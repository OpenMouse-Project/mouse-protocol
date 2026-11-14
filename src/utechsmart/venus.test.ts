import assert from "node:assert/strict";
import { test } from "node:test";
import * as v from "./index.js";

const hex = (text: string) => Uint8Array.from(text.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16)));
// Sanitized excerpts of the user's real 04d9:fc55 dump0-500.bin. No runtime file I/O.
const factoryDpi = hex("05 00 00 00 01 16 00 00 00 00 01 2d 00 00 00 00 01 5a 00 00 00 00 01 5c 01 00 00 00 01 7c 04 00 00 00");
const profile2Dpi = hex("05 00 03 00 01 09 00 00 00 00 01 0b 00 00 00 00 01 12 00 00 00 00 01 16 00 00 00 00 01 1b 00 00 00 00");
const factoryButtons = hex(`14 00 81 00 00 00 82 00 00 00 83 00 00 00 99 81 03 00 8a 00 00 00 89 00 00 00
  90 00 1e 00 90 00 1f 00 90 00 20 00 90 00 21 00 90 00 22 00 90 00 23 00
  90 00 24 00 90 00 25 00 90 00 26 00 90 00 27 00 90 00 57 00 90 00 56 00
  00 00 00 00 8d 00 00 00 00 00 00 00 00 00 00 00 8b 00 00 00 8c 00 00 00 ff ff ff ff`);
const profile2Buttons = hex(`14 00 81 00 00 00 82 00 00 00 83 00 00 00 99 81 03 00 8a 00 00 00 89 00 00 00
  8f 01 1e 00 8f 01 1f 00 8f 01 20 00 8f 01 21 00 8f 01 22 00 8f 01 23 00
  8f 01 24 00 8f 01 25 00 8f 01 26 00 8f 01 27 00 8f 01 57 00 8f 01 56 00
  00 00 00 00 8d 00 00 00 00 00 00 00 00 00 00 00 8b 00 00 00 8c 00 00 00 ff ff ff ff`);
function fixture(): v.UtechsmartVenusMemory {
  const data = new Uint8Array(0x3b6);
  data.set(hex("01 00 00 dc 05 c0 02 00 01 00 02 00 02 00 02 00"), 0x2c);
  [0x40, 0x100, 0x1b0, 0x260, 0x310].forEach((base, p) => {
    data.set(p === 1 ? profile2Dpi : factoryDpi, base);
    if (p === 2 || p === 4) data[base + 2] = 1;
  });
  [0x80, 0x140, 0x1f0, 0x2a0, 0x350].forEach((base, p) => data.set(p === 1 ? profile2Buttons : factoryButtons, base));
  return { address: 0, data };
}

test("identity, interface and report sizes", () => {
  assert.equal(v.UTECHSMART_VENUS_VENDOR_ID, 0x04d9);
  assert.equal(v.UTECHSMART_VENUS_PRODUCT_ID, 0xfc55);
  assert.equal(v.UTECHSMART_VENUS_INTERFACE, 2);
  assert.equal(v.UTECHSMART_VENUS_CONFIG_USAGE_PAGE, 0xffa0);
  assert.equal(v.UTECHSMART_VENUS_CONFIG_USAGE, 1);
  assert.equal(v.UTECHSMART_VENUS_REPORT_SIZE, 16);
  assert.equal(v.UTECHSMART_VENUS_LONG_REPORT_SIZE, 64);
});

test("hardware read/write frames include id, zero reserved bytes and no checksum", () => {
  assert.deepEqual(v.utechsmartVenusEncodeRead(0x123, 8), hex("02 f2 23 01 08 00 00 00 00 00 00 00 00 00 00 00"));
  assert.deepEqual(v.utechsmartVenusEncodeWrite(0x123, [1, 2, 3]), hex("02 f3 23 01 03 00 00 00 01 02 03 00 00 00 00 00"));
  assert.equal(v.utechsmartVenusEncodeRead(0x100, 56)[4], 56);
  assert.equal(v.utechsmartVenusReadReportId(8), 2);
  assert.equal(v.utechsmartVenusReadReportId(9), 3);
  assert.equal(v.utechsmartVenusReadReportId(56), 3);
  for (const address of [-1, 0x10000, 0.5, NaN]) assert.throws(() => v.utechsmartVenusEncodeRead(address, 1));
  for (const length of [0, 57, 1.5, NaN]) assert.throws(() => v.utechsmartVenusEncodeRead(0, length));
  assert.throws(() => v.utechsmartVenusEncodeRead(0xffff, 2));
  for (const data of [[], new Array(9).fill(0), [256], [-1], [0.5]]) assert.throws(() => v.utechsmartVenusEncodeWrite(0, data));
  assert.throws(() => v.utechsmartVenusEncodeWrite(0xffff, [1, 2]));
});

