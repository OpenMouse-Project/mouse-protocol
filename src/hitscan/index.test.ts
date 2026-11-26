import assert from "node:assert/strict";
import test from "node:test";
import {
  HITSCAN_COMMAND, HITSCAN_FLASH_LENGTH, HitscanConfig,
  hitscanBuildCommand, hitscanBuildReadPayload, hitscanBuildWritePayload,
  hitscanBuildReadChunks, hitscanBuildWriteChunks, hitscanChecksumIsValid,
  hitscanMatchesResponse, hitscanParseReadResponse, hitscanEncodeRecord,
  hitscanEncodeScalar, hitscanDecodeScalar, hitscanEncodeTriplet,
  hitscanDecodeTriplet, hitscanEncodeShortcut, hitscanDecodeShortcut,
  hitscanEncodeMacro, hitscanDecodeMacro, type HitscanMacroEvent,
} from "./index.js";

test("DLL ReadCurrentDPI and scalar write constructions match literal wire fixtures", () => {
  // ReadCurrentDPI (0x180010650): read address 4, one byte.
  assert.deepEqual([...hitscanBuildReadPayload(4, 1)], [8, 0, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40]);
  // Generic updater: scalar 1 at address 0 is [01,54], plus outer checksum EF.
  assert.deepEqual([...hitscanBuildWritePayload(0, [1, 0x54])], [7, 0, 0, 0, 2, 1, 0x54, 0, 0, 0, 0, 0, 0, 0, 0, 0xef]);
  assert.deepEqual([...hitscanBuildCommand(HITSCAN_COMMAND.online)], [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4a]);
  assert.equal(hitscanChecksumIsValid(hitscanBuildReadPayload(0, 10)), true);
  assert.equal(hitscanChecksumIsValid(new Uint8Array(17)), false);
});

test("flash transfers use ten-byte chunks and cannot cross the recovered image boundary", () => {
  const read = hitscanBuildReadChunks(0x100, 23);
  assert.deepEqual(read.map(p => [...p.subarray(2, 5)]), [[1, 0, 10], [1, 10, 10], [1, 20, 3]]);
  const write = hitscanBuildWriteChunks(HITSCAN_FLASH_LENGTH - 11, new Uint8Array(11).fill(0xaa));
  assert.deepEqual(write.map(p => p[4]), [10, 1]);
  assert.ok(write.every(hitscanChecksumIsValid));
  for (const [address, length] of [[-1, 1], [0, 0], [0, 11], [HITSCAN_FLASH_LENGTH - 1, 2], [0.5, 1]]) {
    assert.throws(() => hitscanBuildReadPayload(address!, length!), RangeError);
  }
  assert.throws(() => hitscanBuildWriteChunks(HITSCAN_FLASH_LENGTH - 10, new Uint8Array(11)), RangeError);
  assert.throws(() => hitscanBuildWritePayload(0, [256]), RangeError);
});

test("reply matching rejects corruption, notifications, stale flash reads and non-echo writes", () => {
  const request = hitscanBuildReadPayload(0x04, 1);
  const response = Uint8Array.from([8, 0, 0, 4, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3e]);
  assert.deepEqual(hitscanParseReadResponse(response, 4, 1), new Uint8Array([2]));
  assert.equal(hitscanMatchesResponse(request, response), true);
  assert.equal(hitscanParseReadResponse(response, 0, 1), null);
  assert.equal(hitscanParseReadResponse(response, 4, 2), null);
  response[15] ^= 1;
  assert.equal(hitscanMatchesResponse(request, response), false);
  const write = hitscanBuildWritePayload(0, [1, 0x54]);
  assert.equal(hitscanMatchesResponse(write, write.slice()), true);
  assert.equal(hitscanMatchesResponse(write, hitscanBuildWritePayload(2, [1, 0x54])), false);
  const notification = hitscanBuildCommand(0x0a);
  assert.equal(hitscanMatchesResponse(notification, notification), false);
});

test("record checksums include wrapping and invalid data does not become parser defaults", () => {
  assert.deepEqual([...hitscanEncodeScalar(255)], [255, 0x56]);
  assert.equal(hitscanDecodeScalar([255, 0x56]), 255);
  assert.equal(hitscanDecodeScalar([255, 0x55]), null);
  assert.deepEqual([...hitscanEncodeTriplet([0xff, 0xff, 0])], [255, 255, 0, 0x57]);
  assert.deepEqual(hitscanDecodeTriplet([255, 255, 0, 0x57]), new Uint8Array([255, 255, 0]));
  assert.equal(hitscanDecodeTriplet([255, 255, 0]), null);
  assert.throws(() => hitscanEncodeTriplet([0, 0]), RangeError);
});

