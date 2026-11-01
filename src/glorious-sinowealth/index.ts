/**
 * Pure encoding rules for the original wired Glorious Model O / O- and Model D /
 * D- (SinoWealth firmware, USB `258a:0036` and `258a:0033`) and the Model O
 * Eternal (`3794:a000`).
 *
 * These are not the "classic" Glorious wireless line in ../glorious-classic/
 * (a 64-byte unnumbered report) and not the Pixart Model O 2 family in
 * ../glorious/. They are the generic SinoWealth mouse protocol that
 * libratbag's `driver-sinowealth.c` (MIT) and OpenRGB's SinowealthController
 * implement, and that the vendor's "Glorious Model O Software" speaks: a short
 * command on feature report 5 selects what feature report 4 (or 6 on "long"
 * firmware) answers, and settings travel as one block that is read, modified
 * and written back whole. Offsets below are buffer indexes with the report id
 * at [0], as in both sources.
 *
 * Nothing here has been exercised on hardware by this project yet. Both
 * sources document the 0036/0033 PIDs and the offsets; unknown bytes are
 * preserved, never written with guessed values.
 */

export const GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID = 5;
/** 6-byte command frame, report id first. */
export const GLORIOUS_SINOWEALTH_COMMAND_LENGTH = 6;
export const GLORIOUS_SINOWEALTH_CONFIG_REPORT_ID = 4;
/** Some firmwares answer the config block on report 6 instead (libratbag's "long" devices). */
export const GLORIOUS_SINOWEALTH_CONFIG_LONG_REPORT_ID = 6;
/** Size of the largest feature report the vendor interface declares. */
export const GLORIOUS_SINOWEALTH_REPORT_LENGTH = 520;
/** Config block sizes seen across SinoWealth firmwares (report id included). */
export const GLORIOUS_SINOWEALTH_CONFIG_SIZE_MIN = 123;
export const GLORIOUS_SINOWEALTH_CONFIG_SIZE_MAX = 167;

export const GLORIOUS_SINOWEALTH_CMD_FIRMWARE = 0x01;
export const GLORIOUS_SINOWEALTH_CMD_GET_CONFIG = 0x11;
export const GLORIOUS_SINOWEALTH_CMD_DEBOUNCE = 0x1a;

export const GLORIOUS_SINOWEALTH_VENDOR_ID = 0x258a;
export const GLORIOUS_SINOWEALTH_ETERNAL_VENDOR_ID = 0x3794;

/** Vendor collection carrying reports 4 and 5. */
export const GLORIOUS_SINOWEALTH_USAGE_PAGE = 0xff00;

export interface GloriousSinowealthProduct {
  vendorId: number;
  productId: number;
  name: string;
  /** True only after this exact PID was exercised on hardware. */
  verified: boolean;
}

/**
 * libratbag `data/devices/glorious-model-{o,d,o-eternal}.device` and OpenRGB's
 * `SinowealthControllerDetect.cpp` agree on 0036 and 0033. An older Model O
 * firmware (V102) shares the generic SinoWealth id 0x0027 with other brands'
 * mice and is deliberately not claimed: telling them apart needs the firmware
 * string, which a browser cannot always read.
 */
export const GLORIOUS_SINOWEALTH_PRODUCTS: readonly GloriousSinowealthProduct[] = [
  { vendorId: GLORIOUS_SINOWEALTH_VENDOR_ID, productId: 0x0036, name: "Model O / O-", verified: false },
  { vendorId: GLORIOUS_SINOWEALTH_VENDOR_ID, productId: 0x0033, name: "Model D / D-", verified: false },
  { vendorId: GLORIOUS_SINOWEALTH_ETERNAL_VENDOR_ID, productId: 0xa000, name: "Model O Eternal", verified: false },
];

export function gloriousSinowealthProduct(vendorId: number, productId: number): GloriousSinowealthProduct | undefined {
  return GLORIOUS_SINOWEALTH_PRODUCTS.find((product) => product.vendorId === vendorId && product.productId === productId);
}

