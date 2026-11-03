/*
 * The first M724 driver's frame builders, kept so existing imports keep
 * working. They read `[F3 sub profile section]` where the bytes are really
 * `[F3 addrLo addrHi len]` (see `holtek.ts`); each still returns the frame
 * it always did. New code uses `redragonEncodeWrite` and the model codecs.
 */

import { REDRAGON_POLLING_CODES, REDRAGON_POLLING_RATES, redragonEncodeWrite, redragonSession } from "./holtek.js";

/** @deprecated The "section" byte is the write length; use `redragonEncodeWrite`. */
export const REDRAGON_DPI_SECTION = 0x05;
/** @deprecated The "section" byte is the write length; use `redragonEncodeWrite`. */
export const REDRAGON_POLL_SECTION = 0x06;
/** @deprecated The polling "subcommand" is address `0x32`; use `redragonPollAddress`. */
export const REDRAGON_POLL_SUB = 0x32;
/** @deprecated The "profile" byte is the address high byte; use `redragonSlotAddress`. */
export const REDRAGON_PROFILE0 = 0x00;
/** @deprecated Profile 1's stage slot addresses; use `redragonSlotAddress(0, stage)`. */
export const REDRAGON_PROFILE0_DPI_SUBCMDS = [0x44, 0x4a, 0x50, 0x56, 0x5c] as const;

/** @deprecated Approximates RDCfg's table; use `redragonM724EncodeDpi`. */
export function redragonEncodeDpiValue(dpi: number): { value: number; range: 0 | 1 } {
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 12400) {
    throw new Error(`Redragon DPI ${dpi} is outside the observed 50-12400 range.`);
  }
  const code = Math.round((dpi * 9) / 400);
  return code <= 255 ? { value: code, range: 0 } : { value: Math.round(code / 2), range: 1 };
}

/** @deprecated Approximates RDCfg's table; use `redragonM724DecodeDpi`. */
export function redragonDecodeDpiValue(value: number, range: 0 | 1): number {
  return Math.round(value * (range === 1 ? 2 : 1) * (400 / 9));
}

/** @deprecated Profile 1 only; use `redragonEncodeWrite(redragonSlotAddress(...), ...)`. */
export function redragonEncodeDpiSlot(profile: number, level: number, dpiX: number, dpiY = dpiX): Uint8Array {
  if (profile !== REDRAGON_PROFILE0) {
    throw new Error(`Redragon profile ${profile} subcommands are not decoded yet (only profile 1).`);
  }
  const address = REDRAGON_PROFILE0_DPI_SUBCMDS[level];
  if (!Number.isInteger(level) || address === undefined) throw new Error(`Redragon DPI level ${level} is out of range 0-4.`);
  const x = redragonEncodeDpiValue(dpiX);
  const y = redragonEncodeDpiValue(dpiY);
  return redragonEncodeWrite(address, [0x01, x.value, x.range, y.value, y.range]);
}

/** @deprecated Also sets profiles 2-3 to 1000 Hz; use `redragonPollAddress`. */
export function redragonEncodePollingRate(hz: number): Uint8Array {
  const code = REDRAGON_POLLING_CODES[hz];
  if (code === undefined) {
    throw new Error(`Redragon polling rate ${hz} Hz was never observed; supported: ${REDRAGON_POLLING_RATES.join(", ")}.`);
  }
  return redragonEncodeWrite(REDRAGON_POLL_SUB, [code, 0x00, 0x01, 0x00, 0x01, 0x00]);
}

/** @deprecated Use `redragonSession(true)`. */
export function redragonHello(): Uint8Array {
  return redragonSession(true);
}
