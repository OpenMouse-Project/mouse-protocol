/**
 * Tt eSPORTS (Thermaltake) Iris Optical RGB (`264a:1019`), including the
 * Hatsune Miku Edition, which is the same mouse in a different shell and
 * enumerates with the same IDs and product string.
 *
 * Framing comes from a static decode of the vendor's "Command Center Pro"
 * (Iris module, HIDLib) and was checked read-only against a Miku Edition
 * (firmware byte 0x80, bcdDevice 0x6901) before any write:
 *
 * - Everything goes through one top-level collection on interface 1 with
 *   usage page 0x08 (LED), usage 0x4B. Every feature report on it is 2052
 *   bytes after the report id.
 * - Report 0x0C carries commands. `C4 xx` are actions (`C4 08` firmware,
 *   `C4 0C p` select profile p for reading, `C4 10` open a flash write,
 *   `C4 00` close it), `DF 0D` reads the profile register and `DE 0D` writes
 *   it. The reply to a 0x0C read starts with the status byte 0xB0 where the
 *   report id would be.
 * - Report 0x05 is a whole 2048-byte onboard profile:
 *   `[status 0xB0 on read / 0x00 on write, profile, checksum, data[2048], pad]`.
 *   The checksum makes bytes 3..2052 sum to zero modulo 256.
 *
 * Profile layout (offsets into the 2048 data bytes):
 *
 * | Offset | Meaning |
 * | --- | --- |
 * | 0 | Polling code: 8 = 125 Hz, 4 = 250, 2 = 500, 1 = 1000, 0x10 = 1500, 0 = 2000 |
 * | 2 | Bit 7: angle snapping |
 * | 4 | Button response (debounce): `ms - 7`, 1..25 for 8..32 ms |
 * | 8 | High nibble: number of DPI stages (1..4); low nibble: active stage |
 * | 9..12 | DPI per stage in hundreds (1..50, so 100..5000) |
 * | 160..1898 | Lighting |
 * | 2001.. | Profile name, length byte then UTF-16LE |
 */

export const THERMALTAKE_VENDOR_ID = 0x264a;
export const THERMALTAKE_IRIS_PRODUCT_ID = 0x1019;
export const THERMALTAKE_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [THERMALTAKE_IRIS_PRODUCT_ID, "Tt eSPORTS Iris Optical RGB"],
]);
export const THERMALTAKE_PRODUCT_IDS: readonly number[] = [...THERMALTAKE_PRODUCT_NAMES.keys()];

/** The configuration collection: LED page, Generic Indicator usage. */
export const THERMALTAKE_CONFIG_USAGE_PAGE = 0x0008;
export const THERMALTAKE_CONFIG_USAGE = 0x004b;

export const THERMALTAKE_REPORT_ID = {
  command: 0x0c,
  profile: 0x05,
} as const;
/** Bytes after the report id in every feature report on the config collection. */
export const THERMALTAKE_REPORT_SIZE = 2052;
/** Status byte the mouse puts in front of a successful reply. */
export const THERMALTAKE_STATUS_OK = 0xb0;

export const THERMALTAKE_PROFILE_COUNT = 5;
export const THERMALTAKE_PROFILE_SIZE = 2048;

export const THERMALTAKE_PROFILE_OFFSET = {
  polling: 0,
  angleSnapping: 2,
  debounce: 4,
  dpiLevels: 8,
  dpiTable: 9,
} as const;

export const THERMALTAKE_DPI_MIN = 100;
export const THERMALTAKE_DPI_MAX = 5000;
export const THERMALTAKE_DPI_STEP = 100;
export const THERMALTAKE_DPI_MAX_STAGES = 4;

export const THERMALTAKE_DEBOUNCE_MIN_MS = 8;
export const THERMALTAKE_DEBOUNCE_MAX_MS = 32;

/** Polling code to rate, in the order the vendor slider lists them. */
export const THERMALTAKE_POLLING_CODES: ReadonlyArray<readonly [number, number]> = [
  [0x08, 125],
  [0x04, 250],
  [0x02, 500],
  [0x01, 1000],
  [0x10, 1500],
  [0x00, 2000],
];
export const THERMALTAKE_POLLING_RATES: readonly number[] = THERMALTAKE_POLLING_CODES.map(([, hz]) => hz);

