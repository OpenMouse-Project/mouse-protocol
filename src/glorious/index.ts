/**
 * Pure encoding rules of the Glorious Model O 2 / I 2 family (Pixart firmware,
 * VID 0x093a). The configuration interface is write-only: the firmware accepts
 * a 256-byte settings payload assembled from four 64-byte feature reports
 * (report ID 0x03) on USB interface 1, but never echoes settings back.
 * Reverse-engineered layout: https://github.com/zeppybabe/gloriousctl-linux.
 */

export const GLORIOUS_CONFIG_REPORT_ID = 0x03;
export const GLORIOUS_PACKET_LENGTH = 64;

const SETTINGS_FRAGMENTS = 4;
const SETTINGS_CMD: readonly [number, number] = [0x04, 0xfb];

export const GLORIOUS_DPI_UNIT = 50;
export const GLORIOUS_DPI_MIN = 100;
export const GLORIOUS_DPI_MAX = 26000;

/** Payload byte [9]: 0x01(1k), 0x02(125), 0x03(250), 0x04(500). */
export const GLORIOUS_POLLING_RATES: ReadonlyArray<readonly [code: number, hertz: number]> = [
  [0x02, 125],
  [0x03, 250],
  [0x04, 500],
  [0x01, 1000],
];

/** Payload byte [7]: 0x01 (1 mm) or 0x02 (2 mm); 0.7 mm is not exposed. */
export const GLORIOUS_LOD_MEDIUM_MM = 1;
export const GLORIOUS_LOD_HIGH_MM = 2;

/** Payload byte [8]: debounce in milliseconds, even numbers, 0x00-0x10. */
export const GLORIOUS_DEBOUNCE_MAX_MS = 16;

export const GLORIOUS_MAX_STAGES = 6;

/** Lighting payload (cmd 02 fb) RGB effect ids ([5]). */
export const GLORIOUS_RGB_EFFECTS = {
  off: 0x00,
  glorious: 0x01,
  seamlessBreathing: 0x02,
  breathing: 0x03,
  normallyOn: 0x04,
  breathingSingle: 0x05,
  tail: 0x06,
  rave: 0x07,
  wave: 0x08,
} as const;

export type GloriousRgbEffectId = keyof typeof GLORIOUS_RGB_EFFECTS;

export const GLORIOUS_EFFECT_OPTIONS: ReadonlyArray<readonly [id: GloriousRgbEffectId, label: string]> = [
  ["glorious", "Glorious"],
  ["off", "LEDs off"],
  ["seamlessBreathing", "Seamless breathing"],
  ["breathing", "Breathing (rainbow)"],
  ["normallyOn", "Solid color"],
  ["breathingSingle", "Breathing (solid)"],
  ["tail", "Tail"],
  ["rave", "Rave"],
  ["wave", "Wave"],
];

/** Brightness ([6]/[7]) and speed ([9]) map onto five/four CORE levels. */
export const GLORIOUS_BRIGHTNESS_LEVELS: ReadonlyArray<number> = [0x00, 0x05, 0x0a, 0x0f, 0x14];
export const GLORIOUS_SPEED_LEVELS: ReadonlyArray<number> = [0x05, 0x0a, 0x0f, 0x14];

export interface GloriousLighting {
  /** One of GLORIOUS_RGB_EFFECTS values. */
  effect: number;
  brightnessWired: number;
  brightnessWireless: number;
  speed: number;
  /** "#rrggbb" strings: [0] primary plus up to six cycle colors. */
  colors: string[];
}

export const GLORIOUS_DEFAULT_LIGHTING: GloriousLighting = {
  effect: GLORIOUS_RGB_EFFECTS.glorious,
  brightnessWired: 0x14,
  brightnessWireless: 0x14,
  speed: 0x0a,
  colors: ["#ff0000", "#ff7f00", "#ffff00", "#00ff00", "#0000ff", "#4b0082", "#9400d3"],
};

const LIGHTING_CMD: readonly [number, number] = [0x02, 0xfb];
const LIGHTING_FRAGMENTS = 3;
const LIGHTING_MODIFIER = 0x14;

/** Number of palette slots an effect consumes ([8]): solid 1, rave 2, rainbow 7. */
export function gloriousLightingColorCount(effect: number): number {
  if (effect === GLORIOUS_RGB_EFFECTS.rave) return 2;
  if (effect === GLORIOUS_RGB_EFFECTS.off
    || effect === GLORIOUS_RGB_EFFECTS.normallyOn
    || effect === GLORIOUS_RGB_EFFECTS.breathingSingle) return 1;
  return 7;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
}

