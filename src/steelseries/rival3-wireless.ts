/**
 * SteelSeries Rival 3 Wireless configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/rival3_wireless.py` — the primary source for
 *   every command byte, product id, and default here. Read in full for this
 *   cluster; not assumed from any other SteelSeries device file.
 * - rivalcfg `rivalcfg/devices/dpi/truemove_air.py` — the DPI byte table for
 *   this device's TrueMove Air sensor. **This is a distinct table from
 *   `./rival3.ts`'s `TRUEMOVE_CORE_DPI_TO_BYTE`** (used by Rival 3 Gen 1 and
 *   Aerox 3): TrueMove Air starts at 100 DPI (Core starts at 200), covers
 *   100–18000 in 100 DPI steps (180 entries; Core tops out at 8500 in 84
 *   entries), and the byte values at shared DPI numbers differ (e.g.
 *   400 DPI is `0x04` here vs. `0x08` for Core; 1600 DPI is `0x12` here vs.
 *   `0x24` for Core). Reusing Core's table for this device would silently
 *   set the wrong sensitivity, so this module defines its own
 *   `TRUEMOVE_AIR_DPI_TO_BYTE` and does not import Core's.
 * - rivalcfg `rivalcfg/handlers/multidpi_range_choice.py` — the DPI preset
 *   packet shape, same handler as Rival 3 Gen 1/Aerox 3 but with
 *   `dpi_length_byte: 2` (little-endian two bytes per preset — Rival 3 Gen 1
 *   and Aerox 3 both use one byte per preset, so a preset list here is twice
 *   as long as an equivalent list for those families).
 * - rivalcfg `rivalcfg/handlers/buttons/buttons.py` — the fixed-width button
 *   field layout, 6 buttons only (no `scrollUp`/`scrollDown` remap *slots* —
 *   this device profile has no such button entries — though `ScrollUp`
 *   (`0x31`) and `ScrollDown` (`0x32`) remain valid remap *targets*, same as
 *   `dpi` (`0x30`)).
 * - rivalcfg's `usbhid.py` / `mouse.py` framing conventions, shared with
 *   `./rival3.ts` and `./aerox3.ts` (unnumbered HID output reports on the
 *   vendor configuration interface, `"endpoint": 3`).
 *
 * ## Why this is a separate protocol family from Rival 3 Gen 1 and Aerox 3
 *
 * Despite the shared "Rival 3" name, `rival3_wireless.py` is confirmed as a
 * genuinely separate command set from both siblings, verified directly from
 * the source rather than assumed from the family name:
 *
 * - Product id `1038:1830` ("2.4 GHz mode", endpoint 3) — distinct from Rival
 *   3 Gen 1's `1038:1824`/`184C` and Aerox 3's `1038:1836`.
 * - Sensitivity command `0x20` (single-byte prefix, like Aerox 3's `0x2D` but
 *   a different byte) vs. Rival 3 Gen 1's two-byte `0x0B 0x00`.
 * - Polling command `0x17` with choices `{125:0x03, 250:0x02, 500:0x01,
 *   1000:0x00}` — the same four rates as Gen 1/Aerox 3 but a **different
 *   command byte** (`0x17` here vs. `0x04 0x00` / `0x2B`); the value mapping
 *   is byte-identical, only the command prefix differs.
 * - Buttons command `0x19` vs. Gen 1's undocumented `0x07 0x00` and Aerox 3's
 *   `0x2A`.
 * - Save command `0x09` (**one byte**) — distinct from Rival 3 Gen 1's
 *   `0x09 0x00` (two bytes, same leading byte, easy to confuse) and Aerox 3's
 *   `0x11 0x00`.
 * - Firmware query `0x90 0x00` — distinct from Rival 3 Gen 1's `0x10 0x00`.
 *   Aerox 3 has no firmware query at all.
 * - A `battery_level` read (`0xAA 0x01`, three-byte response) that neither
 *   Rival 3 Gen 1 nor Aerox 3 profile defines at all — see below.
 *
 * `rivalcfg/devices/devices.py`'s `SUPPORTED_DEVICES` lists `rival3_wireless`
 * and `rival3_wireless_gen2` (`1038:1872`) as separate profile modules from
 * each other and from `rival3.py`/`aerox3.py`; nothing here claims `0x1872`
 * — the Wireless Gen 2 is a different device with its own (unread) command
 * set and is out of scope for this cluster.
 *
 * No corroborating libratbag or OpenRGB source for this exact device/PID was
 * available in this environment (no local libratbag checkout, and OpenRGB's
 * SteelSeries controllers were not searched for a Rival 3 Wireless-specific
 * file this pass) — every command byte above is sourced from rivalcfg alone.
 * This should be treated as a single-source reconstruction until corroborated
 * or hardware-verified.
 *
 * ## Battery / charging read — this device IS partially readable
 *
 * Unlike the wired Rival 3 Gen 1 and Aerox 3 (write-only, no getters at
 * all), `rival3_wireless.py` defines a top-level `battery_level` block: an
 * output-report write of `0xAA 0x01` gets a 3-byte input-report reply, where
 * `data[0]` is the battery percentage (`level`) and `data[2]` is a
 * charging boolean (`is_charging`, `bool(data[2])`) — `data[1]` is unused by
 * rivalcfg's lambdas. This module exposes `steelseriesRival3WirelessBatteryQuery`
 * / `steelseriesRival3WirelessDecodeBattery` so the HID client can wire a real
 * `readStatus` battery read instead of reporting `batteryState: "Unknown"`.
 * The firmware query (`0x90 0x00`, 2-byte reply) is also readable, following
 * the same pattern as `./rival3.ts`'s `10 00`.
 *
 * DPI presets, polling rate, and buttons remain write-only: `rival3_wireless.py`
 * defines no getter for any of the three, same as every other SteelSeries
 * profile in rivalcfg.
 *
 * Settings apply immediately; the save command (`09`) persists them to
 * onboard flash, mirroring the other two families' CLI default. None of this
 * has been verified on physical hardware by this project.
 */

