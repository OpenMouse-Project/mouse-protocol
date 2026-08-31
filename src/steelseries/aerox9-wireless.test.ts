import assert from "node:assert/strict";
import test from "node:test";

import {
  AEROX9_WIRELESS_BATTERY_RESPONSE_LENGTH,
  AEROX9_WIRELESS_DPI_MAX,
  AEROX9_WIRELESS_DPI_MIN,
  AEROX9_WIRELESS_MAX_DPI_PRESETS,
  Aerox9WirelessProtocolError,
  applyAerox9WirelessFlag,
  steelseriesAerox9WirelessBatteryQuery,
  steelseriesAerox9WirelessDecodeBattery,
  steelseriesAerox9WirelessDpiOptions,
  steelseriesAerox9WirelessEncodeDefaultLighting,
  steelseriesAerox9WirelessEncodeDimTimer,
  steelseriesAerox9WirelessEncodeDpiPresets,
  steelseriesAerox9WirelessEncodePollingRate,
  steelseriesAerox9WirelessEncodeRainbowEffect,
  steelseriesAerox9WirelessEncodeReactiveColor,
  steelseriesAerox9WirelessEncodeSleepTimer,
  steelseriesAerox9WirelessEncodeZoneColor,
  steelseriesAerox9WirelessSaveCommand,
} from "./aerox9-wireless.ts";
import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.ts";

test("applyAerox9WirelessFlag ORs 0b01000000 into byte 0 only", () => {
  assert.deepEqual(applyAerox9WirelessFlag([0x2d]), [0x6d]);
  assert.deepEqual(applyAerox9WirelessFlag([0x21, 0x01]), [0x61, 0x01]);
  assert.deepEqual(applyAerox9WirelessFlag([0x11, 0x00]), [0x51, 0x00]);
  assert.deepEqual(applyAerox9WirelessFlag([0x92]), [0xd2]);
  assert.throws(() => applyAerox9WirelessFlag([]), Aerox9WirelessProtocolError);
});

test("DPI options mirror the shared TrueMove Air table", () => {
  const options = steelseriesAerox9WirelessDpiOptions();
  assert.equal(options[0], AEROX9_WIRELESS_DPI_MIN);
  assert.equal(options.at(-1), AEROX9_WIRELESS_DPI_MAX);
  assert.equal(options.length, (AEROX9_WIRELESS_DPI_MAX - AEROX9_WIRELESS_DPI_MIN) / 100 + 1);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(1600), 0x12);
});

