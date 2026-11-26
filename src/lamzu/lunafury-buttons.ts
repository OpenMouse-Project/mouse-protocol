/** Runtime button assignments from the public LunaFury configurator.
 * Function/data values are independent of the CompX transport envelope.
 * Macros and unknown functions are deliberately read-only in this codec.
 */
export const LUNAFURY_BUTTON_IDS = { Left: 1, Right: 2, Middle: 3, Back: 4, Forward: 5 } as const;
export type LunaFuryMappedButton = keyof typeof LUNAFURY_BUTTON_IDS;
export interface LunaFuryBinding { functionId: number; data: readonly number[] }

const ACTIONS: Record<string, LunaFuryBinding> = {
  Disabled: { functionId: 0, data: [] },
  "Left Click": { functionId: 1, data: [1] },
  "Right Click": { functionId: 1, data: [2] },
  "Middle Click": { functionId: 1, data: [3] },
  Back: { functionId: 1, data: [4] },
  Forward: { functionId: 1, data: [5] },
  "Scroll Up": { functionId: 1, data: [0x10] },
  "Scroll Down": { functionId: 1, data: [0x11] },
  "DPI Cycle": { functionId: 7, data: [6] },
  "DPI Up": { functionId: 7, data: [1] },
  "DPI Down": { functionId: 7, data: [2] },
};
for (const [name, usage] of [
  ["Media Player", 0x183], ["Play/Pause", 0xcd], ["Next Track", 0xb5], ["Previous Track", 0xb6],
  ["Volume Up", 0xe9], ["Volume Down", 0xea], ["Mute", 0xe2], ["Stop", 0xb7],
  ["Calculator", 0x192], ["My Computer", 0x194], ["Browser Home", 0x223], ["Email", 0x18a],
  ["Brightness Up", 0x6f], ["Brightness Down", 0x70],
] as const) ACTIONS[name] = { functionId: 5, data: [usage >> 8, usage & 255] };
export const LUNAFURY_BUTTON_ACTIONS: readonly string[] = Object.freeze(Object.keys(ACTIONS));

export function lunafuryIsMappedButton(button: string): button is LunaFuryMappedButton {
  return Object.hasOwn(LUNAFURY_BUTTON_IDS, button);
}

function byte(value: number): boolean { return Number.isInteger(value) && value >= 0 && value <= 255; }
function keyUsage(usage: number): boolean {
  return Number.isInteger(usage) && ((usage >= 4 && usage <= 99 && usage !== 50)
    || [224, 225, 226, 228, 229, 230].includes(usage));
}

/** Canonical, layout-independent HID key with all eight L/R modifier bits. */
export function lunafuryKeyboardAction(modifiers: number, usage: number): string {
  if (!byte(modifiers) || !keyUsage(usage)) throw new Error("Unsupported LunaFury keyboard binding.");
  return `Keyboard:${modifiers}:${usage}`;
}

export function lunafuryParseKeyboardAction(action: string): { modifiers: number; usage: number } | undefined {
  const match = /^Keyboard:(0|[1-9]\d{0,2}):(0|[1-9]\d{0,2})$/.exec(action);
  if (!match) return undefined;
  const modifiers = Number(match[1]), usage = Number(match[2]);
  return byte(modifiers) && keyUsage(usage) ? { modifiers, usage } : undefined;
}

export function lunafuryEncodeButtonAction(action: string): LunaFuryBinding {
  if (Object.hasOwn(ACTIONS, action)) return { functionId: ACTIONS[action].functionId, data: [...ACTIONS[action].data] };
  const keyboard = lunafuryParseKeyboardAction(action);
  if (keyboard) return { functionId: 4, data: [keyboard.modifiers, keyboard.usage] };
  throw new Error("Unsupported LunaFury button action.");
}

export function lunafuryButtonActionWritable(action: string): boolean {
  return Object.hasOwn(ACTIONS, action) || lunafuryParseKeyboardAction(action) !== undefined;
}

export function lunafuryDecodeButtonAction(binding: LunaFuryBinding): string {
  const { functionId, data } = binding;
  const action = Object.entries(ACTIONS).find(([, known]) => known.functionId === functionId
    && known.data.length === data.length && known.data.every((value, index) => data[index] === value))?.[0];
  if (action) return action;
  if (functionId === 4 && data.length === 2 && byte(data[0]) && keyUsage(data[1])) {
    return lunafuryKeyboardAction(data[0], data[1]);
  }
  // Include the raw bytes so different unsupported assignments never compare equal.
  const kind = [0x10, 0x11, 0x12].includes(functionId) ? "Macro" : "Unknown";
  return `${kind}:${functionId}:${data.join(",")}`;
}

function scope(profile: number, button: string): number {
  if (!Number.isInteger(profile) || profile < 1 || profile > 3) throw new Error("Invalid LunaFury profile.");
  if (!lunafuryIsMappedButton(button)) throw new Error("Unknown LunaFury physical button.");
  return LUNAFURY_BUTTON_IDS[button];
}

export function lunafuryReadButton(profile: number, button: string) {
  const id = scope(profile, button);
  return { target: 2, page: 3, command: 0x80, length: 15, args: [profile, id, 0, 0xff, 10] };
}

export function lunafuryWriteButton(profile: number, button: string, action: string) {
  const id = scope(profile, button), { functionId, data } = lunafuryEncodeButtonAction(action);
  return { target: 2, page: 3, command: 0, length: 5 + data.length,
    args: [profile, id, 0, functionId, data.length, ...data] };
}

/** Decode only complete, correctly addressed payloads. Padding is not action data. */
export function lunafuryDecodeButton(payload: Uint8Array, profile: number, button: string): LunaFuryBinding {
  const id = scope(profile, button);
  if (payload.length < 5 || payload[0] !== profile || payload[1] !== id || payload[2] !== 0
    || payload[4] > 10 || payload.length < 5 + payload[4]) throw new Error("Invalid LunaFury button reply.");
  return { functionId: payload[3], data: Array.from(payload.slice(5, 5 + payload[4])) };
}
