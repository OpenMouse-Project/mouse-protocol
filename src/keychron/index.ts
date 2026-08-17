/** Nape Pro VIA codec. Do not reuse these keymap/layer helpers for M-series Keychron mice. */
export const KEYCHRON_VENDOR_ID = 0x3434;
export const KEYCHRON_RAW_USAGE_PAGE = 0xff60;
export const KEYCHRON_RAW_USAGE = 0x61;
export const KEYCHRON_REPORT_ID = 0;
export const KEYCHRON_PACKET_LENGTH = 32;
export const KEYCHRON_NAPE_PRODUCTS = new Map<number, { name: string; receiver?: boolean }>([
  [0x0440, { name: "Nape Pro" }],
  [0xd026, { name: "Keychron Link-KM", receiver: true }],
  [0xd029, { name: "Keychron Link-KM Type C", receiver: true }],
]);
export const KEYCHRON_COMMAND = { firmwareVersion: 161, getCurrentLayer: 163, miscGroup: 167 } as const;
/** Standard VIA opcodes used by Nape for keymap metadata (not the 0xA7 misc group). */
export const KEYCHRON_VIA_COMMAND = {
  getKeycode: 4,
  setKeycode: 5,
  getLayerCount: 17,
  getBuffer: 18,
  getEncoder: 20,
  setEncoder: 21,
} as const;
export const KEYCHRON_NAPE_COMMAND = {
  getOrientation: 32, getDpiStage: 33, setDpiStage: 34, setDpiValue: 35,
  getDpiValue: 36, setLayer: 45, getBattery: 49, setOrientation: 52,
  getCustomDpi: 54, setCustomDpi: 55, getLayerOrientation: 56, setLayerOrientation: 57,
} as const;
/** Sensor heading is stored per layer in 45° steps (0–7 → 0°–315°). */
export const KEYCHRON_NAPE_ORIENTATION_STEPS = 8;
export const KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES = 45;
/**
 * Nape Pro exposes eight user layers (1–8). VIA may report a spare slot at
 * index 0; GET_CURRENT_LAYER and keymap/encoder commands use the same 1–8
 * index. Keychron Launcher writes GET_BUFFER offset 14 * 3 when the mouse
 * reports current layer 3.
 */
export const KEYCHRON_NAPE_LAYER_COUNT = 8;
export const KEYCHRON_MISC_COMMAND = {
  getSleep: 11,
  setSleep: 12,
  getPolling: 13,
  setPolling: 14,
} as const;
export const KEYCHRON_POLLING_TABLE = [8000, 4000, 2000, 1000, 500, 250, 125] as const;
/** Nape Pro only — observed on firmware v1.2.6-ZK (stage 5 stores 4000). Other Keychron mice should define their own ranges. */
export const KEYCHRON_NAPE_DPI_MIN = 50;
export const KEYCHRON_NAPE_DPI_MAX = 4000;
export const KEYCHRON_NAPE_DPI_STEP = 50;
export const KEYCHRON_NAPE_SLEEP_MIN_SECONDS = 60;
export const KEYCHRON_NAPE_SLEEP_MAX_SECONDS = 12 * 3600 + 59 * 60 + 59;
export const KEYCHRON_NAPE_SLEEP_OPTIONS = [
  60, 120, 300, 600, 1800, 3600, 7200, 18_000, 43_200,
] as const;

export function keychronPacket(command: readonly number[]): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(KEYCHRON_PACKET_LENGTH);
  packet.set(command.slice(0, KEYCHRON_PACKET_LENGTH));
  return packet;
}

export function keychronDecodePolling(response: Uint8Array): { rateHz: number; supported: number[] } {
  if (response.slice(2).every((byte) => byte === 0)) return { rateHz: 1000, supported: [125, 500, 1000] };
  const mask = response[5] ?? 0;
  const supported = KEYCHRON_POLLING_TABLE.filter((_, index) => ((mask >> index) & 1) === 1).slice().sort((a, b) => a - b);
  const rateHz = KEYCHRON_POLLING_TABLE[Math.min(response[6] ?? 3, KEYCHRON_POLLING_TABLE.length - 1)] ?? 1000;
  return { rateHz, supported: supported.length ? supported : [rateHz] };
}

