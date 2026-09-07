/**
 * Corsair NXP-family configuration protocol as spoken by the NIGHTSWORD RGB
 * (firmware 3.41), reconstructed from ckb-next's `nxp_proto.h` / `dpi.c` and
 * corrected against real hardware. The full trace lives in
 * `captures/corsair-nightsword/PROTOCOL.md`.
 *
 * Transport: 64-byte feature reports on report id 0 over the interface whose
 * collection is usage page 0xffc2, usage 4. A GET is `sendFeatureReport` then
 * `receiveFeatureReport`; the reply echoes request bytes 0–3. A SET produces
 * no reply at all — the driver confirms it with the matching GET.
 *
 * Byte order is asymmetric on this firmware: DPI X/Y arrive big-endian in GET
 * replies but must be sent little-endian in SET payloads. Identity fields are
 * little-endian. Nothing here transports bytes; the WebHID client lives in
 * `src/drivers/corsair/hid.ts`.
 */
export const CORSAIR_VENDOR_ID = 0x1b1c;
export const CORSAIR_USAGE_PAGE = 0xffc2;
/** Usage of the config collection. MI_00 also carries an 0xffc2 collection with usage 3 that never answers. */
export const CORSAIR_CONFIG_USAGE = 4;
export const CORSAIR_REPORT_ID = 0;
export const CORSAIR_PACKET_SIZE = 64;
export const CORSAIR_NIGHTSWORD_PRODUCT_ID = 0x1b5c;

export interface CorsairDeviceDefinition {
  name: string;
  dpiMax: number;
  dpiStep: number;
  /** Number of `MOUSE_DPIPROF` slots (d0–d5 on the NIGHTSWORD). */
  stages: number;
  /** Firmware the protocol was exercised on. */
  verifiedFirmware: string;
}

export const CORSAIR_PRODUCTS: ReadonlyMap<number, CorsairDeviceDefinition> = new Map([
  [CORSAIR_NIGHTSWORD_PRODUCT_ID, {
    name: "NIGHTSWORD RGB",
    dpiMax: 18_000,
    dpiStep: 1,
    stages: 6,
    verifiedFirmware: "3.41",
  }],
]);

export const CORSAIR_PRODUCT_IDS: readonly number[] = [...CORSAIR_PRODUCTS.keys()];

export const CORSAIR_COMMAND = {
  get: 0x0e,
  set: 0x07,
} as const;

export const CORSAIR_FIELD = {
  ident: 0x01,
  pollRate: 0x0a,
  mouse: 0x13,
  profileId: 0x15,
  profileName: 0x16,
} as const;

/** `FIELD_MOUSE` subcommands (packet byte 2). */
export const CORSAIR_MOUSE = {
  dpi: 0x02,
  lift: 0x03,
  snap: 0x04,
  dpiMask: 0x05,
  /** OR'd with the stage index: d0–d5. */
  dpiProfile: 0xd0,
} as const;

/**
 * Packet byte 3. Zero addresses the live/software settings; 1 would address the
 * stored hardware profile, which returns zeros on the NIGHTSWORD. Live writes
 * do not survive a power cycle.
 */
export const CORSAIR_LIVE_PROFILE = 0;
export const CORSAIR_STAGE_COUNT = 6;
/**
 * Slot d0 is iCUE's "Sniper" stage (held-button DPI, yellow indicator); iCUE's
 * numbered stages 1–5 are slots d1–d5. `MOUSE_DPI` reports the slot index, so
 * a current stage of 2 means iCUE's Stage 2. Confirmed against the iCUE DPI
 * panel on fw 3.41.
 */
export const CORSAIR_SNIPER_STAGE = 0;
export const CORSAIR_POLL_INTERVALS_MS = [1, 2, 4, 8] as const;
export type CorsairPollIntervalMs = (typeof CORSAIR_POLL_INTERVALS_MS)[number];

export type CorsairRgb = readonly [number, number, number];

export interface CorsairIdent {
  firmware: number;
  bootloader: number;
  vendorId: number;
  productId: number;
  /** USB polling interval in milliseconds: 1 = 1000 Hz, 8 = 125 Hz. */
  pollIntervalMs: number;
  pollingRateHz: number;
}

export interface CorsairDpiStage {
  x: number;
  y: number;
  rgb: CorsairRgb;
}

export interface CorsairCurrentDpi {
  stage: number;
  x: number;
  y: number;
}

