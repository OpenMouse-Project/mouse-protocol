/**
 * Configuration protocol of the 0x04F3:0x026E/0x026F OEM mouse firmware, as
 * used by Amkette's XS Flow series and the Ryunix Kyu Pro MX1. Reverse-engineered
 * from Amkette's public WebHID configurator
 * (https://support.amkette.com/webapp/xs_flow_2_speed/); nothing here has been
 * seen in a vendor binary.
 *
 * Transport: the mouse's control collection (usage page 0x0A) carries
 *   - input report 0x04: telemetry (see `kyu-pro-mx1.ts`);
 *   - feature report 0x05: status read, which makes the mouse emit report 0x04;
 *   - feature report 0x06: 31-byte command write; reading it back returns the
 *     acknowledgement, whose byte 1 is 1 when the command was accepted.
 *
 * Command frame (31 bytes): `[command, sequence, sub, checksum, ...payload]`.
 * The checksum is `(6 + sum of the other 30 bytes) & 0xFF` and sits at offset
 * 3. The vendor pads payloads with 0xFF, except polling rate and reset (0x00).
 * The mouse never reports DPI values, lift-off distance, sleep time or button
 * maps back, so those are write-only; only the active DPI stage, polling rate,
 * battery and lighting mode arrive in telemetry.
 *
 * Only the Amkette XS driver (`src/drivers/amkette/xs-hid.ts`) sends these
 * commands, and they have only been checked on an Amkette mouse. The Ryunix Kyu
 * Pro MX1 driver reads telemetry only; do not wire these writes into it before
 * they have been checked on that mouse.
 */

export const RYUNIX_COMMAND_REPORT_ID = 0x06;
export const RYUNIX_COMMAND_FRAME_LENGTH = 31;

export const RYUNIX_COMMAND = {
  buttons: 0x01,
  dpi: 0x02,
  dpiColors: 0x03,
  pollingRate: 0x04,
  liftOffDistance: 0x05,
  lighting: 0x06,
  power: 0x07,
  sensorOptions: 0x08,
  macroWrite: 0x10,
  macroErase: 0x11,
  reset: 0x0f,
} as const;

/** Sub-command of the DPI table write: X axis, then the Y axis copy. */
const DPI_SUB_X = 0x02;
const DPI_SUB_Y = 0x12;

export const RYUNIX_DPI_SLOTS = 8;
export const RYUNIX_DPI_MAX_STAGES = 7;
export const RYUNIX_DPI_MIN = 200;
export const RYUNIX_DPI_STEP = 100;

/** Sequence counter the vendor app increments per command, wrapping at 256. */
export function ryunixNextSequence(current: number): number {
  return (current + 1) & 0xff;
}

/**
 * Build one command frame. `payload` is placed after the checksum and padded
 * with `pad` to the fixed frame length.
 */
export function ryunixFrame(
  command: number,
  sequence: number,
  sub: number,
  payload: readonly number[],
  pad = 0xff,
): Uint8Array {
  const bodyLength = RYUNIX_COMMAND_FRAME_LENGTH - 1;
  if (payload.length > bodyLength - 3) {
    throw new RangeError(`Ryunix payload is ${payload.length} bytes; at most ${bodyLength - 3} fit.`);
  }
  const body = new Uint8Array(bodyLength).fill(pad);
  body[0] = command;
  body[1] = sequence & 0xff;
  body[2] = sub;
  payload.forEach((byte, index) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new RangeError(`Ryunix payload byte ${index} (${byte}) is not a byte.`);
    }
    body[3 + index] = byte;
  });
  let checksum = 6;
  for (const byte of body) checksum += byte;

  const frame = new Uint8Array(RYUNIX_COMMAND_FRAME_LENGTH);
  frame.set(body.subarray(0, 3), 0);
  frame[3] = checksum & 0xff;
  frame.set(body.subarray(3), 4);
  return frame;
}

/** True when the acknowledgement read from report 0x06 reports success. */
export function ryunixAckOk(ack: Uint8Array): boolean {
  return ack.length > 1 && ack[1] === 1;
}

/** Polling-rate codes the mouse accepts and reports. */
export const RYUNIX_POLLING_CODES: ReadonlyArray<readonly [code: number, hz: number]> = [
  [0x08, 125],
  [0x04, 250],
  [0x02, 500],
  [0x01, 1000],
  [0x11, 2000],
  [0x12, 4000],
  [0x14, 8000],
];

export function ryunixPollingHz(code: number): number | null {
  return RYUNIX_POLLING_CODES.find(([value]) => value === code)?.[1] ?? null;
}

