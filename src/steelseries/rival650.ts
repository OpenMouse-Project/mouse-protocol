/**
 * SteelSeries Rival 650 Wireless configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/rival650.py` — the primary source for every
 *   command byte, product id, and default here. Read in full for this
 *   cluster; not assumed from any sibling SteelSeries device file.
 * - rivalcfg `rivalcfg/handlers/range.py` — `sensitivity1`/`sensitivity2`:
 *   linear range-to-range mapping. `input_range` `[100, 12000, 100]` against
 *   `output_range` `[0x00, 0x77, 1]` — 120 steps each side, so the wire byte
 *   is simply `(dpi - 100) / 100`, `range_length_byte` defaulting to 1 (not
 *   set in the profile).
 * - rivalcfg `rivalcfg/handlers/range_choice.py` — `lift_off_distance`: a
 *   *scalar* range-choice (unlike `./rival3-wireless.ts`'s per-preset DPI
 *   table use of the *multi*-DPI handler), `input_range` `[1, 8, 1]` matched
 *   exactly (every step has its own `output_choices` entry, so no rounding
 *   is exercised in practice) against a two-byte little-endian output value
 *   (`range_length_byte: 2` — the output values themselves, e.g. `0x7874`,
 *   are already 16-bit quantities, not indices).
 * - rivalcfg `rivalcfg/handlers/range.py` again — `sleep_timer`: `input_range`
 *   `[1, 20, 1]` (minutes) against `output_range` `[0x003C, 0x04B0, 60]`
 *   (seconds, `range_length_byte: 2`) — 60 and 1200 are `1*60` and `20*60`,
 *   so the wire value is simply `minutes * 60` seconds, little-endian 2
 *   bytes.
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` — the fixed-width button
 *   field layout, 7 buttons, `button_field_length: 5`. Button 7 has
 *   `"id": 0x00` in the source (colliding with `button_disable`'s `0x00`) and
 *   defaults to the `dpi` special action — like `./aerox5-wireless.ts`'s
 *   `scrollUp`/`scrollDown`, this means Button 7 is a valid remap *source*
 *   (it has an `offset`) but not a valid remap *target* (writing its `id`
 *   into another button's field would be indistinguishable from disabling
 *   that button), so `RivalSixFiftyButtonAction`'s `"button"` variant
 *   excludes it.
 * - rivalcfg's `usbhid.py` / `mouse.py` framing — unnumbered HID output
 *   reports on the vendor configuration interface (`"endpoint": 0` for both
 *   models, unlike `./rival3-wireless.ts`/`./aerox5-wireless.ts`'s
 *   `endpoint: 3`).
 *
 * ## Why this is a separate protocol family from every other SteelSeries device here
 *
 * `rival650.py` shares no command byte with `./rival3.ts`, `./aerox3.ts`,
 * `./rival3-wireless.ts`, `./aerox5.ts`, or `./aerox5-wireless.ts`:
 * sensitivity `0x15 0x01`/`0x15 0x02` (two separate single-value commands,
 * not a shared multi-preset table like Rival 3 Wireless's `0x20` or Aerox 5
 * Wireless's `0x2D`), polling `0x17` with `{125:0x04, 250:0x03, 500:0x02,
 * 1000:0x01}` (Rival 3 Wireless also uses command byte `0x17` but a
 * *different* value mapping — do not conflate the two), lift-off distance
 * `0x20 0x01` (a setting neither Rival 3 Wireless nor Aerox 5 Wireless
 * expose), buttons `0x19` (byte-identical to Rival 3 Wireless's buttons
 * command, but a different field layout: 7 buttons here vs. 6 there), sleep
 * timer `0x2B 0x01 0x01 0x00 0x00 0x00` (a 6-byte prefix, longer than any
 * sibling's), battery `0xAA 0x01` (**byte-identical** to
 * `./rival3-wireless.ts`'s battery command and response shape — see below),
 * save `0x09` (one byte, same as Rival 3 Wireless's, different from Rival 3
 * Gen 1's two-byte `0x09 0x00`). No firmware-query command is defined in
 * `rival650.py` at all (unlike Rival 3 Wireless's `0x90 0x00`), so this
 * family has no firmware probe.
 *
 * Product ids: `1038:172B` (wired/USB-cabled mode) and `1038:1726` (2.4 GHz
 * wireless mode), both `"endpoint": 0`. Neither collides with any PID
 * claimed by the Rival 3 / Aerox 3 / Rival 3 Wireless / Aerox 5 / Aerox 5
 * Wireless families already registered in `./devices.ts`. Unlike
 * `./aerox5-wireless.ts`, `rival650.py` uses the **same** command bytes for
 * both PIDs — there is no `_patch_command`-style wireless-flag transform to
 * model here.
 *
 * No corroborating libratbag or OpenRGB source for this exact device/PID was
 * available in this environment (no local libratbag checkout, and OpenRGB's
 * SteelSeries controller files were not reachable this pass) — every command
 * byte above is sourced from rivalcfg alone. This should be treated as a
 * single-source reconstruction until corroborated or hardware-verified.
 *
 * ## Battery / charging read — byte-identical shape to Rival 3 Wireless
 *
 * `rival650.py`'s top-level `battery_level` block is byte-for-byte the same
 * shape as `./rival3-wireless.ts`'s: command `0xAA 0x01`, 3-byte input-report
 * reply, `level = int(data[0])`, `is_charging = bool(data[2])`, `data[1]`
 * unused by either lambda. This module defines its own
 * `steelseriesRival650BatteryQuery` / `steelseriesRival650DecodeBattery`
 * rather than importing Rival 3 Wireless's, so each family's codec stays
 * self-contained (matching `./aerox5-wireless.ts`'s precedent of not sharing
 * command/decode functions across families even when bytes happen to match).
 *
 * DPI presets, polling rate, lift-off distance, buttons, and sleep timer
 * remain write-only: `rival650.py` defines no getter for any of them, same
 * as every other SteelSeries profile in rivalcfg. Settings apply
 * immediately; the save command (`0x09`) persists them to onboard flash.
 * None of this has been verified on physical hardware by this project.
 */

