/**
 * Pure encoding rules of Glorious's "core2" feature-report protocol, spoken by
 * the Model O 2 PRO 4K/8K (USB 0x258a:0x201b wired, 0x2035 receiver). It is
 * the classic Model O/D envelope (see ../glorious-classic/index.ts) with a
 * different register map, per-profile data, a polling-rate bitmask and one
 * polling byte per link.
 *
 * Evidence, in order of weight:
 * - A USBPcap capture of Glorious CORE on a wired unit
 *   (captures/glorious-o2-pro-4k8k-wired/). Every request in it is re-encoded
 *   byte for byte by core2-protocol.test.ts.
 * - The frame builders of Glorious CORE 2.1.21 itself (`MouseV2ProDeviceHandler`
 *   in its Electron main bundle, which also handles the Model O/D Wireless that
 *   korkje/mxw documents). They name every register below and fix the data
 *   layouts the capture only shows by example. Their device table lists this
 *   mouse as "MODEL O 2 PRO 4k/8kHz Edition", config channel usage page 0xffff,
 *   usage 0, DPI 100 to 26000, three profiles.
 * - https://github.com/korkje/mxw (envelope, profile select) and
 *   https://github.com/AMarcinkiewicz/GloriousAutoPollingRate (polling codes,
 *   measured on a Model D2 Pro 4K).
 *
 * Nothing here transports bytes; the WebHID client lives in
 * `src/drivers/glorious/core2-hid.ts`.
 *
 * Transport: unnumbered 64-byte feature reports (report id 0) on the interface
 * whose collection is usage page 0xffff, usage 0. A request is SET_REPORT; a
 * reply, when there is one, is the GET_REPORT that follows about 60 ms later.
 * There is no checksum.
 *
 * Request body, offsets without the report id:
 *
 *   [0..1] 00 00
 *   [2]    0x02, the mouse; CORE uses 0 only to read a receiver's own firmware
 *   [3]    length of the data that follows the register byte
 *   [4]    bank: 0 system, 1 per-profile settings, 2 per-profile lighting
 *   [5]    register
 *   [6..]  data; every per-profile register starts with the profile id
 *
 * A reply echoes [1..5] and puts its own data length at [3]. Byte [0] is a
 * status: 0xa1 ok, 0xa0 busy or waking up, 0xa2 command failed, 0xa4 receiver
 * cannot find the mouse. CORE sends the whole performance block (stages,
 * colors, lift-off, active stage, polling, debounce, motion sync) in that
 * order after any change, 30 ms apart and 120 ms after the active stage.
 */

export const GLORIOUS_CORE2_VENDOR_ID = 0x258a;
export const GLORIOUS_CORE2_USAGE_PAGE = 0xffff;
export const GLORIOUS_CORE2_REPORT_ID = 0;
export const GLORIOUS_CORE2_FRAME_LENGTH = 64;

export interface GloriousCore2Product {
  name: string;
  /** True for the 2.4 GHz receiver, false for the mouse on its cable. */
  wireless: boolean;
}

/** Product ids from Glorious CORE's device table. */
export const GLORIOUS_CORE2_PRODUCTS: ReadonlyMap<number, GloriousCore2Product> = new Map([
  [0x201b, { name: "Model O2 Pro 4K/8K", wireless: false }],
  [0x2035, { name: "Model O2 Pro 4K/8K Wireless receiver", wireless: true }],
]);

/** Profiles are numbered from 1 on the wire, the position of the profile in CORE's list. */
export const GLORIOUS_CORE2_PROFILE_COUNT = 3;
export const GLORIOUS_CORE2_PROFILE_DEFAULT = 1;
/** The profile CORE had selected when the capture was taken. */
export const GLORIOUS_CORE2_PROFILE_CAPTURED = 2;

const TARGET_MOUSE = 0x02;
const TARGET_RECEIVER = 0x00;
const HEADER_LENGTH = 6;

export const GLORIOUS_CORE2_BANK = { system: 0x00, profile: 0x01, lighting: 0x02 } as const;

