import {
  PULSAR_COMMAND,
  PULSAR_CONFIG_PACKET_LENGTH,
  PULSAR_CONFIG_REPORT_ID,
  PULSAR_FLASH,
  pulsarPacketChecksum,
} from "../pulsar/index.js";
import type { MouseStatus } from "../drivers/mouse-types.js";

/**
 * Lamzu's "Atlantis" generation — CompX vendor id 0x3554.
 *
 * These mice do not speak the page/command feature-report protocol in
 * `../compx/codec.ts` that the 0x373e and 0x37b0 Lamzu models use. They speak
 * the *other* CompX stack: report 8, 16-byte interrupt reports, settings in a
 * flash image addressed by byte offset — the same wire protocol this package
 * already implements for the Pulsar 4K receiver and the VGN and Teevolution
 * mice that share vendor id 0x3554. CompX is the ODM for all of them; the
 * user's own device reports `manufacturer: "compx"`.
 *
 * So the framing, command ids, checksum and 50-step DPI encoding are imported
 * from the Pulsar entry point rather than restated here. What this module adds
 * is only what is genuinely Lamzu: the product catalog, the flash fields
 * Lamzu's firmware uses that the Pulsar driver never reads, the lift-off
 * encoding (which differs), and the polling-rate table (which differs).
 *
 * Verified on a Lamzu Atlantis Mini 4K, firmware 1.24, wired 0x3554:0xf50f —
 * see docs/lamzu-atlantis-testing.md. Protocol groundwork: LeadSun/lamzu-cfg
 * (Apache-2.0/MIT), reverse-engineered from an Atlantis Mini Pro.
 */

export const LAMZU_ATLANTIS_VENDOR_ID = 0x3554;

/** The one collection that answers: interface 1, usage page 0xff02, usage 2. */
export const LAMZU_ATLANTIS_USAGE_PAGE = 0xff02;
export const LAMZU_ATLANTIS_USAGE = 0x02;

/** Shared CompX report-8 framing, re-stated under Lamzu names for callers. */
export const LAMZU_ATLANTIS_REPORT_ID = PULSAR_CONFIG_REPORT_ID;
export const LAMZU_ATLANTIS_PACKET_LENGTH = PULSAR_CONFIG_PACKET_LENGTH;
export const LAMZU_ATLANTIS_PAYLOAD_OFFSET = 5;
export const LAMZU_ATLANTIS_MAX_PAYLOAD = 10;

/**
 * The commands are CompX's, not Lamzu's, so the whole Pulsar set is aliased
 * here rather than a Lamzu-specific subset. Only six have been exercised on
 * Atlantis hardware: 0x04 battery, 0x07/0x08 flash write/read, 0x0e active
 * profile, 0x0f set active profile, and 0x12 firmware version (returned
 * 0x01 0x24 — v1.24, matching both the USB bcdDevice and the version Lamzu's
 * download page lists for this model). The dongle-only commands (0x15, 0x1d,
 * 0x2b) answer status 1 over the cable; the rest — `encryptionData`,
 * `deviceOnline`, `setDongleRgb` — are inherited names this driver never
 * sends and are unverified on this family.
 */
export const LAMZU_ATLANTIS_COMMAND = PULSAR_COMMAND;

/**
 * Switching the active onboard profile. It is the write counterpart of
 * `getCurrentConfig` (0x0e) and is absent from `PULSAR_COMMAND` because the
 * Pulsar driver only reads the profile. Documented by lamzu-cfg as
 * `WriteActiveProfile` and exercised here on an Atlantis Mini 4K.
 */
export const LAMZU_ATLANTIS_WRITE_ACTIVE_PROFILE = 0x0f;

/**
 * Restoring the factory settings, CompX's ClearSetting. Absent from
 * `PULSAR_COMMAND` like the profile write above. Sent with no address and no
 * payload; Scyrox's configurator then waits up to six seconds for the mouse to
 * echo the command before it re-reads the flash image.
 */
