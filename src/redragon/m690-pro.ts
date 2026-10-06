import { KEY_USAGES, NUMPAD_USAGES, SHORTCUTS, keyName } from "./keys.js";

/**
 * Redragon M690 PRO ("MIRAGE PRO") wire format.
 *
 * Unlike the Holtek M612/M724 (`04d9`), the M690 PRO is a SinoWealth design
 * (`258a:002e` over the cable, `258a:002f` through its 2.4 GHz receiver),
 * configured by Redragon's OemDrv-based M690-PRO app v1.0. The framing matches
 * libratbag's `driver-sinowealth.c` (MIT): a short command on feature report 5
 * selects what feature report 8 answers or accepts, and settings travel as one
 * block that is read, modified and written back whole. The constants come
 * from USBPcap captures of that app and from its installer's `Cfg.ini` and
 * text table (see docs/redragon-m690-pro-testing.md); unknown bytes are
 * preserved, never written with guessed values.
 */

export interface RedragonM690ProProduct {
  name: string;
  connection: "Wired" | "Wireless";
  /** First command of this path's settings bank: 0x11/0x12 wired, 0x21/0x22 wireless. */
  configCommand: number;
  buttonsCommand: number;
  /** True only after the exact PID and path were exercised on hardware. */
  verified: boolean;
}

export const REDRAGON_M690_PRO_VENDOR_ID = 0x258a; // SinoWealth
export const REDRAGON_M690_PRO_WIRED_PRODUCT_ID = 0x002e;
export const REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID = 0x002f;

/**
 * The cable and the receiver each keep their own settings bank; the vendor
 * app reads and writes the bank of whichever PID it is connected to.
 *
 * Verified on mouse firmware 2.95 and 2.97 (receiver 6.05), over the cable
 * and through the receiver: in Chrome on Windows (and on macOS through the
 * receiver), every setting read, written and read back; through OpenMouse
 * Bridge on Windows, also the battery (receiver), charging status (cable)
 * and the receiver's link check, which a browser cannot read. OpenMouse's
 * hardware test passed on all four paths; its polling sampler saw dropouts
 * through Bridge, so there the rate was read back but not measured.
 */
export const REDRAGON_M690_PRO_PRODUCTS: ReadonlyMap<number, RedragonM690ProProduct> = new Map([
  [REDRAGON_M690_PRO_WIRED_PRODUCT_ID, {
    name: "M690 PRO",
    connection: "Wired",
    configCommand: 0x11,
    buttonsCommand: 0x12,
    verified: true,
  }],
  [REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID, {
    name: "M690 PRO",
    connection: "Wireless",
    configCommand: 0x21,
    buttonsCommand: 0x22,
    verified: true,
  }],
]);

export const REDRAGON_M690_PRO_PRODUCT_IDS: readonly number[] = [...REDRAGON_M690_PRO_PRODUCTS.keys()];

/** Vendor collection on USB interface 1 carrying reports 5, 7 and 8. */
export const REDRAGON_M690_PRO_USAGE_PAGE = 0xff00;
export const REDRAGON_M690_PRO_USAGE = 0x01;
/** 7-byte feature report: commands and their short answers. */
export const REDRAGON_M690_PRO_COMMAND_REPORT_ID = 5;
export const REDRAGON_M690_PRO_COMMAND_LENGTH = 8;
/** 519-byte feature report: settings and button blocks. */
export const REDRAGON_M690_PRO_BLOCK_REPORT_ID = 8;
export const REDRAGON_M690_PRO_BLOCK_LENGTH = 520;
/** 7-byte input report the mouse sends when its DPI button changes stage. */
export const REDRAGON_M690_PRO_EVENT_REPORT_ID = 7;

export const REDRAGON_M690_PRO_CMD_IDENTIFY = 0x01;
/** Receiver only: whether the mouse is linked (`[05 80 01 ..]`) or off/asleep (`[05 80 00 ..]`). */
export const REDRAGON_M690_PRO_CMD_LINK = 0x80;
/** Polled every 30 s by the vendor app: connection and battery. */
export const REDRAGON_M690_PRO_CMD_STATUS = 0x90;

