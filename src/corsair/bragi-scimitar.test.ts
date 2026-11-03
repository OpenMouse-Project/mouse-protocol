import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CORSAIR_BRAGI_COMMAND,
  CORSAIR_BRAGI_MICE,
  CORSAIR_BRAGI_PROPERTY,
  CORSAIR_BRAGI_STATUS,
  CORSAIR_VENDOR_ID,
  corsairBragiDecode as decode,
  corsairBragiEncode as encode,
  corsairBragiIsReplyTo,
  corsairBragiPacketOfSize,
} from "./index.ts";

const SIZE = 128;
const PRODUCT_ID = 0x1be3;

/** `<seconds> <dir> <hex>` lines from the iCUE capture, zero-padded back to 128 bytes. */
function capture(): Array<{ dir: string; bytes: Uint8Array }> {
  const text = readFileSync(new URL("../../captures/corsair-scimitar-rgb-elite/properties.hex", import.meta.url), "utf8");
  return text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
    const [, dir, ...hex] = line.trim().split(/\s+/);
    const bytes = new Uint8Array(SIZE);
    bytes.set(hex.map((byte) => Number.parseInt(byte, 16)));
    return { dir: dir!, bytes };
  });
}

/** Request/reply pairs; the capture alternates > and <. */
function pairs(): Array<{ request: Uint8Array; reply: Uint8Array }> {
  const frames = capture();
  const out: Array<{ request: Uint8Array; reply: Uint8Array }> = [];
  for (let index = 0; index < frames.length; index += 2) {
    assert.equal(frames[index]!.dir, ">");
    assert.equal(frames[index + 1]!.dir, "<");
    out.push({ request: frames[index]!.bytes, reply: frames[index + 1]!.bytes });
  }
  return out;
}

const value = (bytes: Uint8Array) => bytes[4]! | (bytes[5]! << 8);

test("the SCIMITAR RGB ELITE is in the Bragi table with its 128-byte report size and usage", () => {
  assert.deepEqual(CORSAIR_BRAGI_MICE.get(PRODUCT_ID), {
    name: "SCIMITAR RGB ELITE",
    dpiMin: 100,
    dpiMax: 18_000,
    packetSize: 128,
    commandUsage: 0x01,
    extraProperties: ["brightness", "angleSnapping", "dpiStage"],
  });
});

test("every captured GET request is the encoder's output at 128 bytes", () => {
  const gets = pairs().filter(({ request }) => request[1] === CORSAIR_BRAGI_COMMAND.get);
  assert.ok(gets.length > 100);
  for (const { request } of gets) assert.deepEqual(encode.get(0, request[2]!, SIZE), request);
});

test("every captured GET reply is slot 0, GET echoed, status ok", () => {
  for (const { request, reply } of pairs().filter(({ request }) => request[1] === CORSAIR_BRAGI_COMMAND.get)) {
    assert.ok(corsairBragiIsReplyTo(request, reply));
    const { slot, command, status } = decode.reply(reply);
    assert.deepEqual([slot, command, status], [0, CORSAIR_BRAGI_COMMAND.get, CORSAIR_BRAGI_STATUS.ok]);
  }
});

test("every captured SET request is re-encoded byte for byte and acked ok", () => {
  const sets = pairs().filter(({ request }) => request[1] === CORSAIR_BRAGI_COMMAND.set);
  assert.ok(sets.length > 50);
  const seen = new Set<number>();
  for (const { request, reply } of sets) {
    const property = request[2]!;
    const v = value(request);
    seen.add(property);
    switch (property) {
      case CORSAIR_BRAGI_PROPERTY.dpiX: assert.deepEqual(encode.setDpi(0, "x", v, SIZE), request); break;
      case CORSAIR_BRAGI_PROPERTY.dpiY: assert.deepEqual(encode.setDpi(0, "y", v, SIZE), request); break;
      case CORSAIR_BRAGI_PROPERTY.pollingRate: assert.deepEqual(encode.setPollingRate(0, decode.pollingRateHz(v)!, SIZE), request); break;
      case CORSAIR_BRAGI_PROPERTY.brightness: assert.deepEqual(encode.setBrightness(0, decode.brightnessPercent(v)!, SIZE), request); break;
      case CORSAIR_BRAGI_PROPERTY.angleSnapping: assert.deepEqual(encode.setAngleSnapping(0, v === 1, SIZE), request); break;
      // iCUE flips the mode at connect; the driver never does, so there is no encoder.
      case CORSAIR_BRAGI_PROPERTY.mode: assert.deepEqual(corsairBragiPacketOfSize(SIZE, 0, CORSAIR_BRAGI_COMMAND.set, property, v & 0xff, v >> 8), request); break;
      default: assert.fail(`unexpected SET property 0x${property.toString(16)}`);
    }
    assert.deepEqual(decode.reply(reply), { slot: 0, command: CORSAIR_BRAGI_COMMAND.set, status: CORSAIR_BRAGI_STATUS.ok, value: 0 });
  }
  // The capture exercised every settable property the codec encodes.
  assert.deepEqual([...seen].sort((a, b) => a - b), [0x01, 0x02, 0x03, 0x07, 0x21, 0x22]);
});

