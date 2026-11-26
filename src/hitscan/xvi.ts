/**
 * Hitscan's web control protocol (control.hitscan.com, release
 * `1.0.15-fe600431`), recovered from the shipped `hitscan-device.js`,
 * `hitscan-input-codec.js`, `hitscan-inputs.js` and `vendor/xvi-20260924.min.js`.
 *
 * This is a different generation from the native `Hitscan Utility 1.0.2`
 * protocol in `./index.ts`: the web app talks to vendor id `0x3770` over
 * 64-byte feature report 0 with an `0xa1` status byte, while the native utility
 * uses report 8 output/input transfers and checksummed flash records. The two
 * share only the vendor id.
 *
 * Request layout (64 bytes, feature report id 0):
 *   `[0, 0, device, length, class, command, data...]`
 * Reply layout after `hitscanXviNormalize` (some platforms prepend report id 0):
 *   `[0xa1, 0, 0, length, class, command, payload...]`
 * `0xa1` is success, `0x02` means the mouse is asleep, `0x00` is not a status.
 *
 * The payload starts at byte 6 and usually echoes the request's first data
 * byte (the profile) before the value. Each decoder below documents the exact
 * offsets established by the vendor reply parsers. Nothing here has been
 * exercised on hardware; ranges and encodings are the vendor app's own.
 */
import { hitscanXviDecodeGbkName } from "./xvi-inputs.js";

/** Hit scan devices that speak the web protocol. `0x0300` is the shared dongle. */
export const HITSCAN_XVI_VENDOR_ID = 0x3770;
export interface HitscanXviProduct {
  model: "Hyperlight X" | "Hyperlight N" | null;
  transport: "wired" | "receiver";
}
export const HITSCAN_XVI_PRODUCTS: ReadonlyMap<number, HitscanXviProduct> = new Map([
  [0x0136, { model: "Hyperlight X", transport: "wired" }],
  [0x0194, { model: "Hyperlight N", transport: "wired" }],
  // The receiver answers for whichever mouse is paired; the mouse id comes
  // from the `GetDevicePID` reply.
  [0x0300, { model: null, transport: "receiver" }],
]);

export const HITSCAN_XVI_REPORT_ID = 0;
export const HITSCAN_XVI_PACKET_LENGTH = 64;
/** Mouse device id used in request byte 2 (`sdk.wiredMouseDeviceID`). */
export const HITSCAN_XVI_DEVICE_ID = 2;
/** The dongle answers its own firmware query with device id 0. */
export const HITSCAN_XVI_DONGLE_DEVICE_ID = 0;
export const HITSCAN_XVI_STATUS_OK = 0xa1;
export const HITSCAN_XVI_STATUS_ASLEEP = 0x02;
export const HITSCAN_XVI_NOTIFICATION_REPORT_ID = 4;

export const HITSCAN_XVI_MAX_PROFILES = 10;
export const HITSCAN_XVI_MAX_DPI_STAGES = 4;
/** The vendor reads and writes six RGB slots even on four-stage mice. */
export const HITSCAN_XVI_MAX_DPI_COLORS = 6;
export const HITSCAN_XVI_DPI_MIN = 50;
export const HITSCAN_XVI_DPI_MAX = 30_000;
export const HITSCAN_XVI_DPI_STEP = 50;
export const HITSCAN_XVI_MAX_MACROS = 20;
export const HITSCAN_XVI_MAX_MACRO_BYTES = 4096;
export const HITSCAN_XVI_TIMING_MAX_MS = 50;
export const HITSCAN_XVI_ANGLE_LIMIT = 30;

/** `RATE_IDS` in hitscan-device.js. 16 is also read back as 1 kHz. */
export const HITSCAN_XVI_POLLING_CODES: ReadonlyMap<number, number> = new Map([
  [125, 8], [250, 4], [500, 2], [1000, 1], [2000, 32], [4000, 64], [8000, 128],
]);
/** The app's polling picker offers these on both the cable and the receiver. */
export const HITSCAN_XVI_POLLING_RATES: readonly number[] = [500, 1000, 2000, 4000, 8000];
export const HITSCAN_XVI_LIFT_OFF_MILLIMETRES: readonly number[] = [0.7, 1, 2];
/** Auto-sleep picker in the web app, seconds. 0/0xff00/0xffff read as "never". */
export const HITSCAN_XVI_SLEEP_OPTIONS: readonly number[] = [10, 30, 60, 300, 600];
export const HITSCAN_XVI_SLEEP_NEVER = 0xffff;

/** Request classes (`request[4]`). */
export const HITSCAN_XVI_CLASS = {
  config: 0,
  sensor: 1,
  color: 2,
  button: 3,
  macro: 4,
} as const;

