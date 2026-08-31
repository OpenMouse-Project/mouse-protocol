import type { MouseStatus } from "../mouse-types.js";
import {
  SENSEI_TEN_POLLING_RATES,
  SENSEI_TEN_REPORT_ID,
  SENSEI_TEN_DEFAULT_BUTTONS_MAPPING,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesSenseiTenDecodeFirmware,
  steelseriesSenseiTenDpiOptions,
  steelseriesSenseiTenEncodeButtonsMapping,
  steelseriesSenseiTenEncodeDpiPresets,
  steelseriesSenseiTenEncodeLedColor,
  steelseriesSenseiTenEncodePollingRate,
  steelseriesSenseiTenFirmwareQuery,
  steelseriesSenseiTenSaveCommand,
  type SenseiTenButtonAction,
  type SenseiTenButtonName,
  type SenseiTenColorStop,
  type SenseiTenFirmware,
  type SenseiTenLed,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads the firmware response with a 200 ms timeout; allow slack. */
const FIRMWARE_TIMEOUT_MS = 500;
/** rivalcfg profile defaults (`sensei_ten.py`), shown only until this session writes a value. */
const DEFAULT_DPI = 400;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Sensei TEN WebHID control (`1038:1832`, `1038:1834` CS:GO Neon
 * Rider Edition).
 *
 * The device is write-only for DPI/polling/lighting/buttons: settings are
 * sent as unnumbered output (or, for `logo_color`/`wheel_color`, feature)
 * reports and nothing can be read back except the two-byte firmware
 * version, which this driver uses as its connectivity probe — same pattern
 * as Rival 3 Gen 1's `10 00`, but Sensei TEN's query is `90 00`.
 * `readStatus` therefore reports the session's last-written values (or
 * rivalcfg's documented defaults before any write) with `valuesVerified:
 * false`. Every setter follows its write with the save command so the
 * change persists in the mouse's onboard memory, mirroring rivalcfg's CLI
 * default.
 *
 * The config channel is hidapi `endpoint: 0`, per `sensei_ten.py`'s model
 * entries; its WebHID collection shape has not been captured yet, so the
 * picker offers every interface and the wrong ones fail the firmware probe
 * loudly.
 *
 * See `../../steelseries/sensei-ten.ts`'s doc comment for the full protocol
 * writeup, including the flagged corroboration gap (rivalcfg only — no
 * libratbag or OpenRGB source was reachable for this device).
 */
export class SteelSeriesSenseiTenHidClient {
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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "sensei-ten";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...SENSEI_TEN_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesSenseiTenDpiOptions(); }

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
      const name = this.device.productName?.trim() || "SteelSeries Sensei TEN";
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-sensei-ten",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Sensei TEN cannot report its current settings; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Sensei TEN",
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
   * Replaces the mouse's DPI preset table with a single preset. The device
   * is write-only, so the existing presets cannot be read and preserved —
   * record them before testing.
   */
  async setDpi(dpi: number): Promise<number> {
    const report = steelseriesSenseiTenEncodeDpiPresets([dpi], 0);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesSenseiTenSaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesSenseiTenEncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesSenseiTenSaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  /** `5B 00` feature report — see `steelseriesSenseiTenEncodeLedColor`'s doc comment. */
  async setLedColor(led: SenseiTenLed, stops: readonly SenseiTenColorStop[], durationMs?: number): Promise<void> {
    const report = steelseriesSenseiTenEncodeLedColor(led, stops, durationMs);
    await this.run(async () => {
      await this.open();
      await this.writeFeature(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesSenseiTenSaveCommand());
    });
  }

  async setButtonsMapping(
    mapping: Partial<Record<SenseiTenButtonName, SenseiTenButtonAction>> = SENSEI_TEN_DEFAULT_BUTTONS_MAPPING,
  ): Promise<void> {
    const report = steelseriesSenseiTenEncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesSenseiTenSaveCommand());
    });
  }

  /**
   * The `90 00` firmware query is the device's only readable value, so it
   * doubles as the proof that the granted interface is the config channel.
   */
  private async probeFirmware(): Promise<SenseiTenFirmware> {
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
    await this.write(steelseriesSenseiTenFirmwareQuery());
    const payload = await response;
    if (!payload) {
      throw new Error(
        "The Sensei TEN did not answer on this interface. Close SteelSeries GG (and the SteelSeriesEngine service); if it still does not answer, add the device again and choose another entry.",
      );
    }
    return steelseriesSenseiTenDecodeFirmware(payload);
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(SENSEI_TEN_REPORT_ID, payload.buffer as ArrayBuffer);
  }

  private async writeFeature(payload: Uint8Array): Promise<void> {
    await this.device.sendFeatureReport(SENSEI_TEN_REPORT_ID, payload.buffer as ArrayBuffer);
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
