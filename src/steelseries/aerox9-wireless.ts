/**
 * SteelSeries Aerox 9 Wireless configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/aerox9_wireless_wired.py` — the primary source
 *   for every command byte, product id, and default here, for the mouse's
 *   USB-cabled mode (`1038:185A`, plus the WOW Edition `0x1876`).
 * - rivalcfg `rivalcfg/devices/aerox9_wireless_wireless.py` — the 2.4 GHz
 *   dongle mode (`1038:1858`, WOW Edition `0x1874`). Read in full and diffed
 *   directly against the wired-mode file: it is **not** a separate command
 *   set. It is `aerox9_wireless_wired.py`'s settings dict comprehended
 *   through one `_patch_command` helper that (1) ORs `0b01000000` (`0x40`)
 *   into every command's first byte and (2) adds a 64-byte `readback_length`.
 *   This is the exact same transform cluster 3 found for the Aerox 5
 *   Wireless (`./aerox5-wireless.ts`'s `applyWirelessFlag`) — confirmed here
 *   by direct `diff` of the two device files, not assumed from precedent.
 *   This module implements that transform (`applyAerox9WirelessFlag`, named
 *   distinctly from `./aerox5-wireless.ts`'s `applyWirelessFlag` to avoid a
 *   re-export collision in `./index.ts`) rather than hand-duplicating the
 *   wired-mode byte tables.
 * - rivalcfg `rivalcfg/devices/dpi/truemove_air.py` — same TrueMove Air
 *   sensor table as Aerox 5 / Aerox 5 Wireless / Rival 3 Wireless — imported
 *   from `./rival3-wireless.ts`'s `TRUEMOVE_AIR_DPI_TO_BYTE`, not re-derived
 *   (same `input_range`/`output_choices` reference).
 * - rivalcfg `rivalcfg/handlers/multidpi_range_choice.py` — `dpi_length_byte: 1`,
 *   `first_preset: 0` (same as Aerox 5 and Aerox 5 Wireless — not 1, unlike
 *   Aerox 3 and Rival 3 Wireless), `max_preset_count: 5`.
 * - rivalcfg `rivalcfg/handlers/range.py` — `sleep_timer`/`dim_timer`: same
 *   linear range-to-range mapping as Aerox 5 Wireless, same output ranges
 *   (`sleep_timer`: `[0x000000, 0x124F80, 60000]` against `[0, 20, 1]`
 *   minutes, i.e. `minutes * 60000` ms; `dim_timer`:
 *   `[0x000000, 0x124F80, 1000]` against `[0, 1200, 1]` seconds, i.e.
 *   `seconds * 1000` ms), little-endian 3 bytes (`range_length_byte: 3`).
 * - rivalcfg `rivalcfg/handlers/rgbcolor.py` / `reactive_rgbcolor.py` — RGB
 *   value encoding, same as every other SteelSeries family in this codebase.
 * - rivalcfg `rivalcfg/handlers/none.py` — `rainbow_effect` is a fixed
 *   no-argument enable, `22 FF` (`62 FF` wireless), same shape as Aerox 5
 *   Wireless's — **not** the plain Aerox 5's zone-bitmask choice.
 *
 * ## No button-mapping command in this device's rivalcfg profile
 *
 * Despite SteelSeries marketing the Aerox 9 (Wireless) as a 9-button
 * "MMO-style" mouse, `aerox9_wireless_wired.py` defines **no**
 * `buttons_mapping` setting and no button-remap command at all — confirmed
 * by reading the full settings dict, which has exactly nine entries
 * (`sensitivity`, `polling_rate`, `z1_color`, `z2_color`, `z3_color`,
 * `reactive_color`, `sleep_timer`, `dim_timer`, `rainbow_effect`,
 * `default_lighting`) plus `battery_level`/`save_command`, none of them a
 * buttons handler. This is unlike `./aerox5.ts` and `./aerox5-wireless.ts`,
 * both of which do define one. This module therefore exposes no button
 * remap function — there is nothing in the reference implementation to
 * reconstruct it from, not an oversight.
 *
 * ## Why wired-cable-mode and 2.4 GHz-dongle-mode share one module
 *
 * Same pattern as Aerox 5 Wireless: one physical mouse, two USB product-id
 * groups depending on how the host currently sees it, driven by the same
 * command set modulo the fixed `applyAerox9WirelessFlag` transform. Every command
 * byte in `AEROX9_WIRELESS_COMMAND` below is the wired-mode value;
 * `applyAerox9WirelessFlag` produces the 2.4 GHz-mode byte on demand.
 *
 * ## Why this is a separate protocol family from Aerox 5 / Aerox 5 Wireless
 *
 * Aerox 9 Wireless shares several command bytes with Aerox 5 Wireless
 * (`0x2D`/`0x2B`/`0x29`/`0x22`/`0x27`/`0x92`/`0x11 00`, the same
 * `_patch_command` wireless-flag transform, the same `readback_length: 64`),
 * but is a genuinely different device profile, confirmed by direct
 * comparison of the two rivalcfg files rather than assumed from the shared
 * "Aerox" naming and similar wireless architecture:
 *
 * - RGB zone commands are `21 01 <zone> <r> <g> <b>` here, same fixed-packet
 *   shape as Aerox 5 Wireless's `steelseriesAerox5WirelessEncodeZoneColor`,
 *   confirmed byte-identical (`z1_color`/`z2_color`/`z3_color` commands
 *   `[0x21, 0x01, 0x00/0x01/0x02]` match exactly) — reused here as a
 *   structurally identical function rather than imported, so each family's
 *   codec stays self-contained.
 * - `dim_timer`'s command is `23 0F 01 00 00`, byte-identical to Aerox 5
 *   Wireless's.
 * - No button-mapping command at all (see above) — Aerox 5 Wireless has one.
 * - Distinct product-id space entirely: `0x185A`/`0x1876` (wired),
 *   `0x1858`/`0x1874` (2.4 GHz) — none overlap Aerox 5 Wireless's
 *   `0x1852`/`0x1854`/`0x185C`/`0x185E`/`0x1860`/`0x1862`, or any PID
 *   claimed by clusters 1–3.
 *
 * PIDs are therefore registered under their own family
 * (`"aerox9-wireless"`), never `"aerox5-wireless"`.
 *
 * No corroborating libratbag or OpenRGB source for any of these PIDs was
 * available in this environment (no local libratbag checkout, and OpenRGB's
 * SteelSeries controller files were not reachable this pass) — every command
 * byte above is sourced from rivalcfg alone, same single-source caveat
 * clusters 2 and 3 flagged for their devices. This should be treated as
 * unverified beyond rivalcfg until corroborated or hardware-tested.
 *
 * Every command is an HID output report, report id `0x00`, on the vendor
 * configuration interface (`"endpoint": 3` for every model in both rivalcfg
 * files). DPI presets, polling rate, zone colors, reactive color, sleep/dim
 * timers, rainbow, and default lighting are write-only — neither rivalcfg
 * file defines a getter for any of them. Battery level **is** readable (see
 * below). Settings apply immediately; the save command (`11 00`,
 * wireless-mode `51 00`) persists them to onboard flash. None of this has
 * been verified on physical hardware by this project.
 *
 * ## Battery read
 *
 * `aerox9_wireless_wired.py` defines a `battery_level` block identical in
 * shape to Aerox 5 Wireless's: an output-report write of `0x92` gets a
 * 2-byte input-report reply, where `data[1] & 0b10000000` is the charging
 * flag and `((data[1] & ~0b10000000) - 1) * 5` is the percentage (coarse
 * 0–100 scale in steps of 5). Confirmed byte-for-byte identical to
 * `aerox5_wireless_wired.py`'s `battery_level` block by direct comparison —
 * not assumed. 2.4 GHz mode additionally needs `0x92 | 0x40 = 0xD2`, produced
 * by `applyAerox9WirelessFlag`. This is the same battery-response shape as
 * `./aerox5-wireless.ts` and a **different** shape from
 * `./rival3-wireless.ts`'s `AA 01` / 3-byte-reply / plain-percentage-byte
 * battery read — do not conflate the three devices' battery decoding.
 */

