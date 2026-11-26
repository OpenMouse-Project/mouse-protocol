/**
 * Endgame Gear OT-platform (XM1r / OP1 / OP1 RGB) protocol codecs.
 *
 * Derived from the vendor's Electron configuration tools
 * ("Endgame Gear Configuration Software" v1.6.400 for OP1 + OP1 RGB, and
 * "XM1r Configuration Software" v1.2.2), which ship as unpacked
 * Angular + node-hid applications, so the framing, command table, effect
 * struct layout, profile block surgery, and firmware-update flow below come
 * straight from the vendor's own TypeScript sources.
 *
 * Transport: 64-byte HID feature reports, report id 0. Byte 1 is the COMTYPE
 * command, byte 2 the packet id, bytes 3..63 the payload. The vendor sets its
 * "ACK seen" flag right after every write, so a query completes on the first
 * non-empty, non-ACK reply, with or without a preceding ACK. Fire-and-forget
 * commands complete on an ACK or kComResponse. Vendor retry budget: 10 writes,
 * 10 reads. A session starts with kComSetPasswd then kComQueryFirmwareVersion,
 * on the 0xFFA1:0x00A5 interface only.
 *
 * None of this has been exercised on hardware yet: every entry is
 * recognition-grade, not hardware-verified.
 */

export const OT_VENDOR_ID = 0x3367;

export type OtSensorFamily = "paw3370" | "paw3395";

export interface OtDeviceProfile {
  pid: number;
  name: string;
  sensorFamily: OtSensorFamily;
  /** Software CPI ceiling from the vendor app (XM1r page caps at 19000). */
  maxCpi: number;
  /** OP1 RGB is the only OT mouse with the 6-byte RGB effect block. */
  hasRgbEffect: boolean;
  /** Wired-only generation; the 0x1910 wireless page is not mapped yet. */
  wireless: boolean;
}

export const OT_DEVICE_PROFILES: ReadonlyMap<number, OtDeviceProfile> = new Map([
  [0x1903, { pid: 0x1903, name: "Endgame Gear XM1r", sensorFamily: "paw3370", maxCpi: 19_000, hasRgbEffect: false, wireless: false }],
  [0x1906, { pid: 0x1906, name: "Endgame Gear OP1", sensorFamily: "paw3395", maxCpi: 26_000, hasRgbEffect: false, wireless: false }],
  [0x1905, { pid: 0x1905, name: "Endgame Gear OP1 RGB", sensorFamily: "paw3395", maxCpi: 26_000, hasRgbEffect: true, wireless: false }],
]);

/**
 * PID 0x1910 is accepted by the vendor app's HID filter and opens a wireless
 * page (battery level, charging state) using XM2w artwork, but no mouse name
 * is attached to it anywhere in the shipped app. Deliberately unsupported
 * until a device name can be tied to it.
 */
export const OT_UNMAPPED_WIRELESS_PID = 0x1910;

/** Full COMTYPE table from the vendor app's hid.service. */
export const OT_COMTYPE = {
  light: 1,
  queryLight: 2,
  mouse: 3,
  queryMouse: 4,
  keyboard: 5,
  queryKeyboard: 6,
  lcd: 7,
  firmwareDlSetup: 8,
  firmwareDataPacket: 9,
  macroDlSetup: 10,
  macroDataPacket: 11,
  activateProfile: 12,
  queryProfile: 13,
  setMacroKey: 14,
  queryMacroKey: 15,
  setDefaultExePage: 16,
  queryFirmwareVersion: 17,
  resetFirmware: 18,
  setPasswd: 19,
  ack: 20,
  response: 21,
  writeFlash: 22,
  setName: 23,
  exePathSetup: 24,
  exePathDataPacket: 25,
  queryName: 26,
  queryExePathSetup: 27,
  queryExePathDataPacket: 28,
  setSerialTime: 29,
  querySerialTime: 30,
  queryMacroSetup: 31,
  queryMacroDataPacket: 32,
  queryNameSetup: 33,
  nameSetup: 34,
  clearFlash: 35,
  saveSettings: 36,
  resetMouse: 37,
  closeMouse: 38,
  queryMemoryData: 39,
  setLedEffect: 40,
  queryScanData: 41,
  queryMeasurementData: 42,
  setLedGain: 43,
  setBackgroundEffect: 44,
  setSynchronizeLedStart: 45,
  getSupporters: 46,
  getInfo: 47,
  firmwareUpgrade: 48,
  firmwareSetup: 49,
  firmwareUpload: 50,
  queryProfileData: 51,
  setProfileData: 52,
  queryAnalogData: 53,
} as const;

