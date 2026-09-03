/**
 * Pure encoding rules for Glorious's "classic" HID feature-report protocol,
 * used by the pre-Pixart Model O / Model D / Model I lines (VIDs 0x258a,
 * 0x22d4, 0x320f, 0x3794) — the same wire format the official Windows
 * software, and community tools glorious-ctl and mxw, use. Distinct from the
 * Pixart Model O 2 / I 2 protocol in ../glorious/index.ts, which is
 * write-only in a different way and has a different report layout.
 *
 * RGB, debounce, and battery are reverse-engineered from
 * https://github.com/louis4craft/glorious-ctl (mouse.py). DPI, polling rate,
 * and lift-off distance are reverse-engineered from
 * https://github.com/korkje/mxw (Rust; src/config/*.rs). Neither tool reads
 * DPI/polling/LOD back from the mouse — both are write-only for those three,
 * so this module is too; the driver keeps its own cache of the last-applied
 * values (see ../drivers/glorious/classic-hid.ts).
 *
 * Reports are unnumbered 64-byte feature reports (report id 0). Both source
 * tools build a 65-byte buffer with byte [0] as the hidapi report-id slot
 * (always 0) followed by the 64-byte body; WebHID takes the report id
 * separately, so every offset below is the source's buffer index minus 1.
 * `bfr()` documents that shift at each call site with the source's own index.
 */

export const GLORIOUS_CLASSIC_REPORT_ID = 0;
export const GLORIOUS_CLASSIC_PACKET_LENGTH = 64;

export const GLORIOUS_CLASSIC_PROFILE_DEFAULT = 1;
export const GLORIOUS_CLASSIC_DEBOUNCE_MAX_MS = 32;

function packet(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(GLORIOUS_CLASSIC_PACKET_LENGTH);
}

/**
 * Sets `body[bufferIndex - 1]`, i.e. the byte the source (mouse.py / mxw)
 * calls `bfr[bufferIndex]` in its 65-byte, report-id-prefixed buffer.
 */
function bfr(body: Uint8Array, bufferIndex: number, value: number): void {
  body[bufferIndex - 1] = value & 0xff;
}

// ---------------------------------------------------------------------------
// RGB (mouse.py set_rgb)
// ---------------------------------------------------------------------------

export type GloriousClassicRgbEffect =
  | "off" | "glorious" | "cycle" | "pulse" | "solid" | "pulseOne" | "tail" | "rave" | "wave";

const EFFECT_IDS: Record<GloriousClassicRgbEffect, number> = {
  off: 0x00,
  glorious: 0x01,
  cycle: 0x02,
  pulse: 0x03,
  solid: 0x04,
  pulseOne: 0x05,
  tail: 0x06,
  rave: 0x07,
  wave: 0x08,
};

export const GLORIOUS_CLASSIC_RGB_EFFECT_OPTIONS: ReadonlyArray<readonly [GloriousClassicRgbEffect, string]> = [
  ["glorious", "Glorious"],
  ["off", "LEDs off"],
  ["cycle", "Cycle"],
  ["pulse", "Pulse"],
  ["solid", "Solid color"],
  ["pulseOne", "Pulse (solid)"],
  ["tail", "Tail"],
  ["rave", "Rave"],
  ["wave", "Wave"],
];

export interface GloriousClassicRgb {
  effect: GloriousClassicRgbEffect;
  /** 0-100, ignored by effects that don't take a rate. */
  rate: number;
  /** "#rrggbb" strings, meaning depends on effect (see buildGloriousClassicRgbPayload). */
  colors: string[];
  profileId?: number;
}

export const GLORIOUS_CLASSIC_DEFAULT_RGB: GloriousClassicRgb = {
  effect: "glorious",
  rate: 50,
  colors: ["#ff0000"],
  profileId: GLORIOUS_CLASSIC_PROFILE_DEFAULT,
};

