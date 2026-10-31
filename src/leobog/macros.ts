/**
 * LEOBOG GM3 onboard macros.
 *
 * Macros use command pair `03 00`, a different subsystem from the `01 00`
 * button table. Reverse engineered on 2026-10-27 from the vendor application
 * (`OemDrv.exe`) under Frida while a macro was recorded and saved:
 *
 * ```text
 * 04 00 | u16 size | u8 nameBytes | UTF-16LE name | 4-byte step records…
 * ```
 *
 * `size` counts every byte after the two-byte field itself, so a macro with a
 * six-byte name and four steps reports `0x17`. One step is
 *
 * ```text
 * u8 flags | u16 time_ms (big endian) | u8 hid_usage
 * ```
 *
 * where bit 7 of `flags` marks a release and bit 5 marks a mouse button (the
 * code byte is then a HID button number instead of a keyboard usage).
 * `time_ms` is the wait *after* that step, so on a press it is the hold time:
 * the device keeps the key down for it and the host's key-repeat fires for the
 * whole hold. Recording `C`, a pause, then `D` produced
 * `00 00EA 06 | 80 01D5 06 | 00 007D 07 | 80 0000 07`.
 *
 * The vendor keeps its own copy in `%LOCALAPPDATA%\BYCOMBO4\mac.dct` (written
 * on exit) as 12-byte steps holding the Windows virtual-key code rather than
 * the HID usage; the conversion happens when the record is uploaded.
 *
 * Binding a macro to a button reuses the `01 00` table with category `03`:
 * `03 <mode> <count> <slot>`. Key and mouse-button steps are both modelled;
 * the vendor editor's mouse movement and wheel steps have not been captured
 * through the device path yet.
 */

export const LEOBOG_GM3_MACRO_COMMAND = 0x03;
export const LEOBOG_GM3_MACRO_SUBCOMMAND = 0x00;

/** Leading word of a macro record; constant across every capture so far. */
export const LEOBOG_GM3_MACRO_RECORD_TAG = 0x0004;
export const LEOBOG_GM3_MACRO_STEP_BYTES = 4;

/**
 * `Dev\ms\3311-2\MS.ini` declares `MDNUM=3`, which is the only slot count the
 * vendor files give. The application's panel holds more macros than that, but
 * only the ones with steps are uploaded.
 */
export const LEOBOG_GM3_MACRO_SLOTS = 3;
export const LEOBOG_GM3_MACRO_MAX_NAME_BYTES = 32;
export const LEOBOG_GM3_MACRO_MAX_STEPS = 60;

/** Bit 7 of a step's flag byte marks a key release. */
export const LEOBOG_GM3_MACRO_RELEASE_FLAG = 0x80;

export type LeobogGm3MacroEventType = "keyDown" | "keyUp" | "mouseDown" | "mouseUp";

/**
 * Bit 5 of a step's flag byte marks a mouse-button event; the code byte is
 * then a HID button number instead of a keyboard usage.
 *
 * Measured 2026-10-27 by recording `left click`, then `C`: the record came
 * back as `20 00 8C 01 | A0 02 B0 01 | 00 00 7D 06 | 80 00 00 06`, so the
 * left button is `1` with `0x20` set, and the release carries `0x80 | 0x20`.
 * Only the left button has been measured; the rest follow the HID button
 * order below.
 */
export const LEOBOG_GM3_MACRO_MOUSE_FLAG = 0x20;

export const LEOBOG_GM3_MOUSE_BUTTON = {
  left: 1,
  right: 2,
  middle: 3,
  back: 4,
  forward: 5,
} as const;

export type LeobogGm3MouseButton = keyof typeof LEOBOG_GM3_MOUSE_BUTTON;

export interface LeobogGm3MacroStep {
  /**
   * Milliseconds the device waits after this step before running the next one.
   * On a press it is therefore the hold time; 0 means carry straight on.
   */
  delayMs: number;
  event: { type: LeobogGm3MacroEventType; hidUsage: number };
}

export interface LeobogGm3Macro {
  name: string;
  steps: LeobogGm3MacroStep[];
}

/** Execution modes the vendor dialog offers, and their wire values. */
export const LEOBOG_GM3_MACRO_MODE = {
  /** 执行次数 — repeats the macro `count` times. */
  repeat: 0x01,
  /** 循环直到任意按键按下 — loops until any key is pressed. */
  untilAnyKey: 0x02,
  /** 循环直到按键松开 — loops until the button is released. */
  untilRelease: 0x04,
} as const;

export type LeobogGm3MacroMode = typeof LEOBOG_GM3_MACRO_MODE[keyof typeof LEOBOG_GM3_MACRO_MODE];

function assertMacroName(name: string): number {
  const bytes = new TextEncoder().encode(name).length * 2;
  if (!Number.isInteger(bytes) || bytes < 2 || bytes > LEOBOG_GM3_MACRO_MAX_NAME_BYTES) {
    throw new RangeError(
      `A macro name must be 1-${LEOBOG_GM3_MACRO_MAX_NAME_BYTES / 2} characters (got "${name}").`,
    );
  }
  return bytes;
}

function assertStep(step: LeobogGm3MacroStep): void {
  if (!Number.isInteger(step.delayMs) || step.delayMs < 0 || step.delayMs > 0xffff) {
    throw new RangeError(`A macro delay must be 0-65535 ms (got ${step.delayMs}).`);
  }
  if (!["keyDown", "keyUp", "mouseDown", "mouseUp"].includes(step.event.type)) {
    throw new RangeError(`Unsupported macro event "${step.event.type}".`);
  }
  if (!Number.isInteger(step.event.hidUsage) || step.event.hidUsage < 0 || step.event.hidUsage > 0xff) {
    throw new RangeError(`A HID usage must be 0-255 (got ${step.event.hidUsage}).`);
  }
}

