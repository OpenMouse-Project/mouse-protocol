import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesPrimeMiniHidClient } from "./prime-mini-hid.ts";

function fakeDevice(options: { productId?: number; firmware?: number[]; answerFirmware?: boolean } = {}) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x184d,
    productName: "SteelSeries Prime Mini",
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
        const response = new Uint8Array(
          options.firmware ?? [0x31, 0x2e, 0x30, 0x2e, 0x31, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
        );
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Prime Mini protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Prime Mini protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Prime Mini product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesPrimeMiniHidClient.isSupported(device), true);
  // Prime Wireless twins and every other SteelSeries family must not be claimed.
  for (const productId of [0x184a, 0x1848, 0x1842, 0x1840, 0x182c, 0x182e, 0x1830, 0x1850, 0x1836]) {
    assert.equal(
      SteelSeriesPrimeMiniHidClient.isSupported({ ...device, productId } as HIDDevice),
      false,
      `must not claim product id 0x${productId.toString(16)}`,
    );
  }
  assert.equal(SteelSeriesPrimeMiniHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes firmware and reports stage defaults", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesPrimeMiniHidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x90, 0x00] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Prime Mini");
  assert.deepEqual(status.firmware, ["1.0.11"]);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("a silent interface fails the firmware probe loudly", async () => {
  const { device } = fakeDevice({ answerFirmware: false });
  const client = new SteelSeriesPrimeMiniHidClient(device);
  await assert.rejects(() => client.readStatus(), /did not answer the firmware query/);
});

test("setDpi edits the active stage and rewrites the table plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimeMiniHidClient(device);
  await client.readStatus();
  sent.length = 0;
  const dpi = await client.setDpi(1600);
  assert.equal(dpi, 1600);
  assert.deepEqual(sent, [
    {
      reportId: 0,
      payload: [0x2d, 0x05, 0x00, 0x20, 0x00, 0x10, 0x00, 0x18, 0x00, 0x30, 0x00, 0x40, 0x00],
    },
    { reportId: 0, payload: [0x11] },
  ]);
});

test("setActiveDpiStage switches the stage without changing values", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimeMiniHidClient(device);
  await client.readStatus();
  sent.length = 0;
  const stage = await client.setActiveDpiStage(2);
  assert.equal(stage, 2);
  assert.deepEqual(sent[0], {
    reportId: 0,
    payload: [0x2d, 0x05, 0x02, 0x08, 0x00, 0x10, 0x00, 0x18, 0x00, 0x30, 0x00, 0x40, 0x00],
  });
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x11] });
  await assert.rejects(() => client.setActiveDpiStage(5), /holds 5 DPI stages/);
});

test("setPollingRate, setButtonsMapping, and setZoneColor write plus save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimeMiniHidClient(device);
  await client.readStatus();
  sent.length = 0;
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2b, 0x02] },
    { reportId: 0, payload: [0x11] },
  ]);
  sent.length = 0;
  await client.setButtonsMapping({ button6: { type: "disabled" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.payload[0], 0x2a);
  assert.equal(sent[0]?.payload.length, 41);
  assert.equal(sent[0]?.payload[1 + 5 * 5], 0x00);
  assert.deepEqual(sent[1], { reportId: 0, payload: [0x11] });
  sent.length = 0;
  await client.setZoneColor(0, 0, 255);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x21, 0x00, 0x00, 0x00, 0xff] },
    { reportId: 0, payload: [0x11] },
  ]);
});
