// Transport-independent DPI codec for the 0x1d57 X11-style protocol used by
// the Attack Shark X11 and branded Delux M800 Mini firmware.
//
// Layout verified against akawazak/attack-shark-x11-community-driver's
// `DpiBuilder` and docs/dpi-protocol.md: a 56-byte FEATURE report on report
// id 0x04 (52 bytes on the wire, 56 over the 2.4 GHz receiver), six stages,
// an active stage index, stage masks, per-stage "high" flags, and a 16-bit
// big-endian checksum over bytes 3..49. The community driver writes this
// over interface 2 exactly as the polling command is written.
//
// The DPI byte encoding is not linear: each supported value maps to a
// hardware register byte (src/main/driver/tables/dpi-map.ts upstream).
// Above 10,000 the byte repeats across register pages, so the stage mask and
// high flag bytes are what disambiguate a value on read.

export const X11_DPI_REPORT_ID = 0x04;
export const X11_DPI_STAGE_COUNT = 6;
export const X11_DPI_MIN = 50;
export const X11_DPI_MAX = 22000;
export const X11_DPI_STEP = 50;
export const X11_DPI_DEFAULT_ACTIVE = 2;

/** X11 factory stage table (DpiBuilder.DEFAULT_OPTIONS upstream). */
export const X11_DPI_DEFAULT_STAGES: readonly number[] = [800, 1600, 2400, 3200, 5000, 22000];

/**
 * DPI value -> hardware byte. Values above 10,000 intentionally repeat
 * (10100->0x76, 20100->0xeb, ...) because the high nibble selects the
 * sensor's register page.
 */
