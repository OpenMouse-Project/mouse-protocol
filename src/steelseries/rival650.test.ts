import assert from "node:assert/strict";
import test from "node:test";

import {
  Rival650ProtocolError,
  RIVAL650_DPI_MAX,
  RIVAL650_DPI_MIN,
  steelseriesRival650BatteryQuery,
  steelseriesRival650DecodeBattery,
  steelseriesRival650DpiOptions,
  steelseriesRival650EncodeButtonsMapping,
  steelseriesRival650EncodeLiftOffDistance,
  steelseriesRival650EncodePollingRate,
  steelseriesRival650EncodeSensitivity1,
  steelseriesRival650EncodeSensitivity2,
  steelseriesRival650EncodeSleepTimer,
  steelseriesRival650SaveCommand,
} from "./rival650.ts";

test("DPI options span 100..12000 in 100 DPI steps", () => {
  const options = steelseriesRival650DpiOptions();
  assert.equal(options.length, 120);
  assert.equal(options[0], RIVAL650_DPI_MIN);
  assert.equal(options.at(-1), RIVAL650_DPI_MAX);
});

test("sensitivity1/sensitivity2 encode as command prefix + linear byte", () => {
  // (dpi - 100) / 100
  assert.deepEqual(steelseriesRival650EncodeSensitivity1(100), new Uint8Array([0x15, 0x01, 0x00]));
  assert.deepEqual(steelseriesRival650EncodeSensitivity1(800), new Uint8Array([0x15, 0x01, 0x07]));
  assert.deepEqual(steelseriesRival650EncodeSensitivity1(12000), new Uint8Array([0x15, 0x01, 0x77]));
  assert.deepEqual(steelseriesRival650EncodeSensitivity2(1600), new Uint8Array([0x15, 0x02, 0x0f]));
});

test("sensitivity rejects out-of-range or off-step DPI", () => {
  assert.throws(() => steelseriesRival650EncodeSensitivity1(99), Rival650ProtocolError);
  assert.throws(() => steelseriesRival650EncodeSensitivity1(12100), Rival650ProtocolError);
  assert.throws(() => steelseriesRival650EncodeSensitivity1(150), /100 DPI steps/);
});

test("polling rate uses the Rival 650's own byte mapping (not Rival 3 Wireless's)", () => {
  assert.deepEqual(steelseriesRival650EncodePollingRate(1000), new Uint8Array([0x17, 0x01]));
  assert.deepEqual(steelseriesRival650EncodePollingRate(500), new Uint8Array([0x17, 0x02]));
  assert.deepEqual(steelseriesRival650EncodePollingRate(250), new Uint8Array([0x17, 0x03]));
  assert.deepEqual(steelseriesRival650EncodePollingRate(125), new Uint8Array([0x17, 0x04]));
  assert.throws(() => steelseriesRival650EncodePollingRate(2000), /125, 250, 500, or 1000 Hz/);
});

test("lift-off distance encodes the exact per-step output_choices value, little-endian", () => {
  assert.deepEqual(steelseriesRival650EncodeLiftOffDistance(1), new Uint8Array([0x20, 0x01, 0x74, 0x78]));
  assert.deepEqual(steelseriesRival650EncodeLiftOffDistance(8), new Uint8Array([0x20, 0x01, 0x51, 0x55]));
  assert.throws(() => steelseriesRival650EncodeLiftOffDistance(0), Rival650ProtocolError);
  assert.throws(() => steelseriesRival650EncodeLiftOffDistance(9), Rival650ProtocolError);
  assert.throws(() => steelseriesRival650EncodeLiftOffDistance(1.5), Rival650ProtocolError);
});

