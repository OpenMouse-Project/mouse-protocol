/**
 * SteelSeries Rival 3 Gen 2 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships `rival-3-v2.lisp` under
 * `apps/engine/install/deviceSpecifications/`, and this module transcribes
 * it. Those files are OpenPGP-armored ("DESCRIPTOR" armor, SKESK/AES-128);
 * the bytes below are the documented HID report payloads, not guesses.
 * rivalcfg's mainline `rival3_gen2.py` corroborates the product id, the
 * `0x34` XY-DPI command shape, and most other command bytes — but see the
 * DPI table note below, where the two sources disagree.
 *
 * Despite the shared "Rival 3" name this is a different command set from
 * Rival 3 Gen 1 (`./rival3.ts`: two-byte `0x0B 0x00` DPI, `0x04 0x00`
 * polling, `0x09 0x00` save) and from Aerox 3 (`./aerox3.ts`). Command
 * bytes here are single-byte prefixes with a `write-op`/`read-op` framing
 * convention; on this wired-only mouse both masks are `0x00`, so the bytes
 * go on the wire as written.
 *
 * Every command is an HID **output report** with report id 0x00 (65-byte
 * reports throughout the specification).
 *
 * DPI uses an XY batch (`0x34`): `num_cpi_levels` (1–5), `index` (0–4,
 * 0-based), then a 10-byte interleaved table (x0, y0, x1, y1, …), one
 * sensor byte per axis value. The sensor table is TrueMove Core shaped
 * (200–8500), transcribed here from the vendor file's own
 * `convert_cpi_fw_to_driver` case table — **not** imported from
 * `./rival3.ts`'s `TRUEMOVE_CORE_DPI_TO_BYTE`, because the two disagree on
 * 23 entries: the vendor file says `0x49→3200` where rivalcfg says
 * `0x4A→3200`, and similarly one byte lower at 22 other DPI steps (2300,
 * 2600, 2900, 3500, 3800, …). The vendor table is self-consistent with the
 * vendor's own factory defaults (Aerox 3's default preset bytes
 * 8/18/27/55/73 decode to exactly 400/800/1200/2400/3200 under it, while
 * `0x49` is absent from rivalcfg's table), so this module follows the
 * vendor file and flags the divergence for the shared table to be
 * reconciled separately. Off-grid DPI values are rejected rather than
 * rounded.
 *
 * The specification always carries all five XY pairs, so this codec
 * requires exactly five presets rather than guessing at padding for
 * shorter tables.
 *
 * Polling (`0x2B`, values 1000→0x01, 500→0x02, 250→0x03, 125→0x04) has a
 * read-back (same values), defined but not decoded here. Buttons are one
 * 40-byte packet (8 slots × 5-byte fields: 6 physical buttons plus scroll
 * up/down), command `0x2A`.
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is hardware evidence and a reason to ship them:
 *
 * - The 3-zone RGB commands (`0x21`, per-zone bitmasks), reactive color
 *   (`0x26`), lighting enable (`0x27`), and reset (`0x22`, mask `0x07`).
 * - `read_polling_rate` and the unique-id read.
 * - Angle snapping: driver-side (`SSE`) settings, not HID commands.
 *
 * Settings apply immediately; the save command (`0x11`, one byte) persists
 * them to onboard flash. None of this has been verified on physical
 * hardware by this project.
 */

