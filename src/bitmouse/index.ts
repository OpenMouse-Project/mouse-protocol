/**
 * Pure codecs for the "BITMOUSE" OEM protocol used by newer ATK and VXE mice
 * (ATK ZERO, ATK A9 NK, VXE R1 S/R2 SE, …), unit-tested without WebHID.
 *
 * This is a different family from the 16-byte EEPROM protocol in atk/index.ts:
 * frames are 63 bytes on report 0x08, carried on a vendor collection at usage
 * page 0xff05 / usage 0x0001 rather than 0xff02 / 0x0002.
 *
 * Frame layout, request:
 *
 *   [0] checksum   sum of bytes 1..62, low byte
 *   [1] 0x72       constant command code
 *   [2] paramLen   request length field (see the command table)
 *   [3] cmdSn      sequence; replies observed to carry a constant 0x3a
 *   [4] target     0 = the device addressed directly, 1 = mouse behind a receiver
 *   [5] commandId
 *   [6] cmdLen     expected reply payload length
 *   [7..] payload
 *
 * Replies arrive without the checksum byte, so every field sits one byte
 * earlier: [0] 0x72, [1] status (0xff = error), [2] cmdSn, [3] target,
 * [4] commandId, [5] payload length, [6..] payload.
 *
 * The device does not clear the tail of a reply, so bytes past the reported
 * length are leftovers from the previous exchange and must be discarded —
 * bitmouseDecodeReply trims to the reported length for this reason.
 *
 * Sources: the vendor's own WebHID configurator (ATK HUB v3.2.21, hub.atk.pro)
 * for the framing, command ids and field offsets; the values were then read
 * back from an ATK ZERO on both transports. Fields still unexplained are
 * marked below rather than given a guessed meaning.
 */

export const BITMOUSE_REPORT_ID = 0x08;
export const BITMOUSE_FRAME_LENGTH = 63;
export const BITMOUSE_COMMAND_CODE = 0x72;
export const BITMOUSE_PAYLOAD_OFFSET = 7;
/** Replies drop the checksum byte, so their payload starts one byte earlier. */
export const BITMOUSE_REPLY_PAYLOAD_OFFSET = 6;
export const BITMOUSE_ERROR_STATUS = 0xff;

/** Discovery: the config channel is the only 0xff05 collection on these mice. */
export const BITMOUSE_USAGE_PAGE = 0xff05;
export const BITMOUSE_USAGE = 0x0001;

/** Byte 4. A receiver relays to its mouse on target 1 and answers on target 0. */
export const BITMOUSE_TARGET = {
  device: 0x00,
  mouseBehindReceiver: 0x01,
} as const;

export const BITMOUSE_COMMAND = {
  setReportRate: 1,
  setDpi: 2,
  setSilentHeight: 3,
  setFarDistance: 27,
  setSensorModel: 31,
  getBatteryLevel: 7,
  getCurrentMouseConfig: 9,
  setLinearCorrection: 11,
  setRippleControl: 12,
  setMotionSync: 13,
  getBatteryChargingStatus: 15,
  setSensorSleepTime: 21,
  setStabilizationTime: 22,
  getAddressData: 23,
  getDeviceType: 26,
  getDeviceVersion: 28,
  mouseCidMid: 74,
  getDongleConnectStatus: 129,
  getDongleVersion: 136,
  getMouseCidMidDongle: 137,
} as const;

/**
 * Request lengths the vendor software sends for each command, as
 * [paramLen, cmdLen]. The firmware rejects a mismatched pair, so these are
 * copied rather than derived.
 */
export const BITMOUSE_LENGTHS = {
  setReportRate: [3, 1],
  setDpi: [12, 10],
  setSilentHeight: [4, 2],
  setFarDistance: [3, 1],
  setSensorModel: [3, 1],
  getBatteryLevel: [2, 1],
  getCurrentMouseConfig: [19, 17],
  setLinearCorrection: [3, 1],
  setRippleControl: [3, 1],
  setMotionSync: [3, 1],
  getBatteryChargingStatus: [2, 1],
  setSensorSleepTime: [5, 2],
  setStabilizationTime: [3, 1],
  getAddressData: [10, 13],
  getDeviceType: [2, 1],
  getDeviceVersion: [5, 3],
  mouseCidMid: [8, 6],
  getDongleConnectStatus: [3, 1],
  getDongleVersion: [5, 3],
  getMouseCidMidDongle: [8, 6],
} as const satisfies Record<keyof typeof BITMOUSE_COMMAND, readonly [number, number]>;

