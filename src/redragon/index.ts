import { KEY_USAGES, SHORTCUTS, keyName } from "./keys.js";

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

/*
 * Predator M612 (`04d9:fc61`), captured with usbmon while RDCfg 1.0.58 ran
 * under Wine, then probed with hidraw (see docs/redragon-m612-testing.md).
 *
 * The M612 shares the M724 transport (feature report 2, `F5` bracket, `F1`
 * commit block) but its bytes are best read as a flat settings memory:
 * `[02 F3 addrLo addrHi len 00 00 00 data...]` writes `len` bytes at
 * `addr`. Unlike the M724, it also answers reads: `[02 F2 addrLo addrHi len]`
 * followed by a GET_FEATURE returns `[02 08 addrLo 32+addrHi len 00 FA FA
 * data...]`, at most 8 data bytes per read.
 */

export const REDRAGON_M612_PRODUCT_ID = 0xfc61;
/** First payload byte of a settings read (report id excluded). */
export const REDRAGON_CMD_READ = 0xf2;
/** First payload byte of every GET_FEATURE answer (report id excluded). */
export const REDRAGON_REPLY_TAG = 0x08;
/** Length of the answer header before the data bytes (report id excluded). */
export const REDRAGON_REPLY_HEADER = 7;
/** Most data bytes one read or write frame carries. */
export const REDRAGON_MAX_TRANSFER = 8;

/** Active onboard profile, 0-4. */
export const REDRAGON_M612_ACTIVE_PROFILE_ADDRESS = 0x002c;
/** Polling block: `[1000 / Hz, 00, 02, 00, 02, 00]` (last four constant). */
export const REDRAGON_M612_POLL_ADDRESS = 0x0032;
export const REDRAGON_M612_POLL_LENGTH = 6;
/**
 * Per-profile block bases. `base + 0` is the active DPI stage (0-4, moved
 * by the DPI button); stage slot `n` is the 5 bytes at `base + 2 + 6n`:
 * `[enabled, x, xRange, y, yRange]`.
 */
export const REDRAGON_M612_PROFILE_BASES = [0x0042, 0x0102, 0x01b2, 0x0262, 0x0312] as const;
export const REDRAGON_M612_STAGE_COUNT = 5;
export const REDRAGON_M612_SLOT_LENGTH = 5;

/**
 * DPI labels RDCfg shows for each position of its DPI slider, read from the
 * running vendor app and cross-checked by matching its bitmap-font glyphs.
 * Position `p` 0-92 writes `value = 14 + p, range 0`; 93-145 write
 * `value = p - 39, range 1` (range 1 doubles the step). The rule was
 * confirmed by Apply captures at positions 0-6, 93, 94, 120, 144, and 145,
 * and by the factory push (13, 39, 65, 92). The labels are the vendor's
 * rounded values, so they are the DPI OpenMouse shows for the same bytes.
 */
export const REDRAGON_M612_DPI_LABELS: readonly number[] = [
  500, 570, 600, 640, 680, 700, 760, 800,
  830, 870, 900, 950, 980, 1000, 1060, 1100,
  1140, 1170, 1200, 1250, 1300, 1330, 1360, 1400,
  1440, 1480, 1500, 1550, 1600, 1630, 1670, 1700,
  1740, 1780, 1800, 1860, 1900, 1930, 1970, 2000,
  2050, 2090, 2100, 2160, 2200, 2240, 2280, 2300,
  2350, 2400, 2430, 2470, 2500, 2540, 2580, 2600,
  2660, 2700, 2730, 2770, 2800, 2850, 2880, 2900,
  2960, 3000, 3040, 3070, 3100, 3150, 3200, 3230,
  3260, 3300, 3340, 3380, 3400, 3450, 3500, 3530,
  3570, 3600, 3640, 3680, 3700, 3760, 3800, 3830,
  3870, 3900, 3950, 3990, 4000, 4100, 4180, 4250,
  4330, 4400, 4480, 4560, 4630, 4700, 4780, 4860,
  4940, 5000, 5100, 5160, 5240, 5300, 5400, 5470,
  5540, 5600, 5700, 5770, 5850, 5900, 6000, 6080,
  6150, 6230, 6300, 6380, 6460, 6530, 6600, 6680,
  6760, 6840, 6900, 7000, 7060, 7140, 7200, 7300,
  7370, 7440, 7500, 7600, 7670, 7750, 7800, 7900,
  7980, 8000,
];

