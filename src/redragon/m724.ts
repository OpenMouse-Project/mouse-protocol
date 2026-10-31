/*
 * Redragon K1NG 1K (M724, `04d9:fc7a`). Codecs from static analysis of
 * RDCfg.exe (sha256 ddfab882...7294): the M724 is RDCfg model 0xCFF
 * (`Default.bin` Name1 ^ Name2) with `Light=0`. Every value below was
 * confirmed on hardware over hidraw (see docs/redragon-m724-testing.md).
 */

import { REDRAGON_M612_BUTTON_ACTIONS } from "./m612.js";
import { REDRAGON_SINGLE_KEY_ACTION, redragonButtonCodec, redragonNearestDpiPosition, type RedragonDpiCode, type RedragonModel } from "./holtek.js";

export const REDRAGON_M724_PRODUCT_ID = 0xfc7a;

/**
 * Wire code for `100 * (i + 2)` DPI, i = 0..60 (200-6200 DPI), from RDCfg's
 * 0xCFF table at `0x49f13c`. Range 1 doubles the step: 6400-12400 DPI reuse
 * the code of half their value (12400 -> code of 6200 = 140, range 1).
 */
const M724_CODES = [
  4, 6, 9, 11, 13, 15, 18, 20, 22, 24, 27, 29, 31, 33, 36, 38, 40, 43, 45, 47,
  49, 52, 54, 56, 58, 61, 63, 65, 67, 70, 72, 74, 77, 79, 81, 83, 86, 88, 90, 92,
  95, 97, 99, 102, 104, 106, 108, 111, 113, 115, 117, 120, 122, 124, 127, 129, 131, 133, 135, 138,
  140,
] as const;

/**
 * RDCfg's slider labels for model 0xCFF (`FUN_004237a0`, positions 1-92):
 * 200-6200 in steps of 100, then 6400-12400 in steps of 200.
 */
export const REDRAGON_M724_DPI_LABELS: readonly number[] = [
  ...M724_CODES.map((_, index) => (index + 2) * 100),
  ...Array.from({ length: 31 }, (_, index) => 6400 + index * 200),
];

/** Snaps to the nearest RDCfg label and returns it with its wire code. */
export function redragonM724EncodeDpi(dpi: number): RedragonDpiCode & { dpi: number } {
  const label = REDRAGON_M724_DPI_LABELS[redragonNearestDpiPosition(REDRAGON_M724_DPI_LABELS, dpi, "M724")]!;
  return label <= 6200
    ? { dpi: label, value: M724_CODES[label / 100 - 2]!, range: 0 }
    : { dpi: label, value: M724_CODES[label / 200 - 2]!, range: 1 };
}

/** DPI for a wire code; codes RDCfg never writes fall back to the sensor's 400/9 DPI per count. */
export function redragonM724DecodeDpi(value: number, range: number): number {
  const scale = range === 1 ? 2 : 1;
  const index = M724_CODES.indexOf(value as (typeof M724_CODES)[number]);
  if (index >= 0) return (index + 2) * 100 * scale;
  return Math.round((value * scale * 400) / 9 / 10) * 10;
}

/**
 * Lighting is per profile: an 8-byte block at `0x448 + 8p`,
 * `[flag, R, G, B, mode, speed, kind, brightness]` (RDCfg's `Light=0` path
 * writes bytes 1-7; the flag byte is kept as read).
 */
export const REDRAGON_M724_LIGHTING_BASE = 0x0448;
export const REDRAGON_M724_LIGHTING_BLOCK_LENGTH = 8;

export interface RedragonM724EffectInfo {
  /** OpenMouse name for RDCfg's effect. */
  name: "Static" | "Breathing single" | "Breathing random" | "Spectrum" | "Wave" | "Single Flash" | "Off";
  mode: number;
  kind: number;
  color: boolean;
  speed: boolean;
}