/**
 * Rates a mouse offers, from the "maximum report rate" byte of its telemetry
 * (offset 7). 8/4/2/1 mean the mouse reaches 8000/4000/2000/1000 Hz; 0x31
 * limits it to 250 Hz.
 */
export function ryunixSupportedPollingRates(maxRateCode: number | null): number[] {
  const base = [125, 250, 500, 1000];
  switch (maxRateCode) {
    case 8: return [...base, 2000, 4000, 8000];
    case 4: return [...base, 2000, 4000];
    case 2: return [...base, 2000];
    case 0x31: return [125, 250];
    default: return base;
  }
}

export function ryunixSetPollingRateFrame(sequence: number, hz: number): Uint8Array {
  const entry = RYUNIX_POLLING_CODES.find(([, rate]) => rate === hz);
  if (!entry) throw new RangeError(`Unsupported polling rate ${hz} Hz.`);
  return ryunixFrame(RYUNIX_COMMAND.pollingRate, sequence, 1, [entry[0]], 0x00);
}

/** Lift-off distance in millimetres; the vendor app offers 1 and 2. */
export const RYUNIX_LIFT_OFF_MM = [1, 2] as const;

export function ryunixSetLiftOffFrame(sequence: number, millimetres: number): Uint8Array {
  if (!(RYUNIX_LIFT_OFF_MM as readonly number[]).includes(millimetres)) {
    throw new RangeError(`Unsupported lift-off distance ${millimetres} mm.`);
  }
  return ryunixFrame(RYUNIX_COMMAND.liftOffDistance, sequence, 1, [millimetres]);
}

export interface RyunixSensor {
  name: string;
  maxDpi: number;
  /** DPI resolution of the wire value: 50 or 100 counts per step. */
  step: number;
  /** The vendor app's default stage table for this sensor (eight slots). */
  defaultStages: readonly number[];
}

/** Sensor types the telemetry reports (offset 8), with the vendor's DPI limits. */
export const RYUNIX_SENSORS: ReadonlyMap<number, RyunixSensor> = new Map([
  [0x11, { name: "3311", maxDpi: 12000, step: 100, defaultStages: [400, 800, 1600, 2400, 3200, 6400, 12000, 12000] }],
  [0x95, { name: "3395", maxDpi: 26000, step: 50, defaultStages: [400, 800, 1600, 3200, 6400, 26000, 26000, 26000] }],
  [0x50, { name: "3950", maxDpi: 30000, step: 50, defaultStages: [400, 800, 1600, 3200, 6400, 30000, 30000, 30000] }],
  [0x20, { name: "3220", maxDpi: 8000, step: 100, defaultStages: [400, 800, 1600, 2400, 3200, 6400, 8000, 8000] }],
  [0x12, { name: "3212", maxDpi: 4800, step: 100, defaultStages: [400, 800, 1200, 1600, 2400, 3200, 4800, 4800] }],
  [0x09, { name: "3809", maxDpi: 6000, step: 100, defaultStages: [400, 800, 1600, 2400, 3200, 4800, 6000, 6000] }],
  [0x03, { name: "S203", maxDpi: 6400, step: 100, defaultStages: [400, 800, 1200, 1600, 2400, 3200, 6400, 6400] }],
  [0x06, { name: "S205", maxDpi: 12800, step: 100, defaultStages: [400, 800, 1600, 2400, 3200, 6400, 12800, 12800] }],
  [0x70, { name: "OM70", maxDpi: 30000, step: 100, defaultStages: [400, 800, 1600, 3200, 6400, 30000, 30000, 30000] }],
]);

/** The vendor app assumes the 3220 until the mouse reports its sensor. */
export const RYUNIX_DEFAULT_SENSOR_TYPE = 0x20;

export function ryunixSensor(sensorType: number | null): RyunixSensor {
  return RYUNIX_SENSORS.get(sensorType ?? RYUNIX_DEFAULT_SENSOR_TYPE)
    ?? RYUNIX_SENSORS.get(RYUNIX_DEFAULT_SENSOR_TYPE)!;
}

export interface RyunixDpiTable {
  /** DPI of each enabled stage, lowest slot first; 1 to 7 entries. */
  stages: readonly number[];
  /** Zero-based active stage. */
  activeStage: number;
}

/**
 * The vendor app's default table for a sensor, first `count` stages. Its UI
 * shows seven stages with 1600 DPI active on the XS Flow 2 Speed.
 */
export function ryunixDefaultDpiStages(sensor: RyunixSensor, count = RYUNIX_DPI_MAX_STAGES): number[] {
  return sensor.defaultStages.slice(0, count);
}

