/**
 * SteelSeries Rival 600 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships `rival-600.lisp` (and
 * `dota2-rival-600.lisp`, which includes it) under
 * `apps/engine/install/deviceSpecifications/`, and this module transcribes
 * it. Those files are OpenPGP-armored ("DESCRIPTOR" armor, SKESK/AES-128);
 * the bytes below are the documented HID report payloads, not guesses.
 * rivalcfg's `rival600.py` independently corroborates every command byte
 * and the DPI range here (see below), so this family is dual-sourced.
 *
 * Despite the shared A3360/TrueMove3 sensor and the "600/650" naming, the
 * Rival 600 does NOT share a command set with the Rival 650 Wireless
 * (`./rival650.ts`, family `"rival650"`): sensitivity `0x03` (two per-level
 * commands) vs. `0x15`, polling `0x04` vs. `0x17`, buttons `0x31` (feature
 * report) vs. `0x19` (output), and a firmware query `0x10` the 650 lacks.
 * The two vendor specification files confirm the split, so this is a
 * separate family/module, not a reuse.
 *
 * Every command is an HID **output report** with report id 0x00 (33-byte
 * reports — `HIDIO 33` throughout the specification — smaller than every
 * other family's 65-byte reports), except the button-mapping command,
 * which is an HID **feature** report (`0x31`, `HIDFEATURE`).
 *
 * DPI uses two per-level commands (`03 00 01`/`03 00 02`): a linear
 * one-byte encoding, `byte = (dpi - 100) / 100`, range 0x00–0x77
 * (100–12000 in 100 DPI steps), followed by the suffix `00 42` (the A3360
 * sensor PID). The vendor file states the byte and suffix but no range;
 * rivalcfg's `input_range [100, 12000, 100]` / `output_range [0x00, 0x77,
 * 1]` supplies the mapping, and it is the same linear encoding Rival 310
 * uses. Off-grid values are rejected rather than rounded.
 *
 * Polling (`04 00`, values 1000→0x01, 500→0x02, 250→0x03, 125→0x04) is
 * write-only. Buttons are one 35-byte packet (7 slots × 5-byte fields) as
 * a feature report, command `0x31`: `button7` has id `0x00`, colliding
 * with the disable byte, so it is a valid remap *source* but not a valid
 * *target* — see `steelseriesRival600EncodeButtonsMapping`.
 *
 * The proximity (lift-off) sensor command `0x96` carries `enable`, a low
 * threshold, and a high threshold byte; the vendor file states no range
 * for the two thresholds, so this codec passes them through.
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is hardware evidence and a reason to ship
 * them:
 *
 * - The 8-zone lighting path: the specification uses `direct_write` `0x27`
 *   (mask + 8 RGB triples) and `single_zone_direct_write` `0x07`, while
 *   rivalcfg's `rival600.py` instead uses a `05 00` feature-report
 *   rgbgradient path. The two sources disagree on the LED command, so
 *   lighting is left out until the difference is resolved on hardware.
 * - `reset_all_illumination` `0x08`, `current_sensor` read `0x60`,
 *   `resolution_level` read `0x81`(read-op), macros, and factory restore.
 * - Deceleration/acceleration (`MOUSEACCELDECEL`) and angle snapping
 *   (`MOUSESMOOTHING`): these are kernel-driver `SSE` settings, not HID
 *   commands, and are out of scope for this codec.
 *
 * `read resolution_level` (read-op) returns the active preset level; this
 * module exposes it as `steelseriesRival600LevelQuery`, though the driver
 * does not rely on it. Settings apply immediately; the save command
 * (`09 00`) persists them to onboard flash. None of this has been verified
 * on physical hardware by this project.
 */

export const RIVAL600_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL600_COMMAND = {
  sensitivity1: [0x03, 0x00, 0x01],
  sensitivity2: [0x03, 0x00, 0x02],
  pollingRate: [0x04, 0x00],
  /** Read-op for the active preset level (`81 00`). */
  activeLevel: [0x81, 0x00],
  /** Feature report; 7×5-byte button table follows the selector. */
  buttonsMapping: [0x31, 0x00],
  proximity: [0x96, 0x00],
  save: [0x09, 0x00],
  firmware: [0x10, 0x00],
} as const;

