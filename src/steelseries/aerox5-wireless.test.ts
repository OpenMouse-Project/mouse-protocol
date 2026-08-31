import assert from "node:assert/strict";
import test from "node:test";

import {
  AEROX5_WIRELESS_BATTERY_RESPONSE_LENGTH,
  AEROX5_WIRELESS_DPI_MAX,
  AEROX5_WIRELESS_DPI_MIN,
  AEROX5_WIRELESS_MAX_DPI_PRESETS,
  Aerox5WirelessProtocolError,
  applyWirelessFlag,
  steelseriesAerox5WirelessBatteryQuery,
  steelseriesAerox5WirelessDecodeBattery,
  steelseriesAerox5WirelessDpiOptions,
  steelseriesAerox5WirelessEncodeButtonsMapping,
  steelseriesAerox5WirelessEncodeDefaultLighting,
  steelseriesAerox5WirelessEncodeDimTimer,
  steelseriesAerox5WirelessEncodeDpiPresets,
  steelseriesAerox5WirelessEncodePollingRate,
  steelseriesAerox5WirelessEncodeRainbowEffect,
  steelseriesAerox5WirelessEncodeReactiveColor,
  steelseriesAerox5WirelessEncodeSleepTimer,
  steelseriesAerox5WirelessEncodeZoneColor,
  steelseriesAerox5WirelessSaveCommand,
} from "./aerox5-wireless.ts";
import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.ts";

test("applyWirelessFlag ORs 0b01000000 into byte 0 only", () => {
  assert.deepEqual(applyWirelessFlag([0x2d]), [0x6d]);
  assert.deepEqual(applyWirelessFlag([0x21, 0x01]), [0x61, 0x01]);
  assert.deepEqual(applyWirelessFlag([0x11, 0x00]), [0x51, 0x00]);
  assert.deepEqual(applyWirelessFlag([0x92]), [0xd2]);
  assert.throws(() => applyWirelessFlag([]), Aerox5WirelessProtocolError);
});

test("DPI options mirror the shared TrueMove Air table", () => {
  const options = steelseriesAerox5WirelessDpiOptions();
  assert.equal(options[0], AEROX5_WIRELESS_DPI_MIN);
  assert.equal(options.at(-1), AEROX5_WIRELESS_DPI_MAX);
  assert.equal(options.length, (AEROX5_WIRELESS_DPI_MAX - AEROX5_WIRELESS_DPI_MIN) / 100 + 1);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(1600), 0x12);
});

