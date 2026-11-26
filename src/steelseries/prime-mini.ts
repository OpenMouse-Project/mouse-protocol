/**
 * SteelSeries Prime Mini configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships `prime_mini.lisp` under
 * `apps/engine/install/deviceSpecifications/`, and this module transcribes
 * it. Those files are OpenPGP-armored ("DESCRIPTOR" armor, SKESK/AES-128);
 * the bytes below are the documented HID report payloads, not guesses.
 * Do not confuse this wired-only mouse (`1038:184D`) with the Prime Mini
 * Wireless (`1038:184A`/`1038:1848`, family `"prime-mini-wireless"`),
 * which shares the plain Prime Wireless command set — see
 * `./prime-mini-wireless.ts`. No other public implementation of this
 * protocol was available to corroborate against, so treat every byte as
 * vendor-documented but not yet hardware-verified.
 *
 * Every command is an HID **output report** with report id 0x00 (65-byte
 * reports throughout the specification).
 *
 * DPI uses a 5-preset batch (`0x2D`): `level_max` (1–5), `active_level`
 * (0–4, 0-based), then five uint16 little-endian factors, each multiplied
 * by 50 (`DPI = factor × 50`, range factor 1–360, i.e. 50–18000 DPI). The
 * specification always carries all five slots, so this codec requires
 * exactly five presets rather than guessing at padding for shorter tables.
 * The factory table is 400/800/1200/2400/3200 (sensor bytes 8/16/24/48/64
 * in the GG seed data).
 *
 * Polling (`0x2B`, values 1000→0x01, 500→0x02, 250→0x03, 125→0x04) has a
 * read-back (`0xAB`, same values), defined but not decoded here. Buttons
 * are one 40-byte packet (8 slots × 5-byte fields), command `0x2A`: the
 * vendor frontend always forces the 6th slot to DPI-switch and only exposes
 * 5 remappable buttons plus scroll, so this codec defaults that slot to
 * DPI-switch while still encoding an explicit caller override verbatim.
 *
 * Lighting is a single zone: color (`0x21`, zone byte `0x00` + RGB),
 * brightness (`0x23`, 0–100), default lighting (`0x27`, off/rainbow) with a
 * read-back, and reset (`0x22`).
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is hardware evidence and a reason to ship them:
 *
 * - `0xAB` — polling read-back; `0x27` — default-lighting read-back.
 * - `0x90 0x00` — firmware version (15-byte string reply); implemented as
 *   query + decoder below because the driver needs a connectivity probe.
 * - Accelerometer/deceleration, angle snapping, sleep timers: driver-side
 *   (`SSE`) settings, not HID commands, out of scope for this codec.
 *
 * Settings apply immediately; the save command (`0x11`, one byte — no
 * `0x00` suffix, unlike Aerox's `11 00`) persists them to onboard flash.
 * None of this has been verified on physical hardware by this project.
 */

export const PRIME_MINI_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const PRIME_MINI_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  buttonsMapping: [0x2a],
  ledBrightness: [0x23],
  defaultLighting: [0x27],
  zoneColor: [0x21],
  resetLighting: [0x22],
  firmware: [0x90, 0x00],
} as const;

/** `0xAB` — polling read-back; documented, not decoded here. */
export const PRIME_MINI_POLLING_QUERY = [0xab] as const;

/** `0x11` — one byte, no suffix. Distinct from Aerox's two-byte `11 00`. */
export const PRIME_MINI_SAVE_COMMAND = [0x11] as const;

export const PRIME_MINI_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

/** DPI = factor × 50; factor 1–360, i.e. 50–18000 DPI in 50 DPI steps. */
export const PRIME_MINI_DPI_MIN = 50;
export const PRIME_MINI_DPI_MAX = 18000;
export const PRIME_MINI_DPI_STEP = 50;
export const PRIME_MINI_MAX_DPI_PRESETS = 5;
export const PRIME_MINI_FIRMWARE_RESPONSE_LENGTH = 15;