test("encodes DPI presets wired vs. 2.4 GHz mode, first_preset 0", () => {
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeDpiPresets([400, 800], 0, false)],
    [0x2d, 0x02, 0x00, 0x04, 0x09],
  );
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeDpiPresets([400, 800], 0, true)],
    [0x6d, 0x02, 0x00, 0x04, 0x09],
  );
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeDpiPresets([400, 800], 1, false)],
    [0x2d, 0x02, 0x01, 0x04, 0x09],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesAerox9WirelessEncodeDpiPresets([150], 0, false), Aerox9WirelessProtocolError);
  assert.throws(
    () => steelseriesAerox9WirelessEncodeDpiPresets([], 0, false),
    new RegExp(`1–${AEROX9_WIRELESS_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesAerox9WirelessEncodeDpiPresets([400, 800], -1, false), Aerox9WirelessProtocolError);
  assert.throws(() => steelseriesAerox9WirelessEncodeDpiPresets([400, 800], 2, false), Aerox9WirelessProtocolError);
});

test("encodes polling rate, wired vs. wireless", () => {
  assert.deepEqual([...steelseriesAerox9WirelessEncodePollingRate(1000, false)], [0x2b, 0x00]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodePollingRate(500, false)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodePollingRate(250, false)], [0x2b, 0x02]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodePollingRate(125, false)], [0x2b, 0x03]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodePollingRate(1000, true)], [0x6b, 0x00]);
  assert.throws(() => steelseriesAerox9WirelessEncodePollingRate(2000, false), Aerox9WirelessProtocolError);
});

test("encodes zone colors as a fixed 6-byte packet", () => {
  assert.deepEqual([...steelseriesAerox9WirelessEncodeZoneColor(1, 255, 0, 0, false)], [0x21, 0x01, 0x00, 255, 0, 0]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeZoneColor(2, 0, 255, 0, false)], [0x21, 0x01, 0x01, 0, 255, 0]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeZoneColor(3, 0, 0, 255, false)], [0x21, 0x01, 0x02, 0, 0, 255]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeZoneColor(1, 255, 0, 0, true)], [0x61, 0x01, 0x00, 255, 0, 0]);
  assert.throws(() => steelseriesAerox9WirelessEncodeZoneColor(4 as never, 0, 0, 0, false), Aerox9WirelessProtocolError);
  assert.throws(() => steelseriesAerox9WirelessEncodeZoneColor(1, 256, 0, 0, false), Aerox9WirelessProtocolError);
});

test("encodes reactive color on/off, wired vs. wireless", () => {
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeReactiveColor(null, false)],
    [0x26, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeReactiveColor({ r: 1, g: 2, b: 3 }, false)],
    [0x26, 0x01, 0x00, 1, 2, 3],
  );
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeReactiveColor(null, true)],
    [0x66, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
});

test("encodes sleep timer as minutes * 60000 ms, little-endian 3 bytes", () => {
  assert.deepEqual([...steelseriesAerox9WirelessEncodeSleepTimer(0, false)], [0x29, 0x00, 0x00, 0x00]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeSleepTimer(5, false)], [0x29, 0xe0, 0x93, 0x04]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeSleepTimer(20, false)], [0x29, 0x80, 0x4f, 0x12]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeSleepTimer(5, true)], [0x69, 0xe0, 0x93, 0x04]);
  assert.throws(() => steelseriesAerox9WirelessEncodeSleepTimer(21, false), Aerox9WirelessProtocolError);
  assert.throws(() => steelseriesAerox9WirelessEncodeSleepTimer(-1, false), Aerox9WirelessProtocolError);
});

test("encodes dim timer as seconds * 1000 ms, little-endian 3 bytes", () => {
  assert.deepEqual([...steelseriesAerox9WirelessEncodeDimTimer(0, false)], [0x23, 0x0f, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeDimTimer(30, false)],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x30, 0x75, 0x00],
  );
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeDimTimer(1200, false)],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x80, 0x4f, 0x12],
  );
  assert.deepEqual(
    [...steelseriesAerox9WirelessEncodeDimTimer(30, true)],
    [0x63, 0x0f, 0x01, 0x00, 0x00, 0x30, 0x75, 0x00],
  );
  assert.throws(() => steelseriesAerox9WirelessEncodeDimTimer(1201, false), Aerox9WirelessProtocolError);
});

test("rainbow effect is a fixed no-argument enable, wired vs. wireless", () => {
  assert.deepEqual([...steelseriesAerox9WirelessEncodeRainbowEffect(false)], [0x22, 0xff]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeRainbowEffect(true)], [0x62, 0xff]);
});

test("encodes default lighting modes", () => {
  assert.deepEqual([...steelseriesAerox9WirelessEncodeDefaultLighting("off", false)], [0x27, 0x00, 0x00]);
  assert.deepEqual([...steelseriesAerox9WirelessEncodeDefaultLighting("rainbow", true)], [0x67, 0x01, 0x00]);
  assert.throws(() => steelseriesAerox9WirelessEncodeDefaultLighting("nope" as never, false), Aerox9WirelessProtocolError);
});

test("frames the save command, wired 11 00 vs. wireless 51 00", () => {
  assert.deepEqual([...steelseriesAerox9WirelessSaveCommand(false)], [0x11, 0x00]);
  assert.deepEqual([...steelseriesAerox9WirelessSaveCommand(true)], [0x51, 0x00]);
});

test("frames the battery query, wired 92 vs. wireless D2", () => {
  assert.deepEqual([...steelseriesAerox9WirelessBatteryQuery(false)], [0x92]);
  assert.deepEqual([...steelseriesAerox9WirelessBatteryQuery(true)], [0xd2]);
});

test("decodes the two-byte battery response — charging flag and *5-scaled, 1-indexed percentage", () => {
  const idle = steelseriesAerox9WirelessDecodeBattery(new Uint8Array([0x00, 0x0b]));
  assert.deepEqual(idle, { level: 50, isCharging: false });
  const charging = steelseriesAerox9WirelessDecodeBattery(new Uint8Array([0x00, 0x8b]));
  assert.deepEqual(charging, { level: 50, isCharging: true });
  assert.throws(
    () => steelseriesAerox9WirelessDecodeBattery(new Uint8Array([0x00])),
    Aerox9WirelessProtocolError,
  );
  assert.equal(AEROX9_WIRELESS_BATTERY_RESPONSE_LENGTH, 2);
});
