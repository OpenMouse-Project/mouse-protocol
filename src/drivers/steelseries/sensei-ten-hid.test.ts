import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesSenseiTenHidClient } from "./sensei-ten-hid.ts";

function fakeDevice(options: { productId?: number; answerFirmware?: boolean; firmware?: number[] } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  const feature: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1832,
    productName: "SteelSeries Sensei TEN",
    opened: true,
    collections: [],
    open: async () => {},
    close: async () => {},
    sendReport: async (reportId: number, data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const payload = [...view];
      sent.push({ reportId, payload });
      if (payload[0] === 0x90 && payload[1] === 0x00 && options.answerFirmware !== false) {
        const response = new Uint8Array(options.firmware ?? [0x25, 0x00]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async (reportId: number, data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      feature.push({ reportId, payload: [...view] });
    },
    receiveFeatureReport: async () => { throw new Error("not used by this driver"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent, feature };
}

test("claims both Sensei TEN product ids and rejects every sibling-cluster SteelSeries PID", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesSenseiTenHidClient.isSupported(device), true);
  assert.equal(SteelSeriesSenseiTenHidClient.isSupported({ ...device, productId: 0x1834 } as HIDDevice), true);
  for (const pid of [
    0x1824, 0x184c, // Rival 3 Gen 1
    0x1836, // Aerox 3
    0x1830, // Rival 3 Wireless
    0x1850, // Aerox 5
    0x1852, 0x1854, 0x185c, 0x185e, 0x1860, 0x1862, // Aerox 5 Wireless
    0x172b, 0x1726, // Rival 650
    0x185a, 0x1876, 0x1858, 0x1874, // Aerox 9 Wireless
    0x182c, // Prime+
    0x1720, 0x171e, 0x1736, // Rival 310
    0x184a, 0x1848, // Prime Mini Wireless
    0x1870, 0x1872, // documented-different Rival 3 Gen 2 / Wireless Gen 2
  ]) {
    assert.equal(SteelSeriesSenseiTenHidClient.isSupported({ ...device, productId: pid } as HIDDevice), false, `pid 0x${pid.toString(16)}`);
  }
  assert.equal(SteelSeriesSenseiTenHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and never claims to have read settings", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesSenseiTenHidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x90, 0x00] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Sensei TEN");
  assert.deepEqual(status.firmware, ["37.0"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the probe loudly and names SteelSeries GG", async () => {
  const { device, sent } = fakeDevice({ answerFirmware: false });
  await assert.rejects(new SteelSeriesSenseiTenHidClient(device).readStatus(), /SteelSeries GG/);
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x90, 0x00] }]);
});

test("setDpi and setPollingRate write the value then save, on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesSenseiTenHidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x55, 0x00, 0x01, 0x01, 0x20, 0x00] },
    { reportId: 0, payload: [0x59, 0x00] },
    { reportId: 0, payload: [0x54, 0x00, 0x02] },
    { reportId: 0, payload: [0x59, 0x00] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("setLedColor sends a feature report (not sendReport), then saves via output report", async () => {
  const { device, sent, feature } = fakeDevice();
  const client = new SteelSeriesSenseiTenHidClient(device);
  await client.setLedColor("logo", [{ pos: 0, r: 0xff, g: 0x00, b: 0x00 }]);
  assert.equal(feature.length, 1);
  assert.equal(feature[0]!.reportId, 0);
  assert.equal(feature[0]!.payload.length, 2 + 26 + 7);
  assert.deepEqual(feature[0]!.payload.slice(0, 2), [0x5b, 0x00]);
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x59, 0x00] }]);
});

test("setButtonsMapping writes the packet then saves", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesSenseiTenHidClient(device);
  await client.setButtonsMapping({ button6: { type: "dpiSwitch" } });
  const packet = new Array(40).fill(0x00);
  packet[0x19] = 0x30;
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x31, 0x00, ...packet] },
    { reportId: 0, payload: [0x59, 0x00] },
  ]);
});

test("setButtonsMapping defaults to rivalcfg's documented default mapping", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesSenseiTenHidClient(device);
  await client.setButtonsMapping();
  const expectedPacket = [
    0x01, 0x00, 0x00, 0x00, 0x00,
    0x02, 0x00, 0x00, 0x00, 0x00,
    0x03, 0x00, 0x00, 0x00, 0x00,
    0x04, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x00, 0x00, 0x00, 0x00,
    0x51, 0x4e, 0x00, 0x00, 0x00,
    0x51, 0x4b, 0x00, 0x00, 0x00,
    0x30, 0x00, 0x00, 0x00, 0x00,
  ];
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x31, 0x00, ...expectedPacket] },
    { reportId: 0, payload: [0x59, 0x00] },
  ]);
});

test("invalid values are rejected before any report reaches the mouse", async () => {
  const { device, sent, feature } = fakeDevice();
  const client = new SteelSeriesSenseiTenHidClient(device);
  await assert.rejects(client.setDpi(825), /50 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /125, 250, 500, or 1000 Hz/);
  await assert.rejects(client.setLedColor("logo", [{ pos: 0, r: 300, g: 0, b: 0 }]));
  assert.deepEqual(sent, []);
  assert.deepEqual(feature, []);
});

test("concurrent setters never interleave their write/save pairs", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesSenseiTenHidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125)]);
  assert.deepEqual(sent.map(({ payload }) => payload[0]), [0x55, 0x59, 0x54, 0x59]);
});
