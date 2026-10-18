import assert from "node:assert/strict";
import test from "node:test";

import {
  RYUNIX_BUTTON_ACTIONS,
  RYUNIX_BUTTON_FACTORY_CODES,
  RYUNIX_BUTTON_SLOTS,
  RYUNIX_COMMAND_FRAME_LENGTH,
  ryunixAckOk,
  ryunixButtonActionName,
  ryunixClampDpi,
  ryunixDefaultDpiStages,
  ryunixFrame,
  ryunixResetFrame,
  ryunixSensor,
  ryunixSetButtonsFrames,
  ryunixSetDpiColorsFrame,
  ryunixSetDpiFrame,
  ryunixSetLiftOffFrame,
  ryunixSetLightingFrame,
  ryunixSetPollingRateFrame,
  ryunixSetPowerFrame,
  ryunixSetSensorOptionsFrame,
  ryunixSupportedPollingRates,
} from "./protocol.ts";

/** The vendor app's own framing, re-implemented: pad to 30, then splice `6 + sum` in at index 3. */
function vendorFrame(head: number[], pad: number): number[] {
  const body = [...head];
  while (body.length < 30) body.push(pad);
  let checksum = 6;
  for (const byte of body) checksum += byte;
  body.splice(3, 0, checksum & 0xff);
  return body;
}

test("frames match the vendor app's framing and checksum", () => {
  assert.deepEqual([...ryunixResetFrame(1)], vendorFrame([15, 1, 1, 255], 0));
  assert.equal(ryunixResetFrame(1)[3], 0x16);
  assert.deepEqual([...ryunixSetPollingRateFrame(5, 1000)], vendorFrame([4, 5, 1, 1], 0));
  assert.deepEqual([...ryunixSetLiftOffFrame(3, 2)], vendorFrame([5, 3, 1, 2], 255));
  assert.equal(ryunixSetLiftOffFrame(3, 2)[3], 0xf7);
  assert.equal(ryunixResetFrame(1).length, RYUNIX_COMMAND_FRAME_LENGTH);
});

test("frames reject oversized payloads and non-byte values", () => {
  assert.throws(() => ryunixFrame(1, 1, 1, new Array(28).fill(0)), RangeError);
  assert.throws(() => ryunixFrame(1, 1, 1, [256]), RangeError);
  assert.throws(() => ryunixFrame(1, 1, 1, [-1]), RangeError);
});

test("polling rate frames cover every code and refuse unknown rates", () => {
  const codes: Array<[number, number]> = [[125, 8], [250, 4], [500, 2], [1000, 1], [2000, 17], [4000, 18], [8000, 20]];
  for (const [hz, code] of codes) assert.equal(ryunixSetPollingRateFrame(1, hz)[4], code);
  assert.throws(() => ryunixSetPollingRateFrame(1, 750), RangeError);
});

