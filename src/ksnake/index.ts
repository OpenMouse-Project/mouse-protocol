/**
 * K-snake X11 configuration protocol, reverse-engineered from the vendor
 * WebHID panel shipped at https://x1a11.yjx2012.com/ (Next.js `app/page` chunk).
 *
 * Transport: WebHID output report (`sendReport(0, 64 bytes starting with
 * 0x55)`) with the reply arriving as a queued `inputreport` — not a feature
 * report. Control collection is usage page 0xFF01, usage 0x10; the vendor
 * picker requests:
 *   [{ vendorId: 0xA8A4, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 },
 *    { vendorId: 0xA8A5, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 }]
 * 0xA8A4 reports "USB", 0xA8A5 is the 2.4 GHz dongle.
 *
 * This module is transport-independent: it only builds 64-byte report bodies
 * and decodes reply buffers. See `src/drivers/ksnake/hid.ts` for the WebHID
 * exchange queue.
 */

export const KSNAKE_USB_VENDOR_ID = 0xa8a4;
export const KSNAKE_DONGLE_VENDOR_ID = 0xa8a5;
export const KSNAKE_PRODUCT_ID = 0x2255;
export const KSNAKE_USAGE_PAGE = 0xff01;
export const KSNAKE_USAGE = 0x10;

export const KSNAKE_REPORT_ID = 0x00;
export const KSNAKE_MAGIC = 0x55;
export const KSNAKE_REPORT_SIZE = 64;

/** DPI range. Vendor panel slider allows 200–12000 (step 100); the manual's
 *  factory steps are 800–12000 and 600 was observed in stage 0 on retail
 *  hardware (user-customized via the vendor panel). */
export const KSNAKE_DPI_MIN = 200;
export const KSNAKE_DPI_MAX = 12000;

export function ksnakeIsValidDpi(dpi: number): boolean {
  return Number.isInteger(dpi) && dpi >= KSNAKE_DPI_MIN && dpi <= KSNAKE_DPI_MAX;
}

export interface KsnakeProduct {
  model: string;
  wireless: boolean;
  /** Not yet exercised on hardware through this driver. */
  verified: false;
}

export const KSNAKE_PRODUCTS: ReadonlyMap<number, KsnakeProduct> = new Map([
  [KSNAKE_PRODUCT_ID, { model: "X11", wireless: true, verified: false }],
]);

const CMD = {
  GET_VERSION: 0x03,
  GET_KEYS: 0x08,
  SET_KEYS: 0x09,
  GET_CONFIG: 0x0e,
  SET_CONFIG: 0x0f,
  SET_LIGHT: 0x21,
  GET_BATTERY: 0x30,
} as const;

const GET_CONFIG_TAIL = [0xa5, 0x0b, 0x2f, 0x01, 0x01, 0x00, 0x00, 0x00] as const;
const SET_CONFIG_HEAD = [0xae, 0x0a, 0x2f, 0x01, 0x01, 0x00, 0x00] as const;
const GET_BATTERY_TAIL = [0xa5, 0x0b, 0x2e, 0x01, 0x01, 0x00, 0x00, 0x00] as const;

/**
 * Polling-rate index ↔ Hz.
 * Endpoints confirmed by the X11 user manual: 1000 Hz in 2.4G/wired,
 * 125 Hz in BT. Middle steps (250/500) come from the vendor panel screenshot
 * + PAW3311 spec — keep until a hardware capture says otherwise.
 * Default index 3 = 1000 Hz.
 */
export const KSNAKE_POLLING_RATES = [125, 250, 500, 1000] as const;

export function ksnakeEncodePollingRate(hz: number): number | null {
  const index = (KSNAKE_POLLING_RATES as readonly number[]).indexOf(hz);
  return index === -1 ? null : index;
}

export function ksnakeDecodePollingRate(index: number): number | null {
  return index >= 0 && index < KSNAKE_POLLING_RATES.length ? KSNAKE_POLLING_RATES[index] : null;
}

/**
 * Lift-off mapping. The vendor panel offers two stops (lod_value 1/2,
 * default 1, likely 1mm/2mm on the PAW3311); they map to the Low/High stops.
 * Medium is not offered by the hardware.
 */
export function ksnakeDecodeLiftOff(value: number): "Low" | "High" {
  return value === 2 ? "High" : "Low";
}

export function ksnakeEncodeLiftOff(level: string): number | null {
  if (level === "Low") return 1;
  if (level === "High") return 2;
  return null;
}

