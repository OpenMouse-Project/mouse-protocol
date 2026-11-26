/**
 * SteelSeries Aerox 3 Wireless Gen 2 configuration protocol — pure
 * encode/decode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships
 * `aerox_3_wireless_gen2_{mouse,dongle,shared}.lisp` under
 * `apps/engine/install/deviceSpecifications/`, and this module transcribes
 * them. Those files are OpenPGP-armored ("DESCRIPTOR" armor, SKESK/AES-128);
 * the bytes below are the documented HID report payloads, not guesses. No
 * other public implementation of this protocol was available to corroborate
 * against — rivalcfg has no Aerox 3 Wireless Gen 2 profile — so treat every
 * byte as vendor-documented but not yet hardware-verified.
 *
 * Despite the shared "Aerox 3 Wireless" name this is a different command
 * set from the Gen 1 (`./aerox3-wireless.ts`: one-byte TrueMove Air DPI
 * `0x2D`, polling `0x2B` with values `00–03`, sleep/dim timers, fixed
 * rainbow enable). Gen 2 carries raw-uint16 XY DPI with per-preset
 * lift-off, split wired/wireless polling rates, and a different lighting
 * and power scheme. Do not reuse the Gen 1 module.
 *
 * Transports share one module via the usual SteelSeries wireless
 * transform: the mouse (`1038:1892`) uses command bytes as documented, and
 * the 2.4 GHz dongle (`1038:1890`) ORs `0b01000000` into byte 0 of every
 * command (`applyAerox3WirelessGen2Flag`), confirmed by diffing the
 * mouse/dongle specification files, not assumed from precedent.
 *
 * Every command is an HID **output report** with report id 0x00 (65-byte
 * reports throughout the specification).
 *
 * DPI uses an XY batch (`0x2D`): `num_dpi_levels` (0x01–0x05), `index`
 * (0x00–0x04, 0-based), then five 5-byte `mouse_sensitivity` structs (x
 * uint16LE, y uint16LE, lift_off_distance uint8). Values are raw uint16 —
 * no sensor lookup table. The specification states no DPI bounds; the
 * 100–26000 range accepted here follows the TrueMove 26K sensor cap and
 * the 100-DPI floor of every other modern SteelSeries family, and is
 * flagged as such rather than as a vendor-file claim. The lift-off byte
 * has no documented range and is passed through. The specification always
 * carries all five structs, so this codec requires exactly five presets
 * rather than guessing at padding for shorter tables.
 *
 * Polling (`0x2B`) carries separate `wireless_rate` (0x00–0x05) and
 * `wired_rate` (0x02–0x05) bytes plus a 300 ms settle delay, with a
 * read-back (`0xAB`, same fields). No value→Hz table appears in the
 * specification; the mapping used here (0→4000, 1→2000, 2→1000, 3→500,
 * 4→250, 5→125) is inferred from two facts: the mouse is advertised as 4K
 * wireless, and the wired range starts one step in (02), which only makes
 * sense if 02 is 1000 Hz — flag it as inference, not a file claim.
 *
 * Buttons are one 40-byte packet (8 slots × 5-byte fields: 6 physical
 * buttons plus scroll up/down), command `0x2A`, with a read-back (`0xAA`)
 * defined but not decoded here.
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is hardware evidence and a reason to ship them:
 *
 * - The 3-zone lighting commands (`direct_write`/`write_all_illumination`
 *   `0x21`, `lighting_settings` `0x23` + read `0xA3`, restart/disable
 *   `0x24`, idle `0x25`, `read_color_spin` `0xBE`). There is no default or
 *   reactive lighting on this mouse, unlike Gen 1.
 * - `high_efficiency_mode` (`0x28` + read `0xA8`), `wireless_stability`
 *   (`0x15` + read `0x95`), angle snapping / mouse rotation / scroll jump /
 *   acceleration tables (`0x16`/`0x17` + reads `0x96`/`0x97`).
 * - `restore_factory_default` (`0x91`).
 *
 * Settings apply immediately; the save command (`11 00`) persists them to
 * onboard flash. None of this has been verified on physical hardware by
 * this project.
 */