test("polling rate options follow the reported maximum", () => {
  assert.deepEqual(ryunixSupportedPollingRates(1), [125, 250, 500, 1000]);
  assert.deepEqual(ryunixSupportedPollingRates(null), [125, 250, 500, 1000]);
  assert.deepEqual(ryunixSupportedPollingRates(2), [125, 250, 500, 1000, 2000]);
  assert.deepEqual(ryunixSupportedPollingRates(4), [125, 250, 500, 1000, 2000, 4000]);
  assert.deepEqual(ryunixSupportedPollingRates(8), [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(ryunixSupportedPollingRates(0x31), [125, 250]);
});

test("lift-off distance accepts only the vendor's two heights", () => {
  assert.equal(ryunixSetLiftOffFrame(1, 1)[4], 1);
  assert.throws(() => ryunixSetLiftOffFrame(1, 3), RangeError);
});

test("DPI table frames encode wire values per sensor and pad unused slots", () => {
  const s3220 = ryunixSensor(0x20);
  const frame = ryunixSetDpiFrame(2, { stages: [400, 800, 1600], activeStage: 1 }, s3220);
  const expected = vendorFrame([2, 2, 2, 1, 0b111, 3, 0, 7, 0, 15, 0, ...new Array(10).fill(255)], 255);
  assert.deepEqual([...frame], expected);

  // 3395 and 3950 count in 50 DPI steps.
  const s3395 = ryunixSensor(0x95);
  const fine = ryunixSetDpiFrame(2, { stages: [400, 26000], activeStage: 0 }, s3395);
  assert.deepEqual([...fine.subarray(6, 10)], [7, 0, 0x07, 0x02]);
  assert.equal(ryunixSetDpiFrame(2, { stages: [400], activeStage: 0 }, s3220, "y")[2], 0x12);
});

test("DPI table frames validate stage counts, active stage and DPI values", () => {
  const sensor = ryunixSensor(0x20);
  assert.throws(() => ryunixSetDpiFrame(1, { stages: [], activeStage: 0 }, sensor), RangeError);
  assert.throws(() => ryunixSetDpiFrame(1, { stages: new Array(8).fill(800), activeStage: 0 }, sensor), RangeError);
  assert.throws(() => ryunixSetDpiFrame(1, { stages: [800], activeStage: 1 }, sensor), RangeError);
  assert.throws(() => ryunixSetDpiFrame(1, { stages: [150], activeStage: 0 }, sensor), RangeError);
  assert.throws(() => ryunixSetDpiFrame(1, { stages: [850], activeStage: 0 }, sensor), RangeError);
  assert.throws(() => ryunixSetDpiFrame(1, { stages: [8100], activeStage: 0 }, sensor), RangeError);
});

test("sensor defaults and DPI clamping follow the vendor tables", () => {
  assert.equal(ryunixSensor(null).name, "3220");
  assert.equal(ryunixSensor(0xee).name, "3220");
  assert.equal(ryunixSensor(0x95).maxDpi, 26000);
  assert.equal(ryunixClampDpi(120, ryunixSensor(0x20)), 200);
  assert.equal(ryunixClampDpi(99999, ryunixSensor(0x20)), 8000);
  assert.equal(ryunixClampDpi(1349, ryunixSensor(0x20)), 1300);
  assert.deepEqual(ryunixDefaultDpiStages(ryunixSensor(0x20), 4), [400, 800, 1600, 2400]);
  assert.deepEqual(ryunixDefaultDpiStages(ryunixSensor(0x20)), [400, 800, 1600, 2400, 3200, 6400, 8000]);
});

test("DPI colour frames carry eight RGB triples", () => {
  const frame = ryunixSetDpiColorsFrame(4, ["#ff0000", "#0066ff"]);
  assert.deepEqual([...frame.subarray(4, 10)], [255, 0, 0, 0, 102, 255]);
  assert.equal(frame.length, RYUNIX_COMMAND_FRAME_LENGTH);
  assert.throws(() => ryunixSetDpiColorsFrame(4, ["red"]), RangeError);
});

test("lighting frames only carry the controls an effect has", () => {
  assert.deepEqual([...ryunixSetLightingFrame(7, { effect: 3, brightness: 3 })], vendorFrame([6, 7, 1, 255, 3, 48, 0], 255));
  assert.equal(ryunixSetLightingFrame(7, { effect: 3, brightness: 3 })[3], 0x2f);
  // Breathe: speed only, brightness ignored.
  assert.equal(ryunixSetLightingFrame(1, { effect: 2, speed: 2, brightness: 4 })[6], 2);
  // Rainbow flow adds direction.
  assert.equal(ryunixSetLightingFrame(1, { effect: 1, speed: 1, direction: 1 })[7], 1);
  // Out-of-range levels clamp like the vendor app.
  assert.equal(ryunixSetLightingFrame(1, { effect: 3, brightness: 9 })[6], 0x40);
  assert.equal(ryunixSetLightingFrame(1, { effect: 2, speed: 0 })[6], 1);
  assert.throws(() => ryunixSetLightingFrame(1, { effect: 99 }), RangeError);
});

test("power and sensor option frames match the vendor layout", () => {
  assert.deepEqual([...ryunixSetPowerFrame(9, { sleepMinutes: 5, wakeOnMove: true, lightOnMove: false })], vendorFrame([7, 9, 1, 5, 1, 0], 255));
  assert.throws(() => ryunixSetPowerFrame(1, { sleepMinutes: 0, wakeOnMove: true, lightOnMove: false }), RangeError);
  assert.throws(() => ryunixSetPowerFrame(1, { sleepMinutes: 16, wakeOnMove: true, lightOnMove: false }), RangeError);
  assert.deepEqual(
    [...ryunixSetSensorOptionsFrame(2, { angleSnapping: true, motionSync: false, rippleControl: true })],
    vendorFrame([8, 2, 1, 1, 0, 1], 255),
  );
});

test("button frames send positions in firmware order, with unset slots as 0xFF", () => {
  const left = RYUNIX_BUTTON_ACTIONS.get("Left click")!;
  const dpi = RYUNIX_BUTTON_ACTIONS.get("DPI cycle")!;
  const [first, second] = ryunixSetButtonsFrames([4, 5], [left, null, null, null, null, null, dpi]);
  assert.deepEqual([...first.subarray(0, 3)], [1, 4, 2]);
  assert.deepEqual([...first.subarray(4, 7)], [0x10, 0x01, 0x00]);
  assert.deepEqual([...first.subarray(7, 10)], [255, 255, 255]);
  assert.deepEqual([...first.subarray(22, 25)], [0x40, 0x01, 0x00]);
  assert.deepEqual([...second.subarray(0, 3)], [1, 5, 0x12]);
  assert.deepEqual([...second.subarray(4, 7)], [255, 255, 255]);
  assert.equal(first.length, RYUNIX_COMMAND_FRAME_LENGTH);
});

test("button actions are unique codes that round-trip by name", () => {
  const seen = new Set<string>();
  for (const [name, code] of RYUNIX_BUTTON_ACTIONS) {
    const key = code.join(",");
    assert.equal(seen.has(key), false, `${name} duplicates another action`);
    seen.add(key);
    assert.equal(ryunixButtonActionName(code), name);
  }
  assert.equal(ryunixButtonActionName([1, 2, 3]), null);
});

test("acknowledgements need byte 1 set", () => {
  assert.equal(ryunixAckOk(Uint8Array.of(0, 1)), true);
  assert.equal(ryunixAckOk(Uint8Array.of(0, 0)), false);
  assert.equal(ryunixAckOk(Uint8Array.of(1)), false);
});

test("the factory layout covers every position and agrees with the slot defaults", () => {
  assert.equal(RYUNIX_BUTTON_FACTORY_CODES.length, 10);
  RYUNIX_BUTTON_SLOTS.forEach((slot, index) => {
    assert.deepEqual(RYUNIX_BUTTON_FACTORY_CODES[index], RYUNIX_BUTTON_ACTIONS.get(slot.factory), slot.name);
  });
  assert.deepEqual(RYUNIX_BUTTON_FACTORY_CODES[9], RYUNIX_BUTTON_ACTIONS.get("Mode switch"));
});
