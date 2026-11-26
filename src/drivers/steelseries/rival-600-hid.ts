import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL600_POLLING_RATES,
  RIVAL600_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesRival600DecodeFirmware,
  steelseriesRival600DpiOptions,
  steelseriesRival600EncodeButtonsMapping,
  steelseriesRival600EncodePollingRate,
  steelseriesRival600EncodeProximity,
  steelseriesRival600EncodeSensitivity1,
  steelseriesRival600EncodeSensitivity2,
  steelseriesRival600FirmwareQuery,
  steelseriesRival600SaveCommand,
  type Rival600ButtonAction,
  type Rival600ButtonName,
  type SteelSeriesRival600Firmware,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads input-report replies with a 200 ms timeout; allow slack. */
const RESPONSE_TIMEOUT_MS = 500;
/** rivalcfg profile default (`rival600.py`: `sensitivity1` default 800). */
const DEFAULT_DPI = 800;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Rival 600 WebHID control (`1038:1724`, and the Dota 2 Edition
 * `1038:172E` which includes the same profile).
 *
 * DPI (two independent presets, sensitivity `03 00 01`/`03 00 02` — this
 * codec exposes `setDpi` against preset 1 only, matching every other
 * SteelSeries family's single-`setDpi` surface, plus `setDpiPreset2`),
 * polling rate, buttons, and the proximity (lift-off) threshold are all
 * write-only. The one readable value is the two-byte firmware version
 * (`10 00`), which this client uses as its connectivity probe; the active
 * preset level (`81 00`) is also readable but not needed here.
 * `readStatus` therefore has `valuesVerified: false`: DPI and polling rate
 * are the session's last-written values (or rivalcfg's documented defaults
 * before any write). See `../../steelseries/rival-600.ts` for the full
 * protocol writeup — reconstructed from the vendor's GG device
 * specification, with rivalcfg's `rival600.py` independently corroborating
 * every command byte. Do not confuse this mouse with the Rival 650 Wireless
 * (`1038:172B`/`1038:1726`, a different command set).
 *
 * Output reports are 33 bytes (`HIDIO 33` in the specification), unused
 * padding is zero; the button mapping is a HID **feature** report, routed
 * through `device.sendFeatureReport`, unlike every other setter here. The
 * config channel is hidapi interface 0; its WebHID collection shape has not
 * been captured yet, so the picker offers every interface and the wrong
 * ones fail the firmware probe loudly.
 */
export class SteelSeriesRival600HidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private listenerAttached = false;
  private readonly inputWaiters = new Set<(payload: Uint8Array) => void>();
  private lastWritten: { dpi: number | null; pollingRateHz: number | null } = {
    dpi: null,
    pollingRateHz: null,
  };

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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival-600";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL600_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival600DpiOptions(); }

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
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 600"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival-600",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 600 cannot report its current DPI or polling rate; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 600",
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: this.lastWritten.dpi ?? DEFAULT_DPI,
        pollingRateHz: this.lastWritten.pollingRateHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [firmware.display],
      };
    });
  }

  /**
   * `03 00 01 <v> 00 42` — writes sensitivity preset 1. The device has no
   * per-preset getter, so preset 2 is left untouched by this call.
   */
  async setDpi(dpi: number): Promise<number> {
    const report = steelseriesRival600EncodeSensitivity1(dpi);
    await this.commit(report);
    this.lastWritten.dpi = dpi;
    return dpi;
  }

  /** `03 00 02 <v> 00 42` — writes sensitivity preset 2. */
  async setDpiPreset2(dpi: number): Promise<number> {
    const report = steelseriesRival600EncodeSensitivity2(dpi);
    await this.commit(report);
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesRival600EncodePollingRate(pollingRateHz);
    await this.commit(report);
    this.lastWritten.pollingRateHz = pollingRateHz;
    return pollingRateHz;
  }

  async setButtonsMapping(mapping: Partial<Record<Rival600ButtonName, Rival600ButtonAction>>): Promise<void> {
    const report = steelseriesRival600EncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.device.sendFeatureReport(RIVAL600_REPORT_ID, report.buffer as ArrayBuffer);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival600SaveCommand());
    });
  }

  /** `96 00 <enable> <low> <high>` — proximity (lift-off) sensor threshold. Not wired to any UI control. */
  async setProximity(enable: boolean, low: number, high: number): Promise<void> {
    const report = steelseriesRival600EncodeProximity(enable, low, high);
    await this.commit(report);
  }

  private async commit(report: Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival600SaveCommand());
    });
  }

  /**
   * `10 00` — two-byte firmware version. Doubles as the proof that the
   * granted interface is the config channel.
   */
  private async probeFirmware(): Promise<SteelSeriesRival600Firmware> {
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
    await this.write(steelseriesRival600FirmwareQuery());
    const payload = await response;
    if (!payload) {
      throw new Error("The Rival 600 did not answer the firmware query on this interface. Add the device again and choose another entry.");
    }
    return steelseriesRival600DecodeFirmware(payload);
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(RIVAL600_REPORT_ID, payload.buffer as ArrayBuffer);
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
