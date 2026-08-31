import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIME_MINI_WIRELESS_BATTERY_RESPONSE_LENGTH,
  PRIME_MINI_WIRELESS_DPI_MAX,
  PRIME_MINI_WIRELESS_DPI_MIN,
  PRIME_MINI_WIRELESS_MAX_DPI_PRESETS,
  PrimeMiniWirelessProtocolError,
  applyPrimeMiniWirelessFlag,
  steelseriesPrimeMiniWirelessBatteryQuery,
  steelseriesPrimeMiniWirelessDecodeBattery,
  steelseriesPrimeMiniWirelessDpiOptions,
  steelseriesPrimeMiniWirelessEncodeButtonsMapping,
  steelseriesPrimeMiniWirelessEncodeColor,
  steelseriesPrimeMiniWirelessEncodeDefaultLighting,
  steelseriesPrimeMiniWirelessEncodeDimTimer,
  steelseriesPrimeMiniWirelessEncodeDpiPresets,
  steelseriesPrimeMiniWirelessEncodePollingRate,
  steelseriesPrimeMiniWirelessEncodeSleepTimer,
  steelseriesPrimeMiniWirelessSaveCommand,
} from "./prime-mini-wireless.ts";
import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.ts";

test("applyPrimeMiniWirelessFlag ORs 0b01000000 into byte 0 only", () => {
  assert.deepEqual(applyPrimeMiniWirelessFlag([0x2d]), [0x6d]);
  assert.deepEqual(applyPrimeMiniWirelessFlag([0x21, 0x01, 0x00]), [0x61, 0x01, 0x00]);
  assert.deepEqual(applyPrimeMiniWirelessFlag([0x11, 0x00]), [0x51, 0x00]);
  assert.deepEqual(applyPrimeMiniWirelessFlag([0x92]), [0xd2]);
  assert.throws(() => applyPrimeMiniWirelessFlag([]), PrimeMiniWirelessProtocolError);
});

test("DPI options mirror the shared TrueMove Air table", () => {
  const options = steelseriesPrimeMiniWirelessDpiOptions();
  assert.equal(options[0], PRIME_MINI_WIRELESS_DPI_MIN);
  assert.equal(options.at(-1), PRIME_MINI_WIRELESS_DPI_MAX);
  assert.equal(options.length, (PRIME_MINI_WIRELESS_DPI_MAX - PRIME_MINI_WIRELESS_DPI_MIN) / 100 + 1);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(1600), 0x12);
});

