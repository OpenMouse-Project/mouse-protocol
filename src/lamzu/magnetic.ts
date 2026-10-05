/**
 * Magnetic button commands used by RAWM's Leviathan V4 GT. The mouse speaks the
 * same page-command framing as the Lamzu receivers; these are the extra pages
 * for trigger travel, rapid trigger, the magnetic/optical switch choice and the
 * manual calibration, read from the V4 GT's web hub.
 */
import type { CompaxRequest } from "../compx/codec.js";

export const MAGNETIC_PAGE = { device: 0x00, magnetic: 0x03 } as const;
export const MAGNETIC_SWITCH = { optical: 2, magnetic: 3 } as const;
export const MAGNETIC_TRAVEL_MAX = 10;
export const MAGNETIC_RAPID_TRIGGER_MAX_MS = 15;
/** Release travel 9 means the release follows the trigger point. */
export const MAGNETIC_RELEASE_FOLLOWS = 9;

const MOUSE = 0x02;

export const magneticRead = {
  fault: { target: MOUSE, page: MAGNETIC_PAGE.magnetic, command: 0x86, length: 6, args: [] },
  switchTypes: { target: MOUSE, page: MAGNETIC_PAGE.device, command: 0x95, length: 8, args: [] },
  eid: { target: MOUSE, page: MAGNETIC_PAGE.device, command: 0x82, length: 2, args: [] },
  travel: (profile: number, key: number): CompaxRequest =>
    ({ target: MOUSE, page: MAGNETIC_PAGE.magnetic, command: 0x85, length: 4, args: [profile, key] }),
  rapidTrigger: (profile: number, key: number): CompaxRequest =>
    ({ target: MOUSE, page: MAGNETIC_PAGE.device, command: 0x98, length: 3, args: [profile, key] }),
} as const;

export const magneticWrite = {
  switchTypes: (eid: number, left: number, right: number): CompaxRequest =>
    ({ target: MOUSE, page: MAGNETIC_PAGE.device, command: 0x15, length: 8, args: [eid & 0xff, left, right] }),
  travel: (profile: number, key: number, press: number, release: number): CompaxRequest =>
    ({ target: MOUSE, page: MAGNETIC_PAGE.magnetic, command: 0x05, length: 4, args: [profile, key, press, release] }),
  rapidTrigger: (profile: number, key: number, milliseconds: number): CompaxRequest =>
    ({ target: MOUSE, page: MAGNETIC_PAGE.device, command: 0x18, length: 3, args: [profile, key, milliseconds] }),
  /** `state` 5 asks the layout, 4 and 1 start a two or one button calibration, 5 and 3 poll it. */
  calibration: (state: number): CompaxRequest =>
    ({ target: MOUSE, page: MAGNETIC_PAGE.magnetic, command: 0x07, length: 3, args: [state] }),
} as const;

export function magneticDecodeFault(payload: Uint8Array): { calibrated: boolean; needsRecalibration: boolean } {
  return { calibrated: (payload[4] ?? 1) === 0, needsRecalibration: payload[5] === 64 };
}

export function magneticDecodeSwitchTypes(payload: Uint8Array): [number, number] {
  return [payload[1] ?? 0, payload[2] ?? 0];
}

export function magneticDecodeTravel(payload: Uint8Array): { press: number; release: number } {
  return { press: payload[2] ?? 0, release: payload[3] ?? 0 };
}

export function magneticDecodeRapidTrigger(payload: Uint8Array): number {
  return payload[2] ?? 0;
}

/** The hub's identifier for the mouse model, echoed back when the switch type is written. */
export function magneticDecodeEid(payload: Uint8Array): number {
  const low = payload[0] ?? 0;
  const high = payload[1] ?? 0;
  const value = high === 0 || high === 0xff ? low : high + (low << 8);
  return value === 0xff ? 0 : value;
}

export interface MagneticCalibrationReading {
  state: number;
  code: number;
  twoButtons: boolean;
  /** Which button the mouse is waiting on: bit 0/1 release left/right, bit 2/3 press left/right. */
  mask: number;
  left: number;
  right: number;
  /** Progress of a single-button calibration, 0 to 100. */
  progress: number;
}

export function magneticDecodeCalibration(payload: Uint8Array): MagneticCalibrationReading {
  return {
    state: payload[1] ?? 0,
    code: payload[3] ?? 0,
    twoButtons: payload[21] === 7,
    mask: payload[19] ?? 0,
    left: payload[24] ?? 0,
    right: payload[25] ?? 0,
    progress: payload[2] ?? 0,
  };
}

export const MAGNETIC_CALIBRATION_STATE = { success: 7, failed: 8, cancelled: 9 } as const;

export const MAGNETIC_CALIBRATION_STEPS: Readonly<Record<number, string>> = {
  1: "Release the left and right buttons completely",
  2: "Press and hold the left button fully",
  3: "Release the left button",
  4: "Press and hold the right button fully",
  5: "Release the right button",
  6: "Verifying and saving...",
  7: "Calibration Successful",
  8: "Calibration Failed",
  9: "Calibration Cancelled",
  10: "Press and hold both buttons fully",
  11: "Release both buttons; either can be released first",
};

export const MAGNETIC_CALIBRATION_ERRORS: Readonly<Record<number, string>> = {
  2: "Calibration timed out. Fully press and release as prompted, then recalibrate.",
  3: "Abnormal button travel. Fully press and release, then recalibrate.",
  4: "Unstable calibration data. Keep the mouse still and operate the buttons smoothly, then recalibrate.",
  8: "Calibration canceled. Previous settings restored.",
  9: "Mouse is asleep. Move it to wake it, then recalibrate.",
  10: "USB connection changed during calibration. Keep the connection unchanged, then recalibrate.",
  11: "Another magnetic switch calibration is in progress. Try again later.",
  12: "Magnetic switch signal unavailable. Check the battery and connection, then recalibrate.",
  13: "Failed to save calibration. Previous settings restored. Please recalibrate.",
  14: "Button not fully released or release positions inconsistent. Fully release both buttons, then recalibrate.",
};

/** What each button is being asked to do, from the mask the mouse reports during a two button calibration. */
export function magneticCalibrationPrompt(mask: number): string | null {
  if (!mask) return null;
  const side = (press: number, release: number): string =>
    mask & press ? "Press and hold fully" : mask & release ? "Release" : mask & 16 ? "Keep steady" : "";
  const left = side(4, 1);
  const right = side(8, 2);
  return [left && `Left: ${left}`, right && `Right: ${right}`].filter(Boolean).join("\n") || null;
}
