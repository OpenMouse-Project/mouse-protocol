/**
 * SteelSeries Rival 3 Wireless Gen 2 configuration protocol — pure
 * encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships
 * `rival-3-wireless-v2.lisp` under
 * `apps/engine/install/deviceSpecifications/`, and this module transcribes
 * it. Those files are OpenPGP-armored ("DESCRIPTOR" armor, SKESK/AES-128);
 * the bytes below are the documented HID report payloads, not guesses.
 * rivalcfg lists a `rival3_wireless_gen2` profile (PID `1038:1872`) but its
 * command set was never readable in this environment, so nothing here is
 * corroborated beyond the vendor file — treat every byte as
 * vendor-documented but not yet hardware-verified.
 *
 * Despite the shared "Rival 3 Wireless" name this is a different command
 * set from Rival 3 Wireless Gen 1 (`./rival3-wireless.ts`: single-byte DPI
 * `0x20`, 6 button slots, single lighting zone, `0xAA` 3-byte battery
 * shape). The Gen 2 uses XY DPI (`0x2C`), 7 button slots plus a separate
 * 2-slot wheel mapping, no lighting at all, and a 2-byte battery reply.
 *
 * Every command is an HID **output report** with report id 0x00 (65-byte
 * reports throughout the specification). The specification frames commands
 * through `write-op`/`read-op` mask helpers; on this 2.4 GHz-mode product
 * id both masks are `0x00`, so the bytes go on the wire as written.
 *
 * DPI uses an XY batch (`0x2C`): `max_level` (0x01–0x05), `index`
 * (0x01–0x05, **1-based** — unlike every other SteelSeries XY family in
 * this package, which are 0-based), then five horizontal bytes followed by
 * five vertical bytes (split arrays, not interleaved). The sensor table is
 * TrueMove Air (100–18000), imported from `./rival3-wireless.ts`'s
 * `TRUEMOVE_AIR_DPI_TO_BYTE` — the vendor file includes the same table
 * (spot-checked `0x04→400`, `0x12→1600`, `0xD6→18000`). The specification
 * always carries all five pairs per axis, so this codec requires exactly
 * five presets rather than guessing at padding for shorter tables.
 *
 * Polling (`0x17`, values 1000→0x00, 500→0x01, 250→0x02, 125→0x03 — the
 * same mapping as Gen 1's identical command byte, confirmed by direct
 * comparison, not assumed) has a read-back, defined but not decoded here.
 * Buttons are one 35-byte packet (7 slots × 5-byte fields: function byte
 * plus 4 key-code bytes), command `0x19`, plus a separate 2-slot wheel
 * mapping, command `0x1A`. The 7th button slot has no confirmed physical
 * identity (the GG seed data exposes 6 buttons); it is encodable as
 * `button7` and zero-filled when unmapped, both flagged here.
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is hardware evidence and a reason to ship them:
 *
 * - `read_polling_rate` — polling read-back.
 * - `power_mode` (`0x2B`, sleep timer only) and `wireless_power_mode`
 *   (`0x2E`, no-redundancy / boosted-bluetooth flags).
 * - Accelerometer/deceleration and angle snapping: driver-side (`SSE`)
 *   settings, not HID commands, out of scope for this codec.
 *
 * This mouse has no lighting commands at all. Settings apply immediately;
 * the save command (`0x09`, one byte) persists them to onboard flash. None
 * of this has been verified on physical hardware by this project.
 */

import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

export const RIVAL3_WIRELESS_V2_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL3_WIRELESS_V2_COMMAND = {
  dpiPresets: [0x2c],
  pollingRate: [0x17],
  buttonsMapping: [0x19],
  wheelMapping: [0x1a],
  batteryLevel: [0xaa, 0x01],
  firmware: [0x10],
} as const;

/** `0x09` — one byte; commit the current settings to onboard flash. */
export const RIVAL3_WIRELESS_V2_SAVE_COMMAND = [0x09] as const;

export const RIVAL3_WIRELESS_V2_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x00],
  [500, 0x01],
  [250, 0x02],
  [125, 0x03],
]);

export const RIVAL3_WIRELESS_V2_DPI_MIN = 100;
export const RIVAL3_WIRELESS_V2_DPI_MAX = 18000;
export const RIVAL3_WIRELESS_V2_DPI_STEP = 100;
export const RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS = 5;
export const RIVAL3_WIRELESS_V2_BATTERY_RESPONSE_LENGTH = 2;

/** Factory table shared across the modern SteelSeries families. */
export const RIVAL3_WIRELESS_V2_DEFAULT_DPI_PRESETS = [400, 800, 1600, 2400, 3200] as const;
export const RIVAL3_WIRELESS_V2_DEFAULT_POLLING_RATE = 1000;

export class Rival3WirelessV2ProtocolError extends Error {}