export const RIVAL650_REPORT_ID = 0x00;

/** Command prefixes; length varies by command, matching rivalcfg exactly. */
export const RIVAL650_COMMAND = {
  sensitivity1: [0x15, 0x01],
  sensitivity2: [0x15, 0x02],
  pollingRate: [0x17],
  liftOffDistance: [0x20, 0x01],
  buttonsMapping: [0x19],
  sleepTimer: [0x2b, 0x01, 0x01, 0x00, 0x00, 0x00],
  /** `AA 01` — battery percentage + charging state, 3-byte input-report reply. */
  batteryLevel: [0xaa, 0x01],
  /** One byte, same as Rival 3 Wireless's, unlike Rival 3 Gen 1's two-byte `09 00`. */
  save: [0x09],
} as const;

export const RIVAL650_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const RIVAL650_DPI_MIN = 100;
export const RIVAL650_DPI_MAX = 12000;
export const RIVAL650_DPI_STEP = 100;
export const RIVAL650_BATTERY_RESPONSE_LENGTH = 3;

export const RIVAL650_LIFT_OFF_DISTANCE_MIN = 1;
export const RIVAL650_LIFT_OFF_DISTANCE_MAX = 8;

/** `lift_off_distance.output_choices` from `rival650.py`, exact per-mm values, no rounding needed. */
const LIFT_OFF_DISTANCE_TO_VALUE: ReadonlyMap<number, number> = new Map([
  [1, 0x7874],
  [2, 0x736f],
  [3, 0x6e6a],
  [4, 0x6965],
  [5, 0x6460],
  [6, 0x5f5b],
  [7, 0x5a56],
  [8, 0x5551],
]);