/** Vendor TrueMove Core table, transcribed from the specification's own conversion table. */
export const RIVAL3_GEN2_DPI_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [200, 0x04], [300, 0x06], [400, 0x08], [500, 0x0b], [600, 0x0d], [700, 0x0f],
  [800, 0x12], [900, 0x14], [1000, 0x16], [1100, 0x19], [1200, 0x1b], [1300, 0x1d],
  [1400, 0x20], [1500, 0x22], [1600, 0x24], [1700, 0x27], [1800, 0x29], [1900, 0x2b],
  [2000, 0x2e], [2100, 0x30], [2200, 0x32], [2300, 0x34], [2400, 0x37], [2500, 0x39],
  [2600, 0x3b], [2700, 0x3e], [2800, 0x40], [2900, 0x42], [3000, 0x45], [3100, 0x47],
  [3200, 0x49], [3300, 0x4c], [3400, 0x4e], [3500, 0x50], [3600, 0x53], [3700, 0x55],
  [3800, 0x57], [3900, 0x5a], [4000, 0x5c], [4100, 0x5e], [4200, 0x61], [4300, 0x63],
  [4400, 0x65], [4500, 0x68], [4600, 0x6a], [4700, 0x6c], [4800, 0x6f], [4900, 0x71],
  [5000, 0x73], [5100, 0x76], [5200, 0x78], [5300, 0x7a], [5400, 0x7d], [5500, 0x7f],
  [5600, 0x81], [5700, 0x84], [5800, 0x86], [5900, 0x88], [6000, 0x8b], [6100, 0x8d],
  [6200, 0x8f], [6300, 0x92], [6400, 0x94], [6500, 0x96], [6600, 0x99], [6700, 0x9b],
  [6800, 0x9d], [6900, 0xa0], [7000, 0xa2], [7100, 0xa4], [7200, 0xa7], [7300, 0xa9],
  [7400, 0xab], [7500, 0xad], [7600, 0xb0], [7700, 0xb2], [7800, 0xb4], [7900, 0xb7],
  [8000, 0xb9], [8100, 0xbc], [8200, 0xbe], [8300, 0xc0], [8400, 0xc3], [8500, 0xc5],
]);

export const RIVAL3_GEN2_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL3_GEN2_COMMAND = {
  dpiPresets: [0x34],
  pollingRate: [0x2b],
  buttonsMapping: [0x2a],
  firmware: [0x90],
} as const;

/** `0x11` — one byte; commit the current settings to onboard flash. */
export const RIVAL3_GEN2_SAVE_COMMAND = [0x11] as const;

export const RIVAL3_GEN2_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const RIVAL3_GEN2_DPI_MIN = 200;
export const RIVAL3_GEN2_DPI_MAX = 8500;
export const RIVAL3_GEN2_DPI_STEP = 100;
export const RIVAL3_GEN2_MAX_DPI_PRESETS = 5;
export const RIVAL3_GEN2_FIRMWARE_RESPONSE_LENGTH = 15;

/** Common factory table shared across the modern SteelSeries families. */
export const RIVAL3_GEN2_DEFAULT_DPI_PRESETS = [400, 800, 1600, 2400, 3200] as const;
export const RIVAL3_GEN2_DEFAULT_POLLING_RATE = 1000;

export class Rival3Gen2ProtocolError extends Error {}

/** One DPI preset: independent X/Y sensitivities. */
export interface Rival3Gen2DpiPreset {
  x: number;
  y: number;
}