const REGISTER_PROFILE = 0x0d;
/** The profile register holds the profile count (5) in its high nibble. */
const PROFILE_REGISTER_BASE = THERMALTAKE_PROFILE_COUNT << 4;

/** A 0x0C command payload, zero-padded to the report size. */
export function thermaltakeEncodeCommand(bytes: readonly number[]): Uint8Array<ArrayBuffer> {
  if (bytes.length > THERMALTAKE_REPORT_SIZE) throw new RangeError("Thermaltake command is longer than the report.");
  const payload = new Uint8Array(THERMALTAKE_REPORT_SIZE);
  bytes.forEach((value, i) => { payload[i] = value & 0xff; });
  return payload;
}

function checkProfileIndex(profile: number): void {
  if (!Number.isInteger(profile) || profile < 0 || profile >= THERMALTAKE_PROFILE_COUNT) {
    throw new RangeError(`Thermaltake profile ${profile} is out of range.`);
  }
}

export const thermaltakeCommands = {
  readFirmware: (): Uint8Array<ArrayBuffer> => thermaltakeEncodeCommand([0xc4, 0x08, 0x00, 0x00]),
  /** Select a profile; the next 0x05 read returns it. */
  readProfile: (profile: number): Uint8Array<ArrayBuffer> => {
    checkProfileIndex(profile);
    return thermaltakeEncodeCommand([0xc4, 0x0c, profile, 0x00]);
  },
  beginWrite: (): Uint8Array<ArrayBuffer> => thermaltakeEncodeCommand([0xc4, 0x10, 0x00, 0x00, 0x00]),
  endWrite: (): Uint8Array<ArrayBuffer> => thermaltakeEncodeCommand([0xc4, 0x00, 0x00, 0x00, 0x00]),
  readActiveProfile: (): Uint8Array<ArrayBuffer> => thermaltakeEncodeCommand([0xdf, REGISTER_PROFILE, 0x00, 0x00, 0x00]),
  writeActiveProfile: (profile: number): Uint8Array<ArrayBuffer> => {
    checkProfileIndex(profile);
    return thermaltakeEncodeCommand([0xde, REGISTER_PROFILE, 0x00, 0x00, PROFILE_REGISTER_BASE + profile]);
  },
} as const;

/**
 * A reply laid out as the vendor tool sees it: index 0 is the report id slot,
 * then the 2052 report bytes. Transports differ: WebHID keeps the leading
 * byte (2053 bytes), others drop it, and OpenMouse Bridge also stops where
 * the device's transfer ended (7 bytes for a 0x0C reply, 2051 for a profile).
 * Anything shorter than the full report is taken to start after the id slot
 * and is zero-padded. Null for an empty or oversized reply.
 */
export function thermaltakeNormalizeReply(reportId: number, reply: Uint8Array): Uint8Array | null {
  if (reply.length === THERMALTAKE_REPORT_SIZE + 1) return reply;
  if (reply.length === 0 || reply.length > THERMALTAKE_REPORT_SIZE) return null;
  const full = new Uint8Array(THERMALTAKE_REPORT_SIZE + 1);
  full[0] = reportId;
  full.set(reply, 1);
  return full;
}

/**
 * The mouse interface (interface 0, Generic Desktop Mouse) carries a second,
 * unnumbered 8-byte vendor feature report (page 0xFF00, usage 0x80). Unlike
 * the config collection it declares real items, so Chrome on Windows exposes
 * it, and the firmware feeds it to the same command parser: `C4 08`, `DF xx`
 * and `DE 0D` answer there exactly as on report 0x0C, truncated to 8 bytes.
 * Profile blocks need the 2052-byte report and cannot travel this way.
 */
export const THERMALTAKE_SHORT_REPORT_ID = 0;
export const THERMALTAKE_SHORT_REPORT_SIZE = 8;
export const THERMALTAKE_SHORT_USAGE_PAGE = 0xff00;
export const THERMALTAKE_SHORT_USAGE = 0x80;

/** The first 8 bytes of a command, for the short channel. */
export function thermaltakeShortCommand(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (payload.subarray(THERMALTAKE_SHORT_REPORT_SIZE).some((byte) => byte !== 0)) {
    throw new RangeError("Thermaltake command does not fit the 8-byte report.");
  }
  return payload.slice(0, THERMALTAKE_SHORT_REPORT_SIZE);
}

