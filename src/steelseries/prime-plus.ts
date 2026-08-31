/**
 * SteelSeries Prime+ configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/prime_plus.py` — the primary source for every
 *   command byte and default here. `1038:182C`, endpoint 0.
 * - rivalcfg `rivalcfg/devices/prime.py` (plain Prime, `1038:182E` plus two
 *   limited-edition PIDs) was read only to confirm Prime+ genuinely warrants
 *   its own module rather than reusing Prime's. **Surprising finding: it does
 *   not, protocol-wise.** `prime.py` and `prime_plus.py` are byte-identical
 *   in every setting (sensitivity `0x61`, polling `0x5D`, color `0x62 0x01`,
 *   brightness `0x5F`, buttons `0x5B`, save `0x59`) — the only diff is the
 *   model name/PID list. **rivalcfg's Prime+ profile has no OLED/display
 *   setting**, contrary to this rollout's assumption that Prime+ has one
 *   because the physical mouse has an OLED status screen. Neither rivalcfg,
 *   libratbag, nor the OpenRGB SteelSeries controller sources reachable from
 *   this environment (see corroboration gap below) expose any command for it.
 *   Prime+ is still implemented as its own module/PID/family rather than
 *   folded into a shared "Prime" module, per this rollout's instruction to
 *   add Prime+ only and not touch plain Prime — but the wire protocol
 *   implemented here is not distinguishable from plain Prime's, and a reader
 *   should not infer an OLED command exists just because this module exists.
 * - rivalcfg `rivalcfg/handlers/multidpi_range.py` (DPI presets: `merge_bytes(
 *   count, selected_preset, ...values)`, `count_mode: "number"`, 2-byte
 *   little-endian DPI values here vs. Aerox 3's 1-byte) and
 *   `rivalcfg/handlers/range.py` (the range→range linear rounding both
 *   `multidpi_range` and `range` build on).
 * - rivalcfg `rivalcfg/handlers/rgbcolor.py` — RGB value encoding (`[r,g,b]`).
 * - rivalcfg `rivalcfg/handlers/range.py` (again, for `led_brightness`: a
 *   0–256 linear passthrough, 2-byte little-endian — note the input range's
 *   upper bound is genuinely `256`, not `255`, in `prime_plus.py`; not a typo
 *   introduced here).
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` — the fixed-width button
 *   field layout (5 bytes/button, zero-filled, `offset`/`id` per button),
 *   same shape as Aerox 3's but only 6 buttons/slots (no scroll-wheel source
 *   entries — `prime_plus.py`'s `buttons_mapping.buttons` table lists only
 *   `Button1`..`Button6`).
 * - rivalcfg `rivalcfg/mouse.py` (`_exec_command`) — confirms wire assembly
 *   order is `command ++ process_value(value) ++ command_suffix`, which is
 *   how the color command's 16-byte suffix (15 zero bytes then `0xFF`)
 *   attaches after the `[r,g,b]` triple.
 *
 * ## Corroboration gap (must read before trusting this file)
 *
 * libratbag's `src/driver-steelseries.c` (fetched from
 * `libratbag/libratbag@master`) contains **no reference at all** to Prime,
 * Prime+, PID `0x182C`, or any OLED/display command — it does not implement
 * this device family. The OpenRGB SteelSeries controller sources could not be
 * located at their expected path in this environment (404) and a GitHub code
 * search for "Prime+", `0x182C`, and "SteelSeriesPrime" against
 * `CalcProgrammer1/OpenRGB` returned zero results, so OpenRGB could not be
 * checked either. **rivalcfg is therefore the only source this module is
 * corroborated against.** Nothing here has been verified on physical Prime+
 * hardware by this project.
 *
 * Every command is an HID **output report** with report id 0x00 (`"endpoint":
 * 0` in `prime_plus.py`, the vendor configuration interface). The functions
 * here build the report *payload* — the bytes after the report id — unpadded,
 * matching rivalcfg's `usbhid.py` writes.
 *
 * **This device is write-only.** `prime_plus.py` defines no getter for any
 * setting and no firmware-query command, so there is nothing to probe the
 * mouse with beyond a successful `open()` — same honesty policy as Aerox 3:
 * session state must be tracked client-side with `valuesVerified: false`.
 *
 * Settings apply immediately; the save command (`0x59`, a single byte with
 * **no** `0x00` suffix — distinct from Aerox 3's `11 00` and Rival 3 Gen 1's
 * `09 00`; do not confuse the three) persists them to onboard flash.
 *
 * ## Button mapping — deliberately reduced scope
 *
 * Same scope line drawn in `./aerox3.ts`: this module implements the exact
 * 5-byte/button, zero-filled packet shape and the mouse-button/disable/
 * DPI-switch/scroll-wheel special actions, but does not re-implement
 * rivalcfg's QWERTY or multimedia key-name tables — keyboard and multimedia
 * targets are taken here as raw `{ type: "keyboard" | "multimedia", code }`
 * scan-code bytes, matching `button_keyboard: 0x51` / `button_multimedia:
 * 0x61` verbatim. Unlike Aerox 3, Prime+'s `buttons` table has no `ScrollUp`/
 * `ScrollDown` *source* button entries (only 6 physical buttons are mapped),
 * but `button_scroll_up: 0x31` / `button_scroll_down: 0x32` are still valid
 * *target* special actions for any of the 6 buttons, exposed here as
 * `{ type: "scrollUp" }` / `{ type: "scrollDown" }`.
 */