/** Slider position where RDCfg switches to range 1. */
const M612_RANGE1_FIRST_POSITION = 93;

export interface RedragonDpiCode {
  value: number;
  range: 0 | 1;
}

/** Wire code for one RDCfg slider position. */
export function redragonM612DpiCodeAt(position: number): RedragonDpiCode {
  if (!Number.isInteger(position) || position < 0 || position >= REDRAGON_M612_DPI_LABELS.length) {
    throw new Error(`Redragon M612 DPI position ${position} is outside 0-${REDRAGON_M612_DPI_LABELS.length - 1}.`);
  }
  return position < M612_RANGE1_FIRST_POSITION
    ? { value: 14 + position, range: 0 }
    : { value: position - 39, range: 1 };
}

/**
 * Snaps a requested DPI to the nearest RDCfg slider label (ties go to the
 * lower one) and returns that label with its wire code.
 */
export function redragonM612EncodeDpi(dpi: number): RedragonDpiCode & { dpi: number } {
  const labels = REDRAGON_M612_DPI_LABELS;
  if (!Number.isInteger(dpi) || dpi < labels[0]! || dpi > labels[labels.length - 1]!) {
    throw new Error(`Redragon M612 DPI ${dpi} is outside ${labels[0]}-${labels[labels.length - 1]}.`);
  }
  let best = 0;
  for (let position = 1; position < labels.length; position++) {
    if (Math.abs(labels[position]! - dpi) < Math.abs(labels[best]! - dpi)) best = position;
  }
  return { dpi: labels[best]!, ...redragonM612DpiCodeAt(best) };
}

/**
 * DPI for a wire code. Codes RDCfg can write map to its label; anything else
 * (another tool's write) falls back to the linear sensor scale the labels
 * approximate, 4000 DPI per 106 counts, rounded to 10.
 */
export function redragonM612DecodeDpi(value: number, range: number): number {
  const position = range === 0 ? value - 14 : range === 1 ? value + 39 : -1;
  const inRange = range === 0 ? position < M612_RANGE1_FIRST_POSITION : position >= M612_RANGE1_FIRST_POSITION;
  if (inRange && position >= 0 && position < REDRAGON_M612_DPI_LABELS.length) {
    return REDRAGON_M612_DPI_LABELS[position]!;
  }
  return Math.round((value * (range === 1 ? 2 : 1) * 4000) / 106 / 10) * 10;
}

function checkTransfer(address: number, length: number): void {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new Error(`Redragon address ${address} is outside 0x0000-0xffff.`);
  }
  if (!Number.isInteger(length) || length < 1 || length > REDRAGON_MAX_TRANSFER) {
    throw new Error(`Redragon transfer length ${length} is outside 1-${REDRAGON_MAX_TRANSFER}.`);
  }
}

/** `[02 F3 addrLo addrHi len 00 00 00 data...]` (full frame, report id included). */
export function redragonEncodeWrite(address: number, data: ArrayLike<number>): Uint8Array {
  checkTransfer(address, data.length);
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_WRITE;
  frame[2] = address & 0xff;
  frame[3] = address >> 8;
  frame[4] = data.length;
  for (let index = 0; index < data.length; index++) {
    const byte = data[index]!;
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new Error(`Redragon data byte ${byte} is not a byte.`);
    frame[8 + index] = byte;
  }
  return frame;
}

/** `[02 F2 addrLo addrHi len ...]` (full frame, report id included). */
export function redragonEncodeRead(address: number, length: number): Uint8Array {
  checkTransfer(address, length);
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_READ;
  frame[2] = address & 0xff;
  frame[3] = address >> 8;
  frame[4] = length;
  return frame;
}

/**
 * Validates the GET_FEATURE answer to `redragonEncodeRead(address, length)`
 * and returns its data bytes. Accepts the answer with or without the leading
 * report id, since WebHID and hidraw differ there.
 */
export function redragonDecodeRead(answer: Uint8Array, address: number, length: number): Uint8Array {
  checkTransfer(address, length);
  const body = answer[0] === REDRAGON_REPORT_ID && answer[1] === REDRAGON_REPLY_TAG ? answer.subarray(1) : answer;
  const hex = [...answer].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  if (
    body.length < REDRAGON_REPLY_HEADER + length ||
    body[0] !== REDRAGON_REPLY_TAG ||
    body[1] !== (address & 0xff) ||
    body[2] !== 0x32 + (address >> 8) ||
    body[3] !== length ||
    body[5] !== 0xfa ||
    body[6] !== 0xfa
  ) {
    throw new Error(`Redragon read of ${length} bytes at 0x${address.toString(16).padStart(4, "0")} got an unexpected answer: ${hex}.`);
  }
  return body.slice(REDRAGON_REPLY_HEADER, REDRAGON_REPLY_HEADER + length);
}

