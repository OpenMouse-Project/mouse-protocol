import type { MouseStatus, MouseUiHints } from "../mouse-types.ts";
import {
  GLORIOUS_CLASSIC_DEBOUNCE_MAX_MS,
  GLORIOUS_CLASSIC_DEFAULT_RGB,
  GLORIOUS_CLASSIC_DPI_MAX,
  GLORIOUS_CLASSIC_DPI_MIN,
  GLORIOUS_CLASSIC_DPI_STAGE_COUNT,
  GLORIOUS_CLASSIC_LOD_HIGH_MM,
  GLORIOUS_CLASSIC_LOD_MEDIUM_MM,
  GLORIOUS_CLASSIC_PACKET_LENGTH,
  GLORIOUS_CLASSIC_POLLING_RATES,
  GLORIOUS_CLASSIC_PROFILE_DEFAULT,
  GLORIOUS_CLASSIC_REPORT_ID,
  buildGloriousClassicActiveStagePayload,
  buildGloriousClassicBatteryRequestPayload,
  buildGloriousClassicDebouncePayload,
  buildGloriousClassicDpiStagesPayload,
  buildGloriousClassicLiftOffPayload,
  buildGloriousClassicPollingRatePayload,
  buildGloriousClassicRgbPayload,
  gloriousClassicDecodePollingRate,
  gloriousClassicEncodePollingRate,
  parseGloriousClassicBatteryResponse,
  type GloriousClassicBattery,
  type GloriousClassicBatteryState,
  type GloriousClassicRgb,
} from "../../glorious-classic/index.ts";
import { GLORIOUS_CLASSIC_PRODUCTS, VENDOR_ID } from "../vendors.ts";

/**
 * Driver for Glorious's pre-Pixart "classic" line (Model O / O-, Model D /
 * D-, Model I, Model O V2 — plus the newer "core2" 8000Hz-class mice, Model
 * O3 Wireless and Model D 2 PRO 4K/8KHz Edition, on a reduced feature set —
 * see the `generation` doc comment on `GLORIOUS_CLASSIC_PRODUCTS` in
 * vendors.ts for why). The config channel is a feature report, usually 64
 * bytes and unnumbered (id 0), but a real "Model O 2 Wired Mouse"
 * (0x320f:0x823a) instead carries it as numbered report 7 at a 263-byte
 * declared length. Both the report id and byte length are read from the
 * device's own descriptor rather than assumed, so it connects - but every
 * payload below is only reverse-engineered against the 64-byte case, and a
 * diagnostic confirmed the mouse silently ignores a 64-byte payload just
 * zero-padded out to 263 (WebHID's write succeeds; nothing changes on the
 * mouse). See isConfirmedReportLength()'s doc comment: writes are refused
 * for any length this driver hasn't confirmed a real byte layout for,
 * rather than guessing again. See ../../glorious-classic/index.ts for the
 * payload layout, which does not depend on the report id.
 *
 * DPI, polling rate, lift-off distance, and RGB are all write-only on this
 * protocol (neither glorious-ctl nor mxw, the two tools this was ported
 * from, implement a read for them) — like the sibling Pixart driver in
 * ./hid.ts, this class keeps its own last-applied-settings cache so the UI
 * has something to show. Only battery status is actually read from the
 * mouse.
 */

// Config channel usage pages. Older firmware used 0xff01/0xff00; newer
// firmware (confirmed on a Model D Wireless, 0x258a:0x2012) moved the
// unnumbered config feature report to the 0xffff:0 collection instead.
const CLASSIC_USAGE_PAGES = [0xff01, 0xff00, 0xffff];
const BATTERY_RESPONSE_DELAY_MS = 60;

const BATTERY_STATE_LABEL: Record<GloriousClassicBatteryState, MouseStatus["batteryState"]> = {
  Normal: "Discharging",
  Asleep: "Unknown",
  WakingUp: "Unknown",
  Unknown: "Unknown",
};

const LIFT_OFF_DISTANCES: ReadonlyArray<readonly [millimetres: number, name: NonNullable<MouseStatus["liftOffDistance"]>]> = [
  [GLORIOUS_CLASSIC_LOD_MEDIUM_MM, "Medium"],
  [GLORIOUS_CLASSIC_LOD_HIGH_MM, "High"],
];

