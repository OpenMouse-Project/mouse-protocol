/**
 * SteelSeries Prime Mini Wireless configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - There is **no** `prime_mini_wireless.py` (nor a wired/wireless filename
 *   pair) in rivalcfg. The Prime Mini Wireless is instead one of two models
 *   inside the shared "Prime Wireless" profile pair:
 *   `rivalcfg/devices/prime_wireless_wired.py` (USB-cabled mode) defines two
 *   `models` entries — `"SteelSeries Prime Wireless (wired mode)"`
 *   (`1038:1842`) and `"SteelSeries Prime Mini Wireless (wired mode)"`
 *   (`1038:184A`) — sharing one `settings`/`battery_level`/`save_command`
 *   dict. `rivalcfg/devices/prime_wireless_wireless.py` (2.4 GHz dongle mode)
 *   mirrors that with `1038:1840` (Prime Wireless) and `1038:1848` (Prime
 *   Mini Wireless), built by comprehending `prime_wireless_wired.py`'s
 *   `settings`/`battery_level`/`save_command` through one `_patch_command`
 *   helper — same transform this file implements as `applyPrimeMiniWirelessFlag`.
 *   Both files were read in full. This module implements only the two Prime
 *   Mini Wireless product ids (`0x184A` wired, `0x1848` 2.4 GHz) per the
 *   scope of this change — see "Scope" below for why the plain Prime
 *   Wireless PIDs (`0x1842`/`0x1840`) are deliberately not registered here
 *   even though the command set is identical.
 * - rivalcfg `rivalcfg/devices/dpi/truemove_air.py` — same TrueMove Air
 *   sensor table as the Rival 3 Wireless and Aerox 5 Wireless — imported
 *   from `./rival3-wireless.ts`'s `TRUEMOVE_AIR_DPI_TO_BYTE`, not re-derived.
 * - rivalcfg `rivalcfg/handlers/multidpi_range_choice.py` — `dpi_length_byte: 1`,
 *   `first_preset: 0` (same shape as `./aerox5-wireless.ts`, **not**
 *   `./rival3-wireless.ts`'s `first_preset: 1`/`dpi_length_byte` via
 *   `multidpi_range`).
 * - rivalcfg `rivalcfg/handlers/range.py` — `sleep_timer`/`dim_timer`: the
 *   exact same linear range-to-range mapping as `./aerox5-wireless.ts`
 *   (`sleep_timer` = minutes × 60000 ms, `dim_timer` = seconds × 1000 ms,
 *   both little-endian 3 bytes, `range_length_byte: 3`). Traced by hand
 *   against `prime_wireless_wired.py`'s `output_range: [0x000000, 0x124F80, …]`
 *   values, not assumed from the Aerox 5 Wireless precedent.
 * - rivalcfg `rivalcfg/handlers/rgbcolor.py` — LED color: `command: [0x21, 0x01, 0x00]`
 *   with the RGB triplet appended directly (no zone byte and no bitmask —
 *   this is a single-LED mouse, unlike the Aerox 5 Wireless's
 *   zone-indexed `steelseriesAerox5WirelessEncodeZoneColor`).
 * - rivalcfg `rivalcfg/handlers/choice.py` — `polling_rate`
 *   (`{125:0x03, 250:0x02, 500:0x01, 1000:0x00}`, byte-identical mapping to
 *   `./aerox5-wireless.ts`'s table, confirmed by direct comparison — not
 *   assumed) and `default_lighting` (`{"off": 0x00, "rainbow": 0x01}`).
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` (inferred generic
 *   handler backing `value_type: "buttons"`) — 6 mappable buttons + scroll
 *   up/down, `button_field_length: 5`, byte-identical ids/offsets to the
 *   non-wireless `prime_mini.py`'s `buttons_mapping` block (confirmed by
 *   direct comparison of both device files).
 *
 * ## Why wired-cable-mode and 2.4 GHz-dongle-mode share one module
 *
 * Same SteelSeries wireless pattern as `./aerox5-wireless.ts` and
 * `./rival3-wireless.ts`: one physical mouse, two USB product ids depending
 * on transport, one command set modulo a fixed transform.
 * `prime_wireless_wireless.py`'s `_patch_command` ORs `0b01000000` (`0x40`)
 * into `command[0]` of every setting, `battery_level`, and `save_command`
 * inherited from `prime_wireless_wired.py`, and adds `readback_length: 64`
 * (an expected reply length this module does not need to model — no
 * function here reads or validates a readback payload). Every command byte
 * in `PRIME_MINI_WIRELESS_COMMAND` below is the wired-mode value;
 * `applyPrimeMiniWirelessFlag` produces the 2.4 GHz-mode byte from it on demand.
 *
 * ## Scope: Prime Mini Wireless only, not the plain Prime Wireless
 *
 * `prime_wireless_wired.py`/`prime_wireless_wireless.py` document the Prime
 * Mini Wireless and the plain (non-Mini) Prime Wireless as one shared
 * `settings` dict — genuinely the same command bytes, same DPI table, same
 * battery shape, differing only in physical product id. This change is
 * scoped to the Prime Mini Wireless cluster only: `./devices.ts` registers
 * `0x184A`/`0x1848` (Prime Mini Wireless) under family
 * `"prime-mini-wireless"` and deliberately does **not** register
 * `0x1842`/`0x1840` (plain Prime Wireless) — even though this module's
 * exported functions would encode identical bytes for either PID group, the
 * plain Prime Wireless is out of scope for this change and is left for
 * whichever future change actually verifies and ships it.
 *
 * ## No corroboration beyond rivalcfg was possible in this environment
 *
 * No local libratbag checkout was available, and OpenRGB's SteelSeries
 * controller files were not reachable this pass — every command byte above
 * is sourced from rivalcfg alone, same disclosure as `./aerox5-wireless.ts`.
 * This should be treated as unverified beyond rivalcfg until corroborated
 * or hardware-tested.
 *
 * Every command is an HID output report, report id `0x00`, on the vendor
 * configuration interface (`"endpoint": 3` for every model in both rivalcfg
 * files). DPI presets, polling rate, LED color, sleep/dim timers, default
 * lighting, and buttons are write-only — neither rivalcfg file defines a
 * getter for any of them. Battery level **is** readable (see below).
 * Settings apply immediately; the save command (`11 00` wired, `51 00`
 * wireless) persists them to onboard flash. None of this has been verified
 * on physical hardware by this project.
 *
 * ## Battery read
 *
 * `prime_wireless_wired.py` defines a `battery_level` block byte-identical
 * in shape to `./aerox5-wireless.ts`'s: an output-report write of `0x92`
 * gets a 2-byte input-report reply, where `data[1] & 0b10000000` is the
 * charging flag and `((data[1] & ~0b10000000) - 1) * 5` is the percentage
 * (coarse 0–100 scale in steps of 5, `- 1` because the raw byte is
 * 1-indexed). Confirmed by reading `prime_wireless_wired.py` directly — this
 * is **not** `./rival3-wireless.ts`'s `AA 01` / 3-byte-reply /
 * plain-percentage-byte shape; do not conflate the two. In 2.4 GHz mode the
 * query byte is `0x92 | 0x40 = 0xD2`, produced by `applyPrimeMiniWirelessFlag`.
 */

