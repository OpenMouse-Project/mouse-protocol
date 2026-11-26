/**
 * SteelSeries Rival 100 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships `rival-100.lisp` (plus the
 * `rival-100-dell-china`, `rival-100-pc-bang`, `dota2-rival-100-retail`,
 * `dota2-rival-100-lenovo` and `rival-105` files, all of which `include
 * "rival-100"`) under `apps/engine/install/deviceSpecifications/`, and this
 * module transcribes it. Those files are OpenPGP-armored ("DESCRIPTOR"
 * armor, SKESK/AES-128); the bytes below are the documented HID report
 * payloads, not guesses. rivalcfg's `rival100.py` (which lists the same
 * Rival 100/105 product ids) independently corroborates the command bytes.
 *
 * This is the first-generation "rival 100 family" command set shared by the
 * Rival 100, Rival 105, and every Rival 100 special edition. It is not the
 * Rival 110/106/300S command set: those share the same command bytes but use
 * a different sensor table (PixArt PMW3326, 200–7200 DPI), which needs its
 * own module. Do not extend this one to cover them.
 *
 * Every command is an HID **output report** with report id 0x00 (33-byte
 * reports — `HIDIO 33`). Unlike the modern families, **buttons are not
 * remappable** at all: the vendor file stubs `button_mappings`/
 * `wheel_mappings` out as empty, and the only button control is a "button 6
 * mode" toggle (`0B`), which switches the CPI button under the wheel between
 * hardware DPI switching and an OS-bound button.
 *
 * DPI uses two per-level commands (`03 01`/`03 02`) with a **choice** byte,
 * not a linear encoding: the vendor file states the byte but no table (the
 * Rival 100 sensor exposes only eight hardware steps). rivalcfg's
 * `rival100.py` supplies that table — 250→0x08, 500→0x07, 1000→0x06,
 * 1250→0x05, 1500→0x04, 1750→0x03, 2000→0x02, 4000→0x01 (note the
 * *inverted* byte order) — and is the sole source for the mapping, flagged
 * here. Off-table DPI values are rejected. The active preset level is the
 * one readable value (`16 00`).
 *
 * Polling (`04 00`) is write-only (1000→0x01, 500→0x02, 250→0x03,
 * 125→0x04). Lighting is a single zone: color (`05 00` + RGB) and effect
 * (`07 00` + mode). A firmware version (`10 00`, two bytes) is defined for
 * the Rival 105 and the derived files; the Rival 100 base file has the same
 * struct commented out ("removed for security reasons"), but rivalcfg reads
 * it on the Rival 100, so it is exposed here and used by the driver as its
 * connectivity probe (flagged).
 *
 * Settings apply immediately; the save command (`09 00`) persists them to
 * onboard flash. None of this has been verified on physical hardware by
 * this project.
 */

export const RIVAL100_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL100_COMMAND = {
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
export const RIVAL100_SAVE_COMMAND = [0x09, 0x00] as const;

export const RIVAL100_FIRMWARE_RESPONSE_LENGTH = 2;

export const RIVAL100_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

/**
 * The eight hardware DPI steps the Rival 100 sensor exposes, from
 * rivalcfg's `rival100.py` `choices` (the vendor file gives no table). Note
 * the inverted byte order: the largest DPI is the smallest byte.
 */
export const RIVAL100_DPI_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [250, 0x08],
  [500, 0x07],
  [1000, 0x06],
  [1250, 0x05],
  [1500, 0x04],
  [1750, 0x03],
  [2000, 0x02],
  [4000, 0x01],
]);

/** rivalcfg `rival100.py` defaults for the two presets. */
export const RIVAL100_DEFAULT_DPI_PRESET_1 = 1000;
export const RIVAL100_DEFAULT_DPI_PRESET_2 = 2000;
export const RIVAL100_DEFAULT_POLLING_RATE = 1000;

export class Rival100ProtocolError extends Error {}

/** The eight supported DPI values, ascending. */
export function steelseriesRival100DpiOptions(): number[] {
  return [...RIVAL100_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

function encodeDpiByte(dpi: number): number {
  const byte = RIVAL100_DPI_TO_BYTE.get(dpi);
  if (byte === undefined) {
    throw new Rival100ProtocolError(
      `SteelSeries Rival 100 DPI must be one of: ${steelseriesRival100DpiOptions().join(", ")}.`,
    );
  }
  return byte;
}

/** `03 01 <byte>` — sensitivity preset 1. */
export function steelseriesRival100EncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL100_COMMAND.sensitivity1, encodeDpiByte(dpi)]);
}

