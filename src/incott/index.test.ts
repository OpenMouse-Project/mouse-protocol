import assert from "node:assert/strict";
import test from "node:test";

import {
  incottDecodeBattery,
  incottDecodeButtonBinding,
  incottDecodeDebounce,
  incottDecodeDpiStage,
  incottDecodeDpiStageIndex,
  incottDecodeIdentity,
  incottDecodeInputStatus,
  incottDecodeLiftOff,
  incottDecodeLiftOffDirect,
  incottDecodeMotionSync,
  incottDecodePerformanceMode,
  incottDecodePollingRate,
  incottDecodeReceiverLed,
  incottDecodeSleep,
  incottDecodeToggle,
  incottEncodeQuery,
  incottEncodeSetActiveDpiStage,
  incottEncodeSetButtonBinding,
  incottEncodeSetDebounce,
  incottEncodeSetDpi,
  incottEncodeSetLiftOff,
  incottEncodeSetPerformanceMode,
  incottEncodeSetPollingRate,
  incottEncodeSetReceiverLed,
  incottEncodeSetSleep,
  incottEncodeSetToggle,
  incottFrameMatches,
  incottIsWiredProduct,
  incottLiftOffLabel,
  incottLiftOffTenths,
  incottNormalizeProductName,
  incottValidateDpi,
  INCOTT_POLLING_STEPS_HZ,
  INCOTT_POLLING_STEPS_HZ_WIRED,
  INCOTT_PRODUCT_ID,
  INCOTT_PRODUCT_ID_WIRED,
} from "./index.ts";

const bytes = (frame: Uint8Array): number[] => Array.from(frame);

test("every payload is 8 bytes and omits the report ID", () => {
  // WebHID's sendFeatureReport takes the report ID as a separate argument, so
  // including it here would shift every field by one byte on the wire.
  assert.equal(incottEncodeSetDpi(1, 800).length, 8);
  assert.equal(incottEncodeSetPollingRate(1000).length, 8);
  assert.equal(incottEncodeQuery(0x84).length, 8);
});

test("DPI is a little-endian uint16 wire value under command 0x02, byte 1 the stage index", () => {
  // Captured 2026-09-08 against a real incott 8K wireless mouse, reading all
  // six stages independently:
  //   09 82 00 -> wire 0x07 -> 400 DPI      09 82 03 -> wire 0x2f -> 2400 DPI
  //   09 82 01 -> wire 0x0f -> 800 DPI      09 82 04 -> wire 0x3f -> 3200 DPI
  //   09 82 02 -> wire 0x1f -> 1600 DPI     09 82 05 -> wire 0x7f -> 6400 DPI
  // and the write shape (`TX 09 02 <stage> <lo> <hi>`), confirmed by writing
  // 25000 to stage 2 (wire 499 = 0x01f3) and reading it back exactly, then
  // restoring 1600 (wire 31 = 0x1f) and reading that back too.
  //
  // THIS WAS WRONG until 2026-09-08: byte 1 used to be hardcoded to a
  // constant `0x01`, so only stage 1 could ever be written — see
  // `INCOTT_DPI_STAGE_COUNT`.
  assert.deepEqual(bytes(incottEncodeSetDpi(1, 800)).slice(0, 4), [0x02, 0x01, 0x0f, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetDpi(2, 25000)).slice(0, 4), [0x02, 0x02, 0xf3, 0x01]);
  assert.deepEqual(bytes(incottEncodeSetDpi(0, 400)).slice(0, 4), [0x02, 0x00, 0x07, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetDpi(5, 6400)).slice(0, 4), [0x02, 0x05, 0x7f, 0x00]);
  // The wire round-trips: 0 -> 50 DPI, the documented minimum.
  assert.deepEqual(bytes(incottEncodeSetDpi(3, 50)).slice(0, 4), [0x02, 0x03, 0x00, 0x00]);
});

test("DPI rejects values outside 50-45000 or not a multiple of 50", () => {
  assert.throws(() => incottEncodeSetDpi(0, 49), RangeError);
  assert.throws(() => incottEncodeSetDpi(0, 45050), RangeError);
  assert.throws(() => incottEncodeSetDpi(0, 825), RangeError);
  assert.throws(() => incottEncodeSetDpi(0, -50), RangeError);
});

test("DPI rejects a stage index outside 0-5", () => {
  assert.throws(() => incottEncodeSetDpi(6, 800), RangeError);
  assert.throws(() => incottEncodeSetDpi(-1, 800), RangeError);
});

