/**
 * Redragon M719RGB-PRO (INVADER PRO) protocol codec.
 *
 * The M719RGB-PRO enumerates under CompX / Areson's vendor ID (0x25a7) rather
 * than Holtek (0x04d9) or SinoWealth (0x258a):
 * - 0x25a7:0xfa7e — 2.4 GHz wireless receiver
 * - 0x25a7:0xfab0 — wired USB cable
 *
 * Transport:
 * - Commands are sent as 16-byte payloads on Feature Report ID 0x08
 *   (Usage Page 0xff02, Usage 0x0002; 17 bytes on the wire including Report ID).
 * - Responses and asynchronous hardware notifications arrive on Input Report
 *   ID 0x09 (Usage Page 0xff01, Usage 0x0001; 16-byte payload).
 * - Every 17-byte packet sums to 0x55 modulo 256:
 *     payload[15] = (0x55 - ((0x08 + sum(payload[0..14])) & 0xff)) & 0xff
 * - Every EEPROM record also ends with a trailing data checksum byte so the
 *   record sums to 0x55 modulo 256.
 *
 * Sensor: PixArt PAW3325 (200–5,000 DPI in 100-DPI steps via non-linear hardware
 * code table with hiByte = 0x00; 5,200–10,000 DPI in 200-DPI steps via
 * hiByte = 0x01 and half-DPI code lookup).
 */

export interface RedragonM719ProRgb {
  r: number;
  g: number;
  b: number;
}

export interface RedragonM719ProProduct {
  name: string;
  productId: number;
  connection: "Wired" | "Wireless";
  sensor: "PAW3325";
  maxDpi: number;
  maxPollingRate: number;
  dpiSteps: number;
  buttons: number;
  /** True only after the exact PID and path were exercised on hardware. */
  verified: boolean;
}

// ── USB Identity & HID Collections ─────────────────────────────────────────

export const REDRAGON_M719_PRO_VENDOR_ID = 0x25a7;
export const REDRAGON_M719_PRO_WIRELESS_PRODUCT_ID = 0xfa7e;
export const REDRAGON_M719_PRO_WIRED_PRODUCT_ID = 0xfab0;
export const REDRAGON_M719_PRO_RECEIVER_PRODUCT_ID = REDRAGON_M719_PRO_WIRELESS_PRODUCT_ID;

export const REDRAGON_M719_PRO_COMMAND_USAGE_PAGE = 0xff02;
export const REDRAGON_M719_PRO_COMMAND_USAGE = 0x0002;
export const REDRAGON_M719_PRO_NOTIFY_USAGE_PAGE = 0xff01;
export const REDRAGON_M719_PRO_NOTIFY_USAGE = 0x0001;

export const REDRAGON_M719_PRO_COMMAND_REPORT_ID = 0x08;
export const REDRAGON_M719_PRO_RESPONSE_REPORT_ID = 0x09;
export const REDRAGON_M719_PRO_NOTIFY_REPORT_ID = 0x0a;

/** WebHID report payload length (excluding the 1-byte report ID). */
export const REDRAGON_M719_PRO_PACKET_LENGTH = 16;
/** Maximum EEPROM payload bytes carried in a single read/write frame. */
export const REDRAGON_M719_PRO_MAX_CHUNK_LENGTH = 10;
/** Modulo-256 sum target used for both packet frames and EEPROM records. */
export const REDRAGON_M719_PRO_CHECKSUM_TARGET = 0x55;

export const REDRAGON_M719_PRO_PRODUCTS: ReadonlyMap<number, RedragonM719ProProduct> = new Map([
  [REDRAGON_M719_PRO_WIRELESS_PRODUCT_ID, {
    name: "M719RGB-PRO",
    productId: REDRAGON_M719_PRO_WIRELESS_PRODUCT_ID,
    connection: "Wireless",
    sensor: "PAW3325",
    maxDpi: 10000,
    maxPollingRate: 1000,
    dpiSteps: 5,
    buttons: 8,
    verified: true,
  }],
  [REDRAGON_M719_PRO_WIRED_PRODUCT_ID, {
    name: "M719RGB-PRO",
    productId: REDRAGON_M719_PRO_WIRED_PRODUCT_ID,
    connection: "Wired",
    sensor: "PAW3325",
    maxDpi: 10000,
    maxPollingRate: 1000,
    dpiSteps: 5,
    buttons: 8,
    verified: true,
  }],
]);

export const REDRAGON_M719_PRO_PRODUCT_IDS: readonly number[] = [...REDRAGON_M719_PRO_PRODUCTS.keys()];

// ── Command Opcodes & EEPROM Layout ────────────────────────────────────────

export const REDRAGON_M719_PRO_COMMAND = {
  handshake: 0x01,
  tellDriverStatus: 0x02,
  getConnectStatus: 0x03,
  getBattery: 0x04,
  writeEeprom: 0x07,
  readEeprom: 0x08,
  commit: 0x09,
  hardwareNotify: 0x0a,
} as const;

export const REDRAGON_M719_PRO_EEPROM = {
  /** 2 bytes: [rateCode, 0x55 - rateCode]. */
  pollingRate: 0x0000,
  /** 2 bytes: [stageCount, 0x55 - stageCount] (1..5). */
  dpiStageCount: 0x0002,
  /** 2 bytes: [activeStageIndex, 0x55 - activeStageIndex] (0..4). */
  activeDpiStage: 0x0004,
  /** 20 bytes: 5 stages × 4 bytes [xCode, yCode, hiByte, chk]. */
  dpiStages: 0x000c,
  /** 20 bytes: 5 stages × 4 bytes [r, g, b, chk]. */
  dpiColors: 0x002c,
  /** 2 or 6 bytes: DPI indicator / logo LED mode block. */
  dpiLedEffect: 0x004c,
  /** 64 bytes: 16 slots × 4 bytes [b0, b1, b2, chk]. */
  buttonMatrix: 0x0060,
  /** 7 bytes: [hwEffect, r, g, b, hwSpeed, hwBrightness, chk]. */
  rgbLighting: 0x00a0,
  /** Base address for extended multimedia / key-combo payloads (0x20 bytes per slot). */
  comboBase: 0x0100,
  /** Stride per hardware button slot in the extended combo area. */
  comboSlotStride: 0x0020,
  /** Base address for onboard macro blocks (0x0180 bytes per slot). */
  macroBase: 0x0300,
  /** Stride per macro slot. */
  macroSlotStride: 0x0180,
} as const;

export const REDRAGON_M719_PRO_POLLING_RATES = [125, 250, 500, 1000] as const;
export const REDRAGON_M719_PRO_MAX_DPI_STAGES = 5;
export const REDRAGON_M719_PRO_DPI_MIN = 200;
export const REDRAGON_M719_PRO_DPI_MAX = 10000;
export const REDRAGON_M719_PRO_DPI_STEP = 100;

