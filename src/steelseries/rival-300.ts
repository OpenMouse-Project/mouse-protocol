/**
 * SteelSeries Rival 300 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships `rival_base.lisp` (the
 * shared profile) plus `rival_300.lisp`, `dota2-rival-mouse.lisp`,
 * `predator-mouse.lisp`, `csgo-rival-300.lisp`, `csgo-rival-300-stm32.lisp`,
 * `fallout_4_rival_300.lisp`, `hp_omen_rival_300.lisp`,
 * `csgo-hyperbeast-rival-300.lisp` and `eg-rival-300.lisp`, all of which
 * `include "rival_base"`. This module transcribes that command set. Those
 * files are OpenPGP-armored ("DESCRIPTOR" armor, SKESK/AES-128). rivalcfg's
 * `rival300.py` (which lists the same product ids) independently
 * corroborates every command byte.
 *
 * This is the original Rival / Rival 300 command set, distinct from Rival
 * 100 (`./rival-100.ts`) and Rival 110 (`./rival-110.ts`): the DPI byte is a
 * linear range (not a choice table), the two LED zones have independent
 * color and effect commands, and the six buttons are remappable.
 *
 * Every command is an HID **output report** with report id 0x00 (33-byte
 * reports — `HIDIO 33`).
 *
 * DPI uses two per-level commands (`03 01`/`03 02`) with a linear byte:
 * rivalcfg's `input_range [50, 6500, 50]` against `output_range [0x01,
 * 0x82, 1]`, so `byte = (dpi - 50) / 50 + 1`, range 0x01–0x82
 * (50–6500 DPI in 50 DPI steps). The vendor struct carries a trailing
 * `dcpi` byte (`0x00` or `0xAA`) that rivalcfg leaves at 0; this codec
 * matches rivalcfg and does not emit it. Off-grid values are rejected.
 *
 * Polling (`04 00`) is write-only (1000→0x01, 500→0x02, 250→0x03,
 * 125→0x04). Lighting is two zones — logo (`08 01`) and wheel (`08 02`) —
 * each with its own color and effect (`07 01`/`07 02`, steady 0x01 / breath
 * 0x03). Buttons are one 30-byte packet (6 slots × 5-byte fields),
 * command `31 00`, as an output report.
 *
 * The two readable values are the firmware version (`10 00`, two bytes,
 * `fw_minor` then `fw_major`) and the active preset index (`16 00`).
 * Settings apply immediately; the save command (`09 00`) persists them to
 * onboard flash. None of this has been verified on physical hardware by this
 * project.
 */

export const RIVAL300_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL300_COMMAND = {
  sensitivity1: [0x03, 0x01],
  sensitivity2: [0x03, 0x02],
  pollingRate: [0x04, 0x00],
  logoColor: [0x08, 0x01],
  wheelColor: [0x08, 0x02],
  logoEffect: [0x07, 0x01],
  wheelEffect: [0x07, 0x02],
  buttonsMapping: [0x31, 0x00],
  save: [0x09, 0x00],
  firmware: [0x10, 0x00],
  activeCpiIndex: [0x16, 0x00],
} as const;

/** `09 00` — commit the current settings to onboard flash. */
export const RIVAL300_SAVE_COMMAND = [0x09, 0x00] as const;

export const RIVAL300_FIRMWARE_RESPONSE_LENGTH = 2;
export const RIVAL300_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const RIVAL300_DPI_MIN = 50;
export const RIVAL300_DPI_MAX = 6500;
export const RIVAL300_DPI_STEP = 50;

/** rivalcfg `rival300.py` defaults for the two presets. */
export const RIVAL300_DEFAULT_DPI_PRESET_1 = 800;
export const RIVAL300_DEFAULT_DPI_PRESET_2 = 1600;
export const RIVAL300_DEFAULT_POLLING_RATE = 1000;

export class Rival300ProtocolError extends Error {}

/** The 130 DPI values the linear encoding can express, ascending. */
export function steelseriesRival300DpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = RIVAL300_DPI_MIN; dpi <= RIVAL300_DPI_MAX; dpi += RIVAL300_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