test("encodes DPI presets wired vs. 2.4 GHz mode, first_preset 0", () => {
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeDpiPresets([400, 800], 0, false)],
    [0x2d, 0x02, 0x00, 0x04, 0x09],
  );
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeDpiPresets([400, 800], 0, true)],
    [0x6d, 0x02, 0x00, 0x04, 0x09],
  );
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeDpiPresets([400, 800], 1, false)],
    [0x2d, 0x02, 0x01, 0x04, 0x09],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesAerox5WirelessEncodeDpiPresets([150], 0, false), Aerox5WirelessProtocolError);
  assert.throws(
    () => steelseriesAerox5WirelessEncodeDpiPresets([], 0, false),
    new RegExp(`1–${AEROX5_WIRELESS_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesAerox5WirelessEncodeDpiPresets([400, 800], -1, false), Aerox5WirelessProtocolError);
  assert.throws(() => steelseriesAerox5WirelessEncodeDpiPresets([400, 800], 2, false), Aerox5WirelessProtocolError);
});

test("encodes polling rate with a different byte mapping than the plain Aerox 5, wired vs. wireless", () => {
  assert.deepEqual([...steelseriesAerox5WirelessEncodePollingRate(1000, false)], [0x2b, 0x00]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodePollingRate(500, false)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodePollingRate(250, false)], [0x2b, 0x02]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodePollingRate(125, false)], [0x2b, 0x03]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodePollingRate(1000, true)], [0x6b, 0x00]);
  assert.throws(() => steelseriesAerox5WirelessEncodePollingRate(2000, false), Aerox5WirelessProtocolError);
});

test("encodes zone colors as a fixed 6-byte packet, not the plain Aerox 5's bitmask shape", () => {
  assert.deepEqual([...steelseriesAerox5WirelessEncodeZoneColor(1, 255, 0, 0, false)], [0x21, 0x01, 0x00, 255, 0, 0]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodeZoneColor(2, 0, 255, 0, false)], [0x21, 0x01, 0x01, 0, 255, 0]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodeZoneColor(3, 0, 0, 255, false)], [0x21, 0x01, 0x02, 0, 0, 255]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodeZoneColor(1, 255, 0, 0, true)], [0x61, 0x01, 0x00, 255, 0, 0]);
  assert.throws(() => steelseriesAerox5WirelessEncodeZoneColor(4 as never, 0, 0, 0, false), Aerox5WirelessProtocolError);
  assert.throws(() => steelseriesAerox5WirelessEncodeZoneColor(1, 256, 0, 0, false), Aerox5WirelessProtocolError);
});

test("encodes reactive color on/off, wired vs. wireless", () => {
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeReactiveColor(null, false)],
    [0x26, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeReactiveColor({ r: 1, g: 2, b: 3 }, false)],
    [0x26, 0x01, 0x00, 1, 2, 3],
  );
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeReactiveColor(null, true)],
    [0x66, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
});

test("encodes sleep timer as minutes * 60000 ms, little-endian 3 bytes", () => {
  assert.deepEqual([...steelseriesAerox5WirelessEncodeSleepTimer(0, false)], [0x29, 0x00, 0x00, 0x00]);
  // 5 min * 60000 = 300000 = 0x0493E0
  assert.deepEqual([...steelseriesAerox5WirelessEncodeSleepTimer(5, false)], [0x29, 0xe0, 0x93, 0x04]);
  // 20 min * 60000 = 1200000 = 0x124F80
  assert.deepEqual([...steelseriesAerox5WirelessEncodeSleepTimer(20, false)], [0x29, 0x80, 0x4f, 0x12]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodeSleepTimer(5, true)], [0x69, 0xe0, 0x93, 0x04]);
  assert.throws(() => steelseriesAerox5WirelessEncodeSleepTimer(21, false), Aerox5WirelessProtocolError);
  assert.throws(() => steelseriesAerox5WirelessEncodeSleepTimer(-1, false), Aerox5WirelessProtocolError);
});

test("encodes dim timer as seconds * 1000 ms, little-endian 3 bytes", () => {
  assert.deepEqual([...steelseriesAerox5WirelessEncodeDimTimer(0, false)], [0x23, 0x0f, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
  // 30 s * 1000 = 30000 = 0x007530
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeDimTimer(30, false)],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x30, 0x75, 0x00],
  );
  // 1200 s * 1000 = 1200000 = 0x124F80
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeDimTimer(1200, false)],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x80, 0x4f, 0x12],
  );
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeDimTimer(30, true)],
    [0x63, 0x0f, 0x01, 0x00, 0x00, 0x30, 0x75, 0x00],
  );
  assert.throws(() => steelseriesAerox5WirelessEncodeDimTimer(1201, false), Aerox5WirelessProtocolError);
});

test("rainbow effect is a fixed no-argument enable, wired vs. wireless", () => {
  assert.deepEqual([...steelseriesAerox5WirelessEncodeRainbowEffect(false)], [0x22, 0xff]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodeRainbowEffect(true)], [0x62, 0xff]);
});

test("encodes default lighting modes, identical table to the plain Aerox 5", () => {
  assert.deepEqual([...steelseriesAerox5WirelessEncodeDefaultLighting("off", false)], [0x27, 0x00, 0x00]);
  assert.deepEqual([...steelseriesAerox5WirelessEncodeDefaultLighting("rainbow", true)], [0x67, 0x01, 0x00]);
  assert.throws(() => steelseriesAerox5WirelessEncodeDefaultLighting("nope" as never, false), Aerox5WirelessProtocolError);
});

test("frames the save command, wired 11 00 vs. wireless 51 00", () => {
  assert.deepEqual([...steelseriesAerox5WirelessSaveCommand(false)], [0x11, 0x00]);
  assert.deepEqual([...steelseriesAerox5WirelessSaveCommand(true)], [0x51, 0x00]);
});

test("frames the battery query, wired 92 vs. wireless D2", () => {
  assert.deepEqual([...steelseriesAerox5WirelessBatteryQuery(false)], [0x92]);
  assert.deepEqual([...steelseriesAerox5WirelessBatteryQuery(true)], [0xd2]);
});

test("decodes the two-byte battery response — charging flag and *5-scaled, 1-indexed percentage", () => {
  // data[1] = 0x0B -> not charging, level = (0x0B - 1) * 5 = 50
  const idle = steelseriesAerox5WirelessDecodeBattery(new Uint8Array([0x00, 0x0b]));
  assert.deepEqual(idle, { level: 50, isCharging: false });
  // data[1] = 0x8B -> charging bit set, level = ((0x8B & ~0x80) - 1) * 5 = 50
  const charging = steelseriesAerox5WirelessDecodeBattery(new Uint8Array([0x00, 0x8b]));
  assert.deepEqual(charging, { level: 50, isCharging: true });
  assert.throws(
    () => steelseriesAerox5WirelessDecodeBattery(new Uint8Array([0x00])),
    Aerox5WirelessProtocolError,
  );
  assert.equal(AEROX5_WIRELESS_BATTERY_RESPONSE_LENGTH, 2);
});

test("buttons mapping covers 9 buttons + scroll up/down (55-byte packet), wired vs. wireless prefix", () => {
  const zeros = () => new Array(55).fill(0x00);

  const button9 = zeros();
  button9[0x28] = 0x51;
  button9[0x29] = 0x0a;
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeButtonsMapping({ button9: { type: "keyboard", code: 0x0a } }, false)],
    [0x2a, ...button9],
  );
  assert.deepEqual(
    [...steelseriesAerox5WirelessEncodeButtonsMapping({ button9: { type: "keyboard", code: 0x0a } }, true)],
    [0x6a, ...button9],
  );

  assert.deepEqual([...steelseriesAerox5WirelessEncodeButtonsMapping({}, false)], [0x2a, ...zeros()]);
});

test("rejects unknown buttons and out-of-range codes", () => {
  assert.throws(
    () => steelseriesAerox5WirelessEncodeButtonsMapping({ ["button10" as never]: { type: "disabled" } }, false),
    Aerox5WirelessProtocolError,
  );
  assert.throws(
    () => steelseriesAerox5WirelessEncodeButtonsMapping({ button1: { type: "keyboard", code: 999 } }, false),
    Aerox5WirelessProtocolError,
  );
});
