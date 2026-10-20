/**
 * AJ200 / AJ200P AI-family codecs, including MASTER firmware 3.3.13.
 *
 * This is the 0x363c / 0xffa0 protocol, unrelated to NJ07/NJ08 or GearHub.
 * All offsets below are relative to payloads, excluding command/length/status.
 * See docs/ajazz-aj200p.md for evidence and verification boundaries.
 */
export const AJ200P_VENDOR_ID = 0x363c;
export const AJ200P_USAGE_PAGE = 0xffa0;
export const AJ200P_USAGE = 2;
export const AJ200P_OUTPUT_REPORT_ID = 0x0b;
export const AJ200P_REPORT_BYTES = 127;
export { AJ200P_PRODUCTS, aj200pSettingsLength, type Aj200pProduct } from "./aj200p-products.js";
export const AJ200P_RATES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
const RATE_CODES = [8, 4, 2, 1, 16, 32, 64] as const;
export const AJ200P_SLEEP_SECONDS = [10, 30, 60, 120, 180, 300, 900, 1800] as const;
export const AJ200P_BUTTON_NAMES = [
  "Left",
  "Middle",
  "Right",
  "Backward",
  "Forward",
  "Bottom",
  "Scroll up",
  "Scroll down",
  "Tilt left",
  "Tilt right",
] as const;
/** Wire slot 6 is the vendor's hidden `key7`, not an additional physical AI key. */
export const AJ200P_BUTTON_SLOTS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10] as const;
export const AJ200P_COMMAND = {
  info: 0x13,
  keys: 0x15,
  setKeys: 0x16,
  settings: 0x17,
  setSettings: 0x18,
  dpi: 0x19,
  setDpi: 0x1a,
  profile: 0x21,
} as const;
export type Aj200pCommand = (typeof AJ200P_COMMAND)[keyof typeof AJ200P_COMMAND];
export type Aj200pBinding = readonly [number, number, number];
export interface Aj200pAction {
  label: string;
  binding: Aj200pBinding;
}

export function aj200pInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function aj200pEncode(command: Aj200pCommand, payload: ArrayLike<number> = []): Uint8Array {
  const lengths: Record<Aj200pCommand, readonly number[]> = {
    0x13: [0],
    0x15: [0],
    0x16: [21, 33],
    0x17: [0],
    0x18: [30, 31, 38, 39],
    0x19: [0],
    0x1a: [48, 64],
    0x21: [1],
  };
  if (!(command in lengths) || !lengths[command].includes(payload.length))
    throw new Error("Invalid AJ200P command or payload length.");
  const body = new Uint8Array(AJ200P_REPORT_BYTES);
  body[0] = command;
  body[1] = payload.length;
  for (let i = 0; i < payload.length; i++)
    body[i + 2] = aj200pInteger(payload[i], 0, 255, "Payload byte");
  if (command === AJ200P_COMMAND.profile) aj200pInteger(payload[0], 0, 4, "Profile index");
  return body;
}

/** Returns null for unrelated reports; malformed matching replies are errors. */
export function aj200pDecodeReply(
  reportId: number,
  body: Uint8Array,
  command: Aj200pCommand,
): Uint8Array | null {
  if ((reportId !== 0x0a && reportId !== 0x0b) || body[0] !== command) return null;
  if (body.length < 3) throw new Error("Truncated AJ200P response.");
  if (body[2] !== 0)
    throw new Error(`AJ200P command 0x${command.toString(16)} failed (status ${body[2]}).`);
  // DPI tables count only data bytes; other replies include the status byte.
  const length = command === AJ200P_COMMAND.dpi ? body[1] : body[1] - 1;
  const required: Partial<Record<Aj200pCommand, readonly number[]>> = {
    0x13: [54],
    0x15: [21, 33],
    0x17: [30, 31, 38, 39],
    0x19: [48, 64],
  };
  if (
    length < 0 ||
    body.length < 3 + length ||
    (required[command] !== undefined && !required[command]!.includes(length))
  ) {
    throw new Error("Unsupported or truncated AJ200P response layout.");
  }
  return body.slice(3, 3 + length);
}

export function aj200pDecodeRate(code: number): number | null {
  const index = RATE_CODES.indexOf(code as (typeof RATE_CODES)[number]);
  return index < 0 ? null : AJ200P_RATES[index];
}
export function aj200pEncodeRate(hz: number): number {
  const index = AJ200P_RATES.indexOf(hz as (typeof AJ200P_RATES)[number]);
  if (index < 0) throw new RangeError("Unsupported AJ200P polling rate.");
  return RATE_CODES[index];
}
export function aj200pColor(data: ArrayLike<number>, offset: number): string {
  return "#" + [0, 1, 2].map((n) => data[offset + n].toString(16).padStart(2, "0")).join("");
}
export function aj200pColorBytes(color: string): Uint8Array {
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new RangeError("Expected an RGB colour in #rrggbb format.");
  return Uint8Array.from(
    [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)),
  );
}
export function aj200pVersion(lo: number, hi: number): string {
  return `${hi}.${lo >> 4}.${lo & 15}`;
}
export function aj200pDecodeInfo(data: Uint8Array) {
  if (data.length !== 54) throw new Error("Unsupported AJ200P identity layout.");
  aj200pInteger(data[17], 0, 4, "Active profile");
  const wireless = data[16] === 1;
  return {
    profile: data[17] + 1,
    wireless,
    // Do not expose the radio address or other identifying bytes.
    receiverVersion: aj200pVersion(data[7], data[8]),
    mouseVersion: aj200pVersion(data[9], data[10]),
    battery: data[14] <= 100 ? data[14] : null,
    charging: !wireless && data[13] === 1 && data[14] < 100,
  };
}

