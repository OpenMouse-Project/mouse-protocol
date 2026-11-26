/**
 * SteelSeries Sensei Pro / Rival Pro configuration protocol — pure encode helpers.
 *
 * Reconstructed from the vendor's own software, not from a third-party
 * reimplementation: SteelSeries GG 121.0.0 ships per-device Lisp
 * specifications under `apps/engine/install/deviceSpecifications/`, and this
 * module transcribes `sensei_rival_pro_shared.lisp` (plus the `dongle` and
 * `base_station` files for product ids). Those files are OpenPGP-armored
 * ("DESCRIPTOR" armor, SKESK/AES-128); the bytes below are the documented
 * HID report payloads, not guesses. No other public implementation of this
 * protocol family was available to corroborate against — rivalcfg does not
 * cover these mice — so treat every byte as vendor-documented but not yet
 * hardware-verified.
 *
 * The four models (Sensei Pro, Sensei Pro Mini, Rival Pro, Rival Pro Mini)
 * share one specification: the mouse reports its model and color itself
 * (`read_device_model` / `read_color_spin`, `translate_device_model`
 * 0 = sensei_pro, 1 = sensei_pro_mini, 2 = rival_pro, 3 = rival_pro_mini).
 * The host talks to the base station (`1038:1880`) or the dongle
 * (`1038:1882`); individual mouse USB product ids are not listed in the
 * shipped specification, so only the station and dongle ids are registered
 * in `./devices.ts`.
 *
 * Every command is an HID **output report** with report id 0x00, 65-byte
 * reports (`chunk HIDIO 65` throughout the specification).
 *
 * DPI is carried as raw little-endian uint16 values — there is no sensor
 * lookup table in this family (unlike TrueMove Core/Air). Each of the 5
 * presets is one 6-byte `mouse_sensitivity` struct: x_dpi (2 bytes),
 * y_dpi (2 bytes), lift_off_distance (1 byte), landing_distance (1 byte).
 * The specification fixes `num_dpi_levels` to the 0x01–0x05 range and the
 * selected `index` to 0x00–0x04 (0-based), and its own write-success handler
 * reads back all five 6-byte slots, so this codec always writes full
 * five-preset tables rather than guessing at padding for shorter ones.
 * No DPI minimum or maximum appears in the specification; the 1–65000 range
 * accepted here follows SteelSeries' advertised range (42K sensor, GG
 * allows up to 65K per contemporary reviews) and is flagged as such — it is
 * not a vendor-file claim.
 *
 * Polling uses SteelSeries' dual-rate scheme: every level carries a sensor
 * report rate and a polling rate side by side. The specification's own
 * `translate_polling_and_report_rate_to_ui` maps value bytes to hertz:
 * 0→8000, 1→4000, 2→2000, 3→1000, 4→500, 5→250, 6→125. The single-setting
 * command (`0x2C`) takes an `index` (0–4) plus one `rate` byte; the batch
 * command (`0x2D`) takes `num_levels` (1–5), an `index` (0–4), and five
 * `{report_rate, polling_rate}` profile pairs, with the same full-table
 * policy as DPI: exactly five profiles are written.
 *
 * Buttons are one 40-byte packet (8 slots × 5-byte `key_mapping` fields:
 * function byte plus 4 key-code bytes), command `0x2A`: 6 physical buttons
 * plus scroll up/down. Keyboard (`0x51`) and multimedia (`0x61`) targets
 * take raw code bytes — the specification names no key tables, so unlike
 * some sibling families there is nothing to corroborate names against.
 * Scroll-up/scroll-down are valid remap targets but, as in the sibling
 * families, only physical buttons are remap sources here.
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is hardware evidence and a reason to ship them:
 *
 * - `0xB4` — read back the DPI preset table (same 5×6-byte layout).
 * - `0xAC` / `0xAD` — read back the single/batch polling configuration.
 * - `0xAA` — read back the button mapping (`command_status` + slots).
 * - `0x92` — battery status read; `0x29` — sleep timer (uint32 ms);
 *   `0xA5` — LED indicator (DPI-level colors) read.
 * - High-efficiency mode, wireless stability, mouse rotation, acceleration
 *   tables, scroll jump, motion sync, LAN mode (`0x15`–`0x17`, `0x95`–`0x97`,
 *   `0xBE`), and the base-station/dongle management commands.
 *
 * The mice expose no configurable RGB lighting — only the DPI-level
 * indicator LED — so this family has no lighting encoder by design, not by
 * omission. Settings apply on write; the save command (`0x09`, one byte)
 * persists them. None of this has been verified on physical hardware by
 * this project.
 */

export const SENSEI_RIVAL_PRO_REPORT_ID = 0x00;

