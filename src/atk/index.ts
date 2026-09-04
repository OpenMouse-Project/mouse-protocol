/**
 * Pure ATK (A9 family) and VXE R1 (Beken) codecs, unit-tested without WebHID.
 *
 * ATK shares the Endgame Gear WE framing (see endgame-gear-we.ts): feature
 * command 0x08 reads an EEPROM address, 0x07 writes one, every frame and every
 * value/checksum pair sums to 0x55. Only the DPI stage encoding differs — ATK
 * packs a mode nibble per axis so newer sensors reach 42,000 DPI.
 *
 * VXE R1 SE/SE+ ("Wireless mouse -1k dongle", 0x373b:0x1085, Beken MCU) uses
 * the same framing and the same DPI/advanced registers as the A9 family, but
 * stores the polling rate in a live-settings row at 0x0070 keyed by a selector
 * byte. The mapping below comes from the OpenVXE tracker (BuSd777/OpenVXE),
 * the only reverse-engineering project that targets this exact receiver PID.
 */

const CHECKSUM_TOTAL = 0x55;

/**
 * Per-axis mode nibble: bits 2-3 extend the value byte, bit 1 selects the
 * 50-DPI step range above 10,000, bit 0 doubles the result above 30,000.
 */
export function atkEncodeDpiAxis(dpi: number): { byte: number; nibble: number } {
  let value = dpi;
  let doubled = 0;
  if (value > 30000) {
    doubled = 1;
    value = Math.round(value / 2);
  }
  if (value <= 10000) {
    const code = Math.floor(value / 10) - 1;
    return { byte: code & 0xff, nibble: ((code >> 8) << 2) | doubled };
  }
  const code = Math.floor((value - 10050) / 50);
  return { byte: code & 0xff, nibble: ((code >> 8) << 2) | 2 | doubled };
}

export function atkDecodeDpiAxis(byte: number, nibble: number): number {
  const code = (((nibble >> 2) & 0x03) << 8) | (byte & 0xff);
  const base = (nibble & 2) !== 0 ? 10050 + code * 50 : (code + 1) * 10;
  return (nibble & 1) !== 0 ? base * 2 : base;
}

/** One DPI stage: [x, y, packed nibbles, checksum]. */
export function atkPackDpiStage(x: number, y: number): number[] {
  const encodedX = atkEncodeDpiAxis(x);
  const encodedY = atkEncodeDpiAxis(y);
  const mode = ((encodedY.nibble & 0x0f) << 4) | (encodedX.nibble & 0x0f);
  const sum = (encodedX.byte + encodedY.byte + mode) & 0xff;
  return [encodedX.byte, encodedY.byte, mode, (CHECKSUM_TOTAL - sum) & 0xff];
}

export function atkUnpackDpiStage(data: Uint8Array | readonly number[]): { x: number; y: number } | null {
  if (data.length < 4) return null;
  const sum = (data[0]! + data[1]! + data[2]! + data[3]!) & 0xff;
  if (sum !== CHECKSUM_TOTAL) return null;
  return {
    x: atkDecodeDpiAxis(data[0]!, data[2]! & 0x0f),
    y: atkDecodeDpiAxis(data[1]!, (data[2]! >> 4) & 0x0f),
  };
}

/** Register holds tenths of a millimetre offset by 6 (code 1 = 0.7 mm). */
export function atkDecodeLiftOff(code: number): number | null {
  return code ? (code + 6) / 10 : null;
}

// ── VXE R1 SE/SE+ live-settings polling ────────────────────────────────────

/**
 * Address of the R1's live-settings row. It carries several settings as
 * [selector, value, 0x00, checksum], so a write must always include the
 * selector byte. Applying an entry over the row updates that setting live
 * without rewriting the persisted EEPROM.
 */
export const ATK_VXE_R1_SETTINGS_REGISTER = 0x0070;

/** Selector for the angle-snapping flag (value 0x10 on, 0x00 off). */
export const ATK_VXE_R1_ANGLE_SELECTOR = 0x01;

/** Selector for the debounce entry (value is milliseconds, 1-20). */
export const ATK_VXE_R1_DEBOUNCE_SELECTOR = 0x02;

/** Selector for the lift-off level (value 1 low, 2 high). */
export const ATK_VXE_R1_LOD_SELECTOR = 0x03;

/** Selector for the 250/500/1000 Hz polling-rate entry. */
export const ATK_VXE_R1_POLLING_SELECTOR = 0x0b;

/** Rates the R1 SE/SE+ offers on its stock 1K receiver. */
export const ATK_VXE_R1_POLLING_RATES: readonly number[] = [250, 500, 1000];

const VXE_POLLING_CODES: ReadonlyArray<readonly [number, number]> = [
  [0x03, 250],
  [0x02, 500],
  [0x01, 1000],
];

/** Build the 4-byte live-settings row for a given selector/value pair. */
export function atkPackVxeR1LiveSetting(selector: number, value: number): number[] {
  return [selector, value, 0x00, (CHECKSUM_TOTAL - value) & 0xff];
}

/** Build the 4-byte live-settings polling row, or null for an unsupported rate. */
export function atkPackVxeR1PollingSetting(pollingRateHz: number): number[] | null {
  const rate = VXE_POLLING_CODES.find(([, hertz]) => hertz === pollingRateHz);
  if (!rate) return null;
  return atkPackVxeR1LiveSetting(ATK_VXE_R1_POLLING_SELECTOR, rate[0]);
}

/** Decode the value byte of an R1 polling row, or null if unrecognised. */
export function atkDecodeVxeR1PollingCode(code: number): number | null {
  return VXE_POLLING_CODES.find(([value]) => (value & 0xff) === (code & 0xff))?.[1] ?? null;
}

