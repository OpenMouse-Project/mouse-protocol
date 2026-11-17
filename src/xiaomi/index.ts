/*
 * Xiaomi Mi Gaming Mouse configuration protocol.
 *
 * The command layout is reverse-engineered from the third-party Qt app
 * JUGGERNAUT13/XIAOMI_MI_GAMING_MOUSE_APP (mainwindow.cpp / mainwindow.h),
 * which the protocol contributor tested on hardware. Every command and reply
 * is a 32-byte report headed by 0x4D followed by the command byte; the device
 * answers with an input report that echoes the header and command byte.
 */

export const XIAOMI_VENDOR_ID = 0x2717;
/**
 * First byte of every 32-byte hidraw report. It is also the HID report ID
 * of the vendor control channel, so it doubles as `XIAOMI_REPORT_ID`.
 */
export const XIAOMI_HEADER = 0x4d;
/**
 * Size of the raw hidraw buffer: 1 report-ID byte + 31 data bytes.
 * The codec builds and parses this 32-byte layout; the WebHID driver
 * strips the leading report-ID byte before calling `sendReport`.
 */
export const XIAOMI_PACKET_SIZE = 32;
/**
 * HID report ID of the vendor control channel (vendor page 0xFF00,
 * usage 2, 31-byte reports). The Qt app writes it as the first byte of
 * its 32-byte hidraw buffer; WebHID passes it as `sendReport`'s first
 * argument instead.
 */
export const XIAOMI_REPORT_ID = XIAOMI_HEADER;
/** Data size of one control report, excluding the report-ID byte. */
export const XIAOMI_REPORT_DATA_SIZE = XIAOMI_PACKET_SIZE - 1;

export interface XiaomiDeviceDefinition {
  name: string;
  wireless: boolean;
  verified: boolean;
}

/**
 * Product IDs of the Mi Gaming Mouse. The wired PID is verified on hardware;
 * the wireless PID is reported by the reference app as "NOT WORKING IN
 * WIRELESS MODE, BUT COMMANDS EXEC SUCCESSFULLY", so it is unverified.
 */
export const XIAOMI_DEVICES: ReadonlyMap<number, XiaomiDeviceDefinition> = new Map([
  [0x5009, { name: "Mi Gaming Mouse", wireless: false, verified: true }],
  [0x500b, { name: "Mi Gaming Mouse", wireless: true, verified: false }],
]);

export const XIAOMI_PRODUCT_IDS: ReadonlySet<number> = new Set(XIAOMI_DEVICES.keys());

/* ---------------------------------
 * Lighting
 * --------------------------------- */

/** Wire zone ids. */
export const XIAOMI_LIGHTING_DEVICES = { TAIL: 0, WHEEL: 1 } as const;
export type XiaomiLightingDevice = keyof typeof XIAOMI_LIGHTING_DEVICES;

/**
 * Logical effect values. 4 is a gap in the firmware's enum; the wire value is
 * `effect + (effect > 3 ? 1 : 0)`, so the wire gaps are 4 and 5.
 */
export const XIAOMI_EFFECTS = [0, 1, 2, 3, 5, 6] as const;
export type XiaomiEffect = (typeof XIAOMI_EFFECTS)[number];

/** Effects each zone accepts. The wheel only supports Off and Static. */
export const XIAOMI_EFFECTS_BY_DEVICE: Record<XiaomiLightingDevice, readonly XiaomiEffect[]> = {
  TAIL: [0, 1, 2, 3, 5, 6],
  WHEEL: [0, 1],
};

/** Blink speed, 1 (slowest) to 8 (fastest). */
export const XIAOMI_SPEEDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export function xiaomiEffectToWire(effect: number): number {
  return effect + (effect > 3 ? 1 : 0);
}

export function xiaomiEffectFromWire(wire: number): number {
  return wire - (wire > 3 ? 1 : 0);
}

/* ---------------------------------
 * Polling rate
 * --------------------------------- */

