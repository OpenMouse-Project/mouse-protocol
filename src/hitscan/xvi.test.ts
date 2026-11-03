import assert from "node:assert/strict";
import test from "node:test";

import {
  HITSCAN_XVI_COMMAND,
  HITSCAN_XVI_DPI_STEP,
  HITSCAN_XVI_PACKET_LENGTH,
  hitscanXviActiveStageGetRequest,
  hitscanXviButtonGetRequest,
  hitscanXviButtonSetRequest,
  hitscanXviDecodeActiveStage,
  hitscanXviDecodeAngle,
  hitscanXviDecodeBattery,
  hitscanXviDecodeButton,
  hitscanXviDecodeDevicePid,
  hitscanXviDecodeDpiColors,
  hitscanXviDecodeDpiStages,
  hitscanXviDecodeFirmware,
  hitscanXviDecodeLiftOff,
  hitscanXviDecodeMacroData,
  hitscanXviDecodeMacroIds,
  hitscanXviDecodeMacroName,
  hitscanXviDecodeMacroSize,
  hitscanXviDecodeNotification,
  hitscanXviDecodePollingRate,
  hitscanXviDecodeProfileName,
  hitscanXviDecodeSignal,
  hitscanXviDecodeSleep,
  hitscanXviDecodeSpdt,
  hitscanXviDecodeTimings,
  hitscanXviDecodeLiftOffByte,
  hitscanXviEncodeAngle,
  hitscanXviEncodeLiftOff,
  hitscanXviEncodePollingRate,
  hitscanXviFrame,
  hitscanXviNormalize,
  hitscanXviPollingRateSetRequest,
  hitscanXviProfileNameSetRequest,
  hitscanXviReply,
  hitscanXviSleepSetRequest,
  hitscanXviSplitDpiGetRequest,
  hitscanXviTimingsSetRequest,
  hitscanXviDpiStagesSetRequest,
} from "./xvi.js";
import {
  HITSCAN_XVI_KEY_CODES,
  hitscanXviButtonActionForLabel,
  hitscanXviButtonLabel,
  hitscanXviDecodeButtonAction,
  hitscanXviDecodeGbkName,
  hitscanXviDecodeMacroEvents,
  hitscanXviEncodeButtonAction,
  hitscanXviEncodeGbkName,
  hitscanXviEncodeMacroEvents,
  hitscanXviIsLeftClick,
  HITSCAN_XVI_BUTTON_LABELS,
} from "./xvi-inputs.js";

function reply(commandClass: number, command: number, payload: readonly number[] = []): Uint8Array {
  const packet = new Uint8Array(HITSCAN_XVI_PACKET_LENGTH);
  packet.set([0xa1, 0, 0, payload.length + 2, commandClass, command, ...payload]);
  return packet;
}

test("frames put the device, length, class and command where the vendor SDK does", () => {
  const packet = hitscanXviFrame(2, 1, 0x80, [3]);
  assert.deepEqual([...packet.slice(0, 7)], [0, 0, 2, 2, 1, 0x80, 3]);
  assert.equal(packet.length, 64);
  assert.deepEqual([...hitscanXviPollingRateSetRequest(2, 1000).slice(0, 8)], [0, 0, 2, 2, 1, 0, 2, 1]);
  assert.throws(() => hitscanXviFrame(99, 0, 0), RangeError);
});

test("replies normalize a platform report-id prefix and echo the class/command", () => {
  const expected = reply(1, 0x80, [2, 1]);
  assert.deepEqual(hitscanXviNormalize(Uint8Array.of(0, ...expected)), expected);
  const request = hitscanXviPollingRateSetRequest(2, 1000);
  assert.ok(hitscanXviReply(expected, request) === null, "different command must not match");
  assert.ok(hitscanXviReply(reply(1, 0x80, [2, 1]), hitscanXviFrame(2, 1, 0x80, [2])));
});

test("firmware, battery and signal decode the web app's offsets", () => {
  assert.equal(hitscanXviDecodeFirmware(reply(0, 0x81, [1, 0, 2, 16])), "1.0.2.16");
  assert.equal(hitscanXviDecodeFirmware(reply(0, 0x81, [0, 0, 0, 0])), null);
  assert.deepEqual(hitscanXviDecodeBattery(reply(0, 0x83, [1, 88])), { percent: 88, charging: true });
  assert.equal(hitscanXviDecodeBattery(reply(0, 0x83, [2, 88])), null);
  assert.deepEqual(hitscanXviDecodeSignal(reply(0, 0xa7, [1, 200])), { level: 1, rssi: 200 });
  assert.equal(hitscanXviDecodeSignal(reply(0, 0xa7, [4, 200])), null);
  assert.equal(hitscanXviDecodeDevicePid(reply(0, 0x8b, [0, 0, 0x37, 0x70, 0x01, 0x94])), 0x0194);
});

