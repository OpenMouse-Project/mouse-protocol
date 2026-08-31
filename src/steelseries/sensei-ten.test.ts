import assert from "node:assert/strict";
import test from "node:test";

import {
  SENSEI_TEN_DEFAULT_BUTTONS_MAPPING,
  SENSEI_TEN_DPI_MAX,
  SENSEI_TEN_DPI_MIN,
  SENSEI_TEN_MAX_DPI_PRESETS,
  SenseiTenProtocolError,
  steelseriesSenseiTenDecodeFirmware,
  steelseriesSenseiTenDpiOptions,
  steelseriesSenseiTenEncodeButtonsMapping,
  steelseriesSenseiTenEncodeDpiPresets,
  steelseriesSenseiTenEncodeLedColor,
  steelseriesSenseiTenEncodePollingRate,
  steelseriesSenseiTenFirmwareQuery,
  steelseriesSenseiTenSaveCommand,
} from "./sensei-ten.ts";

test("DPI options span the full linear 50-18000 range in 50 DPI steps", () => {
  const options = steelseriesSenseiTenDpiOptions();
  assert.equal(options[0], SENSEI_TEN_DPI_MIN);
  assert.equal(options.at(-1), SENSEI_TEN_DPI_MAX);
  assert.equal(options.length, (SENSEI_TEN_DPI_MAX - SENSEI_TEN_DPI_MIN) / 50 + 1);
});