export const RIVAL3_WIRELESS_REPORT_ID = 0x00;

/** Command prefixes; length varies by command, matching rivalcfg exactly. */
export const RIVAL3_WIRELESS_COMMAND = {
  sensitivity: [0x20],
  pollingRate: [0x17],
  buttonsMapping: [0x19],
  /** `AA 01` — battery percentage + charging state, 3-byte input-report reply. */
  batteryLevel: [0xaa, 0x01],
  /** One byte — distinct from Rival 3 Gen 1's two-byte `09 00`. */
  save: [0x09],
  /** `90 00` — distinct from Rival 3 Gen 1's `10 00`. */
  firmware: [0x90, 0x00],
} as const;

export const RIVAL3_WIRELESS_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x00],
  [500, 0x01],
  [250, 0x02],
  [125, 0x03],
]);

export const RIVAL3_WIRELESS_DPI_MIN = 100;
export const RIVAL3_WIRELESS_DPI_MAX = 18000;
export const RIVAL3_WIRELESS_DPI_STEP = 100;
export const RIVAL3_WIRELESS_MAX_DPI_PRESETS = 5;
export const RIVAL3_WIRELESS_FIRMWARE_RESPONSE_LENGTH = 2;
export const RIVAL3_WIRELESS_BATTERY_RESPONSE_LENGTH = 3;

/**
 * rivalcfg's TrueMove Air sensor table (`devices/dpi/truemove_air.py`), the
 * sensor used by the Rival 3 Wireless — **not** the TrueMove Core table
 * `./rival3.ts` exports. Values pinned in `rival3-wireless.test.ts` against
 * the source file: 100→0x00, 400→0x04, 1600→0x12, 18000→0xD6.
 */