// ---------------------------------------------------------------------------
// Config block layout (buffer indexes, report id at [0])
// ---------------------------------------------------------------------------

const OFFSET_SENSOR = 0x09;
const OFFSET_POLLING = 0x0a; // low nibble rate code, high nibble flags
const OFFSET_STAGES = 0x0b; // low nibble stage count, high nibble active (1-based among enabled)
const OFFSET_DISABLED = 0x0c; // bit set: stage slot disabled
const OFFSET_DPI = 0x0d; // 8 slots, 1 byte each, or 2 (x, y) when XY-independent
const OFFSET_EFFECT = 0x35;
const OFFSET_GLORIOUS = 0x36;
const OFFSET_SINGLE = 0x38;
const OFFSET_SINGLE_COLOR = 0x39;
const OFFSET_BREATHING = 0x54;
const OFFSET_WAVE = 0x7c;
const OFFSET_BREATHING1 = 0x7d;
const OFFSET_BREATHING1_COLOR = 0x7e;

const FLAG_XY_INDEPENDENT = 0x8;
export const GLORIOUS_SINOWEALTH_SLOT_COUNT = 8;
export const GLORIOUS_SINOWEALTH_DPI_STEP = 100;
/** The vendor software goes no lower than 400 DPI, though the sensor accepts 100. */
export const GLORIOUS_SINOWEALTH_DPI_MIN = 400;

export const GLORIOUS_SINOWEALTH_POLLING_CODES: Readonly<Record<number, number>> = {
  125: 0x01,
  250: 0x02,
  500: 0x03,
  1000: 0x04,
};
export const GLORIOUS_SINOWEALTH_POLLING_RATES = [125, 250, 500, 1000] as const;

/** Debounce is stored as ms / 2; the vendor software allows 4-16 ms. */
export const GLORIOUS_SINOWEALTH_DEBOUNCE_MS = [4, 6, 8, 10, 12, 14, 16] as const;

/** Sensor ids at [9] from libratbag; PMW3327/PMW3360 store `(dpi - 100) / 100`, the others `dpi / 100`. */
const SENSORS: Readonly<Record<number, { name: string; maxDpi: number; offsetByOne: boolean }>> = {
  0x06: { name: "PMW3360", maxDpi: 12000, offsetByOne: true },
  0x08: { name: "PMW3212", maxDpi: 7200, offsetByOne: false },
  0x0e: { name: "PMW3327", maxDpi: 10200, offsetByOne: true },
  0x0f: { name: "PMW3389", maxDpi: 16000, offsetByOne: false },
};

export const GLORIOUS_SINOWEALTH_EFFECT_OFF = 0x00;
export const GLORIOUS_SINOWEALTH_EFFECT_GLORIOUS = 0x01;
export const GLORIOUS_SINOWEALTH_EFFECT_STATIC = 0x02;
export const GLORIOUS_SINOWEALTH_EFFECT_BREATHING = 0x05;
export const GLORIOUS_SINOWEALTH_EFFECT_WAVE = 0x09;
export const GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE = 0x0a;
/** The value mice with no LEDs report; never overwritten. */
export const GLORIOUS_SINOWEALTH_EFFECT_NONE = 0xff;

export type GloriousSinowealthEffect =
  | typeof GLORIOUS_SINOWEALTH_EFFECT_OFF
  | typeof GLORIOUS_SINOWEALTH_EFFECT_GLORIOUS
  | typeof GLORIOUS_SINOWEALTH_EFFECT_STATIC
  | typeof GLORIOUS_SINOWEALTH_EFFECT_BREATHING
  | typeof GLORIOUS_SINOWEALTH_EFFECT_WAVE
  | typeof GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE;

/** Brightness nibble 1-4 (libratbag), shown as 25-100 %. */
export const GLORIOUS_SINOWEALTH_MAX_BRIGHTNESS = 4;
/** Speed nibble 1-3: slow, normal, fast. */
export const GLORIOUS_SINOWEALTH_MAX_SPEED = 3;

