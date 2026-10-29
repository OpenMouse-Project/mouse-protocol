/**
 * Hitscan web protocol input codecs: button actions, macro event streams and
 * the GBK names shared by profiles and macros.
 *
 * Recovered from `hitscan-input-codec.js` and `hitscan-inputs.js` in release
 * `1.0.15-fe600431` of control.hitscan.com. Key names use the browser's
 * `KeyboardEvent.code` vocabulary, exactly like the vendor codec, and are
 * encoded as USB HID keyboard usage ids. Only the vendor's confirmed event
 * categories are emitted; anything else stays a raw custom binding.
 */

type Bytes = Uint8Array | readonly number[];

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Invalid Hitscan ${label}: ${value}.`);
}

/** `KeyboardEvent.code` → USB HID keyboard usage id, from the vendor codec. */
export const HITSCAN_XVI_KEY_CODES: Readonly<Record<string, number>> = (() => {
  const codes: Record<string, number> = {
    Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
    BracketLeft: 47, BracketRight: 48, Backslash: 49, IntlHash: 50, Semicolon: 51,
    Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
    PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75,
    Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81,
    ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86,
    NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99,
    IntlBackslash: 100, ContextMenu: 101, NumpadEqual: 103,
  };
  for (let index = 0; index < 26; index++) codes[`Key${String.fromCharCode(65 + index)}`] = 4 + index;
  for (let digit = 1; digit <= 9; digit++) {
    codes[`Digit${digit}`] = 29 + digit;
    codes[`Numpad${digit}`] = 88 + digit;
  }
  codes.Digit0 = 39;
  for (let index = 1; index <= 24; index++) codes[`F${index}`] = index <= 12 ? 57 + index : 91 + index;
  return Object.freeze(codes);
})();

export const HITSCAN_XVI_MODIFIER_CODES: Readonly<Record<string, number>> = Object.freeze({
  ControlLeft: 1, ShiftLeft: 2, AltLeft: 4, MetaLeft: 8,
  ControlRight: 16, ShiftRight: 32, AltRight: 64, MetaRight: 128,
});

export const HITSCAN_XVI_MOUSE_BITS: Readonly<Record<string, number>> = Object.freeze({
  MouseLeft: 1, MouseRight: 2, MouseMiddle: 4, MouseBack: 8, MouseForward: 16,
});

/** Button function ids and payloads the vendor's `simple` table names. */
export const HITSCAN_XVI_SIMPLE_ACTIONS: Readonly<Record<string, { functionId: number; data: readonly number[] }>> = Object.freeze({
  disabled: { functionId: 0, data: [] },
  dpi: { functionId: 7, data: [6] },
  "dpi-up": { functionId: 7, data: [1] },
  "dpi-down": { functionId: 7, data: [2] },
  "profile-switch": { functionId: 8, data: [3] },
  "polling-loop": { functionId: 13, data: [3] },
});

/** Function id 1 payloads; 16/17 are scroll up/down, not macro modes. */
export const HITSCAN_XVI_MOUSE_ACTIONS: Readonly<Record<string, number>> = Object.freeze({
  left: 1, right: 2, middle: 3, back: 4, forward: 5, "scroll-up": 16, "scroll-down": 17,
});

/** Function id 5 payloads, two bytes big-endian. */
export const HITSCAN_XVI_MEDIA_CODES: Readonly<Record<string, number>> = Object.freeze({
  "media-player": 0x183, "media-play-pause": 0xcd, "media-next": 0xb5, "media-previous": 0xb6,
  "volume-up": 0xe9, "volume-down": 0xea, mute: 0xe2, "media-stop": 0xb7,
  calculator: 0x192, "my-pc": 0x194, "www-home": 0x223, email: 0x18a,
  "lighting-up": 0x6f, "lighting-down": 0x70,
});

export const HITSCAN_XVI_MEDIA_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "media-player": "Media Player", "media-play-pause": "Play/Pause", "media-next": "Next Track",
  "media-previous": "Previous Track", "volume-up": "Volume Up", "volume-down": "Volume Down",
  mute: "Mute", "media-stop": "Media Stop", calculator: "Calculator", "my-pc": "My PC",
  "www-home": "WWW Home", email: "Email", "lighting-up": "Lighting Up", "lighting-down": "Lighting Down",
});

export type HitscanXviButtonAction =
  | { kind: "mouse"; button: keyof typeof HITSCAN_XVI_MOUSE_ACTIONS }
  | { kind: "simple"; action: keyof typeof HITSCAN_XVI_SIMPLE_ACTIONS }
  | { kind: "media"; media: keyof typeof HITSCAN_XVI_MEDIA_CODES }
  | { kind: "key"; key: string; modifiers: number }
  | { kind: "dpiLock"; dpi: number }
  | { kind: "macro"; macro: number; runMode: "count" | "once" | "held" | "toggle"; runCount: number }
  | { kind: "custom"; functionId: number; data: number[] };

export interface HitscanXviButtonBinding {
  functionId: number;
  data: number[];
}

function checkedData(data: readonly number[]): number[] {
  for (const byte of data) integer(byte, 0, 255, "button byte");
  return [...data];
}

export function hitscanXviEncodeButtonAction(action: HitscanXviButtonAction): HitscanXviButtonBinding {
  switch (action.kind) {
    case "custom":
      integer(action.functionId, 0, 255, "button function");
      return { functionId: action.functionId, data: checkedData(action.data) };
    case "mouse": {
      const code = HITSCAN_XVI_MOUSE_ACTIONS[action.button];
      if (code === undefined) throw new RangeError(`Unknown Hitscan mouse action ${action.button}.`);
      return { functionId: 1, data: [code] };
    }
    case "simple": {
      const entry = HITSCAN_XVI_SIMPLE_ACTIONS[action.action];
      if (!entry) throw new RangeError(`Unknown Hitscan button action ${action.action}.`);
      return { functionId: entry.functionId, data: [...entry.data] };
    }
    case "media": {
      const code = HITSCAN_XVI_MEDIA_CODES[action.media];
      if (code === undefined) throw new RangeError(`Unknown Hitscan media action ${action.media}.`);
      return { functionId: 5, data: [code >> 8, code & 0xff] };
    }
    case "key": {
      integer(action.modifiers, 0, 255, "key modifiers");
      const key = HITSCAN_XVI_KEY_CODES[action.key] ?? 0;
      const modifiers = action.modifiers | (HITSCAN_XVI_MODIFIER_CODES[action.key] ?? 0);
      integer(modifiers, 0, 255, "key modifiers");
      if (!key && !modifiers) throw new RangeError("A Hitscan key binding needs a key or modifier.");
      return { functionId: 4, data: [modifiers, key] };
    }
    case "dpiLock": {
      integer(action.dpi, 50, 30000, "DPI lock");
      return { functionId: 7, data: [5, action.dpi >> 8, action.dpi & 0xff, action.dpi >> 8, action.dpi & 0xff] };
    }
    case "macro": {
      integer(action.macro, 1, 0xffff, "macro id");
      integer(action.runCount, 1, 255, "macro repeat count");
      const functionId = action.runMode === "held" ? 17 : action.runMode === "toggle" ? 18 : 16;
      const data = [action.macro >> 8, action.macro & 0xff];
      if (action.runMode !== "held" && action.runMode !== "toggle") data.push(action.runMode === "once" ? 1 : action.runCount);
      return { functionId, data };
    }
  }
}

function sameData(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function hitscanXviDecodeButtonAction(binding: HitscanXviButtonBinding): HitscanXviButtonAction {
  const { functionId, data } = binding;
  for (const [button, code] of Object.entries(HITSCAN_XVI_MOUSE_ACTIONS)) {
    if (functionId === 1 && sameData(data, [code])) return { kind: "mouse", button };
  }
  for (const [media, code] of Object.entries(HITSCAN_XVI_MEDIA_CODES)) {
    if (functionId === 5 && sameData(data, [code >> 8, code & 0xff])) return { kind: "media", media };
  }
  for (const [action, entry] of Object.entries(HITSCAN_XVI_SIMPLE_ACTIONS)) {
    if (functionId === entry.functionId && sameData(data, entry.data)) return { kind: "simple", action };
  }
  if (functionId === 4 && data.length === 2) {
    const [modifiers, key] = data;
    const name = Object.keys(HITSCAN_XVI_KEY_CODES).find((code) => HITSCAN_XVI_KEY_CODES[code] === key);
    if (name !== undefined && (modifiers ?? 0) + (key ?? 0) > 0) {
      return { kind: "key", key: name, modifiers: modifiers ?? 0 };
    }
  }
  if (functionId === 7 && data.length === 5 && data[0] === 5 && data[1] === data[3] && data[2] === data[4]) {
    const dpi = (data[1]! << 8) | data[2]!;
    if (dpi >= 50 && dpi <= 30000) return { kind: "dpiLock", dpi };
  }
  if ([16, 17, 18].includes(functionId)) {
    const macro = ((data[0] ?? 0) << 8) | (data[1] ?? 0);
    if (macro > 0 && data.length === (functionId === 16 ? 3 : 2) && (functionId !== 16 || (data[2] ?? 0) > 0)) {
      return {
        kind: "macro",
        macro,
        runMode: functionId === 17 ? "held" : functionId === 18 ? "toggle" : "count",
        runCount: functionId === 16 ? data[2]! : 1,
      };
    }
  }
  return { kind: "custom", functionId, data: [...data] };
}

/** Labels the shared remapper can offer and write back. Keys, macros and raw ids stay fixed. */
export const HITSCAN_XVI_BUTTON_LABELS: ReadonlyArray<readonly [string, HitscanXviButtonAction]> = [
  ["Left Click", { kind: "mouse", button: "left" }],
  ["Right Click", { kind: "mouse", button: "right" }],
  ["Middle Click", { kind: "mouse", button: "middle" }],
  ["Backward", { kind: "mouse", button: "back" }],
  ["Forward", { kind: "mouse", button: "forward" }],
  ["Scroll Up", { kind: "mouse", button: "scroll-up" }],
  ["Scroll Down", { kind: "mouse", button: "scroll-down" }],
  ["DPI Loop", { kind: "simple", action: "dpi" }],
  ["DPI+", { kind: "simple", action: "dpi-up" }],
  ["DPI-", { kind: "simple", action: "dpi-down" }],
  ["Profile Switch", { kind: "simple", action: "profile-switch" }],
  ["Polling Rate Switch", { kind: "simple", action: "polling-loop" }],
  ...Object.keys(HITSCAN_XVI_MEDIA_CODES).map((media): readonly [string, HitscanXviButtonAction] =>
    [HITSCAN_XVI_MEDIA_LABELS[media] ?? media, { kind: "media", media }]),
  ["Disable", { kind: "simple", action: "disabled" }],
];

export function hitscanXviButtonActionForLabel(label: string): HitscanXviButtonAction | null {
  return HITSCAN_XVI_BUTTON_LABELS.find(([name]) => name === label)?.[1] ?? null;
}

function modifierLabel(byte: number): string {
  const names = Object.entries(HITSCAN_XVI_MODIFIER_CODES)
    .filter(([, bit]) => (byte & bit) !== 0)
    .map(([name]) => name.replace(/Left|Right$/, ""));
  return names.join("+");
}

export function hitscanXviButtonLabel(action: HitscanXviButtonAction): string {
  if (action.kind === "macro") return `Macro ${action.macro}`;
  if (action.kind === "dpiLock") return `DPI Lock ${action.dpi}`;
  if (action.kind === "key") {
    const modifiers = modifierLabel(action.modifiers | (HITSCAN_XVI_MODIFIER_CODES[action.key] ?? 0));
    return `Key ${action.key}${modifiers ? ` (${modifiers})` : ""}`;
  }
  if (action.kind === "custom") {
    return `Custom (${[action.functionId, ...action.data].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")})`;
  }
  const binding = hitscanXviEncodeButtonAction(action);
  return HITSCAN_XVI_BUTTON_LABELS.find(([, candidate]) => {
    const encoded = hitscanXviEncodeButtonAction(candidate);
    return encoded.functionId === binding.functionId && sameData(encoded.data, binding.data);
  })?.[0] ?? "Custom";
}

