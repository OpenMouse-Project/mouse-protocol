import { EGG_WE_HID_FILTERS } from "./endgame/egg-we-control.ts";
import {
  LOGITECH_BOLT_PRODUCT_IDS,
  LOGITECH_DIRECT_PRODUCT_IDS,
} from "@openmouse/protocol/logitech";
import { RAZER_PRODUCTS, RAZER_PRODUCT_IDS } from "@openmouse/protocol/razer-devices";
import { PULSAR_XS1_PRODUCT_IDS } from "@openmouse/protocol/pulsar";
import {
  NINJUTSO_LEGACY_MOUSE_PRODUCT_IDS,
  NINJUTSO_LEGACY_RECEIVER_PRODUCT_IDS,
  NINJUTSO_LEGACY_VENDOR_ID,
  NINJUTSO_MOUSE_PRODUCT_IDS,
  NINJUTSO_RECEIVER_PRODUCT_IDS,
  NINJUTSO_VENDOR_ID,
} from "@openmouse/protocol/ninjutso";
import {
  ZAUNKOENIG_PRODUCT_IDS,
  ZAUNKOENIG_USAGE_PAGE,
  ZAUNKOENIG_VENDOR_ID,
} from "@openmouse/protocol/zaunkoenig";

export const VENDOR_ID = {
  pulsar: 0x3710,
  endgameGear: 0x3367,
  wlmouse: 0x36a7,
  lamzu: 0x373e,
  attackshark: 0x373e,
  logitech: 0x046d,
  orbital: 0x1915,
  razer: 0x1532,
  teevolution: 0x3554,
  vgn: 0x3554,
  atk: 0x373b,
  finalmouse: 0x361d,
  keychron: 0x3434,
  moddo: 0x2fe3,
  attackShark: 0x25a7,
  attackSharkX: 0x1d57, // R1 / X11 family OEM VID (PIDs vary per firmware)
  ninjutsoLegacy: NINJUTSO_LEGACY_VENDOR_ID,
  ninjutso: NINJUTSO_VENDOR_ID,
  zaunkoenig: ZAUNKOENIG_VENDOR_ID,
  fantech: 0x3151,
} as const;

// Keychron VIA raw HID. 0x0440 is Nape Pro wired; 0xd026/0xd029 are shared Link-KM receivers.
export const KEYCHRON_PRODUCT_IDS = [0x0440, 0xd026, 0xd029] as const;

export const KEYCHRON_HID_FILTERS: HIDDeviceFilter[] = KEYCHRON_PRODUCT_IDS.map(
  (productId) => ({ vendorId: VENDOR_ID.keychron, productId, usagePage: 0xff60, usage: 0x61 }),
);

// moddoMOUSE exposes its vendor config interface on usage page 0xff, usage 0x01
// (older firmware answers on usage 0x02). Offer both so the picker lists the
// control interface; the driver rejects anything without the config report.
export const MODDO_HID_FILTERS: HIDDeviceFilter[] = [
  { vendorId: VENDOR_ID.moddo, usagePage: 0xff, usage: 0x01 },
  { vendorId: VENDOR_ID.moddo, usagePage: 0xff, usage: 0x02 },
];

// The X3 family's control channel is the Sonix XS-1 interface: a single
// 64-byte unnumbered feature report on usage page 0xffff. Request that
// collection directly so the picker lists the control interface instead of the
// mouse's plain pointer interface, which cannot answer feature reports.
export const PULSAR_XS1_HID_FILTERS: HIDDeviceFilter[] = [...PULSAR_XS1_PRODUCT_IDS].map(
  (productId) => ({ vendorId: VENDOR_ID.pulsar, productId, usagePage: 0xffff, usage: 0x01 }),
);

// Viper V2/V3 Pro and Mouse Dock Pro expose their control channel as a Generic
// Desktop Mouse collection. Limit this broad collection filter to known PIDs so
// it cannot also surface unrelated Razer keyboards or the Viper V4 Pro's
// ordinary boot-mouse interfaces.
export const RAZER_MOUSE_DOCK_PRO_CONTROL_FILTERS: HIDDeviceFilter[] = [0x00a4].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId, usagePage: 0x01, usage: 0x02 }),
);

export const RAZER_VIPER_V2_CONTROL_FILTERS: HIDDeviceFilter[] = [0x00a5, 0x00a6].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId, usagePage: 0x01, usage: 0x02 }),
);

export const RAZER_VIPER_V3_CONTROL_FILTERS: HIDDeviceFilter[] = [0x00c0, 0x00c1].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId, usagePage: 0x01, usage: 0x02 }),
);

// The Viper Mini answers on the same kind of single Generic Desktop Mouse
// control interface as the V3 Pro, so it gets the same narrow collection filter.
export const RAZER_VIPER_MINI_CONTROL_FILTERS: HIDDeviceFilter[] = [0x008a].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId, usagePage: 0x01, usage: 0x02 }),
);

// The original Viper exposes the same single Generic Desktop Mouse control
// interface, so it gets the same narrow collection filter.
export const RAZER_VIPER_CONTROL_FILTERS: HIDDeviceFilter[] = [0x0078].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId, usagePage: 0x01, usage: 0x02 }),
);

