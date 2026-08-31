import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL310_POLLING_RATES,
  STEELSERIES_PRODUCTS,
  STEELSERIES_RIVAL310_REPORT_ID,
  STEELSERIES_VENDOR_ID,
  steelseriesRival310DecodeFirmware,
  steelseriesRival310DpiOptions,
  steelseriesRival310EncodeButtonsMapping,
  steelseriesRival310EncodeLedColor,
  steelseriesRival310EncodePollingRate,
  steelseriesRival310EncodeSensitivity1,
  steelseriesRival310FirmwareQuery,
  steelseriesRival310SaveCommand,
  type Rival310ButtonAction,
  type Rival310ButtonName,
  type Rival310Led,
  type SteelSeriesRival310Firmware,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads the firmware response with a 200 ms timeout; allow slack. */
const FIRMWARE_TIMEOUT_MS = 500;
/** rivalcfg profile defaults (`rival310.py`), shown only until this session writes a value. */
const DEFAULT_DPI = 800;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Rival 310 WebHID control (`1038:1720`, `1038:171E` CS:GO Howl
 * Edition, `1038:1736` PUBG Edition — one shared command set, see
 * `../../steelseries/rival310.ts`'s doc comment).
 *
 * The device is write-only for settings: only the two-byte firmware version
 * (`90 00`) can be read back, and this driver uses it as its connectivity
 * probe, same pattern as `./hid.ts`'s Rival 3 Gen 1 client. `readStatus`
 * therefore reports the session's last-written DPI/polling values (or
 * rivalcfg's documented defaults before any write) with
 * `valuesVerified: false` — it never pretends to have read them from the
 * mouse. Every setter follows its write with the save command so the change
 * persists in the mouse's onboard memory, mirroring rivalcfg's CLI default.
 *
 * The config channel is hidapi `endpoint 0`, per `rival310.py`'s model
 * entries; its WebHID collection shape has not been captured yet, so the
 * picker offers every interface and the wrong ones fail the firmware probe
 * loudly, same as Rival 3 Gen 1.
 *
 * LED color writes are HID **feature** reports, not output reports (see
 * `steelseriesRival310EncodeLedColor`'s doc comment) — `setLedColor` routes
 * through `device.sendFeatureReport`, unlike every other setter here.
 */
export class SteelSeriesRival310HidClient {
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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival310";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL310_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival310DpiOptions(); }

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
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 310"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival310",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 310 cannot report its current settings; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 310",
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
   * Writes sensitivity preset 1 only. The device is write-only, so the
   * existing preset 2 and button/lighting configuration cannot be read and
   * preserved — record them before testing, per docs/steelseries-testing.md.
   */
  async setDpi(dpi: number): Promise<number> {
    const report = steelseriesRival310EncodeSensitivity1(dpi);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival310SaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesRival310EncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival310SaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  async setLedColor(led: Rival310Led, r: number, g: number, b: number): Promise<void> {
    const report = steelseriesRival310EncodeLedColor(led, r, g, b);
    await this.run(async () => {
      await this.open();
      await this.device.sendFeatureReport(STEELSERIES_RIVAL310_REPORT_ID, report.buffer as ArrayBuffer);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival310SaveCommand());
    });
  }

  async setButtonsMapping(mapping: Partial<Record<Rival310ButtonName, Rival310ButtonAction>>): Promise<void> {
    const report = steelseriesRival310EncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival310SaveCommand());
    });
  }

  /**
   * The `90 00` firmware query is the device's only readable value, so it
   * doubles as the proof that the granted interface is the config channel.
   */
  private async probeFirmware(): Promise<SteelSeriesRival310Firmware> {
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
    await this.write(steelseriesRival310FirmwareQuery());
    const payload = await response;
    if (!payload) {
      throw new Error(
        "The Rival 310 did not answer on this interface. Close SteelSeries GG (and the SteelSeriesEngine service); if it still does not answer, add the device again and choose another entry.",
      );
    }
    return steelseriesRival310DecodeFirmware(payload);
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(STEELSERIES_RIVAL310_REPORT_ID, payload.buffer as ArrayBuffer);
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