/**
 * Registers by bank. `liftOff` is named after CORE's UI: it writes the same 1
 * for both of its 1.0 mm and 2.0 mm options, so the value-to-distance map is
 * not known and the codec has no encoder for it.
 */
export const GLORIOUS_CORE2_REGISTER = {
  profileSelect: 0x05,
  debounce: 0x08,
  motionSync: 0x09,
  pollingRate: 0x0a,
  liftOff: 0x0b,
  dpiStages: 0x01,
  activeDpiStage: 0x02,
  dpiColors: 0x01,
  firmware: 0x81,
  battery: 0x83,
} as const;

/** Reply status byte (CORE `SetAndCheckStatus`). */
export const GLORIOUS_CORE2_STATUS = { ok: 0xa1, busy: 0xa0, failed: 0xa2, asleep: 0xa4 } as const;

/** Builds one request. `length` defaults to the data length, which is what every captured write carries. */
export function gloriousCore2Request(
  bank: number,
  register: number,
  data: readonly number[] = [],
  length = data.length,
  target = TARGET_MOUSE,
): Uint8Array<ArrayBuffer> {
  if (HEADER_LENGTH + data.length > GLORIOUS_CORE2_FRAME_LENGTH) throw new RangeError("Glorious core2 data does not fit in one frame.");
  const body = new Uint8Array(GLORIOUS_CORE2_FRAME_LENGTH);
  body[2] = target;
  body[3] = length;
  body[4] = bank;
  body[5] = register;
  body.set(data, HEADER_LENGTH);
  return body;
}

export interface GloriousCore2Reply {
  status: number;
  bank: number;
  register: number;
  data: Uint8Array;
}

/** Splits a reply into its parts, or null when it is too short to be one. */
export function decodeGloriousCore2Reply(body: Uint8Array): GloriousCore2Reply | null {
  if (body.length < HEADER_LENGTH) return null;
  return {
    status: body[0]!,
    bank: body[4]!,
    register: body[5]!,
    data: body.subarray(HEADER_LENGTH, Math.min(body.length, HEADER_LENGTH + body[3]!)),
  };
}

function okReplyFor(body: Uint8Array, register: number): GloriousCore2Reply | null {
  const reply = decodeGloriousCore2Reply(body);
  return reply && reply.status === GLORIOUS_CORE2_STATUS.ok && reply.register === register ? reply : null;
}

// Reads: firmware and battery. The only two CORE ever issues.

/**
 * Reply data: firmware version a.b.c.d (4 bytes), then the wired product id
 * (u16 BE). CORE addresses the mouse over the cable and the receiver itself
 * (target 0) over the 2.4 GHz link; only the cable case was captured.
 */
export function encodeGloriousCore2FirmwareRequest(target: "mouse" | "receiver" = "mouse"): Uint8Array<ArrayBuffer> {
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.system, GLORIOUS_CORE2_REGISTER.firmware, [], 3, target === "mouse" ? TARGET_MOUSE : TARGET_RECEIVER);
}

export interface GloriousCore2Firmware {
  /** "1.0.15.0" for the unit that was captured. */
  version: string;
  /** Absent when the reply is too short to carry it. */
  productId: number | null;
}

export function decodeGloriousCore2Firmware(body: Uint8Array): GloriousCore2Firmware | null {
  const reply = okReplyFor(body, GLORIOUS_CORE2_REGISTER.firmware);
  if (!reply || reply.data.length < 4) return null;
  const [a, b, c, d, high, low] = reply.data as unknown as number[];
  return { version: `${a}.${b}.${c}.${d}`, productId: reply.data.length >= 6 ? (high! << 8) | low! : null };
}

/** Reply data: charging flag (1 = charging), then percent. */
export function encodeGloriousCore2BatteryRequest(): Uint8Array<ArrayBuffer> {
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.system, GLORIOUS_CORE2_REGISTER.battery, [], 2);
}

export interface GloriousCore2Battery {
  percent: number;
  charging: boolean;
}

