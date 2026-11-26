import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL110_BUTTON6_MODE_TO_BYTE,
  RIVAL110_DEFAULT_DPI_PRESET_1,
  RIVAL110_DEFAULT_DPI_PRESET_2,
  RIVAL110_DEFAULT_POLLING_RATE,
  RIVAL110_DPI_MAX,
  RIVAL110_DPI_MIN,
  RIVAL110_DPI_TO_BYTE,
  RIVAL110_FIRMWARE_RESPONSE_LENGTH,
  RIVAL110_POLLING_RATES,
  Rival110ProtocolError,
  steelseriesRival110ActiveCpiQuery,
  steelseriesRival110DecodeActivePreset,
  steelseriesRival110DecodeFirmware,
  steelseriesRival110DpiOptions,
  steelseriesRival110EncodeButton6Mode,
  steelseriesRival110EncodeLedColor,
  steelseriesRival110EncodeLightEffect,
  steelseriesRival110EncodePollingRate,
  steelseriesRival110EncodeSensitivity1,
  steelseriesRival110EncodeSensitivity2,
  steelseriesRival110FirmwareQuery,
  steelseriesRival110SaveCommand,
} from "./rival-110.ts";

test("DPI table is the PMW3326 curve, including 0x49 for 3200", () => {
  const options = steelseriesRival110DpiOptions();
  assert.equal(options[0], RIVAL110_DPI_MIN);
  assert.equal(options.at(-1), RIVAL110_DPI_MAX);
  assert.equal(options.length, (RIVAL110_DPI_MAX - RIVAL110_DPI_MIN) / 100 + 1);
  assert.equal(RIVAL110_DPI_TO_BYTE.get(400), 0x08);
  assert.equal(RIVAL110_DPI_TO_BYTE.get(800), 0x12);
  assert.equal(RIVAL110_DPI_TO_BYTE.get(3200), 0x49);
  assert.equal(RIVAL110_DPI_TO_BYTE.get(7200), 0xa7);
  assert.equal(RIVAL110_DEFAULT_DPI_PRESET_1, 800);
  assert.equal(RIVAL110_DEFAULT_DPI_PRESET_2, 1600);
  assert.equal(RIVAL110_DEFAULT_POLLING_RATE, 1000);
});

test("encodes both sensitivity presets with the PMW3326 byte", () => {
  assert.deepEqual([...steelseriesRival110EncodeSensitivity1(200)], [0x03, 0x01, 0x04]);
  assert.deepEqual([...steelseriesRival110EncodeSensitivity1(800)], [0x03, 0x01, 0x12]);
  assert.deepEqual([...steelseriesRival110EncodeSensitivity2(1600)], [0x03, 0x02, 0x24]);
  assert.deepEqual([...steelseriesRival110EncodeSensitivity2(7200)], [0x03, 0x02, 0xa7]);
  // Off-table values are rejected (no 250 step, unlike the Rival 100 family).
  assert.throws(() => steelseriesRival110EncodeSensitivity1(250), Rival110ProtocolError);
  assert.throws(() => steelseriesRival110EncodeSensitivity2(7300), Rival110ProtocolError);
});

test("encodes polling rates with 1000->0x01 down to 125->0x04", () => {
  assert.deepEqual([...steelseriesRival110EncodePollingRate(1000)], [0x04, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival110EncodePollingRate(500)], [0x04, 0x00, 0x02]);
  assert.deepEqual([...steelseriesRival110EncodePollingRate(250)], [0x04, 0x00, 0x03]);
  assert.deepEqual([...steelseriesRival110EncodePollingRate(125)], [0x04, 0x00, 0x04]);
  assert.deepEqual([...RIVAL110_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesRival110EncodePollingRate(2000), Rival110ProtocolError);
});

test("save, firmware, and active-CPI queries", () => {
  assert.deepEqual([...steelseriesRival110SaveCommand()], [0x09, 0x00]);
  assert.deepEqual([...steelseriesRival110FirmwareQuery()], [0x10, 0x00]);
  assert.deepEqual([...steelseriesRival110ActiveCpiQuery()], [0x16, 0x00]);
  assert.equal(RIVAL110_FIRMWARE_RESPONSE_LENGTH, 2);
  assert.deepEqual(steelseriesRival110DecodeFirmware(new Uint8Array([0x05, 0x02])), {
    bytes: [0x05, 0x02],
    display: "2.5",
  });
  assert.throws(() => steelseriesRival110DecodeFirmware(new Uint8Array([0x05])), Rival110ProtocolError);
  // Active-preset reply: report-id stripped, so the first byte is the level.
  assert.equal(steelseriesRival110DecodeActivePreset(new Uint8Array([0x01, 0x00])), 1);
  assert.equal(steelseriesRival110DecodeActivePreset(new Uint8Array([0x02, 0x00])), 2);
  assert.throws(() => steelseriesRival110DecodeActivePreset(new Uint8Array([0x03])), Rival110ProtocolError);
  assert.throws(() => steelseriesRival110DecodeActivePreset(new Uint8Array([])), Rival110ProtocolError);
});

test("LED color, effect, and button-6 mode", () => {
  assert.deepEqual([...steelseriesRival110EncodeLedColor(0xff, 0x18, 0x00)], [0x05, 0x00, 0xff, 0x18, 0x00]);
  assert.throws(() => steelseriesRival110EncodeLedColor(0, -1, 0), Rival110ProtocolError);
  assert.deepEqual([...steelseriesRival110EncodeLightEffect("steady")], [0x07, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival110EncodeLightEffect("breath")], [0x07, 0x00, 0x03]);
  assert.throws(() => steelseriesRival110EncodeLightEffect("rainbow" as never), Rival110ProtocolError);
  assert.deepEqual([...steelseriesRival110EncodeButton6Mode("dpi")], [0x0b, 0x00]);
  assert.deepEqual([...steelseriesRival110EncodeButton6Mode("os")], [0x0b, 0x01]);
  assert.throws(() => steelseriesRival110EncodeButton6Mode("x" as never), Rival110ProtocolError);
  assert.deepEqual(RIVAL110_BUTTON6_MODE_TO_BYTE, { dpi: 0x00, os: 0x01 });
});
