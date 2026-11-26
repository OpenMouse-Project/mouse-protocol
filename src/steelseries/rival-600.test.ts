import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL600_DEFAULT_DPI_PRESET_1,
  RIVAL600_DEFAULT_DPI_PRESET_2,
  RIVAL600_DEFAULT_POLLING_RATE,
  RIVAL600_DPI_MAX,
  RIVAL600_DPI_MIN,
  RIVAL600_DPI_PRESET_COUNT,
  RIVAL600_FIRMWARE_RESPONSE_LENGTH,
  RIVAL600_POLLING_RATES,
  Rival600ProtocolError,
  steelseriesRival600DecodeFirmware,
  steelseriesRival600DpiOptions,
  steelseriesRival600EncodeButtonsMapping,
  steelseriesRival600EncodePollingRate,
  steelseriesRival600EncodeProximity,
  steelseriesRival600EncodeSensitivity1,
  steelseriesRival600EncodeSensitivity2,
  steelseriesRival600FirmwareQuery,
  steelseriesRival600LevelQuery,
  steelseriesRival600SaveCommand,
} from "./rival-600.ts";

test("DPI options are the full linear 100..12000 range in 100 DPI steps", () => {
  const options = steelseriesRival600DpiOptions();
  assert.equal(options[0], RIVAL600_DPI_MIN);
  assert.equal(options.at(-1), RIVAL600_DPI_MAX);
  assert.equal(options.length, (RIVAL600_DPI_MAX - RIVAL600_DPI_MIN) / 100 + 1);
  assert.equal(RIVAL600_DPI_PRESET_COUNT, 2);
  assert.equal(RIVAL600_DEFAULT_DPI_PRESET_1, 800);
  assert.equal(RIVAL600_DEFAULT_DPI_PRESET_2, 1600);
  assert.equal(RIVAL600_DEFAULT_POLLING_RATE, 1000);
});

test("encodes both sensitivity presets with the linear byte and 00 42 suffix", () => {
  // byte = (dpi - 100) / 100
  assert.deepEqual([...steelseriesRival600EncodeSensitivity1(100)], [0x03, 0x00, 0x01, 0x00, 0x00, 0x42]);
  assert.deepEqual([...steelseriesRival600EncodeSensitivity1(800)], [0x03, 0x00, 0x01, 0x07, 0x00, 0x42]);
  assert.deepEqual([...steelseriesRival600EncodeSensitivity2(1600)], [0x03, 0x00, 0x02, 0x0f, 0x00, 0x42]);
  assert.deepEqual([...steelseriesRival600EncodeSensitivity1(12000)], [0x03, 0x00, 0x01, 0x77, 0x00, 0x42]);
  assert.throws(() => steelseriesRival600EncodeSensitivity1(150), Rival600ProtocolError);
  assert.throws(() => steelseriesRival600EncodeSensitivity2(12100), Rival600ProtocolError);
});

test("encodes polling rates with 1000->0x01 down to 125->0x04", () => {
  assert.deepEqual([...steelseriesRival600EncodePollingRate(1000)], [0x04, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival600EncodePollingRate(500)], [0x04, 0x00, 0x02]);
  assert.deepEqual([...steelseriesRival600EncodePollingRate(250)], [0x04, 0x00, 0x03]);
  assert.deepEqual([...steelseriesRival600EncodePollingRate(125)], [0x04, 0x00, 0x04]);
  assert.deepEqual([...RIVAL600_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesRival600EncodePollingRate(2000), Rival600ProtocolError);
});

test("save, level, and firmware queries", () => {
  assert.deepEqual([...steelseriesRival600SaveCommand()], [0x09, 0x00]);
  assert.deepEqual([...steelseriesRival600LevelQuery()], [0x81, 0x00]);
  assert.deepEqual([...steelseriesRival600FirmwareQuery()], [0x10, 0x00]);
  assert.equal(RIVAL600_FIRMWARE_RESPONSE_LENGTH, 2);
  // Incoming struct order is fw_minor then fw_major; display is major.minor.
  assert.deepEqual(steelseriesRival600DecodeFirmware(new Uint8Array([0x34, 0x02])), {
    bytes: [0x34, 0x02],
    display: "2.52",
  });
  assert.throws(() => steelseriesRival600DecodeFirmware(new Uint8Array([0x34])), Rival600ProtocolError);
});

test("proximity (lift-off) command carries enable and thresholds", () => {
  assert.deepEqual([...steelseriesRival600EncodeProximity(true, 0x10, 0x80)], [0x96, 0x00, 0x01, 0x10, 0x80]);
  assert.deepEqual([...steelseriesRival600EncodeProximity(false, 0x00, 0xff)], [0x96, 0x00, 0x00, 0x00, 0xff]);
  assert.throws(() => steelseriesRival600EncodeProximity(true, -1, 0), Rival600ProtocolError);
  assert.throws(() => steelseriesRival600EncodeProximity(true, 0, 256), Rival600ProtocolError);
});

test("button mapping is a feature-report 35-byte table with 7 slots", () => {
  const report = steelseriesRival600EncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button6: { type: "disabled" },
    button7: { type: "dpiSwitch" },
  });
  assert.equal(report[0], 0x31);
  assert.equal(report[1], 0x00);
  assert.equal(report.length, 2 + 7 * 5);
  assert.equal(report[2], 0x01);
  assert.equal(report[2 + 5 * 5], 0x00);
  assert.equal(report[2 + 6 * 5], 0x30);
});

test("button mapping rejects unknown slots and bad codes, and button7 target encodes as 0x00", () => {
  assert.throws(
    () => steelseriesRival600EncodeButtonsMapping({ ["button8" as never]: { type: "disabled" } }),
    Rival600ProtocolError,
  );
  // `button7`'s id is 0x00, colliding with the disable byte, which is why it
  // is excluded from the `"button"` target type; forced through at runtime it
  // simply encodes the disable byte (the documented collision).
  const collision = steelseriesRival600EncodeButtonsMapping({
    button1: { type: "button", target: "button7" as never },
  });
  assert.equal(collision[2], 0x00);
  assert.throws(
    () => steelseriesRival600EncodeButtonsMapping({ button1: { type: "keyboard", code: 256 } }),
    Rival600ProtocolError,
  );
});
