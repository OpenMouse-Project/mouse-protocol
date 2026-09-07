import type { AtkSensor } from "@openmouse/protocol/atk";

export interface AtkProduct {
  brand: "ATK" | "VXE";
  model: string;
  sensor: AtkSensor;
  family?: "r1";
  verified: boolean;
}

/**
 * Mouse identity returned by GetMouseCIDMID (command 0x10).
 *
 * Keys are the `cid,mid` pair. ATK's own web configurator carries the same
 * pair per model as `custom.mouseCidMid`, alongside the sensor; the three VXE
 * entries below were transcribed from hardware and agree with that table
 * exactly, which is why it is treated as a usable source for identities that
 * have not been read off a mouse yet. Such entries stay `verified: false`.
 */
export const ATK_PRODUCTS: Record<string, AtkProduct> = {
  /**
   * ATK F1 Ultimate 2.0, retailed as the "F1 V2 Ultimate". Ships on the 8K
   * receiver 0x373b:0x11d9, whose USB product string ("Wireless mouse 8k
   * dongle-L") is a generic dongle SKU shared with 0x373b:0x1278 — the
   * identity is the only thing that names the mouse. Identity and sensor are
   * declared by ATK's configurator against mouse PID 0x373b:0x11e4; not yet
   * read back from hardware, so the DPI range is unchanged by this entry
   * (PAW3950Ultra spans 10-42,000, the same as the unidentified fallback).
   */
  "1,8": { brand: "ATK", model: "F1 Ultimate 2.0", sensor: "PAW3950Ultra", verified: false },
  "2,11": { brand: "VXE", model: "R1", sensor: "PAW3395", family: "r1", verified: false },
  "2,12": { brand: "VXE", model: "R1", sensor: "PAW3395", family: "r1", verified: true },
  "2,32": { brand: "VXE", model: "R1 SE+", sensor: "PAW3395SE", family: "r1", verified: true },
};

/** Known VXE R1 SE+ transports under COMPX's shared vendor id. */
export const ATK_COMPX_PRODUCT_IDS: readonly number[] = [0xf58e, 0xf58f];
