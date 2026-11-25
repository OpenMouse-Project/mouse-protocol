import type { MouseStatus } from "../mouse-types.ts";
import {
  RAPOO_VENDOR_ID,
  RAPOO_VT1_MAX_PRODUCT_IDS,
  RAPOO_VT1_MAX_USAGE,
  RAPOO_VT1_MAX_USAGE_PAGE,
} from "@openmouse/protocol/rapoo";

/** Identification only until the VT1 MAX protocol is verified on hardware. */
export class RapooVt1MaxHidClient {
  constructor(readonly device: HIDDevice) {}

  static isSupported(device: HIDDevice): boolean {
    const matches = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === RAPOO_VT1_MAX_USAGE_PAGE && collection.usage === RAPOO_VT1_MAX_USAGE)
      || collection.children.some(matches);
    return device.vendorId === RAPOO_VENDOR_ID
      && RAPOO_VT1_MAX_PRODUCT_IDS.has(device.productId)
      && device.collections.some(matches);
  }

  async open(): Promise<void> {
    if (!RapooVt1MaxHidClient.isSupported(this.device)) {
      throw new Error("The Rapoo VT1 MAX configuration collection is unavailable.");
    }
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] { return []; }
  getPollingRateOptions(): number[] { return []; }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    return {
      brand: "Rapoo",
      name: "Rapoo VT1 MAX",
      ui: {
        family: "rapoo-vt1-max",
        settingsReady: false,
        valuesVerified: false,
        hideProcessingCard: true,
        hideSignalCard: true,
        hideSleepCard: true,
        statusNote: "Identification only. Settings and battery require verification on a VT1 MAX; no commands are sent.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      liftOffDistance: null,
      firmware: [],
    };
  }
}
