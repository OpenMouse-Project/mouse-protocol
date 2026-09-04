import assert from "node:assert/strict";
import test from "node:test";

import {
  atkDecodeLiftOff,
  atkDecodeVxeR1PollingCode,
  atkPackDpiStage,
  atkPackVxeR1PollingSetting,
  atkUnpackDpiStage,
  ATK_VXE_R1_POLLING_RATES,
} from "@openmouse/protocol/atk";

test("DPI stages survive a round trip across every step range", () => {
  for (const [x, y] of [[50, 50], [800, 800], [10000, 1600], [10050, 10050], [26000, 26000], [42000, 42000]]) {
    const stage = atkPackDpiStage(x!, y!);
    const sum = stage.reduce((total, byte) => total + byte, 0);

    assert.equal(sum & 0xff, 0x55, `stage checksum for ${x}/${y}`);
    assert.deepEqual(atkUnpackDpiStage(stage), { x, y });
  }
});

test("DPI stages with a corrupt checksum are rejected", () => {
  const stage = atkPackDpiStage(1600, 1600);
  stage[3] ^= 0xff;

  assert.equal(atkUnpackDpiStage(stage), null);
  assert.equal(atkUnpackDpiStage([1, 2, 3]), null);
});

test("Lift-off codes decode to millimetres", () => {
  assert.equal(atkDecodeLiftOff(1), 0.7);
  assert.equal(atkDecodeLiftOff(4), 1);
  assert.equal(atkDecodeLiftOff(11), 1.7);
  assert.equal(atkDecodeLiftOff(0), null);
});

test("R1 polling pack is the 0x0b live-settings row with a checksum pair", () => {
  assert.deepEqual(atkPackVxeR1PollingSetting(1000), [0x0b, 0x01, 0x00, 0x54]);
  assert.deepEqual(atkPackVxeR1PollingSetting(500), [0x0b, 0x02, 0x00, 0x53]);
  assert.deepEqual(atkPackVxeR1PollingSetting(250), [0x0b, 0x03, 0x00, 0x52]);
  assert.equal(atkPackVxeR1PollingSetting(2000), null);
  assert.equal(atkPackVxeR1PollingSetting(125), null);
});

test("R1 polling codes decode back to hertz and reject unknown bytes", () => {
  assert.equal(atkDecodeVxeR1PollingCode(0x01), 1000);
  assert.equal(atkDecodeVxeR1PollingCode(0x02), 500);
  assert.equal(atkDecodeVxeR1PollingCode(0x03), 250);
  assert.equal(atkDecodeVxeR1PollingCode(0x00), null);
  assert.equal(atkDecodeVxeR1PollingCode(0x40), null);
  assert.deepEqual(ATK_VXE_R1_POLLING_RATES, [250, 500, 1000]);
});
