/**
 * steelseries aerox 3 wireless configuration protocol, pure encode/decode helpers.
 *
 * transcribed from rivalcfg `rivalcfg/devices/aerox3_wireless_wired.py` for the
 * usb-cabled mode, `1038:183A` and the cs2 dragon lore edition `1038:187A`, and
 * `aerox3_wireless_wireless.py` for the 2.4 ghz dongle mode, `1038:1838` and
 * `1038:1878`. the dongle profile is the wired settings dict passed through a
 * `_patch_command` helper that ors `0b01000000` into byte 0 of every command,
 * implemented here as `applyAerox3WirelessFlag`.
 *
 * the settings dict is byte-identical to `aerox5_wireless_wired.py` except for
 * `buttons_mapping`: the aerox 3 wireless has 6 buttons plus scroll up/down, so
 * its packet is 40 bytes with the scroll fields at `0x1E`/`0x23`, where the
 * aerox 5 wireless has 9 buttons and a 55-byte packet. it is also unrelated to
 * the wired-only aerox 3 in `./aerox3.ts`, whose polling bytes, zone packing,
 * rainbow command and dpi preset base all differ.
 *
 * every command is an hid output report with report id `0x00` on the usage page
 * `0xFFC0` collection. settings are write-only and the mouse acks each write by
 * echoing its command byte followed by `00`. battery level is readable through
 * `92`. the save command `11 00` persists dpi, polling, timers and buttons, but
 * zone colors are lost at power-off and the mouse boots into its default
 * lighting, as rivalcfg's docs warn for newer steelseries mice.
 */

import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

export const AEROX3_WIRELESS_REPORT_ID = 0x00;

const WIRELESS_FLAG = 0b01000000;

/** wired-mode command bytes, see `applyAerox3WirelessFlag` for 2.4 ghz mode. */
export const AEROX3_WIRELESS_COMMAND = {
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

export const AEROX3_WIRELESS_SAVE_COMMAND = [0x11, 0x00] as const;

/** rivalcfg `_patch_command`: ors `0x40` into the first byte. */
export function applyAerox3WirelessFlag(command: readonly number[]): number[] {
  if (command.length === 0) {
    throw new Aerox3WirelessProtocolError("Cannot apply the wireless flag to an empty command.");
  }
  return [command[0]! | WIRELESS_FLAG, ...command.slice(1)];
}

function frame(command: readonly number[], wireless: boolean): number[] {
  return wireless ? applyAerox3WirelessFlag(command) : [...command];
}

export const AEROX3_WIRELESS_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x00],
  [500, 0x01],
  [250, 0x02],
  [125, 0x03],
]);

export const AEROX3_WIRELESS_DPI_MIN = 100;
export const AEROX3_WIRELESS_DPI_MAX = 18000;
export const AEROX3_WIRELESS_DPI_STEP = 100;
export const AEROX3_WIRELESS_MAX_DPI_PRESETS = 5;
export const AEROX3_WIRELESS_SLEEP_TIMER_MAX_MINUTES = 20;
export const AEROX3_WIRELESS_DIM_TIMER_MAX_SECONDS = 1200;
export const AEROX3_WIRELESS_BATTERY_RESPONSE_LENGTH = 2;

/** rivalcfg profile defaults. */
export const AEROX3_WIRELESS_DEFAULT_DPI_PRESETS = [400, 800, 1200, 2400, 3200] as const;
export const AEROX3_WIRELESS_DEFAULT_POLLING_RATE = 1000;
export const AEROX3_WIRELESS_DEFAULT_SLEEP_TIMER_MINUTES = 5;
export const AEROX3_WIRELESS_DEFAULT_DIM_TIMER_SECONDS = 30;

const BATTERY_CHARGING_FLAG = 0b10000000;

export class Aerox3WirelessProtocolError extends Error {}