/** ASCII model id the identify command answers on both firmware revisions seen (2.95, 2.97). */
export const REDRAGON_M690_PRO_DEVICE_ID = "2945";

/**
 * Byte 9 of every settings block captured (every unit and firmware
 * revision, cable and receiver banks); libratbag's layout puts the sensor
 * type there. Browsers cannot read the identify answer (see
 * `redragonM690ProIsModelBlock`), so this byte stands in for it.
 */
export const REDRAGON_M690_PRO_MODEL_BYTE = 0x13;
const OFFSET_MODEL = 0x09;

/** Bytes of each block that are meaningful, report id included; the rest of a 520-byte write is zero. */
export const REDRAGON_M690_PRO_CONFIG_LENGTH = 154;
export const REDRAGON_M690_PRO_BUTTONS_LENGTH = 88;
/** Byte [3] of a block write carries the block length minus 8 (0x92 settings, 0x50 buttons). */
const WRITE_LENGTH_OFFSET = 3;
/** The vendor app appends 0xa5 after the button block when it writes it. */
export const REDRAGON_M690_PRO_BUTTONS_TRAILER = 0xa5;

const OFFSET_POLLING = 0x0a;
const OFFSET_STAGES = 0x0b;
const OFFSET_STAGE_DPI = 0x0d;
const OFFSET_STAGE_COLORS = 0x2d;
const OFFSET_EFFECT = 0x45;
const OFFSET_STREAMING = 0x46;
const OFFSET_STEADY = 0x48;
const OFFSET_BREATHING = 0x4c;
const OFFSET_STEADY_COLORS = 0x66;

export const REDRAGON_M690_PRO_STAGE_COUNT = 5;
export const REDRAGON_M690_PRO_STEADY_COLOR_SLOTS = 7;

/**
 * The vendor app's DPI choices (its Cfg.ini `DPISET`). Each stage stores the
 * 1-based position in this list, not a DPI: 250 -> 0x01, 500 -> 0x02,
 * 3000 -> 0x0c, 8000 -> 0x18 were all captured.
 */
export const REDRAGON_M690_PRO_DPI_LABELS: readonly number[] = [
  250, 500, 800, 1000, 1200, 1500, 1750, 2000, 2250, 2400, 2750, 3000,
  3200, 3500, 3750, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000,
];

/**
 * Polling code in the low nibble of byte 0x0a, as in libratbag's map for
 * this framing. Each rate was confirmed by the mouse's report interval after
 * a write (125/250/500 from the vendor app, 1000 from this driver).
 */
export const REDRAGON_M690_PRO_POLLING_CODES: Readonly<Record<number, number>> = {
  125: 0x01,
  250: 0x02,
  500: 0x03,
  1000: 0x04,
};
export const REDRAGON_M690_PRO_POLLING_RATES = [125, 250, 500, 1000] as const;

/** Effect codes at byte 0x45, named as in the vendor app's text table. */
export const REDRAGON_M690_PRO_EFFECTS: Readonly<Record<number, string>> = {
  0x01: "Colorful Streaming",
  0x02: "Steady",
  0x03: "Breathing",
};
export const REDRAGON_M690_PRO_EFFECT_STREAMING = 0x01;
export const REDRAGON_M690_PRO_EFFECT_STEADY = 0x02;
export const REDRAGON_M690_PRO_EFFECT_BREATHING = 0x03;
/** Brightness the vendor app's slider offers (0 is dark). */
export const REDRAGON_M690_PRO_MAX_BRIGHTNESS = 4;

export interface RedragonM690ProRgb { r: number; g: number; b: number }

export interface RedragonM690ProLighting {
  effect: number;
  streaming: { brightness: number; speed: number };
  /** `slot` indexes `steadyColors`; the vendor app recolours the selected slot. */
  steady: { brightness: number; slot: number };
  breathing: { brightness: number; speed: number };
  steadyColors: RedragonM690ProRgb[];
}

