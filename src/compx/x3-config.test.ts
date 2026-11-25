import assert from "node:assert/strict";
import test from "node:test";

import {
  buildX3Burst,
  buildX3Buttons,
  buildX3Commit,
  buildX3MacroChunks,
  buildX3Polling,
  buildX3Power,
  buildX3Sensor,
  defaultX3Settings,
  parseX3Battery,
  x3DpiToRaw,
  x3EnabledMask,
  x3KeyboardAction,
  x3MacroAction,
  x3RawToDpi,
  X3_MOD,
} from "./x3-config.ts";

const hex = (s: string) => Uint8Array.from(s.split(" ").map((b) => parseInt(b, 16)));
const h = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

test("commit", () => {
  assert.equal(h(buildX3Commit()), "0C 0A 01 FE 01 FE 00 00 00 00");
});

test("default sensor golden", () => {
  assert.equal(
    h(buildX3Sensor(defaultX3Settings())),
    "04 38 01 01 00 3F 00 00 0F 1F 2F 3F 63 07 00 00 00 00 00 00 00 02 00 00 01 FF 00 00 00 FF 00 00 00 FF FF FF 00 00 FF FF FF 00 FF FF 40 00 FF FF FF 01 0E 7D 00 00 00 00",
  );
});

test("default power golden", () => {
  assert.equal(h(buildX3Power(defaultX3Settings())), "05 0F 01 00 13 E8 00 00 FF 0A 02 02 06 00 00");
});

test("polling goldens", () => {
  assert.equal(h(buildX3Polling(1000)), "06 09 01 01 FE 00 00 00 00");
  assert.equal(h(buildX3Polling(500)), "06 09 01 02 FD 00 00 00 00");
  assert.equal(h(buildX3Polling(250)), "06 09 01 04 FB 00 00 00 00");
  assert.equal(h(buildX3Polling(125)), "06 09 01 08 F7 00 00 00 00");
  assert.throws(() => buildX3Polling(100 as 125));
});

const DEFAULT_BUTTONS =
  "08 3B 01 02 00 00 03 00 00 04 00 00 0D 00 00 3C 00 00 0F 00 00 06 00 00 05 00 00 3C 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 0A 00 00 09 00 00 00 C2";

test("default buttons golden", () => {
  assert.equal(h(buildX3Buttons(defaultX3Settings().buttons)), DEFAULT_BUTTONS);
});

test("forward = Ctrl+X golden", () => {
  const s = defaultX3Settings();
  s.buttons[6] = x3KeyboardAction(X3_MOD.ctrl, 0x1b);
  assert.equal(
    h(buildX3Buttons(s.buttons)),
    "08 3B 01 02 00 00 03 00 00 04 00 00 0D 00 00 3C 00 00 0F 00 00 11 01 1B 05 00 00 3C 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 0A 00 00 09 00 00 00 E9",
  );
});

test("buttons need a left click and 18 slots", () => {
  const s = defaultX3Settings();
  s.buttons[0] = [0x01, 0, 0];
  assert.throws(() => buildX3Buttons(s.buttons));
  assert.throws(() => buildX3Buttons(s.buttons.slice(1)));
  assert.deepEqual([...x3MacroAction(2)], [0x12, 0, 2]);
});

test("burst order and lengths", () => {
  const b = buildX3Burst(defaultX3Settings());
  assert.deepEqual(b.map((r) => r[0]), [0x0c, 0x04, 0x05, 0x06, 0x08]);
  assert.deepEqual(b.map((r) => r.length), [10, 56, 15, 9, 59]);
});

test("macro golden", () => {
  const events = Array.from({ length: 7 }, () => [
    { usage: 6, down: true },
    { usage: 6, down: false },
  ]).flat();
  const [c0, c1, c2] = buildX3MacroChunks(events, 2);
  assert.deepEqual([c0.length, c1.length, c2.length], [64, 64, 12]);
  assert.deepEqual([...c0.subarray(0, 4)], [9, 0x40, 8, 0]);
  assert.deepEqual([...c1.subarray(0, 4)], [9, 0x40, 8, 1]);
  assert.deepEqual([...c2.subarray(0, 4)], [9, 0x0c, 8, 2]);
  const block = new Uint8Array(128);
  block.set(c0.subarray(4), 0);
  block.set(c1.subarray(4), 60);
  block.set(c2.subarray(4), 120);
  assert.deepEqual([...block.subarray(0, 5)], [2, 0, 0, 0, 1]);
  assert.equal(block[25], 14);
  assert.deepEqual([...block.subarray(26, 30)], [1, 6, 0x81, 6]);
  assert.deepEqual([...block.subarray(126)], [0x03, 0xf3]);
  assert.throws(() => buildX3MacroChunks(events, 0));
  assert.throws(() => buildX3MacroChunks(Array(51).fill({ usage: 4, down: true })));
});

