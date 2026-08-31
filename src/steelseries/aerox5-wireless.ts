/**
 * SteelSeries Aerox 5 Wireless configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/aerox5_wireless_wired.py` — the primary source
 *   for every command byte, product id, and default here, for the mouse's
 *   USB-cabled mode (`1038:1854`, plus the Destiny 2 / Diablo IV cosmetic
 *   editions `0x185E`/`0x1862`).
 * - rivalcfg `rivalcfg/devices/aerox5_wireless_wireless.py` — the 2.4 GHz
 *   dongle mode (`1038:1852`, editions `0x185C`/`0x1860`). Read in full: it
 *   is **not** a separate command set, it is `aerox5_wireless_wired.py`'s
 *   settings dict comprehended through one `_patch_command` helper that (1)
 *   ORs `0b01000000` into every command's first byte and (2) adds a 64-byte
 *   `readback_length`. This module implements that same transform
 *   (`applyWirelessFlag`) instead of hand-duplicating the wired-mode byte
 *   tables, so the two PID groups can never drift out of sync the way a
 *   copy-paste would risk.
 * - rivalcfg `rivalcfg/devices/dpi/truemove_air.py` — same TrueMove Air
 *   sensor table as the plain (non-wireless) Aerox 5 — imported from
 *   `./rival3-wireless.ts`'s `TRUEMOVE_AIR_DPI_TO_BYTE`, not re-derived.
 * - rivalcfg `rivalcfg/handlers/multidpi_range_choice.py` — `dpi_length_byte: 1`,
 *   `first_preset: 0` (same as the plain Aerox 5 — **not** 1, unlike Aerox 3
 *   and Rival 3 Wireless).
 * - rivalcfg `rivalcfg/handlers/range.py` — `sleep_timer`/`dim_timer`: linear
 *   range-to-range mapping, 3-byte little-endian output. Traced by hand:
 *   `sleep_timer`'s `output_range` is `[0x000000, 0x124F80, 60000]` against
 *   `input_range` `[0, 20, 1]` (minutes) — `0x124F80` is 1,200,000, i.e.
 *   20 minutes × 60000 ms/min, so the output value is simply
 *   `minutes * 60000` — and `dim_timer`'s `output_range` is the same
 *   `[0x000000, 0x124F80, 1000]` against `input_range` `[0, 1200, 1]`
 *   (seconds), i.e. `seconds * 1000`. Both encode little-endian, 3 bytes
 *   (`range_length_byte: 3`), per `helpers.uint_to_little_endian_bytearray`.
 * - rivalcfg `rivalcfg/handlers/rgbcolor.py` / `reactive_rgbcolor.py` — RGB
 *   value encoding, same as `./aerox3.ts`/`./aerox5.ts`.
 * - rivalcfg `rivalcfg/handlers/none.py` — `rainbow_effect` here is a
 *   fixed-argument `[0x22, 0xFF]` command with `value_type: "none"` (just
 *   enables the effect on all zones; disabled by writing a color instead),
 *   unlike the plain Aerox 5's zone-bitmask `rainbow_effect`.
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` — 9 buttons + scroll
 *   up/down, byte-identical layout to `./aerox5.ts`'s `AEROX5_BUTTONS` (same
 *   ids and offsets, confirmed by direct comparison of the two device
 *   files) — reused here as `AEROX5_WIRELESS_BUTTONS`, a structurally
 *   identical constant, rather than re-derived from scratch, since the two
 *   device files' `buttons_mapping` blocks are identical.
 *
 * ## Why wired-cable-mode and 2.4 GHz-dongle-mode share one module
 *
 * This is the common SteelSeries wireless pattern also seen in Rival 3
 * Wireless's sibling `rival3_wireless_gen2.py` (not implemented here, out of
 * scope): one physical mouse, multiple USB product ids depending on how the
 * host currently sees it, all driven by the same command set modulo a fixed
 * per-transport transform. Concretely: `aerox5_wireless_wireless.py`'s
 * `_patch_command` ORs `0b01000000` (`0x40`) into `command[0]` of every
 * setting, `battery_level`, and `save_command` inherited from
 * `aerox5_wireless_wired.py`, and adds `readback_length: 64` (an expected
 * reply length this module does not need to model — no function here reads
 * or validates a readback payload; callers that care can check the response
 * length themselves). Every command byte in `AEROX5_WIRELESS_COMMAND` below
 * is the wired-mode value; `applyWirelessFlag` produces the 2.4 GHz-mode
 * byte from it on demand, so there is exactly one place either byte can be
 * gotten wrong.
 *
 * ## Why this is a separate protocol family from the plain Aerox 5
 *
 * Despite the shared "Aerox 5" name and several identical command bytes
 * (`0x2D`/`0x2B`/`0x26`/`0x2A`/`0x27`), `aerox5_wireless_wired.py` is a
 * genuinely different command layout from `./aerox5.ts`'s plain
 * `aerox5.py`, confirmed by direct comparison rather than assumed from the
 * shared name:
 *
 * - Polling command `0x2B` shares the byte but **not** the value mapping:
 *   `{125:0x03, 250:0x02, 500:0x01, 1000:0x00}` here vs. the plain Aerox 5's
 *   `{125:0x04, 250:0x03, 500:0x02, 1000:0x01}` — writing the plain Aerox 5's
 *   byte to this device would select the wrong rate.
 * - RGB zone commands are a different packing entirely:
 *   `21 01 <zone-index 0/1/2> <r> <g> <b>` here (fixed 6-byte packet, no
 *   bitmask, no zero-padding growth) vs. the plain Aerox 5's
 *   `21 <bitmask> <padding> <r> <g> <b>` (`./aerox5.ts`'s
 *   `steelseriesAerox5EncodeZoneColor`). Do not reuse that function here.
 * - `rainbow_effect` is a fixed no-argument enable (`22 FF`) here vs. the
 *   plain Aerox 5's zone-bitmask choice.
 * - This device has `sleep_timer` (`0x29`) and `dim_timer` (`0x23 0F 01 00 00`)
 *   settings the plain Aerox 5 profile does not define at all — note
 *   `dim_timer`'s command also collides on its first byte (`0x23`) with the
 *   plain Aerox 5's `led_brightness` command; they are unrelated settings on
 *   unrelated devices, not the same control.
 * - This device has a `battery_level` read (`0x92`, 2-byte reply) the plain
 *   Aerox 5 profile has no equivalent of at all (write-only, no getters).
 *
 * PIDs are therefore registered under their own family (`"aerox5-wireless"`),
 * never `"aerox5"`.
 *
 * No corroborating libratbag or OpenRGB source for any of these PIDs was
 * available in this environment (no local libratbag checkout, and OpenRGB's
 * SteelSeries controller files were not reachable this pass) — every command
 * byte above is sourced from rivalcfg alone. This should be treated as
 * unverified beyond rivalcfg until corroborated or hardware-tested.
 *
 * Every command is an HID output report, report id `0x00`, on the vendor
 * configuration interface (`"endpoint": 3` for every model in both rivalcfg
 * files). DPI presets, polling rate, zone colors, reactive color, sleep/dim
 * timers, rainbow, default lighting, and buttons are write-only — neither
 * rivalcfg file defines a getter for any of them. Battery level **is**
 * readable (see below). Settings apply immediately; the save command
 * (`11 00`, wireless-mode `51 00`) persists them to onboard flash. None of
 * this has been verified on physical hardware by this project.
 *
 * ## Battery read
 *
 * `aerox5_wireless_wired.py` defines a `battery_level` block: an
 * output-report write of `0x92` gets a 2-byte input-report reply, where
 * `data[1] & 0b10000000` is the charging flag and
 * `((data[1] & ~0b10000000) - 1) * 5` is the percentage (a coarse 0–100
 * scale in steps of 5, `- 1` because the raw byte is 1-indexed). This module
 * exposes `steelseriesAerox5WirelessBatteryQuery` /
 * `steelseriesAerox5WirelessDecodeBattery` for both transports (2.4 GHz mode
 * additionally needs `0x92 | 0x40 = 0xD2`, produced by
 * `applyWirelessFlag`). This is a **different battery-response shape** from
 * `./rival3-wireless.ts`'s `AA 01` / 3-byte-reply / plain-percentage-byte
 * battery read — do not conflate the two devices' battery decoding.
 */