export const LAMZU_ATLANTIS_CLEAR_SETTINGS = 0x09;

/**
 * Flash offsets. Everything in `PULSAR_FLASH` matched byte for byte on Lamzu
 * hardware — same firmware family, same layout — so those are inherited rather
 * than re-typed, and only the fields Lamzu's configurator exposes that the
 * Pulsar driver never reads are added here.
 *
 * `sleepTime` deserves a note: the byte is a count of ten-second units, not
 * seconds. Lamzu's configurator showed a 1-minute timeout while address 173
 * held 0x06, and 10 seconds while it held 0x01.
 */
export const LAMZU_ATLANTIS_FLASH = {
  ...PULSAR_FLASH,
  dpiStageCount: 2,
  dpiStageColors: 44,
  buttonActions: 96,
  highPerformance: 185,
  /**
   * Sensor angle tuning: a signed degree count at 189 and, at 191, the switch
   * the vendor configurator sets to 1 before its first angle write. Both are
   * one-byte sealed fields, named AngleTune and AngleTuneState in Scyrox's
   * flash map.
   */
  angleTune: 189,
  angleTuneState: 191,
  /** Where 3955-sensor firmware keeps the DPI stage values (six-byte records,
   * each with its own checksum). The legacy `dpiValues` fields on those mice
   * keep holding the factory defaults. */
  sensor3955DpiValues: 6912,
} as const;

export const LAMZU_ATLANTIS_STAGE_STRIDE = 4;
/**
 * Stride of the 3955-sensor DPI records: 16-bit x, 16-bit y, flags, checksum.
 * See the layout type below for when a product uses these.
 */
export const LAMZU_ATLANTIS_SENSOR3955_STAGE_STRIDE = 6;
export const LAMZU_ATLANTIS_MAX_DPI_STAGES = 8;

/**
 * Onboard profiles, 1-based in Lamzu's UI and 0-based on the wire. Probed on
 * hardware: writing indices 0-3 is accepted and reads back, while 4 and above
 * are rejected with status 1 and leave the mouse on its previous profile.
 */
export const LAMZU_ATLANTIS_PROFILE_COUNT = 4;

/** PAW3395: 50-26,000 DPI in 50 DPI steps, per Lamzu's own device table. */
export const LAMZU_ATLANTIS_DPI_STEP = 50;
export const LAMZU_ATLANTIS_MIN_DPI = 50;
export const LAMZU_ATLANTIS_MAX_DPI = 26000;

/**
 * Both timers this firmware stores — the peak-performance window and the sleep
 * timeout — count ten-second units in a single byte.
 */
export const LAMZU_ATLANTIS_TIMER_STEP_SECONDS = 10;
export const LAMZU_ATLANTIS_MAX_TIMER_SECONDS = 0xff * LAMZU_ATLANTIS_TIMER_STEP_SECONDS;

/** Sleep timeouts Lamzu's own configurator offers, in seconds. */
export const LAMZU_ATLANTIS_SLEEP_OPTIONS = [10, 30, 60, 300, 600, 1800] as const;

/**
 * Which rate-byte encoding a product speaks. Stored per product rather than
 * derived from the rate ceiling: the 1K receiver tops out at 1,000 Hz like the
 * cable does, so a ceiling test would silently decide its encoding for it, and
 * no 1K receiver has been on hand to check.
 *
 * "wired" and "receiver" are Lamzu's two encodings of 1,000 Hz (see the table
 * below). "pulsar" is CompX's own encoding — the one `pulsarEncodePollingRate`
 * implements — where 0x10 and up carry 2-8 kHz. Scyrox's generation uses it on
 * both the cable and the dongle: its web configurator writes 0x10, 0x20 and
 * 0x40 for 2,000, 4,000 and 8,000 Hz, and a V8S set to 4,000 Hz held 0x20.
 */
export type LamzuAtlantisRateFamily = "wired" | "receiver" | "pulsar";