/** Command bytes (`request[5]`). A value may repeat across classes. */
export const HITSCAN_XVI_COMMAND = {
  profileSet: 0x05,
  profileGet: 0x85,
  profileList: 0x86,
  profileNameSet: 0x0e,
  profileNameGet: 0x8e,
  resetProfile: 0x0d,
  firmware: 0x81,
  battery: 0x83,
  signal: 0xa7,
  devicePid: 0x8b,
  pollingSet: 0x00,
  pollingGet: 0x80,
  sleepSet: 0x07,
  sleepGet: 0x87,
  liftOffSet: 0x08,
  liftOffGet: 0x88,
  dpiStagesSet: 0x01,
  dpiStagesGet: 0x81,
  dpiStageSet: 0x02,
  dpiStageGet: 0x82,
  dpiMax: 0x8c,
  colorsSet: 0x01,
  colorsGet: 0x81,
  splitDpiSet: 0x0d,
  splitDpiGet: 0x8d,
  angleSet: 0x14,
  angleGet: 0x94,
  motionSyncSet: 0x09,
  motionSyncGet: 0x89,
  hyperModeSet: 0x0b,
  hyperModeGet: 0x8b,
  trackingModeSet: 0x13,
  trackingModeGet: 0x93,
  spdtSet: 0x03,
  spdtGet: 0x83,
  scrollHighPerformanceSet: 0x19,
  scrollHighPerformanceGet: 0x99,
  timingsSet: 0x08,
  timingsGet: 0x88,
  buttonSet: 0x00,
  buttonGet: 0x80,
  macroAllocate: 0x01,
  macroSize: 0x81,
  macroDataSet: 0x03,
  macroDataGet: 0x83,
  macroNameSet: 0x06,
  macroNameGet: 0x86,
  macroList: 0x85,
  macroDelete: 0x02,
} as const;

