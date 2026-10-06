import assert from "node:assert/strict";
import test from "node:test";

import {
  gwolvesAdvanceCalibration,
  gwolvesBuildCalibrationPayload,
  gwolvesBuildModelPayload,
  gwolvesDecodeRapidTrigger,
  gwolvesDecodeTriggerPoint,
  gwolvesEncodeRapidTrigger,
  gwolvesEncodeTriggerPoint,
  gwolvesParseButtonDepth,
  gwolvesReportChecksumIsValid,
} from "@openmouse/protocol/gwolves";

test("trigger points store the slider value minus one and reject a broken pair", () => {
  assert.equal(gwolvesEncodeTriggerPoint(1), 0);
  assert.equal(gwolvesEncodeTriggerPoint(20), 19);
  assert.throws(() => gwolvesEncodeTriggerPoint(0));
  assert.equal(gwolvesDecodeTriggerPoint([4, 0x55 - 4]), 5);
  assert.equal(gwolvesDecodeTriggerPoint([7, 7]), null);
  assert.equal(gwolvesDecodeTriggerPoint([40, 0x55 - 40]), null);
});

test("rapid trigger keeps the switch in the top bit and the level below it", () => {
  assert.equal(gwolvesEncodeRapidTrigger(true, 7), 0x87);
  assert.equal(gwolvesEncodeRapidTrigger(false, 10), 10);
  assert.deepEqual(gwolvesDecodeRapidTrigger([0x87, (0x55 - 0x87) & 0xff]), { enabled: true, level: 7 });
  assert.equal(gwolvesDecodeRapidTrigger([1, 1]), null);
});

test("calibration and model requests are valid report 8 frames", () => {
  const calibration = gwolvesBuildCalibrationPayload();
  assert.equal(gwolvesReportChecksumIsValid(calibration), true);
  assert.deepEqual([calibration[0], calibration[4], calibration[5], calibration[7]], [0x2e, 10, 1, 3]);
  const model = gwolvesBuildModelPayload([1, 2, 3, 4]);
  assert.equal(gwolvesReportChecksumIsValid(model), true);
  assert.deepEqual([...model.subarray(5, 9)], [1, 2, 3, 4]);
});

test("press depth only comes from the depth notification", () => {
  const report = new Uint8Array(16);
  report[0] = 10; report[13] = 0x80 | 33; report[14] = 100;
  assert.deepEqual(gwolvesParseButtonDepth(report), { left: 33, right: 100 });
  report[5] = 1;
  assert.equal(gwolvesParseButtonDepth(report), null);
  assert.equal(gwolvesParseButtonDepth(new Uint8Array(16)), null);
});

test("calibration needs both buttons fully down and then both fully up", () => {
  let stage = gwolvesAdvanceCalibration("pressBoth", { left: 100, right: 40 });
  assert.equal(stage, "pressBoth");
  stage = gwolvesAdvanceCalibration(stage, { left: 100, right: 100 });
  assert.equal(stage, "releaseBoth");
  assert.equal(gwolvesAdvanceCalibration(stage, { left: 0, right: 5 }), "releaseBoth");
  assert.equal(gwolvesAdvanceCalibration(stage, { left: 0, right: 0 }), "done");
});
