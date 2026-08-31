/**
 * SteelSeries Rival 310 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/rival310.py` — the primary source for every
 *   command byte, default, and PID here.
 * - rivalcfg `rivalcfg/handlers/range.py` — the "range" handler used for both
 *   DPI presets: linear `input_range: [100, 12000, 100]` mapped onto
 *   `output_range: [0x00, 0x77, 1]`, i.e. a **plain one-byte linear encoding**
 *   (`byte = (dpi - 100) / 100`), not the TrueMove Core lookup table used by
 *   `./rival3.ts` and `./aerox3.ts`. The Rival 310 predates TrueMove Core
 *   (SteelSeries shipped it with the older PixArt PMW3360-derived "TrueMove3"
 *   sensor); rivalcfg encodes it as a bare range, so this module does too —
 *   no table is reused from the Rival 3 modules.
 * - rivalcfg `rivalcfg/handlers/choice.py` — polling rate.
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` — the fixed-width button
 *   field layout (5 bytes/button, zero-filled, `offset`/`id` per button,
 *   `<action byte>` then `<code byte>` for keyboard/multimedia targets).
 *   Byte-identical field mechanics to `./aerox3.ts`'s buttons handler, but a
 *   two-byte `31 00` command prefix (Rival 310) instead of one-byte `2A`
 *   (Aerox 3), and different id/offset/special-action values throughout.
 * - rivalcfg `rivalcfg/handlers/rgbgradient.py` — LED color/effect encoding;
 *   see "RGB — deliberately reduced scope" below for what this module
 *   actually implements of it.
 *
 * ## Corroboration gap — explicitly flagged
 *
 * This module was **not** cross-checked against libratbag's
 * `src/driver-steelseries.c` or against OpenRGB's SteelSeries controller
 * files: both `github.com/libratbag/libratbag` and
 * `github.com/openrgb/OpenRGB` were unreachable from this environment (no
 * outbound network access beyond the pre-cloned `/tmp/rivalcfg` mirror), and
 * no local clone of either was available to read instead. The task
 * instructions called for checking libratbag "harder" for this device
 * specifically, since the Rival 310 is old/popular enough to plausibly be
 * supported there — that check could not be performed. Every byte in this
 * module traces to rivalcfg alone. Treat the DPI range encoding, the button
 * byte layout, and the RGB header/body layout as **rivalcfg-only claims,
 * unverified against a second independent source**, until someone with
 * network access (or a local libratbag/OpenRGB checkout) confirms or
 * corrects them.
 *
 * Every command is an HID **output report** with report id 0x00 on the
 * vendor configuration interface (hidapi `endpoint == 0`, per rivalcfg's
 * `"endpoint": 0` model entries — note this differs from Rival 3 Gen 1's and
 * Aerox 3's `endpoint: 3`; do not assume interface 3 for this device). The
 * one exception is the RGB color commands, which rivalcfg sends as HID
 * **feature** reports (`usbhid.HID_REPORT_TYPE_FEATURE`) — callers must route
 * `steelseriesRival310EncodeLedColor`'s output through a feature-report send,
 * not `sendReport`. The functions here build the report *payload* — the
 * bytes after the report id — unpadded, matching rivalcfg's `usbhid.py`.
 *
 * **This device is write-only for settings**, like every other SteelSeries
 * family in this package: rivalcfg defines no getter for DPI, polling,
 * lighting, or buttons. The one readable value is the two-byte firmware
 * version behind command `90 00` (`response_length: 2`, `report_type`
 * output) — analogous to Rival 3 Gen 1's `10 00`, a different command byte.
 *
 * Settings apply immediately; the save command (`59 00`) commits them to
 * onboard flash, matching rivalcfg's CLI default of saving after every write.
 * None of this has been verified on physical Rival 310 hardware by this
 * project.
 *
 * ## Product ids
 *
 * rivalcfg's `rival310.py` lists three colorway/bundle variants, all vendor
 * `0x1038`, all sharing this exact command set (one profile, three `models`
 * entries):
 *
 * - `0x1720` — SteelSeries Rival 310
 * - `0x171E` — SteelSeries Rival 310 CS:GO Howl Edition
 * - `0x1736` — SteelSeries Rival 310 PUBG Edition
 *
 * Checked against `./devices.ts` as it stood when this module was written:
 * none of `0x1720`/`0x171E`/`0x1736` collided with any PID already claimed
 * there (Rival 3 Gen 1 `0x1824`/`0x184C`, Aerox 3 `0x1836`, Rival 3 Wireless
 * `0x1830`, Aerox 5 `0x1850`, Aerox 5 Wireless family `0x1852`/`0x1854`/
 * `0x185C`/`0x185E`/`0x1860`/`0x1862`).
 *
 * ## RGB — deliberately reduced scope
 *
 * rivalcfg's `rgbgradient` handler supports up to 14 timed color stops with
 * duration, repeat, and button-trigger fields — a small state machine. This
 * module implements only the **single steady color** path through that
 * handler (`is_gradient = False`, one color, `pos = 0`), which is what the
 * handler itself produces for a plain color string or RGB tuple input (the
 * common case; see `_handle_color_string`/`_handle_color_tuple` in
 * `rgbgradient.py`). Traced byte-for-byte from `process_value`:
 *
 * - `header` is `header_length` (26) zero-filled bytes: `header[0]` = led id
 *   (`led_id_offsets: [0]`), `header[1..2]` = duration little-endian
 *   (`duration_offset: 1`, `duration_length: 2`; rivalcfg's default 1000 ms
 *   is used since a steady color does not animate), `header[17]` = repeat
 *   flag (`repeat_offset: 17`; **`0x01` for a steady, non-gradient color** —
 *   `process_value` sets `repeat = 0x01` whenever `is_gradient` is false),
 *   `header[21]` = triggers bitmask (`triggers_offset: 21`; always `0x00`
 *   here — trigger support is out of scope), `header[25]` = color count
 *   (`color_count_offset: 25`; always `1`).
 * - `body` is the color repeated with a zero position delta:
 *   `[r, g, b, r, g, b, 0x00]` — `process_value`'s body starts as
 *   `list(gradient[0]["color"])` (first `r,g,b`), then its stop loop appends
 *   `merge_bytes(body, color, real_pos - last_real_pos)` for the same single
 *   stop, i.e. `color` again followed by the integer position delta (`0` for
 *   the only stop, at `pos = 0`) appended as its own trailing byte.
 * - Full payload sent to the device: `5B 00` (command) + 26-byte header +
 *   7-byte body = 35 bytes, as a **feature** report.
 *
 * Multi-stop gradients, custom durations, repeat-off one-shot sequences, and
 * button-triggered color changes are not implemented — documented here so
 * nobody re-derives them, the same scope line `./aerox3.ts` draws around its
 * button-mapping keyboard/multimedia name tables.
 */

