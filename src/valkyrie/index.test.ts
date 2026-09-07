import assert from "node:assert/strict";
import test from "node:test";
import {
  valkyrieDecodeIdentityReply,
  valkyrieEncodeIdentityRequest,
  valkyrieModelName,
  valkyrieOutputReportId,
} from "./index.js";

const capturedReply = Uint8Array.from([
  0x10, 0x00, 0x01, 0x0b, 0x4d, 0x32, 0x32, 0x30,
  0x84, 0x01, 0x11, 0x01, 0x00, 0x4e, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc7,
]);

function changedReply(offset: number, value: number): Uint8Array {
  const reply = capturedReply.slice();
  reply[offset] = value;
  reply[31] = reply.subarray(4, 31).reduce((sum, byte) => sum + byte, 0) & 0xff;
  return reply;
}

test("encodes the captured identity request without the transport report ID", () => {
  // Given / When: the read-only identity command.
  const payload = valkyrieEncodeIdentityRequest();
  // Then: hidapi prefixes report ID zero to these 32 bytes.
  assert.equal(valkyrieOutputReportId, 0);
  assert.deepEqual(payload, Uint8Array.from([0x10, ...Array(31).fill(0)]));
});

test("returns independent request buffers when the caller mutates one", () => {
  // Given
  valkyrieEncodeIdentityRequest().fill(0xff);
  // When
  const payload = valkyrieEncodeIdentityRequest();
  // Then
  assert.equal(payload[0], 0x10);
  assert.equal(payload[31], 0);
});

test("decodes raw metadata from the captured M220 identity reply", () => {
  // Given
  const reply = capturedReply.slice();
  // When
  const identity = valkyrieDecodeIdentityReply(reply);
  // Then
  assert.deepEqual(identity, {
    modelCode: "M220", firmwareVersionRaw: 0x0184, sensorCode: 0x11,
    sensorVariantRaw: 1, batteryStatusRaw: 0, batteryPercent: 78,
    connectionStatusRaw: 1,
  });
  assert.deepEqual(reply, capturedReply);
});

for (const length of [0, 1, 15, 31, 33, 64]) {
  test(`rejects a reply with length ${length}`, () => {
    // Given
    const reply = new Uint8Array(length);
    reply.set(capturedReply.subarray(0, length));
    // When
    const identity = valkyrieDecodeIdentityReply(reply);
    // Then
    assert.equal(identity, undefined);
  });
}

for (const [label, offset, value] of [
  ["command", 0, 0x11], ["status", 1, 1],
  ["header marker", 2, 0], ["header length", 3, 0x0a],
  ["NUL model byte", 4, 0], ["control model byte", 5, 0x1f],
  ["DEL model byte", 6, 0x7f], ["non-ASCII model byte", 7, 0x80],
  ["battery above 100", 13, 101],
] as const) {
  test(`rejects invalid ${label} even with a recomputed checksum`, () => {
    // Given
    const reply = changedReply(offset, value);
    // When
    const identity = valkyrieDecodeIdentityReply(reply);
    // Then
    assert.equal(identity, undefined);
  });
}

test("rejects a reply with a corrupted checksum", () => {
  // Given
  const reply = capturedReply.slice();
  reply[31] = 0xc6;
  // When
  const identity = valkyrieDecodeIdentityReply(reply);
  // Then
  assert.equal(identity, undefined);
});

for (const batteryPercent of [0, 100]) {
  test(`accepts battery boundary ${batteryPercent}`, () => {
    // Given
    const reply = changedReply(13, batteryPercent);
    // When
    const identity = valkyrieDecodeIdentityReply(reply);
    // Then
    assert.equal(identity?.batteryPercent, batteryPercent);
  });
}

test("retains an unknown printable model and uninterpreted status bytes", () => {
  // Given
  const reply = changedReply(4, 0x20);
  reply[7] = 0x7e;
  reply[12] = 0xfe;
  reply[14] = 0xff;
  reply[30] = 0xff;
  reply[31] = 0xe3;
  // When
  const identity = valkyrieDecodeIdentityReply(reply);
  // Then
  assert.deepEqual(identity, {
    modelCode: " 22~", firmwareVersionRaw: 0x0184, sensorCode: 0x11,
    sensorVariantRaw: 1, batteryStatusRaw: 0xfe, batteryPercent: 78,
    connectionStatusRaw: 0xff,
  });
});

for (const [modelCode, expected] of [
  ["M220", "VK M3 Lite"], ["E023", "VK M3"],
  ["X999", undefined], ["m220", undefined], ["", undefined],
] as const) {
  test(`resolves only the explicit vendor model mapping for '${modelCode}'`, () => {
    // Given / When
    const name = valkyrieModelName(modelCode);
    // Then
    assert.equal(name, expected);
  });
}


test("decodes the captured wired M220 identity reply", () => {
  const reply = Uint8Array.from([
    0x10, 0, 1, 0x0b, 0x4d, 0x32, 0x32, 0x30,
    0x17, 3, 0x11, 1, 1, 0x64, 1, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x73,
  ]);
  assert.deepEqual(valkyrieDecodeIdentityReply(reply), {
    modelCode: "M220", firmwareVersionRaw: 0x0317, sensorCode: 0x11,
    sensorVariantRaw: 1, batteryStatusRaw: 1, batteryPercent: 100,
    connectionStatusRaw: 1,
  });
});
