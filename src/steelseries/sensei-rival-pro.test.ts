import assert from "node:assert/strict";
import test from "node:test";

import {
  SENSEI_RIVAL_PRO_DEFAULT_DPI_PRESETS,
  SENSEI_RIVAL_PRO_DPI_MAX,
  SENSEI_RIVAL_PRO_DPI_MIN,
  SENSEI_RIVAL_PRO_DPI_PRESETS,
  SENSEI_RIVAL_PRO_POLLING_RATES,
  SenseiRivalProProtocolError,
  steelseriesSenseiRivalProEncodeButtonsMapping,
  steelseriesSenseiRivalProEncodeDpiPresets,
  steelseriesSenseiRivalProEncodePollingBatch,
  steelseriesSenseiRivalProEncodePollingRate,
  steelseriesSenseiRivalProSaveCommand,
} from "./sensei-rival-pro.ts";

test("DPI presets encode x/y little-endian plus lift-off and landing bytes", () => {
  assert.deepEqual(
    [...steelseriesSenseiRivalProEncodeDpiPresets(
      [
        { x: 400, y: 400, liftOffDistance: 1, landingDistance: 1 },
        { x: 800, y: 800, liftOffDistance: 1, landingDistance: 1 },
        { x: 1600, y: 1600, liftOffDistance: 1, landingDistance: 1 },
        { x: 2400, y: 2400, liftOffDistance: 1, landingDistance: 1 },
        { x: 3200, y: 3200, liftOffDistance: 1, landingDistance: 1 },
      ],
      2,
    )],
    [
      0x34, 0x05, 0x02,
      0x90, 0x01, 0x90, 0x01, 0x01, 0x01,
      0x20, 0x03, 0x20, 0x03, 0x01, 0x01,
      0x40, 0x06, 0x40, 0x06, 0x01, 0x01,
      0x60, 0x09, 0x60, 0x09, 0x01, 0x01,
      0x80, 0x0c, 0x80, 0x0c, 0x01, 0x01,
    ],
  );
});

test("DPI presets keep independent X and Y axes", () => {
  const report = steelseriesSenseiRivalProEncodeDpiPresets(
    [
      { x: 800, y: 1600, liftOffDistance: 0, landingDistance: 0 },
      { x: 800, y: 1600, liftOffDistance: 0, landingDistance: 0 },
      { x: 800, y: 1600, liftOffDistance: 0, landingDistance: 0 },
      { x: 800, y: 1600, liftOffDistance: 0, landingDistance: 0 },
      { x: 800, y: 1600, liftOffDistance: 0, landingDistance: 0 },
    ],
    0,
  );
  assert.deepEqual([...report.slice(0, 9)], [0x34, 0x05, 0x00, 0x20, 0x03, 0x40, 0x06, 0x00, 0x00]);
});

test("DPI presets require exactly five entries and a valid index", () => {
  const preset = { x: 800, y: 800, liftOffDistance: 0, landingDistance: 0 };
  assert.throws(
    () => steelseriesSenseiRivalProEncodeDpiPresets([preset, preset], 0),
    SenseiRivalProProtocolError,
  );
  assert.throws(
    () => steelseriesSenseiRivalProEncodeDpiPresets([preset, preset, preset, preset, preset], 5),
    SenseiRivalProProtocolError,
  );
  assert.throws(
    () => steelseriesSenseiRivalProEncodeDpiPresets(
      [preset, preset, preset, preset, { x: 0, y: 800, liftOffDistance: 0, landingDistance: 0 }],
      0,
    ),
    SenseiRivalProProtocolError,
  );
  assert.throws(
    () => steelseriesSenseiRivalProEncodeDpiPresets(
      [preset, preset, preset, preset, { x: 800, y: 800, liftOffDistance: 256, landingDistance: 0 }],
      0,
    ),
    SenseiRivalProProtocolError,
  );
  assert.equal(SENSEI_RIVAL_PRO_DPI_MIN, 1);
  assert.equal(SENSEI_RIVAL_PRO_DPI_MAX, 65000);
  assert.equal(SENSEI_RIVAL_PRO_DPI_PRESETS, 5);
  assert.deepEqual([...SENSEI_RIVAL_PRO_DEFAULT_DPI_PRESETS], [400, 800, 1600, 2400, 3200]);
});

