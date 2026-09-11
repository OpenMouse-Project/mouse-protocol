/**
 * Pure MCHOSE codecs, unit-tested without WebHID.
 *
 * Reverse-engineered from MCHOSE's own M HUB web driver and verified against an
 * A7 V2 Ultra+ on its 2.4 GHz receiver; see docs/mchose-protocol.md for the
 * capture notes and the dead ends.
 *
 * Transport: feature reports on the `0xff01` vendor collection. Report `0x11`
 * carries the short (20-byte) command set, report `0x12` the long (64-byte)
 * one. The distinguishing quirk is that **the whole command body is sent
 * bit-inverted, and replies come back inverted too**:
 *
 *   sendFeatureReport(0x11, [~cmd, ~arg0, …])
 *   receiveFeatureReport(0x11) -> [reportId, ~cmd, ~payload0, …]
 *
 * Only the bytes the vendor actually spells out are inverted; the rest of the
 * report is zero-padded, which is why replies carry unrelated trailing bytes —
 * the firmware leaves stale scratch data past the meaningful fields.
 */

export const MCHOSE_VENDOR_ID = 0x3837;

/** Vendor configuration collection. */
export const MCHOSE_CONFIG_USAGE_PAGE = 0xff01;
export const MCHOSE_CONFIG_USAGE = 0x0001;

/** Short command channel: command + 19 argument bytes. */
export const MCHOSE_SHORT_REPORT_ID = 0x11;
export const MCHOSE_SHORT_TOKENS = 20;
/** Long command channel: command + 63 argument bytes. */
export const MCHOSE_LONG_REPORT_ID = 0x12;
export const MCHOSE_LONG_TOKENS = 64;

export const MCHOSE_REPORT_LENGTH = 64;

export const MCHOSE_COMMAND = {
  /** Receiver identity: bond flag, ids, link state. */
  identity: 0x03,
  /** Firmware version, as a length-prefixed ASCII string. */
  version: 0x04,
  /** Mouse identity plus battery level and charge state. */
  battery: 0x06,
  /** Whole configuration blob: DPI stages, per-link indices, debounce, sleep. */
  config: 0x67,
  /** Writes the same blob back, one command byte in front of the same layout. */
  writeConfig: 0x57,
  /** Switches the active onboard profile; takes a single 0-based index. */
  setProfile: 0x58,
  /** Reassigns one button: `[buttonIndex, reserved, type, value u24 BE]`. */
  setButton: 0x52,
  /** Reads one button's name, which is where a macro's name lives. */
  readButtonName: 0x63,
  /** Reads one profile's name: `[index]`, replying index + ASCII. */
  readProfileName: 0x68,
  /** Sets the auto-sleep timer: `[enabled, minutes]`. */
  setSleep: 0x0a,
  /**
   * Performance block: `[lod, ripple, line, motionSync, _, _, mode,
   * rotateOpen, rotateVal]`.
   */
  setPerformance: 0x42,
} as const;

/**
 * The config blob's `sensor` byte (offset 17) is a bitfield holding lift-off
 * distance *and* the three processing toggles. Every one of these is written
 * through the performance command rather than the config write, and read back
 * out of this byte. Mapped bit by bit on hardware:
 *
 *   0x80 -> 0x90  motion sync on        (bit 4)
 *   0x90 -> 0x94  ripple control on     (bit 2)
 *   0x94 -> 0x9c  linear correction on  (bit 3)
 *
 * Bits 6-7 are the performance mode — see `MCHOSE_SENSOR_MODE_MASK` below. An
 * earlier reading of this byte took bit 7 alone to be a boolean "game mode",
 * which is wrong: M HUB offers three modes, and bit 6 is the other half.
 *
 * Lift-off therefore occupies only **bits 0-1**; treating it as three bits
 * would read ripple as part of the level. Bit 5 is still unexplained, so
 * writers must preserve the rest of the byte rather than assign it.
 */
export const MCHOSE_LOD_MASK = 0x03;
export const MCHOSE_SENSOR_RIPPLE = 0x04;
export const MCHOSE_SENSOR_LINEAR = 0x08;
export const MCHOSE_SENSOR_MOTION_SYNC = 0x10;