test("polling, lift-off, angle and sleep use the vendor encodings", () => {
  assert.equal(hitscanXviEncodePollingRate(8000), 128);
  assert.equal(hitscanXviEncodePollingRate(1000), 1);
  assert.equal(hitscanXviDecodePollingRate(reply(1, 0x80, [1, 64])), 4000);
  assert.equal(hitscanXviDecodePollingRate(reply(1, 0x80, [1, 16])), 1000);
  assert.equal(hitscanXviEncodeLiftOff(0.7), 0x87);
  assert.equal(hitscanXviEncodeLiftOff(2), 2);
  assert.equal(hitscanXviDecodeLiftOff(reply(1, 0x88, [1, 0x87])), 0.7);
  assert.equal(hitscanXviDecodeLiftOffByte(3), null);
  assert.equal(hitscanXviEncodeAngle(-30), 226);
  assert.equal(hitscanXviDecodeAngle(reply(1, 0x94, [1, 226])), -30);
  assert.deepEqual([...hitscanXviSleepSetRequest(1, null).slice(6, 9)], [1, 0xff, 0xff]);
  assert.equal(hitscanXviDecodeSleep(reply(0, 0x87, [1, 0xff, 0xff])), null);
  assert.equal(hitscanXviDecodeSleep(reply(0, 0x87, [1, 0, 60])), 60);
});

test("DPI stages parse X/Y pairs and the active stage is 1-based", () => {
  const decoded = hitscanXviDecodeDpiStages(reply(1, 0x81, [2, 3, 0x01, 0x90, 0x01, 0x90, 0x03, 0x20, 0x03, 0x20, 0x06, 0x40, 0x06, 0x40]));
  assert.deepEqual(decoded?.stages, [{ x: 400, y: 400 }, { x: 800, y: 800 }, { x: 1600, y: 1600 }]);
  assert.equal(hitscanXviDecodeActiveStage(reply(1, 0x82, [2, 3])), 3);
  assert.equal(hitscanXviDecodeActiveStage(reply(1, 0x82, [2, 0])), null);
  const packet = hitscanXviDpiStagesSetRequest(1, [{ x: 400, y: 400 }, { x: 800, y: 800 }]);
  assert.equal(packet[3], 26);
  assert.deepEqual([...packet.slice(6, 14)], [1, 2, 0x01, 0x90, 0x01, 0x90, 0x03, 0x20]);
  assert.throws(() => hitscanXviDpiStagesSetRequest(1, [{ x: 425, y: 425 }]), RangeError);
});

