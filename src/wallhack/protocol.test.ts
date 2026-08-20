import assert from "node:assert/strict";
import test from "node:test";

import {
  wallhackBuildRead,
  wallhackBuildSetDpiStage,
  wallhackBuildSimple,
  wallhackBuildWrite,
  wallhackDecodeBattery,
  wallhackDecodeVersions,
  wallhackIsReplyFor,
  wallhackLodFromCode,
  wallhackLodToCode,
  wallhackPollingHzToRank,
  wallhackPollingRankToHz,
  wallhackReadByte,
  wallhackReadDpi,
  wallhackResponseAddress,
  WALLHACK_COMMAND,
  WALLHACK_FLASH,
  WALLHACK_REPORT_LENGTH,
} from "./index.ts";

test("simple command frames as [0,0,cmd] padded to 63 bytes", () => {
  const packet = wallhackBuildSimple(WALLHACK_COMMAND.readVersion);
  assert.equal(packet.length, WALLHACK_REPORT_LENGTH);
  assert.deepEqual([...packet.subarray(0, 3)], [0, 0, 0xbc]);
  assert.ok(packet.subarray(3).every((byte) => byte === 0));
});

test("function-area read frames the command, count and little-endian address", () => {
  const packet = wallhackBuildRead(WALLHACK_FLASH.silentHeight, 1);
  assert.deepEqual(
    [...packet.subarray(0, 7)],
    [0, 0, WALLHACK_COMMAND.readFunctionArea, 1, WALLHACK_FLASH.silentHeight, 0, 0],
  );
});

test("function-area write carries the payload after the 7-byte header", () => {
  const packet = wallhackBuildWrite(WALLHACK_FLASH.motionSyncEnable, [1]);
  assert.deepEqual(
    [...packet.subarray(0, 8)],
    [0, 0, WALLHACK_COMMAND.writeFunctionArea, 1, WALLHACK_FLASH.motionSyncEnable, 0, 0, 1],
  );
});

test("a two-byte address splits low/high", () => {
  const packet = wallhackBuildRead(0x0110, 2);
  assert.equal(packet[4], 0x10);
  assert.equal(packet[5], 0x01);
});

test("DPI stage write stores the value little-endian inside the record", () => {
  const packet = wallhackBuildSetDpiStage(1600);
  // header: write, base = dpi8Block; payload begins at byte 7
  assert.equal(packet[2], WALLHACK_COMMAND.writeFunctionArea);
  assert.equal(packet[4], WALLHACK_FLASH.dpi8Block);
  // payload = [enabled, 0, dpiLo, dpiHi, 0x90, 1, 0xff, 0xff, 0]
  assert.equal(packet[7], 1);
  assert.equal(packet[9], 1600 & 0xff);
  assert.equal(packet[10], (1600 >> 8) & 0xff);
});

test("reply matching keys on the echoed command byte", () => {
  assert.ok(wallhackIsReplyFor(new Uint8Array([0, 0, 0xbc]), WALLHACK_COMMAND.readVersion));
  assert.ok(!wallhackIsReplyFor(new Uint8Array([0, 0, 0xa4]), WALLHACK_COMMAND.readVersion));
});

test("response address echoes bytes 4-5 little-endian", () => {
  assert.equal(wallhackResponseAddress(new Uint8Array([0, 0, 0xa4, 1, 0x6e, 0x00, 0])), 0x6e);
});

test("single-byte config read returns byte 7", () => {
  const response = new Uint8Array([0, 0, 0xa4, 1, WALLHACK_FLASH.silentHeight, 0, 0, 2]);
  assert.equal(wallhackReadByte(response), 2);
});

test("DPI read decodes bytes 9-10 little-endian", () => {
  const response = new Uint8Array([0, 0, 0xa4, 9, WALLHACK_FLASH.dpi8Block, 0, 0, 1, 0, 0x40, 0x06]);
  assert.equal(wallhackReadDpi(response), 1600);
});

test("version reply decodes three big-endian firmwares", () => {
  const response = new Uint8Array([0, 0, 0xbc, 0, 0, 0, 0, 1, 4, 2, 13, 0, 9]);
  assert.deepEqual(wallhackDecodeVersions(response), { mouse: "1.4", dongle: "2.13", nxp: "0.9" });
});

test("version reply shorter than 13 bytes is unknown", () => {
  assert.equal(wallhackDecodeVersions(new Uint8Array([0, 0, 0xbc, 0, 0, 0, 0, 1])), null);
});

test("battery reply reads percent at 7 and charging at 8", () => {
  assert.deepEqual(wallhackDecodeBattery(new Uint8Array([0, 0, 0xba, 0, 0, 0, 0, 82, 1])), {
    percent: 82,
    charging: true,
  });
  // out-of-range percent is treated as unknown
  assert.deepEqual(wallhackDecodeBattery(new Uint8Array([0, 0, 0xba, 0, 0, 0, 0, 200, 0])), {
    percent: null,
    charging: false,
  });
});

test("polling rank/Hz round-trips through the Z1 table", () => {
  assert.equal(wallhackPollingRankToHz(3), 1000);
  assert.equal(wallhackPollingRankToHz(17), 8000);
  assert.equal(wallhackPollingRankToHz(99), null);
  assert.equal(wallhackPollingHzToRank(1000), 3);
  assert.equal(wallhackPollingHzToRank(8000), 17);
  assert.equal(wallhackPollingHzToRank(1234), null);
});

test("lift-off code maps to the three-stop LOD and back", () => {
  assert.equal(wallhackLodFromCode(0), "Low");
  assert.equal(wallhackLodFromCode(1), "Medium");
  assert.equal(wallhackLodFromCode(2), "High");
  assert.equal(wallhackLodFromCode(9), null);
  assert.equal(wallhackLodToCode("Low"), 0);
  assert.equal(wallhackLodToCode("High"), 2);
});
