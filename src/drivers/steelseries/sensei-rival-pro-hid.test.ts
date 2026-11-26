import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesSenseiRivalProHidClient } from "./sensei-rival-pro-hid.ts";

function fakeDevice(options: { productId?: number } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1880,
    productName: "SteelSeries Sensei Pro",
    opened: true,
    collections: [],
    open: async () => {},
    close: async () => {},
    sendReport: async (reportId: number, data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      sent.push({ reportId, payload: [...view] });
    },
    sendFeatureReport: async () => { throw new Error("the Sensei Pro / Rival Pro protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Sensei Pro / Rival Pro protocol does not use feature reports"); },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the base station and dongle product ids", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesSenseiRivalProHidClient.isSupported(device), true);
  assert.equal(
    SteelSeriesSenseiRivalProHidClient.isSupported(fakeDevice({ productId: 0x1882 }).device),
    true,
  );
  // Neighboring SteelSeries mice must not be claimed.
  assert.equal(
    SteelSeriesSenseiRivalProHidClient.isSupported(fakeDevice({ productId: 0x1830 }).device),
    false,
  );
  assert.equal(
    SteelSeriesSenseiRivalProHidClient.isSupported(fakeDevice({ productId: 0x1872 }).device),
    false,
  );
  assert.equal(
    SteelSeriesSenseiRivalProHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice),
    false,
  );
});

test("readStatus sends nothing and reports assumed defaults", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesSenseiRivalProHidClient(device).readStatus();
  assert.deepEqual(sent, []);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Sensei Pro");
  assert.deepEqual(status.firmware, []);
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
});

test("setDpi writes a five-identical-preset table plus save", async () => {
  const { device, sent } = fakeDevice();
  const dpi = await new SteelSeriesSenseiRivalProHidClient(device).setDpi(1600);
  assert.equal(dpi, 1600);
  assert.deepEqual(sent, [
    {
      reportId: 0,
      payload: [
        0x34, 0x05, 0x00,
        0x40, 0x06, 0x40, 0x06, 0x00, 0x00,
        0x40, 0x06, 0x40, 0x06, 0x00, 0x00,
        0x40, 0x06, 0x40, 0x06, 0x00, 0x00,
        0x40, 0x06, 0x40, 0x06, 0x00, 0x00,
        0x40, 0x06, 0x40, 0x06, 0x00, 0x00,
      ],
    },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("setPollingRate writes the single polling command plus save", async () => {
  const { device, sent } = fakeDevice();
  const rate = await new SteelSeriesSenseiRivalProHidClient(device).setPollingRate(8000);
  assert.equal(rate, 8000);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2c, 0x00, 0x00] },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("setButtonsMapping writes the 40-byte mapping plus save", async () => {
  const { device, sent } = fakeDevice();
  await new SteelSeriesSenseiRivalProHidClient(device).setButtonsMapping({
    button1: { type: "button", target: "button1" },
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.reportId, 0);
  assert.equal(sent[0]?.payload.length, 41);
  assert.equal(sent[0]?.payload[0], 0x2a);
  assert.equal(sent[0]?.payload[1], 0x01);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x09] });
});
