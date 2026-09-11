/**
 * MCHOSE's **second** mouse protocol — the one the A7 V3 generation speaks.
 *
 * Read out of the same M HUB bundle as the A7 V2 codec in `./index.ts`, which
 * carries two complete mouse UIs side by side: an older one driving the V2
 * models and a newer one driving everything in {@link MCHOSE_V3_PRODUCTS}.
 * They share a vendor id and even a usage page, and share nothing else.
 *
 * | | A7 V2 (`./index.ts`) | A7 V3 (this file) |
 * | --- | --- | --- |
 * | transport | feature reports `0x11` / `0x12` | **output report `0x4d`**, replies on the input report |
 * | encoding | every body byte inverted (XOR `0xff`) | plain bytes, XOR checksum |
 * | commands | one byte | **two bytes, little-endian** |
 * | settings | one 64-byte blob (`0x67`) | several focused commands |
 *
 * The framing is a 64-byte frame whose first byte is both the `'M'` magic and
 * the HID report id, so the body that actually goes out over
 * `sendReport(0x4d, body)` is the remaining 63 bytes — which is what every
 * function here encodes and decodes:
 *
 * ```
 * frame[0] = 0x4d   report id, not part of the body
 * body[0]  = 0x01   protocol version
 * body[1]  = flags  1 when a trailing checksum is present
 * body[2]  = data length
 * body[3]  = command low byte
 * body[4]  = command high byte
 * body[5]  = business code
 * body[6]  = sequence
 * body[7…] = data, then the checksum at body[7 + length]
 * ```
 *
 * The checksum is an XOR of `body[1]` through `body[6 + length]`.
 *
 * **Nothing in this file has been exercised on hardware.** It is a reading of
 * the vendor bundle, and the driver that uses it is read-only for that reason;
 * see docs/mchose-protocol.md.
 */

/** Output report the whole V3 command set rides on; also the `'M'` magic. */
export const MCHOSE_V3_REPORT_ID = 0x4d;

/** Full frame including the report id. The body sent over WebHID is one less. */
export const MCHOSE_V3_FRAME_LENGTH = 64;
export const MCHOSE_V3_BODY_LENGTH = MCHOSE_V3_FRAME_LENGTH - 1;

/**
 * The V3 config channel sits on the **same collection as the V2's** — the
 * vendor's own WebHID filters ask for `0xff01`/`0x0001` for both generations.
 * Spelled out rather than imported from `./index.ts` to keep the two codecs
 * free of a circular import; they are the same numbers because the hardware
 * uses the same numbers, not because one derives from the other.
 */
export const MCHOSE_V3_USAGE_PAGE = 0xff01;
export const MCHOSE_V3_USAGE = 0x0001;

const VERSION_OFFSET = 0;
const FLAGS_OFFSET = 1;
const LENGTH_OFFSET = 2;
const COMMAND_LOW_OFFSET = 3;
const COMMAND_HIGH_OFFSET = 4;
const BIZ_CODE_OFFSET = 5;
const SEQUENCE_OFFSET = 6;
const DATA_OFFSET = 7;

const PROTOCOL_VERSION = 0x01;
const FLAG_CHECKSUM = 0x01;

/**
 * Command ids, little-endian in the frame. The `0x00xx` block is settings and
 * the `0x09xx` block is device-level; a write is its read plus `0x0100`.
 */
export const MCHOSE_V3_COMMAND = {
  /** Button assignments for one profile: `[profileIndex, 0, buttonCount]`. */
  readButtons: 0x0001,
  /** Profile, DPI/rate indices, sleep, sensor flags, debounce: `[]`. */
  readSettings: 0x0002,
  /** DPI stage table for one axis: `[profileIndex, axis]`. */
  readDpi: 0x0003,
  /** Lift-off index, on models that keep it outside the sensor byte. */
  readLiftOff: 0x0009,
  /** Identity and power: vendor/product id, charge state, battery. */
  readDeviceInfo: 0x0900,
  /** Firmware version, returned as a hex string the vendor trims. */
  readVersion: 0x0901,
  /** Macro storage, read 22 bytes at a time. */
  readMacro: 0x090c,

  writeButtons: 0x0101,
  writeSettings: 0x0102,
  writeDpi: 0x0103,
  /** One stage without rewriting the table: `[profile, stage, axis, dpi u16]`. */
  writeSingleDpi: 0x0104,
  /** Factory reset, whole device or one profile. */
  reset: 0x0105,
  writeLiftOff: 0x0109,
} as const;

