import type { AtkSensor } from "@openmouse/protocol/atk";

/**
 * ATK and VXE mice reached through a 2.4 GHz receiver cannot be identified by
 * their USB ids: one receiver product id is reused across models. ATK's own HUB
 * handles this by reading a CID/MID identity pair from the mouse
 * (`GetMouseCIDMID`, command 0x10) and looking the pair up in its device table.
 * This catalog is the same lookup, keyed `"<cid>,<mid>"`.
 *
 * The sensor matters beyond cosmetics: it selects the DPI encoding. Reading a
 * PAW3395 stage with the A9's PAW3950Ultra encoding reports a fifth of the real
 * value.
 */
export interface AtkProduct {
  /** VXE is ATK's sibling brand; both ship behind vendor id 0x373b. */
  brand: "ATK" | "VXE";
  model: string;
  sensor: AtkSensor;
  /**
   * Only `true` once this exact CID/MID has been read from real hardware and
   * its decoded DPI cross-checked. Sharing a sensor with a verified sibling is
   * not sufficient.
   */
  verified: boolean;
}

/**
 * Names and sensors transcribed from ATK HUB Web 3.2.21's device table, which
 * keys these entries by `mouseCidMid` with `identifyByCidMid: true`.
 *
 * Deliberately narrow: the R1 ships with at least six different sensors across
 * revisions (PAW3311, PAW3395, PAW3395SE, PAW3395Ultra, PAW3950Ultra, CORE26K),
 * and three of those use lookup-table DPI encodings this repo has not captured.
 * Only pairs whose sensor has a known encoding belong here.
 */
export const ATK_PRODUCTS: Record<string, AtkProduct> = {
  // Verified on hardware: firmware "Mouse 3.13" behind receiver 0x373b:0x1085,
  // stages read back as 800/1200/1600/3200 under the step-50 encoding.
  "2,12": { brand: "VXE", model: "R1", sensor: "PAW3395", verified: true },
  // Same entry in the vendor table, white colourway, same sensor and firmware
  // mark ("r1") — untested here.
  "2,11": { brand: "VXE", model: "R1", sensor: "PAW3395", verified: false },
};

/**
 * VXE mice also appear under COMPX's vendor id 0x3554 on their wired (and other
 * non-receiver) transports — `0x3554:0xf58f` is "Compx VXE R1", with the same
 * 0xff02 / report 0x08 command channel as the 0x373b receivers.
 *
 * Product-id gated rather than vendor-wide: 0x3554 is shared with the VGN
 * Dragonfly F2 Master+ (`0xfb56`/`0xfb57`), which has its own driver and a
 * different wire protocol. The vendor's table reuses 0xf58f across the R1, R1SE
 * and R1SE+, so the sensor still comes from the mouse's CID/MID, not this id.
 */
export const ATK_COMPX_PRODUCT_IDS: readonly number[] = [0xf58f];
