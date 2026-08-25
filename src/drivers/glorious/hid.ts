import type { GloriousLighting, GloriousSettings } from "../../glorious/index.ts";
import {
  GLORIOUS_CONFIG_REPORT_ID,
  GLORIOUS_DEFAULT_LIGHTING,
  GLORIOUS_DEFAULT_SETTINGS,
  GLORIOUS_DEBOUNCE_MAX_MS,
  GLORIOUS_DPI_MAX,
  GLORIOUS_DPI_MIN,
  GLORIOUS_DPI_UNIT,
  GLORIOUS_POLLING_RATES,
  buildGloriousLightingPayload,
  buildGloriousSettingsPayload,
  gloriousDecodePolling,
  gloriousEncodePolling,
  gloriousIsSupportedDpi,
  gloriousNormalizeLighting,
  gloriousNormalizeSettings,
  gloriousSanitizeDebounce,
} from "../../glorious/index.ts";
import type { MouseStatus, MouseUiHints } from "../mouse-types.ts";
import { VENDOR_ID, GLORIOUS_PRODUCTS } from "../vendors.ts";

/**
 * Driver for the write-only Pixart configuration interface of the Glorious
 * Model O 2 / I 2 family. See glorious/index.ts for the payload layout;
 * this file only handles HID plumbing, validation, and local state caching.
 */

const VENDOR_USAGE_PAGE = 0xff00;

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

const LIFT_OFF_DISTANCES: ReadonlyArray<readonly [millimetres: number, name: LiftOffDistance]> = [
  [1, "Medium"],
  [2, "High"],
];

