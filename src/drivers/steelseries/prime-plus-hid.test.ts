import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesPrimePlusHidClient } from "./prime-plus-hid.ts";

function fakeDevice(options: { productId?: number } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x182c,
    productName: "SteelSeries Prime+",
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
    sendFeatureReport: async () => { throw new Error("the Prime+ protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Prime+ protocol does not use feature reports"); },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Prime+ product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesPrimePlusHidClient.isSupported(device), true);
  // Every sibling-cluster PID (Rival 3 Gen 1, Aerox 3, Rival 3 Wireless,
  // Aerox 5, Aerox 5 Wireless, Rival 650, Aerox 9 Wireless) must not be
  // claimed by this driver.
  const foreignPids = [
    0x1824, // Rival 3 (pre-0.37 firmware)
    0x184c, // Rival 3 (post-0.37 firmware)
    0x1836, // Aerox 3
    0x1830, // Rival 3 Wireless
    0x1850, // Aerox 5
    0x1854, // Aerox 5 Wireless (wired mode)
    0x1852, // Aerox 5 Wireless (2.4 GHz mode)
    0x172b, // Rival 650 Wireless (wired mode)
    0x1726, // Rival 650 Wireless (2.4 GHz mode)
    0x185a, // Aerox 9 Wireless (wired mode)
    0x1858, // Aerox 9 Wireless (2.4 GHz mode)
    0x182e, // plain Prime — must NOT be claimed
    0x182a, // Prime Rainbow 6 Siege Black Ice Edition — must NOT be claimed
    0x1856, // Prime CS:GO Neo Noir Edition — must NOT be claimed
  ];
  for (const productId of foreignPids) {
    assert.equal(
      SteelSeriesPrimePlusHidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesPrimePlusHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus never probes the device (no readable value exists) and never claims verified values", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesPrimePlusHidClient(device).readStatus();
  assert.deepEqual(sent, []);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Prime+");
  assert.deepEqual(status.firmware, []);
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("setDpi and setPollingRate write the value then save, on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimePlusHidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    // (1600 - 50) / 50 + 1 = 32 = 0x0020, little-endian -> 0x20, 0x00
    { reportId: 0, payload: [0x61, 0x01, 0x00, 0x20, 0x00] },
    { reportId: 0, payload: [0x59] },
    { reportId: 0, payload: [0x5d, 0x02] },
    { reportId: 0, payload: [0x59] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("setColor and setLedBrightness write the value then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimePlusHidClient(device);
  await client.setColor(0xff, 0x52, 0x00);
  await client.setLedBrightness(256);
  assert.deepEqual(sent, [
    {
      reportId: 0,
      payload: [
        0x62, 0x01, 0xff, 0x52, 0x00,
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
        0xff,
      ],
    },
    { reportId: 0, payload: [0x59] },
    // 256 -> 0x0100 little-endian
    { reportId: 0, payload: [0x5f, 0x00, 0x01] },
    { reportId: 0, payload: [0x59] },
  ]);
});

test("setButtonsMapping writes a 30-byte packet then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimePlusHidClient(device);
  await client.setButtonsMapping({
    button1: { type: "button", target: "button2" },
    button6: { type: "dpiSwitch" },
  });
  const expectedPacket = new Array(30).fill(0x00);
  expectedPacket[0x00] = 0x02;
  expectedPacket[0x19] = 0x30;
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x5b, ...expectedPacket] },
    { reportId: 0, payload: [0x59] },
  ]);
});

test("concurrent setters are serialized in call order", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimePlusHidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125)]);
  assert.deepEqual(sent.map((entry) => entry.payload[0]), [0x61, 0x59, 0x5d, 0x59]);
});

test("invalid input is rejected before any write", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimePlusHidClient(device);
  await assert.rejects(client.setDpi(51));
  await assert.rejects(client.setDpi(18050));
  await assert.rejects(client.setPollingRate(2000));
  await assert.rejects(client.setLedBrightness(257));
  await assert.rejects(client.setColor(-1, 0, 0));
  assert.deepEqual(sent, []);
});