export const KSNAKE_DEFAULT_CONFIG = {
  lightMode: 2,
  reportRate: 3,
  dpiIndex: 2,
  // Hardware reports 6 (retail 2.4 GHz dongle, FW 2.1.7).
  dpiCount: 6,
  stages: [800, 1200, 1600, 3200, 5000, 12000],
  scrollFlag: 0,
  lodValue: 1,
  sensorFlag: 53,
  keyRespond: 2,
  sleepLight: 10,
  highspeedMode: 0,
  wakeupFlag: 1,
  moveLightFlag: 1,
} as const;

export interface KsnakeConfig {
  lightMode: number;
  /** 0-based index into KSNAKE_POLLING_RATES */
  reportRate: number;
  /** 0-based active DPI stage */
  dpiIndex: number;
  /** number of enabled DPI stages */
  dpiCount: number;
  /** up to 6 LE uint16 DPI stages */
  stages: number[];
  scrollFlag: number;
  lodValue: number;
  sensorFlag: number;
  keyRespond: number;
  sleepLight: number;
  highspeedMode: number;
  wakeupFlag: number;
  moveLightFlag: number;
}

function le16(lo: number, hi: number): number {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

/** 64-byte output-report body (without the reportId prefix). */
export function ksnakeGetVersionRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_VERSION;
  return buf;
}

/** Vendor reply bytes [23..25] hold ASCII "x.y.z" when present. */
export function ksnakeDecodeVersion(reply: Uint8Array): string | null {
  if (reply.length < 26) return null;
  const digit = (b: number): string | null => (b >= 48 && b <= 57 ? String.fromCharCode(b) : null);
  const major = digit(reply[23]);
  const minor = digit(reply[24]);
  const patch = digit(reply[25]);
  if (major === null || minor === null || patch === null) return null;
  return `${major}.${minor}.${patch}`;
}

export function ksnakeGetBatteryRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_BATTERY;
  GET_BATTERY_TAIL.forEach((b, i) => {
    buf[2 + i] = b;
  });
  return buf;
}

export function ksnakeDecodeBattery(reply: Uint8Array): { percent: number; charging: number } | null {
  if (reply.length < 10) return null;
  return { percent: reply[8] & 0xff, charging: reply[9] & 0xff };
}

export function ksnakeGetConfigRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_CONFIG;
  GET_CONFIG_TAIL.forEach((b, i) => {
    buf[2 + i] = b;
  });
  return buf;
}

/** Decode a getConfig reply, mirroring the vendor `getMouseConfigInfo()`. */
export function ksnakeDecodeConfig(reply: Uint8Array): KsnakeConfig | null {
  if (reply.length < 56) return null;
  const blank = reply[13] === 0 && reply[14] === 0 && reply[15] === 0;
  const erased = reply[13] === 255 && reply[14] === 255 && reply[15] === 255;
  if (blank || erased) {
    return { ...KSNAKE_DEFAULT_CONFIG, stages: [...KSNAKE_DEFAULT_CONFIG.stages] };
  }
  return {
    lightMode: reply[9],
    reportRate: reply[10] - 1,
    dpiIndex: reply[12] - 1,
    dpiCount: reply[11],
    stages: [
      le16(reply[13], reply[14]),
      le16(reply[15], reply[16]),
      le16(reply[17], reply[18]),
      le16(reply[19], reply[20]),
      le16(reply[21], reply[22]),
      le16(reply[23], reply[24]),
    ],
    scrollFlag: reply[48],
    lodValue: reply[49],
    sensorFlag: reply[50],
    keyRespond: reply[51],
    sleepLight: reply[52],
    highspeedMode: reply[53],
    // NOTE: the vendor panel itself is asymmetric here — its decode reads
    // wakeup from the LOW nibble (`15 & t[55]`) but its encode writes
    // `wakeup << 4 | move`. This codec mirrors the vendor byte-for-byte, so
    // states round-trip exactly like the vendor panel does.
    wakeupFlag: reply[55] & 15,
    moveLightFlag: (reply[55] >> 4) & 15,
  };
}

/** Encode a setConfig request, mirroring vendor `setMouseConfigData()`. */
export function ksnakeEncodeSetConfig(config: KsnakeConfig): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.SET_CONFIG;
  SET_CONFIG_HEAD.forEach((b, i) => {
    buf[2 + i] = b;
  });
  buf[9] = config.lightMode & 0xff;
  buf[10] = (config.reportRate + 1) & 0xff;
  buf[11] = config.dpiCount & 0xff;
  buf[12] = (config.dpiIndex + 1) & 0xff;
  const stages = [...config.stages];
  while (stages.length < 6) stages.push(0);
  for (let i = 0; i < 6; i++) {
    buf[13 + i * 2] = stages[i] & 0xff;
    buf[14 + i * 2] = (stages[i] >> 8) & 0xff;
  }
  buf[48] = config.scrollFlag & 0xff;
  buf[49] = config.lodValue & 0xff;
  buf[50] = config.sensorFlag & 0xff;
  buf[51] = config.keyRespond & 0xff;
  buf[52] = config.sleepLight & 0xff;
  buf[53] = config.highspeedMode & 0xff;
  buf[54] = ((config.wakeupFlag << 4) | (config.moveLightFlag & 15)) & 0xff;
  return buf;
}

