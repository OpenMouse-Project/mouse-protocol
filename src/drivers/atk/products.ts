import type { AtkSensor } from "@openmouse/protocol/atk";
import {
  atkDeviceForHid,
  atkDevicesForCidMid,
  atkDevicesForHid,
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
  const byUsbId = atkDeviceForHid(vendorId, productId, cidMid);
  if (byUsbId || !cidMid || atkDevicesForHid(vendorId, productId).length > 0) return byUsbId;
  // CID/MID numbering restarts per USB vendor: Compx (0x3554) "2,8" is the
  // VXE R1 Pro while ATK (0x373b) "2,8" is the VXE R1 NK, a different sensor.
  // A CID/MID-only match is trusted only within the connected vendor.
  const byCidMid = atkDevicesForCidMid(cidMid);
  return byCidMid.length === 1 && byCidMid[0]!.vendorId === vendorId ? byCidMid[0] : undefined;
}

/**
 * Sensor shared by every catalog model with this CID/MID. Receivers enumerate
 * under their own USB id, so the paired mouse is known only by CID/MID; the
 * pair is not unique, but when every model sharing it has the same sensor the
 * DPI codec is still unambiguous. A pair listed only under another USB vendor
 * is ignored, because the same pair names unrelated mice there.
 */
export function atkCatalogSensorForCidMid(cidMid: string | null, vendorId: number): AtkSensor | null {
  if (!cidMid) return null;
  const devices = atkDevicesForCidMid(cidMid);
  if (!devices.some((device) => device.vendorId === vendorId)) return null;
  const sensors = new Set(devices.map((device) => atkCatalogSensorToSensor(device.sensor)));
  const [only] = sensors;
  return sensors.size === 1 && only ? only : null;
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

/**
 * Identities that exist only under Compx's USB vendor id (0x3554), where the
 * same CID/MID means a different mouse than it does under ATK's 0x373b.
 *
 * "2,8" is the VXE R1 Pro as reported through the 0x3554:0xf58a 1K dongle
 * (firmware 1.20). ATK HUB lists the wired mouse as "2,7", one below. The
 * verified R1 ("2,12", listed "2,11") and R1 SE+ ("2,32", listed "2,31")
 * entries above sit one above their HUB listings in the same way.
 */
export const ATK_COMPX_PRODUCTS: Record<string, AtkProduct> = {
  "2,8": { brand: "VXE", model: "R1 Pro", sensor: "PAW3395", family: "r1", verified: true },
};

const COMPX_VENDOR_ID = 0x3554;

/** Hand-built identity for a CID/MID reply, scoped by the USB vendor that answered. */
export function atkProductFor(vendorId: number, cidMid: string): AtkProduct | null {
  return (vendorId === COMPX_VENDOR_ID ? ATK_COMPX_PRODUCTS[cidMid] : undefined)
    ?? ATK_PRODUCTS[cidMid]
    ?? null;
}

/** Known VXE R1-family transports under COMPX's shared vendor id. */
export const ATK_COMPX_PRODUCT_IDS: readonly number[] = [0xf58a, 0xf58c, 0xf58e, 0xf58f];
