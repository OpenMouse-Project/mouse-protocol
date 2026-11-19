import assert from "node:assert/strict";
import test from "node:test";

import {
  XIAOMI_DPI_LEVELS,
  XIAOMI_DPI_MAX,
  XIAOMI_DPI_MIN,
  XIAOMI_DPI_STEP,
  XIAOMI_EFFECTS,
  XIAOMI_EFFECTS_BY_DEVICE,
  XIAOMI_HEADER,
  XIAOMI_KEY_COMBOS,
  XIAOMI_MACRO_EVENT_SIZE,
  XIAOMI_MACRO_HEADER_LENGTH,
  XIAOMI_MACRO_MAX_EVENTS_PER_PACKET,
  XIAOMI_MACRO_PACKET_SIZE,
  XIAOMI_MACRO_REPORT_ID,
  XIAOMI_PACKET_SIZE,
  XIAOMI_POLLING_RATES,
  XIAOMI_PRODUCT_IDS,
  XIAOMI_SPEEDS,
  xiaomiDecodeBattery,
  xiaomiDecodeBinding,
  xiaomiDecodeDpi,
  xiaomiDecodeLighting,
  xiaomiDecodeMacroChunk,
  xiaomiDecodePolling,
  xiaomiDpiFromWire,
  xiaomiDpiToWire,
  xiaomiEffectFromWire,
  xiaomiEffectToWire,
  xiaomiHexColorToRgb,
  xiaomiMacroPackets,
  xiaomiPollingRateFromWire,
  xiaomiPollingRateToWire,
  xiaomiReadBatteryRequest,
  xiaomiReadBindingRequest,
  xiaomiReadDpiRequest,
  xiaomiReadLightingRequest,
  xiaomiReadMacroRequest,
  xiaomiReadPollingRequest,
  xiaomiRgbToHexColor,
  xiaomiWriteBindingRequest,
  xiaomiWriteDpiRequest,
  xiaomiWriteLightingRequest,
  xiaomiWriteMacroRequest,
  xiaomiWritePollingRequest,
} from "./index.js";

function reply(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(XIAOMI_PACKET_SIZE);
  data.set(bytes);
  return data;
}

function macroReply(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(XIAOMI_MACRO_PACKET_SIZE);
  data.set(bytes);
  return data;
}

test("device table covers the wired and wireless PIDs", () => {
  assert.deepEqual([...XIAOMI_PRODUCT_IDS], [0x5009, 0x500b]);
});

test("effect wire mapping skips the firmware gap", () => {
  for (const effect of XIAOMI_EFFECTS) {
    assert.equal(xiaomiEffectFromWire(xiaomiEffectToWire(effect)), effect);
  }
  assert.equal(xiaomiEffectToWire(3), 3);
  assert.equal(xiaomiEffectToWire(5), 6);
  assert.equal(xiaomiEffectToWire(6), 7);
  assert.equal(xiaomiEffectFromWire(6), 5);
  assert.equal(xiaomiEffectFromWire(7), 6);
});

test("polling wire mapping is a power of two in wire order", () => {
  assert.deepEqual(XIAOMI_POLLING_RATES, [1000, 500, 250, 125]);
  assert.equal(xiaomiPollingRateToWire(1000), 0x01);
  assert.equal(xiaomiPollingRateToWire(500), 0x02);
  assert.equal(xiaomiPollingRateToWire(250), 0x04);
  assert.equal(xiaomiPollingRateToWire(125), 0x08);
  assert.equal(xiaomiPollingRateFromWire(0x04), 250);
  assert.throws(() => xiaomiPollingRateToWire(750), RangeError);
  assert.throws(() => xiaomiPollingRateFromWire(0x03), Error);
  assert.throws(() => xiaomiPollingRateFromWire(0x10), Error);
});

test("DPI wire mapping divides by the step and validates the range", () => {
  assert.equal(XIAOMI_DPI_MIN, 50);
  assert.equal(XIAOMI_DPI_MAX, 7200);
  assert.equal(XIAOMI_DPI_STEP, 50);
  assert.equal(xiaomiDpiToWire(100), 2);
  assert.equal(xiaomiDpiToWire(7200), 144);
  assert.equal(xiaomiDpiFromWire(2), 100);
  assert.throws(() => xiaomiDpiToWire(49), RangeError);
  assert.throws(() => xiaomiDpiToWire(7250), RangeError);
  assert.throws(() => xiaomiDpiToWire(101), RangeError);
  assert.throws(() => xiaomiDpiToWire(100.5), RangeError);
});

