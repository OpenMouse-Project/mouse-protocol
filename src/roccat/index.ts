/**
 * ROCCAT Kone Pro Air (`1e7d:2c8e` via the Stellar Wireless dongle, `1e7d:2c92`
 * wired) and sibling Kone Pro firmware — the read side.
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
 * - `0x10 0x50 <sub>` — performance class: the settings query (0x14) and the
 *   `0x18` apply tail the vendor software sends after a write;
 * - `0x90 0x0a` — the unnamed status probe, answered `0x90 0x0a 04 00 00 — `
 *   with a body whose meaning is unresolved (see the note by
 *   `roccatIsStatusReply`).
 *
 * **This module decodes, it does not encode settings writes.** No setter ships
 * until a capture shows one landing: the 2026-10-16 session sent the vendor's
 * own settings frame by hand, got the expected echo, and the reply pages still
 * read the previously stored stage table, while a passive listener saw the
 * vendor software's reads and no write on any of the four interfaces. Frames
 * being accepted is not the same as frames being applied, and a whole-block
 * write that is not applied still costs the user their settings. The protocol
 * bytes below are kept because they are what the captures establish; the
 * encoders are not, because nothing establishes them.
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
export const ROCCAT_STATUS_COMMAND_ID = 0x90;

/**
 * Sub-commands of the performance class. `settingsGroup` is the settings
 * query this module sends; `applyGroup` is the `10 50 18 04` tail the vendor
 * software sends after a settings write, and appears here only because the
 * decoder has to recognise an echo of it.
 */
export const ROCCAT_PERFORMANCE_COMMAND = {
  settingsGroup: 0x14,
  applyGroup: 0x18,
} as const;

/** Unnamed status probe SignalRGB ends its setup with: `90 0a`. */
export const ROCCAT_STATUS_COMMAND: readonly number[] = [
  ROCCAT_STATUS_COMMAND_ID,
  0x0a,
];

export const ROCCAT_POLLING_TABLE = [125, 250, 500, 1000] as const;
/** Opposite of the Burst Core polling dict (125 -> 0x03 here). */
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
/** The stored table carries five stages of each axis. */
export const ROCCAT_DPI_STAGE_COUNT = 5;

/** LOD byte in the settings block: 0x06 = low, 0x07 = high. */
export const ROCCAT_LOD = {
  low: 0x06,
  high: 0x07,
} as const;

export interface RoccatDpiStages {
  /** The five 50-step slots of one axis. */
  stages: readonly number[];
  /** The counterpart five slots carried in the neighbouring byte list. */
  stagesY: readonly number[];
}

/** The empty settings query — a 0x14 frame with no arguments. */
export function roccatEncodeSettingsQuery(): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(ROCCAT_PACKET_LENGTH);
  view[0] = ROCCAT_FRAME_PREFIX;
  view[1] = ROCCAT_PERFORMANCE_CLASS;
  view[2] = ROCCAT_PERFORMANCE_COMMAND.settingsGroup;
  return view;
}

/**
 * Reply to a settings query, on this unit:
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

/** The status probe, answered `90 0a …` on the input stream. */
export function roccatEncodeStatus(): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(ROCCAT_PACKET_LENGTH);
  view[0] = ROCCAT_STATUS_COMMAND[0]!;
  view[1] = ROCCAT_STATUS_COMMAND[1]!;
  return view;
}

/** Reply to the status probe recorded on this unit: `90 0a 04 00 00 <byte5 — `. */
export function roccatIsStatusReply(reply: Uint8Array): boolean {
  return reply.length >= 2 && reply[0] === ROCCAT_STATUS_COMMAND[0] && reply[1] === ROCCAT_STATUS_COMMAND[1];
}

// The status echo `90 0a 04 00 00 1e 00 00 <word> 1e` was recorded on this
// unit, but byte 5's meaning is unresolved here: it moved 0x1e -> 0x14 across
// sessions while the trailing u16 increased (2720 -> 2884), so a battery
// percent, a signal strength and an elapsed counter all fit. The 2026-10-16
// capture later lined byte 5 up with the vendor software's own battery log,
// but that is a reading from Swarm, not from this driver, so no battery value
// is surfaced until a capture establishes it from the reply itself.
