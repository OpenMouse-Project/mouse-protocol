/**
 * Hitscan Utility 1.0.2 native HIDUsb.dll protocol, recovered statically.
 * See docs/hitscan/HID-{COMMANDS,CONFIG}.md for instruction
 * addresses. Payloads exclude the Windows HID report ID; no hardware validation
 * is implied. DPI and key records deliberately preserve sensor/action bytes.
 */
export * from "./settings.js";
export * from "./buttons.js";
export const HITSCAN_REPORT_ID = 0x08;
export const HITSCAN_PAYLOAD_LENGTH = 16;
export const HITSCAN_MAX_CHUNK = 10;
export const HITSCAN_CONFIG_LENGTH = 0xc0;
export const HITSCAN_FLASH_LENGTH = 0x1b00;
export const HITSCAN_NOTIFICATION = 0x0a;

/** Base64-decoded shipped Config.ini, normalized by the app's config reader. */
export const HITSCAN_VENDOR_ID = 0x3770;
export const HITSCAN_PRODUCTS: ReadonlyMap<number, {
  transport: "wired" | "receiver" | "8k-receiver";
  verified: false;
}> = new Map([
  [0x0100, {transport: "wired", verified: false}],
  [0x0200, {transport: "receiver", verified: false}],
  [0x0300, {transport: "8k-receiver", verified: false}],
]);
/** MID is returned at runtime; the shipped file gives neither model a retail name. */
export const HITSCAN_MODELS: ReadonlyMap<number, {
  sensor: "3395"; minDpi: number; maxDpi: number; dpiStep: number;
  maxDpiStages: number; verified: false;
}> = new Map([1, 2].map(id => [id, {
  sensor: "3395", minDpi: 50, maxDpi: 26000, dpiStep: 50,
  maxDpiStages: 4, verified: false,
}]));

export const HITSCAN_COMMAND = {
  deviceInfo: 0x01, driverStatus: 0x02, online: 0x03, battery: 0x04,
  pair: 0x05, pairStatus: 0x06, write: 0x07, read: 0x08,
  reset: 0x09, setVidPid: 0x0b, descriptor: 0x0c, updateMode: 0x0d,
  profile: 0x0e, setProfile: 0x0f, mtkMode: 0x11, firmware: 0x12,
  setDongleRgb: 0x14, dongleRgb: 0x15, setLongRange: 0x16,
  longRange: 0x17, setDongleRgbBar: 0x18, dongleRgbBar: 0x19,
  setDongleId: 0x1a, slaveFirmware: 0xb3, writeCidMid: 0xf0, cidMid: 0xf1,
} as const;

