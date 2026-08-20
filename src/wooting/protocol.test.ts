import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeProtobufFields,
  decodeWootingAnalogReport,
  decodeWootingDeviceConfig,
  decodeWootingVersion,
  encodeWootingCommand,
  isWootingReply,
  wootingFeatureReport,
  wootingProductName,
  WOOTING_COMMAND,
} from "./index.ts";

test("encodeWootingCommand matches the SDK single-report layout", () => {
  const buffer = encodeWootingCommand(WOOTING_COMMAND.getDeviceConfig);
  // [reportIndex, magic0, magic1, commandId, param3, param2, param1, param0]
  assert.deepEqual([...buffer], [0x00, 0xd0, 0xda, 19, 0x00, 0x00, 0x00, 0x00]);
});

test("encodeWootingCommand reverses parameters and honours multi-report", () => {
  const single = encodeWootingCommand(5, 0x11, 0x22, 0x33, 0x44);
  assert.deepEqual([...single], [0x00, 0xd0, 0xda, 5, 0x44, 0x33, 0x22, 0x11]);

  const multi = encodeWootingCommand(5, 0x11, 0x22, 0x33, 0x44, { multiReport: true });
  assert.equal(multi[0], 0x01);
  assert.equal(multi[1], 0xd1);
  assert.equal(multi[2], 0xda);
});

test("wootingFeatureReport splits off the hidapi report-index byte", () => {
  const { reportId, data } = wootingFeatureReport(encodeWootingCommand(WOOTING_COMMAND.getDeviceConfig));
  assert.equal(reportId, 0);
  assert.deepEqual([...data], [0xd0, 0xda, 19, 0x00, 0x00, 0x00, 0x00]);
});

test("decodeWootingDeviceConfig reads the layout byte at the WebHID offset (9)", () => {
  // A real 60HE+ reply: header d1 da 13, status/payload, layout byte at index 9.
  const ansi = new Uint8Array([0xd1, 0xda, 0x13, 0x88, 0x07, 0, 0, 0, 0, 0x00, 0x11, 0, 0x0c]);
  assert.deepEqual(decodeWootingDeviceConfig(ansi), { layout: "ANSI", layoutId: 0 });

  const iso = new Uint8Array(64);
  iso[9] = 1;
  assert.deepEqual(decodeWootingDeviceConfig(iso), { layout: "ISO", layoutId: 1 });

  const split = new Uint8Array(64);
  split[9] = 3;
  assert.deepEqual(decodeWootingDeviceConfig(split), { layout: "ANSI Split", layoutId: 3 });

  const other = new Uint8Array(64);
  other[9] = 7;
  assert.deepEqual(decodeWootingDeviceConfig(other), { layout: "Unknown", layoutId: 7 });
});

test("decodeWootingDeviceConfig rejects a response too short to trust", () => {
  assert.equal(decodeWootingDeviceConfig(new Uint8Array(4)), null);
});

test("WOOTING_COMMAND exposes the read-only D0DA command ids", () => {
  assert.equal(WOOTING_COMMAND.getVersion, 0x01);
  assert.equal(WOOTING_COMMAND.getSerial, 0x03);
  assert.equal(WOOTING_COMMAND.getDeviceConfig, 0x13);
});

test("decodeWootingVersion parses major.minor.patch at offset 6", () => {
  // Real 60HE+ get_version reply — Wootility shows v2.13.0.
  const reply = new Uint8Array([0xd1, 0xda, 0x01, 0x88, 0x03, 0x00, 0x02, 0x0d, 0x00]);
  assert.equal(decodeWootingVersion(reply), "2.13.0");
  // Not a Wooting reply, or an all-zero version, decodes to nothing.
  assert.equal(decodeWootingVersion(new Uint8Array([0x01])), null);
  assert.equal(decodeWootingVersion(new Uint8Array([0xd1, 0xda, 0x01, 0x88, 0, 0, 0, 0, 0])), null);
});

test("isWootingReply accepts a magic-word reply and rejects stubs", () => {
  // The real 60HE+ DEVICE_CONFIG reply seen on hardware.
  assert.equal(isWootingReply(new Uint8Array([0xd1, 0xda, 0x13, 0xff, 0, 0, 0, 0])), true);
  assert.equal(isWootingReply(new Uint8Array([0xd0, 0xda, 0x13, 0x00])), true);
  // A feature GET that echoes only the report id, or an empty buffer, is not a reply.
  assert.equal(isWootingReply(new Uint8Array([0x01])), false);
  assert.equal(isWootingReply(new Uint8Array(32)), false);
});

test("decodeProtobufFields extracts fields by wire type", () => {
  // field 1 varint = 150; field 2 length-delimited "ab"; field 3 float32 = 0.2
  const floatBytes = new Uint8Array(new Float32Array([0.2]).buffer);
  const data = new Uint8Array([0x08, 0x96, 0x01, 0x12, 0x02, 0x61, 0x62, (3 << 3) | 5, ...floatBytes]);
  const fields = decodeProtobufFields(data);
  assert.equal(fields[0]?.field, 1);
  assert.equal(fields[0]?.int, 150);
  assert.equal(fields[1]?.field, 2);
  assert.deepEqual([...(fields[1]?.bytes ?? [])], [0x61, 0x62]);
  assert.equal(fields[2]?.field, 3);
  assert.ok(Math.abs((fields[2]?.float ?? 0) - 0.2) < 1e-6);
});

test("decodeWootingAnalogReport parses 3-byte entries in stable usage order", () => {
  // [usageHigh, usage, value] entries: S (0x16) at 200 arrives before A (0x04) at 100,
  // but the result is ordered by usage so rows keep their place as values change.
  const data = new Uint8Array([0x00, 0x16, 0xc8, 0x00, 0x04, 0x64, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(decodeWootingAnalogReport(data), [
    { usage: 0x04, value: 100 },
    { usage: 0x16, value: 200 },
  ]);
  // No keys pressed → empty.
  assert.deepEqual(decodeWootingAnalogReport(new Uint8Array(30)), []);
});

test("wootingProductName knows the 60HE+ and falls back otherwise", () => {
  assert.equal(wootingProductName(0x1322), "Wooting 60HE+");
  assert.equal(wootingProductName(0xffff), "Wooting keyboard");
});
