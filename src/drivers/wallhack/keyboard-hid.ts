import type { MouseStatus } from "../mouse-types.ts";
import {
  wallhackKeyboardName,
  WALLHACK_KEYBOARD_ALT_VENDOR_ID,
  WALLHACK_KEYBOARD_PRODUCT_IDS,
  WALLHACK_KEYBOARD_USAGE_PAGE,
  WALLHACK_VENDOR_ID,
} from "@openmouse/protocol/wallhack";

/**
 * WALLHACK K-001 analog keyboard — read-only WebHID identity (stage one).
 *
 * OpenMouse is a mouse control panel, so the K-001's actuation / rapid-trigger /
 * SOCD surface has no home in the settings grid yet. Like the Wooting stage-one
 * driver, this recognises the board on its 0xFFA0 command interface, connects,
 * and reports what it is — `ui.settingsReady = false`, no setters. The keyboard's
 * per-firmware config protocol (the app ships it as versioned modules) is not
 * decoded here, so this makes no config reads and changes nothing.
 */

export class WallhackKeyboardHidClient {
  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  /**
   * K-001 identity: either WALLHACK vendor id, the keyboard product id, and the
   * 0xFFA0 command collection. Both vendor ids are accepted because some units
   * enumerate under the switch-matrix MCU's vendor id.
   */
  static isSupported(device: HIDDevice): boolean {
    const vendorOk = device.vendorId === WALLHACK_VENDOR_ID
      || device.vendorId === WALLHACK_KEYBOARD_ALT_VENDOR_ID;
    if (!vendorOk) return false;
    if (!WALLHACK_KEYBOARD_PRODUCT_IDS.has(device.productId)) return false;
    return WallhackKeyboardHidClient.commandCollection(device.collections) !== null;
  }

  private static commandCollection(
    collections: readonly HIDCollectionInfo[],
  ): HIDCollectionInfo | null {
    // Matched on usage page alone, mirroring the WALLHACK app's `ec()`.
    for (const collection of collections) {
      if (collection.usagePage === WALLHACK_KEYBOARD_USAGE_PAGE) {
        return collection;
      }
      const nested = WallhackKeyboardHidClient.commandCollection(collection.children);
      if (nested) return nested;
    }
    return null;
  }

  /** Part of the shared client contract; a keyboard has no mouse DPI options. */
  getDpiOptions(): number[] {
    return [];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    return {
      brand: "WALLHACK",
      name: wallhackKeyboardName(this.device.productId),
      ui: {
        family: "wallhack-keyboard",
        // Analog-keyboard controls have no place in the mouse settings grid yet.
        settingsReady: false,
        defaultDisplayName: wallhackKeyboardName(this.device.productId),
      },
      batteryPercent: null,
      batteryState: "Unknown",
      // Placeholder mouse fields the shared status shape requires; the grid is
      // hidden, so these are never shown.
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: "USB",
      liftOffDistance: null,
      firmware: [wallhackKeyboardName(this.device.productId)],
    };
  }
}