export const BITMOUSE_POLLING_RATES: ReadonlyArray<readonly [code: number, hertz: number]> = [
  [0, 1000],
  [1, 500],
  [2, 250],
  [3, 125],
  [4, 8000],
  [5, 4000],
  [6, 2000],
];

/** Reported by getDeviceType; names are the vendor's own. */
export const BITMOUSE_DEVICE_TYPES: ReadonlyArray<readonly [code: number, name: string]> = [
  [0, "dongle1K"],
  [1, "dongle4K"],
  [2, "wired1K"],
  [3, "wired8K"],
  [4, "dongle2K"],
  [5, "dongle8K"],
  [6, "wired2K"],
  [7, "wired4K"],
];

export interface BitmouseRequest {
  commandId: number;
  paramLen: number;
  cmdLen: number;
  target?: number;
  payload?: readonly number[];
}

export interface BitmouseReply {
  commandId: number;
  target: number;
  status: number;
  /** Constant 0x3a in every reply captured so far; meaning unknown. */
  cmdSn: number;
  isError: boolean;
  payload: Uint8Array;
}

export function bitmouseChecksum(frame: Uint8Array | readonly number[]): number {
  let sum = 0;
  for (let index = 1; index < frame.length; index += 1) sum += frame[index]! & 0xff;
  return sum & 0xff;
}

export function bitmouseEncodeRequest(request: BitmouseRequest): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(BITMOUSE_FRAME_LENGTH);
  frame[1] = BITMOUSE_COMMAND_CODE;
  frame[2] = request.paramLen & 0xff;
  frame[3] = 0;
  frame[4] = (request.target ?? BITMOUSE_TARGET.device) & 0xff;
  frame[5] = request.commandId & 0xff;
  frame[6] = request.cmdLen & 0xff;
  const payload = request.payload ?? [];
  const room = BITMOUSE_FRAME_LENGTH - BITMOUSE_PAYLOAD_OFFSET;
  if (payload.length > room) throw new Error(`A BITMOUSE payload holds at most ${room} bytes.`);
  frame.set(payload.map((byte) => byte & 0xff), BITMOUSE_PAYLOAD_OFFSET);
  frame[0] = bitmouseChecksum(frame);
  return frame;
}

/** Returns null for anything that is not a well-formed reply frame. */
export function bitmouseDecodeReply(frame: Uint8Array): BitmouseReply | null {
  if (frame.length < BITMOUSE_REPLY_PAYLOAD_OFFSET) return null;
  if (frame[0] !== BITMOUSE_COMMAND_CODE) return null;
  const reported = frame[5] ?? 0;
  const available = frame.length - BITMOUSE_REPLY_PAYLOAD_OFFSET;
  return {
    commandId: frame[4]!,
    target: frame[3]!,
    status: frame[1]!,
    cmdSn: frame[2]!,
    isError: frame[1] === BITMOUSE_ERROR_STATUS,
    // Trimmed: the tail of a reply still holds the previous exchange's bytes.
    payload: frame.slice(
      BITMOUSE_REPLY_PAYLOAD_OFFSET,
      BITMOUSE_REPLY_PAYLOAD_OFFSET + Math.min(reported, available),
    ),
  };
}

export function bitmouseDecodePollingRate(code: number): number | null {
  return BITMOUSE_POLLING_RATES.find(([encoded]) => encoded === code)?.[1] ?? null;
}

export function bitmouseEncodePollingRate(hertz: number): number | null {
  return BITMOUSE_POLLING_RATES.find(([, rate]) => rate === hertz)?.[0] ?? null;
}

export function bitmouseDecodeDeviceType(code: number): string | null {
  return BITMOUSE_DEVICE_TYPES.find(([encoded]) => encoded === code)?.[1] ?? null;
}

/**
 * Settings the config block does not carry. The vendor reads each with
 * getAddressData at a fixed address, one byte at a time.
 */
