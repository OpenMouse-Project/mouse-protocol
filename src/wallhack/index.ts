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
  dynamicDpiEnable: 117,
  dynamicDpiMode: 118,
  dynamicDpiCoordinateReportEnable: 119,
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

/**
 * Sensor-rotation encoding (`z7`/`mB`): the `angleTuneValue` byte stores
 * degrees + 30, so 30 means straight and the range 0-60 maps to -30..+30.
 */
export const WALLHACK_SENSOR_ANGLE_CENTER = 30;
export const WALLHACK_SENSOR_ANGLE_MIN = -30;
export const WALLHACK_SENSOR_ANGLE_MAX = 30;

/** Raw `angleTuneValue` byte → degrees, or null when outside 0-60. */
export function wallhackRawToSensorAngle(raw: number): number | null {
  const degrees = raw - WALLHACK_SENSOR_ANGLE_CENTER;
  if (!Number.isInteger(raw) || degrees < WALLHACK_SENSOR_ANGLE_MIN || degrees > WALLHACK_SENSOR_ANGLE_MAX) {
    return null;
  }
  return degrees;
}

/** Degrees (-30..+30) → raw `angleTuneValue` byte. Throws outside the range. */
export function wallhackSensorAngleToRaw(degrees: number): number {
  if (!Number.isInteger(degrees) || degrees < WALLHACK_SENSOR_ANGLE_MIN || degrees > WALLHACK_SENSOR_ANGLE_MAX) {
    throw new Error(`WALLHACK sensor angle must be a whole number of degrees in -30..+30, got ${degrees}.`);
  }
  return degrees + WALLHACK_SENSOR_ANGLE_CENTER;
}

/**
 * Sensor scanning mode (`gameMode` byte, surfaced as HIGH/ACCEL): 0 is HIGH,
 * 1 is ACCEL. Enabling ACCEL costs battery; the vendor app confirms with the
 * user before writing 1.
 */
export type WallhackSensorScanningMode = "HIGH" | "ACCEL";

export function wallhackScanningModeFromByte(value: number): WallhackSensorScanningMode | null {
  if (value === 0) return "HIGH";
  if (value === 1) return "ACCEL";
  return null;
}

export function wallhackScanningModeToByte(mode: WallhackSensorScanningMode): number {
  return mode === "ACCEL" ? 1 : 0;
}

/**
 * Minimum mouse-Nordic firmware triples (mouse/dongle/nxp5516) the vendor app
 * gates features behind (`W7`). The M-001 demo reports V1.17.0-era versions;
 * anything older answers these areas with noise or a status error.
 */
export const WALLHACK_MIN_FIRMWARE = {
  customSleepTimer: { mouse: 51, dongle: 36, nxp5516: 48 },
  sensorScanning: { mouse: 52, dongle: 36, nxp5516: 48 },
  buttonMapping: { mouse: 53, dongle: 37, nxp5516: 52 },
  sensorRotation: { mouse: 53, dongle: 37, nxp5516: 52 },
  macros: { mouse: 57, dongle: 40, nxp5516: 53 },
  dynamicSensitivity: { mouse: 57, dongle: 40, nxp5516: 53 },
} as const;

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

// ---------------------------------------------------------------------------
// Dynamic sensitivity (DPI acceleration) curves
// ---------------------------------------------------------------------------

/**
 * DPI-acceleration curves (`dynamicSensitivity` in the app). Every curve has
 * exactly 5 points; X is cursor speed in sensor counts/ms (whole numbers
 * 0-280, strictly increasing) and Y is the gain multiplier (a multiple of
 * 0.01 in 0.10-6.00). Preset tables live at their own function-area
 * addresses and pack one point into 2 bytes (`speed u8, gain*100 u8`); the
 * custom table packs one point into 4 bytes (u16LE speed, u16LE gain*100).
 * Curve replies carry a status code at byte 6: 0 is OK.
 */
export const WALLHACK_CURVE_POINT_COUNT = 5;
export const WALLHACK_CURVE_SPEED_MAX = 280;
export const WALLHACK_CURVE_GAIN_MIN = 0.1;
export const WALLHACK_CURVE_GAIN_MAX = 6.0;
export const WALLHACK_CURVE_GAIN_STEP = 0.01;

export type WallhackCurveMode = "classic" | "natural" | "jump" | "custom";

export const WALLHACK_CURVE_ADDRESS: Record<WallhackCurveMode, number> = {
  classic: 640,
  natural: 650,
  jump: 660,
  custom: 670,
};

export const WALLHACK_CURVE_MODE_INDEX: Record<WallhackCurveMode, number> = {
  classic: 0,
  natural: 1,
  jump: 2,
  custom: 3,
};