export const STEELSERIES_RIVAL310_REPORT_ID = 0x00;

/** Two-byte command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL310_COMMAND = {
  sensitivity1: [0x53, 0x00, 0x01],
  sensitivity2: [0x53, 0x00, 0x02],
  pollingRate: [0x54, 0x00],
  ledColor: [0x5b, 0x00],
  buttonsMapping: [0x31, 0x00],
  save: [0x59, 0x00],
  firmware: [0x90, 0x00],
} as const;

/** `command_suffix` appended after the DPI byte for both sensitivity presets. */
const SENSITIVITY_SUFFIX = [0x00, 0x42] as const;

export const RIVAL310_SAVE_COMMAND = [0x59, 0x00] as const;
export const RIVAL310_FIRMWARE_RESPONSE_LENGTH = 2;

export const RIVAL310_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const RIVAL310_DPI_MIN = 100;
export const RIVAL310_DPI_MAX = 12000;
export const RIVAL310_DPI_STEP = 100;

export class SteelSeriesRival310ProtocolError extends Error {}

/**
 * `input_range: [100, 12000, 100]` -> `output_range: [0x00, 0x77, 1]`: a
 * plain linear one-byte encoding, `byte = (dpi - 100) / 100`, range 0x00–0x77
 * (119). Values must land exactly on a 100 DPI step; rivalcfg's `range`
 * handler rounds off-grid input to the nearest step instead, but this codec
 * rejects it, matching how the rest of this package validates DPI (see
 * `rival3.ts`'s doc comment on the same choice).
 */
