/**
 * SteelSeries per-PID catalog.
 *
 * SteelSeries is a multi-family vendor: rivalcfg alone documents four
 * incompatible Rival 3 command sets (Gen 1, Gen 2, Wireless, Wireless Gen 2),
 * and libratbag distinguishes four more protocol versions for older mice. The
 * `family` field selects which codec module drives a product; command bytes,
 * framing, and value tables live in that module, never here, and no family's
 * codec branches on product id.
 *
 * Only PIDs whose protocol has been traced to a public implementation belong
 * here. The Rival 3 Wireless (`0x1830`, `0x1872`) and Rival 3 Gen 2 (`0x1870`)
 * are deliberately absent: their command sets are documented as different, and
 * listing them would claim devices this codec would misprogram.
 */

export const STEELSERIES_VENDOR_ID = 0x1038;

export type SteelSeriesProtocolFamily = "rival3";

export interface SteelSeriesProduct {
  model: string;
  /** Selects the codec module. Never infer one family's commands from another. */
  family: SteelSeriesProtocolFamily;
  wireless: boolean;
  /**
   * No public implementation has a settings getter for this family — rivalcfg
   * keeps a local JSON mirror because the mouse cannot be asked. Typed as the
   * literal `false` so a future readable family forces a conscious widening
   * rather than silently defaulting reads on.
   */
  settingsReadable: false;
  /** The `10 00` firmware query; the Gen 2 profile has no firmware command. */
  hasFirmwareQuery: boolean;
  /** True only after this exact product id was exercised on real hardware. */
  verified: boolean;
}

export const STEELSERIES_PRODUCTS: ReadonlyMap<number, SteelSeriesProduct> = new Map([
  // Pre-0.37 firmware enumeration.
  [0x1824, {
    model: "Rival 3",
    family: "rival3",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // The same mouse re-enumerated after the v0.37.0.0 firmware update; rivalcfg
  // lists both ids against one profile and OpenRGB names 0x1824 "Old Firmware".
  [0x184c, {
    model: "Rival 3",
    family: "rival3",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
]);
