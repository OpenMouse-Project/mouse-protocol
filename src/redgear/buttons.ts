/** Report-4 button records: vendor API captures plus static formatter 0x40426e. */
export const X13_BUTTON_NAMES = [
  "Left",
  "Right",
  "Middle",
  "DPI",
  "Forward",
  "Back",
] as const;
export const X13_BUTTON_ACTIONS = [
  "Left click",
  "Right click",
  "Middle click",
  "Back",
  "Forward",
  "DPI cycle",
] as const;
const masks: Readonly<Record<string, number>> = {
  "Left click": 1,
  "Right click": 2,
  "Middle click": 4,
  Back: 8,
  Forward: 16,
};

function spans(payload: Uint8Array): Array<{ offset: number; end: number }> {
  if (payload.length !== 2048)
    throw new RangeError(
      "X13 Pro button payload must be 2048 bytes without ID",
    );
  const offsets = Array.from(
    { length: 7 },
    (_, i) => payload[i * 2]! | (payload[i * 2 + 1]! << 8),
  );
  if (
    offsets[0]! < 48 ||
    offsets.some((off, i) => off > 2038 || (i > 0 && off <= offsets[i - 1]!))
  )
    throw new Error("Invalid X13 Pro button pointers");
  return offsets.map((offset, i) => ({ offset, end: offsets[i + 1] ?? 2048 }));
}

function actionAt(
  payload: Uint8Array,
  slot: number,
  offset: number,
  end: number,
): string {
  if (end - offset !== 10 || payload[offset]! % 16 !== slot + 1)
    return "Unknown / macro";
  const record = payload.subarray(offset, offset + 10);
  if (
    record[0] === (0x40 | (slot + 1)) &&
    record.slice(1).every((v) => v === 0)
  )
    return "DPI cycle";
  if (
    record[0] !== (0x20 | (slot + 1)) ||
    record.slice(2, 8).some((v) => v !== 0) ||
    record[8] !== 255 ||
    record[9] !== 255
  )
    return "Unknown / macro";
  return (
    Object.entries(masks).find(([, value]) => value === record[1])?.[0] ??
    "Unknown / macro"
  );
}

export function redgearDecodeButtons(payload: Uint8Array): {
  buttonMappings: Record<string, string>;
  fixedButtons: string[];
} {
  const records = spans(payload);
  const buttonMappings: Record<string, string> = {};
  const fixedButtons: string[] = [];
  X13_BUTTON_NAMES.forEach((name, slot) => {
    const span = records[slot]!;
    const action = actionAt(payload, slot, span.offset, span.end);
    buttonMappings[name] = action;
    if (action === "Unknown / macro") fixedButtons.push(name);
  });
  return { buttonMappings, fixedButtons };
}

/** Replace only one same-length standard record. Macro/unknown slots cannot be overwritten. */
export function redgearEncodeButton(
  payload: Uint8Array,
  button: string,
  action: string,
): Uint8Array {
  const records = spans(payload);
  const slot = (X13_BUTTON_NAMES as readonly string[]).indexOf(button);
  if (slot < 0 || !(X13_BUTTON_ACTIONS as readonly string[]).includes(action))
    throw new RangeError("Unsupported X13 Pro button/action");
  const parsed = redgearDecodeButtons(payload);
  if (parsed.fixedButtons.includes(button))
    throw new Error("Unknown/macro assignments are protected");
  if (
    action !== "Left click" &&
    parsed.buttonMappings[button] === "Left click" &&
    !Object.entries(parsed.buttonMappings).some(
      ([key, value]) => key !== button && value === "Left click",
    )
  )
    throw new Error("Keep at least one primary left-click button");
  const result = payload.slice();
  const offset = records[slot]!.offset;
  result.fill(0, offset, offset + 10);
  if (action === "DPI cycle") result[offset] = 0x40 | (slot + 1);
  else {
    result[offset] = 0x20 | (slot + 1);
    result[offset + 1] = masks[action]!;
    result[offset + 8] = 255;
    result[offset + 9] = 255;
  }
  return result;
}
