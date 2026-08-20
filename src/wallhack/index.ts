/**
 * WALLHACK device codec — wire format for the WALLHACK M-001 mouse and K-001
 * keyboard, reverse-engineered from the WALLHACK Terminal WebHID app
 * (terminal.wallhack.com). Pure functions only: packet builders and response
 * decoders, no I/O. The WebHID drivers live in ../drivers/wallhack.
 *
 * Transport (shared): output on **report id 4**, fixed **63-byte** reports,
 * zero-padded. Responses arrive as input reports with the command code echoed at
 * byte 2 and, for function-area reads, the 16-bit little-endian address echoed at
 * bytes 4-5 and the payload from byte 7.
 *
 * The two devices are told apart by their command interface's HID usage page:
 * the mouse answers on 0xFF1C, the keyboard on 0xFFA0.
 */

export const WALLHACK_VENDOR_ID = 0x3879; // 14457
/** A second vendor id some K-001 units enumerate under (the switch-matrix MCU). */
export const WALLHACK_KEYBOARD_ALT_VENDOR_ID = 0x1caa; // 7338

/** M-001 mouse: real config PID and the in-app demo PID. */
export const WALLHACK_MOUSE_PRODUCT_IDS = new Set<number>([0x1110, 0x0807]);
/** K-001 keyboard PID (shared across both keyboard vendor ids). */
export const WALLHACK_KEYBOARD_PRODUCT_IDS = new Set<number>([0x0806]);

/** Command-interface usage pages, from the app's `CS` map. */
export const WALLHACK_MOUSE_USAGE_PAGE = 0xff1c; // 65308
export const WALLHACK_MOUSE_USAGE = 0x92; // 146
export const WALLHACK_KEYBOARD_USAGE_PAGE = 0xffa0; // 65440
export const WALLHACK_KEYBOARD_USAGE = 0x01;

/** Every report is sent under this report id and is this many bytes long. */
export const WALLHACK_REPORT_ID = 4;
export const WALLHACK_REPORT_LENGTH = 63;

/**
 * Mouse command codes (`Pt`). The function-area pair reads/writes the config
 * map (`WALLHACK_FLASH`); the rest are direct queries and actions.
 */
export const WALLHACK_COMMAND = {
  checkConn: 0xa0,
  fastBegin: 0xa1,
  fastEnd: 0xa2,
  getBasicInfo: 0xa3,
  readFunctionArea: 0xa4,
  writeFunctionArea: 0xa5,
  getDefaultKeys: 0xa6,
  getKeys: 0xa7,
  setKeys: 0xa8,
  getLighting: 0xa9,
  setLighting: 0xaa,
  factoryReset: 0xab,
  getMacro: 0xac,
  setMacro: 0xad,
  pair: 0xae,
  clearPairing: 0xaf,
  testColor: 0xb0,
  readMouseChipId: 0xb8,
  readDongleChipId: 0xb9,
  battery: 0xba,
  readVersion: 0xbc,
} as const;

/**
 * Byte offsets into the mouse config "function area" (`We`). Each named field is
 * a single byte unless noted. `dpi8Block` is the base of the per-stage DPI
 * records.
 */
export const WALLHACK_FLASH = {
  profileIndex: 0,
  ledMode: 1,
  ledLight: 2,
  reportEsb: 10, // wireless (2.4 GHz) polling rank
  reportUsb: 11, // wired polling rank
  dpiRank: 12, // active DPI stage (0-based)
  dpi8Block: 77, // base of the 8 DPI-stage records
  reportUser: 104,
  sleepTime: 105,
  deepSleepTime: 107,
  keyDebounceTime: 109,
  silentHeight: 110, // lift-off distance
  angleSnapEnable: 111,
  rippleControlEnable: 112,
  motionSyncEnable: 113,
  turnOffAutomaticSleep: 114,
  angleTuneValue: 115,
  gameMode: 116,
} as const;

/** Polling-rate rank → Hz (`Z1`). Same table for wired and wireless. */
export const WALLHACK_POLLING_BY_RANK: Record<number, number> = {
  0: 125, 1: 250, 2: 500, 3: 1000, 4: 1500, 5: 2000, 6: 2500, 7: 3000,
  8: 3500, 9: 4000, 10: 4500, 11: 5000, 12: 5500, 13: 6000, 14: 6500,
  15: 7000, 16: 7500, 17: 8000,
};

/** Full list of selectable polling rates, in Hz (`jm`). */
export const WALLHACK_POLLING_RATES: readonly number[] = Object.values(WALLHACK_POLLING_BY_RANK);

/** Lift-off-distance code → millimetres (`s6`). */
export const WALLHACK_LOD_MM_BY_CODE: Record<number, number> = { 0: 0.7, 1: 1, 2: 2 };

export function wallhackPollingRankToHz(rank: number): number | null {
  return WALLHACK_POLLING_BY_RANK[rank] ?? null;
}

export function wallhackPollingHzToRank(hz: number): number | null {
  for (const [rank, value] of Object.entries(WALLHACK_POLLING_BY_RANK)) {
    if (value === hz) return Number(rank);
  }
  return null;
}

/**
 * Lift-off code (0/1/2) → OpenMouse's three-stop LOD. The device's three heights
 * (0.7 / 1 / 2 mm) map onto Low / Medium / High in order.
 */
export function wallhackLodFromCode(code: number): "Low" | "Medium" | "High" | null {
  switch (code) {
    case 0: return "Low";
    case 1: return "Medium";
    case 2: return "High";
    default: return null;
  }
}

export function wallhackLodToCode(lod: "Low" | "Medium" | "High"): number {
  return lod === "Low" ? 0 : lod === "Medium" ? 1 : 2;
}

