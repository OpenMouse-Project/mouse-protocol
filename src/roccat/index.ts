/**
 * ROCCAT Kone Pro Air (`1e7d:2c8e` via the Stellar Wireless dongle, `1e7d:2c92`
 * wired) and sibling Kone Pro firmware.
 *
 * Transport: the mouse speaks on the composite's vendor interface (usage page
 * 0xFF00, usage 0x0001 — interface 2 of the dongle, interface 1 wired) with
 * plain unnumbered output reports. WebHID callers send
 * `sendReport(0, payload64)`; the mouse answers on the same interface's
 * interrupt-IN stream. There is no feature report here — a full 0x00–0xFF
 * GET sweep on this unit answered nothing (2026-10-14, Windows node-hid,
 * `captures/roccat-kone-pro-air/`).
 *
 * Payload frame layout (device coordinates, ahead of no report id):
 *
 * - `0x10 0x50 <sub>` — performance class: the settings write / query (0x14),
 *   the commit tail `0x10 0x50 0x18 0x04`, and the commit (0x19);
 * - `0x10 0x10 <sub>` — the lighting write (`0x0b` + two RGB zones);
 * - `0x90 0x0a` — the unnamed status probe, answered `0x90 0x0a 04 00 00 — `
 *   with a body whose meaning is unresolved (see the note by
 *   `roccatIsStatusReply`).
 *
 * This is the protocol the vendor software replays; the DPI table write, the
 * commit tail, the status probe and the lighting write were exercised on this
 * unit (see `captures/roccat-kone-pro-air/`). What is proven on hardware: the
 * frames are accepted, the background status stream answers `90 0a 04 …`, and
 * a settings echo carried a full stage table on one session with the mouse
 * awake. What is not: a byte-precise before/after proof that the stage table
 * write applies another read-back than the sleeper echoes an empty body for.
 * The fields carry their known/unknown state through — unknown bytes stay
 * unknown rather than guessed.
 */

export const ROCCAT_VENDOR_ID = 0x1e7d; // ROCCAT GmbH (now Turtle Beach)

export const ROCCAT_KONE_PRO_AIR_WIRELESS_PID = 0x2c8e; // Stellar Wireless dongle
export const ROCCAT_KONE_PRO_AIR_WIRED_PID = 0x2c92; // wired generation
export const ROCCAT_KONE_PRO_PID = 0x2c8f; // wired Kone Pro, same Swarm family

export const ROCCAT_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [ROCCAT_KONE_PRO_AIR_WIRELESS_PID, "ROCCAT Kone Pro Air"],
  [ROCCAT_KONE_PRO_AIR_WIRED_PID, "ROCCAT Kone Pro Air (Wired)"],
]);

export const ROCCAT_PRODUCT_IDS: readonly number[] = [
  ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
  ROCCAT_KONE_PRO_AIR_WIRED_PID,
];

/** Vendor collection on the dongle's interface 2 (interface 1 when wired). */
export const ROCCAT_CONFIG_USAGE_PAGE = 0xff00;
export const ROCCAT_CONFIG_USAGE = 0x0001;

/** Payload size of every config frame; unnumbered report id 0. */
export const ROCCAT_PACKET_LENGTH = 64;
export const ROCCAT_REPORT_ID = 0x00;

/** Byte 0 of a 64-byte config frame: carries no discovered meaning. */
export const ROCCAT_FRAME_PREFIX = 0x10;

export const ROCCAT_PERFORMANCE_CLASS = 0x50;
export const ROCCAT_LIGHTING_CLASS = 0x10;
export const ROCCAT_STATUS_COMMAND_ID = 0x90;

export const ROCCAT_PERFORMANCE_COMMAND = {
  settingsGroup: 0x14,
  applyGroup: 0x18,
  commitGroup: 0x19,
} as const;

/** Unnamed status probe SignalRGB ends its setup with: `90 0a`. */
export const ROCCAT_STATUS_COMMAND: readonly number[] = [
  ROCCAT_STATUS_COMMAND_ID,
  0x0a,
];