/** `command_suffix` appended after the DPI byte for both sensitivity presets. */
const SENSITIVITY_SUFFIX = [0x00, 0x42] as const;

/** `09 00` — commit the current settings to onboard flash. */
export const RIVAL600_SAVE_COMMAND = [0x09, 0x00] as const;

/** The two sensitivity presets the specification defines (levels 1 and 2). */
export const RIVAL600_DPI_PRESET_COUNT = 2;

export const RIVAL600_FIRMWARE_RESPONSE_LENGTH = 2;

export const RIVAL600_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const RIVAL600_DPI_MIN = 100;
export const RIVAL600_DPI_MAX = 12000;
export const RIVAL600_DPI_STEP = 100;

/** rivalcfg `rival600.py` defaults for the two presets. */
export const RIVAL600_DEFAULT_DPI_PRESET_1 = 800;
export const RIVAL600_DEFAULT_DPI_PRESET_2 = 1600;
export const RIVAL600_DEFAULT_POLLING_RATE = 1000;

export class Rival600ProtocolError extends Error {}

/**
 * `input_range [100, 12000, 100]` -> `output_range [0x00, 0x77, 1]`: a
 * plain linear one-byte encoding, `byte = (dpi - 100) / 100`, range
 * 0x00–0x77 (119). Values must land exactly on a 100 DPI step; off-grid
 * input is rejected, matching how the rest of this package validates DPI.
 */
function encodeDpiByte(dpi: number): number {
  if (
    !Number.isInteger(dpi) ||
    dpi < RIVAL600_DPI_MIN ||
    dpi > RIVAL600_DPI_MAX ||
    (dpi - RIVAL600_DPI_MIN) % RIVAL600_DPI_STEP !== 0
  ) {
    throw new Rival600ProtocolError(
      `SteelSeries Rival 600 DPI must be ${RIVAL600_DPI_MIN}–${RIVAL600_DPI_MAX.toLocaleString("en-US")} in ${RIVAL600_DPI_STEP} DPI steps.`,
    );
  }
  return (dpi - RIVAL600_DPI_MIN) / RIVAL600_DPI_STEP;
}

/** The 120 DPI values the linear encoding can express, ascending. */
export function steelseriesRival600DpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = RIVAL600_DPI_MIN; dpi <= RIVAL600_DPI_MAX; dpi += RIVAL600_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

/** `03 00 01 <byte> 00 42` — sensitivity preset 1. */
export function steelseriesRival600EncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL600_COMMAND.sensitivity1, encodeDpiByte(dpi), ...SENSITIVITY_SUFFIX]);
}

/** `03 00 02 <byte> 00 42` — sensitivity preset 2. */
export function steelseriesRival600EncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL600_COMMAND.sensitivity2, encodeDpiByte(dpi), ...SENSITIVITY_SUFFIX]);
}

/** `04 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival600EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival600ProtocolError("SteelSeries Rival 600 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL600_COMMAND.pollingRate, byte]);
}

/** `09 00` — commit the current settings to onboard flash. */
export function steelseriesRival600SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL600_SAVE_COMMAND);
}

/** `81 00` — read the active preset level. */
export function steelseriesRival600LevelQuery(): Uint8Array {
  return new Uint8Array(RIVAL600_COMMAND.activeLevel);
}

/** `10 00` — the device answers with minor then major firmware bytes. */
export function steelseriesRival600FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL600_COMMAND.firmware);
}

export interface SteelSeriesRival600Firmware {
  /** The two raw response bytes, in the order the device sent them (minor, major). */
  bytes: [number, number];
  /** The version the two bytes describe, major first, e.g. "2.52". */
  display: string;
}

/**
 * Decode the two-byte firmware response. The specification's incoming
 * struct orders the fields `fw_minor` then `fw_major`, so the display
 * string puts them back in major.minor order.
 */