function hexToRgb(hex: string): readonly [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match ? match[1] : "ff0000";
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * `rate_check()` from mouse.py: 0-100 input, clamped, mapped onto the
 * hardware's inverted byte scale. Effects 7/8 (rave/wave) use a finer step.
 */
export function gloriousClassicRateByte(rate: number, effect: GloriousClassicRgbEffect): number {
  const clamped = Math.max(0, Math.min(100, Math.round(rate)));
  const id = EFFECT_IDS[effect];
  return id === EFFECT_IDS.rave || id === EFFECT_IDS.wave
    ? (105 - clamped) * 2
    : Math.floor((105 - clamped) / 5);
}

/**
 * Builds the single 64-byte feature-report body for an RGB write. Mirrors
 * `set_rgb()` in mouse.py exactly, including its per-effect payload length
 * and color-slot layout:
 *   bfr[3]=0x02 (class), bfr[4]=<length, effect-dependent>, bfr[5]=0x02,
 *   bfr[7]=profile, bfr[8]=0xFF, bfr[9]=<effect id>, bfr[11]=<rate>,
 *   bfr[12..]=color triplets.
 */
export function buildGloriousClassicRgbPayload(rgb: GloriousClassicRgb): Uint8Array<ArrayBuffer> {
  const body = packet();
  const profileId = rgb.profileId ?? GLORIOUS_CLASSIC_PROFILE_DEFAULT;
  const id = EFFECT_IDS[rgb.effect];
  const rateByte = gloriousClassicRateByte(rgb.rate, rgb.effect);
  const rgbColors = rgb.colors.map(hexToRgb);

  bfr(body, 3, 0x02);
  bfr(body, 5, 0x02);
  bfr(body, 7, profileId);
  bfr(body, 8, 0xff);
  bfr(body, 9, id);

  switch (rgb.effect) {
    case "off":
      bfr(body, 4, 0x05);
      break;
    case "glorious":
      bfr(body, 4, 0x05);
      bfr(body, 11, rateByte);
      break;
    case "cycle":
      bfr(body, 4, 0x05);
      bfr(body, 11, rateByte);
      bfr(body, 12, 0xff);
      break;
    case "pulse": {
      const colors = rgbColors.slice(0, 6);
      bfr(body, 4, colors.length * 3 + 5);
      bfr(body, 11, rateByte);
      colors.forEach(([r, g, b], index) => {
        bfr(body, 12 + index * 3, r);
        bfr(body, 13 + index * 3, g);
        bfr(body, 14 + index * 3, b);
      });
      break;
    }
    case "solid": {
      bfr(body, 4, 0x08);
      const [r, g, b] = rgbColors[0] ?? [255, 0, 0];
      bfr(body, 12, r);
      bfr(body, 13, g);
      bfr(body, 14, b);
      break;
    }
    case "pulseOne": {
      bfr(body, 4, 0x08);
      bfr(body, 11, rateByte);
      const [r, g, b] = rgbColors[0] ?? [255, 0, 0];
      bfr(body, 12, r);
      bfr(body, 13, g);
      bfr(body, 14, b);
      break;
    }
    case "tail":
      bfr(body, 4, 0x05);
      bfr(body, 11, rateByte);
      break;
    case "rave": {
      const colors = rgbColors.slice(0, 2);
      bfr(body, 4, colors.length * 3 + 5);
      bfr(body, 11, rateByte);
      colors.forEach(([r, g, b], index) => {
        bfr(body, 12 + index * 3, r);
        bfr(body, 13 + index * 3, g);
        bfr(body, 14 + index * 3, b);
      });
      break;
    }
    case "wave":
      bfr(body, 4, 0x05);
      bfr(body, 11, rateByte);
      break;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Debounce (mouse.py set_debounce_time): bfr[3]=0x02, bfr[4]=0x01, bfr[6]=0x08,
// bfr[7]=profile, bfr[8]=ms.
// ---------------------------------------------------------------------------

export function buildGloriousClassicDebouncePayload(milliseconds: number, profileId = GLORIOUS_CLASSIC_PROFILE_DEFAULT): Uint8Array<ArrayBuffer> {
  const clamped = Math.max(0, Math.min(GLORIOUS_CLASSIC_DEBOUNCE_MAX_MS, Math.round(milliseconds)));
  const body = packet();
  bfr(body, 3, 0x02);
  bfr(body, 4, 0x01);
  bfr(body, 6, 0x08);
  bfr(body, 7, profileId);
  bfr(body, 8, clamped);
  return body;
}

// ---------------------------------------------------------------------------
// Battery (mouse.py get_battery_status). Request: bfr[3]=0x02, bfr[4]=0x02,
// bfr[6]=0x83. Response: bfr[1]=status, bfr[6]=echo, bfr[8]=percent.
// ---------------------------------------------------------------------------

export function buildGloriousClassicBatteryRequestPayload(): Uint8Array<ArrayBuffer> {
  const body = packet();
  bfr(body, 3, 0x02);
  bfr(body, 4, 0x02);
  bfr(body, 6, 0x83);
  return body;
}

export type GloriousClassicBatteryState = "Normal" | "Asleep" | "WakingUp" | "Unknown";

export interface GloriousClassicBattery {
  state: GloriousClassicBatteryState;
  /** 1-100, or null when the state has no meaningful percentage. */
  percent: number | null;
}

/** Raw status byte -> meaning, per `status_map.index(bfr_r[1])` in mouse.py. */
const STATUS_BYTE_TO_STATE: ReadonlyMap<number, GloriousClassicBatteryState> = new Map([
  [0xa1, "Normal"],
  [0xa4, "Asleep"],
  [0xa2, "Unknown"],
  [0xa0, "WakingUp"],
  [0xa3, "Unknown"],
]);

/**
 * Mirrors `get_battery_status()`'s response parsing. `body` is the 64-byte
 * feature-report body (bfr[1] is body[0], i.e. `bfr[n]` is `body[n-1]`).
 */
export function parseGloriousClassicBatteryResponse(body: Uint8Array): GloriousClassicBattery {
  const statusByte = body[0]; // bfr[1]
  const echo = body[5]; // bfr[6]
  const rawPercent = body[7]; // bfr[8]

  if (echo !== 0x83) return { state: "Unknown", percent: null };

  const state = STATUS_BYTE_TO_STATE.get(statusByte) ?? "Unknown";
  if (state !== "Normal") return { state, percent: null };

  const percent = rawPercent === 0 ? 1 : rawPercent;
  return { state, percent: percent > 0 && percent <= 100 ? percent : null };
}

// ---------------------------------------------------------------------------
// DPI, polling rate, lift-off distance (korkje/mxw). None of these three has
// a read command in mxw either — every write below is fire-and-forget, same
// as the RGB/debounce commands above.
// ---------------------------------------------------------------------------

export const GLORIOUS_CLASSIC_DPI_MIN = 100;
export const GLORIOUS_CLASSIC_DPI_MAX = 19000;
export const GLORIOUS_CLASSIC_DPI_STAGE_COUNT = 4;

/**
 * DPI stages (mxw src/config/dpi_stages.rs): bfr[3]=0x02, bfr[4]=0x12,
 * bfr[5]=0x01, bfr[6]=0x01, bfr[7]=profile, bfr[8]=stage count, then per
 * stage a 4-byte big-endian u16 value written twice (X and Y, always equal
 * in mxw): bfr[9+4i]=hi, bfr[10+4i]=lo, bfr[11+4i]=hi, bfr[12+4i]=lo.
 */
export function buildGloriousClassicDpiStagesPayload(
  stages: readonly number[],
  profileId = GLORIOUS_CLASSIC_PROFILE_DEFAULT,
): Uint8Array<ArrayBuffer> {
  const clamped = stages.map((dpi) => Math.max(GLORIOUS_CLASSIC_DPI_MIN, Math.min(GLORIOUS_CLASSIC_DPI_MAX, Math.round(dpi))));
  const body = packet();
  bfr(body, 3, 0x02);
  bfr(body, 4, 0x12);
  bfr(body, 5, 0x01);
  bfr(body, 6, 0x01);
  bfr(body, 7, profileId);
  bfr(body, 8, clamped.length);
  clamped.forEach((dpi, index) => {
    const hi = (dpi >> 8) & 0xff;
    const lo = dpi & 0xff;
    const base = 9 + 4 * index;
    bfr(body, base, hi);
    bfr(body, base + 1, lo);
    bfr(body, base + 2, hi);
    bfr(body, base + 3, lo);
  });
  return body;
}

/** Active DPI stage (mxw src/config/dpi_stage.rs), stageId is 1-based (1-4). */
export function buildGloriousClassicActiveStagePayload(
  stageId: number,
  profileId = GLORIOUS_CLASSIC_PROFILE_DEFAULT,
): Uint8Array<ArrayBuffer> {
  const body = packet();
  bfr(body, 3, 0x02);
  bfr(body, 4, 0x02);
  bfr(body, 5, 0x01);
  bfr(body, 6, 0x02);
  bfr(body, 7, profileId);
  bfr(body, 8, stageId);
  return body;
}

/**
 * Polling rate (mxw src/config/polling_rate.rs): bfr[3]=0x02, bfr[4]=0x01,
 * bfr[5]=0x01, bfr[7]=poll interval in milliseconds. mxw only offers
 * {1,2,4,8} ms, i.e. {1000,500,250,125} Hz — this generation has no 2K/4K/8K
 * mode.
 */
export const GLORIOUS_CLASSIC_POLLING_RATES: ReadonlyArray<readonly [ms: number, hertz: number]> = [
  [1, 1000],
  [2, 500],
  [4, 250],
  [8, 125],
];

export function gloriousClassicEncodePollingRate(hertz: number): number | null {
  return GLORIOUS_CLASSIC_POLLING_RATES.find(([, hz]) => hz === hertz)?.[0] ?? null;
}

export function gloriousClassicDecodePollingRate(ms: number): number | null {
  return GLORIOUS_CLASSIC_POLLING_RATES.find(([interval]) => interval === ms)?.[1] ?? null;
}

export function buildGloriousClassicPollingRatePayload(intervalMs: number): Uint8Array<ArrayBuffer> {
  const body = packet();
  bfr(body, 3, 0x02);
  bfr(body, 4, 0x01);
  bfr(body, 5, 0x01);
  bfr(body, 7, intervalMs);
  return body;
}

/**
 * Lift-off distance (mxw src/config/lift_off.rs): bfr[3]=0x02, bfr[4]=0x01,
 * bfr[5]=0x01, bfr[6]=0x07, bfr[7]=millimetres-1 (0=1mm, 1=2mm — only those
 * two are valid on this generation).
 */
export const GLORIOUS_CLASSIC_LOD_MEDIUM_MM = 1;
export const GLORIOUS_CLASSIC_LOD_HIGH_MM = 2;

export function buildGloriousClassicLiftOffPayload(millimetres: number): Uint8Array<ArrayBuffer> {
  const body = packet();
  bfr(body, 3, 0x02);
  bfr(body, 4, 0x01);
  bfr(body, 5, 0x01);
  bfr(body, 6, 0x07);
  bfr(body, 7, millimetres - 1);
  return body;
}