export function hitscanXviIsLeftClick(action: HitscanXviButtonAction): boolean {
  const binding = hitscanXviEncodeButtonAction(action);
  return binding.functionId === 1 && sameData(binding.data, [HITSCAN_XVI_MOUSE_ACTIONS.left!]);
}

/* ----------------------------------------------------------------- macros */

export type HitscanXviMacroEvent =
  | { type: "delay"; ms: number }
  | { type: "down" | "up"; key: string };

/** Exact event stream bytes; throws when the sequence cannot be represented. */
export function hitscanXviEncodeMacroEvents(events: readonly HitscanXviMacroEvent[]): Uint8Array<ArrayBuffer> {
  if (!Array.isArray(events) || events.length === 0 || events.length > 1000) {
    throw new RangeError("A Hitscan macro needs 1-1000 events.");
  }
  const bytes: number[] = [];
  const held = new Set<string>();
  let mouse = 0;
  for (const event of events) {
    if (event.type === "delay") {
      integer(event.ms, 0, 60000, "macro delay");
      bytes.push(...(event.ms <= 255 ? [0x20, event.ms] : [0x21, event.ms >> 8, event.ms & 0xff]));
      continue;
    }
    if (event.type !== "down" && event.type !== "up") throw new RangeError("Unknown Hitscan macro event.");
    const down = event.type === "down";
    if (held.has(event.key) === down) throw new RangeError(`Hitscan macro key ${event.key} is not balanced.`);
    if (down) held.add(event.key); else held.delete(event.key);
    const mouseBit = HITSCAN_XVI_MOUSE_BITS[event.key];
    if (mouseBit !== undefined) {
      mouse = down ? mouse | mouseBit : mouse & ~mouseBit;
      bytes.push(1, mouse);
    } else if (HITSCAN_XVI_MODIFIER_CODES[event.key] !== undefined) {
      bytes.push(down ? 9 : 10, HITSCAN_XVI_MODIFIER_CODES[event.key]!);
    } else if (HITSCAN_XVI_KEY_CODES[event.key] !== undefined) {
      bytes.push(down ? 2 : 3, HITSCAN_XVI_KEY_CODES[event.key]!);
    } else {
      throw new RangeError(`Unsupported Hitscan macro key ${event.key}.`);
    }
  }
  if (held.size) throw new RangeError("A Hitscan macro cannot end with a key held down.");
  return Uint8Array.from(bytes);
}

