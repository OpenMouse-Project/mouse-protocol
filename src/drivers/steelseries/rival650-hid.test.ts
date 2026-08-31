import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival650HidClient } from "./rival650-hid.ts";

function fakeDevice(
  options: {
    productId?: number;
    answerBattery?: boolean;
    battery?: number[];
  } = {},
) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x172b,
    productName: "SteelSeries Rival 650 Wireless",
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
      if (payload[0] === 0xaa && payload[1] === 0x01 && options.answerBattery !== false) {
        const response = new Uint8Array(options.battery ?? [72, 0x00, 0x00]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Rival 650 Wireless protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 650 Wireless protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Rival 650 Wireless product ids", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesRival650HidClient.isSupported(device), true);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1726 } as HIDDevice), true);
  // Every sibling PID from clusters 1-4 must not be claimed.
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1824 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x184c } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1836 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1830 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1850 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1854 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x185e } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1862 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1852 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x185c } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1860 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes battery only, reports no firmware, and never claims to have read DPI/polling/LOD", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0xaa, 0x01] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 650 Wireless");
  assert.deepEqual(status.firmware, []);
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryPercent, 72);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("readStatus reports a charging battery", async () => {
  const { device } = fakeDevice({ battery: [55, 0x00, 0x01] });
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.equal(status.batteryPercent, 55);
  assert.equal(status.batteryState, "Charging");
});

test("a silent interface fails the battery probe loudly and names SteelSeries GG", async () => {
  const { device, sent } = fakeDevice({ answerBattery: false });
  await assert.rejects(new SteelSeriesRival650HidClient(device).readStatus(), /SteelSeries GG/);
  assert.deepEqual(sent, [{ reportId: 0, payload: [0xaa, 0x01] }]);
});

test("setDpi, setPollingRate, and setLiftOffDistance write the value then save, all on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setLiftOffDistance(2), 2);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x15, 0x01, 0x0f] },
    { reportId: 0, payload: [0x09] },
    { reportId: 0, payload: [0x17, 0x02] },
    { reportId: 0, payload: [0x09] },
    { reportId: 0, payload: [0x20, 0x01, 0x6f, 0x73] },
    { reportId: 0, payload: [0x09] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("setSleepTimer writes the value then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await client.setSleepTimer(5);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2b, 0x01, 0x01, 0x00, 0x00, 0x00, 0x2c, 0x01] },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("setButtonsMapping writes the packet then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await client.setButtonsMapping({ button6: { type: "dpiSwitch" } });
  const expected = new Array(35).fill(0x00);
  expected[0x19] = 0x30;
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x19, ...expected] },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("invalid values are rejected before any report reaches the mouse", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await assert.rejects(client.setDpi(150), /100 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /125, 250, 500, or 1000 Hz/);
  await assert.rejects(client.setLiftOffDistance(9), Error);
  await assert.rejects(client.setSleepTimer(21), /1–20 minutes/);
  assert.deepEqual(sent, []);
});

test("concurrent setters never interleave their write/save pairs", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125), client.setLiftOffDistance(8)]);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    [0x15, 0x01, 0x03],
    [0x09],
    [0x17, 0x04],
    [0x09],
    [0x20, 0x01, 0x51, 0x55],
    [0x09],
  ]);
});
