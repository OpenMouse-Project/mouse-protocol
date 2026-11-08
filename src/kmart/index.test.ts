import assert from "node:assert/strict";
import test from "node:test";
import {
  KMART_COMMAND, KMART_PMW3325_DPI_VALUES, kmartDecodeStatus, kmartDpiStagesData, kmartPmw3325DpiCode,
  kmartPollingInterval, kmartPollingRate, kmartRequest,
} from "./index.ts";

// Captured from the 2.4 GHz receiver (PID 0x5b2f), report ID included.
const CAPTURED_STATUS = Uint8Array.from(
  "0c 01 20 00 00 01 10 00 4d 33 36 31 32 01 11 25 36 08 58 00 ff 01 00 91 e4 10 ff ff 00 01 60 03 20".split(" "),
  (byte) => parseInt(byte, 16),
);

test("Kmart status request matches the configurator frame", () => {
  const request = kmartRequest(KMART_COMMAND.status, 0);
  assert.equal(request.length, 32);
  assert.deepEqual([...request.slice(0, 7)], [0x01, 0x20, 0, 0, 0, 0, 0]);
});

test("Kmart writes carry the write flag, length and data", () => {
  const request = kmartRequest(KMART_COMMAND.pollingInterval, 0xd0, [0x01], true);
  assert.deepEqual([...request.slice(0, 8)], [0x01, 0x07, 0x00, 0xd0, 0x01, 0x01, 0x01, 0x00]);
  assert.throws(() => kmartRequest(KMART_COMMAND.lighting, 0, new Array(27).fill(0), true), RangeError);
});

test("Kmart decodes a captured status reply with or without the report ID", () => {
  for (const reply of [CAPTURED_STATUS, CAPTURED_STATUS.subarray(1)]) {
    const status = kmartDecodeStatus(reply);
    assert.equal(status.linked, true);
    assert.equal(status.firmwareTag, "M3612");
    assert.equal(status.sensor, 0x25);
    assert.equal(status.activeStage, 2);
    assert.equal(status.enabledStageCount, 6);
    assert.equal(status.pollingRateHz, 125);
    assert.equal(status.batteryPercent, 88);
    assert.equal(status.chargeState, 0);
  }
  const asleep = CAPTURED_STATUS.slice();
  asleep[3] = 0x02;
  asleep[0x15] = 0x00;
  assert.equal(kmartDecodeStatus(asleep).linked, false);
  const corrupt = CAPTURED_STATUS.slice();
  corrupt[8] = 0;
  assert.throws(() => kmartDecodeStatus(corrupt));
});

test("Kmart DPI stages encode the bytes verified on hardware", () => {
  assert.equal(KMART_PMW3325_DPI_VALUES.length, 59);
  assert.equal(KMART_PMW3325_DPI_VALUES[0], 200);
  assert.equal(KMART_PMW3325_DPI_VALUES.at(-1), 10000);
  assert.deepEqual(
    kmartDpiStagesData([400, 800, 1600, 2400, 3200, 6400], 2),
    [0x36, 0x3f, 0x03, 0, 0x07, 0, 0x0f, 0, 0x17, 0, 0x1f, 0, 0x34, 0, 0, 0, 0, 0],
  );
  assert.throws(() => kmartPmw3325DpiCode(450), RangeError);
  assert.throws(() => kmartDpiStagesData([400], 1), RangeError);
});

test("Kmart polling uses report intervals in milliseconds", () => {
  assert.equal(kmartPollingInterval(1000), 1);
  assert.equal(kmartPollingInterval(125), 8);
  assert.equal(kmartPollingRate(2), 500);
  assert.equal(kmartPollingRate(3), null);
  assert.throws(() => kmartPollingInterval(2000), RangeError);
});
