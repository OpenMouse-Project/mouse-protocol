/**
 * SteelSeries Rival 5 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations and the vendor's
 * own software, not from vendor source code:
 *
 * - rivalcfg has no Rival 5 profile, so there is no rivalcfg corroboration
 *   for any byte here — unlike every other wired SteelSeries family in this
 *   package, which all trace to rivalcfg first.
 * - The vendor's SteelSeries GG device specification (`rival-5.lisp`,
 *   GG 121.0.0) documents the full command set: DPI batch `0x2D`, polling
 *   `0x2B` (+ read `0xAB`), 11-slot buttons `0x2A`, lighting `0x21`–`0x27`,
 *   save `0x11`, firmware `0x90`. Those files are OpenPGP-armored
 *   ("DESCRIPTOR" armor, SKESK/AES-128); the bytes below are the documented
 *   HID report payloads.
 * - The DPI sensor table is byte-identical to TrueMove Air (spot-checked
 *   against the vendor file's inline case table: `0x00→100`, `0x04→400`,
 *   `0x12→1600`, `0xD6→18000`), so it is imported from
 *   `./rival3-wireless.ts`'s `TRUEMOVE_AIR_DPI_TO_BYTE` rather than
 *   re-derived — the same reuse `./aerox5.ts` makes.
 *
 * Every command is an HID **output report** with report id 0x00 (65-byte
 * reports throughout the specification).
 *
 * DPI uses a 5-preset batch (`0x2D`): `level_max` (1–5), `level_active`
 * (0–4, 0-based — same convention as `./aerox5.ts`'s `first_preset: 0`),
 * then five one-byte sensor values (`0x00–0xD6`). The specification always
 * carries all five slots, so this codec requires exactly five presets
 * rather than guessing at padding for shorter tables.
 *
 * Polling (`0x2B`, values 1000→0x01, 500→0x02, 250→0x03, 125→0x04) has a
 * read-back (`0xAB`), defined but not decoded here. Buttons are one packet
 * (11 slots × 5-byte fields: 9 physical buttons plus scroll up/down),
 * command `0x2A`.
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is hardware evidence and a reason to ship them:
 *
 * - The 10-zone `direct_write` (`0x21` + uint16 LED mask + 10 RGB triples),
 *   `write_all_illumination` (mask `0x3FF`), brightness (`0x23`, 0–100),
 *   reactive color (`0x26`), default lighting (`0x27`), and reset (`0x22`).
 *   The mega-strip zone addressing is not needed for DPI/polling/buttons.
 * - `0xAB` — polling read-back.
 * - Accelerometer/deceleration and angle snapping: driver-side (`SSE`)
 *   settings, not HID commands, out of scope for this codec.
 *
 * Settings apply immediately; the save command (`0x11`, one byte) persists
 * them to onboard flash. None of this has been verified on physical
 * hardware by this project.
 */

import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

export const RIVAL5_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL5_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  buttonsMapping: [0x2a],
} as const;

/** `0xAB` — polling read-back; documented, not decoded here. */
export const RIVAL5_POLLING_QUERY = [0xab] as const;

/** `0x90` — firmware version (32-byte string reply, see below). */
export const RIVAL5_FIRMWARE_QUERY = [0x90] as const;

/** `0x11` — one byte; commit the current settings to onboard flash. */
export const RIVAL5_SAVE_COMMAND = [0x11] as const;

export const RIVAL5_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const RIVAL5_DPI_MIN = 100;
export const RIVAL5_DPI_MAX = 18000;
export const RIVAL5_DPI_STEP = 100;
export const RIVAL5_MAX_DPI_PRESETS = 5;
export const RIVAL5_FIRMWARE_RESPONSE_LENGTH = 32;

/** Factory table from the GG seed data (400/800/1200/2400/3200). */
export const RIVAL5_DEFAULT_DPI_PRESETS = [400, 800, 1200, 2400, 3200] as const;
export const RIVAL5_DEFAULT_POLLING_RATE = 1000;

export class Rival5ProtocolError extends Error {}