export const BITMOUSE_ADDRESS = {
  sensorModel: 74,
  farDistance: 75,
  sensorAngle: 2692,
} as const;

/**
 * Sensor sampling modes. The vendor exposes three of the firmware's six codes,
 * labelled Base / Athletics / Athletics Max; they are mapped onto the shared
 * eco-to-ultra names here.
 */
export const BITMOUSE_SENSOR_MODES: ReadonlyArray<readonly [code: number, name: "Eco" | "High" | "Ultra"]> = [
  [0, "Eco"],
  [4, "High"],
  [5, "Ultra"],
];

export function bitmouseDecodeSensorMode(code: number): "Eco" | "High" | "Ultra" | null {
  return BITMOUSE_SENSOR_MODES.find(([encoded]) => encoded === code)?.[1] ?? null;
}

export function bitmouseEncodeSensorMode(name: string): number | null {
  return BITMOUSE_SENSOR_MODES.find(([, label]) => label === name)?.[0] ?? null;
}

/**
 * Lift-off. The config block's own silentHeight byte reads zero and is not the
 * height: the vendor reads the level as offsetCalibration + 1 and writes it as
 * { height: 0, offsetCalibration: level - 1 }.
 *
 * The level uses the same register scale as the A9 family (see atk/index.ts):
 * tenths of a millimetre offset by six, so code 1 is 0.7 mm and code 11 is
 * 1.7 mm — the continuous range the vendor software presents as a slider.
 */
export const BITMOUSE_LIFT_OFF_MIN_CODE = 1;
export const BITMOUSE_LIFT_OFF_MAX_CODE = 11;

export function bitmouseDecodeLiftOffLevel(offsetCalibration: number): number {
  return offsetCalibration + 1;
}

export function bitmouseLiftOffMillimetres(code: number): number | null {
  return code ? (code + 6) / 10 : null;
}

export function bitmouseLiftOffCode(millimetres: number): number {
  return Math.round(millimetres * 10) - 6;
}

export function bitmouseSetLiftOffRequest(code: number): BitmouseRequest {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.setSilentHeight;
  if (!Number.isInteger(code)
    || code < BITMOUSE_LIFT_OFF_MIN_CODE
    || code > BITMOUSE_LIFT_OFF_MAX_CODE) {
    throw new Error(
      `A lift-off code runs ${BITMOUSE_LIFT_OFF_MIN_CODE} to ${BITMOUSE_LIFT_OFF_MAX_CODE}.`,
    );
  }
  return {
    commandId: BITMOUSE_COMMAND.setSilentHeight,
    paramLen,
    cmdLen,
    payload: [0, code - 1],
  };
}

export function bitmouseSetFarDistanceRequest(enabled: boolean): BitmouseRequest {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.setFarDistance;
  return { commandId: BITMOUSE_COMMAND.setFarDistance, paramLen, cmdLen, payload: [enabled ? 1 : 0] };
}

export function bitmouseSetSensorModeRequest(code: number): BitmouseRequest {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.setSensorModel;
  return { commandId: BITMOUSE_COMMAND.setSensorModel, paramLen, cmdLen, payload: [code & 0xff] };
}

export interface BitmouseConfig {
  profile: number;
  configVersion: number;
  pollingRateHz: number | null;
  silentHeight: number;
  offsetCalibration: number;
  motionSync: boolean;
  linearCorrection: boolean;
  rippleControl: boolean;
  sleepSeconds: number;
  debounceMs: number;
}

/**
 * getCurrentMouseConfig payload. The vendor's own accessors overlap at offsets
 * 3-4 (a 16-bit DPI value and an 8-bit lift-off byte claim the same ground) and
 * an ATK ZERO reports zero there on both transports, so neither field is
 * decoded as DPI here — DPI comes from the address block below instead.
 */
export function bitmouseDecodeConfig(payload: Uint8Array): BitmouseConfig | null {
  if (payload.length < 12) return null;
  return {
    profile: payload[0]!,
    configVersion: payload[1]!,
    pollingRateHz: bitmouseDecodePollingRate(payload[2]!),
    silentHeight: payload[4]!,
    offsetCalibration: payload[5]!,
    motionSync: payload[6] === 1,
    linearCorrection: payload[7] === 1,
    rippleControl: payload[8] === 1,
    sleepSeconds: payload[9]! | (payload[10]! << 8),
    debounceMs: payload[11]!,
  };
}

