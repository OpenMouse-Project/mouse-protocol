import type { MouseStatus } from "../mouse-types.ts";
import { LAMZU_ATLANTIS_VENDOR_ID } from "../../lamzu/index.ts";
import { LamzuAtlantisHidClient } from "../lamzu-atlantis/hid.ts";

export const NOIR_M1_NEX_PRODUCT_ID = 0xf500;

const M1_NEX_PRODUCT = {
  brand: "Noir Gear",
  model: "M1-NEX",
  wireless: false,
  pollingRates: [125, 250, 500, 1000],
  rateFamily: "wired",
  verified: true,
  minDpi: 400,
  maxDpi: 12000,
  dpiStep: 50,
  maxDpiStages: 7,
  // The device rejects CompX's onboard-profile query (0x0e, status 1).
  // OpenMouse must not present the Lamzu profile selector for this model.
  profileCount: 0,
  supportsLiftOffDistance: false,
  supportsSleepTimeout: false,
  supportsMotionSync: false,
  supportsAngleSnapping: true,
  supportsRippleControl: true,
  supportsPerformanceMode: false,
  supportsHyperMode: false,
} as const;

/**
 * Noir M1-NEX wired PID. Its report-8 transport, DPI-stage memory layout,
 * per-stage RGB records and key table were read from this exact device. The
 * color write was also changed, read back, and restored on hardware. Other
 * setters inherit safe write/read-back behavior but still need individual
 * hardware verification before this driver is considered fully supported.
 */
export class NoirM1NexHidClient extends LamzuAtlantisHidClient {
  constructor(device: HIDDevice) {
    super(device, M1_NEX_PRODUCT);
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === LAMZU_ATLANTIS_VENDOR_ID
      && device.productId === NOIR_M1_NEX_PRODUCT_ID
      && LamzuAtlantisHidClient.hasConfigCollection(device);
  }

  override displayName(): string {
    return "M1-NEX";
  }

  override deviceBrand(): MouseStatus["brand"] {
    return "Noir Gear";
  }
}