/** every dpi the truemove air table can express, ascending. */
export function steelseriesAerox3WirelessDpiOptions(): number[] {
  return [...TRUEMOVE_AIR_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/** `2D <count> <selected> <v1>...<vN>`, one byte per dpi, `selectedIndex` is 0-based on the wire. */
export function steelseriesAerox3WirelessEncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
  wireless: boolean,
): Uint8Array {
  if (presets.length < 1 || presets.length > AEROX3_WIRELESS_MAX_DPI_PRESETS) {
    throw new Aerox3WirelessProtocolError(
      `SteelSeries Aerox 3 Wireless supports 1 to ${AEROX3_WIRELESS_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new Aerox3WirelessProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_AIR_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new Aerox3WirelessProtocolError(
        `SteelSeries Aerox 3 Wireless DPI must be ${AEROX3_WIRELESS_DPI_MIN} to ${AEROX3_WIRELESS_DPI_MAX.toLocaleString("en-US")} in ${AEROX3_WIRELESS_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  return new Uint8Array([...frame(AEROX3_WIRELESS_COMMAND.dpiPresets, wireless), presets.length, selectedIndex, ...encoded]);
}

/** `2B <v>` with 1000 as `0x00` down to 125 as `0x03`. */
export function steelseriesAerox3WirelessEncodePollingRate(pollingRateHz: number, wireless: boolean): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new Aerox3WirelessProtocolError(
      "SteelSeries Aerox 3 Wireless supports 125, 250, 500, or 1000 Hz polling.",
    );
  }
  return new Uint8Array([...frame(AEROX3_WIRELESS_COMMAND.pollingRate, wireless), byte]);
}

export interface Aerox3WirelessRgb {
  r: number;
  g: number;
  b: number;
}

function encodeRgb({ r, g, b }: Aerox3WirelessRgb): [number, number, number] {
  for (const channel of [r, g, b]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Aerox3WirelessProtocolError("RGB channels must be integers from 0 to 255.");
    }
  }
  return [r, g, b];
}

/** zone 1 is the top led of the strip, 2 the middle one, 3 the bottom one. */
export type Aerox3WirelessZone = 1 | 2 | 3;

export const AEROX3_WIRELESS_ZONES = [1, 2, 3] as const satisfies readonly Aerox3WirelessZone[];

/** rivalcfg defaults are red, lime and blue. */
export const AEROX3_WIRELESS_DEFAULT_ZONE_COLORS: Readonly<Record<Aerox3WirelessZone, Aerox3WirelessRgb>> = {
  1: { r: 0xff, g: 0x00, b: 0x00 },
  2: { r: 0x00, g: 0xff, b: 0x00 },
  3: { r: 0x00, g: 0x00, b: 0xff },
};

/** `21 01 <zone index> <r> <g> <b>`. */
export function steelseriesAerox3WirelessEncodeZoneColor(
  zone: Aerox3WirelessZone,
  color: Aerox3WirelessRgb,
  wireless: boolean,
): Uint8Array {
  if (!AEROX3_WIRELESS_ZONES.includes(zone)) {
    throw new Aerox3WirelessProtocolError(
      "SteelSeries Aerox 3 Wireless has zones 1 (top), 2 (middle), and 3 (bottom) only.",
    );
  }
  return new Uint8Array([...frame(AEROX3_WIRELESS_COMMAND.zoneColor, wireless), zone - 1, ...encodeRgb(color)]);
}

/** `26 01 00 <r> <g> <b>` when enabled, `26 00 00 00 00 00` when `color` is null. */
export function steelseriesAerox3WirelessEncodeReactiveColor(
  color: Aerox3WirelessRgb | null,
  wireless: boolean,
): Uint8Array {
  const command = frame(AEROX3_WIRELESS_COMMAND.reactiveColor, wireless);
  if (color === null) {
    return new Uint8Array([...command, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  return new Uint8Array([...command, 0x01, 0x00, ...encodeRgb(color)]);
}

function encodeMillisecondsLE24(value: number, max: number, unit: string, msPerUnit: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Aerox3WirelessProtocolError(`SteelSeries Aerox 3 Wireless ${unit} must be an integer from 0 to ${max}.`);
  }
  const ms = value * msPerUnit;
  return [ms & 0xff, (ms >> 8) & 0xff, (ms >> 16) & 0xff];
}

/** `29 <ms LE24>`, idle minutes before sleep, 0 disables it. */
export function steelseriesAerox3WirelessEncodeSleepTimer(minutes: number, wireless: boolean): Uint8Array {
  const bytes = encodeMillisecondsLE24(minutes, AEROX3_WIRELESS_SLEEP_TIMER_MAX_MINUTES, "sleep timer minutes", 60_000);
  return new Uint8Array([...frame(AEROX3_WIRELESS_COMMAND.sleepTimer, wireless), ...bytes]);
}

/** `23 0F 01 00 00 <ms LE24>`, idle seconds before the leds dim, 0 disables it. */
export function steelseriesAerox3WirelessEncodeDimTimer(seconds: number, wireless: boolean): Uint8Array {
  const bytes = encodeMillisecondsLE24(seconds, AEROX3_WIRELESS_DIM_TIMER_MAX_SECONDS, "dim timer seconds", 1_000);
  return new Uint8Array([...frame(AEROX3_WIRELESS_COMMAND.dimTimer, wireless), ...bytes]);
}

/**
 * `22 FF`, rivalcfg's rainbow on every zone. a `1038:183A` unit acks it but the
 * strip stays dark, use the `rainbow` default lighting instead.
 */
export function steelseriesAerox3WirelessEncodeRainbowEffect(wireless: boolean): Uint8Array {
  return new Uint8Array(frame(AEROX3_WIRELESS_COMMAND.rainbowEffect, wireless));
}

export const AEROX3_WIRELESS_DEFAULT_LIGHTING = {
  off: [0x00, 0x00],
  reactive: [0x00, 0x01],
  rainbow: [0x01, 0x00],
  "reactive-rainbow": [0x01, 0x01],
} as const;

export type Aerox3WirelessDefaultLighting = keyof typeof AEROX3_WIRELESS_DEFAULT_LIGHTING;

/** `27 <v1> <v2>`, the lighting shown before a host sends any color. */
export function steelseriesAerox3WirelessEncodeDefaultLighting(
  mode: Aerox3WirelessDefaultLighting,
  wireless: boolean,
): Uint8Array {
  const bytes = Object.hasOwn(AEROX3_WIRELESS_DEFAULT_LIGHTING, mode) ? AEROX3_WIRELESS_DEFAULT_LIGHTING[mode] : undefined;
  if (bytes === undefined) {
    throw new Aerox3WirelessProtocolError(
      `SteelSeries Aerox 3 Wireless default lighting must be one of: ${Object.keys(AEROX3_WIRELESS_DEFAULT_LIGHTING).join(", ")}.`,
    );
  }
  return new Uint8Array([...frame(AEROX3_WIRELESS_COMMAND.defaultLighting, wireless), ...bytes]);
}

/** `11 00`, commits the current settings to onboard flash. */
export function steelseriesAerox3WirelessSaveCommand(wireless: boolean): Uint8Array {
  return new Uint8Array(frame(AEROX3_WIRELESS_SAVE_COMMAND, wireless));
}

/** `92`, answered by a two-byte input report. */
export function steelseriesAerox3WirelessBatteryQuery(wireless: boolean): Uint8Array {
  return new Uint8Array(frame(AEROX3_WIRELESS_COMMAND.batteryLevel, wireless));
}

export interface Aerox3WirelessBattery {
  /** 0 to 100 in steps of 5. */
  level: number;
  isCharging: boolean;
}

/** `data[1]` holds the charging flag in its top bit and a 1-based level in steps of 5 below it. */
export function steelseriesAerox3WirelessDecodeBattery(payload: Uint8Array): Aerox3WirelessBattery {
  if (payload.length < AEROX3_WIRELESS_BATTERY_RESPONSE_LENGTH) {
    throw new Aerox3WirelessProtocolError(
      "SteelSeries Aerox 3 Wireless battery response is shorter than two bytes.",
    );
  }
  const statusByte = payload[1]!;
  const raw = statusByte & ~BATTERY_CHARGING_FLAG;
  return {
    level: Math.min(100, Math.max(0, (raw - 1) * 5)),
    isCharging: (statusByte & BATTERY_CHARGING_FLAG) !== 0,
  };
}

// -- button mapping ---------------------------------------------------------

/** `buttons_mapping.buttons` from `aerox3_wireless_wired.py`. */
export const AEROX3_WIRELESS_BUTTONS = {
  button1: { id: 0x01, offset: 0x00 },
  button2: { id: 0x02, offset: 0x05 },
  button3: { id: 0x03, offset: 0x0a },
  button4: { id: 0x04, offset: 0x0f },
  button5: { id: 0x05, offset: 0x14 },
  button6: { id: 0x06, offset: 0x19 },
  scrollUp: { id: 0x31, offset: 0x1e },
  scrollDown: { id: 0x32, offset: 0x23 },
} as const satisfies Record<string, { id: number; offset: number }>;

export type Aerox3WirelessButtonName = keyof typeof AEROX3_WIRELESS_BUTTONS;

const BUTTON_FIELD_LENGTH = 5;
const BUTTON_DISABLE = 0x00;
const BUTTON_DPI_SWITCH = 0x30;
const BUTTON_KEYBOARD = 0x51;
const BUTTON_MULTIMEDIA = 0x61;

/**
 * a button's target. any physical button, scroll included, is a valid target:
 * rivalcfg resolves `scrollup` through the buttons table, which is how its
 * default profile keeps the wheel working.
 */
export type Aerox3WirelessButtonAction =
  | { type: "button"; target: Aerox3WirelessButtonName }
  | { type: "disabled" }
  | { type: "dpiSwitch" }
  | { type: "keyboard"; code: number }
  | { type: "multimedia"; code: number };

/** rivalcfg's default mapping, button 6 being the dpi cycle button behind the wheel. */
export const AEROX3_WIRELESS_DEFAULT_BUTTONS: Readonly<Record<Aerox3WirelessButtonName, Aerox3WirelessButtonAction>> = {
  button1: { type: "button", target: "button1" },
  button2: { type: "button", target: "button2" },
  button3: { type: "button", target: "button3" },
  button4: { type: "button", target: "button4" },
  button5: { type: "button", target: "button5" },
  button6: { type: "dpiSwitch" },
  scrollUp: { type: "button", target: "scrollUp" },
  scrollDown: { type: "button", target: "scrollDown" },
};

/** rivalcfg `layout_multimedia.py`, the low byte of each consumer usage. */
export const AEROX3_WIRELESS_MULTIMEDIA_KEYS = {
  mute: 0xe2,
  next: 0xb5,
  playPause: 0xcd,
  previous: 0xb6,
  volumeUp: 0xe9,
  volumeDown: 0xea,
} as const;

function encodeKeyCode(code: number, kind: string): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new Aerox3WirelessProtocolError(`${kind} codes must be integers from 0 to 255.`);
  }
  return code;
}

/**
 * `2A` followed by a 40-byte packet, 5 bytes per button. like rivalcfg, any
 * button missing from `mapping` gets its default action, so remapping one
 * button never disables the others.
 */
export function steelseriesAerox3WirelessEncodeButtonsMapping(
  mapping: Partial<Record<Aerox3WirelessButtonName, Aerox3WirelessButtonAction>>,
  wireless: boolean,
): Uint8Array {
  for (const name of Object.keys(mapping)) {
    if (!Object.hasOwn(AEROX3_WIRELESS_BUTTONS, name)) {
      throw new Aerox3WirelessProtocolError(`Unknown SteelSeries Aerox 3 Wireless button "${name}".`);
    }
  }

  const names = Object.keys(AEROX3_WIRELESS_BUTTONS) as Aerox3WirelessButtonName[];
  const packet = new Array<number>(names.length * BUTTON_FIELD_LENGTH).fill(0x00);

  for (const name of names) {
    const action = mapping[name] ?? AEROX3_WIRELESS_DEFAULT_BUTTONS[name];
    const { offset } = AEROX3_WIRELESS_BUTTONS[name];
    switch (action.type) {
      case "button": {
        if (!Object.hasOwn(AEROX3_WIRELESS_BUTTONS, action.target)) {
          throw new Aerox3WirelessProtocolError(`Unknown SteelSeries Aerox 3 Wireless button "${action.target}".`);
        }
        packet[offset] = AEROX3_WIRELESS_BUTTONS[action.target].id;
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
        throw new Aerox3WirelessProtocolError("Unsupported SteelSeries Aerox 3 Wireless button action.");
      }
    }
  }

  return new Uint8Array([...frame(AEROX3_WIRELESS_COMMAND.buttonsMapping, wireless), ...packet]);
}
