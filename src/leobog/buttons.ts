/**
 * LEOBOG GM3 button assignment table.
 *
 * The vendor application writes the whole table with command pair `01 00`
 * (80 payload bytes, four per slot) every time the user changes one binding;
 * a Frida capture of `OemDrv.exe` on 2026-10-26 shows the full table re-sent
 * per edit. Unlike the `44 00` configuration block there is **no read
 * command**: a read-only sweep of commands `00`-`0E` returns either the
 * previous reply buffer or a HID timeout, writing the table changes nothing
 * inside the readable 400-byte block, and the vendor app itself only ever
 * issues `HidD_GetFeature` for `44 00` — its UI is filled from the local cache
 * at `%LOCALAPPDATA%\BYCOMBO4\LEOBOG Gm3\profile.dct`. Callers therefore have
 * to keep their own model of the current table.
 *
 * A binding is four bytes. Category `01` is a mouse action and carries
 * `<button> <mode> <parameter>`: mode `00` is the rapid-fire action whose
 * parameter is the fire count/interval, and modes `02`/`03` are multi-click.
 * Category `02` is a HID Consumer usage in bytes 2-3, big endian; category
 * `05` is one of the vendor's mouse functions and `00 00 00 00` is disabled.
 *
 * Everything marked "verified" below was captured by selecting that exact
 * label in the vendor UI while watching the `01 00` frames. See
 * `docs/leobog-gm3-buttons.md` for the full evidence trail.
 */

/** Payload bytes the `01`/`00` command carries. */
export const LEOBOG_GM3_BUTTON_TABLE_LENGTH = 80;
export const LEOBOG_GM3_BUTTON_COMMAND = 0x01;
export const LEOBOG_GM3_BUTTON_SUBCOMMAND = 0x00;
/** Four bytes per slot. */
export const LEOBOG_GM3_BUTTON_BYTES = 4;

/**
 * Wire slot order. The vendor numbers middle as 2 and right as 3, the
 * opposite of the usual convention, and this order is what the device stores.
 */
export const LEOBOG_GM3_BUTTON_NAMES = [
  "Left",
  "Middle",
  "Right",
  "Forward",
  "Backward",
  "DPI",
] as const;

export type LeobogGm3ButtonName = (typeof LEOBOG_GM3_BUTTON_NAMES)[number];
export type LeobogGm3ButtonCode = readonly [number, number, number, number];

/** Category byte values used by the table. */
export const LEOBOG_GM3_BUTTON_CATEGORY = {
  disabled: 0x00,
  mouse: 0x01,
  consumer: 0x02,
  mouseFunction: 0x05,
} as const;

/**
 * Category `02` wraps a standard HID Consumer usage. The device stores it big
 * endian in bytes 2-3, so `0x018A` (Email) becomes `02 00 01 8A`.
 */
export function leobogGm3ConsumerCode(usage: number): LeobogGm3ButtonCode {
  if (!Number.isInteger(usage) || usage < 0 || usage > 0xffff) {
    throw new RangeError(`A consumer usage must be 0-65535 (got ${usage}).`);
  }
  return [
    LEOBOG_GM3_BUTTON_CATEGORY.consumer,
    0x00,
    (usage >> 8) & 0xff,
    usage & 0xff,
  ];
}

export const LEOBOG_GM3_DISABLED: LeobogGm3ButtonCode = [0x00, 0x00, 0x00, 0x00];

/** One selectable action: the label the shared card shows plus its bytes. */
export interface LeobogGm3ButtonAction {
  label: string;
  code: LeobogGm3ButtonCode;
}

function mouseFunction(label: string, index: number, parameter = 0x00): LeobogGm3ButtonAction {
  return {
    label,
    code: [LEOBOG_GM3_BUTTON_CATEGORY.mouseFunction, index, 0x00, parameter],
  };
}

function consumer(label: string, usage: number): LeobogGm3ButtonAction {
  return { label, code: leobogGm3ConsumerCode(usage) };
}

/**
 * The actions this model exposes. The vendor binary contains a wider catalog
 * (report rate switch, lighting switch, mode switch, a "common commands"
 * group) but the GM3 application does not offer those for this firmware.
 */