export interface GloriousSinowealthRgb { r: number; g: number; b: number }

export interface GloriousSinowealthStage {
  /** Index into the block's 8 slots. */
  slot: number;
  /** Null when the sensor byte is unknown, so the stored value cannot be turned into DPI. */
  dpi: number | null;
}

export interface GloriousSinowealthEffectParams {
  brightness: number;
  speed: number;
}

export interface GloriousSinowealthConfig {
  sensor: number;
  sensorName: string | null;
  maxDpi: number | null;
  pollingHz: number | null;
  xyIndependent: boolean;
  /** Enabled stages in slot order; the active stage indexes this list. */
  stages: GloriousSinowealthStage[];
  /** 0-based index into `stages`. */
  activeStage: number;
  effect: number;
  /** Single-colour effects' colour, when the block is long enough to hold it. */
  staticColor: GloriousSinowealthRgb | null;
  breathingSingleColor: GloriousSinowealthRgb | null;
  glorious: GloriousSinowealthEffectParams;
  static: GloriousSinowealthEffectParams;
  breathing: GloriousSinowealthEffectParams;
  wave: GloriousSinowealthEffectParams | null;
  breathingSingle: GloriousSinowealthEffectParams | null;
}

function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/** A 6-byte command frame, report id first: `[05 cmd 00 00 00 00]`. */
export function gloriousSinowealthEncodeCommand(command: number, argument = 0): Uint8Array {
  const frame = new Uint8Array(GLORIOUS_SINOWEALTH_COMMAND_LENGTH);
  frame[0] = GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID;
  frame[1] = command;
  frame[2] = argument;
  return frame;
}

/** Throws unless `reply` is report 5 answering `command`. */
export function gloriousSinowealthCheckCommandReply(reply: Uint8Array, command: number): void {
  if (reply.length < 3 || reply[0] !== GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID || reply[1] !== command) {
    throw new Error(`The Glorious mouse answered command 0x${command.toString(16)} with ${hex(reply.subarray(0, 8))}.`);
  }
}

/** `[05 1a n ..]` -> n * 2 ms. */
export function gloriousSinowealthDecodeDebounce(reply: Uint8Array): number {
  gloriousSinowealthCheckCommandReply(reply, GLORIOUS_SINOWEALTH_CMD_DEBOUNCE);
  const milliseconds = reply[2]! * 2;
  if (!(GLORIOUS_SINOWEALTH_DEBOUNCE_MS as readonly number[]).includes(milliseconds)) {
    throw new Error(`The Glorious mouse reported a debounce of ${milliseconds} ms, outside ${GLORIOUS_SINOWEALTH_DEBOUNCE_MS[0]}-${GLORIOUS_SINOWEALTH_DEBOUNCE_MS[GLORIOUS_SINOWEALTH_DEBOUNCE_MS.length - 1]} ms.`);
  }
  return milliseconds;
}

export function gloriousSinowealthEncodeDebounce(milliseconds: number): Uint8Array {
  if (!(GLORIOUS_SINOWEALTH_DEBOUNCE_MS as readonly number[]).includes(milliseconds)) {
    throw new Error(`Glorious debounce ${milliseconds} ms is not one of ${GLORIOUS_SINOWEALTH_DEBOUNCE_MS.join(", ")}.`);
  }
  return gloriousSinowealthEncodeCommand(GLORIOUS_SINOWEALTH_CMD_DEBOUNCE, milliseconds / 2);
}

/**
 * Throws unless `block` is a settings answer (report 4 or 6, command 0x11)
 * with at least the bytes every firmware has.
 */