/** Command prefixes; the payload is the prefix plus its arguments. */
export const SENSEI_RIVAL_PRO_COMMAND = {
  dpiPresets: [0x34],
  pollingRate: [0x2c],
  pollingBatch: [0x2d],
  buttonsMapping: [0x2a],
  /** `0xB4` — read back the DPI table; documented, not decoded here. */
  dpiPresetsQuery: [0xb4],
  /** `0xAC` — read back the single polling rate; documented, not decoded here. */
  pollingRateQuery: [0xac],
  /** `0xAD` — read back the batch polling table; documented, not decoded here. */
  pollingBatchQuery: [0xad],
  /** `0xAA` — read back the button mapping; documented, not decoded here. */
  buttonsMappingQuery: [0xaa],
} as const;

/** `0x09` — one byte; commit the current settings to onboard flash. */
export const SENSEI_RIVAL_PRO_SAVE_COMMAND = [0x09] as const;

export const SENSEI_RIVAL_PRO_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

/**
 * The specification's `translate_polling_and_report_rate_to_ui` table,
 * verbatim: 0→8000, 1→4000, 2→2000, 3→1000, 4→500, 5→250, 6→125.
 */
const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [8000, 0x00],
  [4000, 0x01],
  [2000, 0x02],
  [1000, 0x03],
  [500, 0x04],
  [250, 0x05],
  [125, 0x06],
]);

/**
 * No DPI bounds appear in the specification (raw uint16 per axis). The
 * 1–65000 range follows SteelSeries' advertised range for these mice (42K
 * sensor; GG accepts up to 65K per contemporary reviews) — it is not a
 * vendor-file claim, and out-of-range values are rejected rather than
 * clamped so a caller is never silently given a different sensitivity.
 */
export const SENSEI_RIVAL_PRO_DPI_MIN = 1;
export const SENSEI_RIVAL_PRO_DPI_MAX = 65000;
export const SENSEI_RIVAL_PRO_DPI_PRESETS = 5;

/** Factory defaults (400/800/1600/2400/3200) per SteelSeries support. */
export const SENSEI_RIVAL_PRO_DEFAULT_DPI_PRESETS = [400, 800, 1600, 2400, 3200] as const;

/**
 * UI DPI options: 50–65000 in 50 DPI steps. The wire format accepts any
 * 1–65000 integer; this list is only a picker hint following the 50-step
 * convention of the other linear SteelSeries families.
 */
export function steelseriesSenseiRivalProDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = 50; dpi <= SENSEI_RIVAL_PRO_DPI_MAX; dpi += 50) {
    options.push(dpi);
  }
  return options;
}

export class SenseiRivalProProtocolError extends Error {}

/** One DPI preset: independent X/Y sensitivity plus lift-off/landing distances. */
export interface SenseiRivalProDpiPreset {
  x: number;
  y: number;
  /** Lift-off distance byte; no vendor range — passed through. */
  liftOffDistance: number;
  /** Landing distance byte; no vendor range — passed through. */
  landingDistance: number;
}

function checkByte(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new SenseiRivalProProtocolError(`${what} must be an integer 0–255.`);
  }
  return value;
}

function checkDpi(value: number): void {
  if (!Number.isInteger(value) || value < SENSEI_RIVAL_PRO_DPI_MIN || value > SENSEI_RIVAL_PRO_DPI_MAX) {
    throw new SenseiRivalProProtocolError(
      `SteelSeries Sensei Pro / Rival Pro DPI must be ${SENSEI_RIVAL_PRO_DPI_MIN}–${SENSEI_RIVAL_PRO_DPI_MAX.toLocaleString("en-US")}.`,
    );
  }
}

function encodePreset(preset: SenseiRivalProDpiPreset): number[] {
  checkDpi(preset.x);
  checkDpi(preset.y);
  checkByte(preset.liftOffDistance, "Lift-off distance");
  checkByte(preset.landingDistance, "Landing distance");
  return [
    preset.x & 0xff, (preset.x >> 8) & 0xff,
    preset.y & 0xff, (preset.y >> 8) & 0xff,
    preset.liftOffDistance, preset.landingDistance,
  ];
}

/**
 * `34 <count 1–5> <selected 0-based> <5× (x u16LE, y u16LE, lod, lad)>` —
 * replaces the mouse's whole preset table. The specification's write-success
 * handler always reads back all five 6-byte slots, so exactly five presets
 * are required; `selectedIndex` is 0-based here and on the wire.
 */