/**
 * `input_range [50, 6500, 50]` -> `output_range [0x01, 0x82, 1]`:
 * `byte = (dpi - 50) / 50 + 1`. Off-grid values are rejected.
 */
function encodeDpiByte(dpi: number): number {
  if (
    !Number.isInteger(dpi) ||
    dpi < RIVAL300_DPI_MIN ||
    dpi > RIVAL300_DPI_MAX ||
    (dpi - RIVAL300_DPI_MIN) % RIVAL300_DPI_STEP !== 0
  ) {
    throw new Rival300ProtocolError(
      `SteelSeries Rival 300 DPI must be ${RIVAL300_DPI_MIN}–${RIVAL300_DPI_MAX.toLocaleString("en-US")} in ${RIVAL300_DPI_STEP} DPI steps.`,
    );
  }
  return (dpi - RIVAL300_DPI_MIN) / RIVAL300_DPI_STEP + 1;
}

/** `03 01 <byte>` — sensitivity preset 1. */
export function steelseriesRival300EncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL300_COMMAND.sensitivity1, encodeDpiByte(dpi)]);
}

/** `03 02 <byte>` — sensitivity preset 2. */
export function steelseriesRival300EncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL300_COMMAND.sensitivity2, encodeDpiByte(dpi)]);
}

/** `04 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival300EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival300ProtocolError("SteelSeries Rival 300 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL300_COMMAND.pollingRate, byte]);
}

/** `09 00` — commit the current settings to onboard flash. */
export function steelseriesRival300SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL300_SAVE_COMMAND);
}

/** `10 00` — the device answers with minor then major firmware bytes. */
export function steelseriesRival300FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL300_COMMAND.firmware);
}

/** `16 00` — read the active preset index. */
export function steelseriesRival300ActiveCpiQuery(): Uint8Array {
  return new Uint8Array(RIVAL300_COMMAND.activeCpiIndex);
}

/**
 * Decode the active-preset reply. The specification's `resolution_level`
 * incoming struct is `report_id` then `level`, and the reply's report id is
 * not surfaced by WebHID, so the level is the first byte. The device reports
 * it 1-based (values 0x01/0x02); anything else is rejected rather than
 * guessed at.
 */
export function steelseriesRival300DecodeActivePreset(payload: Uint8Array): 1 | 2 {
  const level = payload[0];
  if (level !== 0x01 && level !== 0x02) {
    throw new Rival300ProtocolError(
      `SteelSeries Rival 300 active preset reply was not 1 or 2 (got ${level === undefined ? "nothing" : `0x${level.toString(16)}`}).`,
    );
  }
  return level;
}

export interface SteelSeriesRival300Firmware {
  /** The two raw response bytes, in the order the device sent them (minor, major). */
  bytes: [number, number];
  /** The version the two bytes describe, major first, e.g. "1.3". */
  display: string;
}

