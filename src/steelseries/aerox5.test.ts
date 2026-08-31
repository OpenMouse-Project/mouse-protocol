import assert from "node:assert/strict";
import test from "node:test";

import {
  AEROX5_DPI_MAX,
  AEROX5_DPI_MIN,
  AEROX5_MAX_DPI_PRESETS,
  Aerox5ProtocolError,
  steelseriesAerox5DpiOptions,
  steelseriesAerox5EncodeButtonsMapping,
  steelseriesAerox5EncodeDefaultLighting,
  steelseriesAerox5EncodeDpiPresets,
  steelseriesAerox5EncodeLedBrightness,
  steelseriesAerox5EncodePollingRate,
  steelseriesAerox5EncodeRainbowEffect,
  steelseriesAerox5EncodeReactiveColor,
  steelseriesAerox5EncodeZoneColor,
  steelseriesAerox5SaveCommand,
} from "./aerox5.ts";
import { TRUEMOVE_AIR_DPI_TO_BYTE } from "./rival3-wireless.ts";
import { TRUEMOVE_CORE_DPI_TO_BYTE } from "./rival3.ts";

test("DPI options mirror the shared TrueMove Air table, distinct from TrueMove Core", () => {
  const options = steelseriesAerox5DpiOptions();
  assert.equal(options[0], AEROX5_DPI_MIN);
  assert.equal(options.at(-1), AEROX5_DPI_MAX);
  assert.equal(options.length, (AEROX5_DPI_MAX - AEROX5_DPI_MIN) / 100 + 1);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(400), 0x04);
  assert.notEqual(TRUEMOVE_AIR_DPI_TO_BYTE.get(400), TRUEMOVE_CORE_DPI_TO_BYTE.get(400));
});

test("encodes rivalcfg's default five-preset configuration, first_preset 0 (no +1 offset)", () => {
  // rivalcfg default "400, 800, 1200, 2400, 3200", first preset selected.
  assert.deepEqual(
    [...steelseriesAerox5EncodeDpiPresets([400, 800, 1200, 2400, 3200], 0)],
    [0x2d, 0x05, 0x00, 0x04, 0x09, 0x0d, 0x1b, 0x26],
  );
  assert.deepEqual([...steelseriesAerox5EncodeDpiPresets([100], 0)], [0x2d, 0x01, 0x00, 0x00]);
  assert.deepEqual([...steelseriesAerox5EncodeDpiPresets([18000], 0)], [0x2d, 0x01, 0x00, 0xd6]);
});