import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

export const AEROX9_WIRELESS_REPORT_ID = 0x00;

/** `_WIRELESS_FLAG = 0b01000000` in `aerox9_wireless_wireless.py` — identical constant to Aerox 5 Wireless's. */
const WIRELESS_FLAG = 0b01000000;

/** Wired-cable-mode command bytes; OR `WIRELESS_FLAG` into byte 0 for 2.4 GHz mode. */
export const AEROX9_WIRELESS_COMMAND = {
  dpiPresets: [0x2d],
  pollingRate: [0x2b],
  zoneColor: [0x21, 0x01],
  reactiveColor: [0x26],
  sleepTimer: [0x29],
  dimTimer: [0x23, 0x0f, 0x01, 0x00, 0x00],
  rainbowEffect: [0x22, 0xff],
  defaultLighting: [0x27],
  batteryLevel: [0x92],
} as const;

/** `11 00` wired-mode / `51 00` 2.4 GHz-mode — see `applyAerox9WirelessFlag`. */
export const AEROX9_WIRELESS_SAVE_COMMAND = [0x11, 0x00] as const;

/**
 * `_patch_command`: OR `0b01000000` into the command's first byte. Pass the
 * wired-mode command bytes from `AEROX9_WIRELESS_COMMAND` /
 * `AEROX9_WIRELESS_SAVE_COMMAND`; returns the 2.4 GHz-mode equivalent.
 */