export function steelseriesSenseiRivalProEncodeDpiPresets(
  presets: readonly SenseiRivalProDpiPreset[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length !== SENSEI_RIVAL_PRO_DPI_PRESETS) {
    throw new SenseiRivalProProtocolError(
      `SteelSeries Sensei Pro / Rival Pro requires exactly ${SENSEI_RIVAL_PRO_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new SenseiRivalProProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  return new Uint8Array([
    ...SENSEI_RIVAL_PRO_COMMAND.dpiPresets,
    presets.length,
    selectedIndex,
    ...presets.flatMap(encodePreset),
  ]);
}

function pollingRateToByte(pollingRateHz: number): number {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new SenseiRivalProProtocolError(
      `SteelSeries Sensei Pro / Rival Pro supports ${SENSEI_RIVAL_PRO_POLLING_RATES.join(", ")} Hz polling.`,
    );
  }
  return byte;
}

/**
 * `2C <index 0–4> <rate>` — one polling level. The same value byte selects
 * both the polling and the sensor report rate scales.
 */
export function steelseriesSenseiRivalProEncodePollingRate(
  index: number,
  pollingRateHz: number,
): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 4) {
    throw new SenseiRivalProProtocolError("SteelSeries Sensei Pro / Rival Pro polling index must be 0–4.");
  }
  return new Uint8Array([...SENSEI_RIVAL_PRO_COMMAND.pollingRate, index, pollingRateToByte(pollingRateHz)]);
}

/** One performance profile: sensor report rate plus polling rate. */
export interface SenseiRivalProPollingProfile {
  reportRateHz: number;
  pollingRateHz: number;
}

/**
 * `2D <count=5> <selected 0–4> <5× (report byte, polling byte)>` — the
 * whole polling table. Exactly five profiles are required, matching what
 * the specification reads back.
 */
export function steelseriesSenseiRivalProEncodePollingBatch(
  profiles: readonly SenseiRivalProPollingProfile[],
  selectedIndex: number,
): Uint8Array {
  if (profiles.length !== SENSEI_RIVAL_PRO_DPI_PRESETS) {
    throw new SenseiRivalProProtocolError(
      "SteelSeries Sensei Pro / Rival Pro requires exactly 5 polling profiles.",
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= profiles.length) {
    throw new SenseiRivalProProtocolError("Selected polling profile must be an index into the 5 profiles being written.");
  }
  return new Uint8Array([
    ...SENSEI_RIVAL_PRO_COMMAND.pollingBatch,
    profiles.length,
    selectedIndex,
    ...profiles.flatMap((profile) => [
      pollingRateToByte(profile.reportRateHz),
      pollingRateToByte(profile.pollingRateHz),
    ]),
  ]);
}

/** `09` — commit the current settings to onboard flash. */
export function steelseriesSenseiRivalProSaveCommand(): Uint8Array {
  return new Uint8Array(SENSEI_RIVAL_PRO_SAVE_COMMAND);
}

// -- Button mapping --------------------------------------------------------

/** `key_mapping.function` values from the specification. */
export const SENSEI_RIVAL_PRO_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  scrollUp: { id: 0x31, offset: 0x1e },
  scrollDown: { id: 0x32, offset: 0x23 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type SenseiRivalProButtonName = keyof typeof SENSEI_RIVAL_PRO_BUTTONS;

const BUTTON_FIELD_LENGTH = 5;
const BUTTON_DISABLE = 0x00;
const BUTTON_DPI_SWITCH = 0x30;
const BUTTON_KEYBOARD = 0x51;
const BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. The specification names no keyboard/multimedia key
 * tables, so those targets are raw code bytes. `0x71` (macro) is marked
 * not supported by the specification and is rejected.
 */
export type SenseiRivalProButtonAction =
  | { type: "button"; target: SenseiRivalProButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new SenseiRivalProProtocolError(`${kind} codes must be integers 0–255.`);
  }
  return code;
}

/**
 * `2A` + one 40-byte packet (8 buttons × 5-byte fields: function byte plus
 * 4 key-code bytes), zero-filled except where a mapping is given. Pass
 * every button explicitly — unmapped buttons are left disabled, never
 * defaulted, so a partial mapping cannot silently wipe the rest.
 */
export function steelseriesSenseiRivalProEncodeButtonsMapping(
  mapping: Partial<Record<SenseiRivalProButtonName, SenseiRivalProButtonAction>>,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(SENSEI_RIVAL_PRO_BUTTONS, name)) {
      throw new SenseiRivalProProtocolError(`Unknown SteelSeries Sensei Pro / Rival Pro button "${name}".`);
    }
  }

  const names = Object.keys(SENSEI_RIVAL_PRO_BUTTONS) as SenseiRivalProButtonName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[SenseiRivalProButtonName, SenseiRivalProButtonAction]>) {
    const { offset } = SENSEI_RIVAL_PRO_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(SENSEI_RIVAL_PRO_BUTTONS, action.target)) {
          throw new SenseiRivalProProtocolError(`Unknown SteelSeries Sensei Pro / Rival Pro button "${action.target}".`);
        }
        packet[offset] = SENSEI_RIVAL_PRO_BUTTONS[action.target].id;
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
      case "scrollUp": {
        packet[offset] = SENSEI_RIVAL_PRO_BUTTONS.scrollUp.id;
        break;
      }
      case "scrollDown": {
        packet[offset] = SENSEI_RIVAL_PRO_BUTTONS.scrollDown.id;
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
        throw new SenseiRivalProProtocolError("Unsupported SteelSeries Sensei Pro / Rival Pro button action.");
      }
    }
  }

  return new Uint8Array([...SENSEI_RIVAL_PRO_COMMAND.buttonsMapping, ...packet]);
}
