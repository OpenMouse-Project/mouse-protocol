import assert from "node:assert/strict";
import test from "node:test";

import { GWolvesHidClient } from "./hid.ts";

function device(productId: number, reportId = 0x08, reportCount = 16): HIDDevice {
  return {
    vendorId: 0x33e4,
    productId,
    productName: "G-Wolves HTX Ultra 8K Wireless Mouse-RS",
    collections: [{
      usagePage: 0xff02,
      usage: 2,
      children: [],
      featureReports: [],
      inputReports: [{ reportId, items: [{ reportCount, reportSize: 8 }] }],
      outputReports: [{ reportId, items: [{ reportCount, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

test("support is driven by the product catalog, not hardcoded product ids", () => {
  // Arrange
  const wired = device(0x5618);
  const receiver = device(0x3854);
  const wrongVendor = { ...device(0x5618), vendorId: 0x3554 } as HIDDevice;
  const unknownModel = device(0x1234);
  const wrongReport = device(0x5618, 0x09, 48);

  // Act / Assert
  assert.equal(GWolvesHidClient.isSupported(wired), true);
  assert.equal(GWolvesHidClient.isSupported(receiver), true);
  assert.equal(GWolvesHidClient.isSupported(wrongVendor), false);
  assert.equal(GWolvesHidClient.isSupported(unknownModel), false);
  assert.equal(GWolvesHidClient.isSupported(wrongReport), false);
});

test("models the web driver drives over its 64-byte feature-report path are not claimed", () => {
  // Arrange: "XVI": "1" models in mouse.fit's env-models.json, including
  // "IsNewProtocol": "1" ones (HTM Plus, HSK Pro 2.0, HTXU 0x5608, Fenrir Pro).
  const featureReportModels = [0x3808, 0x3817, 0x6808, 0x6817, 0x5608, 0x5617, 0x3608, 0x3617, 0x3908, 0x2708, 0x5708, 0x5804];

  // Act / Assert: rejected even when the descriptor looks like report 8.
  for (const productId of featureReportModels) {
    assert.equal(GWolvesHidClient.isSupported(device(productId)), false, `0x${productId.toString(16)}`);
  }
});

test("transport metadata distinguishes receiver from cable via the catalog", () => {
  // Arrange / Act
  const wired = new GWolvesHidClient(device(0x5618));
  const receiver = new GWolvesHidClient(device(0x3854));

  // Assert
  assert.equal(wired.isWirelessPath(), false);
  assert.equal(receiver.isWirelessPath(), true);
});

test("poll interval is shorter over the wireless receiver", () => {
  // Arrange / Act
  const wired = new GWolvesHidClient(device(0x5618));
  const receiver = new GWolvesHidClient(device(0x3854));

  // Assert
  assert.equal(wired.pollIntervalMs, 30_000);
  assert.equal(receiver.pollIntervalMs, 10_000);
});

test("DPI options follow the shared VGN-family 50-step range", () => {
  // Arrange / Act
  const client = new GWolvesHidClient(device(0x5618));
  const options = client.getDpiOptions();

  // Assert
  assert.equal(options[0], 50);
  assert.equal(options[options.length - 1], 26_000);
  assert.equal(options.every((dpi) => dpi % 50 === 0), true);
});