import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

export const PRIME_MINI_WIRELESS_REPORT_ID = 0x00;

/** `_WIRELESS_FLAG = 0b01000000` in `prime_wireless_wireless.py`. */
const WIRELESS_FLAG = 0b01000000;

/** Wired-cable-mode command bytes; OR `WIRELESS_FLAG` into byte 0 for 2.4 GHz mode. */
export const PRIME_MINI_WIRELESS_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  color: [0x21, 0x01, 0x00],
  buttonsMapping: [0x2a],
  sleepTimer: [0x29],
  dimTimer: [0x23, 0x0f, 0x01, 0x00, 0x00],
  defaultLighting: [0x27],
  batteryLevel: [0x92],
} as const;

/** `11 00` wired-mode / `51 00` 2.4 GHz-mode — see `applyPrimeMiniWirelessFlag`. */
export const PRIME_MINI_WIRELESS_SAVE_COMMAND = [0x11, 0x00] as const;

/**
 * `_patch_command`: OR `0b01000000` into the command's first byte. Pass the
 * wired-mode command bytes from `PRIME_MINI_WIRELESS_COMMAND` /
 * `PRIME_MINI_WIRELESS_SAVE_COMMAND`; returns the 2.4 GHz-mode equivalent.
 */
export function applyPrimeMiniWirelessFlag(command: readonly number[]): number[] {
  if (command.length === 0) {
    throw new PrimeMiniWirelessProtocolError("Cannot apply the wireless flag to an empty command.");
  }
  return [command[0]! | WIRELESS_FLAG, ...command.slice(1)];
}

