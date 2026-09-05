import type { AtkSensor } from "@openmouse/protocol/atk";

export interface AtkProduct {
  brand: "ATK" | "VXE";
  model: string;
  sensor: AtkSensor;
  family?: "r1";
  verified: boolean;
}

/** Mouse identity returned by GetMouseCIDMID (command 0x10). */
export const ATK_PRODUCTS: Record<string, AtkProduct> = {
  "2,11": { brand: "VXE", model: "R1", sensor: "PAW3395", family: "r1", verified: false },
  "2,12": { brand: "VXE", model: "R1", sensor: "PAW3395", family: "r1", verified: true },
  "2,32": { brand: "VXE", model: "R1 SE+", sensor: "PAW3395SE", family: "r1", verified: true },
};

/** Known VXE R1 SE+ transports under COMPX's shared vendor id. */
export const ATK_COMPX_PRODUCT_IDS: readonly number[] = [0xf58e, 0xf58f];
