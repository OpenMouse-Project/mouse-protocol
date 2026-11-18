import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeInstantConfig,
  decodeInstantReadByte,
  decodeInstantStatus,
  INSTANT_CONFIG,
  INSTANT_DPI_GEARS,
  INSTANT_REPORT_ID,
  instantBlockReadByteFrame,
  instantBlockReadFrames,
  instantBlockWriteFrames,
  instantDpiFrames,
  instantDpiGearIndex,
  instantFrame,
  instantModeFrames,
} from "./protocol.ts";

function hex(frame: Uint8Array): string {
  return Buffer.from(frame).toString("hex");
}

test("instantFrame pads to an 8-byte report 7 frame", () => {
  assert.equal(hex(instantFrame(0x18, [0x03, 0])), "0718030000000000");
  assert.equal(instantFrame(0x18).length, 8);
  assert.equal(instantFrame(0x18)[0], INSTANT_REPORT_ID);
  assert.throws(() => instantFrame(0x18, [1, 2, 3, 4, 5, 6, 7]), RangeError);
});

test("block write matches the vendor's captured Apply frames", () => {
  const frames = instantBlockWriteFrames(0x0000, [0x5a, 0x03]);
  assert.deepEqual(frames.map(hex), [
    "0718030000005a01",
    "0718030100000301",
    "0718090000000001",
    "0718000000000000",
  ]);
  const high = instantBlockWriteFrames(0x003a, [0x0b]);
  assert.equal(hex(high[0]!), "071803003a000b00");
  assert.equal(hex(high[1]!), "071809003a000000");
});

test("block read uses little-endian addresses and a final commit", () => {
  const frames = instantBlockReadFrames(0x003a, 2);
  assert.equal(frames.length, 3);
  assert.equal(hex(frames[0]!), "071803003a000001");
  assert.equal(hex(frames[1]!), "071803013a000001");
  assert.equal(hex(frames[2]!), "071800003a000000");
  assert.equal(hex(instantBlockReadByteFrame(0x003a, 1, 2)), "071805013a000001");
  assert.equal(decodeInstantReadByte(new Uint8Array([0x07, 0x0b])), 0x0b);
  assert.equal(decodeInstantReadByte(new Uint8Array([0x07])), null);
});

test("DPI frames match the vendor's 0x12 encoding", () => {
  assert.deepEqual(instantDpiFrames(800).map(hex), [
    "0712640000000000",
    "0711000000000000",
  ]);
  assert.deepEqual(instantDpiFrames(1600, 1).map(hex), [
    "0712006400000000",
    "0711000000000000",
  ]);
  assert.throws(() => instantDpiFrames(300, 1), RangeError);
  assert.throws(() => instantDpiFrames(123), RangeError);
});

test("mode frames enter and leave block mode", () => {
  assert.equal(hex(instantModeFrames(true)[0]!), "0718100000000000");
  assert.equal(hex(instantModeFrames(false)[0]!), "0718000000000000");
});

test("config decode keeps the lighting byte raw", () => {
  // Ghidra: 0x3A packs light_direction/light_symmetry, not the polling rate.
  const config = decodeInstantConfig(new Uint8Array([...new Uint8Array(0x3a), 0x0b]));
  assert.equal(config.lightingDirectionByte, 0x0b);
  assert.equal(config.bytes[0x3a], 0x0b);
});

test("DPI table is the vendor's 23-value table", () => {
  assert.equal(INSTANT_DPI_GEARS.length, 23);
  assert.equal(instantDpiGearIndex(200), 1);
  assert.equal(instantDpiGearIndex(12800), 23);
  assert.equal(instantDpiGearIndex(300), null);
});

test("status decode keeps the vendor block markers", () => {
  const report = new Uint8Array([
    0x07, 0x00, 0x54, 0x09, 0x27, 0x00, 0x03, 0xcb, 0x11, 0x02, 0x00, 0x26,
    0x06, 0x00, 0x00, 0x10, 0x24, 0x5a, 0xa5, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.deepEqual(decodeInstantStatus(report), {
    firmware: 0x0954,
    state: 0x00,
    sensorCpi: 0x0626,
    magicOk: true,
  });
  assert.equal(decodeInstantStatus(new Uint8Array(8)), null);
  const broken = report.slice();
  broken[16] = 0x00;
  assert.equal(decodeInstantStatus(broken)?.magicOk, false);
});

test("config address map is the vendor's Apply layout", () => {
  assert.deepEqual(INSTANT_CONFIG, {
    header: 0x0000,
    keymap: 0x0007,
    stageEnable: 0x001c,
    stageColorsA: 0x0020,
    stageColorsB: 0x0028,
    sensor: 0x0030,
    lightingDirection: 0x003a,
    lighting: 0x003e,
    trailer: 0x0f80,
  });
});
