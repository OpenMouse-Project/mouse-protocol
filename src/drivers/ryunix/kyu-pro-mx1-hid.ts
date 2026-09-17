import type { MouseStatus } from "../mouse-types.ts";
import {
  decodeKyuProMx1Telemetry,
  RYUNIX_CONFIG_REPORT_ID,
  RYUNIX_PRODUCT_IDS,
  RYUNIX_USAGE,
  RYUNIX_USAGE_PAGE,
  RYUNIX_VENDOR_ID,
  RYUNIX_WIRELESS_PRODUCT_ID,
  type KyuProMx1Telemetry,
} from "@openmouse/protocol/ryunix";

function hasControlCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    collection.usagePage === RYUNIX_USAGE_PAGE
      && collection.usage === RYUNIX_USAGE
      && collection.featureReports.some((report) => report.reportId === RYUNIX_CONFIG_REPORT_ID)
    || hasControlCollection(collection.children));
}

export class KyuProMx1Client {
  private telemetry: KyuProMx1Telemetry | null = null;
  private listening = false;

  public constructor(public readonly device: HIDDevice) {}

  public static isSupported(device: HIDDevice): boolean {
    return device.vendorId === RYUNIX_VENDOR_ID
      && RYUNIX_PRODUCT_IDS.has(device.productId)
      && hasControlCollection(device.collections);
  }

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const telemetry = decodeKyuProMx1Telemetry(bytes, event.reportId);
    if (telemetry) this.telemetry = telemetry;
  };

  public async open(): Promise<void> {
    if (!KyuProMx1Client.isSupported(this.device)) {
      throw new Error("The Ryunix configuration collection is unavailable.");
    }
    if (!this.device.opened) await this.device.open();
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
  }

  public async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    if (this.device.opened) await this.device.close();
  }

  public getDpiOptions(): number[] {
    return [];
  }

  public getPollingRateOptions(): number[] {
    return [];
  }

  public async readStatus(): Promise<MouseStatus> {
    await this.open();
    const telemetry = this.telemetry;
    const wireless = this.device.productId === RYUNIX_WIRELESS_PRODUCT_ID;

    return {
      brand: "Ryunix",
      name: this.device.productName || "Kyu Pro MX1",
      ui: {
        family: "ryunix",
        settingsReady: false,
        valuesVerified: false,
        pollingReadOnly: true,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        hideSignalCard: true,
        hideSleepCard: true,
        forceShowBattery: true,
        defaultDisplayName: "Kyu Pro MX1",
        statusNote: telemetry
          ? `Read-only telemetry; the mouse is ${telemetry.active ? "active" : "inactive"}.`
          : "Read-only telemetry appears after the mouse sends a status report.",
      },
      batteryPercent: telemetry?.batteryPercent ?? null,
      batteryState: telemetry
        ? telemetry.charging ? "Charging" : "Discharging"
        : "Unknown",
      dpi: 0,
      pollingRateHz: telemetry?.pollingRateHz ?? 0,
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver" : "USB",
      liftOffDistance: null,
      ...(telemetry?.ledMode ? {
        lighting: {
          zone: "Logo & Scroll",
          modes: [telemetry.ledMode],
          mode: telemetry.ledMode,
          color: null,
          color2: null,
          colorModes: [],
          dualColorModes: [],
          reactiveModes: [],
          speeds: [],
          speed: null,
        },
      } : {}),
      firmware: [],
    };
  }
}