export function steelseriesRival600DecodeFirmware(payload: Uint8Array): SteelSeriesRival600Firmware {
  if (payload.length < RIVAL600_FIRMWARE_RESPONSE_LENGTH) {
    throw new Rival600ProtocolError("SteelSeries Rival 600 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[1]}.${bytes[0]}` };
}

/**
 * `96 00 <enable> <low> <high>` — proximity (lift-off) sensor threshold.
 * `low`/`high` have no stated range in the vendor file; they are passed
 * through as bytes.
 */
export function steelseriesRival600EncodeProximity(enable: boolean, low: number, high: number): Uint8Array {
  for (const [value, name] of [[low, "Low"], [high, "High"]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Rival600ProtocolError(`SteelSeries Rival 600 proximity ${name} threshold must be an integer 0–255.`);
    }
  }
  return new Uint8Array([...RIVAL600_COMMAND.proximity, enable ? 0x01 : 0x00, low, high]);
}

// -- Button mapping --------------------------------------------------------

/** 7 button slots, 5-byte fields — the same layout as the Rival 650. */
export const RIVAL600_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  /**
   * `"id": 0x00` in rivalcfg's `rival600.py` (and the vendor table's CPI
   * button) — collides with `button_disable`, so this button cannot be a
   * valid remap *target*. It still has its own `offset` and defaults to the
   * `dpi` special action.
   */
  button7: { id: 0x00, offset: 0x1e },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Rival600ButtonName = keyof typeof RIVAL600_BUTTONS;

const RIVAL600_BUTTON_FIELD_LENGTH = 5;
const RIVAL600_BUTTON_DISABLE = 0x00;
const RIVAL600_BUTTON_DPI_SWITCH = 0x30;
const RIVAL600_BUTTON_SCROLL_UP = 0x31;
const RIVAL600_BUTTON_SCROLL_DOWN = 0x32;
const RIVAL600_BUTTON_KEYBOARD = 0x51;
const RIVAL600_BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. `button7`'s `id` (`0x00`) collides with `disabled`,
 * so — like `./rival650.ts` — it is a valid remap *source* but excluded
 * from `"button"` as a remap *target*.
 */
export type Rival600ButtonAction =
  | { type: "button"; target: Exclude<Rival600ButtonName, "button7"> }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Rival600ProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `31 00` (feature report) + one 35-byte packet (7 slots × 5-byte fields),
 * zero-filled except where a mapping is given. Pass every button explicitly
 * — unmapped buttons stay disabled, matching this package's
 * no-silent-defaults policy.
 */
export function steelseriesRival600EncodeButtonsMapping(
  mapping: Partial<Record<Rival600ButtonName, Rival600ButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(RIVAL600_BUTTONS, name)) {
      throw new Rival600ProtocolError(`Unknown SteelSeries Rival 600 button "${name}".`);
    }
  }

  const names = Object.keys(RIVAL600_BUTTONS) as Rival600ButtonName[];
  const packet = new Array<number>(names.length * RIVAL600_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival600ButtonName, Rival600ButtonAction]>) {
    const { offset } = RIVAL600_BUTTONS[name];
    switch (action.type) {
      case "button": {
        packet[offset] = RIVAL600_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = RIVAL600_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = RIVAL600_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = RIVAL600_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = RIVAL600_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        packet[offset] = RIVAL600_BUTTON_KEYBOARD;
        packet[offset + 1] = encodeKeyCode(action.code, "Keyboard scan");
        break;
      }
      case "multimedia": {
        packet[offset] = RIVAL600_BUTTON_MULTIMEDIA;
        packet[offset + 1] = encodeKeyCode(action.code, "Multimedia key");
        break;
      }
      default: {
        throw new Rival600ProtocolError("Unsupported SteelSeries Rival 600 button action.");
      }
    }
  }

  return new Uint8Array([...RIVAL600_COMMAND.buttonsMapping, ...packet]);
}
