import type { MouseStatus } from "../mouse-types.ts";
import {
  ZAUNKOENIG_CONFIG_REPORT_ID,
  ZAUNKOENIG_PRODUCT_IDS,
  ZAUNKOENIG_USAGE_PAGE,
  ZAUNKOENIG_VENDOR_ID,
  ZAUNKOENIG_VERSION_REPORT_ID,
  type ZaunkoenigConfig,
  type ZaunkoenigPrimaryButton,
  type ZaunkoenigUsbSpeed,
  zaunkoenigBuildConfigPayload,
  zaunkoenigBuildFactoryResetPayload,
  zaunkoenigDecodeConfigReport,
  zaunkoenigDecodeVersionReport,
  zaunkoenigDevice,
  zaunkoenigEncodeConfigWord,
  zaunkoenigFirmwareIsSupported,
} from "@openmouse/protocol/zaunkoenig";

const PRODUCT_IDS = new Set<number>(ZAUNKOENIG_PRODUCT_IDS);
const POLLING_RATES = [1000, 2000, 4000, 8000] as const;

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

/** WebHID client for the public Zaunkoenfigurator protocol (M3K and M2K). */
export class ZaunkoenigHidClient {
  readonly canDisableSleep = false;
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== ZAUNKOENIG_VENDOR_ID || !PRODUCT_IDS.has(device.productId)) return false;
    return hasControlCollection(device.collections);
  }

  get pollIntervalMs(): number { return 30_000; }

  getDpiOptions(): number[] {
    const { dpiStep, dpiMax } = zaunkoenigDevice(this.device.productId);
    return Array.from({ length: dpiMax / dpiStep }, (_, index) => (index + 1) * dpiStep);
  }

  getSupportedPollingRates(): number[] { return [...POLLING_RATES]; }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(_onChange?: () => void): Promise<boolean> { return false; }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      return await this.readStatusDirect();
    });
  }

  async setDpi(dpi: number): Promise<number> {
    const confirmed = await this.update((config) => ({ ...config, dpi }));
    return confirmed.dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (!POLLING_RATES.includes(pollingRateHz as (typeof POLLING_RATES)[number])) {
      throw new Error("Zaunkoenig polling rate must be 1000, 2000, 4000, or 8000 Hz.");
    }
    const confirmed = await this.update((config) => ({
      ...config,
      pollingRateHz: pollingRateHz as ZaunkoenigConfig["pollingRateHz"],
      pollingRateCode: pollingCode(pollingRateHz),
      usbSpeed: pollingRateHz > 1000 ? "High" : config.usbSpeed,
    }));
    return confirmed.pollingRateHz;
  }

  async setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    const millimetres = value === "Low" ? 1 : value === "Medium" ? 2 : 3;
    const confirmed = await this.update((config) => ({ ...config, liftOffDistanceMm: millimetres }));
    return lodName(confirmed.liftOffDistanceMm);
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return (await this.update((config) => ({ ...config, angleSnapping: enabled }))).angleSnapping;
  }

  async setUsbSpeed(usbSpeed: ZaunkoenigUsbSpeed): Promise<ZaunkoenigUsbSpeed> {
    const confirmed = await this.update((config) => ({
      ...config,
      usbSpeed,
      pollingRateHz: usbSpeed === "Full" ? 1000 : pollingRate(config.pollingRateCode),
    }));
    return confirmed.usbSpeed;
  }

  async setPrimaryButton(primaryButton: ZaunkoenigPrimaryButton): Promise<ZaunkoenigPrimaryButton> {
    return (await this.update((config) => ({ ...config, primaryButton }))).primaryButton;
  }

  async factoryReset(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      await this.device.sendFeatureReport(ZAUNKOENIG_CONFIG_REPORT_ID, buffer(zaunkoenigBuildFactoryResetPayload()));
      return await this.readStatusDirect();
    });
  }

  private async update(change: (config: ZaunkoenigConfig) => ZaunkoenigConfig): Promise<ZaunkoenigConfig> {
    return await this.run(async () => {
      await this.open();
      const current = await this.readConfig();
      const wanted = change(current);
      const wantedWord = zaunkoenigEncodeConfigWord(wanted, this.device.productId);
      if (wantedWord !== zaunkoenigEncodeConfigWord(current, this.device.productId)) {
        await this.device.sendFeatureReport(
          ZAUNKOENIG_CONFIG_REPORT_ID,
          buffer(zaunkoenigBuildConfigPayload(wanted, this.device.productId)),
        );
      }
      const confirmed = await this.readConfig();
      if (zaunkoenigEncodeConfigWord(confirmed, this.device.productId) !== wantedWord) {
        throw new Error("The Zaunkoenig mouse did not retain the requested configuration.");
      }
      return confirmed;
    });
  }

  private async readStatusDirect(): Promise<MouseStatus> {
    const firmware = zaunkoenigDecodeVersionReport(
      await this.device.receiveFeatureReport(ZAUNKOENIG_VERSION_REPORT_ID),
    );
    if (!zaunkoenigFirmwareIsSupported(firmware)) {
      throw new Error(`Unsupported Zaunkoenig firmware: ${firmware || "unknown"}. parawizard new v0.8 is required.`);
    }
    const config = await this.readConfig();
    const definition = zaunkoenigDevice(this.device.productId);
    return {
      brand: "Zaunkoenig",
      name: this.device.productName?.trim() || `Zaunkoenig ${definition.model}`,
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: config.dpi,
      pollingRateHz: config.pollingRateHz,
      supportedPollingRates: [...POLLING_RATES],
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: `USB ${config.usbSpeed}-speed`,
      liftOffDistance: lodName(config.liftOffDistanceMm),
      supportedLiftOffDistances: definition.liftOffDistancesMm.map(lodName),
      angleSnapping: config.angleSnapping,
      motionSync: null,
      rippleControl: null,
      usbSpeed: config.usbSpeed,
      primaryButton: config.primaryButton,
      firmware: firmware ? [firmware] : [],
      ui: {
        family: "zaunkoenig",
        hideUnsupportedPollingRates: true,
        hideMotionSync: true,
        hideRippleControl: true,
        hideSleepCard: true,
        hideSignalCard: true,
        showAdvancedSection: true,
        pollingNote: "Full-speed is limited to 1,000 Hz; High-speed supports 1,000–8,000 Hz.",
        defaultDisplayName: `Zaunkoenig ${definition.model}`,
      },
    };
  }

  private async readConfig(): Promise<ZaunkoenigConfig> {
    return zaunkoenigDecodeConfigReport(
      await this.device.receiveFeatureReport(ZAUNKOENIG_CONFIG_REPORT_ID),
      this.device.productId,
    );
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function lodName(millimetres: 1 | 2 | 3): LiftOffDistance {
  return millimetres === 1 ? "Low" : millimetres === 2 ? "Medium" : "High";
}

function pollingCode(rate: number): ZaunkoenigConfig["pollingRateCode"] {
  return ({ 8000: 0, 4000: 1, 2000: 2, 1000: 3 } as const)[rate as 1000] ?? 3;
}

function pollingRate(code: ZaunkoenigConfig["pollingRateCode"]): ZaunkoenigConfig["pollingRateHz"] {
  return [8000, 4000, 2000, 1000][code] as ZaunkoenigConfig["pollingRateHz"];
}

function hasControlCollection(items: readonly HIDCollectionInfo[]): boolean {
  return items.some((collection) =>
    (collection.usagePage === ZAUNKOENIG_USAGE_PAGE
      && collection.featureReports.some((report) => report.reportId === ZAUNKOENIG_VERSION_REPORT_ID)
      && collection.featureReports.some((report) => report.reportId === ZAUNKOENIG_CONFIG_REPORT_ID))
    || hasControlCollection(collection.children));
}

function buffer(payload: Uint8Array): ArrayBuffer {
  return new Uint8Array(payload).buffer;
}