test("selects a non-first preset as 0-based on the wire (first_preset: 0)", () => {
  assert.deepEqual(
    [...steelseriesAerox5EncodeDpiPresets([400, 800], 1)],
    [0x2d, 0x02, 0x01, 0x04, 0x09],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesAerox5EncodeDpiPresets([150], 0), Aerox5ProtocolError);
  assert.throws(
    () => steelseriesAerox5EncodeDpiPresets([], 0),
    new RegExp(`1–${AEROX5_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(
    () => steelseriesAerox5EncodeDpiPresets([100, 100, 100, 100, 100, 100], 0),
    new RegExp(`1–${AEROX5_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesAerox5EncodeDpiPresets([400, 800], -1), Aerox5ProtocolError);
  assert.throws(() => steelseriesAerox5EncodeDpiPresets([400, 800], 2), Aerox5ProtocolError);
});

test("encodes every polling rate with the plain-Aerox5 byte mapping (same as Aerox 3) and rejects unsupported rates", () => {
  assert.deepEqual([...steelseriesAerox5EncodePollingRate(1000)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesAerox5EncodePollingRate(500)], [0x2b, 0x02]);
  assert.deepEqual([...steelseriesAerox5EncodePollingRate(250)], [0x2b, 0x03]);
  assert.deepEqual([...steelseriesAerox5EncodePollingRate(125)], [0x2b, 0x04]);
  assert.throws(() => steelseriesAerox5EncodePollingRate(2000), Aerox5ProtocolError);
});

test("encodes zone colors with growing zero-padding for zones 2 and 3", () => {
  assert.deepEqual([...steelseriesAerox5EncodeZoneColor(1, 255, 0, 0)], [0x21, 0x01, 255, 0, 0]);
  assert.deepEqual(
    [...steelseriesAerox5EncodeZoneColor(2, 0, 255, 0)],
    [0x21, 0x02, 0x00, 0x00, 0x00, 0, 255, 0],
  );
  assert.deepEqual(
    [...steelseriesAerox5EncodeZoneColor(3, 0, 0, 255)],
    [0x21, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0, 0, 255],
  );
  assert.throws(() => steelseriesAerox5EncodeZoneColor(4 as never, 0, 0, 0), Aerox5ProtocolError);
  assert.throws(() => steelseriesAerox5EncodeZoneColor(1, 256, 0, 0), Aerox5ProtocolError);
});

test("encodes reactive color on/off", () => {
  assert.deepEqual(
    [...steelseriesAerox5EncodeReactiveColor(null)],
    [0x26, 0x00, 0x00, 0x00, 0x00, 0x00],
  );
  assert.deepEqual(
    [...steelseriesAerox5EncodeReactiveColor({ r: 1, g: 2, b: 3 })],
    [0x26, 0x01, 0x00, 1, 2, 3],
  );
});

test("encodes LED brightness as linear passthrough and rejects out-of-range", () => {
  assert.deepEqual([...steelseriesAerox5EncodeLedBrightness(0)], [0x23, 0]);
  assert.deepEqual([...steelseriesAerox5EncodeLedBrightness(100)], [0x23, 100]);
  assert.throws(() => steelseriesAerox5EncodeLedBrightness(101), Aerox5ProtocolError);
  assert.throws(() => steelseriesAerox5EncodeLedBrightness(-1), Aerox5ProtocolError);
});

test("encodes rainbow zone bitmasks, identical table to Aerox 3", () => {
  assert.deepEqual([...steelseriesAerox5EncodeRainbowEffect("all")], [0x22, 0b111]);
  assert.deepEqual([...steelseriesAerox5EncodeRainbowEffect("top")], [0x22, 0b001]);
  assert.throws(() => steelseriesAerox5EncodeRainbowEffect("nope" as never), Aerox5ProtocolError);
});

test("encodes default lighting modes, identical table to Aerox 3", () => {
  assert.deepEqual([...steelseriesAerox5EncodeDefaultLighting("off")], [0x27, 0x00, 0x00]);
  assert.deepEqual([...steelseriesAerox5EncodeDefaultLighting("rainbow")], [0x27, 0x01, 0x00]);
  assert.throws(() => steelseriesAerox5EncodeDefaultLighting("nope" as never), Aerox5ProtocolError);
});

test("frames the save command", () => {
  assert.deepEqual([...steelseriesAerox5SaveCommand()], [0x11, 0x00]);
});

test("buttons mapping covers 9 buttons + scroll up/down (55-byte packet)", () => {
  const zeros = () => new Array(55).fill(0x00);

  const dpiSwitch = zeros();
  dpiSwitch[0x19] = 0x30;
  assert.deepEqual(
    [...steelseriesAerox5EncodeButtonsMapping({ button6: { type: "dpiSwitch" } })],
    [0x2a, ...dpiSwitch],
  );

  // Button 9 sits past Aerox 3's packet length entirely — exercises the extra side-button cluster.
  const button9 = zeros();
  button9[0x28] = 0x51;
  button9[0x29] = 0x0a;
  assert.deepEqual(
    [...steelseriesAerox5EncodeButtonsMapping({ button9: { type: "keyboard", code: 0x0a } })],
    [0x2a, ...button9],
  );

  // scrollUp/scrollDown as remap *sources* (not targets) into other buttons' ids.
  const scrollSources = zeros();
  scrollSources[0x2d] = 0x02; // scrollUp -> button2's id
  scrollSources[0x32] = 0x01; // scrollDown -> button1's id
  assert.deepEqual(
    [...steelseriesAerox5EncodeButtonsMapping({
      scrollUp: { type: "button", target: "button2" },
      scrollDown: { type: "button", target: "button1" },
    })],
    [0x2a, ...scrollSources],
  );

  assert.deepEqual([...steelseriesAerox5EncodeButtonsMapping({})], [0x2a, ...zeros()]);
});

test("rejects unknown buttons and out-of-range codes", () => {
  assert.throws(
    () => steelseriesAerox5EncodeButtonsMapping({ ["button10" as never]: { type: "disabled" } }),
    Aerox5ProtocolError,
  );
  assert.throws(
    () => steelseriesAerox5EncodeButtonsMapping({ button1: { type: "keyboard", code: 999 } }),
    Aerox5ProtocolError,
  );
  assert.throws(
    () => steelseriesAerox5EncodeButtonsMapping({ button1: { type: "multimedia", code: -1 } }),
    Aerox5ProtocolError,
  );
});