export const TRUEMOVE_AIR_DPI_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [100, 0x00], [200, 0x02], [300, 0x03], [400, 0x04], [500, 0x05], [600, 0x06],
  [700, 0x07], [800, 0x09], [900, 0x0a], [1000, 0x0b], [1100, 0x0c], [1200, 0x0d],
  [1300, 0x0e], [1400, 0x10], [1500, 0x11], [1600, 0x12], [1700, 0x13], [1800, 0x14],
  [1900, 0x16], [2000, 0x17], [2100, 0x18], [2200, 0x19], [2300, 0x1a], [2400, 0x1b],
  [2500, 0x1d], [2600, 0x1e], [2700, 0x1f], [2800, 0x20], [2900, 0x21], [3000, 0x23],
  [3100, 0x25], [3200, 0x26], [3300, 0x27], [3400, 0x28], [3500, 0x29], [3600, 0x2a],
  [3700, 0x2c], [3800, 0x2d], [3900, 0x2e], [4000, 0x2f], [4100, 0x30], [4200, 0x32],
  [4300, 0x33], [4400, 0x34], [4500, 0x35], [4600, 0x36], [4700, 0x38], [4800, 0x39],
  [4900, 0x3a], [5000, 0x3b], [5100, 0x3c], [5200, 0x3e], [5300, 0x3f], [5400, 0x40],
  [5500, 0x41], [5600, 0x42], [5700, 0x44], [5800, 0x45], [5900, 0x46], [6000, 0x47],
  [6100, 0x48], [6200, 0x4a], [6300, 0x4b], [6400, 0x4c], [6500, 0x4d], [6600, 0x4e],
  [6700, 0x50], [6800, 0x51], [6900, 0x52], [7000, 0x53], [7100, 0x54], [7200, 0x56],
  [7300, 0x57], [7400, 0x58], [7500, 0x59], [7600, 0x5a], [7700, 0x5c], [7800, 0x5d],
  [7900, 0x5e], [8000, 0x5f], [8100, 0x60], [8200, 0x62], [8300, 0x63], [8400, 0x64],
  [8500, 0x65], [8600, 0x66], [8700, 0x68], [8800, 0x69], [8900, 0x6a], [9000, 0x6b],
  [9100, 0x6c], [9200, 0x6e], [9300, 0x6f], [9400, 0x70], [9500, 0x71], [9600, 0x72],
  [9700, 0x74], [9800, 0x75], [9900, 0x76], [10000, 0x77], [10100, 0x78], [10200, 0x7a],
  [10300, 0x7b], [10400, 0x7c], [10500, 0x7d], [10600, 0x7e], [10700, 0x80], [10800, 0x81],
  [10900, 0x82], [11000, 0x83], [11100, 0x84], [11200, 0x86], [11300, 0x87], [11400, 0x88],
  [11500, 0x89], [11600, 0x8a], [11700, 0x8c], [11800, 0x8d], [11900, 0x8e], [12000, 0x8f],
  [12100, 0x90], [12200, 0x92], [12300, 0x93], [12400, 0x94], [12500, 0x95], [12600, 0x96],
  [12700, 0x98], [12800, 0x99], [12900, 0x9a], [13000, 0x9b], [13100, 0x9c], [13200, 0x9e],
  [13300, 0x9f], [13400, 0xa0], [13500, 0xa1], [13600, 0xa2], [13700, 0xa4], [13800, 0xa5],
  [13900, 0xa6], [14000, 0xa7], [14100, 0xa8], [14200, 0xaa], [14300, 0xab], [14400, 0xac],
  [14500, 0xad], [14600, 0xae], [14700, 0xb0], [14800, 0xb1], [14900, 0xb2], [15000, 0xb3],
  [15100, 0xb4], [15200, 0xb5], [15300, 0xb6], [15400, 0xb7], [15500, 0xb8], [15600, 0xb9],
  [15700, 0xba], [15800, 0xbb], [15900, 0xbc], [16000, 0xbd], [16100, 0xbf], [16200, 0xc0],
  [16300, 0xc2], [16400, 0xc3], [16500, 0xc4], [16600, 0xc5], [16700, 0xc6], [16800, 0xc7],
  [16900, 0xc9], [17000, 0xca], [17100, 0xcb], [17200, 0xcc], [17300, 0xcd], [17400, 0xcf],
  [17500, 0xd0], [17600, 0xd1], [17700, 0xd2], [17800, 0xd3], [17900, 0xd5], [18000, 0xd6],
]);

export class Rival3WirelessProtocolError extends Error {}