export const X11_DPI_STEP_MAP: Readonly<Record<number, number>> = {
  50: 0x01, 100: 0x02, 150: 0x03, 200: 0x04, 250: 0x05, 300: 0x06, 350: 0x08,
  400: 0x09, 450: 0x0a, 500: 0x0b, 550: 0x0c, 600: 0x0e, 650: 0x0f, 700: 0x10,
  750: 0x11, 800: 0x12, 850: 0x13, 900: 0x15, 950: 0x16, 1000: 0x17, 1050: 0x18,
  1100: 0x19, 1150: 0x1b, 1200: 0x1c, 1250: 0x1d, 1300: 0x1e, 1350: 0x1f,
  1400: 0x20, 1450: 0x22, 1500: 0x23, 1550: 0x24, 1600: 0x25, 1650: 0x26,
  1700: 0x27, 1750: 0x29, 1800: 0x2a, 1850: 0x2b, 1900: 0x2c, 1950: 0x2d,
  2000: 0x2f, 2050: 0x30, 2100: 0x31, 2150: 0x32, 2200: 0x33, 2250: 0x34,
  2300: 0x36, 2350: 0x37, 2400: 0x38, 2450: 0x39, 2500: 0x3a, 2550: 0x3b,
  2600: 0x3d, 2650: 0x3e, 2700: 0x3f, 2750: 0x40, 2800: 0x41, 2850: 0x43,
  2900: 0x44, 2950: 0x45, 3000: 0x46, 3050: 0x47, 3100: 0x48, 3150: 0x4a,
  3200: 0x4b, 3250: 0x4c, 3300: 0x4d, 3350: 0x4e, 3400: 0x4f, 3450: 0x51,
  3500: 0x52, 3550: 0x53, 3600: 0x54, 3650: 0x55, 3700: 0x57, 3750: 0x58,
  3800: 0x59, 3850: 0x5a, 3900: 0x5b, 3950: 0x5c, 4000: 0x5e, 4050: 0x5f,
  4100: 0x60, 4150: 0x61, 4200: 0x62, 4250: 0x63, 4300: 0x65, 4350: 0x66,
  4400: 0x67, 4450: 0x68, 4500: 0x69, 4550: 0x6b, 4600: 0x6c, 4650: 0x6d,
  4700: 0x6e, 4750: 0x6f, 4800: 0x70, 4850: 0x72, 4900: 0x73, 4950: 0x74,
  5000: 0x75, 5050: 0x76, 5100: 0x77, 5150: 0x79, 5200: 0x7a, 5250: 0x7b,
  5300: 0x7c, 5350: 0x7d, 5400: 0x7f, 5450: 0x80, 5500: 0x81, 5550: 0x82,
  5600: 0x83, 5650: 0x84, 5700: 0x86, 5750: 0x87, 5800: 0x88, 5850: 0x89,
  5900: 0x8a, 5950: 0x8b, 6000: 0x8d, 6050: 0x8e, 6100: 0x8f, 6150: 0x90,
  6200: 0x91, 6250: 0x93, 6300: 0x94, 6350: 0x95, 6400: 0x96, 6450: 0x97,
  6500: 0x98, 6550: 0x9a, 6600: 0x9b, 6650: 0x9c, 6700: 0x9d, 6750: 0x9e,
  6800: 0x9f, 6850: 0xa1, 6900: 0xa2, 6950: 0xa3, 7000: 0xa4, 7050: 0xa5,
  7100: 0xa7, 7150: 0xa8, 7200: 0xa9, 7250: 0xaa, 7300: 0xab, 7350: 0xac,
  7400: 0xae, 7450: 0xaf, 7500: 0xb0, 7550: 0xb1, 7600: 0xb2, 7650: 0xb3,
  7700: 0xb5, 7750: 0xb6, 7800: 0xb7, 7850: 0xb8, 7900: 0xb9, 7950: 0xbb,
  8000: 0xbc, 8050: 0xbd, 8100: 0xbe, 8150: 0xbf, 8200: 0xc0, 8250: 0xc2,
  8300: 0xc3, 8350: 0xc4, 8400: 0xc5, 8450: 0xc6, 8500: 0xc7, 8550: 0xc9,
  8600: 0xca, 8650: 0xcb, 8700: 0xcc, 8750: 0xcd, 8800: 0xcf, 8850: 0xd0,
  8900: 0xd1, 8950: 0xd2, 9000: 0xd3, 9050: 0xd4, 9100: 0xd6, 9150: 0xd7,
  9200: 0xd8, 9250: 0xd9, 9300: 0xda, 9350: 0xdb, 9400: 0xdd, 9450: 0xde,
  9500: 0xdf, 9550: 0xe0, 9600: 0xe1, 9650: 0xe3, 9700: 0xe4, 9750: 0xe5,
  9800: 0xe6, 9850: 0xe7, 9900: 0xe8, 9950: 0xea, 10000: 0xeb,
  10100: 0x76, 10200: 0x77, 10300: 0x79, 10400: 0x7a, 10500: 0x7b, 10600: 0x7c,
  10700: 0x7d, 10800: 0x7f, 10900: 0x80, 11000: 0x81, 11100: 0x82, 11200: 0x83,
  11300: 0x84, 11400: 0x86, 11500: 0x87, 11600: 0x88, 11700: 0x89, 11800: 0x8a,
  11900: 0x8b, 12000: 0x8d,
  12100: 0x8e, 12200: 0x8f, 12300: 0x90, 12400: 0x91, 12500: 0x93, 12600: 0x94,
  12700: 0x95, 12800: 0x96, 12900: 0x97, 13000: 0x98, 13100: 0x9a, 13200: 0x9b,
  13300: 0x9c, 13400: 0x9d, 13500: 0x9e, 13600: 0x9f, 13700: 0xa1, 13800: 0xa2,
  13900: 0xa3, 14000: 0xa4, 14100: 0xa5, 14200: 0xa7, 14300: 0xa8, 14400: 0xa9,
  14500: 0xaa, 14600: 0xab, 14700: 0xac, 14800: 0xae, 14900: 0xaf, 15000: 0xb0,
  15100: 0xb1, 15200: 0xb2, 15300: 0xb3, 15400: 0xb5, 15500: 0xb6, 15600: 0xb7,
  15700: 0xb8, 15800: 0xb9, 15900: 0xbb, 16000: 0xbc, 16100: 0xbd, 16200: 0xbe,
  16300: 0xbf, 16400: 0xc0, 16500: 0xc2, 16600: 0xc3, 16700: 0xc4, 16800: 0xc5,
  16900: 0xc6, 17000: 0xc7, 17100: 0xc9, 17200: 0xca, 17300: 0xcb, 17400: 0xcc,
  17500: 0xcd, 17600: 0xcf, 17700: 0xd0, 17800: 0xd1, 17900: 0xd2, 18000: 0xd3,
  18100: 0xd4, 18200: 0xd6, 18300: 0xd7, 18400: 0xd8, 18500: 0xd9, 18600: 0xda,
  18700: 0xdb, 18800: 0xdd, 18900: 0xde, 19000: 0xdf, 19100: 0xe0, 19200: 0xe1,
  19300: 0xe3, 19400: 0xe4, 19500: 0xe5, 19600: 0xe6, 19700: 0xe7, 19800: 0xe8,
  19900: 0xea, 20000: 0xeb,
  20100: 0xeb, 20200: 0x76, 20300: 0x76, 20400: 0x77, 20500: 0x77, 20600: 0x79,
  20700: 0x79, 20800: 0x7a, 20900: 0x7a, 21000: 0x7b, 21100: 0x7b, 21200: 0x7c,
  21300: 0x7c, 21400: 0x7d, 21500: 0x7d, 21600: 0x7f, 21700: 0x7f, 21800: 0x80,
  21900: 0x80, 22000: 0x81,
};