/**
 * Which flash region a product's DPI stage values live in: the legacy
 * four-byte fields at `dpiValues`, or the six-byte records at
 * `sensor3955DpiValues` that CompX's 3955-sensor firmware moved them to.
 */
export type LamzuAtlantisDpiLayout = "legacy" | "sensor3955";

export interface LamzuAtlantisProduct {
  model: string;
  brand?: MouseStatus["brand"];
  wireless: boolean;
  pollingRates: readonly number[];
  rateFamily: LamzuAtlantisRateFamily;
  /** Which flash region the stage values live in; defaults to "legacy". */
  dpiLayout?: LamzuAtlantisDpiLayout;
  /** False until this exact product id has been exercised on hardware. */
  verified: boolean;
  /** Per-product sensor limits where they differ from Atlantis defaults. */
  minDpi?: number;
  maxDpi?: number;
  dpiStep?: number;
  maxDpiStages?: number;
  /** Zero means that this transport has no firmware-managed numbered profiles. */
  profileCount?: number;
  /** Omit unsupported controls rather than presenting speculative settings. */
  supportsLiftOffDistance?: boolean;
  supportsSleepTimeout?: boolean;
  supportsMotionSync?: boolean;
  supportsAngleSnapping?: boolean;
  supportsRippleControl?: boolean;
  supportsPerformanceMode?: boolean;
  supportsHyperMode?: boolean;
  /**
   * When set, the lift-off byte is a scale of codes 1 to n at these heights in
   * millimetres, rather than Lamzu's two stops. The status then carries
   * `liftOffScale`, and the coarse `liftOffDistance` is the nearest stop.
   */
  liftOffMillimetres?: readonly number[];
  /** Controls below default to off: no Lamzu unit has exercised them. */
  supportsAngleTuning?: boolean;
  supportsFactoryReset?: boolean;
  /**
   * Whether a sleep write also goes to `performanceTime` (flash 183). Scyrox's
   * configurator writes every sleep value to both addresses, and a V8S it had
   * configured held the same byte in each.
   */
  mirrorSleepToPerformanceTime?: boolean;
}

const RATES_WIRED = [125, 250, 500, 1000] as const;
const RATES_4K = [500, 1000, 2000, 4000] as const;

/**
 * Six models share these ids — Atlantis OG V2, Atlantis Mini, Atlantis Mini
 * Pro, Thorn, Maya and Paro of this generation — and nothing on the wire
 * separates them: same product id, same USB product string ("LAMZU Atlantis
 * Pro" on the cable, "LAMZU 4K Receiver" on the dongle), same firmware
 * version. Lamzu's own Windows configurator has the same problem and solves it
 * by making the user pick the model from a list, so this catalog names the
 * family rather than pretending to identify one model.
 *
 * 0xf50f (the mouse on its cable) is confirmed on hardware. The two receiver
 * ids come from Lamzu's shipped device table and nothing more: no receiver has
 * been exercised, so neither their rate lists nor the transport itself is
 * established, and they stay `verified: false` until one is.
 *
 * 0xf517 was in that table too, but hardware showed it enumerating as a
 * "Scyrox Turbo 8k dongle" that speaks this same protocol; it moved to
 * `../scyrox/index.ts`.
 */
export const LAMZU_ATLANTIS_PRODUCTS: ReadonlyMap<number, LamzuAtlantisProduct> = new Map([
  [0xf50f, { model: "Atlantis", wireless: false, pollingRates: RATES_WIRED, rateFamily: "wired", verified: true }],
  [0xf50d, { model: "Atlantis", wireless: true, pollingRates: RATES_WIRED, rateFamily: "wired", verified: false }],
  [0xf510, { model: "Atlantis", wireless: true, pollingRates: RATES_4K, rateFamily: "receiver", verified: false }],
]);

