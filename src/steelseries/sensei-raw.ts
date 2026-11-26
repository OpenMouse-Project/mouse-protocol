/**
 * SteelSeries Sensei [RAW] configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships `sensei-raw_base.lisp`
 * under `apps/engine/install/deviceSpecifications/`, and this module
 * transcribes it. That file is OpenPGP-armored ("DESCRIPTOR" armor,
 * SKESK/AES-128); the bytes below are the documented HID report payloads,
 * not guesses. rivalcfg's `sensei_raw.py` (which lists the same product ids)
 * independently corroborates every command byte and supplies the DPI range.
 *
 * This is the original **Sensei [RAW]** command set — a different device
 * family from the Sensei (`./sensei-ten.ts`? no: the plain Sensei), the
 * Sensei [RAW] Optical RGB (`0x1800`, which uses the Rival 310 command set),
 * and the Sensei 310 (`./sensei-310.ts`). The [RAW] has a single white/red
 * LED (brightness + effect only, **no color command**), eight buttons with
 * 3-byte fields, and a linear two-preset DPI.
 *
 * Every command is an HID **output report** with report id 0x00 (33-byte
 * reports — `HIDIO 33`).
 *
 * DPI uses two per-level commands (`03 01`/`03 02`) with a linear byte:
 * rivalcfg's `input_range [90, 5670, 90]` against `output_range [0x01,
 * 0x3F, 1]`, so `byte = (dpi - 90) / 90 + 1`, range 0x01–0x3F
 * (90–5670 DPI in 90 DPI steps). Off-grid values are rejected.
 *
 * Polling (`04 00`) is write-only (1000→0x01, 500→0x02, 250→0x03,
 * 125→0x04). The single LED has a brightness level (`05 01`, off/low/
 * medium/high → 0x01–0x04) and an effect (`07 01`, steady 0x01 / breath
 * 0x03 / trigger 0x05). Buttons are one 24-byte packet (8 slots × 3-byte
 * fields), command `31 00`; the button-6/7 slot order is odd (see
 * `SENSEI_RAW_BUTTONS`).
 *
 * The two readable values are the firmware version (`10 00`, two bytes,
 * `fw_minor` then `fw_major`) and the active preset index (`16 00`).
 * Settings apply immediately; the save command (`09 00`) persists them to
 * onboard flash. None of this has been verified on physical hardware by this
 * project.
 */

export const SENSEI_RAW_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const SENSEI_RAW_COMMAND = {
  sensitivity1: [0x03, 0x01],
  sensitivity2: [0x03, 0x02],
  pollingRate: [0x04, 0x00],
  ledBrightness: [0x05, 0x01],
  ledEffect: [0x07, 0x01],
  buttonsMapping: [0x31, 0x00],
  save: [0x09, 0x00],
  firmware: [0x10, 0x00],
  activeCpiIndex: [0x16, 0x00],
} as const;

/** `09 00` — commit the current settings to onboard flash. */
export const SENSEI_RAW_SAVE_COMMAND = [0x09, 0x00] as const;

export const SENSEI_RAW_FIRMWARE_RESPONSE_LENGTH = 2;
export const SENSEI_RAW_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const SENSEI_RAW_DPI_MIN = 90;
export const SENSEI_RAW_DPI_MAX = 5670;
export const SENSEI_RAW_DPI_STEP = 90;

/** rivalcfg `sensei_raw.py` defaults for the two presets. */
export const SENSEI_RAW_DEFAULT_DPI_PRESET_1 = 1620;
export const SENSEI_RAW_DEFAULT_DPI_PRESET_2 = 3240;
export const SENSEI_RAW_DEFAULT_POLLING_RATE = 1000;

export class SenseiRawProtocolError extends Error {}

/** The 63 DPI values the linear encoding can express, ascending. */
export function steelseriesSenseiRawDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = SENSEI_RAW_DPI_MIN; dpi <= SENSEI_RAW_DPI_MAX; dpi += SENSEI_RAW_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