/**
 * Bits 6-7 hold the **performance mode**, which M HUB presents as a three-way
 * choice rather than a switch. Mapped on hardware by writing each value:
 *
 *   field 7 = 1 -> bits 00 -> Performance
 *   field 7 = 2 -> bits 10 -> eSports
 *   field 7 = 3 -> bits 11 -> Ultra
 *
 * Note the gap: the stored bit pattern is the mode number except for
 * Performance, which stores 0 rather than 1.
 */
export const MCHOSE_SENSOR_MODE_MASK = 0xc0;

export const MCHOSE_MODES: readonly string[] = ["Performance", "eSports", "Ultra"];

/** Decode bits 6-7 into a 1-based mode number. */
export function mchoseDecodeMode(sensor: number): number {
  const stored = (sensor & MCHOSE_SENSOR_MODE_MASK) >> 6;
  return stored === 0 ? 1 : stored;
}

export function mchoseModeName(sensor: number): string {
  return MCHOSE_MODES[mchoseDecodeMode(sensor) - 1] ?? MCHOSE_MODES[0]!;
}

export function mchoseModeNumber(name: string): number | null {
  const index = MCHOSE_MODES.indexOf(name);
  return index < 0 ? null : index + 1;
}

/**
 * Angle tuning, in the config blob at offset 49. M HUB offers -30 to +30
 * degrees; the byte is stored as-is, so negatives are two's complement. The
 * firmware does not validate the value — it stored 0xf1 and 0x8f unchanged —
 * so the range has to be enforced here.
 *
 * M HUB flags this control with "update the mouse firmware", so older firmware
 * may ignore it.
 */
export const MCHOSE_ANGLE_TUNING_OFFSET = 49;
export const MCHOSE_ANGLE_TUNING_MIN = -30;
export const MCHOSE_ANGLE_TUNING_MAX = 30;

export function mchoseDecodeAngleTuning(raw: number): number {
  const byte = raw & 0xff;
  return byte > 0x7f ? byte - 0x100 : byte;
}

export function mchoseEncodeAngleTuning(degrees: number): number {
  return degrees < 0 ? (degrees + 0x100) & 0xff : degrees & 0xff;
}

export function mchoseDecodeLiftOffIndex(sensor: number): number {
  return sensor & MCHOSE_LOD_MASK;
}

export interface MchoseProcessing {
  /** MCHOSE calls this "linear correction"; it is angle snapping. */
  angleSnapping: boolean;
  rippleControl: boolean;
  motionSync: boolean;
}

export function mchoseDecodeProcessing(sensor: number): MchoseProcessing {
  return {
    angleSnapping: (sensor & MCHOSE_SENSOR_LINEAR) !== 0,
    rippleControl: (sensor & MCHOSE_SENSOR_RIPPLE) !== 0,
    motionSync: (sensor & MCHOSE_SENSOR_MOTION_SYNC) !== 0,
  };
}

/**
 * Ripple, linear correction and motion sync use 1 = on and 2 = off, with 0
 * meaning "leave this one alone".
 */
const toggle = (value: boolean | undefined): number =>
  value === undefined ? 0 : value ? 1 : 2;

/**
 * Build the performance write.
 *
 * Lift-off must be supplied every time, because index 0 is a real level and so
 * cannot double as "unchanged" the way the toggles' 0 does. Pass only the
 * toggles being changed and the rest are left as they are.
 */
