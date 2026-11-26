
export const X3_REPORT = { commit: 0x0c, sensor: 0x04, power: 0x05, polling: 0x06, buttons: 0x08, macro: 0x09 } as const;
export const X3_DPI_MIN = 50;
export const X3_DPI_MAX = 26000;
export const X3_DPI_STEP = 50;
export const X3_MAX_STAGES = 8;
export const X3_BUTTON_SLOTS = 18;
export const X3_MACRO_MAX_EVENTS = 50;
export const X3_RECEIVER_GAP_MS = 500;
export const X3_WIRED_GAP_MS = 15;
export const X3_MACRO_GAP_MS = 15;

export type X3Rgb = readonly [number, number, number];
export type X3Slot = readonly [number, number, number];
export type X3PollingHz = 125 | 250 | 500 | 1000;

export interface X3MacroEvent {
  usage: number;
  down: boolean;
}

export interface X3Settings {
  dpiStages: number[];
  enabledMask?: number;
  activeStage: number;
  stageColors: X3Rgb[];
  lod: 0 | 1;
  ripple: boolean;
  angleSnap: boolean;
  motionSync: boolean;
  pollingHz: X3PollingHz;
  sleepMinutes: number;
  deepSleepMinutes: number;
  debounceMs: number;
  buttons: X3Slot[];
}

export const X3_DEFAULT_COLORS: readonly X3Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
  [255, 64, 0],
  [255, 255, 255],
];

export const X3_FACTORY_BUTTONS: readonly X3Slot[] = [
  [0x02, 0, 0],
  [0x03, 0, 0],
  [0x04, 0, 0],
  [0x0d, 0, 0],
  [0x3c, 0, 0],
  [0x0f, 0, 0],
  [0x06, 0, 0],
  [0x05, 0, 0],
  [0x3c, 0, 0],
  [0x01, 0, 0],
  [0x01, 0, 0],
  [0x01, 0, 0],
  [0x01, 0, 0],
  [0x01, 0, 0],
  [0x01, 0, 0],
  [0x01, 0, 0],
  [0x0a, 0, 0],
  [0x09, 0, 0],
];

export function defaultX3Settings(): X3Settings {
  return {
    dpiStages: [800, 1600, 2400, 3200, 5000, 26000],
    activeStage: 0,
    stageColors: X3_DEFAULT_COLORS.map((c) => [...c] as unknown as X3Rgb),
    lod: 1,
    ripple: false,
    angleSnap: false,
    motionSync: false,
    pollingHz: 1000,
    sleepMinutes: 5,
    deepSleepMinutes: 30,
    debounceMs: 4,
    buttons: X3_FACTORY_BUTTONS.map((s) => [...s] as unknown as X3Slot),
  };
}

function sum(data: Uint8Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i <= to; i++) s += data[i];
  return s & 0xffff;
}

function putBe16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >> 8) & 0xff;
  data[offset + 1] = value & 0xff;
}

function header(id: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out[0] = id;
  out[1] = length;
  out[2] = 0x01;
  return out;
}

export function x3DpiToRaw(dpi: number): number {
  if (!Number.isInteger(dpi) || dpi < X3_DPI_MIN || dpi > X3_DPI_MAX || dpi % X3_DPI_STEP !== 0) {
    throw new RangeError(`X3 DPI must be ${X3_DPI_MIN}..${X3_DPI_MAX} in steps of ${X3_DPI_STEP}, got ${dpi}`);
  }
  return dpi / X3_DPI_STEP - 1;
}

export function x3RawToDpi(raw: number): number {
  return (raw + 1) * X3_DPI_STEP;
}

export function x3EnabledMask(s: Pick<X3Settings, "dpiStages" | "enabledMask">): number {
  return s.enabledMask ?? (1 << Math.min(s.dpiStages.length, X3_MAX_STAGES)) - 1;
}

export function buildX3Commit(): Uint8Array {
  const out = new Uint8Array(10);
  out.set([0x0c, 0x0a, 0x01, 0xfe, 0x01, 0xfe]);
  return out;
}