export function keychronDecodeFirmware(response: Uint8Array): string | null {
  const end = response.indexOf(0, 1);
  const bytes = response.slice(1, end < 0 ? undefined : end);
  if (!bytes.length) return null;
  const text = String.fromCharCode(...bytes);
  return text.startsWith("v") ? text : `v${text}`;
}

export function keychronDecodeBattery(
  response: Uint8Array,
): { percent: number; state: "Charging" | "Full" | "Discharging" } {
  const percent = response[2] ?? 0xff;
  const status = response[3] ?? 0;
  const state = status === 1
    ? "Charging"
    : status === 2
      ? "Full"
      : "Discharging";
  return { percent, state };
}

export function keychronDecodeSleepTimeout(response: Uint8Array): number {
  return (response[5] ?? 0) | ((response[6] ?? 0) << 8);
}

export function keychronEncodeSleepTimeout(seconds: number): number[] {
  return [
    KEYCHRON_COMMAND.miscGroup,
    KEYCHRON_MISC_COMMAND.setSleep,
    0,
    0,
    seconds & 0xff,
    (seconds >> 8) & 0xff,
    0,
    0,
  ];
}

export function keychronDecodeLayerCount(response: Uint8Array): number {
  return response[1] ?? 0;
}

export function keychronDecodeCurrentLayer(response: Uint8Array): number {
  const reported = response[1] ?? 1;
  if (reported < 1) return 1;
  return Math.min(reported, KEYCHRON_NAPE_LAYER_COUNT);
}

export function keychronEncodeSetLayer(layer: number): number[] {
  return [KEYCHRON_COMMAND.miscGroup, KEYCHRON_NAPE_COMMAND.setLayer, layer & 0xff];
}

export function keychronOrientationIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= KEYCHRON_NAPE_ORIENTATION_STEPS) {
    throw new Error(`Orientation must be a 45° step from 0° to 315°.`);
  }
  return index;
}

export function keychronOrientationDegrees(index: number): number {
  return KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES * keychronOrientationIndex(index);
}

export function keychronOrientationLabel(index: number): string {
  return `${keychronOrientationDegrees(index)}\u00b0`;
}

export const KEYCHRON_NAPE_ORIENTATION_OPTIONS = Array.from(
  { length: KEYCHRON_NAPE_ORIENTATION_STEPS },
  (_, index) => ({
    index,
    degrees: KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES * index,
    label: `${KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES * index}\u00b0`,
  }),
);

export function keychronDecodeOrientationIndex(response: Uint8Array): number {
  return response[2] ?? 0xff;
}

export function keychronEncodeSetOrientation(index: number): number[] {
  return [KEYCHRON_COMMAND.miscGroup, KEYCHRON_NAPE_COMMAND.setOrientation, keychronOrientationIndex(index)];
}

export function keychronEncodeGetLayerOrientation(layer: number): number[] {
  return [KEYCHRON_COMMAND.miscGroup, KEYCHRON_NAPE_COMMAND.getLayerOrientation, layer & 0xff];
}

export function keychronEncodeSetLayerOrientation(layer: number, index: number): number[] {
  return [
    KEYCHRON_COMMAND.miscGroup,
    KEYCHRON_NAPE_COMMAND.setLayerOrientation,
    layer & 0xff,
    keychronOrientationIndex(index),
  ];
}

/** Nape VIA keymap is 7 packed columns; the overlay exposes the first six. */
export const KEYCHRON_NAPE_KEYMAP_COLUMNS = 7;
export const KEYCHRON_NAPE_KEYMAP_BUFFER_SIZE = KEYCHRON_NAPE_KEYMAP_COLUMNS * 2;
export const KEYCHRON_NAPE_KEY_CONTROLS = [
  { col: 0, name: "03" },
  { col: 1, name: "04" },
  { col: 2, name: "01" },
  { col: 3, name: "02" },
  { col: 4, name: "M1" },
  { col: 5, name: "M2" },
] as const;
export const KEYCHRON_NAPE_ENCODER_ID = 0;
export const KEYCHRON_NAPE_ENCODER_CCW = 0;
export const KEYCHRON_NAPE_ENCODER_CW = 1;

