/**
 * SteelSeries Sensei TEN configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/sensei_ten.py` — the primary source for every
 *   command byte, default, and product id here.
 * - rivalcfg `rivalcfg/test/devices/old_specs/test_sensei_ten.py` — the
 *   device-specific fixture test, which pins exact expected HID report bytes
 *   for polling rate, sensitivity presets, logo/wheel color gradients,
 *   buttons mapping, save, and the firmware query. Every byte sequence in
 *   this module's own tests was cross-checked against that file rather than
 *   re-derived solely from the handler source, since it is ground truth for
 *   how rivalcfg actually serializes this device's settings.
 * - rivalcfg `rivalcfg/handlers/range.py` (the `range` value type the
 *   `multidpi_range` handler below builds on: linear input→output mapping,
 *   rounded to the nearest step) and `rivalcfg/handlers/rgbgradient.py` (the
 *   color/gradient wire format for `logo_color` and `wheel_color`).
 * - `rivalcfg/devices/sensei_raw.py` and `rivalcfg/devices/sensei310.py` were
 *   read to confirm they are unrelated protocols (different command bytes,
 *   different DPI encodings) and were not a source for anything here.
 *
 * **Corroboration gap, flagged prominently per this rollout's instructions:**
 * libratbag and the OpenRGB SteelSeries controller sources were not
 * reachable from this environment (no network access to
 * github.com/libratbag/libratbag or OpenRGB's SteelSeries controller files),
 * so unlike some earlier SteelSeries clusters in this project, **nothing
 * here has a second independent source** — rivalcfg (source + its own test
 * fixture) is the only corroboration this module has. Treat every byte below
 * as "rivalcfg says so", not "two independent projects agree".
 *
 * Every command is an HID **output report** (id `0x00`) except `logo_color`
 * and `wheel_color`, which are HID **feature reports** — `sensei_ten.py`
 * marks them `usbhid.HID_REPORT_TYPE_FEATURE` while every other setting is
 * `HID_REPORT_TYPE_OUTPUT`. The functions here build the report *payload* —
 * the bytes after the report id — unpadded, matching rivalcfg's `usbhid.py`
 * writes (`_hid_write` always prepends `report_id = 0x00` and otherwise
 * sends the payload as-is with no fixed packet length for this device).
 *
 * **This device is write-only except for firmware.** No public
 * implementation has a getter for DPI, polling, or lighting/buttons; the
 * single readable value is the two-byte firmware version behind `90 00`
 * (`response_length: 2`, `report_type: OUTPUT`), the same shape as Rival 3
 * Gen 1's `10 00` — see `steelseriesSenseiTenDecodeFirmware`, which reuses
 * Rival 3's read-order-byte-join convention and the same byte-order caveat.
 *
 * Settings apply immediately; `save_command` (`59 00`) persists them to
 * onboard flash — distinct from Rival 3 Gen 1's `09 00` and Aerox 3's
 * `11 00`; do not reuse across families.
 *
 * ## Sensor / DPI encoding
 *
 * Unlike Rival 3 Gen 1 and Aerox 3 (TrueMove Core, a byte lookup table),
 * Sensei TEN's `sensitivity` setting uses rivalcfg's plain `multidpi_range`
 * handler with `input_range: [50, 18000, 50]` and `output_range: [1, 0x0168,
 * 1]` — a **linear** mapping, not a table: `output = input / 50`, written as
 * a 2-byte little-endian integer per preset (`dpi_length_byte: 2`). This
 * matches SteelSeries marketing calling Sensei TEN's sensor a newer
 * generation (TrueMove3+) than the TrueMove Core/Air families used by
 * Rival 3 and Aerox 3/5 — confirmed here by the *shape* of the DPI handler
 * (linear range vs. lookup table) rather than by an independent sensor-name
 * source, which was not reachable (see corroboration gap above).
 *
 * `count_mode: "flag"` — like Aerox 3's `dpiPresets`, the on-wire preset
 * count is a bitmask (`0b00000001` for 1 preset, `0b00001111` for 4, etc.),
 * not a plain integer, unlike Rival 3 Gen 1's `count_mode: "number"`.
 *
 * ## RGB: `logo_color` / `wheel_color`
 *
 * Sensei TEN has two independently addressable RGB zones — the SteelSeries
 * logo and the scroll-wheel light — both using rivalcfg's full `rgbgradient`
 * value type (multi-stop animated gradients), not the simpler flat
 * `rgbcolor`/zone-bitmask scheme Aerox 3 and Aerox 5 use. This module
 * implements the complete gradient encoding (not just a solid-color special
 * case), because the wire format is small and precisely pinned by
 * `test_sensei_ten.py`'s `test_set_logo_color`/`test_set_wheel_color`
 * fixtures, which this module's tests reproduce byte-for-byte.
 *
 * The packet layout, from `rgbgradient.py`'s `process_value` with Sensei
 * TEN's `rgbgradient_header` (`header_length: 26`, `led_id_offsets: [0]`,
 * `duration_offset: 1` (2 bytes, little-endian ms), `repeat_offset: 17`,
 * `triggers_offset: 21`, `color_count_offset: 25`):
 *
 * ```
 * 5B 00 <led_id> <duration_lo> <duration_hi> <14 zero bytes>
 *       <repeat> <3 zero bytes> <triggers> <3 zero bytes> <color_count>
 *       <initial_color r,g,b> <color1 r,g,b> <pos1> ... <colorN r,g,b> <posN>
 * ```
 *
 * `led_id` is `0x00` for `logo_color`, `0x01` for `wheel_color` — the only
 * difference between the two settings' commands. `repeat` is `0x01` for a
 * solid color (no animation) or when the gradient has button triggers
 * (`triggers` — not exposed by this module, always `0x00`, matching
 * `sensei_ten.py`'s profile, which never sets it); `0x00` for an animated
 * gradient with no trigger.
 *
 * **The per-stop `pos` byte is a *delta*, not an absolute position** — easy
 * to get wrong reading `rgbgradient.py` casually, and this module's first
 * draft did. Each stop's true 0–255 position is `Math.trunc(pos * 255 /
 * 100)` (rivalcfg uses Python's `int()`, which truncates toward zero, not
 * `round()`); the wire byte for that stop is the *difference* between this
 * truncated position and the previous stop's, starting from 0. This was
 * confirmed against `test_sensei_ten.py`'s `test_set_wheel_color` fixture:
 * stops at 0/25/50/75/100% truncate to real positions 0/63/127/191/255, and
 * the fixture's actual bytes are the deltas 0/63/64/64/64, not the absolute
 * values — reproduced exactly by this module's own tests. rivalcfg
 * auto-appends a final stop equal to the first color at pos 100 if the
 * caller's last stop is not already at 100, "smoothing" the loop — this
 * module requires the caller to pass every stop explicitly (including the
 * closing one, if wanted) rather than silently appending one, to keep the
 * encoder a pure function of its input.
 *
 * ## Buttons mapping — reduced scope, mirrors `aerox3.ts`
 *
 * `31 00` + one 40-byte (8 buttons × 5-byte field) packet, zero-filled
 * except where a mapping is given — byte-identical field layout to Aerox 3's
 * `buttons_mapping`, but Sensei TEN's `button_scroll_up`/`button_scroll_down`
 * (`0x31`/`0x32`) are function **codes** a button's slot can hold (used when
 * *another* button is remapped to act as a scroll action), unlike Aerox 3
 * where `scrollUp`/`scrollDown` are physical button *sources* that cannot be
 * remap targets. Sensei TEN has no such restriction — every one of its 8
 * buttons is a valid remap target for another button's id (Button1–Button8,
 * ids `0x01`–`0x08`). As with `aerox3.ts`, this module implements the exact
 * packet shape and the mouse-button/disable/DPI-switch/scroll-up/scroll-down
 * special actions, but does not re-implement rivalcfg's QWERTY/multimedia
 * key-name tables — keyboard and multimedia targets are raw
 * `{ type: "keyboard" | "multimedia", code }` scan-code bytes, matching
 * `button_keyboard: 0x51` / `button_multimedia: 0x61` verbatim. The
 * documented defaults (`test_set_buttons_mapping`'s `"default"` case) are
 * exposed as `SENSEI_TEN_DEFAULT_BUTTONS_MAPPING` for callers/tests: Button6
 * defaults to keyboard code `0x4E` (Page Down), Button7 to `0x4B` (Page Up),
 * Button8 to DPI-switch — the rest map to themselves.
 *
 * None of this has been verified on physical Sensei TEN hardware by this
 * project. The Sensei RAW (`sensei_raw.py`) and Sensei 310 (`sensei310.py`)
 * use different, incompatible command sets and must not reuse this module.
 */

