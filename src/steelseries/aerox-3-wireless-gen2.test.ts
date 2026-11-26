import assert from "node:assert/strict";
import test from "node:test";

import {
  AEROX3_WIRELESS_GEN2_BATTERY_RESPONSE_LENGTH,
  AEROX3_WIRELESS_GEN2_DEFAULT_DPI_PRESETS,
  AEROX3_WIRELESS_GEN2_DEFAULT_POLLING_RATE,
  AEROX3_WIRELESS_GEN2_DPI_MAX,
  AEROX3_WIRELESS_GEN2_DPI_MIN,
  AEROX3_WIRELESS_GEN2_MAX_DPI_PRESETS,
  AEROX3_WIRELESS_GEN2_POLLING_RATES,
  Aerox3WirelessGen2ProtocolError,
  applyAerox3WirelessGen2Flag,
  steelseriesAerox3WirelessGen2BatteryQuery,
  steelseriesAerox3WirelessGen2DecodeBattery,
  steelseriesAerox3WirelessGen2DecodeFirmware,
  steelseriesAerox3WirelessGen2DpiOptions,
  steelseriesAerox3WirelessGen2EncodeButtonsMapping,
  steelseriesAerox3WirelessGen2EncodeDpiPresets,
  steelseriesAerox3WirelessGen2EncodePollingRate,
  steelseriesAerox3WirelessGen2EncodePollingRateSingle,
  steelseriesAerox3WirelessGen2FirmwareQuery,
  steelseriesAerox3WirelessGen2SaveCommand,
} from "./aerox-3-wireless-gen2.ts";

test("wireless flag ORs 0x40 into byte 0 only", () => {
  assert.deepEqual(applyAerox3WirelessGen2Flag([0x2d]), [0x6d]);
  assert.deepEqual(applyAerox3WirelessGen2Flag([0x11, 0x00]), [0x51, 0x00]);
  assert.deepEqual(applyAerox3WirelessGen2Flag([0x92]), [0xd2]);
  assert.throws(() => applyAerox3WirelessGen2Flag([]), Aerox3WirelessGen2ProtocolError);
});

test("DPI options run 100..26000 in 100 DPI steps", () => {
  const options = steelseriesAerox3WirelessGen2DpiOptions();
  assert.equal(options[0], AEROX3_WIRELESS_GEN2_DPI_MIN);
  assert.equal(options.at(-1), AEROX3_WIRELESS_GEN2_DPI_MAX);
  assert.equal(options.length, (AEROX3_WIRELESS_GEN2_DPI_MAX - AEROX3_WIRELESS_GEN2_DPI_MIN) / 100 + 1);
  assert.deepEqual([...AEROX3_WIRELESS_GEN2_DEFAULT_DPI_PRESETS], [400, 800, 1600, 2400, 3200]);
  assert.equal(AEROX3_WIRELESS_GEN2_DEFAULT_POLLING_RATE, 1000);
  assert.equal(AEROX3_WIRELESS_GEN2_MAX_DPI_PRESETS, 5);
});

function fivePresets(): [
  { x: number; y: number; liftOffDistance: number },
  { x: number; y: number; liftOffDistance: number },
  { x: number; y: number; liftOffDistance: number },
  { x: number; y: number; liftOffDistance: number },
  { x: number; y: number; liftOffDistance: number },
] {
  const preset = { x: 800, y: 1600, liftOffDistance: 2 };
  return [preset, preset, preset, preset, preset];
}

test("DPI presets encode x/y little-endian plus lift-off, wired vs dongle", () => {
  assert.deepEqual(
    [...steelseriesAerox3WirelessGen2EncodeDpiPresets(fivePresets(), 1, false)],
    [
      0x2d, 0x05, 0x01,
      0x20, 0x03, 0x40, 0x06, 0x02,
      0x20, 0x03, 0x40, 0x06, 0x02,
      0x20, 0x03, 0x40, 0x06, 0x02,
      0x20, 0x03, 0x40, 0x06, 0x02,
      0x20, 0x03, 0x40, 0x06, 0x02,
    ],
  );
  assert.deepEqual(
    [...steelseriesAerox3WirelessGen2EncodeDpiPresets(fivePresets(), 1, true).slice(0, 1)],
    [0x6d],
  );
});

