import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesAerox3WirelessGen2HidClient } from "./aerox-3-wireless-gen2-hid.ts";

function fakeDevice(options: { productId?: number; battery?: number[]; firmware?: number[]; answer?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1892,
    productName: "SteelSeries Aerox 3 Wireless Gen 2",
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
      if (options.answer === false) return;
      if ((payload[0] === 0x92 || payload[0] === 0xd2) && payload.length === 1) {
        const response = new Uint8Array(options.battery ?? [0x01, 0x64]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
      if ((payload[0] === 0x90 || payload[0] === 0xd0) && payload[1] === 0x00) {
        const response = new Uint8Array(options.firmware ?? [0x31, 0x2e, 0x31, 0x2e, 0x35, ...new Array(7).fill(0x00)]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Aerox 3 Wireless Gen 2 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Aerox 3 Wireless Gen 2 protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims the wired and dongle product ids, and selects transport by PID", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesAerox3WirelessGen2HidClient.isSupported(device), true);
  assert.equal(
    SteelSeriesAerox3WirelessGen2HidClient.isSupported(fakeDevice({ productId: 0x1890 }).device),
    true,
  );
  for (const productId of [0x183a, 0x1838, 0x1854, 0x1852, 0x1830, 0x1836]) {
    assert.equal(
      SteelSeriesAerox3WirelessGen2HidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesAerox3WirelessGen2HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes battery and firmware without claiming charging state", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesAerox3WirelessGen2HidClient(device).readStatus();
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x92] },
    { reportId: 0, payload: [0x90, 0x00] },
  ]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Aerox 3 Wireless Gen 2");
  assert.deepEqual(status.firmware, ["1.1.5"]);
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000]);
});

test("a silent interface fails the battery probe loudly and names SteelSeries GG", async () => {
  const { device } = fakeDevice({ answer: false });
  const client = new SteelSeriesAerox3WirelessGen2HidClient(device);
  await assert.rejects(() => client.readStatus(), /Close SteelSeries GG/);
});

test("dongle mode ORs the wireless flag into every command", async () => {
  const { device, sent } = fakeDevice({ productId: 0x1890 });
  const client = new SteelSeriesAerox3WirelessGen2HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(1000);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x6b, 0x02, 0x02] },
    { reportId: 0, payload: [0x51, 0x00] },
  ]);
});

test("setDpi edits the active stage plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3WirelessGen2HidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(1600);
  assert.equal(dpi, 1600);
  assert.deepEqual(sent, [
    {
      reportId: 0,
      payload: [
        0x2d, 0x05, 0x00,
        0x40, 0x06, 0x40, 0x06, 0x00,
        0x20, 0x03, 0x20, 0x03, 0x00,
        0x40, 0x06, 0x40, 0x06, 0x00,
        0x60, 0x09, 0x60, 0x09, 0x00,
        0x80, 0x0c, 0x80, 0x0c, 0x00,
      ],
    },
    { reportId: 0, payload: [0x11, 0x00] },
  ]);
});