export function mchoseEncodePerformance(
  liftOffIndex: number,
  changes: Partial<MchoseProcessing> & { mode?: number; angleTuning?: number } = {},
): number[] {
  if (!Number.isInteger(liftOffIndex) || liftOffIndex < 0 || liftOffIndex > MCHOSE_LOD_MASK) {
    throw new Error(`Lift-off index must be 0-${MCHOSE_LOD_MASK}.`);
  }
  const tuning = changes.angleTuning;
  if (tuning !== undefined
    && (!Number.isInteger(tuning) || tuning < MCHOSE_ANGLE_TUNING_MIN || tuning > MCHOSE_ANGLE_TUNING_MAX)) {
    throw new Error(`Angle tuning must be ${MCHOSE_ANGLE_TUNING_MIN} to ${MCHOSE_ANGLE_TUNING_MAX} degrees.`);
  }
  const mode = changes.mode;
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 1 || mode > MCHOSE_MODES.length)) {
    throw new Error(`Mode must be 1-${MCHOSE_MODES.length}.`);
  }
  // [command, lod, ripple, line, motionSync, _, _, mode, rotateOpen, rotateVal]
  return [
    MCHOSE_COMMAND.setPerformance,
    liftOffIndex,
    toggle(changes.rippleControl),
    toggle(changes.angleSnapping),
    toggle(changes.motionSync),
    0,
    0,
    mode ?? 0,
    tuning === undefined ? 0 : 1,
    tuning === undefined ? 0 : mchoseEncodeAngleTuning(tuning),
  ];
}

/** Lift-off on its own, leaving every processing toggle untouched. */
export function mchoseEncodeLiftOff(index: number): number[] {
  return mchoseEncodePerformance(index);
}

/** The shared three-stop labels, positioned by how many steps a model offers. */
export type MchoseLiftOffLabel = "Low" | "Medium" | "High";

export function mchoseLiftOffLabels(steps: number): MchoseLiftOffLabel[] {
  if (steps >= 3) return ["Low", "Medium", "High"];
  if (steps === 2) return ["Low", "High"];
  return ["Low"];
}

/**
 * Auto-sleep is stored in whole minutes at offset 19 of the config blob, and
 * written with its own command rather than through the config write. Confirmed
 * on hardware: sending `0x0a 01 09` moved that byte from 0 to 9.
 *
 * The device is slower to apply this than a config write — it needs roughly a
 * second before the new value reads back.
 */
export const MCHOSE_SLEEP_MAX_MINUTES = 0xff;

/** Sleep timeouts offered in the UI, in seconds; 0 disables the timer. */
export const MCHOSE_SLEEP_OPTIONS: readonly number[] = [0, 60, 120, 180, 300, 600, 1800];

/** Longest debounce the firmware accepts, in milliseconds. */
export const MCHOSE_DEBOUNCE_MAX_MS = 20;

export function mchoseEncodeSleep(minutes: number): number[] {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MCHOSE_SLEEP_MAX_MINUTES) {
    throw new Error(`Sleep must be 0-${MCHOSE_SLEEP_MAX_MINUTES} minutes.`);
  }
  // The vendor pairs a "sleep enabled" flag with the value; 0 minutes is off.
  return [MCHOSE_COMMAND.setSleep, minutes > 0 ? 1 : 0, minutes];
}

/**
 * Onboard profiles, 0-based on the wire. The mouse holds three, each with its
 * own DPI stage table and its own per-link rate/stage pair — confirmed by
 * switching an A7 V2 Ultra+ through all three and reading each back.
 *
 * `0x67` has no profile argument: it always answers for whichever profile is
 * active, so reading another one means switching to it first.
 */
export const MCHOSE_PROFILE_COUNT = 3;

/** Build the `0x58` payload. `index` is 0-based, as the firmware expects. */
export function mchoseEncodeSetProfile(index: number): number[] {
  if (!Number.isInteger(index) || index < 0 || index >= MCHOSE_PROFILE_COUNT) {
    throw new Error(`MCHOSE profile index must be 0-${MCHOSE_PROFILE_COUNT - 1}.`);
  }
  return [MCHOSE_COMMAND.setProfile, index];
}

/**
 * Build a feature-report body. `tokens` is the command byte followed by its
 * arguments, exactly as the vendor spells them; everything given is inverted
 * and the remainder of the report stays zero.
 */
export function mchoseEncodeCommand(
  tokens: readonly number[],
  tokenCount: number,
): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(MCHOSE_REPORT_LENGTH);
  const spelled = Math.min(tokenCount, MCHOSE_REPORT_LENGTH);
  for (let index = 0; index < spelled; index += 1) {
    body[index] = ((tokens[index] ?? 0) ^ 0xff) & 0xff;
  }
  return body;
}