test("stage colours read six RGB triplets", () => {
  const colors = [0xff, 0x44, 0x44, 0x33, 0xcc, 0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.deepEqual(hitscanXviDecodeDpiColors(reply(2, 0x81, [1, ...colors]))?.slice(0, 2), ["#ff4444", "#33cc66"]);
});

test("timings decode the four values after the profile echo", () => {
  assert.deepEqual(
    hitscanXviDecodeTimings(reply(0, 0x88, [1, 2, 5, 20, 20, 3])),
    { beforePress: 2, beforeRelease: 5, afterPress: 20, afterRelease: 20 },
  );
  assert.deepEqual(
    [...hitscanXviTimingsSetRequest(1, { beforePress: 0, beforeRelease: 5, afterPress: 20, afterRelease: 20 }).slice(6, 12)],
    [1, 0, 5, 20, 20, 3],
  );
  assert.throws(() => hitscanXviTimingsSetRequest(1, {
    beforePress: 51, beforeRelease: 5, afterPress: 20, afterRelease: 20,
  }), RangeError);
});

test("SPDT carries independent left and right flags", () => {
  assert.deepEqual(hitscanXviDecodeSpdt(reply(3, 0x83, [1, 1, 0])), { left: true, right: false });
  assert.equal(hitscanXviDecodeSpdt(reply(3, 0x83, [1, 2, 0])), null);
});

test("profile names echo the profile, length and GBK bytes", () => {
  const decoded = hitscanXviDecodeProfileName(reply(0, 0x8e, [2, 2, 0xb2, 0xe2]));
  assert.equal(decoded?.id, 2);
  assert.equal(decoded?.name, "测");
  const packet = hitscanXviProfileNameSetRequest(2, [0xb2, 0xe2]);
  assert.deepEqual([...packet.slice(2, 8)], [2, 4, 0, 0x0e, 2, 2]);
});

test("button replies keep the request-aligned payload offsets", () => {
  const decoded = hitscanXviDecodeButton(reply(3, 0x80, [1, 1, 0, 1, 1, 1]));
  assert.deepEqual(decoded, { profileId: 1, buttonId: 1, functionId: 1, data: [1] });
  const request = hitscanXviButtonGetRequest(1, 1, 10);
  assert.deepEqual([...request.slice(3, 11)], [15, 3, 0x80, 1, 1, 0, 0xff, 10]);
  const set = hitscanXviButtonSetRequest(1, 0x14, 16, [0, 2, 3]);
  assert.deepEqual([...set.slice(2, 12)], [2, 8, 3, 0, 1, 0x14, 0, 16, 3, 0]);
});

test("button actions round-trip and unknown encodings stay custom", () => {
  for (const [label, action] of HITSCAN_XVI_BUTTON_LABELS) {
    const binding = hitscanXviEncodeButtonAction(action);
    const decoded = hitscanXviDecodeButtonAction(binding);
    assert.equal(hitscanXviButtonLabel(decoded), label);
  }
  const raw = hitscanXviDecodeButtonAction({ functionId: 99, data: [1, 2] });
  assert.deepEqual(raw, { kind: "custom", functionId: 99, data: [1, 2] });
  assert.equal(hitscanXviButtonLabel(raw), "Custom (63 01 02)");
  const macro = hitscanXviEncodeButtonAction({ kind: "macro", macro: 3, runMode: "count", runCount: 2 });
  assert.deepEqual(macro, { functionId: 16, data: [0, 3, 2] });
  const key = hitscanXviEncodeButtonAction({ kind: "key", key: "KeyA", modifiers: 1 });
  assert.deepEqual(key, { functionId: 4, data: [1, HITSCAN_XVI_KEY_CODES.KeyA] });
  assert.ok(hitscanXviIsLeftClick({ kind: "mouse", button: "left" }));
  assert.ok(!hitscanXviIsLeftClick({ kind: "mouse", button: "right" }));
  assert.ok(hitscanXviButtonActionForLabel("DPI+"));
});

test("macro events encode the vendor stream and reject unbalanced keys", () => {
  const events = [
    { type: "down" as const, key: "KeyA" },
    { type: "delay" as const, ms: 10 },
    { type: "up" as const, key: "KeyA" },
  ];
  assert.deepEqual([...hitscanXviEncodeMacroEvents(events)], [2, 4, 0x20, 10, 3, 4]);
  assert.deepEqual(hitscanXviDecodeMacroEvents(Uint8Array.of(2, 4, 0x20, 10, 3, 4)), events);
  assert.deepEqual([...hitscanXviEncodeMacroEvents([{ type: "down", key: "MouseLeft" }, { type: "delay", ms: 300 }, { type: "up", key: "MouseLeft" }])], [1, 1, 0x21, 1, 44, 1, 0]);
  assert.throws(() => hitscanXviEncodeMacroEvents([{ type: "down", key: "KeyA" }]), RangeError);
  assert.equal(hitscanXviDecodeMacroEvents(Uint8Array.of(3, 4)), null);
});

test("GBK names round-trip and UTF-16 default names are recognised", () => {
  const chinese = "\u6d4b\u8bd5";
  assert.equal(hitscanXviDecodeGbkName(hitscanXviEncodeGbkName(chinese)), chinese);
  assert.equal(hitscanXviDecodeGbkName(Uint8Array.of(0x41, 0x42, 0, 0)), "AB");
  const prefix = [80, 0, 114, 0, 111, 0, 102, 0, 105, 0, 108, 0, 101, 0, 32, 0];
  assert.equal(hitscanXviDecodeGbkName(Uint8Array.of(...prefix, 84, 0, 101, 0, 115, 0, 116, 0)), "Profile Test");
  assert.throws(() => hitscanXviEncodeGbkName(""), RangeError);
});

test("macro replies decode the list, size, name and data offsets", () => {
  assert.deepEqual(hitscanXviDecodeMacroIds(reply(4, 0x85, [0, 2, 0, 0, 0, 1, 0, 2])), [1, 2]);
  assert.equal(hitscanXviDecodeMacroSize(reply(4, 0x81, [0, 1, 0, 0, 0, 20])), 20);
  assert.deepEqual(hitscanXviDecodeMacroName(reply(4, 0x86, [1, 4, 84, 101, 115, 116])), { id: 1, bytes: [84, 101, 115, 116] });
  assert.deepEqual(hitscanXviDecodeMacroData(reply(4, 0x83, [0, 1, 0, 0, 0, 5, 3, 9, 9, 9]), 1, 5, 3), [9, 9, 9]);
  assert.equal(hitscanXviDecodeMacroData(reply(4, 0x83, [0, 1, 0, 0, 0, 5, 3, 9, 9, 9]), 1, 6, 3), null);
});

test("split-DPI polling uses the vendor's class-1 0x8d query", () => {
  assert.deepEqual([...hitscanXviSplitDpiGetRequest(3).slice(2, 7)], [2, 2, 1, 0x8d, 3]);
});

test("notifications decode signal, battery, sleep, DPI, LOD and rate", () => {
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(0x19, 200, 1)), { type: "signal", level: 1, rssi: 200 });
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(4, 0x03, 88, 1)), { type: "battery", percent: 88, charging: true });
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(0x06, 0)), { type: "sleep" });
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(0x06, 1)), { type: "wake" });
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(1, 2, 0x03, 0x20, 0x03, 0x20)), { type: "dpi", stage: 1, x: 800, y: 800 });
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(7, 0x87)), { type: "liftOff", millimetres: 0.7 });
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(8, 16)), { type: "polling", hz: 1000 });
  assert.deepEqual(hitscanXviDecodeNotification(Uint8Array.of(0x02, 3)), { type: "profile" });
});

test("DPI option helper arithmetic stays on 50-DPI steps", () => {
  assert.equal(HITSCAN_XVI_DPI_STEP, 50);
  assert.equal(HITSCAN_XVI_COMMAND.motionSyncGet, 0x89);
  assert.equal(hitscanXviActiveStageGetRequest(1)[6], 1);
});
