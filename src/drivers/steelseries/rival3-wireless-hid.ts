import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL3_WIRELESS_POLLING_RATES,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  RIVAL3_WIRELESS_REPORT_ID,
  steelseriesRival3WirelessBatteryQuery,
  steelseriesRival3WirelessDecodeBattery,
  steelseriesRival3WirelessDecodeFirmware,
  steelseriesRival3WirelessDpiOptions,
  steelseriesRival3WirelessEncodeButtonsMapping,
  steelseriesRival3WirelessEncodeDpiPresets,
  steelseriesRival3WirelessEncodePollingRate,
  steelseriesRival3WirelessFirmwareQuery,
  steelseriesRival3WirelessSaveCommand,
  type Rival3WirelessBattery,
  type Rival3WirelessButtonAction,
  type Rival3WirelessButtonName,
  type Rival3WirelessFirmware,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads input-report replies with a 200 ms timeout; allow slack. */
const RESPONSE_TIMEOUT_MS = 500;
/** rivalcfg profile default (`rival3_wireless.py`: "400, 800, 1200, 2400, 3200"). */
const DEFAULT_DPI = 400;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Rival 3 Wireless WebHID control (`1038:1830`, 2.4 GHz mode).
 *
 * DPI presets, polling rate, and buttons are write-only, same as Rival 3
 * Gen 1 and Aerox 3 — `rival3_wireless.py` defines no getter for any of the
 * three. Unlike either of those wired devices, this one **is** partially
 * readable: `battery_level` (`AA 01`) reports charge percentage and charging
 * state, and `firmware_version` (`90 00`) reports firmware, both via
 * input-report replies to output-report queries, same pattern as
 * `SteelSeriesRival3HidClient`'s `10 00` probe. `readStatus` uses the
 * battery query as its connectivity probe (it is the value most worth
 * reading live for a wireless mouse) and also reads firmware; DPI and
 * polling rate remain the session's last-written values (or rivalcfg's
 * documented defaults before any write), with `valuesVerified: false`
 * reflecting that those two specific values are still unread.
 *
 * The config channel is hidapi interface 3, per `rival3_wireless.py`'s
 * `"endpoint": 3` model entry; its WebHID collection shape has not been
 * captured yet, so the picker offers every interface and the wrong ones
 * fail the battery probe loudly.
 */
export class SteelSeriesRival3WirelessHidClient {
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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival3-wireless";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL3_WIRELESS_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival3WirelessDpiOptions(); }

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
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 3 Wireless"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival3-wireless",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 3 Wireless cannot report its current DPI or polling rate; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 3 Wireless",
        },
        batteryPercent: battery.level,
        batteryState: battery.isCharging ? "Charging" : "Discharging",
        dpi: this.lastWritten.dpi ?? DEFAULT_DPI,
        pollingRateHz: this.lastWritten.pollingRateHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wireless",
        liftOffDistance: null,
        firmware: [firmware.display],
      };
    });
  }

  /**
   * Replaces the mouse's DPI preset table with a single preset. The device
   * does not expose a getter for DPI, so the existing presets cannot be read
   * and preserved — record them in SteelSeries GG before testing, per
   * docs/steelseries-testing.md.
   */
  async setDpi(dpi: number): Promise<number> {
    const report = steelseriesRival3WirelessEncodeDpiPresets([dpi], 0);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3WirelessSaveCommand());
      this.lastWritten.dpi = dpi;
    });
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const report = steelseriesRival3WirelessEncodePollingRate(pollingRateHz);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3WirelessSaveCommand());
      this.lastWritten.pollingRateHz = pollingRateHz;
    });
    return pollingRateHz;
  }

  async setButtonsMapping(mapping: Partial<Record<Rival3WirelessButtonName, Rival3WirelessButtonAction>>): Promise<void> {
    const report = steelseriesRival3WirelessEncodeButtonsMapping(mapping);
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival3WirelessSaveCommand());
    });
  }

  /**
   * `AA 01` — battery percentage and charging state. Doubles as the proof
   * that the granted interface is the config channel, same role Rival 3
   * Gen 1's firmware probe plays.
   */
  private async probeBattery(): Promise<Rival3WirelessBattery> {
    const payload = await this.awaitResponse(steelseriesRival3WirelessBatteryQuery());
    if (!payload) {
      throw new Error(
        "The Rival 3 Wireless did not answer on this interface. Close SteelSeries GG (and the SteelSeriesEngine service); if it still does not answer, add the device again and choose another entry.",
      );
    }
    return steelseriesRival3WirelessDecodeBattery(payload);
  }

  /** `90 00` — firmware version, read the same way as the battery probe. */
  private async probeFirmware(): Promise<Rival3WirelessFirmware> {
    const payload = await this.awaitResponse(steelseriesRival3WirelessFirmwareQuery());
    if (!payload) {
      throw new Error("The Rival 3 Wireless did not answer the firmware query on this interface.");
    }
    return steelseriesRival3WirelessDecodeFirmware(payload);
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
    await this.device.sendReport(RIVAL3_WIRELESS_REPORT_ID, payload.buffer as ArrayBuffer);
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
