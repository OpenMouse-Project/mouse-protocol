/**
 * Wooting analog keyboard vendor HID protocol — transport-independent codec.
 *
 * Wire mechanics mirror the official Wooting RGB SDK (`src/wooting-usb.c`,
 * `wooting_usb_send_feature_buff`). Commands are 8-byte HID *feature* reports:
 *
 *   [reportIndex, magic0, magic1, commandId, param3, param2, param1, param0]
 *
 * where `magic0`/`magic1` are `0xD0`/`0xDA` on single-report (v1/v2-interface)
 * devices and `0xD1`/`0xDA` on multi-report (v3) devices, and `reportIndex`
 * (0 or 1) matches. Note the SDK writes the four parameters in reverse order
 * (param3 first). The response is read back as an *input* report; its layout is
 * command-specific.
 *
 * The Wooting 60HE+ (VID `0x31E3`, PID `0x1322`) is a single-report,
 * v2-interface board, so it uses magic `0xD0`/`0xDA` and report index 0, and
 * exposes its config interface on vendor usage page `0xFF53`, usage `0x01`.
 *
 * These helpers are read-only building blocks: OpenMouse uses them to identify
 * a board and, where the browser permits, read its device config. No firmware
 * flashing, profile writes, or key remapping live here.
 */

/** Wooting "VID2" — used by every Hall-effect / ARM board (Two HE, 60HE, 60HE+, 80HE…). */
export const WOOTING_VENDOR_ID = 0x31e3;
/** Atmel VID on the original AVR boards (Wooting One / Two). Kept for discovery only. */
export const WOOTING_LEGACY_VENDOR_ID = 0x03eb;

/**
 * Vendor config interface exposed over WebHID. The 60HE+ presents several
 * vendor-defined collections; only `0xFF55` usage `0x01` declares a writable
 * feature report (confirmed on hardware — the `0xFF53` collection is the
 * analog/HID data stream and declares no feature report, so a WebHID feature
 * write there fails). `0xFF00` is the legacy generic interface on older boards.
 */
export const WOOTING_CONFIG_USAGE_PAGE = 0xff55;
export const WOOTING_CONFIG_USAGE_PAGE_LEGACY = 0xff00;
/** The analog/HID data stream — not used for commands. */
export const WOOTING_ANALOG_USAGE_PAGE = 0xff53;
export const WOOTING_CONFIG_USAGE = 0x01;

export interface WootingProduct {
  name: string;
  /** True only once the board has been exercised on real hardware through OpenMouse. */
  verified: boolean;
}

/**
 * Known product IDs. Only the 60HE+ is listed until other boards are captured
 * with `openmouse-collect` and confirmed on hardware.
 */
export const WOOTING_PRODUCTS: ReadonlyMap<number, WootingProduct> = new Map([
  [0x1322, { name: "Wooting 60HE+", verified: false }],
]);

export const WOOTING_PRODUCT_IDS: readonly number[] = [...WOOTING_PRODUCTS.keys()];

export const WOOTING_COMMAND_SIZE = 8;
export const WOOTING_MAGIC_SINGLE = 0xd0;
export const WOOTING_MAGIC_MULTI = 0xd1;
export const WOOTING_MAGIC_WORD_1 = 0xda;

/**
 * Command IDs from the D0DA command table (the `d0da` project's
 * `d0da_feature.py`, cross-checked with the RGB SDK). Only read-only queries are
 * listed here — deliberately NOT the neighbouring destructive ones
 * (`reset_to_bootloader = 0x02`, `keys_off = 0x15`, `do_soft_reset = 0x19`).
 */
export const WOOTING_COMMAND = {
  /** get_version — firmware version. */
  getVersion: 0x01,
  /** get_serial — device serial number. */
  getSerial: 0x03,
  /** get_current_keyboard_profile_index — which onboard profile is active. */
  getCurrentKeyboardProfileIndex: 0x0b,
  /** get_actuation_profile — per-key actuation overrides for a profile. */
  getActuationProfile: 0x31,
  /** get_keyboard_profile — the active profile: actuation (field 1, mm × 20480), rapid trigger, etc. */
  getKeyboardProfile: 0x27,
  /** get_settings — global device settings protobuf. */
  getSettings: 0x33,
  /** get_device_config — board layout / config block. */
  getDeviceConfig: 0x13,
} as const;