export const LEOBOG_GM3_BUTTON_ACTIONS: readonly LeobogGm3ButtonAction[] = [
  { label: "Disabled", code: LEOBOG_GM3_DISABLED },

  // Mouse buttons, written out as captured. Byte 1 is the vendor's button
  // number, byte 2 the mode (0 plain/fire, 1 single, 2 double, 3 triple) and
  // byte 3 the parameter — the multi-click and fire entries keep the vendor's
  // own 0x32 default for the repeat count/interval.
  { label: "Left click", code: [0x01, 0x01, 0x01, 0x00] },
  { label: "Middle click", code: [0x01, 0x02, 0x01, 0x00] },
  { label: "Right click", code: [0x01, 0x03, 0x01, 0x00] },
  { label: "Forward", code: [0x01, 0x04, 0x01, 0x00] },
  { label: "Backward", code: [0x01, 0x05, 0x01, 0x00] },
  { label: "Scroll up", code: [0x01, 0x08, 0x00, 0x00] },
  { label: "Scroll down", code: [0x01, 0x09, 0x00, 0x00] },
  { label: "Double click", code: [0x01, 0x01, 0x02, 0x32] },
  { label: "Triple click", code: [0x01, 0x01, 0x03, 0x32] },
  { label: "Fire button", code: [0x01, 0x01, 0x00, 0x32] },
  // Tilt comes from the vendor jump table rather than a live capture; the
  // 0xff byte marks the direction.
  { label: "Tilt left", code: [0x01, 0x07, 0xff, 0x32] },
  { label: "Tilt right", code: [0x01, 0x06, 0xff, 0x32] },

  // Mouse functions.
  mouseFunction("DPI loop", 0x04),
  mouseFunction("DPI lock", 0x05, 0x09),

  // Multimedia, standard HID Consumer usages.
  consumer("Play/Pause", 0x00cd),
  consumer("Stop", 0x00b7),
  consumer("Previous track", 0x00b6),
  consumer("Next track", 0x00b5),
  consumer("Volume +", 0x00e9),
  consumer("Volume −", 0x00ea),
  consumer("Mute", 0x00e2),
  consumer("Brightness +", 0x006f),
  consumer("Brightness −", 0x0070),
  consumer("Mail", 0x018a),
  consumer("Browser", 0x0223),
  consumer("My Computer", 0x0194),
  consumer("Calculator", 0x0192),
  consumer("Favorites", 0x022a),
  consumer("Media player", 0x0183),
];

/** Factory bindings, from the vendor `MS.ini` plus the live default read. */
export const LEOBOG_GM3_DEFAULT_BUTTONS: Readonly<Record<LeobogGm3ButtonName, string>> = {
  Left: "Left click",
  Middle: "Middle click",
  Right: "Right click",
  Forward: "Forward",
  Backward: "Backward",
  // The factory binding of the DPI button, confirmed as `05 04 00 00`.
  DPI: "DPI loop",
};

/** Catalog lookup by display label. */
export function leobogGm3FindButtonAction(label: string): LeobogGm3ButtonCode | null {
  const action = LEOBOG_GM3_BUTTON_ACTIONS.find((entry) => entry.label === label);
  return action ? [...action.code] as LeobogGm3ButtonCode : null;
}

/** Display label for a binding, or null when the catalog cannot name it. */
export function leobogGm3ButtonLabel(code: LeobogGm3ButtonCode | null): string | null {
  if (code === null) return null;
  const match = LEOBOG_GM3_BUTTON_ACTIONS.find((action) =>
    action.code.length === code.length
    && action.code.every((byte, index) => byte === code[index]));
  return match?.label ?? null;
}

/** Packs slot codes into the 80-byte `01 00` payload, zero-filling the rest. */
export function leobogGm3EncodeButtonTable(
  codes: readonly LeobogGm3ButtonCode[],
): Uint8Array {
  if (codes.length > LEOBOG_GM3_BUTTON_TABLE_LENGTH / LEOBOG_GM3_BUTTON_BYTES) {
    throw new RangeError(
      `The GM3 stores at most ${LEOBOG_GM3_BUTTON_TABLE_LENGTH / LEOBOG_GM3_BUTTON_BYTES} button slots.`,
    );
  }
  const table = new Uint8Array(LEOBOG_GM3_BUTTON_TABLE_LENGTH);
  codes.forEach((code, slot) => {
    table.set(code, slot * LEOBOG_GM3_BUTTON_BYTES);
  });
  return table;
}

/** Reads back the first `LEOBOG_GM3_BUTTON_NAMES.length` slots of a payload. */
export function leobogGm3DecodeButtonTable(
  payload: Uint8Array,
): LeobogGm3ButtonCode[] | null {
  if (payload.length < LEOBOG_GM3_BUTTON_TABLE_LENGTH) return null;
  return LEOBOG_GM3_BUTTON_NAMES.map((_, slot) => {
    const at = slot * LEOBOG_GM3_BUTTON_BYTES;
    return [
      payload[at]!,
      payload[at + 1]!,
      payload[at + 2]!,
      payload[at + 3]!,
    ] as LeobogGm3ButtonCode;
  });
}