/**
 * The rate byte uses the encoding the other Lamzu generations use, where
 * 1,000 Hz appears twice: 0x01 in the wired 125-1000 family and 0x10 in the
 * receiver family. Both were read from the same mouse — 0x10 before Lamzu's
 * configurator touched the profile and 0x01 after it wrote 1,000 Hz over the
 * cable, with the vendor UI reading "1000Hz" both times — and selecting
 * 500 Hz in that UI wrote 0x02.
 *
 * This is why the Lamzu units need their own table rather than
 * `pulsarDecodePollingRate`, which reads 0x10 as 2,000 Hz.
 */
export const LAMZU_ATLANTIS_POLLING_RATES = [
  [0x08, 125], [0x04, 250], [0x02, 500], [0x01, 1000],
  [0x10, 1000], [0x20, 2000], [0x40, 4000], [0x80, 8000],
] as const;

/**
 * CompX's own rate bytes, the mapping `pulsarEncodePollingRate` implements:
 * below 0x10 they divide 1,000 Hz exactly as Lamzu's wired family does, and
 * 0x10 to 0x40 step by 2,000 Hz. Read from Scyrox's web configurator
 * (scyrox.net, S-center 3.1.0, which encodes `rate <= 1000 ? 1000 / rate :
 * rate / 2000 * 16`) and confirmed on hardware: a V8S the configurator set to
 * 4,000 Hz held 0x20 while a decoder using the Lamzu table read it as 2,000.
 */
export const LAMZU_ATLANTIS_PULSAR_POLLING_RATES = [
  [0x08, 125], [0x04, 250], [0x02, 500], [0x01, 1000],
  [0x10, 2000], [0x20, 4000], [0x40, 8000],
] as const;

export type LamzuAtlantisLiftOffDistance = "Low" | "Medium";

/**
 * Only two lift-off heights exist on this generation, 1 mm and 2 mm, and they
 * encode as 1 and 2. The Pulsar driver's 3/1/2 → Low/Medium/High mapping would
 * report a Lamzu's 1 mm as "Medium".
 */
export const LAMZU_ATLANTIS_LIFT_OFF_DISTANCES = [
  [0x01, "Low"], [0x02, "Medium"],
] as const satisfies ReadonlyArray<readonly [number, LamzuAtlantisLiftOffDistance]>;

export interface LamzuAtlantisRequest {
  command: number;
  address?: number;
  payload?: readonly number[];
}

export interface LamzuAtlantisReply {
  command: number;
  error: number;
  address: number;
  /**
   * The full payload window, not a slice of `declaredLength` bytes: the
   * battery reply declares 2 while carrying 4 meaningful bytes (percent,
   * charging, then the millivolts), so trusting the length byte would drop the
   * voltage. Callers slice to what they asked for.
   */
  payload: Uint8Array;
  declaredLength: number;
}

/**
 * Builds the 16 bytes WebHID sends for report 8. The report id is excluded
 * from the buffer but included in the checksum, which is what
 * `pulsarPacketChecksum` accounts for.
 */
export function lamzuAtlantisEncodeRequest(spec: LamzuAtlantisRequest): Uint8Array<ArrayBuffer> {
  const payload = spec.payload ?? [];
  if (payload.length > LAMZU_ATLANTIS_MAX_PAYLOAD) {
    throw new Error(`A CompX report-8 frame carries at most ${LAMZU_ATLANTIS_MAX_PAYLOAD} payload bytes.`);
  }
  const address = spec.address ?? 0;
  const packet = new Uint8Array(LAMZU_ATLANTIS_PACKET_LENGTH);
  packet[0] = spec.command;
  packet[2] = (address >> 8) & 0xff;
  packet[3] = address & 0xff;
  packet[4] = payload.length;
  packet.set(payload, LAMZU_ATLANTIS_PAYLOAD_OFFSET);
  packet[LAMZU_ATLANTIS_PACKET_LENGTH - 1] = pulsarPacketChecksum(packet);
  return packet;
}

/**
 * Decodes an input report body (the 16 bytes WebHID delivers, report id
 * excluded). Returns null for a truncated frame or a failed checksum so a
 * caller waiting on a reply can skip the unsolicited reports this firmware
 * emits rather than throwing on them.
 */
