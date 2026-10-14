import type { MouseStatus } from "../mouse-types.ts";
import {
  ROCCAT_CONFIG_USAGE,
  ROCCAT_CONFIG_USAGE_PAGE,
  ROCCAT_DEBOUNCE_MAX_MS,
  ROCCAT_DEBOUNCE_MIN_MS,
  ROCCAT_DPI_STAGE_COUNT,
  ROCCAT_HZ_TO_POLLING_CODE,
  ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
  ROCCAT_LOD_TO_CODE,
  ROCCAT_PACKET_LENGTH,
  ROCCAT_PRODUCT_IDS,
  ROCCAT_PRODUCT_NAMES,
  ROCCAT_REPORT_ID,
  ROCCAT_VENDOR_ID,
  roccatDecodeBattery,
  roccatDecodeSettingsReply,
  roccatEncodeApply,
  roccatEncodeLighting,
  roccatEncodePerformanceWrite,
  roccatEncodeSettingsQuery,
  roccatEncodeStatus,
  type RoccatSettings,
} from "../../roccat/index.ts";

/**
 * ROCCAT Kone Pro Air and Kone Pro over their vendor 0xFF00:0x0001 output
 * channel (see `@openmouse/protocol/roccat`). Frames are 64-byte unnumbered
 * output reports; the mouse answers on the same interface's input stream,
 * echoing the frame's class byte 1.
 *
 * What is verified on hardware (see `captures/roccat-kone-pro-air/`):
 * every frame here was replayed against the dongle and accepted, the status
 * stream answers `90 0a 04 …`, and a settings echo carried a full stage table
 * once the mouse was awake (an asleep mouse echoes a zero body, which the
 * decoder has to treat as no-data). What is deliberately not faked: the
 * echo's polling/LOD/debounce positions and the battery-to-percent mapping
 * are not established, so the UI surfaces those values only from the
 * driver's own last write and labels the read as unknown — exactly how the
 * Razer driver surfaces write-only fields.
 */