export const REDRAGON_M719_PRO_DEFAULT_STAGES = [800, 1600, 2400, 3200, 4800] as const;
export const REDRAGON_M719_PRO_DEFAULT_STAGE_COLORS: readonly RedragonM719ProRgb[] = [
  { r: 0xff, g: 0x00, b: 0x00 },
  { r: 0x00, g: 0x00, b: 0xff },
  { r: 0x00, g: 0xff, b: 0x00 },
  { r: 0xff, g: 0x00, b: 0xff },
  { r: 0xff, g: 0xff, b: 0x00 },
] as const;

// ── Checksum & Packet Framing ──────────────────────────────────────────────

/**
 * Compute the trailing checksum byte so `[...bytes, checksum]` sums to `0x55` mod 256.
 */
export function redragonM719ProDataChecksum(bytes: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    sum = (sum + (bytes[i] ?? 0)) & 0xff;
  }
  return (REDRAGON_M719_PRO_CHECKSUM_TARGET - sum) & 0xff;
}

/**
 * Validate that a buffer with its trailing checksum byte sums to `0x55` mod 256.
 */
export function redragonM719ProVerifyDataChecksum(bytes: ArrayLike<number>): boolean {
  if (bytes.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    sum = (sum + (bytes[i] ?? 0)) & 0xff;
  }
  return sum === REDRAGON_M719_PRO_CHECKSUM_TARGET;
}

/**
 * Compute byte 15 of a 16-byte WebHID payload sent with report ID `0x08`
 * (or report ID `0x09` on replies) so `(reportId + sum(payload[0..15])) & 0xff === 0x55`.
 */
export function redragonM719ProPacketChecksum(
  payload: ArrayLike<number>,
  reportId = REDRAGON_M719_PRO_COMMAND_REPORT_ID,
): number {
  let sum = reportId & 0xff;
  const limit = Math.min(payload.length, REDRAGON_M719_PRO_PACKET_LENGTH - 1);
  for (let i = 0; i < limit; i += 1) {
    sum = (sum + (payload[i] ?? 0)) & 0xff;
  }
  return (REDRAGON_M719_PRO_CHECKSUM_TARGET - sum) & 0xff;
}

/**
 * Pack a 2-byte scalar record `[value, (0x55 - value) & 0xff]`.
 */
export function redragonM719ProPackScalar(value: number): Uint8Array {
  const b = value & 0xff;
  return new Uint8Array([b, (REDRAGON_M719_PRO_CHECKSUM_TARGET - b) & 0xff]);
}

/**
 * Unpack a 2-byte scalar record `[value, checksum]`, returning `null` if corrupt.
 */
export function redragonM719ProUnpackScalar(bytes: ArrayLike<number>): number | null {
  if (bytes.length < 2) return null;
  const value = (bytes[0] ?? 0) & 0xff;
  const chk = (bytes[1] ?? 0) & 0xff;
  if (((value + chk) & 0xff) !== REDRAGON_M719_PRO_CHECKSUM_TARGET) return null;
  return value;
}

/**
 * Build a 16-byte WebHID Feature Report 0x08 payload.
 */
export function redragonM719ProEncodeCommand(
  command: number,
  options: {
    subCommand?: number;
    address?: number;
    data?: ArrayLike<number>;
    length?: number;
  } = {},
): Uint8Array {
  const payload = new Uint8Array(REDRAGON_M719_PRO_PACKET_LENGTH);
  const address = options.address ?? 0;
  const data = options.data ?? [];
  if (data.length > REDRAGON_M719_PRO_MAX_CHUNK_LENGTH) {
    throw new RangeError(
      `Redragon M719RGB-PRO packet carries at most ${REDRAGON_M719_PRO_MAX_CHUNK_LENGTH} data bytes, got ${data.length}.`,
    );
  }
  payload[0] = command & 0xff;
  payload[1] = (options.subCommand ?? 0) & 0xff;
  payload[2] = (address >> 8) & 0xff;
  payload[3] = address & 0xff;
  payload[4] = (options.length ?? data.length) & 0xff;
  for (let i = 0; i < data.length; i += 1) {
    payload[5 + i] = (data[i] ?? 0) & 0xff;
  }
  payload[15] = redragonM719ProPacketChecksum(payload, REDRAGON_M719_PRO_COMMAND_REPORT_ID);
  return payload;
}

/**
 * Normalize an incoming input report buffer into a 16-byte payload
 * (stripping a leading report ID `0x08`, `0x09`, or `0x0a` when a 17-byte raw
 * wire frame is passed).
 */
export function redragonM719ProNormalizeReply(raw: Uint8Array): Uint8Array {
  if (
    raw.length === REDRAGON_M719_PRO_PACKET_LENGTH + 1
    && (raw[0] === REDRAGON_M719_PRO_RESPONSE_REPORT_ID
      || raw[0] === REDRAGON_M719_PRO_COMMAND_REPORT_ID
      || raw[0] === REDRAGON_M719_PRO_NOTIFY_REPORT_ID)
  ) {
    return raw.subarray(1);
  }
  return raw;
}

// ── Handshake, Link, Battery, EEPROM & Notification Commands ───────────────

const HANDSHAKE_SECRET_KEY = [0x05, 0x00, 0x00, 0x00] as const;

/**
 * Compute the 4-byte expected response for a 4-byte handshake challenge (`Cmd 0x01`).
 * Verified from OEM `FUN_00442600` (`k = [0x05, 0x00, 0x00, 0x00]`).
 */
export function redragonM719ProComputeHandshakeResponse(
  challenge: readonly [number, number, number, number],
): [number, number, number, number] {
  const [r0, r1, r2, r3] = challenge;
  return [
    (HANDSHAKE_SECRET_KEY[0] + r1 + r0) & 0xff,
    (HANDSHAKE_SECRET_KEY[1] + r2 + ((r1 << 1) & 0xff)) & 0xff,
    (HANDSHAKE_SECRET_KEY[2] + r3 + ((r2 * 3) & 0xff)) & 0xff,
    (HANDSHAKE_SECRET_KEY[3] + r0 + ((r3 << 2) & 0xff)) & 0xff,
  ];
}

export function redragonM719ProEncodeHandshake(
  challenge: readonly [number, number, number, number],
): Uint8Array {
  return redragonM719ProEncodeCommand(REDRAGON_M719_PRO_COMMAND.handshake, {
    data: challenge,
  });
}

