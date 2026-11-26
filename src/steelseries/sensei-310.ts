/**
 * SteelSeries Sensei 310 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations and the vendor's own
 * software, not from vendor source code:
 *
 * - rivalcfg `rivalcfg/devices/sensei310.py` — same command set as
 *   `./rival310.ts`'s `rival310.py` (sensitivity `0x53`, polling `0x54`,
 *   buttons `0x31`, save `0x59`, firmware `0x90 00`), which is why this
 *   module mirrors that file's structure and constants.
 * - The vendor's SteelSeries GG device specification (`sensei-310.lisp`,
 *   GG 121.0.0) is a one-page file: `(include "rival-310")` plus an
 *   8-entry `button_mapping_data` override (`repeat 8` instead of Rival
 *   310's 6) with the same `0x31` command. Everything except the button
 *   table is inherited byte-for-byte, so this module keeps the Rival 310
 *   command bytes, DPI encoding, polling values, RGB handling, save
 *   command, and firmware query identical, with Sensei 310 naming.
 *
 * Button 7/8 use ids `0x07`/`0x08` at offsets `0x1e`/`0x23`, continuing the
 * sequential id/offset pattern and matching `./sensei-ten.ts`'s 8-button
 * table. The vendor file states only the slot count, so those two ids are
 * an inference from the shared convention, flagged here rather than
 * asserted as observed.
 *
 * Like `./rival310.ts`, this module is rivalcfg-only corroboration: no
 * libratbag or OpenRGB source was reachable for this device. Nothing here
 * has been verified on physical Sensei 310 hardware by this project.
 *
 * Every command is an HID **output report** with report id 0x00 on the
 * vendor configuration interface (`"endpoint": 0`, as in `rival310.py`),
 * except the LED color commands, which are HID **feature** reports.
 *
 * **This device is write-only for settings**: no getter exists for DPI,
 * polling, lighting, or buttons. The one readable value is the two-byte
 * firmware version behind command `90 00`.
 *
 * Settings apply immediately; the save command (`59 00`) commits them to
 * onboard flash.
 */

export const STEELSERIES_SENSEI310_REPORT_ID = 0x00;