test("color helpers round-trip", () => {
  assert.deepEqual(xiaomiHexColorToRgb("#00ff80"), [0x00, 0xff, 0x80]);
  assert.deepEqual(xiaomiHexColorToRgb("00ff80"), [0x00, 0xff, 0x80]);
  assert.equal(xiaomiRgbToHexColor([0x00, 0xff, 0x80]), "#00ff80");
  assert.throws(() => xiaomiHexColorToRgb("#00ff8"), RangeError);
  assert.throws(() => xiaomiHexColorToRgb("nope"), RangeError);
});

test("read requests are 32-byte reports headed by 0x4D", () => {
  const lighting = xiaomiReadLightingRequest(0);
  assert.equal(lighting.length, XIAOMI_PACKET_SIZE);
  assert.deepEqual([...lighting.slice(0, 3)], [XIAOMI_HEADER, 0xa0, 0]);
  assert.deepEqual([...xiaomiReadLightingRequest(1).slice(0, 3)], [XIAOMI_HEADER, 0xa0, 1]);
  assert.throws(() => xiaomiReadLightingRequest(2), RangeError);

  assert.deepEqual([...xiaomiReadBatteryRequest().slice(0, 2)], [XIAOMI_HEADER, 0x90]);
  assert.deepEqual([...xiaomiReadPollingRequest().slice(0, 2)], [XIAOMI_HEADER, 0xc4]);
  assert.deepEqual([...xiaomiReadDpiRequest().slice(0, 2)], [XIAOMI_HEADER, 0xc2]);
  assert.deepEqual([...xiaomiReadBindingRequest(3).slice(0, 3)], [XIAOMI_HEADER, 0xb0, 3]);
  assert.throws(() => xiaomiReadBindingRequest(8), RangeError);
});

test("lighting write encodes effect, speed and RGB", () => {
  const frame = xiaomiWriteLightingRequest(0, 1, 4, [0x00, 0xff, 0x80]);
  assert.equal(frame.length, XIAOMI_PACKET_SIZE);
  assert.deepEqual([...frame.slice(0, 10)], [XIAOMI_HEADER, 0xa1, 0, 1, 4, 0x08, 0x08, 0x00, 0xff, 0x80]);

  // Logical effect 5 maps to wire value 6.
  assert.equal(xiaomiWriteLightingRequest(0, 5, 1, [1, 2, 3])[3], 6);

  // The wheel zone only accepts Off and Static.
  assert.deepEqual(XIAOMI_EFFECTS_BY_DEVICE.WHEEL, [0, 1]);
  assert.throws(() => xiaomiWriteLightingRequest(1, 2, 4, [0, 0, 0]), RangeError);
  assert.throws(() => xiaomiWriteLightingRequest(0, 4, 4, [0, 0, 0]), RangeError);
  assert.throws(() => xiaomiWriteLightingRequest(0, 1, 0, [0, 0, 0]), RangeError);
  assert.throws(() => xiaomiWriteLightingRequest(0, 1, 9, [0, 0, 0]), RangeError);
  assert.throws(() => xiaomiWriteLightingRequest(2, 1, 4, [0, 0, 0]), RangeError);
});

test("polling write encodes the rate as a power of two", () => {
  assert.equal(xiaomiWritePollingRequest(1000)[2], 0x01);
  assert.equal(xiaomiWritePollingRequest(125)[2], 0x08);
  assert.throws(() => xiaomiWritePollingRequest(100), RangeError);
});

test("DPI write packs five levels, the active level and the trailer", () => {
  const frame = xiaomiWriteDpiRequest([100, 800, 1600, 2400, 4800], 2);
  assert.deepEqual([...frame.slice(0, 10)], [XIAOMI_HEADER, 0xc1, 2, 16, 32, 48, 96, 2, 0x00, 0x05]);
  assert.throws(() => xiaomiWriteDpiRequest([100, 800, 1600, 2400], 2), RangeError);
  assert.throws(() => xiaomiWriteDpiRequest([100, 800, 1600, 2400, 4800], 5), RangeError);
  assert.throws(() => xiaomiWriteDpiRequest([100, 800, 1600, 2400, 4800], -1), RangeError);
});