/** The 180 DPI values the TrueMove Air sensor table can express, ascending. */
export function steelseriesRival3WirelessDpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `20 <count> <selected> <v1_lo> <v1_hi>…<vN_lo> <vN_hi>` — replaces the
 * mouse's whole preset table. Two little-endian bytes per DPI
 * (`dpi_length_byte: 2`, unlike Rival 3 Gen 1/Aerox 3's one byte); the high
 * byte is always `0x00` since the TrueMove Air table only produces values up
 * to `0xD6`, but both bytes are always sent to match the wire format exactly.
 * `selectedIndex` is 0-based here and encoded 1-based on the wire
 * (`first_preset: 1`).
 */
export function steelseriesRival3WirelessEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length < 1 || presets.length > RIVAL3_WIRELESS_MAX_DPI_PRESETS) {
    throw new Rival3WirelessProtocolError(
      `SteelSeries Rival 3 Wireless supports 1–${RIVAL3_WIRELESS_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Rival3WirelessProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded: number[] = [];
  for (const dpi of presets) {
    const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new Rival3WirelessProtocolError(
        `SteelSeries Rival 3 Wireless DPI must be ${RIVAL3_WIRELESS_DPI_MIN}–${RIVAL3_WIRELESS_DPI_MAX.toLocaleString()} in ${RIVAL3_WIRELESS_DPI_STEP} DPI steps.`,
      );
    }
    encoded.push(byte & 0xff, 0x00);
  }
  return new Uint8Array([
    ...RIVAL3_WIRELESS_COMMAND.sensitivity,
    presets.length,
    selectedIndex + 1,
    ...encoded,
  ]);
}

/** `17 <v>` with 1000→0x00, 500→0x01, 250→0x02, 125→0x03 (different byte order than Rival 3 Gen 1/Aerox 3). */
export function steelseriesRival3WirelessEncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Rival3WirelessProtocolError(
      "SteelSeries Rival 3 Wireless supports 125, 250, 500, or 1000 Hz polling.",
    );
  }
  return new Uint8Array([...RIVAL3_WIRELESS_COMMAND.pollingRate, byte]);
}

/** `09` — commit the current settings to onboard flash. One byte, unlike Rival 3 Gen 1's `09 00`. */
export function steelseriesRival3WirelessSaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL3_WIRELESS_COMMAND.save);
}

/** `90 00` — the device answers with a two-byte input report. */
export function steelseriesRival3WirelessFirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL3_WIRELESS_COMMAND.firmware);
}

export interface Rival3WirelessFirmware {
  /** The two raw response bytes, in the order the device sent them. */
  bytes: [number, number];
  /** The bytes joined in read order, e.g. "37.0". */
  display: string;
}

/** Decode the two-byte firmware response, same read-order convention as `./rival3.ts`. */
export function steelseriesRival3WirelessDecodeFirmware(payload: Uint8Array): Rival3WirelessFirmware {
  if (payload.length < RIVAL3_WIRELESS_FIRMWARE_RESPONSE_LENGTH) {
    throw new Rival3WirelessProtocolError(
      "SteelSeries Rival 3 Wireless firmware response is shorter than two bytes.",
    );
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[0]}.${bytes[1]}` };
}

/** `AA 01` — the device answers with a three-byte input report (level, unused, charging). */
export function steelseriesRival3WirelessBatteryQuery(): Uint8Array {
  return new Uint8Array(RIVAL3_WIRELESS_COMMAND.batteryLevel);
}

export interface Rival3WirelessBattery {
  /** Battery percentage, `data[0]` verbatim (rivalcfg does not clamp it). */
  level: number;
  /** `bool(data[2])` in rivalcfg — `data[1]` is not used by either lambda. */
  isCharging: boolean;
}

/**
 * Decode the three-byte battery response: `data[0]` is the percentage
 * (rivalcfg's `level` lambda, `int(data[0])`), `data[2]` is charging state
 * (rivalcfg's `is_charging` lambda, `bool(data[2])`). `data[1]` is present in
 * the response but unused by either rivalcfg lambda.
 */
export function steelseriesRival3WirelessDecodeBattery(payload: Uint8Array): Rival3WirelessBattery {
  if (payload.length < RIVAL3_WIRELESS_BATTERY_RESPONSE_LENGTH) {
    throw new Rival3WirelessProtocolError(
      "SteelSeries Rival 3 Wireless battery response is shorter than three bytes.",
    );
  }
  return { level: payload[0]!, isCharging: payload[2]! !== 0 };
}

// -- Button mapping ---------------------------------------------------------

interface Rival3WirelessButtonSlot {
  id: number;
  offset: number;
}

