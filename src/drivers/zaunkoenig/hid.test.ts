import assert from "node:assert/strict";
import test from "node:test";

import { ZAUNKOENIG_M3K_PRODUCT_ID, ZAUNKOENIG_VENDOR_ID } from "../../zaunkoenig/index.ts";
import { ZaunkoenigHidClient } from "./hid.ts";

function fakeDevice() {
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  let configWord = 0x220f; // M3K defaults: HS, 8 kHz, 2 mm, 800 DPI.
  const device = {
    vendorId: ZAUNKOENIG_VENDOR_ID,
    productId: ZAUNKOENIG_M3K_PRODUCT_ID,
    productName: "M3K",
    opened: true,
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      type: 1,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [2, 3].map((reportId) => ({ reportId, items: [{ reportSize: 8, reportCount: 32 }] })),
    }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      const view = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      const payload = new Uint8Array(view);
      sent.push({ reportId, payload });
      if (reportId === 3 && payload[2] === 0xff && payload[3] === 0xff) configWord = 0x220f;
      else if (reportId === 3) configWord = payload[0]! | (payload[1]! << 8);
    },
    receiveFeatureReport: async (reportId: number) => {
      if (reportId === 2) {
        return new DataView(new Uint8Array([2, ...Buffer.from("parawizard new v0.8.2"), 0]).buffer);
      }
      return new DataView(new Uint8Array([3, configWord & 0xff, configWord >> 8, 0, 0]).buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("recognizes only the vendor collection carrying reports 2 and 3", () => {
  const { device } = fakeDevice();
  assert.equal(ZaunkoenigHidClient.isSupported(device), true);
  assert.equal(ZaunkoenigHidClient.isSupported({ ...device, productId: 0xffff } as HIDDevice), false);
  assert.equal(ZaunkoenigHidClient.isSupported({ ...device, collections: [] } as unknown as HIDDevice), false);
});

test("reads all settings exposed by Zaunkoenfigurator", async () => {
  const status = await new ZaunkoenigHidClient(fakeDevice().device).readStatus();
  assert.equal(status.brand, "Zaunkoenig");
  assert.equal(status.name, "M3K");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 8000);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.angleSnapping, false);
  assert.equal(status.usbSpeed, "High");
  assert.equal(status.primaryButton, "Left");
  assert.deepEqual(status.firmware, ["parawizard new v0.8.2"]);
});

test("writes through one packed config report and confirms readback", async () => {
  const { device, sent } = fakeDevice();
  const client = new ZaunkoenigHidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(2000), 2000);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(await client.setPrimaryButton("Right"), "Right");
  assert.ok(sent.every(({ reportId, payload }) => reportId === 3 && payload.length === 4));
});

test("sends the factory-reset sentinel", async () => {
  const { device, sent } = fakeDevice();
  const client = new ZaunkoenigHidClient(device);
  await client.setDpi(1600);
  const status = await client.factoryReset();
  assert.equal(status.dpi, 800);
  assert.deepEqual([...sent.at(-1)!.payload], [0, 0, 0xff, 0xff]);
});