/** Human-facing product name for a device by product id. */
export function wallhackMouseName(_productId: number): string {
  return "WALLHACK M-001";
}

export function wallhackKeyboardName(_productId: number): string {
  return "WALLHACK K-001";
}

/** Pack `bytes` into a fresh zero-padded 63-byte report body (`as`). */
export function wallhackReport(bytes: Iterable<number>): Uint8Array {
  const frame = new Uint8Array(WALLHACK_REPORT_LENGTH);
  frame.set([...bytes].slice(0, WALLHACK_REPORT_LENGTH), 0);
  return frame;
}

/**
 * Build a simple (non-function-area) command: `[0, 0, command, ...args]` padded
 * to the report length. Matches the app's `as(new Uint8Array([0, 0, cmd, …]))`.
 */
export function wallhackBuildSimple(command: number, args: readonly number[] = []): Uint8Array {
  return wallhackReport([0, 0, command, ...args]);
}

/**
 * Build a function-area read/write packet (`Ht`):
 * `[0, 0, cmd, n, addrLo, addrHi, 0, ...payload]`, where `cmd` is
 * READ/WRITE_FUNCTION_AREA, `n` is the payload length (write) or byte count
 * (read), and `addr` is the 16-bit little-endian offset.
 */
export function wallhackBuildFunctionArea(
  write: boolean,
  address: number,
  n: number,
  payload: readonly number[] = [],
): Uint8Array {
  const command = write ? WALLHACK_COMMAND.writeFunctionArea : WALLHACK_COMMAND.readFunctionArea;
  const header = [0, 0, command, n & 0xff, address & 0xff, (address >> 8) & 0xff, 0];
  return wallhackReport([...header, ...payload]);
}

/** Read `count` bytes from the config map at `address`. */
export function wallhackBuildRead(address: number, count = 1): Uint8Array {
  return wallhackBuildFunctionArea(false, address, count);
}

/** Write `payload` bytes to the config map at `address`. */
export function wallhackBuildWrite(address: number, payload: readonly number[]): Uint8Array {
  return wallhackBuildFunctionArea(true, address, payload.length, payload);
}

/** A DPI value as the two little-endian bytes the DPI-stage record stores. */
export function wallhackDpiBytes(dpi: number): [number, number] {
  return [dpi & 0xff, (dpi >> 8) & 0xff];
}

/**
 * One DPI-stage record as written by the app (`sJ`):
 * `[enabled, 0, dpiLo, dpiHi, 0x90, 1, colorHi, colorLo, 0]`. The trailing bytes
 * are the stage's LED colour; the app writes 0x90/0xFFFF as defaults.
 */
export function wallhackBuildSetDpiStage(dpi: number): Uint8Array {
  const [lo, hi] = wallhackDpiBytes(dpi);
  return wallhackBuildWrite(WALLHACK_FLASH.dpi8Block, [1, 0, lo, hi, 0x90, 1, 0xff, 0xff, 0]);
}

/**
 * A response is a valid reply for `command` when it echoes that command code at
 * byte 2. (Bytes 0-1 are report framing / status.)
 */
export function wallhackIsReplyFor(response: Uint8Array, command: number): boolean {
  return response.length > 2 && response[2] === command;
}

/** The function-area address a read/write response echoes back (bytes 4-5, LE). */
export function wallhackResponseAddress(response: Uint8Array): number | null {
  if (response.length < 6) return null;
  return (response[4]! | (response[5]! << 8)) & 0xffff;
}

/**
 * The single config byte a function-area read returns. The payload begins at
 * byte 7 (`gJ`, `fJ`, `mJ` all read `t[7]`).
 */
export function wallhackReadByte(response: Uint8Array): number | null {
  if (response.length < 8) return null;
  return response[7]!;
}

/**
 * The active DPI stage's value from a `dpi8Block` read. The stage record's DPI
 * lives at payload bytes 2-3, i.e. response bytes 9-10, little-endian (`lJ`).
 */
export function wallhackReadDpi(response: Uint8Array): number | null {
  if (response.length < 11) return null;
  return (response[9]! | (response[10]! << 8)) & 0xffff;
}

export interface WallhackVersions {
  /** Mouse Nordic firmware, e.g. "1.4". */
  mouse: string;
  /** Receiver/dongle Nordic firmware. */
  dongle: string;
  /** Receiver NXP (nxp5516) firmware. */
  nxp: string;
}

/**
 * Decode a READ_VERSION reply (`rJ`): three big-endian 16-bit versions at bytes
 * 7-8 (mouse), 9-10 (dongle), 11-12 (NXP), each rendered `major.minor`.
 */
export function wallhackDecodeVersions(response: Uint8Array): WallhackVersions | null {
  if (response.length < 13) return null;
  const render = (hi: number, lo: number): string => `${hi}.${lo}`;
  return {
    mouse: render(response[7]!, response[8]!),
    dongle: render(response[9]!, response[10]!),
    nxp: render(response[11]!, response[12]!),
  };
}

export interface WallhackBattery {
  percent: number | null;
  charging: boolean;
}

/**
 * Decode a BATTERY reply: percentage at byte 7, charging flag at byte 8. The
 * exact byte positions are best-effort from the obfuscated bundle and want
 * hardware confirmation; a percent outside 0-100 is treated as unknown.
 */
export function wallhackDecodeBattery(response: Uint8Array): WallhackBattery | null {
  if (response.length < 9) return null;
  const raw = response[7]!;
  const percent = raw >= 0 && raw <= 100 ? raw : null;
  return { percent, charging: response[8] === 1 };
}