/**
 * RDCfg's effects for `Light=0` (`FUN_004495e0`): FULL LIGHTED, BREATHING,
 * 7 COLOR BREATHING, RAINBOW, WAVE, FLASH, and OFF.
 */
export const REDRAGON_M724_EFFECTS: readonly RedragonM724EffectInfo[] = [
  { name: "Static", mode: 1, kind: 1, color: true, speed: false },
  { name: "Breathing single", mode: 2, kind: 1, color: true, speed: true },
  { name: "Breathing random", mode: 2, kind: 3, color: false, speed: true },
  { name: "Spectrum", mode: 3, kind: 1, color: false, speed: true },
  { name: "Wave", mode: 5, kind: 1, color: false, speed: true },
  { name: "Single Flash", mode: 4, kind: 1, color: true, speed: true },
  { name: "Off", mode: 0, kind: 0, color: false, speed: false },
];

/** Address of profile p's 8-byte lighting block. */
export function redragonM724LightingAddress(profile: number): number {
  if (!Number.isInteger(profile) || profile < 0 || profile > 4) throw new Error(`Redragon M724 profile ${profile} is outside 0-4.`);
  return REDRAGON_M724_LIGHTING_BASE + REDRAGON_M724_LIGHTING_BLOCK_LENGTH * profile;
}

/** The effect a block shows: breathing is told apart by its kind byte. */
export function redragonM724EffectForBlock(block: ArrayLike<number>): RedragonM724EffectInfo | undefined {
  const mode = block[4];
  return REDRAGON_M724_EFFECTS.find((info) => info.mode === mode && (mode !== 2 || info.kind === block[6]));
}

/** Lift-off `[level, 00]`: 0 low (factory), 1 medium, 2 high. RDCfg hides it for the M724, the mouse honours it. */
export const REDRAGON_M724_LIFT_OFF_ADDRESS = 0x002a;

/**
 * The M612's actions with the M724's lighting cycle (`9b 04` under
 * `Light=0`, captured from an RDCfg Apply) and RDCfg's media keys
 * (`8e 01 usage`, consumer page).
 */
export const REDRAGON_M724_BUTTON_ACTIONS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ...REDRAGON_M612_BUTTON_ACTIONS.map(([name, bytes]): readonly [string, readonly number[]] =>
    name === "Lighting effect cycle" ? [name, [0x9b, 0x04]] : [name, bytes]),
  ["Play/Pause", [0x8e, 0x01, 0xcd]],
  ["Stop", [0x8e, 0x01, 0xb7]],
  ["Previous track", [0x8e, 0x01, 0xb6]],
  ["Next track", [0x8e, 0x01, 0xb5]],
  ["Volume up", [0x8e, 0x01, 0xe9]],
  ["Volume down", [0x8e, 0x01, 0xea]],
  ["Mute", [0x8e, 0x01, 0xe2]],
];

export const REDRAGON_M724_MODEL: RedragonModel = {
  model: "M724",
  productId: REDRAGON_M724_PRODUCT_ID,
  dpi: { labels: REDRAGON_M724_DPI_LABELS, step: 100, encode: redragonM724EncodeDpi, decode: redragonM724DecodeDpi },
  buttons: {
    // Slots 0-6 hold the factory left, right, middle, forward, back, DPI
    // cycle and profile cycle; RDCfg writes the wheel to slots 10-11.
    names: ["Left", "Right", "Wheel click", "Side front", "Side rear", "DPI button", "Profile button", "Wheel up", "Wheel down"],
    offsets: [0x00, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x28, 0x2c],
    // Plain keys as RDCfg's SINGLE KEY writes them, tested on hardware.
    ...redragonButtonCodec("M724", REDRAGON_M724_BUTTON_ACTIONS, [REDRAGON_SINGLE_KEY_ACTION, 0x00]),
  },
  lighting: "profile",
  liftOffAddress: REDRAGON_M724_LIFT_OFF_ADDRESS,
};
