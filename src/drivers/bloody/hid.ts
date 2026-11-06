import type { MouseStatus } from "../mouse-types.ts";
import {
  BLOODY_DPI_MAX,
  BLOODY_DPI_MIN,
  BLOODY_DPI_STEP,
  BLOODY_FLASH_SECTOR_SIZE,
  BLOODY_PRODUCT_IDS,
  BLOODY_PRODUCT_NAMES,
  BLOODY_REPORT_ID,
  BLOODY_REPORT_SIZE,
  BLOODY_VENDOR_ID,
  bloodyBuildFlashChunk,
  bloodyBuildFlashMagicCommit,
  bloodyBuildFlashReadChunk,
  bloodyBuildFlashReset,
  bloodyBuildFlashSector,
  bloodyBuildFlashUnlock,
  bloodyBuildSaveCommand,
  bloodyBuildSensitivityQuery,
  bloodyBuildSensitivitySet,
  bloodyBuildSetBacklight,
  bloodyBuildSetDpi,
  bloodyDecodeFlashSector,
  bloodyDecodeSensitivity,
  bloodyGetDpiOptions,
  bloodyIsValidFlashSector,
  bloodyParseFlashReadChunk,
  bloodyValidateDpi,
} from "../../bloody/index.ts";

/**
 * Searches HID collections to find the declared byte size of a feature report.
 *
 * @param collections - HID collection hierarchy reported by WebHID.
 * @param reportId - Feature report ID to search for.
 * @returns Report payload size in bytes, or null if not found.
 */
function findFeatureReportSize(collections: readonly HIDCollectionInfo[], reportId: number): number | null {
  for (const collection of collections) {
    for (const report of collection.featureReports ?? []) {
      if (report.reportId === reportId && report.items && report.items.length > 0) {
        const totalBits = report.items.reduce((sum, item) => sum + (item.reportSize ?? 8) * (item.reportCount ?? 0), 0);
        return Math.ceil(totalBits / 8);
      }
    }
    if (collection.children) {
      const childSize = findFeatureReportSize(collection.children, reportId);
      if (childSize !== null) return childSize;
    }
  }
  return null;
}

/**
 * Checks if the HID device exposes the Bloody vendor control collection (0xFF00-0xFFFF).
 *
 * @param collections - Device HID collections.
 * @returns True if the vendor control collection with feature report support is present.
 */
function hasControlCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage >= 0xff00 && (collection.featureReports ?? []).some((report) => report.reportId === BLOODY_REPORT_ID))
    || (collection.children && hasControlCollection(collection.children)));
}

/**
 * WebHID client for A4Tech Bloody mice (e.g. Bloody W70 Max).
 */