export const SENSEI_TEN_REPORT_ID = 0x00;

/** Two-byte command prefixes; the payload is the prefix plus its arguments. */
export const SENSEI_TEN_COMMAND = {
  buttonsMapping: [0x31, 0x00],
  pollingRate: [0x54, 0x00],
  sensitivity: [0x55, 0x00],
  logoColor: [0x5b, 0x00],
  wheelColor: [0x5b, 0x00],
  save: [0x59, 0x00],
  firmware: [0x90, 0x00],
} as const;

export const SENSEI_TEN_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const SENSEI_TEN_DPI_MIN = 50;
export const SENSEI_TEN_DPI_MAX = 18000;
export const SENSEI_TEN_DPI_STEP = 50;
export const SENSEI_TEN_MAX_DPI_PRESETS = 5;
export const SENSEI_TEN_FIRMWARE_RESPONSE_LENGTH = 2;

export class SenseiTenProtocolError extends Error {}

/** Every DPI value the linear 50–18,000 (step 50) range can express, ascending. */
export function steelseriesSenseiTenDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = SENSEI_TEN_DPI_MIN; dpi <= SENSEI_TEN_DPI_MAX; dpi += SENSEI_TEN_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

function dpiToWord(dpi: number): number {
  if (
    !Number.isInteger(dpi) ||
    dpi < SENSEI_TEN_DPI_MIN ||
    dpi > SENSEI_TEN_DPI_MAX ||
    dpi % SENSEI_TEN_DPI_STEP !== 0
  ) {
    throw new SenseiTenProtocolError(
      `SteelSeries Sensei TEN DPI must be ${SENSEI_TEN_DPI_MIN}–${SENSEI_TEN_DPI_MAX.toLocaleString()} in ${SENSEI_TEN_DPI_STEP} DPI steps.`,
    );
  }
  return dpi / SENSEI_TEN_DPI_STEP;
}