/** Flash coordinates, not report offsets. Unnamed scalar fields stay numeric. */
export const HITSCAN_ADDRESS = {
  pollingRate: 0x00, dpiStageCount: 0x02, activeDpiStage: 0x04,
  dpiStages: 0x0c, dpiColors: 0x2c, dpiLed: 0x4c,
  buttons: 0x60, ledBar: 0xa0, shortcuts: 0x100, macros: 0x300,
} as const;
export const HITSCAN_SCALAR_ADDRESSES = [
  0, 2, 4, 6, 8, 10, 0xa7, 0xa9, 0xab, 0xad, 0xaf, 0xb1, 0xb3, 0xb5, 0xb7, 0xb9,
] as const;
type Bytes = Uint8Array | readonly number[];

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Invalid Hitscan ${label}.`);
}
function checkedBytes(data: Bytes): Uint8Array<ArrayBuffer> {
  for (const value of data) integer(value, 0, 255, "byte");
  return Uint8Array.from(data);
}
function range(address: number, length: number): void {
  integer(address, 0, HITSCAN_FLASH_LENGTH - 1, "flash address");
  integer(length, 1, HITSCAN_FLASH_LENGTH - address, "flash length");
}

/** Applies to records as well as full wire reports (include report ID there). */
export function hitscanChecksum(bytes: Iterable<number>): number {
  let sum = 0;
  for (const byte of bytes) { integer(byte, 0, 255, "byte"); sum += byte; }
  return (0x55 - sum) & 255;
}
export function hitscanChecksumIsValid(payload: Bytes): boolean {
  if (payload.length !== HITSCAN_PAYLOAD_LENGTH) return false;
  let sum = HITSCAN_REPORT_ID;
  for (const byte of payload) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return false;
    sum += byte;
  }
  return (sum & 255) === 0x55;
}
function finalize(payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  payload[15] = hitscanChecksum([HITSCAN_REPORT_ID, ...payload.subarray(0, 15)]);
  return payload;
}

/** Raw normal command constructor; declared length may differ from data count. */
export function hitscanBuildCommand(command: number, data: Bytes = [], declaredLength = data.length): Uint8Array<ArrayBuffer> {
  integer(command, 0, 255, "command");
  integer(declaredLength, 0, 255, "declared length");
  if (data.length > HITSCAN_MAX_CHUNK) throw new RangeError("Hitscan command data exceeds ten bytes.");
  const payload = new Uint8Array(HITSCAN_PAYLOAD_LENGTH);
  payload[0] = command;
  payload[4] = declaredLength;
  payload.set(checkedBytes(data), 5);
  return finalize(payload);
}
export function hitscanBuildReadPayload(address: number, length: number): Uint8Array<ArrayBuffer> {
  range(address, length);
  integer(length, 1, HITSCAN_MAX_CHUNK, "read chunk length");
  const payload = hitscanBuildCommand(HITSCAN_COMMAND.read, [], length);
  payload[2] = address >> 8; payload[3] = address & 255;
  return finalize(payload);
}
export function hitscanBuildWritePayload(address: number, data: Bytes): Uint8Array<ArrayBuffer> {
  range(address, data.length);
  if (data.length > HITSCAN_MAX_CHUNK) throw new RangeError("Hitscan write chunk exceeds ten bytes.");
  const payload = hitscanBuildCommand(HITSCAN_COMMAND.write, data);
  payload[2] = address >> 8; payload[3] = address & 255;
  return finalize(payload);
}
export function hitscanBuildReadChunks(address: number, length: number): Uint8Array<ArrayBuffer>[] {
  range(address, length);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < length; offset += HITSCAN_MAX_CHUNK) {
    chunks.push(hitscanBuildReadPayload(address + offset, Math.min(HITSCAN_MAX_CHUNK, length - offset)));
  }
  return chunks;
}
export function hitscanBuildWriteChunks(address: number, data: Bytes): Uint8Array<ArrayBuffer>[] {
  range(address, data.length);
  const bytes = checkedBytes(data), chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < bytes.length; offset += HITSCAN_MAX_CHUNK) {
    chunks.push(hitscanBuildWritePayload(address + offset, bytes.subarray(offset, offset + HITSCAN_MAX_CHUNK)));
  }
  return chunks;
}
/** Writes are acknowledged by a full echo; notifications never satisfy requests. */
export function hitscanMatchesResponse(request: Bytes, response: Bytes): boolean {
  if (!hitscanChecksumIsValid(request) || !hitscanChecksumIsValid(response)) return false;
  if (response[0] === HITSCAN_NOTIFICATION || response[0] !== request[0]) return false;
  return request[0] !== HITSCAN_COMMAND.write || request.every((byte, index) => response[index] === byte);
}
/** Stronger than the DLL's opcode-only matcher: reject stale address/length replies. */
export function hitscanParseReadResponse(response: Bytes, address: number, length: number): Uint8Array<ArrayBuffer> | null {
  range(address, length); integer(length, 1, HITSCAN_MAX_CHUNK, "read chunk length");
  if (!hitscanChecksumIsValid(response) || response[0] !== HITSCAN_COMMAND.read || response[1] !== 0
      || response[2] !== (address >> 8) || response[3] !== (address & 255) || response[4] !== length) return null;
  return Uint8Array.from(response.slice(5, 5 + length));
}

export function hitscanEncodeRecord(data: Bytes): Uint8Array<ArrayBuffer> {
  const bytes = checkedBytes(data), record = new Uint8Array(bytes.length + 1);
  record.set(bytes); record[bytes.length] = hitscanChecksum(bytes);
  return record;
}
export function hitscanDecodeRecord(record: Bytes, dataLength: number): Uint8Array<ArrayBuffer> | null {
  integer(dataLength, 1, HITSCAN_FLASH_LENGTH - 1, "record length");
  if (record.length !== dataLength + 1) return null;
  const bytes = checkedBytes(record);
  return hitscanChecksum(bytes.subarray(0, dataLength)) === bytes[dataLength] ? bytes.slice(0, dataLength) : null;
}
export function hitscanEncodeScalar(value: number): Uint8Array<ArrayBuffer> { return hitscanEncodeRecord([value]); }
export function hitscanDecodeScalar(record: Bytes): number | null { return hitscanDecodeRecord(record, 1)?.[0] ?? null; }
export function hitscanEncodeTriplet(data: Bytes): Uint8Array<ArrayBuffer> {
  if (data.length !== 3) throw new RangeError("Hitscan DPI/color/button data must contain three bytes.");
  return hitscanEncodeRecord(data);
}
export function hitscanDecodeTriplet(record: Bytes): Uint8Array<ArrayBuffer> | null { return hitscanDecodeRecord(record, 3); }

/** Type values follow the DLL's normalized event enum; physical meaning is unverified. */
export interface HitscanKeyEvent { type: 0 | 1 | 2; modifier: number; code: number; value: number }
export interface HitscanMacroEvent extends HitscanKeyEvent { delay: number }
export interface HitscanMacro { name: Uint8Array; events: HitscanMacroEvent[] }
function packedEvent(event: HitscanKeyEvent): number[] {
  integer(event.type, 0, 2, "event type"); integer(event.modifier, 0, 15, "event modifier");
  integer(event.code, 0, 255, "event code"); integer(event.value, 0, 255, "event value");
  return [(event.type === 0 ? 0x80 : event.type === 1 ? 0x40 : 0) | event.modifier, event.code, event.value];
}
function unpackedEvent(data: Uint8Array, offset: number): HitscanKeyEvent {
  const head = data[offset]!;
  return { type: (head & 0xc0) === 0x80 ? 0 : (head & 0xc0) === 0x40 ? 1 : 2,
    modifier: head & 15, code: data[offset + 1]!, value: data[offset + 2]! };
}
export function hitscanEncodeShortcut(events: readonly HitscanKeyEvent[]): Uint8Array<ArrayBuffer> {
  integer(events.length, 2, 6, "shortcut event count");
  return hitscanEncodeRecord([events.length, ...events.flatMap(packedEvent)]);
}
/** Accepts a packed record or its full 32-byte slot, preserving caller input. */
export function hitscanDecodeShortcut(record: Bytes): HitscanKeyEvent[] | null {
  const bytes = checkedBytes(record), count = bytes[0] ?? 0;
  if (count < 2 || count > 6) return null;
  const end = 1 + count * 3;
  if (bytes.length < end + 1 || (bytes.length !== end + 1 && bytes.length !== 32)
      || hitscanChecksum(bytes.subarray(0, end)) !== bytes[end]) return null;
  return Array.from({length: count}, (_, i) => unpackedEvent(bytes, 1 + 3 * i));
}
export function hitscanEncodeMacro(macro: HitscanMacro): Uint8Array<ArrayBuffer> {
  integer(macro.name.length, 0, 30, "macro name length");
  integer(macro.events.length, 2, 70, "macro event count");
  const record = new Uint8Array(33 + macro.events.length * 5);
  record[0] = macro.name.length; record.set(checkedBytes(macro.name), 1); record[31] = macro.events.length;
  macro.events.forEach((event, index) => {
    integer(event.delay, 0, 65535, "macro delay");
    const offset = 32 + index * 5;
    record.set(packedEvent(event), offset); record[offset + 3] = event.delay >> 8; record[offset + 4] = event.delay & 255;
  });
  record[record.length - 1] = hitscanChecksum(record.subarray(31, record.length - 1));
  return record;
}
/** Name bytes are opaque; the event checksum excludes the name/header region. */
export function hitscanDecodeMacro(record: Bytes): HitscanMacro | null {
  const bytes = checkedBytes(record), count = bytes[31] ?? 0, nameLength = bytes[0] ?? 0;
  if (count < 2 || count > 70 || nameLength > 30) return null;
  const end = 32 + count * 5;
  if (bytes.length < end + 1 || (bytes.length !== end + 1 && bytes.length !== 384)
      || hitscanChecksum(bytes.subarray(31, end)) !== bytes[end]) return null;
  return { name: bytes.slice(1, 1 + nameLength), events: Array.from({length: count}, (_, i) => {
    const offset = 32 + i * 5;
    return {...unpackedEvent(bytes, offset), delay: (bytes[offset + 3]! << 8) | bytes[offset + 4]!};
  }) };
}

/** Lossless snapshot: no parser defaults, coerced booleans, or discarded unknown bytes. */
export class HitscanConfig {
  private readonly data: Uint8Array<ArrayBuffer>;
  constructor(data: Bytes) {
    if (data.length !== HITSCAN_CONFIG_LENGTH && data.length !== HITSCAN_FLASH_LENGTH) throw new RangeError("Hitscan snapshot must be 0xc0 or 0x1b00 bytes.");
    this.data = checkedBytes(data);
  }
  get bytes(): Uint8Array<ArrayBuffer> { return this.data.slice(); }
  record(address: number, dataLength: number): Uint8Array<ArrayBuffer> | null {
    range(address, dataLength + 1);
    if (address + dataLength + 1 > this.data.length) return null;
    return hitscanDecodeRecord(this.data.subarray(address, address + dataLength + 1), dataLength);
  }
  scalar(address: number): number | null { return this.record(address, 1)?.[0] ?? null; }
  dpiStage(index: number): Uint8Array<ArrayBuffer> | null { integer(index, 0, 7, "DPI stage"); return this.record(0x0c + index * 4, 3); }
  dpiColor(index: number): Uint8Array<ArrayBuffer> | null { integer(index, 0, 7, "DPI color"); return this.record(0x2c + index * 4, 3); }
  button(index: number): Uint8Array<ArrayBuffer> | null { integer(index, 0, 15, "button"); return this.record(0x60 + index * 4, 3); }
  shortcut(index: number): HitscanKeyEvent[] | null {
    integer(index, 0, 15, "shortcut slot"); const start = 0x100 + index * 32;
    return start + 32 <= this.data.length ? hitscanDecodeShortcut(this.data.subarray(start, start + 32)) : null;
  }
  macro(index: number): HitscanMacro | null {
    integer(index, 0, 15, "macro slot"); const start = 0x300 + index * 384;
    return start + 384 <= this.data.length ? hitscanDecodeMacro(this.data.subarray(start, start + 384)) : null;
  }
}

/**
 * GetBatteryLevel (0x04) returns payload[5], payload[6] and BE16 payload[7..8].
 * The DLL does not name them; this is the same reply shape CompX mice use
 * (percent, charging flag, millivolts), and this command table, framing and
 * flash layout match CompX's byte for byte. Unverified on Hitscan hardware.
 */
export function hitscanDecodeBattery(reply: Bytes): { percent: number | null; charging: boolean; millivolts: number | null } | null {
  if (!hitscanChecksumIsValid(reply) || reply[0] !== HITSCAN_COMMAND.battery) return null;
  const percent = reply[5]!, millivolts = (reply[7]! << 8) | reply[8]!;
  return { percent: percent <= 100 ? percent : null, charging: reply[6] === 1, millivolts: millivolts || null };
}

/** GetVersion (0x12) / GetSlaveVersion (0xb3): BE16 at payload[5..6]. */
export function hitscanDecodeVersion(reply: Bytes, command: number = HITSCAN_COMMAND.firmware): number | null {
  if (!hitscanChecksumIsValid(reply) || reply[0] !== command) return null;
  return (reply[5]! << 8) | reply[6]!;
}

/** Same "v<major>.<minor hex>" form the CompX drivers display. */
export function hitscanFormatVersion(version: number): string {
  return `v${version >> 8}.${(version & 255).toString(16).padStart(2, "0")}`;
}