export function lamzuAtlantisDecodeReply(body: Uint8Array): LamzuAtlantisReply | null {
  if (body.length < LAMZU_ATLANTIS_PACKET_LENGTH) return null;
  const packet = body.subarray(0, LAMZU_ATLANTIS_PACKET_LENGTH);
  if (pulsarPacketChecksum(packet) !== packet[LAMZU_ATLANTIS_PACKET_LENGTH - 1]) return null;
  return {
    command: packet[0] ?? 0,
    error: packet[1] ?? 0,
    address: ((packet[2] ?? 0) << 8) | (packet[3] ?? 0),
    payload: packet.slice(
      LAMZU_ATLANTIS_PAYLOAD_OFFSET,
      LAMZU_ATLANTIS_PAYLOAD_OFFSET + LAMZU_ATLANTIS_MAX_PAYLOAD,
    ),
    declaredLength: Math.min(packet[4] ?? 0, LAMZU_ATLANTIS_MAX_PAYLOAD),
  };
}

/**
 * A flash field is stored with a trailing checksum byte, so the value bytes
 * and that byte together must sum to 0x55.
 */
export function lamzuAtlantisFieldIsIntact(field: Uint8Array): boolean {
  let sum = 0;
  for (const byte of field) sum = (sum + byte) & 0xff;
  return sum === 0x55;
}

/** Appends the trailing checksum a flash field is stored with. */
export function lamzuAtlantisSealField(values: readonly number[]): number[] {
  let sum = 0;
  for (const value of values) sum = (sum + value) & 0xff;
  return [...values, (0x55 - sum) & 0xff];
}

export interface LamzuAtlantisDpiStage {
  x: number;
  y: number;
}

/**
 * Decodes a DPI stage field: `[x, y, flags, checksum]`, where the flags byte
 * carries each axis's ninth and tenth bits — bits 2-3 for x, bits 6-7 for y,
 * which is how `pulsarVgnEncodeDpi` lays them out.
 *
 * `pulsarVgnDecodeDpi` cannot be used for reads here: it returns null unless
 * the two axis bytes are identical, because the Pulsar driver only ever
 * writes them in lockstep. A Lamzu configured with separate axes stores a
 * perfectly valid field that would then read as corrupt.
 */
export function lamzuAtlantisDecodeDpiStage(field: Uint8Array): LamzuAtlantisDpiStage | null {
  if (field.length < LAMZU_ATLANTIS_STAGE_STRIDE || !lamzuAtlantisFieldIsIntact(field)) return null;
  const flags = field[2] ?? 0;
  const axis = (low: number, high: number) => (((high & 0x03) << 8) + low + 1) * LAMZU_ATLANTIS_DPI_STEP;
  return {
    x: axis(field[0] ?? 0, flags >> 2),
    y: axis(field[1] ?? 0, flags >> 6),
  };
}

/**
 * Encodes one DPI as a legacy stage field, both axes in lockstep: the same
 * bytes as `pulsarVgnEncodeDpi`, but over the whole ten bits the decoder above
 * reads (50 to 51,200 DPI) rather than the Pulsar ceiling of 26,000. Each
 * product's own maxDpi still bounds what a client writes.
 */
export function lamzuAtlantisEncodeDpiStage(dpi: number): number[] {
  const value = dpi / LAMZU_ATLANTIS_DPI_STEP - 1;
  if (!Number.isInteger(value) || value < 0 || value > 0x3ff) {
    throw new Error("A legacy DPI stage holds 50 to 51,200 DPI in 50 DPI steps.");
  }
  const low = value & 0xff;
  const high = value >> 8;
  return lamzuAtlantisSealField([low, low, (high << 2) | (high << 6)]);
}

/**
 * The 3955 sensor's two value bands, from the vendor configurator's sensor
 * table. Below 42,002 DPI the value stores as-is; above, halved, with the
 * band marker in both nibbles of the flags byte (DPIex 17 = 0x11).
 */