/** One DPI preset: independent X/Y sensitivities. */
export interface Rival3WirelessV2DpiPreset {
  x: number;
  y: number;
}

/** Every DPI value the shared TrueMove Air table can express, ascending. */
export function steelseriesRival3WirelessV2DpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

function dpiToByte(dpi: number): number {
  const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
  if (byte === undefined) {
    throw new Rival3WirelessV2ProtocolError(
      `SteelSeries Rival 3 Wireless Gen 2 DPI must be ${RIVAL3_WIRELESS_V2_DPI_MIN}–${RIVAL3_WIRELESS_V2_DPI_MAX.toLocaleString("en-US")} in ${RIVAL3_WIRELESS_V2_DPI_STEP} DPI steps.`,
    );
  }
  return byte;
}

/**
 * `2C <count 1–5> <selected 1-based> <x0…x4> <y0…y4>` — replaces the
 * mouse's whole preset table with five horizontal bytes followed by five
 * vertical bytes. Exactly five presets are required (see the module doc
 * comment); `selectedIndex` is 0-based here and encoded 1-based on the
 * wire — the reverse of the Gen 1 convention, so do not reuse that
 * encoder.
 */
export function steelseriesRival3WirelessV2EncodeDpiPresets(
  presets: readonly Rival3WirelessV2DpiPreset[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length !== RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS) {
    throw new Rival3WirelessV2ProtocolError(
      `SteelSeries Rival 3 Wireless Gen 2 requires exactly ${RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Rival3WirelessV2ProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  return new Uint8Array([
    ...RIVAL3_WIRELESS_V2_COMMAND.dpiPresets,
    presets.length,
    selectedIndex + 1,
    ...presets.map((preset) => dpiToByte(preset.x)),
    ...presets.map((preset) => dpiToByte(preset.y)),
  ]);
}

/** `17 <v>` with 1000→0x00, 500→0x01, 250→0x02, 125→0x03. */
export function steelseriesRival3WirelessV2EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival3WirelessV2ProtocolError("SteelSeries Rival 3 Wireless Gen 2 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL3_WIRELESS_V2_COMMAND.pollingRate, byte]);
}

/** `09` — commit the current settings to onboard flash. */
export function steelseriesRival3WirelessV2SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL3_WIRELESS_V2_SAVE_COMMAND);
}

/** `AA 01` — answered by a two-byte input report. */
export function steelseriesRival3WirelessV2BatteryQuery(): Uint8Array {
  return new Uint8Array(RIVAL3_WIRELESS_V2_COMMAND.batteryLevel);
}

export interface Rival3WirelessV2Battery {
  /** Battery level as reported (0–100 scale per the specification's GG mapping). */
  level: number;
}

/**
 * Decode the two-byte battery reply as a little-endian level. Unlike Gen
 * 1's 3-byte reply this packet carries no charging flag, so charging state
 * stays unknown — do not infer it.
 */
export function steelseriesRival3WirelessV2DecodeBattery(payload: Uint8Array): Rival3WirelessV2Battery {
  if (payload.length < RIVAL3_WIRELESS_V2_BATTERY_RESPONSE_LENGTH) {
    throw new Rival3WirelessV2ProtocolError(
      "SteelSeries Rival 3 Wireless Gen 2 battery response is shorter than two bytes.",
    );
  }
  return { level: payload[0]! | (payload[1]! << 8) };
}

/** `10` — the mouse answers with major/minor firmware bytes. */
export function steelseriesRival3WirelessV2FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL3_WIRELESS_V2_COMMAND.firmware);
}

export interface Rival3WirelessV2Firmware {
  /** The two raw response bytes, in the order the device sent them. */
  bytes: [number, number];
  /** The bytes joined in read order, e.g. "1.5". */
  display: string;
}

/** Decode the two-byte firmware reply, read-order convention as usual. */
export function steelseriesRival3WirelessV2DecodeFirmware(payload: Uint8Array): Rival3WirelessV2Firmware {
  if (payload.length < 2) {
    throw new Rival3WirelessV2ProtocolError("SteelSeries Rival 3 Wireless Gen 2 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[0]}.${bytes[1]}` };
}

// -- Button mapping --------------------------------------------------------

/**
 * 7 button slots. The 7th slot's physical identity is unconfirmed (the GG
 * seed exposes 6 buttons); it is encodable and zero-filled when unmapped —
 * see the module doc comment.
 */
export const RIVAL3_WIRELESS_V2_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  button7: { id: 0x07, offset: 0x1e },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Rival3WirelessV2ButtonName = keyof typeof RIVAL3_WIRELESS_V2_BUTTONS;

/** The 2 scroll-wheel slots use the same field shape under command `0x1A`. */
export const RIVAL3_WIRELESS_V2_WHEEL_BUTTONS = {
  scrollUp: { id: 0x31, offset: 0x00 },
  scrollDown: { id: 0x32, offset: 0x05 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Rival3WirelessV2WheelName = keyof typeof RIVAL3_WIRELESS_V2_WHEEL_BUTTONS;

const BUTTON_FIELD_LENGTH = 5;
const BUTTON_DISABLE = 0x00;
const BUTTON_DPI_SWITCH = 0x30;
const BUTTON_KEYBOARD = 0x51;
const BUTTON_MULTIMEDIA = 0x61;

export type Rival3WirelessV2ButtonAction =
  | { type: "button"; target: Rival3WirelessV2ButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

export type Rival3WirelessV2WheelAction =
  | { type: "button"; target: Rival3WirelessV2ButtonName | Rival3WirelessV2WheelName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Rival3WirelessV2ProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

function encodeAction(
  packet: number[],
  offset: number,
  action: Rival3WirelessV2ButtonAction | Rival3WirelessV2WheelAction,
): void {
  switch (action.type) {
    case "button": {
      const target =
        (RIVAL3_WIRELESS_V2_BUTTONS as Record<string, { id: number }>)[action.target] ??
        (RIVAL3_WIRELESS_V2_WHEEL_BUTTONS as Record<string, { id: number }>)[action.target];
      if (!target) {
        throw new Rival3WirelessV2ProtocolError(`Unknown SteelSeries Rival 3 Wireless Gen 2 button "${action.target}".`);
      }
      packet[offset] = target.id;
      break;
    }
    case "disabled": {
      packet[offset] = BUTTON_DISABLE;
      break;
    }
    case "dpiSwitch": {
      packet[offset] = BUTTON_DPI_SWITCH;
      break;
    }
    case "scrollUp": {
      packet[offset] = RIVAL3_WIRELESS_V2_WHEEL_BUTTONS.scrollUp.id;
      break;
    }
    case "scrollDown": {
      packet[offset] = RIVAL3_WIRELESS_V2_WHEEL_BUTTONS.scrollDown.id;
      break;
    }
    case "keyboard": {
      packet[offset] = BUTTON_KEYBOARD;
      packet[offset + 1] = encodeKeyCode(action.code, "Keyboard scan");
      break;
    }
    case "multimedia": {
      packet[offset] = BUTTON_MULTIMEDIA;
      packet[offset + 1] = encodeKeyCode(action.code, "Multimedia key");
      break;
    }
    default: {
      throw new Rival3WirelessV2ProtocolError("Unsupported SteelSeries Rival 3 Wireless Gen 2 button action.");
    }
  }
}

/**
 * `19` + one 35-byte packet (7 slots × 5-byte fields), zero-filled except
 * where a mapping is given. Pass every button explicitly — unmapped buttons
 * stay disabled, matching this package's no-silent-defaults policy.
 */
export function steelseriesRival3WirelessV2EncodeButtonsMapping(
  mapping: Partial<Record<Rival3WirelessV2ButtonName, Rival3WirelessV2ButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(RIVAL3_WIRELESS_V2_BUTTONS, name)) {
      throw new Rival3WirelessV2ProtocolError(`Unknown SteelSeries Rival 3 Wireless Gen 2 button "${name}".`);
    }
  }

  const names = Object.keys(RIVAL3_WIRELESS_V2_BUTTONS) as Rival3WirelessV2ButtonName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival3WirelessV2ButtonName, Rival3WirelessV2ButtonAction]>) {
    encodeAction(packet, RIVAL3_WIRELESS_V2_BUTTONS[name].offset, action);
  }

  return new Uint8Array([...RIVAL3_WIRELESS_V2_COMMAND.buttonsMapping, ...packet]);
}

/**
 * `1A` + one 10-byte packet (2 wheel slots × 5-byte fields). The wheel
 * mapping is always written to flash alongside buttons on the real device.
 */
export function steelseriesRival3WirelessV2EncodeWheelMapping(
  mapping: Partial<Record<Rival3WirelessV2WheelName, Rival3WirelessV2WheelAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(RIVAL3_WIRELESS_V2_WHEEL_BUTTONS, name)) {
      throw new Rival3WirelessV2ProtocolError(`Unknown SteelSeries Rival 3 Wireless Gen 2 wheel "${name}".`);
    }
  }

  const names = Object.keys(RIVAL3_WIRELESS_V2_WHEEL_BUTTONS) as Rival3WirelessV2WheelName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival3WirelessV2WheelName, Rival3WirelessV2WheelAction]>) {
    encodeAction(packet, RIVAL3_WIRELESS_V2_WHEEL_BUTTONS[name].offset, action);
  }

  return new Uint8Array([...RIVAL3_WIRELESS_V2_COMMAND.wheelMapping, ...packet]);
}
