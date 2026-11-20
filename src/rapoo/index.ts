/**
 * Rapoo's vendor configuration channel (VT9 Pro and its family).
 *
 * Two independent sources pin the layout down, and they agree byte for byte:
 *
 * - a capture from a real VT9 Pro on 2026-09-29 (receiver 0x24AE:0x1205,
 *   cable 0x24AE:0x4405) reading every register below twice, on both links;
 * - mousectl's `rapoo_vt3pro` driver, reverse engineered from Rapoo's own
 *   `RapooGameDevDriver` 1.6.29, which documents the same frame and the same
 *   addresses for the VT3 PRO.
 *
 * The request is 31 bytes of output report 0xBA on the 0xFF00:0x000E
 * interface: one connection byte, then 30 payload bytes.
 *
 *     [0] connection byte          [1] command
 *     [2] payload length           [3..6] address, u32 little endian
 *     [7..] data
 *
 * Those 31 bytes are the *report data*: the report id goes to the transport
 * separately, the way WebHID's `sendReport` and OpenMouse Bridge take it.
 * Windows reports the same report as 32 bytes because `HidP_GetCaps` counts
 * the id, and hidraw wants it prepended - both of those are this 31 plus one
 * byte. Sending 32 bytes of data instead is refused before it reaches the
 * mouse (measured in the browser: `Failed to write the report`).
 *
 * The answer travels back through GET_REPORT(Input) rather than as an
 * interrupt-IN report, which is why WebHID cannot see it: the browser has no
 * equivalent call. Transports that can issue it (Windows `HidD_GetInputReport`,
 * Linux `HIDIOCGINPUT`, OpenMouse Bridge's `receiveInputReport`) deliver the
 * report id stripped, leaving the status byte first:
 *
 *     [0] status, 0x01 when the frame was answered
 *     [1] 0 for every block answer, non-zero on a battery answer
 *     [2] battery percentage on a battery answer
 *     [4..] payload
 *
 * Two measured properties of the link shape every caller, so they belong here
 * rather than in a driver:
 *
 * - **the channel is lossy.** About 40% of frames are dropped without the
 *   device ever going busy (busy is a status byte other than 0x01). An OK that
 *   was not preceded by a busy is the *previous* command's answer, so a read
 *   has to be retried, and "no answer" never means "no such register";
 * - **the connection byte is not validated.** 0xFF and 0xA5 both answered, as
 *   did 0x00, 0x01 and 0x5A. A dropped frame must therefore never be read as
 *   "wrong connection type".
 *
 * Everything in this module is transport independent: it encodes frames,
 * decodes answers, and turns register blocks into protocol values. Retries,
 * sleeps and the read-modify-write of a live device belong to the driver.
 */

export const RAPOO_VENDOR_ID = 0x24ae;

/** VT1 MAX identifiers and configuration collection from Rapoo's Web Hub manifest. */
export const RAPOO_VT1_MAX_PRODUCT_IDS: ReadonlySet<number> = new Set([0x4644, 0x1444]);
export const RAPOO_VT1_MAX_USAGE_PAGE = 0xff00;
export const RAPOO_VT1_MAX_USAGE = 0x0002;

/** The 2.4 GHz receiver's configuration interface. */
export const RAPOO_WIRELESS_PRODUCT_ID = 0x1205;

/** The same mouse reached over its cable. */
export const RAPOO_WIRED_PRODUCT_ID = 0x4405;

export const RAPOO_PRODUCT_IDS: ReadonlySet<number> = new Set([
  RAPOO_WIRELESS_PRODUCT_ID,
  RAPOO_WIRED_PRODUCT_ID,
]);

export const RAPOO_CONFIG_USAGE_PAGE = 0xff00;
export const RAPOO_CONFIG_USAGE = 0x000e;

/** Report data length of the command channel, in both directions. */
export const RAPOO_CONFIG_REPORT_ID = 0xba;