function encodeDpiByte(dpi: number): number {
  if (
    !Number.isInteger(dpi) ||
    dpi < RIVAL310_DPI_MIN ||
    dpi > RIVAL310_DPI_MAX ||
    (dpi - RIVAL310_DPI_MIN) % RIVAL310_DPI_STEP !== 0
  ) {
    throw new SteelSeriesRival310ProtocolError(
      `SteelSeries Rival 310 DPI must be ${RIVAL310_DPI_MIN}–${RIVAL310_DPI_MAX.toLocaleString()} in ${RIVAL310_DPI_STEP} DPI steps.`,
    );
  }
  return (dpi - RIVAL310_DPI_MIN) / RIVAL310_DPI_STEP;
}

/** The 120 DPI values the linear encoding can express, ascending. */
export function steelseriesRival310DpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = RIVAL310_DPI_MIN; dpi <= RIVAL310_DPI_MAX; dpi += RIVAL310_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

/** `53 00 01 <byte> 00 42` — sensitivity preset 1. */
export function steelseriesRival310EncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL310_COMMAND.sensitivity1, encodeDpiByte(dpi), ...SENSITIVITY_SUFFIX]);
}

/** `53 00 02 <byte> 00 42` — sensitivity preset 2. */
export function steelseriesRival310EncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...RIVAL310_COMMAND.sensitivity2, encodeDpiByte(dpi), ...SENSITIVITY_SUFFIX]);
}

/** `54 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival310EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new SteelSeriesRival310ProtocolError("SteelSeries Rival 310 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL310_COMMAND.pollingRate, byte]);
}

/** `59 00` — commit the current settings to onboard flash. */
export function steelseriesRival310SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL310_SAVE_COMMAND);
}

/** `90 00` — the device answers with a two-byte input report. */
export function steelseriesRival310FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL310_COMMAND.firmware);
}

export interface SteelSeriesRival310Firmware {
  /** The two raw response bytes, in the order the device sent them. */
  bytes: [number, number];
  /** The bytes joined in read order, e.g. "37.0". */
  display: string;
}

/**
 * Decode the two-byte firmware response. As with `rival3.ts`'s `10 00`
 * response, the byte order is not settled against hardware; `display`
 * follows the same read-order convention until a real Rival 310 unit
 * confirms which byte is major and which is minor.
 */
