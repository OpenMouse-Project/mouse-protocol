/**
 * Dareu A950 PRO Mg (TM271F) Jm-family configuration codec.
 *
 * Framing is derived from Dareu's Jm WebHID panel (`jmdevice.v_1.3.24.js`).
 * The vendor id, command collection, and report-8 size below were measured
 * from the TM265 receiver; clients must still require that exact shape.
 */

export const DAREU_DIRECT_PRODUCT_ID = 0x1117;
export const DAREU_RECEIVER_PRODUCT_ID = 0x1114;
export const DAREU_PRODUCT_IDS = [DAREU_DIRECT_PRODUCT_ID, DAREU_RECEIVER_PRODUCT_ID] as const;

/** Captured from the connected TM265 receiver's USB and HID descriptors. */
export const DAREU_VENDOR_ID = 0x260d;
/** Receiver service collection that must accompany the report-8 interface. */
export const DAREU_RECEIVER_USAGE_PAGE = 0xff05;
export const DAREU_RECEIVER_USAGE = 0x00;
/** Jm command collection: report ID 8 has 16-byte input/output bodies. */
export const DAREU_COMMAND_USAGE_PAGE = 0xff02;
export const DAREU_COMMAND_USAGE = 0x02;

export interface DareuProduct {
  model: string;
  name: string;
  transport: "wired" | "receiver";
}

export const DAREU_PRODUCTS: ReadonlyMap<number, DareuProduct> = new Map([
  [DAREU_DIRECT_PRODUCT_ID, { model: "TM271F", name: "A950 PRO Mg", transport: "wired" }],
  [DAREU_RECEIVER_PRODUCT_ID, { model: "TM265Dongle", name: "2.4G Receiver", transport: "receiver" }],
]);

export const DAREU_REPORT_ID = 0x08;
export const DAREU_REPORT_SIZE = 16;
export const DAREU_MAX_BUFFER_CHUNK = 10;
export const DAREU_MAX_BUFFER_ADDRESS = 0xffff;

export const DAREU_DPI_MIN = 100;
export const DAREU_DPI_MAX = 26000;
export const DAREU_DPI_STEP = 50;
export const DAREU_DEFAULT_DPI_STAGES = [400, 800, 1600, 3200, 6400] as const;
export const DAREU_DEFAULT_ACTIVE_DPI_STAGE = 2;
export const DAREU_BUTTON_IDS = [1, 2, 3, 4, 5, 6] as const;
/** JmMouse reports four numbered, onboard configuration banks. */
export const DAREU_PROFILE_COUNT = 4;

export const DAREU_WIRED_POLLING_RATES = [125, 250, 500, 1000] as const;
export const DAREU_WIRELESS_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000] as const;
/** Dareu's supplied energy page exposes these mouse and DPI-LED sleep values. */
export const DAREU_SLEEP_TIMEOUT_SECONDS = [60, 180, 300, 600, 1200, 1800, 2400, 0] as const;

const POLLING_RATE_IDS = new Map<number, number>([
  [125, 8],
  [250, 4],
  [500, 2],
  [1000, 1],
  [2000, 16],
  [4000, 32],
]);

const COMMAND = {
  CHECK_ACTIVE: 3,
  GET_BATTERY: 4,
  WRITE_BUFFER: 7,
  READ_BUFFER: 8,
  GET_ACTIVE_PROFILE: 14,
  SET_ACTIVE_PROFILE: 15,
  GET_MOUSE_FIRMWARE: 18,
  GET_RECEIVER_FIRMWARE: 29,
} as const;

/** DPI indicator controls offered by the A950 vendor page. */
export const DAREU_DPI_LED_EFFECTS = [0, 1, 2] as const;
export const DAREU_DPI_LED_BRIGHTNESS_RANGE = [1, 10] as const;
export const DAREU_DPI_LED_SPEED_RANGE = [1, 5] as const;

export const DAREU_MEMORY_ADDRESS = {
  pollingRate: 0,
  dpiHeader: 2,
  dpiLegacyStages: 12,
  buttonAssignments: 96,
  dpiLed: 76,
  dpiLedEnabled: 82,
  dpiLedSleep: 173,
  sleepEnabled: 181,
  sleepTimeout: 183,
  dpiExtendedStages: 6912,
} as const;

export const DAREU_BUTTONS = [
  { id: 1, name: "Left" },
  { id: 2, name: "Right" },
  { id: 3, name: "Middle" },
  { id: 4, name: "Back" },
  { id: 5, name: "Forward" },
  { id: 6, name: "DPI" },
] as const;

