import assert from "node:assert/strict";
import test from "node:test";

import {
  buildX11DpiReport,
  decodeX11DpiReport,
  encodeX11DpiByte,
  nearestX11Dpi,
  X11_DPI_DEFAULT_ACTIVE,
  X11_DPI_DEFAULT_STAGES,
  X11_DPI_MAX,
  X11_DPI_MIN,
} from "../../compx/x11-dpi.ts";

test("nearestX11Dpi clamps to the sensor range and rounds up to a real step", () => {
  assert.equal(nearestX11Dpi(10), X11_DPI_MIN);
  assert.equal(nearestX11Dpi(801), 850);
  assert.equal(nearestX11Dpi(800), 800);
  assert.equal(nearestX11Dpi(23000), X11_DPI_MAX);
  assert.equal(nearestX11Dpi(22000), 22000);
});

test("encodeX11DpiByte uses the hardware register map", () => {
  assert.equal(encodeX11DpiByte(800), 0x12);
  assert.equal(encodeX11DpiByte(1600), 0x25);
  assert.equal(encodeX11DpiByte(22000), 0x81);
});

test("buildX11DpiReport lays out the default table exactly like the reference driver", () => {
  const report = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
  });
  assert.equal(report.length, 56);
  assert.deepEqual([...report.subarray(0, 3)], [0x04, 0x38, 0x01]);
  assert.equal(report[3], 0x00);
  assert.equal(report[4], 0x01);
  assert.equal(report[5], 0x3f);
  // Default stage 6 is 22,000: mask bit 5 set on both mask bytes, its high
  // flag set, its byte 0x81.
  assert.equal(report[6], 0x20);
  assert.equal(report[7], 0x20);
  assert.deepEqual([...report.subarray(8, 14)], [0x12, 0x25, 0x38, 0x4b, 0x75, 0x81]);
  assert.deepEqual([...report.subarray(16, 22)], [0, 0, 0, 0, 0, 0x01]);
  assert.equal(report[24], X11_DPI_DEFAULT_ACTIVE);
  const sum = report.subarray(3, 50).reduce((acc, byte) => (acc + byte) & 0xffff, 0);
  assert.equal((report[50] << 8) | report[51], sum);
});

test("wired units emit the first 52 bytes only", () => {
  const report = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
    wired: true,
  });
  assert.equal(report.length, 52);
});

test("decodeX11DpiReport round-trips a table across every stage category", () => {
  const config = {
    stages: [500, 8000, 11000, 15000, 21000, 22000],
    activeStage: 3,
    angleSnap: true,
    rippleControl: false,
  };
  const report = buildX11DpiReport(config);
  const decoded = decodeX11DpiReport(report);
  assert.deepEqual(decoded, { ...config, enabledMask: 0x3f, base: report });
});

// Report 0x04 read through the 0xa0 handshake from a genuine X11 receiver
// (1d57:fa60, firmware 0x0107): three stages enabled (550/600/650, stage 2
// active), the factory colours, and the vendor app's 01 01 in the unused
// stage 7/8 slots.
const X11_READ_BACK = Uint8Array.from(
  ("04 38 01 00 01 07 20 20 0c 0e 0f 12 75 81 01 01 00 00 00 00 00 01 00 00 02 ff 00 00 00 ff 00 00 "
    + "00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 0e b3 00 00 00 00")
    .split(" ").map((byte) => parseInt(byte, 16)),
);

test("decodeX11DpiReport reads a real X11 table with disabled stages", () => {
  const decoded = decodeX11DpiReport(X11_READ_BACK);
  assert.deepEqual(decoded?.stages, [550, 600, 650, 800, 5000, 22000]);
  assert.equal(decoded?.enabledMask, 0x07);
  assert.equal(decoded?.activeStage, 2);
  assert.equal(decoded?.angleSnap, false);
  assert.equal(decoded?.rippleControl, true);
  assert.deepEqual(decoded?.base, X11_READ_BACK);
});

test("buildX11DpiReport on a read-back changes only the edited fields", () => {
  const decoded = decodeX11DpiReport(X11_READ_BACK)!;
  const stages = [...decoded.stages];
  stages[0] = 1600;
  const report = buildX11DpiReport({ ...decoded, stages });
  const changed = [...report.subarray(0, 50)].flatMap((byte, i) => (byte === X11_READ_BACK[i] ? [] : [i]));
  // Only stage 1's byte (plus the checksum); the enable mask, colours and
  // unused slots stay as the mouse had them.
  assert.deepEqual(changed, [8]);
  assert.equal(report[8], 0x25);
  const sum = report.subarray(3, 50).reduce((acc, byte) => (acc + byte) & 0xffff, 0);
  assert.equal((report[50] << 8) | report[51], sum);
  assert.deepEqual(decodeX11DpiReport(report)?.stages, stages);
});

test("buildX11DpiReport keeps a disabled stage's stored bytes when its value is 0", () => {
  const base = new Uint8Array(X11_READ_BACK);
  base[13] = 0x00; // an empty slot behind disabled stage 6
  base[21] = 0x00;
  base[6] = base[7] = 0x00;
  const sum = base.subarray(3, 50).reduce((acc, byte) => (acc + byte) & 0xffff, 0);
  base[50] = sum >> 8;
  base[51] = sum & 0xff;
  const decoded = decodeX11DpiReport(base)!;
  assert.equal(decoded.stages[5], 0);
  const report = buildX11DpiReport(decoded);
  assert.deepEqual(report, base);
});

test("decodeX11DpiReport still rejects an enabled stage it cannot decode", () => {
  const report = new Uint8Array(X11_READ_BACK);
  report[8] = 0x00;
  const sum = report.subarray(3, 50).reduce((acc, byte) => (acc + byte) & 0xffff, 0);
  report[50] = sum >> 8;
  report[51] = sum & 0xff;
  assert.equal(decodeX11DpiReport(report), null);
});

test("decodeX11DpiReport accepts a report-id-stripped read-back", () => {
  const full = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
  });
  const stripped = new Uint8Array(full.subarray(1));
  const decoded = decodeX11DpiReport(stripped);
  assert.deepEqual(decoded?.stages, [...X11_DPI_DEFAULT_STAGES]);
  assert.equal(decoded?.activeStage, X11_DPI_DEFAULT_ACTIVE);
});

test("decodeX11DpiReport rejects a bad signature or checksum", () => {
  const good = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
  });
  const badSignature = new Uint8Array(good);
  badSignature[0] = 0x02;
  assert.equal(decodeX11DpiReport(badSignature), null);

  const badChecksum = new Uint8Array(good);
  badChecksum[51] = (badChecksum[51] + 1) & 0xff;
  assert.equal(decodeX11DpiReport(badChecksum), null);

  assert.equal(decodeX11DpiReport(new Uint8Array([0x38, 0x01])), null);
});