test("incottValidateDpi throws exactly when incottEncodeSetDpi would reject the DPI value", () => {
  assert.doesNotThrow(() => incottValidateDpi(800));
  assert.doesNotThrow(() => incottValidateDpi(25000));
  assert.throws(() => incottValidateDpi(825), RangeError);
  assert.throws(() => incottValidateDpi(45050), RangeError);
});

test("polling rate carries its value in byte 1, not byte 2", () => {
  // Unlike DPI and the sensor commands, polling has no sub-command: the wire
  // value sits where a sub-command would normally go.
  assert.deepEqual(bytes(incottEncodeSetPollingRate(1000)).slice(0, 2), [0x01, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetPollingRate(125)).slice(0, 2), [0x01, 0x03]);
  assert.deepEqual(bytes(incottEncodeSetPollingRate(8000)).slice(0, 2), [0x01, 0x04]);
  assert.deepEqual(bytes(incottEncodeSetPollingRate(2000)).slice(0, 2), [0x01, 0x06]);
});

test("polling rate rejects a rate the device does not implement", () => {
  assert.throws(() => incottEncodeSetPollingRate(333), /polling/i);
});

test("lift-off distance maps tenths of a millimetre onto wire values", () => {
  assert.deepEqual(bytes(incottEncodeSetLiftOff(10)).slice(0, 4), [0x04, 0x01, 0x00, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetLiftOff(20)).slice(0, 4), [0x04, 0x01, 0x01, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetLiftOff(7)).slice(0, 4), [0x04, 0x01, 0x02, 0x00]);
});

test("lift-off rejects a distance the device does not implement", () => {
  assert.throws(() => incottEncodeSetLiftOff(15), /lift-off/i);
});

test("the three sensor toggles share command 0x04 and differ by sub-command", () => {
  assert.deepEqual(bytes(incottEncodeSetToggle("rippleControl", true)).slice(0, 4), [0x04, 0x02, 0x01, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetToggle("angleSnapping", true)).slice(0, 4), [0x04, 0x03, 0x01, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetToggle("motionSync", true)).slice(0, 4), [0x04, 0x04, 0x01, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetToggle("motionSync", false)).slice(0, 4), [0x04, 0x04, 0x00, 0x00]);
});

test("debounce is a plain millisecond value bounded at 30", () => {
  assert.deepEqual(bytes(incottEncodeSetDebounce(4)).slice(0, 4), [0x05, 0x01, 0x04, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetDebounce(0)).slice(0, 4), [0x05, 0x01, 0x00, 0x00]);
  assert.throws(() => incottEncodeSetDebounce(31), /debounce/i);
  assert.throws(() => incottEncodeSetDebounce(-1), /debounce/i);
});

test("sleep seconds are encoded little-endian across two bytes", () => {
  assert.deepEqual(bytes(incottEncodeSetSleep(60)).slice(0, 5), [0x05, 0x03, 0x3c, 0x00, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetSleep(900)).slice(0, 5), [0x05, 0x03, 0x84, 0x03, 0x00]);
});

test("sleep rejects values outside the device's accepted range", () => {
  assert.throws(() => incottEncodeSetSleep(0), /sleep/i);
  assert.throws(() => incottEncodeSetSleep(901), /sleep/i);
});

test("receiver LED carries its mode in byte 1 like polling", () => {
  assert.deepEqual(bytes(incottEncodeSetReceiverLed(0)).slice(0, 2), [0x08, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetReceiverLed(2)).slice(0, 2), [0x08, 0x02]);
  assert.throws(() => incottEncodeSetReceiverLed(3), /receiver/i);
});