/**
 * Builds the `03 00` payload for one macro. The name is UTF-16LE, matching the
 * vendor capture byte for byte.
 */
export function leobogGm3EncodeMacroRecord(
  name: string,
  steps: readonly LeobogGm3MacroStep[],
): Uint8Array {
  const nameBytes = assertMacroName(name);
  if (steps.length > LEOBOG_GM3_MACRO_MAX_STEPS) {
    throw new RangeError(
      `A GM3 macro holds at most ${LEOBOG_GM3_MACRO_MAX_STEPS} steps (got ${steps.length}).`,
    );
  }
  steps.forEach(assertStep);

  const stepBytes = steps.length * LEOBOG_GM3_MACRO_STEP_BYTES;
  const size = 1 + nameBytes + stepBytes;
  const payload = new Uint8Array(4 + size);
  payload[0] = LEOBOG_GM3_MACRO_RECORD_TAG & 0xff;
  payload[1] = (LEOBOG_GM3_MACRO_RECORD_TAG >> 8) & 0xff;
  payload[2] = size & 0xff;
  payload[3] = (size >> 8) & 0xff;
  payload[4] = nameBytes;
  let cursor = 5;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    payload[cursor] = code & 0xff;
    payload[cursor + 1] = (code >> 8) & 0xff;
    cursor += 2;
  }
  steps.forEach((step, index) => {
    const at = 5 + nameBytes + index * LEOBOG_GM3_MACRO_STEP_BYTES;
    const release = step.event.type === "keyUp" || step.event.type === "mouseUp";
    const mouse = step.event.type === "mouseDown" || step.event.type === "mouseUp";
    payload[at] = (release ? LEOBOG_GM3_MACRO_RELEASE_FLAG : 0x00)
      | (mouse ? LEOBOG_GM3_MACRO_MOUSE_FLAG : 0x00);
    // The vendor writes the delay big endian, unlike every other field.
    payload[at + 1] = (step.delayMs >> 8) & 0xff;
    payload[at + 2] = step.delayMs & 0xff;
    payload[at + 3] = step.event.hidUsage & 0xff;
  });
  return payload;
}

/** Which event a step's flag byte describes. */
export function leobogGm3MacroEventType(flags: number): LeobogGm3MacroEventType {
  const mouse = (flags & LEOBOG_GM3_MACRO_MOUSE_FLAG) !== 0;
  const release = (flags & LEOBOG_GM3_MACRO_RELEASE_FLAG) !== 0;
  if (mouse) return release ? "mouseUp" : "mouseDown";
  return release ? "keyUp" : "keyDown";
}

/** Reads a `03 00` payload back; returns null when the shape does not match. */
export function leobogGm3DecodeMacroRecord(
  payload: Uint8Array,
): LeobogGm3Macro | null {
  if (payload.length < 6) return null;
  if ((payload[0]! | (payload[1]! << 8)) !== LEOBOG_GM3_MACRO_RECORD_TAG) return null;
  const size = payload[2]! | (payload[3]! << 8);
  if (payload.length < 4 + size) return null;
  const nameBytes = payload[4]!;
  if (nameBytes < 2 || nameBytes % 2 !== 0 || 5 + nameBytes > payload.length) return null;
  let name = "";
  for (let at = 5; at < 5 + nameBytes; at += 2) {
    name += String.fromCharCode(payload[at]! | (payload[at + 1]! << 8));
  }
  const stepBytes = size - 1 - nameBytes;
  if (stepBytes % LEOBOG_GM3_MACRO_STEP_BYTES !== 0) return null;
  const steps: LeobogGm3MacroStep[] = [];
  for (let at = 5 + nameBytes; at < 4 + size; at += LEOBOG_GM3_MACRO_STEP_BYTES) {
    steps.push({
      delayMs: (payload[at + 1]! << 8) | payload[at + 2]!,
      event: {
        type: leobogGm3MacroEventType(payload[at]!),
        hidUsage: payload[at + 3]!,
      },
    });
  }
  return { name, steps };
}

/**
 * The four-byte table entry that runs a macro: `03 <mode> <count> <slot>`.
 * Measured with 执行次数 1 → `03 01 01 00`, 执行次数 7 → `03 01 07 00`,
 * 循环直到任意按键按下 → `03 02 01 00`, 循环直到按键松开 → `03 04 01 00`.
 */
export function leobogGm3MacroBindingCode(
  slot: number,
  mode: LeobogGm3MacroMode = LEOBOG_GM3_MACRO_MODE.repeat,
  count = 1,
): readonly [number, number, number, number] {
  if (!Number.isInteger(slot) || slot < 0 || slot >= LEOBOG_GM3_MACRO_SLOTS) {
    throw new RangeError(`A GM3 macro slot must be 0-${LEOBOG_GM3_MACRO_SLOTS - 1} (got ${slot}).`);
  }
  // The two loop modes always carry 1 here; the device ignores the count.
  const repeats = mode === LEOBOG_GM3_MACRO_MODE.repeat ? count : 1;
  if (!Number.isInteger(repeats) || repeats < 0 || repeats > 0xff) {
    throw new RangeError(`A repeat count must be 0-255 (got ${count}).`);
  }
  return [0x03, mode, repeats, slot];
}

/** True when a table entry is a macro binding. */
export function leobogGm3IsMacroBinding(code: readonly number[]): boolean {
  return code.length === 4 && code[0] === 0x03;
}
