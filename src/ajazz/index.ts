/**
 * AJAZZ NJ07 / NJ08 configuration protocol ("V1" device class of the vendor
 * WebHID panel at https://nacodex.yjx2012.com/, Next.js chunk 515).
 *
 * No hardware capture exists. Every byte here was read off that panel's
 * JavaScript, so the driver is unverified until an owner confirms it.
 *
 * Transport: output report 0xF0 carrying 63 bytes, answered by an input
 * report whose first data byte echoes the command. The control collection is
 * usage page 0xFF01, usage 0x10, and the panel's device picker requests
 *   [{ vendorId: 0xA8A4, productId, usagePage: 0xFF01, usage: 0x10 },
 *    { vendorId: 0xA8A5, productId, usagePage: 0xFF01, usage: 0x10 }]
 * for each product id below. 0xA8A4 is the wired mouse, 0xA8A5 the 2.4 GHz
 * dongle.
 *
 * This is the same command family as the K-snake X11 (`../ksnake`), with a
 * different first byte and different header bytes. All offsets below are in
 * "body coordinates": index 0 of the 63 bytes WebHID sends, which is also
 * index 0 of the data WebHID hands back (the report id is stripped).
 *
 * This module is transport-independent; `src/drivers/ajazz/hid.ts` does the
 * WebHID exchange.
 */

export const AJAZZ_USB_VENDOR_ID = 0xa8a4;
export const AJAZZ_DONGLE_VENDOR_ID = 0xa8a5;
export const AJAZZ_USAGE_PAGE = 0xff01;
export const AJAZZ_USAGE = 0x10;
export const AJAZZ_REPORT_ID = 0xf0;
export const AJAZZ_BODY_BYTES = 63;

export interface AjazzProduct {
  model: string;
  /** Top of the vendor panel's DPI slider for this model. */
  maxDpi: number;
}

/**
 * Product ids the vendor panel requests, with the DPI range of each model's
 * panel config (`mouse_info_nj07*.json`, `mouse_info_nj08*.json`). The panel
 * also requests 0x2255 (shared with the K-snake X11, so owned by that driver)
 * and 0x2216 on VIDs 0xA8A7/0xA8A9; those need a descriptor to tell apart.
 */
export const AJAZZ_PRODUCTS: ReadonlyMap<number, AjazzProduct> = new Map([
  [0x2157, { model: "NJ07", maxDpi: 12800 }],
  [0x2158, { model: "NJ08", maxDpi: 12800 }],
  [0x2167, { model: "NJ07 MC", maxDpi: 24000 }],
  [0x2168, { model: "NJ08 MC", maxDpi: 24000 }],
  [0x2177, { model: "NJ07 MC PRO", maxDpi: 24000 }],
  [0x2178, { model: "NJ08 MC PRO", maxDpi: 24000 }],
]);

export const AJAZZ_DPI_MIN = 50;
export const AJAZZ_DPI_STEP = 50;
export const AJAZZ_DPI_STAGES = 6;

export function ajazzIsValidDpi(dpi: number, maxDpi: number): boolean {
  return Number.isInteger(dpi) && dpi >= AJAZZ_DPI_MIN && dpi <= maxDpi;
}

/** Polling rate by 0-based index, as the config block stores it. */
export const AJAZZ_POLLING_RATES = [125, 250, 500, 1000] as const;

/** The panel's per-model config lists 125, 500 and 1000 Hz on USB and 2.4G. */
export const AJAZZ_OFFERED_POLLING_RATES = [125, 500, 1000] as const;

export function ajazzEncodePollingRate(hz: number): number | null {
  const index = (AJAZZ_POLLING_RATES as readonly number[]).indexOf(hz);
  return index === -1 ? null : index;
}

export function ajazzDecodePollingRate(index: number): number | null {
  return index >= 0 && index < AJAZZ_POLLING_RATES.length ? AJAZZ_POLLING_RATES[index] : null;
}

/** Auto-sleep choices offered in the UI, in seconds. The panel allows 1 to 100 minutes. */
export const AJAZZ_SLEEP_OPTIONS = [60, 180, 300, 600, 1200, 1800, 3600] as const;

/** The panel's sleep slider runs 0 to 100 minutes and 0 means never sleep. */
export const AJAZZ_SLEEP_MAX_MINUTES = 100;

export function ajazzIsValidSleepSeconds(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= 60 &&
    seconds % 60 === 0 &&
    seconds / 60 <= AJAZZ_SLEEP_MAX_MINUTES
  );
}

const CMD = {
  GET_VERSION: 0x04,
  GET_CONFIG: 0x0e,
  SET_CONFIG: 0x0f,
  GET_BATTERY: 0x30,
} as const;

export const AJAZZ_CMD = CMD;