export function buildX3Sensor(s: X3Settings): Uint8Array {
  const count = s.dpiStages.length;
  if (count < 1) throw new RangeError("X3 needs at least one DPI stage");
  const out = header(X3_REPORT.sensor, 56);
  out[3] = s.lod ? 1 : 0;
  out[4] = s.ripple ? 1 : 0;
  out[5] = x3EnabledMask(s) & 0xff;
  out[6] = s.angleSnap ? 1 : 0;
  out[7] = s.motionSync ? 1 : 0;
  s.dpiStages.slice(0, X3_MAX_STAGES).forEach((dpi, i) => {
    const raw = x3DpiToRaw(dpi);
    out[8 + i] = raw & 0xff;
    out[16 + i] = raw >> 8;
  });
  out[24] = (s.activeStage % count) + 1;
  s.stageColors.slice(0, X3_MAX_STAGES).forEach((c, i) => {
    for (let k = 0; k < 3; k++) {
      if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 255) throw new RangeError("X3 colour channel must be 0..255");
      out[25 + 3 * i + k] = c[k];
    }
  });
  out[49] = 0x01;
  putBe16(out, 50, sum(out, 3, 49));
  return out;
}

export function buildX3Power(s: Pick<X3Settings, "sleepMinutes" | "deepSleepMinutes" | "debounceMs">): Uint8Array {
  const sleepRaw = Math.round(s.sleepMinutes * 2);
  if (sleepRaw < 1 || sleepRaw > 60) throw new RangeError("X3 sleep must be 0.5..30 minutes");
  const deep = s.deepSleepMinutes;
  if (!Number.isInteger(deep) || deep < 1 || deep > 60) throw new RangeError("X3 deep sleep must be 1..60 minutes");
  const debounceRaw = Math.trunc(s.debounceMs / 2);
  if (debounceRaw < 1 || debounceRaw > 25) throw new RangeError("X3 debounce must be 2..51 ms");
  const out = header(X3_REPORT.power, 15);
  out[3] = 0;
  out[4] = (deep & 0xf0) | 0x03;
  out[5] = ((deep & 0x0f) << 4) | 0x08;
  out[8] = 0xff;
  out[9] = sleepRaw;
  out[10] = debounceRaw;
  putBe16(out, 11, sum(out, 3, 10));
  return out;
}

const POLLING_CODES: Record<X3PollingHz, number> = { 1000: 0x01, 500: 0x02, 250: 0x04, 125: 0x08 };

export function buildX3Polling(hz: X3PollingHz): Uint8Array {
  const code = POLLING_CODES[hz];
  if (code === undefined) throw new RangeError(`X3 polling rate must be 125, 250, 500 or 1000, got ${hz}`);
  const out = header(X3_REPORT.polling, 9);
  out[3] = code;
  out[4] = 0xff - code;
  return out;
}

export function buildX3Buttons(buttons: readonly X3Slot[]): Uint8Array {
  if (buttons.length !== X3_BUTTON_SLOTS) throw new RangeError(`X3 needs ${X3_BUTTON_SLOTS} button slots`);
  if (!buttons.some((b) => b[0] === 0x02)) throw new RangeError("X3 needs at least one slot set to Left click");
  const out = header(X3_REPORT.buttons, 59);
  buttons.forEach((b, i) => out.set(b, 3 + 3 * i));
  putBe16(out, 57, sum(out, 3, 56));
  return out;
}

export function buildX3Burst(s: X3Settings): Uint8Array[] {
  return [buildX3Commit(), buildX3Sensor(s), buildX3Power(s), buildX3Polling(s.pollingHz), buildX3Buttons(s.buttons)];
}

