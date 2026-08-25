import assert from "node:assert/strict";
import test from "node:test";

import {
  GLORIOUS_DEFAULT_LIGHTING,
  GLORIOUS_DEFAULT_STAGE_COLORS,
  GLORIOUS_RGB_EFFECTS,
  type GloriousLighting,
  buildGloriousLightingPayload,
  buildGloriousSettingsPayload,
  gloriousDecodePolling,
  gloriousEncodeDpi,
  gloriousEncodePolling,
  gloriousIsSupportedDpi,
  gloriousLightingColorCount,
  gloriousNormalizeLighting,
  gloriousNormalizeSettings,
  gloriousSanitizeDebounce,
  type GloriousSettings,
} from "@openmouse/protocol/glorious";

function defaultSettings(): GloriousSettings {
  return {
    activeStage: 2,
    stageCount: 4,
    stageDpis: [400, 800, 1600, 3200, 0, 0],
    stageColors: ["#ff0000", "#0000ff", "#00ff00", "#ffff00", "#000000", "#000000"],
    lodMm: 1,
    debounceMs: 10,
    pollingCode: 0x01,
  };
}

test("settings payload splits into four 64-byte fragments with headers", () => {
  const fragments = buildGloriousSettingsPayload(defaultSettings());
  assert.equal(fragments.length, 4);
  fragments.forEach((fragment, index) => {
    assert.equal(fragment.length, 64);
    assert.equal(fragment[0], 0x03);
    assert.equal(fragment[1], 0x04);
    assert.equal(fragment[2], 0xfb);
    assert.equal(fragment[3], index);
    assert.equal(fragment[4], 0x01);
  });
});

test("global settings land in fragment 0 at the documented offsets", () => {
  const [first] = buildGloriousSettingsPayload(defaultSettings());
  assert.equal(first[5], 2);
  assert.equal(first[6], 4);
  assert.equal(first[7], 1);
  assert.equal(first[8], 10);
  assert.equal(first[9], 0x01);
  assert.equal(first[10], 0x00);
});

test("stage DPIs are little-endian units of 50 across all fragments", () => {
  const settings = { ...defaultSettings(), stageCount: 6, stageDpis: [400, 800, 1600, 3200, 6400, 12800] };
  const [f1, f2, f3, f4] = buildGloriousSettingsPayload(settings);
  assert.deepEqual([f1[11], f1[12]], [8, 0]);
  assert.deepEqual([f2[5], f2[6]], [16, 0]);
  assert.deepEqual([f2[10], f2[11]], [32, 0]);
  assert.deepEqual([f3[5], f3[6]], [64, 0]);
  assert.deepEqual([f3[10], f3[11]], [128, 0]);
  const encoded12800 = gloriousEncodeDpi(12800);
  assert.deepEqual([f4[5], f4[6]], [encoded12800 & 0xff, encoded12800 >> 8 & 0xff]);
});

test("unused stages and factory colors are written verbatim", () => {
  const [f1, f2, f3, f4] = buildGloriousSettingsPayload(defaultSettings());
  assert.deepEqual([...f1.slice(13, 16)], [0xff, 0x00, 0x00]);
  assert.deepEqual([...f2.slice(7, 10)], [0x00, 0x00, 0xff]);
  assert.deepEqual([...f2.slice(12, 15)], [0x00, 0xff, 0x00]);
  assert.deepEqual([...f3.slice(7, 10)], [0xff, 0xff, 0x00]);
  assert.deepEqual([...f3.slice(10, 13)], [0, 0, 0]);
  assert.deepEqual([...f4.slice(7, 10)], [0, 0, 0]);
});

test("custom stage colors replace the factory palette byte for byte", () => {
  const settings = {
    ...defaultSettings(),
    stageColors: ["#102030", "#405060", "#708090", "#a0b0c0", "#d0e0f0", "#ffffff"],
  };
  const [f1, f2, f3, f4] = buildGloriousSettingsPayload(settings);
  assert.deepEqual([...f1.slice(13, 16)], [0x10, 0x20, 0x30]);
  assert.deepEqual([...f2.slice(7, 10)], [0x40, 0x50, 0x60]);
  assert.deepEqual([...f2.slice(12, 15)], [0x70, 0x80, 0x90]);
  assert.deepEqual([...f3.slice(7, 10)], [0xa0, 0xb0, 0xc0]);
  assert.deepEqual([...f3.slice(12, 15)], [0xd0, 0xe0, 0xf0]);
  assert.deepEqual([...f4.slice(7, 10)], [0xff, 0xff, 0xff]);
});

test("settings normalization repairs invalid stage colors and keeps valid ones", () => {
  const normalized = gloriousNormalizeSettings({
    stageColors: ["#AABBCC", "red", undefined, "#12345"],
  });
  assert.deepEqual(
    normalized.stageColors.slice(0, 4),
    ["#aabbcc", ...GLORIOUS_DEFAULT_STAGE_COLORS.slice(1, 3), "#ffff00"],
  );
});

