import type { MouseStatus } from "../mouse-types.js";
import {
  AEROX5_POLLING_RATES,
  AEROX5_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesAerox5DpiOptions,
  steelseriesAerox5EncodeButtonsMapping,
  steelseriesAerox5EncodeDefaultLighting,
  steelseriesAerox5EncodeDpiPresets,
  steelseriesAerox5EncodeLedBrightness,
  steelseriesAerox5EncodePollingRate,
  steelseriesAerox5EncodeRainbowEffect,
  steelseriesAerox5EncodeReactiveColor,
  steelseriesAerox5EncodeZoneColor,
  steelseriesAerox5SaveCommand,
  type Aerox5ButtonAction,
  type Aerox5ButtonName,
  type Aerox5DefaultLighting,
  type Aerox5RainbowZones,
  type Aerox5Zone,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg profile defaults (`aerox5.py`: "400, 800, 1200, 2400, 3200"). */
const DEFAULT_DPI = 400;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Aerox 5 WebHID control (`1038:1850`, wired-only — see
 * `SteelSeriesAerox5WirelessHidClient` for the separately-sold Aerox 5
 * Wireless, a different command layout entirely).
 *
 * Like Aerox 3, this device has **no readable value at all** — no firmware
 * query exists in `aerox5.py`, so there is nothing to probe the device
 * with. `readStatus` therefore treats a successful `open()` as the only
 * available connectivity signal and reports the session's last-written
 * values (or rivalcfg's documented defaults before any write) with
 * `valuesVerified: false`. Every setter follows its write with the save
 * command so the change persists in the mouse's onboard memory, mirroring
 * rivalcfg's CLI default.
 *
 * The config channel is hidapi interface 3, per `aerox5.py`'s `"endpoint": 3`
 * model entry; its WebHID collection shape has not been captured yet, so the
 * picker offers every interface.
 */
export class SteelSeriesAerox5HidClient {
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
    const product = STEELSERIES_PRODUCTS.get(device.productId);
    return product?.family === "aerox5";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...AEROX5_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesAerox5DpiOptions(); }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const name = this.device.productName?.trim() || "SteelSeries Aerox 5";
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-aerox5",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Aerox 5 cannot report its current settings; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Aerox 5",
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: this.lastWritten.dpi ?? DEFAULT_DPI,
        pollingRateHz: this.lastWritten.pollingRateHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  /**
   * Replaces the mouse's DPI preset table with a single preset. The device
   * is write-only, so the existing presets cannot be read and preserved —
   * record them before testing.
   */
  async setDpi(dpi: number): Promise<number> {
    const report = steelseriesAerox5EncodeDpiPresets([dpi], 0);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesAerox5EncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  async setZoneColor(zone: Aerox5Zone, r: number, g: number, b: number): Promise<void> {
    const report = steelseriesAerox5EncodeZoneColor(zone, r, g, b);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
    });
  }

  async setReactiveColor(color: { r: number; g: number; b: number } | null): Promise<void> {
    const report = steelseriesAerox5EncodeReactiveColor(color);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
    });
  }

  async setLedBrightness(percent: number): Promise<void> {
    const report = steelseriesAerox5EncodeLedBrightness(percent);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
    });
  }

  async setRainbowEffect(zones: Aerox5RainbowZones): Promise<void> {
    const report = steelseriesAerox5EncodeRainbowEffect(zones);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
    });
  }

  async setDefaultLighting(mode: Aerox5DefaultLighting): Promise<void> {
    const report = steelseriesAerox5EncodeDefaultLighting(mode);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
    });
  }

  async setButtonsMapping(mapping: Partial<Record<Aerox5ButtonName, Aerox5ButtonAction>>): Promise<void> {
    const report = steelseriesAerox5EncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox5SaveCommand());
    });
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(AEROX5_REPORT_ID, payload.buffer as ArrayBuffer);
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