export interface RedragonM690ProConfig {
  pollingHz: number | null;
  stageCount: number;
  /** 0-based. */
  activeStage: number;
  /** Bit set = stage disabled in the vendor app. */
  disabledStages: number;
  /** DPI label per stage, or null for a code outside the vendor list. */
  stages: Array<number | null>;
  stageColors: RedragonM690ProRgb[];
  lighting: RedragonM690ProLighting;
}

export interface RedragonM690ProStatus {
  wireless: boolean;
  /** Battery percent: the receiver's byte, or 100 once the cable reports the battery charged. */
  batteryPercent: number | null;
  /** Over the cable only: `01` charging, `02` charged. */
  charge: "Charging" | "Full" | null;
  raw: number;
}

/** A 7-byte command frame, report id first: `[05 cmd 00 00 00 00 00 00]`. */
export function redragonM690ProEncodeCommand(command: number): Uint8Array {
  const frame = new Uint8Array(REDRAGON_M690_PRO_COMMAND_LENGTH);
  frame[0] = REDRAGON_M690_PRO_COMMAND_REPORT_ID;
  frame[1] = command;
  return frame;
}

/** Throws unless `reply` is report 5 answering `command`. */
export function redragonM690ProCheckCommandReply(reply: Uint8Array, command: number): void {
  if (reply.length < 4 || reply[0] !== REDRAGON_M690_PRO_COMMAND_REPORT_ID || reply[1] !== command) {
    throw new Error(`The Redragon M690 PRO answered command 0x${command.toString(16)} with ${hex(reply.subarray(0, 8))}.`);
  }
}

/** `[05 01 32 39 34 35 ..]` -> "2945". */
export function redragonM690ProDecodeIdentity(reply: Uint8Array): string {
  redragonM690ProCheckCommandReply(reply, REDRAGON_M690_PRO_CMD_IDENTIFY);
  return String.fromCharCode(...reply.subarray(2, 6));
}

/** `[05 80 01 01 ..]` linked, `[05 80 00 01 ..]` mouse off or asleep. */
export function redragonM690ProDecodeLink(reply: Uint8Array): boolean {
  redragonM690ProCheckCommandReply(reply, REDRAGON_M690_PRO_CMD_LINK);
  return reply[2] === 0x01;
}

/**
 * `[05 90 11 64 ..]` through the receiver: byte 3 is the battery level,
 * 0-100 (0x64 -> 0x63 seen as it drained). The vendor app showed "80 %" for
 * 0x63 on a fully charged unit, so it displays coarser steps; the raw level
 * is reported. Over the cable byte 3 is the charge
 * state: `01` while charging, `02` once charged, when the vendor app shows
 * "100 %" and the wheel LED turns green (a mouse plugged in at full charge
 * answered `01` for about a minute, then `02`).
 */
export function redragonM690ProDecodeStatus(reply: Uint8Array): RedragonM690ProStatus {
  redragonM690ProCheckCommandReply(reply, REDRAGON_M690_PRO_CMD_STATUS);
  const wireless = (reply[2]! & 0x01) === 0x01;
  const raw = reply[3]!;
  if (wireless) return { wireless, batteryPercent: raw <= 100 ? raw : null, charge: null, raw };
  const charge = raw === 0x01 ? "Charging" : raw === 0x02 ? "Full" : null;
  return { wireless, batteryPercent: charge === "Full" ? 100 : null, charge, raw };
}

/**
 * Throws unless `block` is a report-8 answer to `command` long enough to hold
 * `length` bytes. The settings block also ends in the vendor's `a5 00` marker.
 */
export function redragonM690ProCheckBlock(block: Uint8Array, command: number, length: number): void {
  if (block.length < length || block[0] !== REDRAGON_M690_PRO_BLOCK_REPORT_ID || block[1] !== command) {
    throw new Error(`The Redragon M690 PRO answered block 0x${command.toString(16)} with ${block.length} bytes starting ${hex(block.subarray(0, 8))}.`);
  }
  if (length === REDRAGON_M690_PRO_CONFIG_LENGTH && block[length - 2] !== 0xa5) {
    throw new Error("The Redragon M690 PRO settings block lacks its a5 end marker; not using it.");
  }
}