/** Config block as the panel's `getMouseConfigInfo()` / `setMouseConfigData()` see it. */
export interface AjazzConfig {
  lightMode: number;
  /** 0-based index into AJAZZ_POLLING_RATES */
  reportRate: number;
  /** Number of enabled DPI stages (the panel's `dpi_count` / `dpi_flag`). */
  dpiCount: number;
  /** 0-based active DPI stage */
  dpiIndex: number;
  /** Six little-endian uint16 DPI stages */
  stages: number[];
  /** 0 forward, 1 reverse */
  scrollFlag: number;
  lodValue: number;
  /** Bit 0 is the panel's "line correction" (angle snapping). */
  sensorFlag: number;
  keyRespond: number;
  /** Auto-sleep in minutes, 0 = never */
  sleepMinutes: number;
  highspeedMode: number;
  /**
   * The panel writes `wakeup << 4 | moveLight` here but reads both fields back
   * from the high nibble, so it is carried as one opaque byte.
   */
  wakeByte: number;
}

/** What the panel substitutes when the config block reads back blank or erased. */
export const AJAZZ_BLANK_CONFIG: Readonly<AjazzConfig> = {
  lightMode: 0,
  reportRate: 3,
  dpiCount: 6,
  dpiIndex: 2,
  stages: [800, 1600, 2400, 3200, 5000, 12000],
  scrollFlag: 0,
  lodValue: 1,
  sensorFlag: 53,
  keyRespond: 8,
  sleepMinutes: 10,
  highspeedMode: 0,
  wakeByte: 0x10,
};

function body(...head: number[]): Uint8Array {
  const out = new Uint8Array(AJAZZ_BODY_BYTES);
  out.set(head);
  return out;
}

function le16(lo: number, hi: number): number {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

export function ajazzGetVersionRequest(): Uint8Array {
  return body(CMD.GET_VERSION, 0x01);
}

export function ajazzGetBatteryRequest(): Uint8Array {
  return body(CMD.GET_BATTERY, 0x01);
}

export function ajazzGetConfigRequest(): Uint8Array {
  return body(CMD.GET_CONFIG, 0x01, 0x0b, 0x2e);
}

/**
 * The panel keeps the last five printable characters of the reply after the
 * two header bytes ("x.y.z"); the rest of the report is padding.
 */
export function ajazzDecodeVersion(reply: Uint8Array): string | null {
  if (reply[0] !== CMD.GET_VERSION) return null;
  const printable = [...reply.slice(2)].filter((b) => b >= 32 && b <= 126);
  return printable.length ? String.fromCharCode(...printable.slice(-5)) : null;
}

/** Battery percent at byte 7 and a charge flag at byte 8 (nonzero while charging). */
export function ajazzDecodeBattery(reply: Uint8Array): { percent: number; charging: boolean } | null {
  if (reply[0] !== CMD.GET_BATTERY || reply.length < 9) return null;
  return { percent: reply[7], charging: reply[8] !== 0 };
}

/**
 * Decode a GET_CONFIG reply. Like the panel, an all-zero or all-0xFF run at
 * bytes 13 to 15 means the flash was never written and the defaults apply.
 */
export function ajazzDecodeConfig(reply: Uint8Array): AjazzConfig | null {
  if (reply[0] !== CMD.GET_CONFIG || reply.length < 54) return null;
  const run = [reply[13], reply[14], reply[15]];
  if (run.every((b) => b === 0) || run.every((b) => b === 0xff)) {
    return { ...AJAZZ_BLANK_CONFIG, stages: [...AJAZZ_BLANK_CONFIG.stages] };
  }
  return {
    lightMode: reply[8],
    reportRate: reply[9] - 1,
    dpiCount: reply[10],
    dpiIndex: Math.max(reply[11] - 1, 0),
    stages: Array.from({ length: AJAZZ_DPI_STAGES }, (_, i) => le16(reply[12 + i * 2], reply[13 + i * 2])),
    scrollFlag: reply[47],
    lodValue: reply[48],
    sensorFlag: reply[49],
    keyRespond: reply[50],
    sleepMinutes: reply[51],
    highspeedMode: reply[52],
    wakeByte: reply[53],
  };
}

/**
 * SET_CONFIG always rewrites the whole block; bytes 4 to 7 and 24 to 46 stay
 * zero exactly as the panel sends them.
 */
export function ajazzEncodeSetConfig(config: AjazzConfig): Uint8Array {
  const out = body(CMD.SET_CONFIG, 0x01, 0x0a, 0x2f);
  out[8] = config.lightMode;
  out[9] = config.reportRate + 1;
  out[10] = config.dpiCount;
  out[11] = config.dpiIndex + 1;
  config.stages.slice(0, AJAZZ_DPI_STAGES).forEach((dpi, i) => {
    out[12 + i * 2] = dpi & 0xff;
    out[13 + i * 2] = (dpi >> 8) & 0xff;
  });
  out[47] = config.scrollFlag;
  out[48] = config.lodValue;
  out[49] = config.sensorFlag;
  out[50] = config.keyRespond;
  out[51] = config.sleepMinutes;
  out[52] = config.highspeedMode;
  out[53] = config.wakeByte;
  return out;
}