export const DAREU_BUTTON_ACTIONS = [
  "Left Click", "Right Click", "Middle Click", "Back", "Forward",
  "DPI Cycle", "DPI Up", "DPI Down",
] as const;

const BUTTON_MASKS = new Map<string, number>([
  ["Left Click", 1],
  ["Right Click", 2],
  ["Middle Click", 4],
  ["Back", 8],
  ["Forward", 16],
]);

const DPI_BUTTON_ACTIONS = new Map<string, number>([
  ["DPI Cycle", 1],
  ["DPI Up", 2],
  ["DPI Down", 3],
]);

function assertAddress(address: number): void {
  if (!Number.isInteger(address) || address < 0 || address > DAREU_MAX_BUFFER_ADDRESS) {
    throw new RangeError(`Dareu buffer address must be an integer from 0 to ${DAREU_MAX_BUFFER_ADDRESS}.`);
  }
}

function assertBufferRange(address: number, length: number): void {
  assertAddress(address);
  if (!Number.isInteger(length) || length < 1 || address + length > DAREU_MAX_BUFFER_ADDRESS + 1) {
    throw new RangeError("Dareu buffer range must stay within the 16-bit address space.");
  }
}

function frame(command: number): Uint8Array {
  const full = new Uint8Array(DAREU_REPORT_SIZE + 1);
  full[0] = DAREU_REPORT_ID;
  full[1] = command;
  return full;
}

function sealFrame(full: Uint8Array): Uint8Array {
  full[full.length - 1] = dareuChecksum(full);
  return full.slice(1);
}

/**
 * Jm checksum.  The vendor calculates it over every byte except the final
 * checksum slot; output frames include report ID 8 in that sum.
 */
export function dareuChecksum(bytes: Uint8Array): number {
  if (bytes.length < 2) throw new RangeError("Dareu checksum needs a payload byte and checksum slot.");
  let sum = 0;
  for (let index = 0; index < bytes.length - 1; index++) sum += bytes[index];
  return (sum < 55 ? 85 - sum : 341 - sum) & 0xff;
}

/** Append the per-value checksum stored in Jm configuration memory. */
export function dareuWithMemoryChecksum(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 1);
  result.set(data);
  result[result.length - 1] = dareuChecksum(result);
  return result;
}

export function dareuHasValidMemoryChecksum(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[bytes.length - 1] === dareuChecksum(bytes);
}

/** 16-byte body for report ID 8; callers pass this to `sendReport(8, body)`. */
export function dareuCheckActiveRequest(): Uint8Array {
  return sealFrame(frame(COMMAND.CHECK_ACTIVE));
}

/** 16-byte body for the Jm battery-status request. */
export function dareuGetBatteryRequest(): Uint8Array {
  return sealFrame(frame(COMMAND.GET_BATTERY));
}

/** Read the one-based JmMouse profile currently active on the mouse. */
export function dareuGetActiveProfileRequest(): Uint8Array {
  return sealFrame(frame(COMMAND.GET_ACTIVE_PROFILE));
}

/** Switch the active JmMouse profile using the mouse (0x81) target. */
export function dareuSetActiveProfileRequest(profile: number): Uint8Array {
  if (!Number.isInteger(profile) || profile < 1 || profile > DAREU_PROFILE_COUNT) {
    throw new RangeError(`Dareu profile must be between 1 and ${DAREU_PROFILE_COUNT}.`);
  }
  const full = frame(COMMAND.SET_ACTIVE_PROFILE);
  full[5] = 0x81;
  full[6] = profile - 1;
  return sealFrame(full);
}

/** Get the paired mouse firmware version (two-byte big-endian Jm value). */
export function dareuGetMouseFirmwareRequest(): Uint8Array {
  return sealFrame(frame(COMMAND.GET_MOUSE_FIRMWARE));
}

/** Get the receiver firmware version (two-byte big-endian Jm value). */
export function dareuGetReceiverFirmwareRequest(): Uint8Array {
  return sealFrame(frame(COMMAND.GET_RECEIVER_FIRMWARE));
}

