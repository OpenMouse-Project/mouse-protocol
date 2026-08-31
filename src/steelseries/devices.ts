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
 *
 * The Aerox 5 is split across **two** families despite one product line and
 * mostly-shared command bytes: `"aerox5"` (`0x1850`, the plain wired mouse —
 * see `./aerox5.ts`) and `"aerox5-wireless"` (the separately-sold Aerox 5
 * Wireless, six PIDs across its USB-cabled and 2.4 GHz dongle modes — see
 * `./aerox5-wireless.ts`). The two families' polling-rate byte values and
 * RGB zone-color packet shapes differ even though several other command
 * bytes match; do not assume one family's codec for the other's PIDs.
 *
 * The Aerox 9 Wireless (`"aerox9-wireless"`, four PIDs across its
 * USB-cabled and 2.4 GHz dongle modes — see `./aerox9-wireless.ts`) is its
 * own family, not folded into `"aerox5-wireless"` despite sharing the same
 * `_patch_command`-style wireless-flag transform and several command bytes:
 * its RGB zone commands, dim timer, and battery read match Aerox 5
 * Wireless's byte-for-byte, but it defines no button-mapping command at all
 * (`./aerox9-wireless.ts`'s doc comment) where Aerox 5 Wireless does, and
 * its product-id space is disjoint from every other family here.
 *
 * The Prime+ (`0x182C`, family `"prime-plus"`) is its own family per this
 * rollout's per-cluster scoping, even though — see `./prime-plus.ts`'s doc
 * comment for the full corroboration-gap disclosure — its rivalcfg profile
 * (`prime_plus.py`) is byte-identical to plain Prime's (`prime.py`, PIDs
 * `0x182E`/`0x182A`/`0x1856`, none of which are listed here: plain/non-Plus
 * Prime is out of scope for this cluster and deliberately not added).
 *
 * The Prime Mini Wireless (`"prime-mini-wireless"`, PIDs `0x184A` wired /
 * `0x1848` 2.4 GHz — see `./prime-mini-wireless.ts`) is its own family for
 * the same reason: rivalcfg documents it and the plain (non-Mini) Prime
 * Wireless as one shared `settings` dict inside
 * `prime_wireless_wired.py`/`prime_wireless_wireless.py`, but the plain
 * Prime Wireless's PIDs (`0x1842` wired / `0x1840` 2.4 GHz) are out of scope
 * for this cluster and deliberately not added here.
 */

export const STEELSERIES_VENDOR_ID = 0x1038;

export type SteelSeriesProtocolFamily =
  | "rival3"
  | "rival310"
  | "aerox3"
  | "rival3-wireless"
  | "aerox5"
  | "aerox5-wireless"
  | "rival650"
  | "aerox9-wireless"
  | "prime-plus"
  | "prime-mini-wireless";

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
  // aerox5.py: plain wired Aerox 5. No getter, no firmware-query command.
  [0x1850, {
    model: "Aerox 5",
    family: "aerox5",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // aerox5_wireless_wired.py: Aerox 5 Wireless in USB-cabled mode. Own
  // command set from the plain Aerox 5 (different polling-rate bytes,
  // different RGB zone packing, extra sleep/dim timers, a battery read the
  // plain Aerox 5 has no equivalent of). No firmware-query command.
  [0x1854, {
    model: "Aerox 5 Wireless (wired mode)",
    family: "aerox5-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x185e, {
    model: "Aerox 5 Wireless Destiny 2 Edition (wired mode)",
    family: "aerox5-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x1862, {
    model: "Aerox 5 Wireless Diablo IV Edition (wired mode)",
    family: "aerox5-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // aerox5_wireless_wireless.py: same mouse, 2.4 GHz dongle mode. Every
  // command byte is `aerox5_wireless_wired.py`'s with `0b01000000` ORed into
  // byte 0 (see ./aerox5-wireless.ts's `applyWirelessFlag`).
  [0x1852, {
    model: "Aerox 5 Wireless (2.4 GHz mode)",
    family: "aerox5-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x185c, {
    model: "Aerox 5 Wireless Destiny 2 Edition (2.4 GHz mode)",
    family: "aerox5-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x1860, {
    model: "Aerox 5 Wireless Diablo IV Edition (2.4 GHz mode)",
    family: "aerox5-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // rival650.py: wired/USB-cabled mode, endpoint 0. Own command set (0x15/
  // 0x17/0x20/0x19/0x2B), a battery_level read (0xAA 0x01, byte-identical
  // shape to Rival 3 Wireless's) but no firmware-query command. See
  // ./rival650.ts.
  [0x172b, {
    model: "Rival 650 Wireless (wired mode)",
    family: "rival650",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // rival650.py: same mouse, 2.4 GHz wireless mode. Same command bytes as
  // wired mode — no wireless-flag transform, unlike Aerox 5 Wireless.
  [0x1726, {
    model: "Rival 650 Wireless (2.4 GHz wireless mode)",
    family: "rival650",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // aerox9_wireless_wired.py: Aerox 9 Wireless in USB-cabled mode. Shares
  // the applyWirelessFlag transform with Aerox 5 Wireless (confirmed by
  // diffing the two rivalcfg wired/wireless file pairs) but defines no
  // button-mapping command. No firmware-query command.
  [0x185a, {
    model: "Aerox 9 Wireless (wired mode)",
    family: "aerox9-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x1876, {
    model: "Aerox 9 Wireless WOW Edition (wired mode)",
    family: "aerox9-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // aerox9_wireless_wireless.py: same mouse, 2.4 GHz dongle mode. Every
  // command byte is `aerox9_wireless_wired.py`'s with `0b01000000` ORed into
  // byte 0 (see ./aerox9-wireless.ts's `applyWirelessFlag`).
  [0x1858, {
    model: "Aerox 9 Wireless (2.4 GHz mode)",
    family: "aerox9-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x1874, {
    model: "Aerox 9 Wireless WOW Edition (2.4 GHz mode)",
    family: "aerox9-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // prime_plus.py: wired only, endpoint 0. No getter, no firmware-query
  // command. Protocol is byte-identical to plain Prime's — see
  // ./prime-plus.ts's doc comment for the full disclosure.
  [0x182c, {
    model: "Prime+",
    family: "prime-plus",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // rival310.py: wired only, endpoint 0. Own command set (0x53/0x54/0x5B/
  // 0x31), a linear (non-table) DPI encoding, and a readable firmware
  // version behind 0x90 00 — see ./rival310.ts's doc comment, including its
  // explicit libratbag/OpenRGB corroboration-gap disclosure.
  [0x1720, {
    model: "Rival 310",
    family: "rival310",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x171e, {
    model: "Rival 310 CS:GO Howl Edition",
    family: "rival310",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1736, {
    model: "Rival 310 PUBG Edition",
    family: "rival310",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // prime_wireless_wired.py: Prime Mini Wireless in USB-cabled mode (one of
  // two models in that file's shared profile — the other is the plain Prime
  // Wireless, out of scope for this cluster, see the doc comment above).
  // No firmware-query command.
  [0x184a, {
    model: "Prime Mini Wireless (wired mode)",
    family: "prime-mini-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // prime_wireless_wireless.py: same mouse, 2.4 GHz dongle mode. Every
  // command byte is `prime_wireless_wired.py`'s with `0b01000000` ORed into
  // byte 0 (see ./prime-mini-wireless.ts's `applyWirelessFlag`).
  [0x1848, {
    model: "Prime Mini Wireless (2.4 GHz mode)",
    family: "prime-mini-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
]);
