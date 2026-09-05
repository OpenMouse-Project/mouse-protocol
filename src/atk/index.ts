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

export type AtkSensor =
  | "PAW3950Ultra"
  | "PAW3950"
  | "PAW3950DM"
  | "PAW3395Ultra"
  | "PAW3395"
  | "PAW3395SE"
  | "CORE26K";

export type AtkDpiFamily = "ultra" | "step50" | "paw3395se";

export interface AtkSensorProfile {
  family: AtkDpiFamily;
  minDpi: number;
  maxDpi: number;
}

/** Limits and encoding families transcribed from ATK HUB 3.2.21. */
export const ATK_SENSORS: Record<AtkSensor, AtkSensorProfile> = {
  PAW3950Ultra: { family: "ultra", minDpi: 10, maxDpi: 42000 },
  PAW3950: { family: "step50", minDpi: 50, maxDpi: 36000 },
  PAW3950DM: { family: "step50", minDpi: 50, maxDpi: 36000 },
  PAW3395Ultra: { family: "step50", minDpi: 100, maxDpi: 30000 },
  PAW3395: { family: "step50", minDpi: 100, maxDpi: 30000 },
  PAW3395SE: { family: "paw3395se", minDpi: 200, maxDpi: 18000 },
  CORE26K: { family: "step50", minDpi: 50, maxDpi: 26000 },
};

const PAW3395SE_INVALID_CODES = new Set([
  7, 13, 20, 26, 33, 40, 46, 53, 60, 66, 73, 80, 86, 93, 100, 106, 113,
  120, 126, 133, 140, 146, 153, 160, 166, 173, 180, 186, 193, 200, 206,
  213, 220, 226, 233,
]);
const PAW3395SE_CODES = Array.from({ length: 235 }, (_, index) => index + 1)
  .filter((code) => !PAW3395SE_INVALID_CODES.has(code));

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

function atkEncodeDpiAxisStep50(dpi: number): { byte: number; nibble: number } {
  const doubled = dpi > 30000;
  const count = Math.round(dpi / (doubled ? 100 : 50)) - 1;
  return { byte: count & 0xff, nibble: (((count >> 8) & 0x03) << 2) | (doubled ? 1 : 0) };
}

function atkDecodeDpiAxisStep50(byte: number, nibble: number): number {
  const count = (byte & 0xff) | (((nibble >> 2) & 0x03) << 8);
  const dpi = (count + 1) * 50;
  return (nibble & 1) !== 0 ? dpi * 2 : dpi;
}

function atkEncodeDpiAxisPaw3395Se(dpi: number): { byte: number; nibble: number } | null {
  const doubled = dpi > 10000;
  const baseDpi = doubled ? dpi / 2 : dpi;
  if (!Number.isInteger(baseDpi) || baseDpi < 50 || baseDpi > 10000 || baseDpi % 50 !== 0) return null;
  const code = PAW3395SE_CODES[baseDpi / 50 - 1];
  return code === undefined ? null : { byte: code, nibble: doubled ? 2 : 0 };
}

function atkDecodeDpiAxisPaw3395Se(byte: number, nibble: number): number | null {
  if ((nibble & ~2) !== 0) return null;
  const index = PAW3395SE_CODES.indexOf(byte & 0xff);
  if (index < 0) return null;
  const baseDpi = (index + 1) * 50;
  if ((nibble & 2) !== 0) return baseDpi > 5000 ? baseDpi * 2 : null;
  return baseDpi;
}

export function atkPackDpiStageForSensor(sensor: AtkSensor | null, x: number, y: number): number[] | null {
  if (sensor) {
    const options = atkDpiOptionsForSensor(sensor);
    if (!options.includes(x) || !options.includes(y)) return null;
  }
  const family = sensor ? ATK_SENSORS[sensor].family : "ultra";
  const encode = family === "paw3395se"
    ? atkEncodeDpiAxisPaw3395Se
    : family === "step50"
      ? atkEncodeDpiAxisStep50
      : atkEncodeDpiAxis;
  const encodedX = encode(x);
  const encodedY = encode(y);
  if (!encodedX || !encodedY) return null;
  const mode = ((encodedY.nibble & 0x0f) << 4) | (encodedX.nibble & 0x0f);
  const sum = (encodedX.byte + encodedY.byte + mode) & 0xff;
  return [encodedX.byte, encodedY.byte, mode, (CHECKSUM_TOTAL - sum) & 0xff];
}

export function atkUnpackDpiStageForSensor(
  sensor: AtkSensor | null,
  data: Uint8Array | readonly number[],
): { x: number; y: number } | null {
  if (data.length < 4 || (data[0]! + data[1]! + data[2]! + data[3]!) % 0x100 !== CHECKSUM_TOTAL) return null;
  const family = sensor ? ATK_SENSORS[sensor].family : "ultra";
  const decode = family === "paw3395se"
    ? atkDecodeDpiAxisPaw3395Se
    : family === "step50"
      ? atkDecodeDpiAxisStep50
      : atkDecodeDpiAxis;
  const x = decode(data[0]!, data[2]! & 0x0f);
  const y = decode(data[1]!, (data[2]! >> 4) & 0x0f);
  return x === null || y === null ? null : { x, y };
}

export function atkDpiOptionsForSensor(sensor: AtkSensor): number[] {
  const profile = ATK_SENSORS[sensor];
  if (profile.family === "ultra") {
    const options: number[] = [];
    for (let dpi = profile.minDpi; dpi <= 10000; dpi += 10) options.push(dpi);
    for (let dpi = 10050; dpi <= 30000; dpi += 50) options.push(dpi);
    for (let dpi = 30100; dpi <= profile.maxDpi; dpi += 100) options.push(dpi);
    return options;
  }
  if (profile.family === "paw3395se") {
    const options: number[] = [];
    for (let dpi = profile.minDpi; dpi <= 10000; dpi += 50) options.push(dpi);
    for (let dpi = 10100; dpi <= profile.maxDpi; dpi += 100) options.push(dpi);
    return options;
  }
  const options: number[] = [];
  for (let dpi = profile.minDpi; dpi <= Math.min(profile.maxDpi, 30000); dpi += 50) options.push(dpi);
  for (let dpi = 30100; dpi <= profile.maxDpi; dpi += 100) options.push(dpi);
  return options;
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