test("legacy F1 controls remain explicit and cannot build reset", () => {
  const controls = { enter: 1, buttons: 2, dpi: 4, led: 8, exit: 16 } as const;
  for (const [name, code] of Object.entries(controls)) {
    const frame = v.utechsmartVenusEncodeControl(name as keyof typeof controls);
    assert.equal(frame.length, 16);
    assert.deepEqual([...frame.slice(0, 4)], [2, 0xf1, 2, code]);
    assert.ok(frame.slice(4).every((b) => b === 0));
  }
  assert.throws(() => v.utechsmartVenusEncodeControl("reset" as "enter"));
});

test("F5 brackets settings writes with 0/1, never a polling divisor", () => {
  for (const state of [0, 1] as const) {
    assert.deepEqual(v.utechsmartVenusEncodeSession(state), Uint8Array.from([2, 0xf5, state, ...new Array(13).fill(0)]));
  }
  for (const state of [-1, 2, 4, 8, 0.5, NaN]) {
    assert.throws(() => v.utechsmartVenusEncodeSession(state as 0));
  }
});

test("settings apply is F1 02 08 without relying on the legacy LED interpretation", () => {
  assert.deepEqual(v.utechsmartVenusEncodeApply(), hex("02 f1 02 08 00 00 00 00 00 00 00 00 00 00 00 00"));
});

function reply(address: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length <= 8 ? 16 : 64);
  bytes.set([length <= 8 ? 2 : 3, 8, 0, 0x60 + (address >> 8), length, 0, 0xfa, 0xfa]);
  bytes.set(Array.from({ length }, (_, i) => i + 1), 8);
  return bytes;
}
test("reply validation accepts unreliable odd-address echo and both report formats", () => {
  for (const length of [1, 8, 9, 56]) {
    const answer = reply(0x123, length);
    assert.deepEqual(v.utechsmartVenusDecodeRead(answer, 0x123, length), answer.slice(8, 8 + length));
    assert.deepEqual(v.utechsmartVenusDecodeRead(answer.subarray(1), 0x123, length), answer.slice(8, 8 + length));
    answer[2] = 0x22;
    assert.equal(v.utechsmartVenusDecodeRead(answer, 0x123, length)[0], 1);
  }
});
test("reply validation rejects tag, length, sentinel, report id, truncation and wrong status", () => {
  for (const [index, value] of [[0, 3], [1, 7], [3, 0x32], [4, 7], [6, 0], [7, 0]]) {
    const answer = reply(0x123, 8);
    answer[index!] = value!;
    assert.throws(() => v.utechsmartVenusDecodeRead(answer, 0x123, 8));
  }
  assert.throws(() => v.utechsmartVenusDecodeRead(reply(0x123, 8).slice(0, 15), 0x123, 8));
  const unknownStatus = reply(0x123, 8);
  unknownStatus[3] = 0x99;
  assert.equal(v.utechsmartVenusDecodeRead(unknownStatus, 0x123, 8, { validateStatus: false }).length, 8);
});

test("profile, polling, stage and button address helpers enforce integer bounds", () => {
  const dpiBases = [0x40, 0x100, 0x1b0, 0x260, 0x310];
  const buttonBases = [0x80, 0x140, 0x1f0, 0x2a0, 0x350];
  for (let p = 0; p < 5; p++) {
    assert.equal(v.utechsmartVenusProfileAddress(p), dpiBases[p]);
    assert.equal(v.utechsmartVenusPollAddress(p), 0x32 + 2 * p);
    assert.equal(v.utechsmartVenusStageAddress(p, 9), dpiBases[p]! + 58);
    assert.equal(v.utechsmartVenusButtonAddress(p, 19), buttonBases[p]! + 78);
  }
  for (const p of [-1, 5, 0.5, NaN]) {
    for (const call of [() => v.utechsmartVenusProfileAddress(p), () => v.utechsmartVenusPollAddress(p), () => v.utechsmartVenusStageAddress(p, 0), () => v.utechsmartVenusButtonAddress(p, 0)]) assert.throws(call);
  }
  for (const s of [-1, 10, 0.5, NaN]) assert.throws(() => v.utechsmartVenusStageAddress(0, s));
  for (const s of [-1, 20, 0.5, NaN]) assert.throws(() => v.utechsmartVenusButtonAddress(0, s));
});

