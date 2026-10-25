import assert from "node:assert/strict";
import test from "node:test";
import { hitscanDecodeButton, hitscanEncodeButton, type HitscanButtonAction } from "./buttons.js";

test("mouse and DPI actions follow named Qt action connections", () => {
  for (const [action, raw] of [
    [{kind: "mouse", button: "left"}, [1, 1, 0]],
    [{kind: "mouse", button: "right"}, [1, 2, 0]],
    [{kind: "mouse", button: "middle"}, [1, 4, 0]],
    [{kind: "mouse", button: "back"}, [1, 8, 0]],
    [{kind: "mouse", button: "forward"}, [1, 16, 0]],
    [{kind: "dpi", action: "loop"}, [2, 1, 0]],
    [{kind: "dpi", action: "up"}, [2, 2, 0]],
    [{kind: "dpi", action: "down"}, [2, 3, 0]],
    [{kind: "disabled"}, [0, 0, 0]],
    [{kind: "pollingSwitch"}, [7, 0, 0]],
  ] as const) {
    assert.deepEqual(hitscanEncodeButton(action), raw);
    assert.deepEqual(hitscanDecodeButton(raw), action);
  }
});

test("shipped Config.ini button defaults retain unexplained values", () => {
  // Literal KeyParam1..6; labels/defaults in that INI are not all conventional.
  for (const raw of [[1,1,0], [1,2,0], [1,0,0x83], [1,8,0], [1,0,0], [1,1,0]]) {
    assert.deepEqual(hitscanEncodeButton(hitscanDecodeButton(raw)), raw);
  }
  assert.equal(hitscanDecodeButton([1,0,0x83]).kind, "unknown");
  assert.equal(hitscanDecodeButton([1,0,0]).kind, "unknown");
  assert.equal(hitscanDecodeButton([1,1,2]).kind, "unknown");
});

test("shortcut/macro parameters and unknown actions survive unchanged", () => {
  for (const raw of [[5,0x80,12], [6,2,70], [10,3,4], [255,255,255]]) {
    assert.deepEqual(hitscanEncodeButton(hitscanDecodeButton(new Uint8Array(raw))), raw);
  }
  for (const raw of [[], [1,2], [1,2,3,4], [1,-1,0], [256,0,0], [NaN,0,0]]) {
    assert.throws(() => hitscanDecodeButton(raw), RangeError);
  }
  assert.throws(() => hitscanEncodeButton({kind:"macro",parameters:[1,256]}), RangeError);
  assert.throws(() => hitscanEncodeButton({kind:"mouse",button:"invalid"} as unknown as HitscanButtonAction), RangeError);
});
