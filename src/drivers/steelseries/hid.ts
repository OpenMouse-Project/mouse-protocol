import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL3_POLLING_RATES,
  STEELSERIES_PRODUCTS,
  STEELSERIES_REPORT_ID,
  STEELSERIES_VENDOR_ID,
  steelseriesRival3DecodeFirmware,
  steelseriesRival3DpiOptions,
  steelseriesRival3EncodeDpiPresets,
  steelseriesRival3EncodePollingRate,
  steelseriesRival3FirmwareQuery,
  steelseriesRival3SaveCommand,
  type SteelSeriesRival3Firmware,
} from "@openmouse/protocol/steelseries";

/** rivalcfg sleeps 50 ms after every command (`command_approve_delay`) and
 * cites a SteelSeries mouse crashing when driven faster. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads the firmware response with a 200 ms timeout; allow slack. */
const FIRMWARE_TIMEOUT_MS = 500;
/** rivalcfg profile defaults, shown only until this session writes a value. */
const DEFAULT_DPI = 800;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Rival 3 Gen 1 WebHID control (`1038:1824`, `1038:184C`).
 *
 * The device is write-only: settings are sent as unnumbered output reports and
 * nothing can be read back except the two-byte firmware version, which this
 * driver uses as its connectivity probe. `readStatus` therefore reports the
 * session's last-written values (or rivalcfg's documented defaults before any
 * write) with `valuesVerified: false` — it never pretends to have read them.
 * Every setter follows its write with the save command so the change persists
 * in the mouse's onboard memory, mirroring rivalcfg's CLI default.
 *
 * The config channel is hidapi interface 3; its WebHID collection shape has
 * not been captured yet, so the picker offers every interface and the wrong
 * ones fail the firmware probe loudly.
 */
export class SteelSeriesRival3HidClient {
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
    return device.vendorId === STEELSERIES_VENDOR_ID && STEELSERIES_PRODUCTS.has(device.productId);
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL3_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival3DpiOptions(); }

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
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 3"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival3",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 3 cannot report its current settings; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 3",
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
   * Replaces the mouse's DPI preset table with a single preset. The device is
   * write-only, so the existing presets cannot be read and preserved — record
   * them in SteelSeries GG before testing, per docs/steelseries-testing.md.
   */
  async setDpi(dpi: number): Promise<number> {
    const report = steelseriesRival3EncodeDpiPresets([dpi], 0);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3SaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesRival3EncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3SaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  /**
   * The `10 00` firmware query is the device's only readable value, so it
   * doubles as the proof that the granted interface is the config channel.
   */
  private async probeFirmware(): Promise<SteelSeriesRival3Firmware> {
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
    await this.write(steelseriesRival3FirmwareQuery());
    const payload = await response;
    if (!payload) {
      throw new Error(
        "The Rival 3 did not answer on this interface. Close SteelSeries GG (and the SteelSeriesEngine service); if it still does not answer, add the device again and choose another entry.",
      );
    }
    return steelseriesRival3DecodeFirmware(payload);
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(STEELSERIES_REPORT_ID, payload.buffer as ArrayBuffer);
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
