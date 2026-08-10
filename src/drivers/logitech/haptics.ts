/**
 * Feature 0x19B0 (Haptic), as implemented by the MX Master 4 (WPID B042).
 *
 * No public documentation exists for this feature. Everything here was read
 * off hardware by watching Logi Options+ talk to the mouse: a Bolt receiver
 * broadcasts replies to every open handle, and the low nibble of the function
 * byte carries the requester's software id, so the vendor application's own
 * traffic is visible alongside your own.
 *
 * The configuration is a two-byte pair behind get 0x10 / set 0x20.
 *
 * Byte 0 is a flag bitmask. Turning haptics off in Options+ cleared bit 0;
 * turning its battery-saving mode off cleared bit 1; both returned together as
 * 0x03. Ten writes for ten switch toggles, and only those two pairs moved
 * anything — Options+'s per-context switches (Actions Ring, Gestures, Switch
 * Screens) change no device byte at all, so those are decided in its software.
 * Bits 2-7 were 0 throughout and their purpose is unknown, so a write carries
 * them through rather than clearing them.
 *
 * Byte 1 is the strength. Options+'s four presets write exactly the values in
 * LOGITECH_HAPTIC_PRESETS, and capability byte 3 reports 60 as the device
 * default, matching its Medium.
 */

export const LOGITECH_HAPTIC = {
  /** getCapabilities: [?, ?, ?, defaultIntensity, defaultEffect, ...]. */
  capabilities: 0x00,
  get: 0x10,
  set: 0x20,
  /** Fires the motor once. Nothing is persisted. */
  play: 0x40,
} as const;

/**
 * Options+'s Subtle / Low / Medium / High, captured from its writes. The
 * device takes any byte in range, so these are the vendor's choices rather
 * than a device-imposed set.
 */
export const LOGITECH_HAPTIC_PRESETS = {
  Subtle: 25,
  Low: 45,
  Medium: 60,
  High: 100,
} as const;

export type LogitechHapticPreset = keyof typeof LOGITECH_HAPTIC_PRESETS;

/** The largest value any preset uses; nothing above it has been exercised. */
export const LOGITECH_HAPTIC_INTENSITY_MAX = LOGITECH_HAPTIC_PRESETS.High;

export const LOGITECH_HAPTIC_FLAG = {
  enabled: 0x01,
  batterySaving: 0x02,
} as const;

export type LogitechHapticFlag = keyof typeof LOGITECH_HAPTIC_FLAG;

/**
 * Effect ids the MX Master 4 accepts; every other id up to 0x3F answers
 * INVALID_ARGUMENT. Sixteen ids but thirteen distinct sensations by hand:
 * 0x00 and 0x01 are indistinguishable, as are 0x02, 0x03 and 0x04. 0x1B sits
 * apart from the contiguous block and feels like a lighter variant of another
 * effect, which one is unconfirmed.
 */
export const LOGITECH_HAPTIC_EFFECT_IDS: readonly number[] = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x1b,
];

/**
 * The effects Options+ plays for each action, captured from its traffic: 0x08
 * straight after every strength write, 0x00 after re-enabling haptics.
 */
export const LOGITECH_HAPTIC_EFFECTS = {
  strengthSample: 0x08,
  enableConfirmation: 0x00,
} as const;

export interface LogitechHapticConfig {
  enabled: boolean;
  batterySaving: boolean;
  intensity: number;
  /** Byte 0 as read, so a later write can carry its unknown bits through. */
  flagByte: number;
}

export function decodeHapticConfig(payload: Uint8Array | readonly number[]): LogitechHapticConfig | null {
  const flagByte = payload[0];
  const intensity = payload[1];
  if (flagByte === undefined || intensity === undefined) return null;
  return {
    enabled: (flagByte & LOGITECH_HAPTIC_FLAG.enabled) !== 0,
    batterySaving: (flagByte & LOGITECH_HAPTIC_FLAG.batterySaving) !== 0,
    intensity,
    flagByte,
  };
}

/** Sets or clears one flag, leaving every other bit of the byte alone. */
export function encodeHapticFlags(flagByte: number, flag: LogitechHapticFlag, on: boolean): number {
  const mask = LOGITECH_HAPTIC_FLAG[flag];
  return on ? flagByte | mask : flagByte & ~mask;
}

/**
 * A write carries both bytes, so a caller changing one field must supply the
 * other as the device currently reports it. Passing a stale or invented flag
 * byte silently discards whatever bits 2-7 hold.
 */
export function buildHapticConfigWrite(flagByte: number, intensity: number): number[] {
  return [flagByte & 0xff, intensity & 0xff];
}

export function isLogitechHapticIntensity(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= LOGITECH_HAPTIC_INTENSITY_MAX;
}

export function isLogitechHapticEffect(effect: number): boolean {
  return LOGITECH_HAPTIC_EFFECT_IDS.includes(effect);
}

/**
 * Byte 1 of a play reply reports that the motor was already running, not
 * anything about the effect. Proven by playing one short effect from idle and
 * again on the heels of the longest effect in the set: the same id answered 0
 * three times and then 1 three times.
 */
export function decodeHapticPlayReply(
  payload: Uint8Array | readonly number[],
): { effect: number; motorWasBusy: boolean } | null {
  const effect = payload[0];
  const busy = payload[1];
  if (effect === undefined || busy === undefined) return null;
  return { effect, motorWasBusy: busy !== 0 };
}

/** Capability byte 3 is the factory strength; the MX Master 4 reports 60. */
export function decodeHapticDefaultIntensity(payload: Uint8Array | readonly number[]): number | null {
  return payload[3] ?? null;
}
