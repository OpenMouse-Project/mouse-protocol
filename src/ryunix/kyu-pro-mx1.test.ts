import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeKyuProMx1Telemetry,
  RYUNIX_TELEMETRY_REPORT_ID,
} from "./kyu-pro-mx1.ts";

test("Kyu Pro MX1 telemetry decodes observed status fields", () => {
  const status = decodeKyuProMx1Telemetry(
    Uint8Array.of(1, 2, 0x04, 84, 1, 0x02),
    RYUNIX_TELEMETRY_REPORT_ID,
  );

  assert.deepEqual(status, {
    active: true,
    dpiStage: 2,
    pollingRateHz: 250,
    batteryPercent: 84,
    charging: true,
    batteryStatusCode: 1,
    ledMode: "Breathing single",
    ledModeCode: 0x02,
    maxPollingCode: null,
    sensorType: null,
  });
});

test("Kyu Pro MX1 telemetry reads the max rate, sensor type and high polling rates", () => {
  const status = decodeKyuProMx1Telemetry(
    Uint8Array.of(1, 0, 0x12, 90, 0, 0x03, 0, 0x04, 0x95),
    RYUNIX_TELEMETRY_REPORT_ID,
  );

  assert.equal(status?.pollingRateHz, 4000);
  assert.equal(status?.maxPollingCode, 4);
  assert.equal(status?.sensorType, 0x95);
});

test("Kyu Pro MX1 telemetry preserves an unknown LED mode without guessing", () => {
  const status = decodeKyuProMx1Telemetry(
    Uint8Array.of(0, 1, 0x01, 50, 0, 0xfe),
    RYUNIX_TELEMETRY_REPORT_ID,
  );

  assert.equal(status?.ledMode, null);
  assert.equal(status?.ledModeCode, 0xfe);
});

test("Kyu Pro MX1 telemetry rejects malformed or unrelated reports", () => {
  assert.equal(decodeKyuProMx1Telemetry(Uint8Array.of(1, 2, 4), RYUNIX_TELEMETRY_REPORT_ID), null);
  assert.equal(decodeKyuProMx1Telemetry(Uint8Array.of(1, 2, 3, 50, 0, 1), RYUNIX_TELEMETRY_REPORT_ID), null);
  assert.equal(decodeKyuProMx1Telemetry(Uint8Array.of(1, 2, 4, 101, 0, 1), RYUNIX_TELEMETRY_REPORT_ID), null);
  assert.equal(decodeKyuProMx1Telemetry(Uint8Array.of(1, 2, 4, 50, 0, 1), 0x01), null);
  // Battery status is 0, 1 or 2 (full on USB power); anything else is not telemetry.
  assert.equal(decodeKyuProMx1Telemetry(Uint8Array.of(1, 2, 4, 50, 3, 1), RYUNIX_TELEMETRY_REPORT_ID), null);
});

test("telemetry decodes a report captured from a wired XS Flow 2 Speed", () => {
  // Input report 0x04 body as read over USB at 100% battery.
  const status = decodeKyuProMx1Telemetry(
    Uint8Array.of(0x01, 0x02, 0x01, 0x64, 0x02, 0x00, 0x00, 0x01, 0x20),
    RYUNIX_TELEMETRY_REPORT_ID,
  );

  assert.equal(status?.pollingRateHz, 1000);
  assert.equal(status?.batteryPercent, 100);
  assert.equal(status?.batteryStatusCode, 2);
  assert.equal(status?.charging, false);
  assert.equal(status?.dpiStage, 2);
  assert.equal(status?.ledModeCode, 0);
  assert.equal(status?.ledMode, "Off");
  assert.equal(status?.maxPollingCode, 1);
  assert.equal(status?.sensorType, 0x20);
});