/** Which report a command reply came back on. */
export type ThermaltakeChannel = "config" | "short";

/**
 * A command reply with its status slot at index 0, whichever channel it came
 * from: the 0x0C report writes its status over the report id slot, and the
 * short report puts it first after an optional leading id byte.
 */
function commandFrame(reply: Uint8Array, channel: ThermaltakeChannel): Uint8Array | null {
  if (channel === "config") return thermaltakeNormalizeReply(THERMALTAKE_REPORT_ID.command, reply);
  if (reply.length === THERMALTAKE_SHORT_REPORT_SIZE + 1) return reply.subarray(1);
  return reply.length === THERMALTAKE_SHORT_REPORT_SIZE ? reply : null;
}

/** Firmware byte from a `C4 08` reply (`B0 55 AA <version>`), or null. */
export function thermaltakeDecodeFirmware(reply: Uint8Array, channel: ThermaltakeChannel = "config"): number | null {
  const full = commandFrame(reply, channel);
  if (!full || full[1] !== 0x55 || full[2] !== 0xaa) return null;
  return full[3]!;
}

/** Zero-based active profile from a `DF 0D` reply, or null when it does not look like one. */
export function thermaltakeDecodeActiveProfile(reply: Uint8Array, channel: ThermaltakeChannel = "config"): number | null {
  const full = commandFrame(reply, channel);
  if (!full || full[2] !== REGISTER_PROFILE) return null;
  const count = full[5]! >> 4;
  const active = full[5]! & 0x0f;
  return count === THERMALTAKE_PROFILE_COUNT && active < count ? active : null;
}

/** Two's complement of the byte sum, so the block plus checksum sums to zero. */
export function thermaltakeChecksum(data: Uint8Array): number {
  let sum = 0;
  for (const byte of data) sum += byte;
  return (0x100 - (sum & 0xff)) & 0xff;
}

/**
 * The 2048 profile bytes of a 0x05 reply, or null when the status, profile
 * index or checksum is wrong.
 */
export function thermaltakeDecodeProfile(reply: Uint8Array, profile: number): Uint8Array | null {
  const full = thermaltakeNormalizeReply(THERMALTAKE_REPORT_ID.profile, reply);
  if (!full || full[1] !== THERMALTAKE_STATUS_OK || full[2] !== profile) return null;
  const data = full.slice(4, 4 + THERMALTAKE_PROFILE_SIZE);
  return thermaltakeChecksum(data) === full[3] ? data : null;
}

/** 0x05 write payload for a whole profile: `[0, profile, checksum, data, 0]`. */
export function thermaltakeEncodeProfileWrite(profile: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  checkProfileIndex(profile);
  if (data.length !== THERMALTAKE_PROFILE_SIZE) throw new RangeError("Thermaltake profiles are 2048 bytes.");
  const payload = new Uint8Array(THERMALTAKE_REPORT_SIZE);
  payload[1] = profile;
  payload[2] = thermaltakeChecksum(data);
  payload.set(data, 3);
  return payload;
}

export interface ThermaltakeSettings {
  /** Null for a polling code the vendor tool does not offer. */
  pollingRateHz: number | null;
  /** Enabled stages, in order. */
  dpiStages: number[];
  /** All four stored stage values, enabled or not. */
  dpiTable: number[];
  /** Zero-based, inside `dpiStages`. */
  activeDpiStage: number;
  angleSnapping: boolean;
  /** Null for a stored value outside 8..32 ms. */
  debounceMs: number | null;
}

export function thermaltakePollingCodeToHz(code: number): number | null {
  return THERMALTAKE_POLLING_CODES.find(([value]) => value === code)?.[1] ?? null;
}

export function thermaltakeHzToPollingCode(hz: number): number {
  const entry = THERMALTAKE_POLLING_CODES.find(([, rate]) => rate === hz);
  if (!entry) throw new RangeError(`Thermaltake mice cannot poll at ${hz} Hz.`);
  return entry[0];
}

