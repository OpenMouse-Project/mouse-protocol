import type { MouseStatus } from "../mouse-types.ts";
import {
  BLOODY_PRODUCT_IDS,
  BLOODY_PRODUCT_NAMES,
  BLOODY_REPORT_ID,
  BLOODY_REPORT_SIZE,
  BLOODY_VENDOR_ID,
  bloodyBuildFlashChunk,
  bloodyBuildFlashMagicCommit,
  bloodyBuildFlashReset,
  bloodyBuildFlashSector,
  bloodyBuildFlashUnlock,
  bloodyBuildSaveCommand,
  bloodyBuildSensitivityQuery,
  bloodyBuildSensitivitySet,
  bloodyBuildSetBacklight,
  bloodyBuildSetDpi,
  bloodyDecodeSensitivity,
  bloodyGetDpiOptions,
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
  private stagePool: number[] = [1000, 1200, 1600, 2000, 4000];
  private enabledStageCount = 5;
  private currentStages: number[] = [1000, 1200, 1600, 2000, 4000];

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
   * Returns selectable DPI values for Bloody mice (100 to 16,000 in 50-DPI steps).
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
   * @returns Snapshot of the mouse status.
   */
  async readStatus(): Promise<MouseStatus> {
    await this.open();

    const sensRaw = await this.query(bloodyBuildSensitivityQuery());
    const sens = sensRaw ? bloodyDecodeSensitivity(sensRaw) : null;
    if (sens && sensRaw) this.lastSensRaw = sensRaw;

    const name = BLOODY_PRODUCT_NAMES.get(this.device.productId)
      ?? (this.device.productName?.trim() || "Bloody mouse");

    if (sens?.stages && sens.stages.length > 0) {
      this.stagePool.splice(0, sens.stages.length, ...sens.stages);
      this.enabledStageCount = sens.stages.length;
      this.activeStageIndex = sens.activeStageIndex;
      this.activeDpi = sens.currentDpi;
    } else if (this.lastStatus === null) {
      // First read initialization for W70/W90 Max:
      // Provide full 5-stage profile pool (enabled 5 / 5) and default active stage 0
      this.enabledStageCount = 5;
      this.activeStageIndex = 0;
      if (this.activeDpi === null) {
        this.activeDpi = this.stagePool[0] ?? 1000;
      }
    }

    this.currentStages = this.stagePool.slice(0, this.enabledStageCount);
    if (this.activeStageIndex >= this.currentStages.length) {
      this.activeStageIndex = Math.max(0, this.currentStages.length - 1);
    }

    const currentActiveStage = this.activeStageIndex;
    const currentStages = [...this.currentStages];
    const currentDpi = this.activeDpi ?? currentStages[currentActiveStage] ?? 1000;

    const status: MouseStatus = {
      brand: "Bloody",
      name,
      ui: {
        family: "bloody",
        settingsReady: true,
        valuesVerified: Boolean(sens),
        hidePollingCard: true,
        hideUnsupportedPollingRates: true,
        dpiStageEditor: {
          maxStages: 5,
          countEditable: true,
          minDpi: 100,
          maxDpi: 16000,
          stepDpi: 50,
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
   * Writes the 256-byte profile sector to onboard flash memory (sector 0xe000).
   *
   * Executes a 7-step hardware flash routine (unlock, write 8 chunks of 32 bytes,
   * commit signature, reset notification, live DPI sync, lock, and save).
   * Flash locking and saving are wrapped in a finally block to ensure the controller
   * never remains unlocked if an error occurs.
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
      const sector = bloodyBuildFlashSector(stages, enabledStageCount);

      // 1. Unlock flash programming mode (command 0x20 0x01)
      await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildFlashUnlock(true)));
      await new Promise((resolve) => setTimeout(resolve, 30));

      try {
        // 2. Write 8 chunks of 32 bytes to sector 0xe000 (command 0x2f 0x01)
        for (let c = 0; c < 8; c++) {
          const offset = c * 32;
          const chunk = sector.subarray(offset, offset + 32);
          const chunkPkt = bloodyBuildFlashChunk(offset, chunk, 0xe0);
          await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(chunkPkt));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        // 3. Magic commit packet to finalize sector write (0xa4a4a4a4)
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildFlashMagicCommit(0xe0)));
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 4. Reset notification packet (command 0x13)
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildFlashReset()));
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 5. Set live runtime active DPI & stage count (command 0x0d)
        const dpiPacket = bloodyBuildSetDpi(activeDpi, activeStageIndex, enabledStageCount, pollingHz);
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(dpiPacket));
        await new Promise((resolve) => setTimeout(resolve, 30));
      } finally {
        // 6. Lock flash programming mode (command 0x20 0x00)
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildFlashUnlock(false)));
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 7. Commit / save settings (command 0x0a)
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildSaveCommand()));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    });
  }

  /**
   * Switches the active DPI stage on the mouse.
   *
   * @param stage - Zero-based stage index.
   * @returns Selected stage index.
   */
  async setActiveDpiStage(stage: number): Promise<number> {
    await this.open();
    const total = this.enabledStageCount;
    if (stage < 0 || stage >= total) {
      throw new RangeError(`Stage ${stage} is outside valid range 0..${total - 1}`);
    }
    this.activeStageIndex = stage;
    const dpi = this.stagePool[stage] ?? 1000;
    const pollingHz = this.lastStatus?.pollingRateHz ?? 1000;

    if (this.lastSensRaw) {
      // Legacy Bloody models (supporting 0x02 sensitivity table)
      await this.enqueue(async () => {
        const flashPacket = bloodyBuildSensitivitySet(this.currentStages, this.activeStageIndex, this.lastSensRaw!);
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(flashPacket));
        await new Promise((resolve) => setTimeout(resolve, 30));

        const dpiPacket = bloodyBuildSetDpi(dpi, this.activeStageIndex, total, pollingHz);
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(dpiPacket));
        await new Promise((resolve) => setTimeout(resolve, 30));

        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildSaveCommand()));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    } else {
      // Modern models (W70 / W90 Max with 512KB flash memory sector 0xe000)
      await this.writeFlashSector(this.currentStages, total, dpi, stage, pollingHz);
    }

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
   * @param dpi - Sensitivity in DPI.
   * @returns Configured DPI value.
   */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    await this.open();
    if (stage < 0 || stage >= 5) {
      throw new RangeError(`Stage ${stage} is outside supported 0..4`);
    }
    while (this.stagePool.length <= stage) {
      this.stagePool.push(dpi);
    }
    this.stagePool[stage] = dpi;
    this.currentStages = this.stagePool.slice(0, this.enabledStageCount);
    const total = this.enabledStageCount;
    const pollingHz = this.lastStatus?.pollingRateHz ?? 1000;

    if (this.lastSensRaw) {
      // Legacy Bloody models (supporting 0x02 sensitivity table)
      await this.enqueue(async () => {
        const flashPacket = bloodyBuildSensitivitySet(this.currentStages, this.activeStageIndex, this.lastSensRaw!);
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(flashPacket));
        await new Promise((resolve) => setTimeout(resolve, 30));

        if (stage === this.activeStageIndex) {
          const dpiPacket = bloodyBuildSetDpi(dpi, this.activeStageIndex, total, pollingHz);
          await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(dpiPacket));
          await new Promise((resolve) => setTimeout(resolve, 30));
          this.activeDpi = dpi;
        }

        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildSaveCommand()));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    } else {
      // Modern models (W70 / W90 Max with 512KB flash memory sector 0xe000)
      if (stage === this.activeStageIndex) {
        this.activeDpi = dpi;
      }
      const activeDpi = this.activeDpi ?? this.stagePool[this.activeStageIndex] ?? 1000;
      await this.writeFlashSector(this.currentStages, total, activeDpi, this.activeStageIndex, pollingHz);
    }

    if (this.lastStatus) {
      this.lastStatus.dpiStages = [...this.currentStages];
      if (stage === this.activeStageIndex) {
        this.lastStatus.dpi = dpi;
      }
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
    const clamped = Math.max(1, Math.min(5, Math.round(count)));
    this.enabledStageCount = clamped;
    this.currentStages = this.stagePool.slice(0, clamped);

    if (this.activeStageIndex >= clamped) {
      this.activeStageIndex = clamped - 1;
    }
    const activeDpi = this.stagePool[this.activeStageIndex] ?? 1000;
    const pollingHz = this.lastStatus?.pollingRateHz ?? 1000;

    if (this.lastSensRaw) {
      // Legacy Bloody models (supporting 0x02 sensitivity table)
      await this.enqueue(async () => {
        const flashPacket = bloodyBuildSensitivitySet(this.currentStages, this.activeStageIndex, this.lastSensRaw!);
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(flashPacket));
        await new Promise((resolve) => setTimeout(resolve, 30));

        const dpiPacket = bloodyBuildSetDpi(activeDpi, this.activeStageIndex, clamped, pollingHz);
        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(dpiPacket));
        await new Promise((resolve) => setTimeout(resolve, 30));

        await this.device.sendFeatureReport(BLOODY_REPORT_ID, this.fitBuffer(bloodyBuildSaveCommand()));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    } else {
      // Modern models (W70 / W90 Max with 512KB flash memory sector 0xe000)
      await this.writeFlashSector(this.currentStages, clamped, activeDpi, this.activeStageIndex, pollingHz);
    }

    this.activeDpi = activeDpi;
    if (this.lastStatus) {
      this.lastStatus.dpiStages = [...this.currentStages];
      this.lastStatus.activeDpiStage = this.activeStageIndex;
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
