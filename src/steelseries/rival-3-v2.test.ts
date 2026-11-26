import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL3_GEN2_DEFAULT_DPI_PRESETS,
  RIVAL3_GEN2_DEFAULT_POLLING_RATE,
  RIVAL3_GEN2_DPI_MAX,
  RIVAL3_GEN2_DPI_MIN,
  RIVAL3_GEN2_DPI_TO_BYTE,
  RIVAL3_GEN2_MAX_DPI_PRESETS,
  RIVAL3_GEN2_POLLING_RATES,
  Rival3Gen2ProtocolError,
  steelseriesRival3Gen2DecodeFirmware,
  steelseriesRival3Gen2DpiOptions,
  steelseriesRival3Gen2EncodeButtonsMapping,
  steelseriesRival3Gen2EncodeDpiPresets,
  steelseriesRival3Gen2EncodePollingRate,
  steelseriesRival3Gen2FirmwareQuery,
  steelseriesRival3Gen2SaveCommand,
} from "./rival-3-v2.ts";

test("DPI table follows the vendor file, including 0x49 for 3200", () => {
  assert.equal(RIVAL3_GEN2_DPI_TO_BYTE.get(400), 0x08);
  assert.equal(RIVAL3_GEN2_DPI_TO_BYTE.get(3200), 0x49);
  assert.equal(RIVAL3_GEN2_DPI_TO_BYTE.get(8500), 0xc5);
  assert.ok(![...RIVAL3_GEN2_DPI_TO_BYTE.values()].includes(0x4a));
  const options = steelseriesRival3Gen2DpiOptions();
  assert.equal(options[0], RIVAL3_GEN2_DPI_MIN);
  assert.equal(options.at(-1), RIVAL3_GEN2_DPI_MAX);
  assert.equal(options.length, 84);
  assert.deepEqual([...RIVAL3_GEN2_DEFAULT_DPI_PRESETS], [400, 800, 1600, 2400, 3200]);
  assert.equal(RIVAL3_GEN2_DEFAULT_POLLING_RATE, 1000);
  assert.equal(RIVAL3_GEN2_MAX_DPI_PRESETS, 5);
});

test("DPI presets interleave X and Y bytes with count and index", () => {
  const pair = { x: 800, y: 1600 };
  assert.deepEqual(
    [...steelseriesRival3Gen2EncodeDpiPresets([pair, pair, pair, pair, pair], 1)],
    [0x34, 0x05, 0x01, 0x12, 0x24, 0x12, 0x24, 0x12, 0x24, 0x12, 0x24, 0x12, 0x24],
  );
});

test("DPI presets require exactly five on-grid pairs and a valid index", () => {
  const pair = { x: 800, y: 800 };
  assert.throws(() => steelseriesRival3Gen2EncodeDpiPresets([pair, pair], 0), Rival3Gen2ProtocolError);
  assert.throws(
    () => steelseriesRival3Gen2EncodeDpiPresets([pair, pair, pair, pair, pair], 5),
    Rival3Gen2ProtocolError,
  );
  assert.throws(
    () => steelseriesRival3Gen2EncodeDpiPresets([pair, pair, pair, pair, { x: 150, y: 800 }], 0),
    Rival3Gen2ProtocolError,
  );
});

test("polling rates use 1000->0x01 down to 125->0x04", () => {
  assert.deepEqual([...steelseriesRival3Gen2EncodePollingRate(1000)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesRival3Gen2EncodePollingRate(125)], [0x2b, 0x04]);
  assert.deepEqual([...RIVAL3_GEN2_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesRival3Gen2EncodePollingRate(2000), Rival3Gen2ProtocolError);
});

test("save is one byte; firmware is a 15-byte string query", () => {
  assert.deepEqual([...steelseriesRival3Gen2SaveCommand()], [0x11]);
  assert.deepEqual([...steelseriesRival3Gen2FirmwareQuery()], [0x90]);
  const payload = new Uint8Array([0x31, 0x2e, 0x31, 0x2e, 0x36, ...new Array(10).fill(0x00)]);
  assert.equal(steelseriesRival3Gen2DecodeFirmware(payload), "1.1.6");
  assert.throws(() => steelseriesRival3Gen2DecodeFirmware(new Uint8Array(14)), Rival3Gen2ProtocolError);
});

test("button mapping covers eight slots", () => {
  const report = steelseriesRival3Gen2EncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button6: { type: "scrollUp" },
    scrollDown: { type: "dpiSwitch" },
  });
  assert.equal(report[0], 0x2a);
  assert.equal(report.length, 1 + 8 * 5);
  assert.equal(report[1], 0x01);
  assert.equal(report[1 + 5 * 5], 0x31);
  assert.equal(report[1 + 7 * 5], 0x30);
});

test("button mapping rejects unknown buttons and bad codes", () => {
  assert.throws(
    () => steelseriesRival3Gen2EncodeButtonsMapping({ ["button7" as never]: { type: "disabled" } }),
    Rival3Gen2ProtocolError,
  );
  assert.throws(
    () => steelseriesRival3Gen2EncodeButtonsMapping({ button1: { type: "keyboard", code: -1 } }),
    Rival3Gen2ProtocolError,
  );
});
