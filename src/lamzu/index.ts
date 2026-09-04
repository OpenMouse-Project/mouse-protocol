export * from "../compx/codec.js";
export interface LamzuProduct {
  model: string;
  wireless: boolean;
  pollingRates: readonly number[];
  brand?: "Lamzu" | "CRDRAKO" | "Attack Shark";
  uiFamily?: string;
  mouseTarget?: number;
  maxDpi?: number;
  sleepOptions?: readonly number[];
}
export const LAMZU_VENDOR_ID = 0x373e;
const RATES_1K = [125, 250, 500, 1000] as const;
const RATES_8K = [500, 1000, 2000, 4000, 8000] as const;
const RATES_8K_FULL = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
export const CRDRAKO_PRODUCT_IDS = [0x006a, 0x006b] as const;
export const ATTACKSHARK_PRODUCT_IDS = [0x0046, 0x0047] as const;
export const LAMZU_PRODUCTS: ReadonlyMap<number, LamzuProduct> = new Map([
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
  [0x0046, {
    brand: "Attack Shark", model: "R5 Ultra", wireless: false,
    pollingRates: RATES_1K, maxDpi: 42000, uiFamily: "attack-shark",
  }],
  [0x0047, {
    brand: "Attack Shark", model: "R5 Ultra", wireless: true,
    pollingRates: RATES_8K, maxDpi: 42000, uiFamily: "attack-shark",
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
 * Deliberately absent: 0x000a and 0x0002, which Aurora lists as
 * `DeviceBLPID` and `Receiver4K8KBLPID` — the DFU bootloader identities the
 * mouse and dongle take while flashing firmware. They never speak this
 * protocol and must not be offered in the picker.
 */
export const LAMZU_INCA_PRODUCTS: ReadonlyMap<number, LamzuProduct> = new Map([
  [0x0009, { model: "Inca 8K", wireless: false, pollingRates: RATES_1K }],
  [0x000f, { model: "Inca 8K", wireless: true, pollingRates: RATES_1K }],
  [0x0010, { model: "Inca 8K", wireless: true, pollingRates: RATES_8K }],
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
