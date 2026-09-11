/**
 * HyperX / Kingston NGenuity2 protocol codecs for the Pulsefire Haste family.
 *
 * Transport-independent: pure encode/decode helpers, constants, and types.  The
 * actual HID I/O lives in the driver (src/drivers/hyperx/hid.ts).
 *
 * Protocol overview (reverse-engineered by evan-razzaque/open-pulsefire-haste,
 * adapted from santeri3700/hyperx_pulsefire_dart_reverse_engineering):
 * - All packets are 64 bytes, zero-padded.
 * - Byte 0 is the command opcode; remaining bytes are the payload.
 * - Commands travel as vendor-defined *output* reports (interrupt OUT) and
 *   replies come back as *input* reports (interrupt IN) on a single 64-byte
 *   vendor collection (usage page 0xFF00, usage 0x01).  There is no feature
 *   report — the interface's HID descriptor is only ~25 bytes and declares just
 *   one input and one output report.
 * - Reads (0x46, 0x50, 0x51, 0x52, 0x53, 0x54) echo the request's opcode at
 *   byte 0.  Writes (0xD0, 0xD2, 0xD3, 0xD4, 0xDE) are fire-and-forget: the
 *   mouse ACKs nothing, so a getter must be read back to confirm.
 * - The mouse operates in "direct" mode: writes apply immediately to the live
 *   profile and revert on power cycle unless a SAVE packet is sent too.
 */

// ── Vendor constants ────────────────────────────────────────────────────────

export const HYPERX_VENDOR_ID_KINGSTON = 0x0951;
export const HYPERX_VENDOR_ID_HP = 0x03f0;

/** Vendor HID collection that carries the control channel. */
export const HYPERX_USAGE_PAGE = 0xff00;
export const HYPERX_USAGE = 0x01;

// ── Product IDs ─────────────────────────────────────────────────────────────

/**
 * Known Pulsefire Haste product ids.
 *
 * The original wired model shipped under Kingston VID 0x0951 (PID 0x1727) and
 * later under HP VID 0x03f0 (PIDs 0x0f8f wired, 0x048e wired-mode alt).  The
 * wireless dongle enumerates as 0x028e.
 */
export const HYPERX_PULSEFIRE_HASTE_KINGSTON_PIDS: ReadonlySet<number> = new Set([
  0x1727, // Pulsefire Haste wired (Kingston era)
]);

export const HYPERX_PULSEFIRE_HASTE_HP_PIDS: ReadonlySet<number> = new Set([
  0x0f8f, // Pulsefire Haste wired (HP era)
  0x048e, // Pulsefire Haste wired-mode alt (HP era)
  0x028e, // Pulsefire Haste wireless dongle (HP era)
]);

export const HYPERX_PULSEFIRE_HASTE_PIDS: ReadonlySet<number> = new Set([
  ...HYPERX_PULSEFIRE_HASTE_KINGSTON_PIDS,
  ...HYPERX_PULSEFIRE_HASTE_HP_PIDS,
]);

export const HYPERX_PIDS: ReadonlySet<number> = HYPERX_PULSEFIRE_HASTE_PIDS;

// ── Command opcodes ─────────────────────────────────────────────────────────

export const CMD = {
  /** Read connection status. */
  GET_CONNECTION: 0x46,
  /** Read hardware info: product/vendor id, firmware, product string. */
  GET_HARDWARE_INFO: 0x50,
  /** Read heartbeat: battery percent and charging status (wireless only). */
  GET_BATTERY: 0x51,
  /** Read saved LED configuration (logo + scroll wheel). */
  GET_LED: 0x52,
  /** Read DPI settings: every profile's DPI, active profile, lift-off distance. */
  GET_DPI: 0x53,
  /** Read button assignments. */
  GET_BUTTONS: 0x54,

  /** Set polling rate. */
  SET_POLLING_RATE: 0xd0,
  /** Multi-purpose DPI command: select profile, set DPI, set LOD, etc. */
  SET_DPI: 0xd3,
  /** Set LED. */
  SET_LED: 0xd2,
  /** Set button assignment. */
  SET_BUTTON: 0xd4,
  /** Save settings to onboard memory. */
  SAVE: 0xde,
} as const;

// ── Polling rate encoding ───────────────────────────────────────────────────

export const POLLING_RATE_ENCODE: ReadonlyMap<number, number> = new Map([
  [125, 0x00],
  [250, 0x01],
  [500, 0x02],
  [1000, 0x03],
]);

export const POLLING_RATE_DECODE: ReadonlyMap<number, number> = new Map(
  [...POLLING_RATE_ENCODE].map(([hz, code]) => [code, hz]),
);

export const SUPPORTED_POLLING_RATES: readonly number[] = [...POLLING_RATE_ENCODE.keys()];

// ── DPI encoding ────────────────────────────────────────────────────────────

/**
 * DPI is stored as `DPI / 100` in a 16-bit little-endian field.  The Pulsefire
 * Haste allows 200–16,000 DPI in 100-DPI steps and has one DPI value per
 * profile (no separate X/Y axes).
 */