export class BloodyHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus: MouseStatus | null = null;
  private lastSensRaw: Uint8Array | null = null;
  private activeDpi: number | null = null;
  private activeStageIndex = 0;
  /** Stage DPI values as read from the device; empty until a read succeeds. */
  private stagePool: number[] = [];
  private enabledStageCount = 0;
  private currentStages: number[] = [];
  /** True only once stages were read from the device; writes are refused otherwise. */
  private stagesKnown = false;

  /**
   * Creates a new Bloody WebHID driver instance.
   *
   * @param device - Underlying WebHID device handle.
   */
  constructor(device: HIDDevice) {
    this.device = device;
  }

  /**
   * Determines whether the given HID device is a supported Bloody mouse.
   *
   * @param device - WebHID device to evaluate.
   * @returns True if the device matches Bloody vendor ID, supported product ID, and vendor collection.
   */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== BLOODY_VENDOR_ID) return false;
    if (!BLOODY_PRODUCT_IDS.includes(device.productId)) return false;
    return hasControlCollection(device.collections);
  }

  /**
   * Returns selectable DPI values for Bloody mice (100 to 10,000 in 100-DPI steps).
   *
   * @returns Array of supported DPI integers.
   */
  getDpiOptions(): number[] {
    return bloodyGetDpiOptions();
  }

  /**
   * Returns supported polling rates controllable via software.
   *
   * @returns Empty array because Bloody W70 Max controls polling rate via a physical switch.
   */
  getSupportedPollingRates(): number[] {
    return [];
  }

  /**
   * Opens the WebHID device session if not already opened.
   */
  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  /**
   * Closes the WebHID device session.
   */
  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /**
   * Adjusts a payload buffer to match the device collection's expected feature report byte size.
   *
   * @param payload - Outgoing report payload.
   * @returns Sized ArrayBuffer matching the collection declaration.
   */
  private fitBuffer(payload: Uint8Array): ArrayBuffer {
    const size = findFeatureReportSize(this.device.collections, BLOODY_REPORT_ID) ?? BLOODY_REPORT_SIZE;
    if (payload.byteLength === size) return new Uint8Array(payload).buffer;
    const target = new Uint8Array(size);
    target.set(payload.subarray(0, size));
    return target.buffer;
  }

  /**
   * Reads current operational state, sensitivity stages, and configuration from the mouse.
   *
   * Stages come from the 0x02 sensitivity table, or from the flash profile sector when the
   * device does not answer 0x02. If neither can be read the stages are reported as unknown
   * (empty) and all writes are refused.
   *
   * @returns Snapshot of the mouse status.
   */
  async readStatus(): Promise<MouseStatus> {
    await this.open();

    const sensRaw = await this.query(bloodyBuildSensitivityQuery());
    const sens = sensRaw ? bloodyDecodeSensitivity(sensRaw) : null;

    const name = BLOODY_PRODUCT_NAMES.get(this.device.productId)
      ?? (this.device.productName?.trim() || "Bloody mouse");

    if (sens && sensRaw) {
      this.lastSensRaw = sensRaw;
      this.stagePool = [...sens.stages];
      this.enabledStageCount = sens.stages.length;
      this.activeStageIndex = sens.activeStageIndex;
      this.activeDpi = sens.currentDpi;
      this.stagesKnown = true;
    } else {
      this.lastSensRaw = null;
      const sector = await this.enqueue(() => this.readFlashSector());
      const profile = sector ? bloodyDecodeFlashSector(sector) : null;
      if (profile) {
        this.stagePool = [...profile.stages];
        this.enabledStageCount = profile.enabledStageCount;
        if (this.lastStatus === null) {
          this.activeStageIndex = 0;
          this.activeDpi = this.stagePool[0] ?? null;
        }
        this.stagesKnown = true;
      } else {
        this.stagePool = [];
        this.enabledStageCount = 0;
        this.stagesKnown = false;
      }
    }

    this.currentStages = this.stagePool.slice(0, this.enabledStageCount);
    if (this.activeStageIndex >= this.currentStages.length) {
      this.activeStageIndex = Math.max(0, this.currentStages.length - 1);
    }

    const currentActiveStage = this.activeStageIndex;
    const currentStages = [...this.currentStages];
    const currentDpi = this.stagesKnown ? (this.activeDpi ?? currentStages[currentActiveStage] ?? 0) : 0;

    const status: MouseStatus = {
      brand: "Bloody",
      name,
      ui: {
        family: "bloody",
        settingsReady: this.stagesKnown,
        valuesVerified: this.stagesKnown,
        hidePollingCard: true,
        hideUnsupportedPollingRates: true,
        dpiStageEditor: {
          maxStages: 5,
          countEditable: true,
          minDpi: BLOODY_DPI_MIN,
          maxDpi: BLOODY_DPI_MAX,
          stepDpi: BLOODY_DPI_STEP,
        },
      },
      batteryPercent: null,
      batteryState: "Unknown",
      connectionType: "Wired",
      dpi: currentDpi,
      dpiStages: currentStages,
      activeDpiStage: currentActiveStage,
      pollingRateHz: this.lastStatus?.pollingRateHz ?? 1000,
      supportedPollingRates: [],
      activeProfile: null,
      liftOffDistance: null,
      firmware: [],
    };

    this.lastStatus = status;
    return status;
  }

  /**
   * Throws unless stages were successfully read from the device.
   */
  private requireStagesKnown(): void {
    if (!this.stagesKnown) {
      throw new Error("Bloody DPI stages are unknown (device state could not be read); refusing to write");
    }
  }

  /**
   * Enqueues an asynchronous operation to serialize HID command execution.
   *
   * @param operation - Async function returning a promise.
   * @returns Promise resolving with the operation result once prior operations finish.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Sends one feature report and waits for the controller to settle.
   *
   * @param packet - Report payload.
   * @param delayMs - Settle time after the write.
   */
  private async sendStep(packet: Uint8Array, delayMs: number): Promise<void> {
    await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(packet));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * Reads the 256-byte profile sector (0xe000) from the device in 32-byte chunks.
   * Must run inside the queue. Never throws.
   *
   * @returns The sector, or null if any chunk could not be read or the sector is invalid.
   */
  private async readFlashSector(): Promise<Uint8Array | null> {
    try {
      const sector = new Uint8Array(BLOODY_FLASH_SECTOR_SIZE);
      for (let offset = 0; offset < sector.length; offset += 32) {
        await this.sendStep(bloodyBuildFlashReadChunk(offset, 0xe0), 20);
        const view = await this.device.receiveFeatureReport(BLOODY_REPORT_ID);
        const chunk = bloodyParseFlashReadChunk(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        if (!chunk) return null;
        sector.set(chunk, offset);
      }
      return bloodyIsValidFlashSector(sector) ? sector : null;
    } catch (err) {
      console.warn("[BloodyHidClient] flash sector read failed:", err);
      return null;
    }
  }

  /**
   * Writes the 256-byte profile sector to onboard flash memory (sector 0xe000).
   *
   * Reads the current sector first and patches only the stage count and DPI stage bytes, so
   * button mappings and other settings survive; only chunks that differ are programmed. If the
   * sector cannot be read the write is refused. Lock and save always run (every step is
   * attempted) and never mask the original error.
   *
   * @param stages - Array of DPI values for each stage.
   * @param enabledStageCount - Number of active stages (1..5).
   * @param activeDpi - Currently active DPI value.
   * @param activeStageIndex - Currently active stage index (0..4).
   * @param pollingHz - Operational polling rate in Hz.
   */
  private async writeFlashSector(
    stages: readonly number[],
    enabledStageCount: number,
    activeDpi: number,
    activeStageIndex: number,
    pollingHz = 1000,
  ): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readFlashSector();
      if (!current) {
        throw new Error("Could not read the Bloody profile sector; refusing to overwrite it");
      }
      const sector = bloodyBuildFlashSector(stages, enabledStageCount, current);
      const dpiPacket = bloodyBuildSetDpi(activeDpi, activeStageIndex, enabledStageCount, pollingHz);

      let failure: unknown;
      let failed = false;
      try {
        // 1. Unlock flash programming mode (command 0x20 0x01)
        await this.sendStep(bloodyBuildFlashUnlock(true), 30);

        // 2. Write only the 32-byte chunks that changed (command 0x2f 0x01)
        for (let offset = 0; offset < sector.length; offset += 32) {
          const chunk = sector.subarray(offset, offset + 32);
          if (chunk.every((byte, i) => byte === current[offset + i])) continue;
          await this.sendStep(bloodyBuildFlashChunk(offset, chunk, 0xe0), 20);
        }

        // 3. Magic commit packet to finalize sector write (0xa4a4a4a4)
        await this.sendStep(bloodyBuildFlashMagicCommit(0xe0), 30);

        // 4. Reset notification packet (command 0x13)
        await this.sendStep(bloodyBuildFlashReset(), 30);

        // 5. Set live runtime active DPI & stage count (command 0x0d)
        await this.sendStep(dpiPacket, 30);
      } catch (err) {
        failed = true;
        failure = err;
      }

      // 6/7. Lock flash and save. Each step is attempted regardless of earlier failures.
      const cleanupErrors: unknown[] = [];
      for (const [packet, delay] of [[bloodyBuildFlashUnlock(false), 30], [bloodyBuildSaveCommand(), 40]] as const) {
        try {
          await this.sendStep(packet, delay);
        } catch (err) {
          cleanupErrors.push(err);
        }
      }

      if (failed) throw failure;
      if (cleanupErrors.length > 0) {
        throw cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, "Bloody flash lock/save cleanup failed");
      }
    });
  }

  /**
   * Writes stage configuration via the legacy 0x02 sensitivity table path.
   *
   * @param stages - Stage DPI values to store.
   * @param activeStageIndex - Active stage index.
   * @param activeDpi - DPI of the active stage.
   * @param total - Enabled stage count.
   * @param pollingHz - Operational polling rate in Hz.
   */
  private writeLegacy(
    stages: readonly number[],
    activeStageIndex: number,
    activeDpi: number,
    total: number,
    pollingHz: number,
  ): Promise<void> {
    const base = this.lastSensRaw!;
    return this.enqueue(async () => {
      await this.sendStep(bloodyBuildSensitivitySet(stages.slice(0, total), activeStageIndex, base), 30);
      await this.sendStep(bloodyBuildSetDpi(activeDpi, activeStageIndex, total, pollingHz), 30);
      await this.sendStep(bloodyBuildSaveCommand(), 30);
    });
  }

  /**
   * Persists a candidate configuration using the path appropriate for this model.
   * Does not mutate client state; callers update state only after this resolves.
   */
  private persist(
    stages: readonly number[],
    activeStageIndex: number,
    activeDpi: number,
    total: number,
  ): Promise<void> {
    const pollingHz = this.lastStatus?.pollingRateHz ?? 1000;
    return this.lastSensRaw
      ? this.writeLegacy(stages, activeStageIndex, activeDpi, total, pollingHz)
      : this.writeFlashSector(stages, total, activeDpi, activeStageIndex, pollingHz);
  }

  /**
   * Switches the active DPI stage on the mouse.
   *
   * @param stage - Zero-based stage index.
   * @returns Selected stage index.
   */
  async setActiveDpiStage(stage: number): Promise<number> {
    await this.open();
    this.requireStagesKnown();
    const total = this.enabledStageCount;
    if (!Number.isInteger(stage) || stage < 0 || stage >= total) {
      throw new RangeError(`Stage ${stage} is outside valid range 0..${total - 1}`);
    }
    const dpi = this.stagePool[stage]!;
    await this.persist(this.stagePool, stage, dpi, total);

    this.activeStageIndex = stage;
    this.activeDpi = dpi;
    if (this.lastStatus) {
      this.lastStatus.activeDpiStage = stage;
      this.lastStatus.dpi = dpi;
    }
    return stage;
  }

  /**
   * Sets the DPI value for a specific stage slot.
   *
   * @param stage - Zero-based stage index (0..4).
   * @param dpi - Sensitivity in DPI (100..10,000, multiple of 100).
   * @returns Configured DPI value.
   */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    await this.open();
    bloodyValidateDpi(dpi);
    this.requireStagesKnown();
    if (!Number.isInteger(stage) || stage < 0 || stage >= this.stagePool.length) {
      throw new RangeError(`Stage ${stage} is outside supported 0..${this.stagePool.length - 1}`);
    }
    const nextPool = [...this.stagePool];
    nextPool[stage] = dpi;
    const total = this.enabledStageCount;
    const isActive = stage === this.activeStageIndex;
    const activeDpi = isActive ? dpi : (this.activeDpi ?? nextPool[this.activeStageIndex]!);

    await this.persist(nextPool, this.activeStageIndex, activeDpi, total);

    this.stagePool = nextPool;
    this.currentStages = nextPool.slice(0, total);
    if (isActive) this.activeDpi = dpi;
    if (this.lastStatus) {
      this.lastStatus.dpiStages = [...this.currentStages];
      if (isActive) this.lastStatus.dpi = dpi;
    }
    return dpi;
  }

  /**
   * Sets the number of enabled DPI stages (1..5).
   *
   * @param count - Desired stage count.
   * @returns Configured stage count.
   */
  async setDpiStageCount(count: number): Promise<number> {
    await this.open();
    this.requireStagesKnown();
    const clamped = Math.max(1, Math.min(5, Math.round(count)));
    if (clamped > this.stagePool.length) {
      throw new RangeError(`Stage count ${clamped} exceeds the ${this.stagePool.length} stages known from the device`);
    }
    const activeStageIndex = Math.min(this.activeStageIndex, clamped - 1);
    const activeDpi = this.stagePool[activeStageIndex]!;

    await this.persist(this.stagePool, activeStageIndex, activeDpi, clamped);

    this.enabledStageCount = clamped;
    this.currentStages = this.stagePool.slice(0, clamped);
    this.activeStageIndex = activeStageIndex;
    this.activeDpi = activeDpi;
    if (this.lastStatus) {
      this.lastStatus.dpiStages = [...this.currentStages];
      this.lastStatus.activeDpiStage = activeStageIndex;
      this.lastStatus.dpi = activeDpi;
    }
    return clamped;
  }

  /**
   * Sets the DPI of the currently active stage.
   *
   * @param dpi - Target DPI value.
   * @returns Configured DPI.
   */
  async setDpi(dpi: number): Promise<number> {
    const stage = this.activeStageIndex ?? this.lastStatus?.activeDpiStage ?? 0;
    return await this.setDpiStageValue(stage, dpi);
  }

  /**
   * No-op polling rate setter since polling rate is controlled by physical hardware sliders on Bloody W70 Max.
   *
   * @param rate - Requested polling rate in Hz.
   * @returns Current reported rate.
   */
  async setPollingRate(rate: number): Promise<number> {
    // Polling rate is controlled by a hardware switch on the underside of this mouse.
    return this.lastStatus?.pollingRateHz ?? rate;
  }

  /**
   * Sets the mouse backlight brightness level (0..3).
   *
   * @param level - Brightness level between 0 and 3.
   * @returns Configured level.
   */
  async setBacklight(level: number): Promise<number> {
    await this.open();
    return this.enqueue(async () => {
      const packet = bloodyBuildSetBacklight(level);
      await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(packet));
      return level;
    });
  }

  /**
   * Sends a feature report query and reads back the response buffer.
   *
   * @param request - Command query buffer.
   * @returns Response payload buffer or null on failure.
   */
  private query(request: Uint8Array): Promise<Uint8Array | null> {
    return this.enqueue(async () => {
      try {
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(request));
        // Give microcontroller time to process command and populate response
        await new Promise((resolve) => setTimeout(resolve, 50));
        const view = await this.device.receiveFeatureReport(BLOODY_REPORT_ID);
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (bytes.length > 0 && bytes[0] === BLOODY_REPORT_ID) {
          return bytes.subarray(1);
        }
        return bytes;
      } catch (err) {
        console.warn("[BloodyHidClient] query failed:", err);
        return null;
      }
    });
  }
}
