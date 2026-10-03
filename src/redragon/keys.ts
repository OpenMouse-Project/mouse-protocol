/**
 * Keyboard keys for the Redragon drivers' button bindings: the HID keyboard
 * modifier bits and usage IDs (USB HID Usage Tables, keyboard page 0x07).
 * Each driver wraps them in its own slot encoding (M612 `8F mods usage`,
 * M690 PRO `21 mods usage 00`). Not exported from the package.
 */

export const MODIFIER_NAMES: ReadonlyArray<readonly [number, string]> = [[0x01, "Ctrl"], [0x02, "Shift"], [0x04, "Alt"], [0x08, "Win"]];

export const KEY_USAGES: ReadonlyArray<readonly [string, number]> = [
  ...Array.from({ length: 26 }, (_, index) => [String.fromCharCode(65 + index), 0x04 + index] as const),
  ...Array.from({ length: 9 }, (_, index) => [String(index + 1), 0x1e + index] as const),
  ["0", 0x27],
  ["Enter", 0x28], ["Escape", 0x29], ["Backspace", 0x2a], ["Tab", 0x2b], ["Space", 0x2c],
  ["-", 0x2d], ["=", 0x2e], ["[", 0x2f], ["]", 0x30], ["\\", 0x31], [";", 0x33], ["'", 0x34], ["`", 0x35],
  [",", 0x36], [".", 0x37], ["/", 0x38], ["Caps Lock", 0x39],
  ...Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, 0x3a + index] as const),
  ["Print Screen", 0x46], ["Scroll Lock", 0x47], ["Pause", 0x48], ["Insert", 0x49], ["Home", 0x4a],
  ["Page Up", 0x4b], ["Delete", 0x4c], ["End", 0x4d], ["Page Down", 0x4e],
  ["Right arrow", 0x4f], ["Left arrow", 0x50], ["Down arrow", 0x51], ["Up arrow", 0x52],
];

/** Numeric keypad keys, offered by the M690 PRO's vendor app (Numpad 5 = 0x5d captured). */
export const NUMPAD_USAGES: ReadonlyArray<readonly [string, number]> = [
  ["Num Lock", 0x53], ["Numpad /", 0x54], ["Numpad *", 0x55], ["Numpad -", 0x56], ["Numpad +", 0x57],
  ["Numpad Enter", 0x58],
  ...Array.from({ length: 9 }, (_, index) => [`Numpad ${index + 1}`, 0x59 + index] as const),
  ["Numpad 0", 0x62], ["Numpad .", 0x63],
];

/** Named shortcuts: RDCfg's menu entries plus Undo/Redo. */
export const SHORTCUTS: ReadonlyArray<readonly [string, number, string]> = [
  ["Copy", 0x01, "C"], ["Cut", 0x01, "X"], ["Paste", 0x01, "V"], ["Select all", 0x01, "A"],
  ["Undo", 0x01, "Z"], ["Redo", 0x01, "Y"], ["Find", 0x01, "F"], ["New", 0x01, "N"],
  ["Print", 0x01, "P"], ["Save", 0x01, "S"],
  ["Switch window", 0x04, "Tab"], ["Close window", 0x04, "F4"],
  ["File explorer", 0x08, "E"], ["Run", 0x08, "R"], ["Show desktop", 0x08, "D"], ["Lock PC", 0x08, "L"],
];

/** "Ctrl+Shift+R" for modifiers 0x03 and usage 0x15, or null for anything outside `keys`. */
export function keyName(modifiers: number, usage: number, keys: ReadonlyArray<readonly [string, number]> = KEY_USAGES): string | null {
  const key = keys.find(([, value]) => value === usage)?.[0];
  if (key === undefined || (modifiers & ~0x0f) !== 0) return null;
  return [...MODIFIER_NAMES.filter(([bit]) => modifiers & bit).map(([, name]) => name), key].join("+");
}
