import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesSenseiRawHidClient } from "./sensei-raw-hid.ts";

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
    productId: options.productId ?? 0x1369,
    productName: "SteelSeries Sensei [RAW]",
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
      if (payload[0] === 0x10 && payload[1] === 0x00) reply(options.firmware ?? [0x03, 0x01]);
      if (payload[0] === 0x16 && payload[1] === 0x00) reply([options.activePreset ?? 0x01]);
    },
    sendFeatureReport: async () => { throw new Error("the Sensei [RAW] protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Sensei [RAW] protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims the Sensei [RAW] family product ids and nothing else", () => {
  const { device } = fakeDevice();
  for (const productId of [0x1369, 0x1362, 0x136d, 0x136f, 0x1380, 0x1390]) {
    assert.equal(
      SteelSeriesSenseiRawHidClient.isSupported({ ...device, productId } as HIDDevice),
      true,
      `expected 0x${productId.toString(16)} to be claimed`,
    );
  }
  // Sensei TEN, Sensei [RAW] Optical RGB (rival-310 based) and modern families must not be claimed.
  for (const productId of [0x1832, 0x1800, 0x1826, 0x1824, 0x1729]) {
    assert.equal(
      SteelSeriesSenseiRawHidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesSenseiRawHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and the active preset, reporting that preset's default", async () => {
  const { device, sent } = fakeDevice({ activePreset: 0x02 });
  const status = await new SteelSeriesSenseiRawHidClient(device).readStatus();
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x10, 0x00] },
    { reportId: 0, payload: [0x16, 0x00] },
  ]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Sensei [RAW]");
  assert.deepEqual(status.firmware, ["1.3"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.dpi, 3240);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote?.includes("active preset (2)"));
});

test("a silent interface fails the firmware probe loudly", async () => {
  const { device } = fakeDevice({ answer: false });
  const client = new SteelSeriesSenseiRawHidClient(device);
  await assert.rejects(() => client.readStatus(), /did not answer the firmware query/);
});

test("setDpi writes the active preset (1 by default) plus save", async () => {
  const { device, sent } = fakeDevice({ activePreset: 0x01 });
  const client = new SteelSeriesSenseiRawHidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(1620);
  assert.equal(dpi, 1620);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x16, 0x00] },
    { reportId: 0, payload: [0x03, 0x01, 0x12] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});

test("setDpi writes preset 2 when the CPI button has selected it", async () => {
  const { device, sent } = fakeDevice({ activePreset: 0x02 });
  const client = new SteelSeriesSenseiRawHidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setDpi(3240);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x16, 0x00] },
    { reportId: 0, payload: [0x03, 0x02, 0x24] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
});

test("setPollingRate, LED brightness/effect, and buttons mapping write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesSenseiRawHidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x04, 0x00, 0x02] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setLedBrightness("medium");
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x05, 0x01, 0x03] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setLedEffect("trigger");
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x07, 0x01, 0x05] },
    { reportId: 0, payload: [0x09, 0x00] },
  ]);
  sent.length = 0;
  await client.setButtonsMapping({ button8: { type: "dpiSwitch" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.payload[0], 0x31);
  assert.equal(sent[0]?.payload.length, 2 + 8 * 3);
  assert.equal(sent[0]?.payload[2 + 0x15], 0x30);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x09, 0x00] });
});
