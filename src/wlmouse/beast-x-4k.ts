/**
 * Beast X 4K (36a7:a887) settings protocol. Unlike the rest of the WLmouse
 * range it never answers compx feature reports: commands go out as 64-byte
 * output report 4 and each answer comes back as input report 4.
 *
 * Report body, after the report id:
 *   [0..1]  CRC-16/MODBUS of [2..30], little-endian
 *   [2]     command; [3] data length; [4..5] address, little-endian
 *   [6]     reply status, 0xfe or 0xff on error (0 in requests)
 *   [7..30] data, at most 24 bytes
 *
 * Decoded from a USB capture of WLmouse's desktop software driving a Beast X
 * 4K, and from that software's V0109 build for the read command and the
 * settings layout. V0109 checksums with a plain byte sum; the newer build in
 * the capture, which the firmware answered, uses the CRC above.
 */
export const WLMOUSE_4K_PRODUCT_ID = 0xa887;
export const WLMOUSE_4K_REPORT_ID = 4;
export const WLMOUSE_4K_PACKET_LENGTH = 63;
export const WLMOUSE_4K_CHUNK_LENGTH = 24;
export const WLMOUSE_4K_COMMAND = {
  openSession: 0x01,
  closeSession: 0x02,
  readSettings: 0x05,
  writeSettings: 0x06,
} as const;
export const WLMOUSE_4K_STATUS_ERRORS: ReadonlySet<number> = new Set([0xfe, 0xff]);

/**
 * One onboard profile's settings, read and written at `profile << 7`. The
 * active profile number is the byte at address 0.
 *   [01..08] lighting, [58..59] a fixed 600, [6b..70] the PC clock the vendor
 *   software pushes on every write; all preserved as read.
 */
export const WLMOUSE_4K_SETTINGS_LENGTH = 0x75;
export const WLMOUSE_4K_SETTINGS = {
  stageCount: 0x09,
  highMode: 0x0a,
  pollingIndex: 0x0b,
  activeStage: 0x0c,
  /** 0 = 1 mm, 1 = 2 mm. */
  liftOff: 0x0d,
  /** Eight 9-byte slots: [enabled][separate axes][X u16 LE][Y u16 LE][R][G][B]. */
  stages: 0x0e,
  sleepSeconds: 0x56,
  debounceMs: 0x5a,
  slamClickPrevention: 0x5b,
  motionSync: 0x5c,
} as const;
export const WLMOUSE_4K_STAGE_LENGTH = 9;
export const WLMOUSE_4K_STAGE_SLOTS = 8;
export const WLMOUSE_4K_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000] as const;

export interface Wlmouse4kReply {
  command: number;
  length: number;
  address: number;
  status: number;
  data: Uint8Array;
}

export interface Wlmouse4kSettings {
  stageCount: number;
  activeStage: number;
  /** X DPI of all eight slots; only the first `stageCount` are cycled. */
  stageDpis: number[];
  pollingRateHz: number | null;
  highMode: boolean;
  liftOffMm: number;
  sleepSeconds: number;
  debounceMs: number;
  slamClickPrevention: boolean;
  motionSync: boolean;
}

export function wlmouse4kCrc(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index]! & 0xff;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

/** A request body; reads pass `length` and no data. */
export function wlmouse4kEncodeRequest(
  command: number,
  address = 0,
  data: ArrayLike<number> = [],
  length = data.length,
): Uint8Array<ArrayBuffer> {
  if (length > WLMOUSE_4K_CHUNK_LENGTH || data.length > length) {
    throw new Error(`A Beast X 4K request carries at most ${WLMOUSE_4K_CHUNK_LENGTH} bytes.`);
  }
  const body = new Uint8Array(WLMOUSE_4K_PACKET_LENGTH);
  body[2] = command;
  body[3] = length;
  body[4] = address & 0xff;
  body[5] = (address >> 8) & 0xff;
  body.set(Array.from(data), 7);
  const crc = wlmouse4kCrc(body.subarray(2, 31));
  body[0] = crc & 0xff;
  body[1] = crc >> 8;
  return body;
}

export function wlmouse4kDecodeReply(body: Uint8Array): Wlmouse4kReply | null {
  if (body.length < 31) return null;
  const length = Math.min(body[3]!, WLMOUSE_4K_CHUNK_LENGTH);
  return {
    command: body[2]!,
    length,
    address: body[4]! | (body[5]! << 8),
    status: body[6]!,
    data: body.slice(7, 7 + length),
  };
}

export function wlmouse4kDecodeSettings(block: Uint8Array): Wlmouse4kSettings {
  if (block.length < WLMOUSE_4K_SETTINGS_LENGTH) throw new Error("The Beast X 4K returned a truncated settings block.");
  const at = WLMOUSE_4K_SETTINGS;
  const stageCount = Math.min(Math.max(block[at.stageCount]!, 1), WLMOUSE_4K_STAGE_SLOTS);
  return {
    stageCount,
    activeStage: Math.min(block[at.activeStage]!, stageCount - 1),
    stageDpis: Array.from({ length: WLMOUSE_4K_STAGE_SLOTS }, (_, stage) => {
      const x = at.stages + stage * WLMOUSE_4K_STAGE_LENGTH + 2;
      return block[x]! | (block[x + 1]! << 8);
    }),
    pollingRateHz: WLMOUSE_4K_POLLING_RATES[block[at.pollingIndex]!] ?? null,
    highMode: block[at.highMode] === 1,
    liftOffMm: block[at.liftOff] === 1 ? 2 : 1,
    sleepSeconds: block[at.sleepSeconds]! | (block[at.sleepSeconds + 1]! << 8),
    debounceMs: block[at.debounceMs]!,
    slamClickPrevention: block[at.slamClickPrevention] === 1,
    motionSync: block[at.motionSync] === 1,
  };
}