test("dpi conversion", () => {
  assert.equal(x3DpiToRaw(800), 15);
  assert.equal(x3DpiToRaw(26000), 0x207);
  for (let d = 50; d <= 26000; d += 50) assert.equal(x3RawToDpi(x3DpiToRaw(d)), d);
  for (const bad of [0, 49, 75, 26050, 800.5]) assert.throws(() => x3DpiToRaw(bad));
});

test("sensor active stage, mask, validation", () => {
  const s = defaultX3Settings();
  s.dpiStages = [800, 1600, 12850];
  s.activeStage = 4;
  assert.equal(x3EnabledMask(s), 0x07);
  const r = buildX3Sensor(s);
  assert.equal(r[5], 0x07);
  assert.equal(r[24], 2);
  assert.equal(r[18], 1);
  assert.equal(r[10], 0xff & (12850 / 50 - 1));
  s.enabledMask = 0x05;
  assert.equal(buildX3Sensor(s)[5], 0x05);
  s.dpiStages = [];
  assert.throws(() => buildX3Sensor(s));
});

test("power validation", () => {
  const p = defaultX3Settings();
  assert.throws(() => buildX3Power({ ...p, sleepMinutes: 0 }));
  assert.throws(() => buildX3Power({ ...p, sleepMinutes: 31 }));
  assert.throws(() => buildX3Power({ ...p, deepSleepMinutes: 0 }));
  assert.throws(() => buildX3Power({ ...p, deepSleepMinutes: 61 }));
  assert.throws(() => buildX3Power({ ...p, debounceMs: 1 }));
  assert.throws(() => buildX3Power({ ...p, debounceMs: 52 }));
  assert.equal(buildX3Power({ ...p, sleepMinutes: 0.5 })[9], 1);
  assert.equal(buildX3Power({ ...p, sleepMinutes: 30, debounceMs: 50 })[10], 25);
});

test("checksum unchanged bytes verify", () => {
  const r = buildX3Sensor(defaultX3Settings());
  let s = 0;
  for (let i = 3; i <= 49; i++) s += r[i];
  assert.equal((r[50] << 8) | r[51], s);
  assert.deepEqual(hex("0E 7D"), r.subarray(50, 52));
});

test("battery sample and curve", () => {
  const b = parseX3Battery(hex("03 10 40 01 09"))!;
  assert.equal(b.voltage, 4);
  assert.equal(b.percent, 77);
  assert.equal(b.charging, false);
  assert.equal(parseX3Battery(hex("03 10 40 02 09"))!.charging, true);
  const want: Record<number, number> = { 0x36: 0, 0x37: 1, 0x38: 3, 0x39: 6, 0x3a: 13, 0x3b: 21, 0x3c: 33, 0x3d: 46, 0x3e: 59, 0x3f: 68, 0x41: 87, 0x42: 94, 0x43: 100, 0xff: 100 };
  for (const [raw, pct] of Object.entries(want)) {
    const got = parseX3Battery(Uint8Array.of(3, 0x10, Number(raw), 1, 9))!.percent;
    assert.ok(Math.abs(got - pct) <= 1, `raw ${raw}: ${got} vs ${pct}`);
  }
  assert.equal(parseX3Battery(hex("03 10 40 01")), null);
  assert.equal(parseX3Battery(hex("04 10 40 01 09")), null);
  assert.equal(parseX3Battery(hex("03 11 40 01 09")), null);
});

test("X3 action labels round trip and match the reference codes", async () => {
  const { x3ActionLabel, x3ParseActionLabel } = await import("./x3-config.ts");
  assert.deepEqual([...x3ParseActionLabel("Ctrl+X")!], [0x11, 0x01, 0x1b]);
  assert.deepEqual([...x3ParseActionLabel("Ctrl+Shift+Alt+Win+F12")!], [0x11, 0x0f, 0x45]);
  assert.deepEqual([...x3ParseActionLabel("Mute")!], [0x1a, 0, 0]);
  assert.deepEqual([...x3ParseActionLabel("Macro", 2)!], [0x12, 0, 2]);
  for (const l of ["Ctrl+X", "Alt+Tab", "Win+0", "Space", "DPI-", "Volume Up", "Macro", "Browser Home"]) {
    assert.equal(x3ActionLabel(x3ParseActionLabel(l)!), l);
  }
  assert.equal(x3ParseActionLabel("Ctrl+Ctrl+X"), null);
  assert.equal(x3ParseActionLabel("Bogus"), null);
  assert.equal(x3ActionLabel([0x3c, 0, 0]), null);
});