const SENSOR3955_DPI_RANGES = [
  { min: 1, flags: 0x00 },
  { min: 42002, flags: 0x11 },
] as const;

/** One doubling per set bit in a flags nibble, exactly as the vendor decodes. */
function sensor3955BandMultiplier(flags: number): number {
  let multiplier = 1;
  if (flags & 0x01) multiplier *= 2;
  if (flags & 0x02) multiplier *= 2;
  return multiplier;
}

/**
 * Decodes a 3955 DPI record: `[xLo, xHi, yLo, yHi, flags, checksum]`. The
 * value stores as `dpi / multiplier - 1`, 16 bits per axis, with flags bits
 * 2-3 carrying x's value bits 16-17, bits 6-7 y's, and bits 0-1 / 4-5 each
 * axis's band marker.
 *
 * Transcribed from the vendor configurator's read routine and checked
 * against its encoder, which writes 1,600 DPI as `3f 06 3f 06 00 cb`. That is
 * the encoder's output, not a capture: the vendor tool showed a V8S on 1,600
 * while the legacy field at 12 said 400, but no OpenMouse build has read this
 * region from hardware yet.
 */
export function lamzuAtlantisDecodeDpiStage3955(field: Uint8Array): LamzuAtlantisDpiStage | null {
  if (field.length < LAMZU_ATLANTIS_SENSOR3955_STAGE_STRIDE || !lamzuAtlantisFieldIsIntact(field)) return null;
  const flags = field[4] ?? 0;
  const decode = (low: number, high: number, extraBits: number, bandFlags: number) =>
    (((extraBits << 16) | (high << 8) | low) + 1) * sensor3955BandMultiplier(bandFlags);
  return {
    x: decode(field[0] ?? 0, field[1] ?? 0, (flags >> 2) & 0x03, flags & 0x03),
    y: decode(field[2] ?? 0, field[3] ?? 0, (flags >> 6) & 0x03, (flags >> 4) & 0x03),
  };
}

/**
 * Encodes one DPI as a 3955 record, both axes in lockstep the way the vendor
 * configurator writes them. A stage the vendor app had set to separate x and
 * y comes back symmetric; asymmetric records are not attempted without
 * hardware to confirm the flags layout for them.
 */
export function lamzuAtlantisEncodeDpiStage3955(dpi: number): number[] {
  let band = SENSOR3955_DPI_RANGES.length - 1;
  while (band > 0 && dpi < SENSOR3955_DPI_RANGES[band].min) band -= 1;
  const range = SENSOR3955_DPI_RANGES[band];
  const value = Math.floor(dpi / sensor3955BandMultiplier(range.flags)) - 1;
  const extraBits = value >> 16;
  const flags = (extraBits << 2) | (extraBits << 6) | range.flags | (range.flags << 4);
  return lamzuAtlantisSealField([
    value & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
    (value >> 8) & 0xff,
    flags & 0xff,
  ]);
}

export function lamzuAtlantisDecodePollingRate(
  raw: number,
  family: LamzuAtlantisRateFamily = "wired",
): number | null {
  const table = family === "pulsar"
    ? LAMZU_ATLANTIS_PULSAR_POLLING_RATES
    : LAMZU_ATLANTIS_POLLING_RATES;
  return table.find(([encoded]) => encoded === raw)?.[1] ?? null;
}

/**
 * Picks the byte for a rate. Only 1,000 Hz is ambiguous, and the transport's
 * declared family decides it rather than anything inferred from the rate list.
 */
export function lamzuAtlantisEncodePollingRate(
  hertz: number,
  family: LamzuAtlantisRateFamily,
): number | null {
  if (family === "pulsar") {
    return LAMZU_ATLANTIS_PULSAR_POLLING_RATES.find(([, rate]) => rate === hertz)?.[0] ?? null;
  }
  const candidates = LAMZU_ATLANTIS_POLLING_RATES.filter(([, rate]) => rate === hertz);
  if (candidates.length === 0) return null;
  const preferred = family === "receiver"
    ? candidates.find(([encoded]) => encoded >= 0x10)
    : candidates.find(([encoded]) => encoded <= 0x08);
  return (preferred ?? candidates[0])?.[0] ?? null;
}