export const OT_REPORT_ID = 0;
export const OT_PACKET_SIZE = 64;
export const OT_COMTYPE_OFFSET = 1;
export const OT_PACKET_ID_OFFSET = 2;
export const OT_PAYLOAD_INDEX = 3;
export const OT_PAYLOAD_SIZE = OT_PACKET_SIZE - OT_PAYLOAD_INDEX;
/** Vendor firmware-download chunk size (PAYLOAD_SIZE 59, minus 2 framing bytes). */
export const OT_FW_CHUNK_SIZE = 57;
export const OT_WRITE_RETRIES = 10;
export const OT_READ_RETRIES = 10;

/**
 * The only HID interface the vendor app opens (it skips every other
 * collection of the same PID). Other interfaces are standard mouse/keyboard
 * collections the browser refuses feature-report writes on.
 */
export const OT_USAGE_PAGE = 0xffa1;
export const OT_USAGE = 0x00a5;

/**
 * Session password the vendor app sends (kComSetPasswd, packet id 0) before
 * anything else, then reads the firmware version. A static constant shipped in
 * the app, not a per-device secret.
 */
export const OT_PASSWORD = "GEGJGYIKDCGBE9DWDKB27EAA7K9Z5J1P";
export const OT_PASSWORD_LENGTH = 32;

/** Build the kComSetPasswd packet that opens a session. */
export function otEncodeSetPasswdPacket(): Uint8Array {
  const out = new Uint8Array(OT_PACKET_SIZE);
  out[OT_COMTYPE_OFFSET] = OT_COMTYPE.setPasswd;
  out[OT_PACKET_ID_OFFSET] = 0;
  for (let index = 0; index < OT_PASSWORD_LENGTH; index += 1) {
    out[OT_PAYLOAD_INDEX + index] = OT_PASSWORD.charCodeAt(index);
  }
  return out;
}

/** Profile-data block ids (kComQueryProfileData / kComSetProfileData). */
export const OT_PROFILE_BLOCK = {
  main: 0,
  keyboard: 1,
  name: 2,
  cpiY: 3,
  wireless: 4,
  rgb: 6,
} as const;

/** Serialized effect struct is 118 bytes; see OT_EFFECT_OFFSETS. */
export const OT_EFFECT_SIZE = 118;

export const OT_EFFECT_OFFSETS = {
  transferFlags: 0,
  profileIndex: 1,
  activeProfile: 2,
  maxProfile: 3,
  cpi: 4, // 4 x u16 LE
  profileFlags: 12, // u32 LE
  cpiIndex: 16,
  pollrateIndex: 17,
  pollRates: 18, // 3 x u8
  sensitivityX: 21,
  sensitivityY: 22,
  dcuThreshold: 23, // lift-off distance
  acceleration: 24,
  angleSnap: 25,
  jitterCorrection: 26,
  red: 27, // 4 x u8, per-CPI LED
  green: 31, // 4 x u8
  blue: 35, // 4 x u8
  buttonRemap: 39, // 7 x u8
  lcdBrightness: 46,
  lcdContrast: 47,
  winPointerSpeed: 48,
  winSpare: 49,
  hidUsage: 50, // 7 x u16 LE
  modifier: 64, // 7 x u8
  profileName: 71, // 32 bytes UTF-16, NUL-padded
  cpiY: 103, // 4 x u16 LE
  wirelessMode: 111,
  rgbMode: 112,
  rgbRed: 113,
  rgbGreen: 114,
  rgbBlue: 115,
  rgbBrightness: 116,
  rgbSpeed: 117,
} as const;

