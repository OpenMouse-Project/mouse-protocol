import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL3_GEN2_DEFAULT_DPI_PRESETS,
  RIVAL3_GEN2_DEFAULT_POLLING_RATE,
  RIVAL3_GEN2_MAX_DPI_PRESETS,
  RIVAL3_GEN2_POLLING_RATES,
  RIVAL3_GEN2_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesRival3Gen2DecodeFirmware,
  steelseriesRival3Gen2DpiOptions,
  steelseriesRival3Gen2EncodeButtonsMapping,
  steelseriesRival3Gen2EncodeDpiPresets,
  steelseriesRival3Gen2EncodePollingRate,
  steelseriesRival3Gen2FirmwareQuery,
  steelseriesRival3Gen2SaveCommand,
  type Rival3Gen2ButtonAction,
  type Rival3Gen2ButtonName,
  type Rival3Gen2DpiPreset,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** Firmware replies are small; allow slack over rivalcfg-style timeouts. */
const FIRMWARE_TIMEOUT_MS = 500;

/**
 * SteelSeries Rival 3 Gen 2 WebHID control (`1038:1870`, wired only).
 *
 * DPI presets, polling rate, and buttons are write-only; only the 15-byte
 * firmware version string (`90`) can be read back, and this driver uses it
 * as its connectivity probe. `readStatus` therefore reports the session's
 * last-written values (or the documented defaults before any write) with
 * `valuesVerified: false`. Every setter follows its write with the save
 * command so the change persists in the mouse's onboard memory. See
 * `../../steelseries/rival-3-v2.ts` for the full protocol writeup —
 * reconstructed from the vendor's GG device specification, with the DPI
 * table transcribed from the vendor file (note the documented divergence
 * from rivalcfg's TrueMove Core table there).
 *
 * DPI is managed as five XY stages (the common factory table), mirroring
 * the Aerox wireless drivers: `setDpi` edits both axes of the active stage,
 * and the whole table is rewritten on every change because the device
 * exposes no per-preset getter. Do not confuse this mouse with Rival 3 Gen
 * 1 (`1038:1824`/`1038:184C`, a different command set).
 */
export class SteelSeriesRival3Gen2HidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private listenerAttached = false;
  private readonly inputWaiters = new Set<(payload: Uint8Array) => void>();
  private dpiStages: Rival3Gen2DpiPreset[] = RIVAL3_GEN2_DEFAULT_DPI_PRESETS.map((dpi) => ({ x: dpi, y: dpi }));
  private activeDpiStage = 0;
  private pollingRateHz: number = RIVAL3_GEN2_DEFAULT_POLLING_RATE;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const payload = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    for (const finish of [...this.inputWaiters]) finish(payload);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== STEELSERIES_VENDOR_ID) return false;
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival3-v2";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL3_GEN2_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival3Gen2DpiOptions(); }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.listenerAttached) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listenerAttached = true;
    }
  }

  async close(): Promise<void> {
    if (this.listenerAttached) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listenerAttached = false;
    }
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const firmware = await this.probeFirmware();
      const product = STEELSERIES_PRODUCTS.get(this.device.productId);
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 3 Gen 2"}`;
      const active = this.dpiStages[this.activeDpiStage];
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival3-v2",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 3 Gen 2 cannot report its current settings; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 3 Gen 2",
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: active?.x ?? RIVAL3_GEN2_DEFAULT_DPI_PRESETS[0]!,
        pollingRateHz: this.pollingRateHz,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [firmware],
      };
    });
  }

  /** writes `dpi` into both axes of the active stage. */
  async setDpi(dpi: number): Promise<number> {
    await this.setDpiStageValue(this.activeDpiStage, { x: dpi, y: dpi });
    return dpi;
  }

  async setDpiStageValue(stage: number, preset: Rival3Gen2DpiPreset): Promise<Rival3Gen2DpiPreset> {
    this.requireStage(stage);
    const stages = this.dpiStages.map((value, index) => (index === stage ? preset : value));
    await this.writePresets(stages, this.activeDpiStage);
    return preset;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    this.requireStage(stage);
    await this.writePresets(this.dpiStages, stage);
    return stage;
  }

  async setDpiStages(stages: readonly Rival3Gen2DpiPreset[], activeStage = 0): Promise<void> {
    await this.writePresets(stages, activeStage);
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    await this.commit(steelseriesRival3Gen2EncodePollingRate(pollingRateHz));
    this.pollingRateHz = pollingRateHz;
    return pollingRateHz;
  }

  async setButtonsMapping(mapping: Partial<Record<Rival3Gen2ButtonName, Rival3Gen2ButtonAction>>): Promise<void> {
    await this.commit(steelseriesRival3Gen2EncodeButtonsMapping(mapping));
  }

  private requireStage(stage: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= RIVAL3_GEN2_MAX_DPI_PRESETS) {
      throw new Error(`The Rival 3 Gen 2 holds ${RIVAL3_GEN2_MAX_DPI_PRESETS} DPI stages.`);
    }
  }

  private async writePresets(stages: readonly Rival3Gen2DpiPreset[], activeStage: number): Promise<void> {
    this.requireStage(activeStage);
    const report = steelseriesRival3Gen2EncodeDpiPresets(stages, activeStage);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3Gen2SaveCommand());
      this.dpiStages = [...stages];
      this.activeDpiStage = activeStage;
    });
  }

  private async commit(report: Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3Gen2SaveCommand());
    });
  }

  /**
   * `90` — 15-byte firmware version string. Doubles as the proof that the
   * granted interface is the config channel.
   */
  private async probeFirmware(): Promise<string> {
    const response = new Promise<Uint8Array | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (payload: Uint8Array | null): void => {
        clearTimeout(timer);
        this.inputWaiters.delete(finish as (payload: Uint8Array) => void);
        resolve(payload);
      };
      timer = setTimeout(() => finish(null), FIRMWARE_TIMEOUT_MS);
      this.inputWaiters.add(finish as (payload: Uint8Array) => void);
    });
    await this.write(steelseriesRival3Gen2FirmwareQuery());
    const payload = await response;
    if (!payload) {
      throw new Error("The Rival 3 Gen 2 did not answer the firmware query on this interface. Add the device again and choose another entry.");
    }
    return steelseriesRival3Gen2DecodeFirmware(payload);
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(RIVAL3_GEN2_REPORT_ID, payload.buffer as ArrayBuffer);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
