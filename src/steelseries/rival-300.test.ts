import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL300_DEFAULT_DPI_PRESET_1,
  RIVAL300_DEFAULT_DPI_PRESET_2,
  RIVAL300_DEFAULT_POLLING_RATE,
  RIVAL300_DPI_MAX,
  RIVAL300_DPI_MIN,
  RIVAL300_POLLING_RATES,
  Rival300ProtocolError,
  steelseriesRival300ActiveCpiQuery,
  steelseriesRival300DecodeActivePreset,
  steelseriesRival300DecodeFirmware,
  steelseriesRival300DpiOptions,
  steelseriesRival300EncodeButtonsMapping,
  steelseriesRival300EncodeLedColor,
  steelseriesRival300EncodeLedEffect,
  steelseriesRival300EncodePollingRate,
  steelseriesRival300EncodeSensitivity1,
  steelseriesRival300EncodeSensitivity2,
  steelseriesRival300FirmwareQuery,
  steelseriesRival300SaveCommand,
} from "./rival-300.ts";

test("DPI options are the linear 50..6500 range in 50 DPI steps", () => {
  const options = steelseriesRival300DpiOptions();
  assert.equal(options[0], RIVAL300_DPI_MIN);
  assert.equal(options.at(-1), RIVAL300_DPI_MAX);
  assert.equal(options.length, (RIVAL300_DPI_MAX - RIVAL300_DPI_MIN) / 50 + 1);
  assert.equal(RIVAL300_DEFAULT_DPI_PRESET_1, 800);
  assert.equal(RIVAL300_DEFAULT_DPI_PRESET_2, 1600);
  assert.equal(RIVAL300_DEFAULT_POLLING_RATE, 1000);
});

test("encodes sensitivity presets with the linear+1 byte", () => {
  // byte = (dpi - 50) / 50 + 1
  assert.deepEqual([...steelseriesRival300EncodeSensitivity1(50)], [0x03, 0x01, 0x01]);
  assert.deepEqual([...steelseriesRival300EncodeSensitivity1(800)], [0x03, 0x01, 0x10]);
  assert.deepEqual([...steelseriesRival300EncodeSensitivity2(1600)], [0x03, 0x02, 0x20]);
  assert.deepEqual([...steelseriesRival300EncodeSensitivity1(6500)], [0x03, 0x01, 0x82]);
  assert.throws(() => steelseriesRival300EncodeSensitivity1(75), Rival300ProtocolError);
  assert.throws(() => steelseriesRival300EncodeSensitivity2(6550), Rival300ProtocolError);
});

test("polling, save, firmware, and active-CPI queries", () => {
  assert.deepEqual([...steelseriesRival300EncodePollingRate(1000)], [0x04, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival300EncodePollingRate(125)], [0x04, 0x00, 0x04]);
  assert.deepEqual([...RIVAL300_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesRival300EncodePollingRate(2000), Rival300ProtocolError);
  assert.deepEqual([...steelseriesRival300SaveCommand()], [0x09, 0x00]);
  assert.deepEqual([...steelseriesRival300FirmwareQuery()], [0x10, 0x00]);
  assert.deepEqual([...steelseriesRival300ActiveCpiQuery()], [0x16, 0x00]);
  assert.deepEqual(steelseriesRival300DecodeFirmware(new Uint8Array([0x03, 0x01])), {
    bytes: [0x03, 0x01],
    display: "1.3",
  });
  assert.throws(() => steelseriesRival300DecodeFirmware(new Uint8Array([0x03])), Rival300ProtocolError);
  // Active-preset reply: report-id stripped, so the first byte is the level.
  assert.equal(steelseriesRival300DecodeActivePreset(new Uint8Array([0x01, 0x00])), 1);
  assert.equal(steelseriesRival300DecodeActivePreset(new Uint8Array([0x02, 0x00])), 2);
  assert.throws(() => steelseriesRival300DecodeActivePreset(new Uint8Array([0x03])), Rival300ProtocolError);
  assert.throws(() => steelseriesRival300DecodeActivePreset(new Uint8Array([])), Rival300ProtocolError);
});

test("LED color and effect address logo (0x01) and wheel (0x02) zones", () => {
  assert.deepEqual([...steelseriesRival300EncodeLedColor("logo", 0xff, 0x18, 0x00)], [0x08, 0x01, 0xff, 0x18, 0x00]);
  assert.deepEqual([...steelseriesRival300EncodeLedColor("wheel", 0x00, 0x00, 0xff)], [0x08, 0x02, 0x00, 0x00, 0xff]);
  assert.deepEqual([...steelseriesRival300EncodeLedEffect("logo", "steady")], [0x07, 0x01, 0x01]);
  assert.deepEqual([...steelseriesRival300EncodeLedEffect("wheel", "breath")], [0x07, 0x02, 0x03]);
  assert.throws(() => steelseriesRival300EncodeLedColor("strip" as never, 0, 0, 0), Rival300ProtocolError);
  assert.throws(() => steelseriesRival300EncodeLedEffect("logo", "pulse" as never), Rival300ProtocolError);
});

test("button mapping covers six slots", () => {
  const report = steelseriesRival300EncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button6: { type: "dpiSwitch" },
  });
  assert.equal(report[0], 0x31);
  assert.equal(report[1], 0x00);
  assert.equal(report.length, 2 + 6 * 5);
  assert.equal(report[2], 0x01);
  assert.equal(report[2 + 5 * 5], 0x30);
});

test("button mapping rejects unknown slots and bad codes", () => {
  assert.throws(
    () => steelseriesRival300EncodeButtonsMapping({ ["button7" as never]: { type: "disabled" } }),
    Rival300ProtocolError,
  );
  assert.throws(
    () => steelseriesRival300EncodeButtonsMapping({ button1: { type: "multimedia", code: 300 } }),
    Rival300ProtocolError,
  );
});