import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

export const AEROX5_WIRELESS_REPORT_ID = 0x00;

/** `_WIRELESS_FLAG = 0b01000000` in `aerox5_wireless_wireless.py`. */
const WIRELESS_FLAG = 0b01000000;

/** Wired-cable-mode command bytes; OR `WIRELESS_FLAG` into byte 0 for 2.4 GHz mode. */
export const AEROX5_WIRELESS_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  zoneColor: [0x21, 0x01],
  reactiveColor: [0x26],
  sleepTimer: [0x29],
  dimTimer: [0x23, 0x0f, 0x01, 0x00, 0x00],
  buttonsMapping: [0x2a],
  rainbowEffect: [0x22, 0xff],
  defaultLighting: [0x27],
  batteryLevel: [0x92],
} as const;

/** `11 00` wired-mode / `51 00` 2.4 GHz-mode — see `applyWirelessFlag`. */
export const AEROX5_WIRELESS_SAVE_COMMAND = [0x11, 0x00] as const;

/**
 * `_patch_command`: OR `0b01000000` into the command's first byte. Pass the
 * wired-mode command bytes from `AEROX5_WIRELESS_COMMAND` /
 * `AEROX5_WIRELESS_SAVE_COMMAND`; returns the 2.4 GHz-mode equivalent.
 */
