export * from "../compx/codec.js";
export * from "./atlantis.js";
export * from "./lunafury.js";
export * from "./magnetic.js";
export interface LamzuProduct {
  model: string;
  wireless: boolean;
  pollingRates: readonly number[];
  brand?: "Lamzu" | "CRDRAKO" | "Attack Shark" | "LunaFury" | "RAWM";
  /** Left and right buttons are magnetic switches (Leviathan V4 GT). */
  magnetic?: boolean;
  uiFamily?: string;
  mouseTarget?: number;
  maxDpi?: number;
  maxDpiStages?: number;
  sleepOptions?: readonly number[];
  /** The receiver answers the dongle LED on/off command (page 0x02, 0x04/0x84). */
  dongleLed?: boolean;
}
export const LAMZU_VENDOR_ID = 0x373e;
const RATES_1K = [125, 250, 500, 1000] as const;
const RATES_8K = [500, 1000, 2000, 4000, 8000] as const;
const RATES_8K_FULL = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
export const CRDRAKO_PRODUCT_IDS = [0x006a, 0x006b] as const;
// LunaFury's public web configurator (mouse.lunafury.games, inspected
// 2026-10-05) names these runtime identities and uses the same 64-byte CompX
// feature-report framing as this driver. Its B032/B033/B054/B084 identities
// are firmware-update bootloaders and are intentionally not catalogued here.
export const LUNAFURY_PRODUCT_IDS = [0x0032, 0x0033, 0x0054, 0x0084] as const;
// Attack Shark Core 2.0.7.9 (Config/xvi_models.xlsx) lists all three on the
// same CompX platform: wired 125-1000, 8K receiver 125-8000, DPIMax 42000.
// Only the R5 Ultra has been seen on hardware.
export const ATTACKSHARK_PRODUCT_IDS = [0x0046, 0x0047, 0x0021, 0x0022, 0x003a, 0x003b] as const;
export const LAMZU_PRODUCTS: ReadonlyMap<number, LamzuProduct> = new Map([
  // RAWM's Leviathan V4 GT answers the same page-command framing. Product ids
  // come from the V4 GT's web hub; not yet tried on hardware.
  [0x0098, {
    brand: "RAWM", model: "Leviathan V4 GT", wireless: false,
    pollingRates: RATES_8K_FULL, maxDpi: 45000, magnetic: true,
  }],
  [0x0099, {
    brand: "RAWM", model: "Leviathan V4 GT", wireless: true,
    pollingRates: RATES_8K_FULL, maxDpi: 45000, magnetic: true,
  }],
  [0x001c, { model: "Maya X", wireless: false, pollingRates: RATES_1K }],
  [0x001d, { model: "Maya X", wireless: true, pollingRates: RATES_1K }],
  [0x001e, { model: "Maya X", wireless: true, pollingRates: RATES_8K }],
  [0x006a, {
    brand: "CRDRAKO", model: "KO-ONE", wireless: false,
    pollingRates: RATES_8K_FULL, mouseTarget: 0x00, uiFamily: "crdrako",
  }],
  [0x006b, {
    brand: "CRDRAKO", model: "KO-ONE", wireless: true,
    pollingRates: RATES_8K_FULL, mouseTarget: 0x02, uiFamily: "crdrako",
  }],
  [0x0032, {
    brand: "LunaFury", model: "LUNA33", wireless: false,
    pollingRates: RATES_1K, mouseTarget: 0x00, maxDpi: 30000, maxDpiStages: 6,
    uiFamily: "lunafury",
  }],
  [0x0033, {
    brand: "LunaFury", model: "LUNA33", wireless: true,
    pollingRates: RATES_8K_FULL, maxDpi: 30000, maxDpiStages: 6, uiFamily: "lunafury",
  }],
  [0x0054, {
    brand: "LunaFury", model: "TYPE33", wireless: false,
    pollingRates: RATES_8K_FULL, mouseTarget: 0x00, maxDpi: 30000, maxDpiStages: 5,
    uiFamily: "lunafury",
  }],
  [0x0084, {
    brand: "LunaFury", model: "TYPE33", wireless: true,
    pollingRates: RATES_8K_FULL, maxDpi: 30000, maxDpiStages: 5, uiFamily: "lunafury",
  }],
  [0x0046, {
    brand: "Attack Shark", model: "R5 Ultra", wireless: false,
    pollingRates: RATES_1K, maxDpi: 42000, uiFamily: "attack-shark",
  }],
  [0x0047, {
    brand: "Attack Shark", model: "R5 Ultra", wireless: true,
    pollingRates: RATES_8K_FULL, maxDpi: 42000, uiFamily: "attack-shark",
    // Attack Shark Core 2.0.7.9 (DriverCore.exe, DongleLEDOnOff): the toggle
    // only shows on the receiver, and later Core releases dropped it.
    dongleLed: true,
  }],
  [0x0021, {
    brand: "Attack Shark", model: "R6", wireless: false,
    pollingRates: RATES_1K, maxDpi: 42000, uiFamily: "attack-shark",
  }],
  [0x0022, {
    brand: "Attack Shark", model: "R6", wireless: true,
    pollingRates: RATES_8K_FULL, maxDpi: 42000, uiFamily: "attack-shark",
  }],
  [0x003a, {
    brand: "Attack Shark", model: "R8", wireless: false,
    pollingRates: RATES_1K, maxDpi: 42000, uiFamily: "attack-shark",
  }],
  [0x003b, {
    brand: "Attack Shark", model: "R8", wireless: true,
    pollingRates: RATES_8K_FULL, maxDpi: 42000, uiFamily: "attack-shark",
  }],
]);
/**
 * Lamzu's own vendor id, introduced with the Inca 8K. Every earlier Lamzu
 * model enumerates under the shared CompX ODM id 0x373e above, which CRDRAKO
 * and Attack Shark also use, so the two catalogs are kept apart: the same
 * product id means different hardware depending on which vendor id it arrived
 * under. The Inca answers the identical CompX framing, so only the lookup
 * needed splitting, not the protocol.
 */