export function hitscanXviDecodeMacroEvents(bytes: Bytes): HitscanXviMacroEvent[] | null {
  const data = Uint8Array.from(bytes);
  const events: HitscanXviMacroEvent[] = [];
  let offset = 0;
  let mouse = 0;
  while (offset < data.length) {
    const type = data[offset++]!;
    if (offset >= data.length) return null;
    const value = data[offset++]!;
    if (type >= 0x20 && type <= 0x23) {
      let delay = value;
      for (let extra = 0; extra < type - 0x20; extra++) {
        if (offset >= data.length) return null;
        delay = delay * 256 + data[offset++]!;
      }
      if (delay > 60000) return null;
      events.push({ type: "delay", ms: delay });
    } else if (type === 2 || type === 3) {
      const key = Object.keys(HITSCAN_XVI_KEY_CODES).find((code) => HITSCAN_XVI_KEY_CODES[code] === value);
      if (key === undefined) return null;
      events.push({ type: type === 2 ? "down" : "up", key });
    } else if (type === 9 || type === 10) {
      const key = Object.keys(HITSCAN_XVI_MODIFIER_CODES).find((code) => HITSCAN_XVI_MODIFIER_CODES[code] === value);
      if (key === undefined) return null;
      events.push({ type: type === 9 ? "down" : "up", key });
    } else if (type === 1) {
      if (value > 31) return null;
      for (const [key, bit] of Object.entries(HITSCAN_XVI_MOUSE_BITS)) {
        if ((mouse & bit) !== (value & bit)) events.push({ type: value & bit ? "down" : "up", key });
      }
      mouse = value;
    } else {
      return null;
    }
    if (events.length > 1000) return null;
  }
  try {
    hitscanXviEncodeMacroEvents(events);
  } catch {
    return null;
  }
  return events;
}

