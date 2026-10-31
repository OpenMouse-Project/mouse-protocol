/*
 * Predator M612 (`04d9:fc61`), captured with usbmon while RDCfg 1.0.58 ran
 * under Wine, then probed with hidraw (see docs/redragon-m612-testing.md).
 * Transport and memory layout are in `holtek.ts`; this file holds what is
 * M612-specific: its DPI slider, buttons, and the global lighting effects.
 */

import {
  REDRAGON_ACTIVE_PROFILE_ADDRESS,
  REDRAGON_BUTTON_BASES,
  REDRAGON_KEY_ACTION,
  REDRAGON_BUTTON_LENGTH,
  REDRAGON_POLL_ADDRESS,
  REDRAGON_PROFILE_BASES,
  REDRAGON_PROFILE_COUNT,
  REDRAGON_PROFILE_SELECT_CODE,
  REDRAGON_SLOT_LENGTH,
  REDRAGON_STAGE_COUNT,
  redragonButtonCodec,
  redragonNearestDpiPosition,
  redragonSlotAddress,
  type RedragonDpiCode,
  type RedragonModel,
} from "./holtek.js";

export const REDRAGON_M612_PRODUCT_ID = 0xfc61;

export const REDRAGON_M612_ACTIVE_PROFILE_ADDRESS = REDRAGON_ACTIVE_PROFILE_ADDRESS;
/** Polling codes of profiles 1-3, as RDCfg writes them in one block. */
export const REDRAGON_M612_POLL_ADDRESS = REDRAGON_POLL_ADDRESS;
export const REDRAGON_M612_POLL_LENGTH = 6;
export const REDRAGON_M612_PROFILE_BASES = REDRAGON_PROFILE_BASES;
export const REDRAGON_M612_STAGE_COUNT = REDRAGON_STAGE_COUNT;
export const REDRAGON_M612_SLOT_LENGTH = REDRAGON_SLOT_LENGTH;
export const REDRAGON_M612_PROFILE_COUNT = REDRAGON_PROFILE_COUNT;
export const REDRAGON_M612_PROFILE_SELECT_CODE = REDRAGON_PROFILE_SELECT_CODE;
export const REDRAGON_M612_BUTTON_BASES = REDRAGON_BUTTON_BASES;
export const REDRAGON_M612_BUTTON_LENGTH = REDRAGON_BUTTON_LENGTH;
export const REDRAGON_M612_KEY_ACTION = REDRAGON_KEY_ACTION;

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
  const position = redragonNearestDpiPosition(REDRAGON_M612_DPI_LABELS, dpi, "M612");
  return { dpi: REDRAGON_M612_DPI_LABELS[position]!, ...redragonM612DpiCodeAt(position) };
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

/** Address of one M612 DPI stage slot. */
export const redragonM612SlotAddress = redragonSlotAddress;

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
export const REDRAGON_M612_BUTTON_OFFSETS = [0x00, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x28, 0x2c] as const;

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

const M612_BUTTONS = redragonButtonCodec("M612", REDRAGON_M612_BUTTON_ACTIONS);

/** Every action name `redragonM612EncodeButtonAction` accepts, in display order. */
export const REDRAGON_M612_BUTTON_OPTIONS: readonly string[] = M612_BUTTONS.options;
/** Four-byte slot value for an action name from `REDRAGON_M612_BUTTON_OPTIONS`. */
export const redragonM612EncodeButtonAction = M612_BUTTONS.encode;
export const redragonM612DecodeButtonAction = M612_BUTTONS.decode;

export const REDRAGON_M612_MODEL: RedragonModel = {
  model: "M612",
  productId: REDRAGON_M612_PRODUCT_ID,
  dpi: { labels: REDRAGON_M612_DPI_LABELS, step: 10, encode: redragonM612EncodeDpi, decode: redragonM612DecodeDpi },
  buttons: {
    // RDCfg's button numbers, named for what each one is on the mouse.
    names: [
      "Left (1)", "Right (2)", "Wheel click (3)", "Fire (4)", "Button 5", "Button 6",
      "Button 7", "Button 8", "Button 9", "Wheel up", "Wheel down",
    ],
    offsets: REDRAGON_M612_BUTTON_OFFSETS,
    ...M612_BUTTONS,
  },
  lighting: "effect",
};