/** Null while the mouse is asleep or waking up, or when the percent byte is not a percentage. */
export function decodeGloriousCore2Battery(body: Uint8Array): GloriousCore2Battery | null {
  const reply = okReplyFor(body, GLORIOUS_CORE2_REGISTER.battery);
  if (!reply || reply.data.length < 2) return null;
  // CORE and mxw both show a raw 0 as 1 %.
  const percent = reply.data[1] === 0 ? 1 : reply.data[1]!;
  return percent <= 100 ? { percent, charging: reply.data[0] === 1 } : null;
}

// Profile select. Not in the capture (CORE had already selected profile 2);
// the frame is CORE's `PrepareChangeProfileBuffer` and mxw's `profile::set`.

function assertProfile(profile: number): void {
  if (!Number.isInteger(profile) || profile < 1 || profile > GLORIOUS_CORE2_PROFILE_COUNT) {
    throw new RangeError(`Glorious core2 profile must be 1 to ${GLORIOUS_CORE2_PROFILE_COUNT}.`);
  }
}

export function encodeGloriousCore2Profile(profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.system, GLORIOUS_CORE2_REGISTER.profileSelect, [profile]);
}

// DPI stages, their LED colors and the active stage.

export const GLORIOUS_CORE2_MAX_DPI_STAGES = 6;
export const GLORIOUS_CORE2_DPI_MIN = 100;
export const GLORIOUS_CORE2_DPI_MAX = 26_000;
/** CORE accepts any value in range; 50 is the step the other Glorious drivers here use. */
export const GLORIOUS_CORE2_DPI_STEP = 50;

/**
 * Stage table: profile, stage count, then per stage DPI X and DPI Y as u16
 * big-endian. CORE always writes X equal to Y. The mouse reports the same
 * layout when a stage is selected with the DPI button (input report 4 on
 * interface 1: 01, stage, X, Y).
 */
export function encodeGloriousCore2DpiStages(stages: readonly number[], profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  if (stages.length < 1 || stages.length > GLORIOUS_CORE2_MAX_DPI_STAGES) throw new RangeError(`Glorious core2 takes 1 to ${GLORIOUS_CORE2_MAX_DPI_STAGES} DPI stages.`);
  const data = [profile, stages.length];
  for (const dpi of stages) {
    if (!Number.isInteger(dpi) || dpi < GLORIOUS_CORE2_DPI_MIN || dpi > GLORIOUS_CORE2_DPI_MAX) {
      throw new RangeError(`Glorious core2 DPI must be ${GLORIOUS_CORE2_DPI_MIN} to ${GLORIOUS_CORE2_DPI_MAX}.`);
    }
    data.push(dpi >> 8, dpi & 0xff, dpi >> 8, dpi & 0xff);
  }
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.dpiStages, data);
}

/**
 * Stage LED colors: profile, then six RGB triplets whatever the stage count,
 * unused slots zero. CORE's factory colors are orange, light blue, red, green.
 */
export function encodeGloriousCore2DpiColors(colors: readonly string[], profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  if (colors.length > GLORIOUS_CORE2_MAX_DPI_STAGES) throw new RangeError(`Glorious core2 has ${GLORIOUS_CORE2_MAX_DPI_STAGES} stage colors.`);
  const data = [profile];
  for (let slot = 0; slot < GLORIOUS_CORE2_MAX_DPI_STAGES; slot += 1) {
    const color = colors[slot];
    if (color === undefined) {
      data.push(0, 0, 0);
      continue;
    }
    const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
    if (!match) throw new RangeError(`Glorious core2 color must be #rrggbb, got ${color}.`);
    const rgb = Number.parseInt(match[1]!, 16);
    data.push(rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff);
  }
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.lighting, GLORIOUS_CORE2_REGISTER.dpiColors, data);
}

/** `stageIndex` is 0-based here; the mouse counts stages from 1. */
export function encodeGloriousCore2ActiveDpiStage(stageIndex: number, profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= GLORIOUS_CORE2_MAX_DPI_STAGES) throw new RangeError("Glorious core2 DPI stage index is out of range.");
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.activeDpiStage, [profile, stageIndex + 1]);
}