export interface WallhackCurvePoint {
  speed: number;
  gain: number;
}

export const WALLHACK_CURVE_PRESETS: Record<WallhackCurveMode, WallhackCurvePoint[]> = {
  classic: [
    { speed: 0, gain: 1 }, { speed: 20, gain: 1.1 }, { speed: 40, gain: 1.2 },
    { speed: 70, gain: 1.35 }, { speed: 100, gain: 1.5 },
  ],
  natural: [
    { speed: 0, gain: 1 }, { speed: 11, gain: 1.45 }, { speed: 20, gain: 1.5 },
    { speed: 35, gain: 1.5 }, { speed: 100, gain: 1.5 },
  ],
  jump: [
    { speed: 0, gain: 1 }, { speed: 9, gain: 1 }, { speed: 21, gain: 1.5 },
    { speed: 24, gain: 1.5 }, { speed: 100, gain: 1.5 },
  ],
  custom: [
    { speed: 0, gain: 1 }, { speed: 70, gain: 1 }, { speed: 140, gain: 1 },
    { speed: 210, gain: 1 }, { speed: 280, gain: 1 },
  ],
};

/** Validate curve points; returns an error string or null when valid. */
export function wallhackValidateCurve(points: readonly WallhackCurvePoint[]): string | null {
  if (points.length !== WALLHACK_CURVE_POINT_COUNT) {
    return `a curve has exactly ${WALLHACK_CURVE_POINT_COUNT} points`;
  }
  let previous = -1;
  for (const [index, point] of points.entries()) {
    if (!Number.isInteger(point.speed) || point.speed < 0 || point.speed > WALLHACK_CURVE_SPEED_MAX) {
      return `point ${index} speed must be a whole number in 0..${WALLHACK_CURVE_SPEED_MAX}`;
    }
    if (point.speed <= previous) return "speeds must be strictly increasing";
    previous = point.speed;
    const hundredths = Math.round(point.gain * 100);
    if (
      Number.isNaN(point.gain) ||
      Math.abs(point.gain * 100 - hundredths) > 1e-6 ||
      hundredths < WALLHACK_CURVE_GAIN_MIN * 100 ||
      hundredths > WALLHACK_CURVE_GAIN_MAX * 100
    ) {
      return `point ${index} gain must be a multiple of 0.01 in 0.10..6.00`;
    }
  }
  return null;
}

/** Read packet for a curve table: preset tables read 10 bytes, custom 20. */
export function wallhackBuildCurveRead(mode: WallhackCurveMode): Uint8Array {
  return wallhackBuildRead(WALLHACK_CURVE_ADDRESS[mode], mode === "custom" ? 20 : 10);
}

/** Write packet for the custom curve table (20-byte payload). Throws when invalid. */
export function wallhackBuildCustomCurveWrite(points: readonly WallhackCurvePoint[]): Uint8Array {
  const error = wallhackValidateCurve(points);
  if (error) throw new Error(`Invalid dynamic sensitivity curve: ${error}.`);
  const payload = new Uint8Array(20);
  points.forEach((point, index) => {
    payload[index * 4] = point.speed & 0xff;
    payload[index * 4 + 1] = (point.speed >> 8) & 0xff;
    const hundredths = Math.round(point.gain * 100);
    payload[index * 4 + 2] = hundredths & 0xff;
    payload[index * 4 + 3] = (hundredths >> 8) & 0xff;
  });
  return wallhackBuildWrite(WALLHACK_CURVE_ADDRESS.custom, [...payload]);
}

/**
 * Decode a preset-curve payload (10 bytes from response byte 7): one point
 * per 2 bytes as `speed u8, gain*100 u8`. Returns null when malformed.
 */
export function wallhackDecodePresetCurve(payload: Uint8Array): WallhackCurvePoint[] | null {
  if (payload.length < 10) return null;
  const points: WallhackCurvePoint[] = [];
  for (let index = 0; index < WALLHACK_CURVE_POINT_COUNT; index++) {
    points.push({ speed: payload[index * 2]!, gain: payload[index * 2 + 1]! / 100 });
  }
  return wallhackValidateCurve(points) === null ? points : null;
}

/**
 * Decode a custom-curve payload (20 bytes): one point per 4 bytes as u16LE
 * speed + u16LE gain*100. Returns null when malformed.
 */