export class GloriousHidClient {
  /** Write-only protocol — there is nothing to poll. */
  readonly pollIntervalMs = 0;
  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== VENDOR_ID.glorious) return false;
    const named = GLORIOUS_PRODUCTS.has(device.productId)
      || /model\s+[odi]\s*2/i.test(device.productName || "");
    if (!named) return false;
    return device.collections.some((collection) => this.hasConfigReport(collection));
  }

  private static hasConfigReport(collection: HIDCollectionInfo): boolean {
    return collection.usagePage === VENDOR_USAGE_PAGE
        && collection.featureReports.some((report) => report.reportId === GLORIOUS_CONFIG_REPORT_ID)
      || collection.children.some((child) => this.hasConfigReport(child));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  displayName(): string {
    if (this.device.productName) return this.device.productName;
    const known = GLORIOUS_PRODUCTS.get(this.device.productId);
    return known ? `Glorious ${known.name}` : "Glorious mouse";
  }

  isWireless(): boolean {
    return GLORIOUS_PRODUCTS.get(this.device.productId)?.wireless ?? false;
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = GLORIOUS_DPI_MIN; dpi <= GLORIOUS_DPI_MAX; dpi += GLORIOUS_DPI_UNIT) options.push(dpi);
    return options;
  }

  getSupportedPollingRates(): number[] {
    return GLORIOUS_POLLING_RATES.map(([, hertz]) => hertz).sort((left, right) => left - right);
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    return this.statusFromState(this.loadState());
  }

  async setDpi(dpi: number): Promise<number> {
    if (!gloriousIsSupportedDpi(dpi)) throw new Error(`${dpi.toLocaleString()} is not a supported DPI value.`);
    const settings = this.loadState();
    settings.stageDpis[settings.activeStage] = dpi;
    await this.pushSettings(settings);
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const encoded = gloriousEncodePolling(pollingRateHz);
    if (!encoded || !this.getSupportedPollingRates().includes(pollingRateHz)) {
      throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
    }
    const settings = this.loadState();
    settings.pollingCode = encoded;
    await this.pushSettings(settings);
    return pollingRateHz;
  }

  async setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    const millimetres = LIFT_OFF_DISTANCES.find(([, name]) => name === value)?.[0];
    if (!millimetres) throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    const settings = this.loadState();
    settings.lodMm = millimetres;
    await this.pushSettings(settings);
    return value;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!Number.isInteger(milliseconds)) {
      throw new Error(`Debounce must be an even number of milliseconds between 0 and ${GLORIOUS_DEBOUNCE_MAX_MS}.`);
    }
    const settings = this.loadState();
    settings.debounceMs = gloriousSanitizeDebounce(milliseconds);
    await this.pushSettings(settings);
    return settings.debounceMs;
  }

  async setSleepTimeout(_seconds: number): Promise<number> {
    throw new Error("Auto sleep is not exposed by this device's protocol.");
  }

  /** Last known onboard settings (write-only protocol: nothing to poll). */
  getSettings(): GloriousSettings {
    return this.loadState();
  }

  /** Validates and pushes a full settings payload, returning the stored copy. */
  async applySettings(settings: GloriousSettings): Promise<GloriousSettings> {
    const normalized = gloriousNormalizeSettings(settings);
    await this.pushSettings(normalized);
    return this.loadState();
  }

  /** Firmware never reports lighting back; this returns the last applied state. */
  getLighting(): GloriousLighting {
    try {
      return gloriousNormalizeLighting(JSON.parse(localStorage.getItem(this.lightingKey()) ?? "{}"));
    } catch {
      return { ...GLORIOUS_DEFAULT_LIGHTING, colors: [...GLORIOUS_DEFAULT_LIGHTING.colors] };
    }
  }

  async setLighting(lighting: GloriousLighting): Promise<GloriousLighting> {
    await this.open();
    for (const fragment of buildGloriousLightingPayload(lighting)) {
      await this.device.sendFeatureReport(GLORIOUS_CONFIG_REPORT_ID, fragment.slice(1));
    }
    const normalized = gloriousNormalizeLighting(lighting);
    try {
      localStorage.setItem(this.lightingKey(), JSON.stringify(normalized));
    } catch {
      // Lighting still reaches the mouse when browser storage is unavailable.
    }
    return normalized;
  }

  getUiHints(): MouseUiHints {
    return {
      family: "glorious",
      hideLodLow: true,
      hideUnsupportedPollingRates: true,
      hideProcessingCard: true,
    };
  }

  private async pushSettings(settings: GloriousSettings): Promise<void> {
    await this.open();
    for (const fragment of buildGloriousSettingsPayload(settings)) {
      // Fragments follow the C/hidapi layout where byte 0 is the report ID.
      // WebHID takes the ID separately and prepends it, so only send the body.
      await this.device.sendFeatureReport(GLORIOUS_CONFIG_REPORT_ID, fragment.slice(1));
    }
    this.saveState(settings);
  }

  private statusFromState(settings: GloriousSettings): MouseStatus {
    const wireless = this.isWireless();
    const liftOffDistance = LIFT_OFF_DISTANCES.find(([millimetres]) => millimetres === settings.lodMm)?.[1]
      ?? "Medium";
    return {
      brand: "Glorious",
      name: this.displayName(),
      ui: this.getUiHints(),
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: settings.stageDpis[settings.activeStage] || 800,
      pollingRateHz: gloriousDecodePolling(settings.pollingCode) ?? 1000,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: settings.activeStage + 1,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless
        ? "2.4 GHz receiver · write-only config"
        : "Wired USB · write-only config",
      debounceMs: settings.debounceMs,
      liftOffDistance,
      firmware: [],
    };
  }

  private stateKey(): string {
    return `openmouse-glorious-state-v1:${this.device.vendorId.toString(16)}-${this.device.productId.toString(16)}`;
  }

  private lightingKey(): string {
    return `openmouse-glorious-lighting-v1:${this.device.vendorId.toString(16)}-${this.device.productId.toString(16)}`;
  }

  private loadState(): GloriousSettings {
    try {
      return gloriousNormalizeSettings(JSON.parse(localStorage.getItem(this.stateKey()) ?? "{}"));
    } catch {
      return {
        ...GLORIOUS_DEFAULT_SETTINGS,
        stageDpis: [...GLORIOUS_DEFAULT_SETTINGS.stageDpis],
        stageColors: [...GLORIOUS_DEFAULT_SETTINGS.stageColors],
      };
    }
  }

  private saveState(settings: GloriousSettings): void {
    try {
      localStorage.setItem(this.stateKey(), JSON.stringify(settings));
    } catch {
      // Settings still reach the mouse when browser storage is unavailable.
    }
  }
}
