import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CORSAIR_BRAGI_COMMAND,
  CORSAIR_BRAGI_PROPERTY,
  CORSAIR_BRAGI_STATUS,
  corsairBragiDecode as decode,
  corsairBragiEncode as encode,
  corsairBragiIsReplyTo,
  corsairBragiPacket,
} from "./index.ts";

/** `<seconds> <dir> <hex>` lines from the iCUE capture, zero-padded back to 64 bytes. */
function capture(): Array<{ dir: string; bytes: Uint8Array }> {
  const text = readFileSync(new URL("../../captures/corsair-ironclaw-rgb-wireless/dpi-slider.hex", import.meta.url), "utf8");
  return text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
    const [, dir, ...hex] = line.trim().split(/\s+/);
    const bytes = new Uint8Array(64);
    bytes.set(hex.map((byte) => Number.parseInt(byte, 16)));
    return { dir: dir!, bytes };
  });
}

function frame(...bytes: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(bytes);
  return out;
}

test("re-encodes every frame iCUE sent while the DPI slider moved", () => {
  const sent = capture().filter((entry) => entry.dir === ">");
  assert.equal(sent.length, 202);
  for (const { bytes } of sent) {
    const axis = bytes[2] === CORSAIR_BRAGI_PROPERTY.dpiX ? "x" : "y";
    const dpi = bytes[4]! | (bytes[5]! << 8);
    assert.deepEqual(encode.setDpi(bytes[0]! & 0x07, axis, dpi), bytes);
  }
});

test("iCUE writes X then Y with the same value", () => {
  const sent = capture().filter((entry) => entry.dir === ">").map(({ bytes }) => ({ property: bytes[2], dpi: bytes[4]! | (bytes[5]! << 8) }));
  for (let index = 0; index < sent.length; index += 2) {
    assert.equal(sent[index]!.property, CORSAIR_BRAGI_PROPERTY.dpiX);
    assert.equal(sent[index + 1]!.property, CORSAIR_BRAGI_PROPERTY.dpiY);
    assert.equal(sent[index]!.dpi, sent[index + 1]!.dpi);
  }
  const values = sent.map((entry) => entry.dpi);
  assert.deepEqual([Math.min(...values), Math.max(...values)], [1391, 11288]);
});

test("every captured ack answers the request before it: slot 1, SET echoed, status ok", () => {
  const frames = capture();
  for (let index = 0; index < frames.length; index += 2) {
    const request = frames[index]!;
    const reply = frames[index + 1]!;
    assert.equal(request.dir, ">");
    assert.equal(reply.dir, "<");
    assert.ok(corsairBragiIsReplyTo(request.bytes, reply.bytes));
    assert.deepEqual(decode.reply(reply.bytes), { slot: 1, command: CORSAIR_BRAGI_COMMAND.set, status: CORSAIR_BRAGI_STATUS.ok, value: 0 });
  }
});

test("a reply from another slot or for another command is not the answer", () => {
  const request = encode.get(1, CORSAIR_BRAGI_PROPERTY.dpiX);
  assert.ok(corsairBragiIsReplyTo(request, frame(0x01, 0x02, 0x00, 0x6f, 0x05)));
  assert.ok(!corsairBragiIsReplyTo(request, frame(0x00, 0x02, 0x00, 0x6f, 0x05)));
  assert.ok(!corsairBragiIsReplyTo(request, frame(0x01, 0x01, 0x00)));
});

// GET replies below follow ckb-next / OpenRGB / OpenLinkHub; none was captured yet.
test("GET requests carry the slot in byte 0 and the property in byte 2", () => {
  assert.deepEqual([...encode.get(0, CORSAIR_BRAGI_PROPERTY.slots).subarray(0, 4)], [0x08, 0x02, 0x36, 0x00]);
  assert.deepEqual([...encode.get(1, CORSAIR_BRAGI_PROPERTY.productId).subarray(0, 4)], [0x09, 0x02, 0x12, 0x00]);
  assert.throws(() => corsairBragiPacket(8, 0x02, 0x12), /slot/);
  assert.throws(() => encode.setDpi(1, "x", 0), /DPI/);
  assert.throws(() => encode.setDpi(1, "x", 70_000), /DPI/);
});

test("decodes values little-endian from byte 3", () => {
  assert.deepEqual(decode.reply(frame(0x01, 0x02, 0x00, 0x4c, 0x1b)), { slot: 1, command: 0x02, status: 0, value: 0x1b4c });
  assert.equal(decode.reply(frame(0x01, 0x02, 0x05)).status, CORSAIR_BRAGI_STATUS.unsupported);
  assert.equal(decode.firmware(frame(0x01, 0x02, 0x00, 0x03, 0x0b, 0x2a, 0x00)), "3.11.42");
  assert.throws(() => decode.reply(new Uint8Array(3)), /shorter/);
});

test("maps polling, battery and slot values", () => {
  assert.deepEqual([1, 2, 3, 4].map(decode.pollingRateHz), [125, 250, 500, 1000]);
  assert.equal(decode.pollingRateHz(0), null);
  assert.equal(decode.batteryPercent(875), 88);
  assert.equal(decode.batteryPercent(1001), null);
  assert.deepEqual([1, 2, 3, 0].map(decode.batteryState), ["Charging", "Discharging", "Full", "Unknown"]);
  assert.deepEqual(decode.slots(0b0000_0010), [1]);
  assert.deepEqual(decode.slots(0b1000_0101), [2, 7]);
  assert.deepEqual(decode.slots(0), []);
});