export const OT_CPI_COUNT = 4;
export const OT_POLL_RATE_COUNT = 3;
export const OT_CPI_LED_COUNT = 4;
export const OT_BUTTON_COUNT = 7;
export const OT_KEY_SLOTS = 7;
export const OT_PROFILE_NAME_BYTES = 32;
export const OT_MAX_PROFILES = 5;

/** Poll-rate index to Hz, from the vendor struct comment (0=1000 … 3=125). */
export const OT_POLL_RATE_HZ: ReadonlyMap<number, number> = new Map([
  [0, 1000],
  [1, 500],
  [2, 250],
  [3, 125],
]);

/**
 * Settings OpenMouse exposes on an OT-platform mouse. Read-only entries
 * (sensitivity, acceleration, jitter correction, LED stages, button mapping)
 * are decoded into status but have no writer yet; macros, profile
 * activation, keyboard bindings, and LED-effect writes are vendor-only.
 */
export type OtExposedFeature =
  | "profiles"
  | "dpi-stages"
  | "polling-rate"
  | "lift-off-distance"
  | "angle-snapping"
  | "ripple-control"
  | "slamclick-filter"
  | "motion-sync"
  | "sensitivity"
  | "acceleration"
  | "jitter-correction"
  | "led-stages"
  | "button-mapping"
  | "rgb-effect"
  | "battery-telemetry"
  | "firmware-query"
  | "firmware-flash"
  | "firmware-reset";

export function otExposedFeatures(profile: OtDeviceProfile): OtExposedFeature[] {
  const features: OtExposedFeature[] = [
    "profiles",
    "dpi-stages",
    "polling-rate",
    "lift-off-distance",
    "angle-snapping",
    "ripple-control",
    "slamclick-filter",
    "motion-sync",
    "sensitivity",
    "acceleration",
    "jitter-correction",
    "led-stages",
    "button-mapping",
    "battery-telemetry",
    "firmware-query",
    "firmware-flash",
    "firmware-reset",
  ];
  if (profile.hasRgbEffect) features.push("rgb-effect");
  return features;
}

export const OT_POLLING_RATES = [125, 250, 500, 1000] as const;

/** Profile-flags bits, from MakeProfileFromEffect in the vendor app. */
export const OT_PROFILE_FLAG = {
  angleSnapping: 1 << 3,
  motionSyncSmooth: 1 << 5,
  rippleControl: 1 << 6,
  rgbEnabled: 1 << 12,
  motionSyncResponsive: 1 << 14,
  slamClickFilter: 1 << 15,
} as const;

/** Button-remap event ids (CpiEventEnum in the vendor app; wire value = id - 1). */
export const OT_CPI_EVENT = {
  loop: 10,
  plus: 11,
  minus: 12,
  custom: 13,
} as const;

/** Magic trailer of the kComResetFirmware payload (0x0BADF00D), after a 0x01 lead byte. */
export const OT_RESET_MAGIC = [0x0b, 0xad, 0xf0, 0x0d, 0xf0, 0x0d, 0xba, 0xd0] as const;

export interface OtEffect {
  transferFlags: number;
  profileIndex: number;
  activeProfile: number;
  maxProfile: number;
  cpi: number[];
  profileFlags: number;
  cpiIndex: number;
  pollrateIndex: number;
  pollRates: number[];
  sensitivityX: number;
  sensitivityY: number;
  dcuThreshold: number;
  acceleration: number;
  angleSnap: number;
  jitterCorrection: number;
  red: number[];
  green: number[];
  blue: number[];
  buttonRemap: number[];
  lcdBrightness: number;
  lcdContrast: number;
  winPointerSpeed: number;
  winSpare: number;
  hidUsage: number[];
  modifier: number[];
  profileName: string;
  cpiY: number[];
  wirelessMode: number;
  rgbMode: number;
  rgbRed: number;
  rgbGreen: number;
  rgbBlue: number;
  rgbBrightness: number;
  rgbSpeed: number;
}

