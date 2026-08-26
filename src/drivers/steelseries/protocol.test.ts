import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL3_DPI_MAX,
  RIVAL3_DPI_MIN,
  RIVAL3_DPI_STEP,
  RIVAL3_MAX_DPI_PRESETS,
  SteelSeriesProtocolError,
  TRUEMOVE_CORE_DPI_TO_BYTE,
  steelseriesRival3DecodeFirmware,
  steelseriesRival3DpiOptions,
  steelseriesRival3EncodeDpiPresets,
  steelseriesRival3EncodePollingRate,
  steelseriesRival3FirmwareQuery,
  steelseriesRival3SaveCommand,
} from "../../steelseries/index.ts";

test("the TrueMove Core table matches every value rivalcfg quotes", () => {
  // Anchors quoted verbatim in rivalcfg's devices/dpi/truemove_core.py.
  const quoted: Array<[number, number]> = [
    [200, 0x04], [300, 0x06], [400, 0x08], [500, 0x0b], [600, 0x0d], [700, 0x0f],
    [800, 0x12], [900, 0x14], [1000, 0x16], [1100, 0x19], [1200, 0x1b],
    [1600, 0x24], [8500, 0xc5],
  ];
  for (const [dpi, byte] of quoted) {
    assert.equal(TRUEMOVE_CORE_DPI_TO_BYTE.get(dpi), byte, `${dpi} DPI`);
  }
});

test("the table spans 200–8,500 in 100 DPI steps with strictly increasing bytes", () => {
  const options = steelseriesRival3DpiOptions();
  assert.equal(options.length, (RIVAL3_DPI_MAX - RIVAL3_DPI_MIN) / RIVAL3_DPI_STEP + 1);
  assert.equal(options[0], RIVAL3_DPI_MIN);
  assert.equal(options.at(-1), RIVAL3_DPI_MAX);
  let previousByte = -1;
  for (const [index, dpi] of options.entries()) {
    assert.equal(dpi, RIVAL3_DPI_MIN + index * RIVAL3_DPI_STEP);
    const byte = TRUEMOVE_CORE_DPI_TO_BYTE.get(dpi)!;
    assert.ok(byte > previousByte, `byte for ${dpi} DPI must exceed the previous entry`);
    previousByte = byte;
  }
});

test("encodes rivalcfg's default two-preset configuration byte for byte", () => {
  // rivalcfg default `sensitivity: "800, 1600"`, first preset selected.
  assert.deepEqual(
    [...steelseriesRival3EncodeDpiPresets([800, 1600], 0)],
    [0x0b, 0x00, 0x02, 0x01, 0x12, 0x24],
  );
  assert.deepEqual([...steelseriesRival3EncodeDpiPresets([800], 0)], [0x0b, 0x00, 0x01, 0x01, 0x12]);
  assert.deepEqual(
    [...steelseriesRival3EncodeDpiPresets([200, 400, 800, 1600, 8500], 4)],
    [0x0b, 0x00, 0x05, 0x05, 0x04, 0x08, 0x12, 0x24, 0xc5],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesRival3EncodeDpiPresets([850], 0), SteelSeriesProtocolError);
  assert.throws(() => steelseriesRival3EncodeDpiPresets([250], 0), /100 DPI steps/);
  assert.throws(() => steelseriesRival3EncodeDpiPresets([150], 0), SteelSeriesProtocolError);
  assert.throws(() => steelseriesRival3EncodeDpiPresets([8600], 0), SteelSeriesProtocolError);
  assert.throws(() => steelseriesRival3EncodeDpiPresets([], 0), /1–5 DPI presets/);
  assert.throws(
    () => steelseriesRival3EncodeDpiPresets([800, 800, 800, 800, 800, 800], 0),
    new RegExp(`1–${RIVAL3_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesRival3EncodeDpiPresets([800, 1600], -1), SteelSeriesProtocolError);
  assert.throws(() => steelseriesRival3EncodeDpiPresets([800, 1600], 2), SteelSeriesProtocolError);
});

test("encodes every polling rate and rejects rates the mouse does not offer", () => {
  assert.deepEqual([...steelseriesRival3EncodePollingRate(1000)], [0x04, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival3EncodePollingRate(500)], [0x04, 0x00, 0x02]);
  assert.deepEqual([...steelseriesRival3EncodePollingRate(250)], [0x04, 0x00, 0x03]);
  assert.deepEqual([...steelseriesRival3EncodePollingRate(125)], [0x04, 0x00, 0x04]);
  assert.throws(() => steelseriesRival3EncodePollingRate(2000), SteelSeriesProtocolError);
  assert.throws(() => steelseriesRival3EncodePollingRate(0), SteelSeriesProtocolError);
});

test("frames the save and firmware commands", () => {
  assert.deepEqual([...steelseriesRival3SaveCommand()], [0x09, 0x00]);
  assert.deepEqual([...steelseriesRival3FirmwareQuery()], [0x10, 0x00]);
});

test("decodes the firmware response and rejects truncated payloads", () => {
  const firmware = steelseriesRival3DecodeFirmware(new Uint8Array([0x25, 0x00]));
  assert.deepEqual(firmware.bytes, [37, 0]);
  assert.equal(firmware.display, "37.0");
  assert.throws(() => steelseriesRival3DecodeFirmware(new Uint8Array([])), SteelSeriesProtocolError);
  assert.throws(() => steelseriesRival3DecodeFirmware(new Uint8Array([0x25])), /shorter than two bytes/);
});

test("encoders return fresh buffers and never mutate the caller's presets", () => {
  const presets = [800, 1600];
  const first = steelseriesRival3EncodeDpiPresets(presets, 0);
  const second = steelseriesRival3EncodeDpiPresets(presets, 0);
  assert.notEqual(first.buffer, second.buffer);
  assert.deepEqual([...first], [...second]);
  assert.deepEqual(presets, [800, 1600]);
});
