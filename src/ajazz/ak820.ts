/**
 * Ajazz AK820 (wired, single-backlight variant) — protocol constants.
 *
 * Hardware identity (from config.xml in the official driver installer):
 *   Product:  Ajazz AK820 有线单光版 (wired single-light edition)
 *   VID:      0x1A2C  (China Resource Semico)
 *   PID:      0x9605
 *
 * Wire format (confirmed by Claude-previous static analysis of the installer):
 *   Transport:   HID Feature Reports, 64-byte payload (report id 0x00 or 0x01
 *                depending on what the OS exposes; try both).
 *   Collection:  vendor-specific, usage page 0xFF00 or 0xFF60 (both have been
 *                observed on similar China Resource Semico firmware).
 *
 * NOTE — this driver is currently READ-ONLY / identity-only (Phase 1).
 * The exact opcode layout has not yet been captured from live traffic.
 * readStatus() returns the board's name and marks settingsReady: false so
 * the settings grid stays hidden.  Extend once protocol capture is done.
 *
 * This lives next to the NJ07 / NJ08 mouse codec in `./index.ts`, which is a
 * different device family on different VIDs (0xA8A4/0xA8A5).  Exports here
 * carry the `AK820` infix so the two families never collide.
 */

export const AJAZZ_AK820_VENDOR_ID = 0x1a2c;

/** The only PID we have confirmed.  Add more as new variants are captured. */
export const AJAZZ_AK820_WIRED_PID = 0x9605;

export const AJAZZ_AK820_PRODUCT_IDS: ReadonlySet<number> = new Set([
  AJAZZ_AK820_WIRED_PID,
]);

/**
 * Usage pages observed on China Resource Semico HID keyboards.
 * The driver tries both; accept whichever the OS exposes.
 */
export const AJAZZ_AK820_USAGE_PAGES: ReadonlySet<number> = new Set([0xff00, 0xff60]);

/** Human-readable name for a given product id. */
export function ajazzAk820ProductName(productId: number): string {
  switch (productId) {
    case AJAZZ_AK820_WIRED_PID:
      return "Ajazz AK820 (Wired)";
    default:
      return `Ajazz (PID 0x${productId.toString(16).toUpperCase()})`;
  }
}
