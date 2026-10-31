/*
 * Holtek transport shared by the Redragon M724 and M612, decoded from
 * RDCfg.exe (sha256 ddfab882...7294) and confirmed on both mice: the
 * settings are one flat memory behind 16-byte feature report 2 on the
 * `0xFFA0:0x01` collection (USB interface 2).
 *
 *   write  [02 F3 addrLo addrHi len 00 00 00 data...]       (len <= 8)
 *   read   [02 F2 addrLo addrHi len ...], then GET_FEATURE
 *          -> [02 08 addrLo 32+addrHi len 00 FA FA data...]
 *   commit [02 F1 02 code]
 *   bracket [02 F5 00] ... [02 F5 01] around a write session
 *
 * There is no checksum. Malformed frames STALL, and a session left open
 * hangs the interface until replug.
 */

import { KEY_USAGES, SHORTCUTS, keyName } from "./keys.js";

export const REDRAGON_VENDOR_ID = 0x04d9; // Holtek Semiconductor
export const REDRAGON_CONFIG_USAGE_PAGE = 0xffa0;
export const REDRAGON_CONFIG_USAGE = 0x01;
export const REDRAGON_REPORT_ID = 2;
export const REDRAGON_REPORT_SIZE = 16;

/** First payload byte of a config write (report id excluded). */
export const REDRAGON_CMD_WRITE = 0xf3;
/** First payload byte of a settings read (report id excluded). */
export const REDRAGON_CMD_READ = 0xf2;
/** First payload byte of the session bracket (report id excluded). */
export const REDRAGON_CMD_HELLO = 0xf5;
/** First payload byte of a commit write (report id excluded). */
export const REDRAGON_CMD_COMMIT = 0xf1;
/** First payload byte of every GET_FEATURE answer (report id excluded). */
export const REDRAGON_REPLY_TAG = 0x08;
/** Length of the answer header before the data bytes (report id excluded). */
export const REDRAGON_REPLY_HEADER = 7;
/** Most data bytes one read or write frame carries. */
export const REDRAGON_MAX_TRANSFER = 8;

/** Write section of the commit block. */
export const REDRAGON_COMMIT_SECTION = 0x02;
/**
 * Commit codes RDCfg sends after a button write (`SendButtonRefesh`), in
 * order. Each reloads one area (01 profile, 02 DPI, 04 lighting, 08 polling
 * and lift-off); a write without its commit is stored but only takes effect
 * at boot. The whole block is sent after every write.
 */
export const REDRAGON_COMMIT_CODES = [0x04, 0x01, 0x02, 0x08, 0x10] as const;

export const REDRAGON_POLLING_RATES = [125, 250, 500, 1000] as const;
/** Polling code per rate: code = 1000 / Hz. */
export const REDRAGON_POLLING_CODES: Readonly<Record<number, number>> = {
  1000: 0x01,
  500: 0x02,
  250: 0x04,
  125: 0x08,
};

/** Rejects addresses outside 16 bits and lengths a single frame cannot carry. */
function checkTransfer(address: number, length: number): void {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new Error(`Redragon address ${address} is outside 0x0000-0xffff.`);
  }
  if (!Number.isInteger(length) || length < 1 || length > REDRAGON_MAX_TRANSFER) {
    throw new Error(`Redragon transfer length ${length} is outside 1-${REDRAGON_MAX_TRANSFER}.`);
  }
}

/** `[02 F3 addrLo addrHi len 00 00 00 data...]` (full frame, report id included). */
export function redragonEncodeWrite(address: number, data: ArrayLike<number>): Uint8Array {
  checkTransfer(address, data.length);
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_WRITE;
  frame[2] = address & 0xff;
  frame[3] = address >> 8;
  frame[4] = data.length;
  for (let index = 0; index < data.length; index++) {
    const byte = data[index]!;
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new Error(`Redragon data byte ${byte} is not a byte.`);
    frame[8 + index] = byte;
  }
  return frame;
}

/** `[02 F2 addrLo addrHi len ...]` (full frame, report id included). */
export function redragonEncodeRead(address: number, length: number): Uint8Array {
  checkTransfer(address, length);
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_READ;
  frame[2] = address & 0xff;
  frame[3] = address >> 8;
  frame[4] = length;
  return frame;
}

/**
 * Validates the GET_FEATURE answer to `redragonEncodeRead(address, length)`
 * and returns its data bytes. Accepts the answer with or without the leading
 * report id, since WebHID and hidraw differ there.
 */