export function corsairDevice(productId: number): CorsairDeviceDefinition {
  const definition = CORSAIR_PRODUCTS.get(productId);
  if (!definition) throw new Error(`Unsupported Corsair product id 0x${productId.toString(16)}.`);
  return definition;
}

/** A zero-padded 64-byte packet with `bytes` at the front. */
export function corsairPacket(...bytes: number[]): Uint8Array {
  if (bytes.length > CORSAIR_PACKET_SIZE) throw new Error("Corsair packet payload exceeds 64 bytes.");
  const packet = new Uint8Array(CORSAIR_PACKET_SIZE);
  packet.set(bytes.map(byteValue));
  return packet;
}

/** `0x0341` → "3.41", matching how iCUE and ckb-next print the version. */
export function corsairFormatVersion(word: number): string {
  return `${(word >> 8) & 0xff}.${(word & 0xff).toString(16).padStart(2, "0")}`;
}

/** Slot indices whose bit is set in the `MOUSE_DPIMASK` byte. */
export function corsairEnabledStages(mask: number, stages = CORSAIR_STAGE_COUNT): number[] {
  const enabled: number[] = [];
  for (let stage = 0; stage < stages; stage += 1) {
    if (mask & (1 << stage)) enabled.push(stage);
  }
  return enabled;
}

export const corsairEncode = {
  ident: (): Uint8Array => corsairPacket(CORSAIR_COMMAND.get, CORSAIR_FIELD.ident, 0),
  dpiMask: (): Uint8Array => corsairPacket(CORSAIR_COMMAND.get, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.dpiMask, CORSAIR_LIVE_PROFILE),
  dpiStage: (): Uint8Array => corsairPacket(CORSAIR_COMMAND.get, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.dpi, CORSAIR_LIVE_PROFILE),
  lift: (): Uint8Array => corsairPacket(CORSAIR_COMMAND.get, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.lift, CORSAIR_LIVE_PROFILE),
  snap: (): Uint8Array => corsairPacket(CORSAIR_COMMAND.get, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.snap, CORSAIR_LIVE_PROFILE),
  stage: (stage: number): Uint8Array =>
    corsairPacket(CORSAIR_COMMAND.get, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.dpiProfile | stageIndex(stage), CORSAIR_LIVE_PROFILE),

  // Phase-2 writes. Encoded here so the byte layout is tested, but the
  // read-only driver never sends them. None of these get a reply.
  setStage: (stage: number): Uint8Array =>
    corsairPacket(CORSAIR_COMMAND.set, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.dpi, CORSAIR_LIVE_PROFILE, stageIndex(stage)),
  setDpiMask: (mask: number): Uint8Array => {
    if (!Number.isInteger(mask) || mask < 0 || mask >= 1 << CORSAIR_STAGE_COUNT) {
      throw new Error(`Corsair DPI stage mask must be 0x00–0x${((1 << CORSAIR_STAGE_COUNT) - 1).toString(16)}.`);
    }
    return corsairPacket(CORSAIR_COMMAND.set, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.dpiMask, CORSAIR_LIVE_PROFILE, mask);
  },
  /**
   * SET payloads carry DPI little-endian. RGB is mandatory: a stage write
   * without bytes 9–11 clears the stage colour, so a caller must read the stage
   * first and pass its colour back.
   */
  setStageDpi: (stage: number, x: number, y: number, rgb: CorsairRgb): Uint8Array => {
    dpiValue(x);
    dpiValue(y);
    if (rgb.length !== 3) throw new Error("Corsair stage colour must be an [r, g, b] triple.");
    return corsairPacket(
      CORSAIR_COMMAND.set, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.dpiProfile | stageIndex(stage), CORSAIR_LIVE_PROFILE,
      x !== y ? 1 : 0,
      x & 0xff, x >> 8,
      y & 0xff, y >> 8,
      ...rgb,
    );
  },
  setLift: (height: number): Uint8Array =>
    corsairPacket(CORSAIR_COMMAND.set, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.lift, CORSAIR_LIVE_PROFILE, byteValue(height)),
  /** Trailing 0x05 mirrors ckb-next; hardware accepts the write with or without it. */
  setSnap: (enabled: boolean): Uint8Array =>
    corsairPacket(CORSAIR_COMMAND.set, CORSAIR_FIELD.mouse, CORSAIR_MOUSE.snap, CORSAIR_LIVE_PROFILE, enabled ? 1 : 0, 0x05),
  /** The device re-enumerates after this; the WebHID handle closes. */
  setPollMs: (intervalMs: CorsairPollIntervalMs): Uint8Array => {
    if (!CORSAIR_POLL_INTERVALS_MS.includes(intervalMs)) throw new Error("Corsair polling interval must be 1, 2, 4, or 8 ms.");
    return corsairPacket(CORSAIR_COMMAND.set, CORSAIR_FIELD.pollRate, 0, 0, intervalMs);
  },
} as const;

