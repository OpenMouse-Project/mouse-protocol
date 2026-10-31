/**
 * LEOBOG GM3 onboard configuration block.
 *
 * The vendor application reads this with the `0x44` command (400 payload
 * bytes) and writes it back with `0x04`. Every field below was located by
 * changing exactly one control in the vendor UI, saving, and diffing the
 * block the device answered afterwards:
 *
 * | offset      | meaning                                             |
 * | ----------- | --------------------------------------------------- |
 * | 0           | 0x64 — DPI floor, 100                               |
 * | 1           | 0x18 — DPI ceiling / 1000, 24                       |
 * | 2           | polling-rate index, 1 = 125 Hz … 4 = 1000 Hz        |
 * | 3           | high nibble active stage + 1, low nibble stage count |
 * | 5           | debounce index, 1 = 2 ms … 6 = 12 ms                |
 * | 7, 27       | two identical tables of six little-endian DPI values |
 * | 74          | auto-sleep idle minutes, 0 disables it (vendor: 1-20) |
 * | 76          | battery percentage, as an unsigned byte             |
 *
 * A DPI entry stores `dpi / 100 - 1`, so the factory 800 reads as 7 and the
 * 12000 stage reads as 119. The 26-byte `44 01` records after offset 43 are
 * not decoded; the encoders below copy them through untouched.
 */

/** Payload bytes the `44`/`04` commands carry, after the eight header bytes. */
export const LEOBOG_GM3_ONBOARD_LENGTH = 400;

export const LEOBOG_GM3_DPI_MIN = 100;
export const LEOBOG_GM3_DPI_MAX = 24000;
export const LEOBOG_GM3_DPI_STEP = 100;
export const LEOBOG_GM3_MAX_DPI_STAGES = 6;

/** Polling rates the vendor dropdown offers, indexed by the byte at offset 2. */
export const LEOBOG_GM3_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

/** Button debounce steps, indexed by the byte at offset 5. */
export const LEOBOG_GM3_DEBOUNCE_OPTIONS: readonly number[] = [2, 4, 6, 8, 10, 12];

/** Auto-sleep idle time in minutes; 0 means the mouse never sleeps. */
export const LEOBOG_GM3_SLEEP_MINUTES_OFFSET = 0x4a;
/** Highest idle time the vendor slider offers. */
export const LEOBOG_GM3_SLEEP_MAX_MINUTES = 20;
/** Battery level the block reports, in percent. */
export const LEOBOG_GM3_BATTERY_OFFSET = 0x4c;

const OFFSET_POLLING = 2;
const OFFSET_STAGE_AND_COUNT = 3;
const OFFSET_DEBOUNCE = 5;
/** The stage table appears twice; the vendor application keeps both in sync. */
const DPI_TABLE_OFFSETS = [7, 27] as const;
const DPI_ENTRY_STRIDE = 2;

export interface LeobogGm3OnboardConfig {
  /** Enabled DPI stages, 1-6, from the low nibble of byte 3. */
  stageCount: number;
  /** Active stage index, 0-based, from the high nibble of byte 3. */
  activeStage: number;
  /** Every stage's DPI value; entries past `stageCount` read as 0. */
  dpiStages: number[];
  pollingRateHz: number;
  debounceMs: number;
  /** Idle minutes before the mouse sleeps; 0 when auto-sleep is off. */
  sleepMinutes: number;
  /**
   * Percent the block reports, or null when it carries none. The receiver
   * fills this in; over the cable it reads 0.
   */
  reportedBatteryPercent: number | null;
}

const readDpi = (payload: Uint8Array, offset: number): number =>
  (payload[offset]! | (payload[offset + 1]! << 8)) * 100 + 100;

const writeDpi = (payload: Uint8Array, offset: number, dpi: number): void => {
  const encoded = dpi / 100 - 1;
  payload[offset] = encoded & 0xff;
  payload[offset + 1] = (encoded >> 8) & 0xff;
};

/**
 * Decodes the block, or null when a field is outside the range the vendor
 * application can produce — that keeps a misread or a future firmware layout
 * from being reported as real settings.
 */