export function applyWirelessFlag(command: readonly number[]): number[] {
  if (command.length === 0) {
    throw new Aerox5WirelessProtocolError("Cannot apply the wireless flag to an empty command.");
  }
  return [command[0]! | WIRELESS_FLAG, ...command.slice(1)];
}

export const AEROX5_WIRELESS_POLLING_RATES = [125, 250, 500, 1000] as const;

/** Different byte values than the plain Aerox 5's `POLLING_RATE_TO_BYTE` — see module doc comment. */
const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x00],
  [500, 0x01],
  [250, 0x02],
  [125, 0x03],
]);

export const AEROX5_WIRELESS_DPI_MIN = 100;
export const AEROX5_WIRELESS_DPI_MAX = 18000;
export const AEROX5_WIRELESS_DPI_STEP = 100;
export const AEROX5_WIRELESS_MAX_DPI_PRESETS = 5;
export const AEROX5_WIRELESS_BATTERY_RESPONSE_LENGTH = 2;

const BATTERY_CHARGING_FLAG = 0b10000000;

export class Aerox5WirelessProtocolError extends Error {}

/** The 180 DPI values the shared TrueMove Air sensor table can express, ascending. */
export function steelseriesAerox5WirelessDpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `2D <count> <selected> <v1>…<vN>` (or `6D …` in 2.4 GHz mode). One byte
 * per DPI; `selectedIndex` is 0-based and encoded 0-based on the wire
 * (`first_preset: 0`, same as the plain Aerox 5).
 */
