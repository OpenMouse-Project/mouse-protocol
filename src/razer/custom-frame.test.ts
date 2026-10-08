import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeRazerRequest,
  razerChecksum,
  razerSetOneRowCustomFrameCommand,
  razerSetStandardCustomEffectCommand,
} from "./codec.js";

test("a Diamondback partial frame carries inclusive columns, RGB bytes and the fixed 50-byte size", () => {
  const packet = encodeRazerRequest(razerSetOneRowCustomFrameCommand(19, ["#ff8000", "#123456"]), 0xff);
  assert.equal(packet.length, 90);
  assert.deepEqual([...packet.slice(1, 8)], [0xff, 0, 0, 0, 0x32, 0x03, 0x0c]);
  assert.deepEqual([...packet.slice(8, 16)], [19, 20, 255, 128, 0, 18, 52, 86]);
  assert.ok(packet.slice(16, 88).every((byte) => byte === 0));
  assert.equal(packet[88], razerChecksum(packet));
});

test("the maximum frame fills the declared payload without spilling into padding", () => {
  const packet = encodeRazerRequest(razerSetOneRowCustomFrameCommand(0, Array(16).fill("#123456")), 0xff);
  assert.deepEqual([...packet.slice(8, 10)], [0, 15]);
  assert.deepEqual([...packet.slice(55, 58)], [18, 52, 86]);
  assert.ok(packet.slice(58, 88).every((byte) => byte === 0));
});

test("a custom effect activates the volatile frame on class 03 command 0a", () => {
  const packet = encodeRazerRequest(razerSetStandardCustomEffectCommand(), 0xff);
  assert.deepEqual([...packet.slice(5, 10)], [2, 3, 10, 5, 0]);
  assert.equal(packet[88], razerChecksum(packet));
});

test("invalid frame ranges and colours are rejected", () => {
  for (const start of [-1, 0.5, 256, NaN]) assert.throws(() => razerSetOneRowCustomFrameCommand(start, ["#123456"]));
  assert.throws(() => razerSetOneRowCustomFrameCommand(0, []));
  assert.throws(() => razerSetOneRowCustomFrameCommand(0, Array(17).fill("#123456")));
  assert.throws(() => razerSetOneRowCustomFrameCommand(255, ["#123456", "#abcdef"]));
  assert.throws(() => razerSetOneRowCustomFrameCommand(0, ["#12"]));
});
