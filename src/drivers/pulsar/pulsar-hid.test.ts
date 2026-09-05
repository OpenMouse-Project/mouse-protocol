import assert from "node:assert/strict";
import test from "node:test";

import { PulsarHidClient } from "./pulsar-hid.ts";

function device(vendorId: number, productId: number, reportId = 0x08): HIDDevice {
  return {
    vendorId,
    productId,
    productName: "Pulsar Mouse",
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      children: [],
      featureReports: [],
      inputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
      outputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

test("supports Pulsar receivers on the native vendor id", () => {
  assert.equal(PulsarHidClient.isSupported(device(0x3710, 0x0001)), true);
});

test("supports the Pulsar 4K Wireless Receiver on the shared VGN vendor id", () => {
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0x0002)), true);
});

test("does not claim product ids owned by the Teevolution and VGN drivers", () => {
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0xf520)), false);
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0xfb56)), false);
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0xf58f)), false);
});

test("rejects devices without the report-8 control collection", () => {
  const wrong = device(0x3554, 0x0002, 0x09);
  assert.equal(PulsarHidClient.isSupported(wrong), false);
});
