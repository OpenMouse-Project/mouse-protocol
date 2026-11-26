import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIME_MINI_DEFAULT_DPI_PRESETS,
  PRIME_MINI_DEFAULT_POLLING_RATE,
  PRIME_MINI_DPI_MAX,
  PRIME_MINI_DPI_MIN,
  PRIME_MINI_MAX_DPI_PRESETS,
  PRIME_MINI_POLLING_RATES,
  PrimeMiniProtocolError,
  steelseriesPrimeMiniDecodeFirmware,
  steelseriesPrimeMiniDpiOptions,
  steelseriesPrimeMiniEncodeButtonsMapping,
  steelseriesPrimeMiniEncodeDefaultLighting,
  steelseriesPrimeMiniEncodeDpiPresets,
  steelseriesPrimeMiniEncodeLedBrightness,
  steelseriesPrimeMiniEncodePollingRate,
  steelseriesPrimeMiniEncodeZoneColor,
  steelseriesPrimeMiniFirmwareQuery,
  steelseriesPrimeMiniResetLightingCommand,
  steelseriesPrimeMiniSaveCommand,
} from "./prime-mini.ts";

test("DPI options are the 50..18000 range in 50 DPI steps", () => {
  const options = steelseriesPrimeMiniDpiOptions();
  assert.equal(options[0], PRIME_MINI_DPI_MIN);
  assert.equal(options.at(-1), PRIME_MINI_DPI_MAX);
  assert.equal(options.length, (PRIME_MINI_DPI_MAX - PRIME_MINI_DPI_MIN) / 50 + 1);
  assert.deepEqual([...PRIME_MINI_DEFAULT_DPI_PRESETS], [400, 800, 1200, 2400, 3200]);
  assert.equal(PRIME_MINI_DEFAULT_POLLING_RATE, 1000);
  assert.equal(PRIME_MINI_MAX_DPI_PRESETS, 5);
});

test("DPI presets encode factors little-endian with count and index", () => {
  // factor = dpi / 50: 400 -> 8, 3200 -> 64
  assert.deepEqual(
    [...steelseriesPrimeMiniEncodeDpiPresets([400, 800, 1200, 2400, 3200], 0)],
    [0x2d, 0x05, 0x00, 0x08, 0x00, 0x10, 0x00, 0x18, 0x00, 0x30, 0x00, 0x40, 0x00],
  );
  assert.deepEqual(
    [...steelseriesPrimeMiniEncodeDpiPresets([400, 800, 1200, 2400, 3200], 4).slice(0, 3)],
    [0x2d, 0x05, 0x04],
  );
});

test("DPI presets reject off-grid values, bad counts, and bad indices", () => {
  const presets = [400, 800, 1200, 2400, 3200] as const;
  assert.throws(() => steelseriesPrimeMiniEncodeDpiPresets([400, 800], 0), PrimeMiniProtocolError);
  assert.throws(() => steelseriesPrimeMiniEncodeDpiPresets([...presets], 5), PrimeMiniProtocolError);
  assert.deepEqual(
    [...steelseriesPrimeMiniEncodeDpiPresets([100, 800, 1200, 2400, 3200], 0).slice(3, 5)],
    [0x02, 0x00],
  );
  assert.throws(() => steelseriesPrimeMiniEncodeDpiPresets([25, 800, 1200, 2400, 3200], 0), PrimeMiniProtocolError);
  assert.throws(() => steelseriesPrimeMiniEncodeDpiPresets([125, 800, 1200, 2400, 3200], 0), PrimeMiniProtocolError);
  assert.throws(() => steelseriesPrimeMiniEncodeDpiPresets([18050, 800, 1200, 2400, 3200], 0), PrimeMiniProtocolError);
});

test("polling rates use 1000->0x01 down to 125->0x04", () => {
  assert.deepEqual([...steelseriesPrimeMiniEncodePollingRate(1000)], [0x2b, 0x01]);
  assert.deepEqual([...steelseriesPrimeMiniEncodePollingRate(500)], [0x2b, 0x02]);
  assert.deepEqual([...steelseriesPrimeMiniEncodePollingRate(250)], [0x2b, 0x03]);
  assert.deepEqual([...steelseriesPrimeMiniEncodePollingRate(125)], [0x2b, 0x04]);
  assert.deepEqual([...PRIME_MINI_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesPrimeMiniEncodePollingRate(2000), PrimeMiniProtocolError);
});

test("save is one byte; firmware query is 90 00 with a 15-byte string reply", () => {
  assert.deepEqual([...steelseriesPrimeMiniSaveCommand()], [0x11]);
  assert.deepEqual([...steelseriesPrimeMiniFirmwareQuery()], [0x90, 0x00]);
  const payload = new Uint8Array([0x31, 0x2e, 0x30, 0x2e, 0x31, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(steelseriesPrimeMiniDecodeFirmware(payload), "1.0.11");
  assert.throws(() => steelseriesPrimeMiniDecodeFirmware(new Uint8Array(14)), PrimeMiniProtocolError);
});

test("lighting commands use the single zone", () => {
  assert.deepEqual([...steelseriesPrimeMiniEncodeZoneColor(255, 0, 0)], [0x21, 0x00, 0xff, 0x00, 0x00]);
  assert.deepEqual([...steelseriesPrimeMiniEncodeLedBrightness(100)], [0x23, 100]);
  assert.throws(() => steelseriesPrimeMiniEncodeLedBrightness(101), PrimeMiniProtocolError);
  assert.deepEqual([...steelseriesPrimeMiniEncodeDefaultLighting("rainbow")], [0x27, 0x01]);
  assert.deepEqual([...steelseriesPrimeMiniEncodeDefaultLighting("off")], [0x27, 0x00]);
  assert.throws(
    () => steelseriesPrimeMiniEncodeDefaultLighting("disco" as never),
    PrimeMiniProtocolError,
  );
  assert.deepEqual([...steelseriesPrimeMiniResetLightingCommand()], [0x22]);
  assert.throws(() => steelseriesPrimeMiniEncodeZoneColor(0, 0, 300), PrimeMiniProtocolError);
});

test("button mapping keeps the DPI button on DPI-switch by default", () => {
  const report = steelseriesPrimeMiniEncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
  });
  assert.equal(report[0], 0x2a);
  assert.equal(report.length, 1 + 8 * 5);
  assert.equal(report[1], 0x01);
  assert.equal(report[1 + 5 * 5], 0x30);
  assert.equal(report[1 + 6 * 5], 0x31);
  assert.equal(report[1 + 7 * 5], 0x32);
});

test("button mapping rejects unknown buttons and bad codes", () => {
  assert.throws(
    () => steelseriesPrimeMiniEncodeButtonsMapping({ ["button9" as never]: { type: "disabled" } }),
    PrimeMiniProtocolError,
  );
  assert.throws(
    () => steelseriesPrimeMiniEncodeButtonsMapping({
      button1: { type: "keyboard", code: 512 },
    }),
    PrimeMiniProtocolError,
  );
});
