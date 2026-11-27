// Transport-independent read-back framing for the 0x1d57 X11-style receiver.
//
// The config reports (0x04 DPI table, 0x06 polling rate, 0x0b firmware
// version, ...) cannot be fetched with a bare GET_FEATURE: until the firmware
// is asked for one, a GET returns whatever its control buffer last held
// (descriptor bytes, string descriptors, code). Reading takes a handshake on
// report 0xa0, the same one the vendor app (AttackShark.exe, MS_4 page) uses:
//
//   1. SET_FEATURE 0xa0 [report, length, 0, flag, 0, 0, 0]
//   2. GET_FEATURE 0xa0 until byte 1 (after the report id) is 0x01
//   3. GET_FEATURE report
//
// Verified on a genuine X11 receiver (1d57:fa60, firmware 0x0107) over Linux
// hidraw: every report below was ready on the first poll. Protocol notes:
// github.com/higajooj/x11 PROTOCOL.md.

export const X11_QUERY_REPORT_ID = 0xa0;
export const X11_POWER_REPORT_ID = 0x05;
export const X11_POLLING_REPORT_ID = 0x06;
export const X11_BUTTON_REPORT_ID = 0x08;
export const X11_MACRO_REPORT_ID = 0x09;
export const X11_VERSION_REPORT_ID = 0x0b;

/** Length byte each report carries at offset 1 (its full size on the receiver). */
export const X11_REPORT_LENGTHS: Readonly<Record<number, number>> = {
  0x04: 0x38,
  [X11_POWER_REPORT_ID]: 0x0f,
  [X11_POLLING_REPORT_ID]: 0x09,
  [X11_BUTTON_REPORT_ID]: 0x3b,
  [X11_VERSION_REPORT_ID]: 0x08,
};

export const X11_SLEEP_OPTIONS = Array.from({ length: 60 }, (_, i) => (i + 1) * 30);
export const X11_DEBOUNCE_OPTIONS = Array.from({ length: 24 }, (_, i) => 4 + i * 2);
export const X11_LIGHT_MODES = ["Off", "Static", "Breathing single", "Neon", "Breathing random", "Static DPI", "Breathing DPI"] as const;
export const X11_LIGHT_SPEEDS = [1, 2, 3, 4, 5] as const;
export const X11_LIGHT_BRIGHTNESS = [13, 25, 38, 50, 63, 75, 88, 100] as const;

export interface X11PowerSettings {
  sleepSeconds: number;
  debounceMs: number;
  deepSleepMinutes: number;
  lightMode: number;
  lightSpeed: number;
  brightness: number;
  color: string;
}

function x11PowerChecksum(report: Uint8Array): number {
  return report.subarray(3, 11).reduce((sum, byte) => sum + byte, 0);
}

