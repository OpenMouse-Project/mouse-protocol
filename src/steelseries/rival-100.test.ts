import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL100_DEFAULT_DPI_PRESET_1,
  RIVAL100_DEFAULT_DPI_PRESET_2,
  RIVAL100_DEFAULT_POLLING_RATE,
  RIVAL100_DPI_TO_BYTE,
  RIVAL100_FIRMWARE_RESPONSE_LENGTH,
  RIVAL100_PC_BANG_BUTTON6_PREFIX,
  RIVAL100_POLLING_RATES,
  Rival100ProtocolError,
  steelseriesRival100ActiveCpiQuery,
  steelseriesRival100DecodeFirmware,
  steelseriesRival100DpiOptions,
  steelseriesRival100EncodeButton6Mode,
  steelseriesRival100EncodeLedColor,
  steelseriesRival100EncodeLightEffect,
  steelseriesRival100EncodePollingRate,
  steelseriesRival100EncodeSensitivity1,
  steelseriesRival100EncodeSensitivity2,
  steelseriesRival100FirmwareQuery,
  steelseriesRival100SaveCommand,
} from "./rival-100.ts";

test("DPI options are the eight Rival 100 hardware steps, inverted byte order", () => {
  assert.deepEqual(steelseriesRival100DpiOptions(), [250, 500, 1000, 1250, 1500, 1750, 2000, 4000]);
  assert.equal(RIVAL100_DPI_TO_BYTE.get(250), 0x08);
  assert.equal(RIVAL100_DPI_TO_BYTE.get(1000), 0x06);
  assert.equal(RIVAL100_DPI_TO_BYTE.get(4000), 0x01);
  assert.equal(RIVAL100_DEFAULT_DPI_PRESET_1, 1000);
  assert.equal(RIVAL100_DEFAULT_DPI_PRESET_2, 2000);
  assert.equal(RIVAL100_DEFAULT_POLLING_RATE, 1000);
});

test("encodes both sensitivity presets with the choice byte", () => {
  assert.deepEqual([...steelseriesRival100EncodeSensitivity1(250)], [0x03, 0x01, 0x08]);
  assert.deepEqual([...steelseriesRival100EncodeSensitivity1(1000)], [0x03, 0x01, 0x06]);
  assert.deepEqual([...steelseriesRival100EncodeSensitivity2(2000)], [0x03, 0x02, 0x02]);
  assert.deepEqual([...steelseriesRival100EncodeSensitivity2(4000)], [0x03, 0x02, 0x01]);
  // Off-table values are rejected.
  assert.throws(() => steelseriesRival100EncodeSensitivity1(800), Rival100ProtocolError);
  assert.throws(() => steelseriesRival100EncodeSensitivity2(7200), Rival100ProtocolError);
});

test("encodes polling rates with 1000->0x01 down to 125->0x04", () => {
  assert.deepEqual([...steelseriesRival100EncodePollingRate(1000)], [0x04, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival100EncodePollingRate(500)], [0x04, 0x00, 0x02]);
  assert.deepEqual([...steelseriesRival100EncodePollingRate(250)], [0x04, 0x00, 0x03]);
  assert.deepEqual([...steelseriesRival100EncodePollingRate(125)], [0x04, 0x00, 0x04]);
  assert.deepEqual([...RIVAL100_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesRival100EncodePollingRate(2000), Rival100ProtocolError);
});

test("save, firmware, and active-CPI queries", () => {
  assert.deepEqual([...steelseriesRival100SaveCommand()], [0x09, 0x00]);
  assert.deepEqual([...steelseriesRival100FirmwareQuery()], [0x10, 0x00]);
  assert.deepEqual([...steelseriesRival100ActiveCpiQuery()], [0x16, 0x00]);
  assert.equal(RIVAL100_FIRMWARE_RESPONSE_LENGTH, 2);
  // Incoming struct order is fw_minor then fw_major; display is major.minor.
  assert.deepEqual(steelseriesRival100DecodeFirmware(new Uint8Array([0x03, 0x01])), {
    bytes: [0x03, 0x01],
    display: "1.3",
  });
  assert.throws(() => steelseriesRival100DecodeFirmware(new Uint8Array([0x03])), Rival100ProtocolError);
});

test("LED color sends r/g/b after the command (no brightness byte)", () => {
  assert.deepEqual([...steelseriesRival100EncodeLedColor(255, 0x18, 0x00)], [0x05, 0x00, 0xff, 0x18, 0x00]);
  assert.throws(() => steelseriesRival100EncodeLedColor(256, 0, 0), Rival100ProtocolError);
});

test("light effect and button-6 mode are choice encodings", () => {
  assert.deepEqual([...steelseriesRival100EncodeLightEffect("steady")], [0x07, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival100EncodeLightEffect("breath")], [0x07, 0x00, 0x03]);
  assert.throws(() => steelseriesRival100EncodeLightEffect("pulse" as never), Rival100ProtocolError);
  assert.deepEqual([...steelseriesRival100EncodeButton6Mode("dpi")], [0x0b, 0x00]);
  assert.deepEqual([...steelseriesRival100EncodeButton6Mode("os")], [0x0b, 0x01]);
  assert.throws(() => steelseriesRival100EncodeButton6Mode("wheel" as never), Rival100ProtocolError);
  assert.deepEqual([...RIVAL100_PC_BANG_BUTTON6_PREFIX], [0x00, 0x0e, 0x01]);
});
