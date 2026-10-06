import assert from "node:assert/strict";
import { it } from "node:test";
import {
  AJAZZ_AJ179_PRO_PROFILE,
  CMD,
  encodeCommand,
  gearHubBluetoothPacket,
  gearHubProfileFor,
  GEARHUB_BUTTONS,
} from "./index.ts";

it("wraps checksummed Bluetooth commands without adding the WebHID report id", () => {
  const encoded = encodeCommand([CMD.GET_DPI, 0]);
  const original = encoded.slice();
  const packet = gearHubBluetoothPacket(encoded);
  assert.equal(packet.length, 65);
  assert.equal(packet[0], 0x55);
  assert.deepEqual(packet.slice(1, 1 + encoded.length), encoded);
  assert.equal(packet[8], 0x2b);
  assert.ok(packet.slice(1 + encoded.length).every((byte) => byte === 0));
  assert.deepEqual(encoded, original, "caller-owned command is not mutated");
  const full = new Uint8Array(64).fill(0xab);
  assert.deepEqual(gearHubBluetoothPacket(full).slice(1), full);
  assert.throws(() => gearHubBluetoothPacket(new Uint8Array(65)), /exceeds 64/);
});

it("keeps AJ179 model quirks in its profile without changing sibling button layouts", () => {
  assert.equal(gearHubProfileFor(1851), AJAZZ_AJ179_PRO_PROFILE);
  assert.equal(AJAZZ_AJ179_PRO_PROFILE.buttons?.find((button) => button.name === "Back")?.slot, 4);
  assert.equal(AJAZZ_AJ179_PRO_PROFILE.buttons?.find((button) => button.name === "Forward")?.slot, 3);
  assert.equal(AJAZZ_AJ179_PRO_PROFILE.dpiStageCountIsCapacity, true);
  assert.equal(AJAZZ_AJ179_PRO_PROFILE.batteryPercentageOnly, true);
  for (const id of [2285, 1893, 1643, 3310, 0]) {
    const profile = gearHubProfileFor(id);
    assert.equal(profile.buttons, undefined);
    assert.equal(profile.dpiStageCountIsCapacity, undefined);
    assert.equal(profile.batteryPercentageOnly, undefined);
  }
  assert.equal(GEARHUB_BUTTONS.find((button) => button.name === "Back")?.slot, 3);
  assert.equal(GEARHUB_BUTTONS.find((button) => button.name === "Forward")?.slot, 4);
});