export const PRIME_MINI_WIRELESS_POLLING_RATES = [125, 250, 500, 1000] as const;

/** Byte-identical mapping to `./aerox5-wireless.ts`'s `POLLING_RATE_TO_BYTE` — confirmed by comparison, not assumed. */
const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x00],
  [500, 0x01],
  [250, 0x02],
  [125, 0x03],
]);

export const PRIME_MINI_WIRELESS_DPI_MIN = 100;
export const PRIME_MINI_WIRELESS_DPI_MAX = 18000;
export const PRIME_MINI_WIRELESS_DPI_STEP = 100;
export const PRIME_MINI_WIRELESS_MAX_DPI_PRESETS = 5;
export const PRIME_MINI_WIRELESS_BATTERY_RESPONSE_LENGTH = 2;

const BATTERY_CHARGING_FLAG = 0b10000000;

export class PrimeMiniWirelessProtocolError extends Error {}

/** The 180 DPI values the shared TrueMove Air sensor table can express, ascending. */
export function steelseriesPrimeMiniWirelessDpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `2D <count> <selected> <v1>…<vN>` (or `6D …` in 2.4 GHz mode). One byte
 * per DPI; `selectedIndex` is 0-based and encoded 0-based on the wire
 * (`first_preset: 0`).
 */
export function steelseriesPrimeMiniWirelessEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
  wireless: boolean,
): Uint8Array {
  if (presets.length < 1 || presets.length > PRIME_MINI_WIRELESS_MAX_DPI_PRESETS) {
    throw new PrimeMiniWirelessProtocolError(
      `SteelSeries Prime Mini Wireless supports 1–${PRIME_MINI_WIRELESS_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new PrimeMiniWirelessProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new PrimeMiniWirelessProtocolError(
        `SteelSeries Prime Mini Wireless DPI must be ${PRIME_MINI_WIRELESS_DPI_MIN}–${PRIME_MINI_WIRELESS_DPI_MAX.toLocaleString()} in ${PRIME_MINI_WIRELESS_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  const command = wireless
    ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.dpiPresets)
    : PRIME_MINI_WIRELESS_COMMAND.dpiPresets;
  return new Uint8Array([...command, presets.length, selectedIndex, ...encoded]);
}

/** `2B <v>` (`6B` wireless) with 1000→0x00, 500→0x01, 250→0x02, 125→0x03. */
export function steelseriesPrimeMiniWirelessEncodePollingRate(pollingRateHz: number, wireless: boolean): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new PrimeMiniWirelessProtocolError(
      "SteelSeries Prime Mini Wireless supports 125, 250, 500, or 1000 Hz polling.",
    );
  }
  const command = wireless
    ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.pollingRate)
    : PRIME_MINI_WIRELESS_COMMAND.pollingRate;
  return new Uint8Array([...command, byte]);
}

/**
 * `21 01 00 <r> <g> <b>` (`61 01 00 …` wireless) — a fixed single-LED
 * packet, no zone byte (this mouse has one LED, unlike the Aerox 5
 * Wireless's zone-indexed color command).
 */
