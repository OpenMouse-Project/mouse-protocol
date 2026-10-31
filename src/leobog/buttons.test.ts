import assert from "node:assert/strict";
import test from "node:test";

import {
  LEOBOG_GM3_BUTTON_ACTIONS,
  LEOBOG_GM3_BUTTON_NAMES,
  LEOBOG_GM3_BUTTON_TABLE_LENGTH,
  LEOBOG_GM3_DEFAULT_BUTTONS,
  leobogGm3ButtonLabel,
  leobogGm3ConsumerCode,
  leobogGm3DecodeButtonTable,
  leobogGm3EncodeButtonTable,
  leobogGm3FindButtonAction,
} from "@openmouse/protocol/leobog";

/**
 * The table the vendor application re-sent on every edit while a binding was
 * selected in its UI, and the factory table `MS.ini` describes. Captured over
 * the 2.4 GHz receiver on 2026-10-26.
 */
const CAPTURED_FACTORY_TABLE = new Uint8Array([
  0x01, 0x01, 0x01, 0x00, 0x01, 0x02, 0x01, 0x00, 0x01, 0x03,
  0x01, 0x00, 0x01, 0x04, 0x01, 0x00, 0x01, 0x05, 0x01, 0x00,
  0x05, 0x04, 0x00, 0x00,
]);

/** label -> bytes, for every entry confirmed against a live selection. */
const VERIFIED_ACTIONS: Record<string, readonly number[]> = {
  Disabled: [0x00, 0x00, 0x00, 0x00],
  "Left click": [0x01, 0x01, 0x01, 0x00],
  "Middle click": [0x01, 0x02, 0x01, 0x00],
  "Right click": [0x01, 0x03, 0x01, 0x00],
  Forward: [0x01, 0x04, 0x01, 0x00],
  Backward: [0x01, 0x05, 0x01, 0x00],
  "Scroll up": [0x01, 0x08, 0x00, 0x00],
  "Scroll down": [0x01, 0x09, 0x00, 0x00],
  "Double click": [0x01, 0x01, 0x02, 0x32],
  "Triple click": [0x01, 0x01, 0x03, 0x32],
  "Fire button": [0x01, 0x01, 0x00, 0x32],
  "DPI loop": [0x05, 0x04, 0x00, 0x00],
  "DPI lock": [0x05, 0x05, 0x00, 0x09],
  "Play/Pause": [0x02, 0x00, 0x00, 0xcd],
  "Mail": [0x02, 0x00, 0x01, 0x8a],
  "My Computer": [0x02, 0x00, 0x01, 0x94],
};

test("every live-verified action keeps its captured bytes", () => {
  for (const [label, bytes] of Object.entries(VERIFIED_ACTIONS)) {
    assert.deepEqual(leobogGm3FindButtonAction(label), bytes, label);
    assert.equal(leobogGm3ButtonLabel(bytes as unknown as [number, number, number, number]), label);
  }
});

test("the factory bindings reproduce the captured default table", () => {
  const codes = LEOBOG_GM3_BUTTON_NAMES.map((name) => leobogGm3FindButtonAction(LEOBOG_GM3_DEFAULT_BUTTONS[name]));
  assert.equal(codes.every((code) => code !== null), true);
  const encoded = leobogGm3EncodeButtonTable(codes as [number, number, number, number][]);
  assert.equal(encoded.length, LEOBOG_GM3_BUTTON_TABLE_LENGTH);
  assert.deepEqual(
    [...encoded.slice(0, CAPTURED_FACTORY_TABLE.length)],
    [...CAPTURED_FACTORY_TABLE],
  );
  // Everything past the six slots stays zero, as the vendor app sends it.
  assert.deepEqual([...encoded.slice(CAPTURED_FACTORY_TABLE.length)], new Array(
    LEOBOG_GM3_BUTTON_TABLE_LENGTH - CAPTURED_FACTORY_TABLE.length,
  ).fill(0));
});

test("consumer actions carry a big-endian HID usage", () => {
  assert.deepEqual(leobogGm3ConsumerCode(0x18a), [0x02, 0x00, 0x01, 0x8a]);
  assert.deepEqual(leobogGm3ConsumerCode(0xe9), [0x02, 0x00, 0x00, 0xe9]);
  assert.throws(() => leobogGm3ConsumerCode(0x1_0000), RangeError);
});

test("multi-click and fire keep the vendor's repeat parameter", () => {
  // The vendor ships 0x32 in byte 3 for the double-click, triple-click and
  // fire-button entries; only the mode byte separates them.
  assert.deepEqual(leobogGm3FindButtonAction("Double click"), [0x01, 0x01, 0x02, 0x32]);
  assert.deepEqual(leobogGm3FindButtonAction("Triple click"), [0x01, 0x01, 0x03, 0x32]);
  assert.deepEqual(leobogGm3FindButtonAction("Fire button"), [0x01, 0x01, 0x00, 0x32]);
});

test("the table round-trips through encode and decode", () => {
  const codes = LEOBOG_GM3_BUTTON_ACTIONS.slice(0, LEOBOG_GM3_BUTTON_NAMES.length)
    .map((action) => action.code);
  const encoded = leobogGm3EncodeButtonTable(codes);
  assert.deepEqual(leobogGm3DecodeButtonTable(encoded), codes);
});

test("encode refuses more slots than the table holds", () => {
  const tooMany = Array.from(
    { length: LEOBOG_GM3_BUTTON_TABLE_LENGTH / 4 + 1 },
    () => [0, 0, 0, 0] as const,
  );
  assert.throws(() => leobogGm3EncodeButtonTable(tooMany), RangeError);
});

test("decode rejects a short payload and unknown labels read as null", () => {
  assert.equal(leobogGm3DecodeButtonTable(new Uint8Array(8)), null);
  assert.equal(leobogGm3ButtonLabel([0x09, 0x09, 0x09, 0x09]), null);
  assert.equal(leobogGm3FindButtonAction("Nonexistent"), null);
});