test("queries send the opcode with an optional sub-command and no arguments", () => {
  assert.deepEqual(bytes(incottEncodeQuery(0x84)), [0x84, 0x00, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(bytes(incottEncodeQuery(0x85, 0x03)), [0x85, 0x03, 0, 0, 0, 0, 0, 0]);
});

/** Builds a response frame with the report ID at byte 0, as WebHID returns it. */
const frame = (...values: readonly number[]): Uint8Array => {
  const out = new Uint8Array(64);
  out[0] = 0x09;
  values.forEach((value, index) => {
    out[index + 1] = value;
  });
  return out;
};

test("incottFrameMatches requires the report ID, command, and sub-command to agree", () => {
  assert.equal(incottFrameMatches(frame(0x85, 0x03), 0x85, 0x03), true);
  assert.equal(incottFrameMatches(frame(0x85, 0x01), 0x85, 0x03), false);
  assert.equal(incottFrameMatches(frame(0x84, 0x03), 0x85, 0x03), false);
  // A null sub-command means "do not check byte 2".
  assert.equal(incottFrameMatches(frame(0x89, 0x00), 0x89, null), true);
});

test("incottFrameMatches rejects a frame carrying the wrong report ID", () => {
  const wrong = frame(0x85, 0x03);
  wrong[0] = 0x08;
  assert.equal(incottFrameMatches(wrong, 0x85, 0x03), false);
});

test("0x83/0x06 decodes the active DPI STAGE INDEX, not a DPI value", () => {
  // Captured 2026-09-07 against the vendor tool: 09 83 06 01 -> stage 1 of 6.
  // Decoding byte 3 as an index into the six default presets used to yield
  // 800 DPI here, which matched the vendor UI only by coincidence.
  assert.equal(incottDecodeDpiStageIndex(frame(0x83, 0x06, 0x01)), 1);
  assert.equal(incottDecodeDpiStageIndex(frame(0x83, 0x06, 0x00)), 0);
  assert.equal(incottDecodeDpiStageIndex(frame(0x83, 0x06, 0x05)), 5);
});

test("DPI stage index returns null outside 0-5", () => {
  assert.equal(incottDecodeDpiStageIndex(frame(0x83, 0x06, 0x06)), null);
});

test("incottEncodeSetActiveDpiStage encodes 09 03 06 <idx> for every stage 0-5", () => {
  // Command 0x03, sub-command INCOTT_SUB_DPI_STAGE (0x06), then the stage
  // index — verified on hardware 2026-09-08 by selecting stages 0, 3, 5, then
  // 1 and reading each back correctly via 0x83/0x06.
  assert.deepEqual(bytes(incottEncodeSetActiveDpiStage(0)).slice(0, 3), [0x03, 0x06, 0x00]);
  assert.deepEqual(bytes(incottEncodeSetActiveDpiStage(1)).slice(0, 3), [0x03, 0x06, 0x01]);
  assert.deepEqual(bytes(incottEncodeSetActiveDpiStage(2)).slice(0, 3), [0x03, 0x06, 0x02]);
  assert.deepEqual(bytes(incottEncodeSetActiveDpiStage(3)).slice(0, 3), [0x03, 0x06, 0x03]);
  assert.deepEqual(bytes(incottEncodeSetActiveDpiStage(4)).slice(0, 3), [0x03, 0x06, 0x04]);
  assert.deepEqual(bytes(incottEncodeSetActiveDpiStage(5)).slice(0, 3), [0x03, 0x06, 0x05]);
});

test("incottEncodeSetActiveDpiStage rejects a stage index outside 0-5", () => {
  assert.throws(() => incottEncodeSetActiveDpiStage(6), RangeError);
  assert.throws(() => incottEncodeSetActiveDpiStage(-1), RangeError);
});

test("selecting the active stage (0x03) is byte-for-byte distinct from editing a stage's value (0x02) — the bug this driver used to have", () => {
  // THE BUG: setDpi() used to write the requested value into whichever stage
  // was active, so "select the 3200 stage" and "overwrite the active stage
  // with 3200" were conflated into one command. They are two different wire
  // commands with different opcodes and different payload shapes: the select
  // carries only a stage index (no DPI value at all), the edit carries a
  // 2-byte DPI wire value and no fixed sub-command byte.
  const select = incottEncodeSetActiveDpiStage(4);
  const edit = incottEncodeSetDpi(4, 3200);
  assert.notEqual(select[0], edit[0], "different command bytes (0x03 vs 0x02)");
  assert.deepEqual(bytes(select).slice(0, 3), [0x03, 0x06, 0x04]);
  assert.deepEqual(bytes(edit).slice(0, 4), [0x02, 0x04, 0x3f, 0x00]);
});

test("0x82/<stage> decodes all six DPI stage values, pinned to the real capture", () => {
  // Captured on real hardware 2026-09-08, reading each stage independently:
  //   09 82 00 -> 09 82 00 07 00 -> wire 0x07 -> 400 DPI
  //   09 82 01 -> 09 82 01 0f 00 -> wire 0x0f -> 800 DPI
  //   09 82 02 -> 09 82 02 1f 00 -> wire 0x1f -> 1600 DPI
  //   09 82 03 -> 09 82 03 2f 00 -> wire 0x2f -> 2400 DPI
  //   09 82 04 -> 09 82 04 3f 00 -> wire 0x3f -> 3200 DPI
  //   09 82 05 -> 09 82 05 7f 00 -> wire 0x7f -> 6400 DPI
  // Six independent points on `dpi = (wire + 1) * 50` — proof this is a
  // linear value, not an index. This opcode used to be undecoded
  // (`INCOTT_CMD_UNKNOWN_82`).
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x00, 0x07, 0x00), 0), 400);
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x01, 0x0f, 0x00), 1), 800);
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x02, 0x1f, 0x00), 2), 1600);
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x03, 0x2f, 0x00), 3), 2400);
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x04, 0x3f, 0x00), 4), 3200);
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x05, 0x7f, 0x00), 5), 6400);
});