/**
 * Builds the three 64-byte feature-report fragments of the lighting payload:
 * fragment 0 carries effect, wireless/wired brightness, color count, speed,
 * modifier, and the primary color; fragment 1 echoes the effect and holds the
 * six-cycle palette; fragment 2 echoes the effect again.
 */
export function buildGloriousLightingPayload(lighting: GloriousLighting): Uint8Array<ArrayBuffer>[] {
  const fragments = Array.from({ length: LIGHTING_FRAGMENTS }, () => new Uint8Array(GLORIOUS_PACKET_LENGTH));
  fragments.forEach((fragment, index) => {
    fragment[0] = GLORIOUS_CONFIG_REPORT_ID;
    fragment[1] = LIGHTING_CMD[0];
    fragment[2] = LIGHTING_CMD[1];
    fragment[3] = index;
    fragment[4] = 0x01;
  });

  const first = fragments[0];
  first[5] = lighting.effect;
  first[6] = lighting.brightnessWireless;
  first[7] = lighting.brightnessWired;
  first[8] = gloriousLightingColorCount(lighting.effect);
  first[9] = lighting.speed;
  first[10] = LIGHTING_MODIFIER;
  first.set(hexToRgb(lighting.colors[0] ?? GLORIOUS_DEFAULT_LIGHTING.colors[0]), 11);

  const second = fragments[1];
  second[5] = lighting.effect;
  for (let index = 1; index <= 6; index += 1) {
    second.set(hexToRgb(lighting.colors[index] ?? "#000000"), 3 + index * 3);
  }

  fragments[2][5] = lighting.effect;
  return fragments;
}

/** Repairs untrusted persisted lighting state into a payload-safe object. */
export function gloriousNormalizeLighting(value: unknown): GloriousLighting {
  const parsed = typeof value === "object" && value !== null ? value as Partial<GloriousLighting> : {};
  const validEffects = new Set(Object.values(GLORIOUS_RGB_EFFECTS));
  const nearestLevel = (levels: ReadonlyArray<number>, candidate: unknown): number => {
    if (typeof candidate !== "number") return levels.at(-1)!;
    return levels.reduce((best, level) =>
      Math.abs(level - candidate) < Math.abs(best - candidate) ? level : best);
  };
  const colorPattern = /^#[0-9a-f]{6}$/i;
  return {
    effect: validEffects.has(Number(parsed.effect) as never) ? Number(parsed.effect) : GLORIOUS_DEFAULT_LIGHTING.effect,
    brightnessWired: nearestLevel(GLORIOUS_BRIGHTNESS_LEVELS, parsed.brightnessWired),
    brightnessWireless: nearestLevel(GLORIOUS_BRIGHTNESS_LEVELS, parsed.brightnessWireless),
    speed: nearestLevel(GLORIOUS_SPEED_LEVELS, parsed.speed),
    colors: GLORIOUS_DEFAULT_LIGHTING.colors.map((fallback, index) => {
      const stored = Array.isArray(parsed.colors) ? parsed.colors[index] : undefined;
      return typeof stored === "string" && colorPattern.test(stored) ? stored.toLowerCase() : fallback;
    }),
  };
}

export interface GloriousSettings {
  /** Zero-indexed active DPI stage ([5]). */
  activeStage: number;
  /** Enabled stages, 4-6 ([6]). */
  stageCount: number;
  /** Six DPI stage values; unused stages stay at 0. */
  stageDpis: number[];
  /** "#rrggbb" LED color shown while the DPI button cycles through a stage. */
  stageColors: string[];
  lodMm: number;
  debounceMs: number;
  pollingCode: number;
}

/** Factory per-stage indicator colors (red, blue, green, yellow), then unset. */
export const GLORIOUS_DEFAULT_STAGE_COLORS: ReadonlyArray<string> = [
  "#ff0000",
  "#0000ff",
  "#00ff00",
  "#ffff00",
  "#000000",
  "#000000",
];

export const GLORIOUS_DEFAULT_SETTINGS: GloriousSettings = {
  activeStage: 0,
  stageCount: 4,
  stageDpis: [400, 800, 1600, 3200, 0, 0],
  stageColors: [...GLORIOUS_DEFAULT_STAGE_COLORS],
  lodMm: GLORIOUS_LOD_MEDIUM_MM,
  debounceMs: 10,
  pollingCode: 0x01,
};

// Stage 1 lives in fragment 0 after the global bytes; stages 2-3 share
// fragment 1, stages 4-5 fragment 2, and stage 6 fragment 3.
const STAGE_OFFSETS: ReadonlyArray<readonly [fragment: number, offset: number]> = [
  [0, 11],
  [1, 5],
  [1, 10],
  [2, 5],
  [2, 10],
  [3, 5],
];

export function gloriousEncodeDpi(dpi: number): number {
  return Math.round(dpi / GLORIOUS_DPI_UNIT);
}

