import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesAerox3HidClient } from "./aerox3-hid.ts";

function fakeDevice(options: { productId?: number } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1836,
    productName: "SteelSeries Aerox 3",
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
    sendFeatureReport: async () => { throw new Error("the Aerox 3 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Aerox 3 protocol does not use feature reports"); },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Aerox 3 product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesAerox3HidClient.isSupported(device), true);
  // Rival 3 Gen 1 must not be claimed by this driver, and vice versa.
  assert.equal(SteelSeriesAerox3HidClient.isSupported({ ...device, productId: 0x1824 } as HIDDevice), false);
  assert.equal(SteelSeriesAerox3HidClient.isSupported({ ...device, productId: 0x184c } as HIDDevice), false);
  // The PR #269 Rival 3 Gen 2 PID is deliberately not claimed either.
  assert.equal(SteelSeriesAerox3HidClient.isSupported({ ...device, productId: 0x1870 } as HIDDevice), false);
  assert.equal(SteelSeriesAerox3HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus never probes the device (no readable value exists) and never claims verified values", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesAerox3HidClient(device).readStatus();
  assert.deepEqual(sent, []);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Aerox 3");
  assert.deepEqual(status.firmware, []);
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("setDpi and setPollingRate write the value then save, on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3HidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2d, 0x01, 0x01, 0x24] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x2b, 0x02] },
    { reportId: 0, payload: [0x11, 0x00] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("lighting setters write the value then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3HidClient(device);
  await client.setZoneColor(1, 0xff, 0, 0);
  await client.setReactiveColor(null);
  await client.setLedBrightness(50);
  await client.setRainbowEffect("all");
  await client.setDefaultLighting("rainbow");
  await client.setButtonsMapping({ button1: { type: "dpiSwitch" } });
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x21, 0x01, 0xff, 0x00, 0x00] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x26, 0x00, 0x00, 0x00, 0x00, 0x00] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x23, 50] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x22, 0b111] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x27, 0x01, 0x00] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x2a, ...(() => { const p = new Array(40).fill(0x00); p[0x00] = 0x30; return p; })()] },
    { reportId: 0, payload: [0x11, 0x00] },
  ]);
});

test("concurrent setters are serialized in call order", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3HidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125)]);
  assert.deepEqual(sent.map((entry) => entry.payload[0]), [0x2d, 0x11, 0x2b, 0x11]);
});

test("invalid input is rejected before any write", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3HidClient(device);
  await assert.rejects(client.setDpi(850));
  await assert.rejects(client.setPollingRate(2000));
  assert.deepEqual(sent, []);
});