/**
 * Physical buttons, in the fixed order the button commands walk them. Matches
 * the V2 vocabulary in `./buttons.ts` apart from the vendor's own spelling.
 */
export const MCHOSE_V3_BUTTONS = ["Left", "Right", "Middle", "Forward", "Back", "DPI"] as const;

/** XOR of `body[from]` through `body[to]`, inclusive. */
function checksum(body: Uint8Array, from: number, to: number): number {
  let value = 0;
  for (let index = from; index <= to; index += 1) value ^= body[index] ?? 0;
  return value & 0xff;
}

export interface MchoseV3FrameOptions {
  /** Defaults to 1, which appends the checksum. */
  flags?: number;
  bizCode?: number;
  sequence?: number;
}

/**
 * Build the 63-byte body for `sendReport(MCHOSE_V3_REPORT_ID, body)`.
 *
 * Throws rather than silently truncating: a command whose data does not fit
 * would otherwise go out with a valid checksum over the wrong bytes.
 */
export function mchoseV3Encode(
  command: number,
  data: readonly number[] = [],
  options: MchoseV3FrameOptions = {},
): Uint8Array<ArrayBuffer> {
  const flags = options.flags ?? FLAG_CHECKSUM;
  // The checksum needs a byte of its own past the data.
  if (DATA_OFFSET + data.length + 1 > MCHOSE_V3_BODY_LENGTH) {
    throw new RangeError(`mchoseV3Encode: ${data.length} data bytes do not fit in a frame`);
  }
  const body = new Uint8Array(MCHOSE_V3_BODY_LENGTH);
  body[VERSION_OFFSET] = PROTOCOL_VERSION;
  body[FLAGS_OFFSET] = flags & 0xff;
  body[LENGTH_OFFSET] = data.length & 0xff;
  body[COMMAND_LOW_OFFSET] = command & 0xff;
  body[COMMAND_HIGH_OFFSET] = (command >> 8) & 0xff;
  body[BIZ_CODE_OFFSET] = (options.bizCode ?? 0) & 0xff;
  body[SEQUENCE_OFFSET] = (options.sequence ?? 0) & 0xff;
  for (let index = 0; index < data.length; index += 1) {
    body[DATA_OFFSET + index] = data[index]! & 0xff;
  }
  if (flags === FLAG_CHECKSUM) {
    body[DATA_OFFSET + data.length] = checksum(body, FLAGS_OFFSET, SEQUENCE_OFFSET + data.length);
  }
  return body;
}

/** Command id carried by a reply body, or null if it is too short to hold one. */
export function mchoseV3ReplyCommand(body: Uint8Array): number | null {
  if (body.length <= COMMAND_HIGH_OFFSET) return null;
  return (body[COMMAND_LOW_OFFSET]! | (body[COMMAND_HIGH_OFFSET]! << 8)) & 0xffff;
}

/**
 * Data slice of a reply, or null when the frame is malformed or answers a
 * different command.
 *
 * The vendor's own reader trusts the command id alone and never checks the
 * checksum. This does check it, but only when the reply claims to carry one:
 * a reply with other flags is accepted on its command id, the way M HUB
 * accepts it.
 */
export function mchoseV3Payload(body: Uint8Array, command: number): Uint8Array | null {
  if (mchoseV3ReplyCommand(body) !== command) return null;
  const length = body[LENGTH_OFFSET] ?? 0;
  if (DATA_OFFSET + length > body.length) return null;
  if ((body[FLAGS_OFFSET] ?? 0) === FLAG_CHECKSUM) {
    const expected = checksum(body, FLAGS_OFFSET, SEQUENCE_OFFSET + length);
    if (body[DATA_OFFSET + length] !== expected) return null;
  }
  return body.slice(DATA_OFFSET, DATA_OFFSET + length);
}

const u16 = (data: Uint8Array, offset: number): number =>
  (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);