export interface OtWirelessTelemetry {
  wirelessMode: number;
  batteryRaw: number;
  /** Battery byte with the vendor's charging bit masked off; charging flag is app-inferred, not wire-observed. */
  batteryLevel: number;
  /** True when bit 7 is set. Inferred from app timer logic, not confirmed on the wire. */
  charging: boolean;
  mouseLevel: number;
  dongleLevel: number;
  spacer: number;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function writeU16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function readArray(bytes: Uint8Array, offset: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => bytes[offset + i] ?? 0);
}

function readU16Array(bytes: Uint8Array, offset: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => readU16LE(bytes, offset + i * 2));
}

/** Decode a full 118-byte effect struct. */
export function otDecodeEffect(bytes: Uint8Array): OtEffect {
  const o = OT_EFFECT_OFFSETS;
  const nameBytes = bytes.subarray(o.profileName, o.profileName + OT_PROFILE_NAME_BYTES);
  let name = "";
  for (let i = 0; i + 1 < nameBytes.length; i += 2) {
    const code = nameBytes[i]! | (nameBytes[i + 1]! << 8);
    if (code === 0) break;
    name += String.fromCharCode(code);
  }
  return {
    transferFlags: bytes[o.transferFlags] ?? 0,
    profileIndex: bytes[o.profileIndex] ?? 0,
    activeProfile: bytes[o.activeProfile] ?? 0,
    maxProfile: bytes[o.maxProfile] ?? 0,
    cpi: readU16Array(bytes, o.cpi, OT_CPI_COUNT),
    profileFlags: readU16LE(bytes, o.profileFlags)
      | ((bytes[o.profileFlags + 2] ?? 0) << 16)
      | ((bytes[o.profileFlags + 3] ?? 0) << 24),
    cpiIndex: bytes[o.cpiIndex] ?? 0,
    pollrateIndex: bytes[o.pollrateIndex] ?? 0,
    pollRates: readArray(bytes, o.pollRates, OT_POLL_RATE_COUNT),
    sensitivityX: bytes[o.sensitivityX] ?? 0,
    sensitivityY: bytes[o.sensitivityY] ?? 0,
    dcuThreshold: bytes[o.dcuThreshold] ?? 0,
    acceleration: bytes[o.acceleration] ?? 0,
    angleSnap: bytes[o.angleSnap] ?? 0,
    jitterCorrection: bytes[o.jitterCorrection] ?? 0,
    red: readArray(bytes, o.red, OT_CPI_LED_COUNT),
    green: readArray(bytes, o.green, OT_CPI_LED_COUNT),
    blue: readArray(bytes, o.blue, OT_CPI_LED_COUNT),
    buttonRemap: readArray(bytes, o.buttonRemap, OT_BUTTON_COUNT),
    lcdBrightness: bytes[o.lcdBrightness] ?? 0,
    lcdContrast: bytes[o.lcdContrast] ?? 0,
    winPointerSpeed: bytes[o.winPointerSpeed] ?? 0,
    winSpare: bytes[o.winSpare] ?? 0,
    hidUsage: readU16Array(bytes, o.hidUsage, OT_KEY_SLOTS),
    modifier: readArray(bytes, o.modifier, OT_KEY_SLOTS),
    profileName: name,
    cpiY: readU16Array(bytes, o.cpiY, OT_CPI_COUNT),
    wirelessMode: bytes[o.wirelessMode] ?? 0,
    rgbMode: bytes[o.rgbMode] ?? 0,
    rgbRed: bytes[o.rgbRed] ?? 0,
    rgbGreen: bytes[o.rgbGreen] ?? 0,
    rgbBlue: bytes[o.rgbBlue] ?? 0,
    rgbBrightness: bytes[o.rgbBrightness] ?? 0,
    rgbSpeed: bytes[o.rgbSpeed] ?? 0,
  };
}

