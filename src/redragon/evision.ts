/*
 * Evision USB Gaming Mouse (`04d9:fc5e`): a Holtek RDCfg OEM sibling of the
 * Redragon M612/M724. Captured read-only over hidraw plus one idempotent
 * write on 2026-11-07 (see docs/evision-usb-gaming-mouse-testing.md).
 *
 * The wire protocol is the shared Holtek transport in `holtek.ts`: the same
 * `0xFFA0:0x01` collection, 16-byte feature report 2, five profiles, and the
 * M724's 0xCFF DPI code table. Two differences are observed:
 *
 * - a read answer's byte 3 is `0x60 + addressHigh`, not `0x32 + addressHigh`
 *   (`replyAddressBase`);
 * - the button and lighting blocks do not match the M724's layout, so those
 *   stay unexposed until they are captured rather than guessed at.
 *
 * The five factory DPI stages read as codes 11, 22, 45, 67 and 140, all
 * entries in the 0xCFF table, which is why the labels are reused here.
 */

import { REDRAGON_M724_DPI_LABELS, redragonM724DecodeDpi, redragonM724EncodeDpi } from "./m724.js";
import type { RedragonModel } from "./holtek.js";

export const EVISION_VENDOR_ID = 0x04d9; // Holtek Semiconductor
export const EVISION_PRODUCT_ID = 0xfc5e;
export const EVISION_PRODUCT_NAME = "USB Gaming Mouse";

/** Same 0xCFF table, but the range error names this mouse instead of the M724. */
export function redragonEvisionEncodeDpi(dpi: number) {
  const labels = REDRAGON_M724_DPI_LABELS;
  if (!Number.isInteger(dpi) || dpi < labels[0]! || dpi > labels[labels.length - 1]!) {
    throw new Error(`Evision DPI ${dpi} is outside ${labels[0]}-${labels[labels.length - 1]}.`);
  }
  return redragonM724EncodeDpi(dpi);
}

export const EVISION_MODEL: RedragonModel = {
  model: EVISION_PRODUCT_NAME,
  brand: "Evision",
  productId: EVISION_PRODUCT_ID,
  replyAddressBase: 0x60,
  dpi: {
    labels: REDRAGON_M724_DPI_LABELS,
    step: 100,
    encode: redragonEvisionEncodeDpi,
    decode: redragonM724DecodeDpi,
  },
};