/**
 * Supported rates in wire order: index `i` is encoded on the wire as the byte
 * `1 << i`. Display order is the reverse (ascending).
 */
export const XIAOMI_POLLING_RATES = [1000, 500, 250, 125] as const;

export function xiaomiPollingRateToWire(hz: number): number {
  const index = (XIAOMI_POLLING_RATES as readonly number[]).indexOf(hz);
  if (index < 0) throw new RangeError(`Xiaomi polling rate ${hz} Hz is not supported.`);
  return 1 << index;
}

export function xiaomiPollingRateFromWire(byte: number): number {
  const index = Math.log2(byte);
  if (!Number.isInteger(index) || index < 0 || index >= XIAOMI_POLLING_RATES.length) {
    throw new Error(`Unknown Xiaomi polling value 0x${byte.toString(16).padStart(2, "0")}.`);
  }
  return XIAOMI_POLLING_RATES[index];
}

/* ---------------------------------
 * DPI
 * --------------------------------- */

export const XIAOMI_DPI_STEP = 50;
export const XIAOMI_DPI_LEVELS = 5;
export const XIAOMI_DPI_MIN = 50;
export const XIAOMI_DPI_MAX = 7200;

export function xiaomiDpiToWire(dpi: number): number {
  if (!Number.isInteger(dpi) || dpi < XIAOMI_DPI_MIN || dpi > XIAOMI_DPI_MAX || dpi % XIAOMI_DPI_STEP !== 0) {
    throw new RangeError(`Xiaomi DPI ${dpi} must be ${XIAOMI_DPI_MIN}-${XIAOMI_DPI_MAX} in steps of ${XIAOMI_DPI_STEP}.`);
  }
  return dpi / XIAOMI_DPI_STEP;
}

export function xiaomiDpiFromWire(byte: number): number {
  return byte * XIAOMI_DPI_STEP;
}

/* ---------------------------------
 * Button binding
 * --------------------------------- */

/** Wire button ids. Left and right click are not bindable in the reference app but the firmware allows it. */
export const XIAOMI_BUTTONS = {
  LEFT: 0,
  RIGHT: 1,
  SCROLL: 2,
  M5: 3,
  M4: 4,
  RISE_DPI: 5,
  LOWER_DPI: 6,
  AIMING: 7,
} as const;

/**
 * Binding modes. Values 0x0001-0x0008 and 0x0101-0x010c are direct key
 * combos; 0x0100 is a custom combo (modifier + key); 0x0200/0x0201 are macros
 * (with and without per-event delay).
 */
export const XIAOMI_KEY_COMBOS = {
  LEFT_CLICK: 0x0001,
  RIGHT_CLICK: 0x0002,
  MIDDLE_CLICK: 0x0003,
  MOVE_BACK: 0x0004,
  MOVE_FORWARD: 0x0005,
  RISE_DPI: 0x0006,
  LOWER_DPI: 0x0007,
  TURN_DPI: 0x0008,
  ALT_F4: 0x0101,
  WIN_D: 0x0102,
  CTRL_TAB: 0x0103,
  CTRL_SHIFT_TAB: 0x0104,
  CTRL_X: 0x0105,
  CTRL_V: 0x0106,
  CTRL_Z: 0x0107,
  CTRL_Y: 0x0108,
  CTRL_C: 0x0109,
  VOLUME_UP: 0x010a,
  VOLUME_DOWN: 0x010b,
  SILENT_MODE: 0x010c,
  CUSTOM_KEY_COMBO: 0x0100,
  MACROS_NO_DELAY: 0x0200,
  MACROS_WITH_DELAY: 0x0201,
} as const;

/** Modifier bitmask for custom key combos. */
export const XIAOMI_KEY_MODIFIERS = {
  LEFT_CTRL: 0x01,
  LEFT_SHIFT: 0x02,
  LEFT_ALT: 0x04,
  LEFT_WIN: 0x08,
  RIGHT_CTRL: 0x10,
  RIGHT_SHIFT: 0x20,
  RIGHT_ALT: 0x40,
  RIGHT_WIN: 0x80,
} as const;