test("polling rates use the vendor value table, including 8K", () => {
  assert.deepEqual(
    [...steelseriesSenseiRivalProEncodePollingRate(0, 8000)],
    [0x2c, 0x00, 0x00],
  );
  assert.deepEqual(
    [...steelseriesSenseiRivalProEncodePollingRate(4, 125)],
    [0x2c, 0x04, 0x06],
  );
  assert.deepEqual(
    [...steelseriesSenseiRivalProEncodePollingRate(2, 1000)],
    [0x2c, 0x02, 0x03],
  );
  assert.deepEqual([...SENSEI_RIVAL_PRO_POLLING_RATES], [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.throws(() => steelseriesSenseiRivalProEncodePollingRate(0, 5000), SenseiRivalProProtocolError);
  assert.throws(() => steelseriesSenseiRivalProEncodePollingRate(5, 1000), SenseiRivalProProtocolError);
});

test("polling batch writes five report/polling profile pairs", () => {
  const profile = { reportRateHz: 8000, pollingRateHz: 8000 };
  assert.deepEqual(
    [...steelseriesSenseiRivalProEncodePollingBatch([profile, profile, profile, profile, profile], 0)],
    [0x2d, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
  assert.deepEqual(
    [...steelseriesSenseiRivalProEncodePollingBatch(
      [
        { reportRateHz: 1000, pollingRateHz: 8000 },
        { reportRateHz: 1000, pollingRateHz: 8000 },
        { reportRateHz: 1000, pollingRateHz: 8000 },
        { reportRateHz: 1000, pollingRateHz: 8000 },
        { reportRateHz: 1000, pollingRateHz: 8000 },
      ],
      4,
    ).slice(0, 5)],
    [0x2d, 0x05, 0x04, 0x03, 0x00],
  );
  assert.throws(
    () => steelseriesSenseiRivalProEncodePollingBatch([profile, profile], 0),
    SenseiRivalProProtocolError,
  );
});

test("save command is one byte", () => {
  assert.deepEqual([...steelseriesSenseiRivalProSaveCommand()], [0x09]);
});

test("button mapping encodes eight 5-byte slots", () => {
  const report = steelseriesSenseiRivalProEncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button6: { type: "dpiSwitch" },
    scrollUp: { type: "button", target: "scrollUp" },
  });
  assert.equal(report[0], 0x2a);
  assert.equal(report.length, 1 + 8 * 5);
  assert.equal(report[1], 0x01);
  assert.equal(report[1 + 5 * 5], 0x30);
  assert.equal(report[1 + 6 * 5], 0x31);
  assert.equal(report[2], 0x00);
});

test("button mapping supports scroll, keyboard, and multimedia targets", () => {
  const report = steelseriesSenseiRivalProEncodeButtonsMapping({
    button4: { type: "scrollUp" },
    button5: { type: "keyboard", code: 0x04 },
    button6: { type: "multimedia", code: 0xe9 },
  });
  assert.equal(report[1 + 3 * 5], 0x31);
  assert.equal(report[1 + 4 * 5], 0x51);
  assert.equal(report[1 + 4 * 5 + 1], 0x04);
  assert.equal(report[1 + 5 * 5], 0x61);
  assert.equal(report[1 + 5 * 5 + 1], 0xe9);
});

test("button mapping rejects unknown buttons and targets", () => {
  assert.throws(
    // @ts-expect-error unknown button name
    () => steelseriesSenseiRivalProEncodeButtonsMapping({ button9: { type: "disabled" } }),
    SenseiRivalProProtocolError,
  );
  assert.throws(
    () => steelseriesSenseiRivalProEncodeButtonsMapping({
      button1: { type: "button", target: "button9" as never },
    }),
    SenseiRivalProProtocolError,
  );
});
