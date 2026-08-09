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

export function pulsarDecodeDpi(data: Uint8Array): number {
  const flags = data[2] ?? 0;
  const raw = (data[0] ?? 0) + (((flags & 0x0c) >> 2) << 8);
  let dpi = (raw + 1) * 10;
  if ((flags & 0x02) !== 0) dpi = dpi * 5 + 10000;
  if ((flags & 0x01) !== 0) dpi *= 2;
  return dpi;
}

export function pulsarEncodeDpi(dpi: number): Uint8Array {
  let raw: number;
  let dpiEx: number;
  if (dpi >= 30100) { raw = (dpi / 2 - 10050) / 50; dpiEx = 0x33; }
  else if (dpi >= 10050) { raw = (dpi - 10050) / 50; dpiEx = 0x22; }
  else { raw = dpi / 10 - 1; dpiEx = 0; }
  const high = raw >> 8;
  const result = new Uint8Array(4);
  result[0] = raw;
  result[1] = raw;
  result[2] = (high << 2) | (high << 6) | dpiEx | (dpiEx << 4);
  result[3] = pulsarDataChecksum(result.slice(0, 3));
  return result;
}

export function pulsarDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = 10; dpi <= 10000; dpi += 10) options.push(dpi);
  for (let dpi = 10050; dpi <= 30000; dpi += 50) options.push(dpi);
  for (let dpi = 30100; dpi <= 32000; dpi += 100) options.push(dpi);
  return options;
}

export function readUint16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

export function readUint32LE(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16) | ((data[offset + 3] ?? 0) << 24)) >>> 0;
}

export function uint32LE(value: number): Uint8Array {
  return new Uint8Array([value, value >>> 8, value >>> 16, value >>> 24]);
}
