import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGITECH_HAPTIC_EFFECTS,
  LOGITECH_HAPTIC_EFFECT_IDS,
  LOGITECH_HAPTIC_FLAG,
  LOGITECH_HAPTIC_INTENSITY_MAX,
  LOGITECH_HAPTIC_PRESETS,
  buildHapticConfigWrite,
  decodeHapticConfig,
  decodeHapticDefaultIntensity,
  decodeHapticPlayReply,
  encodeHapticFlags,
  isLogitechHapticEffect,
  isLogitechHapticIntensity,
  type LogitechHapticPreset,
} from "./haptics.js";

/** Config pairs read from an MX Master 4 while toggling Logi Options+. */
const CAPTURES: ReadonlyArray<[number[], { enabled: boolean; batterySaving: boolean; intensity: number }]> = [
  [[0x03, 0x3c], { enabled: true, batterySaving: true, intensity: 60 }],
  [[0x02, 0x3c], { enabled: false, batterySaving: true, intensity: 60 }],
  [[0x01, 0x3c], { enabled: true, batterySaving: false, intensity: 60 }],
  [[0x03, 0x19], { enabled: true, batterySaving: true, intensity: 25 }],
  [[0x03, 0x64], { enabled: true, batterySaving: true, intensity: 100 }],
];

test("decodes the config pairs captured from hardware", () => {
  for (const [payload, expected] of CAPTURES) {
    const config = decodeHapticConfig(payload);
    assert.ok(config);
    assert.equal(config.enabled, expected.enabled);
    assert.equal(config.batterySaving, expected.batterySaving);
    assert.equal(config.intensity, expected.intensity);
  }
});

test("a truncated reply decodes as null rather than as every flag set", () => {
  // Reading a missing byte as -1 would report both flags on and pass as a
  // successful write, which is the wrong direction to fail in.
  assert.equal(decodeHapticConfig([]), null);
  assert.equal(decodeHapticConfig([0x03]), null);
});

test("each flag toggles without disturbing the other", () => {
  assert.equal(encodeHapticFlags(0x03, "enabled", false), 0x02);
  assert.equal(encodeHapticFlags(0x03, "batterySaving", false), 0x01);
  assert.equal(encodeHapticFlags(0x02, "enabled", true), 0x03);
  assert.equal(encodeHapticFlags(0x01, "batterySaving", true), 0x03);
});

test("bits nobody has identified survive a flag change", () => {
  // Bits 2-7 read 0 on every capture, so their meaning is unknown. Clearing
  // them would discard a setting this package never displayed.
  assert.equal(encodeHapticFlags(0x83, "enabled", false), 0x82);
  assert.equal(encodeHapticFlags(0xfc, "enabled", true), 0xfd);
});

test("a write carries both bytes", () => {
  assert.deepEqual(buildHapticConfigWrite(0x03, 25), [0x03, 25]);
  assert.deepEqual(buildHapticConfigWrite(0x101, 300), [0x01, 0x2c]);
});

test("every Logi Options+ preset is a legal intensity and round trips", () => {
  for (const preset of Object.keys(LOGITECH_HAPTIC_PRESETS) as LogitechHapticPreset[]) {
    const value = LOGITECH_HAPTIC_PRESETS[preset];
    assert.ok(isLogitechHapticIntensity(value), `${preset} rejected`);
    const written = buildHapticConfigWrite(0x03, value);
    const config = decodeHapticConfig(written);
    assert.equal(config?.intensity, value);
  }
});

test("intensity outside the range the presets use is refused", () => {
  assert.equal(isLogitechHapticIntensity(LOGITECH_HAPTIC_INTENSITY_MAX + 1), false);
  assert.equal(isLogitechHapticIntensity(-1), false);
  assert.equal(isLogitechHapticIntensity(1.5), false);
  assert.equal(isLogitechHapticIntensity(Number.NaN), false);
});

test("only the effect ids the device accepts are treated as valid", () => {
  // 0x0F to 0x1A and 0x1C upward answer INVALID_ARGUMENT on hardware.
  for (const effect of LOGITECH_HAPTIC_EFFECT_IDS) {
    assert.ok(isLogitechHapticEffect(effect), `0x${effect.toString(16)} rejected`);
  }
  for (const effect of [0x0f, 0x10, 0x1a, 0x1c, 0x20, 0xff, -1]) {
    assert.equal(isLogitechHapticEffect(effect), false, `0x${effect.toString(16)} accepted`);
  }
});

test("the effects Options+ uses are ones the device accepts", () => {
  for (const effect of Object.values(LOGITECH_HAPTIC_EFFECTS)) {
    assert.ok(isLogitechHapticEffect(effect));
  }
});

test("a play reply reports motor state, not a property of the effect", () => {
  // The same id answered 0 from idle and 1 when chased by a longer effect.
  assert.deepEqual(decodeHapticPlayReply([0x0b, 0x00]), { effect: 0x0b, motorWasBusy: false });
  assert.deepEqual(decodeHapticPlayReply([0x0b, 0x01]), { effect: 0x0b, motorWasBusy: true });
  assert.equal(decodeHapticPlayReply([0x0b]), null);
});

test("the capability reply names the factory strength", () => {
  // Read from an MX Master 4: 00 01 00 3C 08 00 7F FF.
  assert.equal(decodeHapticDefaultIntensity([0x00, 0x01, 0x00, 0x3c, 0x08, 0x00, 0x7f, 0xff]), 60);
  assert.equal(decodeHapticDefaultIntensity([0x00, 0x01, 0x00]), null);
  // The device default matches what Options+ calls Medium.
  assert.equal(
    decodeHapticDefaultIntensity([0x00, 0x01, 0x00, 0x3c]),
    LOGITECH_HAPTIC_PRESETS.Medium,
  );
});

test("the flag masks do not overlap", () => {
  assert.equal(LOGITECH_HAPTIC_FLAG.enabled & LOGITECH_HAPTIC_FLAG.batterySaving, 0);
});