export interface MchoseReply {
  command: number;
  payload: Uint8Array;
}

/**
 * Decode a feature-report read. `raw` is the buffer as returned by
 * `receiveFeatureReport`, whose first byte is the report id.
 */
export function mchoseDecodeReply(raw: Uint8Array): MchoseReply | null {
  if (raw.length < 3) return null;
  const payload = new Uint8Array(raw.length - 2);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = ((raw[index + 2] ?? 0) ^ 0xff) & 0xff;
  }
  return { command: (~(raw[1] ?? 0)) & 0xff, payload };
}

const u16 = (data: Uint8Array, offset: number): number =>
  (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);

// ── 0x11 0x03 identity ─────────────────────────────────────────────────────

export interface MchoseIdentity {
  bonded: boolean;
  vendorId: number;
  productId: number;
  connected: boolean;
  gameMode: number;
}

export function mchoseDecodeIdentity(payload: Uint8Array): MchoseIdentity | null {
  if (payload.length < 7) return null;
  return {
    bonded: (payload[0] ?? 0) !== 0,
    vendorId: u16(payload, 1),
    productId: u16(payload, 3),
    connected: (payload[5] ?? 0) !== 0,
    gameMode: payload[6] ?? 0,
  };
}

// ── 0x11 0x04 firmware version ─────────────────────────────────────────────

/** Length-prefixed ASCII, e.g. `08 "5.46.2.4"`. */
export function mchoseDecodeVersion(payload: Uint8Array): string | null {
  const length = payload[0] ?? 0;
  if (!length || payload.length < 1 + length) return null;
  return String.fromCharCode(...payload.subarray(1, 1 + length));
}

// ── 0x11 0x06 battery ──────────────────────────────────────────────────────

export interface MchoseBattery {
  vendorId: number;
  /** The mouse's own product id, even when read through the receiver. */
  productId: number;
  firmwareVersion: number;
  connectMode: number;
  connected: boolean;
  batteryPercent: number;
  charging: boolean;
}

export function mchoseDecodeBattery(payload: Uint8Array): MchoseBattery | null {
  if (payload.length < 11) return null;
  // Bit fields are packed most-significant first: 3 bits mode, 1 bit status.
  const flags = payload[8] ?? 0;
  return {
    vendorId: u16(payload, 0),
    productId: u16(payload, 2),
    firmwareVersion: u16(payload, 4) | (u16(payload, 6) << 16),
    connectMode: (flags >> 5) & 0x07,
    connected: ((flags >> 4) & 0x01) !== 0,
    batteryPercent: payload[9] ?? 0,
    charging: (payload[10] ?? 0) !== 0,
  };
}

// ── 0x12 0x67 configuration ────────────────────────────────────────────────

export const MCHOSE_DPI_STAGES = 6;

export interface MchoseConfig {
  profileIndex: number;
  /** Active DPI stage and polling index on the 2.4 GHz link. */
  wirelessDpiIndex: number;
  wirelessRateIndex: number;
  /** Active DPI stage and polling index on the wired link. */
  wiredDpiIndex: number;
  wiredRateIndex: number;
  /** Six DPI stages, little-endian uint16 each. */
  dpiStages: number[];
  stageCount: number;
  sensor: number;
  /** Lift-off step, decoded out of the low bits of `sensor`. */
  liftOffIndex: number;
  /** Processing toggles, decoded out of the same `sensor` byte. */
  processing: MchoseProcessing;
  keyDebounce: number;
  sleep: number;
  /** Angle-tuning degrees at offset 49; 0 is no correction. */
  angleTuning: number;
  /** Performance mode name, from bits 6-7 of `sensor`. */
  mode: string;
}

/**
 * Note the reserved byte at offset 3: the DPI stages start at offset 4, not
 * immediately after the two index bytes.
 *
 * MCHOSE ships two schemas for this payload and they contradict each other.
 * The layout below is the one the hardware actually uses, confirmed on an
 * A7 V2 Ultra+ by reading it at two known settings:
 *
 *   125 Hz / 1600 DPI -> byte2 0x00   (rate index 0, stage 0)
 *   1000 Hz / 1600 DPI -> byte2 0x20  (rate index 2, stage 0)
 *
 * So the **wired** byte comes first, the **rate** is the high nibble, and the
 * rate is a plain index into the model's rate list with no skipped value. That
 * matches the vendor's write schema; its read schema has both the byte order
 * and the nibble order backwards. Do not "correct" this to match the latter.
 */
