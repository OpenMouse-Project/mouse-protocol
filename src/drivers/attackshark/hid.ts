import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import { LAMZU_PRODUCTS } from "@openmouse/protocol/lamzu";

// Attack Shark mice ship from multiple OEMs and therefore across multiple VIDs:
//   0x25a7  — Attack Shark direct (X3, X6, X11, …)
//   0x373e  — Lamzu OEM shared VID (R5 Ultra, R3, …)
//
// PIDs change between firmware revisions, so detection is done on collection
// structure rather than a hardcoded PID list. The control interface always
// exposes at least one feature report on usage page 0xffff.
//
// For 0x373e devices we exclude known Lamzu PIDs so LamzuHidClient keeps
// priority over its own products.

const ATTACK_SHARK_VIDS: ReadonlySet<number> = new Set([
  VENDOR_ID.attackShark, // 0x25a7
  0x373e,                // Lamzu OEM (R5 Ultra, R3, …)
]);

function hasVendorControl(collection: HIDCollectionInfo): boolean {
  if (collection.usagePage === 0xffff && collection.featureReports.length > 0) return true;
  return collection.children.some(hasVendorControl);
}

export class AttackSharkHidClient {
  readonly device: HIDDevice;

  private lastStatus: MouseStatus | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (!ATTACK_SHARK_VIDS.has(device.vendorId)) return false;
    // Don't claim devices the Lamzu driver already knows.
    if (device.vendorId === 0x373e && LAMZU_PRODUCTS.has(device.productId)) return false;
    // Must expose a vendor-defined control interface (usage page 0xffff with feature reports).
    return device.collections.some(hasVendorControl);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastStatus = null;
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    const name = this.device.productName?.trim();
    if (!name) return "Attack Shark";
    return /^attack\s*shark/i.test(name) ? name : `Attack Shark ${name}`;
  }

  isWireless(): boolean {
    return /receiver|dongle|wireless|2\.4g/i.test(this.device.productName || "");
  }

  deviceBrand(): string {
    return "Attack Shark";
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    // Protocol not yet reverse-engineered. Returns a minimal stub so the UI
    // can display the device name while protocol work is in progress.
    return this.lastStatus = {
      brand: "Attack Shark",
      name: this.displayName(),
      ui: {
        family: "attackshark",
        settingsReady: false,
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      liftOffDistance: null,
      firmware: [],
    };
  }
}