// Synapse Web exposes the V4 control interface through a single top-level
// Generic Desktop or Consumer collection with Feature reports. Request both
// pages so the browser offers that interface, then the driver rejects ordinary
// mouse/keyboard interfaces that lack the required report.
export const RAZER_VIPER_V4_CONTROL_FILTERS: HIDDeviceFilter[] = [0x00e5, 0x00e6].flatMap(
  (productId) => [0x01, 0x0c].map((usagePage) => ({ vendorId: VENDOR_ID.razer, productId, usagePage })),
);

// The DeathAdder Essential family splits its pointer and configuration
// channels across separate interfaces, and which usage page carries the
// configuration one varies by hardware revision. Request the whole device so
// the picker can offer every interface, then the driver rejects the ones that
// cannot answer. 0x006e is the original, 0x0071 the White Edition, 0x0098 the
// 2021 revision.
export const RAZER_DEATHADDER_ESSENTIAL_FILTERS: HIDDeviceFilter[] = [0x006e, 0x0071, 0x0098].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId }),
);

// The Cobra's control interface layout has not been pinned down, so the whole
// device is requested and the driver accepts whichever interface answers.
export const RAZER_COBRA_FILTERS: HIDDeviceFilter[] = [0x00a3].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId }),
);

/**
 * Razer product ids whose control interface is known, and which therefore get a
 * narrower filter of their own above. Excluded from the catch-all below so a
 * broad filter cannot quietly widen one that was deliberately narrowed.
 */
const RAZER_NARROWED_PRODUCT_IDS: ReadonlySet<number> = new Set([
  0x00a4, 0x00a5, 0x00a6, 0x00c0, 0x00c1, 0x006e, 0x0071, 0x0098, 0x0084,
]);

/**
 * Every remaining product in the Razer registry. Which interface carries the
 * control channel has not been established for these, and it varies by
 * revision, so the whole device is requested and the picker offers each
 * interface: the driver rejects the ones that cannot answer, and a model whose
 * first entry never replies is added again on another entry.
 *
 * Products flagged `nativeOnly` in the registry are left out: their control
 * channel is on a Chrome-protected collection, so no granted interface can
 * ever answer and offering them just produces a dead picker entry.
 */
export const RAZER_REGISTRY_FILTERS: HIDDeviceFilter[] = RAZER_PRODUCT_IDS
  .filter((productId) => !RAZER_NARROWED_PRODUCT_IDS.has(productId))
  .filter((productId) => !RAZER_PRODUCTS.get(productId)?.nativeOnly)
  .map((productId) => ({ vendorId: VENDOR_ID.razer, productId }));

// The DeathAdder V2 keeps the Essential family's split interface layout, so it
// needs the same whole-device request rather than a single-collection filter.
export const RAZER_DEATHADDER_V2_FILTERS: HIDDeviceFilter[] = [0x0084].map(
  (productId) => ({ vendorId: VENDOR_ID.razer, productId }),
);

export const TEEVOLUTION_PRODUCT_IDS = [0xf520, 0xf523, 0xf5bb, 0xf522] as const;

// Logitech HID++ control interfaces addressed through a receiver slot.
// 0xc54d and 0xc547 are newer Lightspeed receivers, 0xc539 is HERO-era
// Lightspeed, 0xc0a8 is the PRO X 2 Superstrike USB interface, and Bolt
// product ids live in ./logitech/protocol with the direct-connect list.
export const LOGITECH_RECEIVER_PRODUCT_IDS = [
  0xc54d,
  0xc539,
  0xc0a8,
  0xc547,
  ...LOGITECH_BOLT_PRODUCT_IDS,
] as const;

// Every Logitech product with an HID++ control interface, receiver-addressed or
// not. Direct-connect and Bolt product IDs live in ./logitech/protocol so the
// driver and these filters cannot disagree about which index a mouse answers on.
export const LOGITECH_PRODUCT_IDS = [
  ...LOGITECH_RECEIVER_PRODUCT_IDS,
  ...LOGITECH_DIRECT_PRODUCT_IDS,
] as const;

/**
 * Every Logitech HID++ control interface, not only the product ids listed
 * above: a mouse we have never seen should still be offered. Usage 1 is the
 * short-report HID++ collection used by Lightspeed and for Bolt receiver
 * registers; usage 2 is the long-report collection Bolt mice need for HID++
 * 2.0 feature traffic. The driver decides mouse-vs-keyboard after connecting.
 */
export const LOGITECH_RECEIVER_FILTERS: HIDDeviceFilter[] = [
  { vendorId: VENDOR_ID.logitech, usagePage: 0xff00, usage: 0x0001 },
  { vendorId: VENDOR_ID.logitech, usagePage: 0xff00, usage: 0x0002 },
];

// Retained for existing imports; points at the first supported receiver.
export const LOGITECH_RECEIVER_FILTER: HIDDeviceFilter = LOGITECH_RECEIVER_FILTERS[0];

