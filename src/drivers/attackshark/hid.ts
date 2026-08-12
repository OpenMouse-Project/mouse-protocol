import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";

// Attack Shark HID protocol — work in progress.
// VID 0x25a7 confirmed from USB device databases; PIDs and report layout
// need hardware capture before any read/write can be implemented.

export class AttackSharkHidClient {
  readonly device: HIDDevice;

  private lastStatus: MouseStatus | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === VENDOR_ID.attackShark;
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
    return /receiver|dongle|wireless/i.test(this.device.productName || "");
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    // Protocol not yet reverse-engineered. Return a minimal stub so the UI
    // can at least display the device name and connection type.
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
