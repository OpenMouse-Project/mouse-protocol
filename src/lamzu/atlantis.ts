import {
  PULSAR_COMMAND,
  PULSAR_CONFIG_PACKET_LENGTH,
  PULSAR_CONFIG_REPORT_ID,
  PULSAR_FLASH,
  pulsarPacketChecksum,
} from "../pulsar/index.js";

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
} as const;

export const LAMZU_ATLANTIS_STAGE_STRIDE = 4;
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

export interface LamzuAtlantisProduct {
  model: string;
  wireless: boolean;
  pollingRates: readonly number[];
  /** False until this exact product id has been exercised on hardware. */
  verified: boolean;
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
 * 0xf50f (the mouse on its cable) is confirmed on hardware. The receivers come
 * from Lamzu's shipped device table; the protocol is the same either way, so
 * the risk on those is a wrong rate list rather than a dead device.
 */
export const LAMZU_ATLANTIS_PRODUCTS: ReadonlyMap<number, LamzuAtlantisProduct> = new Map([
  [0xf50f, { model: "Atlantis", wireless: false, pollingRates: RATES_WIRED, verified: true }],
  [0xf50d, { model: "Atlantis", wireless: true, pollingRates: RATES_WIRED, verified: false }],
  [0xf510, { model: "Atlantis", wireless: true, pollingRates: RATES_4K, verified: false }],
  [0xf517, { model: "Atlantis", wireless: true, pollingRates: RATES_4K, verified: false }],
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

export function lamzuAtlantisDecodePollingRate(raw: number): number | null {
  return LAMZU_ATLANTIS_POLLING_RATES.find(([encoded]) => encoded === raw)?.[1] ?? null;
}

/**
 * Picks the byte for a rate. 1,000 Hz has two encodings; the wired family's
 * 0x01 is used unless the product's rate list reaches past 1,000 Hz, which
 * only the receivers do.
 */
export function lamzuAtlantisEncodePollingRate(hertz: number, supported: readonly number[]): number | null {
  const candidates = LAMZU_ATLANTIS_POLLING_RATES.filter(([, rate]) => rate === hertz);
  if (candidates.length === 0) return null;
  const receiverFamily = supported.some((rate) => rate > 1000);
  const preferred = receiverFamily
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
