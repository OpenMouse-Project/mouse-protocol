import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL3_WIRELESS_V2_BATTERY_RESPONSE_LENGTH,
  RIVAL3_WIRELESS_V2_DEFAULT_DPI_PRESETS,
  RIVAL3_WIRELESS_V2_DEFAULT_POLLING_RATE,
  RIVAL3_WIRELESS_V2_DPI_MAX,
  RIVAL3_WIRELESS_V2_DPI_MIN,
  RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS,
  RIVAL3_WIRELESS_V2_POLLING_RATES,
  Rival3WirelessV2ProtocolError,
  steelseriesRival3WirelessV2BatteryQuery,
  steelseriesRival3WirelessV2DecodeBattery,
  steelseriesRival3WirelessV2DecodeFirmware,
  steelseriesRival3WirelessV2DpiOptions,
  steelseriesRival3WirelessV2EncodeButtonsMapping,
  steelseriesRival3WirelessV2EncodeDpiPresets,
  steelseriesRival3WirelessV2EncodePollingRate,
  steelseriesRival3WirelessV2EncodeWheelMapping,
  steelseriesRival3WirelessV2FirmwareQuery,
  steelseriesRival3WirelessV2SaveCommand,
} from "./rival-3-wireless-v2.ts";
import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.js";

test("DPI options mirror the shared TrueMove Air table", () => {
  const options = steelseriesRival3WirelessV2DpiOptions();
  assert.equal(options[0], RIVAL3_WIRELESS_V2_DPI_MIN);
  assert.equal(options.at(-1), RIVAL3_WIRELESS_V2_DPI_MAX);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(400), 0x04);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(3200), 0x26);
  assert.deepEqual([...RIVAL3_WIRELESS_V2_DEFAULT_DPI_PRESETS], [400, 800, 1600, 2400, 3200]);
  assert.equal(RIVAL3_WIRELESS_V2_DEFAULT_POLLING_RATE, 1000);
  assert.equal(RIVAL3_WIRELESS_V2_MAX_DPI_PRESETS, 5);
});

test("DPI presets write split X/Y arrays with a 1-based index", () => {
  assert.deepEqual(
    [...steelseriesRival3WirelessV2EncodeDpiPresets(
      [
        { x: 400, y: 400 },
        { x: 800, y: 800 },
        { x: 1600, y: 1600 },
        { x: 2400, y: 2400 },
        { x: 3200, y: 3200 },
      ],
      0,
    )],
    [0x2c, 0x05, 0x01, 0x04, 0x09, 0x12, 0x1b, 0x26, 0x04, 0x09, 0x12, 0x1b, 0x26],
  );
  assert.deepEqual(
    [...steelseriesRival3WirelessV2EncodeDpiPresets(
      [
        { x: 800, y: 1600 },
        { x: 800, y: 1600 },
        { x: 800, y: 1600 },
        { x: 800, y: 1600 },
        { x: 800, y: 1600 },
      ],
      4,
    ).slice(0, 4)],
    [0x2c, 0x05, 0x05, 0x09],
  );
});

test("DPI presets require exactly five on-grid pairs and a valid index", () => {
  const pair = { x: 800, y: 800 };
  assert.throws(() => steelseriesRival3WirelessV2EncodeDpiPresets([pair, pair], 0), Rival3WirelessV2ProtocolError);
  assert.throws(
    () => steelseriesRival3WirelessV2EncodeDpiPresets([pair, pair, pair, pair, pair], 5),
    Rival3WirelessV2ProtocolError,
  );
  assert.throws(
    () => steelseriesRival3WirelessV2EncodeDpiPresets([pair, pair, pair, pair, { x: 150, y: 800 }], 0),
    Rival3WirelessV2ProtocolError,
  );
});

test("polling rates use 1000->0x00 down to 125->0x03", () => {
  assert.deepEqual([...steelseriesRival3WirelessV2EncodePollingRate(1000)], [0x17, 0x00]);
  assert.deepEqual([...steelseriesRival3WirelessV2EncodePollingRate(125)], [0x17, 0x03]);
  assert.deepEqual([...RIVAL3_WIRELESS_V2_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesRival3WirelessV2EncodePollingRate(2000), Rival3WirelessV2ProtocolError);
  assert.equal(RIVAL3_WIRELESS_V2_BATTERY_RESPONSE_LENGTH, 2);
});

test("save, battery, and firmware commands", () => {
  assert.deepEqual([...steelseriesRival3WirelessV2SaveCommand()], [0x09]);
  assert.deepEqual([...steelseriesRival3WirelessV2BatteryQuery()], [0xaa, 0x01]);
  assert.deepEqual(steelseriesRival3WirelessV2DecodeBattery(new Uint8Array([0x64, 0x00])), { level: 100 });
  assert.throws(() => steelseriesRival3WirelessV2DecodeBattery(new Uint8Array([0x64])), Rival3WirelessV2ProtocolError);
  assert.deepEqual([...steelseriesRival3WirelessV2FirmwareQuery()], [0x10]);
  assert.deepEqual(steelseriesRival3WirelessV2DecodeFirmware(new Uint8Array([0x01, 0x05])), {
    bytes: [0x01, 0x05],
    display: "1.5",
  });
  assert.throws(() => steelseriesRival3WirelessV2DecodeFirmware(new Uint8Array([0x01])), Rival3WirelessV2ProtocolError);
});

test("button mapping covers seven slots", () => {
  const report = steelseriesRival3WirelessV2EncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button6: { type: "dpiSwitch" },
    button7: { type: "scrollUp" },
  });
  assert.equal(report[0], 0x19);
  assert.equal(report.length, 1 + 7 * 5);
  assert.equal(report[1], 0x01);
  assert.equal(report[1 + 5 * 5], 0x30);
  assert.equal(report[1 + 6 * 5], 0x31);
});

test("wheel mapping covers two slots under its own command", () => {
  const report = steelseriesRival3WirelessV2EncodeWheelMapping({
    scrollUp: { type: "button", target: "scrollUp" },
    scrollDown: { type: "disabled" },
  });
  assert.equal(report[0], 0x1a);
  assert.equal(report.length, 1 + 2 * 5);
  assert.equal(report[1], 0x31);
  assert.equal(report[6], 0x00);
});

test("button mapping rejects unknown buttons and bad codes", () => {
  assert.throws(
    () => steelseriesRival3WirelessV2EncodeButtonsMapping({ ["button8" as never]: { type: "disabled" } }),
    Rival3WirelessV2ProtocolError,
  );
  assert.throws(
    () => steelseriesRival3WirelessV2EncodeWheelMapping({ scrollUp: { type: "multimedia", code: 999 } }),
    Rival3WirelessV2ProtocolError,
  );
});
