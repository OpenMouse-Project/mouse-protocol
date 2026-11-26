import assert from "node:assert/strict";
import test from "node:test";
import { compaxEncodeRequest } from "../compx/codec.js";
import { LUNAFURY_BUTTON_ACTIONS, lunafuryButtonActionWritable, lunafuryDecodeButton,
  lunafuryDecodeButtonAction, lunafuryEncodeButtonAction, lunafuryKeyboardAction,
  lunafuryParseKeyboardAction, lunafuryReadButton, lunafuryWriteButton } from "./lunafury-buttons.js";

test("button requests use the vendor page, selectors, length and data order", () => {
  assert.deepEqual(Array.from(compaxEncodeRequest(lunafuryReadButton(3, "Forward")).slice(2, 21)),
    [2, 15, 3, 128, 3, 5, 0, 255, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(lunafuryWriteButton(2, "Back", "Keyboard:129:4"),
    { target: 2, page: 3, command: 0, length: 7, args: [2, 4, 0, 4, 2, 129, 4] });
  assert.deepEqual(lunafuryEncodeButtonAction("Calculator"), { functionId: 5, data: [1, 146] });
  assert.deepEqual(lunafuryEncodeButtonAction("DPI Cycle"), { functionId: 7, data: [6] });
});

test("actions absent from the official menu are not offered or writable", () => {
  for (const action of ["Left Double Click", "Browser Refresh", "Open Browser"]) {
    assert.equal(LUNAFURY_BUTTON_ACTIONS.includes(action), false);
    assert.equal(lunafuryButtonActionWritable(action), false);
    assert.throws(() => lunafuryEncodeButtonAction(action));
  }
  assert.equal(lunafuryDecodeButtonAction({ functionId: 2, data: [1, 1, 2, 0, 100] }), "Unknown:2:1,1,2,0,100");
});

test("every offered action round-trips without sharing mutable bytes", () => {
  for (const action of LUNAFURY_BUTTON_ACTIONS) {
    const binding = lunafuryEncodeButtonAction(action);
    assert.equal(lunafuryDecodeButtonAction(binding), action);
    assert.equal(lunafuryButtonActionWritable(action), true);
    (binding.data as number[]).push(255);
    assert.equal(lunafuryDecodeButtonAction(lunafuryEncodeButtonAction(action)), action);
  }
  for (const mask of [0, 1, 15, 16, 128, 255]) {
    const action = lunafuryKeyboardAction(mask, 99);
    assert.equal(lunafuryDecodeButtonAction(lunafuryEncodeButtonAction(action)), action);
    assert.deepEqual(lunafuryParseKeyboardAction(action), { modifiers: mask, usage: 99 });
  }
});

test("reject malformed actions, unsupported physical buttons and profile ranges", () => {
  for (const action of ["Default", "Macro:16:1", "Unknown:255:", "__proto__", "Keyboard:01:4",
    "Keyboard:256:4", "Keyboard:-1:4", "Keyboard:0:0", "Keyboard:0:50", "Keyboard:0:227", "Keyboard:0:100"]) {
    assert.equal(lunafuryButtonActionWritable(action), false);
    assert.throws(() => lunafuryWriteButton(1, "Right", action));
  }
  for (const profile of [0, 4, 1.5, NaN]) assert.throws(() => lunafuryReadButton(profile, "Left"));
  for (const button of ["DPI", "Receiver", "__proto__"]) assert.throws(() => lunafuryReadButton(1, button));
});

test("button replies validate scope and declared data length while ignoring padding", () => {
  const raw = Uint8Array.from([2, 3, 0, 4, 2, 32, 40, 255, 255]);
  assert.deepEqual(lunafuryDecodeButton(raw, 2, "Middle"), { functionId: 4, data: [32, 40] });
  for (const payload of [[1, 3, 0, 4, 2, 32, 40], [2, 2, 0, 4, 2, 32, 40],
    [2, 3, 1, 4, 2, 32, 40], [2, 3, 0, 4, 2, 32], [2, 3, 0, 4, 11], [2, 3]]) {
    assert.throws(() => lunafuryDecodeButton(Uint8Array.from(payload), 2, "Middle"));
  }
  for (const binding of [{ functionId: 16, data: [3, 2, 1] }, { functionId: 1, data: [1, 2] },
    { functionId: 4, data: [0, 0] }, { functionId: 255, data: [] }]) {
    assert.equal(lunafuryButtonActionWritable(lunafuryDecodeButtonAction(binding)), false);
  }
});