/* ------------------------------------------------------------- GBK names */

/** UTF-16LE "Profile " prefix the vendor app writes into default names. */
const DEFAULT_PROFILE_PREFIX = [80, 0, 114, 0, 111, 0, 102, 0, 105, 0, 108, 0, 101, 0, 32, 0];

let encodeTable: Map<string, readonly number[]> | null = null;

function gbkEncoder(): Map<string, readonly number[]> {
  if (encodeTable) return encodeTable;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder("gbk", { fatal: true });
  } catch {
    throw new Error("This runtime does not provide a GBK TextDecoder.");
  }
  const table = new Map<string, readonly number[]>();
  for (let byte = 0; byte < 0x80; byte++) table.set(String.fromCharCode(byte), [byte]);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      try {
        const char = decoder.decode(Uint8Array.of(lead, trail));
        if (!table.has(char)) table.set(char, [lead, trail]);
      } catch {
        // Unassigned lead/trail pairs are not GBK characters.
      }
    }
  }
  encodeTable = table;
  return table;
}

/** GBK bytes for a profile or macro name; 56 bytes maximum. */
export function hitscanXviEncodeGbkName(name: string): Uint8Array<ArrayBuffer> {
  if (typeof name !== "string" || name.trim().length === 0 || name.includes("\0")) {
    throw new RangeError("A Hitscan name must be non-empty and free of NUL characters.");
  }
  if (/^[\x00-\x7f]*$/.test(name)) {
    if (name.length > 56) throw new RangeError("A Hitscan name is at most 56 encoded bytes.");
    return Uint8Array.from([...name].map((char) => char.charCodeAt(0)));
  }
  const table = gbkEncoder();
  const bytes: number[] = [];
  for (const char of name) {
    const encoded = table.get(char);
    if (!encoded) throw new RangeError(`The character ${JSON.stringify(char)} has no GBK encoding.`);
    bytes.push(...encoded);
  }
  if (bytes.length > 56) throw new RangeError("A Hitscan name is at most 56 encoded bytes.");
  return Uint8Array.from(bytes);
}

/**
 * Decodes a device name. The vendor's default-name marker is UTF-16LE; other
 * names are GBK. Trailing NUL padding is ignored; invalid bytes return null.
 */
export function hitscanXviDecodeGbkName(bytes: Bytes): string | null {
  const data = Uint8Array.from(bytes);
  if (data.length === 0) return "";
  const utf16 = data.length >= 16 && DEFAULT_PROFILE_PREFIX.every((byte, index) => data[index] === byte);
  try {
    if (utf16) {
      // UTF-16LE pads with NUL bytes, so only trim NUL characters, not bytes.
      return new TextDecoder("utf-16le", { fatal: true }).decode(data).replace(/\0+$/, "").trim();
    }
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) end--;
    const trimmed = data.subarray(0, end);
    if (trimmed.includes(0)) return null;
    return new TextDecoder("gbk", { fatal: true }).decode(trimmed).trim();
  } catch {
    return null;
  }
}