/** Nearest DPI the mouse can store, inside 100..5000 in steps of 100. */
export function thermaltakeNearestDpi(dpi: number): number {
  const clamped = Math.min(THERMALTAKE_DPI_MAX, Math.max(THERMALTAKE_DPI_MIN, dpi));
  return Math.round(clamped / THERMALTAKE_DPI_STEP) * THERMALTAKE_DPI_STEP;
}

/** Stage count from the level byte; the vendor tool reads anything outside 1..4 as 4. */
function stageCount(levels: number): number {
  const count = levels >> 4;
  return count >= 1 && count <= THERMALTAKE_DPI_MAX_STAGES ? count : THERMALTAKE_DPI_MAX_STAGES;
}

export function thermaltakeDecodeSettings(data: Uint8Array): ThermaltakeSettings {
  if (data.length < THERMALTAKE_PROFILE_SIZE) throw new RangeError("Thermaltake profiles are 2048 bytes.");
  const o = THERMALTAKE_PROFILE_OFFSET;
  const count = stageCount(data[o.dpiLevels]!);
  const dpiTable = Array.from({ length: THERMALTAKE_DPI_MAX_STAGES }, (_, i) => data[o.dpiTable + i]! * THERMALTAKE_DPI_STEP);
  const debounce = data[o.debounce]!;
  return {
    pollingRateHz: thermaltakePollingCodeToHz(data[o.polling]!),
    dpiStages: dpiTable.slice(0, count),
    dpiTable,
    activeDpiStage: Math.min(data[o.dpiLevels]! & 0x0f, count - 1),
    angleSnapping: (data[o.angleSnapping]! & 0x80) !== 0,
    debounceMs: debounce >= 1 && debounce <= 25 ? debounce + 7 : null,
  };
}

export interface ThermaltakeSettingsPatch {
  pollingRateHz?: number;
  /** Replaces the enabled stages; 1..4 values. */
  dpiStages?: readonly number[];
  activeDpiStage?: number;
  angleSnapping?: boolean;
  debounceMs?: number;
}

/**
 * A copy of `data` with the patch applied. Bytes the patch does not cover,
 * including unknown ones, are kept as they are.
 */
export function thermaltakeApplySettings(data: Uint8Array, patch: ThermaltakeSettingsPatch): Uint8Array<ArrayBuffer> {
  const current = thermaltakeDecodeSettings(data);
  const next = new Uint8Array(data.length);
  next.set(data);
  const o = THERMALTAKE_PROFILE_OFFSET;
  if (patch.pollingRateHz !== undefined) next[o.polling] = thermaltakeHzToPollingCode(patch.pollingRateHz);
  const stages = patch.dpiStages ?? current.dpiStages;
  if (stages.length < 1 || stages.length > THERMALTAKE_DPI_MAX_STAGES) {
    throw new RangeError(`Thermaltake mice store 1 to ${THERMALTAKE_DPI_MAX_STAGES} DPI stages.`);
  }
  if (patch.dpiStages !== undefined) {
    patch.dpiStages.forEach((dpi, i) => {
      next[o.dpiTable + i] = thermaltakeNearestDpi(dpi) / THERMALTAKE_DPI_STEP;
    });
  }
  const active = patch.activeDpiStage ?? Math.min(current.activeDpiStage, stages.length - 1);
  if (!Number.isInteger(active) || active < 0 || active >= stages.length) {
    throw new RangeError(`Invalid DPI stage ${active + 1}.`);
  }
  next[o.dpiLevels] = (stages.length << 4) | active;
  if (patch.angleSnapping !== undefined) {
    // The vendor tool writes the whole byte as 0x80 or 0; leave an "off" byte
    // alone so turning off what is already off changes nothing.
    const byte = next[o.angleSnapping]!;
    if (patch.angleSnapping) next[o.angleSnapping] = 0x80;
    else if (byte & 0x80) next[o.angleSnapping] = 0x00;
  }
  if (patch.debounceMs !== undefined) {
    const ms = patch.debounceMs;
    if (!Number.isInteger(ms) || ms < THERMALTAKE_DEBOUNCE_MIN_MS || ms > THERMALTAKE_DEBOUNCE_MAX_MS) {
      throw new RangeError(`Debounce must be ${THERMALTAKE_DEBOUNCE_MIN_MS} to ${THERMALTAKE_DEBOUNCE_MAX_MS} ms.`);
    }
    next[o.debounce] = ms - 7;
  }
  return next;
}