type Bytes = Uint8Array | readonly number[];

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Invalid Hitscan ${label}: ${value}.`);
}
function checkedBytes(data: Bytes): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(data);
  for (const byte of bytes) integer(byte, 0, 255, "byte");
  return bytes;
}
function profile(value: number): void {
  integer(value, 1, HITSCAN_XVI_MAX_PROFILES, "profile");
}
function rate(value: number): void {
  integer(value, 0, 255, "rate code");
}

/** `[0, 0, device, length, class, command, data...]`, zero padded to 64 bytes. */
export function hitscanXviFrame(
  length: number,
  commandClass: number,
  command: number,
  data: Bytes = [],
  deviceId: number = HITSCAN_XVI_DEVICE_ID,
): Uint8Array<ArrayBuffer> {
  integer(length, 0, HITSCAN_XVI_PACKET_LENGTH - 2, "length");
  integer(commandClass, 0, 255, "class");
  integer(command, 0, 255, "command");
  integer(deviceId, 0, 255, "device id");
  const payload = checkedBytes(data);
  if (payload.length > HITSCAN_XVI_PACKET_LENGTH - 6) throw new RangeError("Hitscan request payload exceeds 58 bytes.");
  const packet = new Uint8Array(HITSCAN_XVI_PACKET_LENGTH);
  packet.set([deviceId, length, commandClass, command, ...payload], 2);
  return packet;
}

/** Drops a platform-prepended report-id byte so reply[0] is the status. */
export function hitscanXviNormalize(reply: Bytes): Uint8Array<ArrayBuffer> {
  const bytes = checkedBytes(reply);
  return bytes.length > HITSCAN_XVI_PACKET_LENGTH || bytes[0] === HITSCAN_XVI_REPORT_ID
    ? bytes.slice(1)
    : bytes;
}

/**
 * Normalizes and validates a reply against the request's class and command.
 * Returns null for stale, malformed or mismatched replies; the caller decides
 * whether an `0x02` status means "asleep".
 */
export function hitscanXviReply(reply: Bytes, request?: Bytes): Uint8Array<ArrayBuffer> | null {
  const bytes = hitscanXviNormalize(reply);
  if (bytes.length < 6) return null;
  if (bytes[0] !== HITSCAN_XVI_STATUS_OK && bytes[0] !== HITSCAN_XVI_STATUS_ASLEEP) return null;
  if (request) {
    const sent = checkedBytes(request);
    if (bytes[4] !== sent[4] || bytes[5] !== sent[5]) return null;
  }
  return bytes;
}

/** Valid `0xa1` reply for `class`/`command`, or null. */
export function hitscanXviDecode(reply: Bytes, commandClass: number, command: number): Uint8Array<ArrayBuffer> | null {
  const bytes = hitscanXviReply(reply);
  if (!bytes || bytes[0] !== HITSCAN_XVI_STATUS_OK) return null;
  if (bytes[4] !== commandClass || bytes[5] !== command) return null;
  return bytes.subarray(6);
}

/** Signed angle byte to degrees. */
export function hitscanXviDecodeAngleByte(value: number): number {
  integer(value, 0, 255, "angle byte");
  return value > 127 ? value - 256 : value;
}

export function hitscanXviEncodeAngle(degrees: number): number {
  integer(degrees, -HITSCAN_XVI_ANGLE_LIMIT, HITSCAN_XVI_ANGLE_LIMIT, "angle");
  return degrees < 0 ? 256 + degrees : degrees;
}

/** Lift-off distance: fractional millimetres use `value | 0x80` with tenths. */
export function hitscanXviEncodeLiftOff(millimetres: number): number {
  if (!HITSCAN_XVI_LIFT_OFF_MILLIMETRES.includes(millimetres)) {
    throw new RangeError("Hitscan lift-off distance must be 0.7, 1 or 2 mm.");
  }
  return millimetres >= 1 ? millimetres : Math.round(millimetres * 10) | 0x80;
}

export function hitscanXviDecodeLiftOffByte(value: number): number | null {
  if (!Number.isInteger(value) || value < 0 || value > 255) return null;
  const millimetres = (value & 0x80) !== 0 ? (value & 0x7f) / 10 : value;
  return HITSCAN_XVI_LIFT_OFF_MILLIMETRES.includes(millimetres) ? millimetres : null;
}

export function hitscanXviEncodePollingRate(hz: number): number {
  const code = HITSCAN_XVI_POLLING_CODES.get(hz);
  if (code === undefined) throw new RangeError(`Unsupported Hitscan polling rate: ${hz} Hz.`);
  return code;
}

/** `16` is the receiver's alternate 1 kHz code, exactly as the vendor app maps it. */
export function hitscanXviDecodePollingRateCode(code: number): number | null {
  if (code === 16) return 1000;
  return [...HITSCAN_XVI_POLLING_CODES].find(([, value]) => value === code)?.[0] ?? null;
}

function word(high: number, low: number): number {
  return (high << 8) | low;
}
function splitWord(value: number): [number, number] {
  return [value >> 8, value & 0xff];
}
function offsetWord(bytes: Uint8Array, at: number): number {
  return word(bytes[at] ?? 0, bytes[at + 1] ?? 0);
}

/* ------------------------------------------------------------------ reads */

export function hitscanXviFirmwareRequest(deviceId: number = HITSCAN_XVI_DEVICE_ID): Uint8Array<ArrayBuffer> {
  return hitscanXviFrame(16, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.firmware, [], deviceId);
}

export function hitscanXviBatteryRequest(): Uint8Array<ArrayBuffer> {
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.battery);
}

export function hitscanXviSignalRequest(): Uint8Array<ArrayBuffer> {
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.signal);
}

/** Device id 1 and a trailing `2`: the vendor's `GetDevicePID` constructor. */
export function hitscanXviDevicePidRequest(): Uint8Array<ArrayBuffer> {
  return hitscanXviFrame(6, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.devicePid, [2], 1);
}

export function hitscanXviProfileListRequest(): Uint8Array<ArrayBuffer> {
  return hitscanXviFrame(1, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileList);
}

export function hitscanXviProfileGetRequest(): Uint8Array<ArrayBuffer> {
  return hitscanXviFrame(1, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileGet);
}

export function hitscanXviProfileSetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(1, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileSet, [profileId]);
}

export function hitscanXviProfileNameGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(58, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileNameGet, [profileId]);
}

export function hitscanXviProfileNameSetRequest(profileId: number, nameBytes: Bytes): Uint8Array<ArrayBuffer> {
  profile(profileId);
  const bytes = checkedBytes(nameBytes);
  if (bytes.length > 56) throw new RangeError("Hitscan profile names are at most 56 encoded bytes.");
  return hitscanXviFrame(bytes.length + 2, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileNameSet, [
    profileId, bytes.length, ...bytes,
  ]);
}

export function hitscanXviResetProfileRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(1, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.resetProfile, [profileId]);
}

export function hitscanXviPollingRateGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.pollingGet, [profileId]);
}

export function hitscanXviPollingRateSetRequest(profileId: number, hz: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.pollingSet, [
    profileId, hitscanXviEncodePollingRate(hz),
  ]);
}

export function hitscanXviSleepGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(3, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.sleepGet, [profileId]);
}

/** `seconds === null` writes the "never" sentinel. */
export function hitscanXviSleepSetRequest(profileId: number, seconds: number | null): Uint8Array<ArrayBuffer> {
  profile(profileId);
  if (seconds !== null) integer(seconds, 0, 0xfffe, "sleep seconds");
  const value = seconds === null ? HITSCAN_XVI_SLEEP_NEVER : seconds;
  return hitscanXviFrame(3, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.sleepSet, [
    profileId, ...splitWord(value),
  ]);
}

export function hitscanXviLiftOffGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.liftOffGet, [profileId]);
}

export function hitscanXviLiftOffSetRequest(profileId: number, millimetres: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.liftOffSet, [
    profileId, hitscanXviEncodeLiftOff(millimetres),
  ]);
}

export interface HitscanXviDpiStage {
  x: number;
  y: number;
}

function dpiValue(value: number): void {
  integer(value, HITSCAN_XVI_DPI_MIN, HITSCAN_XVI_DPI_MAX, "DPI");
  if (value % HITSCAN_XVI_DPI_STEP !== 0) throw new RangeError("Hitscan DPI must use 50-DPI steps.");
}

export function hitscanXviDpiStagesGetRequest(profileId: number, capacity = 6): Uint8Array<ArrayBuffer> {
  profile(profileId);
  integer(capacity, 1, 6, "DPI stage capacity");
  return hitscanXviFrame(10, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.dpiStagesGet, [profileId, capacity]);
}

/** `[2, 26, 1, 1, profile, count, x/y pairs...]`; the length byte stays 26. */
export function hitscanXviDpiStagesSetRequest(profileId: number, stages: readonly HitscanXviDpiStage[]): Uint8Array<ArrayBuffer> {
  profile(profileId);
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > HITSCAN_XVI_MAX_DPI_STAGES) {
    throw new RangeError(`Hitscan takes 1-${HITSCAN_XVI_MAX_DPI_STAGES} DPI stages.`);
  }
  const data: number[] = [profileId, stages.length];
  for (const stage of stages) {
    dpiValue(stage.x); dpiValue(stage.y);
    data.push(...splitWord(stage.x), ...splitWord(stage.y));
  }
  return hitscanXviFrame(26, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.dpiStagesSet, data);
}

export function hitscanXviActiveStageGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.dpiStageGet, [profileId]);
}

/** `stage` is 1-based, matching the firmware. */
export function hitscanXviActiveStageSetRequest(profileId: number, stage: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  integer(stage, 1, HITSCAN_XVI_MAX_DPI_STAGES, "DPI stage");
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.dpiStageSet, [profileId, stage]);
}

export function hitscanXviDpiMaxRequest(): Uint8Array<ArrayBuffer> {
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.dpiMax);
}

export function hitscanXviDpiColorsGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(19, HITSCAN_XVI_CLASS.color, HITSCAN_XVI_COMMAND.colorsGet, [profileId]);
}

/** `rgb` is 18 bytes: six RGB triplets, one per stage slot. */
export function hitscanXviDpiColorsSetRequest(profileId: number, rgb: Bytes): Uint8Array<ArrayBuffer> {
  profile(profileId);
  const bytes = checkedBytes(rgb);
  if (bytes.length !== HITSCAN_XVI_MAX_DPI_COLORS * 3) {
    throw new RangeError("Hitscan stage colours are six RGB triplets (18 bytes).");
  }
  return hitscanXviFrame(19, HITSCAN_XVI_CLASS.color, HITSCAN_XVI_COMMAND.colorsSet, [profileId, ...bytes]);
}

export function hitscanXviSplitDpiGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.splitDpiGet, [profileId]);
}

export function hitscanXviSplitDpiSetRequest(profileId: number, enabled: boolean): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.splitDpiSet, [profileId, enabled ? 1 : 0]);
}

export function hitscanXviAngleGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.angleGet, [profileId]);
}

export function hitscanXviAngleSetRequest(profileId: number, degrees: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.angleSet, [
    profileId, hitscanXviEncodeAngle(degrees),
  ]);
}

export function hitscanXviFlagGetRequest(
  profileId: number,
  command: number,
): Uint8Array<ArrayBuffer> {
  profile(profileId);
  rate(command);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, command, [profileId]);
}

export function hitscanXviFlagSetRequest(
  profileId: number,
  command: number,
  enabled: boolean,
): Uint8Array<ArrayBuffer> {
  profile(profileId);
  rate(command);
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.sensor, command, [profileId, enabled ? 1 : 0]);
}

export function hitscanXviSpdtGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(3, HITSCAN_XVI_CLASS.button, HITSCAN_XVI_COMMAND.spdtGet, [profileId]);
}

/** The vendor SDK duplicates one flag; Hitscan's own adapter writes both. */
export function hitscanXviSpdtSetRequest(profileId: number, left: boolean, right: boolean): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(3, HITSCAN_XVI_CLASS.button, HITSCAN_XVI_COMMAND.spdtSet, [
    profileId, left ? 1 : 0, right ? 1 : 0,
  ]);
}

export function hitscanXviScrollHighPerformanceGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(4, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.scrollHighPerformanceGet, [profileId]);
}

/** `timeoutMs` is the vendor UI's 300 ms constant. */
export function hitscanXviScrollHighPerformanceSetRequest(
  profileId: number,
  enabled: boolean,
  timeoutMs = 300,
): Uint8Array<ArrayBuffer> {
  profile(profileId);
  integer(timeoutMs, 0, 0xffff, "scroll timeout");
  return hitscanXviFrame(4, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.scrollHighPerformanceSet, [
    profileId, enabled ? 1 : 0, ...splitWord(timeoutMs),
  ]);
}

export interface HitscanXviClickTimings {
  beforePress: number;
  beforeRelease: number;
  afterPress: number;
  afterRelease: number;
}

const TIMING_KEYS = ["beforePress", "beforeRelease", "afterPress", "afterRelease"] as const;

export function hitscanXviTimingsGetRequest(profileId: number): Uint8Array<ArrayBuffer> {
  profile(profileId);
  return hitscanXviFrame(6, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.timingsGet, [profileId, 0, 0, 0, 0, 0]);
}

/** Five payload bytes: four timings plus the vendor's trailing `3`. */
export function hitscanXviTimingsSetRequest(profileId: number, timings: HitscanXviClickTimings): Uint8Array<ArrayBuffer> {
  profile(profileId);
  const values = TIMING_KEYS.map((key) => {
    const value = timings[key];
    integer(value, 0, HITSCAN_XVI_TIMING_MAX_MS, key);
    return value;
  });
  return hitscanXviFrame(6, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.timingsSet, [profileId, ...values, 3]);
}

/** Physical button record ids: Left, Right, Middle, Forward, Back, DPI. */
export const HITSCAN_XVI_BUTTON_IDS: readonly number[] = [1, 2, 3, 5, 4, 0x14];
export const HITSCAN_XVI_BUTTON_NAMES: readonly string[] = ["Left", "Right", "Middle", "Forward", "Back", "DPI"];

export function hitscanXviButtonGetRequest(
  profileId: number,
  buttonId: number,
  length = 10,
): Uint8Array<ArrayBuffer> {
  profile(profileId);
  integer(buttonId, 0, 0x14, "button id");
  integer(length, 0, 53, "button data length");
  return hitscanXviFrame(5 + length, HITSCAN_XVI_CLASS.button, HITSCAN_XVI_COMMAND.buttonGet, [
    profileId, buttonId, 0, 0xff, length,
  ]);
}

export function hitscanXviButtonSetRequest(
  profileId: number,
  buttonId: number,
  functionId: number,
  data: Bytes,
): Uint8Array<ArrayBuffer> {
  profile(profileId);
  integer(buttonId, 0, 0x14, "button id");
  integer(functionId, 0, 255, "button function");
  const payload = checkedBytes(data);
  if (payload.length > 53) throw new RangeError("Hitscan button data exceeds 53 bytes.");
  return hitscanXviFrame(5 + payload.length, HITSCAN_XVI_CLASS.button, HITSCAN_XVI_COMMAND.buttonSet, [
    profileId, buttonId, 0, functionId, payload.length, ...payload,
  ]);
}

/* ----------------------------------------------------------------- macros */

export function hitscanXviMacroListRequest(capacity = HITSCAN_XVI_MAX_MACROS): Uint8Array<ArrayBuffer> {
  integer(capacity, 0, HITSCAN_XVI_MAX_MACROS, "macro capacity");
  return hitscanXviFrame(8, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroList, splitWord(capacity));
}

export function hitscanXviMacroSizeRequest(macroId: number): Uint8Array<ArrayBuffer> {
  integer(macroId, 1, 0xffff, "macro id");
  return hitscanXviFrame(6, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroSize, splitWord(macroId));
}

export function hitscanXviMacroAllocateRequest(macroId: number, size: number): Uint8Array<ArrayBuffer> {
  integer(macroId, 1, 0xffff, "macro id");
  integer(size, 0, 0xffffffff, "macro size");
  return hitscanXviFrame(6, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroAllocate, [
    ...splitWord(macroId), (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
  ]);
}

export function hitscanXviMacroDataSetRequest(
  macroId: number,
  offset: number,
  data: Bytes,
): Uint8Array<ArrayBuffer> {
  integer(macroId, 1, 0xffff, "macro id");
  integer(offset, 0, 0xffffffff, "macro offset");
  const bytes = checkedBytes(data);
  if (bytes.length > 51) throw new RangeError("Hitscan macro chunks are at most 51 bytes.");
  return hitscanXviFrame(7 + bytes.length, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroDataSet, [
    ...splitWord(macroId),
    (offset >>> 24) & 0xff, (offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff,
    bytes.length, ...bytes,
  ]);
}

export function hitscanXviMacroDataRequest(macroId: number, offset: number, length: number): Uint8Array<ArrayBuffer> {
  integer(macroId, 1, 0xffff, "macro id");
  integer(offset, 0, 0xffffffff, "macro offset");
  integer(length, 1, 50, "macro chunk length");
  return hitscanXviFrame(length + 7, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroDataGet, [
    ...splitWord(macroId),
    (offset >>> 24) & 0xff, (offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff,
    length,
  ]);
}

export function hitscanXviMacroNameRequest(macroId: number): Uint8Array<ArrayBuffer> {
  integer(macroId, 1, 0xffff, "macro id");
  return hitscanXviFrame(6, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroNameGet, [macroId, 56]);
}

export function hitscanXviMacroNameSetRequest(macroId: number, nameBytes: Bytes): Uint8Array<ArrayBuffer> {
  integer(macroId, 1, 0xffff, "macro id");
  const bytes = checkedBytes(nameBytes);
  if (bytes.length > 56) throw new RangeError("Hitscan macro names are at most 56 encoded bytes.");
  return hitscanXviFrame(bytes.length + 2, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroNameSet, [
    macroId, bytes.length, ...bytes,
  ]);
}

export function hitscanXviMacroDeleteRequest(macroId: number): Uint8Array<ArrayBuffer> {
  integer(macroId, 1, HITSCAN_XVI_MAX_MACROS, "macro id");
  return hitscanXviFrame(2, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroDelete, splitWord(macroId));
}

/* ---------------------------------------------------------------- decoders */

export function hitscanXviDecodeFirmware(reply: Bytes): string | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.firmware);
  if (!payload || payload.length < 4) return null;
  const version = `${payload[0]}.${payload[1]}.${payload[2]}.${payload[3]}`;
  return version === "0.0.0.0" ? null : version;
}

/** Payload byte 0 is the charging flag, byte 1 the percentage. */
export function hitscanXviDecodeBattery(reply: Bytes): { percent: number; charging: boolean } | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.battery);
  if (!payload || payload.length < 2) return null;
  const charging = payload[0];
  const percent = payload[1];
  if ((charging !== 0 && charging !== 1) || percent > 100) return null;
  return { percent, charging: charging === 1 };
}

/** Supplier levels are 1 = strong, 2 = medium, 3 = weak, 0 = unavailable. */
export function hitscanXviDecodeSignal(reply: Bytes): { level: 0 | 1 | 2 | 3; rssi: number } | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.signal);
  if (!payload || payload.length < 2) return null;
  const level = payload[0];
  if (level === undefined || level > 3) return null;
  return { level: level as 0 | 1 | 2 | 3, rssi: payload[1] };
}

/** PID at payload[4..5], VID at payload[2..3]. */
export function hitscanXviDecodeDevicePid(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.devicePid);
  if (!payload || payload.length < 6) return null;
  const pid = offsetWord(payload, 4);
  return pid === 0 ? null : pid;
}

export function hitscanXviDecodeProfileCount(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileList);
  const count = payload?.[0];
  return count !== undefined && count >= 1 && count <= HITSCAN_XVI_MAX_PROFILES ? count : null;
}

export function hitscanXviDecodeProfileId(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileGet);
  const id = payload?.[0];
  return id !== undefined && id >= 1 && id <= HITSCAN_XVI_MAX_PROFILES ? id : null;
}

/** Payload[0] is the profile echo, payload[1] the name length, then GBK bytes. */
export function hitscanXviDecodeProfileName(reply: Bytes): { id: number; name: string | null } | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.profileNameGet);
  if (!payload || payload.length < 2) return null;
  const id = payload[0];
  const length = payload[1];
  if (id === undefined || id < 1 || id > HITSCAN_XVI_MAX_PROFILES) return null;
  if (length === undefined || length > 56 || payload.length < 2 + length) return null;
  return { id, name: hitscanXviDecodeGbkName(payload.subarray(2, 2 + length)) };
}

export function hitscanXviDecodePollingRate(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.pollingGet);
  const code = payload?.[1];
  return code === undefined ? null : hitscanXviDecodePollingRateCode(code);
}

export function hitscanXviDecodeSleep(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.sleepGet);
  if (!payload || payload.length < 3) return null;
  const seconds = offsetWord(payload, 1);
  return seconds === 0 || seconds === 0xff00 || seconds === 0xffff ? null : seconds;
}

export function hitscanXviDecodeLiftOff(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.liftOffGet);
  const value = payload?.[1];
  return value === undefined ? null : hitscanXviDecodeLiftOffByte(value);
}

/**
 * Payload[1] is the stage count, then four bytes per stage from payload[2].
 * The vendor reads and writes X and Y independently.
 */
export function hitscanXviDecodeDpiStages(reply: Bytes): { stages: HitscanXviDpiStage[] } | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.dpiStagesGet);
  if (!payload || payload.length < 2) return null;
  const count = payload[1];
  if (count === undefined || count < 1 || count > 6 || payload.length < 2 + count * 4) return null;
  const stages: HitscanXviDpiStage[] = [];
  for (let index = 0; index < count; index++) {
    const x = offsetWord(payload, 2 + index * 4);
    const y = offsetWord(payload, 4 + index * 4);
    if (x < HITSCAN_XVI_DPI_MIN || x > HITSCAN_XVI_DPI_MAX || y < HITSCAN_XVI_DPI_MIN || y > HITSCAN_XVI_DPI_MAX) return null;
    stages.push({ x, y });
  }
  return { stages };
}

export function hitscanXviDecodeActiveStage(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.dpiStageGet);
  const stage = payload?.[1];
  return stage !== undefined && stage >= 1 && stage <= 6 ? stage : null;
}

export function hitscanXviDecodeDpiColors(reply: Bytes): string[] | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.color, HITSCAN_XVI_COMMAND.colorsGet);
  if (!payload || payload.length < 1 + HITSCAN_XVI_MAX_DPI_COLORS * 3) return null;
  return Array.from({ length: HITSCAN_XVI_MAX_DPI_COLORS }, (_, index) => {
    const at = 1 + index * 3;
    return `#${[0, 1, 2].map((channel) => (payload[at + channel] ?? 0).toString(16).padStart(2, "0")).join("")}`;
  });
}

