import assert from "node:assert/strict";
import test from "node:test";

import {
  AEROX3_WIRELESS_DEFAULT_BUTTONS,
  AEROX3_WIRELESS_DPI_MAX,
  AEROX3_WIRELESS_DPI_MIN,
  Aerox3WirelessProtocolError,
  applyAerox3WirelessFlag,
  steelseriesAerox3WirelessBatteryQuery,
  steelseriesAerox3WirelessDecodeBattery,
  steelseriesAerox3WirelessDpiOptions,
  steelseriesAerox3WirelessEncodeButtonsMapping,
  steelseriesAerox3WirelessEncodeDefaultLighting,
  steelseriesAerox3WirelessEncodeDimTimer,
  steelseriesAerox3WirelessEncodeDpiPresets,
  steelseriesAerox3WirelessEncodePollingRate,
  steelseriesAerox3WirelessEncodeRainbowEffect,
  steelseriesAerox3WirelessEncodeReactiveColor,
  steelseriesAerox3WirelessEncodeSleepTimer,
  steelseriesAerox3WirelessEncodeZoneColor,
  steelseriesAerox3WirelessSaveCommand,
} from "./aerox3-wireless.ts";

test("the wireless flag only touches byte 0", () => {
  assert.deepEqual(applyAerox3WirelessFlag([0x23, 0x0f, 0x01]), [0x63, 0x0f, 0x01]);
  assert.deepEqual(applyAerox3WirelessFlag([0x92]), [0xd2]);
  assert.throws(() => applyAerox3WirelessFlag([]), Aerox3WirelessProtocolError);
});

test("dpi options span the truemove air table", () => {
  const options = steelseriesAerox3WirelessDpiOptions();
  assert.equal(options[0], AEROX3_WIRELESS_DPI_MIN);
  assert.equal(options.at(-1), AEROX3_WIRELESS_DPI_MAX);
});

test("encodes the rivalcfg default dpi presets", () => {
  assert.deepEqual(
    [...steelseriesAerox3WirelessEncodeDpiPresets([400, 800, 1200, 2400, 3200], 0, false)],
    [0x2d, 0x05, 0x00, 0x04, 0x09, 0x0d, 0x1b, 0x26],
  );
  assert.deepEqual([...steelseriesAerox3WirelessEncodeDpiPresets([1600], 0, true)], [0x6d, 0x01, 0x00, 0x12]);
  assert.throws(() => steelseriesAerox3WirelessEncodeDpiPresets([150], 0, false), /100 DPI steps/);
  assert.throws(() => steelseriesAerox3WirelessEncodeDpiPresets([400, 400, 400, 400, 400, 400], 0, false), /1 to 5/);
  assert.throws(() => steelseriesAerox3WirelessEncodeDpiPresets([400], 1, false), Aerox3WirelessProtocolError);
});

test("encodes polling rates", () => {
  assert.deepEqual([...steelseriesAerox3WirelessEncodePollingRate(1000, false)], [0x2b, 0x00]);
  assert.deepEqual([...steelseriesAerox3WirelessEncodePollingRate(125, true)], [0x6b, 0x03]);
  assert.throws(() => steelseriesAerox3WirelessEncodePollingRate(2000, false), Aerox3WirelessProtocolError);
});

test("encodes zone, reactive and rainbow lighting", () => {
  assert.deepEqual([...steelseriesAerox3WirelessEncodeZoneColor(3, { r: 1, g: 2, b: 3 }, false)], [0x21, 0x01, 0x02, 1, 2, 3]);
  assert.deepEqual([...steelseriesAerox3WirelessEncodeZoneColor(1, { r: 255, g: 0, b: 0 }, true)], [0x61, 0x01, 0x00, 255, 0, 0]);
  assert.throws(() => steelseriesAerox3WirelessEncodeZoneColor(4 as never, { r: 0, g: 0, b: 0 }, false), Aerox3WirelessProtocolError);
  assert.throws(() => steelseriesAerox3WirelessEncodeZoneColor(1, { r: 256, g: 0, b: 0 }, false), Aerox3WirelessProtocolError);
  assert.deepEqual([...steelseriesAerox3WirelessEncodeReactiveColor(null, false)], [0x26, 0, 0, 0, 0, 0]);
  assert.deepEqual([...steelseriesAerox3WirelessEncodeReactiveColor({ r: 9, g: 8, b: 7 }, true)], [0x66, 0x01, 0x00, 9, 8, 7]);
  assert.deepEqual([...steelseriesAerox3WirelessEncodeRainbowEffect(false)], [0x22, 0xff]);
  assert.deepEqual([...steelseriesAerox3WirelessEncodeDefaultLighting("reactive-rainbow", false)], [0x27, 0x01, 0x01]);
  assert.throws(() => steelseriesAerox3WirelessEncodeDefaultLighting("toString" as never, false), Aerox3WirelessProtocolError);
});