export function wallhackDecodeCustomCurve(payload: Uint8Array): WallhackCurvePoint[] | null {
  if (payload.length < 20) return null;
  const points: WallhackCurvePoint[] = [];
  for (let index = 0; index < WALLHACK_CURVE_POINT_COUNT; index++) {
    const speed = (payload[index * 4]! | (payload[index * 4 + 1]! << 8)) & 0xffff;
    const hundredths = (payload[index * 4 + 2]! | (payload[index * 4 + 3]! << 8)) & 0xffff;
    points.push({ speed, gain: hundredths / 100 });
  }
  return wallhackValidateCurve(points) === null ? points : null;
}

/** Curve-table status code (response byte 6) rendered as text. */
export function wallhackCurveStatusText(response: Uint8Array): string {
  const status = response.length > 6 ? response[6]! : 0;
  switch (status) {
    case 0: return "ok";
    case 1: return "address or length rejected by the mouse";
    case 2: return "the mouse rejected the curve as invalid (speed ≤ 280, gain 0.10–6.00, speeds strictly increasing)";
    case 3: return "that curve table is read-only";
    default: return `unknown status 0x${status.toString(16).padStart(2, "0")}`;
  }
}

export function wallhackCurveModeFromIndex(index: number): WallhackCurveMode | null {
  switch (index) {
    case 0: return "classic";
    case 1: return "natural";
    case 2: return "jump";
    case 3: return "custom";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Button bindings (GET_KEYS / SET_KEYS)
// ---------------------------------------------------------------------------

/**
 * Button bindings: the mouse holds 8 key slots of 3-byte triplets
 * (`keyType, codeL, codeH`); the first five are the physical buttons in
 * `WALLHACK_BUTTON_ORDER` and the last three are reserved (read as
 * disabled, preserved on write). `GET_KEYS` reads all 8; `SET_KEYS` writes
 * triplets at a triplet (not byte) offset: slot N starts at offset N*3.
 */
export const WALLHACK_KEY_SLOTS = 8;
export const WALLHACK_TRIPLET_SIZE = 3;
export const WALLHACK_BUTTON_ORDER = ["left", "right", "middle", "back", "forward"] as const;
export type WallhackPhysicalButton = (typeof WALLHACK_BUTTON_ORDER)[number];

/** Mouse-button bitmask used by keyType 16 (`Zp`). */
export const WALLHACK_BUTTON_BITS: Record<WallhackPhysicalButton, number> = {
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
};

export type WallhackButtonBinding =
  | { kind: "disabled" }
  | { kind: "mouseButton"; button: string }
  | { kind: "key"; modifiers: number; hidUsage: number }
  | { kind: "dpi"; op: "increment" | "decrement" | "loop" }
  | { kind: "system"; action: "power" | "sleep" | "wake" }
  | { kind: "media"; action: "nextTrack" | "previousTrack" | "stop" | "playPause" | "mute" | "volumeUp" | "volumeDown" }
  | { kind: "rapidFire"; intervalMs: number; clickCount: number }
  | { kind: "macro"; macroNumber: number; stop: { mode: "once" | "finishCycleOnRelease" | "toggle" | "stopOnRelease" } }
  | { kind: "unknown"; triplet: { keyType: number; codeL: number; codeH: number } };

export interface WallhackTriplet {
  keyType: number;
  codeL: number;
  codeH: number;
}

const WALLHACK_DPI_OPS = { increment: 1, decrement: 2, loop: 3 } as const;
const WALLHACK_SYSTEM_ACTIONS = { power: 1, sleep: 2, wake: 4 } as const;
const WALLHACK_MEDIA_ACTIONS = {
  nextTrack: 181,
  previousTrack: 182,
  stop: 183,
  playPause: 205,
  mute: 226,
  volumeUp: 233,
  volumeDown: 234,
} as const;
const WALLHACK_MACRO_STOP_MODES = { once: 0, finishCycleOnRelease: 1, toggle: 2, stopOnRelease: 3 } as const;
const WALLHACK_MOUSE_BUTTON_BY_INDEX = ["left", "middle", "right", "back", "forward"] as const;

function wallhackLookupKey(table: Record<string, number>, code: number): string | null {
  for (const [name, value] of Object.entries(table)) {
    if (value === code) return name;
  }
  return null;
}

/** Encode a binding into its wire triplet (`K7`). Throws on bad parameters. */
export function wallhackEncodeBinding(binding: WallhackButtonBinding): WallhackTriplet {
  switch (binding.kind) {
    case "disabled": return { keyType: 0, codeL: 0, codeH: 0 };
    case "mouseButton": {
      const bits = WALLHACK_BUTTON_BITS[binding.button as WallhackPhysicalButton];
      if (bits === undefined) throw new Error(`Unknown WALLHACK mouse button "${binding.button}".`);
      return { keyType: 16, codeL: bits, codeH: 0 };
    }
    case "key": return { keyType: 32, codeL: binding.modifiers, codeH: binding.hidUsage };
    case "dpi": return { keyType: 19, codeL: WALLHACK_DPI_OPS[binding.op], codeH: 0 };
    case "system": return { keyType: 64, codeL: WALLHACK_SYSTEM_ACTIONS[binding.action], codeH: 0 };
    case "media": return { keyType: 48, codeL: WALLHACK_MEDIA_ACTIONS[binding.action], codeH: 0 };
    case "rapidFire": {
      if (!Number.isInteger(binding.intervalMs) || binding.intervalMs < 0 || binding.intervalMs > 255) {
        throw new Error("Rapid-fire interval must be a whole ms from 0 to 255.");
      }
      if (!Number.isInteger(binding.clickCount) || binding.clickCount < 1 || binding.clickCount > 255) {
        throw new Error("Rapid-fire click count must be from 1 to 255.");
      }
      return { keyType: 20, codeL: binding.intervalMs, codeH: binding.clickCount };
    }
    case "macro": return { keyType: 112, codeL: binding.macroNumber, codeH: WALLHACK_MACRO_STOP_MODES[binding.stop.mode] };
    case "unknown": return { ...binding.triplet };
  }
}

/** Decode a wire triplet into a binding (`e2`), keeping unknowns lossless. */
export function wallhackDecodeTriplet(triplet: WallhackTriplet): WallhackButtonBinding {
  const unknown: WallhackButtonBinding = { kind: "unknown", triplet: { ...triplet } };
  if (triplet.keyType === 0 && triplet.codeL === 0 && triplet.codeH === 0) return { kind: "disabled" };
  switch (triplet.keyType) {
    case 16: {
      const name = wallhackLookupKey(WALLHACK_BUTTON_BITS as unknown as Record<string, number>, triplet.codeL);
      return name ? { kind: "mouseButton", button: name } : unknown;
    }
    case 1: {
      const name = WALLHACK_MOUSE_BUTTON_BY_INDEX[triplet.codeL - 1];
      return name ? { kind: "mouseButton", button: name } : unknown;
    }
    case 32:
    case 7: return { kind: "key", modifiers: triplet.codeL, hidUsage: triplet.codeH };
    case 19:
    case 4: {
      const op = wallhackLookupKey(WALLHACK_DPI_OPS as unknown as Record<string, number>, triplet.codeL);
      return op ? { kind: "dpi", op: op as "increment" | "decrement" | "loop" } : unknown;
    }
    case 64: {
      const action = wallhackLookupKey(WALLHACK_SYSTEM_ACTIONS as unknown as Record<string, number>, triplet.codeL);
      return action ? { kind: "system", action: action as "power" | "sleep" | "wake" } : unknown;
    }
    case 48: {
      const action = wallhackLookupKey(WALLHACK_MEDIA_ACTIONS as unknown as Record<string, number>, triplet.codeL);
      return action
        ? {
          kind: "media",
          action: action as "nextTrack" | "previousTrack" | "stop" | "playPause" | "mute" | "volumeUp" | "volumeDown",
        }
        : unknown;
    }
    case 20: return triplet.codeH > 0 ? { kind: "rapidFire", intervalMs: triplet.codeL, clickCount: triplet.codeH } : unknown;
    case 112: {
      const mode = wallhackLookupKey(
        WALLHACK_MACRO_STOP_MODES as unknown as Record<string, number>,
        triplet.codeH,
      );
      return mode
        ? {
          kind: "macro",
          macroNumber: triplet.codeL,
          stop: { mode: mode as "once" | "finishCycleOnRelease" | "toggle" | "stopOnRelease" },
        }
        : unknown;
    }
    case 11: {
      const stop = wallhackLookupKey(
        WALLHACK_MACRO_STOP_MODES as unknown as Record<string, number>,
        triplet.codeH,
      );
      return stop
        ? {
          kind: "macro",
          macroNumber: triplet.codeL,
          stop: { mode: stop as "once" | "finishCycleOnRelease" | "toggle" | "stopOnRelease" },
        }
        : unknown;
    }
    default: return unknown;
  }
}

export function wallhackTripletsEqual(a: WallhackTriplet, b: WallhackTriplet): boolean {
  return a.keyType === b.keyType && a.codeL === b.codeL && a.codeH === b.codeH;
}

/**
 * Human labels for button bindings, used by OpenMouse's shared button
 * remapper (`buttonMappings`/`buttonOptions`/`setButtonMapping`). Every
 * label parses back through `wallhackBindingFromLabel`, including the
 * parametric `Rapid Fire …`, `Macro …`, `Key …` and `Unknown (…)` forms.
 */
export const WALLHACK_BUTTON_OPTIONS: readonly string[] = [
  "Left Click",
  "Right Click",
  "Middle Click",
  "Back",
  "Forward",
  "DPI +",
  "DPI -",
  "DPI Cycle",
  "Power",
  "Sleep",
  "Wake",
  "Next Track",
  "Previous Track",
  "Stop",
  "Play / Pause",
  "Mute",
  "Volume +",
  "Volume -",
  "Macro 1",
  "Macro 2",
  "Macro 3",
  "Macro 4",
  "Rapid Fire 100ms x5",
  "Disabled",
];

const WALLHACK_MACRO_MODE_LABELS = {
  once: "Once",
  finishCycleOnRelease: "Finish Cycle on Release",
  toggle: "Toggle",
  stopOnRelease: "Stop on Release",
} as const;

export function wallhackBindingLabel(binding: WallhackButtonBinding): string {
  switch (binding.kind) {
    case "disabled": return "Disabled";
    case "mouseButton": {
      switch (binding.button) {
        case "left": return "Left Click";
        case "right": return "Right Click";
        case "middle": return "Middle Click";
        case "back": return "Back";
        case "forward": return "Forward";
        default: return `Unknown (16,${WALLHACK_BUTTON_BITS[binding.button as WallhackPhysicalButton] ?? 0},0)`;
      }
    }
    case "key": return binding.modifiers === 0 ? `Key ${binding.hidUsage}` : `Key ${binding.hidUsage} +${binding.modifiers}`;
    case "dpi": return binding.op === "increment" ? "DPI +" : binding.op === "decrement" ? "DPI -" : "DPI Cycle";
    case "system": return binding.action === "power" ? "Power" : binding.action === "sleep" ? "Sleep" : "Wake";
    case "media": {
      switch (binding.action) {
        case "nextTrack": return "Next Track";
        case "previousTrack": return "Previous Track";
        case "stop": return "Stop";
        case "playPause": return "Play / Pause";
        case "mute": return "Mute";
        case "volumeUp": return "Volume +";
        case "volumeDown": return "Volume -";
      }
      break;
    }
    case "rapidFire": return `Rapid Fire ${binding.intervalMs}ms x${binding.clickCount}`;
    case "macro": {
      const mode = WALLHACK_MACRO_MODE_LABELS[binding.stop.mode];
      return binding.stop.mode === "once" ? `Macro ${binding.macroNumber + 1}` : `Macro ${binding.macroNumber + 1} ${mode}`;
    }
    case "unknown": return `Unknown (${binding.triplet.keyType},${binding.triplet.codeL},${binding.triplet.codeH})`;
  }
}

/** Parse a `wallhackBindingLabel` label back into a binding. Throws when unknown. */
export function wallhackBindingFromLabel(label: string): WallhackButtonBinding {
  switch (label) {
    case "Disabled": return { kind: "disabled" };
    case "Left Click": return { kind: "mouseButton", button: "left" };
    case "Right Click": return { kind: "mouseButton", button: "right" };
    case "Middle Click": return { kind: "mouseButton", button: "middle" };
    case "Back": return { kind: "mouseButton", button: "back" };
    case "Forward": return { kind: "mouseButton", button: "forward" };
    case "DPI +": return { kind: "dpi", op: "increment" };
    case "DPI -": return { kind: "dpi", op: "decrement" };
    case "DPI Cycle": return { kind: "dpi", op: "loop" };
    case "Power": return { kind: "system", action: "power" };
    case "Sleep": return { kind: "system", action: "sleep" };
    case "Wake": return { kind: "system", action: "wake" };
    case "Next Track": return { kind: "media", action: "nextTrack" };
    case "Previous Track": return { kind: "media", action: "previousTrack" };
    case "Stop": return { kind: "media", action: "stop" };
    case "Play / Pause": return { kind: "media", action: "playPause" };
    case "Mute": return { kind: "media", action: "mute" };
    case "Volume +": return { kind: "media", action: "volumeUp" };
    case "Volume -": return { kind: "media", action: "volumeDown" };
  }
  let match = /^Rapid Fire (\d+)ms x(\d+)$/.exec(label);
  if (match) {
    return {
      kind: "rapidFire",
      intervalMs: Number(match[1]),
      clickCount: Number(match[2]),
    };
  }
  match = /^Macro (\d)(?: (.+))?$/.exec(label);
  if (match) {
    const macroNumber = Number(match[1]) - 1;
    const modeLabel: string | undefined = match[2];
    if (!Number.isInteger(macroNumber) || macroNumber < 0 || macroNumber > 3) {
      throw new Error(`Unknown button action "${label}".`);
    }
    const modeName = modeLabel === undefined
      ? "once"
      : (Object.entries(WALLHACK_MACRO_MODE_LABELS).find(([, name]) => name === modeLabel)?.[0] ?? null);
    if (modeName === null) throw new Error(`Unknown button action "${label}".`);
    return {
      kind: "macro",
      macroNumber,
      stop: { mode: modeName as "once" | "finishCycleOnRelease" | "toggle" | "stopOnRelease" },
    };
  }
  match = /^Key (\d+)(?: \+(\d+))?$/.exec(label);
  if (match) return { kind: "key", modifiers: Number(match[2] ?? 0), hidUsage: Number(match[1]) };
  match = /^Unknown \((\d+),(\d+),(\d+)\)$/.exec(label);
  if (match) {
    return {
      kind: "unknown",
      triplet: { keyType: Number(match[1]), codeL: Number(match[2]), codeH: Number(match[3]) },
    };
  }
  throw new Error(`Unknown button action "${label}".`);
}

/** `GET_KEYS` read-all packet (8 slots × 3 bytes). */
export function wallhackBuildGetKeys(slots = WALLHACK_KEY_SLOTS): Uint8Array {
  return wallhackReport([0, 0, WALLHACK_COMMAND.getKeys, slots * WALLHACK_TRIPLET_SIZE, 0, 0, 0]);
}

/** `GET_DEFAULT_KEYS` read-all packet. */
export function wallhackBuildGetDefaultKeys(slots = WALLHACK_KEY_SLOTS): Uint8Array {
  return wallhackReport([0, 0, WALLHACK_COMMAND.getDefaultKeys, slots * WALLHACK_TRIPLET_SIZE, 0, 0, 0]);
}

/**
 * `SET_KEYS` write packet for `triplets` at triplet offset `start`
 * (slot N starts at offset N*3).
 */
export function wallhackBuildSetKeys(triplets: readonly WallhackTriplet[], start = 0): Uint8Array {
  const body = new Uint8Array(triplets.length * WALLHACK_TRIPLET_SIZE);
  triplets.forEach((triplet, index) => {
    body.set([triplet.keyType, triplet.codeL, triplet.codeH], index * WALLHACK_TRIPLET_SIZE);
  });
  const header = [0, 0, WALLHACK_COMMAND.setKeys, body.length, start & 0xff, (start >> 8) & 0xff, 0];
  return wallhackReport([...header, ...body]);
}

/**
 * Decode a `GET_KEYS`/`GET_DEFAULT_KEYS` reply: byte 3 is the payload length
 * and the triplets start at byte 7. Returns null when malformed.
 */
export function wallhackDecodeKeysReply(response: Uint8Array): WallhackTriplet[] | null {
  if (response.length < 8) return null;
  const length = response[3]!;
  const payload = response.subarray(7, 7 + Math.min(length, response.length - 7));
  const triplets: WallhackTriplet[] = [];
  for (let offset = 0; offset + WALLHACK_TRIPLET_SIZE <= payload.length; offset += WALLHACK_TRIPLET_SIZE) {
    triplets.push({ keyType: payload[offset]!, codeL: payload[offset + 1]!, codeH: payload[offset + 2]! });
  }
  return triplets;
}

// ---------------------------------------------------------------------------
// Macros (GET_MACRO / SET_MACRO)
// ---------------------------------------------------------------------------

/**
 * Onboard macros: 4 slots (`Ja`), up to 30 steps each (`$i`). An index table
 * at offset 16 holds one u16LE content address per slot (0/0xFFFF = empty);
 * content lives from offset 32 in 16-byte-aligned, 128-byte-max records
 * (`Fu`/`Jp`/`GB`). One step packs into 4 bytes: `delayMs u16LE`,
 * `eventType|make + code`. Set-macro payloads are written in 24-byte blocks.
 */
export const WALLHACK_MACRO_SLOTS = 4;
export const WALLHACK_MACRO_MAX_STEPS = 30;
export const WALLHACK_MACRO_INDEX_BASE = 16;
export const WALLHACK_MACRO_CONTENT_BASE = 32;
export const WALLHACK_MACRO_SLOT_BYTES = 128;
export const WALLHACK_MACRO_WRITE_BLOCK = 24;

export type WallhackMacroEvent =
  | { type: "keyDown" | "keyUp"; hidUsage: number }
  | { type: "buttonDown" | "buttonUp"; button: string }
  | { type: "wheel"; direction: "up" | "down" }
  | { type: "wheelReset" }
  | { type: "move"; axis: "x" | "y"; delta: number };

export interface WallhackMacroStep {
  delayMs: number;
  event: WallhackMacroEvent;
}

const WALLHACK_MACRO_CODE = { msButton: 1, wheel: 3, x: 4, y: 5, kbModifier: 9, kbOrdinary: 10 } as const;
const WALLHACK_MODIFIER_BASE = 224;

function wallhackModifierBit(hidUsage: number): number | null {
  return hidUsage >= WALLHACK_MODIFIER_BASE && hidUsage <= WALLHACK_MODIFIER_BASE + 7
    ? 1 << (hidUsage - WALLHACK_MODIFIER_BASE)
    : null;
}

function wallhackBitToModifier(bit: number): number | null {
  if (bit === 0 || (bit & (bit - 1)) !== 0) return null;
  return WALLHACK_MODIFIER_BASE + Math.log2(bit);
}

/** Encode macro steps into the content-record bytes (`tO`). Throws when invalid. */
export function wallhackEncodeMacro(steps: readonly WallhackMacroStep[]): Uint8Array {
  if (steps.length > WALLHACK_MACRO_MAX_STEPS) {
    throw new Error(`Macro has ${steps.length} steps; the slot holds ${WALLHACK_MACRO_MAX_STEPS}.`);
  }
  const record = new Uint8Array(4 + steps.length * 4);
  record[0] = steps.length & 0xff;
  record[1] = (steps.length >> 8) & 0xff;
  steps.forEach((step, index) => {
    const base = 4 + index * 4;
    record[base] = step.delayMs & 0xff;
    record[base + 1] = (step.delayMs >> 8) & 0xff;
    const { event } = step;
    switch (event.type) {
      case "keyDown":
      case "keyUp": {
        const bit = wallhackModifierBit(event.hidUsage);
        record[base + 2] = (bit === null ? WALLHACK_MACRO_CODE.kbOrdinary : WALLHACK_MACRO_CODE.kbModifier) |
          (event.type === "keyDown" ? 128 : 0);
        record[base + 3] = bit ?? event.hidUsage;
        break;
      }
      case "buttonDown":
      case "buttonUp": {
        const bits = WALLHACK_BUTTON_BITS[event.button as WallhackPhysicalButton];
        if (bits === undefined) throw new Error(`Unknown WALLHACK mouse button "${event.button}".`);
        record[base + 2] = WALLHACK_MACRO_CODE.msButton | (event.type === "buttonDown" ? 128 : 0);
        record[base + 3] = bits;
        break;
      }
      case "wheel":
      case "wheelReset":
        record[base + 2] = WALLHACK_MACRO_CODE.wheel | (event.type === "wheel" ? 128 : 0);
        record[base + 3] = event.type === "wheelReset" ? 255 : event.direction === "up" ? 1 : 255;
        break;
      case "move": {
        if (!Number.isInteger(event.delta) || event.delta === 0 || Math.abs(event.delta) > 255) {
          throw new Error("Macro movement must be a non-zero integer from -255 to 255.");
        }
        record[base + 2] = WALLHACK_MACRO_CODE[event.axis] | (event.delta < 0 ? 128 : 0);
        record[base + 3] = Math.abs(event.delta);
        break;
      }
    }
  });
  return record;
}

/** Decode a macro content record into steps (`nO`). Returns null when malformed. */
export function wallhackDecodeMacro(record: Uint8Array): WallhackMacroStep[] | null {
  if (record.length < 4) return null;
  const count = (record[0]! | (record[1]! << 8)) & 0xffff;
  const steps: WallhackMacroStep[] = [];
  for (let index = 0; index < count; index++) {
    const base = 4 + index * 4;
    if (base + 4 > record.length || steps.length >= WALLHACK_MACRO_MAX_STEPS) break;
    const delayMs = (record[base]! | (record[base + 1]! << 8)) & 0xffff;
    const codeType = record[base + 2]! & 127;
    const make = (record[base + 2]! & 128) !== 0;
    const code = record[base + 3]!;
    if (codeType === WALLHACK_MACRO_CODE.kbOrdinary || codeType === WALLHACK_MACRO_CODE.kbModifier) {
      const hidUsage = codeType === WALLHACK_MACRO_CODE.kbModifier ? wallhackBitToModifier(code) : code;
      if (hidUsage === null) continue;
      steps.push({ delayMs, event: { type: make ? "keyDown" : "keyUp", hidUsage } });
    } else if (codeType === WALLHACK_MACRO_CODE.msButton) {
      const button = wallhackLookupKey(WALLHACK_BUTTON_BITS as unknown as Record<string, number>, code);
      if (button) steps.push({ delayMs, event: { type: make ? "buttonDown" : "buttonUp", button } });
    } else if (codeType === WALLHACK_MACRO_CODE.wheel) {
      if (code === 1 || code === 255) {
        steps.push({
          delayMs,
          event: make
            ? { type: "wheel", direction: code === 1 ? "up" : "down" }
            : { type: "wheelReset" },
        });
      }
    } else if (codeType === WALLHACK_MACRO_CODE.x || codeType === WALLHACK_MACRO_CODE.y) {
      steps.push({
        delayMs,
        event: { type: "move", axis: codeType === WALLHACK_MACRO_CODE.x ? "x" : "y", delta: make ? -code : code },
      });
    }
  }
  return steps;
}

/** `GET_MACRO` read packet for `length` bytes at `address` (`Mv`). */
export function wallhackBuildGetMacro(address: number, length: number): Uint8Array {
  return wallhackReport([0, 0, WALLHACK_COMMAND.getMacro, length, address & 0xff, (address >> 8) & 0xff, 0]);
}

/** `SET_MACRO` write packet for `bytes` at `address` (`PB`). */
export function wallhackBuildSetMacro(address: number, bytes: readonly number[]): Uint8Array {
  return wallhackReport([0, 0, WALLHACK_COMMAND.setMacro, bytes.length, address & 0xff, (address >> 8) & 0xff, 0, ...bytes]);
}

/** Payload bytes of a `GET_MACRO` reply (from byte 7, per byte 3). */
export function wallhackMacroReplyBytes(response: Uint8Array): Uint8Array | null {
  if (response.length < 8) return null;
  return response.subarray(7, 7 + Math.min(response[3]!, response.length - 7)).slice();
}

/** Index-table address for macro slot N. */
export function wallhackMacroIndexAddress(slot: number): number {
  return WALLHACK_MACRO_INDEX_BASE + slot * 2;
}

/**
 * Write blocks that store `record` for `slot`, reusing the slot's current
 * address when it still fits and allocating a 16-byte-aligned,
 * non-overlapping range otherwise (ports the app's `FB`/`XB`). `index` maps
 * slot → content address for the slots currently on the device; pass an
 * empty map when unknown (always allocates fresh). An empty record clears
 * the slot: only the index write is returned.
 */
export function wallhackMacroWriteBlocks(
  slot: number,
  record: Uint8Array,
  index: ReadonlyMap<number, number>,
): { offset: number; bytes: number[] }[] {
  if (!Number.isInteger(slot) || slot < 0 || slot >= WALLHACK_MACRO_SLOTS) {
    throw new Error(`Macro slot ${slot} outside 0..${WALLHACK_MACRO_SLOTS - 1}.`);
  }
  const blocks: { offset: number; bytes: number[] }[] = [];
  const occupied = [...index.entries()]
    .filter(([other]) => other !== slot)
    .map(([, address]) => address)
    .filter((address) => Number.isInteger(address) && address >= WALLHACK_MACRO_CONTENT_BASE);
  const overlaps = (start: number, length: number): boolean =>
    occupied.some((address) => start < address + length && address < start + length);
  const current = index.get(slot);
  let address = 0;
  if (record.length > 0) {
    if (
      current !== undefined && current >= WALLHACK_MACRO_CONTENT_BASE &&
      current + record.length <= WALLHACK_MACRO_CONTENT_BASE + WALLHACK_MACRO_SLOTS * WALLHACK_MACRO_SLOT_BYTES &&
      !overlaps(current, record.length)
    ) {
      address = current;
    } else {
      const align = (value: number): number => (value + 15) & -16;
      const sorted = [...occupied].sort((a, b) => a - b);
      let candidate = WALLHACK_MACRO_CONTENT_BASE;
      for (const other of sorted) {
        if (candidate + record.length <= other) break;
        candidate = Math.max(candidate, align(other + record.length));
      }
      const top = WALLHACK_MACRO_CONTENT_BASE + WALLHACK_MACRO_SLOTS * WALLHACK_MACRO_SLOT_BYTES;
      if (!Number.isInteger(candidate) || candidate < WALLHACK_MACRO_CONTENT_BASE || candidate + record.length > top) {
        throw new Error("No non-overlapping macro storage range is available.");
      }
      address = candidate;
    }
  }
  blocks.push({ offset: wallhackMacroIndexAddress(slot), bytes: [address & 0xff, (address >> 8) & 0xff] });
  for (let offset = 0; offset < record.length; offset += WALLHACK_MACRO_WRITE_BLOCK) {
    blocks.push({ offset: address + offset, bytes: [...record.subarray(offset, offset + WALLHACK_MACRO_WRITE_BLOCK)] });
  }
  return blocks;
}