export function redragonM719ProVerifyHandshakeReply(
  challenge: readonly [number, number, number, number],
  rawReply: Uint8Array,
): boolean {
  const reply = redragonM719ProNormalizeReply(rawReply);
  if (reply.length < 9 || reply[0] !== REDRAGON_M719_PRO_COMMAND.handshake || reply[1] !== 0x00) {
    return false;
  }
  const expected = redragonM719ProComputeHandshakeResponse(challenge);
  return reply[5] === expected[0]
    && reply[6] === expected[1]
    && reply[7] === expected[2]
    && reply[8] === expected[3];
}

export function redragonM719ProEncodeTellDriverStatus(online = true): Uint8Array {
  return redragonM719ProEncodeCommand(REDRAGON_M719_PRO_COMMAND.tellDriverStatus, {
    data: [online ? 0x01 : 0x00],
  });
}

export function redragonM719ProEncodeGetConnectStatus(): Uint8Array {
  return redragonM719ProEncodeCommand(REDRAGON_M719_PRO_COMMAND.getConnectStatus);
}

/**
 * Decode a `GetConnectStatus` (`0x03`) reply.
 * In the 16-byte payload, `reply[4]` is the parameter length (`0x01`) and
 * `reply[5]` is the online flag (`0x01` = online, `0x00` = offline). Some
 * firmware revisions place the flag directly in `reply[4]` with `reply[5] == 0`.
 */
export function redragonM719ProDecodeConnectStatus(rawReply: Uint8Array): boolean {
  const reply = redragonM719ProNormalizeReply(rawReply);
  if (reply.length < 6 || reply[0] !== REDRAGON_M719_PRO_COMMAND.getConnectStatus || reply[1] !== 0x00) {
    return false;
  }
  if (reply[4] === 0x01) {
    return (reply[5] ?? 0) !== 0;
  }
  return (reply[5] ?? 0) !== 0 || (reply[4] ?? 0) !== 0;
}

export function redragonM719ProEncodeGetBattery(): Uint8Array {
  return redragonM719ProEncodeCommand(REDRAGON_M719_PRO_COMMAND.getBattery);
}

export interface RedragonM719ProBatteryStatus {
  percent: number;
  charging: boolean;
  rawLevel: number;
}

/**
 * Decode a `GetBattery` (`0x04`) reply.
 * Verified from OEM `FUN_00409d00`: `reply[5]` is the battery level (either
 * `0..10` in 10% steps or `0..100` directly; bit 7 may also flag charging),
 * and `reply[6]` is the charging flag (`0x01` = charging, `0x00` = discharging).
 */
export function redragonM719ProDecodeBattery(rawReply: Uint8Array): RedragonM719ProBatteryStatus | null {
  const reply = redragonM719ProNormalizeReply(rawReply);
  if (reply.length < 7 || reply[0] !== REDRAGON_M719_PRO_COMMAND.getBattery || reply[1] !== 0x00) {
    return null;
  }
  const rawByte = reply[5] ?? 0;
  const chargeByte = reply[6] ?? 0;
  const rawLevel = rawByte & 0x7f;
  if (rawLevel === 0 && chargeByte === 0 && (reply[4] ?? 0) === 0) {
    return null;
  }
  const charging = chargeByte !== 0 || (rawByte & 0x80) !== 0;
  const percent = rawLevel <= 10
    ? Math.max(0, Math.min(100, rawLevel * 10))
    : Math.max(0, Math.min(100, rawLevel));
  return { percent, charging, rawLevel };
}

export function redragonM719ProEncodeReadEeprom(address: number, length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > REDRAGON_M719_PRO_MAX_CHUNK_LENGTH) {
    throw new RangeError(`EEPROM read length must be 1–${REDRAGON_M719_PRO_MAX_CHUNK_LENGTH}, got ${length}.`);
  }
  return redragonM719ProEncodeCommand(REDRAGON_M719_PRO_COMMAND.readEeprom, {
    address,
    length,
  });
}

export function redragonM719ProDecodeReadEeprom(
  rawReply: Uint8Array,
  expectedAddress: number,
  expectedLength: number,
): Uint8Array | null {
  const reply = redragonM719ProNormalizeReply(rawReply);
  if (reply.length < 5 + expectedLength) return null;
  if (reply[0] !== REDRAGON_M719_PRO_COMMAND.readEeprom || reply[1] !== 0x00) return null;
  const addrHi = (expectedAddress >> 8) & 0xff;
  const addrLo = expectedAddress & 0xff;
  if (reply[2] !== addrHi || reply[3] !== addrLo) return null;
  return Uint8Array.from(reply.subarray(5, 5 + expectedLength));
}

export function redragonM719ProEncodeWriteEeprom(address: number, data: ArrayLike<number>): Uint8Array {
  if (data.length < 1 || data.length > REDRAGON_M719_PRO_MAX_CHUNK_LENGTH) {
    throw new RangeError(`EEPROM write length must be 1–${REDRAGON_M719_PRO_MAX_CHUNK_LENGTH}, got ${data.length}.`);
  }
  return redragonM719ProEncodeCommand(REDRAGON_M719_PRO_COMMAND.writeEeprom, {
    address,
    data,
  });
}

export function redragonM719ProDecodeWriteEeprom(rawReply: Uint8Array): "ack" | "busy" | "error" {
  const reply = redragonM719ProNormalizeReply(rawReply);
  if (reply.length < 2 || reply[0] !== REDRAGON_M719_PRO_COMMAND.writeEeprom) return "error";
  if (reply[1] === 0x00) return "ack";
  if (reply[1] === 0x01) return "busy";
  return "error";
}

export interface RedragonM719ProHardwareNotification {
  /** 0-based active DPI stage index (0..4) when the physical DPI button was pressed. */
  activeDpiStage?: number;
  /** 1-based profile index (1..5) when the physical profile switch button was pressed. */
  activeProfile?: number;
}

/**
 * Decode an asynchronous MCU notification (`Cmd 0x0a` on Report `0x09` or `0x0a`).
 * Verified from OEM `FUN_004428e0`:
 * - Bit 0 (`0x01`) of flags byte (`payload[5]`): DPI stage changed to `payload[6] & 0x0f` (0..4)
 * - Bit 1 (`0x02`) of flags byte (`payload[5]`): Profile changed to `(payload[7] & 0x0f) + 1` (1..5)
 */
