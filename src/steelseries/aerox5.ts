/**
 * SteelSeries Aerox 5 (wired-only) configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/aerox5.py` — the primary source for every
 *   command byte and default here. This profile covers only `1038:1850`
 *   ("SteelSeries Aerox 5", endpoint 3) — the plain wired mouse, **not** the
 *   separately-sold Aerox 5 Wireless. See `./aerox5-wireless.ts` for that
 *   device: it is a genuinely different command layout (different DPI
 *   command polling-rate byte values, different RGB zone packing, extra
 *   sleep/dim timers, a fixed-argument rainbow command, and a battery read),
 *   not just this module with different product ids swapped in. Do not
 *   assume the two share a codec.
 * - rivalcfg `rivalcfg/devices/dpi/truemove_air.py` — the DPI byte table for
 *   this device's TrueMove Air sensor. **Not** `./rival3.ts`'s
 *   `TRUEMOVE_CORE_DPI_TO_BYTE` (Aerox 3's sensor) — reused verbatim here
 *   from `./rival3-wireless.ts`'s `TRUEMOVE_AIR_DPI_TO_BYTE` instead, since
 *   `aerox5.py`'s `output_choices: truemove_air.choices` is byte-for-byte
 *   the same table rivalcfg already uses for the Rival 3 Wireless (both spot
 *   checked: 400→0x04, 1600→0x12, 18000→0xD6).
 * - rivalcfg `rivalcfg/handlers/multidpi_range_choice.py` — the DPI preset
 *   packet shape, same handler as Aerox 3/Rival 3 Wireless, `dpi_length_byte: 1`
 *   (one byte per preset, unlike Rival 3 Wireless's two). **`first_preset: 0`
 *   here** — unlike Aerox 3 and Rival 3 Wireless (both `first_preset: 1`),
 *   `aerox5.py` encodes the selected index directly with no +1 offset. This
 *   is the one place this device's DPI framing differs from Aerox 3's
 *   despite sharing the same command byte and one-byte preset width.
 * - rivalcfg `rivalcfg/handlers/rgbcolor.py` / `reactive_rgbcolor.py` — RGB
 *   value encoding, byte-identical to `./aerox3.ts`'s usage.
 * - rivalcfg `rivalcfg/handlers/range.py` — LED brightness (linear 0–100
 *   passthrough, `range_length_byte` omitted so 1 byte).
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` — the fixed-width button
 *   field layout, 5 bytes/button, but **9 physical buttons plus scroll
 *   up/down** (`button1`…`button9`, `scrollup`, `scrolldown` — 11 slots, 55
 *   bytes total) instead of Aerox 3's 6 buttons plus scroll (8 slots).
 *   Offsets step by 5 for buttons 1–9 (`0x00`…`0x28`) then scroll up/down
 *   continue the same stride (`0x2D`, `0x32`).
 *
 * ## Why this is a separate protocol family from Aerox 3 despite similar shape
 *
 * Superficially close to `./aerox3.ts` (same `0x2D`/`0x2B`/`0x21`/`0x26`/
 * `0x23`/`0x22`/`0x2A`/`0x27`/`0x11 00` command bytes, same RGB zone
 * bitmask-and-padding packing), but genuinely different in the details that
 * matter for correctness:
 *
 * - Different DPI sensor table (TrueMove Air vs. TrueMove Core) — same
 *   command byte, disjoint value bytes.
 * - `first_preset: 0` vs. Aerox 3's `first_preset: 1` (see above).
 * - 9 buttons + scroll vs. Aerox 3's 6 buttons + scroll — different packet
 *   length and offsets past button 5.
 * - `aerox5.py`'s `rainbow_effect` and `default_lighting` choice tables are
 *   byte-identical to `aerox3.py`'s, confirmed by direct comparison, not
 *   assumed — reused as identical constants rather than re-derived.
 *
 * Given these differences, PID `0x1850` is registered under its own family
 * (`"aerox5"`), not folded into `"aerox3"`.
 *
 * No corroborating libratbag or OpenRGB source for `1038:1850` specifically
 * was available in this environment (no local libratbag checkout, and
 * OpenRGB's SteelSeries controller files were not reachable this pass) —
 * every command byte above is sourced from rivalcfg alone, same
 * single-source caveat cluster 2 flagged for the Rival 3 Wireless. This
 * should be treated as unverified beyond rivalcfg until corroborated or
 * hardware-tested.
 *
 * Every command is an HID output report, report id `0x00`, on the vendor
 * configuration interface (`"endpoint": 3`). This module is write-only —
 * `aerox5.py` defines no getter for any setting and no firmware-query
 * command, same as Aerox 3. Settings apply immediately; the save command
 * (`11 00`) persists them to onboard flash. None of this has been verified
 * on physical hardware by this project.
 */