/** Factory table from the GG seed data (sensor bytes 8/16/24/48/64). */
export const PRIME_MINI_DEFAULT_DPI_PRESETS = [400, 800, 1200, 2400, 3200] as const;
export const PRIME_MINI_DEFAULT_POLLING_RATE = 1000;

export class PrimeMiniProtocolError extends Error {}

/** Every DPI value the factor encoding can express, ascending. */
export function steelseriesPrimeMiniDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = PRIME_MINI_DPI_MIN; dpi <= PRIME_MINI_DPI_MAX; dpi += PRIME_MINI_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

function encodeDpiFactor(dpi: number): [number, number] {
  if (
    !Number.isInteger(dpi) ||
    dpi < PRIME_MINI_DPI_MIN ||
    dpi > PRIME_MINI_DPI_MAX ||
    (dpi - PRIME_MINI_DPI_MIN) % PRIME_MINI_DPI_STEP !== 0
  ) {
    throw new PrimeMiniProtocolError(
      `SteelSeries Prime Mini DPI must be ${PRIME_MINI_DPI_MIN}–${PRIME_MINI_DPI_MAX.toLocaleString("en-US")} in ${PRIME_MINI_DPI_STEP} DPI steps.`,
    );
  }
  const factor = dpi / PRIME_MINI_DPI_STEP;
  return [factor & 0xff, (factor >> 8) & 0xff];
}

/**
 * `2D <count 1–5> <selected 0-based> <5× u16LE factor>` — replaces the
 * mouse's whole preset table. Exactly five presets are required (see the
 * module doc comment); `selectedIndex` is 0-based here and on the wire.
 */
export function steelseriesPrimeMiniEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length !== PRIME_MINI_MAX_DPI_PRESETS) {
    throw new PrimeMiniProtocolError(
      `SteelSeries Prime Mini requires exactly ${PRIME_MINI_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new PrimeMiniProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  return new Uint8Array([
    ...PRIME_MINI_COMMAND.dpiPresets,
    presets.length,
    selectedIndex,
    ...presets.flatMap(encodeDpiFactor),
  ]);
}

/** `2B <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesPrimeMiniEncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new PrimeMiniProtocolError("SteelSeries Prime Mini supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...PRIME_MINI_COMMAND.pollingRate, byte]);
}

/** `11` — commit the current settings to onboard flash. */
export function steelseriesPrimeMiniSaveCommand(): Uint8Array {
  return new Uint8Array(PRIME_MINI_SAVE_COMMAND);
}

/** `90 00` — the device answers with a 15-byte version string. */
export function steelseriesPrimeMiniFirmwareQuery(): Uint8Array {
  return new Uint8Array(PRIME_MINI_COMMAND.firmware);
}

/**
 * Decode the 15-byte firmware version reply as ASCII, stopping at the
 * first NUL. The string shape (dotted version text) follows the
 * specification's `version_str bytearray (size 15)` field; trailing
 * padding is not part of the version.
 */
export function steelseriesPrimeMiniDecodeFirmware(payload: Uint8Array): string {
  if (payload.length < PRIME_MINI_FIRMWARE_RESPONSE_LENGTH) {
    throw new PrimeMiniProtocolError("SteelSeries Prime Mini firmware response is shorter than 15 bytes.");
  }
  const bytes = payload.slice(0, PRIME_MINI_FIRMWARE_RESPONSE_LENGTH);
  const nul = bytes.indexOf(0x00);
  const text = new TextDecoder("ascii").decode(nul === -1 ? bytes : bytes.slice(0, nul));
  return text;
}

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new PrimeMiniProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

/** `21 00 <r> <g> <b>` — the single LED zone color. */
export function steelseriesPrimeMiniEncodeZoneColor(r: number, g: number, b: number): Uint8Array {
  return new Uint8Array([...PRIME_MINI_COMMAND.zoneColor, 0x00, ...encodeRgb(r, g, b)]);
}

/** `23 <v>` — LED brightness, linear 0–100 passthrough. */
export function steelseriesPrimeMiniEncodeLedBrightness(percent: number): Uint8Array {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new PrimeMiniProtocolError("SteelSeries Prime Mini LED brightness must be an integer 0–100.");
  }
  return new Uint8Array([...PRIME_MINI_COMMAND.ledBrightness, percent]);
}

export const PRIME_MINI_DEFAULT_LIGHTING = {
  off: 0x00,
  rainbow: 0x01,
} as const;

export type PrimeMiniDefaultLighting = keyof typeof PRIME_MINI_DEFAULT_LIGHTING;

/** `27 <v>` — boot lighting: off or rainbow. */
export function steelseriesPrimeMiniEncodeDefaultLighting(mode: PrimeMiniDefaultLighting): Uint8Array {
  const byte = PRIME_MINI_DEFAULT_LIGHTING[mode];
  if (byte === undefined) {
    throw new PrimeMiniProtocolError(
      `SteelSeries Prime Mini default lighting must be one of: ${Object.keys(PRIME_MINI_DEFAULT_LIGHTING).join(", ")}.`,
    );
  }
  return new Uint8Array([...PRIME_MINI_COMMAND.defaultLighting, byte]);
}

/** `22` — reset the lighting to boot defaults. */
export function steelseriesPrimeMiniResetLightingCommand(): Uint8Array {
  return new Uint8Array(PRIME_MINI_COMMAND.resetLighting);
}

// -- Button mapping --------------------------------------------------------

/** `buttons_mapping` slots: 6 physical buttons plus scroll up/down. */
export const PRIME_MINI_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  scrollUp: { id: 0x31, offset: 0x1e },
  scrollDown: { id: 0x32, offset: 0x23 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type PrimeMiniButtonName = keyof typeof PRIME_MINI_BUTTONS;

const BUTTON_FIELD_LENGTH = 5;
const BUTTON_DISABLE = 0x00;
const BUTTON_DPI_SWITCH = 0x30;
const BUTTON_KEYBOARD = 0x51;
const BUTTON_MULTIMEDIA = 0x61;

export type PrimeMiniButtonAction =
  | { type: "button"; target: PrimeMiniButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/** The vendor frontend forces this slot to DPI-switch; the codec default matches. */
export const PRIME_MINI_DEFAULT_BUTTONS: Readonly<Record<PrimeMiniButtonName, PrimeMiniButtonAction>> = {
  button1: { type: "button", target: "button1" },
  button2: { type: "button", target: "button2" },
  button3: { type: "button", target: "button3" },
  button4: { type: "button", target: "button4" },
  button5: { type: "button", target: "button5" },
  button6: { type: "dpiSwitch" },
  scrollUp: { type: "button", target: "scrollUp" },
  scrollDown: { type: "button", target: "scrollDown" },
};

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new PrimeMiniProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `2A` + one 40-byte packet (8 slots × 5-byte fields). Like the Aerox
 * wireless families, a button missing from `mapping` keeps its default
 * action (identity, except the DPI button, which keeps DPI-switch per the
 * vendor frontend's forced mapping), so remapping one button never
 * disables the others. An explicit `button6` entry is encoded verbatim.
 */
export function steelseriesPrimeMiniEncodeButtonsMapping(
  mapping: Partial<Record<PrimeMiniButtonName, PrimeMiniButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(PRIME_MINI_BUTTONS, name)) {
      throw new PrimeMiniProtocolError(`Unknown SteelSeries Prime Mini button "${name}".`);
    }
  }

  const names = Object.keys(PRIME_MINI_BUTTONS) as PrimeMiniButtonName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const name of names) {
    const action = mapping[name] ?? PRIME_MINI_DEFAULT_BUTTONS[name];
    const { offset } = PRIME_MINI_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(PRIME_MINI_BUTTONS, action.target)) {
          throw new PrimeMiniProtocolError(`Unknown SteelSeries Prime Mini button "${action.target}".`);
        }
        packet[offset] = PRIME_MINI_BUTTONS[action.target].id;
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
        throw new PrimeMiniProtocolError("Unsupported SteelSeries Prime Mini button action.");
      }
    }
  }

  return new Uint8Array([...PRIME_MINI_COMMAND.buttonsMapping, ...packet]);
}