/** Total key travel of a Wooting Lekker/analog switch, in millimetres (0–255 maps onto this). */
export const WOOTING_TRAVEL_MM = 4.0;

/** Convert a raw 0–255 analog value to millimetres of travel. */
export function wootingAnalogMm(value: number): number {
  return (value / 255) * WOOTING_TRAVEL_MM;
}

/** One decoded protobuf field: its number, wire type, and value(s). */
export interface ProtobufField {
  field: number;
  wire: number;
  /** varint / 32-bit / 64-bit numeric value (wire 0/5/1). */
  int?: number;
  /** the same 32-/64-bit value read as a float, for spotting mm settings. */
  float?: number;
  /** length-delimited payload (wire 2) — sub-message or string/bytes. */
  bytes?: Uint8Array;
}

function readVarint(data: Uint8Array, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = at;
  while (i < data.length) {
    const byte = data[i]!;
    result += (byte & 0x7f) * 2 ** shift;
    i += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, i];
}

/**
 * Decode a protobuf message into its raw fields — no schema needed, because the
 * wire format tags every field with its number and type. Used to read the
 * Wooting profile blob and pick out the actuation / rapid-trigger values by
 * correlating with known settings. Returns [] if the bytes are not valid protobuf.
 */
export function decodeProtobufFields(data: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let i = 0;
  while (i < data.length) {
    const [tag, afterTag] = readVarint(data, i);
    if (tag === 0) break;
    i = afterTag;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      const [value, next] = readVarint(data, i);
      fields.push({ field, wire, int: value });
      i = next;
    } else if (wire === 2) {
      const [len, next] = readVarint(data, i);
      i = next;
      if (i + len > data.length) break;
      fields.push({ field, wire, bytes: data.slice(i, i + len) });
      i += len;
    } else if (wire === 5) {
      if (i + 4 > data.length) break;
      const view = new DataView(data.buffer, data.byteOffset + i, 4);
      fields.push({ field, wire, int: view.getUint32(0, true), float: view.getFloat32(0, true) });
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > data.length) break;
      const view = new DataView(data.buffer, data.byteOffset + i, 8);
      fields.push({ field, wire, int: Number(view.getBigUint64(0, true)), float: view.getFloat64(0, true) });
      i += 8;
    } else {
      break;
    }
  }
  return fields;
}

/** Decoded actuation / rapid-trigger settings for the active profile. */
export interface WootingActuation {
  /** Actuation point in millimetres (the depth at which a press registers). */
  actuationMm: number;
  /** Whether rapid trigger is enabled. */
  rapidTrigger: boolean;
  /** Rapid-trigger sensitivity in millimetres, when rapid trigger is on. */
  rapidTriggerSensitivityMm: number | null;
  /** Continuous rapid trigger (release only when the key fully lifts). */
  continuousRapidTrigger: boolean;
}

/** Raw global settings decoded from a get_settings (0x33) reply. */
export interface WootingGlobalSettings {
  /** Raw actuation value (nested field 1). Multiply by the mm factor to display. */
  actuationRaw: number | null;
  /** Raw rapid-trigger sensitivity value (nested field 2). */
  rapidTriggerSensitivityRaw: number | null;
}

/**
 * Decode the global settings from a `get_settings` (0x33) reply, confirmed on a
 * real 60HE+: `d1 da 33 88 <len:u16> <protobuf>`. The body's field 1 is a nested
 * message whose field 1 is the global actuation and field 2 the rapid-trigger
 * sensitivity (raw units). Example `08 05 10 0a` → actuation 5, RT sensitivity 10
 * for a keyboard set to 0.20mm / 0.15mm.
 */
/**
 * Decode the nested-message fields of a profile reply
 * (`magic magic cmd status <len:u16> 0a <len> <nested>`). Returns the nested
 * message's fields as {field, value}. Used to read the keyboard profile (0x27),
 * whose field 1 is the actuation (stored as mm × 20480).
 */