test("encodes DPI presets wired vs. 2.4 GHz mode, first_preset 0", () => {
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeDpiPresets([400, 800], 0, false)],
    [0x2d, 0x02, 0x00, 0x04, 0x09],
  );
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeDpiPresets([400, 800], 0, true)],
    [0x6d, 0x02, 0x00, 0x04, 0x09],
  );
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeDpiPresets([400, 800], 1, false)],
    [0x2d, 0x02, 0x01, 0x04, 0x09],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeDpiPresets([150], 0, false), PrimeMiniWirelessProtocolError);
  assert.throws(
    () => steelseriesPrimeMiniWirelessEncodeDpiPresets([], 0, false),
    new RegExp(`1–${PRIME_MINI_WIRELESS_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeDpiPresets([400, 800], -1, false), PrimeMiniWirelessProtocolError);
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeDpiPresets([400, 800], 2, false), PrimeMiniWirelessProtocolError);
});

test("encodes polling rate, wired vs. wireless", () => {
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodePollingRate(1000, false)], [0x2b, 0x00]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodePollingRate(500, false)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodePollingRate(250, false)], [0x2b, 0x02]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodePollingRate(125, false)], [0x2b, 0x03]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodePollingRate(1000, true)], [0x6b, 0x00]);
  assert.throws(() => steelseriesPrimeMiniWirelessEncodePollingRate(2000, false), PrimeMiniWirelessProtocolError);
});

test("encodes LED color as a fixed single-LED packet, wired vs. wireless", () => {
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeColor(255, 0, 0, false)], [0x21, 0x01, 0x00, 255, 0, 0]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeColor(0, 255, 0, true)], [0x61, 0x01, 0x00, 0, 255, 0]);
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeColor(256, 0, 0, false), PrimeMiniWirelessProtocolError);
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeColor(-1, 0, 0, false), PrimeMiniWirelessProtocolError);
});

test("encodes sleep timer as minutes * 60000 ms, little-endian 3 bytes", () => {
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeSleepTimer(0, false)], [0x29, 0x00, 0x00, 0x00]);
  // 5 min * 60000 = 300000 = 0x0493E0
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeSleepTimer(5, false)], [0x29, 0xe0, 0x93, 0x04]);
  // 20 min * 60000 = 1200000 = 0x124F80
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeSleepTimer(20, false)], [0x29, 0x80, 0x4f, 0x12]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeSleepTimer(5, true)], [0x69, 0xe0, 0x93, 0x04]);
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeSleepTimer(21, false), PrimeMiniWirelessProtocolError);
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeSleepTimer(-1, false), PrimeMiniWirelessProtocolError);
});

test("encodes dim timer as seconds * 1000 ms, little-endian 3 bytes", () => {
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeDimTimer(0, false)],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
  // 30 s * 1000 = 30000 = 0x007530
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeDimTimer(30, false)],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x30, 0x75, 0x00],
  );
  // 1200 s * 1000 = 1200000 = 0x124F80
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeDimTimer(1200, false)],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x80, 0x4f, 0x12],
  );
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeDimTimer(30, true)],
    [0x63, 0x0f, 0x01, 0x00, 0x00, 0x30, 0x75, 0x00],
  );
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeDimTimer(1201, false), PrimeMiniWirelessProtocolError);
});

test("encodes default lighting modes, wired vs. wireless", () => {
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeDefaultLighting("off", false)], [0x27, 0x00]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeDefaultLighting("rainbow", true)], [0x67, 0x01]);
  assert.throws(() => steelseriesPrimeMiniWirelessEncodeDefaultLighting("nope" as never, false), PrimeMiniWirelessProtocolError);
});

test("frames the save command, wired 11 00 vs. wireless 51 00", () => {
  assert.deepEqual([...steelseriesPrimeMiniWirelessSaveCommand(false)], [0x11, 0x00]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessSaveCommand(true)], [0x51, 0x00]);
});

test("frames the battery query, wired 92 vs. wireless D2", () => {
  assert.deepEqual([...steelseriesPrimeMiniWirelessBatteryQuery(false)], [0x92]);
  assert.deepEqual([...steelseriesPrimeMiniWirelessBatteryQuery(true)], [0xd2]);
});

test("decodes the two-byte battery response — charging flag and *5-scaled, 1-indexed percentage", () => {
  // data[1] = 0x0B -> not charging, level = (0x0B - 1) * 5 = 50
  const idle = steelseriesPrimeMiniWirelessDecodeBattery(new Uint8Array([0x00, 0x0b]));
  assert.deepEqual(idle, { level: 50, isCharging: false });
  // data[1] = 0x8B -> charging bit set, level = ((0x8B & ~0x80) - 1) * 5 = 50
  const charging = steelseriesPrimeMiniWirelessDecodeBattery(new Uint8Array([0x00, 0x8b]));
  assert.deepEqual(charging, { level: 50, isCharging: true });
  assert.throws(
    () => steelseriesPrimeMiniWirelessDecodeBattery(new Uint8Array([0x00])),
    PrimeMiniWirelessProtocolError,
  );
  assert.equal(PRIME_MINI_WIRELESS_BATTERY_RESPONSE_LENGTH, 2);
});

test("buttons mapping covers 6 buttons + scroll up/down (40-byte packet), wired vs. wireless prefix", () => {
  const zeros = () => new Array(40).fill(0x00);

  const button6 = zeros();
  button6[0x19] = 0x51;
  button6[0x1a] = 0x0a;
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeButtonsMapping({ button6: { type: "keyboard", code: 0x0a } }, false)],
    [0x2a, ...button6],
  );
  assert.deepEqual(
    [...steelseriesPrimeMiniWirelessEncodeButtonsMapping({ button6: { type: "keyboard", code: 0x0a } }, true)],
    [0x6a, ...button6],
  );

  assert.deepEqual([...steelseriesPrimeMiniWirelessEncodeButtonsMapping({}, false)], [0x2a, ...zeros()]);
});

test("rejects unknown buttons and out-of-range codes", () => {
  assert.throws(
    () => steelseriesPrimeMiniWirelessEncodeButtonsMapping({ ["button7" as never]: { type: "disabled" } }, false),
    PrimeMiniWirelessProtocolError,
  );
  assert.throws(
    () => steelseriesPrimeMiniWirelessEncodeButtonsMapping({ button1: { type: "keyboard", code: 999 } }, false),
    PrimeMiniWirelessProtocolError,
  );
});