/** `03 02 <byte>` — sensitivity preset 2. */
export function steelseriesRival100EncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL100_COMMAND.sensitivity2, encodeDpiByte(dpi)]);
}

/** `04 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival100EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival100ProtocolError("SteelSeries Rival 100 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL100_COMMAND.pollingRate, byte]);
}

/** `09 00` — commit the current settings to onboard flash. */
export function steelseriesRival100SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL100_SAVE_COMMAND);
}

/** `10 00` — the device answers with minor then major firmware bytes. */
export function steelseriesRival100FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL100_COMMAND.firmware);
}

/** `16 00` — read the active preset index. */
export function steelseriesRival100ActiveCpiQuery(): Uint8Array {
  return new Uint8Array(RIVAL100_COMMAND.activeCpiIndex);
}

export interface SteelSeriesRival100Firmware {
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
export function steelseriesRival100DecodeFirmware(payload: Uint8Array): SteelSeriesRival100Firmware {
  if (payload.length < RIVAL100_FIRMWARE_RESPONSE_LENGTH) {
    throw new Rival100ProtocolError("SteelSeries Rival 100 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[1]}.${bytes[0]}` };
}

// -- LED -------------------------------------------------------------------

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Rival100ProtocolError("RGB channels must be integers 0–255.");
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
export function steelseriesRival100EncodeLedColor(r: number, g: number, b: number): Uint8Array {
  return new Uint8Array([...RIVAL100_COMMAND.ledColor, ...encodeRgb(r, g, b)]);
}

/** `07 00 <mode>` — lighting effect. See `steelseriesRival100EncodeLightEffect`. */
export const RIVAL100_LIGHT_EFFECT_TO_BYTE = {
  steady: 0x01,
  breath: 0x03,
} as const;

export type Rival100LightEffect = keyof typeof RIVAL100_LIGHT_EFFECT_TO_BYTE;

/** `07 00 <mode>` — steady or breath. */
export function steelseriesRival100EncodeLightEffect(effect: Rival100LightEffect): Uint8Array {
  const byte = RIVAL100_LIGHT_EFFECT_TO_BYTE[effect];
  if (byte === undefined) {
    throw new Rival100ProtocolError(
      `SteelSeries Rival 100 light effect must be one of: ${Object.keys(RIVAL100_LIGHT_EFFECT_TO_BYTE).join(", ")}.`,
    );
  }
  return new Uint8Array([...RIVAL100_COMMAND.ledPulsation, byte]);
}

/**
 * `0B <mode>` — the button-6 (CPI) button mode. `dpi` keeps hardware DPI
 * switching; `os` reports it as a normal OS-bound button. The Rival 100
 * "PC Bang" edition sends an extra `00 0E 01` packet before this one (see
 * `rival-100-pc-bang.lisp`); that quirk is handled by the driver for that
 * product id.
 */
export const RIVAL100_BUTTON6_MODE_TO_BYTE = {
  dpi: 0x00,
  os: 0x01,
} as const;

export type Rival100Button6Mode = keyof typeof RIVAL100_BUTTON6_MODE_TO_BYTE;

/** `0B <mode>` — dpi or os. */
export function steelseriesRival100EncodeButton6Mode(mode: Rival100Button6Mode): Uint8Array {
  const byte = RIVAL100_BUTTON6_MODE_TO_BYTE[mode];
  if (byte === undefined) {
    throw new Rival100ProtocolError(
      `SteelSeries Rival 100 button-6 mode must be one of: ${Object.keys(RIVAL100_BUTTON6_MODE_TO_BYTE).join(", ")}.`,
    );
  }
  return new Uint8Array([...RIVAL100_COMMAND.button6Mode, byte]);
}

/** `00 0E 01` — the pre-packet the Rival 100 PC Bang edition sends before `0B`. */
export const RIVAL100_PC_BANG_BUTTON6_PREFIX = [0x00, 0x0e, 0x01] as const;