test("0x82/<stage> round-trips a write of 25000 to stage 2 and a restore of 1600", () => {
  // Captured 2026-09-08: TX 09 02 02 f3 01 (wire 499 = 25000/50 - 1) read
  // back as RX 09 82 02 f3 01 -> exactly 25000, then TX 09 02 02 1f 00
  // (restoring 1600) read back as RX 09 82 02 1f 00 -> exactly 1600. Every
  // written value was restored on real hardware.
  assert.deepEqual(bytes(incottEncodeSetDpi(2, 25000)).slice(0, 4), [0x02, 0x02, 0xf3, 0x01]);
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x02, 0xf3, 0x01), 2), 25000);
  assert.deepEqual(bytes(incottEncodeSetDpi(2, 1600)).slice(0, 4), [0x02, 0x02, 0x1f, 0x00]);
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x02, 0x1f, 0x00), 2), 1600);
});

test("0x82/<stage> rejects a frame answering a different stage (sub-command echo)", () => {
  // Verified on hardware 2026-09-08: 09 82 03 replies 09 82 03 ... — 0x82
  // echoes its sub-command like 0x83/0x84/0x85/0x8e.
  assert.equal(incottDecodeDpiStage(frame(0x82, 0x03, 0x0f, 0x00), 1), null);
});

test("polling rate decodes wire values through the shared table", () => {
  assert.equal(incottDecodePollingRate(frame(0x81, 0x00)), 1000);
  assert.equal(incottDecodePollingRate(frame(0x81, 0x04)), 8000);
  assert.equal(incottDecodePollingRate(frame(0x81, 0x09)), null);
});

test("polling rate byte 2 follows a write, confirming the read on hardware 2026-09-08", () => {
  // Writing wire 1 (500 Hz) then wire 0 (1000 Hz) and reading back showed
  // byte 2 follow the write, 0 -> 1 -> 0 — confirming this is genuinely the
  // polling-rate byte and not a coincidence.
  assert.deepEqual(bytes(incottEncodeSetPollingRate(500)).slice(0, 2), [0x01, 0x01]);
  assert.equal(incottDecodePollingRate(frame(0x81, 0x01)), 500);
  assert.deepEqual(bytes(incottEncodeSetPollingRate(1000)).slice(0, 2), [0x01, 0x00]);
  assert.equal(incottDecodePollingRate(frame(0x81, 0x00)), 1000);
});

test("lift-off distance decodes from the high nibble of byte 7", () => {
  // Captured 2026-09-07: byte 7 = 0x01 -> high nibble 0 -> 1 mm.
  assert.equal(incottDecodeLiftOff(frame(0x84, 0x00, 0, 0, 0, 0, 0x01)), 10);
  assert.equal(incottDecodeLiftOff(frame(0x84, 0x00, 0, 0, 0, 0, 0x10)), 20);
  assert.equal(incottDecodeLiftOff(frame(0x84, 0x00, 0, 0, 0, 0, 0x20)), 7);
});

test("lift-off returns null for an unrecognized nibble", () => {
  assert.equal(incottDecodeLiftOff(frame(0x84, 0x00, 0, 0, 0, 0, 0x70)), null);
});

test("incottDecodeLiftOffDirect reads the symmetric 0x84/0x01 form and agrees with the packed nibble form", () => {
  // Verified on hardware 2026-09-08: hw 0, 1, 2 round-tripped identically
  // through both the symmetric single-purpose read (0x84/0x01 byte 3) and
  // the packed byte-7 high-nibble read (incottDecodeLiftOff) above.
  assert.equal(incottDecodeLiftOffDirect(frame(0x84, 0x01, 0x00)), 10);
  assert.equal(incottDecodeLiftOffDirect(frame(0x84, 0x01, 0x01)), 20);
  assert.equal(incottDecodeLiftOffDirect(frame(0x84, 0x01, 0x02)), 7);
  // Cross-check against the packed-nibble form for the same three values.
  assert.equal(incottDecodeLiftOffDirect(frame(0x84, 0x01, 0x00)), incottDecodeLiftOff(frame(0x84, 0x00, 0, 0, 0, 0, 0x00)));
  assert.equal(incottDecodeLiftOffDirect(frame(0x84, 0x01, 0x01)), incottDecodeLiftOff(frame(0x84, 0x00, 0, 0, 0, 0, 0x10)));
  assert.equal(incottDecodeLiftOffDirect(frame(0x84, 0x01, 0x02)), incottDecodeLiftOff(frame(0x84, 0x00, 0, 0, 0, 0, 0x20)));
});