/** Physical button order for the 6 remappable slots. Labels follow the factory
 *  functions; the side button ships as Forward (user-renameable to Macro1). */
export const KSNAKE_BUTTON_NAMES = ["Left", "Right", "Middle", "Backward", "Forward", "DPI"] as const;

/** Button function types from the vendor key catalog. */
export const KSNAKE_KEY_TYPE = {
  mouse: 32,
  special: 33,
  media: 48,
} as const;

/** One button slot: type 32 = mouse button (code1 = HID bitmask, 0 = disabled),
 *  33 = special (DPI loop [85,0,0], scroll [56,1/255]), 48 = consumer/media
 *  (code1 = consumer usage). Macro references (e.g. type 112) are preserved
 *  opaquely — the catalog cannot rebuild them. */
export interface KsnakeKeyBinding {
  type: number;
  code1: number;
  code2: number;
  code3: number;
}

export function ksnakeIsKnownKeyType(type: number): boolean {
  return type === KSNAKE_KEY_TYPE.mouse || type === KSNAKE_KEY_TYPE.special || type === KSNAKE_KEY_TYPE.media;
}

/**
 * Plausibility gate for decoded key maps. `exchange()` resolves with the next
 * input report, so a stray report from another command can land here; those
 * decode to zeroed/garbage slot types. Real maps always carry nonzero types
 * (32/33/48 catalog, plus opaque refs like macro 112).
 */
export function ksnakeKeysLookPlausible(keys: readonly KsnakeKeyBinding[]): boolean {
  return keys.length === 7 && keys.every((key) => key.type !== 0);
}

/** GET_KEYS request tail observed in vendor JS: [0x55, 0x08, 0xA5, 0x0B, 0x20]. */
export function ksnakeGetKeysRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_KEYS;
  buf[2] = 0xa5;
  buf[3] = 0x0b;
  buf[4] = 0x20;
  return buf;
}

/**
 * Decode a getKeys reply: 7 slots of 4 bytes at reply[8..35] (the vendor
 * slices 8). Slot 6 is a fixed scroll-up entry; slots 0-5 are remappable.
 * Verified against a retail dongle (factory map decodes to
 * Left/Right/Middle/Backward + DPI loop in order).
 */
export function ksnakeDecodeKeys(reply: Uint8Array): KsnakeKeyBinding[] | null {
  if (reply.length < 36) return null;
  const bindings: KsnakeKeyBinding[] = [];
  for (let i = 0; i < 7; i++) {
    bindings.push({
      type: reply[8 + i * 4],
      code1: reply[9 + i * 4],
      code2: reply[10 + i * 4],
      code3: reply[11 + i * 4],
    });
  }
  return bindings;
}

/**
 * Encode a setKeys request, mirroring vendor `setMouseKeys()`: head
 * [0x55, 0x09, 0xA5, 0x22, 0x20], slots 0-5 at body[9..32], fixed tail
 * [33,56,1,0, 33,56,255,0] at body[33..40].
 */
export function ksnakeEncodeSetKeys(keys: readonly KsnakeKeyBinding[]): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.SET_KEYS;
  buf[2] = 0xa5;
  buf[3] = 0x22;
  buf[4] = 0x20;
  const slots = [...keys].slice(0, 6);
  while (slots.length < 6) slots.push({ type: 32, code1: 0, code2: 0, code3: 0 });
  // Wire offsets, NOT vendor-JS t[] indices: t[0] is the report id, so the
  // request slots at t[9..32] land at data[8..31]. (buf[9..] bricked buttons.)
  for (let n = 0; n < 6; n++) {
    const key = slots[n];
    buf[8 + n * 4] = key.type & 0xff;
    buf[9 + n * 4] = key.code1 & 0xff;
    buf[10 + n * 4] = key.code2 & 0xff;
    buf[11 + n * 4] = key.code3 & 0xff;
  }
  const tail = [33, 56, 1, 0, 33, 56, 255, 0];
  tail.forEach((b, i) => {
    buf[32 + i] = b;
  });
  return buf;
}