export function decodeWootingProfileFields(reply: Uint8Array): Array<{ field: number; value: number }> {
  if (reply.length < 6) return [];
  const length = reply[4]! | (reply[5]! << 8);
  const body = reply.subarray(6, 6 + length);
  const nested = decodeProtobufFields(body).find((field) => field.field === 1 && field.bytes);
  if (!nested?.bytes) return [];
  return decodeProtobufFields(nested.bytes)
    .filter((field) => field.int !== undefined)
    .map((field) => ({ field: field.field, value: field.int! }));
}

/**
 * Millimetres of actuation from the keyboard profile's raw value. Confirmed on a
 * 60HE+ across two settings: 1.00mm → 20480, 0.50mm → 18432, i.e. a line
 * `raw = 16384 + mm * 4096` (raw 0x4000 = 0mm, 0x8000 = 4mm).
 */
export const WOOTING_ACTUATION_ZERO = 16384;
export const WOOTING_ACTUATION_UNITS_PER_MM = 4096;
export function wootingActuationMm(raw: number): number {
  return (raw - WOOTING_ACTUATION_ZERO) / WOOTING_ACTUATION_UNITS_PER_MM;
}

export function decodeWootingGlobalSettings(reply: Uint8Array): WootingGlobalSettings | null {
  if (reply.length < 6 || reply[2] !== WOOTING_COMMAND.getSettings) return null;
  const length = reply[4]! | (reply[5]! << 8);
  const body = reply.subarray(6, 6 + length);
  const nested = decodeProtobufFields(body).find((field) => field.field === 1 && field.bytes);
  if (!nested?.bytes) return { actuationRaw: null, rapidTriggerSensitivityRaw: null };
  const sub = decodeProtobufFields(nested.bytes);
  const at = (n: number) => sub.find((field) => field.field === n)?.int ?? null;
  return { actuationRaw: at(1), rapidTriggerSensitivityRaw: at(2) };
}

export interface WootingCommandOptions {
  /** Multi-report (v3) boards use magic 0xD1 and report index 1. The 60HE+ does not. */
  multiReport?: boolean;
}

/**
 * Build the full 8-byte command buffer exactly as the SDK lays it out, with the
 * hidapi report-index byte first. Transports that take the report id separately
 * (WebHID) should send `buffer[0]` as the report id and `buffer.subarray(1)` as
 * the data — see {@link wootingFeatureReport}.
 */
export function encodeWootingCommand(
  commandId: number,
  param0 = 0,
  param1 = 0,
  param2 = 0,
  param3 = 0,
  { multiReport = false }: WootingCommandOptions = {},
): Uint8Array {
  const buffer = new Uint8Array(WOOTING_COMMAND_SIZE);
  buffer[0] = multiReport ? 1 : 0;
  buffer[1] = multiReport ? WOOTING_MAGIC_MULTI : WOOTING_MAGIC_SINGLE;
  buffer[2] = WOOTING_MAGIC_WORD_1;
  buffer[3] = commandId & 0xff;
  buffer[4] = param3 & 0xff;
  buffer[5] = param2 & 0xff;
  buffer[6] = param1 & 0xff;
  buffer[7] = param0 & 0xff;
  return buffer;
}

/**
 * Split an encoded command into the `{ reportId, data }` pair a WebHID
 * `sendFeatureReport(reportId, data)` call expects: the leading hidapi index
 * byte becomes the report id, and the remaining seven bytes are the data.
 */
export function wootingFeatureReport(buffer: Uint8Array) {
  return { reportId: buffer[0] ?? 0, data: buffer.slice(1) };
}

/**
 * Board physical layout as reported in the device-config response. Values follow
 * the SDK's `WOOTING_DEVICE_LAYOUT` enum (wooting-usb.h); anything outside it is
 * surfaced as `Unknown` with the raw id kept.
 */
export type WootingLayout = "ANSI" | "ISO" | "JIS" | "ANSI Split" | "ISO Split" | "Unknown";

/** SDK `WOOTING_DEVICE_LAYOUT` values → display names. */
const WOOTING_LAYOUTS: Readonly<Record<number, WootingLayout>> = {
  0: "ANSI",
  1: "ISO",
  2: "JIS",
  3: "ANSI Split",
  4: "ISO Split",
};