const events: HitscanMacroEvent[] = [
  {type: 0, modifier: 1, code: 4, value: 0, delay: 0x1234},
  {type: 1, modifier: 0, code: 4, value: 0, delay: 65535},
];
test("shortcut literal packing validates checksum without mutating the input", () => {
  const shortcut = hitscanEncodeShortcut(events);
  assert.deepEqual([...shortcut], [2, 0x81, 4, 0, 0x40, 4, 0, 0x8a]);
  assert.deepEqual(hitscanDecodeShortcut(shortcut), events.map(({delay: _delay, ...event}) => event));
  const slot = new Uint8Array(32); slot.set(shortcut); slot[7] ^= 1;
  const original = slot.slice();
  assert.equal(hitscanDecodeShortcut(slot), null);
  assert.deepEqual(slot, original);
  assert.throws(() => hitscanEncodeShortcut(events.slice(0, 1)), RangeError);
  assert.throws(() => hitscanEncodeShortcut(Array(7).fill(events[0])), RangeError);
});

test("macro event delay is big endian; name is outside the event checksum", () => {
  const macro = hitscanEncodeMacro({name: new Uint8Array([65]), events});
  assert.equal(macro.length, 43);
  assert.deepEqual([...macro.subarray(31)], [2, 0x81, 4, 0, 0x12, 0x34, 0x40, 4, 0, 0xff, 0xff, 0x46]);
  assert.deepEqual(hitscanDecodeMacro(macro), {name: new Uint8Array([65]), events});
  macro[1] = 66;
  assert.deepEqual(hitscanDecodeMacro(macro)?.name, new Uint8Array([66]));
  macro[33] ^= 1;
  assert.equal(hitscanDecodeMacro(macro), null);
});

test("maximum macro fits its slot and malformed counts, names and truncation fail", () => {
  const fullEvents = Array.from({length: 70}, () => ({...events[0]!}));
  const macro = hitscanEncodeMacro({name: new Uint8Array(30).fill(65), events: fullEvents});
  assert.equal(macro.length, 383);
  const slot = new Uint8Array(384); slot.set(macro);
  assert.equal(hitscanDecodeMacro(slot)?.events.length, 70);
  assert.equal(hitscanDecodeMacro(macro.subarray(0, 382)), null);
  assert.throws(() => hitscanEncodeMacro({name: new Uint8Array(31), events}), RangeError);
  assert.throws(() => hitscanEncodeMacro({name: new Uint8Array(), events: Array(71).fill(events[0])}), RangeError);
  assert.throws(() => hitscanEncodeMacro({name: new Uint8Array(), events: [{...events[0]!, delay: 65536}, events[1]!]}), RangeError);
  slot[31] = 71;
  assert.equal(hitscanDecodeMacro(slot), null);
});

test("config snapshot preserves unknown bytes and validates individual records", () => {
  const image = new Uint8Array(HITSCAN_FLASH_LENGTH).fill(0xcc);
  image.set(hitscanEncodeScalar(6), 2);
  image.set(hitscanEncodeTriplet([1, 2, 3]), 0x0c);
  image.set(hitscanEncodeRecord([4, 5, 6]), 0x60);
  image.set(hitscanEncodeShortcut(events), 0x100);
  image.set(hitscanEncodeMacro({name: new Uint8Array([65]), events}), 0x300);
  const config = new HitscanConfig(image);
  assert.deepEqual(config.bytes, image);
  image[2] = 0;
  assert.equal(config.scalar(2), 6);
  assert.equal(config.scalar(6), null);
  assert.deepEqual(config.dpiStage(0), new Uint8Array([1, 2, 3]));
  assert.deepEqual(config.button(0), new Uint8Array([4, 5, 6]));
  assert.equal(config.shortcut(0)?.length, 2);
  assert.deepEqual(config.macro(0)?.events, events);
  const copied = config.bytes; copied.fill(0);
  assert.equal(config.scalar(2), 6);
  assert.equal(new HitscanConfig(new Uint8Array(0xc0)).macro(0), null);
  assert.throws(() => new HitscanConfig(new Uint8Array(0xbf)), RangeError);
});
