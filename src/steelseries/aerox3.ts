/**
 * SteelSeries Aerox 3 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/aerox3.py` — the primary source for every
 *   command byte and default here.
 * - rivalcfg `rivalcfg/handlers/multidpi_range_choice.py` (DPI presets, shared
 *   with Rival 3 Gen 1 but with a one-byte command prefix instead of two) and
 *   `rivalcfg/devices/dpi/truemove_core.py` (the DPI byte table — reused from
 *   `./rival3.ts`'s `TRUEMOVE_CORE_DPI_TO_BYTE`, not re-derived, since both
 *   devices use the same TrueMove Core sensor and rivalcfg quotes the same
 *   table for both).
 * - rivalcfg `rivalcfg/handlers/rgbcolor.py` and `reactive_rgbcolor.py` — RGB
 *   value encoding (`[r,g,b]`, and `[0x01,0x00,r,g,b]` / `[0x00,0x00,0x00,0x00,0x00]`
 *   for the on/off reactive-color field).
 * - rivalcfg `rivalcfg/handlers/range.py` and `choice.py` — LED brightness
 *   (linear 0–100 passthrough) and the rainbow-effect/default-lighting
 *   choice tables.
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` — the fixed-width button
 *   field layout (5 bytes/button, zero-filled, `offset`/`id` per button).
 * - rivalcfg `rivalcfg/devices/rival3_gen2.py` — corroborates that `0x1038:0x1870`
 *   (Rival 3 Gen 2) shares the Aerox 3's color/brightness/rainbow/buttons/
 *   default-lighting/save commands, but see the PR #269 note below: its DPI
 *   command differs, so this module intentionally does not claim that PID.
 *
 * ## PR #269 reconciliation (SteelSeries Rival 3 Gen 2, `1038:1870`)
 *
 * flozz/rivalcfg#269 (closed, hardware-confirmed by its author for DPI,
 * polling, and RGB) claims the Rival 3 Gen 2 uses "the identical Aerox 3
 * protocol" at `1038:1870`, endpoint 3. rivalcfg's own mainline
 * `devices/rival3_gen2.py` does ship that exact vendor/product/endpoint
 * triple, confirming the PID half of the PR's claim. **The protocols are not
 * byte-identical, though**: Aerox 3's DPI-preset command is `0x2D` using the
 * `multidpi_range_choice` handler (one DPI byte per preset), while mainline
 * Rival 3 Gen 2 uses command `0x34` with the `multidpi_range_choice_xy`
 * handler (independent X/Y DPI per preset, `"xy_mapping": "xyxy"`, two bytes
 * per axis pair). Every other setting (polling rate `0x2B`, RGB zones `0x21`,
 * reactive color `0x26`, brightness `0x23`, rainbow `0x22`, buttons `0x2A`,
 * default lighting `0x27`, save `0x11 0x00`) is byte-identical between the
 * two mainline device files. Per this rollout's instructions, rivalcfg's
 * mainline file is treated as authoritative over the PR description, and
 * because the DPI command genuinely differs, `1038:0x1870` is **not** added
 * to this module's or any registry's product table here — a Rival 3 Gen 2
 * driver needs its own DPI encoder and is out of scope for this cluster
 * (Aerox 3 only). Nothing in this file claims or matches that PID.
 *
 * Every command is an HID **output report** with report id 0x00 on the
 * vendor configuration interface (hidapi `endpoint` / `interface_number ==
 * 3`, per the `"endpoint": 3` model entry — same interface convention as
 * Rival 3 Gen 1). The functions here build the report *payload* — the bytes
 * after the report id — unpadded, matching rivalcfg's `usbhid.py` writes.
 *
 * **This device is write-only, like Rival 3 Gen 1.** `aerox3.py` defines no
 * getter for any setting and no firmware-query command (Rival 3 Gen 1's
 * `10 00` has no Aerox 3 counterpart in rivalcfg, libratbag, or the OpenRGB
 * SteelSeries controller files checked for this device). There is nothing to
 * probe the mouse with, so the HID client cannot use a firmware read as a
 * connectivity check the way `SteelSeriesRival3HidClient` does; it must treat
 * a successful `open()` as the only available signal. Session state must be
 * tracked client-side with `valuesVerified: false`, exactly as Rival 3 does.
 *
 * Settings apply immediately; the save command (`11 00`, distinct from Rival
 * 3 Gen 1's `09 00` — do not confuse the two) persists them to onboard flash.
 * None of this has been verified on physical Aerox 3 hardware by this
 * project.
 *
 * ## RGB zone command layout
 *
 * All three zone-color settings share one underlying packet shape, visible
 * once the escalating prefixes in `aerox3.py` are read against the LED_ID
 * bitmask comment preserved in rivalcfg's `rival3_gen2.py` (same command
 * family): `21 <LED_ID bitmask> <zone1 r,g,b> <zone2 r,g,b> <zone3 r,g,b>`.
 * `LED_ID` selects which zone(s) the device should actually update; the RGB
 * slots for zones the bitmask does not select are sent as zero padding and
 * ignored by the device. That is why `z1_color`'s command is `[0x21,0x01]`
 * (bitmask `0b001`, immediately followed by that zone's RGB — no padding
 * needed, its slot is first), `z2_color`'s is `[0x21,0x02,0x00,0x00,0x00]`
 * (bitmask `0b010`, three zero bytes filling the skipped zone-1 slot before
 * zone 2's RGB), and `z3_color`'s is `[0x21,0x04,0x00,0x00,0x00,0x00,0x00,0x00]`
 * (bitmask `0b100`, six zero bytes filling the skipped zone-1 and zone-2
 * slots before zone 3's RGB). This module exposes one `steelseriesAerox3EncodeZoneColor`
 * function parameterized on zone 1–3 rather than three near-duplicate
 * functions, producing byte-identical output to each `aerox3.py` command.
 *
 * ## Button mapping — deliberately reduced scope
 *
 * rivalcfg's `buttons` handler supports remapping to another mouse button,
 * a disable/DPI-switch/scroll special action, or a keyboard/multimedia key
 * chosen from large per-layout tables (`handlers/buttons/layout_qwerty.py`,
 * `layout_multimedia.py`). This module implements the exact 5-byte/button,
 * zero-filled packet shape and the mouse-button/disable/DPI-switch/scroll
 * special actions, but does not re-implement rivalcfg's QWERTY or multimedia
 * key-name tables: keyboard and multimedia targets are taken here as raw
 * `{ type: "keyboard" | "multimedia", code }` scan-code bytes rather than
 * name strings, matching `button_keyboard: 0x51` / `button_multimedia: 0x61`
 * verbatim. This is the same kind of scope line `rival3.ts` draws around
 * lighting effects it documents but does not implement.
 */

