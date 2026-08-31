import assert from "node:assert/strict";
import test from "node:test";

import {
  AEROX3_DPI_MAX,
  AEROX3_DPI_MIN,
  AEROX3_MAX_DPI_PRESETS,
  AEROX3_SAVE_COMMAND,
  Aerox3ProtocolError,
  steelseriesAerox3DpiOptions,
  steelseriesAerox3EncodeButtonsMapping,
  steelseriesAerox3EncodeDefaultLighting,
  steelseriesAerox3EncodeDpiPresets,
  steelseriesAerox3EncodeLedBrightness,
  steelseriesAerox3EncodePollingRate,
  steelseriesAerox3EncodeRainbowEffect,
  steelseriesAerox3EncodeReactiveColor,
  steelseriesAerox3EncodeZoneColor,
  steelseriesAerox3SaveCommand,
} from "./aerox3.ts";

test("DPI options mirror the shared TrueMove Core table", () => {
  const options = steelseriesAerox3DpiOptions();
  assert.equal(options[0], AEROX3_DPI_MIN);
  assert.equal(options.at(-1), AEROX3_DPI_MAX);
  assert.equal(options.length, (AEROX3_DPI_MAX - AEROX3_DPI_MIN) / 100 + 1);
});

test("encodes rivalcfg's default two-preset configuration byte for byte", () => {
  // rivalcfg default `sensitivity: "800, 1600"`, first preset selected. Same
  // DPI bytes as Rival 3 Gen 1 (shared TrueMove Core table) but a one-byte
  // `0x2D` command prefix instead of `0x0B 0x00`.
  assert.deepEqual([...steelseriesAerox3EncodeDpiPresets([800, 1600], 0)], [0x2d, 0x02, 0x01, 0x12, 0x24]);
  assert.deepEqual([...steelseriesAerox3EncodeDpiPresets([800], 0)], [0x2d, 0x01, 0x01, 0x12]);
  assert.deepEqual(
    [...steelseriesAerox3EncodeDpiPresets([200, 400, 800, 1600, 8500], 4)],
    [0x2d, 0x05, 0x05, 0x04, 0x08, 0x12, 0x24, 0xc5],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesAerox3EncodeDpiPresets([850], 0), Aerox3ProtocolError);
  assert.throws(() => steelseriesAerox3EncodeDpiPresets([], 0), new RegExp(`1–${AEROX3_MAX_DPI_PRESETS} DPI presets`));
  assert.throws(
    () => steelseriesAerox3EncodeDpiPresets([800, 800, 800, 800, 800, 800], 0),
    new RegExp(`1–${AEROX3_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesAerox3EncodeDpiPresets([800, 1600], -1), Aerox3ProtocolError);
  assert.throws(() => steelseriesAerox3EncodeDpiPresets([800, 1600], 2), Aerox3ProtocolError);
});

test("encodes every polling rate and rejects rates the mouse does not offer", () => {
  assert.deepEqual([...steelseriesAerox3EncodePollingRate(1000)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesAerox3EncodePollingRate(500)], [0x2b, 0x02]);
  assert.deepEqual([...steelseriesAerox3EncodePollingRate(250)], [0x2b, 0x03]);
  assert.deepEqual([...steelseriesAerox3EncodePollingRate(125)], [0x2b, 0x04]);
  assert.throws(() => steelseriesAerox3EncodePollingRate(2000), Aerox3ProtocolError);
});

test("frames the save command distinctly from Rival 3 Gen 1's", () => {
  assert.deepEqual([...steelseriesAerox3SaveCommand()], [0x11, 0x00]);
  assert.deepEqual([...AEROX3_SAVE_COMMAND], [0x11, 0x00]);
});

test("encodes each RGB zone with the escalating zero-padding rivalcfg's aerox3.py commands imply", () => {
  assert.deepEqual([...steelseriesAerox3EncodeZoneColor(1, 0xff, 0x00, 0x00)], [0x21, 0x01, 0xff, 0x00, 0x00]);
  assert.deepEqual(
    [...steelseriesAerox3EncodeZoneColor(2, 0x00, 0xff, 0x00)],
    [0x21, 0x02, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00],
  );
  assert.deepEqual(
    [...steelseriesAerox3EncodeZoneColor(3, 0x00, 0x00, 0xff)],
    [0x21, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff],
  );
  // @ts-expect-error invalid zone
  assert.throws(() => steelseriesAerox3EncodeZoneColor(4, 0, 0, 0), Aerox3ProtocolError);
  assert.throws(() => steelseriesAerox3EncodeZoneColor(1, 256, 0, 0), Aerox3ProtocolError);
  assert.throws(() => steelseriesAerox3EncodeZoneColor(1, -1, 0, 0), Aerox3ProtocolError);
});

test("encodes reactive color on/off exactly per reactive_rgbcolor.py", () => {
  assert.deepEqual([...steelseriesAerox3EncodeReactiveColor(null)], [0x26, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(
    [...steelseriesAerox3EncodeReactiveColor({ r: 1, g: 2, b: 3 })],
    [0x26, 0x01, 0x00, 1, 2, 3],
  );
});

test("encodes LED brightness as a linear 0-100 passthrough", () => {
  assert.deepEqual([...steelseriesAerox3EncodeLedBrightness(0)], [0x23, 0x00]);
  assert.deepEqual([...steelseriesAerox3EncodeLedBrightness(100)], [0x23, 0x64]);
  assert.throws(() => steelseriesAerox3EncodeLedBrightness(101), Aerox3ProtocolError);
  assert.throws(() => steelseriesAerox3EncodeLedBrightness(-1), Aerox3ProtocolError);
  assert.throws(() => steelseriesAerox3EncodeLedBrightness(1.5), Aerox3ProtocolError);
});

test("encodes rainbow effect zone bitmasks", () => {
  assert.deepEqual([...steelseriesAerox3EncodeRainbowEffect("all")], [0x22, 0b111]);
  assert.deepEqual([...steelseriesAerox3EncodeRainbowEffect("bottom")], [0x22, 0b100]);
  assert.deepEqual([...steelseriesAerox3EncodeRainbowEffect("middle")], [0x22, 0b010]);
  assert.deepEqual([...steelseriesAerox3EncodeRainbowEffect("top")], [0x22, 0b001]);
  assert.deepEqual([...steelseriesAerox3EncodeRainbowEffect("bottom-middle")], [0x22, 0b110]);
  assert.deepEqual([...steelseriesAerox3EncodeRainbowEffect("middle-top")], [0x22, 0b011]);
  assert.deepEqual([...steelseriesAerox3EncodeRainbowEffect("bottom-top")], [0x22, 0b101]);
  // @ts-expect-error invalid zone name
  assert.throws(() => steelseriesAerox3EncodeRainbowEffect("nope"), Aerox3ProtocolError);
});

test("encodes default lighting modes", () => {
  assert.deepEqual([...steelseriesAerox3EncodeDefaultLighting("off")], [0x27, 0x00, 0x00]);
  assert.deepEqual([...steelseriesAerox3EncodeDefaultLighting("reactive")], [0x27, 0x00, 0x01]);
  assert.deepEqual([...steelseriesAerox3EncodeDefaultLighting("rainbow")], [0x27, 0x01, 0x00]);
  assert.deepEqual([...steelseriesAerox3EncodeDefaultLighting("reactive-rainbow")], [0x27, 0x01, 0x01]);
  // @ts-expect-error invalid mode
  assert.throws(() => steelseriesAerox3EncodeDefaultLighting("nope"), Aerox3ProtocolError);
});

test("encodes the button mapping packet at rivalcfg's exact offsets", () => {
  const report = steelseriesAerox3EncodeButtonsMapping({
    button1: { type: "button", target: "button2" },
    button6: { type: "dpiSwitch" },
    scrollUp: { type: "button", target: "button1" },
    scrollDown: { type: "disabled" },
  });
  // command 0x2A + 40 zero-filled bytes with the given offsets set.
  const expected = new Array(41).fill(0x00);
  expected[0] = 0x2a;
  expected[1 + 0x00] = 0x02; // button1 -> button2's id
  expected[1 + 0x19] = 0x30; // button6 -> dpi switch
  expected[1 + 0x1e] = 0x01; // scrollUp -> button1's id
  expected[1 + 0x23] = 0x00; // scrollDown -> disabled (already zero)
  assert.deepEqual([...report], expected);
});

test("encodes keyboard and multimedia button targets as [type byte, code]", () => {
  const report = steelseriesAerox3EncodeButtonsMapping({
    button2: { type: "keyboard", code: 0x04 },
    button3: { type: "multimedia", code: 0xcd },
  });
  assert.equal(report[0], 0x2a);
  assert.equal(report[1 + 0x05], 0x51);
  assert.equal(report[1 + 0x05 + 1], 0x04);
  assert.equal(report[1 + 0x0a], 0x61);
  assert.equal(report[1 + 0x0a + 1], 0xcd);
});

test("rejects unknown buttons and out-of-range codes", () => {
  // @ts-expect-error invalid button name
  assert.throws(() => steelseriesAerox3EncodeButtonsMapping({ nope: { type: "disabled" } }), Aerox3ProtocolError);
  assert.throws(
    () => steelseriesAerox3EncodeButtonsMapping({ button1: { type: "keyboard", code: 999 } }),
    Aerox3ProtocolError,
  );
});

test("encoders return fresh buffers and never mutate caller input", () => {
  const presets = [800, 1600];
  const first = steelseriesAerox3EncodeDpiPresets(presets, 0);
  const second = steelseriesAerox3EncodeDpiPresets(presets, 0);
  assert.notEqual(first.buffer, second.buffer);
  assert.deepEqual([...first], [...second]);
  assert.deepEqual(presets, [800, 1600]);
});