/** The unsolicited status report; see {@link decodeRapooNotification}. */
export const RAPOO_NOTIFY_REPORT_ID = 0xbb;

/**
 * A separate interface (0xFF0B:0x0104) that answers a GET_REPORT(Feature) with
 * a status block. It is the only Rapoo read WebHID can perform, because
 * `receiveFeatureReport` exists in the browser and `GET_REPORT(Input)` does
 * not.
 */
export const RAPOO_STATUS_USAGE_PAGE = 0xff0b;
export const RAPOO_STATUS_USAGE = 0x0104;
export const RAPOO_STATUS_REPORT_ID = 0x2a;

export const RAPOO_FRAME_LENGTH = 31;

export const RAPOO_CMD_READ = 0xa4;
export const RAPOO_CMD_WRITE = 0xa5;
export const RAPOO_CMD_BATTERY = 0xaa;

/** The status byte of an answered frame. Anything else means "not ready". */
export const RAPOO_STATUS_OK = 0x01;

/**
 * What mousectl's driver sends, and the values that were measured answering.
 * Nothing validates this byte on the VT9 Pro - see the module comment.
 */
export const RAPOO_CONNECTION_WIRED = 0xff;
export const RAPOO_CONNECTION_RECEIVER = 0xa5;

/**
 * EEPROM addresses: profile 0's base of 0x600 plus the offsets the Windows
 * driver uses. The VT9 Pro and the VT3 PRO agree on all of them.
 */
export const RAPOO_ADDRESS = {
  /** [0] polling rate on 2.4 GHz, [2] the same on the cable. */
  performance: 0x880,
  /** [0] lift-off index, [1] motion sync. */
  sensor: 0x884,
  /** 7 little-endian u16 DPI values, [14] the stage count byte. */
  dpiX: 0x888,
  /** [0] the active stage index, 0 based. */
  activeStage: 0x898,
  /** [0] press debounce, [1] release debounce, [2] sleep minutes, [3] flags. */
  timing: 0x8c0,
  /** [0] sensor angle in degrees. */
  angle: 0x8c4,
  /** Same layout as {@link RAPOO_ADDRESS.dpiX}. */
  dpiY: 0x8c8,
} as const;

/**
 * The block length the Windows driver reads for each address. A read has to
 * ask for the same length the vendor tool does: the device answers with the
 * block it has, not with what was asked for.
 */
export const RAPOO_BLOCK_LENGTH: Readonly<Record<number, number>> = {
  [RAPOO_ADDRESS.performance]: 4,
  [RAPOO_ADDRESS.sensor]: 4,
  [RAPOO_ADDRESS.dpiX]: 16,
  [RAPOO_ADDRESS.activeStage]: 4,
  [RAPOO_ADDRESS.timing]: 4,
  [RAPOO_ADDRESS.angle]: 4,
  [RAPOO_ADDRESS.dpiY]: 16,
};

/** Polling-rate byte to Hz, straight from the vendor driver's switch table. */
export const RAPOO_POLLING_RATES: Readonly<Record<number, number>> = {
  0x08: 125,
  0x04: 250,
  0x02: 500,
  0x01: 1000,
  0x84: 2000,
  0x82: 4000,
  // Decoded so an 8K model reads correctly, but deliberately not offered as an
  // option anywhere: the VT3 PRO profile has support8k = false and the VT9 Pro
  // has never been seen on 8000 Hz.
  0x81: 8000,
};

export function rapooPollingRateHz(code: number): number | null {
  return RAPOO_POLLING_RATES[code] ?? null;
}

/** Debounce values the vendor driver's table indexes, in milliseconds. */
export const RAPOO_DEBOUNCE_MS: readonly number[] = [1, 2, 4, 8, 16, 24, 32];

/** How many DPI stages the table holds. */
export const RAPOO_DPI_STAGES = 7;

/**
 * Bit 0 of {@link RAPOO_ADDRESS.timing}'s flag byte means "angle snap is off",
 * bit 1 means "ripple control is off" - the vendor driver stores *disable*
 * flags here, so a set bit is a feature the user turned off.
 */