export function redragonM719ProDecodeHardwareNotification(
  rawReport: Uint8Array,
  reportId = REDRAGON_M719_PRO_RESPONSE_REPORT_ID,
): RedragonM719ProHardwareNotification | null {
  let payload = rawReport;
  if (
    payload.length === REDRAGON_M719_PRO_PACKET_LENGTH + 1
    && (payload[0] === REDRAGON_M719_PRO_RESPONSE_REPORT_ID || payload[0] === REDRAGON_M719_PRO_NOTIFY_REPORT_ID)
  ) {
    reportId = payload[0]!;
    payload = payload.subarray(1);
  }
  let flags = 0;
  let dpiRaw = 0;
  let profileRaw = 0;
  if (reportId === REDRAGON_M719_PRO_RESPONSE_REPORT_ID && payload[0] === REDRAGON_M719_PRO_COMMAND.hardwareNotify) {
    if (payload.length < 8) return null;
    flags = payload[5] ?? 0;
    dpiRaw = payload[6] ?? 0;
    profileRaw = payload[7] ?? 0;
  } else if (reportId === REDRAGON_M719_PRO_NOTIFY_REPORT_ID) {
    if (payload.length < 7) return null;
    flags = payload[4] ?? 0;
    dpiRaw = payload[5] ?? 0;
    profileRaw = payload[6] ?? 0;
  } else {
    return null;
  }

  if ((flags & 0x03) === 0) return null;
  const result: RedragonM719ProHardwareNotification = {};
  if ((flags & 0x01) !== 0) {
    result.activeDpiStage = Math.min(REDRAGON_M719_PRO_MAX_DPI_STAGES - 1, dpiRaw & 0x0f);
  }
  if ((flags & 0x02) !== 0) {
    result.activeProfile = Math.min(5, (profileRaw & 0x0f) + 1);
  }
  return result;
}

// ── Polling Rate Codec (EEPROM 0x0000) ─────────────────────────────────────

const POLLING_RATE_TO_CODE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x04],
  [125, 0x08],
]);

const CODE_TO_POLLING_RATE: ReadonlyMap<number, number> = new Map([
  [0x01, 1000],
  [0x02, 500],
  [0x04, 250],
  [0x08, 125],
]);

export function redragonM719ProEncodePollingRate(hz: number): Uint8Array {
  const code = POLLING_RATE_TO_CODE.get(hz);
  if (code === undefined) {
    throw new RangeError(`Unsupported Redragon M719RGB-PRO polling rate: ${hz} Hz.`);
  }
  return redragonM719ProPackScalar(code);
}

export function redragonM719ProDecodePollingRate(bytes: ArrayLike<number>): number {
  const code = bytes[0] ?? 0x01;
  return CODE_TO_POLLING_RATE.get(code) ?? 1000;
}

// ── PAW3325 Sensor DPI Codec (EEPROM 0x000C) ───────────────────────────────

/**
 * Authentic PAW3325 DPI lookup table extracted from `Cfg.ini` / `FUN_0040b910`:
 * 49 entries covering 200 to 5,000 DPI in 100-DPI increments.
 * Above 5,000 DPI (up to 10,000 DPI in 200-DPI increments), `hiByte = 0x01`
 * and the hardware code is looked up for `dpi / 2`.
 */
export const REDRAGON_M719_PRO_PAW3325_DPI_TABLE: readonly number[] = [
  200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100,
  1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100,
  2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000, 3100,
  3200, 3300, 3400, 3500, 3600, 3700, 3800, 3900, 4000, 4100,
  4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900, 5000,
];

export const REDRAGON_M719_PRO_PAW3325_CODE_TABLE: readonly number[] = [
  0x04, 0x06, 0x08, 0x0b, 0x0d, 0x0f, 0x12, 0x14, 0x16, 0x19,
  0x1b, 0x1d, 0x20, 0x22, 0x24, 0x27, 0x29, 0x2b, 0x2e, 0x30,
  0x32, 0x34, 0x37, 0x39, 0x3b, 0x3e, 0x40, 0x42, 0x45, 0x47,
  0x49, 0x4c, 0x4e, 0x50, 0x53, 0x55, 0x57, 0x5a, 0x5c, 0x5e,
  0x61, 0x63, 0x65, 0x68, 0x6a, 0x6c, 0x6f, 0x71, 0x73,
];

/**
 * Every distinct DPI value the PAW3325 hardware table can represent:
 * 200–5,000 DPI in 100-DPI steps, then 5,200–10,000 DPI in 200-DPI steps.
 */
export const REDRAGON_M719_PRO_DPI_OPTIONS: readonly number[] = [
  ...REDRAGON_M719_PRO_PAW3325_DPI_TABLE,
  ...REDRAGON_M719_PRO_PAW3325_DPI_TABLE.filter((dpi) => dpi >= 2600).map((dpi) => dpi * 2),
];

export function redragonM719ProNearestDpi(dpi: number): number {
  const clamped = Math.max(REDRAGON_M719_PRO_DPI_MIN, Math.min(REDRAGON_M719_PRO_DPI_MAX, Math.round(dpi)));
  let best = REDRAGON_M719_PRO_DPI_OPTIONS[0]!;
  let minDiff = Math.abs(clamped - best);
  for (const candidate of REDRAGON_M719_PRO_DPI_OPTIONS) {
    const diff = Math.abs(clamped - candidate);
    if (diff < minDiff) {
      minDiff = diff;
      best = candidate;
    }
  }
  return best;
}

/**
 * Encode a DPI value into the 4-byte PAW3325 EEPROM stage record
 * `[xCode, yCode, hiByte, checksum]`.
 */
export function redragonM719ProEncodeDpiStage(dpi: number): Uint8Array {
  if (!Number.isFinite(dpi) || dpi < REDRAGON_M719_PRO_DPI_MIN || dpi > REDRAGON_M719_PRO_DPI_MAX) {
    throw new RangeError(
      `Redragon M719RGB-PRO DPI must be between ${REDRAGON_M719_PRO_DPI_MIN} and ${REDRAGON_M719_PRO_DPI_MAX}, got ${dpi}.`,
    );
  }
  const snapped = redragonM719ProNearestDpi(dpi);
  const hiRange = snapped > 5000;
  const effectiveDpi = hiRange ? Math.round(snapped / 2) : snapped;
  let bestIndex = 0;
  let minDiff = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < REDRAGON_M719_PRO_PAW3325_DPI_TABLE.length; i += 1) {
    const tableDpi = REDRAGON_M719_PRO_PAW3325_DPI_TABLE[i]!;
    const diff = Math.abs(effectiveDpi - tableDpi);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }
  const code = REDRAGON_M719_PRO_PAW3325_CODE_TABLE[bestIndex]!;
  const hiByte = hiRange ? 0x01 : 0x00;
  const chk = (REDRAGON_M719_PRO_CHECKSUM_TARGET - ((code + code + hiByte) & 0xff)) & 0xff;
  return new Uint8Array([code, code, hiByte, chk]);
}

/**
 * Decode a 4-byte PAW3325 EEPROM stage record `[xCode, yCode, hiByte, checksum]`.
 */
