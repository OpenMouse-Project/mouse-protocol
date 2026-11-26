import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL3_WIRELESS_V2_DEFAULT_DPI_PRESETS,
  RIVAL3_WIRELESS_V2_DEFAULT_POLLING_RATE,
  RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS,
  RIVAL3_WIRELESS_V2_POLLING_RATES,
  RIVAL3_WIRELESS_V2_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesRival3WirelessV2DecodeBattery,
  steelseriesRival3WirelessV2DecodeFirmware,
  steelseriesRival3WirelessV2DpiOptions,
  steelseriesRival3WirelessV2BatteryQuery,
  steelseriesRival3WirelessV2EncodeButtonsMapping,
  steelseriesRival3WirelessV2EncodeDpiPresets,
  steelseriesRival3WirelessV2EncodePollingRate,
  steelseriesRival3WirelessV2EncodeWheelMapping,
  steelseriesRival3WirelessV2FirmwareQuery,
  steelseriesRival3WirelessV2SaveCommand,
  type Rival3WirelessV2Battery,
  type Rival3WirelessV2ButtonAction,
  type Rival3WirelessV2ButtonName,
  type Rival3WirelessV2DpiPreset,
  type Rival3WirelessV2Firmware,
  type Rival3WirelessV2WheelAction,
  type Rival3WirelessV2WheelName,
} from "@openmouse/protocol/steelseries";

/** Vendor profile default delay between a write and its save. */
const COMMAND_DELAY_MS = 50;
/** Battery/firmware replies are small; allow slack over profile timeouts. */
const RESPONSE_TIMEOUT_MS = 500;

/**
 * SteelSeries Rival 3 Wireless Gen 2 WebHID control (`1038:1872`, 2.4 GHz
 * mode).
 *
 * DPI presets, polling rate, and buttons are write-only, but unlike Gen 1
 * this mouse IS partially readable: `battery_level` (`AA 01`) reports a
 * two-byte charge level, and `firmware_version` (`10`) reports
 * major/minor bytes. `readStatus` uses the battery query as its
 * connectivity probe (the value most worth reading live for a wireless
 * mouse) and also reads firmware; DPI and polling rate remain the
 * session's last-written values (or documented defaults before any write),
 * with `valuesVerified: false` reflecting that those two specific values
 * are still unread. See `../../steelseries/rival-3-wireless-v2.ts` for the
 * full protocol writeup — reconstructed from the vendor's GG device
 * specification. Do not confuse this mouse with Gen 1 (`1038:1830`, a
 * different command set).
 *
 * The config channel shape has not been captured yet, so the picker offers
 * every interface and the wrong ones fail the battery probe loudly.
 */
export class SteelSeriesRival3WirelessV2HidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private listenerAttached = false;
  private readonly inputWaiters = new Set<(payload: Uint8Array) => void>();
  private dpiStages: Rival3WirelessV2DpiPreset[] = RIVAL3_WIRELESS_V2_DEFAULT_DPI_PRESETS.map((dpi) => ({ x: dpi, y: dpi }));
  private activeDpiStage = 0;
  private pollingRateHz: number = RIVAL3_WIRELESS_V2_DEFAULT_POLLING_RATE;

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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival3-wireless-v2";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL3_WIRELESS_V2_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival3WirelessV2DpiOptions(); }

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
      const battery = await this.probeBattery();
      const firmware = await this.probeFirmware();
      const product = STEELSERIES_PRODUCTS.get(this.device.productId);
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 3 Wireless Gen 2"}`;
      const active = this.dpiStages[this.activeDpiStage];
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival3-wireless-v2",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 3 Wireless Gen 2 cannot report its current DPI or polling rate; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 3 Wireless Gen 2",
        },
        batteryPercent: battery.level,
        batteryState: "Unknown",
        dpi: active?.x ?? RIVAL3_WIRELESS_V2_DEFAULT_DPI_PRESETS[0]!,
        pollingRateHz: this.pollingRateHz,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wireless",
        liftOffDistance: null,
        firmware: [firmware.display],
      };
    });
  }

  /** writes `dpi` into both axes of the active stage. */
  async setDpi(dpi: number): Promise<number> {
    await this.setDpiStageValue(this.activeDpiStage, { x: dpi, y: dpi });
    return dpi;
  }

  async setDpiStageValue(stage: number, preset: Rival3WirelessV2DpiPreset): Promise<Rival3WirelessV2DpiPreset> {
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

  async setDpiStages(stages: readonly Rival3WirelessV2DpiPreset[], activeStage = 0): Promise<void> {
    await this.writePresets(stages, activeStage);
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    await this.commit(steelseriesRival3WirelessV2EncodePollingRate(pollingRateHz));
    this.pollingRateHz = pollingRateHz;
    return pollingRateHz;
  }

  async setButtonsMapping(mapping: Partial<Record<Rival3WirelessV2ButtonName, Rival3WirelessV2ButtonAction>>): Promise<void> {
    await this.commit(steelseriesRival3WirelessV2EncodeButtonsMapping(mapping));
  }

  async setWheelMapping(mapping: Partial<Record<Rival3WirelessV2WheelName, Rival3WirelessV2WheelAction>>): Promise<void> {
    await this.commit(steelseriesRival3WirelessV2EncodeWheelMapping(mapping));
  }

  /**
   * `AA 01` — battery level. Doubles as the proof that the granted
   * interface is the config channel. Unlike Gen 1's reply this packet
   * carries no charging flag, so charging state stays unknown.
   */
  private async probeBattery(): Promise<Rival3WirelessV2Battery> {
    const payload = await this.awaitResponse(steelseriesRival3WirelessV2BatteryQuery());
    if (!payload) {
      throw new Error(
        "The Rival 3 Wireless Gen 2 did not answer on this interface. Close SteelSeries GG (and the SteelSeriesEngine service); if it still does not answer, add the device again and choose another entry.",
      );
    }
    return steelseriesRival3WirelessV2DecodeBattery(payload);
  }

  /** `10` — major/minor firmware bytes, read the same way. */
  private async probeFirmware(): Promise<Rival3WirelessV2Firmware> {
    const payload = await this.awaitResponse(steelseriesRival3WirelessV2FirmwareQuery());
    if (!payload) {
      throw new Error("The Rival 3 Wireless Gen 2 did not answer the firmware query on this interface.");
    }
    return steelseriesRival3WirelessV2DecodeFirmware(payload);
  }

  private async awaitResponse(query: Uint8Array): Promise<Uint8Array | null> {
    const response = new Promise<Uint8Array | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (payload: Uint8Array | null): void => {
        clearTimeout(timer);
        this.inputWaiters.delete(finish as (payload: Uint8Array) => void);
        resolve(payload);
      };
      timer = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);
      this.inputWaiters.add(finish as (payload: Uint8Array) => void);
    });
    await this.write(query);
    return await response;
  }

  private requireStage(stage: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS) {
      throw new Error(`The Rival 3 Wireless Gen 2 holds ${RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS} DPI stages.`);
    }
  }

  private async writePresets(stages: readonly Rival3WirelessV2DpiPreset[], activeStage: number): Promise<void> {
    this.requireStage(activeStage);
    const report = steelseriesRival3WirelessV2EncodeDpiPresets(stages, activeStage);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3WirelessV2SaveCommand());
      this.dpiStages = [...stages];
      this.activeDpiStage = activeStage;
    });
  }

  private async commit(report: Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3WirelessV2SaveCommand());
    });
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(RIVAL3_WIRELESS_V2_REPORT_ID, payload.buffer as ArrayBuffer);
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
