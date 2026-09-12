export const ASUS_VENDOR_ID = 0x0b05;

export const ROG_GLADIUS_II_PRODUCT_ID = 0x1845;

export const ASUS_GLADIUS_II_USAGE_PAGE = 0xff01;
export const ASUS_GLADIUS_II_USAGE = 0x0001;

export const ASUS_REPORT_ID = 0;
export const ASUS_REPORT_SIZE = 64;

export const GLADIUS_II_MIN_DPI = 100;
export const GLADIUS_II_MAX_DPI = 12000;
export const GLADIUS_II_DPI_STEP = 100;

export const GLADIUS_II_POLLING_RATES = [
  125,
  250,
  500,
  1000,
] as const;

export interface GladiusIISettings {
  dpiStages: [number, number];
  pollingRateHz: number;
  debounceMs: number | null;
  angleSnapping: boolean;
}

export interface GladiusIIProfile {
  onboardProfile: number;
  activeDpiStage: number;
}

function requirePrefix(
  data: Uint8Array,
  expected: readonly number[],
  name: string,
): void {
  if (data.length < expected.length) {
    throw new Error(`${name} reply is too short.`);
  }

  for (let i = 0; i < expected.length; i++) {
    if (data[i] !== expected[i]) {
      throw new Error(
        `${name} reply has unexpected byte ${i}: ` +
        `0x${data[i]?.toString(16).padStart(2, "0")}`,
      );
    }
  }
}

function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function decodeDpiWord(value: number): number {
  return (value + 1) * GLADIUS_II_DPI_STEP;
}

/**
 * WebHID payload:
 *
 * 12 04 00 00
 * [DPI1 lo hi]
 * [DPI2 lo hi]
 * [poll]
 * 00
 * [debounce]
 * 00
 * [angle snap]
 */
export function decodeGladiusIISettings(
  data: Uint8Array,
): GladiusIISettings {
  requirePrefix(data, [0x12, 0x04, 0x00], "Gladius II settings");

  if (data.length < 13) {
    throw new Error("Gladius II settings reply is incomplete.");
  }

  const dpi1 = decodeDpiWord(readUint16LE(data, 4));
  const dpi2 = decodeDpiWord(readUint16LE(data, 6));

  const pollingRaw = data[8];

  const pollingRateHz = GLADIUS_II_POLLING_RATES[pollingRaw];

  if (pollingRateHz === undefined) {
    throw new Error(
      `Unknown Gladius II polling value 0x${pollingRaw
        .toString(16)
        .padStart(2, "0")}.`,
    );
  }

  const debounceRaw = data[10];

  // ASUS values 0x02..0x07 map to:
  // 12, 16, 20, 24, 28, 32 ms.
  const debounceMs =
    debounceRaw >= 0x02 && debounceRaw <= 0x07
      ? debounceRaw * 4 + 4
      : null;

  return {
    dpiStages: [dpi1, dpi2],
    pollingRateHz,
    debounceMs,
    angleSnapping: data[12] === 0x01,
  };
}

/**
 * WebHID payload:
 *
 * 12 00 00 ...
 *
 * G-Helper's packet indices include the HID report-id byte.
 * WebHID removes that byte, therefore:
 *
 * packet[11] -> data[10] = onboard profile
 * packet[12] -> data[11] = active DPI stage (1-based)
 */
export function decodeGladiusIIProfile(
  data: Uint8Array,
): GladiusIIProfile {
  requirePrefix(data, [0x12, 0x00, 0x00], "Gladius II profile");

  if (data.length < 12) {
    throw new Error("Gladius II profile reply is incomplete.");
  }

  const onboardProfileRaw = data[10];
  const dpiStageRaw = data[11];

  if (dpiStageRaw < 1 || dpiStageRaw > 2) {
    throw new Error(
      `Invalid Gladius II DPI stage ${dpiStageRaw}.`,
    );
  }

  return {
    // ASUS profile is zero-based.
    onboardProfile: onboardProfileRaw + 1,

    // OpenMouse DPI stage is zero-based.
    activeDpiStage: dpiStageRaw - 1,
  };
}

function request(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(ASUS_REPORT_SIZE);
  data.set(bytes);
  return data;
}

export function gladiusIISetDpiRequest(
  stage: number,
  dpi: number,
): Uint8Array {
  if (!Number.isInteger(stage) || stage < 0 || stage > 1) {
    throw new Error("Gladius II DPI stage must be 0 or 1.");
  }

  if (
    !Number.isInteger(dpi) ||
    dpi < GLADIUS_II_MIN_DPI ||
    dpi > GLADIUS_II_MAX_DPI ||
    dpi % GLADIUS_II_DPI_STEP !== 0
  ) {
    throw new Error(
      `Gladius II DPI must be ${GLADIUS_II_MIN_DPI}-${GLADIUS_II_MAX_DPI} in ${GLADIUS_II_DPI_STEP}-DPI steps.`,
    );
  }

  const encoded =
    (dpi - GLADIUS_II_DPI_STEP) /
    GLADIUS_II_DPI_STEP;

  return request(
    0x51,
    0x31,
    stage,
    0x00,
    encoded & 0xff,
    (encoded >> 8) & 0xff,
  );
}

export function gladiusIISetPollingRateRequest(
  pollingRateHz: number,
): Uint8Array {
  const rateIndex = GLADIUS_II_POLLING_RATES.findIndex(
    (rate) => rate === pollingRateHz,
  );

  if (rateIndex === -1) {
    throw new Error(
      `Unsupported Gladius II polling rate: ${pollingRateHz} Hz.`,
    );
  }

  return request(
    0x51,
    0x31,
    0x02,
    0x00,
    rateIndex,
  );
}

export function gladiusIISaveRequest(): Uint8Array {
  return request(0x50, 0x03);
}

export function gladiusIIReadSettingsRequest(): Uint8Array {
  return request(0x12, 0x04, 0x00);
}

export function gladiusIIReadProfileRequest(): Uint8Array {
  return request(0x12, 0x00);
}