/** Protocol capabilities from the AJAZZ 2.2.5 device catalogue, not product-name guesses. */
export interface Aj200pProduct {
  name: string;
  sensor: "PAW3311" | "PAW3395" | "PAW3950" | "PAW3955";
  wired: boolean;
  verified: boolean;
  minDpi: number;
  maxDpi: number;
  stepDpi: number;
  flywheel: boolean;
  bleSetting: boolean;
  lodCodes: readonly number[];
  wirelessRates: readonly number[];
  wiredRates: readonly number[];
  /** Only MASTER 3.3.13's key-action dispatcher has been examined. */
  hiddenActionsAnalyzed: boolean;
}
const RATE_1K = [125, 250, 500, 1000];
const RATE_4K = [...RATE_1K, 2000, 4000];
const RATE_8K = [...RATE_4K, 8000];
const catalogue = new Map<number, Aj200pProduct>();
function model(
  name: string,
  sensor: Aj200pProduct["sensor"],
  maxDpi: number,
  ids: readonly [number, boolean][],
  features: {
    flywheel?: boolean;
    wirelessRates?: readonly number[];
    lodCodes?: readonly number[];
    hiddenActions?: boolean;
  } = {},
) {
  for (const [id, wired] of ids)
    catalogue.set(id, {
      name: `AJAZZ ${name}`,
      sensor,
      wired,
      verified: id === 0xed1c,
      minDpi: sensor === "PAW3955" ? 1 : 50,
      maxDpi,
      stepDpi: sensor === "PAW3955" ? 1 : 50,
      flywheel: features.flywheel ?? false,
      bleSetting: sensor !== "PAW3311",
      lodCodes:
        features.lodCodes ??
        (sensor === "PAW3311" ? [] : sensor === "PAW3395" ? [1, 2] : [0, 1, 2]),
      wirelessRates: features.wirelessRates ?? (sensor === "PAW3311" ? RATE_1K : RATE_4K),
      wiredRates: sensor === "PAW3311" ? RATE_1K : RATE_8K,
      hiddenActionsAnalyzed: features.hiddenActions ?? false,
    });
}
model("AJ200 NL AI MC", "PAW3311", 24000, [
  [0xed03, true],
  [0xed05, false],
]);
model("AJ200P NL AI MC", "PAW3311", 26000, [
  [0xed06, true],
  [0xed00, false],
]);
model("AJ200 NL AI PRO+", "PAW3395", 32000, [
  [0xed07, true],
  [0xed08, false],
  [0xfc08, false],
]);
model("AJ200P NL AI ULTRA", "PAW3950", 42000, [
  [0xed09, true],
  [0xed0a, false],
  [0xfc0a, false],
]);
model(
  "AJ200P NL AI ULTRA+",
  "PAW3950",
  42000,
  [
    [0xed0b, true],
    [0xed0c, false],
    [0xfc0c, false],
  ],
  { flywheel: true, wirelessRates: [250, 500, 1000, 2000, 4000, 8000] },
);
model("AJ200P NL AI ULTRA-3955", "PAW3955", 80000, [
  [0xed1d, true],
  [0xed1e, false],
]);
// The nano receiver has a distinct name and advertises 8 kHz in the catalogue.
model("AJ200P NL AI ULTRA", "PAW3955", 80000, [[0xfc1e, false]], { wirelessRates: RATE_8K });
model(
  "AJ200P AI MASTER",
  "PAW3955",
  80000,
  [
    [0xed1b, true],
    [0xed1c, false],
    [0xfc1c, false],
  ],
  { flywheel: true, wirelessRates: RATE_8K, hiddenActions: true },
);
model(
  "AJ200P NL AI S ULTRA",
  "PAW3955",
  80000,
  [
    [0xed25, true],
    [0xed26, false],
    [0xfc26, false],
  ],
  { wirelessRates: RATE_8K },
);
export const AJ200P_PRODUCTS: ReadonlyMap<number, Aj200pProduct> = catalogue;
export function aj200pSettingsLength(product: Aj200pProduct): number {
  return 30 + Number(product.bleSetting) + (product.flywheel ? 8 : 0);
}
