/**
 * Ajazz AK820 (wired, single-backlight) — Phase 1 driver.
 *
 * This is a read-only identity driver: it recognises the keyboard on connect
 * and reports its name, but makes no protocol reads and changes nothing.
 * The settings grid is hidden (`settingsReady: false`) because the AK820's
 * key-remap / backlight protocol has not yet been captured.
 *
 * Architecture note — why a keyboard lives in OpenMouse:
 *   OpenMouse's shared `MouseStatus` type is mouse-centric, but non-mouse
 *   devices are explicitly supported by returning a status with
 *   `ui.settingsReady: false`, which hides the settings grid.  The Wallhack
 *   K-001 keyboard driver (`drivers/wallhack/keyboard-hid.ts`) is the
 *   canonical prior art followed here.
 *
 * Extending this driver:
 *   1. Capture live HID traffic with Wireshark / USBPcap or macOS Packet Logger
 *      while the official driver changes a backlight colour or remaps a key.
 *   2. Identify the feature-report opcode and payload layout.
 *   3. Add an `exchange()` helper (sendFeatureReport + receiveFeatureReport)
 *      and decode the response in `readStatus()`.
 *   4. Set `settingsReady: true` and add setter methods.
 *   5. Update `vendors.ts` and `registry.ts` with a usage filter once the
 *      exact usage page + report id are confirmed from captured traffic.
 */

import type { MouseStatus } from "../mouse-types.ts";
import {
  AJAZZ_AK820_PRODUCT_IDS,
  AJAZZ_AK820_USAGE_PAGES,
  AJAZZ_AK820_VENDOR_ID,
  ajazzAk820ProductName,
} from "../../ajazz/ak820.ts";

export class AjazzAk820HidClient {
  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  /**
   * Match: correct VID + known PID + at least one vendor-specific collection
   * on a usage page we recognise.  The usage-page check keeps us from
   * accidentally claiming a standard HID keyboard interface on the same device.
   */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== AJAZZ_AK820_VENDOR_ID) return false;
    if (!AJAZZ_AK820_PRODUCT_IDS.has(device.productId)) return false;
    return AjazzAk820HidClient.hasVendorCollection(device.collections);
  }

  private static hasVendorCollection(
    collections: readonly HIDCollectionInfo[],
  ): boolean {
    for (const col of collections) {
      if (AJAZZ_AK820_USAGE_PAGES.has(col.usagePage)) return true;
      if (AjazzAk820HidClient.hasVendorCollection(col.children)) return true;
    }
    return false;
  }

  /** No DPI options — this is a keyboard. */
  getDpiOptions(): number[] {
    return [];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /**
   * Phase 1: identity only.  No feature-report exchange is attempted because
   * the exact opcode layout is not yet known.  Once captured traffic reveals
   * the command structure, replace this with a real read.
   */
  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const name = ajazzAk820ProductName(this.device.productId);
    return {
      brand: "AJAZZ",
      name,
      ui: {
        family: "ajazz-ak820",
        // Hide the settings grid until protocol capture is complete and
        // real reads / writes are implemented.
        settingsReady: false,
        defaultDisplayName: name,
        statusNote:
          "Settings not yet available — protocol capture needed. " +
          "See src/drivers/ajazz/ak820-hid.ts for how to extend this driver.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      // Placeholder mouse fields required by the shared status shape.
      // The grid is hidden, so these are never displayed to the user.
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: "USB",
      liftOffDistance: null,
      firmware: [name],
    };
  }
}
