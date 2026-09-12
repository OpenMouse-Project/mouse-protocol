import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeGladiusIIProfile,
  decodeGladiusIISettings,
} from "../../asus/index.ts";

function packet(hex: string): Uint8Array {
  return Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 16)),
  );
}

test("decodes verified Gladius II settings capture", () => {
  const response = packet(`
    12 04 00 00
    0E 00
    0B 00
    03
    00
    07
    00
    00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00
  `);

  const result =
    decodeGladiusIISettings(response);

  assert.deepEqual(result.dpiStages, [
    1500,
    1200,
  ]);

  assert.equal(result.pollingRateHz, 1000);
  assert.equal(result.debounceMs, 32);
  assert.equal(result.angleSnapping, false);
});

test("decodes verified Gladius II profile capture", () => {
  const response = packet(`
    12 00 00 00
    30 31 39 35
    03 06
    00
    01
    0E 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00 00 00 00 00 00 00
    00 00
  `);

  const result =
    decodeGladiusIIProfile(response);

  assert.equal(result.onboardProfile, 1);
  assert.equal(result.activeDpiStage, 0);
});