/** The 84 DPI values the vendor sensor table can express, ascending. */
export function steelseriesRival3Gen2DpiOptions(): number[] {
  return [...RIVAL3_GEN2_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

function dpiToByte(dpi: number): number {
  const byte = RIVAL3_GEN2_DPI_TO_BYTE.get(dpi);
  if (byte === undefined) {
    throw new Rival3Gen2ProtocolError(
      `SteelSeries Rival 3 Gen 2 DPI must be ${RIVAL3_GEN2_DPI_MIN}–${RIVAL3_GEN2_DPI_MAX.toLocaleString("en-US")} in ${RIVAL3_GEN2_DPI_STEP} DPI steps.`,
    );
  }
  return byte;
}

/**
 * `34 <count 1–5> <selected 0-based> <x0 y0 x1 y1 … x4 y4>` — replaces the
 * mouse's whole preset table with five interleaved XY pairs. Exactly five
 * presets are required (see the module doc comment).
 */
export function steelseriesRival3Gen2EncodeDpiPresets(
  presets: readonly Rival3Gen2DpiPreset[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length !== RIVAL3_GEN2_MAX_DPI_PRESETS) {
    throw new Rival3Gen2ProtocolError(
      `SteelSeries Rival 3 Gen 2 requires exactly ${RIVAL3_GEN2_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Rival3Gen2ProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  return new Uint8Array([
    ...RIVAL3_GEN2_COMMAND.dpiPresets,
    presets.length,
    selectedIndex,
    ...presets.flatMap((preset) => [dpiToByte(preset.x), dpiToByte(preset.y)]),
  ]);
}

/** `2B <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival3Gen2EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival3Gen2ProtocolError("SteelSeries Rival 3 Gen 2 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL3_GEN2_COMMAND.pollingRate, byte]);
}

/** `11` — commit the current settings to onboard flash. */
export function steelseriesRival3Gen2SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL3_GEN2_SAVE_COMMAND);
}

/** `90` — the device answers with a 15-byte version string. */
export function steelseriesRival3Gen2FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL3_GEN2_COMMAND.firmware);
}

/**
 * Decode the 15-byte firmware version reply as ASCII, stopping at the
 * first NUL. Same shape as the Prime Mini's reply; trailing padding is not
 * part of the version.
 */
export function steelseriesRival3Gen2DecodeFirmware(payload: Uint8Array): string {
  if (payload.length < RIVAL3_GEN2_FIRMWARE_RESPONSE_LENGTH) {
    throw new Rival3Gen2ProtocolError("SteelSeries Rival 3 Gen 2 firmware response is shorter than 15 bytes.");
  }
  const bytes = payload.slice(0, RIVAL3_GEN2_FIRMWARE_RESPONSE_LENGTH);
  const nul = bytes.indexOf(0x00);
  return new TextDecoder("ascii").decode(nul === -1 ? bytes : bytes.slice(0, nul));
}

// -- Button mapping --------------------------------------------------------

/** 6 physical buttons plus scroll up/down (8 slots). */
export const RIVAL3_GEN2_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  scrollUp: { id: 0x31, offset: 0x1e },
  scrollDown: { id: 0x32, offset: 0x23 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Rival3Gen2ButtonName = keyof typeof RIVAL3_GEN2_BUTTONS;

const BUTTON_FIELD_LENGTH = 5;
const BUTTON_DISABLE = 0x00;
const BUTTON_DPI_SWITCH = 0x30;
const BUTTON_KEYBOARD = 0x51;
const BUTTON_MULTIMEDIA = 0x61;

export type Rival3Gen2ButtonAction =
  | { type: "button"; target: Rival3Gen2ButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Rival3Gen2ProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `2A` + one 40-byte packet (8 slots × 5-byte fields), zero-filled except
 * where a mapping is given. Pass every button explicitly — unmapped buttons
 * stay disabled, matching this package's no-silent-defaults policy.
 */
export function steelseriesRival3Gen2EncodeButtonsMapping(
  mapping: Partial<Record<Rival3Gen2ButtonName, Rival3Gen2ButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(RIVAL3_GEN2_BUTTONS, name)) {
      throw new Rival3Gen2ProtocolError(`Unknown SteelSeries Rival 3 Gen 2 button "${name}".`);
    }
  }

  const names = Object.keys(RIVAL3_GEN2_BUTTONS) as Rival3Gen2ButtonName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival3Gen2ButtonName, Rival3Gen2ButtonAction]>) {
    const { offset } = RIVAL3_GEN2_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(RIVAL3_GEN2_BUTTONS, action.target)) {
          throw new Rival3Gen2ProtocolError(`Unknown SteelSeries Rival 3 Gen 2 button "${action.target}".`);
        }
        packet[offset] = RIVAL3_GEN2_BUTTONS[action.target].id;
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
        packet[offset] = RIVAL3_GEN2_BUTTONS.scrollUp.id;
        break;
      }
      case "scrollDown": {
        packet[offset] = RIVAL3_GEN2_BUTTONS.scrollDown.id;
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
        throw new Rival3Gen2ProtocolError("Unsupported SteelSeries Rival 3 Gen 2 button action.");
      }
    }
  }

  return new Uint8Array([...RIVAL3_GEN2_COMMAND.buttonsMapping, ...packet]);
}