/** True when a GET reply echoes the request's command, field, subcommand, and profile bytes. */
export function corsairIsEcho(request: Uint8Array, reply: Uint8Array): boolean {
  if (reply.length < 4 || request.length < 4) return false;
  return reply[0] === request[0] && reply[1] === request[1] && reply[2] === request[2] && reply[3] === request[3];
}

export const corsairDecode = {
  ident: (reply: Uint8Array): CorsairIdent => {
    requireLength(reply, 17, "identity");
    const pollIntervalMs = reply[16]!;
    return {
      firmware: u16le(reply, 8),
      bootloader: u16le(reply, 10),
      vendorId: u16le(reply, 12),
      productId: u16le(reply, 14),
      pollIntervalMs,
      pollingRateHz: pollIntervalMs > 0 ? Math.round(1000 / pollIntervalMs) : 0,
    };
  },
  byte4: (reply: Uint8Array): number => {
    requireLength(reply, 5, "single-byte");
    return reply[4]!;
  },
  dpiMask: (reply: Uint8Array): number => corsairDecode.byte4(reply),
  lift: (reply: Uint8Array): number => corsairDecode.byte4(reply),
  snap: (reply: Uint8Array): boolean => corsairDecode.byte4(reply) !== 0,
  /** GET replies carry DPI big-endian. */
  dpiStage: (reply: Uint8Array): CorsairCurrentDpi => {
    requireLength(reply, 9, "current-DPI");
    return { stage: reply[4]!, x: u16be(reply, 5), y: u16be(reply, 7) };
  },
  stage: (reply: Uint8Array): CorsairDpiStage => {
    requireLength(reply, 12, "DPI-stage");
    return { x: u16be(reply, 5), y: u16be(reply, 7), rgb: [reply[9]!, reply[10]!, reply[11]!] };
  },
} as const;

export function corsairRgbHex(rgb: CorsairRgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** "#rrggbb" (case-insensitive, hash optional) → [r, g, b]. */
export function corsairParseRgbHex(color: string): CorsairRgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) throw new Error(`Corsair stage colour must be #rrggbb, got "${color}".`);
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Lift-off height is a raw 1–5 byte (every value accepted on fw 3.41). iCUE
 * offers no manual lift-off control for this mouse — only its spiral surface
 * calibration — so there are no vendor labels to match; the 1–5 scale is the
 * one ckb-next exposes as a slider. The three-stop names are this driver's own
 * mapping onto it: Low = 1, Medium = 3, High = 5 on write; 1–2 → Low,
 * 3 → Medium, 4–5 → High on read.
 */
export const CORSAIR_LIFT_MIN = 1;
export const CORSAIR_LIFT_MAX = 5;
export type CorsairLiftName = "Low" | "Medium" | "High";
export const CORSAIR_LIFT_LEVELS: Readonly<Record<CorsairLiftName, number>> = { Low: 1, Medium: 3, High: 5 };

export function corsairLiftName(raw: number): CorsairLiftName | null {
  if (!Number.isInteger(raw) || raw < CORSAIR_LIFT_MIN || raw > CORSAIR_LIFT_MAX) return null;
  return raw <= 2 ? "Low" : raw === 3 ? "Medium" : "High";
}

function stageIndex(stage: number): number {
  if (!Number.isInteger(stage) || stage < 0 || stage >= CORSAIR_STAGE_COUNT) {
    throw new Error(`Corsair DPI stage must be 0–${CORSAIR_STAGE_COUNT - 1}.`);
  }
  return stage;
}

function dpiValue(dpi: number): number {
  if (!Number.isInteger(dpi) || dpi < 0 || dpi > 0xffff) throw new Error("Corsair DPI must be an integer from 0 to 65535.");
  return dpi;
}

function byteValue(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`Corsair packet byte ${value} is out of range.`);
  return value;
}

function requireLength(reply: Uint8Array, length: number, what: string): void {
  if (reply.length < length) throw new Error(`Corsair ${what} reply is shorter than ${length} bytes.`);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}