/** HID keyboard usage codes for custom key combos. */
export const XIAOMI_KEY_CODES = {
  CTRL_BREAK: 0x03,
  A: 0x04,
  B: 0x05,
  C: 0x06,
  D: 0x07,
  E: 0x08,
  F: 0x09,
  G: 0x0a,
  H: 0x0b,
  I: 0x0c,
  J: 0x0d,
  K: 0x0e,
  L: 0x0f,
  M: 0x10,
  N: 0x11,
  O: 0x12,
  P: 0x13,
  Q: 0x14,
  R: 0x15,
  S: 0x16,
  T: 0x17,
  U: 0x18,
  V: 0x19,
  W: 0x1a,
  X: 0x1b,
  Y: 0x1c,
  Z: 0x1d,
  ONE: 0x1e,
  TWO: 0x1f,
  THREE: 0x20,
  FOUR: 0x21,
  FIVE: 0x22,
  SIX: 0x23,
  SEVEN: 0x24,
  EIGHT: 0x25,
  NINE: 0x26,
  ZERO: 0x27,
  ENTER: 0x28,
  ESCAPE: 0x29,
  BACKSPACE: 0x2a,
  TAB: 0x2b,
  SPACE: 0x2c,
  SUB: 0x2d,
  EQUAL: 0x2e,
  SQR_BRKT_OPEN: 0x2f,
  SQR_BRKT_CLOSE: 0x30,
  BACKSLASH: 0x31,
  SEMICOLON: 0x33,
  APOSTROPHE: 0x34,
  BACKTICK: 0x35,
  COMMA: 0x36,
  DOT: 0x37,
  SLASH: 0x38,
  CAPS_LOCK: 0x39,
  F1: 0x3a,
  F2: 0x3b,
  F3: 0x3c,
  F4: 0x3d,
  F5: 0x3e,
  F6: 0x3f,
  F7: 0x40,
  F8: 0x41,
  F9: 0x42,
  F10: 0x43,
  F11: 0x44,
  F12: 0x45,
  PRINT_SCREEN: 0x46,
  SCROLL_LOCK: 0x47,
  PAUSE: 0x48,
  INSERT: 0x49,
  HOME: 0x4a,
  PAGE_UP: 0x4b,
  DELETE: 0x4c,
  END: 0x4d,
  PAGE_DOWN: 0x4e,
  RIGHT_ARROW: 0x4f,
  LEFT_ARROW: 0x50,
  DOWN_ARROW: 0x51,
  UP_ARROW: 0x52,
  NUM_LOCK: 0x53,
  NUMPAD_DIV: 0x54,
  NUMPAD_MULT: 0x55,
  NUMPAD_SUB: 0x56,
  NUMPAD_ADD: 0x57,
  NUMPAD_ENTER: 0x58,
  NUMPAD_1: 0x59,
  NUMPAD_2: 0x5a,
  NUMPAD_3: 0x5b,
  NUMPAD_4: 0x5c,
  NUMPAD_5: 0x5d,
  NUMPAD_6: 0x5e,
  NUMPAD_7: 0x5f,
  NUMPAD_8: 0x60,
  NUMPAD_9: 0x61,
  NUMPAD_0: 0x62,
  NUMPAD_DOT: 0x63,
  LESS: 0x64,
  APPS_MENU: 0x65,
  LEFT_CTRL: 0xe0,
  LEFT_SHIFT: 0xe1,
  LEFT_ALT: 0xe2,
  LEFT_WIN: 0xe3,
  RIGHT_CTRL: 0xe4,
  RIGHT_SHIFT: 0xe5,
  RIGHT_ALT: 0xe6,
  RIGHT_WIN: 0xe7,
} as const;

/** Display names of the bindable buttons, indexed by wire button id. */
export const XIAOMI_BUTTON_NAMES = [
  "Left",
  "Right",
  "Scroll",
  "M5",
  "M4",
  "Rise DPI",
  "Lower DPI",
  "Aiming",
] as const;