interface GloriousClassicState {
  profileId: number;
  stageDpis: number[];
  activeStage: number;
  pollingIntervalMs: number;
  lodMm: number;
  debounceMs: number;
}

const DEFAULT_STATE: GloriousClassicState = {
  profileId: GLORIOUS_CLASSIC_PROFILE_DEFAULT,
  stageDpis: [800, 1600, 3200, 6400],
  activeStage: 0,
  pollingIntervalMs: 1,
  lodMm: GLORIOUS_CLASSIC_LOD_MEDIUM_MM,
  debounceMs: 0,
};

export class GloriousClassicHidClient {
  readonly pollIntervalMs = 0;
  readonly device: HIDDevice;
  /**
   * The vendor collection's feature report id and byte length, read from the
   * device at connect time rather than assumed - see isConfirmedReportLength()
   * for why a length other than 64 means writes get refused instead of guessed at.
   */
  private readonly reportId: number;
  private readonly reportLength: number;
  private lastRgb: GloriousClassicRgb = GLORIOUS_CLASSIC_DEFAULT_RGB;

  constructor(device: HIDDevice) {
    this.device = device;
    const config = GloriousClassicHidClient.findConfigReport(device);
    this.reportId = config?.reportId ?? GLORIOUS_CLASSIC_REPORT_ID;
    this.reportLength = config?.length ?? GLORIOUS_CLASSIC_PACKET_LENGTH;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== VENDOR_ID.gloriousClassic
      && device.vendorId !== VENDOR_ID.gloriousClassicI
      && device.vendorId !== VENDOR_ID.gloriousClassicIWired
      && device.vendorId !== VENDOR_ID.gloriousO3) return false;
    if (!GLORIOUS_CLASSIC_PRODUCTS.has(device.productId)) return false;
    return this.findConfigReport(device) !== null;
  }

  /** The feature-report id and byte length carried by the config channel collection, or null. */
  private static findConfigReport(device: HIDDevice): { reportId: number; length: number } | null {
    for (const collection of device.collections) {
      const found = this.findConfigReportIn(collection);
      if (found !== null) return found;
    }
    return null;
  }

  private static findConfigReportIn(collection: HIDCollectionInfo): { reportId: number; length: number } | null {
    if (CLASSIC_USAGE_PAGES.includes(collection.usagePage) && collection.featureReports.length > 0) {
      const report = collection.featureReports[0];
      const bits = report.items.reduce((sum, item) => sum + (item.reportSize ?? 0) * (item.reportCount ?? 0), 0);
      return { reportId: report.reportId, length: bits > 0 ? Math.ceil(bits / 8) : GLORIOUS_CLASSIC_PACKET_LENGTH };
    }
    for (const child of collection.children) {
      const found = this.findConfigReportIn(child);
      if (found !== null) return found;
    }
    return null;
  }

  /** Resizes a payload (always built at GLORIOUS_CLASSIC_PACKET_LENGTH) to the device's real declared length. */
  private fitPayload(payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    if (payload.length === this.reportLength) return payload;
    const resized = new Uint8Array(this.reportLength);
    resized.set(payload.subarray(0, Math.min(payload.length, this.reportLength)));
    return resized;
  }

  private async send(payload: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.device.sendFeatureReport(this.reportId, this.fitPayload(payload));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  displayName(): string {
    if (this.device.productName) return this.device.productName;
    return GLORIOUS_CLASSIC_PRODUCTS.get(this.device.productId)?.name ?? "Glorious mouse";
  }

  isWireless(): boolean {
    return GLORIOUS_CLASSIC_PRODUCTS.get(this.device.productId)?.wireless ?? false;
  }

  /**
   * "core2" (Model O3 Wireless, Model D 2 PRO 4K/8KHz Edition) only gets
   * RGB/debounce/battery — see the doc comment on `GLORIOUS_CLASSIC_PRODUCTS`
   * in vendors.ts for why DPI/polling/LOD stay off for this generation.
   */
  private isCore2(): boolean {
    return GLORIOUS_CLASSIC_PRODUCTS.get(this.device.productId)?.generation === "core2";
  }

  /**
   * Every payload builder in glorious-classic/index.ts was reverse-engineered
   * against the 64-byte feature report every classic-line unit confirmed so
   * far uses. A real 0x320f:0x823a instead declares a 263-byte report;
   * resizing our 64-byte payload to fit sends without a WebHID error, but a
   * diagnostic confirmed the mouse ignores it outright - the firmware ACKs
   * the write and changes nothing. A report length this driver hasn't seen a
   * real byte layout for is therefore not writable yet, even though it
   * connects and its report id is known - see [[glorious-classic-protocol]]
   * in memory. Refuse instead of guessing again until a capture of the
   * device's own official software gives the real layout.
   */
  private isConfirmedReportLength(): boolean {
    return this.reportLength === GLORIOUS_CLASSIC_PACKET_LENGTH;
  }

  private assertWritable(feature: string): void {
    if (this.isCore2()) throw new Error(`${feature} is not confirmed on this mouse's newer protocol generation yet.`);
    if (!this.isConfirmedReportLength()) {
      throw new Error(`${feature} is not confirmed on this unit's ${this.reportLength}-byte feature report yet.`);
    }
  }

  getDpiOptions(): number[] {
    if (this.isCore2() || !this.isConfirmedReportLength()) return [];
    const options: number[] = [];
    for (let dpi = GLORIOUS_CLASSIC_DPI_MIN; dpi <= GLORIOUS_CLASSIC_DPI_MAX; dpi += 50) options.push(dpi);
    return options;
  }

  getSupportedPollingRates(): number[] {
    if (this.isCore2() || !this.isConfirmedReportLength()) return [];
    return GLORIOUS_CLASSIC_POLLING_RATES.map(([, hertz]) => hertz).sort((left, right) => left - right);
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const state = this.loadState();
    const battery = this.isWireless() ? await this.readBattery().catch(() => null) : null;
    const wireless = this.isWireless();
    const core2 = this.isCore2();
    const restricted = core2 || !this.isConfirmedReportLength();
    const liftOffDistance = restricted ? null : LIFT_OFF_DISTANCES.find(([mm]) => mm === state.lodMm)?.[1] ?? "Medium";
    return {
      brand: "Glorious",
      name: this.displayName(),
      ui: this.getUiHints(),
      batteryPercent: battery?.percent ?? null,
      batteryState: battery
        ? (battery.state === "Normal" && battery.charging ? "Charging" : BATTERY_STATE_LABEL[battery.state])
        : "Unknown",
      dpi: restricted ? 0 : state.stageDpis[state.activeStage] ?? state.stageDpis[0] ?? 800,
      pollingRateHz: restricted ? 0 : gloriousClassicDecodePollingRate(state.pollingIntervalMs) ?? 1000,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: restricted ? null : state.profileId,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless
        ? "2.4 GHz / Bluetooth · settings are write-only, not read back"
        : "Wired USB · settings are write-only, not read back",
      debounceMs: state.debounceMs,
      liftOffDistance,
      firmware: [],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    this.assertWritable("DPI");
    if (!Number.isFinite(dpi) || dpi < GLORIOUS_CLASSIC_DPI_MIN || dpi > GLORIOUS_CLASSIC_DPI_MAX) {
      throw new Error(`DPI must be between ${GLORIOUS_CLASSIC_DPI_MIN} and ${GLORIOUS_CLASSIC_DPI_MAX}.`);
    }
    const state = this.loadState();
    const rounded = Math.round(dpi);
    state.stageDpis[state.activeStage] = rounded;
    await this.open();
    await this.send(buildGloriousClassicDpiStagesPayload(state.stageDpis, state.profileId));
    await this.send(buildGloriousClassicActiveStagePayload(state.activeStage + 1, state.profileId));
    this.saveState(state);
    return rounded;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    this.assertWritable("Polling rate");
    const intervalMs = gloriousClassicEncodePollingRate(pollingRateHz);
    if (intervalMs === null) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
    const state = this.loadState();
    await this.open();
    await this.send(buildGloriousClassicPollingRatePayload(intervalMs));
    state.pollingIntervalMs = intervalMs;
    this.saveState(state);
    return pollingRateHz;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    this.assertWritable("Lift-off distance");
    const millimetres = LIFT_OFF_DISTANCES.find(([, name]) => name === value)?.[0];
    if (!millimetres) throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    const state = this.loadState();
    await this.open();
    await this.send(buildGloriousClassicLiftOffPayload(millimetres));
    state.lodMm = millimetres;
    this.saveState(state);
    return value;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    // Unlike DPI/polling/LOD, core2 does write debounce - so this only gates
    // on report length, not isCore2().
    if (!this.isConfirmedReportLength()) {
      throw new Error(`Debounce is not confirmed on this unit's ${this.reportLength}-byte feature report yet.`);
    }
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > GLORIOUS_CLASSIC_DEBOUNCE_MAX_MS) {
      throw new Error(`Debounce must be between 0 and ${GLORIOUS_CLASSIC_DEBOUNCE_MAX_MS} ms.`);
    }
    const state = this.loadState();
    const clamped = Math.round(milliseconds);
    await this.open();
    await this.send(buildGloriousClassicDebouncePayload(clamped, state.profileId));
    state.debounceMs = clamped;
    this.saveState(state);
    return clamped;
  }

  getRgb(): GloriousClassicRgb {
    return this.lastRgb;
  }

  async setRgb(rgb: GloriousClassicRgb): Promise<GloriousClassicRgb> {
    // Unlike DPI/polling/LOD, core2 does write RGB - so this only gates on
    // report length, not isCore2().
    if (!this.isConfirmedReportLength()) {
      throw new Error(`RGB is not confirmed on this unit's ${this.reportLength}-byte feature report yet.`);
    }
    await this.open();
    await this.send(buildGloriousClassicRgbPayload(rgb));
    this.lastRgb = rgb;
    return rgb;
  }

  private async readBattery(): Promise<GloriousClassicBattery> {
    await this.send(buildGloriousClassicBatteryRequestPayload());
    await this.delay(BATTERY_RESPONSE_DELAY_MS);
    const view = await this.device.receiveFeatureReport(this.reportId);
    const body = new Uint8Array(view.buffer, view.byteOffset, Math.min(view.byteLength, GLORIOUS_CLASSIC_PACKET_LENGTH));
    return parseGloriousClassicBatteryResponse(body);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private getUiHints(): MouseUiHints {
    return {
      family: "glorious-classic",
      hideLodLow: true,
      hideUnsupportedPollingRates: true,
      hideProcessingCard: true,
      hideSleepCard: true,
      hideSignalCard: true,
      forceShowBattery: this.isWireless(),
      statusNote: this.isCore2()
        ? "This mouse's newer protocol generation only has confirmed commands for RGB, debounce, and battery — DPI, polling rate, and lift-off distance aren't wired in yet."
        : !this.isConfirmedReportLength()
        ? `This mouse connects, but its ${this.reportLength}-byte feature report uses a byte layout this driver hasn't confirmed yet — no settings can be changed until a real capture is available.`
        : "DPI, polling rate, lift-off distance and RGB are written to this mouse but never read back.",
    };
  }

  private stateKey(): string {
    return `openmouse-glorious-classic-state-v1:${this.device.vendorId.toString(16)}-${this.device.productId.toString(16)}`;
  }

  private loadState(): GloriousClassicState {
    try {
      const stored = JSON.parse(localStorage.getItem(this.stateKey()) ?? "null") as Partial<GloriousClassicState> | null;
      if (!stored) throw new Error("no stored state");
      return {
        profileId: stored.profileId ?? DEFAULT_STATE.profileId,
        stageDpis: Array.isArray(stored.stageDpis) && stored.stageDpis.length === GLORIOUS_CLASSIC_DPI_STAGE_COUNT
          ? [...stored.stageDpis]
          : [...DEFAULT_STATE.stageDpis],
        activeStage: stored.activeStage ?? DEFAULT_STATE.activeStage,
        pollingIntervalMs: stored.pollingIntervalMs ?? DEFAULT_STATE.pollingIntervalMs,
        lodMm: stored.lodMm ?? DEFAULT_STATE.lodMm,
        debounceMs: stored.debounceMs ?? DEFAULT_STATE.debounceMs,
      };
    } catch {
      return { ...DEFAULT_STATE, stageDpis: [...DEFAULT_STATE.stageDpis] };
    }
  }

  private saveState(state: GloriousClassicState): void {
    try {
      localStorage.setItem(this.stateKey(), JSON.stringify(state));
    } catch {
      // Settings still reach the mouse when browser storage is unavailable.
    }
  }
}