test("the handshake reads identify the mouse and its firmware", () => {
  const reads = new Map<number, Uint8Array>();
  for (const { request, reply } of pairs()) {
    if (request[1] === CORSAIR_BRAGI_COMMAND.get && !reads.has(request[2]!)) reads.set(request[2]!, reply);
  }
  assert.equal(decode.reply(reads.get(CORSAIR_BRAGI_PROPERTY.vendorId)!).value, CORSAIR_VENDOR_ID);
  assert.equal(decode.reply(reads.get(CORSAIR_BRAGI_PROPERTY.productId)!).value, PRODUCT_ID);
  // iCUE showed "v. 1.2.21" for this mouse.
  assert.equal(decode.firmware(reads.get(CORSAIR_BRAGI_PROPERTY.firmware)!), "1.2.21");
  assert.equal(decode.pollingRateHz(decode.reply(reads.get(CORSAIR_BRAGI_PROPERTY.pollingRate)!).value), 1000);
});

test("polling rates seen in the capture are the 125, 250, 500 and 1000 Hz values", () => {
  const rates = new Set(pairs()
    .filter(({ request }) => request[1] === CORSAIR_BRAGI_COMMAND.set && request[2] === CORSAIR_BRAGI_PROPERTY.pollingRate)
    .map(({ request }) => decode.pollingRateHz(value(request))));
  assert.deepEqual([...rates].sort((a, b) => a! - b!), [125, 250, 500, 1000]);
});

test("brightness is tenths of a percent: iCUE's 33, 66 and 100 % steps", () => {
  const sent = pairs()
    .filter(({ request }) => request[1] === CORSAIR_BRAGI_COMMAND.set && request[2] === CORSAIR_BRAGI_PROPERTY.brightness)
    .map(({ request }) => value(request));
  assert.ok(sent.length >= 3);
  assert.deepEqual([...new Set(sent)].sort((a, b) => a - b), [330, 660, 1000]);
  assert.deepEqual([330, 660, 1000].map(decode.brightnessPercent), [33, 66, 100]);
  assert.equal(decode.brightnessPercent(1001), null);
  assert.deepEqual([...encode.setBrightness(0, 66, SIZE).subarray(0, 6)], [0x08, 0x01, 0x02, 0x00, 0x94, 0x02]);
});

test("angle snapping is 0 or 1", () => {
  assert.equal(decode.angleSnapping(0), false);
  assert.equal(decode.angleSnapping(1), true);
  assert.equal(decode.angleSnapping(2), null);
  assert.deepEqual([...encode.setAngleSnapping(0, true, SIZE).subarray(0, 5)], [0x08, 0x01, 0x07, 0x00, 0x01]);
});

test("a truncated reply is rejected and an unsupported status is reported, not decoded as a value", () => {
  const request = encode.get(0, CORSAIR_BRAGI_PROPERTY.brightness, SIZE);
  assert.throws(() => decode.reply(new Uint8Array([0x00, 0x02, 0x00, 0xe8, 0x03])), /shorter/);
  const unsupported = new Uint8Array(SIZE);
  unsupported.set([0x00, 0x02, CORSAIR_BRAGI_STATUS.unsupported]);
  assert.ok(corsairBragiIsReplyTo(request, unsupported));
  assert.equal(decode.reply(unsupported).status, CORSAIR_BRAGI_STATUS.unsupported);
});

test("encoders validate their input and size the packet", () => {
  assert.equal(encode.get(0, 0x21).length, 64);
  assert.equal(encode.get(0, 0x21, 128).length, 128);
  assert.throws(() => encode.setPollingRate(0, 3000, SIZE), /polling/);
  assert.throws(() => encode.setBrightness(0, 101, SIZE), /brightness/);
  assert.throws(() => encode.setBrightness(0, -1, SIZE), /brightness/);
  assert.throws(() => corsairBragiPacketOfSize(3, 0, 0x02, 0x21), /size/);
});
