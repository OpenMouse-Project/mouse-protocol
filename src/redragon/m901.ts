/*
 * Redragon M901 Perdition (`04d9:fc5e`, the M901-K-2 "Perdition4" variant):
 * a Holtek RDCfg OEM mouse in the same generic family as the M612/M724.
 *
 * Read over hidraw on 2026-11-07 (see docs/redragon-m901-testing.md). The
 * settings memory and the 0xCFF DPI code table match the other Redragon
 * Holtek mice; `mouse_m908` lists 0xfc5e as a generic-protocol device and
 * `usb-mouse-config` documents the same DPI codes and addresses.
 *
 * The one observed wire difference is the read answer's byte 3:
 * `0x60 + addressHigh` here, `0x32 + addressHigh` on the M612/M724.
 *
 * The 20-slot button keymap and 7-byte per-profile effect block are captured
 * (`usb-mouse-config`'s ADR_KEYMAPS/ADR_EFFECTS), but the physical button
 * order and effect names are not verified on this unit yet, so the model
 * leaves both unset rather than writing guesses to the side panel or LEDs.
 */

import { REDRAGON_M724_DPI_LABELS, redragonM724DecodeDpi, redragonM724EncodeDpi } from "./m724.js";
import type { RedragonModel } from "./holtek.js";

export const REDRAGON_M901_PRODUCT_ID = 0xfc5e;
/** This firmware's byte-3 constant in a GET_FEATURE answer (see holtek.ts). */
export const REDRAGON_M901_REPLY_ADDRESS_BASE = 0x60;

/** Same 0xCFF table, but the range error names this mouse instead of the M724. */
export function redragonM901EncodeDpi(dpi: number) {
  const labels = REDRAGON_M724_DPI_LABELS;
  if (!Number.isInteger(dpi) || dpi < labels[0]! || dpi > labels[labels.length - 1]!) {
    throw new Error(`Redragon M901 DPI ${dpi} is outside ${labels[0]}-${labels[labels.length - 1]}.`);
  }
  return redragonM724EncodeDpi(dpi);
}

export const REDRAGON_M901_MODEL: RedragonModel = {
  model: "M901",
  productId: REDRAGON_M901_PRODUCT_ID,
  replyAddressBase: REDRAGON_M901_REPLY_ADDRESS_BASE,
  dpi: {
    labels: REDRAGON_M724_DPI_LABELS,
    step: 100,
    encode: redragonM901EncodeDpi,
    decode: redragonM724DecodeDpi,
  },
};