export function leobogGm3DecodeOnboard(payload: Uint8Array): LeobogGm3OnboardConfig | null {
  if (payload.length < LEOBOG_GM3_ONBOARD_LENGTH) return null;

  const stageCount = payload[OFFSET_STAGE_AND_COUNT]! & 0x0f;
  const activeStage = (payload[OFFSET_STAGE_AND_COUNT]! >> 4) - 1;
  const pollingIndex = payload[OFFSET_POLLING]!;
  const debounceIndex = payload[OFFSET_DEBOUNCE]!;
  const sleepMinutes = payload[LEOBOG_GM3_SLEEP_MINUTES_OFFSET]!;
  const reportedBattery = payload[LEOBOG_GM3_BATTERY_OFFSET]!;

  if (stageCount < 1 || stageCount > LEOBOG_GM3_MAX_DPI_STAGES) return null;
  if (activeStage < 0 || activeStage >= stageCount) return null;
  if (pollingIndex < 1 || pollingIndex > LEOBOG_GM3_POLLING_RATES.length) return null;
  if (debounceIndex < 1 || debounceIndex > LEOBOG_GM3_DEBOUNCE_OPTIONS.length) return null;
  // The vendor's slider stops at 20 minutes, but a firmware that allows longer
  // idle times should still read back rather than hiding every setting.
  if (sleepMinutes > 120) return null;

  const dpiStages = DPI_TABLE_OFFSETS[0] === undefined
    ? []
    : Array.from(
      { length: LEOBOG_GM3_MAX_DPI_STAGES },
      (_, stage) => readDpi(payload, DPI_TABLE_OFFSETS[0] + stage * DPI_ENTRY_STRIDE),
    );

  return {
    stageCount,
    activeStage,
    dpiStages,
    pollingRateHz: LEOBOG_GM3_POLLING_RATES[pollingIndex - 1]!,
    debounceMs: LEOBOG_GM3_DEBOUNCE_OPTIONS[debounceIndex - 1]!,
    sleepMinutes,
    reportedBatteryPercent: reportedBattery > 0 && reportedBattery <= 100 ? reportedBattery : null,
  };
}

/** True when every enabled stage holds the value the DPI table also stores. */
export function leobogGm3DpiTablesAgree(payload: Uint8Array): boolean {
  if (payload.length < LEOBOG_GM3_ONBOARD_LENGTH) return false;
  for (let stage = 0; stage < LEOBOG_GM3_MAX_DPI_STAGES; stage++) {
    const offset = stage * DPI_ENTRY_STRIDE;
    if (
      readDpi(payload, DPI_TABLE_OFFSETS[0] + offset)
      !== readDpi(payload, DPI_TABLE_OFFSETS[1] + offset)
    ) {
      return false;
    }
  }
  return true;
}

export function leobogGm3IsDpiValue(dpi: number): boolean {
  return (
    Number.isInteger(dpi)
    && dpi >= LEOBOG_GM3_DPI_MIN
    && dpi <= LEOBOG_GM3_DPI_MAX
    && (dpi - LEOBOG_GM3_DPI_MIN) % LEOBOG_GM3_DPI_STEP === 0
  );
}

const mutableCopy = (payload: Uint8Array): Uint8Array => {
  if (payload.length < LEOBOG_GM3_ONBOARD_LENGTH) {
    throw new RangeError(`The onboard block is ${payload.length} bytes, not ${LEOBOG_GM3_ONBOARD_LENGTH}.`);
  }
  return payload.slice(0, LEOBOG_GM3_ONBOARD_LENGTH);
};

/** Returns a copy with one stage's DPI changed; both tables are updated. */
export function leobogGm3WithDpiStage(
  payload: Uint8Array,
  stage: number,
  dpi: number,
): Uint8Array {
  if (!Number.isInteger(stage) || stage < 0 || stage >= LEOBOG_GM3_MAX_DPI_STAGES) {
    throw new RangeError(`DPI stage out of range: ${stage}`);
  }
  if (!leobogGm3IsDpiValue(dpi)) {
    throw new RangeError(`DPI out of range: ${dpi}`);
  }
  const next = mutableCopy(payload);
  for (const table of DPI_TABLE_OFFSETS) {
    writeDpi(next, table + stage * DPI_ENTRY_STRIDE, dpi);
  }
  return next;
}

/**
 * Returns a copy with a different active stage. The vendor application keeps
 * the DPI value of the selected stage untouched, so this only moves the high
 * nibble and leaves the tables alone.
 */