/**
 * Whether a checked settings block (`redragonM690ProCheckBlock`) is the M690
 * PRO's. The identify command's answer is the better proof, but it arrives on
 * the 7-byte feature report 5, and the firmware STALLs a report-5 read unless
 * it asks for exactly 8 bytes; Chrome asks for the device's largest feature
 * report (520 bytes) on every read, so in a browser only report 8 answers.
 */
export function redragonM690ProIsModelBlock(block: Uint8Array): boolean {
  return block.length >= REDRAGON_M690_PRO_CONFIG_LENGTH && block[OFFSET_MODEL] === REDRAGON_M690_PRO_MODEL_BYTE;
}

function rgbAt(block: Uint8Array, offset: number): RedragonM690ProRgb {
  return { r: block[offset]!, g: block[offset + 1]!, b: block[offset + 2]! };
}

/** Decodes a settings block (report id first, at least 154 bytes). */
export function redragonM690ProDecodeConfig(block: Uint8Array): RedragonM690ProConfig {
  const pollingCode = block[OFFSET_POLLING]! & 0x0f;
  const pollingHz = REDRAGON_M690_PRO_POLLING_RATES.find((hz) => REDRAGON_M690_PRO_POLLING_CODES[hz] === pollingCode) ?? null;
  const stageCount = block[OFFSET_STAGES]! & 0x0f;
  const activeStage = (block[OFFSET_STAGES]! >> 4) - 1;
  const stages = Array.from({ length: REDRAGON_M690_PRO_STAGE_COUNT }, (_, stage) =>
    REDRAGON_M690_PRO_DPI_LABELS[block[OFFSET_STAGE_DPI + 2 * stage]! - 1] ?? null);
  const stageColors = Array.from({ length: REDRAGON_M690_PRO_STAGE_COUNT }, (_, stage) =>
    rgbAt(block, OFFSET_STAGE_COLORS + 3 * stage));
  const nibbles = (byte: number) => ({ brightness: byte >> 4, low: byte & 0x0f });
  const streaming = nibbles(block[OFFSET_STREAMING]!);
  const steady = nibbles(block[OFFSET_STEADY]!);
  const breathing = nibbles(block[OFFSET_BREATHING]!);
  return {
    pollingHz,
    stageCount,
    activeStage,
    disabledStages: block[OFFSET_STAGES + 1]!,
    stages,
    stageColors,
    lighting: {
      effect: block[OFFSET_EFFECT]!,
      streaming: { brightness: streaming.brightness, speed: streaming.low },
      steady: { brightness: steady.brightness, slot: steady.low },
      breathing: { brightness: breathing.brightness, speed: breathing.low },
      steadyColors: Array.from({ length: REDRAGON_M690_PRO_STEADY_COLOR_SLOTS }, (_, slot) =>
        rgbAt(block, OFFSET_STEADY_COLORS + 3 * slot)),
    },
  };
}

function editable(block: Uint8Array, length: number): Uint8Array {
  return Uint8Array.from(block.subarray(0, length));
}

function checkStage(stage: number): void {
  if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_M690_PRO_STAGE_COUNT) {
    throw new Error(`Redragon M690 PRO DPI stage ${stage} is outside 0-${REDRAGON_M690_PRO_STAGE_COUNT - 1}.`);
  }
}

function checkNibble(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`Redragon M690 PRO ${name} ${value} is outside 0-${max}.`);
  }
}

/** The DPI label nearest to `dpi`, as the vendor slider would land. */
export function redragonM690ProNearestDpi(dpi: number): number {
  if (!Number.isFinite(dpi)) throw new Error(`Redragon M690 PRO DPI ${dpi} is not a number.`);
  return REDRAGON_M690_PRO_DPI_LABELS.reduce((best, label) =>
    Math.abs(label - dpi) < Math.abs(best - dpi) ? label : best);
}

