import assert from "node:assert/strict";
import test from "node:test";
import {
  HITSCAN_POLLING_RATES, hitscanEncodePollingRate, hitscanDecodePollingRate,
  hitscanEncode3395Dpi, hitscanDecode3395Dpi,
  HITSCAN_3395_DPI_VALUES,
} from "./settings.js";

test("polling codes follow the named Qt rate handlers, including 8K", () => {
  assert.deepEqual(HITSCAN_POLLING_RATES.map(hitscanEncodePollingRate), [8, 4, 2, 1, 16, 32, 64]);
  for (const hz of HITSCAN_POLLING_RATES) assert.equal(hitscanDecodePollingRate(hitscanEncodePollingRate(hz)), hz);
  assert.equal(hitscanDecodePollingRate(3), null);
  assert.throws(() => hitscanEncodePollingRate(16000), RangeError);
});

test("3395 DPI records match the app's threshold, quantization and high bits", () => {
  for (const [dpi, record, decoded] of [
    [50, [0, 0, 0], 50],
    [400, [7, 7, 0], 400],
    [800, [15, 15, 0], 800],
    [4050, [80, 80, 0], 4050],
    [4100, [40, 40, 0x11], 4100],
    [4150, [40, 40, 0x11], 4100],
    [25600, [255, 255, 0x11], 25600],
    [25700, [0, 0, 0x55], 25700],
    [26000, [3, 3, 0x55], 26000],
  ] as const) {
    const result = hitscanEncode3395Dpi(dpi);
    assert.deepEqual([...result.record.subarray(0, 3)], record);
    assert.equal(result.effectiveDpi, decoded);
    assert.equal(hitscanDecode3395Dpi(result.record), decoded);
    assert.equal(hitscanDecode3395Dpi(record), decoded);
  }
  for (const dpi of [0, 49, 75, 26050, NaN, Infinity]) assert.throws(() => hitscanEncode3395Dpi(dpi), RangeError);
  for (const record of [[1, 2, 0], [0, 0, 0x11], [255, 255, 0x55], [0, 0, 0x22], [256, 256, 0], [0, 0]]) {
    assert.equal(hitscanDecode3395Dpi(record), null);
  }
  assert.equal(hitscanDecode3395Dpi([7, 7, 0, 0]), null);
  assert.equal(HITSCAN_3395_DPI_VALUES.includes(4150), false);
  for (const dpi of HITSCAN_3395_DPI_VALUES) {
    const result = hitscanEncode3395Dpi(dpi);
    assert.equal(result.effectiveDpi, dpi);
    assert.equal(hitscanDecode3395Dpi(result.record), dpi);
  }
});