export function leobogGm3WithActiveStage(payload: Uint8Array, stage: number): Uint8Array {
  const stageCount = payload[OFFSET_STAGE_AND_COUNT]! & 0x0f;
  if (!Number.isInteger(stage) || stage < 0 || stage >= stageCount) {
    throw new RangeError(`DPI stage ${stage} is outside this mouse's ${stageCount}-stage cycle.`);
  }
  const next = mutableCopy(payload);
  next[OFFSET_STAGE_AND_COUNT] = ((stage + 1) << 4) | stageCount;
  return next;
}

/**
 * Returns a copy with a different number of enabled stages. Growing fills the
 * new stages from the last value in the table, matching what the vendor UI
 * shows; shrinking blanks the trailing entries the way the vendor write does.
 */
export function leobogGm3WithStageCount(payload: Uint8Array, count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 1 || count > LEOBOG_GM3_MAX_DPI_STAGES) {
    throw new RangeError(`DPI stage count out of range: ${count}`);
  }
  const next = mutableCopy(payload);
  const [tableA, tableB] = DPI_TABLE_OFFSETS;
  // Any stage the vendor write blanked reads back as the 100 DPI floor, so it
  // is treated as empty and refilled from the last stage that still holds a
  // value.
  let fill = LEOBOG_GM3_DPI_MIN;
  for (let stage = 0; stage < LEOBOG_GM3_MAX_DPI_STAGES; stage++) {
    const value = readDpi(next, tableA + stage * DPI_ENTRY_STRIDE);
    if (value > LEOBOG_GM3_DPI_MIN) fill = value;
  }
  const active = Math.min((next[OFFSET_STAGE_AND_COUNT]! >> 4) - 1, count - 1);

  for (let stage = 0; stage < LEOBOG_GM3_MAX_DPI_STAGES; stage++) {
    const blank = stage >= count || readDpi(next, tableA + stage * DPI_ENTRY_STRIDE) <= LEOBOG_GM3_DPI_MIN;
    for (const table of [tableA, tableB]) {
      const offset = table + stage * DPI_ENTRY_STRIDE;
      if (stage >= count) {
        // The vendor write zeroes the entries past the enabled count.
        next[offset] = 0;
        next[offset + 1] = 0;
      } else if (blank) {
        writeDpi(next, offset, fill);
      }
    }
  }

  next[OFFSET_STAGE_AND_COUNT] = ((active + 1) << 4) | count;
  return next;
}

export function leobogGm3WithPollingRate(payload: Uint8Array, hz: number): Uint8Array {
  const index = LEOBOG_GM3_POLLING_RATES.indexOf(hz);
  if (index < 0) {
    throw new RangeError(
      `This mouse does not support ${hz} Hz; it offers ${LEOBOG_GM3_POLLING_RATES.join(", ")}.`,
    );
  }
  const next = mutableCopy(payload);
  next[OFFSET_POLLING] = index + 1;
  return next;
}

export function leobogGm3WithDebounce(payload: Uint8Array, ms: number): Uint8Array {
  const index = LEOBOG_GM3_DEBOUNCE_OPTIONS.indexOf(ms);
  if (index < 0) {
    throw new RangeError(
      `This mouse does not support ${ms} ms debounce; it offers ${LEOBOG_GM3_DEBOUNCE_OPTIONS.join(", ")}.`,
    );
  }
  const next = mutableCopy(payload);
  next[OFFSET_DEBOUNCE] = index + 1;
  return next;
}

/**
 * Returns a copy with a different auto-sleep idle time, in minutes; 0 turns
 * auto-sleep off, matching the vendor's own on/off switch.
 */
export function leobogGm3WithSleepMinutes(payload: Uint8Array, minutes: number): Uint8Array {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > LEOBOG_GM3_SLEEP_MAX_MINUTES) {
    throw new RangeError(
      `Auto-sleep must be off (0) or ${1}-${LEOBOG_GM3_SLEEP_MAX_MINUTES} whole minutes, got ${minutes}.`,
    );
  }
  const next = mutableCopy(payload);
  next[LEOBOG_GM3_SLEEP_MINUTES_OFFSET] = minutes;
  return next;
}
