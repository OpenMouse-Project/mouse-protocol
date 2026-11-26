import type { MouseStatus } from "../mouse-types.js";
import {
  RIVAL300_DEFAULT_DPI_PRESET_1,
  RIVAL300_DEFAULT_DPI_PRESET_2,
  RIVAL300_POLLING_RATES,
  RIVAL300_REPORT_ID,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesRival300ActiveCpiQuery,
  steelseriesRival300DecodeActivePreset,
  steelseriesRival300DecodeFirmware,
  steelseriesRival300DpiOptions,
  steelseriesRival300EncodeButtonsMapping,
  steelseriesRival300EncodeLedColor,
  steelseriesRival300EncodeLedEffect,
  steelseriesRival300EncodePollingRate,
  steelseriesRival300EncodeSensitivity1,
  steelseriesRival300EncodeSensitivity2,
  steelseriesRival300FirmwareQuery,
  steelseriesRival300SaveCommand,
  type Rival300ButtonAction,
  type Rival300ButtonName,
  type Rival300Led,
  type Rival300LightEffect,
  type SteelSeriesRival300Firmware,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`, shared across every SteelSeries family. */
const COMMAND_DELAY_MS = 50;
/** rivalcfg reads input-report replies with a 200 ms timeout; allow slack. */
const RESPONSE_TIMEOUT_MS = 500;
const DEFAULT_POLLING_HZ = 1000;

/**
 * SteelSeries Rival 300 WebHID control (Rival 300 `1038:1710` and its
 * editions Fallout 4 `1038:1712`, Acer Predator `1038:1714`, CS:GO Fade
 * `1038:1394` / stm32 `1038:1716`, HP OMEN `1038:1718`, CS:GO Hyper Beast
 * `1038:171A`, Evil Geniuses `1038:171C`, plus the original Rival Dota 2
 * `1038:1392` — one shared `rival_base` vendor profile; see
 * `../../steelseries/rival-300.ts`).
 *
 * DPI (two presets, `03 01`/`03 02`), polling, both LED zones, and the six
 * buttons are write-only; the two readable values are the firmware version
 * (`10 00`) and the active preset index (`16 00`). This client uses the
 * firmware query as its connectivity probe, matching rivalcfg's
 * `rival300.py`.
 *
 * Because the active preset index is readable, `setDpi` writes the
 * **active** preset (so a change always takes effect, even after the CPI
 * button has selected preset 2) rather than always preset 1, and
 * `readStatus` reports that active preset's DPI. `setDpiPreset2` writes
 * preset 2 explicitly. Both presets are tracked independently; a preset
 * whose value this session has not written falls back to rivalcfg's
 * documented default for that preset, with `valuesVerified: false`.
 *
 * The config channel is hidapi interface 0; its WebHID collection shape has
 * not been captured yet, so the picker offers every interface and the wrong
 * ones fail the firmware probe loudly.
 */
export class SteelSeriesRival300HidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private listenerAttached = false;
  private readonly inputWaiters = new Set<(payload: Uint8Array) => void>();
  /** Last DPI this session wrote to each preset, if any. */
  private readonly presetDpi: Record<1 | 2, number | null> = { 1: null, 2: null };
  private pollingRateHz: number | null = null;

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
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "rival-300";
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...RIVAL300_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesRival300DpiOptions(); }

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
      const activePreset = await this.readActivePreset();
      const product = STEELSERIES_PRODUCTS.get(this.device.productId);
      const name = this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Rival 300"}`;
      return {
        brand: "SteelSeries",
        name,
        ui: {
          family: "steelseries-rival-300",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: `The Rival 300 cannot report the DPI of a preset this app has not written; the value shown is the last written by this app for the active preset (${activePreset}), or that preset's assumed default.`,
          defaultDisplayName: "SteelSeries Rival 300",
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: this.dpiForPreset(activePreset),
        pollingRateHz: this.pollingRateHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [firmware.display],
      };
    });
  }

  /**
   * Writes `dpi` to the **active** preset (`03 01` or `03 02`), so the change
   * takes effect even after the CPI button has switched to preset 2. The
   * active index is read first; if that read fails, this falls back to
   * preset 1 (the pre-existing behavior) rather than aborting the write.
   */
  async setDpi(dpi: number): Promise<number> {
    await this.run(async () => {
      await this.open();
      const preset = await this.readActivePreset();
      await this.write(preset === 2 ? steelseriesRival300EncodeSensitivity2(dpi) : steelseriesRival300EncodeSensitivity1(dpi));
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival300SaveCommand());
      this.presetDpi[preset] = dpi;
    });
    return dpi;
  }

  /** `03 02 <byte>` — writes sensitivity preset 2 explicitly. */
  async setDpiPreset2(dpi: number): Promise<number> {
    await this.commit(steelseriesRival300EncodeSensitivity2(dpi));
    this.presetDpi[2] = dpi;
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    await this.commit(steelseriesRival300EncodePollingRate(pollingRateHz));
    this.pollingRateHz = pollingRateHz;
    return pollingRateHz;
  }

  async setLedColor(led: Rival300Led, r: number, g: number, b: number): Promise<void> {
    await this.commit(steelseriesRival300EncodeLedColor(led, r, g, b));
  }

  async setLedEffect(led: Rival300Led, effect: Rival300LightEffect): Promise<void> {
    await this.commit(steelseriesRival300EncodeLedEffect(led, effect));
  }

  async setButtonsMapping(mapping: Partial<Record<Rival300ButtonName, Rival300ButtonAction>>): Promise<void> {
    await this.commit(steelseriesRival300EncodeButtonsMapping(mapping));
  }

  private async commit(report: Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.write(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.write(steelseriesRival300SaveCommand());
    });
  }

  /** The DPI to display for a preset: last written by this session, else that preset's rivalcfg default. */
  private dpiForPreset(preset: 1 | 2): number {
    return this.presetDpi[preset] ?? (preset === 2 ? RIVAL300_DEFAULT_DPI_PRESET_2 : RIVAL300_DEFAULT_DPI_PRESET_1);
  }

  /**
   * `10 00` — two-byte firmware version. Doubles as the proof that the
   * granted interface is the config channel.
   */
  private async probeFirmware(): Promise<SteelSeriesRival300Firmware> {
    const payload = await this.awaitResponse(steelseriesRival300FirmwareQuery());
    if (!payload) {
      throw new Error("The Rival 300 did not answer the firmware query on this interface. Add the device again and choose another entry.");
    }
    return steelseriesRival300DecodeFirmware(payload);
  }

  /**
   * `16 00` — the active preset index (1 or 2). A failed or malformed reply
   * falls back to preset 1 so a DPI write is never blocked by the probe.
   */
  private async readActivePreset(): Promise<1 | 2> {
    const payload = await this.awaitResponse(steelseriesRival300ActiveCpiQuery());
    if (!payload) return 1;
    try {
      return steelseriesRival300DecodeActivePreset(payload);
    } catch {
      return 1;
    }
  }

  /** Send a query and resolve its first input report, or null on timeout. */
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
    await this.device.sendReport(RIVAL300_REPORT_ID, payload.buffer as ArrayBuffer);
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
