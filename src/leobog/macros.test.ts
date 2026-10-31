import assert from "node:assert/strict";
import test from "node:test";

import {
  LEOBOG_GM3_MACRO_MODE,
  LEOBOG_GM3_MACRO_SLOTS,
  leobogGm3DecodeMacroRecord,
  leobogGm3EncodeMacroRecord,
  leobogGm3MacroEventType,
  leobogGm3IsMacroBinding,
  leobogGm3MacroBindingCode,
  type LeobogGm3MacroStep,
} from "@openmouse/protocol/leobog";

/**
 * The `03 00` payload the vendor application sent after recording `C`, a pause,
 * then `D` into a macro named OM2. Captured over USB on 2026-10-27.
 */
const CAPTURED_OM2 = new Uint8Array([
  0x04, 0x00, 0x17, 0x00, 0x06, 0x4f, 0x00, 0x4d, 0x00, 0x32,
  0x00, 0x00, 0x00, 0xea, 0x06, 0x80, 0x01, 0xd5, 0x06, 0x00,
  0x00, 0x7d, 0x07, 0x80, 0x00, 0x00, 0x07,
]);

/** The same command for a macro with a name and no steps (OMTEST). */
const CAPTURED_OMTEST = new Uint8Array([
  0x04, 0x00, 0x0d, 0x00, 0x0c, 0x4f, 0x00, 0x4d, 0x00, 0x54,
  0x00, 0x45, 0x00, 0x53, 0x00, 0x54, 0x00,
]);

const OM2_STEPS: LeobogGm3MacroStep[] = [
  { delayMs: 234, event: { type: "keyDown", hidUsage: 0x06 } },
  { delayMs: 469, event: { type: "keyUp", hidUsage: 0x06 } },
  { delayMs: 125, event: { type: "keyDown", hidUsage: 0x07 } },
  { delayMs: 0, event: { type: "keyUp", hidUsage: 0x07 } },
];

/**
 * The `03 00` payload after recording `left click`, then `C` into a macro
 * named OMM — the capture that revealed the mouse flag. 2026-10-27, USB.
 */
const CAPTURED_OMM = new Uint8Array([
  0x04, 0x00, 0x17, 0x00, 0x06, 0x4f, 0x00, 0x4d, 0x00, 0x4d,
  0x00, 0x20, 0x00, 0x8c, 0x01, 0xa0, 0x02, 0xb0, 0x01, 0x00,
  0x00, 0x7d, 0x06, 0x80, 0x00, 0x00, 0x06,
]);

const OMM_STEPS: LeobogGm3MacroStep[] = [
  { delayMs: 140, event: { type: "mouseDown", hidUsage: 1 } },
  { delayMs: 688, event: { type: "mouseUp", hidUsage: 1 } },
  { delayMs: 125, event: { type: "keyDown", hidUsage: 0x06 } },
  { delayMs: 0, event: { type: "keyUp", hidUsage: 0x06 } },
];

test("reproduces the captured OM2 record byte for byte", () => {
  assert.deepEqual([...leobogGm3EncodeMacroRecord("OM2", OM2_STEPS)], [...CAPTURED_OM2]);
});

test("an empty macro still carries its name", () => {
  assert.deepEqual([...leobogGm3EncodeMacroRecord("OMTEST", [])], [...CAPTURED_OMTEST]);
});

test("reproduces the captured left-click record and reads it back", () => {
  assert.deepEqual([...leobogGm3EncodeMacroRecord("OMM", OMM_STEPS)], [...CAPTURED_OMM]);
  assert.deepEqual(leobogGm3DecodeMacroRecord(CAPTURED_OMM), { name: "OMM", steps: OMM_STEPS });
});

test("flag bytes name the four event kinds", () => {
  assert.equal(leobogGm3MacroEventType(0x00), "keyDown");
  assert.equal(leobogGm3MacroEventType(0x80), "keyUp");
  assert.equal(leobogGm3MacroEventType(0x20), "mouseDown");
  assert.equal(leobogGm3MacroEventType(0xa0), "mouseUp");
});

test("the record round-trips through encode and decode", () => {
  assert.deepEqual(leobogGm3DecodeMacroRecord(leobogGm3EncodeMacroRecord("OM2", OM2_STEPS)), {
    name: "OM2",
    steps: OM2_STEPS,
  });
  assert.deepEqual(leobogGm3DecodeMacroRecord(leobogGm3EncodeMacroRecord("OMTEST", [])), {
    name: "OMTEST",
    steps: [],
  });
});

test("rejects malformed records", () => {
  assert.equal(leobogGm3DecodeMacroRecord(new Uint8Array(2)), null);
  const wrongTag = leobogGm3EncodeMacroRecord("OM2", OM2_STEPS);
  wrongTag[0] = 0x05;
  assert.equal(leobogGm3DecodeMacroRecord(wrongTag), null);
  assert.equal(leobogGm3DecodeMacroRecord(CAPTURED_OM2.slice(0, 20)), null);
});

test("validates names, delays and usages", () => {
  assert.throws(() => leobogGm3EncodeMacroRecord("", []), RangeError);
  assert.throws(() => leobogGm3EncodeMacroRecord("x".repeat(20), []), RangeError);
  assert.throws(
    () => leobogGm3EncodeMacroRecord("OM2", [{ delayMs: -1, event: { type: "keyDown", hidUsage: 4 } }]),
    RangeError,
  );
  assert.throws(
    () => leobogGm3EncodeMacroRecord("OM2", [{ delayMs: 0, event: { type: "keyDown", hidUsage: 300 } }]),
    RangeError,
  );
});

test("macro bindings match the four modes captured in the vendor UI", () => {
  assert.deepEqual(leobogGm3MacroBindingCode(0), [0x03, 0x01, 0x01, 0x00]);
  assert.deepEqual(leobogGm3MacroBindingCode(0, LEOBOG_GM3_MACRO_MODE.repeat, 7), [0x03, 0x01, 0x07, 0x00]);
  assert.deepEqual(
    leobogGm3MacroBindingCode(0, LEOBOG_GM3_MACRO_MODE.untilAnyKey, 7),
    [0x03, 0x02, 0x01, 0x00],
  );
  assert.deepEqual(
    leobogGm3MacroBindingCode(0, LEOBOG_GM3_MACRO_MODE.untilRelease, 7),
    [0x03, 0x04, 0x01, 0x00],
  );
  assert.deepEqual(leobogGm3MacroBindingCode(2, LEOBOG_GM3_MACRO_MODE.repeat, 3), [0x03, 0x01, 0x03, 0x02]);
});

test("binding helpers reject out-of-range slots and counts", () => {
  assert.throws(() => leobogGm3MacroBindingCode(LEOBOG_GM3_MACRO_SLOTS), RangeError);
  assert.throws(() => leobogGm3MacroBindingCode(0, LEOBOG_GM3_MACRO_MODE.repeat, 256), RangeError);
  assert.equal(leobogGm3IsMacroBinding([0x03, 0x01, 0x01, 0x00]), true);
  assert.equal(leobogGm3IsMacroBinding([0x01, 0x01, 0x01, 0x00]), false);
});