export function gloriousIsSupportedDpi(dpi: number): boolean {
  return Number.isInteger(dpi)
    && dpi >= GLORIOUS_DPI_MIN
    && dpi <= GLORIOUS_DPI_MAX
    && dpi % GLORIOUS_DPI_UNIT === 0;
}

export function gloriousEncodePolling(hertz: number): number | null {
  return GLORIOUS_POLLING_RATES.find(([, value]) => value === hertz)?.[0] ?? null;
}

export function gloriousDecodePolling(code: number): number | null {
  return GLORIOUS_POLLING_RATES.find(([value]) => value === code)?.[1] ?? null;
}

export function gloriousSanitizeDebounce(milliseconds: number): number {
  const clamped = Math.min(Math.max(Math.round(milliseconds), 0), GLORIOUS_DEBOUNCE_MAX_MS);
  return clamped % 2 === 0 ? clamped : clamped - 1;
}

/**
 * Builds the four 64-byte feature-report fragments of the settings payload:
 * header (report ID 0x03, cmd 04 fb, sequence, pad 0x01), then the global
 * bytes ([5] active stage, [6] total stages, [7] LOD, [8] debounce, [9]
 * polling) followed by little-endian DPI u16 divided by 50 plus RGB per stage.
 */
export function buildGloriousSettingsPayload(settings: GloriousSettings): Uint8Array<ArrayBuffer>[] {
  const fragments = Array.from({ length: SETTINGS_FRAGMENTS }, () => new Uint8Array(GLORIOUS_PACKET_LENGTH));
  fragments.forEach((fragment, index) => {
    fragment[0] = GLORIOUS_CONFIG_REPORT_ID;
    fragment[1] = SETTINGS_CMD[0];
    fragment[2] = SETTINGS_CMD[1];
    fragment[3] = index;
    fragment[4] = 0x01;
  });

  const first = fragments[0];
  first[5] = settings.activeStage;
  first[6] = settings.stageCount;
  first[7] = settings.lodMm;
  first[8] = settings.debounceMs;
  first[9] = settings.pollingCode;
  first[10] = 0x00;

  STAGE_OFFSETS.forEach(([fragmentIndex, offset], stageIndex) => {
    const encoded = gloriousEncodeDpi(settings.stageDpis[stageIndex] ?? 0);
    const fragment = fragments[fragmentIndex];
    fragment[offset] = encoded & 0xff;
    fragment[offset + 1] = encoded >> 8 & 0xff;
    fragment.set(hexToRgb(settings.stageColors?.[stageIndex] ?? GLORIOUS_DEFAULT_STAGE_COLORS[stageIndex]), offset + 2);
  });
  return fragments;
}

/** Repairs untrusted persisted state into a payload-safe settings object. */
export function gloriousNormalizeSettings(value: unknown): GloriousSettings {
  const parsed = typeof value === "object" && value !== null ? value as Partial<GloriousSettings> : {};
  const stageDpis = GLORIOUS_DEFAULT_SETTINGS.stageDpis.map((fallback, index) => {
    const stored = Array.isArray(parsed.stageDpis) ? parsed.stageDpis[index] : undefined;
    return typeof stored === "number" && gloriousIsSupportedDpi(stored) ? stored : fallback;
  });
  const pollingCode = Number(parsed.pollingCode);
  const colorPattern = /^#[0-9a-f]{6}$/i;
  return {
    activeStage: sanitizeIndex(parsed.activeStage),
    stageCount: Math.min(
      Math.max(sanitizeIndex(parsed.stageCount, GLORIOUS_MAX_STAGES), GLORIOUS_DEFAULT_SETTINGS.stageCount),
      GLORIOUS_MAX_STAGES),
    stageDpis,
    stageColors: GLORIOUS_DEFAULT_STAGE_COLORS.map((fallback, index) => {
      const stored = Array.isArray(parsed.stageColors) ? parsed.stageColors[index] : undefined;
      return typeof stored === "string" && colorPattern.test(stored) ? stored.toLowerCase() : fallback;
    }),
    lodMm: parsed.lodMm === GLORIOUS_LOD_HIGH_MM ? GLORIOUS_LOD_HIGH_MM : GLORIOUS_LOD_MEDIUM_MM,
    debounceMs: gloriousSanitizeDebounce(
      typeof parsed.debounceMs === "number" ? parsed.debounceMs : GLORIOUS_DEFAULT_SETTINGS.debounceMs),
    pollingCode: gloriousDecodePolling(pollingCode) ? pollingCode : GLORIOUS_DEFAULT_SETTINGS.pollingCode,
  };
}

function sanitizeIndex(value: unknown, max = GLORIOUS_MAX_STAGES - 1): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : 0;
}