export function mchoseDecodeConfig(payload: Uint8Array): MchoseConfig | null {
  if (payload.length < 4 + MCHOSE_DPI_STAGES * 2) return null;
  const wired = payload[1] ?? 0;
  const wireless = payload[2] ?? 0;
  const dpiStages: number[] = [];
  for (let stage = 0; stage < MCHOSE_DPI_STAGES; stage += 1) {
    dpiStages.push(u16(payload, 4 + stage * 2));
  }
  return {
    profileIndex: payload[0] ?? 0,
    wirelessDpiIndex: wireless & 0x0f,
    wirelessRateIndex: (wireless >> 4) & 0x0f,
    wiredDpiIndex: wired & 0x0f,
    wiredRateIndex: (wired >> 4) & 0x0f,
    dpiStages,
    stageCount: payload[16] ?? 0,
    sensor: payload[17] ?? 0,
    liftOffIndex: mchoseDecodeLiftOffIndex(payload[17] ?? 0),
    processing: mchoseDecodeProcessing(payload[17] ?? 0),
    keyDebounce: payload[18] ?? 0,
    sleep: payload[19] ?? 0,
    angleTuning: mchoseDecodeAngleTuning(payload[MCHOSE_ANGLE_TUNING_OFFSET] ?? 0),
    mode: mchoseModeName(payload[17] ?? 0),
  };
}

/** Pack a link's rate/stage pair back into its byte: rate high, stage low. */
export function mchosePackLinkByte(rateIndex: number, dpiIndex: number): number {
  return (((rateIndex & 0x0f) << 4) | (dpiIndex & 0x0f)) & 0xff;
}

/**
 * Build the `0x57` write payload from a payload previously read with `0x67`.
 *
 * The write layout is exactly the read layout with a command byte in front, so
 * a change is applied by echoing every other byte back untouched — which is
 * what keeps button mappings, macros and DPI values from being wiped by a
 * partial write.
 */
export function mchoseEncodeConfigWrite(
  readPayload: Uint8Array,
  changes: {
    wiredRateIndex?: number;
    wiredDpiIndex?: number;
    wirelessRateIndex?: number;
    wirelessDpiIndex?: number;
    dpiStages?: readonly number[];
    keyDebounce?: number;
    stageCount?: number;
  } = {},
): number[] {
  const current = mchoseDecodeConfig(readPayload);
  if (!current) throw new Error("mchoseEncodeConfigWrite needs a decodable 0x67 payload");
  const out = [MCHOSE_COMMAND.writeConfig, ...readPayload];
  // +1 throughout: the command byte shifts every field by one.
  out[1 + 1] = mchosePackLinkByte(
    changes.wiredRateIndex ?? current.wiredRateIndex,
    changes.wiredDpiIndex ?? current.wiredDpiIndex,
  );
  out[1 + 2] = mchosePackLinkByte(
    changes.wirelessRateIndex ?? current.wirelessRateIndex,
    changes.wirelessDpiIndex ?? current.wirelessDpiIndex,
  );
  if (changes.dpiStages) {
    for (let stage = 0; stage < MCHOSE_DPI_STAGES; stage += 1) {
      const value = changes.dpiStages[stage] ?? current.dpiStages[stage] ?? 0;
      out[1 + 4 + stage * 2] = value & 0xff;
      out[1 + 4 + stage * 2 + 1] = (value >> 8) & 0xff;
    }
  }
  if (changes.keyDebounce !== undefined) out[1 + 18] = changes.keyDebounce & 0xff;
  if (changes.stageCount !== undefined) out[1 + 16] = changes.stageCount & 0xff;
  return out;
}

// ── model catalog ──────────────────────────────────────────────────────────