/** Encode an effect to its 118-byte wire form. */
export function otEncodeEffect(effect: OtEffect): Uint8Array {
  const o = OT_EFFECT_OFFSETS;
  const out = new Uint8Array(OT_EFFECT_SIZE);
  const take = (values: number[], count: number): number[] =>
    Array.from({ length: count }, (_, i) => values[i] ?? 0);
  out[o.transferFlags] = effect.transferFlags & 0xff;
  out[o.profileIndex] = effect.profileIndex & 0xff;
  out[o.activeProfile] = effect.activeProfile & 0xff;
  out[o.maxProfile] = effect.maxProfile & 0xff;
  take(effect.cpi, OT_CPI_COUNT).forEach((v, i) => writeU16LE(out, o.cpi + i * 2, v));
  const flags = effect.profileFlags >>> 0;
  out[o.profileFlags] = flags & 0xff;
  out[o.profileFlags + 1] = (flags >> 8) & 0xff;
  out[o.profileFlags + 2] = (flags >> 16) & 0xff;
  out[o.profileFlags + 3] = (flags >> 24) & 0xff;
  out[o.cpiIndex] = effect.cpiIndex & 0xff;
  out[o.pollrateIndex] = effect.pollrateIndex & 0xff;
  take(effect.pollRates, OT_POLL_RATE_COUNT).forEach((v, i) => { out[o.pollRates + i] = v & 0xff; });
  out[o.sensitivityX] = effect.sensitivityX & 0xff;
  out[o.sensitivityY] = effect.sensitivityY & 0xff;
  out[o.dcuThreshold] = effect.dcuThreshold & 0xff;
  out[o.acceleration] = effect.acceleration & 0xff;
  out[o.angleSnap] = effect.angleSnap & 0xff;
  out[o.jitterCorrection] = effect.jitterCorrection & 0xff;
  take(effect.red, OT_CPI_LED_COUNT).forEach((v, i) => { out[o.red + i] = v & 0xff; });
  take(effect.green, OT_CPI_LED_COUNT).forEach((v, i) => { out[o.green + i] = v & 0xff; });
  take(effect.blue, OT_CPI_LED_COUNT).forEach((v, i) => { out[o.blue + i] = v & 0xff; });
  take(effect.buttonRemap, OT_BUTTON_COUNT).forEach((v, i) => { out[o.buttonRemap + i] = v & 0xff; });
  out[o.lcdBrightness] = effect.lcdBrightness & 0xff;
  out[o.lcdContrast] = effect.lcdContrast & 0xff;
  out[o.winPointerSpeed] = effect.winPointerSpeed & 0xff;
  out[o.winSpare] = effect.winSpare & 0xff;
  take(effect.hidUsage, OT_KEY_SLOTS).forEach((v, i) => writeU16LE(out, o.hidUsage + i * 2, v));
  take(effect.modifier, OT_KEY_SLOTS).forEach((v, i) => { out[o.modifier + i] = v & 0xff; });
  for (let i = 0; i < OT_PROFILE_NAME_BYTES / 2; i += 1) {
    const code = i < effect.profileName.length ? effect.profileName.charCodeAt(i) : 0;
    out[o.profileName + i * 2] = code & 0xff;
    out[o.profileName + i * 2 + 1] = (code >> 8) & 0xff;
  }
  take(effect.cpiY, OT_CPI_COUNT).forEach((v, i) => writeU16LE(out, o.cpiY + i * 2, v));
  out[o.wirelessMode] = effect.wirelessMode & 0xff;
  out[o.rgbMode] = effect.rgbMode & 0xff;
  out[o.rgbRed] = effect.rgbRed & 0xff;
  out[o.rgbGreen] = effect.rgbGreen & 0xff;
  out[o.rgbBlue] = effect.rgbBlue & 0xff;
  out[o.rgbBrightness] = effect.rgbBrightness & 0xff;
  out[o.rgbSpeed] = effect.rgbSpeed & 0xff;
  return out;
}