import { TRUEMOVE_CORE_DPI_TO_BYTE } from "./rival3.js";

export const AEROX3_REPORT_ID = 0x00;

/** One-byte command prefixes; the payload is the prefix plus its arguments. */
export const AEROX3_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  reactiveColor: [0x26],
  ledBrightness: [0x23],
  rainbowEffect: [0x22],
  buttonsMapping: [0x2a],
  defaultLighting: [0x27],
  zoneColor: [0x21],
} as const;

/** `11 00` — distinct from Rival 3 Gen 1's `09 00`; do not reuse across families. */
export const AEROX3_SAVE_COMMAND = [0x11, 0x00] as const;

export const AEROX3_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const AEROX3_DPI_MIN = 200;
export const AEROX3_DPI_MAX = 8500;
export const AEROX3_DPI_STEP = 100;
export const AEROX3_MAX_DPI_PRESETS = 5;

export class Aerox3ProtocolError extends Error {}

/** The 84 DPI values the shared TrueMove Core sensor table can express, ascending. */
export function steelseriesAerox3DpiOptions(): number[] {
  return [...TRUEMOVE_CORE_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `2D <count> <selected> <v1>…<vN>` — replaces the mouse's whole preset
 * table. One byte per DPI (`dpi_length_byte: 1`); `selectedIndex` is 0-based
 * here and encoded 1-based on the wire (`first_preset: 1`).
 */
export function steelseriesAerox3EncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length < 1 || presets.length > AEROX3_MAX_DPI_PRESETS) {
    throw new Aerox3ProtocolError(
      `SteelSeries Aerox 3 supports 1–${AEROX3_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Aerox3ProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_CORE_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new Aerox3ProtocolError(
        `SteelSeries Aerox 3 DPI must be ${AEROX3_DPI_MIN}–${AEROX3_DPI_MAX.toLocaleString()} in ${AEROX3_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  return new Uint8Array([...AEROX3_COMMAND.dpiPresets, presets.length, selectedIndex + 1, ...encoded]);
}

/** `2B <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesAerox3EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Aerox3ProtocolError("SteelSeries Aerox 3 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...AEROX3_COMMAND.pollingRate, byte]);
}

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Aerox3ProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

export type Aerox3Zone = 1 | 2 | 3;

/**
 * `21 <bitmask> <padding for skipped zones> <r> <g> <b>` — see the module
 * doc comment for how the zero-padding length grows with the zone number.
 * Zone 1 = top LED, zone 2 = middle LED, zone 3 = bottom LED (strip order,
 * per `aerox3.py`'s CLI flag labels).
 */
export function steelseriesAerox3EncodeZoneColor(
  zone: Aerox3Zone,
  r: number,
  g: number,
  b: number,
): Uint8Array {
  const [red, green, blue] = encodeRgb(r, g, b);
  if (zone === 1) {
    return new Uint8Array([...AEROX3_COMMAND.zoneColor, 0x01, red, green, blue]);
  }
  if (zone === 2) {
    return new Uint8Array([...AEROX3_COMMAND.zoneColor, 0x02, 0x00, 0x00, 0x00, red, green, blue]);
  }
  if (zone === 3) {
    return new Uint8Array([
      ...AEROX3_COMMAND.zoneColor, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, red, green, blue,
    ]);
  }
  throw new Aerox3ProtocolError("SteelSeries Aerox 3 has zones 1 (top), 2 (middle), and 3 (bottom) only.");
}

/**
 * `26 00 00 00 00 00` when disabled, `26 01 00 <r> <g> <b>` when enabled —
 * the color the LEDs flash to in reaction to a button click.
 */
export function steelseriesAerox3EncodeReactiveColor(
  color: { r: number; g: number; b: number } | null,
): Uint8Array {
  if (color === null) {
    return new Uint8Array([...AEROX3_COMMAND.reactiveColor, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  const [r, g, b] = encodeRgb(color.r, color.g, color.b);
  return new Uint8Array([...AEROX3_COMMAND.reactiveColor, 0x01, 0x00, r, g, b]);
}

/** `23 <v>` — linear 0–100 passthrough (`output_range` matches `input_range`). */
export function steelseriesAerox3EncodeLedBrightness(percent: number): Uint8Array {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Aerox3ProtocolError("SteelSeries Aerox 3 LED brightness must be an integer 0–100.");
  }
  return new Uint8Array([...AEROX3_COMMAND.ledBrightness, percent]);
}

export const AEROX3_RAINBOW_ZONES = {
  all: 0b111,
  bottom: 0b100,
  middle: 0b010,
  top: 0b001,
  "bottom-middle": 0b110,
  "middle-top": 0b011,
  "bottom-top": 0b101,
} as const;

export type Aerox3RainbowZones = keyof typeof AEROX3_RAINBOW_ZONES;

/** `22 <bitmask>` — rainbow effect on the selected zone(s); cleared by setting a color. */
export function steelseriesAerox3EncodeRainbowEffect(zones: Aerox3RainbowZones): Uint8Array {
  const byte = AEROX3_RAINBOW_ZONES[zones];
  if (byte === undefined) {
    throw new Aerox3ProtocolError(
      `SteelSeries Aerox 3 rainbow zones must be one of: ${Object.keys(AEROX3_RAINBOW_ZONES).join(", ")}.`,
    );
  }
  return new Uint8Array([...AEROX3_COMMAND.rainbowEffect, byte]);
}

export const AEROX3_DEFAULT_LIGHTING = {
  off: [0x00, 0x00],
  reactive: [0x00, 0x01],
  rainbow: [0x01, 0x00],
  "reactive-rainbow": [0x01, 0x01],
} as const;

export type Aerox3DefaultLighting = keyof typeof AEROX3_DEFAULT_LIGHTING;

/** `27 <v1> <v2>` — what the mouse lights up as before a host ever connects. */
export function steelseriesAerox3EncodeDefaultLighting(mode: Aerox3DefaultLighting): Uint8Array {
  const bytes = AEROX3_DEFAULT_LIGHTING[mode];
  if (bytes === undefined) {
    throw new Aerox3ProtocolError(
      `SteelSeries Aerox 3 default lighting must be one of: ${Object.keys(AEROX3_DEFAULT_LIGHTING).join(", ")}.`,
    );
  }
  return new Uint8Array([...AEROX3_COMMAND.defaultLighting, ...bytes]);
}

/** `11 00` — commit the current settings to onboard flash. */
export function steelseriesAerox3SaveCommand(): Uint8Array {
  return new Uint8Array(AEROX3_SAVE_COMMAND);
}

// -- Button mapping ---------------------------------------------------------

interface Aerox3ButtonSlot {
  id: number;
  offset: number;
}

/** `buttons_mapping.buttons` from `aerox3.py`, id + byte offset into the packet. */
export const AEROX3_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  scrollUp: { id: 0x31, offset: 0x1e },
  scrollDown: { id: 0x32, offset: 0x23 },
} as const satisfies Record<string, Aerox3ButtonSlot>;

export type Aerox3ButtonName = keyof typeof AEROX3_BUTTONS;

const AEROX3_BUTTON_FIELD_LENGTH = 5;
const AEROX3_BUTTON_DISABLE = 0x00;
const AEROX3_BUTTON_DPI_SWITCH = 0x30;
const AEROX3_BUTTON_KEYBOARD = 0x51;
const AEROX3_BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. `scrollUp`/`scrollDown` cannot be remap *targets*
 * (`button_scroll_up`/`button_scroll_down` are `None` in `aerox3.py`) — only
 * sources; attempting to target them is rejected.
 */
export type Aerox3ButtonAction =
  | { type: "button"; target: Exclude<Aerox3ButtonName, "scrollUp" | "scrollDown"> }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `2A` + one 40-byte (`8 buttons × 5-byte field length`) packet, zero-filled
 * except where a mapping is given. Unmapped buttons are left as all-zero
 * fields (rivalcfg instead fills in per-button defaults; this codec leaves
 * that policy to the caller — pass every button explicitly for parity with
 * rivalcfg's default profile).
 */
export function steelseriesAerox3EncodeButtonsMapping(
  mapping: Partial<Record<Aerox3ButtonName, Aerox3ButtonAction>>,
): Uint8Array {
  const names = Object.keys(AEROX3_BUTTONS) as Aerox3ButtonName[];
  const packet = new Array<number>(names.length * AEROX3_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Aerox3ButtonName, Aerox3ButtonAction]>) {
    const slot = AEROX3_BUTTONS[name];
    if (!slot) {
      throw new Aerox3ProtocolError(`Unknown SteelSeries Aerox 3 button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        packet[offset] = AEROX3_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = AEROX3_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = AEROX3_BUTTON_DPI_SWITCH;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Aerox3ProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = AEROX3_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Aerox3ProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = AEROX3_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new Aerox3ProtocolError(`Unsupported SteelSeries Aerox 3 button action.`);
      }
    }
  }

  return new Uint8Array([...AEROX3_COMMAND.buttonsMapping, ...packet]);
}