export function steelseriesPrimeMiniWirelessEncodeColor(r: number, g: number, b: number, wireless: boolean): Uint8Array {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new PrimeMiniWirelessProtocolError("RGB channels must be integers 0–255.");
    }
  }
  const command = wireless ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.color) : PRIME_MINI_WIRELESS_COMMAND.color;
  return new Uint8Array([...command, r, g, b]);
}

function encodeRangeLE3(value: number, min: number, max: number, unit: string, msPerUnit: number): number[] {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PrimeMiniWirelessProtocolError(`SteelSeries Prime Mini Wireless ${unit} must be an integer ${min}–${max}.`);
  }
  const ms = value * msPerUnit;
  return [ms & 0xff, (ms >> 8) & 0xff, (ms >> 16) & 0xff];
}

/**
 * `29 <ms LE24>` (`69 …` wireless) — idle minutes before sleep, `0` disables.
 * Encoded as `minutes * 60000` milliseconds, little-endian 3 bytes.
 */
export function steelseriesPrimeMiniWirelessEncodeSleepTimer(minutes: number, wireless: boolean): Uint8Array {
  const bytes = encodeRangeLE3(minutes, 0, 20, "sleep timer minutes", 60_000);
  const command = wireless
    ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.sleepTimer)
    : PRIME_MINI_WIRELESS_COMMAND.sleepTimer;
  return new Uint8Array([...command, ...bytes]);
}

/**
 * `23 0F 01 00 00 <ms LE24>` (`63 …` wireless) — idle seconds before the LED
 * dims, `0` disables. Encoded as `seconds * 1000` milliseconds,
 * little-endian 3 bytes.
 */
export function steelseriesPrimeMiniWirelessEncodeDimTimer(seconds: number, wireless: boolean): Uint8Array {
  const bytes = encodeRangeLE3(seconds, 0, 1200, "dim timer seconds", 1_000);
  const command = wireless
    ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.dimTimer)
    : PRIME_MINI_WIRELESS_COMMAND.dimTimer;
  return new Uint8Array([...command, ...bytes]);
}

/** `off`/`rainbow` LED-at-startup choice. */
export const PRIME_MINI_WIRELESS_DEFAULT_LIGHTING = {
  off: 0x00,
  rainbow: 0x01,
} as const;

export type PrimeMiniWirelessDefaultLighting = keyof typeof PRIME_MINI_WIRELESS_DEFAULT_LIGHTING;

/** `27 <v>` (`67 …` wireless) — what the mouse lights up as before a host ever connects. */
export function steelseriesPrimeMiniWirelessEncodeDefaultLighting(
  mode: PrimeMiniWirelessDefaultLighting,
  wireless: boolean,
): Uint8Array {
  const byte = PRIME_MINI_WIRELESS_DEFAULT_LIGHTING[mode];
  if (byte === undefined) {
    throw new PrimeMiniWirelessProtocolError(
      `SteelSeries Prime Mini Wireless default lighting must be one of: ${Object.keys(PRIME_MINI_WIRELESS_DEFAULT_LIGHTING).join(", ")}.`,
    );
  }
  const command = wireless
    ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.defaultLighting)
    : PRIME_MINI_WIRELESS_COMMAND.defaultLighting;
  return new Uint8Array([...command, byte]);
}

/** `11 00` wired-mode / `51 00` 2.4 GHz-mode — commit the current settings to onboard flash. */
export function steelseriesPrimeMiniWirelessSaveCommand(wireless: boolean): Uint8Array {
  const command = wireless ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_SAVE_COMMAND) : PRIME_MINI_WIRELESS_SAVE_COMMAND;
  return new Uint8Array(command);
}

/** `92` wired-mode / `D2` 2.4 GHz-mode — the device answers with a two-byte input report. */
export function steelseriesPrimeMiniWirelessBatteryQuery(wireless: boolean): Uint8Array {
  const command = wireless
    ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.batteryLevel)
    : PRIME_MINI_WIRELESS_COMMAND.batteryLevel;
  return new Uint8Array(command);
}