export function steelseriesAerox5WirelessEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
  wireless: boolean,
): Uint8Array {
  if (presets.length < 1 || presets.length > AEROX5_WIRELESS_MAX_DPI_PRESETS) {
    throw new Aerox5WirelessProtocolError(
      `SteelSeries Aerox 5 Wireless supports 1–${AEROX5_WIRELESS_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Aerox5WirelessProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new Aerox5WirelessProtocolError(
        `SteelSeries Aerox 5 Wireless DPI must be ${AEROX5_WIRELESS_DPI_MIN}–${AEROX5_WIRELESS_DPI_MAX.toLocaleString()} in ${AEROX5_WIRELESS_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.dpiPresets) : AEROX5_WIRELESS_COMMAND.dpiPresets;
  return new Uint8Array([...command, presets.length, selectedIndex, ...encoded]);
}

/** `2B <v>` (`6B` wireless) with 1000→0x00, 500→0x01, 250→0x02, 125→0x03. */
export function steelseriesAerox5WirelessEncodePollingRate(pollingRateHz: number, wireless: boolean): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Aerox5WirelessProtocolError(
      "SteelSeries Aerox 5 Wireless supports 125, 250, 500, or 1000 Hz polling.",
    );
  }
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.pollingRate) : AEROX5_WIRELESS_COMMAND.pollingRate;
  return new Uint8Array([...command, byte]);
}

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Aerox5WirelessProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

export type Aerox5WirelessZone = 1 | 2 | 3;

const ZONE_INDEX: Record<Aerox5WirelessZone, number> = { 1: 0x00, 2: 0x01, 3: 0x02 };

/**
 * `21 01 <zone-index> <r> <g> <b>` (`61 01 …` wireless) — a fixed 6-byte
 * packet, **not** the plain Aerox 5's bitmask-plus-padding shape. Zone 1 =
 * top LED, zone 2 = middle LED, zone 3 = bottom LED (strip order, per the
 * source's CLI flag labels).
 */
export function steelseriesAerox5WirelessEncodeZoneColor(
  zone: Aerox5WirelessZone,
  r: number,
  g: number,
  b: number,
  wireless: boolean,
): Uint8Array {
  const zoneIndex = ZONE_INDEX[zone];
  if (zoneIndex === undefined) {
    throw new Aerox5WirelessProtocolError(
      "SteelSeries Aerox 5 Wireless has zones 1 (top), 2 (middle), and 3 (bottom) only.",
    );
  }
  const [red, green, blue] = encodeRgb(r, g, b);
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.zoneColor) : AEROX5_WIRELESS_COMMAND.zoneColor;
  return new Uint8Array([...command, zoneIndex, red, green, blue]);
}

/**
 * `26 00 00 00 00 00` when disabled, `26 01 00 <r> <g> <b>` when enabled
 * (`66 …` wireless) — same shape as `./aerox3.ts`/`./aerox5.ts`.
 */
export function steelseriesAerox5WirelessEncodeReactiveColor(
  color: { r: number; g: number; b: number } | null,
  wireless: boolean,
): Uint8Array {
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.reactiveColor) : AEROX5_WIRELESS_COMMAND.reactiveColor;
  if (color === null) {
    return new Uint8Array([...command, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  const [r, g, b] = encodeRgb(color.r, color.g, color.b);
  return new Uint8Array([...command, 0x01, 0x00, r, g, b]);
}

function encodeRangeLE3(value: number, min: number, max: number, unit: string, msPerUnit: number): number[] {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Aerox5WirelessProtocolError(`SteelSeries Aerox 5 Wireless ${unit} must be an integer ${min}–${max}.`);
  }
  const ms = value * msPerUnit;
  return [ms & 0xff, (ms >> 8) & 0xff, (ms >> 16) & 0xff];
}

/**
 * `29 <ms LE24>` (`69 …` wireless) — idle minutes before sleep, `0` disables.
 * Encoded as `minutes * 60000` milliseconds, little-endian 3 bytes (see
 * module doc comment for the range-handler derivation).
 */
export function steelseriesAerox5WirelessEncodeSleepTimer(minutes: number, wireless: boolean): Uint8Array {
  const bytes = encodeRangeLE3(minutes, 0, 20, "sleep timer minutes", 60_000);
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.sleepTimer) : AEROX5_WIRELESS_COMMAND.sleepTimer;
  return new Uint8Array([...command, ...bytes]);
}

