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
 * here. The Rival 3 Wireless Gen 2 (`0x1872`) and Rival 3 Gen 2 (`0x1870`)
 * are deliberately absent: their command sets are documented as different
 * from every family below, and listing them would claim devices this codec
 * would misprogram. The Rival 3 Wireless (`0x1830`) is present with family
 * `"rival3-wireless"` — its own module, `./rival3-wireless.ts`, distinct from
 * both Rival 3 Gen 1 and Aerox 3 (different command bytes throughout, a
 * different DPI sensor table, and, unlike either wired family, a readable
 * battery/firmware state — see that module's doc comment).
 *
 * The Aerox 3 (`0x1836`, family `"aerox3"`) is a separate protocol family
 * from Rival 3 despite both being SteelSeries, single-byte vs. two-byte
 * command prefixes and all — see `./aerox3.ts`'s doc comment, including its
 * reconciliation of PR flozz/rivalcfg#269's Rival 3 Gen 2 claim (not added
 * here: its DPI command differs from Aerox 3's even though most other
 * commands match).
 */

export const STEELSERIES_VENDOR_ID = 0x1038;

export type SteelSeriesProtocolFamily = "rival3" | "aerox3" | "rival3-wireless";

export interface SteelSeriesProduct {
  model: string;
  /** Selects the codec module. Never infer one family's commands from another. */
  family: SteelSeriesProtocolFamily;
  wireless: boolean;
  /**
   * No public implementation has a settings getter for DPI/polling/buttons on
   * any family here — rivalcfg keeps a local JSON mirror because the mouse
   * cannot be asked those specific settings. Typed as the literal `false` so
   * a future settings-readable family forces a conscious widening rather than
   * silently defaulting reads on. This is independent of `rival3-wireless`'s
   * separate readable battery/firmware state, which is not a "setting".
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
  // aerox3.py defines no getter and no firmware-query command for this family.
  [0x1836, {
    model: "Aerox 3",
    family: "aerox3",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // rival3_wireless.py: "2.4 GHz mode", endpoint 3. Own command set (0x20/
  // 0x17/0x19), own DPI table (TrueMove Air), plus a battery_level read
  // (0xAA 0x01) neither Rival 3 Gen 1 nor Aerox 3 has. See ./rival3-wireless.ts.
  [0x1830, {
    model: "Rival 3 Wireless",
    family: "rival3-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
]);