export interface Aj200pSettings {
  raw: Uint8Array;
  wirelessRate: number | null;
  wiredRate: number | null;
  count: number;
  active: number;
  lod: number;
  debounce: number;
  motionSync: boolean;
  angleSnapping: boolean;
  ripple: number;
  performanceMode: boolean | null;
  sleepSeconds: number;
  deepSleepSeconds: number;
  color: string;
  effect: number;
  brightness: number;
  speed: number;
}
export function aj200pDecodeSettings(data: Uint8Array): Aj200pSettings {
  if (![30, 31, 38, 39].includes(data.length))
    throw new Error("Unsupported AJ200P settings layout.");
  aj200pInteger(data[2], 1, 8, "DPI stage count");
  aj200pInteger(data[3], 0, data[2] - 1, "Active DPI stage");
  return {
    raw: data.slice(),
    wirelessRate: aj200pDecodeRate(data[0]),
    wiredRate: aj200pDecodeRate(data[1]),
    count: data[2],
    active: data[3],
    lod: data[6],
    debounce: data[7],
    motionSync: data[8] === 1,
    angleSnapping: data[10] === 1,
    ripple: data[11],
    // The wire flag enables power saving, the inverse of performance mode.
    performanceMode: data[15] === 0 ? true : data[15] === 1 ? false : null,
    sleepSeconds: data[25] * 10,
    deepSleepSeconds: data[26] * 10,
    color: aj200pColor(data, 21),
    effect: data[27],
    brightness: data[28],
    speed: data[29],
  };
}
export interface Aj200pDpiStage {
  x: number;
  y: number;
  color: string;
}
export function aj200pDecodeDpi(data: Uint8Array): Aj200pDpiStage[] {
  if (data.length !== 64 && data.length !== 48) throw new Error("Unsupported AJ200P DPI layout.");
  const stride = data.length / 8;
  return Array.from({ length: 8 }, (_, stage) => {
    const offset = stage * stride;
    if (stride === 6)
      return {
        x: (data[offset] + ((data[offset + 2] >> 6) << 8) + 1) * 50,
        y: (data[offset + 1] + (((data[offset + 2] >> 2) & 3) << 8) + 1) * 50,
        color: aj200pColor(data, offset + 3),
      };
    return {
      x: ((data[offset] & 15) << 16) | data[offset + 1] | (data[offset + 2] << 8),
      y: ((data[offset] >> 4) << 16) | data[offset + 3] | (data[offset + 4] << 8),
      color: aj200pColor(data, offset + 5),
    };
  });
}
/** Patch only the requested axes/colour; even inactive slots stay intact. */
export function aj200pPatchDpi(
  data: Uint8Array,
  stage: number,
  patch: Partial<Aj200pDpiStage>,
): Uint8Array {
  const current = aj200pDecodeDpi(data);
  aj200pInteger(stage, 0, 7, "DPI stage");
  const next = data.slice();
  const stride = data.length / 8;
  const offset = stage * stride;
  if (patch.x !== undefined || patch.y !== undefined) {
    const x = patch.x ?? current[stage].x;
    const y = patch.y ?? current[stage].y;
    aj200pInteger(x, stride === 8 ? 1 : 50, stride === 8 ? 80000 : 51200, "X DPI");
    aj200pInteger(y, stride === 8 ? 1 : 50, stride === 8 ? 80000 : 51200, "Y DPI");
    if (stride === 6) {
      if (x % 50 !== 0 || y % 50 !== 0) throw new RangeError("This sensor uses 50-DPI steps.");
      const xc = x / 50 - 1,
        yc = y / 50 - 1;
      next[offset] = xc & 255;
      next[offset + 1] = yc & 255;
      next[offset + 2] = (next[offset + 2] & 0x33) | ((xc >> 8) << 6) | ((yc >> 8) << 2);
    } else {
      next[offset] = ((y >> 16) << 4) | (x >> 16);
      next[offset + 1] = x & 255;
      next[offset + 2] = (x >> 8) & 255;
      next[offset + 3] = y & 255;
      next[offset + 4] = (y >> 8) & 255;
    }
  }
  if (patch.color !== undefined) next.set(aj200pColorBytes(patch.color), offset + stride - 3);
  return next;
}

