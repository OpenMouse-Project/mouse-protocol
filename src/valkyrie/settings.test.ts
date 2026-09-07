import assert from "node:assert/strict";
import test from "node:test";
import {
  valkyrieEncodePollingRequest, valkyrieEncodeDpiRequest, valkyrieEncodePollingWrite, valkyrieEncodeDpiStageWrite,
  valkyrieDecodePollingReply, valkyrieDecodeDpiReply,
} from "./settings.js";

const polling = Uint8Array.from([
  0x12, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
]);
const dpi = Uint8Array.from([
  0x13, 0, 1, 0x19, 0x24, 0x31, 0, 0x31, 0, 0x42, 0, 0x42, 0, 0x4a, 0, 0x4a,
  0, 0x65, 0, 0x65, 0, 0xa0, 0, 0xa0, 0, 0xdc, 0, 0xdc, 0, 0, 0, 0x60,
]);

for (const [name, command, encode] of [
  ["polling", 0x12, valkyrieEncodePollingRequest],
  ["DPI", 0x13, valkyrieEncodeDpiRequest],
] as const) {
  test(`encodes the captured ${name} read request`, () => {
    const payload = encode();
    assert.deepEqual(payload, Uint8Array.from([command, ...Array(31).fill(0)]));
  });
}

test("decodes the wired polling reply as a raw code", () => {
  const result = valkyrieDecodePollingReply(polling);
  assert.deepEqual(result, { pollingCodeRaw: 1, rawReply: polling });
});

test("decodes all six raw wired DPI pairs and packed stage nibbles", () => {
  const result = valkyrieDecodeDpiReply(dpi);
  assert.deepEqual(result, {
    activeCountRaw: 4, activeIndexRaw: 2,
    stagesRaw: [0x31, 0x42, 0x4a, 0x65, 0xa0, 0xdc].map(value => ({ x: value, y: value })),
    rawReply: dpi,
  });
});

for (const [name, fixture, decode] of [
  ["polling", polling, valkyrieDecodePollingReply],
  ["DPI", dpi, valkyrieDecodeDpiReply],
] as const) {
  test(`copies the ${name} reply snapshot without mutating the input`, () => {
    const input = fixture.slice();
    const result = decode(input);
    assert.deepEqual(input, fixture);
    input.fill(0xff);
    assert.deepEqual(result?.rawReply, fixture);
  });
  for (const length of [0, 31, 33]) {
    test(`rejects ${name} length ${length}`, () => {
      const input = new Uint8Array(length);
      input.set(fixture.subarray(0, length));
      assert.equal(decode(input), undefined);
    });
  }
  for (const offset of [0, 1, 2, 3, 31]) {
    test(`rejects ${name} corrupted framing/checksum byte ${offset}`, () => {
      const input = fixture.slice();
      input[offset] ^= 0xff;
      assert.equal(decode(input), undefined);
    });
  }
  test(`checks ${name} reserved bytes in the additive checksum`, () => {
    const input = fixture.slice();
    input[30] = 0xff;
    assert.equal(decode(input), undefined);
  });
}

test("preserves unknown polling codes and reserved bytes with valid checksum", () => {
  const input = polling.slice();
  input[4] = 0xfe;
  input[30] = 0xff;
  input[31] = 0xfd;
  assert.deepEqual(valkyrieDecodePollingReply(input), { pollingCodeRaw: 0xfe, rawReply: input });
});

test("reads independent little-endian X/Y pairs from a nonzero buffer offset", () => {
  const backing = new Uint8Array(40);
  const input = backing.subarray(4, 36);
  input.set(dpi);
  input[6] = 1;
  input[8] = 2;
  input[31] = 0x63;
  const result = valkyrieDecodeDpiReply(input);
  assert.deepEqual(result?.stagesRaw[0], { x: 0x131, y: 0x231 });
});

for (const code of [1, 2, 4, 8]) {
  test(`encodes polling write code ${code} with the verified 32-byte framing`, () => {
    const result = valkyrieEncodePollingWrite(polling, code);
    const expected = polling.slice();
    expected[0] = 2;
    expected[4] = code;
    expected[31] = code;
    assert.deepEqual(result, expected);
  });
}

for (const code of [0, 3, 5, 9, 1.5, NaN, Infinity]) {
  test(`rejects invalid polling write code ${code}`, () => {
    assert.throws(() => valkyrieEncodePollingWrite(polling, code), RangeError);
  });
}

test("encodes the hardware-verified slot-zero raw 49-to-50 DPI change", () => {
  const result = valkyrieEncodeDpiStageWrite(dpi, 0, 50);
  const expected = dpi.slice();
  expected[0] = 3;
  expected[3] = 0x25;
  expected[5] = 50;
  expected[7] = 50;
  expected[31] = 0x62;
  assert.deepEqual(result, expected);
});

for (const [stage, rawValue] of [[0, 1], [5, 232]] as const) {
  test(`writes raw boundary ${rawValue} into both axes of stage ${stage}`, () => {
    const result = valkyrieEncodeDpiStageWrite(dpi, stage, rawValue);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    assert.equal(view.getUint16(5 + stage * 4, true), rawValue);
    assert.equal(view.getUint16(7 + stage * 4, true), rawValue);
  });
}

for (const stage of [-1, 6, 0.5, NaN, Infinity]) {
  test(`rejects invalid DPI stage ${stage}`, () => {
    assert.throws(() => valkyrieEncodeDpiStageWrite(dpi, stage, 50), RangeError);
  });
}

for (const rawValue of [0, 233, -1, 1.5, NaN, Infinity]) {
  test(`rejects invalid sensor-0x11 raw DPI ${rawValue}`, () => {
    assert.throws(() => valkyrieEncodeDpiStageWrite(dpi, 0, rawValue), RangeError);
  });
}

for (const [name, fixture, encode] of [
  ["polling", polling, (input: Uint8Array) => valkyrieEncodePollingWrite(input, 2)],
  ["DPI", dpi, (input: Uint8Array) => valkyrieEncodeDpiStageWrite(input, 0, 50)],
] as const) {
  test(`rejects an invalid ${name} snapshot before encoding a write`, () => {
    const input = fixture.slice();
    input[31] ^= 1;
    assert.throws(() => encode(input), RangeError);
  });
  test(`preserves unknown ${name} bytes and leaves the caller snapshot unchanged`, () => {
    const input = fixture.slice();
    input[29] = 0xa5;
    input[30] = 0x5a;
    input[31] = (input[31] + 0xff) & 0xff;
    const before = input.slice();
    const result = encode(input);
    assert.deepEqual(input, before);
    assert.equal(result[29], 0xa5);
    assert.equal(result[30], 0x5a);
    assert.equal(result[31], result.subarray(4, 31).reduce((sum, byte) => sum + byte, 0) & 0xff);
  });
}