export const RAPOO_FLAG_ANGLE_SNAP_OFF = 0x01;
export const RAPOO_FLAG_RIPPLE_OFF = 0x02;

export interface RapooFrameOptions {
  /** Defaults to {@link RAPOO_CONNECTION_RECEIVER}. */
  connection?: number;
  data?: readonly number[];
  /** Overrides the length byte; the data still has to be passed separately. */
  length?: number;
}

/**
 * Build one command frame: the whole report data of 0xBA, 31 bytes.
 *
 * The frame is zero padded, so a write of fewer bytes than the block length
 * still sends the whole block - which is what the vendor driver does, and what
 * the device expects.
 */
export function encodeRapooFrame(
  command: number,
  address: number,
  options: RapooFrameOptions = {},
): Uint8Array {
  if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) {
    throw new RangeError(`Rapoo address out of range: ${address}`);
  }
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new RangeError(`Rapoo command out of range: ${command}`);
  }

  const data = options.data ?? [];
  const capacity = RAPOO_FRAME_LENGTH - 7;
  if (data.length > capacity) {
    throw new RangeError(`Rapoo frame holds ${capacity} data bytes, got ${data.length}`);
  }

  const frame = new Uint8Array(RAPOO_FRAME_LENGTH);
  frame[0] = options.connection ?? RAPOO_CONNECTION_RECEIVER;
  frame[1] = command;
  frame[2] = options.length ?? data.length;
  frame[3] = address & 0xff;
  frame[4] = (address >>> 8) & 0xff;
  frame[5] = (address >>> 16) & 0xff;
  frame[6] = (address >>> 24) & 0xff;
  for (let index = 0; index < data.length; index += 1) frame[7 + index] = data[index];
  return frame;
}

export function encodeRapooRead(
  address: number,
  length: number,
  connection: number = RAPOO_CONNECTION_RECEIVER,
): Uint8Array {
  return encodeRapooFrame(RAPOO_CMD_READ, address, { connection, length });
}

export function encodeRapooWrite(
  address: number,
  data: readonly number[],
  connection: number = RAPOO_CONNECTION_RECEIVER,
): Uint8Array {
  return encodeRapooFrame(RAPOO_CMD_WRITE, address, { connection, data });
}

/**
 * The battery query. Unlike a block read it carries address 0 and length 0, and
 * its answer does not follow the busy -> OK handshake: the value is already in
 * the device's input buffer, so callers have to look for the marker byte.
 */
export function encodeRapooBatteryQuery(
  connection: number = RAPOO_CONNECTION_RECEIVER,
): Uint8Array {
  return encodeRapooFrame(RAPOO_CMD_BATTERY, 0, { connection, length: 0 });
}

/**
 * Index of the status byte in a raw GET_REPORT(Input) buffer.
 *
 * Windows strips the report id and Linux hidraw may keep it, so both layouts
 * occur in the wild; mousectl accepts either and so does this. The status byte
 * is 0x01 when answered and something else while busy, so a 0xBA in front of
 * the buffer is unambiguous.
 */
export function rapooAnswerOffset(bytes: Uint8Array): 0 | 1 {
  return bytes[0] === RAPOO_CONFIG_REPORT_ID ? 1 : 0;
}

export interface RapooAnswer {
  /** Byte 0: {@link RAPOO_STATUS_OK} when this frame was answered. */
  status: number;
  ok: boolean;
  /**
   * True while the device is still working on the frame before this one. It is
   * the expected first state of an exchange, not an error.
   */
  busy: boolean;
  /** Byte 1: 0 on a block answer, non-zero on a battery answer. */
  marker: number;
  /** Everything from byte 4 on, i.e. the block a read asked for. */
  payload: Uint8Array;
  /** The answer with any leading report id removed. */
  data: Uint8Array;
}