import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

export const AEROX5_REPORT_ID = 0x00;

/** One-byte command prefixes; the payload is the prefix plus its arguments. */
export const AEROX5_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  reactiveColor: [0x26],
  ledBrightness: [0x23],
  rainbowEffect: [0x22],
  buttonsMapping: [0x2a],
  defaultLighting: [0x27],
  zoneColor: [0x21],
} as const;

/** `11 00` — same byte-pair as Aerox 3's save command. */
export const AEROX5_SAVE_COMMAND = [0x11, 0x00] as const;

export const AEROX5_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const AEROX5_DPI_MIN = 100;
export const AEROX5_DPI_MAX = 18000;
export const AEROX5_DPI_STEP = 100;
export const AEROX5_MAX_DPI_PRESETS = 5;

export class Aerox5ProtocolError extends Error {}

/** The 180 DPI values the shared TrueMove Air sensor table can express, ascending. */
export function steelseriesAerox5DpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `2D <count> <selected> <v1>…<vN>` — replaces the mouse's whole preset
 * table. One byte per DPI (`dpi_length_byte: 1`). `selectedIndex` is 0-based
 * and encoded 0-based on the wire (`first_preset: 0` — unlike Aerox 3's
 * `first_preset: 1`, no +1 offset here).
 */
export function steelseriesAerox5EncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length < 1 || presets.length > AEROX5_MAX_DPI_PRESETS) {
    throw new Aerox5ProtocolError(
      `SteelSeries Aerox 5 supports 1–${AEROX5_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Aerox5ProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new Aerox5ProtocolError(
        `SteelSeries Aerox 5 DPI must be ${AEROX5_DPI_MIN}–${AEROX5_DPI_MAX.toLocaleString()} in ${AEROX5_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  return new Uint8Array([...AEROX5_COMMAND.dpiPresets, presets.length, selectedIndex, ...encoded]);
}

/** `2B <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04 — same mapping as Aerox 3. */
export function steelseriesAerox5EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Aerox5ProtocolError("SteelSeries Aerox 5 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...AEROX5_COMMAND.pollingRate, byte]);
}

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Aerox5ProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

export type Aerox5Zone = 1 | 2 | 3;

/**
 * `21 <bitmask> <padding for skipped zones> <r> <g> <b>` — identical packing
 * to `./aerox3.ts`'s zone-color command: zone 1 = top LED, zone 2 = middle
 * LED, zone 3 = bottom LED.
 */
export function steelseriesAerox5EncodeZoneColor(
  zone: Aerox5Zone,
  r: number,
  g: number,
  b: number,
): Uint8Array {
  const [red, green, blue] = encodeRgb(r, g, b);
  if (zone === 1) {
    return new Uint8Array([...AEROX5_COMMAND.zoneColor, 0x01, red, green, blue]);
  }
  if (zone === 2) {
    return new Uint8Array([...AEROX5_COMMAND.zoneColor, 0x02, 0x00, 0x00, 0x00, red, green, blue]);
  }
  if (zone === 3) {
    return new Uint8Array([
      ...AEROX5_COMMAND.zoneColor, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, red, green, blue,
    ]);
  }
  throw new Aerox5ProtocolError("SteelSeries Aerox 5 has zones 1 (top), 2 (middle), and 3 (bottom) only.");
}

/**
 * `26 00 00 00 00 00` when disabled, `26 01 00 <r> <g> <b>` when enabled —
 * byte-identical to `./aerox3.ts`'s reactive-color command.
 */
export function steelseriesAerox5EncodeReactiveColor(
  color: { r: number; g: number; b: number } | null,
): Uint8Array {
  if (color === null) {
    return new Uint8Array([...AEROX5_COMMAND.reactiveColor, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  const [r, g, b] = encodeRgb(color.r, color.g, color.b);
  return new Uint8Array([...AEROX5_COMMAND.reactiveColor, 0x01, 0x00, r, g, b]);
}

/** `23 <v>` — linear 0–100 passthrough. */
export function steelseriesAerox5EncodeLedBrightness(percent: number): Uint8Array {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Aerox5ProtocolError("SteelSeries Aerox 5 LED brightness must be an integer 0–100.");
  }
  return new Uint8Array([...AEROX5_COMMAND.ledBrightness, percent]);
}

/** Byte-identical to `AEROX3_RAINBOW_ZONES`, confirmed by direct comparison of the two device files. */
export const AEROX5_RAINBOW_ZONES = {
  all: 0b111,
  bottom: 0b100,
  middle: 0b010,
  top: 0b001,
  "bottom-middle": 0b110,
  "middle-top": 0b011,
  "bottom-top": 0b101,
} as const;

export type Aerox5RainbowZones = keyof typeof AEROX5_RAINBOW_ZONES;

/** `22 <bitmask>` — rainbow effect on the selected zone(s); cleared by setting a color. */
export function steelseriesAerox5EncodeRainbowEffect(zones: Aerox5RainbowZones): Uint8Array {
  const byte = AEROX5_RAINBOW_ZONES[zones];
  if (byte === undefined) {
    throw new Aerox5ProtocolError(
      `SteelSeries Aerox 5 rainbow zones must be one of: ${Object.keys(AEROX5_RAINBOW_ZONES).join(", ")}.`,
    );
  }
  return new Uint8Array([...AEROX5_COMMAND.rainbowEffect, byte]);
}

/** Byte-identical to `AEROX3_DEFAULT_LIGHTING`, confirmed by direct comparison of the two device files. */
export const AEROX5_DEFAULT_LIGHTING = {
  off: [0x00, 0x00],
  reactive: [0x00, 0x01],
  rainbow: [0x01, 0x00],
  "reactive-rainbow": [0x01, 0x01],
} as const;

export type Aerox5DefaultLighting = keyof typeof AEROX5_DEFAULT_LIGHTING;

/** `27 <v1> <v2>` — what the mouse lights up as before a host ever connects. */
export function steelseriesAerox5EncodeDefaultLighting(mode: Aerox5DefaultLighting): Uint8Array {
  const bytes = AEROX5_DEFAULT_LIGHTING[mode];
  if (bytes === undefined) {
    throw new Aerox5ProtocolError(
      `SteelSeries Aerox 5 default lighting must be one of: ${Object.keys(AEROX5_DEFAULT_LIGHTING).join(", ")}.`,
    );
  }
  return new Uint8Array([...AEROX5_COMMAND.defaultLighting, ...bytes]);
}

/** `11 00` — commit the current settings to onboard flash. */
export function steelseriesAerox5SaveCommand(): Uint8Array {
  return new Uint8Array(AEROX5_SAVE_COMMAND);
}

// -- Button mapping ---------------------------------------------------------

interface Aerox5ButtonSlot {
  id: number;
  offset: number;
}

/**
 * `buttons_mapping.buttons` from `aerox5.py`, id + byte offset into the
 * packet — 9 physical buttons (this mouse's extra side-button cluster over
 * Aerox 3's 6) plus scroll up/down, 11 slots total.
 */
export const AEROX5_BUTTONS = {
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
} as const satisfies Record<string, Aerox5ButtonSlot>;

export type Aerox5ButtonName = keyof typeof AEROX5_BUTTONS;

const AEROX5_BUTTON_FIELD_LENGTH = 5;
const AEROX5_BUTTON_DISABLE = 0x00;
const AEROX5_BUTTON_DPI_SWITCH = 0x30;
const AEROX5_BUTTON_KEYBOARD = 0x51;
const AEROX5_BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. `scrollUp`/`scrollDown` cannot be remap *targets*
 * (`button_scroll_up`/`button_scroll_down` are `None` in `aerox5.py`) — only
 * sources; attempting to target them is rejected, same rule as Aerox 3.
 */
export type Aerox5ButtonAction =
  | { type: "button"; target: Exclude<Aerox5ButtonName, "scrollUp" | "scrollDown"> }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `2A` + one 55-byte (`11 buttons × 5-byte field length`) packet, zero-filled
 * except where a mapping is given. Unmapped buttons are left as all-zero
 * fields (rivalcfg instead fills in per-button defaults; this codec leaves
 * that policy to the caller — pass every button explicitly for parity with
 * rivalcfg's default profile).
 */
export function steelseriesAerox5EncodeButtonsMapping(
  mapping: Partial<Record<Aerox5ButtonName, Aerox5ButtonAction>>,
): Uint8Array {
  const names = Object.keys(AEROX5_BUTTONS) as Aerox5ButtonName[];
  const packet = new Array<number>(names.length * AEROX5_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Aerox5ButtonName, Aerox5ButtonAction]>) {
    const slot = AEROX5_BUTTONS[name];
    if (!slot) {
      throw new Aerox5ProtocolError(`Unknown SteelSeries Aerox 5 button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        packet[offset] = AEROX5_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = AEROX5_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = AEROX5_BUTTON_DPI_SWITCH;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Aerox5ProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = AEROX5_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Aerox5ProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = AEROX5_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new Aerox5ProtocolError(`Unsupported SteelSeries Aerox 5 button action.`);
      }
    }
  }

  return new Uint8Array([...AEROX5_COMMAND.buttonsMapping, ...packet]);
}