const STEP_ENTRIES: ReadonlyArray<readonly [number, number]> = Object.entries(X11_DPI_STEP_MAP)
  .map(([dpi, byte]) => [Number(dpi), byte] as const)
  .sort((a, b) => a[0] - b[0]);

/** Nearest supported DPI at or above `dpi`, clamped to the sensor's range. */
export function nearestX11Dpi(dpi: number): number {
  const target = Math.min(X11_DPI_MAX, Math.max(X11_DPI_MIN, Math.round(dpi)));
  const match = STEP_ENTRIES.find(([value]) => value >= target);
  return match ? match[0] : X11_DPI_MAX;
}

/** Hardware byte for the nearest supported value. Throws only if unclamped. */
export function encodeX11DpiByte(dpi: number): number {
  const value = nearestX11Dpi(dpi);
  const byte = X11_DPI_STEP_MAP[value];
  if (byte === undefined) throw new Error(`Unsupported DPI: ${dpi}`);
  return byte;
}

function reverseRange(min: number, max: number): ReadonlyMap<number, number> {
  const table = new Map<number, number>();
  for (const [dpi, byte] of STEP_ENTRIES) {
    if (dpi < min || dpi > max) continue;
    // Above 12,000 the byte repeats across pages; keep the lower value so a
    // decode is deterministic (the exact page is unknown without more state).
    if (!table.has(byte)) table.set(byte, dpi);
  }
  return table;
}

const LOW_REVERSE = reverseRange(50, 10000);
const MID_REVERSE = reverseRange(10100, 12000);
const HIGH_REVERSE = reverseRange(12100, 20000);
const BOTH_REVERSE = reverseRange(20100, 22000);

export interface X11DpiConfig {
  /** Six numeric stage values, in stage order. */
  stages: readonly number[];
  /** 1-based active stage. */
  activeStage: number;
  angleSnap: boolean;
  rippleControl: boolean;
  /** Wired units take only the first 52 bytes. */
  wired?: boolean;
}

function checksum(buffer: Uint8Array): number {
  let sum = 0;
  for (let i = 3; i <= 49; i++) sum = (sum + buffer[i]) & 0xffff;
  return sum;
}