export interface WootingDeviceConfig {
  layout: WootingLayout;
  /** Raw layout byte, preserved for boards whose value we do not name yet. */
  layoutId: number;
}

/**
 * Offset of the layout byte inside the device-config response as WebHID delivers
 * it. The Wooting SDK reads index 10, but its buffer includes the leading
 * report-id byte that a WebHID `inputreport` event strips, so the same field
 * sits at index 9 here — confirmed against a 60HE+ reply
 * (`d1 da 13 88 07 00 00 00 00 00 …`, byte 9 = 0x00 = ANSI).
 */
export const WOOTING_DEVICE_CONFIG_LAYOUT_OFFSET = 9;

/**
 * Decode the layout out of a device-config response. `response` is the raw input
 * report payload (no report-id prefix, matching the WebHID `inputreport` event).
 * Returns `null` when the buffer is too short to trust.
 */
export function decodeWootingDeviceConfig(
  response: Uint8Array,
  offset: number = WOOTING_DEVICE_CONFIG_LAYOUT_OFFSET,
): WootingDeviceConfig | null {
  if (response.length <= offset) return null;
  const layoutId = response[offset]!;
  return { layout: WOOTING_LAYOUTS[layoutId] ?? "Unknown", layoutId };
}

/**
 * True when a buffer looks like a genuine Wooting command reply: it starts with
 * the magic word (`0xD0` or `0xD1`, then `0xDA`) and is long enough to carry a
 * command byte. Used to reject stub responses — e.g. a feature GET that echoes
 * only the report id — so the driver waits for the real input-report reply.
 */
export function isWootingReply(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && (bytes[0] === WOOTING_MAGIC_SINGLE || bytes[0] === WOOTING_MAGIC_MULTI)
    && bytes[1] === WOOTING_MAGIC_WORD_1;
}

/** Offset of the `major` byte in a get_version reply (minor/patch follow). */
export const WOOTING_VERSION_OFFSET = 6;

/**
 * Decode the firmware version out of a `get_version` reply.
 *
 * Confirmed against a real 60HE+ answer `d1 da 01 88 03 00 02 0d 00 …` whose
 * Wootility-reported version is v2.13.0: after the 4-byte header
 * (`magic0 magic1 command status`, status 0x88 = OK) and a two-byte leading
 * field, the version is `major minor patch` at offset 6 — here 2, 13, 0 → "2.13.0".
 * Returns null when the reply is not a version answer or carries no version.
 */
export function decodeWootingVersion(reply: Uint8Array): string | null {
  const o = WOOTING_VERSION_OFFSET;
  if (!isWootingReply(reply) || reply.length < o + 3) return null;
  const [major, minor, patch] = [reply[o]!, reply[o + 1]!, reply[o + 2]!];
  if (major === 0 && minor === 0 && patch === 0) return null;
  return `${major}.${minor}.${patch}`;
}

/** One key's live analog reading: a USB HID keyboard usage id and its 0–255 travel. */
export interface WootingAnalogKey {
  /** USB HID keyboard/keypad usage id (e.g. 0x04 = A). */
  usage: number;
  /** Analog value, 0 (released) to 255 (fully pressed). */
  value: number;
}

/**
 * Decode one analog input report from the Wooting analog stream (the 0xFF53
 * interface). The report is a run of 3-byte entries `[usageHigh, usage, value]`;
 * a full snapshot of the currently-pressed keys arrives on every event (a key at
 * value 0 / usage 0 is absent). Layout matches the community WebHID readers
 * (colecrouter/wooting-js). Returns the pressed keys in a stable order (by usage
 * id) so a live UI can keep each key's row in place instead of reordering as
 * values fluctuate.
 */
export function decodeWootingAnalogReport(data: Uint8Array): WootingAnalogKey[] {
  const keys: WootingAnalogKey[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) {
    const usage = data[i + 1]!;
    const value = data[i + 2]!;
    if (usage !== 0 && value !== 0) keys.push({ usage, value });
  }
  return keys.sort((a, b) => a.usage - b.usage);
}

/** Human name for a product id, falling back to a generic Wooting label. */
export function wootingProductName(productId: number): string {
  return WOOTING_PRODUCTS.get(productId)?.name ?? "Wooting keyboard";
}