test("incottDecodeLiftOffDirect rejects a frame with the wrong sub-command", () => {
  assert.equal(incottDecodeLiftOffDirect(frame(0x84, 0x02, 0x00)), null);
});

test("motion sync decodes from the low nibble of the same byte", () => {
  assert.equal(incottDecodeMotionSync(frame(0x84, 0x00, 0, 0, 0, 0, 0x01)), true);
  assert.equal(incottDecodeMotionSync(frame(0x84, 0x00, 0, 0, 0, 0, 0x00)), false);
  assert.equal(incottDecodeMotionSync(frame(0x84, 0x00, 0, 0, 0, 0, 0x20)), false);
});

test("motion sync via the symmetric 0x84/0x04 read (incottDecodeToggle) agrees with the packed nibble form", () => {
  // Verified on hardware 2026-09-08: 0/1/0 round-tripped identically through
  // both the symmetric read (0x84/0x04 byte 3, the driver's real read path)
  // and the packed byte-7 low-nibble read (incottDecodeMotionSync) above.
  assert.equal(incottDecodeToggle(frame(0x84, 0x04, 0x01), 0x04), true);
  assert.equal(incottDecodeToggle(frame(0x84, 0x04, 0x00), 0x04), false);
  assert.equal(incottDecodeToggle(frame(0x84, 0x04, 0x01), 0x04), incottDecodeMotionSync(frame(0x84, 0x00, 0, 0, 0, 0, 0x01)));
  assert.equal(incottDecodeToggle(frame(0x84, 0x04, 0x00), 0x04), incottDecodeMotionSync(frame(0x84, 0x00, 0, 0, 0, 0, 0x00)));
});

test("motion sync returns null for a nibble that is neither on nor off", () => {
  // 0x0f is a value the device has never been observed to send; it must not
  // be read as a confident "off" the way `false` would be.
  assert.equal(incottDecodeMotionSync(frame(0x84, 0x00, 0, 0, 0, 0, 0x0f)), null);
});

test("motion sync returns null when the frame does not match the sensor query", () => {
  assert.equal(incottDecodeMotionSync(frame(0x83, 0x00, 0, 0, 0, 0, 0x01)), null);
});

test("lift-off and motion sync return null on frames truncated before byte 7", () => {
  const truncated = new Uint8Array(7); // Only 7 bytes, no byte 7
  truncated[0] = 0x09;
  truncated[1] = 0x84;
  truncated[2] = 0x00;
  assert.equal(incottDecodeLiftOff(truncated), null);
  assert.equal(incottDecodeMotionSync(truncated), null);
});

test("toggles decode from byte 3", () => {
  assert.equal(incottDecodeToggle(frame(0x84, 0x03, 0x01)), true);
  assert.equal(incottDecodeToggle(frame(0x84, 0x03, 0x00)), false);
});

test("toggles return null for a value that is neither on nor off", () => {
  assert.equal(incottDecodeToggle(frame(0x84, 0x03, 0x7f)), null);
});

test("incottDecodeToggle rejects a stale frame with the wrong sub-command", () => {
  // Frame carries ripple-control (0x02), but angle-snap (0x03) was requested.
  const rippleFrame = frame(0x84, 0x02, 0x01);
  assert.equal(incottDecodeToggle(rippleFrame, 0x03), null);
  assert.equal(incottDecodeToggle(rippleFrame, 0x02), true);
});

test("debounce decodes within range and rejects impossible values", () => {
  assert.equal(incottDecodeDebounce(frame(0x85, 0x01, 0x04)), 4);
  assert.equal(incottDecodeDebounce(frame(0x85, 0x01, 0x00)), 0);
  assert.equal(incottDecodeDebounce(frame(0x85, 0x01, 0x1e)), 30);
  assert.equal(incottDecodeDebounce(frame(0x85, 0x01, 0x1f)), null);
});

test("sleep decodes a little-endian uint16", () => {
  // Captured 2026-09-07: 3c 00 -> 60 seconds.
  assert.equal(incottDecodeSleep(frame(0x85, 0x03, 0x3c, 0x00)), 60);
  assert.equal(incottDecodeSleep(frame(0x85, 0x03, 0x84, 0x03)), 900);
});

test("sleep returns null outside the device's range", () => {
  assert.equal(incottDecodeSleep(frame(0x85, 0x03, 0x00, 0x00)), null);
  assert.equal(incottDecodeSleep(frame(0x85, 0x03, 0x85, 0x03)), null);
});

