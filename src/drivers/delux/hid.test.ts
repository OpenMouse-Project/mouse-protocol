import assert from "node:assert/strict";
import test from "node:test";

import {
  DELUX_M800_MINI_WIRELESS_PID,
  DELUX_M800_MINI_WIRED_PID,
  DELUX_M800_PRO_WIRELESS_PID,
  DELUX_OEM_VENDOR_ID,
  DELUX_VENDOR_ID,
} from "../../delux/index.ts";
import {
  DeluxHidClient,
  resetDeluxDpiState,
  resetDeluxRuntimeState,
} from "./hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";

function fakeDevice(
  vendorId: number,
  productId: number,
  collections: Array<{ usagePage: number; usage: number }> = [],
  productName = "Delux M800 Mini",
): HIDDevice {
  const sentFeatureReports: Array<{ reportId: number; data: Uint8Array }> = [];
  return {
    vendorId,
    productId,
    productName,
    opened: false,
    collections: collections.map((c) => ({
      ...c,
      type: 0,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [],
    })),
    async open() {
      (this as any).opened = true;
    },
    async close() {
      (this as any).opened = false;
    },
    addEventListener() {},
    removeEventListener() {},
    async sendFeatureReport(reportId: number, data: BufferSource) {
      const arr = new Uint8Array(
        ArrayBuffer.isView(data)
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data,
      );
      sentFeatureReports.push({ reportId, data: arr });
    },
    sentFeatureReports,
  } as unknown as HIDDevice & { sentFeatureReports: Array<{ reportId: number; data: Uint8Array }> };
}

test("DeluxHidClient: isSupported identifies Delux devices", () => {
  // Delux M800 Mini 2.4G wireless (Node / Bridge native mode: empty collections)
  const nativeDongle = fakeDevice(DELUX_OEM_VENDOR_ID, DELUX_M800_MINI_WIRELESS_PID, []);
  assert.equal(DeluxHidClient.isSupported(nativeDongle), true);

  // Delux M800 Mini wired
  const wired = fakeDevice(DELUX_OEM_VENDOR_ID, DELUX_M800_MINI_WIRED_PID, []);
  assert.equal(DeluxHidClient.isSupported(wired), true);

  // Delux M800 Pro (0x248A)
  const pro = fakeDevice(DELUX_VENDOR_ID, DELUX_M800_PRO_WIRELESS_PID, []);
  assert.equal(DeluxHidClient.isSupported(pro), true);

  // Delux M800 Mini via WebHID (interface 2 has Consumer 0x0C)
  const webDongle = fakeDevice(DELUX_OEM_VENDOR_ID, DELUX_M800_MINI_WIRELESS_PID, [{ usagePage: 0x0c, usage: 1 }]);
  assert.equal(DeluxHidClient.isSupported(webDongle), true);

  // Unrelated vendor or PID
  assert.equal(DeluxHidClient.isSupported(fakeDevice(0x1234, 0x5678, [])), false);
  assert.equal(DeluxHidClient.isSupported(fakeDevice(DELUX_OEM_VENDOR_ID, 0x9999, [])), false);
});

test("DeluxHidClient: registry creates Delux client with brand 'Delux'", () => {
  const dongle = fakeDevice(DELUX_OEM_VENDOR_ID, DELUX_M800_MINI_WIRELESS_PID, []);
  const client = createSupportedClient(dongle);
  assert.ok(client instanceof DeluxHidClient);
  assert.equal(deviceBrand(client), "Delux");
});

test("DeluxHidClient: readStatus and polling rates", async () => {
  resetDeluxDpiState();
  resetDeluxRuntimeState();

  const dev = fakeDevice(DELUX_OEM_VENDOR_ID, DELUX_M800_MINI_WIRELESS_PID, []);
  const client = new DeluxHidClient(dev);

  const status = await client.readStatus();
  assert.equal(status.brand, "Delux");
  assert.equal(status.name, "Delux M800 Mini (Wireless)");
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.connectionType, "Wireless");

  // Change polling rate to 500Hz
  await client.setPollingRate(500);
  const updated = await client.readStatus();
  assert.equal(updated.pollingRateHz, 500);

  // Last feature report should be 0x06 with 500Hz rate byte (0x02)
  const sent = (dev as any).sentFeatureReports;
  const lastPolling = sent.find((r: any) => r.reportId === 0x06);
  assert.ok(lastPolling);
  assert.equal(lastPolling.data[2], 0x02); // 500Hz rate byte

  // Reject unsupported polling rate
  await assert.rejects(async () => {
    await client.setPollingRate(8000);
  });
});

test("DeluxHidClient: DPI stages, angle snapping, and ripple control", async () => {
  resetDeluxDpiState();
  const dev = fakeDevice(DELUX_OEM_VENDOR_ID, DELUX_M800_MINI_WIRELESS_PID, []);
  const client = new DeluxHidClient(dev);

  await client.setDpi(3200);
  let status = await client.readStatus();
  assert.equal(status.dpi, 3200);

  await client.setActiveDpiStage(2);
  status = await client.readStatus();
  assert.equal(status.activeDpiStage, 2);

  await client.setAngleSnapping(true);
  status = await client.readStatus();
  assert.equal(status.angleSnapping, true);

  await client.setRippleControl(false);
  status = await client.readStatus();
  assert.equal(status.rippleControl, false);

  await client.close();
  assert.equal(dev.opened, false);
});