export interface MchoseV3DeviceInfo {
  vendorId: number;
  /** The mouse's own product id, even when the host is talking to a receiver. */
  productId: number;
  /** Onboard profile count. */
  profileCount: number;
  macroSaveType: number;
  shareMacroDataSize: number;
  macroUnitSize: number;
  /** 0 when the mouse is not on the air; the receiver still answers. */
  connectStatus: number;
  chargeStatus: number;
  batteryPercent: number;
  /** Performance mode, mirrored out of the sensor byte's low bits. */
  gameMode: number;
}

/** `0x0900` — identity and power. This is how a model is resolved. */
export function mchoseV3DecodeDeviceInfo(data: Uint8Array): MchoseV3DeviceInfo | null {
  if (data.length < 14) return null;
  return {
    vendorId: u16(data, 0),
    productId: u16(data, 2),
    profileCount: data[4]!,
    macroSaveType: data[5]!,
    shareMacroDataSize: u16(data, 6),
    macroUnitSize: u16(data, 8),
    connectStatus: data[10]!,
    chargeStatus: data[11]!,
    batteryPercent: data[12]!,
    gameMode: data[13]!,
  };
}

/**
 * The firmware's polling table has a slot M HUB never offers, so a stored rate
 * index is not an index into the model's rate list. The vendor maps around it
 * in both directions; these two are those maps.
 *
 * Device slot 1 is the hidden one — it reads back as option 1 but is never
 * written, which is what makes the pair asymmetric.
 */
export function mchoseV3RateIndexToOption(deviceIndex: number): number {
  return deviceIndex > 1 ? deviceIndex - 1 : deviceIndex;
}

export function mchoseV3OptionToRateIndex(optionIndex: number): number {
  return optionIndex > 0 ? optionIndex + 1 : optionIndex;
}

export interface MchoseV3Settings {
  profileIndex: number;
  /** Active DPI stage, shared by both links. */
  dpiIndex: number;
  /** Option indices into the model's rate list, already mapped off the wire. */
  wiredRateIndex: number;
  wirelessRateIndex: number;
  /** Auto-sleep in minutes; 0 disables it. */
  sleep: number;
  sleepMode: number;
  /** Packed flags — see {@link mchoseV3DecodeSensor}. */
  sensor: number;
  /** Signed −30…+30 rotation, two's complement on the wire. */
  angleTuning: number;
  leftDebounceMs: number;
  rightDebounceMs: number;
}

/** `0x0002` — the settings the V2 kept in its one big config blob. */
export function mchoseV3DecodeSettings(data: Uint8Array): MchoseV3Settings | null {
  if (data.length < 9) return null;
  const wired = data[1]!;
  const wireless = data[2]!;
  return {
    profileIndex: data[0]!,
    dpiIndex: wired & 0x0f,
    wiredRateIndex: mchoseV3RateIndexToOption((wired >> 4) & 0x0f),
    wirelessRateIndex: mchoseV3RateIndexToOption((wireless >> 4) & 0x0f),
    sleep: data[3]!,
    sleepMode: data[4]! & 1,
    sensor: data[5]!,
    angleTuning: (data[6]! << 24) >> 24,
    leftDebounceMs: data[7]!,
    rightDebounceMs: data[8]!,
  };
}

/**
 * Encode the settings block back. Every field is required because the command
 * replaces the whole block — there is no read-modify-write on the device side,
 * so a caller must pass a freshly read {@link MchoseV3Settings} with its edits
 * applied rather than a partial object.
 */
export function mchoseV3EncodeSettings(settings: MchoseV3Settings): number[] {
  const wired = ((mchoseV3OptionToRateIndex(settings.wiredRateIndex) & 0x0f) << 4)
    | (settings.dpiIndex & 0x0f);
  const wireless = ((mchoseV3OptionToRateIndex(settings.wirelessRateIndex) & 0x0f) << 4)
    | (settings.dpiIndex & 0x0f);
  return [
    settings.profileIndex & 0xff,
    wired,
    wireless,
    settings.sleep & 0xff,
    settings.sleepMode & 0xff,
    settings.sensor & 0xff,
    settings.angleTuning & 0xff,
    settings.leftDebounceMs & 0xff,
    settings.rightDebounceMs & 0xff,
    // The vendor pads ten zero bytes past the block; the firmware may well
    // read them, so they are not dropped.
    ...new Array<number>(10).fill(0),
  ];
}

