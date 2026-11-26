import type { MouseStatus } from "../mouse-types.js";
import {
  SENSEI_RIVAL_PRO_POLLING_RATES,
  SENSEI_RIVAL_PRO_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesSenseiRivalProDpiOptions,
  steelseriesSenseiRivalProEncodeButtonsMapping,
  steelseriesSenseiRivalProEncodeDpiPresets,
  steelseriesSenseiRivalProEncodePollingRate,
  steelseriesSenseiRivalProSaveCommand,
  type SenseiRivalProButtonAction,
  type SenseiRivalProButtonName,
  type SenseiRivalProDpiPreset,
} from "@openmouse/protocol/steelseries";

/** Vendor profile default (first factory preset) until this session writes a value. */
const DEFAULT_DPI = 400;
const DEFAULT_POLLING_HZ = 1000;
/** Lift-off/landing bytes written with DPI presets; the vendor specification states no defaults. */
const DEFAULT_LIFT_OFF_DISTANCE = 0;
const DEFAULT_LANDING_DISTANCE = 0;

/**
 * SteelSeries Sensei Pro / Rival Pro WebHID control (base station
 * `1038:1880`, dongle `1038:1882`).
 *
 * DPI presets, polling rate, and buttons are effectively write-only in this
 * driver: the vendor specification does define read-back commands (`0xB4`
 * for DPI, `0xAC`/`0xAD` for polling, `0xAA` for buttons), but this driver
 * does not decode them yet, so a successful `open()` is the only available
 * connectivity signal and `readStatus` reports the session's last-written
 * values (or documented defaults before any write) with
 * `valuesVerified: false`. The four models share one specification and
 * report the model themselves; see `../../steelseries/sensei-rival-pro.ts`
 * for the full protocol writeup.
 *
 * `setDpi` replaces the whole five-preset table with five identical
 * presets: the device exposes no getter, so existing presets cannot be
 * read and preserved. Lift-off and landing distances reset to 0 for every
 * preset — the specification states no defaults for those bytes, so record
 * them in SteelSeries GG before testing and restore them there afterwards.
 */
export class SteelSeriesSenseiRivalProHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private lastWritten: { dpi: number | null; pollingRateHz: number | null } = {
    dpi: null,
    pollingRateHz: null,
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== STEELSERIES_VENDOR_ID) return false;
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "sensei-rival-pro";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...SENSEI_RIVAL_PRO_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesSenseiRivalProDpiOptions(); }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const product = STEELSERIES_PRODUCTS.get(this.device.productId);
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Sensei Pro / Rival Pro"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-sensei-rival-pro",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Sensei Pro / Rival Pro cannot report its current DPI or polling rate through this driver; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Sensei Pro / Rival Pro",
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: this.lastWritten.dpi ?? DEFAULT_DPI,
        pollingRateHz: this.lastWritten.pollingRateHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wireless",
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  async setDpi(dpi: number): Promise<number> {
    const preset: SenseiRivalProDpiPreset = {
      x: dpi,
      y: dpi,
      liftOffDistance: DEFAULT_LIFT_OFF_DISTANCE,
      landingDistance: DEFAULT_LANDING_DISTANCE,
    };
    const report = steelseriesSenseiRivalProEncodeDpiPresets(
      [preset, preset, preset, preset, preset],
      0,
    );
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(50);
      await this.write(steelseriesSenseiRivalProSaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesSenseiRivalProEncodePollingRate(0, pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(50);
      await this.write(steelseriesSenseiRivalProSaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  async setButtonsMapping(mapping: Partial<Record<SenseiRivalProButtonName, SenseiRivalProButtonAction>>): Promise<void> {
    const report = steelseriesSenseiRivalProEncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(50);
      await this.write(steelseriesSenseiRivalProSaveCommand());
    });
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(SENSEI_RIVAL_PRO_REPORT_ID, payload.buffer as ArrayBuffer);
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
