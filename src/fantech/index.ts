export interface FantechProduct {
  model: string;
  wireless: boolean;
  pollingRates: readonly number[];
  maxDpi?: number;
}

const RATES_8K = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

export const FANTECH_VENDOR_ID = 0x3151;

export const FANTECH_PRODUCTS: ReadonlyMap<number, FantechProduct> = new Map([
  [0x503d, {
    model: "WG14P Yari Pro Wireless 8K Gaming Mouse",
    wireless: true,
    pollingRates: RATES_8K,
    maxDpi: 42000,
  }],
]);