export function hitscanXviDecodeSplitDpi(reply: Bytes): boolean | null {
  return hitscanXviDecodeFlag(reply, HITSCAN_XVI_COMMAND.splitDpiGet);
}

export function hitscanXviDecodeAngle(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.sensor, HITSCAN_XVI_COMMAND.angleGet);
  const value = payload?.[1];
  if (value === undefined) return null;
  const degrees = hitscanXviDecodeAngleByte(value);
  return Math.abs(degrees) <= HITSCAN_XVI_ANGLE_LIMIT ? degrees : null;
}

export function hitscanXviDecodeFlag(reply: Bytes, command: number): boolean | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.sensor, command);
  const value = payload?.[1];
  return value === 0 || value === 1 ? value === 1 : null;
}

export function hitscanXviDecodeSpdt(reply: Bytes): { left: boolean; right: boolean } | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.button, HITSCAN_XVI_COMMAND.spdtGet);
  if (!payload || payload.length < 3) return null;
  const left = payload[1];
  const right = payload[2];
  return left === 0 || left === 1 ? (right === 0 || right === 1 ? { left: left === 1, right: right === 1 } : null) : null;
}

export function hitscanXviDecodeScrollHighPerformance(reply: Bytes): boolean | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.scrollHighPerformanceGet);
  const value = payload?.[1];
  return value === 0 || value === 1 ? value === 1 : null;
}