/**
 * Build the full report buffer including its leading report id byte. Callers
 * hand this to `sendFeatureReport(X11_DPI_REPORT_ID, buffer.subarray(1))`.
 */
export function buildX11DpiReport(config: X11DpiConfig): Uint8Array {
  const buffer = new Uint8Array(56);
  buffer[0] = X11_DPI_REPORT_ID;
  buffer[1] = 0x38;
  buffer[2] = 0x01;
  buffer[3] = config.angleSnap ? 0x01 : 0x00;
  buffer[4] = config.rippleControl ? 0x01 : 0x00;
  buffer[5] = 0x3f;

  let mask = 0;
  for (let i = 0; i < X11_DPI_STAGE_COUNT; i++) {
    const dpi = config.stages[i] ?? X11_DPI_DEFAULT_STAGES[i] ?? 800;
    buffer[8 + i] = encodeX11DpiByte(dpi);
    if (dpi > 12000) mask |= 0x01 << i;
    const high = (dpi >= 10100 && dpi <= 12000) || (dpi >= 20100 && dpi <= 22000);
    buffer[16 + i] = high ? 0x01 : 0x00;
  }
  buffer[6] = mask;
  buffer[7] = mask;
  // 14, 15, 22, 23 stay zero.
  buffer[24] = config.activeStage;

  buffer[25] = 0xff;
  buffer[29] = 0xff;
  buffer[33] = 0xff;
  buffer[34] = 0xff;
  buffer[35] = 0xff;
  buffer[38] = 0xff;
  buffer[39] = 0xff;
  buffer[40] = 0xff;
  buffer[42] = 0xff;
  buffer[43] = 0xff;
  buffer[44] = 0x40;
  buffer[46] = 0xff;
  buffer[47] = 0xff;
  buffer[48] = 0xff;
  buffer[49] = 0x02;

  const sum = checksum(buffer);
  buffer[50] = (sum >> 8) & 0xff;
  buffer[51] = sum & 0xff;

  return config.wired ? buffer.subarray(0, 52) : buffer;
}

/**
 * Decode a report read back from the device. Accepts either the raw feature
 * report (leading report id 0x04, as hidapi sees it) or the report-id-stripped
 * form some adapters return (`receiveFeatureReport` strips it), normalising to
 * the full layout. Returns null when the signature or checksum do not match.
 */
export function decodeX11DpiReport(data: Uint8Array): X11DpiConfig | null {
  let buffer = data;
  if (buffer.length >= 2 && buffer[0] === 0x38 && buffer[1] === 0x01) {
    const full = new Uint8Array(buffer.length + 1);
    full.set(buffer, 1);
    full[0] = X11_DPI_REPORT_ID;
    buffer = full;
  }
  if (buffer.length < 52) return null;
  if (buffer[0] !== X11_DPI_REPORT_ID || buffer[1] !== 0x38 || buffer[2] !== 0x01) return null;
  const expected = ((buffer[50] << 8) | buffer[51]) & 0xffff;
  if (checksum(buffer) !== expected) return null;

  const stages: number[] = [];
  for (let i = 0; i < X11_DPI_STAGE_COUNT; i++) {
    const byte = buffer[8 + i];
    const maskSet = ((buffer[6] >> i) & 0x01) === 1;
    const highSet = buffer[16 + i] === 0x01;
    const table = maskSet && highSet
      ? BOTH_REVERSE
      : maskSet
        ? HIGH_REVERSE
        : highSet
          ? MID_REVERSE
          : LOW_REVERSE;
    const dpi = table.get(byte) ?? LOW_REVERSE.get(byte);
    if (dpi === undefined) return null;
    stages.push(dpi);
  }

  const activeStage = Math.min(6, Math.max(1, buffer[24]));
  return {
    stages,
    activeStage,
    angleSnap: buffer[3] === 0x01,
    rippleControl: buffer[4] === 0x01,
  };
}