export function applyAerox9WirelessFlag(command: readonly number[]): number[] {
  if (command.length === 0) {
    throw new Aerox9WirelessProtocolError("Cannot apply the wireless flag to an empty command.");
  }
  return [command[0]! | WIRELESS_FLAG, ...command.slice(1)];
}

export const AEROX9_WIRELESS_POLLING_RATES = [125, 250, 500, 1000] as const;

/** `{125:0x03, 250:0x02, 500:0x01, 1000:0x00}` in `aerox9_wireless_wired.py` — same mapping as Aerox 5 Wireless. */
const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x00],
  [500, 0x01],
  [250, 0x02],
  [125, 0x03],
]);

export const AEROX9_WIRELESS_DPI_MIN = 100;
export const AEROX9_WIRELESS_DPI_MAX = 18000;
export const AEROX9_WIRELESS_DPI_STEP = 100;
export const AEROX9_WIRELESS_MAX_DPI_PRESETS = 5;
export const AEROX9_WIRELESS_BATTERY_RESPONSE_LENGTH = 2;

const BATTERY_CHARGING_FLAG = 0b10000000;

export class Aerox9WirelessProtocolError extends Error {}

/** The 180 DPI values the shared TrueMove Air sensor table can express, ascending. */
export function steelseriesAerox9WirelessDpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `2D <count> <selected> <v1>…<vN>` (or `6D …` in 2.4 GHz mode). One byte
 * per DPI; `selectedIndex` is 0-based and encoded 0-based on the wire
 * (`first_preset: 0`).
 */