test("binding write packs the combo big-endian with modifiers and key", () => {
  const frame = xiaomiWriteBindingRequest(3, XIAOMI_KEY_COMBOS.CUSTOM_KEY_COMBO, 0x01, 0x04);
  assert.deepEqual([...frame.slice(0, 7)], [XIAOMI_HEADER, 0xb1, 3, 0x01, 0x00, 0x01, 0x04]);
  assert.throws(() => xiaomiWriteBindingRequest(8, 1, 0, 0), RangeError);
  assert.throws(() => xiaomiWriteBindingRequest(3, 0x10000, 0, 0), RangeError);
});

test("lighting decode reads effect, speed and RGB", () => {
  const data = reply(XIAOMI_HEADER, 0xa0, 0, 0, 6, 4, 0, 0, 0x00, 0xff, 0x80);
  assert.deepEqual(xiaomiDecodeLighting(data), { effect: 5, speed: 4, color: [0x00, 0xff, 0x80] });
  assert.throws(() => xiaomiDecodeLighting(reply(XIAOMI_HEADER, 0xa1, 0, 0, 6, 4, 0, 0, 0, 0, 0)), Error);
  assert.throws(() => xiaomiDecodeLighting(new Uint8Array([XIAOMI_HEADER, 0xa0])), Error);
});

test("battery decode reads the percentage", () => {
  assert.equal(xiaomiDecodeBattery(reply(XIAOMI_HEADER, 0x90, 0, 87)), 87);
  assert.throws(() => xiaomiDecodeBattery(reply(XIAOMI_HEADER, 0x91, 0, 87)), Error);
});

test("polling decode maps the wire byte back to Hz", () => {
  assert.equal(xiaomiDecodePolling(reply(XIAOMI_HEADER, 0xc4, 0, 0x02)), 500);
  assert.throws(() => xiaomiDecodePolling(reply(XIAOMI_HEADER, 0xc4, 0, 0x03)), Error);
});

test("DPI decode reads five levels and clamps the active level", () => {
  const data = reply(XIAOMI_HEADER, 0xc2, 0, 2, 16, 32, 48, 96, 2);
  assert.deepEqual(xiaomiDecodeDpi(data), { levels: [100, 800, 1600, 2400, 4800], active: 2 });
  const clamped = reply(XIAOMI_HEADER, 0xc2, 0, 2, 16, 32, 48, 96, 9);
  assert.equal(xiaomiDecodeDpi(clamped).active, XIAOMI_DPI_LEVELS - 1);
  assert.throws(() => xiaomiDecodeDpi(new Uint8Array([XIAOMI_HEADER, 0xc2, 0, 2, 16, 32, 48])), Error);
});

test("binding decode handles direct combos, custom combos and macros", () => {
  // The real device does not echo the button index in byte 2 (always 0x00).
  const direct = reply(XIAOMI_HEADER, 0xb0, 0, 0, 0x01, 0x03, 0, 0);
  assert.deepEqual(xiaomiDecodeBinding(direct), { mode: XIAOMI_KEY_COMBOS.CTRL_TAB });

  const custom = reply(XIAOMI_HEADER, 0xb0, 0, 0, 0x01, 0x00, 0x01, 0x04);
  assert.deepEqual(xiaomiDecodeBinding(custom), {
    mode: XIAOMI_KEY_COMBOS.CUSTOM_KEY_COMBO,
    modifiers: 0x01,
    key: 0x04,
  });

  const macro = reply(XIAOMI_HEADER, 0xb0, 0, 0, 0x02, 0x01, 0x00, 0x10);
  assert.deepEqual(xiaomiDecodeBinding(macro), {
    mode: XIAOMI_KEY_COMBOS.MACROS_WITH_DELAY,
    macroSize: 0x10,
  });
});

