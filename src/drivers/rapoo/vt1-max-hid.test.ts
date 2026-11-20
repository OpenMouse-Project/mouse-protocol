import assert from "node:assert/strict";
import test from "node:test";
import { createSupportedClient } from "../registry.ts";
import { RAPOO_VT1_MAX_HID_FILTERS } from "../vendors.ts";
import { RapooVt1MaxHidClient } from "./vt1-max-hid.ts";

function device(productId: number, usage = 2, vendorId = 0x24ae): HIDDevice {
  return {
    vendorId,
    productId,
    productName: "Rapoo Gaming Device",
    opened: false,
    collections: [{ usagePage: 0xff00, usage, children: [] }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
  } as unknown as HIDDevice;
}

test("VT1 MAX discovery is limited to the vendor configuration collection", () => {
  for (const productId of [0x1444, 0x4644]) {
    const hid = device(productId);
    assert.ok(createSupportedClient(hid) instanceof RapooVt1MaxHidClient);
    assert.ok(RAPOO_VT1_MAX_HID_FILTERS.some((filter) =>
      filter.vendorId === hid.vendorId && filter.productId === productId
      && filter.usagePage === 0xff00 && filter.usage === 2));
  }
  assert.equal(RapooVt1MaxHidClient.isSupported(device(0x1444, 14)), false);
  assert.equal(RapooVt1MaxHidClient.isSupported(device(0x1444, 2, 0x1234)), false);
  assert.equal(RapooVt1MaxHidClient.isSupported(device(0x1417)), false);
});

test("VT1 MAX identification does not query or invent settings", async () => {
  const hid = device(0x1444);
  const client = new RapooVt1MaxHidClient(hid);
  const status = await client.readStatus();
  assert.equal(hid.opened, true);
  assert.equal(status.name, "Rapoo VT1 MAX");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.batteryPercent, null);
  assert.equal(status.dpi, 0);
  assert.equal(status.pollingRateHz, 0);
  await client.close();
  assert.equal(hid.opened, false);
});