/**
 * `23 0F 01 00 00 <ms LE24>` (`63 …` wireless) — idle seconds before the LEDs
 * dim, `0` disables. Encoded as `seconds * 1000` milliseconds, little-endian
 * 3 bytes.
 */
export function steelseriesAerox5WirelessEncodeDimTimer(seconds: number, wireless: boolean): Uint8Array {
  const bytes = encodeRangeLE3(seconds, 0, 1200, "dim timer seconds", 1_000);
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.dimTimer) : AEROX5_WIRELESS_COMMAND.dimTimer;
  return new Uint8Array([...command, ...bytes]);
}

/** `22 FF` (`62 FF` wireless) — enables the rainbow effect on all zones; a color write clears it. */
export function steelseriesAerox5WirelessEncodeRainbowEffect(wireless: boolean): Uint8Array {
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.rainbowEffect) : AEROX5_WIRELESS_COMMAND.rainbowEffect;
  return new Uint8Array(command);
}

/** Byte-identical to the plain Aerox 5's `AEROX5_DEFAULT_LIGHTING` table. */
export const AEROX5_WIRELESS_DEFAULT_LIGHTING = {
  off: [0x00, 0x00],
  reactive: [0x00, 0x01],
  rainbow: [0x01, 0x00],
  "reactive-rainbow": [0x01, 0x01],
} as const;

export type Aerox5WirelessDefaultLighting = keyof typeof AEROX5_WIRELESS_DEFAULT_LIGHTING;

/** `27 <v1> <v2>` (`67 …` wireless) — what the mouse lights up as before a host ever connects. */
export function steelseriesAerox5WirelessEncodeDefaultLighting(
  mode: Aerox5WirelessDefaultLighting,
  wireless: boolean,
): Uint8Array {
  const bytes = AEROX5_WIRELESS_DEFAULT_LIGHTING[mode];
  if (bytes === undefined) {
    throw new Aerox5WirelessProtocolError(
      `SteelSeries Aerox 5 Wireless default lighting must be one of: ${Object.keys(AEROX5_WIRELESS_DEFAULT_LIGHTING).join(", ")}.`,
    );
  }
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.defaultLighting) : AEROX5_WIRELESS_COMMAND.defaultLighting;
  return new Uint8Array([...command, ...bytes]);
}

/** `11 00` wired-mode / `51 00` 2.4 GHz-mode — commit the current settings to onboard flash. */
export function steelseriesAerox5WirelessSaveCommand(wireless: boolean): Uint8Array {
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_SAVE_COMMAND) : AEROX5_WIRELESS_SAVE_COMMAND;
  return new Uint8Array(command);
}

/** `92` wired-mode / `D2` 2.4 GHz-mode — the device answers with a two-byte input report. */
export function steelseriesAerox5WirelessBatteryQuery(wireless: boolean): Uint8Array {
  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.batteryLevel) : AEROX5_WIRELESS_COMMAND.batteryLevel;
  return new Uint8Array(command);
}

export interface Aerox5WirelessBattery {
  /** `((data[1] & ~0x80) - 1) * 5` in rivalcfg — a coarse 0–100 scale in steps of 5. */
  level: number;
  /** `bool(data[1] & 0b10000000)` in rivalcfg. */
  isCharging: boolean;
}

/**
 * Decode the two-byte battery response: `data[0]` is unused by rivalcfg's
 * lambdas, `data[1]`'s top bit is the charging flag and the remaining 7 bits
 * (1-indexed, hence `- 1`) scaled by 5 give the percentage.
 */
