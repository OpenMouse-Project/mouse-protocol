import assert from "node:assert/strict";
import test from "node:test";

import {
  wallhackBindingFromLabel,
  wallhackBindingLabel,
  wallhackBuildCustomCurveWrite,
  wallhackBuildCurveRead,
  wallhackBuildGetKeys,
  wallhackBuildGetMacro,
  wallhackBuildRead,
  wallhackBuildSetDpiStage,
  wallhackBuildSetKeys,
  wallhackBuildSetMacro,
  wallhackBuildSimple,
  wallhackBuildWrite,
  wallhackCurveStatusText,
  wallhackDecodeBattery,
  wallhackDecodeCustomCurve,
  wallhackDecodeKeysReply,
  wallhackDecodeMacro,
  wallhackDecodePresetCurve,
  wallhackDecodeTriplet,
  wallhackDecodeVersions,
  wallhackEncodeBinding,
  wallhackEncodeMacro,
  wallhackIsReplyFor,
  wallhackLodFromCode,
  wallhackLodToCode,
  wallhackMacroReplyBytes,
  wallhackMacroWriteBlocks,
  wallhackPollingHzToRank,
  wallhackPollingRankToHz,
  wallhackRawToSensorAngle,
  wallhackReadByte,
  wallhackReadDpi,
  wallhackResponseAddress,
  wallhackScanningModeFromByte,
  wallhackScanningModeToByte,
  wallhackSensorAngleToRaw,
  wallhackTripletsEqual,
  wallhackValidateCurve,
  WALLHACK_COMMAND,
  WALLHACK_CURVE_ADDRESS,
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

test("sensor angle stores degrees+30 with range checks", () => {
  assert.equal(wallhackSensorAngleToRaw(0), 30);
  assert.equal(wallhackSensorAngleToRaw(-30), 0);
  assert.equal(wallhackSensorAngleToRaw(30), 60);
  assert.equal(wallhackRawToSensorAngle(22), -8);
  assert.equal(wallhackRawToSensorAngle(61), null);
  assert.throws(() => wallhackSensorAngleToRaw(31), /-30\.\.\+30/);
  assert.throws(() => wallhackSensorAngleToRaw(0.5), /-30\.\.\+30/);
});

test("scanning mode maps HIGH/ACCEL to 0/1", () => {
  assert.equal(wallhackScanningModeToByte("HIGH"), 0);
  assert.equal(wallhackScanningModeToByte("ACCEL"), 1);
  assert.equal(wallhackScanningModeFromByte(0), "HIGH");
  assert.equal(wallhackScanningModeFromByte(1), "ACCEL");
  assert.equal(wallhackScanningModeFromByte(2), null);
});

test("curve validation enforces 5 points, speed order and gain steps", () => {
  const ok = [
    { speed: 0, gain: 1 }, { speed: 70, gain: 1.2 }, { speed: 140, gain: 1.4 },
    { speed: 210, gain: 1.6 }, { speed: 280, gain: 2 },
  ];
  assert.equal(wallhackValidateCurve(ok), null);
  assert.match(wallhackValidateCurve(ok.slice(0, 4))!, /exactly 5 points/);
  assert.match(wallhackValidateCurve([{ ...ok[0]! }, { ...ok[1]!, speed: 0 }, ...ok.slice(2)])!, /strictly increasing/);
  assert.match(wallhackValidateCurve(ok.map((p, i) => (i === 4 ? { ...p, speed: 281 } : p)))!, /0\.\.280/);
  assert.match(wallhackValidateCurve(ok.map((p, i) => (i === 0 ? { ...p, gain: 1.005 } : p)))!, /multiple of 0.01/);
  assert.match(wallhackValidateCurve(ok.map((p, i) => (i === 0 ? { ...p, gain: 6.01 } : p)))!, /0.10\.\.6.00/);
});

test("curve reads target the per-mode tables and custom writes encode u16LE", () => {
  const read = wallhackBuildCurveRead("natural");
  assert.deepEqual([...read.subarray(0, 6)], [0, 0, WALLHACK_COMMAND.readFunctionArea, 10, 0x8a, 0x02]);
  assert.equal(WALLHACK_CURVE_ADDRESS.natural, 650);
  const points = [
    { speed: 0, gain: 1 }, { speed: 70, gain: 1 }, { speed: 140, gain: 1 },
    { speed: 210, gain: 1 }, { speed: 280, gain: 1 },
  ];
  const write = wallhackBuildCustomCurveWrite(points);
  assert.deepEqual([...write.subarray(0, 7)], [0, 0, WALLHACK_COMMAND.writeFunctionArea, 20, 0x9e, 0x02, 0]);
  assert.deepEqual([...write.subarray(7, 15)], [0, 0, 100, 0, 70, 0, 100, 0]);
  // preset payload: speed u8 + gain*100 u8 per point
  assert.deepEqual(
    wallhackDecodePresetCurve(new Uint8Array([0, 100, 20, 110, 40, 120, 70, 135, 100, 150])),
    [
      { speed: 0, gain: 1 }, { speed: 20, gain: 1.1 }, { speed: 40, gain: 1.2 },
      { speed: 70, gain: 1.35 }, { speed: 100, gain: 1.5 },
    ],
  );
  // custom payload round-trips through the writer
  const payload = write.subarray(7, 27);
  assert.deepEqual(wallhackDecodeCustomCurve(payload), points);
  assert.equal(wallhackDecodePresetCurve(new Uint8Array(4)), null);
  assert.equal(wallhackCurveStatusText(new Uint8Array([0, 0, 0xa4, 0, 0, 0, 2])), "the mouse rejected the curve as invalid (speed ≤ 280, gain 0.10–6.00, speeds strictly increasing)");
  assert.equal(wallhackCurveStatusText(new Uint8Array([0, 0, 0xa4, 0, 0, 0, 0])), "ok");
});

test("button triplets encode and decode every binding kind", () => {
  const cases = [
    { kind: "disabled" },
    { kind: "mouseButton", button: "back" },
    { kind: "key", modifiers: 2, hidUsage: 4 },
    { kind: "dpi", op: "loop" },
    { kind: "system", action: "sleep" },
    { kind: "media", action: "playPause" },
    { kind: "rapidFire", intervalMs: 100, clickCount: 5 },
    { kind: "macro", macroNumber: 1, stop: { mode: "toggle" } },
  ] as const;
  for (const binding of cases) {
    assert.deepEqual(wallhackDecodeTriplet(wallhackEncodeBinding(binding as never)), binding);
  }
  // legacy/alternate keyTypes decode too
  assert.deepEqual(wallhackDecodeTriplet({ keyType: 1, codeL: 3, codeH: 0 }), { kind: "mouseButton", button: "right" });
  assert.deepEqual(wallhackDecodeTriplet({ keyType: 7, codeL: 0, codeH: 30 }), { kind: "key", modifiers: 0, hidUsage: 30 });
  assert.deepEqual(wallhackDecodeTriplet({ keyType: 4, codeL: 1, codeH: 0 }), { kind: "dpi", op: "increment" });
  assert.deepEqual(wallhackDecodeTriplet({ keyType: 11, codeL: 2, codeH: 1 }), {
    kind: "macro",
    macroNumber: 2,
    stop: { mode: "finishCycleOnRelease" },
  });
  assert.deepEqual(wallhackDecodeTriplet({ keyType: 99, codeL: 1, codeH: 2 }), {
    kind: "unknown",
    triplet: { keyType: 99, codeL: 1, codeH: 2 },
  });
  assert.throws(() => wallhackEncodeBinding({ kind: "mouseButton", button: "wheel" }), /Unknown WALLHACK mouse button/);
});

test("GET_KEYS reads 8 triplets and SET_KEYS writes at the triplet offset", () => {
  const read = wallhackBuildGetKeys();
  assert.deepEqual([...read.subarray(0, 7)], [0, 0, WALLHACK_COMMAND.getKeys, 24, 0, 0, 0]);
  const reply = new Uint8Array([0, 0, WALLHACK_COMMAND.getKeys, 6, 0, 0, 0, 16, 1, 0, 16, 2, 0]);
  assert.deepEqual(wallhackDecodeKeysReply(reply), [
    { keyType: 16, codeL: 1, codeH: 0 },
    { keyType: 16, codeL: 2, codeH: 0 },
  ]);
  const write = wallhackBuildSetKeys([{ keyType: 19, codeL: 3, codeH: 0 }], 9);
  assert.deepEqual([...write.subarray(0, 8)], [0, 0, WALLHACK_COMMAND.setKeys, 3, 9, 0, 0, 19]);
  assert.ok(wallhackTripletsEqual({ keyType: 19, codeL: 3, codeH: 0 }, { keyType: 19, codeL: 3, codeH: 0 }));
  assert.equal(wallhackDecodeKeysReply(new Uint8Array(4)), null);
});

test("button labels round-trip through the remapper forms", () => {
  const labels = [
    "Disabled", "Left Click", "Back", "DPI +", "DPI -", "DPI Cycle", "Sleep",
    "Play / Pause", "Volume -", "Macro 1", "Macro 2 Toggle", "Rapid Fire 100ms x5",
    "Key 4", "Key 4 +2", "Unknown (99,1,2)",
  ];
  for (const label of labels) {
    assert.equal(wallhackBindingLabel(wallhackBindingFromLabel(label)), label);
  }
  assert.throws(() => wallhackBindingFromLabel("Hyper Click"), /Unknown button action/);
  assert.throws(() => wallhackBindingFromLabel("Macro 9"), /Unknown button action/);
});

test("macro records encode steps and decode back", () => {
  const steps = [
    { delayMs: 10, event: { type: "keyDown", hidUsage: 4 } },
    { delayMs: 20, event: { type: "keyUp", hidUsage: 4 } },
    { delayMs: 5, event: { type: "keyDown", hidUsage: 225 } },
    { delayMs: 0, event: { type: "buttonDown", button: "left" } },
    { delayMs: 0, event: { type: "buttonUp", button: "left" } },
    { delayMs: 100, event: { type: "wheel", direction: "up" } },
    { delayMs: 0, event: { type: "wheelReset" } },
    { delayMs: 16, event: { type: "move", axis: "x", delta: -10 } },
  ] as const;
  const record = wallhackEncodeMacro(steps.map((s) => ({ delayMs: s.delayMs, event: { ...s.event } })));
  assert.equal(record[0], 8);
  const decoded = wallhackDecodeMacro(record)!;
  assert.equal(decoded.length, 8);
  assert.deepEqual(decoded[0], { delayMs: 10, event: { type: "keyDown", hidUsage: 4 } });
  assert.deepEqual(decoded[2], { delayMs: 5, event: { type: "keyDown", hidUsage: 225 } });
  assert.deepEqual(decoded[5], { delayMs: 100, event: { type: "wheel", direction: "up" } });
  assert.deepEqual(decoded[7], { delayMs: 16, event: { type: "move", axis: "x", delta: -10 } });
  assert.throws(() => wallhackEncodeMacro(Array.from({ length: 31 }, () => ({ delayMs: 0, event: { type: "wheelReset" as const } }))), /holds 30/);
  assert.equal(wallhackDecodeMacro(new Uint8Array(2)), null);
});

test("macro write blocks allocate aligned storage and clear by index", () => {
  const record = wallhackEncodeMacro([{ delayMs: 1, event: { type: "keyDown", hidUsage: 4 } }]);
  const blocks = wallhackMacroWriteBlocks(1, record, new Map());
  assert.deepEqual(blocks[0], { offset: 16 + 1 * 2, bytes: [32, 0] });
  assert.equal(blocks[1]!.offset, 32);
  // reusing a fitting address keeps it
  const again = wallhackMacroWriteBlocks(1, record, new Map([[1, 64]]));
  assert.equal(again[1]!.offset, 64);
  // clearing emits only the zeroed index write
  assert.deepEqual(wallhackMacroWriteBlocks(2, new Uint8Array(0), new Map([[2, 64]])), [
    { offset: 20, bytes: [0, 0] },
  ]);
  assert.throws(() => wallhackMacroWriteBlocks(4, record, new Map()), /outside 0\.\.3/);
});

test("macro packets frame address, length and payload", () => {
  const read = wallhackBuildGetMacro(32, 8);
  assert.deepEqual([...read.subarray(0, 7)], [0, 0, WALLHACK_COMMAND.getMacro, 8, 32, 0, 0]);
  const write = wallhackBuildSetMacro(32, [1, 2, 3]);
  assert.deepEqual([...write.subarray(0, 10)], [0, 0, WALLHACK_COMMAND.setMacro, 3, 32, 0, 0, 1, 2, 3]);
  const reply = new Uint8Array([0, 0, WALLHACK_COMMAND.getMacro, 3, 32, 0, 0, 9, 8, 7]);
  assert.deepEqual([...wallhackMacroReplyBytes(reply)!], [9, 8, 7]);
  assert.equal(wallhackMacroReplyBytes(new Uint8Array(4)), null);
});
