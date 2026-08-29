import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival3HidClient } from "./hid.ts";

function fakeDevice(options: { productId?: number; answerFirmware?: boolean; firmware?: number[] } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1824,
    productName: "SteelSeries Rival 3",
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
      if (payload[0] === 0x10 && payload[1] === 0x00 && options.answerFirmware !== false) {
        const response = new Uint8Array(options.firmware ?? [0x25, 0x00]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Rival 3 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 3 protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the two Rival 3 Gen 1 product ids", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesRival3HidClient.isSupported(device), true);
  assert.equal(SteelSeriesRival3HidClient.isSupported({ ...device, productId: 0x184c } as HIDDevice), true);
  // Documented different-protocol siblings: Rival 3 Wireless, Gen 2, Wireless Gen 2.
  assert.equal(SteelSeriesRival3HidClient.isSupported({ ...device, productId: 0x1830 } as HIDDevice), false);
  assert.equal(SteelSeriesRival3HidClient.isSupported({ ...device, productId: 0x1870 } as HIDDevice), false);
  assert.equal(SteelSeriesRival3HidClient.isSupported({ ...device, productId: 0x1872 } as HIDDevice), false);
  assert.equal(SteelSeriesRival3HidClient.isSupported({ ...device, productId: 0xffff } as HIDDevice), false);
  assert.equal(SteelSeriesRival3HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and never claims to have read settings", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival3HidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x10, 0x00] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 3");
  assert.deepEqual(status.firmware, ["37.0"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryPercent, null);
  // rivalcfg defaults, flagged as assumptions rather than device readings.
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the probe loudly and names SteelSeries GG", async () => {
  const { device, sent } = fakeDevice({ answerFirmware: false });
  await assert.rejects(new SteelSeriesRival3HidClient(device).readStatus(), /SteelSeries GG/);
  // The probe was the only report sent; nothing else was attempted blind.
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x10, 0x00] }]);
});

test("setters write the value then the save command, all on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3HidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x0b, 0x00, 0x01, 0x01, 0x24] },
    { reportId: 0, payload: [0x09, 0x00] },
    { reportId: 0, payload: [0x04, 0x00, 0x02] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("invalid values are rejected before any report reaches the mouse", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3HidClient(device);
  await assert.rejects(client.setDpi(850), /100 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /125, 250, 500, or 1000 Hz/);
  assert.deepEqual(sent, []);
});

test("concurrent setters never interleave their write/save pairs", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3HidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125)]);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    [0x0b, 0x00, 0x01, 0x01, 0x08],
    [0x09, 0x00],
    [0x04, 0x00, 0x04],
    [0x09, 0x00],
  ]);
});