/** `buttons_mapping.buttons` from `rival3_wireless.py`, id + byte offset into the packet. */
export const RIVAL3_WIRELESS_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
} as const satisfies Record<string, Rival3WirelessButtonSlot>;

export type Rival3WirelessButtonName = keyof typeof RIVAL3_WIRELESS_BUTTONS;

const RIVAL3_WIRELESS_BUTTON_FIELD_LENGTH = 5;
const RIVAL3_WIRELESS_BUTTON_DISABLE = 0x00;
const RIVAL3_WIRELESS_BUTTON_DPI_SWITCH = 0x30;
const RIVAL3_WIRELESS_BUTTON_SCROLL_UP = 0x31;
const RIVAL3_WIRELESS_BUTTON_SCROLL_DOWN = 0x32;
const RIVAL3_WIRELESS_BUTTON_KEYBOARD = 0x51;
const RIVAL3_WIRELESS_BUTTON_MULTIMEDIA = 0x61;

/**
 * One button's target. Unlike `./aerox3.ts`, this device profile has no
 * `scrollUp`/`scrollDown` button *slots* to remap from — only 6 physical
 * buttons — but `scrollUp`/`scrollDown` remain valid remap *targets*
 * (`button_scroll_up: 0x31`, `button_scroll_down: 0x32` in the source), same
 * as `dpiSwitch`.
 */
export type Rival3WirelessButtonAction =
  | { type: "button"; target: Rival3WirelessButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "scrollUp" }
  | { type: "scrollDown" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/**
 * `19` + one 30-byte (`6 buttons × 5-byte field length`) packet, zero-filled
 * except where a mapping is given. Unmapped buttons are left as all-zero
 * fields (rivalcfg instead fills in per-button defaults; this codec leaves
 * that policy to the caller — pass every button explicitly for parity with
 * rivalcfg's default profile).
 */
export function steelseriesRival3WirelessEncodeButtonsMapping(
  mapping: Partial<Record<Rival3WirelessButtonName, Rival3WirelessButtonAction>>,
): Uint8Array {
  const names = Object.keys(RIVAL3_WIRELESS_BUTTONS) as Rival3WirelessButtonName[];
  const packet = new Array<number>(names.length * RIVAL3_WIRELESS_BUTTON_FIELD_LENGTH).fill(0x00);

  for (const [name, action] of Object.entries(mapping) as Array<[Rival3WirelessButtonName, Rival3WirelessButtonAction]>) {
    const slot = RIVAL3_WIRELESS_BUTTONS[name];
    if (!slot) {
      throw new Rival3WirelessProtocolError(`Unknown SteelSeries Rival 3 Wireless button "${name}".`);
    }
    const { offset } = slot;
    switch (action.type) {
      case "button": {
        packet[offset] = RIVAL3_WIRELESS_BUTTONS[action.target].id;
        break;
      }
      case "disabled": {
        packet[offset] = RIVAL3_WIRELESS_BUTTON_DISABLE;
        break;
      }
      case "dpiSwitch": {
        packet[offset] = RIVAL3_WIRELESS_BUTTON_DPI_SWITCH;
        break;
      }
      case "scrollUp": {
        packet[offset] = RIVAL3_WIRELESS_BUTTON_SCROLL_UP;
        break;
      }
      case "scrollDown": {
        packet[offset] = RIVAL3_WIRELESS_BUTTON_SCROLL_DOWN;
        break;
      }
      case "keyboard": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Rival3WirelessProtocolError("Keyboard scan codes must be integers 0–255.");
        }
        packet[offset] = RIVAL3_WIRELESS_BUTTON_KEYBOARD;
        packet[offset + 1] = action.code;
        break;
      }
      case "multimedia": {
        if (!Number.isInteger(action.code) || action.code < 0 || action.code > 255) {
          throw new Rival3WirelessProtocolError("Multimedia key codes must be integers 0–255.");
        }
        packet[offset] = RIVAL3_WIRELESS_BUTTON_MULTIMEDIA;
        packet[offset + 1] = action.code;
        break;
      }
      default: {
        throw new Rival3WirelessProtocolError("Unsupported SteelSeries Rival 3 Wireless button action.");
      }
    }
  }

  return new Uint8Array([...RIVAL3_WIRELESS_COMMAND.buttonsMapping, ...packet]);
}