export function gloriousSinowealthCheckConfig(block: Uint8Array): void {
  const reportOk = block[0] === GLORIOUS_SINOWEALTH_CONFIG_REPORT_ID || block[0] === GLORIOUS_SINOWEALTH_CONFIG_LONG_REPORT_ID;
  if (block.length < GLORIOUS_SINOWEALTH_CONFIG_SIZE_MIN || !reportOk || block[1] !== GLORIOUS_SINOWEALTH_CMD_GET_CONFIG) {
    throw new Error(`The Glorious mouse answered its settings request with ${block.length} bytes starting ${hex(block.subarray(0, 8))}.`);
  }
}

/**
 * The true size of the settings block (report id included), which also goes
 * into the write header. A reply of the declared size is its own size; a
 * reply padded to the interface's largest report (520) is only trusted when
 * the descriptor declares the block's own length. Null when neither holds,
 * and writes are then refused.
 */
export function gloriousSinowealthConfigSize(received: number, declared: number | null): number | null {
  const inRange = (size: number) => size >= GLORIOUS_SINOWEALTH_CONFIG_SIZE_MIN && size <= GLORIOUS_SINOWEALTH_CONFIG_SIZE_MAX;
  if (inRange(received)) return received;
  if (declared !== null && inRange(declared)) return declared;
  return null;
}

function rgbAt(block: Uint8Array, offset: number): GloriousSinowealthRgb | null {
  if (offset + 3 > block.length) return null;
  // The Model O's LED takes red, blue, green (libratbag `LedType=RBG`, OpenRGB).
  return { r: block[offset]!, g: block[offset + 2]!, b: block[offset + 1]! };
}

function params(block: Uint8Array, offset: number): GloriousSinowealthEffectParams | null {
  if (offset >= block.length) return null;
  return { brightness: block[offset]! >> 4, speed: block[offset]! & 0x0f };
}

function rawToDpi(sensor: number, raw: number): number | null {
  const info = SENSORS[sensor];
  if (!info) return null;
  return (raw + (info.offsetByOne ? 1 : 0)) * GLORIOUS_SINOWEALTH_DPI_STEP;
}

function dpiToRaw(sensor: number, dpi: number): number {
  const info = SENSORS[sensor];
  if (!info) throw new Error(`Glorious sensor 0x${sensor.toString(16)} is unknown; not writing a DPI.`);
  if (!Number.isInteger(dpi) || dpi % GLORIOUS_SINOWEALTH_DPI_STEP !== 0 || dpi < GLORIOUS_SINOWEALTH_DPI_MIN || dpi > info.maxDpi) {
    throw new Error(`Glorious DPI ${dpi} is not a multiple of ${GLORIOUS_SINOWEALTH_DPI_STEP} between ${GLORIOUS_SINOWEALTH_DPI_MIN} and ${info.maxDpi}.`);
  }
  return dpi / GLORIOUS_SINOWEALTH_DPI_STEP - (info.offsetByOne ? 1 : 0);
}

/** DPI values the sensor in `block` accepts, or an empty list for an unknown sensor. */
export function gloriousSinowealthDpiOptions(block: Uint8Array): number[] {
  const info = SENSORS[block[OFFSET_SENSOR]!];
  if (!info) return [];
  const options: number[] = [];
  for (let dpi = GLORIOUS_SINOWEALTH_DPI_MIN; dpi <= info.maxDpi; dpi += GLORIOUS_SINOWEALTH_DPI_STEP) options.push(dpi);
  return options;
}

function slotOffset(block: Uint8Array, slot: number): number {
  return OFFSET_DPI + (block[OFFSET_POLLING]! & (FLAG_XY_INDEPENDENT << 4) ? 2 : 1) * slot;
}