/** Address of one M612 DPI stage slot. */
export function redragonM612SlotAddress(profile: number, stage: number): number {
  const base = REDRAGON_M612_PROFILE_BASES[profile];
  if (base === undefined) throw new Error(`Redragon M612 profile ${profile} is outside 0-4.`);
  if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_M612_STAGE_COUNT) {
    throw new Error(`Redragon M612 DPI stage ${stage} is outside 0-4.`);
  }
  return base + 2 + 6 * stage;
}

/*
 * M612 profiles, lighting, and buttons: decoded from RDCfg 1.0.58 Apply
 * captures (see docs/redragon-m612-testing.md).
 */

export const REDRAGON_M612_PROFILE_COUNT = 5;

/**
 * RDCfg's MODE select, byte-for-byte: write `[profile, 00]` at `0x2c`
 * (outside any `F5` bracket), then `F1 02 01`, then the commit block.
 */
export const REDRAGON_M612_PROFILE_SELECT_CODE = 0x01;

/** Lighting effect selector: one bit per effect, `[bit, 00]`. Global, not per profile. */
export const REDRAGON_M612_LIGHTING_EFFECT_ADDRESS = 0x0446;

export type RedragonM612Effect = "wave" | "spectrumBreathing" | "breathing" | "flash" | "static" | "off";

export interface RedragonM612EffectInfo {
  effect: RedragonM612Effect;
  /** Value at `0x446`. */
  bit: number;
  /** 8-byte parameter block `[flag, R, G, B, kind, speed, ?, brightness]`, or null for off. */
  block: number | null;
  color: boolean;
  speed: boolean;
}

/** RDCfg effects, from Apply captures of each one. */
export const REDRAGON_M612_EFFECTS: readonly RedragonM612EffectInfo[] = [
  { effect: "wave", bit: 0x01, block: 0x0448, color: false, speed: true },
  { effect: "spectrumBreathing", bit: 0x02, block: 0x0450, color: false, speed: true },
  { effect: "breathing", bit: 0x04, block: 0x0458, color: true, speed: true },
  { effect: "flash", bit: 0x08, block: 0x0460, color: true, speed: true },
  { effect: "static", bit: 0x10, block: 0x0468, color: true, speed: false },
  { effect: "off", bit: 0x20, block: null, color: false, speed: false },
];
export const REDRAGON_M612_LIGHTING_BLOCK_LENGTH = 8;
/** Speed byte: 8 is RDCfg's slowest slider position, 1 its fastest. */
export const REDRAGON_M612_LIGHTING_SPEEDS = 8;
/** Brightness byte: RDCfg's slider has three positions, 1-3. */
export const REDRAGON_M612_LIGHTING_BRIGHTNESS_LEVELS = 3;

export function redragonM612EffectForBit(bit: number): RedragonM612EffectInfo | undefined {
  return REDRAGON_M612_EFFECTS.find((info) => info.bit === bit);
}

/**
 * Button slots per profile, in RDCfg's numbering: 1 left, 2 right,
 * 3 middle, 4 rapid fire, 5-6 side, 7-8 DPI, 9 LED, then wheel up/down.
 * Four bytes each; there is no slot at `base + 0x24`.
 */
export const REDRAGON_M612_BUTTON_BASES = [0x0082, 0x0142, 0x01f2, 0x02a2, 0x0352] as const;
export const REDRAGON_M612_BUTTON_OFFSETS = [0x00, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x28, 0x2c] as const;
export const REDRAGON_M612_BUTTON_LENGTH = 4;

export function redragonM612ButtonAddress(profile: number, slot: number): number {
  const base = REDRAGON_M612_BUTTON_BASES[profile];
  const offset = REDRAGON_M612_BUTTON_OFFSETS[slot];
  if (base === undefined) throw new Error(`Redragon M612 profile ${profile} is outside 0-4.`);
  if (offset === undefined) throw new Error(`Redragon M612 button slot ${slot} is outside 0-10.`);
  return base + offset;
}