test("incottDecodeSleep returns null on frames truncated before byte 4", () => {
  const truncated = new Uint8Array(4); // Only 4 bytes, no byte 4
  truncated[0] = 0x09;
  truncated[1] = 0x85;
  truncated[2] = 0x03;
  truncated[3] = 0x3c;
  assert.equal(incottDecodeSleep(truncated), null);
});

test("receiver LED decodes from byte 2 and bounds the mode", () => {
  assert.equal(incottDecodeReceiverLed(frame(0x88, 0x00)), 0);
  assert.equal(incottDecodeReceiverLed(frame(0x88, 0x02)), 2);
  assert.equal(incottDecodeReceiverLed(frame(0x88, 0x03)), null);
});

test("battery decodes byte 6 of the 0x8e/0x01 response, verified against the vendor tool", () => {
  // Captured 2026-09-07 by instrumenting incott.net/mouse/:
  //   TX 09 8e 01 -> RX 09 8e 01 5a 04 84 38 01 00, byte 6 = 0x38 = 56.
  // The vendor UI showed "60%" for this exact reading because its own
  // display rounds to the nearest 10% (confirmed by the person who captured
  // it) — 56 is the real, exact value.
  assert.equal(incottDecodeBattery(frame(0x8e, 0x01, 0x5a, 0x04, 0x84, 0x38, 0x01, 0x00)), 56);
  assert.equal(incottDecodeBattery(frame(0x8e, 0x01, 0, 0, 0, 0x64, 0, 0)), 100);
});

test("battery returns null for a percentage that cannot be real, or a mismatched sub-command", () => {
  assert.equal(incottDecodeBattery(frame(0x8e, 0x01, 0, 0, 0, 0x65, 0, 0)), null);
  // 0x8e answers only on sub-command 0x01 — an earlier opcode sweep that only
  // ever tried sub 0x00 concluded (wrongly) that 0x8e never answers at all.
  assert.equal(incottDecodeBattery(frame(0x8e, 0x00, 0, 0, 0, 0x38, 0, 0)), null);
});

test("battery no longer decodes 0x89 byte 8, the disproven constant-0x5a hypothesis", () => {
  // 09 89 00 00 00 00 00 00 5a read 0x5a (90) on every capture ever taken, in
  // every device state — proof it is a constant, not a battery reading. See
  // docs/incott-testing.md.
  assert.equal(incottDecodeBattery(frame(0x89, 0, 0, 0, 0, 0, 0, 0x5a)), null);
});

// ---------------------------------------------------------------------------
// incottDecodeInputStatus — the mouse's UNSOLICITED input report (report id
// 0x09, but NOT a feature-report reply). This is what battery is genuinely
// read from as of 2026-09-08: the 0x8e/byte-6 and 0x89/byte-8 hypotheses
// above are BOTH disproven (a full charge cycle left 0x8e's byte 6 completely
// unchanged), so `incottDecodeBattery` above is kept as a codec/regression
// fixture only and is no longer how the driver reports battery.
//
// Byte-index convention for this function: `byte0`/`byte1` EXCLUDE the report
// id, matching WebHID's `inputreport` event (`event.data` excludes it,
// `event.reportId` carries it separately) — the same convention every
// `incottEncode*` function in this module already uses for outgoing feature
// reports. The two hex captures below were taken with node-hid, whose raw
// buffer INCLUDES the report id at index 0, so node-hid buf[1] is this
// function's byte0 and buf[2] is byte1.
// ---------------------------------------------------------------------------

test("input-report battery: discharging capture 0x5f decodes to 95%, not charging", () => {
  // Captured 2026-09-08, node-hid: 09 5f 10 04 00 0f 0f 10
  // node-hid buf[1] = 0x5f = 95 -> this function's byte0.
  const status = incottDecodeInputStatus(0x5f, 0x10);
  assert.deepEqual(status, { batteryPercent: 95, charging: false, dpiStageIndex: 1, pollingIndex: 0 });
});

test("input-report battery: charging capture 0xe1 decodes to 97%, charging", () => {
  // Captured 2026-09-08, node-hid: 09 e1 10 04 00 0f 0f 10
  // node-hid buf[1] = 0xe1 = 225 -> byte0. 225 > 100, so charging; 225 - 128 = 97.
  const status = incottDecodeInputStatus(0xe1, 0x10);
  assert.deepEqual(status, { batteryPercent: 97, charging: true, dpiStageIndex: 1, pollingIndex: 0 });
});

test("input-report byte 1 (0x10) decodes to DPI stage 1 and polling index 0, corroborating the feature reads", () => {
  // On the unit under test, both nibbles of the captured byte 2 (this
  // function's byte1) independently matched what the feature reads returned
  // at the same moment: 09 83 06 -> stage 1, 09 81 byte 2 -> 0.
  const status = incottDecodeInputStatus(0x5f, 0x10);
  assert.equal(status?.dpiStageIndex, 1);
  assert.equal(status?.pollingIndex, 0);
});