export interface PrimeMiniWirelessBattery {
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
export function steelseriesPrimeMiniWirelessDecodeBattery(payload: Uint8Array): PrimeMiniWirelessBattery {
  if (payload.length < PRIME_MINI_WIRELESS_BATTERY_RESPONSE_LENGTH) {
    throw new PrimeMiniWirelessProtocolError(
      "SteelSeries Prime Mini Wireless battery response is shorter than two bytes.",
    );
  }
  const statusByte = payload[1]!;
  const isCharging = (statusByte & BATTERY_CHARGING_FLAG) !== 0;
  const level = ((statusByte & ~BATTERY_CHARGING_FLAG) - 1) * 5;
  return { level, isCharging };
}

// -- Button mapping ---------------------------------------------------------

interface PrimeMiniWirelessButtonSlot {
  id: number;
  offset: number;
}

/**
 * `buttons_mapping.buttons` shared by `prime_wireless_wired.py` — same
 * offsets/ids as the non-wireless `prime_mini.py`'s `buttons_mapping` block,
 * confirmed by direct comparison of both device files, defined separately
 * here so this family's button table stays self-contained.
 */
export const PRIME_MINI_WIRELESS_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  scrollUp: { id: 0x31, offset: 0x1e },
  scrollDown: { id: 0x32, offset: 0x23 },
} as const satisfies Record<string, PrimeMiniWirelessButtonSlot>;

export type PrimeMiniWirelessButtonName = keyof typeof PRIME_MINI_WIRELESS_BUTTONS;

const PRIME_MINI_WIRELESS_BUTTON_FIELD_LENGTH = 5;
const PRIME_MINI_WIRELESS_BUTTON_DISABLE = 0x00;
const PRIME_MINI_WIRELESS_BUTTON_DPI_SWITCH = 0x30;
const PRIME_MINI_WIRELESS_BUTTON_KEYBOARD = 0x51;
const PRIME_MINI_WIRELESS_BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. `scrollUp`/`scrollDown` cannot be remap *targets*
 * (`button_scroll_up`/`button_scroll_down` are `None` in the source) — only
 * sources, same rule as `./aerox5-wireless.ts`.
 */
export type PrimeMiniWirelessButtonAction =
  | { type: "button"; target: Exclude<PrimeMiniWirelessButtonName, "scrollUp" | "scrollDown"> }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `2A` (`6A` wireless) + one 40-byte (`8 buttons × 5-byte field length`)
 * packet, zero-filled except where a mapping is given. Unmapped buttons are
 * left as all-zero fields (rivalcfg instead fills in per-button defaults;
 * this codec leaves that policy to the caller — pass every button
 * explicitly for parity with rivalcfg's default profile).
 */
export function steelseriesPrimeMiniWirelessEncodeButtonsMapping(
  mapping: Partial<Record<PrimeMiniWirelessButtonName, PrimeMiniWirelessButtonAction>>,
  wireless: boolean,
): Uint8Array {
  const names = Object.keys(PRIME_MINI_WIRELESS_BUTTONS) as PrimeMiniWirelessButtonName[];
  const packet = new Array<number>(names.length * PRIME_MINI_WIRELESS_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[PrimeMiniWirelessButtonName, PrimeMiniWirelessButtonAction]>) {
    const slot = PRIME_MINI_WIRELESS_BUTTONS[name];
    if (!slot) {
      throw new PrimeMiniWirelessProtocolError(`Unknown SteelSeries Prime Mini Wireless button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        packet[offset] = PRIME_MINI_WIRELESS_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = PRIME_MINI_WIRELESS_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = PRIME_MINI_WIRELESS_BUTTON_DPI_SWITCH;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new PrimeMiniWirelessProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = PRIME_MINI_WIRELESS_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new PrimeMiniWirelessProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = PRIME_MINI_WIRELESS_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new PrimeMiniWirelessProtocolError("Unsupported SteelSeries Prime Mini Wireless button action.");
      }
    }
  }

  const command = wireless
    ? applyPrimeMiniWirelessFlag(PRIME_MINI_WIRELESS_COMMAND.buttonsMapping)
    : PRIME_MINI_WIRELESS_COMMAND.buttonsMapping;
  return new Uint8Array([...command, ...packet]);
}