export const PRIME_PLUS_REPORT_ID = 0x00;

/** One-byte command prefixes; the payload is the prefix plus its arguments. */
export const PRIME_PLUS_COMMAND = {
  sensitivity: [0x61],
  pollingRate: [0x5d],
  color: [0x62, 0x01],
  ledBrightness: [0x5f],
  buttonsMapping: [0x5b],
} as const;

/** `0x62 0x01 <r> <g> <b>` followed by this fixed 16-byte suffix (`command_suffix` in `prime_plus.py`). */
const COLOR_SUFFIX = [
  0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
  0xff,
] as const;

/** `0x59` — a single byte, no `0x00` suffix. Distinct from Aerox 3's `11 00`. */
export const PRIME_PLUS_SAVE_COMMAND = [0x59] as const;

export const PRIME_PLUS_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const PRIME_PLUS_DPI_MIN = 50;
export const PRIME_PLUS_DPI_MAX = 18000;
export const PRIME_PLUS_DPI_STEP = 50;
export const PRIME_PLUS_MAX_DPI_PRESETS = 5;

export const PRIME_PLUS_LED_BRIGHTNESS_MAX = 256;

export class PrimePlusProtocolError extends Error {}

/**
 * `prime_plus.py`'s `input_range`/`output_range` for `sensitivity` are both
 * `[50, 18000, 50]` / `[1, 0x0168, 1]` — 360 steps mapped 1:1 in ascending
 * order, so the output byte is simply `(dpi - 50) / 50 + 1`. Unlike Aerox 3's
 * TrueMove Core table, no lookup table is needed or possible to corroborate
 * from `range.py`'s generic range-to-range formula.
 */
function dpiToWireValue(dpi: number): number {
  if (!Number.isInteger(dpi) || dpi < PRIME_PLUS_DPI_MIN || dpi > PRIME_PLUS_DPI_MAX || (dpi - PRIME_PLUS_DPI_MIN) % PRIME_PLUS_DPI_STEP !== 0) {
    throw new PrimePlusProtocolError(
      `SteelSeries Prime+ DPI must be ${PRIME_PLUS_DPI_MIN}–${PRIME_PLUS_DPI_MAX.toLocaleString()} in ${PRIME_PLUS_DPI_STEP} DPI steps.`,
    );
  }
  return (dpi - PRIME_PLUS_DPI_MIN) / PRIME_PLUS_DPI_STEP + 1;
}

/** The 360 DPI values the linear `sensitivity` range can express, ascending. */
export function steelseriesPrimePlusDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = PRIME_PLUS_DPI_MIN; dpi <= PRIME_PLUS_DPI_MAX; dpi += PRIME_PLUS_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

/**
 * `61 <count> <selectedPreset> <v1_lo> <v1_hi> … <vN_lo> <vN_hi>` — replaces
 * the mouse's whole preset table. Two bytes per DPI, little-endian
 * (`dpi_length_byte: 2`); `selectedIndex` is 0-based both here and on the
 * wire (`first_preset: 0`, unlike Aerox 3's `first_preset: 1`).
 */