export function steelseriesRival310DecodeFirmware(payload: Uint8Array): SteelSeriesRival310Firmware {
  if (payload.length < RIVAL310_FIRMWARE_RESPONSE_LENGTH) {
    throw new SteelSeriesRival310ProtocolError("SteelSeries Rival 310 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[0]}.${bytes[1]}` };
}

// -- LED color (steady color only — see module doc comment) -----------------

export type Rival310Led = "logo" | "wheel";

const LED_ID: Record<Rival310Led, number> = { logo: 0x00, wheel: 0x01 };

const RGBGRADIENT_HEADER_LENGTH = 26;
const RGBGRADIENT_DURATION_OFFSET = 1;
const RGBGRADIENT_REPEAT_OFFSET = 17;
const RGBGRADIENT_TRIGGERS_OFFSET = 21;
const RGBGRADIENT_COLOR_COUNT_OFFSET = 25;
const RGBGRADIENT_DEFAULT_DURATION_MS = 1000;

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new SteelSeriesRival310ProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

/**
 * `5B 00` (feature report) + 26-byte header + 7-byte body — sets one LED to
 * a steady color. See the module doc comment's "RGB — deliberately reduced
 * scope" section for the byte-by-byte derivation from rivalcfg's
 * `rgbgradient` handler. This is a **feature** report, unlike every other
 * command in this module.
 */
export function steelseriesRival310EncodeLedColor(led: Rival310Led, r: number, g: number, b: number): Uint8Array {
  const [red, green, blue] = encodeRgb(r, g, b);
  const ledId = LED_ID[led];
  if (ledId === undefined) {
    throw new SteelSeriesRival310ProtocolError('SteelSeries Rival 310 LEDs are "logo" and "wheel" only.');
  }

  const header = new Array<number>(RGBGRADIENT_HEADER_LENGTH).fill(0x00);
  header[0] = ledId;
  header[RGBGRADIENT_DURATION_OFFSET] = RGBGRADIENT_DEFAULT_DURATION_MS & 0xff;
  header[RGBGRADIENT_DURATION_OFFSET + 1] = (RGBGRADIENT_DEFAULT_DURATION_MS >> 8) & 0xff;
  header[RGBGRADIENT_REPEAT_OFFSET] = 0x01;
  header[RGBGRADIENT_TRIGGERS_OFFSET] = 0x00;
  header[RGBGRADIENT_COLOR_COUNT_OFFSET] = 0x01;

  const body = [red, green, blue, red, green, blue, 0x00];

  return new Uint8Array([...RIVAL310_COMMAND.ledColor, ...header, ...body]);
}

// -- Button mapping -----------------------------------------------------

interface Rival310ButtonSlot {
  id: number;
  offset: number;
}

/** `buttons_mapping.buttons` from `rival310.py`, id + byte offset into the packet. */
export const RIVAL310_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
} as const satisfies Record<string, Rival310ButtonSlot>;

export type Rival310ButtonName = keyof typeof RIVAL310_BUTTONS;

const RIVAL310_BUTTON_FIELD_LENGTH = 5;
const RIVAL310_BUTTON_DISABLE = 0x00;
const RIVAL310_BUTTON_KEYBOARD = 0x51;
const RIVAL310_BUTTON_MULTIMEDIA = 0x61;
const RIVAL310_BUTTON_DPI_SWITCH = 0x30;
const RIVAL310_BUTTON_SCROLL_UP = 0x31;
const RIVAL310_BUTTON_SCROLL_DOWN = 0x32;

/**
 * One button's target. Unlike `./aerox3.ts` (where `scrollUp`/`scrollDown`
 * are physical button *sources* that cannot be remap targets), `rival310.py`
 * has no scroll-wheel button slots at all — `button_scroll_up`/
 * `button_scroll_down` are special *action* bytes any of the six buttons can
 * be assigned, alongside `disabled`/`dpiSwitch`/another mouse button/a
 * keyboard or multimedia key.
 */
export type Rival310ButtonAction =
  | { type: "button"; target: Rival310ButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `31 00` + one 30-byte (`6 buttons × 5-byte field length`) packet,
 * zero-filled except where a mapping is given. Unmapped buttons are left as
 * all-zero fields, same policy as `./aerox3.ts`: pass every button
 * explicitly for parity with rivalcfg's default profile
 * (`button1=button1; button2=button2; button3=button3; button4=button4;
 * button5=button5; button6=dpi`).
 */
export function steelseriesRival310EncodeButtonsMapping(
  mapping: Partial<Record<Rival310ButtonName, Rival310ButtonAction>>,
): Uint8Array {
  const names = Object.keys(RIVAL310_BUTTONS) as Rival310ButtonName[];
  const packet = new Array<number>(names.length * RIVAL310_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival310ButtonName, Rival310ButtonAction]>) {
    const slot = RIVAL310_BUTTONS[name];
    if (!slot) {
      throw new SteelSeriesRival310ProtocolError(`Unknown SteelSeries Rival 310 button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        const target = RIVAL310_BUTTONS[action.target];
        if (!target) {
          throw new SteelSeriesRival310ProtocolError(`Unknown SteelSeries Rival 310 button "${action.target}".`);
        }
        packet[offset] = target.id;
        break;
      }
      case "disabled": {
        packet[offset] = RIVAL310_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = RIVAL310_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = RIVAL310_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = RIVAL310_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new SteelSeriesRival310ProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = RIVAL310_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new SteelSeriesRival310ProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = RIVAL310_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new SteelSeriesRival310ProtocolError("Unsupported SteelSeries Rival 310 button action.");
      }
    }
  }

  return new Uint8Array([...RIVAL310_COMMAND.buttonsMapping, ...packet]);
}
