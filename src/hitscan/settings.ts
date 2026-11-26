/** Semantic settings recovered from Hitscan Utility 1.0.2; not hardware verified. */
export const HITSCAN_SETTING_ADDRESS = {
  pollingRate: 0x00,
  dpiStageCount: 0x02,
  activeDpiStage: 0x04,
  liftOffDistance: 0x0a,
  debounce: 0xa9,
  motionSync: 0xab,
  angleSnapping: 0xaf,
  rippleControl: 0xb1,
  autoSleep: 0xb5,
  sleepSelection: 0xb7,
  sensorMode: 0xb9,
} as const;

export const HITSCAN_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
export type HitscanPollingRate = typeof HITSCAN_POLLING_RATES[number];
const pollingCodes = [8, 4, 2, 1, 16, 32, 64] as const;

/** Rate availability still depends on the selected mouse and receiver. */
export function hitscanEncodePollingRate(hz: number): number {
  const index = HITSCAN_POLLING_RATES.findIndex(rate => rate === hz);
  if (index < 0) throw new RangeError("Unsupported Hitscan polling rate.");
  return pollingCodes[index]!;
}

export function hitscanDecodePollingRate(value: number): HitscanPollingRate | null {
  const index = pollingCodes.findIndex(code => code === value);
  return index < 0 ? null : HITSCAN_POLLING_RATES[index]!;
}

/**
 * Both shipped model definitions select 3395, DPIRange
 * "50,4050,50,4100,26000,50,0x11". App function 0x14000EC70 uses
 * 50-unit encoding through 4050 and 100-unit encoding above it.
 * A request such as 4150 therefore quantizes to 4100, matching the app.
 * Returns a checksummed flash record and the actual representable DPI so the
 * caller can display the result of quantization explicitly.
 */
export function hitscanEncode3395Dpi(dpi: number): { record: Uint8Array<ArrayBuffer>; effectiveDpi: number } {
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 26000 || dpi % 50 !== 0) {
    throw new RangeError("Hitscan 3395 DPI must be 50..26000 in steps of 50.");
  }
  const scale = dpi > 4050 ? 2 : 1;
  const encoded = Math.trunc(dpi / (scale * 50)) - 1;
  const flags = (scale === 2 ? 0x11 : 0) | ((encoded >> 8) * 0x44);
  const low = encoded & 255;
  return { record: Uint8Array.of(low, low, flags, (0x55 - low * 2 - flags) & 255),
    effectiveDpi: (encoded + 1) * scale * 50 };
}

/** Exact equal-axis DPI values expressible by the two shipped model profiles. */
export const HITSCAN_3395_DPI_VALUES: readonly number[] = Object.freeze([
  ...Array.from({ length: 81 }, (_, index) => (index + 1) * 50),
  ...Array.from({ length: 220 }, (_, index) => 4100 + index * 100),
]);

/**
 * Decode canonical equal-axis records produced by the shipped model encoder.
 * Unknown flags, unequal axes, and out-of-range records remain unrecognized.
 */
export function hitscanDecode3395Dpi(bytes: Uint8Array | readonly number[]): number | null {
  if ((bytes.length !== 3 && bytes.length !== 4)
      || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  if (bytes.length === 4 && ((bytes[0]! + bytes[1]! + bytes[2]! + bytes[3]!) & 255) !== 0x55) return null;
  const [x, y, flags] = bytes;
  if (x !== y || (flags !== 0 && flags !== 0x11 && flags !== 0x55)) return null;
  const encoded = x! + ((flags & 4) !== 0 ? 256 : 0);
  const dpi = (encoded + 1) * ((flags & 1) !== 0 ? 100 : 50);
  if (dpi < 50 || dpi > 26000) return null;
  const canonical = hitscanEncode3395Dpi(dpi).record;
  return canonical.subarray(0, 3).every((byte, index) => byte === bytes[index]) ? dpi : null;
}

/** Exact dropdown-index mapping; physical duration units remain unverified. */
export const HITSCAN_SLEEP_SELECTION_VALUES = [3, 6, 30, 60, 90, 120, 150, 180, 210, 240] as const;

/** Menu handlers write 0..8 ms; see HID-SETTINGS.md. Spinbox variants are not modelled. */
export const HITSCAN_DEBOUNCE_MAX_MS = 8;

/**
 * LOD is stored as the combo index + 1. The variant widget names its two
 * buttons `mm1Button`/`mm2Button`, so code 1 is 1 mm and code 2 is 2 mm.
 */
export const HITSCAN_LIFT_OFF_MILLIMETRES = [1, 2] as const;

export function hitscanDecodeLiftOff(code: number): 1 | 2 | null {
  return code === 1 || code === 2 ? code : null;
}

/**
 * The `SensorRate` widget offers 125..4000 Hz; `SensorRateB` adds 8000 Hz.
 * Only the 8K receiver is assumed to use the latter.
 */
export function hitscanPollingRatesFor(transport: "wired" | "receiver" | "8k-receiver"): readonly HitscanPollingRate[] {
  return transport === "8k-receiver" ? HITSCAN_POLLING_RATES : HITSCAN_POLLING_RATES.slice(0, 6);
}