export class RoccatHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private lastWrite: RoccatSettings | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== ROCCAT_VENDOR_ID) return false;
    if (!ROCCAT_PRODUCT_IDS.includes(device.productId)) return false;
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === ROCCAT_CONFIG_USAGE_PAGE && collection.usage === ROCCAT_CONFIG_USAGE)
      || collection.children.some(search);
    return device.collections.some(search);
  }

  getDpiOptions(): number[] {
    return [];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastWrite = null;
    if (this.device.opened) await this.device.close();
  }

  displayName(): string {
    return ROCCAT_PRODUCT_NAMES.get(this.device.productId) ?? "ROCCAT mouse";
  }

  deviceBrand(): MouseStatus["brand"] {
    return "ROCCAT";
  }

  connectionType(): "Wired" | "Wireless" {
    return this.device.productId === ROCCAT_KONE_PRO_AIR_WIRELESS_PID ? "Wireless" : "Wired";
  }

  getSupportedPollingRates(): number[] {
    return [...ROCCAT_HZ_TO_POLLING_CODE.keys()];
  }

  getDebounceMaxMs(): number {
    return ROCCAT_DEBOUNCE_MAX_MS;
  }

  getDebounceOptions(): number[] {
    return Array.from(
      { length: ROCCAT_DEBOUNCE_MAX_MS - ROCCAT_DEBOUNCE_MIN_MS + 1 },
      (_, index) => ROCCAT_DEBOUNCE_MIN_MS + index,
    );
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  /**
   * Sends one unnumbered 64-byte output report on the vendor interface.
   * Callers serialize; this must not queue a run() of its own because
   * commit() is itself run inside the queue.
   */
  private async write(payload: Uint8Array): Promise<void> {
    await this.open();
    const frame = new Uint8Array(ROCCAT_PACKET_LENGTH);
    frame.set(payload.subarray(0, ROCCAT_PACKET_LENGTH));
    await this.device.sendReport(ROCCAT_REPORT_ID, frame as BufferSource);
  }

  /**
   * Sends a frame and collects the echo the mouse answers with on the input
   * stream. The echo matches on frame byte 1 (the report's class byte), the
   * one byte every captured variant echoes verbatim.
   */
  private async transact(payload: Uint8Array, waitMs = 250): Promise<Uint8Array | null> {
    await this.open();
    let echo: Uint8Array | null = null;
    const listener = (event: HIDInputReportEvent): void => {
      const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      if (data.length >= 3 && data[1] === payload[1] && !echo) echo = data.subarray(0, 24);
    };
    this.device.addEventListener("inputreport", listener);
    try {
      await this.write(payload);
      await this.delay(waitMs);
    } finally {
      this.device.removeEventListener("inputreport", listener);
    }
    return echo;
  }

  /** Battery percent, or null when the status probe goes unanswered. */
  async readBattery(): Promise<number | null> {
    const echo = await this.transact(roccatEncodeStatus());
    return echo ? roccatDecodeBattery(echo) : null;
  }

  /** The DPI table read. Null when the mouse never answers the query. */
  async readDpiTable(): Promise<ReturnType<typeof roccatDecodeSettingsReply>> {
    const echo = await this.transact(roccatEncodeSettingsQuery());
    return echo ? roccatDecodeSettingsReply(echo) : null;
  }

  /**
   * Status snapshot. Battery is a verified read; the DPI table is a verified
   * read; polling rate, LOD, angle snapping and debounce are reported from the
   * driver's last write (or neutral defaults before one), matching how the
   * Razer driver surfaces write-only fields.
   */
  async readStatus(): Promise<MouseStatus> {
    // Serial, not Promise.all: concurrent transactions would race each
    // other's input-report listeners on a link that answers one echo at a
    // time.
    const battery = await this.readBattery();
    const dpiTable = await this.readDpiTable();
    const name = this.displayName();
    const connection = this.connectionType();
    const last = this.lastWrite;
    return {
      brand: "ROCCAT",
      name,
      ui: {
        family: "roccat",
        settingsReady: dpiTable !== null,
        valuesVerified: dpiTable !== null || battery !== null,
        hideLodLow: false,
        hideUnsupportedPollingRates: true,
        hideMotionSync: true,
        hideRippleControl: true,
        hideSleepCard: true,
        forceShowBattery: connection === "Wireless",
        showAdvancedSection: true,
        pollingNote: "Polling changes write and stick, but the echo does not yet decode a rate, so the value shown is the last one written.",
        statusNote: dpiTable === null
          ? "The mouse did not answer its settings query, so DPI could not be read."
          : undefined,
      },
      batteryPercent: battery,
     batteryState: connection === "Wired"
        ? (battery === 100 ? "Full" : "Charging")
        : "Discharging",
      dpi: (dpiTable?.dpi.stages[0] ?? last?.dpi.stages[0] ?? 0),
      dpiY: dpiTable?.dpi.stagesY[0] ?? last?.dpi.stagesY[0],
      supportsSeparateDpiAxes: true,
      pollingRateHz: last?.pollingRateHz ?? 0,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      debounceMs: last?.debounceMs ?? null,
      sleepTimeout: null,
      angleSnapping: last?.angleSnapping ?? null,
      liftOffDistance: last?.lod ?? null,
      connectionType: connection,
      connectionDetail: connection === "Wireless" ? "2.4 GHz (Stellar Wireless)" : "Wired USB",
      motionSync: null,
      rippleControl: null,
      dpiStages: dpiTable?.dpi.stages ? [...dpiTable.dpi.stages] : undefined,
      dpiStagesY: dpiTable?.dpi.stagesY ? [...dpiTable.dpi.stagesY] : undefined,
      activeDpiStage: 0,
      firmware: [],
    };
  }

  /**
   * The DPI stage editor hook: the block carries five stages per axis, in the
   * vendor's 50-step slots.
   */
  async setDpiStages(stages: readonly number[], stagesY: readonly number[]): Promise<void> {
    if (stages.length !== ROCCAT_DPI_STAGE_COUNT || stagesY.length !== ROCCAT_DPI_STAGE_COUNT) {
      throw new RangeError("The settings write carries five stages per axis.");
    }
    const settings: RoccatSettings = {
      ...(this.lastWrite ?? DEFAULT_SETTINGS),
      dpi: { stages: [...stages], stagesY: [...stagesY] },
    };
    await this.commit(settings);
  }

  async setPollingRateHz(rateHz: number): Promise<void> {
    if (!ROCCAT_HZ_TO_POLLING_CODE.has(rateHz)) throw new RangeError(`Unsupported polling rate: ${rateHz} Hz.`);
    const settings: RoccatSettings = { ...(this.lastWrite ?? DEFAULT_SETTINGS), pollingRateHz: rateHz };
    await this.commit(settings);
  }

  async setAngleSnapping(enabled: boolean): Promise<void> {
    const settings: RoccatSettings = { ...(this.lastWrite ?? DEFAULT_SETTINGS), angleSnapping: enabled };
    await this.commit(settings);
  }

  async setLiftOffDistance(lod: "Low" | "High"): Promise<void> {
    if (!ROCCAT_LOD_TO_CODE.has(lod)) throw new RangeError(`Unsupported lift-off distance: ${lod}`);
    const settings: RoccatSettings = { ...(this.lastWrite ?? DEFAULT_SETTINGS), lod };
    await this.commit(settings);
  }

  async setDebounceMs(ms: number): Promise<void> {
    const settings: RoccatSettings = { ...(this.lastWrite ?? DEFAULT_SETTINGS), debounceMs: ms };
    await this.commit(settings);
  }

  async setLedTimeout(minutes: number): Promise<void> {
    const settings: RoccatSettings = { ...(this.lastWrite ?? DEFAULT_SETTINGS), ledTimeoutMinutes: minutes };
    await this.commit(settings);
  }

  /**
   * Writes the replays-and-commits sequence: the 0x…50 0x14 settings write
   * followed by the `…50 18 04` commit tail.
   */
  private async commit(settings: RoccatSettings): Promise<void> {
    this.lastWrite = settings;
    await this.run(async () => {
      await this.write(roccatEncodePerformanceWrite(settings));
      await this.delay(50);
      await this.write(roccatEncodeApply());
    });
  }

  /**
   * Lighting is write-only — there is no known read-back. The two inner zones
   * take raw RGB; callers pass `#rrggbb` colours.
   */
  async setLighting(left: string, right: string): Promise<void> {
    const l = parseRgb(left);
    const r = parseRgb(right);
    await this.run(async () => {
      await this.write(roccatEncodeLighting(l, r));
    });
  }
}

const DEFAULT_SETTINGS: RoccatSettings = {
  pollingRateHz: 1000,
  angleSnapping: false,
  lod: "Low",
  ledTimeoutMinutes: 15,
  debounceMs: 10,
  dpi: { stages: [400, 800, 1200, 1600, 3200], stagesY: [400, 800, 1200, 1600, 3200] },
};

function parseRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new RangeError(`Colour must be #rrggbb, received ${hex}`);
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