export function hitscanXviDecodeTimings(reply: Bytes): HitscanXviClickTimings | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.config, HITSCAN_XVI_COMMAND.timingsGet);
  if (!payload || payload.length < 5) return null;
  const values = TIMING_KEYS.map((_key, index) => payload[1 + index]);
  if (values.some((value) => value === undefined || value > HITSCAN_XVI_TIMING_MAX_MS)) return null;
  return {
    beforePress: values[0]!,
    beforeRelease: values[1]!,
    afterPress: values[2]!,
    afterRelease: values[3]!,
  };
}

/** Payload: `[profile, button, 0, function, length, data...]`. */
export function hitscanXviDecodeButton(
  reply: Bytes,
): { profileId: number; buttonId: number; functionId: number; data: number[] } | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.button, HITSCAN_XVI_COMMAND.buttonGet);
  if (!payload || payload.length < 5) return null;
  const profileId = payload[0];
  const buttonId = payload[1];
  const functionId = payload[3];
  const length = payload[4];
  if (profileId === undefined || profileId < 1 || profileId > HITSCAN_XVI_MAX_PROFILES) return null;
  if (buttonId === undefined || functionId === undefined || length === undefined) return null;
  if (length > 53 || payload.length < 5 + length) return null;
  return { profileId, buttonId, functionId, data: Array.from(payload.subarray(5, 5 + length)) };
}