export const X3_ACTION = {
  off: 0x01,
  left: 0x02,
  right: 0x03,
  middle: 0x04,
  backward: 0x05,
  forward: 0x06,
  doubleClick: 0x07,
  fire: 0x08,
  scrollUp: 0x09,
  scrollDown: 0x0a,
  dpiCycle: 0x0d,
  dpiUp: 0x0e,
  dpiDown: 0x0f,
  easyAim: 0x10,
  mediaPlayer: 0x15,
  nextTrack: 0x17,
  playPause: 0x18,
  mute: 0x1a,
  volumeUp: 0x1b,
  myComputer: 0x23,
  browserHome: 0x25,
} as const;

export const X3_MOD = { ctrl: 0x01, shift: 0x02, alt: 0x04, win: 0x08 } as const;

export function x3SimpleAction(code: number): X3Slot {
  return [code, 0, 0];
}

export function x3KeyboardAction(modifiers: number, hidKey: number): X3Slot {
  if (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 0x0f) throw new RangeError("X3 modifiers must be 0..15");
  if (!Number.isInteger(hidKey) || hidKey < 0 || hidKey > 0xff) throw new RangeError("X3 HID key must be 0..255");
  return [0x11, modifiers, hidKey];
}

export function x3MacroAction(slot: number): X3Slot {
  if (!Number.isInteger(slot) || slot < 1 || slot > 0xff) throw new RangeError("X3 macro slot must be 1..255");
  return [0x12, 0, slot];
}

export function buildX3MacroChunks(events: readonly X3MacroEvent[], slot = 2): Uint8Array[] {
  if (!Number.isInteger(slot) || slot < 1 || slot > 0xff) throw new RangeError("X3 macro slot must be 1..255");
  if (events.length > X3_MACRO_MAX_EVENTS) throw new RangeError(`X3 macro holds at most ${X3_MACRO_MAX_EVENTS} events`);
  const block = new Uint8Array(128);
  block[0] = slot;
  block[4] = 0x01;
  block[25] = events.length;
  events.forEach((e, i) => {
    if (!Number.isInteger(e.usage) || e.usage < 0 || e.usage > 0x7f) throw new RangeError("X3 macro usage must be 0..127");
    block[26 + 2 * i] = e.down ? 0x01 : 0x81;
    block[27 + 2 * i] = e.usage;
  });
  putBe16(block, 126, sum(block, 0, 125));
  const chunk = (length: number, index: number, from: number, to: number) => {
    const out = new Uint8Array(length);
    out.set([0x09, length, 0x08, index]);
    out.set(block.subarray(from, to), 4);
    return out;
  };
  return [chunk(64, 0, 0, 60), chunk(64, 1, 60, 120), chunk(12, 2, 120, 128)];
}

export interface X3Battery {
  rawByte: number;
  voltage: number;
  percent: number;
  charging: boolean;
}

const f = Math.fround;

export function x3VoltageToPercent(voltage: number): number {
  const v = f(voltage);
  const seg = (lo: number, span: number, base: number, gain: number): number =>
    base + Math.trunc(f(f(f(v - f(lo)) / f(span)) * f(gain)));
  if (v >= f(4.18)) return 100;
  if (v >= f(4.08)) return seg(4.08, 0.1, 90, 10);
  if (v >= f(3.98)) return seg(3.98, 0.1, 75, 15);
  if (v >= f(3.88)) return seg(3.88, 0.1, 60, 15);
  if (v >= f(3.78)) return seg(3.78, 0.1, 40, 20);
  if (v >= f(3.68)) return seg(3.68, 0.1, 20, 20);
  if (v >= f(3.55)) return seg(3.55, 0.13, 5, 15);
  if (v >= f(3.4)) return seg(3.4, 0.15, 0, 5);
  return 0;
}

export function parseX3Battery(data: Uint8Array): X3Battery | null {
  if (data.length < 5 || data[0] !== 0x03 || data[1] !== 0x10) return null;
  const voltage = f(data[2] / 16);
  return { rawByte: data[2], voltage, percent: x3VoltageToPercent(voltage), charging: (data[3] & 0x02) !== 0 };
}