export function redragonM719ProDecodeDpiStage(bytes: ArrayLike<number>): number {
  const code = bytes[0] ?? 0x12;
  const hiRange = (bytes[2] ?? 0) !== 0;
  let bestIndex = 0;
  let minDiff = 0xff;
  for (let i = 0; i < REDRAGON_M719_PRO_PAW3325_CODE_TABLE.length; i += 1) {
    const tableCode = REDRAGON_M719_PRO_PAW3325_CODE_TABLE[i]!;
    const diff = Math.abs(code - tableCode);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }
  const baseDpi = REDRAGON_M719_PRO_PAW3325_DPI_TABLE[bestIndex] ?? 800;
  return hiRange ? baseDpi * 2 : baseDpi;
}

/**
 * Encode all 5 DPI stages into the 20-byte block at `0x000c`.
 */
export function redragonM719ProEncodeDpiStages(stages: readonly number[]): Uint8Array {
  const block = new Uint8Array(REDRAGON_M719_PRO_MAX_DPI_STAGES * 4);
  for (let i = 0; i < REDRAGON_M719_PRO_MAX_DPI_STAGES; i += 1) {
    const dpi = stages[i] ?? REDRAGON_M719_PRO_DEFAULT_STAGES[i] ?? 800;
    block.set(redragonM719ProEncodeDpiStage(dpi), i * 4);
  }
  return block;
}

/**
 * Decode the 20-byte DPI stage block at `0x000c` into 5 DPI values.
 */
export function redragonM719ProDecodeDpiStages(bytes: Uint8Array): number[] {
  const stages: number[] = [];
  for (let i = 0; i < REDRAGON_M719_PRO_MAX_DPI_STAGES; i += 1) {
    const offset = i * 4;
    if (offset + 4 <= bytes.length) {
      stages.push(redragonM719ProDecodeDpiStage(bytes.subarray(offset, offset + 4)));
    } else {
      stages.push(REDRAGON_M719_PRO_DEFAULT_STAGES[i]!);
    }
  }
  return stages;
}

// ── DPI Stage Colors & DPI Indicator LED Codec (EEPROM 0x002C & 0x004C) ────

export function redragonM719ProEncodeDpiStageColor(color: RedragonM719ProRgb): Uint8Array {
  const r = color.r & 0xff;
  const g = color.g & 0xff;
  const b = color.b & 0xff;
  const chk = (REDRAGON_M719_PRO_CHECKSUM_TARGET - ((r + g + b) & 0xff)) & 0xff;
  return new Uint8Array([r, g, b, chk]);
}

export function redragonM719ProDecodeDpiStageColor(bytes: ArrayLike<number>): RedragonM719ProRgb {
  return {
    r: (bytes[0] ?? 0xff) & 0xff,
    g: (bytes[1] ?? 0x00) & 0xff,
    b: (bytes[2] ?? 0x00) & 0xff,
  };
}

export function redragonM719ProEncodeDpiStageColors(colors: readonly RedragonM719ProRgb[]): Uint8Array {
  const block = new Uint8Array(REDRAGON_M719_PRO_MAX_DPI_STAGES * 4);
  for (let i = 0; i < REDRAGON_M719_PRO_MAX_DPI_STAGES; i += 1) {
    const color = colors[i] ?? REDRAGON_M719_PRO_DEFAULT_STAGE_COLORS[i]!;
    block.set(redragonM719ProEncodeDpiStageColor(color), i * 4);
  }
  return block;
}

export function redragonM719ProDecodeDpiStageColors(bytes: Uint8Array): RedragonM719ProRgb[] {
  const colors: RedragonM719ProRgb[] = [];
  for (let i = 0; i < REDRAGON_M719_PRO_MAX_DPI_STAGES; i += 1) {
    const offset = i * 4;
    if (offset + 3 <= bytes.length) {
      colors.push(redragonM719ProDecodeDpiStageColor(bytes.subarray(offset, offset + 4)));
    } else {
      colors.push({ ...REDRAGON_M719_PRO_DEFAULT_STAGE_COLORS[i]! });
    }
  }
  return colors;
}

/**
 * DPI indicator / logo LED mode values at EEPROM `0x004c`:
 * - `0` (`0x00`): Off
 * - `1` (`0x01`): Steady
 * - `2` (`0x02`): Respiration (Breathing)
 */
export const REDRAGON_M719_PRO_DPI_LED_MODES = [0, 1, 2] as const;
export type RedragonM719ProDpiLedMode = (typeof REDRAGON_M719_PRO_DPI_LED_MODES)[number];

/**
 * Encode the DPI indicator LED block at `0x004c`.
 * Verified from OEM `FUN_0040b350` (`dec1.c` lines 1995–2042):
 * - Off (`0`): `[0x00, 0x55]`
 * - Steady (`1`) / Breathing (`2`): `[mode, 0x55 - mode, 0xff, 0x56, activeStage, 0x55 - activeStage]`
 */
export function redragonM719ProEncodeDpiLedEffect(
  mode: RedragonM719ProDpiLedMode,
  activeStage = 0,
): Uint8Array {
  if (mode === 0) {
    return new Uint8Array([0x00, 0x55]);
  }
  const eff = mode & 0xff;
  const stageIdx = Math.max(0, Math.min(REDRAGON_M719_PRO_MAX_DPI_STAGES - 1, activeStage)) & 0xff;
  return new Uint8Array([
    eff,
    (REDRAGON_M719_PRO_CHECKSUM_TARGET - eff) & 0xff,
    0xff,
    (REDRAGON_M719_PRO_CHECKSUM_TARGET - 0xff) & 0xff,
    stageIdx,
    (REDRAGON_M719_PRO_CHECKSUM_TARGET - stageIdx) & 0xff,
  ]);
}

export function redragonM719ProDecodeDpiLedEffect(bytes: ArrayLike<number>): RedragonM719ProDpiLedMode {
  const raw = bytes[0] ?? 0;
  if (raw === 1 || raw === 2) return raw;
  return 0;
}

// ── Main RGB Lighting Codec (EEPROM 0x00A0) ────────────────────────────────

export const REDRAGON_M719_PRO_RGB_EFFECT = {
  neon: 0x00,
  breathing: 0x01,
  steady: 0x02,
  off: 0x04,
} as const;

export type RedragonM719ProRgbEffectCode =
  (typeof REDRAGON_M719_PRO_RGB_EFFECT)[keyof typeof REDRAGON_M719_PRO_RGB_EFFECT];

/** Speed lookup table (levels 1..10) for Steady / Breathing modes (`DAT_00462fc8`). */
export const REDRAGON_M719_PRO_SPEED_LUT: readonly number[] = [
  0xff, 0xe6, 0xd2, 0xbe, 0xaa, 0x96, 0x82, 0x6e, 0x46, 0x28,
];

/** Speed lookup table (levels 1..10) for Neon mode (`DAT_00462fd4`). */
export const REDRAGON_M719_PRO_NEON_SPEED_LUT: readonly number[] = [
  0x2d, 0x28, 0x23, 0x1e, 0x19, 0x13, 0x0f, 0x0a, 0x05, 0x03,
];