/**
 * Sensor byte layout — **note that it is not the V2's**. The V2 puts lift-off
 * in bits 0-1 and the performance mode in bits 6-7; this generation swaps
 * them, and adds a glass-surface flag on the top bit. Getting the two mixed up
 * reads a lift-off level as a power mode.
 */
export const MCHOSE_V3_SENSOR_MODE_MASK = 0x03;
export const MCHOSE_V3_SENSOR_RIPPLE = 0x04;
export const MCHOSE_V3_SENSOR_LINEAR = 0x08;
export const MCHOSE_V3_SENSOR_MOTION_SYNC = 0x10;
export const MCHOSE_V3_SENSOR_LOD_MASK = 0x60;
export const MCHOSE_V3_SENSOR_LOD_SHIFT = 5;
export const MCHOSE_V3_SENSOR_GLASS = 0x80;

export interface MchoseV3Sensor {
  /** Index into the model's lift-off ladder, for models that keep it here. */
  liftOffIndex: number;
  rippleControl: boolean;
  angleSnapping: boolean;
  motionSync: boolean;
  glassMode: boolean;
  /** Index into {@link MCHOSE_V3_MODES}. */
  modeIndex: number;
}

export function mchoseV3DecodeSensor(sensor: number): MchoseV3Sensor {
  return {
    liftOffIndex: (sensor & MCHOSE_V3_SENSOR_LOD_MASK) >> MCHOSE_V3_SENSOR_LOD_SHIFT,
    rippleControl: (sensor & MCHOSE_V3_SENSOR_RIPPLE) !== 0,
    angleSnapping: (sensor & MCHOSE_V3_SENSOR_LINEAR) !== 0,
    motionSync: (sensor & MCHOSE_V3_SENSOR_MOTION_SYNC) !== 0,
    glassMode: (sensor & MCHOSE_V3_SENSOR_GLASS) !== 0,
    modeIndex: sensor & MCHOSE_V3_SENSOR_MODE_MASK,
  };
}

/** Same three-way choice the V2 offers, in the same order. */
export const MCHOSE_V3_MODES = ["Performance", "eSports", "Ultra"] as const;

export interface MchoseV3Dpi {
  profileIndex: number;
  /** 0 for X, 1 for Y. */
  axis: number;
  /** Stages the mouse cycles through. */
  stageCount: number;
  activeStage: number;
  /** Whether this model stores a separate Y-axis table at all. */
  hasSeparateY: boolean;
  /** Six stages, whatever `stageCount` says is live. */
  stages: number[];
}

export const MCHOSE_V3_DPI_STAGES = 6;

/** `0x0003` — one axis of the DPI table. */
export function mchoseV3DecodeDpi(data: Uint8Array): MchoseV3Dpi | null {
  if (data.length < 5 + MCHOSE_V3_DPI_STAGES * 2) return null;
  const stages: number[] = [];
  for (let stage = 0; stage < MCHOSE_V3_DPI_STAGES; stage += 1) {
    stages.push(u16(data, 5 + stage * 2));
  }
  return {
    profileIndex: data[0]!,
    axis: data[1]!,
    stageCount: data[2]!,
    activeStage: data[3]!,
    hasSeparateY: data[4]! === 1,
    stages,
  };
}

/** `0x0009` — lift-off on the models that moved it out of the sensor byte. */
export function mchoseV3DecodeLiftOff(data: Uint8Array): number | null {
  if (data.length < 1) return null;
  return data[0]!;
}

/**
 * Button action types. The same numbering as the V2's, except that the V3
 * marks an unassigned button `0xff` rather than leaving it at type 0, and its
 * value width varies with the type.
 */
export const MCHOSE_V3_BUTTON_UNSET = 0xff;

/** Value byte counts by type; anything unlisted carries two. */
const BUTTON_VALUE_WIDTH: Readonly<Record<number, number>> = {
  0x01: 3,
  0x22: 3,
  0x23: 7,
  0x24: 7,
};