/** Payload[0..1] is the returned count, payload[4..] the ids. */
export function hitscanXviDecodeMacroIds(reply: Bytes): number[] | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroList);
  if (!payload || payload.length < 4) return null;
  const count = offsetWord(payload, 0);
  if (count > HITSCAN_XVI_MAX_MACROS || payload.length < 4 + count * 2) return null;
  const ids: number[] = [];
  for (let index = 0; index < count; index++) {
    const id = offsetWord(payload, 4 + index * 2);
    if (id > HITSCAN_XVI_MAX_MACROS) return null;
    if (id !== 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Payload[2..5] is a big-endian 32-bit byte count. */
export function hitscanXviDecodeMacroSize(reply: Bytes): number | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroSize);
  if (!payload || payload.length < 6) return null;
  const size = (payload[2]! * 0x1000000) + (payload[3]! << 16) + (payload[4]! << 8) + payload[5]!;
  return size <= 0x100000 ? size : null;
}

/** Payload: `[macro, length, GBK bytes...]`. */
export function hitscanXviDecodeMacroName(reply: Bytes): { id: number; bytes: number[] } | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroNameGet);
  if (!payload || payload.length < 2) return null;
  const id = payload[0];
  const length = payload[1];
  if (id === undefined || id < 1 || id > HITSCAN_XVI_MAX_MACROS) return null;
  if (length === undefined || length > 56 || payload.length < 2 + length) return null;
  return { id, bytes: Array.from(payload.subarray(2, 2 + length)) };
}