test("input-report decode rejects a percentage that would fall outside 0-100 once the charging offset is applied", () => {
  // byte0 = 101 is "charging" (>100) but 101 - 128 is negative — not a real
  // percentage, so this must be null rather than a fabricated negative value.
  assert.equal(incottDecodeInputStatus(101, 0x00), null);
});

test("input-report decode rejects out-of-byte-range inputs", () => {
  assert.equal(incottDecodeInputStatus(-1, 0x00), null);
  assert.equal(incottDecodeInputStatus(256, 0x00), null);
  assert.equal(incottDecodeInputStatus(0x00, 256), null);
});

test("button binding encodes the raw three-byte payload under command 0x06", () => {
  // Captured 2026-09-08: the vendor tool wrote `09 06 00 01 00 f0` to button
  // 0. This is a codec for the raw bytes only — see incottEncodeSetButtonBinding.
  assert.deepEqual(bytes(incottEncodeSetButtonBinding(0, [0x01, 0x00, 0xf0])).slice(0, 5), [0x06, 0x00, 0x01, 0x00, 0xf0]);
});

test("button binding rejects a button index outside 0-5", () => {
  assert.throws(() => incottEncodeSetButtonBinding(6, [0, 0, 0]), RangeError);
  assert.throws(() => incottEncodeSetButtonBinding(-1, [0, 0, 0]), RangeError);
});

test("button binding decodes all six buttons, pinned to the real capture", () => {
  // Captured on real hardware 2026-09-08, reading each of the six buttons
  // (left, right, middle, forward, back, DPI, in some physical order):
  //   09 86 00 -> bytes 3-5 = 01 00 f0
  //   09 86 01 -> bytes 3-5 = 01 00 f1
  //   09 86 02 -> bytes 3-5 = 01 00 f2
  //   09 86 03 -> bytes 3-5 = 01 00 f3
  //   09 86 04 -> bytes 3-5 = 01 00 f4
  //   09 86 05 -> bytes 3-5 = 07 00 03
  // Button 0's read-back matches byte-for-byte what the vendor tool wrote
  // (`09 06 00 01 00 f0`) — the round-trip proof this codec is correct.
  assert.deepEqual(incottDecodeButtonBinding(frame(0x86, 0x00, 0x01, 0x00, 0xf0), 0), { button: 0, b0: 0x01, b1: 0x00, b2: 0xf0 });
  assert.deepEqual(incottDecodeButtonBinding(frame(0x86, 0x01, 0x01, 0x00, 0xf1), 1), { button: 1, b0: 0x01, b1: 0x00, b2: 0xf1 });
  assert.deepEqual(incottDecodeButtonBinding(frame(0x86, 0x02, 0x01, 0x00, 0xf2), 2), { button: 2, b0: 0x01, b1: 0x00, b2: 0xf2 });
  assert.deepEqual(incottDecodeButtonBinding(frame(0x86, 0x03, 0x01, 0x00, 0xf3), 3), { button: 3, b0: 0x01, b1: 0x00, b2: 0xf3 });
  assert.deepEqual(incottDecodeButtonBinding(frame(0x86, 0x04, 0x01, 0x00, 0xf4), 4), { button: 4, b0: 0x01, b1: 0x00, b2: 0xf4 });
  assert.deepEqual(incottDecodeButtonBinding(frame(0x86, 0x05, 0x07, 0x00, 0x03), 5), { button: 5, b0: 0x07, b1: 0x00, b2: 0x03 });
});

test("button binding rejects a frame answering a different button (sub-command echo)", () => {
  assert.equal(incottDecodeButtonBinding(frame(0x86, 0x02, 0x01, 0x00, 0xf2), 0), null);
});

test("button binding returns null on a frame truncated before byte 5", () => {
  const truncated = new Uint8Array(5); // Only 5 bytes, no byte 5
  truncated[0] = 0x09;
  truncated[1] = 0x86;
  truncated[2] = 0x00;
  assert.equal(incottDecodeButtonBinding(truncated, 0), null);
});

test("identity returns the raw payload for display", () => {
  // Captured 2026-09-07: 09 8f 01 0e 02 f0 f1 00 ff.
  const identity = incottDecodeIdentity(frame(0x8f, 0x01, 0x0e, 0x02, 0xf0, 0xf1, 0x00, 0xff));
  assert.equal(identity?.raw, "01 0e 02 f0 f1 00 ff");
});

