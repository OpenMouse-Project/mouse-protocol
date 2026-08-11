import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGITECH_HIRES_WHEEL_BIT,
  LOGITECH_SMART_SHIFT_OFF,
  buildRatchetControlWrite,
  buildThumbWheelWrite,
  decodeHiresWheelCapabilities,
  decodeHiresWheelMode,
  decodeRatchetControl,
  decodeThumbWheelStatus,
  decodeThumbWheelSupportsInvert,
  encodeHiresWheelMode,
} from "./wheel.js";

test("decodes the 0x2111 trio captured from hardware", () => {
  // 02 FF 64 — ratcheted, SmartShift off, default threshold 100.
  const control = decodeRatchetControl([0x02, 0xff, 0x64]);
  assert.deepEqual(control, { mode: "Ratchet", threshold: LOGITECH_SMART_SHIFT_OFF, defaultThreshold: 0x64 });
  assert.equal(decodeRatchetControl([0x01, 0x0f, 0x64])?.mode, "Freespin");
});

test("a mode byte outside the two known values decodes as null rather than a guess", () => {
  assert.equal(decodeRatchetControl([0x00, 0x0f, 0x64])?.mode, null);
  assert.equal(decodeRatchetControl([]), null);
});

test("changing the wheel mode preserves the SmartShift threshold, and the reverse", () => {
  const current = { mode: "Ratchet" as const, threshold: 15, defaultThreshold: 100 };
  assert.deepEqual(buildRatchetControlWrite(current, { mode: "Freespin" }), [1, 15, 100]);
  assert.deepEqual(buildRatchetControlWrite(current, { threshold: 46 }), [2, 46, 100]);
  // Both fields ride in one write, so dropping either loses a setting the
  // caller never asked to change.
  assert.deepEqual(buildRatchetControlWrite(current, {}), [2, 15, 100]);
});

test("hi-res capabilities are [multiplier, flags], not the other way round", () => {
  // 0F 1C — reading these reversed reports a multiplier of 28 on a wheel
  // whose real multiplier is 15.
  const capabilities = decodeHiresWheelCapabilities([0x0f, 0x1c]);
  assert.equal(capabilities?.multiplier, 0x0f);
  assert.equal(capabilities?.supportsInvert, true);
  assert.equal(decodeHiresWheelCapabilities([0x0f, 0x00])?.supportsInvert, false);
  assert.equal(decodeHiresWheelCapabilities([0x0f]), null);
});

test("the hi-res mode byte splits into its three bits", () => {
  assert.deepEqual(decodeHiresWheelMode(0x06), { hiRes: true, inverted: true, diverted: false });
  assert.deepEqual(decodeHiresWheelMode(0x01), { hiRes: false, inverted: false, diverted: true });
});

test("a mode write never turns diversion on and never turns it off", () => {
  // Setting divert stops the wheel scrolling, because nothing consumes those
  // notifications. Clearing it would take away whatever set it.
  const withDivert = 0x01;
  const afterHiRes = encodeHiresWheelMode(withDivert, LOGITECH_HIRES_WHEEL_BIT.hiRes, true);
  assert.equal(afterHiRes & LOGITECH_HIRES_WHEEL_BIT.divert, LOGITECH_HIRES_WHEEL_BIT.divert);

  const withoutDivert = 0x02;
  const afterInvert = encodeHiresWheelMode(withoutDivert, LOGITECH_HIRES_WHEEL_BIT.invert, true);
  assert.equal(afterInvert & LOGITECH_HIRES_WHEEL_BIT.divert, 0);
  assert.equal(afterInvert, 0x06);
});

test("thumb-wheel invert support is read from the two-byte capability field", () => {
  // 00 14 00 78 00 03 — the capability is 0x0003 at [4..5]. Reading the single
  // byte at [4] gives 0x00 and reports inversion unsupported on a device that
  // demonstrably honours it.
  const info = [0x00, 0x14, 0x00, 0x78, 0x00, 0x03, 0x03, 0xe8];
  assert.equal(decodeThumbWheelSupportsInvert(info), true);
  assert.equal(decodeThumbWheelSupportsInvert([0x00, 0x14, 0x00, 0x78, 0x00, 0x00]), false);
  assert.equal(decodeThumbWheelSupportsInvert([0x00, 0x14]), null);
});

test("thumb-wheel status decodes diversion and inversion separately", () => {
  assert.deepEqual(decodeThumbWheelStatus([0x01, 0x01]), { diverted: true, inverted: true });
  assert.deepEqual(decodeThumbWheelStatus([0x01, 0x00]), { diverted: true, inverted: false });
  assert.equal(decodeThumbWheelStatus([0x01]), null);
});

test("inverting the thumb wheel preserves the diversion Options+ set", () => {
  // Options+ sets diversion to implement horizontal scrolling; a write that
  // clears it silently removes that.
  assert.deepEqual(buildThumbWheelWrite({ diverted: true }, true), [1, 1]);
  assert.deepEqual(buildThumbWheelWrite({ diverted: true }, false), [1, 0]);
  assert.deepEqual(buildThumbWheelWrite({ diverted: false }, true), [0, 1]);
});
