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
  roccatDecodeSettingsReply,
  roccatEncodeApply,
  roccatEncodeLighting,
  roccatEncodePerformanceWrite,
  roccatEncodeSettingsQuery,
  type RoccatDpiStages,
  type RoccatSettings,
  type RoccatSettingsReply,
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
 * decoder has to treat as no-data).
 *
 * Writes follow the repo's read-patch-write-confirm cycle (as in the AJAZZ
 * driver): the settings write replaces the whole block, so every setter reads
 * the mouse's current table first, patches the one field, writes and commits,
   * then reads the table back and refuses to report success unless the mouse
   * kept it. The pre-read is also what preserves the stored DPI stages: a
   * non-DPI setter (polling rate, LOD, …) would otherwise substitute defaults
   * and silently re-scale the mouse. An asleep mouse answers the query with an
   * empty body, so a setter falls back to the last table this driver wrote, and
   * only a write with no table at all (before the first successful one) is
   * refused. What stays deliberately unfolded: the echo carries no established
   * polling/LOD/angle/debounce positions, so the UI surfaces those values only
   * from the driver's own last write, exactly how the Razer driver handles
   * write-only fields, and no battery reading is surfaced at all because the
   * status byte's mapping is unresolved.
 */
export class RoccatHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private lastWrite: RoccatSettings | null = null;

  /** Wraps a device the registry has already matched. */
  constructor(device: HIDDevice) {
    this.device = device;
  }

  /** Matches a Kone Pro (Air) that exposes the 0xFF00:0x0001 vendor collection. */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== ROCCAT_VENDOR_ID) return false;
    if (!ROCCAT_PRODUCT_IDS.includes(device.productId)) return false;
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === ROCCAT_CONFIG_USAGE_PAGE && collection.usage === ROCCAT_CONFIG_USAGE)
      || collection.children.some(search);
    return device.collections.some(search);
  }

  /** No discrete list: the five-stage editor drives DPI instead. */
  getDpiOptions(): number[] {
    return [];
  }

  /** Opens the device if the vendor link is still closed. */
  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  /** Forgets the cached table and closes the device. */
  async close(): Promise<void> {
    this.lastWrite = null;
    if (this.device.opened) await this.device.close();
  }

  /** Product label for the UI. */
  displayName(): string {
    return ROCCAT_PRODUCT_NAMES.get(this.device.productId) ?? "ROCCAT mouse";
  }

  /** Brand tag reported in MouseStatus. */
  deviceBrand(): MouseStatus["brand"] {
    return "ROCCAT";
  }

  /** Wireless on the dongle pid, wired otherwise. */
  connectionType(): "Wired" | "Wireless" {
    return this.device.productId === ROCCAT_KONE_PRO_AIR_WIRELESS_PID ? "Wireless" : "Wired";
  }

  /** The four rates the polling byte can encode. */
  getSupportedPollingRates(): number[] {
    return [...ROCCAT_HZ_TO_POLLING_CODE.keys()];
  }

  /** Largest debounce the settings byte accepts. */
  getDebounceMaxMs(): number {
    return ROCCAT_DEBOUNCE_MAX_MS;
  }

  /** Every whole-millisecond debounce in range. */
  getDebounceOptions(): number[] {
    return Array.from(
      { length: ROCCAT_DEBOUNCE_MAX_MS - ROCCAT_DEBOUNCE_MIN_MS + 1 },
      (_, index) => ROCCAT_DEBOUNCE_MIN_MS + index,
    );
  }

  /** Serializes device work so transactions cannot interleave. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Sleeps for the echo window. */
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

  /**
   * The DPI table read. Null when the mouse never answers the query. It runs
   * through the same queue as writes: the settings query and the settings
   * write share class byte 1 (0x50), so an unserialized read could accept a
   * concurrent write's echo as its reply.
   */
  async readDpiTable(): Promise<RoccatSettingsReply | null> {
    return this.run(() => this.readTable());
  }

  /**
   * Sends the settings query and decodes the echo, without queueing. For
   * callers already inside a queue task: a nested `run()` from inside
   * `patchSettings` would deadlock behind the task it is already in.
   */
  private async readTable(): Promise<RoccatSettingsReply | null> {
    const echo = await this.transact(roccatEncodeSettingsQuery());
    return echo ? roccatDecodeSettingsReply(echo) : null;
  }

  /**
   * Status snapshot. The DPI table is a verified read; polling rate, LOD,
   * angle snapping and debounce are reported from the driver's last write (or
   * neutral defaults before one), matching how the Razer driver surfaces
   * write-only fields. No battery reading is surfaced: the status byte's
   * meaning is unresolved (see the codec).
   */
  async readStatus(): Promise<MouseStatus> {
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
        valuesVerified: dpiTable !== null,
        hideLodLow: false,
        hideUnsupportedPollingRates: true,
        hideMotionSync: true,
        hideRippleControl: true,
        hideSleepCard: true,
        forceShowBattery: false,
        showAdvancedSection: true,
        pollingNote: "Polling is write-only here: the echo does not yet decode a rate, so the value shown is the last one written, not a value read back.",
        statusNote: dpiTable === null
          ? "The mouse did not answer its settings query, so DPI could not be read."
          : undefined,
      },
      batteryPercent: null,
      batteryState: "Unknown",
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
    await this.patchSettings(
      (current) => ({ ...current, dpi: { stages: [...stages], stagesY: [...stagesY] } }),
      `DPI stages ${stages.join("/")}`,
    );
  }

  /** Setter for the polling byte; rejects rates the table lacks. */
  async setPollingRateHz(rateHz: number): Promise<void> {
    if (!ROCCAT_HZ_TO_POLLING_CODE.has(rateHz)) throw new RangeError(`Unsupported polling rate: ${rateHz} Hz.`);
    await this.patchSettings((current) => ({ ...current, pollingRateHz: rateHz }), `polling rate ${rateHz} Hz`);
  }

  /** Setter for the angle-snapping flag. */
  async setAngleSnapping(enabled: boolean): Promise<void> {
    await this.patchSettings((current) => ({ ...current, angleSnapping: enabled }), `angle snapping ${enabled ? "on" : "off"}`);
  }

  /** Setter for the lift-off distance. */
  async setLiftOffDistance(lod: "Low" | "High"): Promise<void> {
    if (!ROCCAT_LOD_TO_CODE.has(lod)) throw new RangeError(`Unsupported lift-off distance: ${lod}`);
    await this.patchSettings((current) => ({ ...current, lod }), `lift-off distance ${lod}`);
  }

  /** Setter for the debounce byte. */
  async setDebounceMs(ms: number): Promise<void> {
    await this.patchSettings((current) => ({ ...current, debounceMs: ms }), `debounce ${ms} ms`);
  }

  /** Setter for the LED-off timeout. */
  async setLedTimeout(minutes: number): Promise<void> {
    await this.patchSettings((current) => ({ ...current, ledTimeoutMinutes: minutes }), `LED timeout ${minutes} min`);
  }

  /**
   * Read the current table, patch one field, write and commit, then read the
   * table back and confirm the mouse kept it — the same read-patch-write-
   * confirm cycle the AJAZZ driver uses. The frame is encoded before any state
   * changes, so an invalid value throws without poisoning `lastWrite`.
   *
   * An asleep mouse answers the settings query with an empty body, so the
   * stages come from the live read when there is one and otherwise from this
   * driver's own last write. A first-ever write has neither and is refused:
   * the write replaces the whole block, so inventing the stages would silently
   * re-scale the sensor. When the table could not be read the write still goes
   * out, but the confirm step is skipped — there is nothing to compare
   * against — and `readStatus` keeps deriving `valuesVerified` from whether a
   * table was readable, not from the write.
   *
   * The whole cycle is a single queue task, and its reads call `transact`
   * directly rather than `readDpiTable`: two concurrent setters must not
   * interleave read/patch/write, or one setter's pre-read could observe the
   * other's half-applied write. A nested `run()` here would instead deadlock.
   */
  private async patchSettings(
    patch: (current: RoccatSettings) => RoccatSettings,
    describe: string,
  ): Promise<void> {
    await this.run(async () => {
      const current = await this.readTable();
      const dpi = current?.dpi ?? this.lastWrite?.dpi;
      if (!dpi) {
        throw new Error("Could not read the mouse's current settings (an asleep mouse answers with an empty table), so the write was refused rather than overwrite the stored DPI stages. Wake the mouse and try again.");
      }
      const settings = patch({ ...(this.lastWrite ?? DEFAULT_SETTINGS), dpi });
      const frame = roccatEncodePerformanceWrite(settings);
      const apply = roccatEncodeApply();
      await this.write(frame);
      await this.delay(50);
      await this.write(apply);
      const confirmed = await this.readTable();
      if (confirmed && !sameStages(confirmed.dpi, settings.dpi)) {
        throw new Error(`The mouse kept DPI ${formatStages(confirmed.dpi)} instead of the requested ${describe}.`);
      }
      this.lastWrite = settings;
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

/** Parses `#rrggbb` into an RGB triple. */
function parseRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new RangeError(`Colour must be #rrggbb, received ${hex}`);
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** True when both stage tables match on both axes. */
function sameStages(a: RoccatDpiStages, b: RoccatDpiStages): boolean {
  return a.stages.length === b.stages.length
    && a.stagesY.length === b.stagesY.length
    && a.stages.every((value, index) => value === b.stages[index])
    && a.stagesY.every((value, index) => value === b.stagesY[index]);
}

/** Renders a stage table for error messages. */
function formatStages(dpi: RoccatDpiStages): string {
  return `${dpi.stages.join("/")} (X) ${dpi.stagesY.join("/")} (Y)`;
}