/** Validates the echoed id, offset and length before returning chunk bytes. */
export function hitscanXviDecodeMacroData(
  reply: Bytes,
  macroId: number,
  offset: number,
  length: number,
): number[] | null {
  const payload = hitscanXviDecode(reply, HITSCAN_XVI_CLASS.macro, HITSCAN_XVI_COMMAND.macroDataGet);
  if (!payload || payload.length < 7 + length) return null;
  const echoedId = offsetWord(payload, 0);
  const echoedOffset = (payload[2]! * 0x1000000) + (payload[3]! << 16) + (payload[4]! << 8) + payload[5]!;
  if (echoedId !== macroId || echoedOffset !== offset || payload[6] !== length) return null;
  return Array.from(payload.subarray(7, 7 + length));
}

/* ----------------------------------------------------------- notifications */

export type HitscanXviNotification =
  | { type: "signal"; level: 0 | 1 | 2 | 3; rssi: number }
  | { type: "sleep" }
  | { type: "wake" }
  | { type: "battery"; percent: number; charging: boolean }
  | { type: "profile" }
  | { type: "dpi"; stage: number; x: number; y: number }
  | { type: "liftOff"; millimetres: number }
  | { type: "polling"; hz: number }
  | { type: "unknown"; bytes: number[] };

/**
 * Input report 4 carries unsolicited state changes. WebHID strips the report id
 * on some platforms, so a leading `4` followed by a known type is dropped too.
 */
