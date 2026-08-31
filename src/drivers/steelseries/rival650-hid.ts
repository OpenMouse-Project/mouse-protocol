import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL650_POLLING_RATES,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  RIVAL650_REPORT_ID,
  steelseriesRival650BatteryQuery,
  steelseriesRival650DecodeBattery,
  steelseriesRival650DpiOptions,
  steelseriesRival650EncodeButtonsMapping,
  steelseriesRival650EncodeLiftOffDistance,
  steelseriesRival650EncodePollingRate,
  steelseriesRival650EncodeSensitivity1,
  steelseriesRival650EncodeSleepTimer,
  steelseriesRival650SaveCommand,
  type Rival650Battery,
  type Rival650ButtonAction,
  type Rival650ButtonName,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads input-report replies with a 200 ms timeout; allow slack. */
const RESPONSE_TIMEOUT_MS = 500;
/** rivalcfg profile default (`rival650.py`: `sensitivity1` default 800). */
const DEFAULT_DPI = 800;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Rival 650 Wireless WebHID control (`1038:172B` wired mode,
 * `1038:1726` 2.4 GHz wireless mode).
 *
 * DPI (two independent presets, `sensitivity1`/`sensitivity2` — this codec
 * exposes `setDpi` against preset 1 only, matching every other SteelSeries
 * family's single-`setDpi` surface), polling rate, lift-off distance,
 * buttons, and the sleep timer are all write-only — `rival650.py` defines no
 * getter for any of them. Unlike `SteelSeriesRival3WirelessHidClient`, this
 * device has **no firmware-query command** at all (`rival650.py` defines no
 * `firmware_version` block), so `readStatus` reports firmware as unknown
 * rather than probing for it. `battery_level` (`AA 01`) is readable and
 * doubles as this client's connectivity probe, same role it plays for the
 * Rival 3 Wireless. `readStatus` therefore has `valuesVerified: false`:
 * DPI, polling rate, and lift-off distance are the session's last-written
 * values (or rivalcfg's documented defaults before any write).
 *
 * The config channel is hidapi interface 0, per `rival650.py`'s
 * `"endpoint": 0` model entries (both PIDs); its WebHID collection shape has
 * not been captured yet, so the picker offers every interface and the wrong
 * ones fail the battery probe loudly.
 */
export class SteelSeriesRival650HidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private listenerAttached = false;
  private readonly inputWaiters = new Set<(payload: Uint8Array) => void>();
  private lastWritten: { dpi: number | null; pollingRateHz: number | null; liftOffDistance: number | null } = {
    dpi: null,
    pollingRateHz: null,
    liftOffDistance: null,
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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival650";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL650_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival650DpiOptions(); }

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
      const product = STEELSERIES_PRODUCTS.get(this.device.productId);
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 650 Wireless"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival650",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 650 Wireless cannot report its current DPI, polling rate, or lift-off distance; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 650 Wireless",
        },
        batteryPercent: battery.level,
        batteryState: battery.isCharging ? "Charging" : "Discharging",
        dpi: this.lastWritten.dpi ?? DEFAULT_DPI,
        pollingRateHz: this.lastWritten.pollingRateHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wireless",
        // `MouseStatus.liftOffDistance` is the shared three-stop Low/Medium/
        // High enum; this device's 1–8 mm scale does not map onto it cleanly
        // (same reason every sibling SteelSeries client reports null here),
        // so the raw last-written millimeter value stays internal to this
        // client (`this.lastWritten.liftOffDistance`) rather than surfaced.
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  /** `15 01 <v>` — sensitivity preset 1. The device has no getter, so preset 2 is left untouched by this call. */
  async setDpi(dpi: number): Promise<number> {
    const report = steelseriesRival650EncodeSensitivity1(dpi);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival650SaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesRival650EncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival650SaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  /** `20 01 <v>` — lift-off distance, 1–8 mm. */
  async setLiftOffDistance(millimeters: number): Promise<number> {
    const report = steelseriesRival650EncodeLiftOffDistance(millimeters);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival650SaveCommand());
      this.lastWritten.liftOffDistance = millimeters;
    });
    return millimeters;
  }

  /** `2B 01 01 00 00 00 <v>` — idle minutes before sleep, 1–20. */
  async setSleepTimer(minutes: number): Promise<void> {
    const report = steelseriesRival650EncodeSleepTimer(minutes);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival650SaveCommand());
    });
  }

  async setButtonsMapping(mapping: Partial<Record<Rival650ButtonName, Rival650ButtonAction>>): Promise<void> {
    const report = steelseriesRival650EncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival650SaveCommand());
    });
  }

  /**
   * `AA 01` — battery percentage and charging state. Doubles as the proof
   * that the granted interface is the config channel, same role it plays
   * for `SteelSeriesRival3WirelessHidClient`.
   */
  private async probeBattery(): Promise<Rival650Battery> {
    const payload = await this.awaitResponse(steelseriesRival650BatteryQuery());
    if (!payload) {
      throw new Error(
        "The Rival 650 Wireless did not answer on this interface. Close SteelSeries GG (and the SteelSeriesEngine service); if it still does not answer, add the device again and choose another entry.",
      );
    }
    return steelseriesRival650DecodeBattery(payload);
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

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(RIVAL650_REPORT_ID, payload.buffer as ArrayBuffer);
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
