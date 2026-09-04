/**
 * Pure ATK (A9 family) DPI codec, unit-tested without WebHID.
 *
 * ATK shares the Endgame Gear WE framing (see endgame-gear-we.ts): feature
 * command 0x08 reads an EEPROM address, 0x07 writes one, every frame and every
 * value/checksum pair sums to 0x55. Only the DPI stage encoding differs — ATK
 * packs a mode nibble per axis so newer sensors reach 42,000 DPI.
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

/**
 * Sensor families behind vendor id 0x373b, named as ATK's own HUB bundle names
 * them. The A9-era `atkEncodeDpiAxis` above is only correct for PAW3950Ultra;
 * the PAW3395/PAW3950 family packs a plain 10-bit count of 50-DPI steps, so a
 * stage read with the wrong family is wrong by a factor of five. Which family a
 * mouse belongs to is not derivable from the USB ids — a receiver's product id
 * is shared across models — so it comes from the CID/MID identity the mouse
 * reports (see drivers/atk/products.ts).
 */
export type AtkSensor =
  | "PAW3950Ultra"
  | "PAW3950"
  | "PAW3950DM"
  | "PAW3395Ultra"
  | "PAW3395"
  | "CORE26K";

/** How a sensor packs DPI: `ultra` is the segmented A9 encoding, `step50` the 50-DPI count. */
export type AtkDpiFamily = "ultra" | "step50";

export interface AtkSensorProfile {
  family: AtkDpiFamily;
  /** Limits the vendor's HUB enforces for this sensor. */
  minDpi: number;
  maxDpi: number;
  stepDpi: number;
}

/**
 * Transcribed from the DPI limit table in ATK HUB Web 3.2.21. Sensors whose
 * encoding is a lookup table rather than a formula (PAW3395SE, PAW3315,
 * PAW3311, PAW3320) are deliberately absent: their tables have not been
 * captured here, and a guessed step would silently misreport DPI.
 */
export const ATK_SENSORS: Record<AtkSensor, AtkSensorProfile> = {
  PAW3950Ultra: { family: "ultra", minDpi: 10, maxDpi: 42000, stepDpi: 10 },
  PAW3950: { family: "step50", minDpi: 50, maxDpi: 36000, stepDpi: 50 },
  PAW3950DM: { family: "step50", minDpi: 50, maxDpi: 36000, stepDpi: 50 },
  PAW3395Ultra: { family: "step50", minDpi: 100, maxDpi: 30000, stepDpi: 50 },
  PAW3395: { family: "step50", minDpi: 100, maxDpi: 30000, stepDpi: 50 },
  CORE26K: { family: "step50", minDpi: 50, maxDpi: 26000, stepDpi: 50 },
};

/** Above this the step doubles to 100 DPI and the per-axis double bit is set. */
const STEP50_DOUBLE_ABOVE = 30000;

/** `step50` axis: a 10-bit count of 50-DPI steps, optionally doubled. */
export function atkDecodeDpiAxisStep50(byte: number, nibble: number): number {
  const count = (byte & 0xff) | (((nibble >> 2) & 0x03) << 8);
  const dpi = (count + 1) * 50;
  return (nibble & 1) !== 0 ? dpi * 2 : dpi;
}

export function atkEncodeDpiAxisStep50(dpi: number): { byte: number; nibble: number } {
  const doubled = dpi > STEP50_DOUBLE_ABOVE;
  const count = Math.round(dpi / (doubled ? 100 : 50)) - 1;
  return { byte: count & 0xff, nibble: (((count >> 8) & 0x03) << 2) | (doubled ? 1 : 0) };
}

function axisCodec(sensor: AtkSensor | null): {
  decode: (byte: number, nibble: number) => number;
  encode: (dpi: number) => { byte: number; nibble: number };
} {
  // An unidentified mouse keeps the historical A9 behaviour rather than
  // silently switching encoding, matching the vendor HUB's own fallback.
  return (sensor !== null && ATK_SENSORS[sensor]?.family === "step50")
    ? { decode: atkDecodeDpiAxisStep50, encode: atkEncodeDpiAxisStep50 }
    : { decode: atkDecodeDpiAxis, encode: atkEncodeDpiAxis };
}

export function atkPackDpiStageForSensor(sensor: AtkSensor | null, x: number, y: number): number[] {
  const { encode } = axisCodec(sensor);
  const encodedX = encode(x);
  const encodedY = encode(y);
  const mode = ((encodedY.nibble & 0x0f) << 4) | (encodedX.nibble & 0x0f);
  const sum = (encodedX.byte + encodedY.byte + mode) & 0xff;
  return [encodedX.byte, encodedY.byte, mode, (CHECKSUM_TOTAL - sum) & 0xff];
}

export function atkUnpackDpiStageForSensor(
  sensor: AtkSensor | null,
  data: Uint8Array | readonly number[],
): { x: number; y: number } | null {
  if (data.length < 4) return null;
  const sum = (data[0]! + data[1]! + data[2]! + data[3]!) & 0xff;
  if (sum !== CHECKSUM_TOTAL) return null;
  const { decode } = axisCodec(sensor);
  return {
    x: decode(data[0]!, data[2]! & 0x0f),
    y: decode(data[1]!, (data[2]! >> 4) & 0x0f),
  };
}


/** Register holds tenths of a millimetre offset by 6 (code 1 = 0.7 mm). */
export function atkDecodeLiftOff(code: number): number | null {
  return code ? (code + 6) / 10 : null;
}