/**
 * The preset key combos a button can be mapped to, in display order. Custom
 * combos and macros are not presets: they are shown via
 * {@link xiaomiBindingLabel} and cannot be selected from the list.
 */
export const XIAOMI_BUTTON_ACTIONS: ReadonlyArray<{ label: string; combo: number }> = [
  { label: "Left-click", combo: XIAOMI_KEY_COMBOS.LEFT_CLICK },
  { label: "Right-click", combo: XIAOMI_KEY_COMBOS.RIGHT_CLICK },
  { label: "Middle-click", combo: XIAOMI_KEY_COMBOS.MIDDLE_CLICK },
  { label: "Move back", combo: XIAOMI_KEY_COMBOS.MOVE_BACK },
  { label: "Move forward", combo: XIAOMI_KEY_COMBOS.MOVE_FORWARD },
  { label: "Rise DPI", combo: XIAOMI_KEY_COMBOS.RISE_DPI },
  { label: "Lower DPI", combo: XIAOMI_KEY_COMBOS.LOWER_DPI },
  { label: "Turn DPI", combo: XIAOMI_KEY_COMBOS.TURN_DPI },
  { label: "Alt+F4", combo: XIAOMI_KEY_COMBOS.ALT_F4 },
  { label: "Win+D", combo: XIAOMI_KEY_COMBOS.WIN_D },
  { label: "Ctrl+Tab", combo: XIAOMI_KEY_COMBOS.CTRL_TAB },
  { label: "Ctrl+Shift+Tab", combo: XIAOMI_KEY_COMBOS.CTRL_SHIFT_TAB },
  { label: "Ctrl+X", combo: XIAOMI_KEY_COMBOS.CTRL_X },
  { label: "Ctrl+V", combo: XIAOMI_KEY_COMBOS.CTRL_V },
  { label: "Ctrl+Z", combo: XIAOMI_KEY_COMBOS.CTRL_Z },
  { label: "Ctrl+Y", combo: XIAOMI_KEY_COMBOS.CTRL_Y },
  { label: "Ctrl+C", combo: XIAOMI_KEY_COMBOS.CTRL_C },
  { label: "Volume up", combo: XIAOMI_KEY_COMBOS.VOLUME_UP },
  { label: "Volume down", combo: XIAOMI_KEY_COMBOS.VOLUME_DOWN },
  { label: "Silent mode", combo: XIAOMI_KEY_COMBOS.SILENT_MODE },
];

const XIAOMI_MODIFIER_NAMES: ReadonlyArray<{ bit: number; name: string }> = [
  { bit: XIAOMI_KEY_MODIFIERS.LEFT_CTRL, name: "Ctrl" },
  { bit: XIAOMI_KEY_MODIFIERS.LEFT_SHIFT, name: "Shift" },
  { bit: XIAOMI_KEY_MODIFIERS.LEFT_ALT, name: "Alt" },
  { bit: XIAOMI_KEY_MODIFIERS.LEFT_WIN, name: "Win" },
  { bit: XIAOMI_KEY_MODIFIERS.RIGHT_CTRL, name: "R-Ctrl" },
  { bit: XIAOMI_KEY_MODIFIERS.RIGHT_SHIFT, name: "R-Shift" },
  { bit: XIAOMI_KEY_MODIFIERS.RIGHT_ALT, name: "R-Alt" },
  { bit: XIAOMI_KEY_MODIFIERS.RIGHT_WIN, name: "R-Win" },
];

const XIAOMI_KEY_CODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(XIAOMI_KEY_CODES).map(([name, code]) => [code, name.replace(/_/g, " ")]),
);

/**
 * Human-readable label for a binding: the preset label for direct key combos,
 * `Custom (…)` for a custom combo, `Macro (N events)` for macros. Returns
 * `undefined` for unknown modes so callers can fall back to "Unknown".
 */