const WIRELESS_FLAG = 0b01000000;

/** Wired (mouse-mode) command bytes; see `applyAerox3WirelessGen2Flag` for dongle mode. */
export const AEROX3_WIRELESS_GEN2_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  buttonsMapping: [0x2a],
  batteryLevel: [0x92],
  firmware: [0x90, 0x00],
  save: [0x11, 0x00],
} as const;

export const AEROX3_WIRELESS_GEN2_REPORT_ID = 0x00;

/**
 * Dongle-mode transform: OR `0b01000000` into the command's first byte.
 * Pass the wired-mode command bytes; returns the 2.4 GHz-mode equivalent.
 */
export function applyAerox3WirelessGen2Flag(command: readonly number[]): number[] {
  if (command.length === 0) {
    throw new Aerox3WirelessGen2ProtocolError("Cannot apply the wireless flag to an empty command.");
  }
  return [command[0]! | WIRELESS_FLAG, ...command.slice(1)];
}

function frame(command: readonly number[], wireless: boolean): number[] {
  return wireless ? applyAerox3WirelessGen2Flag(command) : [...command];
}

/**
 * Inferred value map (see the module doc comment): 0→4000, 1→2000,
 * 2→1000, 3→500, 4→250, 5→125. The wireless field accepts all six; the
 * wired field accepts 2–5 (1000 Hz and below).
 */
export const AEROX3_WIRELESS_GEN2_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [4000, 0x00],
  [2000, 0x01],
  [1000, 0x02],
  [500, 0x03],
  [250, 0x04],
  [125, 0x05],
]);

/** No DPI bounds appear in the specification; see the module doc comment. */
export const AEROX3_WIRELESS_GEN2_DPI_MIN = 100;
export const AEROX3_WIRELESS_GEN2_DPI_MAX = 26000;
export const AEROX3_WIRELESS_GEN2_DPI_STEP = 100;
export const AEROX3_WIRELESS_GEN2_MAX_DPI_PRESETS = 5;
export const AEROX3_WIRELESS_GEN2_BATTERY_RESPONSE_LENGTH = 2;
export const AEROX3_WIRELESS_GEN2_FIRMWARE_RESPONSE_LENGTH = 12;

/** Common factory table shared across the modern SteelSeries families. */
export const AEROX3_WIRELESS_GEN2_DEFAULT_DPI_PRESETS = [400, 800, 1600, 2400, 3200] as const;
export const AEROX3_WIRELESS_GEN2_DEFAULT_POLLING_RATE = 1000;

export class Aerox3WirelessGen2ProtocolError extends Error {}

/** One DPI preset: independent X/Y sensitivities plus lift-off distance. */
export interface Aerox3WirelessGen2DpiPreset {
  x: number;
  y: number;
  /** Lift-off distance byte; no vendor range — passed through. */
  liftOffDistance: number;
}

/** UI DPI options: 100–26000 in 100 DPI steps (see bounds disclosure above). */
export function steelseriesAerox3WirelessGen2DpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = AEROX3_WIRELESS_GEN2_DPI_MIN; dpi <= AEROX3_WIRELESS_GEN2_DPI_MAX; dpi += AEROX3_WIRELESS_GEN2_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

function checkDpi(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < AEROX3_WIRELESS_GEN2_DPI_MIN ||
    value > AEROX3_WIRELESS_GEN2_DPI_MAX ||
    (value - AEROX3_WIRELESS_GEN2_DPI_MIN) % AEROX3_WIRELESS_GEN2_DPI_STEP !== 0
  ) {
    throw new Aerox3WirelessGen2ProtocolError(
      `SteelSeries Aerox 3 Wireless Gen 2 DPI must be ${AEROX3_WIRELESS_GEN2_DPI_MIN}–${AEROX3_WIRELESS_GEN2_DPI_MAX.toLocaleString("en-US")} in ${AEROX3_WIRELESS_GEN2_DPI_STEP} DPI steps.`,
    );
  }
}

function checkByte(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Aerox3WirelessGen2ProtocolError(`${what} must be an integer 0–255.`);
  }
  return value;
}