export function steelseriesAerox9WirelessEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
  wireless: boolean,
): Uint8Array {
  if (presets.length < 1 || presets.length > AEROX9_WIRELESS_MAX_DPI_PRESETS) {
    throw new Aerox9WirelessProtocolError(
      `SteelSeries Aerox 9 Wireless supports 1–${AEROX9_WIRELESS_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Aerox9WirelessProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new Aerox9WirelessProtocolError(
        `SteelSeries Aerox 9 Wireless DPI must be ${AEROX9_WIRELESS_DPI_MIN}–${AEROX9_WIRELESS_DPI_MAX.toLocaleString()} in ${AEROX9_WIRELESS_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.dpiPresets) : AEROX9_WIRELESS_COMMAND.dpiPresets;
  return new Uint8Array([...command, presets.length, selectedIndex, ...encoded]);
}

/** `2B <v>` (`6B` wireless) with 1000→0x00, 500→0x01, 250→0x02, 125→0x03. */
export function steelseriesAerox9WirelessEncodePollingRate(pollingRateHz: number, wireless: boolean): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Aerox9WirelessProtocolError(
      "SteelSeries Aerox 9 Wireless supports 125, 250, 500, or 1000 Hz polling.",
    );
  }
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.pollingRate) : AEROX9_WIRELESS_COMMAND.pollingRate;
  return new Uint8Array([...command, byte]);
}

function encodeRgb(r: number, g: number, b: number): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Aerox9WirelessProtocolError("RGB channels must be integers 0–255.");
    }
  }
  return [r, g, b];
}

export type Aerox9WirelessZone = 1 | 2 | 3;

const ZONE_INDEX: Record<Aerox9WirelessZone, number> = { 1: 0x00, 2: 0x01, 3: 0x02 };

/**
 * `21 01 <zone-index> <r> <g> <b>` (`61 01 …` wireless) — a fixed 6-byte
 * packet. Zone 1 = top LED, zone 2 = middle LED, zone 3 = bottom LED (strip
 * order, per `z1_color`/`z2_color`/`z3_color`'s CLI flag labels).
 */
export function steelseriesAerox9WirelessEncodeZoneColor(
  zone: Aerox9WirelessZone,
  r: number,
  g: number,
  b: number,
  wireless: boolean,
): Uint8Array {
  const zoneIndex = ZONE_INDEX[zone];
  if (zoneIndex === undefined) {
    throw new Aerox9WirelessProtocolError(
      "SteelSeries Aerox 9 Wireless has zones 1 (top), 2 (middle), and 3 (bottom) only.",
    );
  }
  const [red, green, blue] = encodeRgb(r, g, b);
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.zoneColor) : AEROX9_WIRELESS_COMMAND.zoneColor;
  return new Uint8Array([...command, zoneIndex, red, green, blue]);
}

/**
 * `26 00 00 00 00 00` when disabled, `26 01 00 <r> <g> <b>` when enabled
 * (`66 …` wireless) — same shape as every other SteelSeries family here.
 */
export function steelseriesAerox9WirelessEncodeReactiveColor(
  color: { r: number; g: number; b: number } | null,
  wireless: boolean,
): Uint8Array {
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.reactiveColor) : AEROX9_WIRELESS_COMMAND.reactiveColor;
  if (color === null) {
    return new Uint8Array([...command, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  const [r, g, b] = encodeRgb(color.r, color.g, color.b);
  return new Uint8Array([...command, 0x01, 0x00, r, g, b]);
}

function encodeRangeLE3(value: number, min: number, max: number, unit: string, msPerUnit: number): number[] {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Aerox9WirelessProtocolError(`SteelSeries Aerox 9 Wireless ${unit} must be an integer ${min}–${max}.`);
  }
  const ms = value * msPerUnit;
  return [ms & 0xff, (ms >> 8) & 0xff, (ms >> 16) & 0xff];
}

/**
 * `29 <ms LE24>` (`69 …` wireless) — idle minutes before sleep, `0` disables.
 * Encoded as `minutes * 60000` milliseconds, little-endian 3 bytes.
 */
export function steelseriesAerox9WirelessEncodeSleepTimer(minutes: number, wireless: boolean): Uint8Array {
  const bytes = encodeRangeLE3(minutes, 0, 20, "sleep timer minutes", 60_000);
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.sleepTimer) : AEROX9_WIRELESS_COMMAND.sleepTimer;
  return new Uint8Array([...command, ...bytes]);
}