export const DPI_STEP = 100;
export const DPI_MIN = 200;
export const DPI_MAX = 16000;

export function encodeDpi(dpi: number): number {
  return Math.round(dpi / DPI_STEP);
}

export function decodeDpi(encoded: number): number {
  return encoded * DPI_STEP;
}

export function isValidDpi(dpi: number): boolean {
  return Number.isInteger(dpi) && dpi >= DPI_MIN && dpi <= DPI_MAX && dpi % DPI_STEP === 0;
}

/** Every valid DPI value the protocol can represent. */
export function dpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = DPI_MIN; dpi <= DPI_MAX; dpi += DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

// ── Lift-off distance encoding ──────────────────────────────────────────────

export type LiftOffDistance = "Low" | "High";

export const LOD_ENCODE: ReadonlyMap<LiftOffDistance, number> = new Map([
  ["Low", 1],
  ["High", 2],
]);

export const LOD_DECODE: ReadonlyMap<number, LiftOffDistance> = new Map(
  [...LOD_ENCODE].map(([name, mm]) => [mm, name]),
);

export function decodeLod(encoded: number): LiftOffDistance | null {
  return LOD_DECODE.get(encoded) ?? null;
}

export function encodeLod(distance: LiftOffDistance): number {
  return LOD_ENCODE.get(distance) ?? 1;
}

// ── Connection status encoding ──────────────────────────────────────────────

export type ConnectionType = "Wired" | "Wireless" | null;

export const CONNECTION_TYPE_DECODE: ReadonlyMap<number, ConnectionType> = new Map([
  [0x01, "Wireless"],
  [0x02, "Wired"],
]);

export function decodeConnection(raw: Uint8Array): ConnectionType | null {
  if (raw.length < 4 || raw[0] !== CMD.GET_CONNECTION) return null;
  return CONNECTION_TYPE_DECODE.get(raw[3]) ?? null;
}

// ── Hardware info (0x50) ────────────────────────────────────────────────────

export interface HardwareInfo {
  vendorId: number;
  productId: number;
  firmware: string;
  product: string;
}

/** Decode a two-digit BCD byte, e.g. 0x41 → 41. */
function bcdByte(byte: number): number {
  return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
}

/**
 * Decode a GET_HARDWARE_INFO (0x50) response.
 *
 * Layout (64 bytes):
 *   [0]    = echo of command (0x50)
 *   [3]    = payload length (0x3C)
 *   [4..5] = product ID (LE)
 *   [6..7] = vendor ID (LE)
 *   [8..11] = little-endian BCD release number; each byte is a two-digit
 *             number, stored build→major, e.g. 4.1.0.9 is 0x09 0x00 0x01 0x04
 *   [20..] = null-terminated product string
 */
export function decodeHardwareInfo(raw: Uint8Array): HardwareInfo | null {
  if (raw.length < 32 || raw[0] !== CMD.GET_HARDWARE_INFO) return null;

  const productId = raw[4] | (raw[5] << 8);
  const vendorId = raw[6] | (raw[7] << 8);

  // [8..11] little-endian BCD digits: build, revision, minor, major.
  const major = bcdByte(raw[11]);
  const minor = bcdByte(raw[10]);
  const revision = bcdByte(raw[9]);
  const build = bcdByte(raw[8]);
  const firmware = `${major}.${minor}.${revision}.${build}`;

  let nameEnd = 20;
  while (nameEnd < raw.length && raw[nameEnd] !== 0) nameEnd++;
  const product = new TextDecoder().decode(raw.slice(20, nameEnd));

  return { vendorId, productId, firmware, product };
}

// ── Heartbeat / battery (0x51) ──────────────────────────────────────────────

export interface BatteryInfo {
  percent: number | null;
  state: "Charging" | "Discharging" | "Full" | "Unknown";
}

/**
 * Decode a heartbeat (0x51) response.
 *
 * Layout (64 bytes):
 *   [0] = echo of command (0x51)
 *   [4] = battery percentage (0–100)
 *   [5] = charging status: 0x00 wireless (discharging),
 *                          0x01 wired (charging),
 *                          0x02 wired, fully charged
 */
export function decodeBattery(raw: Uint8Array): BatteryInfo | null {
  if (raw.length < 6 || raw[0] !== CMD.GET_BATTERY) return null;

  const percent = raw[4];
  const status = raw[5];

  // Wired models and some wireless firmwares report 0 or 0xFF for battery.
  if (percent === 0 || percent > 100) {
    return { percent: null, state: "Unknown" };
  }

  const state = status === 0x01 ? "Charging"
    : status === 0x02 ? "Full"
    : percent < 100 ? "Discharging"
    : "Unknown";
  return { percent: percent <= 100 ? percent : null, state };
}

// ── DPI settings (0x53) ─────────────────────────────────────────────────────