test("encodes timers as little-endian milliseconds", () => {
  assert.deepEqual([...steelseriesAerox3WirelessEncodeSleepTimer(5, false)], [0x29, 0xe0, 0x93, 0x04]);
  assert.deepEqual([...steelseriesAerox3WirelessEncodeDimTimer(30, true)], [0x63, 0x0f, 0x01, 0x00, 0x00, 0x30, 0x75, 0x00]);
  assert.throws(() => steelseriesAerox3WirelessEncodeSleepTimer(21, false), /0 to 20/);
  assert.throws(() => steelseriesAerox3WirelessEncodeDimTimer(1201, false), /0 to 1200/);
});

test("save and battery commands", () => {
  assert.deepEqual([...steelseriesAerox3WirelessSaveCommand(false)], [0x11, 0x00]);
  assert.deepEqual([...steelseriesAerox3WirelessSaveCommand(true)], [0x51, 0x00]);
  assert.deepEqual([...steelseriesAerox3WirelessBatteryQuery(false)], [0x92]);
  assert.deepEqual([...steelseriesAerox3WirelessBatteryQuery(true)], [0xd2]);
});

test("decodes the battery reply captured from a 1038:183A unit", () => {
  const reply = new Uint8Array(64);
  reply[0] = 0x92;
  reply[1] = 0x95;
  assert.deepEqual(steelseriesAerox3WirelessDecodeBattery(reply), { level: 100, isCharging: true });
  assert.deepEqual(steelseriesAerox3WirelessDecodeBattery(new Uint8Array([0x92, 0x0b])), { level: 50, isCharging: false });
  assert.deepEqual(steelseriesAerox3WirelessDecodeBattery(new Uint8Array([0x92, 0x00])), { level: 0, isCharging: false });
  assert.throws(() => steelseriesAerox3WirelessDecodeBattery(new Uint8Array([0x92])), Aerox3WirelessProtocolError);
});

function defaultButtonsPacket(): number[] {
  const packet = new Array(40).fill(0x00);
  packet[0x00] = 0x01;
  packet[0x05] = 0x02;
  packet[0x0a] = 0x03;
  packet[0x0f] = 0x04;
  packet[0x14] = 0x05;
  packet[0x19] = 0x30;
  packet[0x1e] = 0x31;
  packet[0x23] = 0x32;
  return packet;
}

test("an empty mapping encodes rivalcfg's default 40-byte button packet", () => {
  assert.deepEqual([...steelseriesAerox3WirelessEncodeButtonsMapping({}, false)], [0x2a, ...defaultButtonsPacket()]);
  assert.deepEqual(
    [...steelseriesAerox3WirelessEncodeButtonsMapping(AEROX3_WIRELESS_DEFAULT_BUTTONS, true)],
    [0x6a, ...defaultButtonsPacket()],
  );
});

test("remapping one button keeps the others at their defaults", () => {
  const expected = defaultButtonsPacket();
  expected[0x14] = 0x61;
  expected[0x15] = 0xcd;
  expected[0x19] = 0x51;
  expected[0x1a] = 0x68;
  assert.deepEqual(
    [...steelseriesAerox3WirelessEncodeButtonsMapping({
      button5: { type: "multimedia", code: 0xcd },
      button6: { type: "keyboard", code: 0x68 },
    }, false)],
    [0x2a, ...expected],
  );
});

test("rejects unknown buttons, targets and codes", () => {
  assert.throws(
    () => steelseriesAerox3WirelessEncodeButtonsMapping({ ["button7" as never]: { type: "disabled" } }, false),
    Aerox3WirelessProtocolError,
  );
  assert.throws(
    () => steelseriesAerox3WirelessEncodeButtonsMapping({ button1: { type: "button", target: "button9" as never } }, false),
    Aerox3WirelessProtocolError,
  );
  assert.throws(
    () => steelseriesAerox3WirelessEncodeButtonsMapping({ button1: { type: "keyboard", code: 256 } }, false),
    Aerox3WirelessProtocolError,
  );
});