export function ryunixClampDpi(dpi: number, sensor: RyunixSensor): number {
  const stepped = Math.round(dpi / RYUNIX_DPI_STEP) * RYUNIX_DPI_STEP;
  return Math.min(sensor.maxDpi, Math.max(RYUNIX_DPI_MIN, stepped));
}

function dpiWire(dpi: number, sensor: RyunixSensor): number {
  return Math.floor(dpi / sensor.step) - 1;
}

/** DPI table frame for one axis; the vendor app writes X, then Y with the same values. */
export function ryunixSetDpiFrame(
  sequence: number,
  table: RyunixDpiTable,
  sensor: RyunixSensor,
  axis: "x" | "y" = "x",
): Uint8Array {
  const count = table.stages.length;
  if (count < 1 || count > RYUNIX_DPI_MAX_STAGES) {
    throw new RangeError(`A DPI table needs 1 to ${RYUNIX_DPI_MAX_STAGES} stages, not ${count}.`);
  }
  if (!Number.isInteger(table.activeStage) || table.activeStage < 0 || table.activeStage >= count) {
    throw new RangeError(`Active DPI stage ${table.activeStage} is outside 0-${count - 1}.`);
  }
  const payload: number[] = [table.activeStage, (1 << count) - 1];
  for (let slot = 0; slot < RYUNIX_DPI_SLOTS; slot++) {
    if (slot >= count) {
      // The vendor app encodes an unused slot as DPI 0, which wraps to 0xFFFF.
      payload.push(0xff, 0xff);
      continue;
    }
    const dpi = table.stages[slot]!;
    if (dpi < RYUNIX_DPI_MIN || dpi > sensor.maxDpi || dpi % RYUNIX_DPI_STEP !== 0) {
      throw new RangeError(`DPI ${dpi} is not a multiple of ${RYUNIX_DPI_STEP} within ${RYUNIX_DPI_MIN}-${sensor.maxDpi}.`);
    }
    const wire = dpiWire(dpi, sensor);
    payload.push(wire & 0xff, (wire >> 8) & 0xff);
  }
  return ryunixFrame(RYUNIX_COMMAND.dpi, sequence, axis === "x" ? DPI_SUB_X : DPI_SUB_Y, payload);
}

/** Stage indicator colours the vendor app shows by default (the eighth is unused). */
export const RYUNIX_DEFAULT_DPI_COLORS: readonly string[] = [
  "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#ffffff", "#ffffff",
];

export function ryunixParseColor(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) throw new RangeError(`"${color}" is not a #rrggbb colour.`);
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Per-stage DPI indicator colours (eight RGB triples). */
export function ryunixSetDpiColorsFrame(sequence: number, colors: readonly string[]): Uint8Array {
  const payload: number[] = [];
  for (let slot = 0; slot < RYUNIX_DPI_SLOTS; slot++) {
    payload.push(...ryunixParseColor(colors[slot] ?? RYUNIX_DEFAULT_DPI_COLORS[slot]!));
  }
  return ryunixFrame(RYUNIX_COMMAND.dpiColors, sequence, 1, payload);
}

export interface RyunixLightingEffect {
  code: number;
  name: string;
  brightness: boolean;
  speed: boolean;
  direction: boolean;
}

/** Effects the vendor app can address; which a model offers is `RYUNIX_LIGHTING_SCHEMES`. */
export const RYUNIX_LIGHTING_EFFECTS: ReadonlyMap<number, RyunixLightingEffect> = new Map([
  [0, { code: 0, name: "Off", brightness: false, speed: false, direction: false }],
  [1, { code: 1, name: "Rainbow flow", brightness: false, speed: true, direction: true }],
  [2, { code: 2, name: "Breathe", brightness: false, speed: true, direction: false }],
  [3, { code: 3, name: "Steady", brightness: true, speed: false, direction: false }],
  [4, { code: 4, name: "Neon", brightness: false, speed: true, direction: false }],
  [5, { code: 5, name: "Marquee", brightness: false, speed: true, direction: false }],
  [6, { code: 6, name: "Rainbow steady", brightness: true, speed: false, direction: false }],
  [7, { code: 7, name: "Wave", brightness: false, speed: true, direction: false }],
]);

/** Effect codes per model scheme in the vendor app; the XS Flow 2 Speed uses scheme 1. */
export const RYUNIX_LIGHTING_SCHEMES: Readonly<Record<number, readonly number[]>> = {
  1: [3, 2, 0],
  2: [3, 2, 4, 0],
  3: [1, 2, 3, 4, 5, 6, 7, 0],
  4: [],
};