export const ROCCAT_POLLING_TABLE = [125, 250, 500, 1000] as const;
/** Opposite of the Burst Core polling dict (125 -> 0x03 here). */
export const ROCCAT_POLLING_CODE_TO_HZ: ReadonlyMap<number, number> = new Map([
  [0x00, 1000],
  [0x01, 500],
  [0x02, 250],
  [0x03, 125],
]);
export const ROCCAT_HZ_TO_POLLING_CODE: ReadonlyMap<number, number> = new Map([
  [1000, 0x00],
  [500, 0x01],
  [250, 0x02],
  [125, 0x03],
]);

/**
 * DPI is stored per 50 in a single byte slot, so the encodable ceiling is
 * 255 x 50 = 12,750. The vendor software advertises higher numbers, but that
 * encoding was never captured and does not fit this byte, so it is not
 * claimed here.
 */
export const ROCCAT_DPI_MIN = 50;
export const ROCCAT_DPI_MAX = 12750;
export const ROCCAT_DPI_STEP = 50;
/** The settings write carries five stages of each axis. */
export const ROCCAT_DPI_STAGE_COUNT = 5;

/** LOD byte in the settings write: 0x06 = low, 0x07 = high (write path only). */
export const ROCCAT_LOD = {
  low: 0x06,
  high: 0x07,
} as const;
export type RoccatLod = "Low" | "High";

export const ROCCAT_LOD_TO_CODE: ReadonlyMap<RoccatLod, number> = new Map([
  ["Low", ROCCAT_LOD.low],
  ["High", ROCCAT_LOD.high],
]);

export const ROCCAT_DEBOUNCE_MIN_MS = 0;
export const ROCCAT_DEBOUNCE_MAX_MS = 10;

export const ROCCAT_LED_TIMEOUT_MIN_MINUTES = 0;
export const ROCCAT_LED_TIMEOUT_MAX_MINUTES = 30;

export interface RoccatDpiStages {
  /** The five 50-step slots the vendor software's stage list writes. */
  stages: readonly number[];
  /** The counterpart five slots carried in the neighbouring byte list. */
  stagesY: readonly number[];
}

export interface RoccatSettings {
  pollingRateHz: number;
  angleSnapping: boolean;
  lod: RoccatLod;
  ledTimeoutMinutes: number;
  debounceMs: number;
  dpi: RoccatDpiStages;
}

/**
 * DPI value to its 50-step slot byte. The wire carries dpi/50 in one byte, so
 * the encodable ceiling is 255 x 50 = 12,750 DPI; higher vendor numbers are
 * not reachable through this slot and were never captured.
 */
export function roccatStagedDpi(dpi: number): number {
  if (!Number.isInteger(dpi / ROCCAT_DPI_STEP)) {
    throw new RangeError(`DPI must step by ${ROCCAT_DPI_STEP}, received ${dpi}.`);
  }
  const value = dpi / ROCCAT_DPI_STEP;
  if (!Number.isInteger(value) || value < 1 || value > 0xff) {
    throw new RangeError(`DPI ${dpi} does not fit the 50-step byte slot.`);
  }
  return value;
}

/**
 * Byte-for-byte the frame the vendor software replays, in device coordinates:
 *
 * ```text
 * 10 50 14 00 01 <polling> <angle> 00
 *   <stage slots 1-5 (axis A, even)> <counterpart slots 1-5 (axis B, odd)>
 *   <lod> 00 80 <ledTimeoutMin> 00 <debounce>
 * ```
 *
 * The DPI slots land at payload bytes 8..17 — even bytes for the stage list
 * SignalRGB drives from its DPI entries, odd bytes for the other axis. On this
 * unit the axis-byte assignment reads back symmetrically (both lists held the
 * same five values from the factory), so the codec writes both axes and marks
 * which is which as unestablished.
 */