test("DPI presets require exactly five entries, valid values, and a valid index", () => {
  assert.throws(() => steelseriesAerox3WirelessGen2EncodeDpiPresets(fivePresets().slice(0, 4), 0, false), Aerox3WirelessGen2ProtocolError);
  assert.throws(() => steelseriesAerox3WirelessGen2EncodeDpiPresets(fivePresets(), 5, false), Aerox3WirelessGen2ProtocolError);
  const bad = fivePresets();
  bad[0] = { x: 50, y: 1600, liftOffDistance: 0 };
  assert.throws(() => steelseriesAerox3WirelessGen2EncodeDpiPresets(bad, 0, false), Aerox3WirelessGen2ProtocolError);
  const badLod = fivePresets();
  badLod[0] = { x: 800, y: 1600, liftOffDistance: 256 };
  assert.throws(() => steelseriesAerox3WirelessGen2EncodeDpiPresets(badLod, 0, false), Aerox3WirelessGen2ProtocolError);
});

test("polling rates cover 125..4000 with split wired/wireless bytes", () => {
  assert.deepEqual([...steelseriesAerox3WirelessGen2EncodePollingRate(4000, 1000, false)], [0x2b, 0x00, 0x02]);
  assert.deepEqual([...steelseriesAerox3WirelessGen2EncodePollingRate(4000, 1000, true)], [0x6b, 0x00, 0x02]);
  assert.deepEqual([...steelseriesAerox3WirelessGen2EncodePollingRate(125, 125, false)], [0x2b, 0x05, 0x05]);
  assert.deepEqual([...AEROX3_WIRELESS_GEN2_POLLING_RATES], [125, 250, 500, 1000, 2000, 4000]);
  assert.throws(() => steelseriesAerox3WirelessGen2EncodePollingRate(8000, 1000, false), Aerox3WirelessGen2ProtocolError);
  assert.throws(() => steelseriesAerox3WirelessGen2EncodePollingRate(1000, 2000, false), Aerox3WirelessGen2ProtocolError);
});

test("single-rate polling caps wired at 1000 Hz", () => {
  assert.deepEqual([...steelseriesAerox3WirelessGen2EncodePollingRateSingle(4000, false)], [0x2b, 0x00, 0x02]);
  assert.deepEqual([...steelseriesAerox3WirelessGen2EncodePollingRateSingle(250, false)], [0x2b, 0x04, 0x04]);
});

test("save, battery, and firmware commands", () => {
  assert.deepEqual([...steelseriesAerox3WirelessGen2SaveCommand(false)], [0x11, 0x00]);
  assert.deepEqual([...steelseriesAerox3WirelessGen2SaveCommand(true)], [0x51, 0x00]);
  assert.deepEqual([...steelseriesAerox3WirelessGen2BatteryQuery(false)], [0x92]);
  assert.deepEqual([...steelseriesAerox3WirelessGen2BatteryQuery(true)], [0xd2]);
  assert.deepEqual(steelseriesAerox3WirelessGen2DecodeBattery(new Uint8Array([0x01, 0x64])), { level: 100, status: 1 });
  assert.throws(() => steelseriesAerox3WirelessGen2DecodeBattery(new Uint8Array([0x01])), Aerox3WirelessGen2ProtocolError);
  assert.deepEqual([...steelseriesAerox3WirelessGen2FirmwareQuery(false)], [0x90, 0x00]);
  assert.equal(AEROX3_WIRELESS_GEN2_BATTERY_RESPONSE_LENGTH, 2);
  const fw = new Uint8Array([0x31, 0x2e, 0x31, 0x2e, 0x35, ...new Array(7).fill(0x00)]);
  assert.equal(steelseriesAerox3WirelessGen2DecodeFirmware(fw), "1.1.5");
  assert.throws(() => steelseriesAerox3WirelessGen2DecodeFirmware(new Uint8Array(11)), Aerox3WirelessGen2ProtocolError);
});

test("button mapping encodes eight slots", () => {
  const report = steelseriesAerox3WirelessGen2EncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button6: { type: "dpiSwitch" },
  }, false);
  assert.equal(report[0], 0x2a);
  assert.equal(report.length, 1 + 8 * 5);
  assert.equal(report[1], 0x01);
  assert.equal(report[1 + 5 * 5], 0x30);
  assert.deepEqual(
    [...steelseriesAerox3WirelessGen2EncodeButtonsMapping({ button1: { type: "button", target: "button1" } }, true).slice(0, 1)],
    [0x6a],
  );
});

test("button mapping rejects unknown buttons and bad codes", () => {
  assert.throws(
    () => steelseriesAerox3WirelessGen2EncodeButtonsMapping({ ["button9" as never]: { type: "disabled" } }, false),
    Aerox3WirelessGen2ProtocolError,
  );
  assert.throws(
    () => steelseriesAerox3WirelessGen2EncodeButtonsMapping({ button1: { type: "keyboard", code: 256 } }, false),
    Aerox3WirelessGen2ProtocolError,
  );
});