export const RYUNIX_BRIGHTNESS_LEVELS = [1, 2, 3, 4] as const;
export const RYUNIX_SPEED_LEVELS = [1, 2, 3] as const;

export interface RyunixLightingSetting {
  effect: number;
  /** 1-4, used by effects with a brightness control. */
  brightness?: number;
  /** 1-3, used by effects with a speed control. */
  speed?: number;
  direction?: number;
}

export function ryunixSetLightingFrame(sequence: number, setting: RyunixLightingSetting): Uint8Array {
  const effect = RYUNIX_LIGHTING_EFFECTS.get(setting.effect);
  if (!effect) throw new RangeError(`Unknown lighting effect ${setting.effect}.`);
  const brightness = effect.brightness
    ? Math.min(Math.max(setting.brightness ?? 4, 1), 4) << 4
    : 0;
  const speed = effect.speed ? Math.min(Math.max(setting.speed ?? 3, 1), 3) : 0;
  return ryunixFrame(RYUNIX_COMMAND.lighting, sequence, 1, [
    0xff,
    effect.code,
    brightness | speed,
    setting.direction ?? 0,
  ]);
}

export const RYUNIX_SLEEP_MIN_MINUTES = 1;
export const RYUNIX_SLEEP_MAX_MINUTES = 15;

export interface RyunixPowerSetting {
  sleepMinutes: number;
  wakeOnMove: boolean;
  lightOnMove: boolean;
}

export function ryunixSetPowerFrame(sequence: number, setting: RyunixPowerSetting): Uint8Array {
  if (
    !Number.isInteger(setting.sleepMinutes)
    || setting.sleepMinutes < RYUNIX_SLEEP_MIN_MINUTES
    || setting.sleepMinutes > RYUNIX_SLEEP_MAX_MINUTES
  ) {
    throw new RangeError(`Sleep time must be ${RYUNIX_SLEEP_MIN_MINUTES}-${RYUNIX_SLEEP_MAX_MINUTES} minutes.`);
  }
  return ryunixFrame(RYUNIX_COMMAND.power, sequence, 1, [
    setting.sleepMinutes,
    setting.wakeOnMove ? 1 : 0,
    setting.lightOnMove ? 1 : 0,
  ]);
}

export interface RyunixSensorOptions {
  angleSnapping: boolean;
  motionSync: boolean;
  rippleControl: boolean;
}

export function ryunixSetSensorOptionsFrame(sequence: number, options: RyunixSensorOptions): Uint8Array {
  return ryunixFrame(RYUNIX_COMMAND.sensorOptions, sequence, 1, [
    options.angleSnapping ? 1 : 0,
    options.motionSync ? 1 : 0,
    options.rippleControl ? 1 : 0,
  ]);
}

/** Restore factory settings. Not used by the driver; documented for completeness. */
export function ryunixResetFrame(sequence: number): Uint8Array {
  return ryunixFrame(RYUNIX_COMMAND.reset, sequence, 1, [0xff], 0x00);
}

/** A button action as the mouse stores it: three bytes `[kind, a, b]`. */
export type RyunixButtonCode = readonly [number, number, number];

/** Actions the vendor app offers, by display name. Keyboard shortcuts are `[0x70, modifier, HID key]`. */
export const RYUNIX_BUTTON_ACTIONS: ReadonlyMap<string, RyunixButtonCode> = new Map([
  ["Left click", [0x10, 0x01, 0x00]],
  ["Right click", [0x10, 0x02, 0x00]],
  ["Middle click", [0x10, 0x04, 0x00]],
  ["Back", [0x10, 0x08, 0x00]],
  ["Forward", [0x10, 0x10, 0x00]],
  ["Scroll up", [0x10, 0x20, 0x00]],
  ["Scroll down", [0x10, 0x40, 0x00]],
  ["Fire key", [0x30, 0x32, 0x00]],
  ["Triple fire", [0x30, 0x32, 0x03]],
  ["DPI cycle", [0x40, 0x01, 0x00]],
  ["DPI up", [0x40, 0x02, 0x00]],
  ["DPI down", [0x40, 0x03, 0x00]],
  ["Disabled", [0x60, 0x00, 0x00]],
  ["Mode switch", [0x60, 0x01, 0x00]],
  ["Lighting toggle", [0x60, 0x04, 0x00]],
  ["Tilt left", [0x60, 0x06, 0x00]],
  ["Tilt right", [0x60, 0x07, 0x00]],
  ["Show desktop", [0x60, 0x08, 0x00]],
  ["Select all", [0x70, 0x01, 0x04]],
  ["Copy", [0x70, 0x01, 0x06]],
  ["New", [0x70, 0x01, 0x11]],
  ["Print", [0x70, 0x01, 0x13]],
  ["Save", [0x70, 0x01, 0x16]],
  ["Paste", [0x70, 0x01, 0x19]],
  ["Cut", [0x70, 0x01, 0x1b]],
  ["Undo", [0x70, 0x01, 0x1d]],
  ["Open", [0x70, 0x08, 0x08]],
  ["Media player", [0x80, 0x83, 0x01]],
  ["Email", [0x80, 0x8a, 0x01]],
  ["Calculator", [0x80, 0x92, 0x01]],
  ["Next track", [0x80, 0xb5, 0x00]],
  ["Previous track", [0x80, 0xb6, 0x00]],
  ["Stop", [0x80, 0xb7, 0x00]],
  ["Play or pause", [0x80, 0xcd, 0x00]],
  ["Mute", [0x80, 0xe2, 0x00]],
  ["Volume up", [0x80, 0xe9, 0x00]],
  ["Volume down", [0x80, 0xea, 0x00]],
] as Array<[string, RyunixButtonCode]>);

