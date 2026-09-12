export const ASUS_VENDOR_ID = 0x0b05;

export const ROG_GLADIUS_II_PRODUCT_ID = 0x1845;

export const ASUS_GLADIUS_II_USAGE_PAGE = 0xff01;
export const ASUS_GLADIUS_II_USAGE = 0x0001;

export const ASUS_REPORT_ID = 0;
export const ASUS_REPORT_SIZE = 64;

export const GLADIUS_II_MIN_DPI = 100;
export const GLADIUS_II_MAX_DPI = 12000;
export const GLADIUS_II_DPI_STEP = 100;

export const GLADIUS_II_PROFILE_COUNT = 3;

export const GLADIUS_II_POLLING_RATES = [
  125,
  250,
  500,
  1000,
] as const;

export const GLADIUS_II_DEBOUNCE_MS = [
  12,
  16,
  20,
  24,
  28,
  32,
] as const;

export type GladiusIILiftOffDistance =
  | "Low"
  | "High";

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

export interface GladiusIIRawLightingZone {
  zone: number;
  mode: number;
  brightness: number;
  red: number;
  green: number;
  blue: number;
  direction: number;
  randomColor: boolean;
  speed: number;
}

function requirePrefix(
  data: Uint8Array,
  expected: readonly number[],
  name: string,
): void {
  if (data.length < expected.length) {
    throw new Error(
      `${name} reply is too short.`,
    );
  }

  for (
    let i = 0;
    i < expected.length;
    i++
  ) {
    if (data[i] !== expected[i]) {
      throw new Error(
        `${name} reply has unexpected byte ${i}: ` +
          `0x${data[i]
            ?.toString(16)
            .padStart(2, "0")}`,
      );
    }
  }
}

function readUint16LE(
  data: Uint8Array,
  offset: number,
): number {
  return (
    data[offset] |
    (data[offset + 1] << 8)
  );
}

function decodeDpiWord(
  value: number,
): number {
  return (
    (value + 1) *
    GLADIUS_II_DPI_STEP
  );
}

function request(
  ...bytes: number[]
): Uint8Array {
  const data = new Uint8Array(
    ASUS_REPORT_SIZE,
  );

  data.set(bytes);

  return data;
}

/* ---------------------------------
 * READ DECODERS
 * --------------------------------- */

export function decodeGladiusIISettings(
  data: Uint8Array,
): GladiusIISettings {
  requirePrefix(
    data,
    [0x12, 0x04, 0x00],
    "Gladius II settings",
  );

  if (data.length < 13) {
    throw new Error(
      "Gladius II settings reply is incomplete.",
    );
  }

  const dpi1 = decodeDpiWord(
    readUint16LE(data, 4),
  );

  const dpi2 = decodeDpiWord(
    readUint16LE(data, 6),
  );

  const pollingRaw = data[8];

  const pollingRateHz =
    GLADIUS_II_POLLING_RATES[
      pollingRaw
    ];

  if (
    pollingRateHz === undefined
  ) {
    throw new Error(
      `Unknown Gladius II polling value 0x${pollingRaw
        .toString(16)
        .padStart(2, "0")}.`,
    );
  }

  const debounceRaw =
    data[10];

  const debounceMs =
    debounceRaw >= 0x02 &&
    debounceRaw <= 0x07
      ? debounceRaw * 4 + 4
      : null;

  return {
    dpiStages: [dpi1, dpi2],
    pollingRateHz,
    debounceMs,
    angleSnapping:
      data[12] === 0x01,
  };
}

export function decodeGladiusIIProfile(
  data: Uint8Array,
): GladiusIIProfile {
  requirePrefix(
    data,
    [0x12, 0x00, 0x00],
    "Gladius II profile",
  );

  if (data.length < 12) {
    throw new Error(
      "Gladius II profile reply is incomplete.",
    );
  }

  const onboardProfileRaw =
    data[10];

  const dpiStageRaw =
    data[11];

  if (
    dpiStageRaw < 1 ||
    dpiStageRaw > 2
  ) {
    throw new Error(
      `Invalid Gladius II DPI stage ${dpiStageRaw}.`,
    );
  }

  return {
    onboardProfile:
      onboardProfileRaw + 1,

    activeDpiStage:
      dpiStageRaw - 1,
  };
}

export function decodeGladiusIILiftOffDistance(
  data: Uint8Array,
): GladiusIILiftOffDistance {
  requirePrefix(
    data,
    [0x12, 0x06],
    "Gladius II lift-off",
  );

  if (data.length < 8) {
    throw new Error(
      "Gladius II lift-off reply is incomplete.",
    );
  }

  const raw = data[7];

  if (raw === 0) {
    return "Low";
  }

  if (raw === 1) {
    return "High";
  }

  throw new Error(
    `Unknown Gladius II lift-off value ${raw}.`,
  );
}

export function decodeGladiusIILighting(
  data: Uint8Array,
): GladiusIIRawLightingZone[] {
  requirePrefix(
    data,
    [0x12, 0x03, 0x00],
    "Gladius II lighting",
  );

  if (data.length < 23) {
    throw new Error(
      "Gladius II lighting reply is incomplete.",
    );
  }

  const direction = data[20];
  const randomColor =
    data[21] === 0x01;
  const speed = data[22];

  const zones: GladiusIIRawLightingZone[] =
    [];

  for (let zone = 0; zone < 3; zone++) {
    const offset =
      4 + zone * 5;

    zones.push({
      zone,
      mode: data[offset],
      brightness:
        data[offset + 1],
      red: data[offset + 2],
      green: data[offset + 3],
      blue: data[offset + 4],
      direction,
      randomColor,
      speed,
    });
  }

  return zones;
}

