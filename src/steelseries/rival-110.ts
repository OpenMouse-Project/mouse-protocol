/**
 * SteelSeries Rival 110 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships `rival-110.lisp`,
 * `rival-106.lisp` and `rival-300s.lisp`, each of which `include "rival-100"`
 * (so the command bytes are Rival 100's) and override only the firmware
 * struct. This module transcribes that command set. Those vendor files are
 * OpenPGP-armored ("DESCRIPTOR" armor, SKESK/AES-128). rivalcfg groups these
 * three product ids under `rival110.py` (with `rival300s.py` reusing it) and
 * independently corroborates every command byte.
 *
 * ## Why this is a separate family from `./rival-100.ts`
 *
 * The Rival 110/106/300S share the Rival 100's command bytes but use the
 * **PixArt PMW3326** sensor, not the Rival 100's eight-step sensor. The
 * vendor files state the DPI byte but no table, so rivalcfg's
 * `dpi/pmw3326.py` supplies it (200–7200 in 100 DPI steps, the "linear-like"
 * sensor curve — notably `0x49`→3200, matching the vendor TrueMove Core
 * table in `./rival-3-v2.ts`). Off-table values are rejected. The Rival 100
 * module's eight-value choice table does not apply here and vice versa,
 * which is exactly why these are two modules.
 *
 * ## Protocol
 *
 * Every command is an HID **output report** with report id 0x00. The vendor
 * file says 33-byte reports (`HIDIO 33`); rivalcfg sets a 32-byte
 * `packet_length` for these models. That padding difference is a transport
 * detail (the driver sends the command bytes), noted here rather than
 * encoded.
 *
 * DPI uses two per-level commands (`03 01`/`03 02`). Polling (`04 00`) is
 * write-only (1000→0x01, 500→0x02, 250→0x03, 125→0x04). Lighting is a single
 * zone: color (`05 00` + RGB) and effect (`07 00` + steady/breath), with the
 * color-sequencing template leaving the brightness byte zero. Button 6 (the
 * CPI button under the wheel) has a mode toggle (`0B`): hardware DPI switch
 * or an OS-bound button. There is **no button remapping** on this family.
 *
 * The two readable values are the firmware version (`10 00`, two bytes,
 * `fw_minor` then `fw_major`) and the active preset index (`16 00`).
 *
 * Settings apply immediately; the save command (`09 00`) persists them to
 * onboard flash. None of this has been verified on physical hardware by this
 * project.
 */

export const RIVAL110_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL110_COMMAND = {
  sensitivity1: [0x03, 0x01],
  sensitivity2: [0x03, 0x02],
  pollingRate: [0x04, 0x00],
  ledColor: [0x05, 0x00],
  ledPulsation: [0x07, 0x00],
  button6Mode: [0x0b],
  save: [0x09, 0x00],
  firmware: [0x10, 0x00],
  activeCpiIndex: [0x16, 0x00],
} as const;

/** `09 00` — commit the current settings to onboard flash. */
export const RIVAL110_SAVE_COMMAND = [0x09, 0x00] as const;

export const RIVAL110_FIRMWARE_RESPONSE_LENGTH = 2;

export const RIVAL110_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

/**
 * The PixArt PMW3326 DPI curve, from rivalcfg's `dpi/pmw3326.py` (the vendor
 * files give no table). 200–7200 in 100 DPI steps.
 */
export const RIVAL110_DPI_TO_BYTE: ReadonlyMap<number, number> = new Map([
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
  [6800, 0x9d], [6900, 0xa0], [7000, 0xa2], [7100, 0xa4], [7200, 0xa7],
]);

/** rivalcfg `rival110.py` defaults for the two presets. */
export const RIVAL110_DEFAULT_DPI_PRESET_1 = 800;
export const RIVAL110_DEFAULT_DPI_PRESET_2 = 1600;
export const RIVAL110_DEFAULT_POLLING_RATE = 1000;

export class Rival110ProtocolError extends Error {}

/** The PMW3326 DPI curve supports 200–7200 in 100 DPI steps. */
export const RIVAL110_DPI_MIN = 200;
export const RIVAL110_DPI_MAX = 7200;

/** The 72 supported DPI values, ascending. */
export function steelseriesRival110DpiOptions(): number[] {
  return [...RIVAL110_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

function encodeDpiByte(dpi: number): number {
  const byte = RIVAL110_DPI_TO_BYTE.get(dpi);
  if (byte === undefined) {
    throw new Rival110ProtocolError(
      `SteelSeries Rival 110 DPI must be ${RIVAL110_DPI_MIN}–${RIVAL110_DPI_MAX.toLocaleString("en-US")} in 100 DPI steps.`,
    );
  }
  return byte;
}

/** `03 01 <byte>` — sensitivity preset 1. */
export function steelseriesRival110EncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL110_COMMAND.sensitivity1, encodeDpiByte(dpi)]);
}