export function ryunixButtonActionName(code: RyunixButtonCode): string | null {
  for (const [name, value] of RYUNIX_BUTTON_ACTIONS) {
    if (value[0] === code[0] && value[1] === code[1] && value[2] === code[2]) return name;
  }
  return null;
}

/**
 * Button positions in the order the firmware stores them (the vendor app sends
 * its buttons as 0,1,2,6,5,3,4,7,8, which is this order). Names follow the
 * physical layout in Amkette's XS Flow 2 Speed configurator: its buttons 4 and
 * 5 are the two small buttons under the wheel (default "show desktop" and "DPI
 * cycle"), 6 and 7 the thumb pair, 8 and 9 the wheel tilt. Its button 10, the
 * bottom mode switch, is left out so the 2.4 GHz/Bluetooth/USB switch cannot be
 * remapped away.
 */
export const RYUNIX_BUTTON_SLOTS = [
  { id: "Left", name: "Left button", factory: "Left click" },
  { id: "Right", name: "Right button", factory: "Right click" },
  { id: "Middle", name: "Wheel button", factory: "Middle click" },
  { id: "Back", name: "Back button", factory: "Back" },
  { id: "Forward", name: "Forward button", factory: "Forward" },
  { id: "Upper", name: "Upper centre button", factory: "Show desktop" },
  { id: "Dpi", name: "DPI button", factory: "DPI cycle" },
  { id: "TiltLeft", name: "Wheel tilt left", factory: "Tilt left" },
  { id: "TiltRight", name: "Wheel tilt right", factory: "Tilt right" },
] as const;

export const RYUNIX_BUTTON_POSITIONS = 10;

/**
 * What each of the ten positions holds in the vendor app's default layout, in
 * firmware order. Position 9 is the bottom mode switch, which is not offered for
 * remapping but is part of every button write. The vendor app writes all ten
 * from this layout, so a write that has to fill positions it was not asked to
 * change uses these rather than 0xFF, whose meaning on this firmware is unknown.
 */
export const RYUNIX_BUTTON_FACTORY_CODES: readonly RyunixButtonCode[] = [
  [0x10, 0x01, 0x00],
  [0x10, 0x02, 0x00],
  [0x10, 0x04, 0x00],
  [0x10, 0x08, 0x00],
  [0x10, 0x10, 0x00],
  [0x60, 0x08, 0x00],
  [0x40, 0x01, 0x00],
  [0x60, 0x06, 0x00],
  [0x60, 0x07, 0x00],
  [0x60, 0x01, 0x00],
];

/**
 * Button table frames for the ten-position layout the XS Flow configurator
 * uses: positions 0-8 in a first frame (sub 0x02) and position 9 in a second
 * (sub 0x12). `positions[i]` is `null` for 0xFF 0xFF 0xFF, which the vendor app
 * writes for a button it has no assignment for.
 */
export function ryunixSetButtonsFrames(
  sequences: readonly [first: number, second: number],
  positions: ReadonlyArray<RyunixButtonCode | null>,
): [Uint8Array, Uint8Array] {
  const unset: RyunixButtonCode = [0xff, 0xff, 0xff];
  const at = (index: number): RyunixButtonCode => positions[index] ?? unset;
  const first: number[] = [];
  for (let index = 0; index < 9; index++) first.push(...at(index));
  return [
    ryunixFrame(RYUNIX_COMMAND.buttons, sequences[0], 0x02, first),
    ryunixFrame(RYUNIX_COMMAND.buttons, sequences[1], 0x12, [...at(9)]),
  ];
}
