import test from "node:test";
import assert from "node:assert/strict";
import {
  redgearDecodeButtons,
  redgearEncodeButton,
} from "../../redgear/buttons.js";
// Minimal independent records from blocked vendor baseline/changed report-4 calls.
const records = [
  "2101000000000000ffff",
  "2202000000000000ffff",
  "2304000000000000ffff",
  "44000000000000000000",
  "2510000000000000ffff",
  "2608000000000000ffff",
  "2702000000000000ffff",
];
function fixture() {
  const b = new Uint8Array(2048);
  b.fill(0x9b, 160);
  records.forEach((hex, i) => {
    b[i * 2] = 48 + i * 10;
    b.set(Buffer.from(hex, "hex"), 48 + i * 10);
  });
  return b;
}
test("button decoder maps captured physical layout and protects unknown records", () => {
  const b = fixture();
  assert.deepEqual(redgearDecodeButtons(b), {
    buttonMappings: {
      Left: "Left click",
      Right: "Right click",
      Middle: "Middle click",
      DPI: "DPI cycle",
      Forward: "Forward",
      Back: "Back",
    },
    fixedButtons: [],
  });
  b[88] = 0xa5;
  assert.equal(
    redgearDecodeButtons(b).buttonMappings.Forward,
    "Unknown / macro",
  );
  assert.throws(() => redgearEncodeButton(b, "Forward", "Back"), /protected/);
});
test("button encoder matches two independent side-button captures and preserves all other data", () => {
  const b = fixture();
  for (const [action, hex] of [
    ["Back", "2508000000000000ffff"],
    ["Right click", "2502000000000000ffff"],
  ]) {
    const encoded = redgearEncodeButton(b, "Forward", action!);
    assert.equal(Buffer.from(encoded.slice(88, 98)).toString("hex"), hex);
    for (let i = 0; i < 2048; i++)
      if (i < 88 || i >= 98) assert.equal(encoded[i], b[i]);
  }
  assert.equal(Buffer.from(b.slice(88, 98)).toString("hex"), records[4]);
});
test("invalid button pointers, values and removal of the only primary click fail", () => {
  const b = fixture();
  assert.throws(() => redgearEncodeButton(b, "Left", "Back"), /primary/);
  assert.throws(() => redgearEncodeButton(b, "unknown", "Back"));
  assert.throws(() => redgearEncodeButton(b, "Forward", "Macro"));
  assert.throws(() => redgearDecodeButtons(new Uint8Array(2049)));
  for (const [index, value] of [
    [0, 1],
    [2, 48],
    [1, 255],
  ]) {
    const bad = b.slice();
    bad[index!] = value!;
    assert.throws(() => redgearDecodeButtons(bad));
  }
});