const pairs = [[0x09, 0, 400], [0x0b, 0, 500], [0x12, 0, 800], [0x16, 0, 1000], [0x1b, 0, 1200], [0x2d, 0, 2000], [0x5a, 0, 4000], [0x5c, 1, 8200], [0x71, 1, 10000], [0x6a, 4, 14100], [0x7c, 4, 16400]] as const;
for (const [value, range, dpi] of pairs) test(`confirmed DPI ${dpi} = (${value}, ${range})`, () => {
  assert.equal(v.utechsmartVenusDecodeDpi(value, range), dpi);
  assert.deepEqual(v.utechsmartVenusEncodeDpi(dpi), { value, range, dpi });
});
test("all vendor DPI labels round-trip, with lower ties and cap exception", () => {
  assert.equal(v.UTECHSMART_VENUS_DPI_LABELS.length, 106);
  for (const dpi of v.UTECHSMART_VENUS_DPI_LABELS) {
    const encoded = v.utechsmartVenusEncodeDpi(dpi);
    assert.equal(encoded.dpi, dpi);
    assert.equal(v.utechsmartVenusDecodeDpi(encoded.value, encoded.range), dpi);
  }
  for (const [input, output] of [[200, 200], [250, 200], [251, 300], [6300, 6200], [6301, 6400], [12500, 12400], [12501, 12600], [12750, 12600], [12751, 12900], [16300, 16200], [16301, 16400], [15600, 15600], [16200, 16200], [16400, 16400]]) {
    assert.equal(v.utechsmartVenusEncodeDpi(input!).dpi, output);
  }
  for (const dpi of [199, 16401, NaN, Infinity, 200.5]) assert.throws(() => v.utechsmartVenusEncodeDpi(dpi));
  assert.equal(v.utechsmartVenusDecodeDpi(5, 4), 670);
  assert.equal(v.utechsmartVenusDecodeDpi(5, 1), 440);
  assert.equal(v.utechsmartVenusDecodeDpi(5, 0xfe), 220);
  assert.equal(v.utechsmartVenusDecodeDpi(9, 0xfe), 400);
});

test("button codec reuses Holtek names, supports single/keypad keys and standard 8-bit modifiers", () => {
  for (const [name, code] of [["Left click", 0x81], ["Right click", 0x82], ["Middle click", 0x83], ["Back", 0x84], ["Forward", 0x85], ["DPI down", 0x89], ["DPI up", 0x8a], ["Profile cycle", 0x8d], ["Disabled", 0]] as const) {
    const action = { kind: "action", name } as const;
    assert.deepEqual(v.utechsmartVenusDecodeButtonAction([code, 0, 0, 0]), action);
    assert.deepEqual(v.utechsmartVenusEncodeButtonAction(action), Uint8Array.from([code, 0, 0, 0]));
  }
  for (const usage of [0x1e, 0x27, 0x57, 0x56]) {
    assert.deepEqual(v.utechsmartVenusDecodeButtonAction([0x90, 0, usage, 0]), { kind: "key", usage });
    assert.deepEqual(v.utechsmartVenusEncodeButtonAction({ kind: "key", usage }), Uint8Array.from([0x90, 0, usage, 0]));
    for (const modifiers of [0, 1, 3, 0x10, 0xff]) {
      const action = { kind: "combo", modifiers, usage } as const;
      assert.deepEqual(v.utechsmartVenusDecodeButtonAction([0x8f, modifiers, usage, 0]), action);
      assert.deepEqual(v.utechsmartVenusEncodeButtonAction(action), Uint8Array.from([0x8f, modifiers, usage, 0]));
    }
  }
  assert.equal(v.utechsmartVenusButtonActionName({ kind: "combo", modifiers: 1, usage: 0x1e }), "Keys Ctrl+1");
  assert.equal(v.utechsmartVenusButtonActionName({ kind: "key", usage: 0x57 }), "Key Numpad +");
  assert.equal(v.utechsmartVenusButtonActionName({ kind: "combo", modifiers: 1, usage: 0x56 }), "Keys Ctrl+Numpad -");
  assert.equal(v.utechsmartVenusButtonActionName({ kind: "combo", modifiers: 0x10, usage: 0x1e }), "Keys Right Ctrl+1");
});
test("unknown and noncanonical button records round-trip without assigning speculative semantics", () => {
  for (const raw of [[0x99, 0x81, 3, 0], [0x81, 1, 0, 0], [0xfe, 0xab, 0xcd, 0xef], [0x8f, 1, 0x1e, 9], [0x90, 1, 0x1e, 0]]) {
    const action = v.utechsmartVenusDecodeButtonAction(raw);
    assert.equal(action.kind, "raw");
    assert.deepEqual(v.utechsmartVenusEncodeButtonAction(action), Uint8Array.from(raw));
  }
  assert.throws(() => v.utechsmartVenusDecodeButtonAction([0]));
  assert.throws(() => v.utechsmartVenusEncodeButtonAction({ kind: "key", usage: 256 }));
  assert.throws(() => v.utechsmartVenusEncodeButtonAction({ kind: "combo", modifiers: -1, usage: 4 }));
  assert.throws(() => v.utechsmartVenusEncodeButtonAction({ kind: "action", name: "Reset" }));
});