/** VIA protocol 12 QMK keycodes confirmed on Nape Pro firmware v1.2.6-ZK. */
export const KEYCHRON_QK_USER = 0x7e00;
export const KEYCHRON_QK_MOMENTARY = 0x5220;
export const KEYCHRON_NAPE_KEYCODE = {
  no: 0,
  mute: 0x00a8,
  volumeUp: 0x00a9,
  volumeDown: 0x00aa,
  leftClick: 0x00d1,
  rightClick: 0x00d2,
  middleClick: 0x00d3,
  backward: 0x00d4,
  forward: 0x00d5,
  scrollUp: 0x00d9,
  scrollDown: 0x00da,
  scrollLeft: 0x00db,
  scrollRight: 0x00dc,
  dpiNext: KEYCHRON_QK_USER + 37,
  dpiPrev: KEYCHRON_QK_USER + 38,
  pollingPrev: KEYCHRON_QK_USER + 39,
  pollingNext: KEYCHRON_QK_USER + 40,
  orientationCycle: KEYCHRON_QK_USER + 43,
  dpiCycle: KEYCHRON_QK_USER + 44,
  pollingCycle: KEYCHRON_QK_USER + 45,
  doubleClick: KEYCHRON_QK_USER + 46,
  customDpi: KEYCHRON_QK_USER + 47,
  gestureMode: KEYCHRON_QK_MOMENTARY + 9,
  scrollMode: KEYCHRON_QK_MOMENTARY + 10,
} as const;

export const KEYCHRON_NAPE_BUTTON_ACTIONS = [
  "Disabled",
  "Left click",
  "Right click",
  "Middle click",
  "Back",
  "Forward",
  "Double left click",
  "Scroll up",
  "Scroll down",
  "Scroll left",
  "Scroll right",
  "Volume up",
  "Volume down",
  "Mute",
  "Scroll mode",
  "Gesture mode",
  "DPI cycle",
  "DPI up",
  "DPI down",
  "Polling cycle",
  "Polling up",
  "Polling down",
  "Cycle orientation",
] as const;
export type KeychronNapeButtonAction = (typeof KEYCHRON_NAPE_BUTTON_ACTIONS)[number];

const KEYCHRON_NAPE_BUTTON_KEYCODES: Record<KeychronNapeButtonAction, number> = {
  Disabled: KEYCHRON_NAPE_KEYCODE.no,
  "Left click": KEYCHRON_NAPE_KEYCODE.leftClick,
  "Right click": KEYCHRON_NAPE_KEYCODE.rightClick,
  "Middle click": KEYCHRON_NAPE_KEYCODE.middleClick,
  Back: KEYCHRON_NAPE_KEYCODE.backward,
  Forward: KEYCHRON_NAPE_KEYCODE.forward,
  "Double left click": KEYCHRON_NAPE_KEYCODE.doubleClick,
  "Scroll up": KEYCHRON_NAPE_KEYCODE.scrollUp,
  "Scroll down": KEYCHRON_NAPE_KEYCODE.scrollDown,
  "Scroll left": KEYCHRON_NAPE_KEYCODE.scrollLeft,
  "Scroll right": KEYCHRON_NAPE_KEYCODE.scrollRight,
  "Volume up": KEYCHRON_NAPE_KEYCODE.volumeUp,
  "Volume down": KEYCHRON_NAPE_KEYCODE.volumeDown,
  Mute: KEYCHRON_NAPE_KEYCODE.mute,
  "Scroll mode": KEYCHRON_NAPE_KEYCODE.scrollMode,
  "Gesture mode": KEYCHRON_NAPE_KEYCODE.gestureMode,
  "DPI cycle": KEYCHRON_NAPE_KEYCODE.dpiCycle,
  "DPI up": KEYCHRON_NAPE_KEYCODE.dpiNext,
  "DPI down": KEYCHRON_NAPE_KEYCODE.dpiPrev,
  "Polling cycle": KEYCHRON_NAPE_KEYCODE.pollingCycle,
  "Polling up": KEYCHRON_NAPE_KEYCODE.pollingNext,
  "Polling down": KEYCHRON_NAPE_KEYCODE.pollingPrev,
  "Cycle orientation": KEYCHRON_NAPE_KEYCODE.orientationCycle,
};

const KEYCHRON_NAPE_BUTTON_ACTION_BY_KEYCODE = new Map<number, KeychronNapeButtonAction>(
  Object.entries(KEYCHRON_NAPE_BUTTON_KEYCODES).map(([action, keycode]) => [keycode, action as KeychronNapeButtonAction]),
);

export interface KeychronNapeMappedControl {
  keycode: number;
  action: KeychronNapeButtonAction | "Custom";
}

