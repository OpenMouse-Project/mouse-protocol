import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival110HidClient } from "./rival-110-hid.ts";

function fakeDevice(options: { productId?: number; firmware?: number[]; activePreset?: number; answer?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const reply = (bytes: number[]) => {
    const response = new Uint8Array(bytes);
    queueMicrotask(() =>
      listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
  };
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1729,
    productName: "SteelSeries Rival 110",
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
      if (payload[0] === 0x10 && payload[1] === 0x00) reply(options.firmware ?? [0x05, 0x02]);
      if (payload[0] === 0x16 && payload[1] === 0x00) reply([options.activePreset ?? 0x01]);
    },
    sendFeatureReport: async () => { throw new Error("the Rival 110 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 110 protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims the Rival 110 family product ids and nothing else", () => {
  const { device } = fakeDevice();
  for (const productId of [0x1729, 0x1816, 0x1810]) {
    assert.equal(
      SteelSeriesRival110HidClient.isSupported({ ...device, productId } as HIDDevice),
      true,
      `expected 0x${productId.toString(16)} to be claimed`,
    );
  }
  for (const productId of [0x1702, 0x1814, 0x1824, 0x1836]) {
    assert.equal(
      SteelSeriesRival110HidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesRival110HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and the active preset, reporting that preset's default", async () => {
  const { device, sent } = fakeDevice({ activePreset: 0x02 });
  const status = await new SteelSeriesRival110HidClient(device).readStatus();
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x10, 0x00] },
    { reportId: 0, payload: [0x16, 0x00] },
  ]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 110");
  assert.deepEqual(status.firmware, ["2.5"]);
  assert.equal(status.connectionType, "Wired");
  // Active preset is 2, which this session has not written, so its default is shown.
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote?.includes("active preset (2)"));
});

test("a silent interface fails the firmware probe loudly", async () => {
  const { device } = fakeDevice({ answer: false });
  const client = new SteelSeriesRival110HidClient(device);
  await assert.rejects(() => client.readStatus(), /did not answer the firmware query/);
});

test("setDpi writes the active preset (1 by default) plus save", async () => {
  const { device, sent } = fakeDevice({ activePreset: 0x01 });
  const client = new SteelSeriesRival110HidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(800);
  assert.equal(dpi, 800);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x16, 0x00] },
    { reportId: 0, payload: [0x03, 0x01, 0x12] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});

test("setDpi writes preset 2 when the CPI button has selected it", async () => {
  const { device, sent } = fakeDevice({ activePreset: 0x02 });
  const client = new SteelSeriesRival110HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setDpi(3200);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x16, 0x00] },
    { reportId: 0, payload: [0x03, 0x02, 0x49] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  // readStatus now reports the value written to the active preset.
  sent.length = 0;
  const status = await client.readStatus();
  assert.equal(status.dpi, 3200);
});

test("setDpiPreset2 writes and records preset 2", async () => {
  const { device, sent } = fakeDevice({ activePreset: 0x01 });
  const client = new SteelSeriesRival110HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setDpiPreset2(1600);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x03, 0x02, 0x24] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});

test("setPollingRate, setLedColor, setLightEffect, and setButton6Mode write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival110HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x04, 0x00, 0x02] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setLedColor(0xff, 0x18, 0x00);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x05, 0x00, 0xff, 0x18, 0x00] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setLightEffect("breath");
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x07, 0x00, 0x03] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setButton6Mode("os");
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x0b, 0x01] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});