export function steelseriesPrimePlusEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length < 1 || presets.length > PRIME_PLUS_MAX_DPI_PRESETS) {
    throw new PrimePlusProtocolError(
      `SteelSeries Prime+ supports 1–${PRIME_PLUS_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new PrimePlusProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded: number[] = [];
  for (const dpi of presets) {
    const value = dpiToWireValue(dpi);
    encoded.push(value & 0xff, (value >> 8) & 0xff);
  }
  return new Uint8Array([...PRIME_PLUS_COMMAND.sensitivity, presets.length, selectedIndex, ...encoded]);
}

/** `5D <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesPrimePlusEncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new PrimePlusProtocolError("SteelSeries Prime+ supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...PRIME_PLUS_COMMAND.pollingRate, byte]);
}

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new PrimePlusProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

/** `62 01 <r> <g> <b>` plus the fixed 16-byte suffix — the scroll-wheel LED color. */
export function steelseriesPrimePlusEncodeColor(r: number, g: number, b: number): Uint8Array {
  const [red, green, blue] = encodeRgb(r, g, b);
  return new Uint8Array([...PRIME_PLUS_COMMAND.color, red, green, blue, ...COLOR_SUFFIX]);
}

/**
 * `5F <v_lo> <v_hi>` — linear 0–256 passthrough, 2-byte little-endian
 * (`range_length_byte: 2`). Note the upper bound is genuinely 256, matching
 * `prime_plus.py`'s `input_range`/`output_range`.
 */
export function steelseriesPrimePlusEncodeLedBrightness(level: number): Uint8Array {
  if (!Number.isInteger(level) || level < 0 || level > PRIME_PLUS_LED_BRIGHTNESS_MAX) {
    throw new PrimePlusProtocolError(
      `SteelSeries Prime+ LED brightness must be an integer 0–${PRIME_PLUS_LED_BRIGHTNESS_MAX}.`,
    );
  }
  return new Uint8Array([...PRIME_PLUS_COMMAND.ledBrightness, level & 0xff, (level >> 8) & 0xff]);
}

/** `59` — commit the current settings to onboard flash. */
export function steelseriesPrimePlusSaveCommand(): Uint8Array {
  return new Uint8Array(PRIME_PLUS_SAVE_COMMAND);
}

// -- Button mapping ---------------------------------------------------------

interface PrimePlusButtonSlot {
  id: number;
  offset: number;
}

/** `buttons_mapping.buttons` from `prime_plus.py`, id + byte offset into the packet. */
export const PRIME_PLUS_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
} as const satisfies Record<string, PrimePlusButtonSlot>;

export type PrimePlusButtonName = keyof typeof PRIME_PLUS_BUTTONS;

const PRIME_PLUS_BUTTON_FIELD_LENGTH = 5;
const PRIME_PLUS_BUTTON_DISABLE = 0x00;
const PRIME_PLUS_BUTTON_DPI_SWITCH = 0x30;
const PRIME_PLUS_BUTTON_SCROLL_UP = 0x31;
const PRIME_PLUS_BUTTON_SCROLL_DOWN = 0x32;
const PRIME_PLUS_BUTTON_KEYBOARD = 0x51;
const PRIME_PLUS_BUTTON_MULTIMEDIA = 0x61;

/** One button's target. */
export type PrimePlusButtonAction =
  | { type: "button"; target: PrimePlusButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `5B` + one 30-byte (`6 buttons × 5-byte field length`) packet, zero-filled
 * except where a mapping is given. Unmapped buttons are left as all-zero
 * fields — pass every button explicitly for parity with rivalcfg's default
 * profile, same policy as `./aerox3.ts`.
 */
export function steelseriesPrimePlusEncodeButtonsMapping(
  mapping: Partial<Record<PrimePlusButtonName, PrimePlusButtonAction>>,
): Uint8Array {
  const names = Object.keys(PRIME_PLUS_BUTTONS) as PrimePlusButtonName[];
  const packet = new Array<number>(names.length * PRIME_PLUS_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[PrimePlusButtonName, PrimePlusButtonAction]>) {
    const slot = PRIME_PLUS_BUTTONS[name];
    if (!slot) {
      throw new PrimePlusProtocolError(`Unknown SteelSeries Prime+ button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        const target = PRIME_PLUS_BUTTONS[action.target];
        if (!target) {
          throw new PrimePlusProtocolError(`Unknown SteelSeries Prime+ button target "${action.target}".`);
        }
        packet[offset] = target.id;
        break;
      }
      case "disabled": {
        packet[offset] = PRIME_PLUS_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = PRIME_PLUS_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = PRIME_PLUS_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = PRIME_PLUS_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new PrimePlusProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = PRIME_PLUS_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new PrimePlusProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = PRIME_PLUS_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new PrimePlusProtocolError(`Unsupported SteelSeries Prime+ button action.`);
      }
    }
  }

  return new Uint8Array([...PRIME_PLUS_COMMAND.buttonsMapping, ...packet]);
}