/** A reply must be a 16-byte report for the requested command, not event 10. */
export function dareuMatchesReply(request: Uint8Array, reply: Uint8Array): boolean {
  if (request.length !== DAREU_REPORT_SIZE || reply.length !== DAREU_REPORT_SIZE || reply[0] === 10 || request[0] !== reply[0]) {
    return false;
  }
  // Read-buffer replies echo the request address and length. Matching those
  // fields prevents an earlier asynchronous read reply from being treated as
  // the answer to the next read.
  return request[0] !== COMMAND.READ_BUFFER
    || (request[2] === reply[2] && request[3] === reply[3] && request[4] === reply[4]);
}

/** Decode a well-formed battery reply. Status is intentionally left raw. */
export function dareuDecodeBattery(reply: Uint8Array): { percent: number; status: number } | null {
  if (reply.length !== DAREU_REPORT_SIZE || reply[0] !== COMMAND.GET_BATTERY || reply[5] > 100) return null;
  return { percent: reply[5], status: reply[6] };
}

export function dareuDecodeActiveProfile(reply: Uint8Array): number | null {
  const profile = reply[5];
  return reply.length === DAREU_REPORT_SIZE
    && reply[0] === COMMAND.GET_ACTIVE_PROFILE
    && profile !== undefined
    && profile < DAREU_PROFILE_COUNT
    ? profile + 1
    : null;
}

/** Decode the exact two-byte big-endian version reported by Jm firmware. */
export function dareuDecodeFirmwareVersion(reply: Uint8Array, command: 18 | 29): number | null {
  if (reply.length !== DAREU_REPORT_SIZE || reply[0] !== command) return null;
  return (reply[5]! << 8) | reply[6]!;
}

function readBufferRequest(address: number, length: number): Uint8Array {
  assertBufferRange(address, length);
  if (length > DAREU_MAX_BUFFER_CHUNK) {
    throw new RangeError(`Dareu buffer requests may read at most ${DAREU_MAX_BUFFER_CHUNK} bytes.`);
  }
  const full = frame(COMMAND.READ_BUFFER);
  full[3] = address >> 8;
  full[4] = address & 0xff;
  full[5] = length;
  return sealFrame(full);
}

/** Split a bounded memory read into the vendor protocol's ten-byte requests. */
export function dareuReadBufferRequests(address: number, length: number): Uint8Array[] {
  assertBufferRange(address, length);
  const requests: Uint8Array[] = [];
  for (let offset = 0; offset < length; offset += DAREU_MAX_BUFFER_CHUNK) {
    requests.push(readBufferRequest(address + offset, Math.min(DAREU_MAX_BUFFER_CHUNK, length - offset)));
  }
  return requests;
}

/** Extract the requested data from a matching Jm buffer-read reply. */
export function dareuDecodeReadBufferReply(request: Uint8Array, reply: Uint8Array): Uint8Array | null {
  if (!dareuMatchesReply(request, reply) || request[0] !== COMMAND.READ_BUFFER) return null;
  const length = request[4];
  if (length < 1 || length > DAREU_MAX_BUFFER_CHUNK || reply.length < 5 + length) return null;
  return reply.slice(5, 5 + length);
}

function writeBufferRequest(address: number, data: Uint8Array): Uint8Array {
  assertBufferRange(address, data.length);
  if (data.length > DAREU_MAX_BUFFER_CHUNK) {
    throw new RangeError(`Dareu buffer requests may write at most ${DAREU_MAX_BUFFER_CHUNK} bytes.`);
  }
  const full = frame(COMMAND.WRITE_BUFFER);
  full[3] = address >> 8;
  full[4] = address & 0xff;
  full[5] = data.length;
  full.set(data, 6);
  return sealFrame(full);
}

/** Split a bounded memory write into ten-byte commands without mutating data. */
export function dareuWriteBufferRequests(address: number, data: Uint8Array): Uint8Array[] {
  assertBufferRange(address, data.length);
  const requests: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += DAREU_MAX_BUFFER_CHUNK) {
    requests.push(writeBufferRequest(address + offset, data.slice(offset, offset + DAREU_MAX_BUFFER_CHUNK)));
  }
  return requests;
}

export function dareuIsValidDpi(dpi: number): boolean {
  return Number.isInteger(dpi)
    && dpi >= DAREU_DPI_MIN
    && dpi <= DAREU_DPI_MAX
    && (dpi - DAREU_DPI_MIN) % DAREU_DPI_STEP === 0;
}

/** Convert a UI DPI value to the legacy Jm sensor-map identifier. */
export function dareuDpiId(dpi: number): number | null {
  if (!dareuIsValidDpi(dpi)) return null;
  const index = dpi / DAREU_DPI_STEP - 1;
  return index < 256 ? index : index < 512 ? (index - 256) | 0x4400 : (index - 512) | 0x8800;
}