export const RIVAL650_SLEEP_TIMER_MIN_MINUTES = 1;
export const RIVAL650_SLEEP_TIMER_MAX_MINUTES = 20;

export class Rival650ProtocolError extends Error {}

/** DPI values expressible by the linear `range` table, ascending: 100, 200, …, 12000. */
export function steelseriesRival650DpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = RIVAL650_DPI_MIN; dpi <= RIVAL650_DPI_MAX; dpi += RIVAL650_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

function encodeDpiByte(dpi: number): number {
  if (!Number.isInteger(dpi) || dpi < RIVAL650_DPI_MIN || dpi > RIVAL650_DPI_MAX || (dpi - RIVAL650_DPI_MIN) % RIVAL650_DPI_STEP !== 0) {
    throw new Rival650ProtocolError(
      `SteelSeries Rival 650 Wireless DPI must be ${RIVAL650_DPI_MIN}–${RIVAL650_DPI_MAX.toLocaleString()} in ${RIVAL650_DPI_STEP} DPI steps.`,
    );
  }
  return (dpi - RIVAL650_DPI_MIN) / RIVAL650_DPI_STEP;
}

/** `15 01 <v>` — sensitivity preset 1, `v = (dpi - 100) / 100` per rivalcfg's `range` table. */
export function steelseriesRival650EncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL650_COMMAND.sensitivity1, encodeDpiByte(dpi)]);
}

/** `15 02 <v>` — sensitivity preset 2, same encoding as preset 1. */
export function steelseriesRival650EncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL650_COMMAND.sensitivity2, encodeDpiByte(dpi)]);
}

/** `17 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04 (different mapping than Rival 3 Wireless's same-byte command). */
export function steelseriesRival650EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival650ProtocolError("SteelSeries Rival 650 Wireless supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL650_COMMAND.pollingRate, byte]);
}

/** `20 01 <v_lo> <v_hi>` — lift-off distance 1–8 mm, exact per-step output value, little-endian 2 bytes. */
export function steelseriesRival650EncodeLiftOffDistance(millimeters: number): Uint8Array {
  const value = LIFT_OFF_DISTANCE_TO_VALUE.get(millimeters);
  if (value === undefined) {
    throw new Rival650ProtocolError(
      `SteelSeries Rival 650 Wireless lift-off distance must be an integer ${RIVAL650_LIFT_OFF_DISTANCE_MIN}–${RIVAL650_LIFT_OFF_DISTANCE_MAX}.`,
    );
  }
  return new Uint8Array([...RIVAL650_COMMAND.liftOffDistance, value & 0xff, (value >> 8) & 0xff]);
}

/** `2B 01 01 00 00 00 <v_lo> <v_hi>` — idle minutes before sleep, encoded as `minutes * 60` seconds, little-endian 2 bytes. */
export function steelseriesRival650EncodeSleepTimer(minutes: number): Uint8Array {
  if (
    !Number.isInteger(minutes) ||
    minutes < RIVAL650_SLEEP_TIMER_MIN_MINUTES ||
    minutes > RIVAL650_SLEEP_TIMER_MAX_MINUTES
  ) {
    throw new Rival650ProtocolError(
      `SteelSeries Rival 650 Wireless sleep timer must be an integer ${RIVAL650_SLEEP_TIMER_MIN_MINUTES}–${RIVAL650_SLEEP_TIMER_MAX_MINUTES} minutes.`,
    );
  }
  const seconds = minutes * 60;
  return new Uint8Array([...RIVAL650_COMMAND.sleepTimer, seconds & 0xff, (seconds >> 8) & 0xff]);
}

/** `09` — commit the current settings to onboard flash. */
export function steelseriesRival650SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL650_COMMAND.save);
}

/** `AA 01` — the device answers with a three-byte input report. */
export function steelseriesRival650BatteryQuery(): Uint8Array {
  return new Uint8Array(RIVAL650_COMMAND.batteryLevel);
}

