/**
 * ASUS ROG / TUF per-PID capability table.
 *
 * Every ASUS mouse from the Gladius II onward speaks the same 64-byte
 * protocol (`12 xx` reads, `51 31` settings, `51 28` lighting, `50 03` save).
 * What differs per model, and what this table records, is how many DPI stages
 * the settings block holds, the DPI step, and which optional commands exist.
 *
 * ## Provenance
 *
 * Only `verified: true` entries have been exercised on hardware by this
 * project. The rest are transcribed facts, not a tested driver:
 *
 * - G-Helper (seerge/g-helper, `app/Peripherals/Mouse/Models/*.cs`): product
 *   ids, stage counts, DPI ranges and steps, profile counts, zones, and which
 *   settings each model exposes.
 * - libratbag (`data/devices/asus-*.device`): cross-checks for the Strix
 *   Impact III and Harpe Ace.
 * - OpenRGB (`AsusAuraMouseDevices.h`): lighting zones and effect order, and
 *   the only public source for the Gladius II Core.
 *
 * The Gladius II Core has no public DPI data. Its stage count, step and ceiling
 * are taken from the TUF Gaming M5, the same generation with the same
 * 6200-DPI sensor, and profiles are held at 1 until an owner confirms more.
 *
 * ## Why an unverified entry is safe to ship
 *
 * Every setter reads the value back. A wrong stage count or step shows up as
 * a read-back mismatch, never as a silent success, and none of these commands
 * touch firmware or calibration except the lift-off write, which is only
 * enabled where G-Helper already sends it.
 *
 * ## Deliberately absent
 *
 * The ROG Omni receiver (`0x1ace`) is shared by several mice and needs a model
 * identification handshake before any of this applies.
 */

/** Effect names, spelled as the shared `MouseLightingMode` values. */
export type AsusLightingEffect = "Static" | "Breathing single" | "Cycling" | "Spectrum" | "Reactive" | "Wave";

export interface AsusMouseModel {
  name: string;
  wireless: boolean;
  /** Stages in the settings block; also shifts the rate/debounce/snap fields. */
  dpiStages: 2 | 4;
  minDpi: number;
  maxDpi: number;
  /** Wire value is `dpi / step - 1`. */
  dpiStep: 50 | 100;
  /** DPI is read from the `12 04 02` X/Y block instead of `12 04 00`. */
  dpiXY?: boolean;
  /** A DPI write carries the stage's indicator colour, so it must be resent. */
  dpiColors?: boolean;
  profiles: number;
  debounce: boolean;
  liftOff: boolean;
  battery: boolean;
  /** Zone names in wire order. */
  zones: readonly string[];
  /** Wire byte for each effect the model offers, in display order. */
  lightingModes: Readonly<Partial<Record<AsusLightingEffect, number>>>;
  /** Older firmware scales brightness 0-4, newer 0-100. */
  brightnessMax: 4 | 100;
  /** Older firmware answers `12 03 00` with every zone in one reply. */
  lightingAllZones?: boolean;
  verified: boolean;
}

const GLADIUS_II_MODES = {
  Static: 0x00,
  "Breathing single": 0x01,
  Cycling: 0x02,
  Spectrum: 0x03,
  Reactive: 0x04,
  Wave: 0x05,
} as const;

// These models put Reactive at 0x03 (G-Helper and OpenRGB agree).
const TUF_MODES = {
  Static: 0x00,
  "Breathing single": 0x01,
  Cycling: 0x02,
  Reactive: 0x03,
} as const;

const MODERN_MODES = {
  Static: 0x00,
  "Breathing single": 0x01,
  Cycling: 0x02,
  Reactive: 0x04,
} as const;

const HARPE_ACE_AIM_LAB = {
  name: "ROG Harpe Ace Aim Lab Edition",
  dpiStages: 4,
  minDpi: 50,
  maxDpi: 36_000,
  dpiStep: 50,
  dpiXY: true,
  dpiColors: true,
  profiles: 5,
  debounce: true,
  liftOff: true,
  battery: true,
  zones: ["Scroll wheel"],
  lightingModes: MODERN_MODES,
  brightnessMax: 100,
  verified: false,
} as const;

const TUF_M5 = {
  name: "TUF Gaming M5",
  wireless: false,
  dpiStages: 2,
  minDpi: 100,
  maxDpi: 6_200,
  dpiStep: 100,
  profiles: 3,
  debounce: true,
  liftOff: false,
  battery: false,
  zones: ["Logo"],
  lightingModes: TUF_MODES,
  brightnessMax: 4,
  verified: false,
} as const;

export const ASUS_MICE: ReadonlyMap<number, AsusMouseModel> = new Map<number, AsusMouseModel>([
  [0x1845, {
    name: "ROG Gladius II",
    wireless: false,
    dpiStages: 2,
    minDpi: 100,
    maxDpi: 12_000,
    dpiStep: 100,
    profiles: 3,
    debounce: true,
    liftOff: true,
    battery: false,
    zones: ["Logo", "Scroll wheel", "Underglow"],
    lightingModes: GLADIUS_II_MODES,
    brightnessMax: 4,
    lightingAllZones: true,
    verified: true,
  }],
  [0x18dd, { ...TUF_M5, name: "ROG Gladius II Core", profiles: 1, zones: ["Logo", "Scroll wheel"] }],
  [0x1898, TUF_M5],
  [0x1910, {
    name: "TUF Gaming M3",
    wireless: false,
    dpiStages: 4,
    minDpi: 100,
    maxDpi: 7_000,
    dpiStep: 100,
    profiles: 1,
    debounce: true,
    liftOff: false,
    battery: false,
    zones: ["Logo"],
    lightingModes: TUF_MODES,
    brightnessMax: 4,
    verified: false,
  }],
  [0x1a88, {
    name: "ROG Strix Impact III",
    wireless: false,
    dpiStages: 4,
    minDpi: 100,
    maxDpi: 12_000,
    dpiStep: 50,
    profiles: 3,
    debounce: false,
    liftOff: false,
    battery: false,
    zones: ["Logo", "Scroll wheel"],
    lightingModes: MODERN_MODES,
    brightnessMax: 100,
    verified: false,
  }],
  [0x1a92, { ...HARPE_ACE_AIM_LAB, wireless: false }],
  [0x1a94, { ...HARPE_ACE_AIM_LAB, wireless: true }],
]);

export const ASUS_PRODUCT_IDS: readonly number[] = [...ASUS_MICE.keys()];
