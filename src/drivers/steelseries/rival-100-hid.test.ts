import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival100HidClient } from "./rival-100-hid.ts";

function fakeDevice(options: { productId?: number; firmware?: number[]; answerFirmware?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1702,
    productName: "SteelSeries Rival 100",
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
        const response = new Uint8Array(options.firmware ?? [0x03, 0x01]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Rival 100 protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 100 protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims the Rival 100 family product ids and nothing else", () => {
  const { device } = fakeDevice();
  for (const productId of [0x1702, 0x1708, 0x170a, 0x170b, 0x170c, 0x1814]) {
    assert.equal(
      SteelSeriesRival100HidClient.isSupported({ ...device, productId } as HIDDevice),
      true,
      `expected 0x${productId.toString(16)} to be claimed`,
    );
  }
  // Rival 110/106/300S (a different sensor table) and modern families must not be claimed.
  for (const productId of [0x1729, 0x1816, 0x1810, 0x1824, 0x1836]) {
    assert.equal(
      SteelSeriesRival100HidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesRival100HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and never claims to have read DPI/polling", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival100HidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x10, 0x00] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 100");
  assert.deepEqual(status.firmware, ["1.3"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.dpi, 1000);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the firmware probe loudly", async () => {
  const { device } = fakeDevice({ answerFirmware: false });
  const client = new SteelSeriesRival100HidClient(device);
  await assert.rejects(() => client.readStatus(), /did not answer the firmware query/);
});

test("setDpi writes preset 1 plus save; setDpiPreset2 writes preset 2", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival100HidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(1000);
  assert.equal(dpi, 1000);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x03, 0x01, 0x06] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setDpiPreset2(2000);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x03, 0x02, 0x02] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});

test("setPollingRate, setLedColor, and setLightEffect write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival100HidClient(device);
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
});

test("setButton6Mode sends the plain packet, but the PC Bang edition gets its prefix", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival100HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setButton6Mode("os");
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x0b, 0x01] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);

  const pcBang = fakeDevice({ productId: 0x1708 });
  const pcBangClient = new SteelSeriesRival100HidClient(pcBang.device);
  await pcBangClient.readStatus();
  pcBang.sent.length = 0;
  await pcBangClient.setButton6Mode("os");
  assert.deepEqual(pcBang.sent, [
    { reportId: 0, payload: [0x00, 0x0e, 0x01] },
    { reportId: 0, payload: [0x0b, 0x01] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});