/** Decodes a checked settings block. */
export function gloriousSinowealthDecodeConfig(block: Uint8Array): GloriousSinowealthConfig {
  const sensor = block[OFFSET_SENSOR]!;
  const info = SENSORS[sensor];
  const disabled = block[OFFSET_DISABLED]!;
  const stages: GloriousSinowealthStage[] = [];
  for (let slot = 0; slot < GLORIOUS_SINOWEALTH_SLOT_COUNT; slot++) {
    if (disabled & (1 << slot)) continue;
    stages.push({ slot, dpi: rawToDpi(sensor, block[slotOffset(block, slot)]!) });
  }
  const pollingCode = block[OFFSET_POLLING]! & 0x0f;
  const pollingHz = GLORIOUS_SINOWEALTH_POLLING_RATES.find((hz) => GLORIOUS_SINOWEALTH_POLLING_CODES[hz] === pollingCode) ?? null;
  return {
    sensor,
    sensorName: info?.name ?? null,
    maxDpi: info?.maxDpi ?? null,
    pollingHz,
    xyIndependent: ((block[OFFSET_POLLING]! >> 4) & FLAG_XY_INDEPENDENT) !== 0,
    stages,
    activeStage: (block[OFFSET_STAGES]! >> 4) - 1,
    effect: block[OFFSET_EFFECT]!,
    staticColor: rgbAt(block, OFFSET_SINGLE_COLOR),
    breathingSingleColor: rgbAt(block, OFFSET_BREATHING1_COLOR),
    glorious: params(block, OFFSET_GLORIOUS)!,
    static: params(block, OFFSET_SINGLE)!,
    breathing: params(block, OFFSET_BREATHING)!,
    wave: params(block, OFFSET_WAVE),
    breathingSingle: params(block, OFFSET_BREATHING1),
  };
}

function editable(block: Uint8Array): Uint8Array {
  return Uint8Array.from(block);
}

/** Returns a copy of `block` with the polling code replaced (flag nibble kept). */
export function gloriousSinowealthWithPollingRate(block: Uint8Array, hz: number): Uint8Array {
  const code = GLORIOUS_SINOWEALTH_POLLING_CODES[hz];
  if (code === undefined) {
    throw new Error(`Glorious polling rate ${hz} Hz is not one of ${GLORIOUS_SINOWEALTH_POLLING_RATES.join(", ")}.`);
  }
  const next = editable(block);
  next[OFFSET_POLLING] = (next[OFFSET_POLLING]! & 0xf0) | code;
  return next;
}

/**
 * Returns a copy of `block` with the `stage`-th enabled stage set to `dpi`.
 * With independent X/Y stages both axes are written, so the stage is no
 * longer independent.
 */
export function gloriousSinowealthWithStageDpi(block: Uint8Array, stage: number, dpi: number): Uint8Array {
  const { stages } = gloriousSinowealthDecodeConfig(block);
  const entry = stages[stage];
  if (!entry) throw new Error(`Glorious DPI stage ${stage} is outside 0-${stages.length - 1}.`);
  const raw = dpiToRaw(block[OFFSET_SENSOR]!, dpi);
  const next = editable(block);
  const offset = slotOffset(next, entry.slot);
  next[offset] = raw;
  if ((next[OFFSET_POLLING]! >> 4) & FLAG_XY_INDEPENDENT) next[offset + 1] = raw;
  return next;
}

/** Returns a copy of `block` with the active stage (0-based among the enabled ones) replaced. */
export function gloriousSinowealthWithActiveStage(block: Uint8Array, stage: number): Uint8Array {
  const { stages } = gloriousSinowealthDecodeConfig(block);
  if (!Number.isInteger(stage) || stage < 0 || stage >= stages.length) {
    throw new Error(`Glorious DPI stage ${stage} is outside 0-${stages.length - 1}.`);
  }
  const next = editable(block);
  next[OFFSET_STAGES] = ((stage + 1) << 4) | (next[OFFSET_STAGES]! & 0x0f);
  return next;
}

export interface GloriousSinowealthLightingChange {
  effect: GloriousSinowealthEffect;
  brightness?: number;
  speed?: number;
  /** Static and single-colour breathing only. */
  color?: GloriousSinowealthRgb;
}

