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
  // Only models the web driver (mouse.fit) talks to over this 16-byte report-8
  // protocol belong here. Its env-models.json picks the transport per model:
  // "XVI": "0" gets the report-8 helper, anything else gets a 64-byte
  // feature-report-0 helper with a different command layout
  // ("IsNewProtocol" only tweaks that 64-byte format). As of 2026-09-26 every
  // other catalogued G-Wolves model (HTM Plus, HSK Pro 2.0, HTXU 0x5608,
  // Fenrir Pro 0x3608, VUK, HT-S2, HTX, HSK Plus/Pro, the ACE line, ...) is
  // "XVI": "1", so they are deliberately absent. Confirm a model is "XVI": "0"
  // and capture it on hardware before adding it.
]);
