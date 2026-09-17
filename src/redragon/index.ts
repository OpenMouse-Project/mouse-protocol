export interface RedragonProduct {
  model: string;
  name: string;
  transport: "wired";
  /** True only after the exact PID and path were exercised on hardware. */
  verified: boolean;
  /** Onboard DPI stages (levels) the vendor app pushes as one table. */
  stages: number;
  /** Highest DPI value observed on the wire for this product. */
  maxDpi: number;
}

export const REDRAGON_VENDOR_ID = 0x04d9; // Holtek Semiconductor
export const REDRAGON_CONFIG_USAGE_PAGE = 0xffa0;
export const REDRAGON_CONFIG_USAGE = 0x01;
export const REDRAGON_REPORT_ID = 2;
export const REDRAGON_REPORT_SIZE = 16;

/** First payload byte of a config write (report id excluded). */
export const REDRAGON_CMD_WRITE = 0xf3;
/** Vendor hello, sent once per RDCfg session before any write. */
export const REDRAGON_CMD_HELLO = 0xf5;
/** Write section carrying the per-profile DPI table. */
export const REDRAGON_DPI_SECTION = 0x05;
/** Profile index byte for profile 1 (the only profile decoded so far). */
export const REDRAGON_PROFILE0 = 0x00;

/**
 * DPI-table subcommands for profile 1, levels 1-5. Other profiles use
 * different bases (0x04, 0xb4, 0x64, 0x14 + 6 per level); only profile 1 is
 * captured well enough to send.
 */
export const REDRAGON_PROFILE0_DPI_SUBCMDS = [0x44, 0x4a, 0x50, 0x56, 0x5c] as const;

export const REDRAGON_PRODUCTS: ReadonlyMap<number, RedragonProduct> = new Map([
  [0xfc7a, {
    model: "M724",
    name: "K1NG 1K",
    transport: "wired",
    verified: true,
    stages: 5,
    maxDpi: 12400,
  }],
]);

export const REDRAGON_PRODUCT_IDS: readonly number[] = [...REDRAGON_PRODUCTS.keys()];

/**
 * Wire encoding of one DPI axis, derived from a usbmon capture of RDCfg
 * pushing the table and one live 800 -> 1200 DPI edit (see
 * docs/redragon-m724-testing.md):
 *
 *   code = round(dpi * 9 / 400)          (800->18, 1200->27, 2400->54,
 *                                         3500->79, 5500->124)
 *   code > 255 wraps to a second range: flag = 1, code = round(code / 2)
 *                                         (12400->279->140)
 */
export function redragonEncodeDpiValue(dpi: number): { value: number; range: 0 | 1 } {
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 12400) {
    throw new Error(`Redragon DPI ${dpi} is outside the observed 50-12400 range.`);
  }
  let code = Math.round((dpi * 9) / 400);
  if (code <= 255) return { value: code, range: 0 };
  return { value: Math.round(code / 2), range: 1 };
}

/** Nominal DPI for a wire (value, range) pair. Quantization error is normal. */
export function redragonDecodeDpiValue(value: number, range: 0 | 1): number {
  return Math.round(value * (range === 1 ? 2 : 1) * (400 / 9));
}

/**
 * Encodes one DPI-table write as the full 16-byte feature frame, report id
 * included, byte-for-byte as RDCfg sends it:
 *
 *   [02 F3 sub profile 05 00 00 00 01 x range y range 00 00 00]
 *
 * X and Y carry the same value; the vendor app keeps the axes linked.
 */
export function redragonEncodeDpiSlot(profile: number, level: number, dpiX: number, dpiY = dpiX): Uint8Array {
  if (profile !== REDRAGON_PROFILE0) {
    throw new Error(`Redragon profile ${profile} subcommands are not decoded yet (only profile 1).`);
  }
  if (!Number.isInteger(level) || level < 0 || level >= REDRAGON_PROFILE0_DPI_SUBCMDS.length) {
    throw new Error(`Redragon DPI level ${level} is out of range 0-4.`);
  }
  const x = redragonEncodeDpiValue(dpiX);
  const y = redragonEncodeDpiValue(dpiY);
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_WRITE;
  frame[2] = REDRAGON_PROFILE0_DPI_SUBCMDS[level]!;
  frame[3] = profile;
  frame[4] = REDRAGON_DPI_SECTION;
  frame[8] = 0x01;
  frame[9] = x.value;
  frame[10] = x.range;
  frame[11] = y.value;
  frame[12] = y.range;
  return frame;
}

/** First payload byte of a commit write (report id excluded). */
export const REDRAGON_CMD_COMMIT = 0xf1;
/** Write section carrying the polling rate. */
export const REDRAGON_POLL_SECTION = 0x06;
/** Polling-rate subcommand. */
export const REDRAGON_POLL_SUB = 0x32;
/** Polling rates observed on the wire. */
export const REDRAGON_POLLING_RATES = [125, 250, 500, 1000] as const;

/** Wire code per polling rate: rate = 1000 / code (bisected live). */
export const REDRAGON_POLLING_CODES: Readonly<Record<number, number>> = {
  1000: 0x01,
  500: 0x02,
  250: 0x04,
  125: 0x08,
};
/** Write section of the commit block (meaning of the codes is unknown). */
export const REDRAGON_COMMIT_SECTION = 0x02;
/**
 * Commit codes closing every vendor session, in order. Bisected live on
 * hardware: without them a DPI write is stored but only takes effect at
 * boot; with them it applies instantly. Per-code semantics unknown.
 */
export const REDRAGON_COMMIT_CODES = [0x04, 0x01, 0x02, 0x08, 0x10] as const;

/** Vendor hello frame, sent once after connect before the first write. */
export function redragonHello(): Uint8Array {
  return redragonSession(true);
}

/**
 * Session bracket frames. Every RDCfg session opens with `[02 F5 00 ...]`
 * and closes with `[02 F5 01 ...]`; a session left open hangs the mouse
 * interface until replug, so every write must be followed by the close.
 */
export function redragonSession(begin: boolean): Uint8Array {
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_HELLO;
  frame[2] = begin ? 0x00 : 0x01;
  return frame;
}

/** One commit-block write (full frame, report id included). */
export function redragonEncodeCommit(code: number): Uint8Array {
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_COMMIT;
  frame[2] = REDRAGON_COMMIT_SECTION;
  frame[3] = code;
  return frame;
}

/**
 * Polling-rate write (full frame, report id included), byte-for-byte as
 * RDCfg sends it: `[02 F3 32 00 06 00 00 00 RR 00 01 00 01 00 00 00]`
 * with `RR = 1000 / Hz` (captured across 4 sessions and bisected live:
 * 1000->0x01, 500->0x02, 250->0x04, 125->0x08).
 */
export function redragonEncodePollingRate(hz: number): Uint8Array {
  const code = REDRAGON_POLLING_CODES[hz];
  if (code === undefined) {
    throw new Error(`Redragon polling rate ${hz} Hz was never observed; supported: ${REDRAGON_POLLING_RATES.join(", ")}.`);
  }
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_WRITE;
  frame[2] = REDRAGON_POLL_SUB;
  frame[3] = REDRAGON_PROFILE0;
  frame[4] = REDRAGON_POLL_SECTION;
  frame[8] = code;
  frame[10] = 0x01;
  frame[12] = 0x01;
  return frame;
}
