import assert from "node:assert/strict";
import test from "node:test";
import { buildX11ButtonReport, buildX11MacroReports, buildX11PowerReport, decodeX11ButtonReport, decodeX11PowerReport } from "./x11-config.ts";
import { buildX11DpiReport, decodeX11DpiReport } from "./x11-dpi.ts";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replaceAll(" ", ""), "hex"));

test("X11 power writes match the captured debounce and sleep changes", () => {
  const before = bytes("05 0f 01 00 03 a8 ff 00 00 01 04 01 af 00 00");
  const debounce = buildX11PowerReport(before, { debounceMs: 12 });
  assert.deepEqual(debounce, bytes("05 0f 01 00 03 a8 ff 00 00 01 06 01 b1 00 00"));
  assert.deepEqual(buildX11PowerReport(debounce, { sleepSeconds: 390 }),
    bytes("05 0f 01 00 03 a8 ff 00 00 0d 06 01 bd 00 00"));
});

test("X11 DPI writes retain the neighboring sensor nibbles", () => {
  const dpi = buildX11DpiReport({ stages: [800, 1600], activeStage: 2, angleSnap: false, rippleControl: false });
  dpi[3] = 0x10;
  dpi[4] = 0x20;
  const edited = buildX11DpiReport({ stages: [800, 1600], activeStage: 2, angleSnap: true, rippleControl: true, base: dpi });
  assert.deepEqual(edited.slice(3, 5), bytes("11 21"));
  const decoded = decodeX11DpiReport(edited);
  assert.ok(decoded?.angleSnap);
  assert.ok(decoded?.rippleControl);
});

test("X11 lighting and deep sleep share bytes without overwriting one another", () => {
  const before = bytes("05 0f 01 00 03 a8 ff 00 00 01 06 01 b1 00 00");
  const after = buildX11PowerReport(before, { lightMode: 1, color: "#3a12ef", lightSpeed: 5, brightness: 4, deepSleepMinutes: 30 });
  assert.deepEqual(after.slice(3, 11), bytes("10 11 e4 3a 12 ef 01 06"));
  const decoded = decodeX11PowerReport(after);
  assert.equal(decoded?.deepSleepMinutes, 30);
  assert.equal(decoded?.color, "#3a12ef");
  assert.equal(decoded?.brightness, 4);
  assert.equal(decoded?.lightSpeed, 5);
  assert.equal(decoded?.debounceMs, 12);
  assert.equal(buildX11PowerReport(after, { sleepSeconds: 300 }, true).length, 13);
});

test("X11 Windows receiver can return the button slots already in write order", () => {
  const reply = bytes("08 3b 01 02 00 00 03 00 00 04 00 00 01 00 00 01 00 00 0d 00 00 06 00 00 05 00 00 "
    + "01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 09 00 00 0a 00 00 00 3e");
  const actions = decodeX11ButtonReport(reply);
  assert.ok(actions);
  assert.deepEqual(actions[6], [0x06, 0, 0]);
  assert.deepEqual(buildX11ButtonReport(actions), reply);
});

test("X11 button codec maps the firmware read order to the captured write order", () => {
  const read = bytes("08 3b 01 02 00 00 03 00 00 04 00 00 01 00 00 06 00 00 05 00 00 3c 00 00 0d 00 00 "
    + "01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 0a 00 00 09 00 00 00 79");
  const slots = decodeX11ButtonReport(read);
  assert.ok(slots);
  slots[6] = [0x1b, 0, 0];
  assert.deepEqual(buildX11ButtonReport(slots), bytes("08 3b 01 02 00 00 03 00 00 04 00 00 01 00 00 01 00 00 0d 00 00 "
    + "1b 00 00 05 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 09 00 00 0a 00 00 00 53"));
});

test("X11 A press/release matches the captured macro pages and checksum", () => {
  const pages = buildX11MacroReports(7, [{ usage: 4, down: true, delayMs: 10 }, { usage: 4, down: false, delayMs: 10 }]);
  assert.deepEqual(pages.map((page) => page.length), [64, 64, 64]);
  assert.deepEqual(pages[0].slice(0, 9), bytes("09 40 07 00 00 00 00 00 01"));
  assert.deepEqual(pages[0].slice(29, 34), bytes("02 01 04 81 04"));
  assert.deepEqual(pages[1].slice(0, 4), bytes("09 40 07 01"));
  assert.deepEqual(pages[2].slice(0, 12), bytes("09 0c 07 02 00 00 00 00 00 00 00 8d"));
});

test("X11 checksum includes the final action byte of a 50-unit macro", () => {
  const events = Array.from({ length: 50 }, (_, index) => ({
    usage: 4, down: index % 2 === 0, delayMs: 10,
  }));
  const [first, , third] = buildX11MacroReports(7, events);
  assert.equal(first[29], 50);
  // 25 press/release pairs at 0x8a each, plus repeat count 1 and unit count 50.
  assert.deepEqual(third.slice(4, 12), bytes("81 04 01 04 81 04 0d ad"));
});

test("X11 macro writes a valid UTF-8 name and includes it in the checksum", () => {
  const name = "é".repeat(9) + "日本";
  const [first, , third] = buildX11MacroReports(7, [
    { usage: 4, down: true, delayMs: 10 }, { usage: 4, down: false, delayMs: 10 },
  ], 0, 1, name);
  const field = first.slice(9, 29);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(field), "é".repeat(9) + "\0\0");
  assert.equal(first[29], 2);
  assert.equal(new DataView(third.buffer).getUint16(10), 0x8d + 9 * (0xc3 + 0xa9));
});