export function hitscanXviDecodeNotification(bytes: Bytes): HitscanXviNotification | null {
  let data = checkedBytes(bytes);
  if (data[0] === HITSCAN_XVI_NOTIFICATION_REPORT_ID && data.length > 1
      && [0x01, 0x02, 0x03, 0x06, 0x07, 0x08, 0x19].includes(data[1]!)) {
    data = data.slice(1);
  }
  const type = data[0];
  if (type === 0x19) {
    const rssi = data[1];
    const level = data[2];
    if (rssi === undefined || level === undefined || level > 3) return null;
    return { type: "signal", level: level as 0 | 1 | 2 | 3, rssi };
  }
  if (type === 0x06) {
    if (data[1] === 0) return { type: "sleep" };
    if (data[1] === 1) return { type: "wake" };
    return null;
  }
  if (type === 0x03) {
    const percent = data[1];
    const charging = data[2];
    if (percent === undefined || charging === undefined || percent > 100 || (charging !== 0 && charging !== 1)) return null;
    return { type: "battery", percent, charging: charging === 1 };
  }
  if (type === 0x02) return data.length >= 2 ? { type: "profile" } : null;
  if (type === 0x01) {
    if (data.length < 6) return null;
    const stage = data[1]! - 1;
    const x = word(data[2]!, data[3]!);
    const y = word(data[4]!, data[5]!);
    if (stage < 0 || x < HITSCAN_XVI_DPI_MIN || x > HITSCAN_XVI_DPI_MAX || y < HITSCAN_XVI_DPI_MIN || y > HITSCAN_XVI_DPI_MAX) return null;
    return { type: "dpi", stage, x, y };
  }
  if (type === 0x07) {
    const millimetres = data[1] === undefined ? null : hitscanXviDecodeLiftOffByte(data[1]);
    return millimetres === null ? null : { type: "liftOff", millimetres };
  }
  if (type === 0x08) {
    const hz = data[1] === undefined ? null : hitscanXviDecodePollingRateCode(data[1]);
    return hz === null ? null : { type: "polling", hz };
  }
  return { type: "unknown", bytes: Array.from(data) };
}