/* ---------------------------------
 * READ REQUESTS
 * --------------------------------- */

export function gladiusIIReadSettingsRequest(): Uint8Array {
  return request(
    0x12,
    0x04,
    0x00,
  );
}

export function gladiusIIReadProfileRequest(): Uint8Array {
  return request(
    0x12,
    0x00,
  );
}

export function gladiusIIReadLiftOffRequest(): Uint8Array {
  return request(
    0x12,
    0x06,
  );
}

export function gladiusIIReadLightingRequest(): Uint8Array {
  return request(
    0x12,
    0x03,
    0x00,
  );
}

/* ---------------------------------
 * DPI
 * --------------------------------- */

export function gladiusIISetDpiRequest(
  stage: number,
  dpi: number,
): Uint8Array {
  if (
    !Number.isInteger(stage) ||
    stage < 0 ||
    stage > 1
  ) {
    throw new Error(
      "Gladius II DPI stage must be 0 or 1.",
    );
  }

  if (
    !Number.isInteger(dpi) ||
    dpi < GLADIUS_II_MIN_DPI ||
    dpi > GLADIUS_II_MAX_DPI ||
    dpi %
      GLADIUS_II_DPI_STEP !==
      0
  ) {
    throw new Error(
      `Gladius II DPI must be ${GLADIUS_II_MIN_DPI}-${GLADIUS_II_MAX_DPI} in ${GLADIUS_II_DPI_STEP}-DPI steps.`,
    );
  }

  const encoded =
    (dpi -
      GLADIUS_II_DPI_STEP) /
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

export function gladiusIISetActiveDpiStageRequest(
  stage: number,
): Uint8Array {
  if (
    !Number.isInteger(stage) ||
    stage < 0 ||
    stage > 1
  ) {
    throw new Error(
      "Gladius II DPI stage must be 0 or 1.",
    );
  }

  return request(
    0x51,
    0x31,
    0x09,
    0x00,
    stage + 1,
  );
}

/* ---------------------------------
 * POLLING
 * --------------------------------- */

export function gladiusIISetPollingRateRequest(
  pollingRateHz: number,
): Uint8Array {
  const rateIndex =
    GLADIUS_II_POLLING_RATES.findIndex(
      (rate) =>
        rate === pollingRateHz,
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

/* ---------------------------------
 * ONBOARD PROFILE
 * --------------------------------- */

export function gladiusIISetProfileRequest(
  profile: number,
): Uint8Array {
  if (
    !Number.isInteger(profile) ||
    profile < 1 ||
    profile >
      GLADIUS_II_PROFILE_COUNT
  ) {
    throw new Error(
      `Gladius II profile must be 1-${GLADIUS_II_PROFILE_COUNT}.`,
    );
  }

  return request(
    0x50,
    0x02,
    profile - 1,
  );
}

/* ---------------------------------
 * ANGLE SNAPPING
 * --------------------------------- */

export function gladiusIISetAngleSnappingRequest(
  enabled: boolean,
): Uint8Array {
  return request(
    0x51,
    0x31,
    0x04,
    0x00,
    enabled ? 0x01 : 0x00,
  );
}

/* ---------------------------------
 * DEBOUNCE
 * --------------------------------- */

export function gladiusIISetDebounceRequest(
  milliseconds: number,
): Uint8Array {
  if (
    !GLADIUS_II_DEBOUNCE_MS.some(
      (value) =>
        value === milliseconds,
    )
  ) {
    throw new Error(
      `Gladius II debounce must be one of: ${GLADIUS_II_DEBOUNCE_MS.join(", ")} ms.`,
    );
  }

  const raw =
    milliseconds / 4 - 1;

  return request(
    0x51,
    0x31,
    0x03,
    0x00,
    raw,
  );
}

/* ---------------------------------
 * LIFT-OFF DISTANCE
 * --------------------------------- */

export function gladiusIISetLiftOffRequest(
  value: GladiusIILiftOffDistance,
): Uint8Array {
  const raw =
    value === "High"
      ? 1
      : 0;

  return request(
    0x51,
    0x35,
    0xff,
    0x00,
    0xff,
    raw,
  );
}

/* ---------------------------------
 * RGB
 * --------------------------------- */

export function gladiusIISetLightingRequest(
  zone: number,
  mode: number,
  brightness: number,
  red: number,
  green: number,
  blue: number,
  direction = 0,
  randomColor = 0,
  speed = 0,
): Uint8Array {
  if (
    !Number.isInteger(zone) ||
    zone < 0 ||
    zone > 2
  ) {
    throw new Error(
      "Gladius II RGB zone must be 0, 1, or 2.",
    );
  }

  if (
    brightness < 0 ||
    brightness > 4
  ) {
    throw new Error(
      "Gladius II RGB brightness must be 0-4.",
    );
  }

  return request(
    0x51,
    0x28,
    zone,
    0x00,
    mode,
    brightness,
    red,
    green,
    blue,
    direction,
    randomColor,
    speed,
  );
}

/* ---------------------------------
 * SAVE
 * --------------------------------- */

export function gladiusIISaveRequest(): Uint8Array {
  return request(
    0x50,
    0x03,
  );
}