/** Whether a block is long enough to hold an effect's parameters. */
export function gloriousSinowealthSupportsEffect(block: Uint8Array, effect: GloriousSinowealthEffect): boolean {
  if (block[OFFSET_EFFECT] === GLORIOUS_SINOWEALTH_EFFECT_NONE) return false;
  switch (effect) {
    case GLORIOUS_SINOWEALTH_EFFECT_OFF: return true;
    case GLORIOUS_SINOWEALTH_EFFECT_WAVE: return block.length > OFFSET_WAVE;
    case GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE: return block.length >= OFFSET_BREATHING1_COLOR + 3;
    default: return block.length >= OFFSET_SINGLE_COLOR + 3;
  }
}

function checkNibble(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Glorious ${name} ${value} is outside ${min}-${max}.`);
}

/**
 * Returns a copy of `block` with the effect selected and that effect's own
 * parameter bytes updated; other effects' bytes are left as stored. Refuses a
 * mouse whose effect byte says it has no LEDs.
 */
export function gloriousSinowealthWithLighting(block: Uint8Array, change: GloriousSinowealthLightingChange): Uint8Array {
  if (!gloriousSinowealthSupportsEffect(block, change.effect)) {
    throw new Error(`This Glorious mouse's settings block cannot hold lighting effect ${change.effect}.`);
  }
  const next = editable(block);
  next[OFFSET_EFFECT] = change.effect;
  if (change.effect === GLORIOUS_SINOWEALTH_EFFECT_OFF) return next;

  const offset = change.effect === GLORIOUS_SINOWEALTH_EFFECT_GLORIOUS ? OFFSET_GLORIOUS
    : change.effect === GLORIOUS_SINOWEALTH_EFFECT_STATIC ? OFFSET_SINGLE
      : change.effect === GLORIOUS_SINOWEALTH_EFFECT_BREATHING ? OFFSET_BREATHING
        : change.effect === GLORIOUS_SINOWEALTH_EFFECT_WAVE ? OFFSET_WAVE
          : OFFSET_BREATHING1;
  let brightness = next[offset]! >> 4;
  let speed = next[offset]! & 0x0f;
  if (change.brightness !== undefined) {
    checkNibble("brightness", change.brightness, 1, GLORIOUS_SINOWEALTH_MAX_BRIGHTNESS);
    brightness = change.brightness;
  }
  if (change.effect === GLORIOUS_SINOWEALTH_EFFECT_STATIC) {
    // A static colour has no speed (OpenRGB writes 0).
    if (change.speed !== undefined) throw new Error("Glorious Static lighting has no speed.");
    speed = 0;
  } else if (change.speed !== undefined) {
    checkNibble("lighting speed", change.speed, 1, GLORIOUS_SINOWEALTH_MAX_SPEED);
    speed = change.speed;
  }
  next[offset] = (brightness << 4) | speed;

  if (change.color !== undefined) {
    const colorOffset = change.effect === GLORIOUS_SINOWEALTH_EFFECT_STATIC ? OFFSET_SINGLE_COLOR
      : change.effect === GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE ? OFFSET_BREATHING1_COLOR
        : null;
    if (colorOffset === null) throw new Error("Only Static and Breathing single lighting take a colour on this Glorious mouse.");
    next.set([change.color.r, change.color.b, change.color.g], colorOffset);
  }
  return next;
}

/**
 * The settings write: the block as read, byte [3] set to its size minus 8
 * (libratbag `config_size - 8`, OpenRGB `0x7b` for a 131-byte block), padded
 * with zeros to `frameLength`. `size` comes from `gloriousSinowealthConfigSize`.
 */
export function gloriousSinowealthEncodeConfigWrite(block: Uint8Array, size: number, frameLength: number): Uint8Array {
  if (block.length < size) throw new Error(`Glorious settings block is ${block.length} bytes; expected ${size}.`);
  if (frameLength < size) throw new Error(`Glorious write report of ${frameLength} bytes cannot hold a ${size}-byte settings block.`);
  const frame = new Uint8Array(frameLength);
  frame.set(block.subarray(0, size));
  frame[3] = size - 8;
  return frame;
}
