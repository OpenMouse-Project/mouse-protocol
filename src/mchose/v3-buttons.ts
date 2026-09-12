/**
 * What an A7 V3 button can be set to, read out of M HUB's own tables.
 *
 * The vendor stores each action as a hex string whose first byte is the type
 * and whose remaining bytes are the value — `"0x13042b"` is Alt+Tab, type
 * `0x13`, modifier `0x04`, usage `0x2b`. The rows below are those strings split
 * in two, in the same orientation {@link mchoseV3DecodeButtons} produces, so a
 * decoded assignment can be compared against this table directly.
 *
 * **Type and value only mean anything together.** `0x0002` is "right click"
 * under type `0x00`, "DPI −" under type `0x01` and a media key under `0x14`.
 *
 * Note the type numbers are **not** the A7 V2's: this generation uses `0x00`
 * for mouse buttons, `0x11`/`0x13` for the keyboard, `0x14` for media, `0x16`
 * for system shortcuts, `0x33` for profiles and `0xfe` for a disabled button.
 * The V2's 1/2/3/5/8/9/10 mean nothing here.
 */

export interface MchoseV3ButtonAction {
  label: string;
  type: number;
  /** Value bytes after the type, most significant first. */
  value: readonly number[];
  /** Display grouping, matching the A7 V2 driver's. */
  group: string;
}

/**
 * A button the firmware reports as carrying no assignment at all. M HUB never
 * writes this — it writes {@link MCHOSE_V3_BUTTON_ACTIONS}'s "Disabled",
 * which is type `0xfe` — but a stock mouse can report it, so it has to be
 * nameable. A real A7 V3 Ultra+ shipped with its DPI button on `0xff`.
 */
export const MCHOSE_V3_BUTTON_UNSET = 0xff;

/**
 * Factory value for each button: the mask a stock mouse carries under type 0,
 * read straight off a real A7 V3 Ultra+'s button table and matching the
 * vendor's own "mouse.left"/"mouse.right"/… entries below.
 */
const BUTTON_DEFAULT_VALUE: Readonly<Record<string, readonly number[]>> = {
  Left: [0x00, 0x01],
  Right: [0x00, 0x02],
  Middle: [0x00, 0x04],
  Forward: [0x00, 0x10],
  Back: [0x00, 0x08],
  DPI: [0x00, 0x00],
};

/**
 * Every action M HUB offers, plus the letters, function keys and navigation
 * keys the vendor's table leaves to its on-screen keyboard. Those are derived,
 * not invented: the vendor's own shortcuts spell out the same standard HID
 * usages under the same type (Ctrl+A is `0x04`, Ctrl+C `0x06`, Alt+F4 `0x3d`,
 * Esc `0x29`), so the usage page is confirmed rather than assumed.
 */