export interface OtProfileBlock {
  block: number;
  /** Effect-struct slice carried after the 4-byte header. */
  offset: number;
  length: number;
}

/**
 * The six kComSetProfileData / kComQueryProfileData blocks. Each packet
 * carries effect[0..4) then the slice; block 0 carries effect[0..first).
 * first = OT_EFFECT_SIZE - 68.
 */
export function otProfileBlocks(): OtProfileBlock[] {
  const first = OT_EFFECT_SIZE - 68;
  return [
    { block: OT_PROFILE_BLOCK.keyboard, offset: first, length: 21 },
    { block: OT_PROFILE_BLOCK.name, offset: first + 21, length: 32 },
    { block: OT_PROFILE_BLOCK.cpiY, offset: first + 53, length: 8 },
    { block: OT_PROFILE_BLOCK.wireless, offset: first + 61, length: 1 },
    { block: OT_PROFILE_BLOCK.rgb, offset: first + 62, length: 6 },
    { block: OT_PROFILE_BLOCK.main, offset: 0, length: first },
  ];
}

/** Build one 64-byte profile packet: [0, setProfileData, packetId, block, header(4), slice…]. */
export function otEncodeProfilePacket(effectBytes: Uint8Array, block: number, packetId = 0): Uint8Array {
  const first = OT_EFFECT_SIZE - 68;
  const out = new Uint8Array(OT_PACKET_SIZE);
  out[OT_COMTYPE_OFFSET] = OT_COMTYPE.setProfileData;
  out[OT_PACKET_ID_OFFSET] = packetId & 0xff;
  out[OT_PAYLOAD_INDEX] = block & 0xff;
  if (block === OT_PROFILE_BLOCK.main) {
    out.set(effectBytes.subarray(0, first), OT_PAYLOAD_INDEX);
    return out;
  }
  const spec = otProfileBlocks().find((b) => b.block === block);
  if (!spec) throw new Error(`Unknown OT profile block ${block}.`);
  out.set(effectBytes.subarray(0, 4), OT_PAYLOAD_INDEX);
  out.set(effectBytes.subarray(spec.offset, spec.offset + spec.length), OT_PAYLOAD_INDEX + 4);
  // Block id last: the header copy above covers it, like the vendor tool.
  out[OT_PAYLOAD_INDEX] = block & 0xff;
  return out;
}

/** All six profile packets in vendor order (keyboard, name, cpiY, wireless, rgb, main). */
export function otEncodeProfilePackets(effectBytes: Uint8Array, packetId = 0): Uint8Array[] {
  return otProfileBlocks().map(({ block }) => otEncodeProfilePacket(effectBytes, block, packetId));
}

/**
 * Reassemble a 118-byte effect from the six query replies. Each reply is the
 * 61-byte payload at OT_PAYLOAD_INDEX. The vendor parsers skip the first four
 * payload bytes (block id + header echo) and read the slice at payload + 4,
 * so only the main-block reply contributes bytes 0..first.
 */
export function otReassembleEffect(replies: ReadonlyMap<number, Uint8Array>): Uint8Array {
  const out = new Uint8Array(OT_EFFECT_SIZE);
  const first = OT_EFFECT_SIZE - 68;
  for (const { block, offset, length } of otProfileBlocks()) {
    const reply = replies.get(block);
    if (!reply) throw new Error(`Missing OT profile block ${block} reply.`);
    if (block === OT_PROFILE_BLOCK.main) {
      out.set(reply.subarray(0, first), 0);
      continue;
    }
    out.set(reply.subarray(4, 4 + length), offset);
  }
  return out;
}

/** Build a kComQueryProfileData packet for one block of one profile. */
export function otEncodeQueryPacket(block: number, profileIndex: number, packetId = 0): Uint8Array {
  const out = new Uint8Array(OT_PACKET_SIZE);
  out[OT_COMTYPE_OFFSET] = OT_COMTYPE.queryProfileData;
  out[OT_PACKET_ID_OFFSET] = packetId & 0xff;
  out[OT_PAYLOAD_INDEX] = block & 0xff;
  out[OT_PAYLOAD_INDEX + 1] = profileIndex & 0xff;
  return out;
}