export interface DpiSettings {
  /** Active profile index (0–4). */
  activeProfile: number;
  /** Bitmask of enabled profiles. */
  enabled: number;
  /** DPI for each profile (0 when unset). */
  profiles: number[];
  /** Lift-off distance for the active profile. */
  liftOffDistance: LiftOffDistance | null;
  /** Maximum DPI the sensor can represent. */
  maxDpi: number;
}

/**
 * Decode a DPI settings (0x53) response.
 *
 * Layout (64 bytes):
 *   [0]    = echo of command (0x53)
 *   [4]    = active profile number
 *   [5]    = enabled profile bitmask
 *   [8]    = max DPI step value (0xA0 = 160 = 16,000 DPI)
 *   [12..21] = 5 × DPI step values (LE uint16), profile 0 first, DPI/100
 *   [22..36] = 5 × profile indicator RGB colours
 *   [37]   = lift-off distance in millimetres (1 or 2)
 */
export function decodeDpiSettings(raw: Uint8Array): DpiSettings | null {
  if (raw.length < 38 || raw[0] !== CMD.GET_DPI) return null;

  const profiles: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const encoded = raw[12 + i * 2] | (raw[13 + i * 2] << 8);
    profiles.push(decodeDpi(encoded));
  }

  const activeProfile = raw[4];
  const liftOffDistance = decodeLod(raw[37]);

  return {
    activeProfile: activeProfile < 5 ? activeProfile : 0,
    enabled: raw[5],
    profiles,
    liftOffDistance,
    maxDpi: decodeDpi(raw[8]),
  };
}

// ── Command encoding helpers ────────────────────────────────────────────────

/**
 * Build a SET_POLLING_RATE (0xD0) command.
 *
 * Wire format: [0xD0, 0x00, 0x00, 0x01, RATE_CODE]
 */
export function encodeSetPollingRate(hz: number): Uint8Array | null {
  const code = POLLING_RATE_ENCODE.get(hz);
  if (code === undefined) return null;

  const buf = new Uint8Array(64);
  buf[0] = CMD.SET_POLLING_RATE;
  buf[3] = 0x01;
  buf[4] = code;
  return buf;
}

/**
 * Build a SET_DPI (0xD3) command that writes the DPI value for a profile.
 *
 * Wire format: [0xD3, 0x02, PROFILE, 0x02, DPI_LOW, DPI_HIGH]
 */
export function encodeSetDpi(profile: number, dpi: number): Uint8Array | null {
  if (!isValidDpi(dpi)) return null;
  const encoded = encodeDpi(dpi);

  const buf = new Uint8Array(64);
  buf[0] = CMD.SET_DPI;
  buf[1] = 0x02; // sub-command: set profile DPI value
  buf[2] = profile & 0x1f;
  buf[3] = 0x02; // payload length (2 bytes for LE uint16)
  buf[4] = encoded & 0xff;
  buf[5] = (encoded >> 8) & 0xff;
  return buf;
}

/**
 * Build a SET_DPI (0xD3) command that selects the active profile.
 *
 * Wire format: [0xD3, 0x00, 0x00, 0x01, PROFILE_NUM]
 */
export function encodeSelectProfile(profile: number): Uint8Array {
  const buf = new Uint8Array(64);
  buf[0] = CMD.SET_DPI;
  buf[1] = 0x00; // sub-command: set selected profile
  buf[3] = 0x01;
  buf[4] = profile & 0x1f;
  return buf;
}

/**
 * Build a SET_DPI (0xD3) command that writes the enabled-profile bitmask.
 *
 * Wire format: [0xD3, 0x01, 0x00, 0x01, BITMASK]
 */
export function encodeEnableProfiles(bitmask: number): Uint8Array {
  const buf = new Uint8Array(64);
  buf[0] = CMD.SET_DPI;
  buf[1] = 0x01; // sub-command: set enabled profiles
  buf[3] = 0x01;
  buf[4] = bitmask & 0x1f;
  return buf;
}

/**
 * Build a SET_DPI (0xD3) command that writes the lift-off distance.
 *
 * Wire format: [0xD3, 0x05, 0x00, 0x01, DISTANCE_MM, DISTANCE_MM]
 */
export function encodeSetLod(distance: LiftOffDistance): Uint8Array {
  const buf = new Uint8Array(64);
  buf[0] = CMD.SET_DPI;
  buf[1] = 0x05; // sub-command: set lift-off distance
  buf[3] = 0x01;
  const mm = encodeLod(distance);
  buf[4] = mm;
  buf[5] = mm;
  return buf;
}

/**
 * Build a SAVE (0xDE) command to persist inline settings to onboard memory.
 *
 * Wire format: [0xDE, 0xFF] saves everything, [0xDE, 0x03] saves DPI only.
 */
export function encodeSave(subcommand: 0xff | 0x03 = 0xff): Uint8Array {
  const buf = new Uint8Array(64);
  buf[0] = CMD.SAVE;
  buf[1] = subcommand;
  return buf;
}