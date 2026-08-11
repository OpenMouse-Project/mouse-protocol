/**
 * Feature 0x0007 (Device Friendly Name) — the editable name a device presents
 * to a host, distinct from the fixed 0x0005 device name.
 *
 * Read from an MX Master 4 (WPID B042): fn 0x00 answers
 * [currentLength, maxLength, ...], reporting 11 of a maximum 14 and holding
 * "MX Master 4". fn 0x01 returns the text in chunks headed by the offset that
 * was asked for, so characters begin one byte into the payload. fn 0x03 writes
 * it back in the same shape.
 */

export const LOGITECH_FRIENDLY_NAME = {
  /** getFriendlyNameLengths: [current, max]. */
  lengths: 0x00,
  /** getFriendlyName(offset): [offset, ...characters]. */
  get: 0x10,
  /** getDefaultFriendlyName(offset), same shape as get. */
  getDefault: 0x20,
  /** setFriendlyName(offset, ...characters). */
  set: 0x30,
} as const;

/**
 * A long report carries 19 bytes: three of HID++ header, then the echoed
 * offset, leaving fifteen for characters. The MX Master 4 allows fourteen, so
 * one write covers any name it accepts — but the limit is the device's, read
 * from the hardware rather than assumed, so this is the transport ceiling.
 */
export const LOGITECH_FRIENDLY_NAME_BYTES_PER_REPORT = 15;

export interface LogitechFriendlyNameLengths {
  length: number;
  maxLength: number;
}

export function decodeFriendlyNameLengths(
  payload: Uint8Array | readonly number[],
): LogitechFriendlyNameLengths | null {
  const length = payload[0];
  const maxLength = payload[1];
  if (length === undefined || maxLength === undefined || maxLength === 0) return null;
  return { length, maxLength };
}

/**
 * Characters from one chunk. The reply repeats the offset it was asked for, so
 * the text starts at payload[1]; reading from payload[0] yields the offset as
 * a stray character and shifts the whole name.
 */
export function decodeFriendlyNameChunk(
  payload: Uint8Array | readonly number[],
  remaining: number,
): number[] {
  const wanted = Math.min(LOGITECH_FRIENDLY_NAME_BYTES_PER_REPORT, Math.max(0, remaining));
  return [...payload].slice(1, 1 + wanted);
}

/** Trailing NULs are padding, not part of the name. */
export function decodeFriendlyNameText(characters: readonly number[]): string {
  return new TextDecoder().decode(new Uint8Array(characters)).replace(/\0/g, "").trim();
}

export type LogitechFriendlyNameRejection =
  | "empty"
  | "too-long"
  | "non-ascii"
  | "too-long-for-one-report";

/**
 * Why a name cannot be written, or null when it can. Names are validated
 * before any bytes go out: a device that accepts half a name and rejects the
 * rest leaves a user with neither the old one nor the new.
 */
export function rejectFriendlyName(name: string, maxLength: number): LogitechFriendlyNameRejection | null {
  const bytes = encodeFriendlyName(name);
  if (bytes.length === 0) return "empty";
  if (bytes.length > maxLength) return "too-long";
  if (bytes.length > LOGITECH_FRIENDLY_NAME_BYTES_PER_REPORT) return "too-long-for-one-report";
  // The wire carries bytes, but a name outside printable ASCII has never been
  // exercised on hardware and multi-byte characters would break the length
  // accounting the device does in characters.
  if (bytes.some((byte) => byte < 0x20 || byte > 0x7e)) return "non-ascii";
  return null;
}

export function encodeFriendlyName(name: string): number[] {
  return [...new TextEncoder().encode(name.trim())];
}

export function buildFriendlyNameWrite(name: string): number[] {
  return [0x00, ...encodeFriendlyName(name)];
}
