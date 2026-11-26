import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival600HidClient } from "./rival-600-hid.ts";

function fakeDevice(options: { productId?: number; firmware?: number[]; answerFirmware?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[]; feature?: boolean }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1724,
    productName: "SteelSeries Rival 600",
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
        const response = new Uint8Array(options.firmware ?? [0x34, 0x02]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async (reportId: number, data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      sent.push({ reportId, payload: [...view], feature: true });
    },
    receiveFeatureReport: async () => { throw new Error("the Rival 600 protocol does not read feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims the Rival 600 product ids and nothing else", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesRival600HidClient.isSupported(device), true);
  assert.equal(SteelSeriesRival600HidClient.isSupported({ ...device, productId: 0x172e } as HIDDevice), true);
  // Rival 650 Wireless, Rival 310, Rival 3, and siblings must not be claimed.
  for (const productId of [0x172b, 0x1726, 0x1720, 0x1824, 0x1836, 0x1830]) {
    assert.equal(
      SteelSeriesRival600HidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesRival600HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and never claims to have read DPI/polling", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival600HidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x10, 0x00] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 600");
  assert.deepEqual(status.firmware, ["2.52"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the firmware probe loudly", async () => {
  const { device } = fakeDevice({ answerFirmware: false });
  const client = new SteelSeriesRival600HidClient(device);
  await assert.rejects(() => client.readStatus(), /did not answer the firmware query/);
});

test("setDpi writes preset 1 plus save; setDpiPreset2 writes preset 2", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival600HidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(800);
  assert.equal(dpi, 800);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x03, 0x00, 0x01, 0x07, 0x00, 0x42] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setDpiPreset2(1600);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x03, 0x00, 0x02, 0x0f, 0x00, 0x42] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});

test("setPollingRate and setProximity write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival600HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x04, 0x00, 0x02] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setProximity(true, 0x10, 0x80);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x96, 0x00, 0x01, 0x10, 0x80] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});

test("setButtonsMapping sends a feature report then a save output report", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival600HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setButtonsMapping({ button7: { type: "dpiSwitch" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.feature, true);
  assert.equal(sent[0]?.payload[0], 0x31);
  assert.equal(sent[0]?.payload.length, 2 + 7 * 5);
  assert.equal(sent[0]?.payload[2 + 6 * 5], 0x30);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x09, 0x00] });
});