/**
 * Parse the wireless telemetry from a block-4 query reply payload
 * (header + wirelessMode, battery, mouseLevel, dongleLevel, spacer).
 */
export function otParseWirelessTelemetry(payload: Uint8Array): OtWirelessTelemetry {
  const at = (i: number): number => payload[4 + i] ?? 0;
  const batteryRaw = at(1);
  return {
    wirelessMode: at(0),
    batteryRaw,
    batteryLevel: batteryRaw & 0x7f,
    charging: (batteryRaw & 0x80) !== 0,
    mouseLevel: at(2),
    dongleLevel: at(3),
    spacer: at(4),
  };
}

export function otProfileForPid(pid: number): OtDeviceProfile {
  const profile = OT_DEVICE_PROFILES.get(pid);
  if (!profile) throw new Error(`Unsupported Endgame Gear OT product 0x${pid.toString(16)}.`);
  return profile;
}

/** Vendor CPI step: 50, or 100 above 10 000 CPI. */
export function otCpiStep(cpi: number): number {
  return cpi > 10_000 ? 100 : 50;
}

export function otClampCpi(profile: OtDeviceProfile, value: number): number {
  const clamped = Math.max(50, Math.min(profile.maxCpi, Math.round(value)));
  const step = otCpiStep(clamped);
  const rounded = Math.floor((clamped + step / 2) / step) * step;
  return Math.max(50, Math.min(profile.maxCpi, rounded));
}

export function otIsValidCpi(profile: OtDeviceProfile, value: number): boolean {
  return Number.isInteger(value) && value === otClampCpi(profile, value);
}

/** Lift-off hint text in the vendor app only knows 1 mm and 2 mm. */
export function otLodLabel(raw: number): string | null {
  if (raw === 1) return "1 mm";
  if (raw === 2) return "2 mm";
  return null;
}

export function otLodRaw(label: string): number | null {
  if (label === "1 mm") return 1;
  if (label === "2 mm") return 2;
  return null;
}

export function otPollRateHz(index: number): number | null {
  return OT_POLL_RATE_HZ.get(index) ?? null;
}

export type OtButtonActionKey =
  | "mouse"
  | "cpi-loop"
  | "cpi-plus"
  | "cpi-minus"
  | "cpi-custom"
  | "keyboard"
  | "disabled"
  | "raw";

export interface OtButtonAction {
  key: OtButtonActionKey;
  eventId?: number;
  cpi?: number;
  usage?: number;
  modifiers?: number;
}

/**
 * Decode one button-remap byte (wire value = UI event id - 1).
 * Mouse-button ids 1..9 pass through; 0 is fixed left click.
 */
export function otDecodeButtonRemap(slot: number, value: number): OtButtonAction {
  if (slot === 0) return { key: "mouse", eventId: 1 };
  const id = (value & 0xff) + 1;
  if (id === OT_CPI_EVENT.loop) return { key: "cpi-loop", eventId: id };
  if (id === OT_CPI_EVENT.plus) return { key: "cpi-plus", eventId: id };
  if (id === OT_CPI_EVENT.minus) return { key: "cpi-minus", eventId: id };
  if (id >= OT_CPI_EVENT.custom) return { key: "cpi-custom", eventId: id };
  if (id >= 1 && id <= 9) return { key: "mouse", eventId: id };
  return { key: "raw", eventId: id };
}

export interface OtFirmwareSetup {
  totalSize: number;
  packetCount: number;
  chunkSize: number;
  crc: number;
  major: number;
  minor: number;
  build: number;
}

/**
 * kComFirmwareDlSetup payload (vendor Custom_HID_Update_Firmware):
 * [3]=0x01, [4..5]=total LE, [6..7]=packets LE, [10]=chunk size,
 * [11..12]=crc LE, [14]=encrypt flag, [15..17]=fw major/minor/build.
 */