export const MCHOSE_V3_BUTTON_ACTIONS: readonly MchoseV3ButtonAction[] = [
  { label: "Default", type: 0x00, value: [], group: "Basic" },
  { label: "Disabled", type: 0xfe, value: [0x00, 0x00], group: "Basic" },

  { label: "Left click", type: 0x00, value: [0x00, 0x01], group: "Mouse" },
  { label: "Right click", type: 0x00, value: [0x00, 0x02], group: "Mouse" },
  { label: "Middle click", type: 0x00, value: [0x00, 0x04], group: "Mouse" },
  { label: "Forward", type: 0x00, value: [0x00, 0x10], group: "Mouse" },
  { label: "Back", type: 0x00, value: [0x00, 0x08], group: "Mouse" },
  { label: "Wheel up", type: 0x05, value: [0x00, 0x00], group: "Mouse" },
  { label: "Wheel down", type: 0x05, value: [0x00, 0x01], group: "Mouse" },

  { label: "DPI +", type: 0x01, value: [0x00, 0x00, 0x02], group: "DPI" },
  { label: "DPI -", type: 0x01, value: [0x00, 0x00, 0x03], group: "DPI" },
  { label: "DPI switch", type: 0x01, value: [0x00, 0x00, 0x00], group: "DPI" },

  { label: "Volume +", type: 0x14, value: [0x00, 0xe9], group: "Media" },
  { label: "Volume -", type: 0x14, value: [0x00, 0xea], group: "Media" },
  { label: "Mute", type: 0x14, value: [0x00, 0xe2], group: "Media" },
  { label: "Play / Pause", type: 0x14, value: [0x00, 0xcd], group: "Media" },
  { label: "Previous track", type: 0x14, value: [0x00, 0xb6], group: "Media" },
  { label: "Next track", type: 0x14, value: [0x00, 0xb5], group: "Media" },
  { label: "Stop", type: 0x14, value: [0x00, 0xb7], group: "Media" },

  { label: "Screen brightness +", type: 0x14, value: [0x00, 0x6f], group: "System" },
  { label: "Screen brightness -", type: 0x14, value: [0x00, 0x70], group: "System" },
  { label: "Copy", type: 0x16, value: [0x01, 0x06], group: "System" },
  { label: "Cut", type: 0x16, value: [0x01, 0x1b], group: "System" },
  { label: "Paste", type: 0x16, value: [0x01, 0x19], group: "System" },

  { label: "Switch to profile 1", type: 0x33, value: [0x00, 0x00], group: "Profile" },
  { label: "Switch to profile 2", type: 0x33, value: [0x00, 0x01], group: "Profile" },
  { label: "Switch to profile 3", type: 0x33, value: [0x00, 0x02], group: "Profile" },
  { label: "Cycle profiles", type: 0x33, value: [0x00, 0xff], group: "Profile" },

  { label: "- _", type: 0x11, value: [0x00, 0x2d], group: "Keyboard" },
  { label: ", <", type: 0x11, value: [0x00, 0x36], group: "Keyboard" },
  { label: "; :", type: 0x11, value: [0x00, 0x33], group: "Keyboard" },
  { label: ". >", type: 0x11, value: [0x00, 0x37], group: "Keyboard" },
  { label: "' \"", type: 0x11, value: [0x00, 0x34], group: "Keyboard" },
  { label: "[ {", type: 0x11, value: [0x00, 0x2f], group: "Keyboard" },
  { label: "] }", type: 0x11, value: [0x00, 0x30], group: "Keyboard" },
  { label: "/ ?", type: 0x11, value: [0x00, 0x38], group: "Keyboard" },
  { label: "\\ |", type: 0x11, value: [0x00, 0x31], group: "Keyboard" },
  { label: "` ~", type: 0x11, value: [0x00, 0x35], group: "Keyboard" },
  { label: "= +", type: 0x11, value: [0x00, 0x2e], group: "Keyboard" },
  { label: "0 )", type: 0x11, value: [0x00, 0x27], group: "Keyboard" },
  { label: "1 !", type: 0x11, value: [0x00, 0x1e], group: "Keyboard" },
  { label: "2 @", type: 0x11, value: [0x00, 0x1f], group: "Keyboard" },
  { label: "3 #", type: 0x11, value: [0x00, 0x20], group: "Keyboard" },
  { label: "4 $", type: 0x11, value: [0x00, 0x21], group: "Keyboard" },
  { label: "5 %", type: 0x11, value: [0x00, 0x22], group: "Keyboard" },
  { label: "6 ^", type: 0x11, value: [0x00, 0x23], group: "Keyboard" },
  { label: "7 &", type: 0x11, value: [0x00, 0x24], group: "Keyboard" },
  { label: "8 *", type: 0x11, value: [0x00, 0x25], group: "Keyboard" },
  { label: "9 (", type: 0x11, value: [0x00, 0x26], group: "Keyboard" },
  { label: "Caps Lock", type: 0x11, value: [0x00, 0x39], group: "Keyboard" },
  { label: "Num -", type: 0x11, value: [0x00, 0x56], group: "Keyboard" },
  { label: "Num *", type: 0x11, value: [0x00, 0x55], group: "Keyboard" },
  { label: "Num /", type: 0x11, value: [0x00, 0x54], group: "Keyboard" },
  { label: "Num +", type: 0x11, value: [0x00, 0x57], group: "Keyboard" },
  { label: "Num 0", type: 0x11, value: [0x00, 0x62], group: "Keyboard" },
  { label: "Num 1", type: 0x11, value: [0x00, 0x59], group: "Keyboard" },
  { label: "Num 2", type: 0x11, value: [0x00, 0x5a], group: "Keyboard" },
  { label: "Num 3", type: 0x11, value: [0x00, 0x5b], group: "Keyboard" },
  { label: "Num 4", type: 0x11, value: [0x00, 0x5c], group: "Keyboard" },
  { label: "Num 5", type: 0x11, value: [0x00, 0x5d], group: "Keyboard" },
  { label: "Num 6", type: 0x11, value: [0x00, 0x5e], group: "Keyboard" },
  { label: "Num 7", type: 0x11, value: [0x00, 0x5f], group: "Keyboard" },
  { label: "Num 8", type: 0x11, value: [0x00, 0x60], group: "Keyboard" },
  { label: "Num 9", type: 0x11, value: [0x00, 0x61], group: "Keyboard" },
  { label: "Num Del", type: 0x11, value: [0x00, 0x63], group: "Keyboard" },
  { label: "Num Enter", type: 0x11, value: [0x00, 0x58], group: "Keyboard" },
  { label: "Num Lock", type: 0x11, value: [0x00, 0x53], group: "Keyboard" },
  { label: "Print Screen", type: 0x11, value: [0x00, 0x46], group: "Keyboard" },
  { label: "Page Down", type: 0x11, value: [0x00, 0x4e], group: "Keyboard" },
  { label: "Page Up", type: 0x11, value: [0x00, 0x4b], group: "Keyboard" },
  { label: "Left Windows", type: 0x11, value: [0x00, 0xe3], group: "Keyboard" },
  { label: "Right Windows", type: 0x11, value: [0x00, 0xe7], group: "Keyboard" },
  { label: "Left Alt", type: 0x11, value: [0x00, 0xe2], group: "Keyboard" },
  { label: "Right Alt", type: 0x11, value: [0x00, 0xe6], group: "Keyboard" },
  { label: "Left Ctrl", type: 0x11, value: [0x00, 0xe0], group: "Keyboard" },
  { label: "Right Ctrl", type: 0x11, value: [0x00, 0xe4], group: "Keyboard" },
  { label: "Left Shift", type: 0x11, value: [0x00, 0xe1], group: "Keyboard" },
  { label: "Right Shift", type: 0x11, value: [0x00, 0xe5], group: "Keyboard" },
  { label: "Scroll Lock", type: 0x11, value: [0x00, 0x47], group: "Keyboard" },
  { label: "Ctrl + -", type: 0x13, value: [0x01, 0x2d], group: "Keyboard" },
  { label: "Ctrl + Y", type: 0x13, value: [0x01, 0x1c], group: "Keyboard" },
  { label: "Ctrl + =", type: 0x13, value: [0x01, 0x2e], group: "Keyboard" },
  { label: "Ctrl + 0", type: 0x13, value: [0x01, 0x27], group: "Keyboard" },
  { label: "Ctrl + C", type: 0x13, value: [0x01, 0x06], group: "Keyboard" },
  { label: "Ctrl + A", type: 0x13, value: [0x01, 0x04], group: "Keyboard" },
  { label: "Ctrl + N", type: 0x13, value: [0x01, 0x11], group: "Keyboard" },
  { label: "Ctrl + X", type: 0x13, value: [0x01, 0x1b], group: "Keyboard" },
  { label: "Ctrl + S", type: 0x13, value: [0x01, 0x16], group: "Keyboard" },
  { label: "Ctrl + V", type: 0x13, value: [0x01, 0x19], group: "Keyboard" },
  { label: "Ctrl + Z", type: 0x13, value: [0x01, 0x1d], group: "Keyboard" },
  { label: "Ctrl + O", type: 0x13, value: [0x01, 0x12], group: "Keyboard" },
  { label: "Ctrl + T", type: 0x13, value: [0x01, 0x17], group: "Keyboard" },
  { label: "Ctrl + W", type: 0x13, value: [0x01, 0x1a], group: "Keyboard" },
  { label: "Alt + Left", type: 0x13, value: [0x04, 0x50], group: "Keyboard" },
  { label: "Alt + Right", type: 0x13, value: [0x04, 0x4f], group: "Keyboard" },
  { label: "Win + Tab", type: 0x13, value: [0x08, 0x2b], group: "Keyboard" },
  { label: "Win + D", type: 0x13, value: [0x08, 0x07], group: "Keyboard" },
  { label: "Win + Ctrl + Enter", type: 0x13, value: [0x09, 0x28], group: "Keyboard" },
  { label: "Win + T", type: 0x13, value: [0x08, 0x17], group: "Keyboard" },
  { label: "Win + A", type: 0x13, value: [0x08, 0x04], group: "Keyboard" },
  { label: "Win + E", type: 0x13, value: [0x08, 0x08], group: "Keyboard" },
  { label: "Win + I", type: 0x13, value: [0x08, 0x0c], group: "Keyboard" },
  { label: "Win + L", type: 0x13, value: [0x08, 0x0f], group: "Keyboard" },
  { label: "Win + K", type: 0x13, value: [0x08, 0x0e], group: "Keyboard" },
  { label: "Win + B", type: 0x13, value: [0x08, 0x05], group: "Keyboard" },
  { label: "Win + G", type: 0x13, value: [0x08, 0x0a], group: "Keyboard" },
  { label: "Win + R", type: 0x13, value: [0x08, 0x15], group: "Keyboard" },
  { label: "Win + S", type: 0x13, value: [0x08, 0x16], group: "Keyboard" },
  { label: "Win + U", type: 0x13, value: [0x08, 0x18], group: "Keyboard" },
  { label: "Win + X", type: 0x13, value: [0x08, 0x1b], group: "Keyboard" },
  { label: "Win + .", type: 0x13, value: [0x08, 0x37], group: "Keyboard" },
  { label: "Win + =", type: 0x13, value: [0x08, 0x2e], group: "Keyboard" },
  { label: "Ctrl + Shift + Esc", type: 0x13, value: [0x03, 0x29], group: "Keyboard" },
  { label: "Ctrl + Esc", type: 0x13, value: [0x01, 0x29], group: "Keyboard" },
  { label: "Alt + Tab", type: 0x13, value: [0x04, 0x2b], group: "Keyboard" },
  { label: "Alt + F4", type: 0x13, value: [0x04, 0x3d], group: "Keyboard" },
  { label: "Alt + Esc", type: 0x13, value: [0x04, 0x29], group: "Keyboard" },
  { label: "A", type: 0x11, value: [0x00, 0x04], group: "Keyboard" },
  { label: "B", type: 0x11, value: [0x00, 0x05], group: "Keyboard" },
  { label: "C", type: 0x11, value: [0x00, 0x06], group: "Keyboard" },
  { label: "D", type: 0x11, value: [0x00, 0x07], group: "Keyboard" },
  { label: "E", type: 0x11, value: [0x00, 0x08], group: "Keyboard" },
  { label: "F", type: 0x11, value: [0x00, 0x09], group: "Keyboard" },
  { label: "G", type: 0x11, value: [0x00, 0x0a], group: "Keyboard" },
  { label: "H", type: 0x11, value: [0x00, 0x0b], group: "Keyboard" },
  { label: "I", type: 0x11, value: [0x00, 0x0c], group: "Keyboard" },
  { label: "J", type: 0x11, value: [0x00, 0x0d], group: "Keyboard" },
  { label: "K", type: 0x11, value: [0x00, 0x0e], group: "Keyboard" },
  { label: "L", type: 0x11, value: [0x00, 0x0f], group: "Keyboard" },
  { label: "M", type: 0x11, value: [0x00, 0x10], group: "Keyboard" },
  { label: "N", type: 0x11, value: [0x00, 0x11], group: "Keyboard" },
  { label: "O", type: 0x11, value: [0x00, 0x12], group: "Keyboard" },
  { label: "P", type: 0x11, value: [0x00, 0x13], group: "Keyboard" },
  { label: "Q", type: 0x11, value: [0x00, 0x14], group: "Keyboard" },
  { label: "R", type: 0x11, value: [0x00, 0x15], group: "Keyboard" },
  { label: "S", type: 0x11, value: [0x00, 0x16], group: "Keyboard" },
  { label: "T", type: 0x11, value: [0x00, 0x17], group: "Keyboard" },
  { label: "U", type: 0x11, value: [0x00, 0x18], group: "Keyboard" },
  { label: "V", type: 0x11, value: [0x00, 0x19], group: "Keyboard" },
  { label: "W", type: 0x11, value: [0x00, 0x1a], group: "Keyboard" },
  { label: "X", type: 0x11, value: [0x00, 0x1b], group: "Keyboard" },
  { label: "Y", type: 0x11, value: [0x00, 0x1c], group: "Keyboard" },
  { label: "Z", type: 0x11, value: [0x00, 0x1d], group: "Keyboard" },
  { label: "F1", type: 0x11, value: [0x00, 0x3a], group: "Keyboard" },
  { label: "F2", type: 0x11, value: [0x00, 0x3b], group: "Keyboard" },
  { label: "F3", type: 0x11, value: [0x00, 0x3c], group: "Keyboard" },
  { label: "F4", type: 0x11, value: [0x00, 0x3d], group: "Keyboard" },
  { label: "F5", type: 0x11, value: [0x00, 0x3e], group: "Keyboard" },
  { label: "F6", type: 0x11, value: [0x00, 0x3f], group: "Keyboard" },
  { label: "F7", type: 0x11, value: [0x00, 0x40], group: "Keyboard" },
  { label: "F8", type: 0x11, value: [0x00, 0x41], group: "Keyboard" },
  { label: "F9", type: 0x11, value: [0x00, 0x42], group: "Keyboard" },
  { label: "F10", type: 0x11, value: [0x00, 0x43], group: "Keyboard" },
  { label: "F11", type: 0x11, value: [0x00, 0x44], group: "Keyboard" },
  { label: "F12", type: 0x11, value: [0x00, 0x45], group: "Keyboard" },
  { label: "Enter", type: 0x11, value: [0x00, 0x28], group: "Keyboard" },
  { label: "Esc", type: 0x11, value: [0x00, 0x29], group: "Keyboard" },
  { label: "Backspace", type: 0x11, value: [0x00, 0x2a], group: "Keyboard" },
  { label: "Tab", type: 0x11, value: [0x00, 0x2b], group: "Keyboard" },
  { label: "Space", type: 0x11, value: [0x00, 0x2c], group: "Keyboard" },
  { label: "Insert", type: 0x11, value: [0x00, 0x49], group: "Keyboard" },
  { label: "Home", type: 0x11, value: [0x00, 0x4a], group: "Keyboard" },
  { label: "Delete", type: 0x11, value: [0x00, 0x4c], group: "Keyboard" },
  { label: "End", type: 0x11, value: [0x00, 0x4d], group: "Keyboard" },
  { label: "Right", type: 0x11, value: [0x00, 0x4f], group: "Keyboard" },
  { label: "Left", type: 0x11, value: [0x00, 0x50], group: "Keyboard" },
  { label: "Down", type: 0x11, value: [0x00, 0x51], group: "Keyboard" },
  { label: "Up", type: 0x11, value: [0x00, 0x52], group: "Keyboard" },
  { label: "Menu", type: 0x11, value: [0x00, 0x65], group: "Keyboard" },
];