export function redragonDecodeRead(answer: Uint8Array, address: number, length: number): Uint8Array {
  checkTransfer(address, length);
  const body = answer[0] === REDRAGON_REPORT_ID && answer[1] === REDRAGON_REPLY_TAG ? answer.subarray(1) : answer;
  const hex = [...answer].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  if (
    body.length < REDRAGON_REPLY_HEADER + length ||
    body[0] !== REDRAGON_REPLY_TAG ||
    body[1] !== (address & 0xff) ||
    body[2] !== 0x32 + (address >> 8) ||
    body[3] !== length ||
    body[5] !== 0xfa ||
    body[6] !== 0xfa
  ) {
    throw new Error(`Redragon read of ${length} bytes at 0x${address.toString(16).padStart(4, "0")} got an unexpected answer: ${hex}.`);
  }
  return body.slice(REDRAGON_REPLY_HEADER, REDRAGON_REPLY_HEADER + length);
}

/** Session bracket frame: `[02 F5 00]` opens, `[02 F5 01]` closes. */
export function redragonSession(begin: boolean): Uint8Array {
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_HELLO;
  frame[2] = begin ? 0x00 : 0x01;
  return frame;
}

/** One commit write `[02 F1 02 code]` (full frame, report id included). */
export function redragonEncodeCommit(code: number): Uint8Array {
  const frame = new Uint8Array(REDRAGON_REPORT_SIZE);
  frame[0] = REDRAGON_REPORT_ID;
  frame[1] = REDRAGON_CMD_COMMIT;
  frame[2] = REDRAGON_COMMIT_SECTION;
  frame[3] = code;
  return frame;
}

/*
 * Settings memory layout, identical on the M724 and M612 (RDCfg's
 * `SendPollRate`, `SendLedState`, profile select, DPI and button writers
 * are model-independent; only the codecs below differ).
 */

export const REDRAGON_PROFILE_COUNT = 5;
/** Active onboard profile `[profile, 00]`, 0-4. */
export const REDRAGON_ACTIVE_PROFILE_ADDRESS = 0x002c;
/** Extra commit RDCfg's MODE select sends before the commit block. */
export const REDRAGON_PROFILE_SELECT_CODE = 0x01;
/** Polling code of profile p at `0x32 + 2p`, `[1000 / Hz, 00]`. */
export const REDRAGON_POLL_ADDRESS = 0x0032;
/**
 * Per-profile block bases. `base + 0` is the active DPI stage (0-4); stage
 * slot `n` is the 5 bytes at `base + 2 + 6n`: `[enabled, x, xRange, y, yRange]`.
 */
export const REDRAGON_PROFILE_BASES = [0x0042, 0x0102, 0x01b2, 0x0262, 0x0312] as const;
export const REDRAGON_STAGE_COUNT = 5;
export const REDRAGON_SLOT_LENGTH = 5;
/** Button slot `s` of profile p is the 4 bytes at `button base + 4s`. */
export const REDRAGON_BUTTON_BASES = [0x0082, 0x0142, 0x01f2, 0x02a2, 0x0352] as const;
export const REDRAGON_BUTTON_LENGTH = 4;

export function redragonPollAddress(profile: number): number {
  checkProfile(profile);
  return REDRAGON_POLL_ADDRESS + 2 * profile;
}

/** Address of one DPI stage slot. */
export function redragonSlotAddress(profile: number, stage: number): number {
  checkProfile(profile);
  if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_STAGE_COUNT) {
    throw new Error(`Redragon DPI stage ${stage} is outside 0-${REDRAGON_STAGE_COUNT - 1}.`);
  }
  return REDRAGON_PROFILE_BASES[profile]! + 2 + 6 * stage;
}

/** Rejects profile indexes outside 0-4. */
function checkProfile(profile: number): void {
  if (!Number.isInteger(profile) || profile < 0 || profile >= REDRAGON_PROFILE_COUNT) {
    throw new Error(`Redragon profile ${profile} is outside 0-${REDRAGON_PROFILE_COUNT - 1}.`);
  }
}

export interface RedragonDpiCode {
  value: number;
  range: 0 | 1;
}

/** Slider position whose label is nearest to `dpi` (ties go to the lower one). */
export function redragonNearestDpiPosition(labels: readonly number[], dpi: number, model: string): number {
  if (!Number.isInteger(dpi) || dpi < labels[0]! || dpi > labels[labels.length - 1]!) {
    throw new Error(`Redragon ${model} DPI ${dpi} is outside ${labels[0]}-${labels[labels.length - 1]}.`);
  }
  let best = 0;
  for (let position = 1; position < labels.length; position++) {
    if (Math.abs(labels[position]! - dpi) < Math.abs(labels[best]! - dpi)) best = position;
  }
  return best;
}