/**
 * `55 00 <count flag> <selected> <v1 lo,hi> ... <vN lo,hi>` — replaces the
 * mouse's whole preset table. Each DPI is 2 bytes little-endian
 * (`dpi_length_byte: 2`); `count` is a bitmask of the preset count
 * (`count_mode: "flag"`), not a plain integer. `selectedIndex` is 0-based
 * here and encoded 1-based on the wire (`first_preset: 1`).
 */
export function steelseriesSenseiTenEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length < 1 || presets.length > SENSEI_TEN_MAX_DPI_PRESETS) {
    throw new SenseiTenProtocolError(
      `SteelSeries Sensei TEN supports 1–${SENSEI_TEN_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new SenseiTenProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const words = presets.map(dpiToWord);
  const countFlag = 0b11111111 >> (8 - presets.length);
  const bytes: number[] = [...SENSEI_TEN_COMMAND.sensitivity, countFlag, selectedIndex + 1];
  for (const word of words) {
    bytes.push(word & 0xff, (word >> 8) & 0xff);
  }
  return new Uint8Array(bytes);
}

/** `54 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesSenseiTenEncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new SenseiTenProtocolError("SteelSeries Sensei TEN supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...SENSEI_TEN_COMMAND.pollingRate, byte]);
}

// -- RGB gradient (logo / wheel) --------------------------------------------

export type SenseiTenLed = "logo" | "wheel";

const LED_ID: Record<SenseiTenLed, number> = { logo: 0x00, wheel: 0x01 };

/** One gradient stop: `pos` is a percentage 0–100. */
export interface SenseiTenColorStop {
  pos: number;
  r: number;
  g: number;
  b: number;
}

const RGBGRADIENT_HEADER_LENGTH = 26;
const RGBGRADIENT_DURATION_OFFSET = 1;
const RGBGRADIENT_REPEAT_OFFSET = 17;
const RGBGRADIENT_TRIGGERS_OFFSET = 21;
const RGBGRADIENT_COLOR_COUNT_OFFSET = 25;
const RGBGRADIENT_MAX_STOPS = 14;

function validateColorChannel(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new SenseiTenProtocolError("RGB channels must be integers 0–255.");
  }
}

/**
 * `5B 00 <led_id> ...` — encodes a color or animated gradient for the logo
 * (`led: "logo"`) or scroll-wheel (`led: "wheel"`) LED. See the module doc
 * comment for the full packet layout.
 *
 * - A single stop (`stops.length === 1`) is treated as a solid, non-animated
 *   color: `repeat` is set to `0x01` regardless of that stop's `pos`
 *   (matching `rgbgradient.py`'s `is_gradient = False` path for a bare color
 *   string/tuple, which always uses `pos = 0` internally — pass `pos: 0`
 *   here for parity, though the wire format ignores it for a single stop
 *   since there is nothing to interpolate toward).
 * - Two or more stops are encoded as an animated gradient at `durationMs`,
 *   `repeat` `0x00`. Unlike rivalcfg's CLI parser, this function does **not**
 *   auto-append a closing stop equal to the first color at pos 100 — pass it
 *   explicitly if a smooth loop is wanted (see `test_set_logo_color`'s
 *   fixture, which does include that stop as its 4th entry).
 */
export function steelseriesSenseiTenEncodeLedColor(
  led: SenseiTenLed,
  stops: readonly SenseiTenColorStop[],
  durationMs = 1000,
): Uint8Array {
  if (stops.length === 0) {
    throw new SenseiTenProtocolError("SteelSeries Sensei TEN LED color needs at least one color stop.");
  }
  if (stops.length > RGBGRADIENT_MAX_STOPS) {
    throw new SenseiTenProtocolError(`SteelSeries Sensei TEN allows a maximum of ${RGBGRADIENT_MAX_STOPS} color stops.`);
  }
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 0xffff) {
    throw new SenseiTenProtocolError("SteelSeries Sensei TEN gradient duration must be an integer 0–65535 ms.");
  }
  for (const stop of stops) {
    validateColorChannel(stop.r);
    validateColorChannel(stop.g);
    validateColorChannel(stop.b);
    if (!Number.isInteger(stop.pos) || stop.pos < 0 || stop.pos > 100) {
      throw new SenseiTenProtocolError("SteelSeries Sensei TEN gradient stop positions must be integers 0–100.");
    }
  }

  const header = new Array<number>(RGBGRADIENT_HEADER_LENGTH).fill(0x00);
  header[0] = LED_ID[led];
  header[RGBGRADIENT_DURATION_OFFSET] = durationMs & 0xff;
  header[RGBGRADIENT_DURATION_OFFSET + 1] = (durationMs >> 8) & 0xff;
  header[RGBGRADIENT_REPEAT_OFFSET] = stops.length === 1 ? 0x01 : 0x00;
  header[RGBGRADIENT_TRIGGERS_OFFSET] = 0x00;
  header[RGBGRADIENT_COLOR_COUNT_OFFSET] = stops.length;

  const body: number[] = [stops[0]!.r, stops[0]!.g, stops[0]!.b];
  let lastRealPos = 0;
  for (const stop of stops) {
    const realPos = Math.trunc((stop.pos * 255) / 100);
    body.push(stop.r, stop.g, stop.b, realPos - lastRealPos);
    lastRealPos = realPos;
  }

  const command = led === "logo" ? SENSEI_TEN_COMMAND.logoColor : SENSEI_TEN_COMMAND.wheelColor;
  return new Uint8Array([...command, ...header, ...body]);
}