export function lamzuAtlantisDecodeLiftOffDistance(raw: number): LamzuAtlantisLiftOffDistance | null {
  return LAMZU_ATLANTIS_LIFT_OFF_DISTANCES.find(([encoded]) => encoded === raw)?.[1] ?? null;
}

export function lamzuAtlantisEncodeLiftOffDistance(value: string): number | null {
  return LAMZU_ATLANTIS_LIFT_OFF_DISTANCES.find(([, name]) => name === value)?.[0] ?? null;
}

/**
 * The status shape for a product whose lift-off byte is a scale of codes 1 to
 * n (see `liftOffMillimetres`), or null for a code outside it. The heights are
 * uneven on the 3955 (0.7, 0.9, 1.2, 1.4, 1.6 mm), so every code's height
 * travels with the scale rather than being interpolated.
 */
export function lamzuAtlantisLiftOffScale(
  code: number,
  millimetres: readonly number[],
): NonNullable<MouseStatus["liftOffScale"]> | null {
  const height = millimetres[code - 1];
  if (!Number.isInteger(code) || height === undefined) return null;
  return {
    value: code,
    min: 1,
    max: millimetres.length,
    millimetres: height,
    minMillimetres: millimetres[0]!,
    maxMillimetres: millimetres[millimetres.length - 1]!,
    millimetresByCode: [...millimetres],
  };
}

/** The coarse stop for a lift-off height, on the thresholds the Finalmouse scale uses. */
export function lamzuAtlantisNearestLiftOffStop(millimetres: number): NonNullable<MouseStatus["liftOffDistance"]> {
  return millimetres < 1 ? "Low" : millimetres < 1.5 ? "Medium" : "High";
}

/** The angle-tune byte is a signed degree count. */
export function lamzuAtlantisDecodeAngleTuning(raw: number): number {
  return raw >= 0x80 ? raw - 0x100 : raw;
}

export function lamzuAtlantisEncodeAngleTuning(degrees: number): number {
  return degrees & 0xff;
}

export interface LamzuAtlantisBattery {
  percent: number | null;
  millivolts: number | null;
  charging: boolean;
}

/**
 * Battery reply payload: [percent, charging, millivolts high, millivolts low].
 *
 * lamzu-cfg reads only the millivolts and derives a percentage linearly
 * between 3,050 and 4,200 mV, which disagrees with the mouse while it charges:
 * at 4,239 mV that estimate says 100%, where both the reported byte and
 * Lamzu's configurator said 95%. The reported byte wins; the voltage is kept
 * for display.
 */
export function lamzuAtlantisDecodeBattery(payload: Uint8Array): LamzuAtlantisBattery {
  if (payload.length < 4) return { percent: null, millivolts: null, charging: false };
  const percent = payload[0] ?? 0;
  const millivolts = ((payload[2] ?? 0) << 8) | (payload[3] ?? 0);
  return {
    percent: percent <= 100 ? percent : null,
    millivolts: millivolts > 0 ? millivolts : null,
    charging: (payload[1] ?? 0) === 1,
  };
}

/** Formats the 0x12 firmware reply the same way the Pulsar driver does. */
export function lamzuAtlantisDecodeFirmware(label: string, payload: Uint8Array): string | null {
  if (payload.length < 2) return null;
  return `${label} v${payload[0] ?? 0}.${(payload[1] ?? 0).toString(16).padStart(2, "0")}`;
}

export function lamzuAtlantisProduct(vendorId: number, productId: number): LamzuAtlantisProduct | undefined {
  if (vendorId !== LAMZU_ATLANTIS_VENDOR_ID) return undefined;
  return LAMZU_ATLANTIS_PRODUCTS.get(productId);
}