// Polling rate: a bitmask code per rate, one for the cable and one for 2.4 GHz.

/**
 * Codes are not a scale (0x10 is unused). They are CORE's own table; 125 to
 * 4000 Hz were also confirmed by counting input reports on a Model D2 Pro 4K
 * (GloriousAutoPollingRate).
 */
export const GLORIOUS_CORE2_POLLING_CODES: ReadonlyArray<readonly [hertz: number, code: number]> = [
  [125, 0x08],
  [250, 0x04],
  [500, 0x02],
  [1000, 0x01],
  [2000, 0x20],
  [4000, 0x40],
  [8000, 0x80],
];

/** 8000 Hz needs the cable; CORE writes 4000 Hz for the 2.4 GHz link in that case. */
export const GLORIOUS_CORE2_WIRELESS_MAX_POLLING_HZ = 4000;

export function gloriousCore2PollingCode(hertz: number): number | null {
  return GLORIOUS_CORE2_POLLING_CODES.find(([rate]) => rate === hertz)?.[1] ?? null;
}

/**
 * Data: profile, cable code, 2.4 GHz code. For one chosen rate CORE sends it
 * twice, except 8000 Hz, whose 2.4 GHz byte is 4000 Hz. The capture also has
 * one frame with 8000 Hz in both bytes, written while CORE's list held two
 * rates; this encoder builds it, the client never does.
 */
export function encodeGloriousCore2PollingRate(wiredHz: number, wirelessHz: number, profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  const wired = gloriousCore2PollingCode(wiredHz);
  const wireless = gloriousCore2PollingCode(wirelessHz);
  if (wired === null || wireless === null) throw new RangeError(`Glorious core2 has no polling code for ${wired === null ? wiredHz : wirelessHz} Hz.`);
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.pollingRate, [profile, wired, wireless]);
}

// Debounce: one block of six bytes, either a single time or five advanced ones.

/** The product page gives 4 to 16 ms, 10 ms by default; CORE's slider moves in steps of 2. */
export const GLORIOUS_CORE2_DEBOUNCE_MIN_MS = 4;
export const GLORIOUS_CORE2_DEBOUNCE_MAX_MS = 16;
export const GLORIOUS_CORE2_DEBOUNCE_STEP_MS = 2;
export const GLORIOUS_CORE2_DEBOUNCE_DEFAULT_MS = 10;

/** Simple mode, which also clears the advanced times: profile, ms, five zeros. */
export function encodeGloriousCore2Debounce(milliseconds: number, profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > GLORIOUS_CORE2_DEBOUNCE_MAX_MS) {
    throw new RangeError(`Glorious core2 debounce must be 0 to ${GLORIOUS_CORE2_DEBOUNCE_MAX_MS} ms.`);
  }
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.system, GLORIOUS_CORE2_REGISTER.debounce, [profile, milliseconds, 0, 0, 0, 0, 0]);
}

export interface GloriousCore2AdvancedDebounce {
  beforePress: number;
  beforeRelease: number;
  afterPress: number;
  afterRelease: number;
  liftOffPress: number;
}

/** CORE's defaults are 0, 0, 10, 10, 8. Not offered by the client. */
export function encodeGloriousCore2AdvancedDebounce(times: GloriousCore2AdvancedDebounce, profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  const values = [times.beforePress, times.beforeRelease, times.afterPress, times.afterRelease, times.liftOffPress];
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > GLORIOUS_CORE2_DEBOUNCE_MAX_MS)) {
    throw new RangeError(`Glorious core2 debounce must be 0 to ${GLORIOUS_CORE2_DEBOUNCE_MAX_MS} ms.`);
  }
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.system, GLORIOUS_CORE2_REGISTER.debounce, [profile, ...values, 0]);
}

// Motion sync. Glorious advises turning it off at 8000 Hz.

export function encodeGloriousCore2MotionSync(enabled: boolean, profile: number): Uint8Array<ArrayBuffer> {
  assertProfile(profile);
  return gloriousCore2Request(GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.motionSync, [profile, enabled ? 1 : 0]);
}