function encodePreset(preset: Aerox3WirelessGen2DpiPreset): number[] {
  checkDpi(preset.x);
  checkDpi(preset.y);
  checkByte(preset.liftOffDistance, "Lift-off distance");
  return [
    preset.x & 0xff, (preset.x >> 8) & 0xff,
    preset.y & 0xff, (preset.y >> 8) & 0xff,
    preset.liftOffDistance,
  ];
}

/**
 * `2D <count 1–5> <selected 0-based> <5× (x u16LE, y u16LE, lod)>` —
 * replaces the mouse's whole preset table. Exactly five presets are
 * required (see the module doc comment).
 */
export function steelseriesAerox3WirelessGen2EncodeDpiPresets(
  presets: readonly Aerox3WirelessGen2DpiPreset[],
  selectedIndex: number,
  wireless: boolean,
): Uint8Array {
  if (presets.length !== AEROX3_WIRELESS_GEN2_MAX_DPI_PRESETS) {
    throw new Aerox3WirelessGen2ProtocolError(
      `SteelSeries Aerox 3 Wireless Gen 2 requires exactly ${AEROX3_WIRELESS_GEN2_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Aerox3WirelessGen2ProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  return new Uint8Array([
    ...frame(AEROX3_WIRELESS_GEN2_COMMAND.dpiPresets, wireless),
    presets.length,
    selectedIndex,
    ...presets.flatMap(encodePreset),
  ]);
}

function pollingRateToByte(pollingRateHz: number): number {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Aerox3WirelessGen2ProtocolError(
      `SteelSeries Aerox 3 Wireless Gen 2 supports ${AEROX3_WIRELESS_GEN2_POLLING_RATES.join(", ")} Hz polling.`,
    );
  }
  return byte;
}

/**
 * `2B <wireless rate> <wired rate>` — one polling level for each transport.
 * Rates above 1000 Hz exceed the wired field's range, so the wired byte is
 * capped at 1000 Hz; both assumptions are flagged in the module doc
 * comment.
 */
export function steelseriesAerox3WirelessGen2EncodePollingRate(
  wirelessHz: number,
  wiredHz: number,
  wireless: boolean,
): Uint8Array {
  const wirelessByte = pollingRateToByte(wirelessHz);
  const wiredByte = pollingRateToByte(wiredHz);
  if (wiredByte < 0x02) {
    throw new Aerox3WirelessGen2ProtocolError(
      "SteelSeries Aerox 3 Wireless Gen 2 wired rate must be 1000 Hz or below.",
    );
  }
  return new Uint8Array([...frame(AEROX3_WIRELESS_GEN2_COMMAND.pollingRate, wireless), wirelessByte, wiredByte]);
}

/** Convenience form: one rate for wireless, capped at 1000 Hz for wired. */
export function steelseriesAerox3WirelessGen2EncodePollingRateSingle(
  pollingRateHz: number,
  wireless: boolean,
): Uint8Array {
  const byte = pollingRateToByte(pollingRateHz);
  return steelseriesAerox3WirelessGen2EncodePollingRate(
    pollingRateHz,
    byte < 0x02 ? 1000 : pollingRateHz,
    wireless,
  );
}

/** `11 00` wired / `51 00` dongle — commit the current settings to onboard flash. */
export function steelseriesAerox3WirelessGen2SaveCommand(wireless: boolean): Uint8Array {
  return new Uint8Array(frame(AEROX3_WIRELESS_GEN2_COMMAND.save, wireless));
}

/** `92` / `D2` — answered by a two-byte input report. */
export function steelseriesAerox3WirelessGen2BatteryQuery(wireless: boolean): Uint8Array {
  return new Uint8Array(frame(AEROX3_WIRELESS_GEN2_COMMAND.batteryLevel, wireless));
}

export interface Aerox3WirelessGen2Battery {
  /** Battery percentage, reported directly. */
  level: number;
  /** Charging/status byte, passed through — its encoding is undocumented. */
  status: number;
}

/**
 * Decode the two-byte battery reply (`battery_status`, `battery_value`).
 * The value is a direct percentage (the specification forwards it to the
 * UI unchanged); the status byte's encoding is undocumented, so it is
 * returned raw and must not be interpreted as a charging flag.
 */
export function steelseriesAerox3WirelessGen2DecodeBattery(payload: Uint8Array): Aerox3WirelessGen2Battery {
  if (payload.length < AEROX3_WIRELESS_GEN2_BATTERY_RESPONSE_LENGTH) {
    throw new Aerox3WirelessGen2ProtocolError(
      "SteelSeries Aerox 3 Wireless Gen 2 battery response is shorter than two bytes.",
    );
  }
  return { level: payload[1]!, status: payload[0]! };
}

/** `90 00` / `D0 00` — the device answers with a 12-byte version string. */
export function steelseriesAerox3WirelessGen2FirmwareQuery(wireless: boolean): Uint8Array {
  return new Uint8Array(frame(AEROX3_WIRELESS_GEN2_COMMAND.firmware, wireless));
}

/** Decode the 12-byte firmware version reply as ASCII, stopping at the first NUL. */
export function steelseriesAerox3WirelessGen2DecodeFirmware(payload: Uint8Array): string {
  if (payload.length < AEROX3_WIRELESS_GEN2_FIRMWARE_RESPONSE_LENGTH) {
    throw new Aerox3WirelessGen2ProtocolError("SteelSeries Aerox 3 Wireless Gen 2 firmware response is shorter than 12 bytes.");
  }
  const bytes = payload.slice(0, AEROX3_WIRELESS_GEN2_FIRMWARE_RESPONSE_LENGTH);
  const nul = bytes.indexOf(0x00);
  return new TextDecoder("ascii").decode(nul === -1 ? bytes : bytes.slice(0, nul));
}

// -- Button mapping --------------------------------------------------------

/** 6 physical buttons plus scroll up/down (8 slots). */
export const AEROX3_WIRELESS_GEN2_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  scrollUp: { id: 0x31, offset: 0x1e },
  scrollDown: { id: 0x32, offset: 0x23 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Aerox3WirelessGen2ButtonName = keyof typeof AEROX3_WIRELESS_GEN2_BUTTONS;

const BUTTON_FIELD_LENGTH = 5;
const BUTTON_DISABLE = 0x00;
const BUTTON_DPI_SWITCH = 0x30;
const BUTTON_KEYBOARD = 0x51;
const BUTTON_MULTIMEDIA = 0x61;

export type Aerox3WirelessGen2ButtonAction =
  | { type: "button"; target: Aerox3WirelessGen2ButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Aerox3WirelessGen2ProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `2A` + one 40-byte packet (8 slots × 5-byte fields), zero-filled except
 * where a mapping is given. Pass every button explicitly — unmapped buttons
 * stay disabled, matching this package's no-silent-defaults policy.
 */
export function steelseriesAerox3WirelessGen2EncodeButtonsMapping(
  mapping: Partial<Record<Aerox3WirelessGen2ButtonName, Aerox3WirelessGen2ButtonAction>>,
  wireless: boolean,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(AEROX3_WIRELESS_GEN2_BUTTONS, name)) {
      throw new Aerox3WirelessGen2ProtocolError(`Unknown SteelSeries Aerox 3 Wireless Gen 2 button "${name}".`);
    }
  }

  const names = Object.keys(AEROX3_WIRELESS_GEN2_BUTTONS) as Aerox3WirelessGen2ButtonName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Aerox3WirelessGen2ButtonName, Aerox3WirelessGen2ButtonAction]>) {
    const { offset } = AEROX3_WIRELESS_GEN2_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(AEROX3_WIRELESS_GEN2_BUTTONS, action.target)) {
          throw new Aerox3WirelessGen2ProtocolError(`Unknown SteelSeries Aerox 3 Wireless Gen 2 button "${action.target}".`);
        }
        packet[offset] = AEROX3_WIRELESS_GEN2_BUTTONS[action.target].id;
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
        throw new Aerox3WirelessGen2ProtocolError("Unsupported SteelSeries Aerox 3 Wireless Gen 2 button action.");
      }
    }
  }

  return new Uint8Array([...frame(AEROX3_WIRELESS_GEN2_COMMAND.buttonsMapping, wireless), ...packet]);
}
