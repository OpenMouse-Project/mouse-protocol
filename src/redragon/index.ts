import { REDRAGON_M612_MODEL } from "./m612.js";
import { REDRAGON_M724_MODEL } from "./m724.js";
import type { RedragonModel } from "./holtek.js";

export interface RedragonProduct {
  model: string;
  name: string;
  transport: "wired";
  /** True only after the exact PID and path were exercised on hardware. */
  verified: boolean;
  /** Onboard DPI stages per profile. */
  stages: number;
  /** Highest DPI RDCfg's slider offers for this product. */
  maxDpi: number;
}

export const REDRAGON_PRODUCTS: ReadonlyMap<number, RedragonProduct> = new Map([
  [0xfc7a, {
    model: "M724",
    name: "K1NG 1K",
    transport: "wired",
    verified: true,
    stages: 5,
    maxDpi: 12400,
  }],
  [0xfc61, {
    model: "M612",
    name: "Predator M612",
    transport: "wired",
    verified: true,
    stages: 5,
    maxDpi: 8000,
  }],
]);

export const REDRAGON_PRODUCT_IDS: readonly number[] = [...REDRAGON_PRODUCTS.keys()];

/** Codec differences per Holtek PID. */
export const REDRAGON_MODELS: ReadonlyMap<number, RedragonModel> = new Map([
  [REDRAGON_M724_MODEL.productId, REDRAGON_M724_MODEL],
  [REDRAGON_M612_MODEL.productId, REDRAGON_M612_MODEL],
]);

export * from "./holtek.js";
export * from "./m612.js";
export * from "./m724.js";
export * from "./deprecated.js";
export * from "./m690-pro.js";
