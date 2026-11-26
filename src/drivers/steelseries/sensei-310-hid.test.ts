import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesSensei310HidClient } from "./sensei-310-hid.ts";

function fakeDevice(options: { productId?: number; firmware?: number[]; answerFirmware?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[]; feature?: boolean }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1722,
    productName: "SteelSeries Sensei 310",
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
      sent.push({ reportId, payload: [...view], feature: true });
    },
    receiveFeatureReport: async () => { throw new Error("the Sensei 310 protocol does not read feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Sensei 310 product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesSensei310HidClient.isSupported(device), true);
  // Rival 310 and every other SteelSeries family must not be claimed.
  for (const productId of [0x1720, 0x171e, 0x1736, 0x1832, 0x1824, 0x1836, 0x1830, 0x1850]) {
    assert.equal(
      SteelSeriesSensei310HidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesSensei310HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and never claims to have read DPI/polling", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesSensei310HidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x90, 0x00] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Sensei 310");
  assert.deepEqual(status.firmware, ["37.0"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the firmware probe loudly", async () => {
  const { device } = fakeDevice({ answerFirmware: false });
  const client = new SteelSeriesSensei310HidClient(device);
  await assert.rejects(() => client.readStatus(), /did not answer the firmware query/);
});

test("setDpi writes sensitivity preset 1 plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesSensei310HidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(800);
  assert.equal(dpi, 800);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x53, 0x00, 0x01, 0x07, 0x00, 0x42] },
    { reportId: 0, payload: [0x59, 0x00] },
  ]);
});

test("setPollingRate, setLedColor, and setButtonsMapping write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesSensei310HidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x54, 0x00, 0x02] },
    { reportId: 0, payload: [0x59, 0x00] },
  ]);
  sent.length = 0;
  await client.setLedColor("wheel", 0, 255, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.feature, true);
  assert.equal(sent[0]?.payload[0], 0x5b);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x59, 0x00] });
  sent.length = 0;
  await client.setButtonsMapping({ button7: { type: "dpiSwitch" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.payload[0], 0x31);
  assert.equal(sent[0]?.payload.length, 2 + 8 * 5);
  assert.equal(sent[0]?.payload[2 + 0x1e], 0x30);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x59, 0x00] });
});
