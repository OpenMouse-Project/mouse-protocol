import type { MouseStatus } from "../mouse-types.js";
import {
  PRIME_PLUS_POLLING_RATES,
  PRIME_PLUS_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesPrimePlusDpiOptions,
  steelseriesPrimePlusEncodeButtonsMapping,
  steelseriesPrimePlusEncodeColor,
  steelseriesPrimePlusEncodeDpiPresets,
  steelseriesPrimePlusEncodeLedBrightness,
  steelseriesPrimePlusEncodePollingRate,
  steelseriesPrimePlusSaveCommand,
  type PrimePlusButtonAction,
  type PrimePlusButtonName,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg profile defaults (`prime_plus.py`), shown only until this session writes a value. */
const DEFAULT_DPI = 400;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Prime+ WebHID control (`1038:182C`).
 *
 * Like Aerox 3, the Prime+ has **no readable value at all** — no firmware
 * query exists in `prime_plus.py`, so there is nothing to probe the device
 * with. `readStatus` therefore treats a successful `open()` as the only
 * available connectivity signal and reports the session's last-written
 * values (or rivalcfg's documented defaults before any write) with
 * `valuesVerified: false`, same honesty policy as Aerox 3 and Rival 3 Gen 1.
 * Every setter follows its write with the save command so the change
 * persists in the mouse's onboard memory, mirroring rivalcfg's CLI default.
 *
 * The config channel is hidapi interface 0, per `prime_plus.py`'s
 * `"endpoint": 0` model entry; its WebHID collection shape has not been
 * captured yet, so the picker offers every interface.
 *
 * See `../../steelseries/prime-plus.ts`'s doc comment for the full
 * corroboration-gap disclosure (rivalcfg only — libratbag has no Prime/
 * Prime+ support and OpenRGB's SteelSeries controller sources could not be
 * located from this environment) and for why this device's protocol is not
 * distinguishable from plain Prime's despite being its own module here.
 */
export class SteelSeriesPrimePlusHidClient {
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
    return product?.family === "prime-plus";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...PRIME_PLUS_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesPrimePlusDpiOptions(); }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const name = this.device.productName?.trim() || "SteelSeries Prime+";
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-prime-plus",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Prime+ cannot report its current settings; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Prime+",
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
    const report = steelseriesPrimePlusEncodeDpiPresets([dpi], 0);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesPrimePlusSaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesPrimePlusEncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesPrimePlusSaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  async setColor(r: number, g: number, b: number): Promise<void> {
    const report = steelseriesPrimePlusEncodeColor(r, g, b);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesPrimePlusSaveCommand());
    });
  }

  async setLedBrightness(level: number): Promise<void> {
    const report = steelseriesPrimePlusEncodeLedBrightness(level);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesPrimePlusSaveCommand());
    });
  }

  async setButtonsMapping(mapping: Partial<Record<PrimePlusButtonName, PrimePlusButtonAction>>): Promise<void> {
    const report = steelseriesPrimePlusEncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesPrimePlusSaveCommand());
    });
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(PRIME_PLUS_REPORT_ID, payload.buffer as ArrayBuffer);
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