test("speeds are 1 through 8", () => {
  assert.deepEqual(XIAOMI_SPEEDS, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("macro channel constants match the 64-byte hidraw layout", () => {
  assert.equal(XIAOMI_MACRO_REPORT_ID, 0x57);
  assert.equal(XIAOMI_MACRO_PACKET_SIZE, 64);
  assert.equal(XIAOMI_MACRO_HEADER_LENGTH, 8);
  assert.equal(XIAOMI_MACRO_EVENT_SIZE, 4);
  assert.equal(XIAOMI_MACRO_MAX_EVENTS_PER_PACKET, 14);
});

test("macro read request is a 64-byte 0x57 0xf0 0x0d report with offset and chunk", () => {
  const frame = xiaomiReadMacroRequest(0x0102, 56);
  assert.equal(frame.length, XIAOMI_MACRO_PACKET_SIZE);
  assert.deepEqual([...frame.slice(0, 8)], [0x57, 0xf0, 0x0d, 56, 0x00, 0x00, 0x01, 0x02]);
  assert.deepEqual([...frame.slice(8, 12)], [0, 0, 0, 0]);

  const first = xiaomiReadMacroRequest(0, 4);
  assert.deepEqual([...first.slice(0, 8)], [0x57, 0xf0, 0x0d, 4, 0x00, 0x00, 0x00, 0x00]);

  assert.throws(() => xiaomiReadMacroRequest(-1, 4), RangeError);
  assert.throws(() => xiaomiReadMacroRequest(0x10000, 4), RangeError);
  assert.throws(() => xiaomiReadMacroRequest(0, 57), RangeError);
  assert.throws(() => xiaomiReadMacroRequest(0, -1), RangeError);
});

test("macro write request packs events as [key, state, delay_hi, delay_lo]", () => {
  const events = [
    { key: 0x04, state: 0 as const, delayMs: 0 },
    { key: 0x04, state: 1 as const, delayMs: 0x0102 },
  ];
  const frame = xiaomiWriteMacroRequest(0x0008, events);
  assert.equal(frame.length, XIAOMI_MACRO_PACKET_SIZE);
  assert.deepEqual([...frame.slice(0, 8)], [0x57, 0xf1, 0x0d, 8, 0x00, 0x00, 0x00, 0x08]);
  assert.deepEqual([...frame.slice(8, 16)], [0x04, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x02]);
  assert.deepEqual([...frame.slice(16, 20)], [0, 0, 0, 0]);

  assert.throws(() => xiaomiWriteMacroRequest(0, [{ key: 0x100, state: 0, delayMs: 0 }]), RangeError);
  assert.throws(() => xiaomiWriteMacroRequest(0, [{ key: 0x04, state: 2, delayMs: 0 }]), RangeError);
  assert.throws(() => xiaomiWriteMacroRequest(0, [{ key: 0x04, state: 0, delayMs: 0x10000 }]), RangeError);
  assert.throws(() => xiaomiWriteMacroRequest(0x10000, []), RangeError);
  assert.throws(
    () => xiaomiWriteMacroRequest(0, Array.from({ length: 15 }, () => ({ key: 0x04, state: 0 as const, delayMs: 0 }))),
    RangeError,
  );
});

test("macro chunk decode reads the event bytes and stops at the header length", () => {
  const data = macroReply(0x57, 0xf0, 0x0d, 8, 0, 0, 0, 0, 0x04, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x02);
  assert.deepEqual(xiaomiDecodeMacroChunk(data), {
    packetSize: 8,
    events: [
      { key: 0x04, state: 0, delayMs: 0 },
      { key: 0x04, state: 1, delayMs: 0x0102 },
    ],
  });

  // A single-event packet (4 event bytes) must decode, not be treated as empty.
  const single = macroReply(0x57, 0xf0, 0x0d, 4, 0, 0, 0, 0, 0x04, 0x00, 0x00, 0x00);
  assert.deepEqual(xiaomiDecodeMacroChunk(single), {
    packetSize: 4,
    events: [{ key: 0x04, state: 0, delayMs: 0 }],
  });

  const end = macroReply(0x57, 0xf0, 0x0d, 0, 0, 0, 0, 0);
  assert.deepEqual(xiaomiDecodeMacroChunk(end), { packetSize: 0, events: [] });

  assert.throws(() => xiaomiDecodeMacroChunk(macroReply(0x57, 0xf1, 0x0d, 8)), Error);
  assert.throws(() => xiaomiDecodeMacroChunk(new Uint8Array([0x57, 0xf0, 0x0d, 8])), Error);
});

test("macro packets chunk events into groups of 14", () => {
  const events = Array.from({ length: 30 }, (_, i) => ({ key: 0x04, state: (i % 2) as 0 | 1, delayMs: 0 }));
  const packets = xiaomiMacroPackets(events);
  assert.equal(packets.length, 3);
  assert.equal(packets[0].length, 14);
  assert.equal(packets[1].length, 14);
  assert.equal(packets[2].length, 2);
  assert.deepEqual(packets[2][0], { key: 0x04, state: 0, delayMs: 0 });

  assert.deepEqual(xiaomiMacroPackets([]), []);
  assert.equal(xiaomiMacroPackets([{ key: 1, state: 0, delayMs: 0 }])[0].length, 1);
});