/** Two-byte command prefixes; the payload is the prefix plus its arguments. */
export const SENSEI310_COMMAND = {
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

/** `59 00` — commit the current settings to onboard flash. */
export const SENSEI310_SAVE_COMMAND = [0x59, 0x00] as const;

export const SENSEI310_FIRMWARE_RESPONSE_LENGTH = 2;

export const SENSEI310_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const SENSEI310_DPI_MIN = 100;
export const SENSEI310_DPI_MAX = 12000;
export const SENSEI310_DPI_STEP = 100;

export class Sensei310ProtocolError extends Error {}

/**
 * `input_range: [100, 12000, 100]` mapped onto a plain one-byte linear
 * encoding (`byte = (dpi - 100) / 100`) — the same encoding as
 * `./rival310.ts`, inherited through the shared vendor profile. Off-grid
 * values are rejected rather than rounded, matching this package's DPI
 * validation policy.
 */
function encodeDpiByte(dpi: number): number {
  if (
    !Number.isInteger(dpi) ||
    dpi < SENSEI310_DPI_MIN ||
    dpi > SENSEI310_DPI_MAX ||
    (dpi - SENSEI310_DPI_MIN) % SENSEI310_DPI_STEP !== 0
  ) {
    throw new Sensei310ProtocolError(
      `SteelSeries Sensei 310 DPI must be ${SENSEI310_DPI_MIN}–${SENSEI310_DPI_MAX.toLocaleString()} in ${SENSEI310_DPI_STEP} DPI steps.`,
    );
  }
  return (dpi - SENSEI310_DPI_MIN) / SENSEI310_DPI_STEP;
}

/** The 120 DPI values the linear encoding can express, ascending. */
export function steelseriesSensei310DpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = SENSEI310_DPI_MIN; dpi <= SENSEI310_DPI_MAX; dpi += SENSEI310_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

/** `53 00 01 <byte> 00 42` — sensitivity preset 1. */
export function steelseriesSensei310EncodeSensitivity1(dpi: number): Uint8Array {
  return new Uint8Array([...SENSEI310_COMMAND.sensitivity1, encodeDpiByte(dpi), ...SENSITIVITY_SUFFIX]);
}

/** `53 00 02 <byte> 00 42` — sensitivity preset 2. */
export function steelseriesSensei310EncodeSensitivity2(dpi: number): Uint8Array {
  return new Uint8Array([...SENSEI310_COMMAND.sensitivity2, encodeDpiByte(dpi), ...SENSITIVITY_SUFFIX]);
}

/** `54 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesSensei310EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Sensei310ProtocolError("SteelSeries Sensei 310 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...SENSEI310_COMMAND.pollingRate, byte]);
}

/** `59 00` — commit the current settings to onboard flash. */
export function steelseriesSensei310SaveCommand(): Uint8Array {
  return new Uint8Array(SENSEI310_SAVE_COMMAND);
}

/** `90 00` — the device answers with a two-byte input report. */
export function steelseriesSensei310FirmwareQuery(): Uint8Array {
  return new Uint8Array(SENSEI310_COMMAND.firmware);
}

export interface SteelSeriesSensei310Firmware {
  /** The two raw response bytes, in the order the device sent them. */
  bytes: [number, number];
  /** The bytes joined in read order, e.g. "37.0". */
  display: string;
}

/**
 * Decode the two-byte firmware response, following `./rival310.ts`'s
 * read-order convention until hardware settles the byte order.
 */
export function steelseriesSensei310DecodeFirmware(payload: Uint8Array): SteelSeriesSensei310Firmware {
  if (payload.length < SENSEI310_FIRMWARE_RESPONSE_LENGTH) {
    throw new Sensei310ProtocolError("SteelSeries Sensei 310 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[0]}.${bytes[1]}` };
}

// -- LED color (steady color only, same scope as rival310.ts) -----------------

export type Sensei310Led = "logo" | "wheel";

const LED_ID: Record<Sensei310Led, number> = { logo: 0x00, wheel: 0x01 };

const RGBGRADIENT_HEADER_LENGTH = 26;
const RGBGRADIENT_DURATION_OFFSET = 1;
const RGBGRADIENT_REPEAT_OFFSET = 17;
const RGBGRADIENT_TRIGGERS_OFFSET = 21;
const RGBGRADIENT_COLOR_COUNT_OFFSET = 25;
const RGBGRADIENT_DEFAULT_DURATION_MS = 1000;

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Sensei310ProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

/**
 * `5B 00` (feature report) + 26-byte header + 7-byte body — sets one LED to
 * a steady color. Same single-color path through rivalcfg's `rgbgradient`
 * handler as `./rival310.ts`; multi-stop gradients are out of scope here
 * too. This is a **feature** report, unlike every other command in this
 * module.
 */
export function steelseriesSensei310EncodeLedColor(led: Sensei310Led, r: number, g: number, b: number): Uint8Array {
  const [red, green, blue] = encodeRgb(r, g, b);
  const ledId = LED_ID[led];
  if (ledId === undefined) {
    throw new Sensei310ProtocolError('SteelSeries Sensei 310 LEDs are "logo" and "wheel" only.');
  }

  const header = new Array<number>(RGBGRADIENT_HEADER_LENGTH).fill(0x00);
  header[0] = ledId;
  header[RGBGRADIENT_DURATION_OFFSET] = RGBGRADIENT_DEFAULT_DURATION_MS & 0xff;
  header[RGBGRADIENT_DURATION_OFFSET + 1] = (RGBGRADIENT_DEFAULT_DURATION_MS >> 8) & 0xff;
  header[RGBGRADIENT_REPEAT_OFFSET] = 0x01;
  header[RGBGRADIENT_TRIGGERS_OFFSET] = 0x00;
  header[RGBGRADIENT_COLOR_COUNT_OFFSET] = 0x01;

  const body = [red, green, blue, red, green, blue, 0x00];

  return new Uint8Array([...SENSEI310_COMMAND.ledColor, ...header, ...body]);
}

// -- Button mapping -----------------------------------------------------

interface Sensei310ButtonSlot {
  id: number;
  offset: number;
}

/**
 * The vendor specification overrides Rival 310's 6-entry table with 8
 * entries (`repeat 8`). Button 7/8 ids continue the sequential pattern;
 * see the module doc comment for the disclosure.
 */
export const SENSEI310_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  button7: { id: 0x07, offset: 0x1e },
  button8: { id: 0x08, offset: 0x23 },
} as const satisfies Record<string, Sensei310ButtonSlot>;

export type Sensei310ButtonName = keyof typeof SENSEI310_BUTTONS;

const SENSEI310_BUTTON_FIELD_LENGTH = 5;
const SENSEI310_BUTTON_DISABLE = 0x00;
const SENSEI310_BUTTON_KEYBOARD = 0x51;
const SENSEI310_BUTTON_MULTIMEDIA = 0x61;
const SENSEI310_BUTTON_DPI_SWITCH = 0x30;
const SENSEI310_BUTTON_SCROLL_UP = 0x31;
const SENSEI310_BUTTON_SCROLL_DOWN = 0x32;

/**
 * One button's target. Like `./rival310.ts`, there are no scroll-wheel
 * button slots — scroll up/down are special *action* bytes any button can
 * be assigned.
 */
export type Sensei310ButtonAction =
  | { type: "button"; target: Sensei310ButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `31 00` + one 40-byte (`8 buttons × 5-byte field length`) packet,
 * zero-filled except where a mapping is given. Pass every button
 * explicitly — unmapped buttons stay disabled, matching this package's
 * no-silent-defaults policy.
 */
export function steelseriesSensei310EncodeButtonsMapping(
  mapping: Partial<Record<Sensei310ButtonName, Sensei310ButtonAction>>,
): Uint8Array {
  const names = Object.keys(SENSEI310_BUTTONS) as Sensei310ButtonName[];
  const packet = new Array<number>(names.length * SENSEI310_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Sensei310ButtonName, Sensei310ButtonAction]>) {
    const slot = SENSEI310_BUTTONS[name];
    if (!slot) {
      throw new Sensei310ProtocolError(`Unknown SteelSeries Sensei 310 button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        const target = SENSEI310_BUTTONS[action.target];
        if (!target) {
          throw new Sensei310ProtocolError(`Unknown SteelSeries Sensei 310 button "${action.target}".`);
        }
        packet[offset] = target.id;
        break;
      }
      case "disabled": {
        packet[offset] = SENSEI310_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = SENSEI310_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = SENSEI310_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = SENSEI310_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Sensei310ProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = SENSEI310_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Sensei310ProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = SENSEI310_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new Sensei310ProtocolError("Unsupported SteelSeries Sensei 310 button action.");
      }
    }
  }

  return new Uint8Array([...SENSEI310_COMMAND.buttonsMapping, ...packet]);
}