/** Types whose value bytes are already in order rather than little-endian. */
const BUTTON_BIG_ENDIAN_TYPES = new Set([0x13, 0x16]);

export interface MchoseV3ButtonAssignment {
  type: number;
  /** Raw value bytes, most significant first. */
  value: number[];
}

/**
 * `0x0001` — the button table, which is a variable-width walk rather than a
 * fixed record: each entry's width depends on the type byte in front of it.
 *
 * Returns null if the walk would run past the payload, so a short or stale
 * reply is rejected instead of yielding half a table.
 */
export function mchoseV3DecodeButtons(
  data: Uint8Array,
): Record<string, MchoseV3ButtonAssignment> | null {
  const result: Record<string, MchoseV3ButtonAssignment> = {};
  let offset = 0;
  for (const name of MCHOSE_V3_BUTTONS) {
    if (offset >= data.length) return null;
    const type = data[offset]!;
    const width = BUTTON_VALUE_WIDTH[type] ?? 2;
    if (offset + 1 + width > data.length) return null;
    const raw = Array.from(data.slice(offset + 1, offset + 1 + width));
    result[name] = {
      type,
      value: BUTTON_BIG_ENDIAN_TYPES.has(type) ? raw : raw.reverse(),
    };
    offset += 1 + width;
  }
  return result;
}

export interface MchoseV3Product {
  name: string;
  /** The mouse's own product id, reported by `0x0900`. */
  productId: number;
  dpiMax: number;
  /** Lift-off steps in millimetres, in firmware index order. */
  liftOffDistances: readonly number[];
  maxPollingRate: number;
  /**
   * True when lift-off lives behind `0x0009` instead of the sensor byte. The
   * five-step models need it: three bits of ladder do not fit in the sensor
   * byte's two.
   */
  liftOffCommand: boolean;
}

const LOD_TWO = [1, 2] as const;
const LOD_THREE = [0.7, 1, 2] as const;
const LOD_FIVE = [0.7, 0.9, 1.2, 1.4, 1.7] as const;

/**
 * Every model on this protocol, from the bundle's own table. The A7 V3 family
 * is what this was written for; the rest share the wire format and the same
 * receivers, so leaving them out would mean resolving one of them to the wrong
 * DPI ceiling rather than not claiming it at all.
 */
export const MCHOSE_V3_PRODUCTS: readonly MchoseV3Product[] = [
  { name: "A5 V3 Pro", productId: 0x4035, dpiMax: 26000, liftOffDistances: LOD_TWO, maxPollingRate: 8000, liftOffCommand: false },
  { name: "A5 V3 Ultra+", productId: 0x4026, dpiMax: 42000, liftOffDistances: LOD_THREE, maxPollingRate: 8000, liftOffCommand: false },
  { name: "A5 V3 Ultra+ (3955)", productId: 0x4034, dpiMax: 50000, liftOffDistances: LOD_FIVE, maxPollingRate: 8000, liftOffCommand: true },
  { name: "K7 V2 Pro+", productId: 0x4027, dpiMax: 42000, liftOffDistances: LOD_THREE, maxPollingRate: 8000, liftOffCommand: false },
  { name: "K7 V2 Ultra+", productId: 0x4028, dpiMax: 50000, liftOffDistances: LOD_FIVE, maxPollingRate: 8000, liftOffCommand: true },
  { name: "A7 V3", productId: 0x4030, dpiMax: 26000, liftOffDistances: LOD_TWO, maxPollingRate: 8000, liftOffCommand: false },
  { name: "A7 V3 Pro", productId: 0x4031, dpiMax: 42000, liftOffDistances: LOD_THREE, maxPollingRate: 8000, liftOffCommand: false },
  { name: "A7 V3 Pro+", productId: 0x4032, dpiMax: 42000, liftOffDistances: LOD_THREE, maxPollingRate: 8000, liftOffCommand: false },
  { name: "A7 V3 Ultra+", productId: 0x4033, dpiMax: 50000, liftOffDistances: LOD_FIVE, maxPollingRate: 8000, liftOffCommand: true },
  { name: "K5 Pro", productId: 0x4037, dpiMax: 26000, liftOffDistances: LOD_TWO, maxPollingRate: 8000, liftOffCommand: false },
  { name: "K5 Ultra", productId: 0x4038, dpiMax: 50000, liftOffDistances: LOD_FIVE, maxPollingRate: 8000, liftOffCommand: true },
  { name: "R7 Ultra", productId: 0x4036, dpiMax: 50000, liftOffDistances: LOD_FIVE, maxPollingRate: 8000, liftOffCommand: true },
  { name: "V7", productId: 0x402a, dpiMax: 26000, liftOffDistances: LOD_TWO, maxPollingRate: 1000, liftOffCommand: false },
  { name: "G3 V3", productId: 0x4029, dpiMax: 12000, liftOffDistances: LOD_TWO, maxPollingRate: 1000, liftOffCommand: false },
];