/** Brightness lookup table (levels 1..10 -> 10%..100%) (`DAT_00462fe0`). */
export const REDRAGON_M719_PRO_BRIGHTNESS_LUT: readonly number[] = [
  0x19, 0x32, 0x4b, 0x64, 0x7d, 0x96, 0xaf, 0xc8, 0xe1, 0xff,
];

export const REDRAGON_M719_PRO_SPEED_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const REDRAGON_M719_PRO_BRIGHTNESS_PERCENTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

function reverseLut(lut: readonly number[], rawByte: number): number {
  let bestIndex = 0;
  let minDiff = 0xff;
  for (let i = 0; i < lut.length; i += 1) {
    const diff = Math.abs(rawByte - lut[i]!);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }
  return bestIndex + 1;
}

export interface RedragonM719ProRgbConfig {
  effect: RedragonM719ProRgbEffectCode;
  color: RedragonM719ProRgb;
  /** Speed level 1..10. */
  speed: number;
  /** Brightness level 1..10 (corresponding to 10%..100%). */
  brightness: number;
}

/**
 * Encode the 7-byte main RGB lighting block at EEPROM `0x00a0`:
 * `[hwEffect, r, g, b, hwSpeed, hwBrightness, checksum]`.
 */
export function redragonM719ProEncodeRgbLighting(config: RedragonM719ProRgbConfig): Uint8Array {
  const effect = config.effect;
  const r = config.color.r & 0xff;
  const g = config.color.g & 0xff;
  const b = config.color.b & 0xff;
  const speedLevel = Math.max(1, Math.min(10, Math.round(config.speed)));
  const brightnessLevel = Math.max(1, Math.min(10, Math.round(config.brightness)));

  let hwSpeed = 0x00;
  let hwBrightness = 0x00;
  if (effect !== REDRAGON_M719_PRO_RGB_EFFECT.off) {
    hwSpeed = effect === REDRAGON_M719_PRO_RGB_EFFECT.neon
      ? REDRAGON_M719_PRO_NEON_SPEED_LUT[speedLevel - 1]!
      : REDRAGON_M719_PRO_SPEED_LUT[speedLevel - 1]!;
    hwBrightness = REDRAGON_M719_PRO_BRIGHTNESS_LUT[brightnessLevel - 1]!;
  }
  const bytes = [effect, r, g, b, hwSpeed, hwBrightness];
  return new Uint8Array([...bytes, redragonM719ProDataChecksum(bytes)]);
}

/**
 * Decode the 7-byte main RGB lighting block from EEPROM `0x00a0`.
 */
export function redragonM719ProDecodeRgbLighting(bytes: ArrayLike<number>): RedragonM719ProRgbConfig {
  const rawEffect = bytes[0] ?? REDRAGON_M719_PRO_RGB_EFFECT.steady;
  const effect: RedragonM719ProRgbEffectCode =
    rawEffect === REDRAGON_M719_PRO_RGB_EFFECT.neon
    || rawEffect === REDRAGON_M719_PRO_RGB_EFFECT.breathing
    || rawEffect === REDRAGON_M719_PRO_RGB_EFFECT.steady
    || rawEffect === REDRAGON_M719_PRO_RGB_EFFECT.off
      ? rawEffect
      : REDRAGON_M719_PRO_RGB_EFFECT.off;
  const color: RedragonM719ProRgb = {
    r: (bytes[1] ?? 0xff) & 0xff,
    g: (bytes[2] ?? 0x00) & 0xff,
    b: (bytes[3] ?? 0x00) & 0xff,
  };
  const spdByte = bytes[4] ?? 0x96;
  const briByte = bytes[5] ?? 0xff;
  const speed = spdByte === 0
    ? 5
    : effect === REDRAGON_M719_PRO_RGB_EFFECT.neon
      ? reverseLut(REDRAGON_M719_PRO_NEON_SPEED_LUT, spdByte)
      : reverseLut(REDRAGON_M719_PRO_SPEED_LUT, spdByte);
  const brightness = briByte === 0 ? 10 : reverseLut(REDRAGON_M719_PRO_BRIGHTNESS_LUT, briByte);
  return { effect, color, speed, brightness };
}

// ── Button Matrix & Extended Multimedia / Key Combo Codec ──────────────────

/**
 * Physical buttons on the Redragon M719RGB-PRO and their hardware slot indices
 * in the 16-slot matrix at `0x0060..0x009f` (`slotOffset = 0x0060 + slot * 4`).
 *
 * Verified from OEM `pro.dct` (`+0x23C MatrixInx+1`) and Wireshark captures:
 * - Button 1 (Left): slot 0 (`0x0060`)
 * - Button 2 (Right): slot 1 (`0x0064`)
 * - Button 3 (Middle / Wheel click): slot 2 (`0x0068`)
 * - Button 4 (Forward): slot 4 (`0x0070`)
 * - Button 5 (Back): slot 3 (`0x006c`)
 * - Button 6 (Fire): slot 8 (`0x0080`)
 * - Button 7 (DPI up): slot 10 (`0x0088`)
 * - Button 8 (DPI down): slot 11 (`0x008c`)
 * (Slot 6 at `0x0078` is the physical bottom Profile Switch button `[0x09, 0x00, 0x00, 0x4c]`.)
 */
export const REDRAGON_M719_PRO_BUTTONS = [
  { label: "Left (1)", slot: 0, offset: 0x0060 },
  { label: "Right (2)", slot: 1, offset: 0x0064 },
  { label: "Wheel click (3)", slot: 2, offset: 0x0068 },
  { label: "Forward (4)", slot: 4, offset: 0x0070 },
  { label: "Back (5)", slot: 3, offset: 0x006c },
  { label: "Fire (6)", slot: 8, offset: 0x0080 },
  { label: "DPI up (7)", slot: 10, offset: 0x0088 },
  { label: "DPI down (8)", slot: 11, offset: 0x008c },
] as const;

export type RedragonM719ProButtonLabel = (typeof REDRAGON_M719_PRO_BUTTONS)[number]["label"];

/** Direct 4-byte matrix actions (`[b0, b1, b2]`). */
const DIRECT_BUTTON_ACTIONS: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
  ["Left click", [0x01, 0x01, 0x00]],
  ["Right click", [0x01, 0x02, 0x00]],
  ["Middle click", [0x01, 0x04, 0x00]],
  ["Back", [0x01, 0x08, 0x00]],
  ["Forward", [0x01, 0x10, 0x00]],
  ["Three click", [0x04, 0x32, 0x03]],
  ["DPI cycle", [0x02, 0x01, 0x00]],
  ["DPI up", [0x02, 0x02, 0x00]],
  ["DPI down", [0x02, 0x03, 0x00]],
  ["Polling rate switch", [0x07, 0x00, 0x00]],
  ["RGB on/off", [0x08, 0x00, 0x00]],
  ["Profile switch", [0x09, 0x00, 0x00]],
  ["Disabled", [0x00, 0x00, 0x00]],
];