/**
 * Keyboard assignments are `[8F, modifiers, usage]` with the HID keyboard
 * modifier bits (1 Ctrl, 2 Shift, 4 Alt, 8 Win) and usage IDs (RDCfg's
 * COMBO KEY and shortcut menus).
 */
export const REDRAGON_KEY_ACTION = 0x8f;
/** RDCfg's SINGLE KEY writes `[90 00 usage 00]` instead (action table `DAT_0049f280`). */
export const REDRAGON_SINGLE_KEY_ACTION = 0x90;

export interface RedragonButtonCodec {
  /** Every action name `encode` accepts, in display order. */
  options: readonly string[];
  /** Four-byte slot value for an action name from `options`. */
  encode(action: string): number[];
  /**
   * Names a slot value: an offered action where the bytes match one exactly,
   * any other keyboard combination by its keys, and anything else (macros,
   * RDCfg's advanced actions) as its raw bytes.
   */
  decode(value: ArrayLike<number>): string;
}

/**
 * Button codec over a model's single-action list plus the shared shortcuts
 * and keys; `keyPrefix` is what a plain "Key X" writes before the usage.
 */
export function redragonButtonCodec(
  model: string,
  actions: ReadonlyArray<readonly [string, readonly number[]]>,
  keyPrefix: readonly number[] = [REDRAGON_KEY_ACTION, 0x00],
): RedragonButtonCodec {
  const usage = (key: string) => KEY_USAGES.find(([name]) => name === key)![1];
  const shortcutName = ([name, modifiers, key]: readonly [string, number, string]) => `${name} (${keyName(modifiers, usage(key))})`;
  const options = [
    ...actions.map(([name]) => name),
    ...SHORTCUTS.map(shortcutName),
    ...KEY_USAGES.map(([name]) => `Key ${name}`),
  ];
  const pad = (bytes: readonly number[]) => [...bytes, 0, 0, 0, 0].slice(0, REDRAGON_BUTTON_LENGTH);
  const encode = (action: string): number[] => {
    const fixed = actions.find(([name]) => name === action);
    if (fixed) return pad(fixed[1]);
    const shortcut = SHORTCUTS.find((entry) => shortcutName(entry) === action);
    if (shortcut) return pad([REDRAGON_KEY_ACTION, shortcut[1], usage(shortcut[2])]);
    const key = action.startsWith("Key ") ? KEY_USAGES.find(([name]) => name === action.slice(4)) : undefined;
    if (key) return pad([...keyPrefix, key[1]]);
    throw new Error(`Redragon ${model} button action "${action}" is not offered.`);
  };
  const decode = (value: ArrayLike<number>): string => {
    const bytes = Array.from(value).slice(0, REDRAGON_BUTTON_LENGTH);
    const same = (encoded: readonly number[]) => encoded.every((byte, index) => byte === (bytes[index] ?? 0));
    const named = options.find((option) => same(encode(option)));
    if (named) return named;
    if (bytes[0] === REDRAGON_KEY_ACTION && (bytes[3] ?? 0) === 0) {
      const combination = keyName(bytes[1] ?? 0, bytes[2] ?? 0);
      if (combination) return `Keys ${combination}`;
    }
    if (bytes[0] === REDRAGON_SINGLE_KEY_ACTION && (bytes[1] ?? 0) === 0 && (bytes[3] ?? 0) === 0) {
      const key = KEY_USAGES.find(([, code]) => code === bytes[2]);
      if (key) return `Key ${key[0]}`;
    }
    return `Vendor action (${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")})`;
  };
  return { options, encode, decode };
}

/** What differs between the Holtek models; the memory layout above is shared. */
export interface RedragonModel {
  /** Catalog model, e.g. "M724". */
  model: string;
  productId: number;
  dpi: {
    /** RDCfg slider labels, ascending. */
    labels: readonly number[];
    /** Step the DPI editor offers. */
    step: number;
    /** Snaps to the nearest label and returns it with its wire code. */
    encode(dpi: number): RedragonDpiCode & { dpi: number };
    decode(value: number, range: number): number;
  };
  /** Button names and slot offsets from the profile's button base, in slot order. */
  buttons: { names: readonly string[]; offsets: readonly number[] } & RedragonButtonCodec;
  /**
   * `effect`: one global effect selector plus a parameter block per effect
   * (M612, RDCfg's `PRODUCT/Light=4` path). `profile`: one block per
   * profile at `0x448 + 8p` (M724, `PRODUCT/Light=0`).
   */
  lighting: "effect" | "profile";
  /** Lift-off `[level, 00]` (0 low, 1 medium, 2 high), where the mouse honours it. */
  liftOffAddress?: number;
}