/**
 * Receivers, shared across the whole generation — which is exactly why a model
 * cannot be resolved from the host-facing product id and `0x0900` has to be
 * asked. `receiver1k` serves the two 1000 Hz models.
 */
export const MCHOSE_V3_LINK_PRODUCT_IDS = {
  receiver: 0x1014,
  receiver8k: 0x1018,
  receiver1k: 0x1016,
} as const;

const V3_LINK_IDS: readonly number[] = Object.values(MCHOSE_V3_LINK_PRODUCT_IDS);

/**
 * Every product id this protocol answers on: the mice over their own cable,
 * plus the receivers. The V2 driver subtracts this set from its own match, so
 * anything added here has to be a V3 device.
 */
export const MCHOSE_V3_PRODUCT_IDS: readonly number[] = [
  ...MCHOSE_V3_PRODUCTS.map((product) => product.productId),
  ...V3_LINK_IDS,
];

export function mchoseV3IsProductId(productId: number): boolean {
  return MCHOSE_V3_PRODUCT_IDS.includes(productId);
}

/** Rate lists the firmware exposes, keyed by the model's maximum. */
export const MCHOSE_V3_POLLING_RATES: Readonly<Record<number, readonly number[]>> = {
  1000: [125, 500, 1000],
  8000: [125, 500, 1000, 2000, 4000, 8000],
};

/**
 * Resolve a model from the id `0x0900` reports, falling back to the product
 * string. An unrecognised device yields null rather than a wrong DPI ceiling.
 */
export function mchoseV3FindProduct(
  mouseProductId: number | null,
  productName?: string | null,
): MchoseV3Product | null {
  const byId = MCHOSE_V3_PRODUCTS.find((product) => product.productId === mouseProductId);
  if (byId) return byId;
  const name = productName?.trim().toUpperCase() ?? "";
  if (!name) return null;
  // Longest name first so "A7 V3 Pro+" is not swallowed by "A7 V3 Pro".
  return [...MCHOSE_V3_PRODUCTS]
    .sort((a, b) => b.name.length - a.name.length)
    .find((product) => name.includes(product.name.toUpperCase())) ?? null;
}

/** Polling rates available to a model. */
export function mchoseV3PollingRates(product: MchoseV3Product): readonly number[] {
  return MCHOSE_V3_POLLING_RATES[product.maxPollingRate] ?? MCHOSE_V3_POLLING_RATES[1000]!;
}

/** Lift-off labels, matching the ladder the model actually has. */
export function mchoseV3LiftOffLabels(product: MchoseV3Product): string[] {
  return product.liftOffDistances.map((mm) => `${mm} mm`);
}

/**
 * Position a lift-off index on the shell's three-stop Low/Medium/High scale.
 *
 * The five-step models do not fit that scale, so this buckets them: the lowest
 * step is Low, the highest is High, everything in between is Medium. The exact
 * millimetre figure is the thing actually worth reporting and it survives in
 * {@link mchoseV3LiftOffLabels}; this is only what the shared status field can
 * carry.
 */
export function mchoseV3LiftOffStop(
  product: MchoseV3Product,
  index: number,
): "Low" | "Medium" | "High" | null {
  const steps = product.liftOffDistances.length;
  if (index < 0 || index >= steps) return null;
  if (index === 0) return "Low";
  if (index === steps - 1) return "High";
  return "Medium";
}
