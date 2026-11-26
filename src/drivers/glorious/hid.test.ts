import assert from "node:assert/strict";
import test from "node:test";

import { GloriousHidClient } from "./hid.ts";
import { VENDOR_ID, GLORIOUS_PRODUCTS } from "../vendors.ts";

test("claims the Mini / D 2 / I 2 Bluetooth PIDs from CORE's device table", () => {
  for (const productId of [0x821b, 0x824a, 0x824b, 0x824d, 0x825a, 0x826b, 0x827a, 0x832a]) {
    assert.equal(GLORIOUS_PRODUCTS.has(productId), true, `0x${productId.toString(16)} should be catalogued`);
  }
});

test("write-only status is flagged unverified but keeps the settings grid", async () => {
  const device = {
    vendorId: VENDOR_ID.glorious,
    productId: 0x822a,
    productName: "Model O 2 Wireless",
    opened: true,
    collections: [],
  } as unknown as HIDDevice;
  const status = await new GloriousHidClient(device).readStatus();
  assert.equal(status.ui?.valuesVerified, false);
  assert.notEqual(status.ui?.settingsReady, false);
});
