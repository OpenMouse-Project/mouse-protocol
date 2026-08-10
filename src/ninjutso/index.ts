/** Public protocol constants used by NinjaForce's shipped WebHID client. */
export const NINJUTSO_LEGACY_VENDOR_ID = 0x1915;
export const NINJUTSO_VENDOR_ID = 0x093a;

export const NINJUTSO_LEGACY_MOUSE_PRODUCT_IDS = [
  0xae11, 0xae12, 0xae13, 0xae14, 0xae15, 0xae16,
] as const;
export const NINJUTSO_LEGACY_RECEIVER_PRODUCT_IDS = [0xae1c, 0xae8c, 0xae8a] as const;
export const NINJUTSO_MOUSE_PRODUCT_IDS = [0xe020, 0xe010, 0xea01] as const;
export const NINJUTSO_RECEIVER_PRODUCT_IDS = [0xeb01, 0xeb02] as const;

export interface NinjutsoDeviceDefinition {
  name: string;
  receiver: boolean;
  protocol: "legacy" | "current";
  /** False until this OpenMouse implementation is exercised on physical hardware. */
  verified: boolean;
}

export const NINJUTSO_DEVICES: ReadonlyMap<string, NinjutsoDeviceDefinition> = new Map<string, NinjutsoDeviceDefinition>([
  ...NINJUTSO_LEGACY_MOUSE_PRODUCT_IDS.map((productId) => [
    `${NINJUTSO_LEGACY_VENDOR_ID}:${productId}`,
    { name: "Ninjutso Sora V2", receiver: false, protocol: "legacy", verified: false },
  ] as const),
  ...NINJUTSO_LEGACY_RECEIVER_PRODUCT_IDS.map((productId) => [
    `${NINJUTSO_LEGACY_VENDOR_ID}:${productId}`,
    { name: "Ninjutso Sora V2 receiver", receiver: true, protocol: "legacy", verified: false },
  ] as const),
  [`${NINJUTSO_VENDOR_ID}:${0xe010}`, { name: "Ninjutso Sora V3", receiver: false, protocol: "current", verified: false }],
  [`${NINJUTSO_VENDOR_ID}:${0xeb02}`, { name: "Ninjutso Sora V3 receiver", receiver: true, protocol: "current", verified: false }],
  [`${NINJUTSO_VENDOR_ID}:${0xe020}`, { name: "Ninjutso TEN / TEN AIR", receiver: false, protocol: "current", verified: false }],
  [`${NINJUTSO_VENDOR_ID}:${0xea01}`, { name: "Ninjutso TEN / TEN AIR", receiver: false, protocol: "current", verified: false }],
  [`${NINJUTSO_VENDOR_ID}:${0xeb01}`, { name: "Ninjutso TEN / TEN AIR receiver", receiver: true, protocol: "current", verified: false }],
]);

export const NINJUTSO_LEGACY_REPORT_ID = 5;
export const NINJUTSO_LEGACY_PAYLOAD_LENGTH = 31;
export const NINJUTSO_REPORT_ID = 6;
export const NINJUTSO_PAYLOAD_LENGTH = 15;
export const NINJUTSO_CONTROL_REPORT_ID = 3;
export const NINJUTSO_CONTROL_PAYLOAD_LENGTH = 63;

export const NINJUTSO_COMMAND = {
  batteryCharging: 17,
  batteryPercent: 18,
  online: 19,
  firmware: 21,
  profile: 16,
  activeDpiStage: 28,
  dpiStageCount: 30,
  dpi: 4,
  pollingRate: 6,
  liftOffDistance: 8,
  angleTuning: 10,
  motionSync: 14,
  systemMode: 12,
  hyperClick: 23,
  slamClick: 42,
  opticalEngine: 50,
  sleepMinutes: 25,
  lightingMode: 32,
  lightingColor: 34,
  lightingState: 38,
  lightingSpeed: 40,
  lightingBrightness: 48,
  pairedProductId: 167,
  setDpi: 3,
  setActiveDpiStage: 27,
  setDpiStageCount: 29,
  setPollingRate: 5,
  setLiftOffDistance: 7,
  setAngleTuning: 9,
  setMotionSync: 13,
  setSystemMode: 11,
  setHyperClick: 22,
  setSlamClick: 41,
  setOpticalEngine: 49,
  setSleepMinutes: 24,
  setLightingMode: 31,
  setLightingColor: 33,
  setLightingState: 37,
  setLightingSpeed: 39,
  setLightingBrightness: 47,
} as const;

export const NINJUTSO_POLLING_RATES = [1000, 2000, 4000, 8000] as const;

export function ninjutsoBuildRequest(command: number, profile = 0, args: readonly number[] = []): Uint8Array {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) throw new Error("Ninjutso command must be one byte.");
  if (!Number.isInteger(profile) || profile < 0 || profile > 0xff) throw new Error("Ninjutso profile must be one byte.");
  if (args.length > 8 || args.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
    throw new Error("Ninjutso command arguments must be at most eight bytes.");
  }
  const payload = new Uint8Array(NINJUTSO_PAYLOAD_LENGTH);
  payload.set([command, 0, 0, 1, 0, args.length, profile, ...args]);
  return payload;
}

export function ninjutsoResponseValue(response: DataView | Uint8Array, command: number): Uint8Array | null {
  const bytes = response instanceof Uint8Array
    ? response
    : new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
  if (bytes.length < 9 || bytes[1] !== command) return null;
  return bytes.slice(8);
}

export function ninjutsoEncodePollingRate(rate: number): number {
  const index = NINJUTSO_POLLING_RATES.indexOf(rate as (typeof NINJUTSO_POLLING_RATES)[number]);
  if (index < 0) throw new Error("Ninjutso polling rate must be 1000, 2000, 4000, or 8000 Hz.");
  return index + 1;
}

export function ninjutsoDecodePollingRate(code: number): number | null {
  return NINJUTSO_POLLING_RATES[code - 1] ?? null;
}

export function ninjutsoEncodeDpi(dpi: number, direct: boolean): [number, number, number] {
  const max = direct ? 45_000 : 30_000;
  const step = direct ? 1 : 50;
  if (!Number.isInteger(dpi) || dpi < (direct ? 1 : 50) || dpi > max || dpi % step !== 0) {
    throw new Error(`Ninjutso DPI must be ${direct ? "1–45,000" : "50–30,000 in 50 DPI steps"}.`);
  }
  const encoded = direct ? dpi : dpi / 50 - 1;
  return [encoded & 0xff, (encoded >> 8) & 0xff, 0];
}

export function ninjutsoDecodeDpi(low: number, high: number, tenth: number, direct: boolean): number {
  const encoded = (high << 8) | low;
  return direct ? encoded + tenth / 10 : (encoded + 1) * 50;
}

export function ninjutsoLegacyRequest(command: number, profile = 0, value?: number): Uint8Array {
  const payload = new Uint8Array(NINJUTSO_LEGACY_PAYLOAD_LENGTH);
  payload.set([command, 0, 0, 1, 0, profile, 22]);
  if (value !== undefined) payload[8] = value & 0xff;
  return payload;
}

export function ninjutsoLegacyEncodeDpi(dpi: number): [number, number] {
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 30_000 || dpi % 50 !== 0) {
    throw new Error("Sora V2 DPI must be 50–30,000 in 50 DPI steps.");
  }
  const encoded = dpi / 50 - 1;
  return [encoded & 0xff, (encoded >> 8) & 0xff];
}

export function ninjutsoLegacyDecodeDpi(low: number, high: number): number {
  return (((high & 0xff) << 8) | (low & 0xff)) * 50 + 50;
}
