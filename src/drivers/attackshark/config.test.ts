import assert from "node:assert/strict";
import test from "node:test";

import {
  buildX11QueryRequest,
  decodeX11FirmwareVersion,
  decodeX11PollingReport,
  normalizeX11Report,
  x11QueryReady,
} from "../../compx/x11-config.ts";

const bytes = (hex: string) => Uint8Array.from(hex.split(" ").map((byte) => parseInt(byte, 16)));

test("buildX11QueryRequest stages a report with its length and flag", () => {
  assert.deepEqual([...buildX11QueryRequest(0x04)], [0x04, 0x38, 0x00, 0x01, 0x00, 0x00, 0x00]);
  assert.deepEqual([...buildX11QueryRequest(0x06)], [0x06, 0x09, 0x00, 0x01, 0x00, 0x00, 0x00]);
  assert.deepEqual([...buildX11QueryRequest(0x0b, 0x00)], [0x0b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(() => buildX11QueryRequest(0x09), /No read-back/);
});

test("x11QueryReady reads the flag with or without the report id", () => {
  assert.equal(x11QueryReady(bytes("a0 01 00 00 00 00 00 00")), true);
  assert.equal(x11QueryReady(bytes("a0 00 00 00 00 00 00 00")), false);
  assert.equal(x11QueryReady(bytes("01 00 00 00 00 00 00")), true);
  assert.equal(x11QueryReady(bytes("00 00 00 00 00 00 00")), false);
});

// Replies read from a genuine X11 receiver (1d57:fa60, firmware 0x0107).
test("decodeX11PollingReport decodes the live polling report", () => {
  assert.equal(decodeX11PollingReport(bytes("06 09 01 01 fe 00 00 00 00")), 1000);
  assert.equal(decodeX11PollingReport(bytes("09 01 08 f7 00 00 00 00")), 125);
  // The complement byte guards against stale buffer contents.
  assert.equal(decodeX11PollingReport(bytes("06 09 01 01 00 00 00 00 00")), null);
  assert.equal(decodeX11PollingReport(bytes("05 0f 01 10 03 a3 00 ff 00")), null);
});

test("decodeX11FirmwareVersion decodes the live version report", () => {
  assert.equal(decodeX11FirmwareVersion(bytes("0b 08 01 07 00 00 00 00")), 0x0107);
  assert.equal(decodeX11FirmwareVersion(bytes("08 01 10 00 00 00 00")), 0x0110);
  assert.equal(decodeX11FirmwareVersion(bytes("05 01 09 06 a1 01 15 00")), null);
});

test("normalizeX11Report rejects data without the report's signature", () => {
  assert.equal(normalizeX11Report(0x06, bytes("00 76 00 69 00 63 00 65")), null);
  assert.equal(normalizeX11Report(0x0a, bytes("0a 80 01")), null);
});