test("sleep timer encodes minutes * 60 seconds, little-endian 2 bytes", () => {
  // 1 min -> 60s = 0x003C
  assert.deepEqual(
    steelseriesRival650EncodeSleepTimer(1),
    new Uint8Array([0x2b, 0x01, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00]),
  );
  // 20 min -> 1200s = 0x04B0
  assert.deepEqual(
    steelseriesRival650EncodeSleepTimer(20),
    new Uint8Array([0x2b, 0x01, 0x01, 0x00, 0x00, 0x00, 0xb0, 0x04]),
  );
  assert.throws(() => steelseriesRival650EncodeSleepTimer(0), /1–20 minutes/);
  assert.throws(() => steelseriesRival650EncodeSleepTimer(21), /1–20 minutes/);
});

test("save command is a single byte, distinct from Rival 3 Gen 1's two-byte save", () => {
  assert.deepEqual(steelseriesRival650SaveCommand(), new Uint8Array([0x09]));
});

test("battery query and decode match rivalcfg's battery_level lambdas", () => {
  assert.deepEqual(steelseriesRival650BatteryQuery(), new Uint8Array([0xaa, 0x01]));
  const discharging = steelseriesRival650DecodeBattery(new Uint8Array([72, 0x00, 0x00]));
  assert.deepEqual(discharging, { level: 72, isCharging: false });
  const charging = steelseriesRival650DecodeBattery(new Uint8Array([55, 0x00, 0x01]));
  assert.deepEqual(charging, { level: 55, isCharging: true });
  assert.throws(() => steelseriesRival650DecodeBattery(new Uint8Array([1, 2])), /shorter than three bytes/);
});

test("buttons mapping writes a 35-byte zero-filled packet with only mapped offsets set", () => {
  const encoded = steelseriesRival650EncodeButtonsMapping({ button6: { type: "dpiSwitch" } });
  const expected = new Array(35).fill(0x00);
  expected[0x19] = 0x30;
  assert.deepEqual(encoded, new Uint8Array([0x19, ...expected]));
});

test("buttons mapping supports remapping to another button, disable, scroll targets, keyboard, and multimedia", () => {
  const encoded = steelseriesRival650EncodeButtonsMapping({
    button1: { type: "button", target: "button2" },
    button2: { type: "disabled" },
    button3: { type: "scrollUp" },
    button4: { type: "scrollDown" },
    button5: { type: "keyboard", code: 0x04 },
    button6: { type: "multimedia", code: 0xcd },
  });
  const expected = new Array(35).fill(0x00);
  expected[0x00] = 0x02; // button1 -> button2's id
  expected[0x05] = 0x00; // disabled
  expected[0x0a] = 0x31; // scrollUp
  expected[0x0f] = 0x32; // scrollDown
  expected[0x14] = 0x51; // keyboard
  expected[0x15] = 0x04;
  expected[0x19] = 0x61; // multimedia
  expected[0x1a] = 0xcd;
  assert.deepEqual(encoded, new Uint8Array([0x19, ...expected]));
});

test("button7 is excluded from valid remap targets at the type level; unknown button names are rejected at runtime", () => {
  assert.throws(
    () =>
      steelseriesRival650EncodeButtonsMapping({
        // @ts-expect-error deliberately invalid button name
        button99: { type: "disabled" },
      }),
    /Unknown SteelSeries Rival 650 Wireless button "button99"/,
  );
});

test("button7 itself is a valid remap source and can be assigned any action", () => {
  const encoded = steelseriesRival650EncodeButtonsMapping({ button7: { type: "disabled" } });
  const expected = new Array(35).fill(0x00);
  expected[0x1e] = 0x00;
  assert.deepEqual(encoded, new Uint8Array([0x19, ...expected]));
});

test("keyboard/multimedia codes outside 0-255 are rejected", () => {
  assert.throws(
    () => steelseriesRival650EncodeButtonsMapping({ button1: { type: "keyboard", code: 300 } }),
    /Keyboard scan codes/,
  );
  assert.throws(
    () => steelseriesRival650EncodeButtonsMapping({ button1: { type: "multimedia", code: -1 } }),
    /Multimedia key codes/,
  );
});