/** `59 00` — commit the current settings to onboard flash. */
export function steelseriesSenseiTenSaveCommand(): Uint8Array {
  return new Uint8Array(SENSEI_TEN_COMMAND.save);
}

/** `90 00` — the two-byte firmware version query, this device's only readable value. */
export function steelseriesSenseiTenFirmwareQuery(): Uint8Array {
  return new Uint8Array(SENSEI_TEN_COMMAND.firmware);
}

export interface SenseiTenFirmware {
  /** The two raw response bytes, in the order the device sent them. */
  bytes: [number, number];
  /** The bytes joined in read order, e.g. "37.0". */
  display: string;
}

/**
 * Decode the two-byte firmware response, reusing Rival 3 Gen 1's read-order
 * join convention (`steelseriesRival3DecodeFirmware`) — the byte order is
 * contested between public implementations for that family, and no
 * corroborating source (libratbag, OpenRGB) was reachable for Sensei TEN
 * specifically to settle it independently. Both raw bytes are returned.
 */
export function steelseriesSenseiTenDecodeFirmware(payload: Uint8Array): SenseiTenFirmware {
  if (payload.length < SENSEI_TEN_FIRMWARE_RESPONSE_LENGTH) {
    throw new SenseiTenProtocolError("SteelSeries Sensei TEN firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[0]}.${bytes[1]}` };
}

// -- Button mapping ---------------------------------------------------------

interface SenseiTenButtonSlot {
  id: number;
  offset: number;
}

/** `buttons_mapping.buttons` from `sensei_ten.py`, id + byte offset into the packet. */
export const SENSEI_TEN_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  button7: { id: 0x07, offset: 0x1e },
  button8: { id: 0x08, offset: 0x23 },
} as const satisfies Record<string, SenseiTenButtonSlot>;

export type SenseiTenButtonName = keyof typeof SENSEI_TEN_BUTTONS;

const SENSEI_TEN_BUTTON_FIELD_LENGTH = 5;
const SENSEI_TEN_BUTTON_DISABLE = 0x00;
const SENSEI_TEN_BUTTON_DPI_SWITCH = 0x30;
const SENSEI_TEN_BUTTON_SCROLL_UP = 0x31;
const SENSEI_TEN_BUTTON_SCROLL_DOWN = 0x32;
const SENSEI_TEN_BUTTON_KEYBOARD = 0x51;
const SENSEI_TEN_BUTTON_MULTIMEDIA = 0x61;

/** One button's target — see the module doc comment for why scroll actions
 * are function codes here, unlike Aerox 3's fixed scroll-source buttons. */
export type SenseiTenButtonAction =
  | { type: "button"; target: SenseiTenButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `31 00` + one 40-byte (`8 buttons × 5-byte field length`) packet,
 * zero-filled except where a mapping is given. Unmapped buttons are left as
 * all-zero fields — pass every button explicitly for parity with rivalcfg's
 * default profile (see `SENSEI_TEN_DEFAULT_BUTTONS_MAPPING`).
 */
export function steelseriesSenseiTenEncodeButtonsMapping(
  mapping: Partial<Record<SenseiTenButtonName, SenseiTenButtonAction>>,
): Uint8Array {
  const names = Object.keys(SENSEI_TEN_BUTTONS) as SenseiTenButtonName[];
  const packet = new Array<number>(names.length * SENSEI_TEN_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[SenseiTenButtonName, SenseiTenButtonAction]>) {
    const slot = SENSEI_TEN_BUTTONS[name];
    if (!slot) {
      throw new SenseiTenProtocolError(`Unknown SteelSeries Sensei TEN button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        packet[offset] = SENSEI_TEN_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = SENSEI_TEN_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = SENSEI_TEN_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = SENSEI_TEN_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = SENSEI_TEN_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new SenseiTenProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = SENSEI_TEN_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new SenseiTenProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = SENSEI_TEN_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new SenseiTenProtocolError(`Unsupported SteelSeries Sensei TEN button action.`);
      }
    }
  }

  return new Uint8Array([...SENSEI_TEN_COMMAND.buttonsMapping, ...packet]);
}

/**
 * `sensei_ten.py`'s documented default mapping (`test_set_buttons_mapping`'s
 * `"default"` fixture): buttons 1–5 map to themselves, Button6 to keyboard
 * Page Down (`0x4E`), Button7 to keyboard Page Up (`0x4B`), Button8 to the
 * DPI switch.
 */
export const SENSEI_TEN_DEFAULT_BUTTONS_MAPPING: Record<SenseiTenButtonName, SenseiTenButtonAction> = {
  button1: { type: "button", target: "button1" },
  button2: { type: "button", target: "button2" },
  button3: { type: "button", target: "button3" },
  button4: { type: "button", target: "button4" },
  button5: { type: "button", target: "button5" },
  button6: { type: "keyboard", code: 0x4e },
  button7: { type: "keyboard", code: 0x4b },
  button8: { type: "dpiSwitch" },
};