/** Multimedia actions stored as `[0x05, 0x00, 0x00, 0x50]` + consumer usage at `0x0100 + slot * 0x20`. */
const MULTIMEDIA_ACTIONS: ReadonlyArray<readonly [string, number]> = [
  ["Media player", 0x0183],
  ["Play/Pause", 0x00cd],
  ["Next track", 0x00b5],
  ["Previous track", 0x00b6],
  ["Stop", 0x00b7],
  ["Mute", 0x00e2],
  ["Volume up", 0x00e9],
  ["Volume down", 0x00ea],
  ["Email", 0x018a],
  ["Calculator", 0x0192],
  ["My computer", 0x0194],
  ["Web home", 0x0223],
  ["Web search", 0x0221],
  ["Web forward", 0x0225],
  ["Web back", 0x0224],
  ["Web stop", 0x0226],
  ["Web refresh", 0x0227],
  ["Web favorites", 0x022a],
];

/** Common keyboard shortcuts stored as `[0x05, 0x00, 0x00, 0x50]` + key events at `0x0100 + slot * 0x20`. */
const SHORTCUT_ACTIONS: ReadonlyArray<readonly [string, number, number]> = [
  // [label, modifierMask (1=Ctrl, 2=Shift, 4=Alt, 8=Win), hidKeyUsage]
  ["Copy (Ctrl+C)", 0x01, 0x06],
  ["Paste (Ctrl+V)", 0x01, 0x19],
  ["Cut (Ctrl+X)", 0x01, 0x1b],
  ["Undo (Ctrl+Z)", 0x01, 0x1d],
  ["Select all (Ctrl+A)", 0x01, 0x04],
  ["Find (Ctrl+F)", 0x01, 0x09],
  ["New (Ctrl+N)", 0x01, 0x11],
  ["Print (Ctrl+P)", 0x01, 0x13],
  ["Save (Ctrl+S)", 0x01, 0x16],
  ["Close window (Alt+F4)", 0x04, 0x3d],
  ["Show desktop (Win+D)", 0x08, 0x07],
  ["Explorer (Win+E)", 0x08, 0x08],
  ["Run (Win+R)", 0x08, 0x15],
  ["Lock PC (Win+L)", 0x08, 0x0f],
  ["Task Manager (Ctrl+Shift+Esc)", 0x03, 0x29],
];

const KEY_USAGES: ReadonlyArray<readonly [string, number]> = [
  ...Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), 0x04 + i] as const),
  ...Array.from({ length: 9 }, (_, i) => [String(i + 1), 0x1e + i] as const),
  ["0", 0x27],
  ["Enter", 0x28],
  ["Esc", 0x29],
  ["Backspace", 0x2a],
  ["Tab", 0x2b],
  ["Space", 0x2c],
  ["-", 0x2d],
  ["=", 0x2e],
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x3a + i] as const),
  ["Insert", 0x49],
  ["Home", 0x4a],
  ["Page Up", 0x4b],
  ["Delete", 0x4c],
  ["End", 0x4d],
  ["Page Down", 0x4e],
  ["Right arrow", 0x4f],
  ["Left arrow", 0x50],
  ["Down arrow", 0x51],
  ["Up arrow", 0x52],
];

const KEY_BY_NAME: ReadonlyMap<string, number> = new Map(
  KEY_USAGES.map(([name, usage]) => [name.toLowerCase(), usage]),
);
const KEY_BY_USAGE: ReadonlyMap<number, string> = new Map(
  KEY_USAGES.map(([name, usage]) => [usage, name]),
);

const DIRECT_BY_LABEL: ReadonlyMap<string, readonly [number, number, number]> = new Map(DIRECT_BUTTON_ACTIONS);
const MULTIMEDIA_BY_LABEL: ReadonlyMap<string, number> = new Map(MULTIMEDIA_ACTIONS);
const MULTIMEDIA_BY_CODE: ReadonlyMap<number, string> = new Map(
  MULTIMEDIA_ACTIONS.map(([label, code]) => [code, label]),
);
const SHORTCUT_BY_LABEL: ReadonlyMap<string, readonly [number, number]> = new Map(
  SHORTCUT_ACTIONS.map(([label, mods, key]) => [label, [mods, key] as const]),
);

export const REDRAGON_M719_PRO_BUTTON_ACTIONS: readonly string[] = [
  ...DIRECT_BUTTON_ACTIONS.map(([label]) => label),
  ...MULTIMEDIA_ACTIONS.map(([label]) => label),
  ...SHORTCUT_ACTIONS.map(([label]) => label),
  ...KEY_USAGES.map(([name]) => `Key ${name}`),
];

export interface RedragonM719ProEncodedButton {
  /** 4-byte slot record `[b0, b1, b2, checksum]` at `0x0060 + slot * 4`. */
  slotBytes: Uint8Array;
  /** Optional extended payload written to `0x0100 + slot * 0x20` when `slotBytes[0] === 0x05`. */
  comboPayload?: Uint8Array;
}

/**
 * Encode a 16-bit HID Consumer usage into the 10-byte EEPROM block at `0x0100 + slot * 0x20`.
 * Format: `[0x02, 0x82, lo, hi, 0x42, lo, hi, chk, 0x00, 0x00]`.
 */
export function redragonM719ProEncodeMultimediaPayload(consumerCode: number): Uint8Array {
  const lo = consumerCode & 0xff;
  const hi = (consumerCode >> 8) & 0xff;
  const body = [0x02, 0x82, lo, hi, 0x42, lo, hi];
  const buf = new Uint8Array(10);
  buf.set(body, 0);
  buf[7] = redragonM719ProDataChecksum(body);
  return buf;
}

/**
 * Encode a modifier mask (`0x01` Ctrl, `0x02` Shift, `0x04` Alt, `0x08` Win) and
 * HID keyboard usage into the EEPROM block at `0x0100 + slot * 0x20`.
 * Verified from OEM `FUN_0040af50` (`dec2.c` lines 3466–3521).
 */
