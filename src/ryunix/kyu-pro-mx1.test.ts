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
    ledMode: "Breathing single",
    ledModeCode: 0x02,
  });
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
});