export function otEncodeFirmwareSetup(setup: OtFirmwareSetup, packetId = 0): Uint8Array {
  const out = new Uint8Array(OT_PACKET_SIZE);
  out[OT_COMTYPE_OFFSET] = OT_COMTYPE.firmwareDlSetup;
  out[OT_PACKET_ID_OFFSET] = packetId & 0xff;
  out[OT_PAYLOAD_INDEX] = 0x01;
  writeU16LE(out, OT_PAYLOAD_INDEX + 1, setup.totalSize);
  writeU16LE(out, OT_PAYLOAD_INDEX + 3, setup.packetCount);
  out[OT_PAYLOAD_INDEX + 7] = setup.chunkSize & 0xff;
  writeU16LE(out, OT_PAYLOAD_INDEX + 8, setup.crc);
  out[OT_PAYLOAD_INDEX + 11] = 1;
  out[OT_PAYLOAD_INDEX + 12] = setup.major & 0xff;
  out[OT_PAYLOAD_INDEX + 13] = setup.minor & 0xff;
  out[OT_PAYLOAD_INDEX + 14] = setup.build & 0xff;
  return out;
}

/** One kComFirmwareDataPacket: [3..4]=index LE, firmware chunk from [5]. */
export function otEncodeFirmwarePacket(index: number, chunk: Uint8Array, packetId = 0): Uint8Array {
  const out = new Uint8Array(OT_PACKET_SIZE);
  out[OT_COMTYPE_OFFSET] = OT_COMTYPE.firmwareDataPacket;
  out[OT_PACKET_ID_OFFSET] = packetId & 0xff;
  writeU16LE(out, OT_PAYLOAD_INDEX, index);
  out.set(chunk.subarray(0, OT_PACKET_SIZE - OT_PAYLOAD_INDEX - 2), OT_PAYLOAD_INDEX + 2);
  return out;
}

/** Split a firmware image into vendor-sized chunks. */
export function otFirmwarePackets(image: Uint8Array): { setup: OtFirmwareSetup; chunks: Uint8Array[] } {
  const chunkSize = OT_FW_CHUNK_SIZE;
  const packetCount = Math.trunc(image.length / chunkSize) + (image.length % chunkSize > 0 ? 1 : 0);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < packetCount; i += 1) {
    chunks.push(image.subarray(i * chunkSize, Math.min(image.length, (i + 1) * chunkSize)));
  }
  let crc = 0;
  for (const byte of image) crc = (crc + byte) & 0xffff;
  return {
    setup: { totalSize: image.length, packetCount, chunkSize, crc, major: 0, minor: 0, build: 0 },
    chunks,
  };
}

/** kComResetFirmware payload: 0x01 lead byte + 0x0BADF00D magic. */
export function otEncodeFirmwareReset(packetId = 0): Uint8Array {
  const out = new Uint8Array(OT_PACKET_SIZE);
  out[OT_COMTYPE_OFFSET] = OT_COMTYPE.resetFirmware;
  out[OT_PACKET_ID_OFFSET] = packetId & 0xff;
  out[OT_PAYLOAD_INDEX] = 0x01;
  OT_RESET_MAGIC.forEach((b, i) => { out[OT_PAYLOAD_INDEX + 1 + i] = b; });
  return out;
}

/** Normalize a 64-byte feature reply (report id 0 may or may not be included). */
export function otNormalizeFeatureReport(raw: Uint8Array): Uint8Array {
  if (raw.length === OT_PACKET_SIZE && raw[0] === OT_REPORT_ID) return raw;
  if (raw.length === OT_PACKET_SIZE - 1) {
    const out = new Uint8Array(OT_PACKET_SIZE);
    out.set(raw, 1);
    return out;
  }
  if (raw.length === OT_PACKET_SIZE + 1 && raw[0] === OT_REPORT_ID) return raw.subarray(1);
  const out = new Uint8Array(OT_PACKET_SIZE);
  out.set(raw.subarray(0, OT_PACKET_SIZE));
  return out;
}
