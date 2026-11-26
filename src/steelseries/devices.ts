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
 * here. The Rival 3 Gen 2 (`0x1870`) is deliberately absent: its command
 * set is documented as different from every family below, and listing it
 * would claim a device this codec would misprogram. The Rival 3 Wireless
 * Gen 2 (`0x1872`) is present with family `"rival3-wireless-v2"` — its own
 * module, `./rival-3-wireless-v2.ts`, with an XY DPI command and no
 * lighting. The Rival 3 Wireless (`0x1830`) is present with family
 * here. The Rival 3 Wireless Gen 2 (`0x1872`) is deliberately absent: its
 * command set is documented as different from every family below, and
 * listing it would claim a device this codec would misprogram. The Rival 3
 * Gen 2 (`0x1870`) is present with family `"rival3-v2"` — its own module,
 * `./rival-3-v2.ts`, with an XY DPI command no other family shares. The
 * Rival 3 Wireless (`0x1830`) is present with family
 * `"rival3-wireless"` — its own module, `./rival3-wireless.ts`, distinct from
 * both Rival 3 Gen 1 and Aerox 3 (different command bytes throughout, a
 * different DPI sensor table, and, unlike either wired family, a readable
 * battery/firmware state — see that module's doc comment).
 *
 * The Aerox 3 (`0x1836`, family `"aerox3"`) is a separate protocol family
 * from Rival 3 despite both being SteelSeries, single-byte vs. two-byte
 * command prefixes and all — see `./aerox3.ts`'s doc comment, including its
 * reconciliation of PR flozz/rivalcfg#269's Rival 3 Gen 2 claim (shipped as
 * its own `"rival3-v2"` family instead: its DPI command differs from
 * Aerox 3's even though most other commands match).
 *
 * The Aerox 3 Wireless (`"aerox3-wireless"`, four PIDs across its USB-cabled
 * and 2.4 GHz dongle modes, see `./aerox3-wireless.ts`) shares nothing with
 * the wired Aerox 3 beyond the name: its command set is Aerox 5 Wireless's,
 * with a shorter 6-button mapping packet.
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
 * (`prime_plus.py`) is byte-identical to plain Prime's (`prime.py`). The
 * plain Prime PIDs (`0x182E`, plus `0x182A`/`0x1856`) reuse this family's
 * codec; no separate module exists.
 *
 * The Prime Mini Wireless (`"prime-mini-wireless"`, PIDs `0x184A` wired /
 * `0x1848` 2.4 GHz — see `./prime-mini-wireless.ts`) is its own family for
 * the same reason: rivalcfg documents it and the plain (non-Mini) Prime
 * Wireless as one shared `settings` dict inside
 * `prime_wireless_wired.py`/`prime_wireless_wireless.py`. The plain Prime
 * Wireless's PIDs (`0x1842` wired / `0x1840` 2.4 GHz) reuse this family's
 * codec; no separate module exists.
 *
 * The Sensei Pro / Rival Pro (`"sensei-rival-pro"`, base station `0x1880` /
 * dongle `0x1882` — see `./sensei-rival-pro.ts`) is its own family per the
 * same rule: a distinct command set (raw-uint16 XY DPI with per-preset
 * lift-off/landing, dual report/polling rates up to 8000 Hz) reconstructed
 * from the vendor's own SteelSeries GG device specification rather than
 * from rivalcfg, which does not cover these mice. The four models share one
 * specification and report the model themselves; only the station and dongle
 * USB product ids are registered.
 */

export const STEELSERIES_VENDOR_ID = 0x1038;

export type SteelSeriesProtocolFamily =
  | "rival3"
  | "rival3-v2"
  | "aerox3-wireless-gen2"
  | "rival-100"
  | "rival-110"
  | "rival-300"
  | "rival310"
  | "aerox3"
  | "aerox3-wireless"
  | "rival3-wireless"
  | "aerox5"
  | "aerox5-wireless"
  | "rival650"
  | "rival-600"
  | "aerox9-wireless"
  | "prime-plus"
  | "prime-mini-wireless"
  | "sensei-ten"
  | "sensei-rival-pro"
  | "sensei-310"
  | "prime-mini"
  | "rival-5"
  | "rival3-wireless-v2"
  | "sensei-raw";

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
  // rival-100.lisp (vendor GG specification): the first-gen "Rival 100 family"
  // command set (DPI choice 0x03, polling 0x04, LED 0x05/0x07, button-6 mode
  // 0x0B, save 0x09, firmware 0x10, no button remapping). Shared by the Rival
  // 100, its special editions, and the Rival 105 — see ./rival-100.ts. This is
  // NOT the Rival 110/106/300S table (different sensor).
  [0x1702, {
    model: "Rival 100",
    family: "rival-100",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // sensei-raw_base.lisp (vendor GG specification): the original Sensei [RAW]
  // command set — linear two-preset DPI 0x03 (90-5670), polling 0x04, single
  // LED brightness/effect 0x05/0x07, eight 3-byte button slots 0x31, save
  // 0x09, firmware 0x10. Shared by the base and its editions — see
  // ./sensei-raw.ts. Distinct from the Sensei [RAW] Optical RGB (0x1800),
  // which uses the Rival 310 command set.
  [0x1369, {
    model: "Sensei [RAW]",
    family: "sensei-raw",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // rival_base.lisp (vendor GG specification): the original Rival / Rival 300
  // command set — linear DPI 0x03, polling 0x04, two-zone LED 0x08/0x07, six
  // remappable buttons 0x31, save 0x09, firmware 0x10. Shared by the Rival
  // 300 and every edition, plus the original Rival Dota 2 — see
  // ./rival-300.ts. Distinct from the Rival 100/110 command sets.
  [0x1710, {
    model: "Rival 300",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1362, {
    model: "Sensei [RAW] Diablo III Edition",
    family: "sensei-raw",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // rival-110.lisp / rival-106.lisp / rival-300s.lisp (vendor GG
  // specification): all three `include "rival-100"`, so they share its
  // command bytes, but they use the PixArt PMW3326 sensor (200-7200 DPI),
  // not the Rival 100's eight-step table — hence a separate family/module
  // (./rival-110.ts). rivalcfg groups these ids under rival110.py, with
  // rival300s.py reusing it.
  [0x1729, {
    model: "Rival 110",
    family: "rival-110",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x136d, {
    model: "Sensei [RAW] Guild Wars 2 Edition",
    family: "sensei-raw",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1392, {
    model: "Rival Dota 2 Edition",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x136f, {
    model: "Sensei [RAW] Call of Duty: Black Ops II Edition",
    family: "sensei-raw",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // rival-100-pc-bang.lisp: same profile plus a `00 0E 01` pre-packet before
  // the button-6 command (handled in the driver for this PID).
  [0x1708, {
    model: "Rival 100 PC Bang Edition",
    family: "rival-100",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1380, {
    model: "Sensei [RAW] World of Tanks Edition",
    family: "sensei-raw",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1394, {
    model: "Rival 300 CS:GO Fade Edition",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1816, {
    model: "Rival 106",
    family: "rival-110",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1712, {
    model: "Rival 300 Fallout 4 Edition",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x170a, {
    model: "Rival 100 Dell China Edition",
    family: "rival-100",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1714, {
    model: "Rival 300 Acer Predator Edition",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x170b, {
    model: "Rival 100 Dota 2 Edition (Retail)",
    family: "rival-100",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1716, {
    model: "Rival 300 CS:GO Fade Edition (stm32)",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x170c, {
    model: "Rival 100 Dota 2 Edition (Lenovo)",
    family: "rival-100",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1718, {
    model: "Rival 300 HP OMEN Edition",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // rival-105.lisp: includes rival-100 and adds the firmware query.
  [0x1814, {
    model: "Rival 105",
    family: "rival-100",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x171a, {
    model: "Rival 300 CS:GO Hyper Beast Edition",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1810, {
    model: "Rival 300S",
    family: "rival-110",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x171c, {
    model: "Rival 300 Evil Geniuses Edition",
    family: "rival-300",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1390, {
    model: "Sensei [RAW] Heroes of the Storm Edition",
    family: "sensei-raw",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
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
  // rival-3-v2 (vendor GG specification): wired only. Own command set (XY
  // DPI 0x34, polling 0x2B, buttons 0x2A, RGB 0x21, save 0x11, firmware
  // 0x90) — see ./rival-3-v2.ts. Must not reuse the Rival 3 Gen 1 or Aerox
  // 3 modules despite the shared name.
  [0x1870, {
    model: "Rival 3 Gen 2",
    family: "rival3-v2",
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
  // aerox3_wireless_wired.py: usb-cabled mode, interface 3, usage page 0xFFC0.
  // every setting exercised on hardware, see docs/steelseries-testing.md.
  [0x183a, {
    model: "Aerox 3 Wireless (wired mode)",
    family: "aerox3-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: true,
  }],
  [0x187a, {
    model: "Aerox 3 Wireless CS2 Dragon Lore Edition (wired mode)",
    family: "aerox3-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // aerox3_wireless_wireless.py: same mouse over the 2.4 GHz dongle, every
  // command byte ORed with 0x40, see ./aerox3-wireless.ts.
  [0x1838, {
    model: "Aerox 3 Wireless (2.4 GHz mode)",
    family: "aerox3-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: true,
  }],
  // aerox_3_wireless_gen2 (vendor GG specification): Gen 2 shares nothing
  // with the Gen 1 command set beyond the name — raw-uint16 XY DPI with
  // per-preset lift-off, split wired/wireless polling to 4000 Hz. See
  // ./aerox-3-wireless-gen2.ts. Mouse (USB-cabled) and 2.4 GHz dongle modes.
  [0x1892, {
    model: "Aerox 3 Wireless Gen 2 (wired mode)",
    family: "aerox3-wireless-gen2",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1890, {
    model: "Aerox 3 Wireless Gen 2 (2.4 GHz mode)",
    family: "aerox3-wireless-gen2",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1878, {
    model: "Aerox 3 Wireless CS2 Dragon Lore Edition (2.4 GHz mode)",
    family: "aerox3-wireless",
    wireless: true,
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
  // rival-3-wireless-v2 (vendor GG specification): 2.4 GHz mode. Own command
  // set (XY DPI 0x2C, polling 0x17, buttons 0x19, wheel 0x1A, battery
  // 0xAA 0x01, firmware 0x10) — see ./rival-3-wireless-v2.ts. No lighting
  // commands exist on this mouse.
  [0x1872, {
    model: "Rival 3 Wireless Gen 2",
    family: "rival3-wireless-v2",
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
  // rival-600.lisp (vendor GG specification): wired only. Own command set
  // (sensitivity 0x03 per-level, polling 0x04, button feature report 0x31,
  // proximity 0x96, save 0x09, firmware 0x10) — see ./rival-600.ts.
  // Distinct from the Rival 650 Wireless despite the shared A3360 sensor.
  [0x1724, {
    model: "Rival 600",
    family: "rival-600",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // dota2-rival-600.lisp includes rival-600.lisp unchanged.
  [0x172e, {
    model: "Rival 600 Dota 2 Edition",
    family: "rival-600",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
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
  // prime.py is byte-identical to prime_plus.py (same sensitivity 0x61,
  // polling 0x5D, color, brightness, buttons 0x5B, save 0x59 — verified by
  // direct comparison when prime-plus.ts was written), so these PIDs reuse
  // the Prime+ codec with no new module.
  [0x182e, {
    model: "Prime",
    family: "prime-plus",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x182a, {
    model: "Prime 6 Siege Black Ice Edition",
    family: "prime-plus",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x1856, {
    model: "Prime CS:GO Neo Noir Edition",
    family: "prime-plus",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // prime_mini.lisp (vendor GG specification): wired only. Own command set
  // (DPI batch 0x2D with uint16 factors, polling 0x2B, buttons 0x2A,
  // single-zone lighting, firmware 0x90) — see ./prime-mini.ts. Not the
  // Prime Mini Wireless (0x184A/0x1848, family "prime-mini-wireless"),
  // which shares the plain Prime Wireless command set instead.
  [0x184d, {
    model: "Prime Mini",
    family: "prime-mini",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
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
  // The plain (non-Mini) Prime Wireless shares the Prime Mini Wireless
  // command set byte-for-byte (one shared `settings` dict in
  // `prime_wireless_wired.py` / `prime_wireless_wireless.py`, confirmed
  // against the vendor's own GG device specification), so these PIDs reuse
  // the Prime Mini Wireless codec with no new module.
  [0x1842, {
    model: "Prime Wireless (wired mode)",
    family: "prime-mini-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x1840, {
    model: "Prime Wireless (2.4 GHz mode)",
    family: "prime-mini-wireless",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  // sensei_ten.py: wired only, endpoint 0. Own command set (0x54/0x55/0x5B/
  // 0x31/0x59), a linear (non-table) DPI encoding distinct from rival310's
  // (2-byte little-endian words vs. 1-byte), and a readable firmware version
  // behind 0x90 00 — see ./sensei-ten.ts's doc comment, including its
  // explicit libratbag/OpenRGB corroboration-gap disclosure.
  [0x1832, {
    model: "Sensei TEN",
    family: "sensei-ten",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  [0x1834, {
    model: "Sensei TEN CS:GO Neon Rider Edition",
    family: "sensei-ten",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // sensei-310 shares Rival 310's command set wholesale (the vendor
  // specification includes it and overrides only the button table) — see
  // ./sensei-310.ts. Own family because the button mapping differs.
  [0x1722, {
    model: "Sensei 310",
    family: "sensei-310",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // rival-5.lisp (vendor GG specification): wired only. Own command set
  // (DPI batch 0x2D with TrueMove Air bytes, polling 0x2B, 11-slot buttons
  // 0x2A, 10-zone lighting, firmware 0x90) — see ./rival-5.ts. No
  // rivalcfg profile exists for this mouse.
  [0x183c, {
    model: "Rival 5",
    family: "rival-5",
    wireless: false,
    settingsReadable: false,
    hasFirmwareQuery: true,
    verified: false,
  }],
  // Sensei Pro / Rival Pro share one vendor specification: the mouse reports
  // its model and color itself (`read_device_model`), and the host talks to
  // the base station or the dongle. Only those two USB product ids appear in
  // the shipped specification; individual mouse-side ids are not listed.
  [0x1880, {
    model: "Sensei Pro / Rival Pro (base station)",
    family: "sensei-rival-pro",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
  [0x1882, {
    model: "Sensei Pro / Rival Pro (dongle)",
    family: "sensei-rival-pro",
    wireless: true,
    settingsReadable: false,
    hasFirmwareQuery: false,
    verified: false,
  }],
]);