/** Every DPI value the shared TrueMove Air table can express, ascending. */
export function steelseriesRival5DpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `2D <count 1–5> <selected 0-based> <5 sensor bytes>` — replaces the
 * mouse's whole preset table. Exactly five presets are required (see the
 * module doc comment); DPI values must be exact TrueMove Air table keys —
 * off-grid values are rejected rather than rounded, matching how the rest
 * of this package validates DPI.
 */
export function steelseriesRival5EncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length !== RIVAL5_MAX_DPI_PRESETS) {
    throw new Rival5ProtocolError(
      `SteelSeries Rival 5 requires exactly ${RIVAL5_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Rival5ProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new Rival5ProtocolError(
        `SteelSeries Rival 5 DPI must be ${RIVAL5_DPI_MIN}–${RIVAL5_DPI_MAX.toLocaleString("en-US")} in ${RIVAL5_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  return new Uint8Array([...RIVAL5_COMMAND.dpiPresets, presets.length, selectedIndex, ...encoded]);
}

/** `2B <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival5EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival5ProtocolError("SteelSeries Rival 5 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL5_COMMAND.pollingRate, byte]);
}

/** `11` — commit the current settings to onboard flash. */
export function steelseriesRival5SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL5_SAVE_COMMAND);
}

/** `90` — the device answers with a 32-byte version string. */
export function steelseriesRival5FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL5_FIRMWARE_QUERY);
}

/**
 * Decode the 32-byte firmware version reply as ASCII, stopping at the
 * first NUL. The string shape follows the specification's `version_str
 * bytearray (size 32)` field; trailing padding is not part of the version.
 */
export function steelseriesRival5DecodeFirmware(payload: Uint8Array): string {
  if (payload.length < RIVAL5_FIRMWARE_RESPONSE_LENGTH) {
    throw new Rival5ProtocolError("SteelSeries Rival 5 firmware response is shorter than 32 bytes.");
  }
  const bytes = payload.slice(0, RIVAL5_FIRMWARE_RESPONSE_LENGTH);
  const nul = bytes.indexOf(0x00);
  return new TextDecoder("ascii").decode(nul === -1 ? bytes : bytes.slice(0, nul));
}

// -- Button mapping --------------------------------------------------------

/** 9 physical buttons plus scroll up/down (11 slots, 55 bytes total). */
export const RIVAL5_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  button7: { id: 0x07, offset: 0x1e },
  button8: { id: 0x08, offset: 0x23 },
  button9: { id: 0x09, offset: 0x28 },
  scrollUp: { id: 0x31, offset: 0x2d },
  scrollDown: { id: 0x32, offset: 0x32 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Rival5ButtonName = keyof typeof RIVAL5_BUTTONS;

const BUTTON_FIELD_LENGTH = 5;
const BUTTON_DISABLE = 0x00;
const BUTTON_DPI_SWITCH = 0x30;
const BUTTON_KEYBOARD = 0x51;
const BUTTON_MULTIMEDIA = 0x61;

export type Rival5ButtonAction =
  | { type: "button"; target: Rival5ButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Rival5ProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `2A` + one 55-byte packet (11 slots × 5-byte fields), zero-filled except
 * where a mapping is given. Pass every button explicitly — unmapped buttons
 * stay disabled, matching this package's no-silent-defaults policy.
 */
export function steelseriesRival5EncodeButtonsMapping(
  mapping: Partial<Record<Rival5ButtonName, Rival5ButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(RIVAL5_BUTTONS, name)) {
      throw new Rival5ProtocolError(`Unknown SteelSeries Rival 5 button "${name}".`);
    }
  }

  const names = Object.keys(RIVAL5_BUTTONS) as Rival5ButtonName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival5ButtonName, Rival5ButtonAction]>) {
    const { offset } = RIVAL5_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(RIVAL5_BUTTONS, action.target)) {
          throw new Rival5ProtocolError(`Unknown SteelSeries Rival 5 button "${action.target}".`);
        }
        packet[offset] = RIVAL5_BUTTONS[action.target].id;
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
        throw new Rival5ProtocolError("Unsupported SteelSeries Rival 5 button action.");
      }
    }
  }

  return new Uint8Array([...RIVAL5_COMMAND.buttonsMapping, ...packet]);
}
