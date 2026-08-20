export interface GWolvesProduct {
  model: string;
  wireless: boolean;
  /**
   * Only `verified: true` entries have been exercised against real hardware
   * by this project. Everything else would be a guess based on "probably
   * the same shared VGN-family protocol as the HTX Ultra" and should not be
   * assumed correct until actually tested — see PROTOCOL-NOTES.md in the
   * HTX Ultra PR for how the verified entries were confirmed (live HID
   * capture while using the official web driver at mouse.fit, cross-checked
   * independently with hidapitester).
   */
  verified: boolean;
}

export const GWOLVES_VENDOR_ID = 0x33e4;

export const GWOLVES_PRODUCTS: ReadonlyMap<number, GWolvesProduct> = new Map([
  [0x5618, { model: "HTX Ultra", wireless: false, verified: true }],
  [0x3854, { model: "HTX Ultra", wireless: true, verified: true }],
  // Add further G-Wolves models here as they're captured/verified. Every
  // G-Wolves mouse checked so far speaks the exact same shared VGN-family
  // wire protocol (same opcodes/checksums/EEPROM map as the HTX Ultra), so
  // a new model is very likely just a new product-id entry here — but
  // confirm with a real capture before setting verified: true, since a
  // wrong address/encoding on an unverified model could silently write the
  // wrong value rather than fail loudly.
]);
