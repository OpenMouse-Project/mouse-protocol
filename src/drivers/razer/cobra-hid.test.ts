import assert from "node:assert/strict";
import test from "node:test";

import { RAZER_READ, encodeRazerRequest, razerSetDpiCommand, razerSetExtendedEffectCommand, razerSetLegacyPollingCommand } from "@openmouse/protocol/razer";
import {
  COBRA_DPI_READ,
  COBRA_EFFECT_TRANSACTION_ID,
  COBRA_PRODUCT_ID,
  COBRA_TRANSACTION_ID,
  RazerCobraHidClient,
} from "./cobra-hid.ts";

test("Cobra requests use the legacy 0xFF transaction id", () => {
  const packet = encodeRazerRequest(RAZER_READ.firmware, COBRA_TRANSACTION_ID);

  assert.equal(packet[1], 0xff);
  assert.equal(packet[6], 0x00);
  assert.equal(packet[7], 0x81);
});

test("Cobra DPI read uses the no-store byte openrazer pairs with writes", () => {
  const packet = encodeRazerRequest(COBRA_DPI_READ, COBRA_TRANSACTION_ID);

  assert.equal(packet[6], 0x04);
  assert.equal(packet[7], 0x85);
  assert.equal(packet[8], 0x00);
});

test("Cobra DPI write carries the storage byte and reads back through no-store", () => {
  const write = encodeRazerRequest(razerSetDpiCommand(1600, 800), COBRA_TRANSACTION_ID);
  const read = encodeRazerRequest(COBRA_DPI_READ, COBRA_TRANSACTION_ID);

  assert.deepEqual([...write.slice(8, 15)], [0x01, 0x06, 0x40, 0x03, 0x20, 0x00, 0x00]);
  assert.equal(read[8], 0x00);
});

test("Cobra polling writes the legacy divisor of 1000", () => {
  const packet = encodeRazerRequest(razerSetLegacyPollingCommand(500), COBRA_TRANSACTION_ID);

  assert.equal(packet[1], 0xff);
  assert.deepEqual([packet[6], packet[7], packet[8]], [0x00, 0x05, 2]);
});

test("Cobra effects match openrazer's extended matrix payloads", () => {
  const cases: Array<{ effect: "off" | "static" | "spectrum" | "reactive" | "breathing-random" | "breathing-single" | "breathing-dual"; options?: object; dataSize: number; args: number[] }> = [
    { effect: "off", dataSize: 0x06, args: [0x01, 0x04, 0x00, 0x00, 0x00, 0x00] },
    { effect: "static", options: { color: "#ff0000" }, dataSize: 0x09, args: [0x01, 0x04, 0x01, 0x00, 0x00, 0x01, 0xff, 0x00, 0x00] },
    { effect: "spectrum", dataSize: 0x06, args: [0x01, 0x04, 0x03, 0x00, 0x00, 0x00] },
    { effect: "reactive", options: { color: "#00ff00", speed: 2 }, dataSize: 0x09, args: [0x01, 0x04, 0x05, 0x00, 0x02, 0x01, 0x00, 0xff, 0x00] },
    { effect: "breathing-random", dataSize: 0x06, args: [0x01, 0x04, 0x02, 0x00, 0x00, 0x00] },
    { effect: "breathing-single", options: { color: "#0000ff" }, dataSize: 0x09, args: [0x01, 0x04, 0x02, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff] },
    { effect: "breathing-dual", options: { color: "#ff0000", color2: "#00ff00" }, dataSize: 0x0c, args: [0x01, 0x04, 0x02, 0x02, 0x00, 0x02, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00] },
  ];

  for (const { effect, options, dataSize, args } of cases) {
    const command = razerSetExtendedEffectCommand(effect, options as Parameters<typeof razerSetExtendedEffectCommand>[1]);
    const packet = encodeRazerRequest(command, COBRA_EFFECT_TRANSACTION_ID);
    assert.equal(command.commandClass, 0x0f);
    assert.equal(command.commandId, 0x02);
    assert.equal(command.dataSize, dataSize);
    assert.deepEqual(command.args, args);
    assert.equal(packet[1], 0x1f);
  }
});

test("Cobra accepts only its own PID on a control interface", () => {
  const control = {
    vendorId: 0x1532,
    productId: COBRA_PRODUCT_ID,
    collections: [{ usagePage: 0x01, usage: 0x02, featureReports: [], children: [] }],
  } as unknown as HIDDevice;
  const wrongPid = { ...control, productId: 0x008a } as unknown as HIDDevice;

  assert.equal(RazerCobraHidClient.isSupported(control), true);
  assert.equal(RazerCobraHidClient.isSupported(wrongPid), false);
});