export interface KeychronNapeLayerKeymap {
  layer: number;
  keys: Array<KeychronNapeMappedControl & { col: number; name: string }>;
  wheel: { ccw: KeychronNapeMappedControl; cw: KeychronNapeMappedControl };
  /** Saved sensor heading for this layer, 0–7 (0°–315°). */
  orientationIndex: number;
}

export function keychronUserLayerToVia(layer: number): number {
  return Math.min(Math.max(layer, 1), KEYCHRON_NAPE_LAYER_COUNT);
}

/** Firmware layers are 1–8; the UI and Launcher label them 0–7. */
export function keychronLayerDisplayIndex(layer: number): number {
  return keychronUserLayerToVia(layer) - 1;
}

export function keychronLayerLabel(layer: number): string {
  return `Layer ${keychronLayerDisplayIndex(layer)}`;
}

export function keychronActionForKeycode(keycode: number): KeychronNapeButtonAction | "Custom" {
  return KEYCHRON_NAPE_BUTTON_ACTION_BY_KEYCODE.get(keycode) ?? "Custom";
}

export function keychronKeycodeForAction(action: KeychronNapeButtonAction): number {
  return KEYCHRON_NAPE_BUTTON_KEYCODES[action];
}

export function keychronMappedControl(keycode: number): KeychronNapeMappedControl {
  return { keycode, action: keychronActionForKeycode(keycode) };
}

export function keychronLayerKeymapFromCodes(
  layer: number,
  columnCodes: readonly number[],
  ccw: number,
  cw: number,
  orientationIndex = 0,
): KeychronNapeLayerKeymap {
  return {
    layer,
    keys: KEYCHRON_NAPE_KEY_CONTROLS.map((control) => ({
      ...control,
      ...keychronMappedControl(columnCodes[control.col] ?? 0),
    })),
    wheel: {
      ccw: keychronMappedControl(ccw),
      cw: keychronMappedControl(cw),
    },
    orientationIndex,
  };
}

export function keychronEncodeGetBuffer(viaLayer: number): number[] {
  const offset = KEYCHRON_NAPE_KEYMAP_BUFFER_SIZE * viaLayer;
  return [
    KEYCHRON_VIA_COMMAND.getBuffer,
    (offset >> 8) & 0xff,
    offset & 0xff,
    KEYCHRON_NAPE_KEYMAP_BUFFER_SIZE,
  ];
}

export function keychronDecodeKeymapBuffer(response: Uint8Array): number[] {
  const size = response[3] ?? 0;
  const data = response.subarray(4, 4 + size);
  const codes: number[] = [];
  for (let index = 0; index + 1 < data.length; index += 2) {
    codes.push(((data[index] ?? 0) << 8) | (data[index + 1] ?? 0));
  }
  return codes;
}

export function keychronEncodeGetKeycode(viaLayer: number, col: number): number[] {
  return [KEYCHRON_VIA_COMMAND.getKeycode, viaLayer & 0xff, 0, col & 0xff];
}

export function keychronEncodeSetKeycode(viaLayer: number, col: number, keycode: number): number[] {
  return [
    KEYCHRON_VIA_COMMAND.setKeycode,
    viaLayer & 0xff,
    0,
    col & 0xff,
    (keycode >> 8) & 0xff,
    keycode & 0xff,
  ];
}

export function keychronEncodeGetEncoder(viaLayer: number, clockwise: boolean): number[] {
  return [
    KEYCHRON_VIA_COMMAND.getEncoder,
    viaLayer & 0xff,
    KEYCHRON_NAPE_ENCODER_ID,
    clockwise ? KEYCHRON_NAPE_ENCODER_CW : KEYCHRON_NAPE_ENCODER_CCW,
  ];
}

export function keychronEncodeSetEncoder(viaLayer: number, clockwise: boolean, keycode: number): number[] {
  return [
    KEYCHRON_VIA_COMMAND.setEncoder,
    viaLayer & 0xff,
    KEYCHRON_NAPE_ENCODER_ID,
    clockwise ? KEYCHRON_NAPE_ENCODER_CW : KEYCHRON_NAPE_ENCODER_CCW,
    (keycode >> 8) & 0xff,
    keycode & 0xff,
  ];
}

export function keychronDecodeKeycodeReply(response: Uint8Array): number {
  return ((response[4] ?? 0) << 8) | (response[5] ?? 0);
}