/** Returns a copy of `block` with the polling code replaced (flag nibble kept). */
export function redragonM690ProWithPollingRate(block: Uint8Array, hz: number): Uint8Array {
  const code = REDRAGON_M690_PRO_POLLING_CODES[hz];
  if (code === undefined) {
    throw new Error(`Redragon M690 PRO polling rate ${hz} Hz is not one of ${REDRAGON_M690_PRO_POLLING_RATES.join(", ")}.`);
  }
  const next = editable(block, REDRAGON_M690_PRO_CONFIG_LENGTH);
  next[OFFSET_POLLING] = (next[OFFSET_POLLING]! & 0xf0) | code;
  return next;
}

/** Returns a copy of `block` with one stage set to a vendor DPI label; the byte after it is kept. */
export function redragonM690ProWithStageDpi(block: Uint8Array, stage: number, dpi: number): Uint8Array {
  checkStage(stage);
  const index = REDRAGON_M690_PRO_DPI_LABELS.indexOf(dpi);
  if (index < 0) throw new Error(`Redragon M690 PRO DPI ${dpi} is not one of the vendor app's values.`);
  const next = editable(block, REDRAGON_M690_PRO_CONFIG_LENGTH);
  next[OFFSET_STAGE_DPI + 2 * stage] = index + 1;
  return next;
}

/** Returns a copy of `block` with the active stage (high nibble of 0x0b) replaced. */
export function redragonM690ProWithActiveStage(block: Uint8Array, stage: number): Uint8Array {
  checkStage(stage);
  const next = editable(block, REDRAGON_M690_PRO_CONFIG_LENGTH);
  next[OFFSET_STAGES] = ((stage + 1) << 4) | (next[OFFSET_STAGES]! & 0x0f);
  return next;
}

/** Returns a copy of `block` with one stage's indicator colour replaced. */
export function redragonM690ProWithStageColor(block: Uint8Array, stage: number, rgb: RedragonM690ProRgb): Uint8Array {
  checkStage(stage);
  const next = editable(block, REDRAGON_M690_PRO_CONFIG_LENGTH);
  next.set([rgb.r, rgb.g, rgb.b], OFFSET_STAGE_COLORS + 3 * stage);
  return next;
}

export interface RedragonM690ProLightingChange {
  effect: typeof REDRAGON_M690_PRO_EFFECT_STREAMING | typeof REDRAGON_M690_PRO_EFFECT_STEADY | typeof REDRAGON_M690_PRO_EFFECT_BREATHING;
  brightness?: number;
  speed?: number;
  /** Steady only: recolours the selected slot, as the vendor app does. */
  color?: RedragonM690ProRgb;
}

/**
 * Returns a copy of `block` with the effect selected and that effect's own
 * parameter byte updated; other effects' bytes are left as stored.
 */
export function redragonM690ProWithLighting(block: Uint8Array, change: RedragonM690ProLightingChange): Uint8Array {
  const next = editable(block, REDRAGON_M690_PRO_CONFIG_LENGTH);
  const offset = change.effect === REDRAGON_M690_PRO_EFFECT_STREAMING ? OFFSET_STREAMING
    : change.effect === REDRAGON_M690_PRO_EFFECT_STEADY ? OFFSET_STEADY
      : change.effect === REDRAGON_M690_PRO_EFFECT_BREATHING ? OFFSET_BREATHING
        : null;
  if (offset === null) throw new Error(`Redragon M690 PRO lighting effect ${change.effect} cannot be written.`);
  let brightness = next[offset]! >> 4;
  let low = next[offset]! & 0x0f;
  if (change.brightness !== undefined) {
    checkNibble("brightness", change.brightness, REDRAGON_M690_PRO_MAX_BRIGHTNESS);
    brightness = change.brightness;
  }
  if (change.speed !== undefined) {
    if (change.effect === REDRAGON_M690_PRO_EFFECT_STEADY) throw new Error("Redragon M690 PRO Steady lighting has no speed.");
    checkNibble("lighting speed", change.speed, 0x0f);
    low = change.speed;
  }
  if (change.color !== undefined) {
    if (change.effect !== REDRAGON_M690_PRO_EFFECT_STEADY) throw new Error("Only Steady lighting takes a colour on the Redragon M690 PRO.");
    if (low >= REDRAGON_M690_PRO_STEADY_COLOR_SLOTS) low = 0;
    next.set([change.color.r, change.color.g, change.color.b], OFFSET_STEADY_COLORS + 3 * low);
  }
  next[OFFSET_EFFECT] = change.effect;
  next[offset] = (brightness << 4) | low;
  return next;
}