/** `03 02 <byte>` — sensitivity preset 2. */
export function steelseriesRival110EncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL110_COMMAND.sensitivity2, encodeDpiByte(dpi)]);
}

/** `04 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival110EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival110ProtocolError("SteelSeries Rival 110 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL110_COMMAND.pollingRate, byte]);
}

/** `09 00` — commit the current settings to onboard flash. */
export function steelseriesRival110SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL110_SAVE_COMMAND);
}

/** `10 00` — the device answers with minor then major firmware bytes. */
export function steelseriesRival110FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL110_COMMAND.firmware);
}

/** `16 00` — read the active preset index. */
export function steelseriesRival110ActiveCpiQuery(): Uint8Array {
  return new Uint8Array(RIVAL110_COMMAND.activeCpiIndex);
}

/**
 * Decode the active-preset reply. The specification's `resolution_level`
 * incoming struct is `report_id` then `level`, and the reply's report id is
 * not surfaced by WebHID, so the level is the first byte. The device reports
 * it 1-based (values 0x01/0x02); anything else is rejected rather than
 * guessed at.
 */
export function steelseriesRival110DecodeActivePreset(payload: Uint8Array): 1 | 2 {
  const level = payload[0];
  if (level !== 0x01 && level !== 0x02) {
    throw new Rival110ProtocolError(
      `SteelSeries Rival 110 active preset reply was not 1 or 2 (got ${level === undefined ? "nothing" : `0x${level.toString(16)}`}).`,
    );
  }
  return level;
}

export interface SteelSeriesRival110Firmware {
  /** The two raw response bytes, in the order the device sent them (minor, major). */
  bytes: [number, number];
  /** The version the two bytes describe, major first, e.g. "1.3". */
  display: string;
}

/**
 * Decode the two-byte firmware response. The specification's incoming
 * struct orders the fields `fw_minor` then `fw_major`, so the display string
 * puts them back in major.minor order.
 */
export function steelseriesRival110DecodeFirmware(payload: Uint8Array): SteelSeriesRival110Firmware {
  if (payload.length < RIVAL110_FIRMWARE_RESPONSE_LENGTH) {
    throw new Rival110ProtocolError("SteelSeries Rival 110 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[1]}.${bytes[0]}` };
}

// -- LED -------------------------------------------------------------------

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Rival110ProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

/**
 * `05 00 <r> <g> <b>` — the single LED zone color. The vendor struct also
 * carries a `brightness` byte, but both the vendor's own color-sequencing
 * template and rivalcfg's `rgbcolor` leave it zero, so this codec matches
 * them rather than inventing a brightness semantic.
 */
export function steelseriesRival110EncodeLedColor(r: number, g: number, b: number): Uint8Array {
  return new Uint8Array([...RIVAL110_COMMAND.ledColor, ...encodeRgb(r, g, b)]);
}

/** `07 00 <mode>` — lighting effect. */
export const RIVAL110_LIGHT_EFFECT_TO_BYTE = {
  steady: 0x01,
  breath: 0x03,
} as const;

export type Rival110LightEffect = keyof typeof RIVAL110_LIGHT_EFFECT_TO_BYTE;

/** `07 00 <mode>` — steady or breath. */
export function steelseriesRival110EncodeLightEffect(effect: Rival110LightEffect): Uint8Array {
  const byte = RIVAL110_LIGHT_EFFECT_TO_BYTE[effect];
  if (byte === undefined) {
    throw new Rival110ProtocolError(
      `SteelSeries Rival 110 light effect must be one of: ${Object.keys(RIVAL110_LIGHT_EFFECT_TO_BYTE).join(", ")}.`,
    );
  }
  return new Uint8Array([...RIVAL110_COMMAND.ledPulsation, byte]);
}

/** `0B <mode>` — the button-6 (CPI) button mode. */
export const RIVAL110_BUTTON6_MODE_TO_BYTE = {
  dpi: 0x00,
  os: 0x01,
} as const;

export type Rival110Button6Mode = keyof typeof RIVAL110_BUTTON6_MODE_TO_BYTE;

/** `0B <mode>` — dpi or os. */
export function steelseriesRival110EncodeButton6Mode(mode: Rival110Button6Mode): Uint8Array {
  const byte = RIVAL110_BUTTON6_MODE_TO_BYTE[mode];
  if (byte === undefined) {
    throw new Rival110ProtocolError(
      `SteelSeries Rival 110 button-6 mode must be one of: ${Object.keys(RIVAL110_BUTTON6_MODE_TO_BYTE).join(", ")}.`,
    );
  }
  return new Uint8Array([...RIVAL110_COMMAND.button6Mode, byte]);
}
