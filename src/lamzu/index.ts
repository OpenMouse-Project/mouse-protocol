export * from "../compx/codec.js";
export interface LamzuProduct {
  model: string;
  wireless: boolean;
  pollingRates: readonly number[];
  maxDpi?: number;
  sleepOptions?: readonly number[];
}
export const LAMZU_VENDOR_ID = 0x373e;
const RATES_1K = [125, 250, 500, 1000] as const;
const RATES_8K = [500, 1000, 2000, 4000, 8000] as const;
export const LAMZU_PRODUCTS: ReadonlyMap<number, LamzuProduct> = new Map([
  [0x001c, { model: "Maya X", wireless: false, pollingRates: RATES_1K }],
  [0x001d, { model: "Maya X", wireless: true, pollingRates: RATES_1K }],
  [0x001e, { model: "Maya X", wireless: true, pollingRates: RATES_8K }],
]);
export const LAMZU_POLLING_RATES = [
  [0x08, 125], [0x04, 250], [0x02, 500], [0x01, 1000],
  [0x10, 1000], [0x20, 2000], [0x40, 4000], [0x80, 8000],
] as const;