/**
 * The 520-byte report-8 write the vendor app sends for a block: the block as
 * read (report id first), byte [3] set to its length minus 8, an optional
 * trailer byte after it, and zero padding.
 */
export function redragonM690ProEncodeBlockWrite(block: Uint8Array, length: number, trailer?: number): Uint8Array {
  if (block.length < length) throw new Error(`Redragon M690 PRO block is ${block.length} bytes; expected ${length}.`);
  const frame = new Uint8Array(REDRAGON_M690_PRO_BLOCK_LENGTH);
  frame.set(block.subarray(0, length));
  frame[WRITE_LENGTH_OFFSET] = length - 8;
  if (trailer !== undefined) frame[length] = trailer;
  return frame;
}

// ---------------------------------------------------------------------------
// Buttons: 4-byte slots from offset 8 of the button block.
// ---------------------------------------------------------------------------

/**
 * The vendor app's buttons 1-8 and the slot each one writes (Cfg.ini `Kn_1`
 * last byte; button 4 -> slot 5 was captured when a macro was assigned to it).
 * Names follow the factory function of each button.
 */
export const REDRAGON_M690_PRO_BUTTONS: ReadonlyArray<readonly [name: string, slot: number]> = [
  ["Left (1)", 1],
  ["Right (2)", 2],
  ["Wheel click (3)", 3],
  ["Forward (4)", 5],
  ["Back (5)", 4],
  ["DPI up (6)", 6],
  ["DPI down (7)", 7],
  ["Fire (8)", 8],
];

/** Consumer-control bits in the order of the mouse's own report-2 descriptor. */
const MEDIA_KEYS: ReadonlyArray<readonly [name: string, byte: number, bit: number]> = [
  ["Next track", 0, 0], ["Previous track", 0, 1], ["Stop", 0, 2], ["Play/Pause", 0, 3],
  ["Mute", 0, 4], ["Volume up", 0, 6], ["Volume down", 0, 7],
  ["Media player", 1, 0], ["File explorer", 1, 1], ["Email", 1, 4], ["Calculator", 1, 5],
  ["Web search", 2, 0], ["Web home", 2, 1], ["Web back", 2, 2], ["Web forward", 2, 3],
  ["Web stop", 2, 4], ["Web refresh", 2, 5], ["Web favorites", 2, 6],
];

/** Actions whose slot bytes were captured from the vendor app or read from factory slots. */
const FIXED_ACTIONS: ReadonlyArray<readonly [name: string, bytes: readonly number[]]> = [
  ["Left click", [0x11, 0x01, 0x00, 0x00]],
  ["Right click", [0x11, 0x02, 0x00, 0x00]],
  ["Middle click", [0x11, 0x04, 0x00, 0x00]],
  ["Back", [0x11, 0x08, 0x00, 0x00]],
  ["Forward", [0x11, 0x10, 0x00, 0x00]],
  ["DPI up", [0x41, 0x01, 0x00, 0x00]],
  ["DPI down", [0x41, 0x02, 0x00, 0x00]],
  ["Three click", [0x31, 0x01, 0x32, 0x03]],
  ["Lighting on/off", [0x50, 0x02, 0x00, 0x00]],
  ["Disabled", [0x50, 0x01, 0x00, 0x00]],
];

/**
 * Keyboard keys are `21 modifiers usage 00` with the HID modifier bits and
 * usage IDs (see ./keys.ts). Captured from the vendor app and confirmed by
 * the keyboard report the mouse sent on each press: Ctrl+Shift+R `21 03 15`,
 * Alt+A `21 04 04`, Win+W `21 08 1a`, and A, \, Delete, Up arrow, F12,
 * Numpad 5 and Backspace with no modifier.
 */