export function xiaomiBindingLabel(binding: XiaomiBinding): string | undefined {
  const preset = XIAOMI_BUTTON_ACTIONS.find((action) => action.combo === binding.mode);
  if (preset) return preset.label;
  if (binding.mode === XIAOMI_KEY_COMBOS.CUSTOM_KEY_COMBO) {
    const parts: string[] = [];
    for (const { bit, name } of XIAOMI_MODIFIER_NAMES) {
      if ((binding.modifiers ?? 0) & bit) parts.push(name);
    }
    const key = XIAOMI_KEY_CODE_NAMES[binding.key ?? 0];
    parts.push(key ?? `0x${(binding.key ?? 0).toString(16)}`);
    return `Custom (${parts.join("+")})`;
  }
  if (binding.mode === XIAOMI_KEY_COMBOS.MACROS_NO_DELAY || binding.mode === XIAOMI_KEY_COMBOS.MACROS_WITH_DELAY) {
    return `Macro (${Math.round((binding.macroSize ?? 0) / XIAOMI_MACRO_EVENT_SIZE)} events)`;
  }
  return undefined;
}

export interface XiaomiBinding {
  /** Binding mode (a key combo, 0x0100 custom, or 0x0200/0x0201 macro). */
  mode: number;
  /** Macro size in bytes, present for macro modes. */
  macroSize?: number;
  /** Modifier bitmask, present for the custom-combo mode. */
  modifiers?: number;
  /** HID keyboard usage, present for the custom-combo mode. */
  key?: number;
}

/* ---------------------------------
 * Macro
 * --------------------------------- */

/**
 * HID report ID of the macro channel. The Qt app writes it as the first byte
 * of its 64-byte hidraw buffer; WebHID passes it as `sendReport`'s first
 * argument instead.
 */
export const XIAOMI_MACRO_REPORT_ID = 0x57;
/** Size of the raw hidraw macro buffer: 1 report-ID byte + 63 data bytes. */
export const XIAOMI_MACRO_PACKET_SIZE = 64;
/** Data size of one macro report, excluding the report-ID byte. */
export const XIAOMI_MACRO_REPORT_DATA_SIZE = XIAOMI_MACRO_PACKET_SIZE - 1;
/** Fixed header length of a macro packet (bytes 0-7). */
export const XIAOMI_MACRO_HEADER_LENGTH = 8;
/** Size of one macro event on the wire: [key, state, delay_hi, delay_lo]. */
export const XIAOMI_MACRO_EVENT_SIZE = 4;
/** Max event bytes per macro packet: 64 - 8 = 56. */
export const XIAOMI_MACRO_MAX_EVENT_BYTES = XIAOMI_MACRO_PACKET_SIZE - XIAOMI_MACRO_HEADER_LENGTH;
/** Max events per macro packet: 56 / 4 = 14. */
export const XIAOMI_MACRO_MAX_EVENTS_PER_PACKET = XIAOMI_MACRO_MAX_EVENT_BYTES / XIAOMI_MACRO_EVENT_SIZE;

/**
 * A single macro event. `state` is 0 (pressed) or 1 (released). `delayMs` is
 * the delay before this event, meaningful only for the with-delay macro mode
 * and always 0 for the first event.
 */
export interface XiaomiMacroEvent {
  key: number;
  state: 0 | 1;
  delayMs: number;
}

/** Decoded macro chunk: the event-byte count and the events it carries. */
export interface XiaomiMacroChunk {
  /** Number of event bytes in this packet (byte 3 of the reply). */
  packetSize: number;
  events: XiaomiMacroEvent[];
}

/**
 * Split a macro into packets of at most {@link XIAOMI_MACRO_MAX_EVENTS_PER_PACKET}
 * events, in order. The driver writes one packet per chunk.
 */
export function xiaomiMacroPackets(events: readonly XiaomiMacroEvent[]): XiaomiMacroEvent[][] {
  const packets: XiaomiMacroEvent[][] = [];
  for (let i = 0; i < events.length; i += XIAOMI_MACRO_MAX_EVENTS_PER_PACKET) {
    packets.push(events.slice(i, i + XIAOMI_MACRO_MAX_EVENTS_PER_PACKET));
  }
  return packets;
}