/**
 * PIDs shared by the whole A7 V2 family, so they identify a link rather than a
 * model. The receiver is the endpoint the host talks to; the mouse reports its
 * own model-specific id inside the battery reply.
 */
export const MCHOSE_LINK_PRODUCT_IDS = {
  receiver: 0x100b,
  bluetooth: 0x100a,
  receiver8k: 0x1020,
} as const;

export interface MchoseProduct {
  name: string;
  /** The mouse's own product id, model-specific. */
  productId: number;
  dpiMax: number;
  /** Lift-off steps in millimetres, in firmware index order. */
  liftOffDistances: readonly number[];
  /** Highest polling rate on a wired or 2.4 GHz link. */
  maxPollingRate: number;
}

/** The A7 V2 family, from the M HUB bundle's own model table. */
export const MCHOSE_PRODUCTS: readonly MchoseProduct[] = [
  { name: "A7 V2 Pro", productId: 0x4018, dpiMax: 26000, liftOffDistances: [1, 2], maxPollingRate: 8000 },
  { name: "A7 V2 Pro+", productId: 0x4023, dpiMax: 26000, liftOffDistances: [1, 2], maxPollingRate: 8000 },
  { name: "A7 V2 Ultra", productId: 0x4019, dpiMax: 42000, liftOffDistances: [0.7, 1, 2], maxPollingRate: 8000 },
  { name: "A7 V2 Ultra+", productId: 0x4021, dpiMax: 42000, liftOffDistances: [0.7, 1, 2], maxPollingRate: 8000 },
];

/** Rate lists the firmware exposes, keyed by the model's maximum rate. */
export const MCHOSE_POLLING_RATES: Readonly<Record<number, readonly number[]>> = {
  1000: [125, 500, 1000],
  4000: [125, 500, 1000, 2000, 4000],
  8000: [125, 500, 1000, 2000, 4000, 8000],
};

/**
 * Identify the model. The id inside the battery reply is decisive; the host-
 * facing PID is shared across the family, so the product string is the only
 * fallback, and an unrecognised one yields null rather than a wrong DPI ceiling.
 */
export function mchoseFindProduct(
  mouseProductId: number | null,
  productName?: string | null,
): MchoseProduct | null {
  const byId = MCHOSE_PRODUCTS.find((product) => product.productId === mouseProductId);
  if (byId) return byId;
  const name = productName?.trim().toUpperCase() ?? "";
  if (!name) return null;
  // Longest name first so "A7 V2 Ultra+" is not swallowed by "A7 V2 Ultra".
  return [...MCHOSE_PRODUCTS]
    .sort((a, b) => b.name.length - a.name.length)
    .find((product) => name.includes(product.name.toUpperCase())) ?? null;
}

/** Polling rates available on the link this host-facing product id represents. */
export function mchosePollingRates(
  product: MchoseProduct,
  hostProductId: number,
): readonly number[] {
  const max = hostProductId === MCHOSE_LINK_PRODUCT_IDS.bluetooth ? 1000 : product.maxPollingRate;
  return MCHOSE_POLLING_RATES[max] ?? MCHOSE_POLLING_RATES[1000]!;
}

export * from "./buttons.ts";
export * from "./dock.ts";
// The A7 V3 generation's protocol, which shares only a vendor id with the above.
export * from "./v3.ts";

/**
 * Profile names, read one at a time with `0x12 0x68 <index>`. The reply is the
 * profile index followed by a NUL-terminated ASCII name — the test hardware
 * answered "Config 1", "Config 2", "Config 3".
 */
export function mchoseEncodeReadProfileName(index: number): number[] {
  if (!Number.isInteger(index) || index < 0 || index >= MCHOSE_PROFILE_COUNT) {
    throw new Error(`MCHOSE profile index must be 0-${MCHOSE_PROFILE_COUNT - 1}.`);
  }
  return [MCHOSE_COMMAND.readProfileName, index];
}

export function mchoseDecodeProfileName(payload: Uint8Array): string | null {
  if (payload.length < 2) return null;
  let end = 1;
  while (end < payload.length && payload[end] !== 0) end += 1;
  const name = String.fromCharCode(...payload.subarray(1, end)).trim();
  return name.length ? name : null;
}