export const LAMZU_INCA_VENDOR_ID = 0x37b0;

export const LAMZU_VENDOR_IDS: readonly number[] = [LAMZU_VENDOR_ID, LAMZU_INCA_VENDOR_ID];

/**
 * Products under Lamzu's own vendor id. 0x0009 (the mouse on its cable) and
 * 0x0010 (the 8K receiver) are confirmed on hardware — see
 * docs/lamzu-inca-testing.md. Both answer the mouse on target 0x02, so neither
 * needs a `mouseTarget` override.
 *
 * The rate split shows up in the capture itself: LAMZU_POLLING_RATES encodes
 * 1000 Hz twice, 0x01 in the 125/250/500/1000 family and 0x10 in the
 * 1000/2000/4000/8000 family, and the cable answered 0x01 where the 8K
 * receiver answered 0x40. Lamzu's Aurora configurator agrees — its device
 * table gives the Inca `PollingRateWired` 125-1000 and `_8KDonglePollingRate`
 * 500-8000 — and its `DPIMax` of 30000 is already the driver default, so no
 * `maxDpi` override is needed.
 *
 * 0x000f is the 1K receiver the Inca can also ship with. It is taken from that
 * same Aurora table (`_1KDongle` 000F, `_1KDonglePollingRate` 125-1000) and
 * has NOT been exercised on hardware; the protocol is the receiver protocol
 * either way, so the risk is a wrong rate list rather than a dead device.
 *
 * The Paro Aurora (released mid-2025, PAW3950) is also entered here from that
 * table, under the same vendor id and protocol flags as the Inca
 * (`IsNewProtocol`: 1, `IsCompx`: 0, `DPIMax` 30000 — the driver default, so
 * no `maxDpi` override). Its three ids are `PIDWired` 0x0007 (125-1000),
 * `_1KDongle` 0x000d (125-1000) and `_8KDongle` 0x000e (500-8000). None of
 * them has been exercised on hardware yet — issue #167 — so a wrong rate list
 * is the failure mode, not a dead device.
 *
 * Deliberately absent: 0x000a and 0x0002, which Aurora lists as
 * `DeviceBLPID` and `Receiver4K8KBLPID` — the DFU bootloader identities the
 * mouse and dongle take while flashing firmware. They never speak this
 * protocol and must not be offered in the picker. The Paro's own bootloader
 * ids, 0x0008 (`DeviceBLPID`) and 0x0004 (`_1KDongleIDVD`), are excluded for
 * the same reason; its 8K dongle shares 0x0002 with the Inca.
 */
export const LAMZU_INCA_PRODUCTS: ReadonlyMap<number, LamzuProduct> = new Map([
  [0x0009, { model: "Inca 8K", wireless: false, pollingRates: RATES_1K }],
  [0x000f, { model: "Inca 8K", wireless: true, pollingRates: RATES_1K }],
  [0x0010, { model: "Inca 8K", wireless: true, pollingRates: RATES_8K }],
  [0x0007, { model: "Paro Aurora", wireless: false, pollingRates: RATES_1K }],
  [0x000d, { model: "Paro Aurora", wireless: true, pollingRates: RATES_1K }],
  [0x000e, { model: "Paro Aurora", wireless: true, pollingRates: RATES_8K }],
]);

/**
 * Resolves a product against the catalog its vendor id belongs to. A vendor id
 * this brand does not use resolves to nothing rather than falling through to
 * the 0x373e catalog, so the same product id under a foreign vendor id is never
 * mistaken for a Lamzu.
 */
export function lamzuProduct(vendorId: number, productId: number): LamzuProduct | undefined {
  if (vendorId === LAMZU_INCA_VENDOR_ID) return LAMZU_INCA_PRODUCTS.get(productId);
  if (vendorId === LAMZU_VENDOR_ID) return LAMZU_PRODUCTS.get(productId);
  return undefined;
}

export const LAMZU_POLLING_RATES = [
  [0x08, 125], [0x04, 250], [0x02, 500], [0x01, 1000],
  [0x10, 1000], [0x20, 2000], [0x40, 4000], [0x80, 8000],
] as const;
