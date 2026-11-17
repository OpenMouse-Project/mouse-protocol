/** USB keyboard usages offered by Launcher's receiver keyboard editor. */
export const KEYCHRON_RECEIVER_KEYS: ReadonlyArray<readonly [string, number]> = [
  ...Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), 4 + i] as const),
  ...Array.from({ length: 9 }, (_, i) => [String(i + 1), 30 + i] as const),
  ["0", 39], ["Enter", 40], ["Escape", 41], ["Backspace", 42], ["Tab", 43], ["Space", 44],
  ["Minus", 45], ["Equal", 46], ["BracketLeft", 47], ["BracketRight", 48], ["Backslash", 49],
  ["Semicolon", 51], ["Quote", 52], ["Backquote", 53], ["Comma", 54], ["Period", 55], ["Slash", 56],
  ["CapsLock", 57], ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 58 + i] as const),
  ["PrintScreen", 70], ["ScrollLock", 71], ["Pause", 72], ["Insert", 73], ["Home", 74],
  ["PageUp", 75], ["Delete", 76], ["End", 77], ["PageDown", 78],
  ["ArrowRight", 79], ["ArrowLeft", 80], ["ArrowDown", 81], ["ArrowUp", 82],
  ["NumLock", 83], ["NumpadDivide", 84], ["NumpadMultiply", 85], ["NumpadSubtract", 86],
  ["NumpadAdd", 87], ["NumpadEnter", 88],
  ...Array.from({ length: 9 }, (_, i) => [`Numpad${i + 1}`, 89 + i] as const),
  ["Numpad0", 98], ["NumpadDecimal", 99],
  ...Array.from({ length: 7 }, (_, i) => [`F${i + 13}`, 104 + i] as const),
  ["ControlLeft", 224], ["ShiftLeft", 225], ["AltLeft", 226], ["MetaLeft", 227],
  ["ControlRight", 228], ["ShiftRight", 229], ["AltRight", 230], ["MetaRight", 231],
];
export const KEYCHRON_RECEIVER_MODIFIERS = ["Ctrl", "Shift", "Alt", "Win", "RightCtrl", "RightShift", "RightAlt", "RightWin"] as const;

/** Receiver EFunKey.Keyboard (2): modifier bitmask followed by USB usages. */
export function encodeReceiverKeys(action: string): number[] | null {
  if (!action.startsWith("Keyboard: ")) return null;
  const parts = action.slice(10).split("+");
  let modifiers = 0;
  const keys: number[] = [];
  for (const part of parts) {
    const bit = KEYCHRON_RECEIVER_MODIFIERS.indexOf(part as typeof KEYCHRON_RECEIVER_MODIFIERS[number]);
    if (bit >= 0) { if (modifiers & (1 << bit)) return null; modifiers |= 1 << bit; }
    else {
      const key = KEYCHRON_RECEIVER_KEYS.find(([name]) => name === part);
      if (!key || keys.includes(key[1])) return null;
      keys.push(key[1]);
    }
  }
  return keys.length > 0 && keys.length <= 6 ? [2, modifiers, ...keys] : null;
}

export function decodeReceiverKeys(bytes: Uint8Array): string | null {
  if (bytes[3] !== 2 || bytes.length < 6) return null;
  const parts: string[] = KEYCHRON_RECEIVER_MODIFIERS.filter((_, bit) => (bytes[4]! & (1 << bit)) !== 0);
  let count = 0;
  for (const usage of bytes.slice(5)) {
    if (usage === 0) break;
    const key = KEYCHRON_RECEIVER_KEYS.find(([, code]) => code === usage);
    if (!key || ++count > 6) return null;
    parts.push(key[0]);
  }
  return count ? `Keyboard: ${parts.join("+")}` : null;
}