/** The DPI table is read with getAddressData in 10-byte chunks from address 1. */
export const BITMOUSE_DPI_BLOCK_ADDRESS = 1;
export const BITMOUSE_DPI_BLOCK_CHUNK = 10;
export const BITMOUSE_DPI_BLOCK_CHUNKS = 7;
export const BITMOUSE_DPI_STAGE_COUNT = 8;
export const BITMOUSE_DPI_STAGE_LENGTH = 8;
/** getAddressData echoes the address and length before the bytes it read. */
export const BITMOUSE_ADDRESS_DATA_OFFSET = 3;

export interface BitmouseDpiStage {
  x: number;
  y: number;
  red: number;
  green: number;
  blue: number;
  /**
   * Byte 7 of the stored record. A write puts a literal 0 here, so it reads
   * back as 0 on every stage; it is not the enable bit, which a write carries
   * one byte further along and the table never stores.
   */
  reserved: number;
}

export interface BitmouseDpiBlock {
  currentIndex: number;
  stageCount: number;
  stages: BitmouseDpiStage[];
}

export function bitmouseAddressDataRequest(address: number, length: number): BitmouseRequest {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.getAddressData;
  return {
    commandId: BITMOUSE_COMMAND.getAddressData,
    paramLen,
    cmdLen,
    payload: [address & 0xff, (address >> 8) & 0xff, length & 0xff],
  };
}

/** The addresses the vendor sweeps to assemble the DPI table. */
export function bitmouseDpiBlockAddresses(): number[] {
  return Array.from(
    { length: BITMOUSE_DPI_BLOCK_CHUNKS },
    (_unused, index) => BITMOUSE_DPI_BLOCK_ADDRESS + index * BITMOUSE_DPI_BLOCK_CHUNK,
  );
}

export function bitmouseDecodeDpiBlock(bytes: Uint8Array | readonly number[]): BitmouseDpiBlock | null {
  const needed = 2 + BITMOUSE_DPI_STAGE_COUNT * BITMOUSE_DPI_STAGE_LENGTH;
  if (bytes.length < needed) return null;
  const stages: BitmouseDpiStage[] = [];
  for (let index = 0; index < BITMOUSE_DPI_STAGE_COUNT; index += 1) {
    const at = 2 + index * BITMOUSE_DPI_STAGE_LENGTH;
    stages.push({
      x: bytes[at]! | (bytes[at + 1]! << 8),
      y: bytes[at + 2]! | (bytes[at + 3]! << 8),
      blue: bytes[at + 4]!,
      green: bytes[at + 5]!,
      red: bytes[at + 6]!,
      reserved: bytes[at + 7]!,
    });
  }
  return { currentIndex: bytes[0]!, stageCount: bytes[1]!, stages };
}

export interface BitmouseProduct {
  name: string;
  /** True for a receiver, which relays configuration to the mouse on target 1. */
  receiver: boolean;
  sensor: keyof typeof BITMOUSE_DPI_RANGES;
  /** The cid,mid pair the mouse answers with, for confirming the model. */
  cidMid: string;
}

/**
 * Products confirmed on hardware. The vendor software drives many more models
 * over this protocol; each one needs its own hardware check before it is added.
 */
export const BITMOUSE_PRODUCTS: ReadonlyMap<number, BitmouseProduct> = new Map([
  [0x1154, { name: "ATK ZERO", receiver: false, sensor: "PAW3950Ultra", cidMid: "1,1" }],
  [0x1155, { name: "ATK ZERO", receiver: true, sensor: "PAW3950Ultra", cidMid: "1,1" }],
] as const);

export const BITMOUSE_PRODUCT_IDS: readonly number[] = [...BITMOUSE_PRODUCTS.keys()];

export interface BitmouseDpiRange {
  min: number;
  max: number;
  /** Ascending step segments: `step` applies up to but not including `until`. */
  segments: ReadonlyArray<{ until: number; step: number }>;
}

