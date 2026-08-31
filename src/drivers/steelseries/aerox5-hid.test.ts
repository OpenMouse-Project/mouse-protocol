import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesAerox5HidClient } from "./aerox5-hid.ts";

function fakeDevice(options: { productId?: number } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1850,
    productName: "SteelSeries Aerox 5",
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
    sendFeatureReport: async () => { throw new Error("the Aerox 5 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Aerox 5 protocol does not use feature reports"); },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the plain Aerox 5 product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesAerox5HidClient.isSupported(device), true);
  // Sibling SteelSeries PIDs already claimed by other families must not be claimed.
  assert.equal(SteelSeriesAerox5HidClient.isSupported({ ...device, productId: 0x1824 } as HIDDevice), false); // Rival 3
  assert.equal(SteelSeriesAerox5HidClient.isSupported({ ...device, productId: 0x1836 } as HIDDevice), false); // Aerox 3
  assert.equal(SteelSeriesAerox5HidClient.isSupported({ ...device, productId: 0x1830 } as HIDDevice), false); // Rival 3 Wireless
  assert.equal(SteelSeriesAerox5HidClient.isSupported({ ...device, productId: 0x1854 } as HIDDevice), false); // Aerox 5 Wireless (wired mode)
  assert.equal(SteelSeriesAerox5HidClient.isSupported({ ...device, productId: 0x1852 } as HIDDevice), false); // Aerox 5 Wireless (2.4 GHz)
  assert.equal(SteelSeriesAerox5HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus never claims to have read anything — no getter exists on this device", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesAerox5HidClient(device).readStatus();
  assert.deepEqual(sent, []);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Aerox 5");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.ui?.valuesVerified, false);
});

test("setDpi and setPollingRate write the value then save, all on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox5HidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2d, 0x01, 0x00, 0x12] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x2b, 0x02] },
    { reportId: 0, payload: [0x11, 0x00] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("setZoneColor and setButtonsMapping write the packet then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox5HidClient(device);
  await client.setZoneColor(1, 255, 0, 0);
  await client.setButtonsMapping({ button9: { type: "dpiSwitch" } });
  const expected = new Array(55).fill(0x00);
  expected[0x28] = 0x30;
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x21, 0x01, 255, 0, 0] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x2a, ...expected] },
    { reportId: 0, payload: [0x11, 0x00] },
  ]);
});

test("invalid values are rejected before any report reaches the mouse", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox5HidClient(device);
  await assert.rejects(client.setDpi(150), /100 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /125, 250, 500, or 1000 Hz/);
  await assert.rejects(client.setLedBrightness(200), /0–100/);
  assert.deepEqual(sent, []);
});

test("concurrent setters never interleave their write/save pairs", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox5HidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125)]);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    [0x2d, 0x01, 0x00, 0x04],
    [0x11, 0x00],
    [0x2b, 0x04],
    [0x11, 0x00],
  ]);
});
