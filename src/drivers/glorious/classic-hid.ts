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
  type GloriousClassicBatteryState,
  type GloriousClassicRgb,
} from "../../glorious-classic/index.ts";
import { GLORIOUS_CLASSIC_PRODUCTS, VENDOR_ID } from "../vendors.ts";

/**
 * Driver for Glorious's pre-Pixart "classic" line (Model O / O-, Model D /
 * D-, Model I, Model O V2 — plus the newer "core2" 8000Hz-class mice, Model
 * O3 Wireless and Model D 2 PRO 4K/8KHz Edition, on a reduced feature set —
 * see the `generation` doc comment on `GLORIOUS_CLASSIC_PRODUCTS` in
 * vendors.ts for why). The config channel is an unnumbered 64-byte feature
 * report; see ../../glorious-classic/index.ts for the payload layout.
 *
 * DPI, polling rate, lift-off distance, and RGB are all write-only on this
 * protocol (neither glorious-ctl nor mxw, the two tools this was ported
 * from, implement a read for them) — like the sibling Pixart driver in
 * ./hid.ts, this class keeps its own last-applied-settings cache so the UI
 * has something to show. Only battery status is actually read from the
 * mouse.
 */

const CLASSIC_USAGE_PAGES = [0xff01, 0xff00];
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
  private lastRgb: GloriousClassicRgb = GLORIOUS_CLASSIC_DEFAULT_RGB;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== VENDOR_ID.gloriousClassic
      && device.vendorId !== VENDOR_ID.gloriousClassicI
      && device.vendorId !== VENDOR_ID.gloriousClassicIWired
      && device.vendorId !== VENDOR_ID.gloriousO3) return false;
    if (!GLORIOUS_CLASSIC_PRODUCTS.has(device.productId)) return false;
    return device.collections.some((collection) => this.hasConfigReport(collection));
  }

  private static hasConfigReport(collection: HIDCollectionInfo): boolean {
    const matchesHere = CLASSIC_USAGE_PAGES.includes(collection.usagePage)
      && collection.featureReports.some((report) => report.reportId === GLORIOUS_CLASSIC_REPORT_ID);
    return matchesHere || collection.children.some((child) => this.hasConfigReport(child));
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

  getDpiOptions(): number[] {
    if (this.isCore2()) return [];
    const options: number[] = [];
    for (let dpi = GLORIOUS_CLASSIC_DPI_MIN; dpi <= GLORIOUS_CLASSIC_DPI_MAX; dpi += 50) options.push(dpi);
    return options;
  }

  getSupportedPollingRates(): number[] {
    if (this.isCore2()) return [];
    return GLORIOUS_CLASSIC_POLLING_RATES.map(([, hertz]) => hertz).sort((left, right) => left - right);
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const state = this.loadState();
    const battery = this.isWireless() ? await this.readBattery().catch(() => null) : null;
    const wireless = this.isWireless();
    const core2 = this.isCore2();
    const liftOffDistance = core2 ? null : LIFT_OFF_DISTANCES.find(([mm]) => mm === state.lodMm)?.[1] ?? "Medium";
    return {
      brand: "Glorious",
      name: this.displayName(),
      ui: this.getUiHints(),
      batteryPercent: battery?.percent ?? null,
      batteryState: battery ? BATTERY_STATE_LABEL[battery.state] : "Unknown",
      dpi: core2 ? 0 : state.stageDpis[state.activeStage] ?? state.stageDpis[0] ?? 800,
      pollingRateHz: core2 ? 0 : gloriousClassicDecodePollingRate(state.pollingIntervalMs) ?? 1000,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: core2 ? null : state.profileId,
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
    if (this.isCore2()) {
      throw new Error("DPI is not confirmed on this mouse's newer protocol generation yet.");
    }
    if (!Number.isFinite(dpi) || dpi < GLORIOUS_CLASSIC_DPI_MIN || dpi > GLORIOUS_CLASSIC_DPI_MAX) {
      throw new Error(`DPI must be between ${GLORIOUS_CLASSIC_DPI_MIN} and ${GLORIOUS_CLASSIC_DPI_MAX}.`);
    }
    const state = this.loadState();
    const rounded = Math.round(dpi);
    state.stageDpis[state.activeStage] = rounded;
    await this.open();
    await this.device.sendFeatureReport(
      GLORIOUS_CLASSIC_REPORT_ID,
      buildGloriousClassicDpiStagesPayload(state.stageDpis, state.profileId),
    );
    await this.device.sendFeatureReport(
      GLORIOUS_CLASSIC_REPORT_ID,
      buildGloriousClassicActiveStagePayload(state.activeStage + 1, state.profileId),
    );
    this.saveState(state);
    return rounded;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (this.isCore2()) {
      throw new Error("Polling rate is not confirmed on this mouse's newer protocol generation yet.");
    }
    const intervalMs = gloriousClassicEncodePollingRate(pollingRateHz);
    if (intervalMs === null) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
    const state = this.loadState();
    await this.open();
    await this.device.sendFeatureReport(GLORIOUS_CLASSIC_REPORT_ID, buildGloriousClassicPollingRatePayload(intervalMs));
    state.pollingIntervalMs = intervalMs;
    this.saveState(state);
    return pollingRateHz;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    if (this.isCore2()) {
      throw new Error("Lift-off distance is not confirmed on this mouse's newer protocol generation yet.");
    }
    const millimetres = LIFT_OFF_DISTANCES.find(([, name]) => name === value)?.[0];
    if (!millimetres) throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    const state = this.loadState();
    await this.open();
    await this.device.sendFeatureReport(GLORIOUS_CLASSIC_REPORT_ID, buildGloriousClassicLiftOffPayload(millimetres));
    state.lodMm = millimetres;
    this.saveState(state);
    return value;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > GLORIOUS_CLASSIC_DEBOUNCE_MAX_MS) {
      throw new Error(`Debounce must be between 0 and ${GLORIOUS_CLASSIC_DEBOUNCE_MAX_MS} ms.`);
    }
    const state = this.loadState();
    const clamped = Math.round(milliseconds);
    await this.open();
    await this.device.sendFeatureReport(GLORIOUS_CLASSIC_REPORT_ID, buildGloriousClassicDebouncePayload(clamped, state.profileId));
    state.debounceMs = clamped;
    this.saveState(state);
    return clamped;
  }

  getRgb(): GloriousClassicRgb {
    return this.lastRgb;
  }

  async setRgb(rgb: GloriousClassicRgb): Promise<GloriousClassicRgb> {
    await this.open();
    await this.device.sendFeatureReport(GLORIOUS_CLASSIC_REPORT_ID, buildGloriousClassicRgbPayload(rgb));
    this.lastRgb = rgb;
    return rgb;
  }

  private async readBattery(): Promise<{ state: GloriousClassicBatteryState; percent: number | null }> {
    await this.device.sendFeatureReport(GLORIOUS_CLASSIC_REPORT_ID, buildGloriousClassicBatteryRequestPayload());
    await this.delay(BATTERY_RESPONSE_DELAY_MS);
    const view = await this.device.receiveFeatureReport(GLORIOUS_CLASSIC_REPORT_ID);
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
