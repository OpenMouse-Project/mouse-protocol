import type { AtkSensor } from "@openmouse/protocol/atk";
import {
  atkDeviceForHid,
  type AtkCatalogSensor,
  type AtkDeviceDescriptor,
} from "./device-catalog.generated.ts";

export interface AtkProduct {
  brand: "ATK" | "VXE";
  model: string;
  sensor: AtkSensor;
  family?: "r1";
  /** Polling ceiling the mouse reports for itself, below its transport's. */
  maxPollingHz?: number;
  verified: boolean;
}

/**
 * Map a catalog sensor onto the codec's supported {@link AtkSensor} union.
 * Returns null for sensors with no verified codec yet (currently PAW3320) so
 * callers fall back to the generic profile rather than a guessed one.
 */
export function atkCatalogSensorToSensor(sensor: AtkCatalogSensor | null): AtkSensor | null {
  switch (sensor) {
    case "PAW3950Ultra":
    case "PAW3950":
    case "PAW3950DM":
    case "PAW3395Ultra":
    case "PAW3395":
    case "PAW3395SE":
    case "PAW3315":
    case "PAW3311":
    case "PAW3320":
    case "CORE26K":
    case "PAW3955Master":
      return sensor;
    default:
      return null;
  }
}

/**
 * Full vendor descriptor for a connected mouse, looked up by USB id and
 * disambiguated with the runtime CID/MID when a USB id is shared. Falls back to
 * undefined for devices the vendor table does not list.
 */
export function atkCatalogDevice(
  vendorId: number,
  productId: number,
  cidMid?: string | null,
): AtkDeviceDescriptor | undefined {
  return atkDeviceForHid(vendorId, productId, cidMid);
}


/** Mouse identity returned by GetMouseCIDMID (command 0x10). */
export const ATK_PRODUCTS: Record<string, AtkProduct> = {
  "1,8": { brand: "ATK", model: "F1 Ultimate 2.0", sensor: "PAW3950Ultra", verified: true },
  "1,31": { brand: "ATK", model: "A9 Mini +", sensor: "PAW3955Master", verified: false },
  "1,52": { brand: "ATK", model: "A9 Mini +", sensor: "PAW3955Master", verified: true },
  "2,11": { brand: "VXE", model: "R1", sensor: "PAW3395", family: "r1", verified: false },
  "2,12": { brand: "VXE", model: "R1", sensor: "PAW3395", family: "r1", verified: true },
  "2,27": { brand: "VXE", model: "R1 Pro Max", sensor: "PAW3395", family: "r1", verified: true },
  "2,32": { brand: "VXE", model: "R1 SE+", sensor: "PAW3395SE", family: "r1", verified: true },
  "2,39": { brand: "ATK", model: "X1 Pro Max", sensor: "PAW3950", verified: true },
  "2,83": { brand: "ATK", model: "A9 Plus Nearlink", sensor: "PAW3395", maxPollingHz: 1000, verified: true },
};

/** Known VXE R1-family transports under COMPX's shared vendor id. */
export const ATK_COMPX_PRODUCT_IDS: readonly number[] = [0xf58a, 0xf58c, 0xf58e, 0xf58f];