export function decodeX11PowerReport(data: Uint8Array): (X11PowerSettings & { base: Uint8Array }) | null {
  const report = normalizeX11Report(X11_POWER_REPORT_ID, data);
  if (!report || report.length < 13 || report[2] !== 1) return null;
  if (x11PowerChecksum(report) !== ((report[11] << 8) | report[12])) return null;
  const sleepSeconds = report[9] * 30;
  const debounceMs = report[10] * 2;
  if (!X11_SLEEP_OPTIONS.includes(sleepSeconds) || !X11_DEBOUNCE_OPTIONS.includes(debounceMs)) return null;
  const brightness = report[5] & 0x0f;
  const lightSpeed = 6 - (report[4] & 0x0f);
  const deepSleepMinutes = (report[4] & 0xf0) | (report[5] >> 4);
  const color = `#${Array.from(report.subarray(6, 9), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return { sleepSeconds, debounceMs, deepSleepMinutes, lightMode: report[3] >> 4, lightSpeed, brightness, color,
    base: report.slice(0, X11_REPORT_LENGTHS[X11_POWER_REPORT_ID]) };
}

export function buildX11PowerReport(base: Uint8Array, changes: Partial<X11PowerSettings>, wired = false): Uint8Array<ArrayBuffer> {
  const power = decodeX11PowerReport(base);
  if (!power) throw new Error("The mouse did not return a valid power settings report.");
  const sleepSeconds = changes.sleepSeconds ?? power.sleepSeconds;
  const debounceMs = changes.debounceMs ?? power.debounceMs;
  if (!X11_SLEEP_OPTIONS.includes(sleepSeconds)) throw new RangeError("Sleep time must be 30 to 1800 seconds, in 30-second steps.");
  if (!X11_DEBOUNCE_OPTIONS.includes(debounceMs)) throw new RangeError("Debounce time must be an even 4 to 50 ms.");
  const report = new Uint8Array(X11_REPORT_LENGTHS[X11_POWER_REPORT_ID]);
  report.set(power.base);
  if (changes.lightMode !== undefined) {
    if (!Number.isInteger(changes.lightMode) || changes.lightMode < 0 || changes.lightMode >= X11_LIGHT_MODES.length) {
      throw new RangeError("Unsupported X11 lighting mode.");
    }
    report[3] = (changes.lightMode << 4) | (report[3] & 0x0f);
  }
  if (changes.deepSleepMinutes !== undefined) {
    const minutes = changes.deepSleepMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new RangeError("Deep sleep must be 1 to 60 minutes.");
    report[4] = (minutes & 0xf0) | (report[4] & 0x0f);
    report[5] = ((minutes & 0x0f) << 4) | (report[5] & 0x0f);
  }
  if (changes.lightSpeed !== undefined) {
    if (!(X11_LIGHT_SPEEDS as readonly number[]).includes(changes.lightSpeed)) throw new RangeError("Invalid X11 lighting speed.");
    report[4] = (report[4] & 0xf0) | (6 - changes.lightSpeed);
  }
  if (changes.brightness !== undefined) {
    if (!Number.isInteger(changes.brightness) || changes.brightness < 1 || changes.brightness > 8) {
      throw new RangeError("Invalid X11 brightness.");
    }
    report[5] = (report[5] & 0xf0) | changes.brightness;
  }
  if (changes.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(changes.color)) throw new TypeError("X11 lighting color must be #rrggbb.");
    report.set([1, 3, 5].map((offset) => parseInt(changes.color!.slice(offset, offset + 2), 16)), 6);
  }
  report[9] = sleepSeconds / 30;
  report[10] = debounceMs / 2;
  new DataView(report.buffer).setUint16(11, x11PowerChecksum(report));
  return wired ? report.subarray(0, 13) : report;
}

export const X11_BUTTON_SLOTS: Readonly<Record<string, number>> = { Left: 0, Right: 1, Middle: 2, Forward: 6, Back: 7 };
export type X11ButtonAction = readonly [number, number, number];

// Firmware returns a different order from its write layout. The fixed mode
// button occupies read slot 7. Write slot 5 has no editable counterpart.
const X11_BUTTON_READ_ORDER = [0, 1, 2, 3, -1, 7, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 17, 16];

export function decodeX11ButtonReport(data: Uint8Array): X11ButtonAction[] | null {
  const report = normalizeX11Report(X11_BUTTON_REPORT_ID, data);
  if (!report || report.length < 59 || report[2] !== 1) return null;
  const sum = report.subarray(3, 57).reduce((total, byte) => total + byte, 0);
  if (sum !== ((report[57] << 8) | report[58])) return null;
  const reordered = report[21] === 0x3c;
  if (!reordered && report[18] !== 0x0d) return null;
  return Array.from({ length: 18 }, (_, index) => {
    const slot = reordered ? X11_BUTTON_READ_ORDER[index] : index;
    if (slot < 0) return [1, 0, 0];
    const offset = 3 + slot * 3;
    return [report[offset], report[offset + 1], report[offset + 2]];
  });
}

export function buildX11ButtonReport(actions: readonly X11ButtonAction[]): Uint8Array<ArrayBuffer> {
  if (actions.length !== 18) throw new RangeError("The X11 button report requires 18 slots.");
  const report = new Uint8Array(59);
  report.set([X11_BUTTON_REPORT_ID, report.length, 1]);
  actions.forEach((action, slot) => report.set(action, 3 + slot * 3));
  const sum = report.subarray(3, 57).reduce((total, byte) => total + byte, 0);
  new DataView(report.buffer).setUint16(57, sum);
  return report;
}

export interface X11MacroEvent {
  usage: number;
  down: boolean;
  delayMs: number;
}

export function buildX11MacroReports(
  slot: number,
  events: readonly X11MacroEvent[],
  playback = 0,
  repeats = 1,
  name = "",
): Uint8Array<ArrayBuffer>[] {
  if (!Number.isInteger(slot) || slot < 1 || slot > 18) throw new RangeError("Invalid X11 macro slot.");
  if (![0, 1, 2].includes(playback) || !Number.isInteger(repeats) || repeats < 1 || repeats > 255) {
    throw new RangeError("Invalid X11 macro playback settings.");
  }
  const actions: number[] = [];
  for (const event of events) {
    if (!Number.isInteger(event.usage) || event.usage < 4 || event.usage > 0xf5
      || !Number.isFinite(event.delayMs) || event.delayMs < 0 || event.delayMs > 50_000) {
      throw new RangeError("Invalid X11 macro event.");
    }
    const direction = event.down ? 0 : 0x80;
    const delay = Math.max(1, Math.floor(event.delayMs / 10));
    if (delay <= 127) actions.push(direction | delay, event.usage);
    else actions.push(direction | (delay % 20), event.usage, Math.floor(delay / 20), 3);
  }
  if (actions.length === 0 || actions.length > 100) throw new RangeError("An X11 macro takes 1 to 50 action units.");
  const pages = [0, 1, 2].map((index) => {
    const page = new Uint8Array(64);
    page.set([X11_MACRO_REPORT_ID, index === 2 ? 12 : 64, slot, index]);
    return page;
  });
  pages[0][4] = playback;
  pages[0][8] = repeats;
  new TextEncoder().encodeInto(name, pages[0].subarray(9, 29));
  pages[0][29] = actions.length / 2;
  pages[0].set(actions.slice(0, 34), 30);
  pages[1].set(actions.slice(34, 94), 4);
  pages[2].set(actions.slice(94), 4);
  const sum = pages[0].subarray(4).reduce((total, byte) => total + byte, 0)
    + pages[1].subarray(4).reduce((total, byte) => total + byte, 0)
    + pages[2].subarray(4, 10).reduce((total, byte) => total + byte, 0);
  new DataView(pages[2].buffer).setUint16(10, sum);
  return pages;
}

const POLLING_CODES: ReadonlyMap<number, number> = new Map([
  [0x08, 125],
  [0x04, 250],
  [0x02, 500],
  [0x01, 1000],
]);

/**
 * Payload (report id excluded) asking the firmware to stage `reportId` for
 * reading. The vendor app sends flag 0 for the version report and 1 otherwise.
 */
export function buildX11QueryRequest(reportId: number, flag = 0x01): Uint8Array<ArrayBuffer> {
  const length = X11_REPORT_LENGTHS[reportId];
  if (length === undefined) throw new Error(`No read-back for report 0x${reportId.toString(16)}`);
  return new Uint8Array([reportId, length, 0x00, flag, 0x00, 0x00, 0x00]);
}

/**
 * True once a 0xa0 read says the requested report is staged. Accepts the
 * report with its leading id (hidapi, Chrome) or stripped (some adapters);
 * the ready byte is 0 or 1, so a leading 0xa0 can only be the id.
 */
export function x11QueryReady(reply: Uint8Array): boolean {
  return (reply[0] === X11_QUERY_REPORT_ID ? reply[1] : reply[0]) === 0x01;
}

/**
 * Normalise a read-back to its full layout with the leading report id, or
 * null when it does not carry the report's signature (id, then length byte).
 */
export function normalizeX11Report(reportId: number, data: Uint8Array): Uint8Array | null {
  const length = X11_REPORT_LENGTHS[reportId];
  if (length === undefined) return null;
  if (data[0] === reportId && data[1] === length) return data;
  if (data[0] === length) {
    const full = new Uint8Array(data.length + 1);
    full[0] = reportId;
    full.set(data, 1);
    return full;
  }
  return null;
}

/** Polling rate in Hz from report 0x06 (`06 09 01 <code> <~code>`), or null. */
export function decodeX11PollingReport(data: Uint8Array): number | null {
  const report = normalizeX11Report(X11_POLLING_REPORT_ID, data);
  if (!report || report.length < 5) return null;
  const code = report[3];
  if (((code ^ report[4]) & 0xff) !== 0xff) return null;
  return POLLING_CODES.get(code) ?? null;
}

/** Firmware version from report 0x0b (`0b 08 <hi> <lo>`), e.g. 0x0107, or null. */
export function decodeX11FirmwareVersion(data: Uint8Array): number | null {
  const report = normalizeX11Report(X11_VERSION_REPORT_ID, data);
  if (!report || report.length < 4) return null;
  return (report[2] << 8) | report[3];
}