/** `input_range [90, 5670, 90]` -> `output_range [0x01, 0x3F, 1]`. */
function encodeDpiByte(dpi: number): number {
  if (
    !Number.isInteger(dpi) ||
    dpi < SENSEI_RAW_DPI_MIN ||
    dpi > SENSEI_RAW_DPI_MAX ||
    (dpi - SENSEI_RAW_DPI_MIN) % SENSEI_RAW_DPI_STEP !== 0
  ) {
    throw new SenseiRawProtocolError(
      `SteelSeries Sensei [RAW] DPI must be ${SENSEI_RAW_DPI_MIN}–${SENSEI_RAW_DPI_MAX.toLocaleString("en-US")} in ${SENSEI_RAW_DPI_STEP} DPI steps.`,
    );
  }
  return (dpi - SENSEI_RAW_DPI_MIN) / SENSEI_RAW_DPI_STEP + 1;
}

/** `03 01 <byte>` — sensitivity preset 1. */
export function steelseriesSenseiRawEncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...SENSEI_RAW_COMMAND.sensitivity1, encodeDpiByte(dpi)]);
}

/** `03 02 <byte>` — sensitivity preset 2. */
export function steelseriesSenseiRawEncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...SENSEI_RAW_COMMAND.sensitivity2, encodeDpiByte(dpi)]);
}

/** `04 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesSenseiRawEncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new SenseiRawProtocolError("SteelSeries Sensei [RAW] supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...SENSEI_RAW_COMMAND.pollingRate, byte]);
}

/** `09 00` — commit the current settings to onboard flash. */
export function steelseriesSenseiRawSaveCommand(): Uint8Array {
  return new Uint8Array(SENSEI_RAW_SAVE_COMMAND);
}

/** `10 00` — the device answers with minor then major firmware bytes. */
export function steelseriesSenseiRawFirmwareQuery(): Uint8Array {
  return new Uint8Array(SENSEI_RAW_COMMAND.firmware);
}

/** `16 00` — read the active preset index. */
export function steelseriesSenseiRawActiveCpiQuery(): Uint8Array {
  return new Uint8Array(SENSEI_RAW_COMMAND.activeCpiIndex);
}

export interface SteelSeriesSenseiRawFirmware {
  /** The two raw response bytes, in the order the device sent them (minor, major). */
  bytes: [number, number];
  /** The version the two bytes describe, major first, e.g. "1.3". */
  display: string;
}