export interface Rival650Battery {
  /** Battery percentage, `data[0]` verbatim (rivalcfg does not clamp it). */
  level: number;
  /** `bool(data[2])` in rivalcfg — `data[1]` is not used by either lambda. */
  isCharging: boolean;
}

/**
 * Decode the three-byte battery response: `data[0]` is the percentage
 * (rivalcfg's `level` lambda, `int(data[0])`), `data[2]` is charging state
 * (rivalcfg's `is_charging` lambda, `bool(data[2])`). `data[1]` is present in
 * the response but unused by either rivalcfg lambda. Byte-identical shape to
 * `./rival3-wireless.ts`'s battery decode.
 */
export function steelseriesRival650DecodeBattery(payload: Uint8Array): Rival650Battery {
  if (payload.length < RIVAL650_BATTERY_RESPONSE_LENGTH) {
    throw new Rival650ProtocolError("SteelSeries Rival 650 Wireless battery response is shorter than three bytes.");
  }
  return { level: payload[0]!, isCharging: payload[2]! !== 0 };
}

// -- Button mapping ---------------------------------------------------------

interface Rival650ButtonSlot {
  id: number;
  offset: number;
}

/** `buttons_mapping.buttons` from `rival650.py`, id + byte offset into the packet. */
export const RIVAL650_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  /**
   * `"id": 0x00` in the source — collides with `button_disable`, so this
   * button cannot be a valid remap *target* (see module doc comment). It
   * still has its own `offset` and defaults to the `dpi` special action.
   */
  button7: { id: 0x00, offset: 0x1e },
} as const satisfies Record<string, Rival650ButtonSlot>;

export type Rival650ButtonName = keyof typeof RIVAL650_BUTTONS;

const RIVAL650_BUTTON_FIELD_LENGTH = 5;
const RIVAL650_BUTTON_DISABLE = 0x00;
const RIVAL650_BUTTON_DPI_SWITCH = 0x30;
const RIVAL650_BUTTON_SCROLL_UP = 0x31;
const RIVAL650_BUTTON_SCROLL_DOWN = 0x32;
const RIVAL650_BUTTON_KEYBOARD = 0x51;
const RIVAL650_BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. `button7`'s `id` (`0x00`) collides with `disabled`,
 * so — like `./aerox5-wireless.ts`'s `scrollUp`/`scrollDown` — it is a valid
 * remap *source* (it has an `offset` and can be assigned any action) but
 * excluded from `"button"` as a remap *target*.
 */
export type Rival650ButtonAction =
  | { type: "button"; target: Exclude<Rival650ButtonName, "button7"> }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `19` + one 35-byte (`7 buttons × 5-byte field length`) packet, zero-filled
 * except where a mapping is given. Unmapped buttons are left as all-zero
 * fields (rivalcfg instead fills in per-button defaults; this codec leaves
 * that policy to the caller — pass every button explicitly for parity with
 * rivalcfg's default profile).
 */
export function steelseriesRival650EncodeButtonsMapping(
  mapping: Partial<Record<Rival650ButtonName, Rival650ButtonAction>>,
): Uint8Array {
  const names = Object.keys(RIVAL650_BUTTONS) as Rival650ButtonName[];
  const packet = new Array<number>(names.length * RIVAL650_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival650ButtonName, Rival650ButtonAction]>) {
    const slot = RIVAL650_BUTTONS[name];
    if (!slot) {
      throw new Rival650ProtocolError(`Unknown SteelSeries Rival 650 Wireless button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        packet[offset] = RIVAL650_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = RIVAL650_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = RIVAL650_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = RIVAL650_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = RIVAL650_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Rival650ProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = RIVAL650_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Rival650ProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = RIVAL650_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new Rival650ProtocolError("Unsupported SteelSeries Rival 650 Wireless button action.");
      }
    }
  }

  return new Uint8Array([...RIVAL650_COMMAND.buttonsMapping, ...packet]);
}