export function steelseriesAerox5WirelessDecodeBattery(payload: Uint8Array): Aerox5WirelessBattery {
  if (payload.length < AEROX5_WIRELESS_BATTERY_RESPONSE_LENGTH) {
    throw new Aerox5WirelessProtocolError(
      "SteelSeries Aerox 5 Wireless battery response is shorter than two bytes.",
    );
  }
  const statusByte = payload[1]!;
  const isCharging = (statusByte & BATTERY_CHARGING_FLAG) !== 0;
  const level = ((statusByte & ~BATTERY_CHARGING_FLAG) - 1) * 5;
  return { level, isCharging };
}

// -- Button mapping ---------------------------------------------------------

interface Aerox5WirelessButtonSlot {
  id: number;
  offset: number;
}

/**
 * `buttons_mapping.buttons` from `aerox5_wireless_wired.py` — byte-identical
 * ids/offsets to `./aerox5.ts`'s `AEROX5_BUTTONS`, confirmed by direct
 * comparison of the two device files, defined separately here rather than
 * imported so each family's button table stays self-contained.
 */
export const AEROX5_WIRELESS_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  button7: { id: 0x07, offset: 0x1e },
  button8: { id: 0x08, offset: 0x23 },
  button9: { id: 0x09, offset: 0x28 },
  scrollUp: { id: 0x31, offset: 0x2d },
  scrollDown: { id: 0x32, offset: 0x32 },
} as const satisfies Record<string, Aerox5WirelessButtonSlot>;

export type Aerox5WirelessButtonName = keyof typeof AEROX5_WIRELESS_BUTTONS;

const AEROX5_WIRELESS_BUTTON_FIELD_LENGTH = 5;
const AEROX5_WIRELESS_BUTTON_DISABLE = 0x00;
const AEROX5_WIRELESS_BUTTON_DPI_SWITCH = 0x30;
const AEROX5_WIRELESS_BUTTON_KEYBOARD = 0x51;
const AEROX5_WIRELESS_BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. `scrollUp`/`scrollDown` cannot be remap *targets*
 * (`button_scroll_up`/`button_scroll_down` are `None` in the source) — only
 * sources, same rule as the plain Aerox 5.
 */
export type Aerox5WirelessButtonAction =
  | { type: "button"; target: Exclude<Aerox5WirelessButtonName, "scrollUp" | "scrollDown"> }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `2A` (`6A` wireless) + one 55-byte (`11 buttons × 5-byte field length`)
 * packet, zero-filled except where a mapping is given. Unmapped buttons are
 * left as all-zero fields (rivalcfg instead fills in per-button defaults;
 * this codec leaves that policy to the caller — pass every button
 * explicitly for parity with rivalcfg's default profile).
 */
export function steelseriesAerox5WirelessEncodeButtonsMapping(
  mapping: Partial<Record<Aerox5WirelessButtonName, Aerox5WirelessButtonAction>>,
  wireless: boolean,
): Uint8Array {
  const names = Object.keys(AEROX5_WIRELESS_BUTTONS) as Aerox5WirelessButtonName[];
  const packet = new Array<number>(names.length * AEROX5_WIRELESS_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Aerox5WirelessButtonName, Aerox5WirelessButtonAction]>) {
    const slot = AEROX5_WIRELESS_BUTTONS[name];
    if (!slot) {
      throw new Aerox5WirelessProtocolError(`Unknown SteelSeries Aerox 5 Wireless button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        packet[offset] = AEROX5_WIRELESS_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = AEROX5_WIRELESS_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = AEROX5_WIRELESS_BUTTON_DPI_SWITCH;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Aerox5WirelessProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = AEROX5_WIRELESS_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Aerox5WirelessProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = AEROX5_WIRELESS_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new Aerox5WirelessProtocolError("Unsupported SteelSeries Aerox 5 Wireless button action.");
      }
    }
  }

  const command = wireless ? applyWirelessFlag(AEROX5_WIRELESS_COMMAND.buttonsMapping) : AEROX5_WIRELESS_COMMAND.buttonsMapping;
  return new Uint8Array([...command, ...packet]);
}
