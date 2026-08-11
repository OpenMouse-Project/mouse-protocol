/**
 * Scroll-wheel features on the MX line: 0x2111 (SmartShift Enhanced),
 * 0x2121 (Hi-Res Wheel) and 0x2150 (Thumb Wheel).
 *
 * Byte layouts were established on an MX Master 4 by pressing the physical
 * wheel-mode button and diffing dumps — exactly two bytes moved — and by
 * moving Logi Options+'s own sliders and watching which value followed.
 */

export const LOGITECH_SMART_SHIFT = {
  /** getCapabilities: [?, min, max, ...] on an MX Master 4, 01 0A 4B 0E. */
  capabilities: 0x00,
  /** getRatchetControlMode: [mode, threshold, defaultThreshold]. */
  get: 0x10,
  /** setRatchetControlMode(mode, threshold, defaultThreshold). */
  set: 0x20,
} as const;

/**
 * 0x2111 byte 0 is the wheel's ratchet mode — the same thing the button behind
 * the wheel toggles, and NOT SmartShift on/off. It was first shipped labelled
 * "SmartShift / Always ratchet", which was naming a control after inferred
 * behaviour rather than demonstrated behaviour.
 */
export const LOGITECH_WHEEL_MODE = { freespin: 1, ratchet: 2 } as const;

/**
 * Byte 1 is the SmartShift threshold: 255 disables it, and a lower value
 * releases the ratchet on a gentler flick. Proven by moving the Options+
 * sensitivity slider — 9% wrote 46 and 75% wrote 15, with the mode byte stuck
 * at 2 throughout.
 */
export const LOGITECH_SMART_SHIFT_OFF = 0xff;

export const LOGITECH_HIRES_WHEEL = {
  /** getCapabilities: [multiplier, flags, ...]. */
  capabilities: 0x00,
  /** getMode / setMode, a single bitmask byte. */
  get: 0x10,
  set: 0x20,
  /** getRatchetSwitchState: byte 0 is 1 while the wheel is ratcheted. */
  ratchetState: 0x30,
} as const;

/**
 * Bits of the 0x2121 mode byte.
 *
 * NEVER set divert. It routes wheel movement to HID++ instead of ordinary HID
 * scrolling, and unless something is consuming those notifications the wheel
 * simply stops working. Writes read-modify-write a single bit and carry this
 * one through untouched.
 */
export const LOGITECH_HIRES_WHEEL_BIT = { divert: 0x01, hiRes: 0x02, invert: 0x04 } as const;

/** Byte 1 of getCapabilities; bit 3 is set when inversion is supported. */
export const LOGITECH_HIRES_WHEEL_SUPPORTS_INVERT = 0x08;

export const LOGITECH_THUMB_WHEEL = {
  /** getThumbwheelInfo: [nativeRes(2), divertedRes(2), capabilities(2), ...]. */
  info: 0x00,
  /** getThumbwheelStatus: [diverted, inverted]. */
  get: 0x10,
  /** setThumbwheelReporting(diverted, inverted). */
  set: 0x20,
} as const;

/** Bit 0 of the two-byte capability field at payload[4..5]. */
export const LOGITECH_THUMB_WHEEL_SUPPORTS_INVERT = 0x01;

export type LogitechWheelMode = "Freespin" | "Ratchet";

export interface LogitechRatchetControl {
  mode: LogitechWheelMode | null;
  threshold: number;
  defaultThreshold: number;
}

export function decodeRatchetControl(payload: Uint8Array | readonly number[]): LogitechRatchetControl | null {
  const mode = payload[0];
  const threshold = payload[1];
  if (mode === undefined || threshold === undefined) return null;
  return {
    mode: mode === LOGITECH_WHEEL_MODE.freespin
      ? "Freespin"
      : mode === LOGITECH_WHEEL_MODE.ratchet ? "Ratchet" : null,
    threshold,
    defaultThreshold: payload[2] ?? 0,
  };
}

/**
 * A 0x2111 write carries all three bytes, so each setter reads the trio first
 * and changes only its own field. A write that drops the companion silently
 * discards a setting it was never asked to touch.
 */
export function buildRatchetControlWrite(
  current: LogitechRatchetControl,
  change: { mode?: LogitechWheelMode; threshold?: number },
): number[] {
  const mode = change.mode ?? current.mode;
  const encoded = mode === "Freespin" ? LOGITECH_WHEEL_MODE.freespin : LOGITECH_WHEEL_MODE.ratchet;
  return [encoded, (change.threshold ?? current.threshold) & 0xff, current.defaultThreshold & 0xff];
}

/**
 * getCapabilities is [multiplier, flags]. Reading those two the other way
 * round yields a nonsense multiplier of 28 on a wheel whose real multiplier
 * is 15.
 */
export function decodeHiresWheelCapabilities(
  payload: Uint8Array | readonly number[],
): { multiplier: number; supportsInvert: boolean } | null {
  const multiplier = payload[0];
  const flags = payload[1];
  if (multiplier === undefined || flags === undefined) return null;
  return { multiplier, supportsInvert: (flags & LOGITECH_HIRES_WHEEL_SUPPORTS_INVERT) !== 0 };
}

export function decodeHiresWheelMode(modeByte: number): { hiRes: boolean; inverted: boolean; diverted: boolean } {
  return {
    hiRes: (modeByte & LOGITECH_HIRES_WHEEL_BIT.hiRes) !== 0,
    inverted: (modeByte & LOGITECH_HIRES_WHEEL_BIT.invert) !== 0,
    diverted: (modeByte & LOGITECH_HIRES_WHEEL_BIT.divert) !== 0,
  };
}

/** Sets one bit and carries every other through, diversion included. */
export function encodeHiresWheelMode(modeByte: number, bit: number, on: boolean): number {
  return (on ? modeByte | bit : modeByte & ~bit) & 0xff;
}

/**
 * Thumb-wheel capabilities are the TWO-byte field at payload[4..5] — an
 * MX Master 4 answers 0x0003 there and demonstrably honours inversion, which
 * reading the single byte at payload[4] would have reported as unsupported.
 */
export function decodeThumbWheelSupportsInvert(payload: Uint8Array | readonly number[]): boolean | null {
  const high = payload[4];
  const low = payload[5];
  if (high === undefined || low === undefined) return null;
  return (((high << 8) | low) & LOGITECH_THUMB_WHEEL_SUPPORTS_INVERT) !== 0;
}

export function decodeThumbWheelStatus(
  payload: Uint8Array | readonly number[],
): { diverted: boolean; inverted: boolean } | null {
  const diverted = payload[0];
  const inverted = payload[1];
  if (diverted === undefined || inverted === undefined) return null;
  return { diverted: diverted !== 0, inverted: inverted !== 0 };
}

/**
 * Logi Options+ sets the diversion bit to implement horizontal scrolling, so a
 * write that clears it takes that away. Diversion is preserved from the read.
 */
export function buildThumbWheelWrite(current: { diverted: boolean }, inverted: boolean): number[] {
  return [current.diverted ? 1 : 0, inverted ? 1 : 0];
}
