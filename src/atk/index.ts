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
  | "PAW3315"
  | "PAW3311"
  | "PAW3320"
  | "CORE26K"
  | "PAW3955Master";

export type AtkDpiFamily = "ultra" | "step50" | "stepped" | "paw3395se" | "paw3955master";

export interface AtkSensorProfile {
  family: AtkDpiFamily;
  minDpi: number;
  maxDpi: number;
  /**
   * Per-axis DPI increments for the "stepped" family. Valid values are
   * minDpi + k*step (the vendor's origin-is-min model, e.g. PAW3315 at 200 +
   * k*100). Only the "stepped" family reads these.
   */
  xStep?: number;
  yStep?: number;
}

/** Limits and encoding families transcribed from ATK HUB 3.2.27. */
export const ATK_SENSORS: Record<AtkSensor, AtkSensorProfile> = {
  PAW3950Ultra: { family: "ultra", minDpi: 10, maxDpi: 42000 },
  PAW3950: { family: "step50", minDpi: 50, maxDpi: 36000 },
  PAW3950DM: { family: "step50", minDpi: 50, maxDpi: 36000 },
  PAW3395Ultra: { family: "step50", minDpi: 100, maxDpi: 30000 },
  PAW3395: { family: "step50", minDpi: 100, maxDpi: 30000 },
  PAW3395SE: { family: "paw3395se", minDpi: 200, maxDpi: 18000 },
  // Stepped sensors from the ATK HUB device table; valid DPI is min + k*step.
  PAW3315: { family: "stepped", minDpi: 200, maxDpi: 16000, xStep: 100, yStep: 100 },
  PAW3311: { family: "stepped", minDpi: 200, maxDpi: 15000, xStep: 100, yStep: 100 },
  PAW3320: { family: "stepped", minDpi: 200, maxDpi: 4000, xStep: 39, yStep: 38 },
  CORE26K: { family: "step50", minDpi: 50, maxDpi: 26000 },
  PAW3955Master: { family: "paw3955master", minDpi: 50, maxDpi: 40000 },
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

/**
 * Stepped sensors (PAW3315/PAW3311/PAW3320): valid DPI is `min + count*step`,
 * matching the vendor's I$()/bMe() model whose origin is the sensor minimum.
 * The axis step can differ (PAW3320 uses 39 for X, 38 for Y).
 */
function atkEncodeDpiAxisStepped(dpi: number, min: number, step: number): { byte: number; nibble: number } {
  const count = Math.round((dpi - min) / step);
  return { byte: count & 0xff, nibble: ((count >> 8) & 0x03) << 2 };
}

function atkDecodeDpiAxisStepped(byte: number, nibble: number, min: number, step: number): number {
  const count = (byte & 0xff) | (((nibble >> 2) & 0x03) << 8);
  return min + count * step;
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

function atkEncodeDpiAxisPaw3955Master(dpi: number): { lo: number; hi: number } | null {
  if (!Number.isInteger(dpi) || dpi < 1 || dpi > 40000) return null;
  const base = dpi - 1;
  return { lo: base & 0xff, hi: (base >> 8) & 0xff };
}

function atkDecodeDpiAxisPaw3955Master(lo: number, hi: number, doubled: boolean): number {
  const dpi = (lo | (hi << 8)) + 1;
  return doubled ? dpi * 2 : dpi;
}

function atkPackDpiStagePaw3955Master(x: number, y: number): number[] | null {
  const encodedX = atkEncodeDpiAxisPaw3955Master(x);
  const encodedY = atkEncodeDpiAxisPaw3955Master(y);
  if (!encodedX || !encodedY) return null;
  const row = [encodedX.lo, encodedX.hi, encodedY.lo, encodedY.hi, 0];
  const sum = row.reduce((total, byte) => total + byte, 0) & 0xff;
  return [...row, (CHECKSUM_TOTAL - sum) & 0xff];
}

function atkUnpackDpiStagePaw3955Master(data: Uint8Array | readonly number[]): { x: number; y: number } | null {
  if (data.length < 6) return null;
  const sum = (data[0]! + data[1]! + data[2]! + data[3]! + data[4]! + data[5]!) & 0xff;
  if (sum !== CHECKSUM_TOTAL) return null;
  const flags = data[4]!;
  return {
    x: atkDecodeDpiAxisPaw3955Master(data[0]!, data[1]!, (flags & 0x01) !== 0),
    y: atkDecodeDpiAxisPaw3955Master(data[2]!, data[3]!, (flags & 0x10) !== 0),
  };
}

/** Byte length of one DPI stage row for this sensor: 6 for PAW3955 Master, 4 otherwise. */
export function atkDpiStageLength(sensor: AtkSensor | null): number {
  return sensor && ATK_SENSORS[sensor].family === "paw3955master" ? 6 : 4;
}

/** True when `value` is on a stepped sensor's grid for one axis. */
function atkSteppedValueValid(value: number, profile: AtkSensorProfile, step: number): boolean {
  return Number.isInteger(value)
    && value >= profile.minDpi
    && value <= profile.maxDpi
    && (value - profile.minDpi) % step === 0;
}

export function atkPackDpiStageForSensor(sensor: AtkSensor | null, x: number, y: number): number[] | null {
  if (sensor) {
    const profile = ATK_SENSORS[sensor];
    if (profile.family === "stepped") {
      // Asymmetric steps (PAW3320: 39 X / 38 Y) need per-axis validation.
      const yStep = profile.yStep ?? profile.xStep ?? 1;
      if (!atkSteppedValueValid(x, profile, profile.xStep ?? 1) || !atkSteppedValueValid(y, profile, yStep)) return null;
    } else {
      const options = atkDpiOptionsForSensor(sensor);
      if (!options.includes(x) || !options.includes(y)) return null;
    }
  }
  const family = sensor ? ATK_SENSORS[sensor].family : "ultra";
  if (family === "paw3955master") return atkPackDpiStagePaw3955Master(x, y);
  if (family === "stepped" && sensor) {
    const profile = ATK_SENSORS[sensor];
    const encodedX = atkEncodeDpiAxisStepped(x, profile.minDpi, profile.xStep ?? 1);
    const encodedY = atkEncodeDpiAxisStepped(y, profile.minDpi, profile.yStep ?? profile.xStep ?? 1);
    const mode = ((encodedY.nibble & 0x0f) << 4) | (encodedX.nibble & 0x0f);
    const sum = (encodedX.byte + encodedY.byte + mode) & 0xff;
    return [encodedX.byte, encodedY.byte, mode, (CHECKSUM_TOTAL - sum) & 0xff];
  }
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
  const family = sensor ? ATK_SENSORS[sensor].family : "ultra";
  if (family === "paw3955master") return atkUnpackDpiStagePaw3955Master(data);
  if (data.length < 4 || (data[0]! + data[1]! + data[2]! + data[3]!) % 0x100 !== CHECKSUM_TOTAL) return null;
  if (family === "stepped" && sensor) {
    const profile = ATK_SENSORS[sensor];
    return {
      x: atkDecodeDpiAxisStepped(data[0]!, data[2]! & 0x0f, profile.minDpi, profile.xStep ?? 1),
      y: atkDecodeDpiAxisStepped(data[1]!, (data[2]! >> 4) & 0x0f, profile.minDpi, profile.yStep ?? profile.xStep ?? 1),
    };
  }
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
  if (profile.family === "paw3955master") {
    const options: number[] = [];
    for (let dpi = profile.minDpi; dpi <= profile.maxDpi; dpi += 10) options.push(dpi);
    if (options[options.length - 1] !== profile.maxDpi) options.push(profile.maxDpi);
    return options;
  }
  if (profile.family === "stepped") {
    const step = profile.xStep ?? 1;
    const options: number[] = [];
    for (let dpi = profile.minDpi; dpi <= profile.maxDpi; dpi += step) options.push(dpi);
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

export const ATK_LIFT_OFF_MIN_CODE = 1;
export const ATK_LIFT_OFF_MAX_CODE = 11;

export function atkEncodeLiftOff(millimetres: number): number {
  return Math.round(millimetres * 10) - 6;
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

// ── COMPX command and stored-profile inspection ────────────────────────────

/** Command ids used by the COMPX configuration transport. */
export const ATK_COMPX_COMMAND = {
  getWirelessMouseOnline: 0x03,
  setWirelessDonglePair: 0x05,
  getWirelessDonglePairResult: 0x06,
  setMacroKey: 0x06,
  restoreFactory: 0x09,
  enterUsbUpgradeMode: 0x0d,
  getCurrentConfig: 0x0e,
  setCurrentConfig: 0x0f,
  dongleExitPair: 0x13,
  getDongleVersion: 0x1d,
  reportMouseUpgradeError: 0x5a,
  reportMouseUpgradeStatus: 0x5b,
} as const;

/** The R1 HUB profile picker exposes four firmware-managed configuration banks. */
export const ATK_R1_PROFILE_COUNT = 4;

export function atkDecodeCurrentProfile(data: Uint8Array | readonly number[]): number | null {
  const profile = data[0];
  return profile !== undefined && profile < ATK_R1_PROFILE_COUNT ? profile : null;
}

/** Build SetCurrentConfig with the vendor's length byte and zero-based bank. */
export function atkBuildSetCurrentProfile(profile: number): Uint8Array {
  if (!Number.isInteger(profile) || profile < 0 || profile >= ATK_R1_PROFILE_COUNT) {
    throw new Error(`ATK profile must be between 0 and ${ATK_R1_PROFILE_COUNT - 1}.`);
  }
  const payload = new Uint8Array(16);
  payload[0] = ATK_COMPX_COMMAND.setCurrentConfig;
  payload[4] = 1;
  payload[5] = profile;
  const sum = 0x08 + payload.subarray(0, 15).reduce((total, byte) => total + byte, 0);
  payload[15] = (CHECKSUM_TOTAL - (sum & 0xff)) & 0xff;
  return payload;
}

/** Build SetWirelessDonglePair for one exact mouse model identity. */
export function atkBuildReceiverPairRequest(cid: number, mid: number): Uint8Array {
  if (![cid, mid].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xff)) {
    throw new Error("ATK receiver pairing CID and MID must be bytes.");
  }
  const payload = new Uint8Array(16);
  payload[0] = ATK_COMPX_COMMAND.setWirelessDonglePair;
  payload[4] = 2;
  payload[5] = cid;
  payload[6] = mid;
  const sum = 0x08 + payload.subarray(0, 15).reduce((total, byte) => total + byte, 0);
  payload[15] = (CHECKSUM_TOTAL - (sum & 0xff)) & 0xff;
  return payload;
}

export const ATK_R1_BUTTONS = [
  { id: "left", label: "Left button", address: 0x0060 },
  { id: "right", label: "Right button", address: 0x0064 },
  { id: "middle", label: "Middle button", address: 0x0068 },
  { id: "back", label: "Back button", address: 0x006c },
  { id: "forward", label: "Forward button", address: 0x0070 },
  { id: "bottom", label: "Bottom button", address: 0x0074 },
] as const;

export const ATK_R1_SHORTCUT_BASE = 0x0100;
export const ATK_R1_SHORTCUT_SLOT_LENGTH = 32;
export const ATK_R1_MACRO_BASE = 0x0300;
export const ATK_R1_MACRO_SLOT_LENGTH = 384;
export const ATK_R1_MACRO_SLOT_COUNT = 12;
/**
 * Action records one slot holds: a 31-byte header, a one-byte action count and
 * five bytes per action fit 70 records in 384 bytes.
 */
export const ATK_R1_MACRO_MAX_ACTIONS = 70;

/** AtkR1 button key index carried by SetMacroKey, matching ATK HUB. */
export const ATK_R1_MACRO_KEY_INDEX = {
  left: 0,
  right: 1,
  middle: 2,
  back: 3,
  forward: 4,
  bottom: 5,
} as const;

export type AtkR1MacroKeyId = keyof typeof ATK_R1_MACRO_KEY_INDEX;

/** Macro start modes as the R1 button record's value2 byte encodes them. */
export const ATK_R1_MACRO_START_TYPES = {
  stopImmediately: 254,
  repeatUntilAnyKeyPress: 255,
  repeatUntilTriggerPress: 253,
  loopCount: 0,
} as const;

export interface AtkR1MacroStepInput {
  kind: "key-down" | "key-up" | "wheel-up" | "wheel-down";
  /** HID usage for keyboard steps. Ignored for wheel steps. */
  keyCode: number;
  holdTime: number;
}

/** Macro action record fields used by the R1's 384-byte macro slots. */
export const ATK_R1_MACRO_KEY_STATE = {
  down: 0x80,
  up: 0x40,
  scroll: 0,
} as const;

export const ATK_R1_MACRO_KEY_TYPE = {
  generalKey: 1,
  scroll: 6,
} as const;

/**
 * Pack one R1 macro into the vendor's 384-byte slot format: a fixed 31-byte
 * header, an action count, five-byte action records, and a final checksum.
 */
export function atkPackAtkR1MacroTable(
  steps: readonly AtkR1MacroStepInput[],
): number[] {
  if (steps.length < 1 || steps.length > ATK_R1_MACRO_MAX_ACTIONS) {
    throw new Error(`An R1 macro needs 1-${ATK_R1_MACRO_MAX_ACTIONS} steps.`);
  }

  const records: number[] = [];
  for (const [index, step] of steps.entries()) {
    if (![step.keyCode, step.holdTime].every((value) =>
      Number.isInteger(value) && value >= 0 && value <= 0xffff)) {
      throw new Error("R1 macro values must be 16-bit integers.");
    }
    // Every non-final delay is floored at 20 ms: the firmware treats a shorter
    // gap as no gap and drops the step. The floor is applied here rather than
    // rejected so a fast recorded press still saves, but it does mean a stored
    // delay below 20 ms reads back as 20 ms after a save.
    const holdTime = index === steps.length - 1 ? step.holdTime : Math.max(20, step.holdTime);
    if (step.kind === "wheel-up" || step.kind === "wheel-down") {
      const direction = step.kind === "wheel-down" ? 255 : 1;
      const delay = packAtkR1MacroDelay(holdTime);
      records.push(
        ATK_R1_MACRO_KEY_STATE.scroll | ATK_R1_MACRO_KEY_TYPE.scroll,
        direction,
        0,
        ...delay,
        ATK_R1_MACRO_KEY_STATE.scroll | ATK_R1_MACRO_KEY_TYPE.scroll,
        0,
        0,
        ...delay,
      );
      continue;
    }
    if (step.keyCode < 0 || step.keyCode > 0xff) {
      throw new Error("R1 keyboard macro values must be bytes with a 16-bit hold time.");
    }
    records.push(
      (step.kind === "key-up" ? ATK_R1_MACRO_KEY_STATE.up : ATK_R1_MACRO_KEY_STATE.down)
        | ATK_R1_MACRO_KEY_TYPE.generalKey,
      step.keyCode,
      0,
      ...packAtkR1MacroDelay(holdTime),
    );
  }

  const actionCount = records.length / 5;
  if (actionCount > ATK_R1_MACRO_MAX_ACTIONS) {
    throw new Error(`An R1 macro holds at most ${ATK_R1_MACRO_MAX_ACTIONS} actions.`);
  }
  const payload = [actionCount, ...records];
  payload.push((0x55 - payload.reduce((total, byte) => total + byte, 0)) & 0xff);
  return [
    8,
    ...Array.from({ length: 8 }, () => 2),
    ...Array.from({ length: 22 }, () => 255),
    ...payload,
  ];
}

/**
 * Macro action delays use the unsuffixed DataView uint16 accessors in ATK HUB,
 * so the bytes on the wire are big-endian. SetMacroKey's separate legacy
 * payload uses an explicitly little-endian uint16 and must not share this.
 */
function packAtkR1MacroDelay(value: number): readonly [number, number] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/**
 * Decode the action records stored in one R1 macro slot. The editor can
 * safely round-trip keyboard and wheel actions; vendor-only action types are
 * rejected so an edit cannot silently replace them with keyboard steps.
 *
 * Delays are returned exactly as stored. `atkPackAtkR1MacroTable` floors every
 * non-final delay at 20 ms, so a slot holding a shorter one reads back lower
 * than a save would write it.
 */
export function atkUnpackAtkR1MacroActions(
  actionCount: number,
  records: Uint8Array | readonly number[],
): AtkR1MacroStepInput[] {
  if (!Number.isInteger(actionCount) || actionCount < 0 || actionCount > ATK_R1_MACRO_MAX_ACTIONS) {
    throw new Error(`An R1 macro holds 0-${ATK_R1_MACRO_MAX_ACTIONS} actions.`);
  }
  const bytes = Array.from(records);
  if (bytes.length < actionCount * 5) {
    throw new Error("The R1 macro action table is truncated.");
  }

  const steps: AtkR1MacroStepInput[] = [];
  for (let index = 0; index < actionCount; index += 1) {
    const offset = index * 5;
    const status = bytes[offset]!;
    const value = bytes[offset + 1]!;
    const value2 = bytes[offset + 2]!;
    const delay = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
    const keyType = status & 0x07;
    const isDown = (status & ATK_R1_MACRO_KEY_STATE.down) !== 0;
    const isUp = (status & ATK_R1_MACRO_KEY_STATE.up) !== 0;

    if (keyType === ATK_R1_MACRO_KEY_TYPE.generalKey) {
      if (isDown === isUp || value2 !== 0) {
        throw new Error("This R1 macro contains a keyboard action with no press or release state.");
      }
      steps.push({
        kind: isDown ? "key-down" : "key-up",
        keyCode: value,
        holdTime: delay,
      });
      continue;
    }

    if (keyType === ATK_R1_MACRO_KEY_TYPE.scroll && !isDown && !isUp && value2 === 0) {
      if (value === 0) {
        const previous = steps.at(-1);
        if (previous?.kind !== "wheel-up" && previous?.kind !== "wheel-down") {
          throw new Error("This R1 macro contains an unmatched wheel release action.");
        }
        // The editor holds one delay for the whole wheel pair, so a pair the
        // vendor stored with different delays cannot survive a save; refuse it
        // rather than silently rewriting the press with the release's delay.
        if (previous.holdTime !== delay) {
          throw new Error("This R1 macro contains a wheel pair with mismatched delays.");
        }
        continue;
      }
      if (value !== 0x01 && value !== 0xff) {
        throw new Error(`This R1 macro contains an unsupported wheel direction 0x${value.toString(16).padStart(2, "0")}.`);
      }
      steps.push({
        kind: value === 0x01 ? "wheel-up" : "wheel-down",
        keyCode: 0,
        holdTime: delay,
      });
      continue;
    }

    throw new Error(`This R1 macro contains vendor action type ${keyType}, which the editor cannot safely edit.`);
  }

  return steps;
}

/**
 * Raw nine-byte SetMacroKey payload for one macro step. The 16-byte frame
 * carries a button index, these nine bytes and a checksum, so the repeat count
 * has no field of its own: only the single-pass case is expressible.
 */
export function atkPackAtkR1MacroStep(
  input: AtkR1MacroStepInput,
  position: number,
  macroId: number,
  startType: number,
  runCount: number,
): number[] {
  if (!Number.isInteger(position) || position < 0 || position > 0xff) throw new Error("Macro step position is invalid.");
  if (![macroId, startType, runCount].every((value) =>
    Number.isInteger(value) && value >= 0 && value <= 0xff)) {
    throw new Error("ATK macro identifiers must be bytes.");
  }
  if (startType === ATK_R1_MACRO_START_TYPES.loopCount && runCount !== 1) {
    throw new Error(
      "This SetMacroKey frame has no repeat-count field; only a single pass can be sent.",
    );
  }
  const step = [];
  if (input.kind === "wheel-up" || input.kind === "wheel-down") {
    step.push(
      position,
      2,
      0,
      input.kind === "wheel-down" ? 0xff : 0x01,
      0,
      ...packAtkR1Uint16(input.holdTime),
      macroId,
      startType,
    );
    return step;
  }
  if (!Number.isInteger(input.keyCode) || input.keyCode < 0 || input.keyCode > 0xff) {
    throw new Error("ATK macro keycode must be a byte.");
  }
  step.push(
    position,
    0,
    input.kind === "key-up" ? 1 : 0,
    input.keyCode,
    0,
    ...packAtkR1Uint16(input.holdTime),
    macroId,
    startType,
  );
  return step;
}

function packAtkR1Uint16(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error("ATK macro hold time must be a 16-bit integer.");
  }
  return [value & 0xff, (value >> 8) & 0xff];
}

/** Build the 16-byte SetMacroKey frame for one step of one button. */
export function atkBuildAtkR1MacroKey(keyIndex: number, step: readonly number[]): Uint8Array {
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > 5) {
    throw new Error("ATK macro button index is invalid.");
  }
  // The frame is 16 bytes: command, three reserved bytes, a length, the button
  // index, nine step bytes and the checksum. A ten-byte step would push its
  // last byte into the checksum's slot and be dropped silently.
  if (step.length !== 9) throw new Error("ATK macro step must contain nine bytes.");
  const payload = new Uint8Array(16);
  payload[0] = ATK_COMPX_COMMAND.setMacroKey;
  payload[4] = 11;
  payload[5] = keyIndex;
  for (let offset = 0; offset < 9; offset += 1) payload[offset + 6] = step[offset]!;
  const sum = 0x08 + Array.from(payload.subarray(0, 15)).reduce((total, byte) => (total + byte) & 0xff, 0);
  payload[15] = (CHECKSUM_TOTAL - (sum & 0xff)) & 0xff;
  return payload;
}

export type AtkR1ButtonId = (typeof ATK_R1_BUTTONS)[number]["id"];

/** Four-byte EEPROM button assignment: class, value 1, value 2, checksum. */
export interface AtkButtonAssignment {
  keyClass: number;
  value1: number;
  value2: number;
  checksum: number;
  checksumValid: boolean;
  label: string;
  raw: string;
}

export interface AtkButtonAction {
  id: string;
  label: string;
  keyClass: number;
  value1: number;
  value2: number;
}

/**
 * Standard R1 button actions transcribed from ATK HUB. Shortcuts and macros
 * deliberately remain unlisted until their slot payloads are hardware-verified.
 */
export const ATK_R1_BUTTON_ACTIONS: readonly AtkButtonAction[] = [
  { id: "disabled", label: "Disabled", keyClass: 0x00, value1: 0x00, value2: 0x00 },
  { id: "left-click", label: "Left click", keyClass: 0x01, value1: 0x01, value2: 0x00 },
  { id: "right-click", label: "Right click", keyClass: 0x01, value1: 0x02, value2: 0x00 },
  { id: "middle-click", label: "Middle click", keyClass: 0x01, value1: 0x04, value2: 0x00 },
  { id: "back", label: "Back", keyClass: 0x01, value1: 0x08, value2: 0x00 },
  { id: "forward", label: "Forward", keyClass: 0x01, value1: 0x10, value2: 0x00 },
  { id: "dpi-cycle", label: "DPI cycle", keyClass: 0x02, value1: 0x01, value2: 0x00 },
  { id: "dpi-up", label: "DPI up", keyClass: 0x02, value1: 0x02, value2: 0x00 },
  { id: "dpi-down", label: "DPI down", keyClass: 0x02, value1: 0x03, value2: 0x00 },
  { id: "scroll-left", label: "Horizontal scroll left", keyClass: 0x03, value1: 0x01, value2: 0x00 },
  { id: "scroll-right", label: "Horizontal scroll right", keyClass: 0x03, value1: 0x02, value2: 0x00 },
  { id: "wheel-up", label: "Wheel up", keyClass: 0x0b, value1: 0x01, value2: 0x00 },
  { id: "wheel-down", label: "Wheel down", keyClass: 0x0b, value1: 0x02, value2: 0x00 },
] as const;

export function atkButtonAction(id: string): AtkButtonAction | null {
  return ATK_R1_BUTTON_ACTIONS.find((action) => action.id === id) ?? null;
}

/** Find the standard action matching a decoded four-byte record. */
export function atkButtonActionId(keyClass: number, value1: number, value2: number): string | null {
  return ATK_R1_BUTTON_ACTIONS.find((action) =>
    action.keyClass === keyClass && action.value1 === value1 && action.value2 === value2)?.id ?? null;
}

/** Pack a four-byte assignment whose checksum makes the record sum to 0x55. */
export function atkPackButtonAssignment(action: AtkButtonAction): number[] {
  if (![action.keyClass, action.value1, action.value2].every((value) =>
    Number.isInteger(value) && value >= 0 && value <= 0xff)) {
    throw new Error("ATK button assignments must use byte values.");
  }
  return [
    action.keyClass,
    action.value1,
    action.value2,
    (CHECKSUM_TOTAL - action.keyClass - action.value1 - action.value2) & 0xff,
  ];
}

export const ATK_BUTTON_CLASS = {
  disabled: 0x00,
  mouse: 0x01,
  dpi: 0x02,
  horizontalScroll: 0x03,
  firepower: 0x04,
  shortcut: 0x05,
  macro: 0x06,
  reportRate: 0x07,
  lighting: 0x08,
  profile: 0x09,
  dpiLock: 0x0a,
  wheel: 0x0b,
} as const;

const BUTTON_CLASS_LABELS: Readonly<Record<number, string>> = {
  [ATK_BUTTON_CLASS.disabled]: "Disabled",
  [ATK_BUTTON_CLASS.mouse]: "Mouse button",
  [ATK_BUTTON_CLASS.dpi]: "DPI control",
  [ATK_BUTTON_CLASS.horizontalScroll]: "Horizontal scroll",
  [ATK_BUTTON_CLASS.firepower]: "Fire key",
  [ATK_BUTTON_CLASS.shortcut]: "Shortcut",
  [ATK_BUTTON_CLASS.macro]: "Macro",
  [ATK_BUTTON_CLASS.reportRate]: "Polling rate",
  [ATK_BUTTON_CLASS.lighting]: "Lighting control",
  [ATK_BUTTON_CLASS.profile]: "Profile control",
  [ATK_BUTTON_CLASS.dpiLock]: "DPI lock",
  [ATK_BUTTON_CLASS.wheel]: "Wheel",
};

const MOUSE_ACTION_LABELS: Readonly<Record<number, string>> = {
  0x00: "Disabled",
  0x01: "Left click",
  0x02: "Right click",
  0x04: "Middle click",
  0x08: "Back",
  0x10: "Forward",
};

const DPI_ACTION_LABELS: Readonly<Record<number, string>> = {
  0x01: "DPI cycle",
  0x02: "DPI up",
  0x03: "DPI down",
};

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** Describe only action values whose meaning is present in the vendor enum. */
export function atkDescribeButtonAction(keyClass: number, value1: number, value2: number): string {
  if (keyClass === ATK_BUTTON_CLASS.disabled) return "Disabled";
  if (keyClass === ATK_BUTTON_CLASS.mouse) return MOUSE_ACTION_LABELS[value1] ?? `Mouse button 0x${hexByte(value1)}`;
  if (keyClass === ATK_BUTTON_CLASS.dpi) return DPI_ACTION_LABELS[value1] ?? `DPI control 0x${hexByte(value1)}`;
  if (keyClass === ATK_BUTTON_CLASS.horizontalScroll) {
    return value1 === 1 ? "Horizontal scroll left" : value1 === 2 ? "Horizontal scroll right" : `Horizontal scroll 0x${hexByte(value1)}`;
  }
  if (keyClass === ATK_BUTTON_CLASS.wheel) {
    return value1 === 1 ? "Wheel up" : value1 === 2 ? "Wheel down" : `Wheel 0x${hexByte(value1)}`;
  }
  const kind = BUTTON_CLASS_LABELS[keyClass] ?? `Unknown class 0x${hexByte(keyClass)}`;
  return `${kind} (0x${hexByte(value1)}, 0x${hexByte(value2)})`;
}

export function atkDecodeButtonAssignment(data: Uint8Array | readonly number[]): AtkButtonAssignment | null {
  if (data.length < 4) return null;
  const [keyClass, value1, value2, checksum] = data;
  const raw = [keyClass!, value1!, value2!, checksum!].map(hexByte).join(" ");
  return {
    keyClass: keyClass!,
    value1: value1!,
    value2: value2!,
    checksum: checksum!,
    checksumValid: (keyClass! + value1! + value2! + checksum!) % 0x100 === CHECKSUM_TOTAL,
    label: atkDescribeButtonAction(keyClass!, value1!, value2!),
    raw,
  };
}

export interface AtkReceiverStatus {
  online: boolean;
  status: number;
  /** RF id in the firmware's rfId1/rfId2/rfId3 display order. */
  rfId: string;
}

export function atkDecodeReceiverStatus(data: Uint8Array | readonly number[]): AtkReceiverStatus | null {
  if (data.length < 4) return null;
  return {
    online: data[0] === 1,
    status: data[0]!,
    rfId: [data[3]!, data[2]!, data[1]!].map(hexByte).join("").toUpperCase(),
  };
}

export interface AtkPairingStatus {
  status: number;
  secondsRemaining: number;
}

export function atkDecodePairingStatus(data: Uint8Array | readonly number[]): AtkPairingStatus | null {
  return data.length < 2 ? null : { status: data[0]!, secondsRemaining: data[1]! };
}

// ── COMPX firmware package inspection ──────────────────────────────────────

export const ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET = 8192;
export const ATK_COMPX_FIRMWARE_HEADER_LENGTH = 720;
const ATK_FIRMWARE_FIELD_LENGTH = 64;
const ATK_FIRMWARE_FIELD_BASE = 23;

export interface AtkFirmwareEndpoint {
  vendorId: number;
  productId: number;
  path: string;
}

export interface AtkCompxFirmwareInfo {
  headerCrc: number;
  headerLength: number;
  firmwareLength: number;
  nextFileAddress: number;
  version: string;
  deviceType: number;
  cid: number;
  mid: number;
  fileId: string;
  icName: string;
  sensorName: string;
  productName: string;
  bootInput: AtkFirmwareEndpoint;
  bootOutput: AtkFirmwareEndpoint;
  normalInput: AtkFirmwareEndpoint;
  normalOutput: AtkFirmwareEndpoint;
  resetCommand: Uint8Array;
  prepareCommand: Uint8Array;
  downloadCommand: Uint8Array;
  payloadCrc: number;
  payloadCrcValid: boolean;
}

function firmwareField(data: Uint8Array, index: number): Uint8Array {
  const start = ATK_FIRMWARE_FIELD_BASE + index * ATK_FIRMWARE_FIELD_LENGTH;
  return data.subarray(start, start + ATK_FIRMWARE_FIELD_LENGTH);
}

function asciiField(data: Uint8Array, index: number): string {
  const field = firmwareField(data, index);
  const end = field.indexOf(0);
  return new TextDecoder("ascii").decode(end < 0 ? field : field.subarray(0, end));
}

function firmwareEndpoint(path: string): AtkFirmwareEndpoint {
  const match = /(?:^|&)vid_([0-9a-f]+)&pid_([0-9a-f]+)(?:&|$)/i.exec(path);
  if (!match) throw new Error(`Invalid COMPX firmware endpoint: ${path || "empty"}.`);
  return { vendorId: Number.parseInt(match[1]!, 16), productId: Number.parseInt(match[2]!, 16), path };
}

/** CRC-32 register state used by COMPX packages: init 0xffffffff, no final xor. */
export function atkCompxPayloadCrc(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  return crc >>> 0;
}

function commandField(data: Uint8Array, index: number): Uint8Array {
  return new Uint8Array(firmwareField(data, index));
}

/** Parse and integrity-check the first firmware image in a COMPX package. */
export function atkParseCompxFirmware(data: Uint8Array): AtkCompxFirmwareInfo {
  if (data.length < ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET) throw new Error("COMPX firmware package is shorter than its header area.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(4, true);
  const firmwareLength = view.getUint32(8, true);
  if (headerLength !== ATK_COMPX_FIRMWARE_HEADER_LENGTH) throw new Error(`Unsupported COMPX header length ${headerLength}.`);
  if (firmwareLength < 1 || ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET + firmwareLength > data.length) {
    throw new Error("COMPX firmware payload length exceeds the package.");
  }
  const prepareCommand = commandField(data, 7);
  const payloadCrc = new DataView(prepareCommand.buffer, prepareCommand.byteOffset, prepareCommand.byteLength).getUint32(19, false);
  const payload = data.subarray(ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET, ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET + firmwareLength);
  return {
    headerCrc: view.getUint32(0, true),
    headerLength,
    firmwareLength,
    nextFileAddress: view.getUint32(12, true),
    version: view.getUint32(16, true).toString(16),
    deviceType: view.getUint8(20),
    cid: view.getUint8(21),
    mid: view.getUint8(22),
    fileId: asciiField(data, 0),
    icName: asciiField(data, 1),
    bootInput: firmwareEndpoint(asciiField(data, 2)),
    bootOutput: firmwareEndpoint(asciiField(data, 3)),
    normalInput: firmwareEndpoint(asciiField(data, 4)),
    normalOutput: firmwareEndpoint(asciiField(data, 5)),
    resetCommand: commandField(data, 6),
    prepareCommand,
    downloadCommand: commandField(data, 8),
    sensorName: asciiField(data, 9),
    productName: asciiField(data, 10),
    payloadCrc,
    payloadCrcValid: atkCompxPayloadCrc(payload) === payloadCrc,
  };
}

// ── F1 Ultimate 2.0 (CID 1, MID 8) verified additions ──────────────────────
//
// Captured 2026-09-22 from ATK HUB web (hub.atk.pro) against VID 0x373b PID
// 0x11d9 ("Wireless mouse 8k dongle-L"), mouse FW V3.03, receiver V3.01, via a
// WebHID sendReport hook. Every frame below was observed on the wire and the
// matching user-visible behavior confirmed by hand; see
// captures/atk-f1-ultimate/ in the integration workspace (not committed).

/** Sensor sampling-rate modes: 0 Basic, 1 Shard, 2 Shard MAX. */

/** EEPROM address of the 6-byte sensor-performance row. */
export const ATK_SENSOR_PERFORMANCE_REGISTER = 0x00b5;

/**
 * Stable marker bytes of the sensor-performance row on the F1 Ultimate 2.0.
 * Bytes 0-1 vary (`[0, 0x55]` in HUB-written rows, `[1, 0x54]` live) and carry
 * an unknown field, so decoding only trusts bytes 2-3 plus the mode pair.
 */
export const ATK_SENSOR_PERFORMANCE_MARKER: readonly number[] = [6, 0x4f];

/** Build the 6-byte sensor-performance row for a mode, or null when invalid. */
export function atkPackSensorMode(mode: number): number[] | null {
  if (!Number.isInteger(mode) || mode < 0 || mode > 2) return null;
  return [0, CHECKSUM_TOTAL, ...ATK_SENSOR_PERFORMANCE_MARKER, mode, (CHECKSUM_TOTAL - mode) & 0xff];
}

/** Decode the mode of a 6-byte sensor-performance row, or null when invalid. */
export function atkDecodeSensorMode(data: Uint8Array | readonly number[]): number | null {
  if (data.length < 6) return null;
  if (data[2] !== ATK_SENSOR_PERFORMANCE_MARKER[0] || data[3] !== ATK_SENSOR_PERFORMANCE_MARKER[1]) return null;
  const mode = data[4]!;
  if (!Number.isInteger(mode) || mode < 0 || mode > 2) return null;
  if (((mode + data[5]!) & 0xff) !== CHECKSUM_TOTAL) return null;
  return mode;
}

/**
 * Scroll-wheel anti-mistouch lives in the system row at 0x0000, bytes 6-7.
 * Stored in 10 ms units; `[0, 0x55]` disables. HUB default on the F1 Ultimate
 * 2.0 is off; 100 ms and 500 ms were exercised on hardware.
 */
export const ATK_ANTI_MISTOUCH_OFFSET = 6;
export const ATK_ANTI_MISTOUCH_STEP_MS = 10;
export const ATK_ANTI_MISTOUCH_MAX_MS = 255 * ATK_ANTI_MISTOUCH_STEP_MS;

/** Build the value/checksum pair for an anti-mistouch time, or null. */
export function atkPackAntiMistouch(milliseconds: number): number[] | null {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > ATK_ANTI_MISTOUCH_MAX_MS) return null;
  if (milliseconds !== 0 && milliseconds % ATK_ANTI_MISTOUCH_STEP_MS !== 0) return null;
  const units = milliseconds / ATK_ANTI_MISTOUCH_STEP_MS;
  return [units, (CHECKSUM_TOTAL - units) & 0xff];
}

/** Decode an anti-mistouch pair to milliseconds, or null when invalid. */
export function atkDecodeAntiMistouch(value: number, checksum: number): number | null {
  if (((value + checksum) & 0xff) !== CHECKSUM_TOTAL) return null;
  if (!Number.isInteger(value) || value < 0 || value > 0xff) return null;
  return value * ATK_ANTI_MISTOUCH_STEP_MS;
}

/** Dongle LED effect command; modes are 0 off, 1 polling, 2 battery, 3 low battery. */
export const ATK_DONGLE_LIGHT_COMMAND = 0x14;

/** Build the 16-byte SetDongleLight frame for a mode, or null when invalid. */
export function atkBuildDongleLight(mode: number): Uint8Array | null {
  if (!Number.isInteger(mode) || mode < 0 || mode > 3) return null;
  const payload = new Uint8Array(16);
  payload[0] = ATK_DONGLE_LIGHT_COMMAND;
  payload[4] = 10;
  payload[5] = mode;
  const sum = 0x08 + payload.subarray(0, 15).reduce((total, byte) => total + byte, 0);
  payload[15] = (CHECKSUM_TOTAL - (sum & 0xff)) & 0xff;
  return payload;
}