/** Decode the two-byte firmware response (`fw_minor`, `fw_major`). */
export function steelseriesRival300DecodeFirmware(payload: Uint8Array): SteelSeriesRival300Firmware {
  if (payload.length < RIVAL300_FIRMWARE_RESPONSE_LENGTH) {
    throw new Rival300ProtocolError("SteelSeries Rival 300 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[1]}.${bytes[0]}` };
}

// -- LED -------------------------------------------------------------------

/** The two independently controlled LED zones. */
export type Rival300Led = "logo" | "wheel";

const LED_COLOR_COMMAND: Record<Rival300Led, readonly number[]> = {
  logo: RIVAL300_COMMAND.logoColor,
  wheel: RIVAL300_COMMAND.wheelColor,
};

const LED_EFFECT_COMMAND: Record<Rival300Led, readonly number[]> = {
  logo: RIVAL300_COMMAND.logoEffect,
  wheel: RIVAL300_COMMAND.wheelEffect,
};

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Rival300ProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

/** `08 <zone> <r> <g> <b>` — one LED zone's color (`logo` = 0x01, `wheel` = 0x02). */
export function steelseriesRival300EncodeLedColor(led: Rival300Led, r: number, g: number, b: number): Uint8Array {
  const command = LED_COLOR_COMMAND[led];
  if (!command) {
    throw new Rival300ProtocolError('SteelSeries Rival 300 LEDs are "logo" and "wheel" only.');
  }
  return new Uint8Array([...command, ...encodeRgb(r, g, b)]);
}

export const RIVAL300_LIGHT_EFFECT_TO_BYTE = {
  steady: 0x01,
  breath: 0x03,
} as const;

export type Rival300LightEffect = keyof typeof RIVAL300_LIGHT_EFFECT_TO_BYTE;

/** `07 <zone> <mode>` — one LED zone's effect (steady/breath). */
export function steelseriesRival300EncodeLedEffect(led: Rival300Led, effect: Rival300LightEffect): Uint8Array {
  const command = LED_EFFECT_COMMAND[led];
  if (!command) {
    throw new Rival300ProtocolError('SteelSeries Rival 300 LEDs are "logo" and "wheel" only.');
  }
  const byte = RIVAL300_LIGHT_EFFECT_TO_BYTE[effect];
  if (byte === undefined) {
    throw new Rival300ProtocolError(
      `SteelSeries Rival 300 light effect must be one of: ${Object.keys(RIVAL300_LIGHT_EFFECT_TO_BYTE).join(", ")}.`,
    );
  }
  return new Uint8Array([...command, byte]);
}

// -- Button mapping --------------------------------------------------------

/** 6 button slots, 5-byte fields. */
export const RIVAL300_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Rival300ButtonName = keyof typeof RIVAL300_BUTTONS;

const RIVAL300_BUTTON_FIELD_LENGTH = 5;
const RIVAL300_BUTTON_DISABLE = 0x00;
const RIVAL300_BUTTON_DPI_SWITCH = 0x30;
const RIVAL300_BUTTON_SCROLL_UP = 0x31;
const RIVAL300_BUTTON_SCROLL_DOWN = 0x32;
const RIVAL300_BUTTON_KEYBOARD = 0x51;
const RIVAL300_BUTTON_MULTIMEDIA = 0x61;

export type Rival300ButtonAction =
  | { type: "button"; target: Rival300ButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Rival300ProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `31 00` + one 30-byte packet (6 slots × 5-byte fields), zero-filled
 * except where a mapping is given. Pass every button explicitly — unmapped
 * buttons stay disabled, matching this package's no-silent-defaults policy.
 */
export function steelseriesRival300EncodeButtonsMapping(
  mapping: Partial<Record<Rival300ButtonName, Rival300ButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(RIVAL300_BUTTONS, name)) {
      throw new Rival300ProtocolError(`Unknown SteelSeries Rival 300 button "${name}".`);
    }
  }

  const names = Object.keys(RIVAL300_BUTTONS) as Rival300ButtonName[];
  const packet = new Array<number>(names.length * RIVAL300_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival300ButtonName, Rival300ButtonAction]>) {
    const { offset } = RIVAL300_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(RIVAL300_BUTTONS, action.target)) {
          throw new Rival300ProtocolError(`Unknown SteelSeries Rival 300 button "${action.target}".`);
        }
        packet[offset] = RIVAL300_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = RIVAL300_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = RIVAL300_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = RIVAL300_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = RIVAL300_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        packet[offset] = RIVAL300_BUTTON_KEYBOARD;
        packet[offset + 1] = encodeKeyCode(action.code, "Keyboard scan");
        break;
      }
      case "multimedia": {
        packet[offset] = RIVAL300_BUTTON_MULTIMEDIA;
        packet[offset + 1] = encodeKeyCode(action.code, "Multimedia key");
        break;
      }
      default: {
        throw new Rival300ProtocolError("Unsupported SteelSeries Rival 300 button action.");
      }
    }
  }

  return new Uint8Array([...RIVAL300_COMMAND.buttonsMapping, ...packet]);
}