/** Decode the two-byte firmware response (`fw_minor`, `fw_major`). */
export function steelseriesSenseiRawDecodeFirmware(payload: Uint8Array): SteelSeriesSenseiRawFirmware {
  if (payload.length < SENSEI_RAW_FIRMWARE_RESPONSE_LENGTH) {
    throw new SenseiRawProtocolError("SteelSeries Sensei [RAW] firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[1]}.${bytes[0]}` };
}

// -- LED -------------------------------------------------------------------

/** `05 01 <level>` — LED brightness; off/low/medium/high. */
export const SENSEI_RAW_BRIGHTNESS_TO_BYTE = {
  off: 0x01,
  low: 0x02,
  medium: 0x03,
  high: 0x04,
} as const;

export type SenseiRawBrightness = keyof typeof SENSEI_RAW_BRIGHTNESS_TO_BYTE;

/** `05 01 <level>` — LED brightness. */
export function steelseriesSenseiRawEncodeLedBrightness(brightness: SenseiRawBrightness): Uint8Array {
  const byte = SENSEI_RAW_BRIGHTNESS_TO_BYTE[brightness];
  if (byte === undefined) {
    throw new SenseiRawProtocolError(
      `SteelSeries Sensei [RAW] brightness must be one of: ${Object.keys(SENSEI_RAW_BRIGHTNESS_TO_BYTE).join(", ")}.`,
    );
  }
  return new Uint8Array([...SENSEI_RAW_COMMAND.ledBrightness, byte]);
}

/** `07 01 <mode>` — LED effect; steady/breath/trigger. */
export const SENSEI_RAW_EFFECT_TO_BYTE = {
  steady: 0x01,
  breath: 0x03,
  trigger: 0x05,
} as const;

export type SenseiRawEffect = keyof typeof SENSEI_RAW_EFFECT_TO_BYTE;

/** `07 01 <mode>` — LED effect. */
export function steelseriesSenseiRawEncodeLedEffect(effect: SenseiRawEffect): Uint8Array {
  const byte = SENSEI_RAW_EFFECT_TO_BYTE[effect];
  if (byte === undefined) {
    throw new SenseiRawProtocolError(
      `SteelSeries Sensei [RAW] effect must be one of: ${Object.keys(SENSEI_RAW_EFFECT_TO_BYTE).join(", ")}.`,
    );
  }
  return new Uint8Array([...SENSEI_RAW_COMMAND.ledEffect, byte]);
}

// -- Button mapping --------------------------------------------------------

/**
 * 8 button slots with 3-byte fields. The offset order is rivalcfg's exact
 * `buttons` table, where the physical buttons 6 and 7 are assigned in swap
 * order (`button7` at 0x0F, `button6` at 0x12); the ids are sequential, so
 * this codec keeps the rivalcfg offsets verbatim rather than "correcting"
 * them.
 */
export const SENSEI_RAW_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x03 },
  button3: { id: 0x03, offset: 0x06 },
  button4: { id: 0x04, offset: 0x09 },
  button5: { id: 0x05, offset: 0x0c },
  button7: { id: 0x07, offset: 0x0f },
  button6: { id: 0x06, offset: 0x12 },
  button8: { id: 0x08, offset: 0x15 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type SenseiRawButtonName = keyof typeof SENSEI_RAW_BUTTONS;

const SENSEI_RAW_BUTTON_FIELD_LENGTH = 3;
const SENSEI_RAW_BUTTON_DISABLE = 0x00;
const SENSEI_RAW_BUTTON_DPI_SWITCH = 0x30;
const SENSEI_RAW_BUTTON_KEYBOARD = 0x10;
const SENSEI_RAW_BUTTON_MULTIMEDIA = 0x11;

export type SenseiRawButtonAction =
  | { type: "button"; target: SenseiRawButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new SenseiRawProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `31 00` + one 24-byte packet (8 slots × 3-byte fields), zero-filled
 * except where a mapping is given. Pass every button explicitly — unmapped
 * buttons stay disabled, matching this package's no-silent-defaults policy.
 */
export function steelseriesSenseiRawEncodeButtonsMapping(
  mapping: Partial<Record<SenseiRawButtonName, SenseiRawButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(SENSEI_RAW_BUTTONS, name)) {
      throw new SenseiRawProtocolError(`Unknown SteelSeries Sensei [RAW] button "${name}".`);
    }
  }

  const names = Object.keys(SENSEI_RAW_BUTTONS) as SenseiRawButtonName[];
  const packet = new Array<number>(names.length * SENSEI_RAW_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[SenseiRawButtonName, SenseiRawButtonAction]>) {
    const { offset } = SENSEI_RAW_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(SENSEI_RAW_BUTTONS, action.target)) {
          throw new SenseiRawProtocolError(`Unknown SteelSeries Sensei [RAW] button "${action.target}".`);
        }
        packet[offset] = SENSEI_RAW_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = SENSEI_RAW_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = SENSEI_RAW_BUTTON_DPI_SWITCH;
        break;
      }
      case "keyboard": {
        packet[offset] = SENSEI_RAW_BUTTON_KEYBOARD;
        packet[offset + 1] = encodeKeyCode(action.code, "Keyboard scan");
        break;
      }
      case "multimedia": {
        packet[offset] = SENSEI_RAW_BUTTON_MULTIMEDIA;
        packet[offset + 1] = encodeKeyCode(action.code, "Multimedia key");
        break;
      }
      default: {
        throw new SenseiRawProtocolError("Unsupported SteelSeries Sensei [RAW] button action.");
      }
    }
  }

  return new Uint8Array([...SENSEI_RAW_COMMAND.buttonsMapping, ...packet]);
}
