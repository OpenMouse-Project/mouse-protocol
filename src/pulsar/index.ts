export const PULSAR_VENDOR_ID = 0x3710;
export const PULSAR_CONFIG_REPORT_ID = 0x08;
export const PULSAR_CONFIG_PACKET_LENGTH = 16;

export const PULSAR_COMMAND = {
  encryptionData: 0x01, deviceOnline: 0x03, batteryLevel: 0x04,
  writeFlashData: 0x07, readFlashData: 0x08, getCurrentConfig: 0x0e,
  readVersionId: 0x12, setDongleRgb: 0x14, getDongleRgb: 0x15,
  getDongleVersion: 0x1d, getRssi: 0x2b,
} as const;

export const PULSAR_FLASH = {
  reportRate: 0, currentDpi: 4, liftOffDistance: 10, dpiValues: 12,
  debounceTime: 169, motionSync: 171, sleepTime: 173,
  angleSnapping: 175, rippleControl: 177, performanceState: 181,
  performanceTime: 183,
} as const;

export const PULSAR_PRO_PRODUCT_ID = 0x5405;
export const PULSAR_PRO_REPORT_ID = 0;
export const PULSAR_PRO_REPORT_LENGTH = 63;
export const PULSAR_PRO_COMMAND = {
  dongleVersion: 0xa0, rssi: 0xa4, dpi: 0xb1, polling: 0xb2, lod: 0xb3,
  battery: 0xb4, motionSync: 0xb5, ripple: 0xb6, angleSnap: 0xb7,
  angleTune: 0xb8, wheelAcceleration: 0xb9, lowBattery: 0xbe,
  mouseVersion: 0xbf, remoteLed: 0xc0, dpiLed: 0xc1, powerSaving: 0xc2,
  saveAllow: 0xc3, turboMode: 0xc4, debounce: 0xc5, profile: 0xc6,
} as const;

export function pulsarPacketChecksum(packet: Uint8Array): number {
  let sum = PULSAR_CONFIG_REPORT_ID;
  for (let index = 0; index < packet.length - 1; index += 1) sum += packet[index] ?? 0;
  return (0x55 - (sum & 0xff)) & 0xff;
}

export function pulsarDataChecksum(data: Uint8Array): number {
  let sum = 0;
  for (const value of data) sum += value;
  return (0x55 - (sum & 0xff)) & 0xff;
}

export function pulsarDecodePollingRate(encoded: number): number {
  return encoded >= 16 ? encoded / 16 * 2000 : 1000 / encoded;
}

export function pulsarEncodePollingRate(rate: number): number {
  const encoded = rate <= 1000 ? 1000 / rate : rate / 2000 * 16;
  if (!Number.isInteger(encoded) || ![125, 250, 500, 1000, 2000, 4000, 8000].includes(rate)) {
    throw new Error("Unsupported Pulsar polling rate.");
  }
  return encoded;
}

export function pulsarDecodeDpi(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  const low = data[0] ?? 0;
  const duplicate = data[1] ?? 0;
  const flags = data[2] ?? 0;
  const checksum = data[3] ?? 0;
  if (low !== duplicate || ((low + duplicate + flags + checksum) & 0xff) !== 0x55) return null;
  return ((((flags >> 2) & 0x03) << 8) + low + 1) * 50;
}

export function pulsarEncodeDpi(dpi: number): Uint8Array {
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 26000 || dpi % 50 !== 0) {
    throw new Error("Pulsar DPI must be 50–26,000 in 50 DPI steps.");
  }
  const encoded = dpi / 50 - 1;
  const low = encoded & 0xff;
  const high = (encoded >> 8) & 0x03;
  const flags = (high << 2) | (high << 6);
  return new Uint8Array([low, low, flags, (0x55 - low - low - flags) & 0xff]);
}

export function pulsarDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = 50; dpi <= 26000; dpi += 50) options.push(dpi);
  return options;
}

export function readUint16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

// XS-1 protocol used by the X3 family: unnumbered 64-byte feature reports
// (report ID 0, which WebHID does not prefix) carrying a 16-bit
// little-endian checksum of bytes 0..61 in bytes 62..63.
export const PULSAR_XS1_PRODUCT_IDS: ReadonlySet<number> = new Set([0x3409, 0x3410, 0x5402, 0x5403]);
export const PULSAR_XS1_WIRELESS_PRODUCT_IDS: ReadonlySet<number> = new Set([0x5402, 0x5403]);
export const PULSAR_XS1_FEATURE_REPORT_ID = 0;
export const PULSAR_XS1_PACKET_LENGTH = 64;
export const PULSAR_XS1_DPI_MIN = 50;
export const PULSAR_XS1_DPI_MAX = 26000;
export const PULSAR_XS1_DPI_STEP = 50;
export const PULSAR_XS1_DEBOUNCE_MAX_MS = 15;
export const PULSAR_XS1_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

export function pulsarXs1Checksum(packet: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < packet.length - 2; index += 1) sum += packet[index] ?? 0;
  return sum & 0xffff;
}

export function pulsarXs1EncodeRequest(command: readonly number[]): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(PULSAR_XS1_PACKET_LENGTH);
  packet[0] = 0x00;
  for (let index = 0; index < command.length; index += 1) packet[index + 1] = command[index] ?? 0;
  const checksum = pulsarXs1Checksum(packet);
  packet[62] = checksum & 0xff;
  packet[63] = checksum >> 8;
  return packet;
}

export function pulsarXs1DpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = PULSAR_XS1_DPI_MIN; dpi <= PULSAR_XS1_DPI_MAX; dpi += PULSAR_XS1_DPI_STEP) options.push(dpi);
  return options;
}

export function pulsarXs1DecodePollingRate(value: number): number | null {
  return PULSAR_XS1_POLLING_QUERY_RATES[value] ?? null;
}

const PULSAR_XS1_POLLING_QUERY_RATES: Readonly<Record<number, number>> = {
  240: 125, 120: 250, 60: 500, 30: 1000, 15: 2000, 8: 4000, 4: 8000,
};

export function readUint32LE(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16) | ((data[offset + 3] ?? 0) << 24)) >>> 0;
}

export function uint32LE(value: number): Uint8Array {
  return new Uint8Array([value, value >>> 8, value >>> 16, value >>> 24]);
}