test("encodes DPI presets byte-for-byte per test_sensei_ten.py's test_set_sensitivity", () => {
  assert.deepEqual([...steelseriesSenseiTenEncodeDpiPresets([200], 0)], [0x55, 0x00, 0x01, 0x01, 0x04, 0x00]);
  assert.deepEqual(
    [...steelseriesSenseiTenEncodeDpiPresets([200, 400], 0)],
    [0x55, 0x00, 0x03, 0x01, 0x04, 0x00, 0x08, 0x00],
  );
  assert.deepEqual(
    [...steelseriesSenseiTenEncodeDpiPresets([200, 400, 800, 18000], 0)],
    [0x55, 0x00, 0x0f, 0x01, 0x04, 0x00, 0x08, 0x00, 0x10, 0x00, 0x68, 0x01],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesSenseiTenEncodeDpiPresets([225], 0), SenseiTenProtocolError);
  assert.throws(() => steelseriesSenseiTenEncodeDpiPresets([25], 0), SenseiTenProtocolError);
  assert.throws(() => steelseriesSenseiTenEncodeDpiPresets([18050], 0), SenseiTenProtocolError);
  assert.throws(() => steelseriesSenseiTenEncodeDpiPresets([], 0), new RegExp(`1–${SENSEI_TEN_MAX_DPI_PRESETS} DPI presets`));
  assert.throws(
    () => steelseriesSenseiTenEncodeDpiPresets([200, 200, 200, 200, 200, 200], 0),
    new RegExp(`1–${SENSEI_TEN_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesSenseiTenEncodeDpiPresets([200, 400], -1), SenseiTenProtocolError);
  assert.throws(() => steelseriesSenseiTenEncodeDpiPresets([200, 400], 2), SenseiTenProtocolError);
});

test("encodes every polling rate byte-for-byte per test_set_polling_rate, rejects unsupported rates", () => {
  assert.deepEqual([...steelseriesSenseiTenEncodePollingRate(1000)], [0x54, 0x00, 0x01]);
  assert.deepEqual([...steelseriesSenseiTenEncodePollingRate(500)], [0x54, 0x00, 0x02]);
  assert.deepEqual([...steelseriesSenseiTenEncodePollingRate(250)], [0x54, 0x00, 0x03]);
  assert.deepEqual([...steelseriesSenseiTenEncodePollingRate(125)], [0x54, 0x00, 0x04]);
  assert.throws(() => steelseriesSenseiTenEncodePollingRate(2000), SenseiTenProtocolError);
});

test("frames the save and firmware commands distinctly from other SteelSeries families", () => {
  assert.deepEqual([...steelseriesSenseiTenSaveCommand()], [0x59, 0x00]);
  assert.deepEqual([...steelseriesSenseiTenFirmwareQuery()], [0x90, 0x00]);
});

test("decodes the two-byte firmware response in read order", () => {
  const firmware = steelseriesSenseiTenDecodeFirmware(new Uint8Array([37, 0]));
  assert.deepEqual(firmware.bytes, [37, 0]);
  assert.equal(firmware.display, "37.0");
  assert.throws(() => steelseriesSenseiTenDecodeFirmware(new Uint8Array([1])), SenseiTenProtocolError);
});

test("encodes the logo color gradient byte-for-byte per test_set_logo_color", () => {
  const report = steelseriesSenseiTenEncodeLedColor(
    "logo",
    [
      { pos: 0, r: 0xff, g: 0x00, b: 0x00 },
      { pos: 33, r: 0x00, g: 0xff, b: 0x00 },
      { pos: 66, r: 0x00, g: 0x00, b: 0xff },
      { pos: 100, r: 0xff, g: 0x00, b: 0x00 },
    ],
    1000,
  );
  const expected = [
    0x5b, 0x00,
    // header (26 bytes): led=0x00, duration=1000 (0xe8,0x03) LE, zeros...
    0x00, 0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // through repeat_offset(17)=0x00
    0x00, 0x00, 0x00, 0x00, // triggers_offset(21)=0x00
    0x00, 0x00, 0x00, 0x04, // color_count_offset(25)=4
    // body: initial color + 4 stops (color + delta-pos, truncated real
    // positions 0/84/168/255 -> deltas 0/84/84/87)
    0xff, 0x00, 0x00,
    0xff, 0x00, 0x00, 0x00,
    0x00, 0xff, 0x00, 0x54,
    0x00, 0x00, 0xff, 0x54,
    0xff, 0x00, 0x00, 0x57,
  ];
  assert.deepEqual([...report], expected);
});

test("encodes the wheel color gradient byte-for-byte per test_set_wheel_color", () => {
  const report = steelseriesSenseiTenEncodeLedColor(
    "wheel",
    [
      { pos: 0, r: 0x11, g: 0x22, b: 0x33 },
      { pos: 25, r: 0x44, g: 0x55, b: 0x66 },
      { pos: 50, r: 0x77, g: 0x88, b: 0x99 },
      { pos: 75, r: 0xaa, g: 0xbb, b: 0xcc },
      { pos: 100, r: 0x11, g: 0x22, b: 0x33 },
    ],
    5000,
  );
  const expected = [
    0x5b, 0x00,
    0x01, 0x88, 0x13, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x05,
    // truncated real positions 0/63/127/191/255 -> deltas 0/63/64/64/64
    0x11, 0x22, 0x33,
    0x11, 0x22, 0x33, 0x00,
    0x44, 0x55, 0x66, 0x3f,
    0x77, 0x88, 0x99, 0x40,
    0xaa, 0xbb, 0xcc, 0x40,
    0x11, 0x22, 0x33, 0x40,
  ];
  assert.deepEqual([...report], expected);
});

test("encodes a single stop as a solid, non-animated color (repeat = 1)", () => {
  const report = steelseriesSenseiTenEncodeLedColor("logo", [{ pos: 0, r: 1, g: 2, b: 3 }]);
  assert.equal(report[2], 0x00); // led id
  assert.equal(report[2 + 17], 0x01); // repeat_offset
  assert.equal(report[2 + 25], 0x01); // color_count_offset
});

test("rejects invalid gradient input", () => {
  assert.throws(() => steelseriesSenseiTenEncodeLedColor("logo", []), SenseiTenProtocolError);
  assert.throws(
    () => steelseriesSenseiTenEncodeLedColor("logo", new Array(15).fill({ pos: 0, r: 0, g: 0, b: 0 })),
    SenseiTenProtocolError,
  );
  assert.throws(() => steelseriesSenseiTenEncodeLedColor("logo", [{ pos: 0, r: 256, g: 0, b: 0 }]), SenseiTenProtocolError);
  assert.throws(() => steelseriesSenseiTenEncodeLedColor("logo", [{ pos: 101, r: 0, g: 0, b: 0 }]), SenseiTenProtocolError);
  assert.throws(() => steelseriesSenseiTenEncodeLedColor("logo", [{ pos: 0, r: 0, g: 0, b: 0 }], -1), SenseiTenProtocolError);
});

test("encodes the button mapping packet at rivalcfg's exact offsets", () => {
  const report = steelseriesSenseiTenEncodeButtonsMapping({
    button1: { type: "button", target: "button2" },
    button6: { type: "dpiSwitch" },
    button7: { type: "scrollUp" },
    button8: { type: "disabled" },
  });
  const expected = new Array(42).fill(0x00);
  expected[0] = 0x31;
  expected[1] = 0x00;
  expected[2 + 0x00] = 0x02; // button1 -> button2's id
  expected[2 + 0x19] = 0x30; // button6 -> dpi switch
  expected[2 + 0x1e] = 0x31; // button7 -> scroll up
  expected[2 + 0x23] = 0x00; // button8 -> disabled (already zero)
  assert.deepEqual([...report], expected);
});

test("encodes keyboard and multimedia button targets as [type byte, code]", () => {
  const report = steelseriesSenseiTenEncodeButtonsMapping({
    button2: { type: "keyboard", code: 0x04 },
    button3: { type: "multimedia", code: 0xcd },
  });
  assert.equal(report[0], 0x31);
  assert.equal(report[1], 0x00);
  assert.equal(report[2 + 0x05], 0x51);
  assert.equal(report[2 + 0x05 + 1], 0x04);
  assert.equal(report[2 + 0x0a], 0x61);
  assert.equal(report[2 + 0x0a + 1], 0xcd);
});

test("encodes the documented default buttons mapping byte-for-byte per test_set_buttons_mapping", () => {
  const report = steelseriesSenseiTenEncodeButtonsMapping(SENSEI_TEN_DEFAULT_BUTTONS_MAPPING);
  const expected = [
    0x31, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x00,
    0x02, 0x00, 0x00, 0x00, 0x00,
    0x03, 0x00, 0x00, 0x00, 0x00,
    0x04, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x00, 0x00, 0x00, 0x00,
    0x51, 0x4e, 0x00, 0x00, 0x00,
    0x51, 0x4b, 0x00, 0x00, 0x00,
    0x30, 0x00, 0x00, 0x00, 0x00,
  ];
  assert.deepEqual([...report], expected);
});

test("rejects unknown buttons and out-of-range codes", () => {
  // @ts-expect-error invalid button name
  assert.throws(() => steelseriesSenseiTenEncodeButtonsMapping({ nope: { type: "disabled" } }), SenseiTenProtocolError);
  assert.throws(
    () => steelseriesSenseiTenEncodeButtonsMapping({ button1: { type: "keyboard", code: 999 } }),
    SenseiTenProtocolError,
  );
});

test("encoders return fresh buffers and never mutate caller input", () => {
  const presets = [200, 400];
  const first = steelseriesSenseiTenEncodeDpiPresets(presets, 0);
  const second = steelseriesSenseiTenEncodeDpiPresets(presets, 0);
  assert.notEqual(first.buffer, second.buffer);
  assert.deepEqual([...first], [...second]);
  assert.deepEqual(presets, [200, 400]);
});
