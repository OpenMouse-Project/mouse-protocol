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
  const decoded = decodeX11DpiReport(buildX11DpiReport(config));
  assert.deepEqual(decoded, config);
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
