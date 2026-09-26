import assert from "node:assert/strict";
import test from "node:test";

import { GloriousHidClient } from "./hid.ts";
import { VENDOR_ID } from "../vendors.ts";

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