export function roccatEncodePerformanceWrite(settings: RoccatSettings): Uint8Array<ArrayBuffer> {
  const pollingCode = ROCCAT_HZ_TO_POLLING_CODE.get(settings.pollingRateHz);
  if (pollingCode === undefined) {
    throw new RangeError(`Unsupported polling rate: ${settings.pollingRateHz} Hz. Pick one of ${[...ROCCAT_POLLING_TABLE].join(", ")}.`);
  }
  if (
    !ROCCAT_LOD_TO_CODE.has(settings.lod)
  ) {
    throw new RangeError(`Unsupported lift-off distance: ${settings.lod ?? "(none)"}.`);
  }
  if (
    !Number.isInteger(settings.ledTimeoutMinutes)
    || settings.ledTimeoutMinutes < ROCCAT_LED_TIMEOUT_MIN_MINUTES
    || settings.ledTimeoutMinutes > ROCCAT_LED_TIMEOUT_MAX_MINUTES
  ) {
    throw new RangeError(`LED timeout must be a whole number of minutes between ${ROCCAT_LED_TIMEOUT_MIN_MINUTES} and ${ROCCAT_LED_TIMEOUT_MAX_MINUTES}.`);
  }
  if (
    !Number.isInteger(settings.debounceMs)
    || settings.debounceMs < ROCCAT_DEBOUNCE_MIN_MS
    || settings.debounceMs > ROCCAT_DEBOUNCE_MAX_MS
  ) {
    throw new RangeError(`Debounce must be between ${ROCCAT_DEBOUNCE_MIN_MS} and ${ROCCAT_DEBOUNCE_MAX_MS} ms.`);
  }
  if (
    settings.dpi.stages.length !== ROCCAT_DPI_STAGE_COUNT
    || settings.dpi.stagesY.length !== ROCCAT_DPI_STAGE_COUNT
  ) {
    throw new RangeError(`The settings write carries ${ROCCAT_DPI_STAGE_COUNT} stages per axis.`);
  }
  for (const stage of [...settings.dpi.stages, ...settings.dpi.stagesY]) {
    roccatStagedDpi(stage);
  }
  const view = new Uint8Array(ROCCAT_PACKET_LENGTH);
  view[0] = ROCCAT_FRAME_PREFIX;
  view[1] = ROCCAT_PERFORMANCE_CLASS;
  view[2] = ROCCAT_PERFORMANCE_COMMAND.settingsGroup;
  view[3] = 0x00;
  view[4] = 0x01;
  view[5] = pollingCode;
  view[6] = settings.angleSnapping ? 1 : 0;
  view[7] = 0x00;
  for (let index = 0; index < ROCCAT_DPI_STAGE_COUNT; index += 1) {
    view[8 + index * 2] = roccatStagedDpi(settings.dpi.stages[index]!);
    view[9 + index * 2] = roccatStagedDpi(settings.dpi.stagesY[index]!);
  }
  view[18] = ROCCAT_LOD_TO_CODE.get(settings.lod)!;
  view[19] = 0x00;
  view[20] = 0x80;
  view[21] = settings.ledTimeoutMinutes;
  view[22] = 0x00;
  view[23] = settings.debounceMs;
  return view;
}

/** The commit tail the vendor software sends after a settings write. */
export const ROCCAT_APPLY_FRAME: readonly number[] = [ROCCAT_FRAME_PREFIX, ROCCAT_PERFORMANCE_CLASS, ROCCAT_PERFORMANCE_COMMAND.applyGroup, 0x04];

/** The `10 50 18 04` apply frame the vendor software sends after a settings write. */
export function roccatEncodeApply(): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(ROCCAT_PACKET_LENGTH);
  [...ROCCAT_APPLY_FRAME].forEach((byte, index) => { view[index] = byte; });
  return view;
}

/** The status probe, answered `90 0a …` on the input stream. */
export function roccatEncodeStatus(): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(ROCCAT_PACKET_LENGTH);
  view[0] = ROCCAT_STATUS_COMMAND[0]!;
  view[1] = ROCCAT_STATUS_COMMAND[1]!;
  return view;
}

/** The empty settings query — a 0x14 frame with no arguments. */
export function roccatEncodeSettingsQuery(): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(ROCCAT_PACKET_LENGTH);
  view[0] = ROCCAT_FRAME_PREFIX;
  view[1] = ROCCAT_PERFORMANCE_CLASS;
  view[2] = ROCCAT_PERFORMANCE_COMMAND.settingsGroup;
  return view;
}