test("polling codes round-trip through the documented mapping", () => {
  for (const [code, hertz] of [[0x01, 1000], [0x02, 125], [0x03, 250], [0x04, 500]] as const) {
    assert.equal(gloriousEncodePolling(hertz), code);
    const decoded = gloriousDecodePolling(code);
    assert.equal(decoded, hertz);
  }
  assert.equal(gloriousEncodePolling(2000), null);
  assert.equal(gloriousDecodePolling(0x05), null);
});

test("debounce is clamped to even milliseconds within 0-16", () => {
  assert.equal(gloriousSanitizeDebounce(10), 10);
  assert.equal(gloriousSanitizeDebounce(7), 6);
  assert.equal(gloriousSanitizeDebounce(99), 16);
  assert.equal(gloriousSanitizeDebounce(-3), 0);
});

test("DPI validation accepts the advertised grid only", () => {
  assert.equal(gloriousIsSupportedDpi(800), true);
  assert.equal(gloriousIsSupportedDpi(26000), true);
  assert.equal(gloriousIsSupportedDpi(801), false);
  assert.equal(gloriousIsSupportedDpi(50), false);
});

function defaultLighting(): GloriousLighting {
  return {
    effect: GLORIOUS_RGB_EFFECTS.breathing,
    brightnessWired: 0x14,
    brightnessWireless: 0x0a,
    speed: 0x05,
    colors: ["#102030", "#405060", "#708090", "#a0b0c0", "#d0e0f0", "#ffffff", "#000000"],
  };
}

test("lighting payload splits into three 64-byte fragments with 02 fb headers", () => {
  const fragments = buildGloriousLightingPayload(defaultLighting());
  assert.equal(fragments.length, 3);
  fragments.forEach((fragment, index) => {
    assert.equal(fragment.length, 64);
    assert.equal(fragment[0], 0x03);
    assert.equal(fragment[1], 0x02);
    assert.equal(fragment[2], 0xfb);
    assert.equal(fragment[3], index);
    assert.equal(fragment[4], 0x01);
  });
});

test("lighting fields land at the documented offsets and effects echo across fragments", () => {
  const lighting = defaultLighting();
  const [first, second, third] = buildGloriousLightingPayload(lighting);
  assert.equal(first[5], GLORIOUS_RGB_EFFECTS.breathing);
  assert.equal(first[6], 0x0a);
  assert.equal(first[7], 0x14);
  assert.equal(first[8], 7);
  assert.equal(first[9], 0x05);
  assert.equal(first[10], 0x14);
  for (const fragment of [first, second, third]) {
    assert.equal(fragment[5], GLORIOUS_RGB_EFFECTS.breathing);
  }
});

test("primary color sits in fragment 0 and cycle colors in fragment 1", () => {
  const [first, second] = buildGloriousLightingPayload(defaultLighting());
  assert.deepEqual([...first.slice(11, 14)], [0x10, 0x20, 0x30]);
  assert.deepEqual([...second.slice(6, 9)], [0x40, 0x50, 0x60]);
  assert.deepEqual([...second.slice(21, 24)], [0x00, 0x00, 0x00]);
});

test("color count follows the effect rules", () => {
  assert.equal(gloriousLightingColorCount(GLORIOUS_RGB_EFFECTS.normallyOn), 1);
  assert.equal(gloriousLightingColorCount(GLORIOUS_RGB_EFFECTS.off), 1);
  assert.equal(gloriousLightingColorCount(GLORIOUS_RGB_EFFECTS.breathingSingle), 1);
  assert.equal(gloriousLightingColorCount(GLORIOUS_RGB_EFFECTS.rave), 2);
  assert.equal(gloriousLightingColorCount(GLORIOUS_RGB_EFFECTS.glorious), 7);
  assert.equal(gloriousLightingColorCount(GLORIOUS_RGB_EFFECTS.wave), 7);
});

test("lighting normalization repairs invalid persisted state", () => {
  const normalized = gloriousNormalizeLighting({
    effect: 99,
    brightnessWired: 3,
    brightnessWireless: "nope",
    speed: 200,
    colors: ["#AABBCC", "red", undefined],
  });
  assert.equal(normalized.effect, GLORIOUS_DEFAULT_LIGHTING.effect);
  assert.equal(normalized.brightnessWired, 0x05);
  assert.equal(normalized.brightnessWireless, 0x14);
  assert.equal(normalized.speed, 0x14);
  assert.deepEqual(normalized.colors.slice(0, 3), ["#aabbcc", ...GLORIOUS_DEFAULT_LIGHTING.colors.slice(1, 3)]);
  assert.deepEqual(normalized.colors.length, 7);
  const roundTrip = gloriousNormalizeLighting(defaultLighting());
  assert.deepEqual(roundTrip, defaultLighting());
});
