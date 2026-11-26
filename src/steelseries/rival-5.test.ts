import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL5_DPI_MAX,
  RIVAL5_DPI_MIN,
  RIVAL5_MAX_DPI_PRESETS,
  RIVAL5_POLLING_RATES,
  Rival5ProtocolError,
  steelseriesRival5DecodeFirmware,
  steelseriesRival5DpiOptions,
  steelseriesRival5EncodeButtonsMapping,
  steelseriesRival5EncodeDpiPresets,
  steelseriesRival5EncodePollingRate,
  steelseriesRival5FirmwareQuery,
  steelseriesRival5SaveCommand,
} from "./rival-5.ts";
import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

test("DPI options mirror the shared TrueMove Air table", () => {
  const options = steelseriesRival5DpiOptions();
  assert.equal(options[0], RIVAL5_DPI_MIN);
  assert.equal(options.at(-1), RIVAL5_DPI_MAX);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(400), 0x04);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(1600), 0x12);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(18000), 0xd6);
});

test("DPI presets encode five sensor bytes with count and 0-based index", () => {
  assert.deepEqual(
    [...steelseriesRival5EncodeDpiPresets([400, 800, 1200, 2400, 3200], 0)],
    [0x2d, 0x05, 0x00, 0x04, 0x09, 0x0d, 0x1b, 0x26],
  );
  assert.deepEqual(
    [...steelseriesRival5EncodeDpiPresets([400, 800, 1200, 2400, 3200], 4).slice(0, 3)],
    [0x2d, 0x05, 0x04],
  );
});

test("DPI presets require exactly five on-grid values and a valid index", () => {
  assert.throws(() => steelseriesRival5EncodeDpiPresets([400, 800], 0), Rival5ProtocolError);
  assert.throws(
    () => steelseriesRival5EncodeDpiPresets([400, 800, 1200, 2400, 3200], 5),
    Rival5ProtocolError,
  );
  assert.throws(() => steelseriesRival5EncodeDpiPresets([150, 800, 1200, 2400, 3200], 0), Rival5ProtocolError);
  assert.equal(RIVAL5_MAX_DPI_PRESETS, 5);
});

test("polling rates use 1000->0x01 down to 125->0x04", () => {
  assert.deepEqual([...steelseriesRival5EncodePollingRate(1000)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesRival5EncodePollingRate(125)], [0x2b, 0x04]);
  assert.deepEqual([...RIVAL5_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesRival5EncodePollingRate(8000), Rival5ProtocolError);
});

test("save is one byte; firmware is a 32-byte string query", () => {
  assert.deepEqual([...steelseriesRival5SaveCommand()], [0x11]);
  assert.deepEqual([...steelseriesRival5FirmwareQuery()], [0x90]);
  const payload = new Uint8Array(32);
  payload.set([0x31, 0x2e, 0x30, 0x2e, 0x31]);
  assert.equal(steelseriesRival5DecodeFirmware(payload), "1.0.1");
  assert.throws(() => steelseriesRival5DecodeFirmware(new Uint8Array(31)), Rival5ProtocolError);
});

test("button mapping covers eleven slots", () => {
  const report = steelseriesRival5EncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button9: { type: "dpiSwitch" },
    scrollDown: { type: "button", target: "scrollDown" },
  });
  assert.equal(report[0], 0x2a);
  assert.equal(report.length, 1 + 11 * 5);
  assert.equal(report[1], 0x01);
  assert.equal(report[1 + 8 * 5], 0x30);
  assert.equal(report[1 + 10 * 5], 0x32);
});

test("button mapping rejects unknown buttons and bad codes", () => {
  assert.throws(
    () => steelseriesRival5EncodeButtonsMapping({ ["button10" as never]: { type: "disabled" } }),
    Rival5ProtocolError,
  );
  assert.throws(
    () => steelseriesRival5EncodeButtonsMapping({ button1: { type: "multimedia", code: 300 } }),
    Rival5ProtocolError,
  );
});
