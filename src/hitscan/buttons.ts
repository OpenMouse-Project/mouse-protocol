/** Three-byte action values, before the per-record checksum. Derived from
 * Hitscan Utility 1.0.2 UI formatter 0x1400324F0 and QAction connections
 * 0x140027AF0 onward. See HID-BUTTONS.md in the retained capture. */
export const HITSCAN_BUTTON_CATEGORY = {
  disabled: 0, mouse: 1, dpi: 2, shortcut: 5, macro: 6, pollingSwitch: 7,
} as const;
export const HITSCAN_MOUSE_BUTTON = { left: 1, right: 2, middle: 4, back: 8, forward: 16 } as const;
export const HITSCAN_DPI_BUTTON = { loop: 1, up: 2, down: 3 } as const;
export type HitscanButtonBytes = readonly [number, number, number];
export type HitscanButtonAction =
  | { kind: "disabled" }
  | { kind: "mouse"; button: keyof typeof HITSCAN_MOUSE_BUTTON }
  | { kind: "dpi"; action: keyof typeof HITSCAN_DPI_BUTTON }
  | { kind: "pollingSwitch" }
  // The utility associates shortcut/macro storage with the physical button.
  // These two parameters are deliberately opaque; neither is a proven slot ID.
  | { kind: "shortcut" | "macro"; parameters: readonly [number, number] }
  | { kind: "unknown"; bytes: HitscanButtonBytes };

function bytes(values: readonly number[]): HitscanButtonBytes {
  if (values.length !== 3 || values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new RangeError("A Hitscan button action requires three bytes.");
  }
  return [values[0]!, values[1]!, values[2]!];
}

/** Encode only named mappings recovered from the app; unknown triples round-trip. */
export function hitscanEncodeButton(action: HitscanButtonAction): HitscanButtonBytes {
  switch (action.kind) {
    case "disabled": return [0, 0, 0];
    case "mouse": return bytes([1, HITSCAN_MOUSE_BUTTON[action.button], 0]);
    case "dpi": return bytes([2, HITSCAN_DPI_BUTTON[action.action], 0]);
    case "pollingSwitch": return [7, 0, 0];
    case "shortcut": return bytes([5, ...action.parameters]);
    case "macro": return bytes([6, ...action.parameters]);
    case "unknown": return bytes(action.bytes);
  }
}

/** Preserve unrecognized parameters, including extra bytes on known categories. */
export function hitscanDecodeButton(values: ArrayLike<number>): HitscanButtonAction {
  const raw = bytes(Array.from(values));
  if (raw[0] === 5 || raw[0] === 6) {
    return { kind: raw[0] === 5 ? "shortcut" : "macro", parameters: [raw[1], raw[2]] };
  }
  if (raw[2] === 0) {
    if (raw[0] === 0 && raw[1] === 0) return { kind: "disabled" };
    if (raw[0] === 7 && raw[1] === 0) return { kind: "pollingSwitch" };
    if (raw[0] === 1) {
      const button = (Object.keys(HITSCAN_MOUSE_BUTTON) as (keyof typeof HITSCAN_MOUSE_BUTTON)[])
        .find(key => HITSCAN_MOUSE_BUTTON[key] === raw[1]);
      if (button) return { kind: "mouse", button };
    }
    if (raw[0] === 2) {
      const action = (Object.keys(HITSCAN_DPI_BUTTON) as (keyof typeof HITSCAN_DPI_BUTTON)[])
        .find(key => HITSCAN_DPI_BUTTON[key] === raw[1]);
      if (action) return { kind: "dpi", action };
    }
  }
  return { kind: "unknown", bytes: raw };
}

/**
 * Physical buttons, in key-record order (`0x60 + 4*i`). `KeyNumber=6` in the
 * shipped Config.ini. The order follows the CompX key table this layout shares
 * with Teevolution; shipped defaults corroborate Left, Right and Back.
 */
export const HITSCAN_BUTTON_NAMES = ["Left", "Right", "Middle", "Back", "Forward", "DPI"] as const;

/** UI labels for the named actions, in display order. Shortcut and macro stay read-only. */
export const HITSCAN_BUTTON_OPTIONS: ReadonlyArray<readonly [string, HitscanButtonAction]> = [
  ["Left Click", { kind: "mouse", button: "left" }],
  ["Right Click", { kind: "mouse", button: "right" }],
  ["Middle Click", { kind: "mouse", button: "middle" }],
  ["Backward", { kind: "mouse", button: "back" }],
  ["Forward", { kind: "mouse", button: "forward" }],
  ["DPI Loop", { kind: "dpi", action: "loop" }],
  ["DPI+", { kind: "dpi", action: "up" }],
  ["DPI-", { kind: "dpi", action: "down" }],
  ["Polling Rate Switch", { kind: "pollingSwitch" }],
  ["Disable", { kind: "disabled" }],
];

export function hitscanButtonActionForLabel(label: string): HitscanButtonAction | null {
  return HITSCAN_BUTTON_OPTIONS.find(([name]) => name === label)?.[1] ?? null;
}

/** Label for a decoded action; shortcut, macro and unknown triples get descriptive names. */
export function hitscanButtonLabel(action: HitscanButtonAction): string {
  if (action.kind === "shortcut") return "Shortcut";
  if (action.kind === "macro") return "Macro";
  if (action.kind === "unknown") return `Unknown (${action.bytes.map(b => b.toString(16).padStart(2, "0")).join(" ")})`;
  const encoded = hitscanEncodeButton(action);
  return HITSCAN_BUTTON_OPTIONS.find(([, option]) =>
    hitscanEncodeButton(option).every((byte, index) => byte === encoded[index]))?.[0] ?? "Unknown";
}