/* ---------------------------------
 * Helpers
 * --------------------------------- */

function request(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(XIAOMI_PACKET_SIZE);
  data.set(bytes);
  return data;
}

function macroRequest(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(XIAOMI_MACRO_PACKET_SIZE);
  data.set(bytes);
  return data;
}

function requirePrefix(data: Uint8Array, expected: readonly number[], name: string, minLength: number): void {
  if (data.length < minLength) {
    throw new Error(`${name} reply is too short.`);
  }

  expected.forEach((byte, i) => {
    if (data[i] !== byte) {
      throw new Error(`${name} reply has unexpected byte ${i}: 0x${data[i].toString(16).padStart(2, "0")}.`);
    }
  });
}

function lightingZone(device: number): XiaomiLightingDevice {
  if (device === XIAOMI_LIGHTING_DEVICES.TAIL) return "TAIL";
  if (device === XIAOMI_LIGHTING_DEVICES.WHEEL) return "WHEEL";
  throw new RangeError("Xiaomi lighting device must be 0 (tail) or 1 (wheel).");
}

export function xiaomiHexColorToRgb(color: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) throw new RangeError(`Xiaomi color must be "#rrggbb", got "${color}".`);
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function xiaomiRgbToHexColor(rgb: readonly [number, number, number]): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

/* ---------------------------------
 * READ REQUESTS
 * --------------------------------- */

export function xiaomiReadLightingRequest(device: number): Uint8Array {
  lightingZone(device);
  return request(XIAOMI_HEADER, 0xa0, device);
}

export function xiaomiReadBatteryRequest(): Uint8Array {
  return request(XIAOMI_HEADER, 0x90);
}

export function xiaomiReadPollingRequest(): Uint8Array {
  return request(XIAOMI_HEADER, 0xc4);
}

export function xiaomiReadDpiRequest(): Uint8Array {
  return request(XIAOMI_HEADER, 0xc2);
}

export function xiaomiReadBindingRequest(button: number): Uint8Array {
  if (!Number.isInteger(button) || button < 0 || button > 7) {
    throw new RangeError("Xiaomi button must be 0-7.");
  }
  return request(XIAOMI_HEADER, 0xb0, button);
}

/* ---------------------------------
 * WRITES
 * --------------------------------- */

export function xiaomiWriteLightingRequest(
  device: number,
  effect: number,
  speed: number,
  rgb: readonly [number, number, number],
): Uint8Array {
  const zone = lightingZone(device);
  if (!XIAOMI_EFFECTS_BY_DEVICE[zone].includes(effect as XiaomiEffect)) {
    throw new RangeError(`Xiaomi effect ${effect} is not supported for the ${zone.toLowerCase()} zone.`);
  }
  if (!XIAOMI_SPEEDS.includes(speed as (typeof XIAOMI_SPEEDS)[number])) {
    throw new RangeError("Xiaomi lighting speed must be 1-8.");
  }
  return request(XIAOMI_HEADER, 0xa1, device, xiaomiEffectToWire(effect), speed, 0x08, 0x08, rgb[0], rgb[1], rgb[2]);
}

export function xiaomiWritePollingRequest(hz: number): Uint8Array {
  return request(XIAOMI_HEADER, 0xc3, xiaomiPollingRateToWire(hz));
}

export function xiaomiWriteDpiRequest(levels: readonly number[], active: number): Uint8Array {
  if (levels.length !== XIAOMI_DPI_LEVELS) {
    throw new RangeError(`Xiaomi DPI needs exactly ${XIAOMI_DPI_LEVELS} levels.`);
  }
  if (!Number.isInteger(active) || active < 0 || active >= XIAOMI_DPI_LEVELS) {
    throw new RangeError(`Xiaomi active DPI level must be 0-${XIAOMI_DPI_LEVELS - 1}.`);
  }
  const bytes = [XIAOMI_HEADER, 0xc1];
  for (const level of levels) bytes.push(xiaomiDpiToWire(level));
  bytes.push(active, 0x00, 0x05);
  return request(...bytes);
}

