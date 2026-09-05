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

// ── COMPX command and stored-profile inspection ────────────────────────────

/** Command ids used by the COMPX configuration transport. */
export const ATK_COMPX_COMMAND = {
  getWirelessMouseOnline: 0x03,
  setWirelessDonglePair: 0x05,
  getWirelessDonglePairResult: 0x06,
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
