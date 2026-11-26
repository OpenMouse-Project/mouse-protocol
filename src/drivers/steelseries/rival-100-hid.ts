import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL100_PC_BANG_BUTTON6_PREFIX,
  RIVAL100_POLLING_RATES,
  RIVAL100_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesRival100DecodeFirmware,
  steelseriesRival100DpiOptions,
  steelseriesRival100EncodeButton6Mode,
  steelseriesRival100EncodeLedColor,
  steelseriesRival100EncodeLightEffect,
  steelseriesRival100EncodePollingRate,
  steelseriesRival100EncodeSensitivity1,
  steelseriesRival100EncodeSensitivity2,
  steelseriesRival100FirmwareQuery,
  steelseriesRival100SaveCommand,
  type Rival100Button6Mode,
  type Rival100LightEffect,
  type SteelSeriesRival100Firmware,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads input-report replies with a 200 ms timeout; allow slack. */
const RESPONSE_TIMEOUT_MS = 500;
/** rivalcfg profile default (`rival100.py`: `sensitivity1` default 1000). */
const DEFAULT_DPI = 1000;
const DEFAULT_POLLING_HZ = 1000;
/** The Rival 100 PC Bang edition needs this pre-packet before a button-6 write. */
const PC_BANG_PRODUCT_ID = 0x1708;

/**
 * SteelSeries Rival 100 WebHID control (Rival 100 `1038:1702` and its
 * special editions `1038:1708` PC Bang / `1038:170A` Dell China /
 * `1038:170B`+`1038:170C` Dota 2, plus the Rival 105 `1038:1814` — one
 * shared vendor profile; see `../../steelseries/rival-100.ts`).
 *
 * DPI (two presets, `03 01`/`03 02`) and polling are write-only; the two
 * readable values are the firmware version (`10 00`) and the active preset
 * index (`16 00`). This client uses the firmware query as its connectivity
 * probe, matching rivalcfg's `rival100.py` (note: the vendor file has that
 * query commented out for the Rival 100 base model; see the codec). DPI
 * presets, polling, and the LED are the session's last-written values (or
 * rivalcfg's documented defaults before any write) with
 * `valuesVerified: false`.
 *
 * This mouse has **no button remapping at all** — the codec exposes only the
 * button-6 (CPI) mode toggle. The config channel is hidapi interface 0; its
 * WebHID collection shape has not been captured yet, so the picker offers
 * every interface and the wrong ones fail the firmware probe loudly.
 */
export class SteelSeriesRival100HidClient {
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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival-100";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL100_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival100DpiOptions(); }

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
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 100"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival-100",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The Rival 100 cannot report its current DPI or polling rate; values shown are the last written by this app, or assumed defaults.",
          defaultDisplayName: "SteelSeries Rival 100",
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

  /** `03 01 <byte>` — writes sensitivity preset 1. The device has no getter, so preset 2 is untouched. */
  async setDpi(dpi: number): Promise<number> {
    await this.commit(steelseriesRival100EncodeSensitivity1(dpi));
    this.lastWritten.dpi = dpi;
    return dpi;
  }

  /** `03 02 <byte>` — writes sensitivity preset 2. */
  async setDpiPreset2(dpi: number): Promise<number> {
    await this.commit(steelseriesRival100EncodeSensitivity2(dpi));
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    await this.commit(steelseriesRival100EncodePollingRate(pollingRateHz));
    this.lastWritten.pollingRateHz = pollingRateHz;
    return pollingRateHz;
  }

  async setLedColor(r: number, g: number, b: number): Promise<void> {
    await this.commit(steelseriesRival100EncodeLedColor(r, g, b));
  }

  async setLightEffect(effect: Rival100LightEffect): Promise<void> {
    await this.commit(steelseriesRival100EncodeLightEffect(effect));
  }

  /** `0B <mode>` — CPI button mode. The PC Bang edition gets its pre-packet first. */
  async setButton6Mode(mode: Rival100Button6Mode): Promise<void> {
    const report = steelseriesRival100EncodeButton6Mode(mode);
    const isPcBang = this.device.productId === PC_BANG_PRODUCT_ID;
    await this.run(async () => {
      await this.open();
      if (isPcBang) {
        await this.write(new Uint8Array(RIVAL100_PC_BANG_BUTTON6_PREFIX));
        await this.delay(COMMAND_DELAY_MS);
      }
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival100SaveCommand());
    });
  }

  private async commit(report: Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival100SaveCommand());
    });
  }

  /**
   * `10 00` — two-byte firmware version. Doubles as the proof that the
   * granted interface is the config channel.
   */
  private async probeFirmware(): Promise<SteelSeriesRival100Firmware> {
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
    await this.write(steelseriesRival100FirmwareQuery());
    const payload = await response;
    if (!payload) {
      throw new Error("The Rival 100 did not answer the firmware query on this interface. Add the device again and choose another entry.");
    }
    return steelseriesRival100DecodeFirmware(payload);
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(RIVAL100_REPORT_ID, payload.buffer as ArrayBuffer);
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
