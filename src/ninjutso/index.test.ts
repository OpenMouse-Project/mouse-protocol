import assert from "node:assert/strict";
import test from "node:test";

import {
  NINJUTSO_DEVICES,
  ninjutsoBuildRequest,
  ninjutsoDecodeDpi,
  ninjutsoDecodePollingRate,
  ninjutsoEncodeDpi,
  ninjutsoEncodePollingRate,
  ninjutsoLegacyDecodeDpi,
  ninjutsoLegacyEncodeDpi,
  ninjutsoResponseValue,
} from "./index.ts";

test("the official NinjaForce VID/PID list has explicit unverified catalog entries", () => {
  assert.equal(NINJUTSO_DEVICES.size, 14);
  assert.ok([...NINJUTSO_DEVICES.values()].every((device) => device.verified === false));
  assert.equal(NINJUTSO_DEVICES.get(`${0x093a}:${0xe010}`)?.name, "Ninjutso Sora V3");
});

test("builds the report-6 command envelope used by NinjaForce", () => {
  assert.deepEqual([...ninjutsoBuildRequest(3, 2, [1, 0x1f, 0])], [3, 0, 0, 1, 0, 3, 2, 1, 0x1f, 0, 0, 0, 0, 0, 0]);
});

test("matches replies by command and extracts the value bytes", () => {
  const reply = new Uint8Array(15);
  reply[1] = 18;
  reply[8] = 73;
  assert.deepEqual([...ninjutsoResponseValue(reply, 18)!], [73, 0, 0, 0, 0, 0, 0]);
  assert.equal(ninjutsoResponseValue(reply, 17), null);
});

test("converts current and legacy DPI encodings", () => {
  assert.deepEqual(ninjutsoEncodeDpi(1600, false), [31, 0, 0]);
  assert.equal(ninjutsoDecodeDpi(31, 0, 0, false), 1600);
  assert.deepEqual(ninjutsoEncodeDpi(45_000, true), [0xc8, 0xaf, 0]);
  assert.equal(ninjutsoDecodeDpi(0xc8, 0xaf, 0, true), 45_000);
  assert.deepEqual(ninjutsoLegacyEncodeDpi(1600), [31, 0]);
  assert.equal(ninjutsoLegacyDecodeDpi(31, 0), 1600);
});

test("converts NinjaForce's 1K through 8K polling codes", () => {
  assert.equal(ninjutsoEncodePollingRate(8000), 4);
  assert.equal(ninjutsoDecodePollingRate(3), 4000);
  assert.throws(() => ninjutsoEncodePollingRate(500), /1000, 2000, 4000, or 8000/);
});