/** Sensor DPI ranges, as the vendor configurator states them. */
export const BITMOUSE_DPI_RANGES = {
  PAW3950Ultra: {
    min: 10,
    max: 42000,
    segments: [{ until: 10000, step: 10 }, { until: 30000, step: 50 }, { until: 42001, step: 100 }],
  },
} as const satisfies Record<string, BitmouseDpiRange>;

export function bitmouseDpiOptions(range: BitmouseDpiRange): number[] {
  const options: number[] = [];
  let dpi = range.min;
  for (const segment of range.segments) {
    const ceiling = Math.min(segment.until, range.max + 1);
    for (; dpi < ceiling; dpi += segment.step) options.push(dpi);
  }
  if (options[options.length - 1] !== range.max) options.push(range.max);
  return options;
}

/**
 * The stages that actually hold a DPI value.
 *
 * Byte 1 of the block reads 8 on an ATK ZERO carrying only two configured
 * stages, so it is the size of the table rather than a count of enabled
 * entries. Unconfigured slots read 0 DPI (keeping stale colour bytes), so the
 * usable list is the leading run of non-zero stages.
 */
export function bitmouseEnabledStages(block: BitmouseDpiBlock): BitmouseDpiStage[] {
  const limit = Math.min(block.stageCount || block.stages.length, block.stages.length);
  const usable: BitmouseDpiStage[] = [];
  for (let index = 0; index < limit; index += 1) {
    const stage = block.stages[index]!;
    if (stage.x === 0) break;
    usable.push(stage);
  }
  return usable;
}

export interface BitmouseDpiWrite {
  index: number;
  x: number;
  y: number;
  red: number;
  green: number;
  blue: number;
  /**
   * Applies the stage as well as storing it. The vendor sets this exactly when
   * the stage being written is the active one; writing a stage with it clear
   * updates the table without moving the sensor onto that stage.
   */
  enable: boolean;
}

export function bitmouseSetDpiRequest(stage: BitmouseDpiWrite): BitmouseRequest {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.setDpi;
  return {
    commandId: BITMOUSE_COMMAND.setDpi,
    paramLen,
    cmdLen,
    payload: [
      stage.index,
      stage.x & 0xff, (stage.x >> 8) & 0xff,
      stage.y & 0xff, (stage.y >> 8) & 0xff,
      stage.blue, stage.green, stage.red,
      0,
      stage.enable ? 1 : 0,
    ],
  };
}

/** Sleep is a little-endian second count in the sensor-sleep command. */
export function bitmouseSetSleepRequest(seconds: number): BitmouseRequest {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.setSensorSleepTime;
  return {
    commandId: BITMOUSE_COMMAND.setSensorSleepTime,
    paramLen,
    cmdLen,
    payload: [seconds & 0xff, (seconds >> 8) & 0xff],
  };
}

/** Lift-off and its calibration byte share one command. */
export function bitmouseSetSilentHeightRequest(height: number, offsetCalibration: number): BitmouseRequest {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.setSilentHeight;
  return {
    commandId: BITMOUSE_COMMAND.setSilentHeight,
    paramLen,
    cmdLen,
    payload: [height & 0xff, offsetCalibration & 0xff],
  };
}

/** A single-byte flag write: motion sync, ripple control, linear correction. */
export function bitmouseSetFlagRequest(
  commandId: number,
  lengths: readonly [number, number],
  value: number,
): BitmouseRequest {
  return { commandId, paramLen: lengths[0], cmdLen: lengths[1], payload: [value & 0xff] };
}

export interface BitmouseCidMid {
  cid: number;
  mid: number;
}

/** Identifies the model: an ATK ZERO answers cid 1, mid 1. */
export function bitmouseDecodeCidMid(payload: Uint8Array): BitmouseCidMid | null {
  if (payload.length < 6) return null;
  return {
    cid: payload[1]!,
    mid: payload[2]! | (payload[3]! << 8) | (payload[4]! << 16) | (payload[5]! << 24),
  };
}

export function bitmouseDecodeVersion(payload: Uint8Array): string | null {
  if (payload.length < 3) return null;
  return `${payload[0]}.${payload[1]}.${payload[2]}`;
}