/** Convert a legacy Jm sensor-map identifier to its exact UI DPI value. */
export function dareuDpiFromId(id: number): number | null {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) return null;
  const high = id >> 8;
  const index = high === 0 ? id : high === 0x44 ? 256 + (id & 0xff) : high === 0x88 ? 512 + (id & 0xff) : -1;
  const dpi = DAREU_DPI_STEP * (index + 1);
  return dareuIsValidDpi(dpi) ? dpi : null;
}

export function dareuPollingRateId(hz: number, transport: "wired" | "receiver"): number | null {
  const id = POLLING_RATE_IDS.get(hz);
  return id !== undefined && (transport === "receiver" || hz <= 1000) ? id : null;
}

export function dareuPollingRateHz(id: number, transport: "wired" | "receiver"): number | null {
  for (const [hz, candidate] of POLLING_RATE_IDS) {
    if (candidate === id && (transport === "receiver" || hz <= 1000)) return hz;
  }
  return null;
}

export function dareuIsValidDpiLedSetting(effect: number, brightness: number, speed: number): boolean {
  return DAREU_DPI_LED_EFFECTS.includes(effect as (typeof DAREU_DPI_LED_EFFECTS)[number])
    && Number.isInteger(brightness)
    && brightness >= DAREU_DPI_LED_BRIGHTNESS_RANGE[0]
    && brightness <= DAREU_DPI_LED_BRIGHTNESS_RANGE[1]
    && Number.isInteger(speed)
    && speed >= DAREU_DPI_LED_SPEED_RANGE[0]
    && speed <= DAREU_DPI_LED_SPEED_RANGE[1];
}

export function dareuIsValidSleepTimeout(seconds: number): boolean {
  return (DAREU_SLEEP_TIMEOUT_SECONDS as readonly number[]).includes(seconds);
}

/** Decode one Jm button record. Unknown, macro, and corrupt records stay opaque. */
export function dareuDecodeButtonAssignment(record: Uint8Array): string | null {
  if (record.length !== 4 || !dareuHasValidMemoryChecksum(record) || record[2] !== 0) {
    return null;
  }
  const actions = record[0] === 1 ? BUTTON_MASKS : record[0] === 2 ? DPI_BUTTON_ACTIONS : null;
  if (!actions) return null;
  for (const [action, value] of actions) {
    if (record[1] === value) return action;
  }
  return null;
}

/** Encode only the ordinary mouse-button mappings proven in Dareu's Jm panel. */
export function dareuEncodeButtonAssignment(action: string): Uint8Array | null {
  const mask = BUTTON_MASKS.get(action);
  if (mask !== undefined) return dareuWithMemoryChecksum(new Uint8Array([1, mask, 0]));
  const dpiAction = DPI_BUTTON_ACTIONS.get(action);
  return dpiAction === undefined ? null : dareuWithMemoryChecksum(new Uint8Array([2, dpiAction, 0]));
}

export interface DareuDpiLedState {
  mode: 0 | 1 | 2;
  brightness: number;
  speed: number;
}

/** Decode the four checksum-protected values in the DPI-indicator block. */
export function dareuDecodeDpiLedState(buffer: Uint8Array): DareuDpiLedState | null {
  if (buffer.length !== 8) return null;
  for (let offset = 0; offset < buffer.length; offset += 2) {
    if (!dareuHasValidMemoryChecksum(buffer.slice(offset, offset + 2))) return null;
  }
  const enabled = buffer[6];
  const rawMode = buffer[0];
  const mode = enabled === 0 ? 0 : rawMode === 1 || rawMode === 2 ? rawMode : null;
  const brightness = Math.round((buffer[2] * 10) / 255);
  const speed = buffer[4];
  if (mode === null || !dareuIsValidDpiLedSetting(mode, brightness, speed)) return null;
  return { mode, brightness, speed };
}

export function dareuEncodeDpiLedBrightness(brightness: number): Uint8Array | null {
  if (!Number.isInteger(brightness)
    || brightness < DAREU_DPI_LED_BRIGHTNESS_RANGE[0]
    || brightness > DAREU_DPI_LED_BRIGHTNESS_RANGE[1]) return null;
  // Matches the vendor panel's assignment into a Uint8Array (truncate, don't round).
  return dareuWithMemoryChecksum(new Uint8Array([Math.floor((255 * brightness) / 10)]));
}
