import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival3WirelessV2HidClient } from "./rival-3-wireless-v2-hid.ts";

function fakeDevice(options: { productId?: number; battery?: number[]; firmware?: number[]; answer?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1872,
    productName: "SteelSeries Rival 3 Wireless Gen 2",
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
      if (payload[0] === 0xaa && payload[1] === 0x01) {
        const response = new Uint8Array(options.battery ?? [0x64, 0x00]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
      if (payload[0] === 0x10 && payload.length === 1) {
        const response = new Uint8Array(options.firmware ?? [0x01, 0x05]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Rival 3 Wireless Gen 2 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 3 Wireless Gen 2 protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Rival 3 Wireless Gen 2 product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesRival3WirelessV2HidClient.isSupported(device), true);
  for (const productId of [0x1830, 0x1824, 0x1836, 0x1870, 0x1850]) {
    assert.equal(
      SteelSeriesRival3WirelessV2HidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesRival3WirelessV2HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes battery and firmware without claiming charging state", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival3WirelessV2HidClient(device).readStatus();
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0xaa, 0x01] },
    { reportId: 0, payload: [0x10] },
  ]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 3 Wireless Gen 2");
  assert.deepEqual(status.firmware, ["1.5"]);
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the battery probe loudly and names SteelSeries GG", async () => {
  const { device } = fakeDevice({ answer: false });
  const client = new SteelSeriesRival3WirelessV2HidClient(device);
  await assert.rejects(() => client.readStatus(), /Close SteelSeries GG/);
});

test("setDpi edits both axes of the active stage plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3WirelessV2HidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(1600);
  assert.equal(dpi, 1600);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2c, 0x05, 0x01, 0x12, 0x09, 0x12, 0x1b, 0x26, 0x12, 0x09, 0x12, 0x1b, 0x26] },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("setPollingRate, setButtonsMapping, and setWheelMapping write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3WirelessV2HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x17, 0x01] },
    { reportId: 0, payload: [0x09] },
  ]);
  sent.length = 0;
  await client.setButtonsMapping({ button7: { type: "dpiSwitch" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.payload[0], 0x19);
  assert.equal(sent[0]?.payload.length, 1 + 7 * 5);
  assert.equal(sent[0]?.payload[1 + 6 * 5], 0x30);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x09] });
  sent.length = 0;
  await client.setWheelMapping({ scrollUp: { type: "button", target: "scrollUp" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.payload[0], 0x1a);
  assert.equal(sent[0]?.payload.length, 1 + 2 * 5);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x09] });
});