export function xiaomiWriteBindingRequest(button: number, combo: number, modifiers: number, key: number): Uint8Array {
  if (!Number.isInteger(button) || button < 0 || button > 7) {
    throw new RangeError("Xiaomi button must be 0-7.");
  }
  if (!Number.isInteger(combo) || combo < 0 || combo > 0xffff) {
    throw new RangeError("Xiaomi binding combo must fit in 16 bits.");
  }
  return request(XIAOMI_HEADER, 0xb1, button, combo >> 8, combo & 0xff, modifiers, key);
}

/* ---------------------------------
 * READ DECODERS
 * --------------------------------- */

export interface XiaomiLighting {
  effect: number;
  speed: number;
  color: [number, number, number];
}

export function xiaomiDecodeLighting(data: Uint8Array): XiaomiLighting {
  requirePrefix(data, [XIAOMI_HEADER, 0xa0], "Xiaomi lighting", 11);
  return {
    effect: xiaomiEffectFromWire(data[4]),
    speed: data[5],
    color: [data[8], data[9], data[10]],
  };
}

export function xiaomiDecodeBattery(data: Uint8Array): number {
  requirePrefix(data, [XIAOMI_HEADER, 0x90], "Xiaomi battery", 4);
  return data[3];
}

export function xiaomiDecodePolling(data: Uint8Array): number {
  requirePrefix(data, [XIAOMI_HEADER, 0xc4], "Xiaomi polling", 4);
  return xiaomiPollingRateFromWire(data[3]);
}

export interface XiaomiDpi {
  levels: number[];
  active: number;
}

export function xiaomiDecodeDpi(data: Uint8Array): XiaomiDpi {
  requirePrefix(data, [XIAOMI_HEADER, 0xc2], "Xiaomi DPI", 9);
  const levels = Array.from({ length: XIAOMI_DPI_LEVELS }, (_, i) => xiaomiDpiFromWire(data[3 + i]));
  let active = data[8];
  if (active > XIAOMI_DPI_LEVELS - 1) active = XIAOMI_DPI_LEVELS - 1;
  return { levels, active };
}

export function xiaomiDecodeBinding(data: Uint8Array): XiaomiBinding {
  // The device does not echo the button index in byte 2 (it stays 0x00), so
  // only the header and command are validated; the reply is correlated with
  // the request by the driver's request/response exchange.
  requirePrefix(data, [XIAOMI_HEADER, 0xb0], "Xiaomi binding", 8);
  const mode = (data[4] << 8) | data[5];
  const result: XiaomiBinding = { mode };
  if (mode === XIAOMI_KEY_COMBOS.MACROS_NO_DELAY || mode === XIAOMI_KEY_COMBOS.MACROS_WITH_DELAY) {
    const size = (data[6] << 8) | data[7];
    result.macroSize = size >= 0x8000 ? size - 0x10000 : size;
  } else if (mode === XIAOMI_KEY_COMBOS.CUSTOM_KEY_COMBO) {
    result.modifiers = data[6];
    result.key = data[7];
  }
  return result;
}

/* ---------------------------------
 * Macro
 * --------------------------------- */

/**
 * Build a macro read request (0x57 0xf0 0x0d). `offset` is the cumulative
 * event-byte offset to resume from; `chunkSize` is the number of event bytes
 * to request (max {@link XIAOMI_MACRO_MAX_EVENT_BYTES}). The device replies
 * with a 64-byte packet whose byte 3 is the number of event bytes returned.
 */