/**
 * `23 0F 01 00 00 <ms LE24>` (`63 …` wireless) — idle seconds before the LEDs
 * dim, `0` disables. Encoded as `seconds * 1000` milliseconds, little-endian
 * 3 bytes.
 */
export function steelseriesAerox9WirelessEncodeDimTimer(seconds: number, wireless: boolean): Uint8Array {
  const bytes = encodeRangeLE3(seconds, 0, 1200, "dim timer seconds", 1_000);
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.dimTimer) : AEROX9_WIRELESS_COMMAND.dimTimer;
  return new Uint8Array([...command, ...bytes]);
}

/** `22 FF` (`62 FF` wireless) — enables the rainbow effect on all zones; a color write clears it. */
export function steelseriesAerox9WirelessEncodeRainbowEffect(wireless: boolean): Uint8Array {
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.rainbowEffect) : AEROX9_WIRELESS_COMMAND.rainbowEffect;
  return new Uint8Array(command);
}

/** Byte-identical to `./aerox5-wireless.ts`'s `AEROX5_WIRELESS_DEFAULT_LIGHTING`, confirmed by direct comparison. */
export const AEROX9_WIRELESS_DEFAULT_LIGHTING = {
  off: [0x00, 0x00],
  reactive: [0x00, 0x01],
  rainbow: [0x01, 0x00],
  "reactive-rainbow": [0x01, 0x01],
} as const;

export type Aerox9WirelessDefaultLighting = keyof typeof AEROX9_WIRELESS_DEFAULT_LIGHTING;

/** `27 <v1> <v2>` (`67 …` wireless) — what the mouse lights up as before a host ever connects. */
export function steelseriesAerox9WirelessEncodeDefaultLighting(
  mode: Aerox9WirelessDefaultLighting,
  wireless: boolean,
): Uint8Array {
  const bytes = AEROX9_WIRELESS_DEFAULT_LIGHTING[mode];
  if (bytes === undefined) {
    throw new Aerox9WirelessProtocolError(
      `SteelSeries Aerox 9 Wireless default lighting must be one of: ${Object.keys(AEROX9_WIRELESS_DEFAULT_LIGHTING).join(", ")}.`,
    );
  }
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.defaultLighting) : AEROX9_WIRELESS_COMMAND.defaultLighting;
  return new Uint8Array([...command, ...bytes]);
}

/** `11 00` wired-mode / `51 00` 2.4 GHz-mode — commit the current settings to onboard flash. */
export function steelseriesAerox9WirelessSaveCommand(wireless: boolean): Uint8Array {
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_SAVE_COMMAND) : AEROX9_WIRELESS_SAVE_COMMAND;
  return new Uint8Array(command);
}

/** `92` wired-mode / `D2` 2.4 GHz-mode — the device answers with a two-byte input report. */
export function steelseriesAerox9WirelessBatteryQuery(wireless: boolean): Uint8Array {
  const command = wireless ? applyAerox9WirelessFlag(AEROX9_WIRELESS_COMMAND.batteryLevel) : AEROX9_WIRELESS_COMMAND.batteryLevel;
  return new Uint8Array(command);
}

export interface Aerox9WirelessBattery {
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
export function steelseriesAerox9WirelessDecodeBattery(payload: Uint8Array): Aerox9WirelessBattery {
  if (payload.length < AEROX9_WIRELESS_BATTERY_RESPONSE_LENGTH) {
    throw new Aerox9WirelessProtocolError(
      "SteelSeries Aerox 9 Wireless battery response is shorter than two bytes.",
    );
  }
  const statusByte = payload[1]!;
  const isCharging = (statusByte & BATTERY_CHARGING_FLAG) !== 0;
  const level = ((statusByte & ~BATTERY_CHARGING_FLAG) - 1) * 5;
  return { level, isCharging };
}