/** Reply to the status probe recorded on this unit: `90 0a 04 00 00 <byte5 — `. */
export function roccatIsStatusReply(reply: Uint8Array): boolean {
  return reply.length >= 2 && reply[0] === ROCCAT_STATUS_COMMAND[0] && reply[1] === ROCCAT_STATUS_COMMAND[1];
}

// The status echo `90 0a 04 00 00 1e 00 00 <word> 1e` was recorded on this
// unit, but byte 5's meaning is unresolved: it moved 0x1e -> 0x14 across
// sessions while the trailing u16 increased (2720 -> 2884), so a battery
// percent, a signal strength and an elapsed counter all fit. It is
// deliberately NOT decoded as a percent; no battery reading is surfaced until
// a capture establishes the mapping.

/**
 * Reply to a settings query / the echo after a write, on this unit:
 * `10 50 03 00 <word hi> <word lo> <seq> 00 <dpi table 8..17> …`. The class
 * byte 2 was 0x03 on every observed variant; frames that echo the driven
 * command (`0x14` writes) carry it at byte 2 as well. Only the frame prefix
 * and the DPI table are decoded — the remaining bytes (the device word, the
 * sequence marker, LOD/angle positions in the echo) are not established.
 */
export interface RoccatSettingsReply {
  dpi: RoccatDpiStages;
}

/** Decodes a settings echo into its DPI table, or null when the reply is not a settings frame or carries an empty (asleep) body. */
export function roccatDecodeSettingsReply(reply: Uint8Array): RoccatSettingsReply | null {
  if (
    reply.length < 18
    || reply[0] !== ROCCAT_FRAME_PREFIX
    || reply[1] !== ROCCAT_PERFORMANCE_CLASS
    || reply[2] === undefined
  ) {
    return null;
  }
  if (reply[2] !== 0x03 && reply[2] !== ROCCAT_PERFORMANCE_COMMAND.settingsGroup
    && reply[2] !== ROCCAT_PERFORMANCE_COMMAND.applyGroup) {
    return null;
  }
  const stageSlots: number[] = [];
  const stageSlotsY: number[] = [];
  for (let index = 0; index < ROCCAT_DPI_STAGE_COUNT; index += 1) {
    stageSlots.push(reply[8 + index * 2]!);
    stageSlotsY.push(reply[9 + index * 2]!);
  }
  // An asleep mouse echoes the frame with an empty body (all twenty slots
  // zero). Reporting that as five stages of 0 DPI would invent a state, so an
  // all-zero table means "no data" exactly like a missed echo does.
  if (stageSlots.every((slot) => slot === 0) && stageSlotsY.every((slot) => slot === 0)) return null;
  return {
    dpi: {
      stages: stageSlots.map((slot) => slot * ROCCAT_DPI_STEP),
      stagesY: stageSlotsY.map((slot) => slot * ROCCAT_DPI_STEP),
    },
  };
}

/**
 * The lighting write: `10 10 0b 00 09 64 64 64 06 <r g b> <r g b>` with the
 * two 0x64 "brightness" words the vendor software sends. Write-only: the
 * mouse has no known command that reads its current effect back. The frame is
 * accepted with identical replies across repeats, and deliberately left the
 * mouse's LEDs stable on this session.
 */
export const ROCCAT_LIGHTING_PREFIX: readonly number[] = [
  ROCCAT_FRAME_PREFIX,
  ROCCAT_LIGHTING_CLASS,
  0x0b,
  0x00,
  0x09,
  0x64,
  0x64,
  0x64,
  0x06,
];

/** The lighting write frame: one raw RGB triple per zone. */
export function roccatEncodeLighting(left: readonly [number, number, number], right: readonly [number, number, number]): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(ROCCAT_PACKET_LENGTH);
  [...ROCCAT_LIGHTING_PREFIX].forEach((byte, index) => { view[index] = byte; });
  view[9] = left[0];
  view[10] = left[1];
  view[11] = left[2];
  view[12] = right[0];
  view[13] = right[1];
  view[14] = right[2];
  return view;
}