test("status decodes real dump excerpts including Ctrl side buttons and raw fire record", () => {
  const memory = fixture();
  const before = memory.data.slice();
  const status = v.utechsmartVenusDecodeStatus(memory);
  assert.equal(status.activeProfile, 1);
  assert.deepEqual(status.profiles.map((p) => p.pollingHz), [500, 1000, 500, 500, 500]);
  assert.deepEqual(status.profiles[1]!.stages.map((s) => s.dpi), [400, 500, 800, 1000, 1200]);
  assert.equal(status.profiles[1]!.currentStage, 3);
  assert.deepEqual(status.profiles[0]!.stages.map((s) => s.dpi), [1000, 2000, 4000, 8200, 16400]);
  assert.equal(status.profiles[0]!.currentStage, 0);
  const usages = [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x57, 0x56];
  for (const profile of status.profiles) {
    assert.equal(profile.stages.length, 5);
    assert.equal(profile.buttons.length, 20);
    assert.deepEqual(profile.buttons.slice(6, 18), usages.map((usage) => profile.index === 1 ? { kind: "combo", modifiers: 1, usage } : { kind: "key", usage }));
    assert.equal(profile.buttons[3]!.kind, "raw");
  }
  assert.deepEqual(memory.data, before);
});
test("status exposes unknown DPI range and polling code, rejects incomplete or invalid counts", () => {
  const memory = fixture();
  memory.data[0x46] = 0xfe;
  memory.data[0x32] = 3;
  const status = v.utechsmartVenusDecodeStatus(memory);
  assert.equal(status.profiles[0]!.pollingHz, null);
  assert.equal(status.profiles[0]!.pollingCode, 3);
  assert.equal(status.profiles[0]!.stages[0]!.range, 0xfe);
  assert.equal(status.profiles[0]!.stages[0]!.raw[2], 0xfe);
  assert.throws(() => v.utechsmartVenusDecodeStatus({ address: 0x40, data: factoryDpi }));
  for (const count of [0, 11]) {
    memory.data[0x40] = count;
    assert.throws(() => v.utechsmartVenusDecodeStatus(memory));
  }
  memory.data[0x40] = 10;
  memory.data[0x42] = 9;
  assert.equal(v.utechsmartVenusDecodeStatus(memory).profiles[0]!.stages.length, 10);
  memory.data[0x40] = 1;
  memory.data[0x42] = 0;
  assert.equal(v.utechsmartVenusDecodeStatus(memory).profiles[0]!.stages.length, 1);
  memory.data[0x80] = 21;
  assert.throws(() => v.utechsmartVenusDecodeStatus(memory));
});