/**
 * Single-byte actions captured from RDCfg (the value is padded to four bytes
 * with zeros). "Rapid fire" is button 4's factory value; its speed and count
 * bytes are kept exactly as shipped.
 */
export const REDRAGON_M612_BUTTON_ACTIONS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["Left click", [0x81]],
  ["Right click", [0x82]],
  ["Middle click", [0x83]],
  ["Back", [0x84]],
  ["Forward", [0x85]],
  ["Scroll up", [0x8b]],
  ["Scroll down", [0x8c]],
  ["Rapid fire", [0x99, 0x81, 0x03]],
  ["DPI cycle", [0x88]],
  ["DPI up", [0x8a]],
  ["DPI down", [0x89]],
  ["Profile cycle", [0x8d]],
  ["Profile up", [0x94]],
  ["Profile down", [0x95]],
  ["Polling rate up", [0x97]],
  ["Polling rate down", [0x98]],
  ["Lighting effect cycle", [0x9b, 0x08]],
  ["Disabled", []],
];

/**
 * Keyboard assignments are `[8F, modifiers, usage]` with the HID keyboard
 * modifier bits (1 Ctrl, 2 Shift, 4 Alt, 8 Win) and usage IDs. Captured from
 * RDCfg's shortcut menus: Ctrl+V `8f 01 19`, Ctrl+A `8f 01 04`, Ctrl+F
 * `8f 01 09`, Ctrl+N `8f 01 11`, Alt+Tab `8f 04 2b`, Alt+F4 `8f 04 3d`,
 * Win+E `8f 08 08`, Win+R `8f 08 15`, Win+D `8f 08 07`, Win+L `8f 08 0f`.
 */
export const REDRAGON_M612_KEY_ACTION = 0x8f;

/** Every action name `redragonM612EncodeButtonAction` accepts, in display order. */
export const REDRAGON_M612_BUTTON_OPTIONS: readonly string[] = [
  ...REDRAGON_M612_BUTTON_ACTIONS.map(([name]) => name),
  ...SHORTCUTS.map(([name, modifiers, key]) => `${name} (${keyName(modifiers, KEY_USAGES.find(([k]) => k === key)![1])})`),
  ...KEY_USAGES.map(([name]) => `Key ${name}`),
];

/** Four-byte slot value for an action name from `REDRAGON_M612_BUTTON_OPTIONS`. */
export function redragonM612EncodeButtonAction(action: string): number[] {
  const pad = (bytes: readonly number[]) => [...bytes, 0, 0, 0, 0].slice(0, REDRAGON_M612_BUTTON_LENGTH);
  const fixed = REDRAGON_M612_BUTTON_ACTIONS.find(([name]) => name === action);
  if (fixed) return pad(fixed[1]);
  const shortcut = SHORTCUTS.find(([name, modifiers, key]) =>
    action === `${name} (${keyName(modifiers, KEY_USAGES.find(([k]) => k === key)![1])})`);
  if (shortcut) {
    return pad([REDRAGON_M612_KEY_ACTION, shortcut[1], KEY_USAGES.find(([k]) => k === shortcut[2])![1]]);
  }
  const key = action.startsWith("Key ") ? KEY_USAGES.find(([name]) => name === action.slice(4)) : undefined;
  if (key) return pad([REDRAGON_M612_KEY_ACTION, 0x00, key[1]]);
  throw new Error(`Redragon M612 button action "${action}" is not offered.`);
}

/**
 * Names a slot value: an offered action where the bytes match one exactly,
 * any other keyboard combination by its keys, and anything else (macros,
 * RDCfg's advanced actions) as its raw bytes.
 */
export function redragonM612DecodeButtonAction(value: ArrayLike<number>): string {
  const bytes = Array.from(value).slice(0, REDRAGON_M612_BUTTON_LENGTH);
  const same = (encoded: readonly number[]) => encoded.every((byte, index) => byte === (bytes[index] ?? 0));
  const named = REDRAGON_M612_BUTTON_OPTIONS.find((option) => same(redragonM612EncodeButtonAction(option)));
  if (named) return named;
  if (bytes[0] === REDRAGON_M612_KEY_ACTION && (bytes[3] ?? 0) === 0) {
    const combination = keyName(bytes[1] ?? 0, bytes[2] ?? 0);
    if (combination) return `Keys ${combination}`;
  }
  return `Vendor action (${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")})`;
}

export * from "./m690-pro.js";
