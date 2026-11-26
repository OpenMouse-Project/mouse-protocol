import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival3Gen2HidClient } from "./rival-3-v2-hid.ts";

function fakeDevice(options: { productId?: number; firmware?: number[]; answerFirmware?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1870,
    productName: "SteelSeries Rival 3 Gen 2",
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
      if (payload[0] === 0x90 && options.answerFirmware !== false) {
        const response = new Uint8Array(
          options.firmware ?? [0x31, 0x2e, 0x31, 0x2e, 0x36, ...new Array(10).fill(0x00)],
        );
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Rival 3 Gen 2 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 3 Gen 2 protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Rival 3 Gen 2 product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesRival3Gen2HidClient.isSupported(device), true);
  // Gen 1, Aerox 3, and the wireless siblings must not be claimed.
  for (const productId of [0x1824, 0x184c, 0x1836, 0x1830, 0x1872, 0x1850]) {
    assert.equal(
      SteelSeriesRival3Gen2HidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesRival3Gen2HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and reports stage defaults", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival3Gen2HidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x90] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 3 Gen 2");
  assert.deepEqual(status.firmware, ["1.1.6"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the firmware probe loudly", async () => {
  const { device } = fakeDevice({ answerFirmware: false });
  const client = new SteelSeriesRival3Gen2HidClient(device);
  await assert.rejects(() => client.readStatus(), /did not answer the firmware query/);
});

test("setDpi edits both axes of the active stage plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3Gen2HidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(1600);
  assert.equal(dpi, 1600);
  assert.deepEqual(sent, [
    {
      reportId: 0,
      payload: [0x34, 0x05, 0x00, 0x24, 0x24, 0x12, 0x12, 0x24, 0x24, 0x37, 0x37, 0x49, 0x49],
    },
    { reportId: 0, payload: [0x11] },
  ]);
});

test("setPollingRate and setButtonsMapping write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3Gen2HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2b, 0x02] },
    { reportId: 0, payload: [0x11] },
  ]);
  sent.length = 0;
  await client.setButtonsMapping({ button6: { type: "scrollUp" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.payload[0], 0x2a);
  assert.equal(sent[0]?.payload.length, 1 + 8 * 5);
  assert.equal(sent[0]?.payload[1 + 5 * 5], 0x31);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x11] });
});