/**
 * Resolve an action for a specific button.
 *
 * "Default" is the one entry whose value depends on which button it is for:
 * the firmware stores each button's own factory mask rather than a shared
 * "restore" sentinel.
 */
export function mchoseV3ButtonAction(
  button: string,
  label: string,
): { type: number; value: number[] } | null {
  if (label === "Default") {
    const value = BUTTON_DEFAULT_VALUE[button];
    return value ? { type: 0x00, value: [...value] } : null;
  }
  const action = MCHOSE_V3_BUTTON_ACTIONS.find(
    (entry) => entry.label === label && entry.label !== "Default",
  );
  return action ? { type: action.type, value: [...action.value] } : null;
}

/**
 * Name a stored assignment. Type and value are matched together, because the
 * same value means different things under different types. A button sitting on
 * its own factory mask is reported as "Default" rather than as the click it
 * happens to encode, since that is what the user changed it from.
 */
export function mchoseV3ButtonActionName(
  button: string,
  action: { type: number; value: readonly number[] },
): string {
  if (action.type === MCHOSE_V3_BUTTON_UNSET) return "Not set";

  const factory = BUTTON_DEFAULT_VALUE[button];
  if (action.type === 0x00 && factory && sameValue(action.value, factory)) return "Default";

  const match = MCHOSE_V3_BUTTON_ACTIONS.find(
    (entry) => entry.type === action.type
      && entry.label !== "Default"
      && sameValue(entry.value, action.value),
  );
  if (match) return match.label;

  const value = action.value.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `Unknown (0x${action.type.toString(16).padStart(2, "0")}${value})`;
}

function sameValue(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Labels for the picker, in display order. */
export function mchoseV3ButtonActionLabels(): string[] {
  return MCHOSE_V3_BUTTON_ACTIONS.map((action) => action.label);
}