export const X3_BUTTON_SLOT: Readonly<Record<string, number>> = { Left: 0, Right: 1, Middle: 2, Forward: 6, Back: 7 };
export const X3_MACRO_LABEL = "Macro";

const NAMED_ACTIONS: ReadonlyArray<readonly [string, number]> = [
  ["Off", X3_ACTION.off],
  ["Left Click", X3_ACTION.left],
  ["Right Click", X3_ACTION.right],
  ["Middle Click", X3_ACTION.middle],
  ["Backward", X3_ACTION.backward],
  ["Forward", X3_ACTION.forward],
  ["Double Click", X3_ACTION.doubleClick],
  ["Fire Button", X3_ACTION.fire],
  ["Scroll Up", X3_ACTION.scrollUp],
  ["Scroll Down", X3_ACTION.scrollDown],
  ["DPI Cycle", X3_ACTION.dpiCycle],
  ["DPI+", X3_ACTION.dpiUp],
  ["DPI-", X3_ACTION.dpiDown],
  ["Easy Aim", X3_ACTION.easyAim],
  ["Media Player", X3_ACTION.mediaPlayer],
  ["Next Track", X3_ACTION.nextTrack],
  ["Play/Pause", X3_ACTION.playPause],
  ["Mute", X3_ACTION.mute],
  ["Volume Up", X3_ACTION.volumeUp],
  ["My Computer", X3_ACTION.myComputer],
  ["Browser Home", X3_ACTION.browserHome],
];

export const X3_BUTTON_OPTIONS: readonly string[] = [...NAMED_ACTIONS.map(([l]) => l), X3_MACRO_LABEL];

const MODS: ReadonlyArray<readonly [string, number]> = [["Ctrl", 1], ["Shift", 2], ["Alt", 4], ["Win", 8]];
const NAMED_KEYS: ReadonlyArray<readonly [string, number]> = [
  ["Enter", 0x28], ["Esc", 0x29], ["Backspace", 0x2a], ["Tab", 0x2b], ["Space", 0x2c],
];

function keyCode(name: string): number | undefined {
  if (/^[A-Z]$/.test(name)) return 0x04 + name.charCodeAt(0) - 65;
  if (/^[1-9]$/.test(name)) return 0x1e + Number(name) - 1;
  if (name === "0") return 0x27;
  const f = /^F(\d{1,2})$/.exec(name);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return 0x3a + Number(f[1]) - 1;
  return NAMED_KEYS.find(([n]) => n === name)?.[1];
}

function keyName(code: number): string | undefined {
  if (code >= 0x04 && code <= 0x1d) return String.fromCharCode(65 + code - 4);
  if (code >= 0x1e && code <= 0x26) return String(code - 0x1d);
  if (code === 0x27) return "0";
  if (code >= 0x3a && code <= 0x45) return `F${code - 0x39}`;
  return NAMED_KEYS.find(([, c]) => c === code)?.[0];
}

export function x3ParseActionLabel(label: string, macroSlot = 2): X3Slot | null {
  if (label === X3_MACRO_LABEL) return x3MacroAction(macroSlot);
  const named = NAMED_ACTIONS.find(([l]) => l === label);
  if (named) return x3SimpleAction(named[1]);
  const parts = label.split("+");
  const last = parts.pop()!;
  let mods = 0;
  for (const p of parts) {
    const m = MODS.find(([n]) => n === p);
    if (!m || mods & m[1]) return null;
    mods |= m[1];
  }
  const key = keyCode(last);
  return key === undefined ? null : x3KeyboardAction(mods, key);
}

export function x3ActionLabel(slot: X3Slot): string | null {
  if (slot[0] === 0x12) return X3_MACRO_LABEL;
  if (slot[0] === 0x11) {
    const key = keyName(slot[2]);
    if (key === undefined || slot[1] > 0x0f) return null;
    return [...MODS.filter(([, b]) => slot[1] & b).map(([n]) => n), key].join("+");
  }
  return NAMED_ACTIONS.find(([, c]) => c === slot[0])?.[0] ?? null;
}