test("identity returns null when the frame is not an identity response", () => {
  assert.equal(incottDecodeIdentity(frame(0x84, 0x00)), null);
});

test("incottIsWiredProduct is true only for the wired product id (0x622C), hardware-verified 2026-09-08", () => {
  assert.equal(incottIsWiredProduct(INCOTT_PRODUCT_ID_WIRED), true);
  assert.equal(incottIsWiredProduct(INCOTT_PRODUCT_ID), false);
});

test("INCOTT_POLLING_STEPS_HZ_WIRED is the hardware-verified 1000 Hz wired ceiling, a strict subset of the wireless ladder", () => {
  assert.deepEqual(INCOTT_POLLING_STEPS_HZ_WIRED, [125, 250, 500, 1000]);
  for (const hz of INCOTT_POLLING_STEPS_HZ_WIRED) {
    assert.equal(INCOTT_POLLING_STEPS_HZ.includes(hz), true);
  }
  assert.equal(INCOTT_POLLING_STEPS_HZ.includes(8000), true, "8000 Hz stays wireless-only");
  assert.equal(INCOTT_POLLING_STEPS_HZ_WIRED.includes(8000), false);
});

test("incottNormalizeProductName strips a leading 'incott' and trailing 'mouse'", () => {
  // The real model name is only present in the wired product string —
  // hardware-verified 2026-09-08.
  assert.equal(incottNormalizeProductName("incott Esports G23V2Pro mouse"), "Esports G23V2Pro");
  // The wireless dongle's string is generic; normalizing it does not invent
  // a model, it only tidies the same generic words.
  assert.equal(incottNormalizeProductName("incott 8K wireless mouse"), "8K wireless");
});

test("incottNormalizeProductName leaves a string with neither word untouched", () => {
  assert.equal(incottNormalizeProductName("G23V2Pro"), "G23V2Pro");
});

test("incottNormalizeProductName is case-insensitive on both stripped words", () => {
  assert.equal(incottNormalizeProductName("Incott Esports G23V2Pro Mouse"), "Esports G23V2Pro");
});

test("incottNormalizeProductName falls back to the raw string rather than return an empty name", () => {
  assert.equal(incottNormalizeProductName("incott mouse"), "incott mouse");
  assert.equal(incottNormalizeProductName(""), "");
});

test("incottNormalizeProductName does not strip 'mouse' or 'incott' from the middle of the string", () => {
  assert.equal(incottNormalizeProductName("incott Field mouse Edition mouse"), "Field mouse Edition");
});

test("incottLiftOffLabel and incottLiftOffTenths round-trip the three stops", () => {
  assert.equal(incottLiftOffLabel(7), "Low");
  assert.equal(incottLiftOffLabel(10), "Medium");
  assert.equal(incottLiftOffLabel(20), "High");
  assert.equal(incottLiftOffLabel(15), null);
  assert.equal(incottLiftOffTenths("Low"), 7);
  assert.equal(incottLiftOffTenths("Medium"), 10);
  assert.equal(incottLiftOffTenths("High"), 20);
});

test("performance mode writes the raw 0-2 value captured from the vendor tool", () => {
  // Captured 2026-09-07 as the owner switched the vendor tool's Performance
  // mode control: TX 09 04 05 02 and TX 09 04 05 01. Which label (HP / Corded
  // / LP) produced which value is UNVERIFIED — only the raw writes exist.
  assert.deepEqual(bytes(incottEncodeSetPerformanceMode(2)).slice(0, 3), [0x04, 0x05, 0x02]);
  assert.deepEqual(bytes(incottEncodeSetPerformanceMode(1)).slice(0, 3), [0x04, 0x05, 0x01]);
  assert.deepEqual(bytes(incottEncodeSetPerformanceMode(0)).slice(0, 3), [0x04, 0x05, 0x00]);
});

test("performance mode rejects a value outside 0-2", () => {
  assert.throws(() => incottEncodeSetPerformanceMode(3), RangeError);
  assert.throws(() => incottEncodeSetPerformanceMode(-1), RangeError);
});

test("performance mode decodes byte 3 of the 0x84/0x05 response (unverified: never captured on hardware)", () => {
  assert.equal(incottDecodePerformanceMode(frame(0x84, 0x05, 0x01)), 1);
  assert.equal(incottDecodePerformanceMode(frame(0x84, 0x05, 0x02)), 2);
  assert.equal(incottDecodePerformanceMode(frame(0x84, 0x05, 0x03)), null);
  // Wrong sub-command: must not be read as a performance-mode reply.
  assert.equal(incottDecodePerformanceMode(frame(0x84, 0x03, 0x01)), null);
});
