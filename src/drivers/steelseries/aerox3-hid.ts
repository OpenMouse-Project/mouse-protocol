import type { MouseStatus } from "../mouse-types.js";
import {
  AEROX3_POLLING_RATES,
  AEROX3_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesAerox3DpiOptions,
  steelseriesAerox3EncodeButtonsMapping,
  steelseriesAerox3EncodeDefaultLighting,
  steelseriesAerox3EncodeDpiPresets,
  steelseriesAerox3EncodeLedBrightness,
  steelseriesAerox3EncodePollingRate,
  steelseriesAerox3EncodeRainbowEffect,
  steelseriesAerox3EncodeReactiveColor,
  steelseriesAerox3EncodeZoneColor,
  steelseriesAerox3SaveCommand,
  type Aerox3ButtonAction,
  type Aerox3ButtonName,
  type Aerox3DefaultLighting,
  type Aerox3RainbowZones,
  type Aerox3Zone,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg profile defaults (`aerox3.py`), shown only until this session writes a value. */
const DEFAULT_DPI = 800;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Aerox 3 WebHID control (`1038:1836`).
 *
 * Unlike Rival 3 Gen 1, the Aerox 3 has **no readable value at all** — no
 * firmware query exists in `aerox3.py`, so there is nothing to probe the
 * device with. `readStatus` therefore treats a successful `open()` as the
 * only available connectivity signal and reports the session's last-written
 * values (or rivalcfg's documented defaults before any write) with
 * `valuesVerified: false`, same honesty policy as Rival 3 Gen 1 but with an
 * even smaller readable surface. Every setter follows its write with the
 * save command so the change persists in the mouse's onboard memory,
 * mirroring rivalcfg's CLI default.
 *
 * The config channel is hidapi interface 3, per `aerox3.py`'s `"endpoint": 3`
 * model entry; its WebHID collection shape has not been captured yet, so the
 * picker offers every interface.
 */
export class SteelSeriesAerox3HidClient {
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
    return product?.family === "aerox3";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...AEROX3_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesAerox3DpiOptions(); }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const name = this.device.productName?.trim() || "SteelSeries Aerox 3";
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-aerox3",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Aerox 3 cannot report its current settings; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Aerox 3",
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
    const report = steelseriesAerox3EncodeDpiPresets([dpi], 0);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesAerox3EncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  async setZoneColor(zone: Aerox3Zone, r: number, g: number, b: number): Promise<void> {
    const report = steelseriesAerox3EncodeZoneColor(zone, r, g, b);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
    });
  }

  async setReactiveColor(color: { r: number; g: number; b: number } | null): Promise<void> {
    const report = steelseriesAerox3EncodeReactiveColor(color);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
    });
  }

  async setLedBrightness(percent: number): Promise<void> {
    const report = steelseriesAerox3EncodeLedBrightness(percent);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
    });
  }

  async setRainbowEffect(zones: Aerox3RainbowZones): Promise<void> {
    const report = steelseriesAerox3EncodeRainbowEffect(zones);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
    });
  }

  async setDefaultLighting(mode: Aerox3DefaultLighting): Promise<void> {
    const report = steelseriesAerox3EncodeDefaultLighting(mode);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
    });
  }

  async setButtonsMapping(mapping: Partial<Record<Aerox3ButtonName, Aerox3ButtonAction>>): Promise<void> {
    const report = steelseriesAerox3EncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesAerox3SaveCommand());
    });
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(AEROX3_REPORT_ID, payload.buffer as ArrayBuffer);
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