test("write plans emit minimal F3 spans except full polling words and preserve unknown/reserved/tail bytes", () => {
  const memory = fixture();
  memory.data.set([0xa5, 0x16, 0, 0xc1, 0xc2, 0xc3], 0x44);
  memory.data[0x33] = 0x7e;
  const before = memory.data.slice();
  const cases: [v.UtechsmartVenusChange, number, number[]][] = [
    [{ kind: "dpi", profile: 0, stage: 0, dpi: 8200 }, 0x45, [0x5c, 1]],
    [{ kind: "dpi", profile: 0, stage: 0, dpi: 2000 }, 0x45, [0x2d]],
    [{ kind: "currentStage", profile: 0, stage: 4 }, 0x42, [4]],
    [{ kind: "polling", profile: 0, hz: 1000 }, 0x32, [1, 0x7e]],
    [{ kind: "button", profile: 1, slot: 6, action: { kind: "combo", modifiers: 3, usage: 0x1e } }, 0x15b, [3]],
    [{ kind: "button", profile: 0, slot: 19, action: { kind: "raw", bytes: hex("ff ab cd ef") } }, 0xce, [0xff, 0xab, 0xcd, 0xef]],
  ];
  for (const [change, address, data] of cases) {
    const plan = v.utechsmartVenusPlanWrite(memory, change);
    assert.deepEqual(plan, [v.utechsmartVenusEncodeWrite(address, data)]);
    const after = memory.data.slice();
    for (const frame of plan) after.set(frame.slice(8, 8 + frame[4]!), frame[2]! + 256 * frame[3]!);
    for (let i = 0; i < before.length; i++) if (i < address || i >= address + data.length) assert.equal(after[i], before[i]);
  }
  assert.deepEqual(memory.data, before);
  assert.deepEqual(v.utechsmartVenusPlanWrite(memory, { kind: "dpi", profile: 0, stage: 0, dpi: 1000 }), []);
  assert.deepEqual(v.utechsmartVenusPlanWrite(memory, { kind: "currentStage", profile: 0, stage: 0 }), []);
  assert.deepEqual(v.utechsmartVenusPlanWrite(memory, { kind: "polling", profile: 0, hz: 500 }), []);
  assert.deepEqual(v.utechsmartVenusPlanWrite(memory, { kind: "button", profile: 0, slot: 0, action: { kind: "action", name: "Left click" } }), []);
});
test("polling plans use vendor codes and full preserved words in every profile", () => {
  const memory = fixture();
  for (let profile = 0; profile < 5; profile++) {
    const address = 0x32 + 2 * profile;
    const second = 0xa0 + profile;
    for (const [hz, code] of [[1000, 1], [500, 2], [250, 4], [125, 8]] as const) {
      memory.data.set([code === 1 ? 2 : 1, second], address);
      const before = memory.data.slice();
      const change = { kind: "polling", profile, hz } as const;
      assert.deepEqual(v.utechsmartVenusPlanWrite(memory, change), [v.utechsmartVenusEncodeWrite(address, [code, second])]);
      assert.deepEqual(memory.data, before, "planning must not mutate readback");
      memory.data[address] = code;
      assert.deepEqual(v.utechsmartVenusPlanWrite(memory, change), []);
    }
  }
});

test("write plans accept address-based excerpts but reject missing bytes, inactive stages and tail slots", () => {
  const excerpt = { address: 0x40, data: factoryDpi.slice() };
  assert.deepEqual(v.utechsmartVenusPlanWrite(excerpt, { kind: "dpi", profile: 0, stage: 0, dpi: 2000 }), [v.utechsmartVenusEncodeWrite(0x45, [0x2d])]);
  assert.throws(() => v.utechsmartVenusPlanWrite(excerpt, { kind: "dpi", profile: 0, stage: 5, dpi: 2000 }));
  assert.throws(() => v.utechsmartVenusPlanWrite(excerpt, { kind: "currentStage", profile: 0, stage: 5 }));
  assert.throws(() => v.utechsmartVenusPlanWrite(excerpt, { kind: "polling", profile: 0, hz: 500 }));
  assert.throws(() => v.utechsmartVenusPlanWrite(fixture(), { kind: "button", profile: 0, slot: 20, action: { kind: "action", name: "Disabled" } }));
  assert.throws(() => v.utechsmartVenusPlanWrite(fixture(), { kind: "polling", profile: 0, hz: 2000 }));
});
