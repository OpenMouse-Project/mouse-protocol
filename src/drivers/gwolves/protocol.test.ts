import assert from "node:assert/strict";
import test from "node:test";

import {
  gwolvesBuildReadPayload,
  gwolvesBuildWritePayload,
  gwolvesBuildWriteScalarPayload,
  gwolvesDecodeDpi,
  gwolvesDecodePollingRate,
  gwolvesEncodeDpi,
  gwolvesEncodePollingRate,
  gwolvesReportChecksumIsValid,
} from "@openmouse/protocol/gwolves";

test("captured DPI write (1650 -> 1600) round-trips through encode/decode", () => {
  // Real packets captured live via browser sendReport/inputreport patch
  // while using the official G-Wolves web driver at mouse.fit — see
  // PROTOCOL-NOTES.md in the PR.
  const captured1650 = [7, 0, 0, 12, 4, 32, 32, 0, 21, 0, 0, 0, 0, 0, 0, 225];
  const captured1600 = [7, 0, 0, 12, 4, 31, 31, 0, 23, 0, 0, 0, 0, 0, 0, 225];

  assert.equal(gwolvesReportChecksumIsValid(captured1650), true);
  assert.equal(gwolvesReportChecksumIsValid(captured1600), true);

  const stage1650 = captured1650.slice(5, 9);
  const stage1600 = captured1600.slice(5, 9);
  assert.equal(gwolvesDecodeDpi(stage1650), 1650);
  assert.equal(gwolvesDecodeDpi(stage1600), 1600);

  assert.deepEqual([...gwolvesEncodeDpi(1650)], stage1650);
  assert.deepEqual([...gwolvesEncodeDpi(1600)], stage1600);
});

test("captured LOD writes (Low/Medium/High) match the firmware's own enum order", () => {
  // Not sequential (0/1/2) — this is the firmware's internal ordering,
  // confirmed by capturing all three levels against real hardware.
  const low = [7, 0, 0, 10, 2, 3, 82, 0, 0, 0, 0, 0, 0, 0, 0, 229];
  const medium = [7, 0, 0, 10, 2, 1, 84, 0, 0, 0, 0, 0, 0, 0, 0, 229];
  const high = [7, 0, 0, 10, 2, 2, 83, 0, 0, 0, 0, 0, 0, 0, 0, 229];

  for (const packet of [low, medium, high]) {
    assert.equal(gwolvesReportChecksumIsValid(packet), true);
  }
  assert.deepEqual([...gwolvesBuildWriteScalarPayload(0x0a, 3)], low);
  assert.deepEqual([...gwolvesBuildWriteScalarPayload(0x0a, 1)], medium);
  assert.deepEqual([...gwolvesBuildWriteScalarPayload(0x0a, 2)], high);
});

test("captured polling rate writes cover all 7 supported rates", () => {
  const captured: Record<number, number[]> = {
    125: [7, 0, 0, 0, 2, 8, 77, 0, 0, 0, 0, 0, 0, 0, 0, 239],
    250: [7, 0, 0, 0, 2, 4, 81, 0, 0, 0, 0, 0, 0, 0, 0, 239],
    500: [7, 0, 0, 0, 2, 2, 83, 0, 0, 0, 0, 0, 0, 0, 0, 239],
    1000: [7, 0, 0, 0, 2, 1, 84, 0, 0, 0, 0, 0, 0, 0, 0, 239],
    2000: [7, 0, 0, 0, 2, 16, 69, 0, 0, 0, 0, 0, 0, 0, 0, 239],
    4000: [7, 0, 0, 0, 2, 32, 53, 0, 0, 0, 0, 0, 0, 0, 0, 239],
    8000: [7, 0, 0, 0, 2, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 239],
  };

  for (const [rate, packet] of Object.entries(captured)) {
    assert.equal(gwolvesReportChecksumIsValid(packet), true);
    const encoded = gwolvesEncodePollingRate(Number(rate));
    assert.equal(encoded, packet[5]);
    assert.equal(gwolvesDecodePollingRate(encoded), Number(rate));
    assert.deepEqual([...gwolvesBuildWriteScalarPayload(0x00, encoded)], packet);
  }
});

test("read payload matches the captured polling-rate read probe", () => {
  // [8, 0, 0, 0, 2, ...zeros..., 67] — read 2 bytes at address 0. This
  // exact packet was confirmed working against real hardware via
  // hidapitester (see PROTOCOL-NOTES.md).
  const expected = [8, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 67];
  assert.deepEqual([...gwolvesBuildReadPayload(0, 2)], expected);
});

test("write payload rejects out-of-range addresses and oversized chunks", () => {
  assert.throws(() => gwolvesBuildWritePayload(-1, [1]));
  assert.throws(() => gwolvesBuildWritePayload(0x10000, [1]));
  assert.throws(() => gwolvesBuildWritePayload(0, new Array(11).fill(0)));
});

test("DPI encode rejects values outside the confirmed 50-26000 step range", () => {
  assert.throws(() => gwolvesEncodeDpi(0));
  assert.throws(() => gwolvesEncodeDpi(49));
  assert.throws(() => gwolvesEncodeDpi(26050));
  assert.throws(() => gwolvesEncodeDpi(1625)); // not a multiple of 50
});