const KEY_TYPE = 0x21;
const KEYS = [...KEY_USAGES, ...NUMPAD_USAGES];
const usageOf = (key: string) => KEYS.find(([name]) => name === key)![1];
const SHORTCUT_ACTIONS: ReadonlyArray<readonly [name: string, bytes: readonly number[]]> = SHORTCUTS.map(([name, modifiers, key]) =>
  [`${name} (${keyName(modifiers, usageOf(key))})`, [KEY_TYPE, modifiers, usageOf(key), 0x00]] as const);
const KEY_ACTIONS: ReadonlyArray<readonly [name: string, bytes: readonly number[]]> = KEYS.map(([name, usage]) =>
  [`Key ${name}`, [KEY_TYPE, 0x00, usage, 0x00]] as const);

/** Every action `redragonM690ProEncodeButtonAction` accepts, in display order. */
export const REDRAGON_M690_PRO_BUTTON_OPTIONS: readonly string[] = [
  ...FIXED_ACTIONS.map(([name]) => name),
  ...MEDIA_KEYS.map(([name]) => name),
  ...SHORTCUT_ACTIONS.map(([name]) => name),
  ...KEY_ACTIONS.map(([name]) => name),
];

export function redragonM690ProEncodeButtonAction(action: string): number[] {
  const fixed = [...FIXED_ACTIONS, ...SHORTCUT_ACTIONS, ...KEY_ACTIONS].find(([name]) => name === action);
  if (fixed) return [...fixed[1]];
  const media = MEDIA_KEYS.find(([name]) => name === action);
  if (media) {
    const bytes = [0x22, 0x00, 0x00, 0x00];
    bytes[1 + media[1]] = 1 << media[2];
    return bytes;
  }
  throw new Error(`The Redragon M690 PRO has no button action "${action}".`);
}

/** Names a 4-byte slot; anything not offered (macros, keys) decodes to its raw bytes. */
export function redragonM690ProDecodeButtonAction(slot: ArrayLike<number>): string {
  const bytes = Array.from(slot).slice(0, 4);
  const fixed = [...FIXED_ACTIONS, ...SHORTCUT_ACTIONS, ...KEY_ACTIONS].find(([, value]) => value.every((byte, index) => byte === bytes[index]));
  if (fixed) return fixed[0];
  if (bytes[0] === KEY_TYPE && bytes[3] === 0x00) {
    const combination = keyName(bytes[1]!, bytes[2]!, KEYS);
    if (combination) return `Keys ${combination}`;
  }
  if (bytes[0] === 0x22) {
    const media = MEDIA_KEYS.find(([, byte, bit]) =>
      bytes.slice(1).every((value, index) => value === (index === byte ? 1 << bit : 0)));
    if (media) return media[0];
  }
  if (bytes[0] === 0x70) return `Macro ${bytes[1]}`;
  return `Custom (${hex(bytes)})`;
}

function slotOffset(slot: number): number {
  return 8 + 4 * (slot - 1);
}

/** Decodes the eight vendor-app buttons from a button block. */
export function redragonM690ProDecodeButtons(block: Uint8Array): Record<string, string> {
  return Object.fromEntries(REDRAGON_M690_PRO_BUTTONS.map(([name, slot]) =>
    [name, redragonM690ProDecodeButtonAction(block.subarray(slotOffset(slot), slotOffset(slot) + 4))]));
}

/** Returns a copy of the button block with one named button reassigned. */
export function redragonM690ProWithButtonAction(block: Uint8Array, button: string, action: string): Uint8Array {
  const entry = REDRAGON_M690_PRO_BUTTONS.find(([name]) => name === button);
  if (!entry) throw new Error(`The Redragon M690 PRO has no button named "${button}".`);
  const next = editable(block, REDRAGON_M690_PRO_BUTTONS_LENGTH);
  next.set(redragonM690ProEncodeButtonAction(action), slotOffset(entry[1]));
  return next;
}

function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