export function xiaomiReadMacroRequest(offset: number, chunkSize: number): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) {
    throw new RangeError("Xiaomi macro offset must be a 16-bit integer");
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 0 || chunkSize > XIAOMI_MACRO_MAX_EVENT_BYTES) {
    throw new RangeError(`Xiaomi macro chunk size must be 0..${XIAOMI_MACRO_MAX_EVENT_BYTES}`);
  }
  return macroRequest(
    XIAOMI_MACRO_REPORT_ID,
    0xf0,
    0x0d,
    chunkSize,
    0x00,
    0x00,
    (offset >> 8) & 0xff,
    offset & 0xff,
  );
}

/**
 * Build a macro write packet (0x57 0xf1 0x0d). `offset` is the cumulative
 * event-byte offset of this packet; `events` holds at most
 * {@link XIAOMI_MACRO_MAX_EVENTS_PER_PACKET} events. Each event is encoded as
 * [key, state, delay_hi, delay_lo]. The device does not reply.
 */
export function xiaomiWriteMacroRequest(offset: number, events: readonly XiaomiMacroEvent[]): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) {
    throw new RangeError("Xiaomi macro offset must be a 16-bit integer");
  }
  if (events.length > XIAOMI_MACRO_MAX_EVENTS_PER_PACKET) {
    throw new RangeError(`A Xiaomi macro packet holds at most ${XIAOMI_MACRO_MAX_EVENTS_PER_PACKET} events`);
  }
  const data = macroRequest(
    XIAOMI_MACRO_REPORT_ID,
    0xf1,
    0x0d,
    events.length * XIAOMI_MACRO_EVENT_SIZE,
    0x00,
    0x00,
    (offset >> 8) & 0xff,
    offset & 0xff,
  );
  events.forEach((event, i) => {
    const pos = XIAOMI_MACRO_HEADER_LENGTH + i * XIAOMI_MACRO_EVENT_SIZE;
    if (!Number.isInteger(event.key) || event.key < 0 || event.key > 0xff) {
      throw new RangeError("Xiaomi macro key must be a byte");
    }
    if (event.state !== 0 && event.state !== 1) {
      throw new RangeError("Xiaomi macro state must be 0 (pressed) or 1 (released)");
    }
    if (!Number.isInteger(event.delayMs) || event.delayMs < 0 || event.delayMs > 0xffff) {
      throw new RangeError("Xiaomi macro delay must be a 16-bit integer");
    }
    data[pos] = event.key;
    data[pos + 1] = event.state;
    data[pos + 2] = (event.delayMs >> 8) & 0xff;
    data[pos + 3] = event.delayMs & 0xff;
  });
  return data;
}

/**
 * Decode a macro read reply. Byte 3 is the number of event bytes in the
 * packet; events start at byte 8. A `packetSize` below the header length
 * signals the end of the macro.
 */
export function xiaomiDecodeMacroChunk(data: Uint8Array): XiaomiMacroChunk {
  if (data.length < XIAOMI_MACRO_PACKET_SIZE) {
    throw new Error(`Xiaomi macro reply must be ${XIAOMI_MACRO_PACKET_SIZE} bytes, got ${data.length}`);
  }
  if (data[0] !== XIAOMI_MACRO_REPORT_ID || data[1] !== 0xf0 || data[2] !== 0x0d) {
    throw new Error("Xiaomi macro reply has an unexpected header");
  }
  const packetSize = data[3];
  if (packetSize < XIAOMI_MACRO_HEADER_LENGTH) {
    return { packetSize, events: [] };
  }
  const count = Math.min(packetSize / XIAOMI_MACRO_EVENT_SIZE, XIAOMI_MACRO_MAX_EVENTS_PER_PACKET);
  const events: XiaomiMacroEvent[] = [];
  for (let i = 0; i < count; i++) {
    const pos = XIAOMI_MACRO_HEADER_LENGTH + i * XIAOMI_MACRO_EVENT_SIZE;
    events.push({
      key: data[pos],
      state: data[pos + 1] === 1 ? 1 : 0,
      delayMs: (data[pos + 2] << 8) | data[pos + 3],
    });
  }
  return { packetSize, events };
}