export function redragonM719ProEncodeKeyComboPayload(modifierMask: number, hidKey: number): Uint8Array {
  const events: Array<readonly [number, number, number]> = [];
  for (const bit of [0x01, 0x02, 0x04, 0x08] as const) {
    if ((modifierMask & bit) !== 0) {
      events.push([0x80, bit, 0x00]);
    }
  }
  if (hidKey !== 0) {
    events.push([0x81, hidKey & 0xff, 0x00]);
  }
  for (const bit of [0x01, 0x02, 0x04, 0x08] as const) {
    if ((modifierMask & bit) !== 0) {
      events.push([0x40, bit, 0x00]);
    }
  }
  if (hidKey !== 0) {
    events.push([0x41, hidKey & 0xff, 0x00]);
  }

  const rawLen = 1 + events.length * 3 + 1;
  const totalLen = Math.max(1, Math.ceil(rawLen / 10)) * 10;
  const buf = new Uint8Array(totalLen);
  buf[0] = events.length & 0xff;
  let idx = 1;
  for (const [e0, e1, e2] of events) {
    buf[idx] = e0;
    buf[idx + 1] = e1;
    buf[idx + 2] = e2;
    idx += 3;
  }
  buf[idx] = redragonM719ProDataChecksum(buf.subarray(0, idx));
  return buf;
}

function parseGenericKeyAction(action: string): readonly [number, number] | null {
  if (action.startsWith("Key ")) {
    const keyName = action.slice(4).trim().toLowerCase();
    const usage = KEY_BY_NAME.get(keyName);
    return usage !== undefined ? [0, usage] : null;
  }
  const body = action.startsWith("Keys ")
    ? action.slice(5).trim()
    : action.startsWith("Combo:")
      ? action.slice(6).trim()
      : null;
  if (!body) return null;
  const parts = body.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let mask = 0;
  let keyUsage = 0;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") mask |= 0x01;
    else if (lower === "shift") mask |= 0x02;
    else if (lower === "alt") mask |= 0x04;
    else if (lower === "win" || lower === "meta" || lower === "gui") mask |= 0x08;
    else {
      const usage = KEY_BY_NAME.get(lower);
      if (usage === undefined || keyUsage !== 0) return null;
      keyUsage = usage;
    }
  }
  if (mask === 0 && keyUsage === 0) return null;
  return [mask, keyUsage];
}

/**
 * Encode a human-readable button action into its 4-byte matrix slot record and
 * optional extended payload for `0x0100 + slot * 0x20`.
 */
export function redragonM719ProEncodeButtonAction(action: string): RedragonM719ProEncodedButton {
  const direct = DIRECT_BY_LABEL.get(action);
  if (direct) {
    const [b0, b1, b2] = direct;
    return {
      slotBytes: new Uint8Array([b0, b1, b2, redragonM719ProDataChecksum(direct)]),
    };
  }

  const consumerCode = MULTIMEDIA_BY_LABEL.get(action);
  if (consumerCode !== undefined) {
    const slotTriplet = [0x05, 0x00, 0x00] as const;
    return {
      slotBytes: new Uint8Array([...slotTriplet, redragonM719ProDataChecksum(slotTriplet)]),
      comboPayload: redragonM719ProEncodeMultimediaPayload(consumerCode),
    };
  }

  const shortcut = SHORTCUT_BY_LABEL.get(action) ?? parseGenericKeyAction(action);
  if (shortcut) {
    const [modifierMask, hidKey] = shortcut;
    const slotTriplet = [0x05, 0x00, 0x00] as const;
    return {
      slotBytes: new Uint8Array([...slotTriplet, redragonM719ProDataChecksum(slotTriplet)]),
      comboPayload: redragonM719ProEncodeKeyComboPayload(modifierMask, hidKey),
    };
  }

  throw new Error(`Unsupported Redragon M719RGB-PRO button action: ${action}`);
}

/**
 * Decode an extended payload from `0x0100 + slot * 0x20` when a button slot has `b0 === 0x05`.
 */
export function redragonM719ProDecodeComboPayload(comboBytes: ArrayLike<number>): string | null {
  if (comboBytes.length < 4) return null;
  const kind = comboBytes[1] ?? 0;
  if (kind === 0x82 || kind === 0x83) {
    const code = ((comboBytes[2] ?? 0) & 0xff) | (((comboBytes[3] ?? 0) & 0xff) << 8);
    return MULTIMEDIA_BY_CODE.get(code) ?? `Consumer (0x${code.toString(16).toUpperCase().padStart(4, "0")})`;
  }
  if (kind === 0x80 || kind === 0x81) {
    let modifierMask = 0;
    let keyUsage = 0;
    for (let i = 1; i + 2 < comboBytes.length; i += 3) {
      const evType = comboBytes[i] ?? 0;
      const evCode = comboBytes[i + 1] ?? 0;
      if (evType === 0x80) {
        modifierMask |= evCode & 0x0f;
      } else if (evType === 0x81) {
        keyUsage = evCode & 0xff;
      } else {
        break;
      }
    }
    for (const [label, mask, usage] of SHORTCUT_ACTIONS) {
      if (mask === modifierMask && usage === keyUsage) return label;
    }
    const keyName = KEY_BY_USAGE.get(keyUsage);
    if (modifierMask === 0 && keyName) {
      return `Key ${keyName}`;
    }
    const parts: string[] = [];
    if ((modifierMask & 0x01) !== 0) parts.push("Ctrl");
    if ((modifierMask & 0x02) !== 0) parts.push("Shift");
    if ((modifierMask & 0x04) !== 0) parts.push("Alt");
    if ((modifierMask & 0x08) !== 0) parts.push("Win");
    if (keyName) parts.push(keyName);
    else if (keyUsage !== 0) parts.push(`0x${keyUsage.toString(16).toUpperCase().padStart(2, "0")}`);
    if (parts.length > 0) return `Keys ${parts.join("+")}`;
  }
  return null;
}

/**
 * Decode a 4-byte button slot record `[b0, b1, b2, chk]` (with an optional
 * extended payload from `0x0100 + slot * 0x20` when `b0 === 0x05`).
 */
export function redragonM719ProDecodeButtonAction(
  slotBytes: ArrayLike<number>,
  comboBytes?: ArrayLike<number> | null,
): string {
  const b0 = (slotBytes[0] ?? 0) & 0xff;
  const b1 = (slotBytes[1] ?? 0) & 0xff;
  const b2 = (slotBytes[2] ?? 0) & 0xff;

  if (b0 === 0x05) {
    if (comboBytes) {
      const decoded = redragonM719ProDecodeComboPayload(comboBytes);
      if (decoded) return decoded;
    }
    return "Multimedia / Key combination";
  }

  if (b0 === 0x06) {
    return `Macro ${b1 + 1}`;
  }

  for (const [label, [d0, d1, d2]] of DIRECT_BUTTON_ACTIONS) {
    if (b0 === d0 && b1 === d1 && b2 === d2) return label;
  }

  if (b0 === 0x04) {
    return "Three click";
  }

  const hex = [b0, b1, b2, (slotBytes[3] ?? 0) & 0xff]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
  return `Custom (${hex})`;
}
