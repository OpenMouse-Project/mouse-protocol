import assert from "node:assert/strict";
import test from "node:test";
import {
  HITSCAN_BUTTON_NAMES, HITSCAN_BUTTON_OPTIONS,
  hitscanBuildCommand, hitscanButtonActionForLabel, hitscanButtonLabel, hitscanDecodeBattery, hitscanDecodeButton,
  hitscanDecodeLiftOff, hitscanDecodeVersion, hitscanFormatVersion, hitscanPollingRatesFor,
} from "./index.js";

test("battery replies decode as percent, charging flag and big-endian millivolts", () => {
  assert.deepEqual(hitscanDecodeBattery(hitscanBuildCommand(4, [87, 1, 0x0f, 0xa0])), { percent: 87, charging: true, millivolts: 4000 });
  assert.deepEqual(hitscanDecodeBattery(hitscanBuildCommand(4, [101, 0, 0, 0])), { percent: null, charging: false, millivolts: null });
  assert.equal(hitscanDecodeBattery(hitscanBuildCommand(3, [87])), null);
  const corrupt = hitscanBuildCommand(4, [87]); corrupt[15] ^= 1;
  assert.equal(hitscanDecodeBattery(corrupt), null);
});

test("version replies are big-endian and format like the CompX drivers", () => {
  const version = hitscanDecodeVersion(hitscanBuildCommand(0x12, [1, 0x0a]));
  assert.equal(version, 0x010a);
  assert.equal(hitscanFormatVersion(version!), "v1.0a");
  assert.equal(hitscanDecodeVersion(hitscanBuildCommand(0xb3, [2, 0]), 0xb3), 0x0200);
  assert.equal(hitscanDecodeVersion(hitscanBuildCommand(0x12, [2, 0]), 0xb3), null);
});

test("only the 8K receiver offers 8000 Hz", () => {
  assert.deepEqual(hitscanPollingRatesFor("wired"), [125, 250, 500, 1000, 2000, 4000]);
  assert.deepEqual(hitscanPollingRatesFor("receiver"), [125, 250, 500, 1000, 2000, 4000]);
  assert.equal(hitscanPollingRatesFor("8k-receiver").at(-1), 8000);
});

test("lift-off accepts only the two traced codes", () => {
  assert.equal(hitscanDecodeLiftOff(1), 1);
  assert.equal(hitscanDecodeLiftOff(2), 2);
  for (const code of [0, 3, 255]) assert.equal(hitscanDecodeLiftOff(code), null);
});

test("button labels round-trip and opaque actions get read-only labels", () => {
  assert.equal(HITSCAN_BUTTON_NAMES.length, 6);
  for (const [label, action] of HITSCAN_BUTTON_OPTIONS) {
    assert.deepEqual(hitscanButtonActionForLabel(label), action);
    assert.equal(hitscanButtonLabel(action), label);
  }
  assert.equal(hitscanButtonLabel(hitscanDecodeButton([5, 1, 2])), "Shortcut");
  assert.equal(hitscanButtonLabel(hitscanDecodeButton([6, 0, 0])), "Macro");
  assert.equal(hitscanButtonLabel(hitscanDecodeButton([1, 0, 0x83])), "Unknown (01 00 83)");
  assert.equal(hitscanButtonActionForLabel("Shortcut"), null);
});