export function aj200pDecodeKeys(data: Uint8Array): Aj200pBinding[] {
  if (data.length !== 33 && data.length !== 21)
    throw new Error("Unsupported AJ200P key-map layout.");
  return Array.from(
    { length: data.length / 3 },
    (_, i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]] as const,
  );
}

const actions: Aj200pAction[] = [];
const add = (label: string, type: number, arg1 = 0, arg2 = 0) =>
  actions.push({ label, binding: [type, arg1, arg2] });
add("Disabled", 0);
for (const [label, mask] of [
  ["Left click", 1],
  ["Right click", 2],
  ["Middle click", 4],
  ["Backward", 8],
  ["Forward", 16],
] as const)
  add(label, 1, mask);
add("DPI loop", 2, 1);
add("DPI+", 2, 2);
add("DPI-", 2, 3);
add("Tilt left", 3, 1);
add("Tilt right", 3, 2);
add("Scroll up", 9, 1);
add("Scroll down", 9, 2);
add("Cycle profiles", 8, 255);
for (let i = 0; i < 5; i++) add(`Profile ${i + 1}`, 8, i);
// Firmware-confirmed actions; physical invocation evidence is documented separately.
add("Cycle polling rate", 7);
for (const hz of AJ200P_RATES) add(`Polling rate ${hz} Hz`, 7, aj200pEncodeRate(hz));
for (const [label, usage] of [
  ["Mute", 0xe2],
  ["Volume up", 0xe9],
  ["Volume down", 0xea],
  ["Play / pause", 0xcd],
  ["Next track", 0xb5],
  ["Previous track", 0xb6],
  ["Stop", 0xb7],
  ["Browser back", 0x224],
  ["Browser forward", 0x225],
  ["Browser home", 0x223],
  ["Brightness up", 0x6f],
  ["Brightness down", 0x70],
  ["Media player", 0x183],
  ["Mail", 0x18a],
  ["Search", 0x221],
  ["Refresh", 0x227],
  ["Browser stop", 0x226],
  ["Calculator", 0x192],
  ["My Computer", 0x194],
] as const)
  add(label, 10, usage & 255, usage >> 8);
for (let i = 0; i < 26; i++) add(String.fromCharCode(65 + i), 11, 4 + i);
for (let i = 0; i < 10; i++) add(String((i + 1) % 10), 11, 30 + i);
for (let i = 0; i < 12; i++) add(`F${i + 1}`, 11, 58 + i);
for (const [label, usage] of [
  ["Enter", 40],
  ["Escape", 41],
  ["Backspace", 42],
  ["Tab", 43],
  ["Space", 44],
  ["-", 45],
  ["=", 46],
  ["[", 47],
  ["]", 48],
  ["\\", 49],
  [";", 51],
  ["'", 52],
  ["`", 53],
  [",", 54],
  [".", 55],
  ["/", 56],
  ["Caps Lock", 57],
  ["Print Screen", 70],
  ["Scroll Lock", 71],
  ["Pause", 72],
  ["Insert", 73],
  ["Home", 74],
  ["Page Up", 75],
  ["Delete", 76],
  ["End", 77],
  ["Page Down", 78],
  ["Arrow right", 79],
  ["Arrow left", 80],
  ["Arrow down", 81],
  ["Arrow up", 82],
  ["Num Lock", 83],
  ["Numpad /", 84],
  ["Numpad *", 85],
  ["Numpad -", 86],
  ["Numpad +", 87],
  ["Numpad 1", 89],
  ["Numpad 2", 90],
  ["Numpad 3", 91],
  ["Numpad 4", 92],
  ["Numpad 5", 93],
  ["Numpad 6", 94],
  ["Numpad 7", 95],
  ["Numpad 8", 96],
  ["Numpad 9", 97],
  ["Numpad 0", 98],
  ["Numpad .", 99],
] as const)
  add(label, 11, usage);
for (const [i, label] of [
  "Left Ctrl",
  "Left Shift",
  "Left Alt",
  "Left Windows",
  "Right Ctrl",
  "Right Shift",
  "Right Alt",
  "Right Windows",
].entries())
  add(label, 11, 0xe0 + i, 8);
export const AJ200P_ACTIONS: readonly Aj200pAction[] = actions;
export function aj200pFindAction(label: string): Aj200pBinding | null {
  return AJ200P_ACTIONS.find((action) => action.label === label)?.binding ?? null;
}
export function aj200pBindingLabel(binding: Aj200pBinding): string {
  const action = AJ200P_ACTIONS.find((candidate) =>
    candidate.binding.every((byte, i) => byte === binding[i]),
  );
  if (action) return action.label;
  if (binding[0] === 5) return "Custom shortcut";
  if (binding[0] === 6) return `Macro ${binding[1] + 1}`;
  return `Custom (${binding.join(",")})`;
}
