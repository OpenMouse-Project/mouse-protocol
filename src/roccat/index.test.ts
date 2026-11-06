import assert from "node:assert/strict";
import test from "node:test";
import {
  ROCCAT_DPI_MAX,
  ROCCAT_DPI_MIN,
  ROCCAT_DPI_STEP,
  ROCCAT_PACKET_LENGTH,
  ROCCAT_STATUS_COMMAND_ID,
  roccatDecodeSettingsReply,
  roccatEncodeSettingsQuery,
  roccatEncodeStatus,
  roccatIsStatusReply,
} from "./index.ts";

const hex = (bytes: Uint8Array, count: number) => [...bytes.subarray(0, count)].map((b) => b.toString(16).padStart(2, "0")).join(" ");

test("the query frames are the recorded bytes", () => {
  assert.equal(hex(roccatEncodeSettingsQuery(), 3), "10 50 14");
  assert.equal(roccatEncodeSettingsQuery().length, ROCCAT_PACKET_LENGTH);
  assert.equal(hex(roccatEncodeStatus(), 2), "90 0a");
  assert.equal(roccatEncodeStatus().length, ROCCAT_PACKET_LENGTH);
});

test("the stored table lands on a 50-DPI grid that fits the slot byte", () => {
  assert.equal(ROCCAT_DPI_MIN, 50);
  assert.equal(ROCCAT_DPI_MAX / ROCCAT_DPI_STEP, 255, "the ceiling fills the slot byte and no vendor number above it fits");
});

test("the settings echo decoder accepts the recorded factory frame", () => {
  // The mouse's interrupt-IN reply to a settings query on this unit (this
  // unit's stage table had five entries, both axes identical). Reported as
  // `10 50 03 00 ec fa 0d 00 10 10 18 18 20 20 40 40 64 64 01 02 00 00`.
  const echo = new Uint8Array([
    0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x0d, 0x00,
    0x10, 0x10, 0x18, 0x18, 0x20, 0x20, 0x40, 0x40, 0x64, 0x64,
    0x01, 0x02, 0x00, 0x00,
  ]);
  const decoded = roccatDecodeSettingsReply(echo);
  assert.deepEqual(decoded?.dpi.stages, [800, 1200, 1600, 3200, 5000]);
  assert.deepEqual(decoded?.dpi.stagesY, [800, 1200, 1600, 3200, 5000]);
});

test("the two neighbouring byte lists decode as the two axes", () => {
  const echo = new Uint8Array([
    0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x0d, 0x00,
    16, 8, 24, 16, 32, 24, 64, 32, 100, 64,
  ]);
  const decoded = roccatDecodeSettingsReply(echo)!;
  assert.deepEqual(decoded.dpi.stages, [800, 1200, 1600, 3200, 5000]);
  assert.deepEqual(decoded.dpi.stagesY, [400, 800, 1200, 1600, 3200]);
});

test("the settings echo decoder refuses foreign frames", () => {
  assert.equal(roccatDecodeSettingsReply(new Uint8Array([0x90, 0x0a, 0x04])), null);
  assert.equal(roccatDecodeSettingsReply(new Uint8Array([0x10, 0x10, 0x0b])), null);
  assert.equal(roccatDecodeSettingsReply(new Uint8Array([0x10, 0x50, 0x51])), null);
  assert.equal(roccatDecodeSettingsReply(new Uint8Array(10)), null);
});

test("an all-zero stage table decodes as no-data, the sleeper echo", () => {
  // What an idle/sleeping mouse returns per poll in the second capture: the
  // echo of `10 50 03 00 ec fa 04` with an empty body.
  const sleeper = new Uint8Array([
    0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x04, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.equal(roccatDecodeSettingsReply(sleeper), null);
  // One non-zero slot is a real table again.
  const one = new Uint8Array([...sleeper]);
  one[8] = 0x10;
  assert.deepEqual(roccatDecodeSettingsReply(one)?.dpi.stages, [800, 0, 0, 0, 0]);
});

test("the status probe reply is recognized but never decoded as a battery percent", () => {
  assert.equal(roccatIsStatusReply(new Uint8Array([0x90, 0x0a])), true);
  assert.equal(roccatIsStatusReply(new Uint8Array([0x90, 0x0a, 0x04, 0x00, 0x00, 0x1e])), true);
  assert.equal(roccatIsStatusReply(new Uint8Array([0x10, 0x50, 0x03])), false);
  assert.equal(ROCCAT_STATUS_COMMAND_ID, 0x90);
});