export const WLMOUSE_PRODUCTS: ReadonlyMap<number, { name: string; wireless: boolean }> = new Map([
  [0xa860, { name: "Beast G", wireless: true }],
  [0xa861, { name: "Beast G", wireless: false }],
  [0xa863, { name: "Huan", wireless: true }],
  [0xa864, { name: "Huan", wireless: false }],
  [0xa866, { name: "Beast Miao", wireless: true }],
  [0xa867, { name: "Beast Miao", wireless: false }],
  [0xa868, { name: "Beast Mini Pro", wireless: true }],
  [0xa869, { name: "Beast Mini Pro", wireless: false }],
  [0xa870, { name: "Beast X Pro", wireless: true }],
  [0xa871, { name: "Beast X Pro", wireless: false }],
  [0xa872, { name: "Strider", wireless: true }],
  [0xa873, { name: "Strider", wireless: false }],
  [0xa874, { name: "Ying", wireless: true }],
  [0xa875, { name: "Ying", wireless: false }],
  [0xa878, { name: "Sword X", wireless: true }],
  [0xa879, { name: "Sword X", wireless: false }],
  [0xa880, { name: "Beast Max", wireless: true }],
  [0xa881, { name: "Beast Max", wireless: false }],
  [0xa882, { name: "WLmouse 1K receiver", wireless: true }],
  [0xa883, { name: "Beast X", wireless: true }],
  [0xa884, { name: "Beast X", wireless: false }],
  [0xa885, { name: "Beast Mini", wireless: true }],
  [0xa886, { name: "Beast Mini", wireless: false }],
]);

export const WLMOUSE_MAX_POLLING_HZ: ReadonlyMap<number, number> = new Map([
  [0xa882, 1000],
]);

export const SUPPORTED_HID_FILTERS: HIDDeviceFilter[] = [
  ...ZAUNKOENIG_PRODUCT_IDS.map((productId) => ({
    vendorId: ZAUNKOENIG_VENDOR_ID,
    productId,
    usagePage: ZAUNKOENIG_USAGE_PAGE,
  })),
  { vendorId: VENDOR_ID.finalmouse, productId: 0x0100, usagePage: 0xff00, usage: 0x0001 },
  { vendorId: VENDOR_ID.pulsar },
  ...PULSAR_XS1_HID_FILTERS,
  // The Pulsar 4K Wireless Receiver enumerates under the shared Teevolution/VGN
  // vendor id with a Pulsar-specific product id, so the broad VID-only filter
  // keeps it visible in the picker; the driver disambiguates by product id.
  { vendorId: VENDOR_ID.vgn },
  { vendorId: VENDOR_ID.endgameGear },
  { vendorId: VENDOR_ID.wlmouse },
  // 0x373e is the shared CompX ODM vendor id behind Lamzu, CRDRAKO, and
  // Attack Shark. The broad filter surfaces all of them; each driver rejects
  // interfaces that lack the feature-report-0 control channel.
  { vendorId: VENDOR_ID.lamzu },
  { vendorId: VENDOR_ID.orbital, usagePage: 0xff0a, usage: 1 },
  ...TEEVOLUTION_PRODUCT_IDS.map((productId) => ({ vendorId: VENDOR_ID.teevolution, productId })),
  ...RAZER_MOUSE_DOCK_PRO_CONTROL_FILTERS,
  ...RAZER_VIPER_V2_CONTROL_FILTERS,
  ...RAZER_VIPER_V3_CONTROL_FILTERS,
  ...RAZER_VIPER_MINI_CONTROL_FILTERS,
  ...RAZER_VIPER_CONTROL_FILTERS,
  { vendorId: VENDOR_ID.vgn, productId: 0xfb56 },
  { vendorId: VENDOR_ID.vgn, productId: 0xfb57 },
  { vendorId: VENDOR_ID.atk, usagePage: 0xff02, usage: 2 },
  { vendorId: VENDOR_ID.attackShark },
  { vendorId: VENDOR_ID.attackSharkX },
  ...RAZER_VIPER_V4_CONTROL_FILTERS,
  ...RAZER_DEATHADDER_ESSENTIAL_FILTERS,
  ...RAZER_COBRA_FILTERS,
  ...KEYCHRON_HID_FILTERS,
  ...RAZER_REGISTRY_FILTERS,
  ...RAZER_DEATHADDER_V2_FILTERS,
  ...EGG_WE_HID_FILTERS,
  ...MODDO_HID_FILTERS,
  ...[...NINJUTSO_LEGACY_MOUSE_PRODUCT_IDS, ...NINJUTSO_LEGACY_RECEIVER_PRODUCT_IDS]
    .map((productId) => ({ vendorId: NINJUTSO_LEGACY_VENDOR_ID, productId })),
  ...[...NINJUTSO_MOUSE_PRODUCT_IDS, ...NINJUTSO_RECEIVER_PRODUCT_IDS]
    .map((productId) => ({ vendorId: NINJUTSO_VENDOR_ID, productId })),
  ...LOGITECH_RECEIVER_FILTERS,
  // Fantech mice use vendor usage page 0xFFFF, usage 0x02 for configuration.
  { vendorId: VENDOR_ID.fantech, usagePage: 0xffff, usage: 0x02 },
];