/**
 * Classify one raw answer. Returns null for a buffer too short to carry a
 * status byte, so a transport can treat a non-answer as a non-answer rather
 * than as a device that said 0x00.
 */
export function decodeRapooAnswer(bytes: Uint8Array): RapooAnswer | null {
  const offset = rapooAnswerOffset(bytes);
  const data = bytes.subarray(offset);
  if (data.length < 4) return null;

  const status = data[0];
  return {
    status,
    ok: status === RAPOO_STATUS_OK,
    busy: status !== RAPOO_STATUS_OK,
    marker: data[1],
    payload: data.subarray(4),
    data,
  };
}

/** The block of `length` bytes an answered read carries, or null. */
export function rapooAnswerBlock(answer: RapooAnswer, length: number): Uint8Array | null {
  if (!answer.ok || answer.payload.length < length) return null;
  return answer.payload.subarray(0, length);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export interface RapooPerformance {
  /** Polling rate while the mouse talks to its receiver. */
  receiverHz: number | null;
  /** Polling rate while it is on the cable. */
  wiredHz: number | null;
  /** Bytes 1 and 3, whose meaning is not established. Preserved unread. */
  reserved: readonly [number, number];
}

/** {@link RAPOO_ADDRESS.performance}: `82 00 82 ff` on a 4000 Hz VT9 Pro. */
export function decodeRapooPerformance(block: Uint8Array): RapooPerformance | null {
  if (block.length < 4) return null;
  return {
    receiverHz: rapooPollingRateHz(block[0]),
    wiredHz: rapooPollingRateHz(block[2]),
    reserved: [block[1], block[3]],
  };
}

export interface RapooSensor {
  /**
   * Raw lift-off selector. The scale it indexes is not established for this
   * mouse (the vendor bundle carries both a 1.0-2.0 mm and a 0.7-1.7 mm
   * ladder), so it is exposed as the raw code rather than as millimetres.
   */
  liftOffIndex: number;
  motionSync: boolean;
}

/** {@link RAPOO_ADDRESS.sensor}: `01 01 01 00` = index 1, motion sync on. */
export function decodeRapooSensor(block: Uint8Array): RapooSensor | null {
  if (block.length < 2) return null;
  return { liftOffIndex: block[0], motionSync: block[1] === 1 };
}

export interface RapooDpiTable {
  /** Every stored stage, in device order, as the mouse stores it. */
  stages: number[];
  /**
   * How many stages are switched on. The mouse stores that count byte as one
   * less than the number of active stages: a byte of 2 means three stages.
   */
  enabledStages: number;
  /** The stored byte, for callers that would rather not work from the count. */
  countByte: number;
}

/** {@link RAPOO_ADDRESS.dpiX} and {@link RAPOO_ADDRESS.dpiY}. */
export function decodeRapooDpiTable(block: Uint8Array): RapooDpiTable | null {
  const countOffset = RAPOO_DPI_STAGES * 2;
  if (block.length < countOffset + 1) return null;

  const stages: number[] = [];
  for (let index = 0; index < RAPOO_DPI_STAGES; index += 1) {
    stages.push(readUint16(block, index * 2));
  }

  const countByte = block[countOffset];
  return {
    stages,
    enabledStages: Math.min(countByte + 1, RAPOO_DPI_STAGES),
    countByte,
  };
}

/** {@link RAPOO_ADDRESS.activeStage}: `01 00 02 01` = the second stage. */
export function decodeRapooActiveStage(block: Uint8Array): number | null {
  if (block.length < 1) return null;
  const index = block[0];
  return index < RAPOO_DPI_STAGES ? index : null;
}

export interface RapooTiming {
  /** Debounce in milliseconds, or null when the stored index is unknown. */
  pressDebounceMs: number | null;
  releaseDebounceMs: number | null;
  sleepMinutes: number;
  angleSnapOff: boolean;
  rippleOff: boolean;
  /** The raw flag byte, so a caller can preserve what it does not understand. */
  flags: number;
}

/** {@link RAPOO_ADDRESS.timing}: `04 04 78 03` = 16/16 ms, 120 min. */
export function decodeRapooTiming(block: Uint8Array): RapooTiming | null {
  if (block.length < 4) return null;

  const flags = block[3];
  return {
    pressDebounceMs: RAPOO_DEBOUNCE_MS[block[0]] ?? null,
    releaseDebounceMs: RAPOO_DEBOUNCE_MS[block[1]] ?? null,
    sleepMinutes: block[2],
    angleSnapOff: (flags & RAPOO_FLAG_ANGLE_SNAP_OFF) !== 0,
    rippleOff: (flags & RAPOO_FLAG_RIPPLE_OFF) !== 0,
    flags,
  };
}

/** {@link RAPOO_ADDRESS.angle}: `00 00 01 00` = 0 degrees. */
export function decodeRapooAngle(block: Uint8Array): number | null {
  if (block.length < 1) return null;
  return block[0];
}

export interface RapooBattery {
  percent: number;
  charging: boolean;
}

/**
 * The `0xAA` answer, which is the only place the charge state is readable.
 *
 * Returns null when the byte is 0 (that is a block answer, not a battery one)
 * or when the marker is a value neither the vendor driver's table nor this
 * capture explains.
 */
export function decodeRapooBatteryAnswer(answer: RapooAnswer): RapooBattery | null {
  if (answer.data.length < 3) return null;
  const marker = answer.data[1];
  if (marker !== 1 && marker !== 2) return null;

  const percent = answer.data[2];
  if (percent > 100) return null;
  return { percent, charging: marker === 2 };
}

export interface RapooNotification {
  /** The link byte, `0x01` on the receiver in every capture so far. */
  linkCode: number;
  batteryPercent: number | null;
}

/**
 * Input report 0xBB, which the mouse sends unprompted roughly every three
 * seconds: `b0 51 20 03 01 62` at 98% on the receiver.
 *
 * The header is checked rather than assumed, so an unrelated report that
 * happens to carry id 0xBB is rejected. Bytes 2 and 3 have been 0x20 and 0x03
 * in every observation but are not understood.
 */
export function decodeRapooNotification(bytes: Uint8Array): RapooNotification | null {
  if (bytes.length < 6) return null;
  if (bytes[0] !== 0xb0 || bytes[1] !== 0x51) return null;

  const percent = bytes[5];
  return {
    linkCode: bytes[4],
    batteryPercent: percent <= 100 ? percent : null,
  };
}

/**
 * The link byte of {@link decodeRapooNotification}.
 *
 * `0x01` was measured on the receiver. `0x02` as the cable is a hypothesis -
 * it was never seen, because every capture had the receiver attached - so a
 * caller that needs the connection for certain should fall back to the product
 * id instead.
 */
export function rapooLinkConnection(linkCode: number): "Wireless" | "Wired" | null {
  if (linkCode === 0x01) return "Wireless";
  if (linkCode === 0x02) return "Wired";
  return null;
}

/**
 * Battery percentage out of the `0x2A` feature block on 0xFF0B:0x0104, which
 * is the one Rapoo read a browser can perform.
 *
 * Observed with the two links differing at byte 5 of the report data:
 * `2a 01 00 00 04 21 50 00 00 62` on the cable and `... 11 20 ...` on the
 * receiver. Windows' GET_REPORT keeps the report id in front of the data and
 * WebHID's `receiveFeatureReport` may not, so the reading is taken relative to
 * the report data rather than at a fixed offset. Only the percentage is
 * understood; the rest of the block is not.
 */
export function rapooStatusBatteryPercent(bytes: Uint8Array): number | null {
  const offset = bytes[0] === RAPOO_STATUS_REPORT_ID ? 1 : 0;
  if (bytes.length < offset + 9) return null;
  const percent = bytes[offset + 8];
  return percent <= 100 ? percent : null;
}
