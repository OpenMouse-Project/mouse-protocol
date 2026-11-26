import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORTED_HID_FILTERS, VENDOR_ID } from "../vendors.ts";
import { FINALMOUSE_SLX_DONGLE_PRODUCT_IDS } from "../../finalmouse/index.ts";
import { FinalmouseHidClient } from "./hid.ts";

// Guards the picker surface: a driver that can speak a device is useless if the
// browser picker never offers it. The ULX dongle and both Starlight X dongles
// must each have a filter, and the SLX filters must stay usage-agnostic (only
// the 0xff00 page is pinned) because their exact usage is not confirmed.
test("every Finalmouse dongle the driver accepts is offered by the picker", () => {
  const filtersFor = (productId: number) => SUPPORTED_HID_FILTERS.filter(
    (filter) => filter.vendorId === VENDOR_ID.finalmouse && filter.productId === productId,
  );

  assert.ok(filtersFor(0x0100).length > 0, "ULX dongle 0x0100 has no filter");
  for (const productId of FINALMOUSE_SLX_DONGLE_PRODUCT_IDS) {
    const filters = filtersFor(productId);
    assert.ok(filters.length > 0, `SLX dongle 0x${productId.toString(16)} has no filter`);
    assert.ok(
      filters.some((filter) => filter.usagePage === 0xff00 && filter.usage === undefined),
      `SLX dongle 0x${productId.toString(16)} must match on the 0xff00 page alone`,
    );
  }
});

test("the Finalmouse picker filters select the dongles the client supports", () => {
  for (const productId of [0x0100, ...FINALMOUSE_SLX_DONGLE_PRODUCT_IDS]) {
    // Any usage inside the vendor page satisfies the filter; the driver is the
    // thing that accepts the device, so the two must agree on the PID set.
    const device = {
      vendorId: VENDOR_ID.finalmouse,
      productId,
      collections: [{ usagePage: 0xff00, usage: productId === 0x0100 ? 0x0001 : 0x0009 }],
    } as unknown as HIDDevice;
    assert.equal(FinalmouseHidClient.isSupported(device), true, `0x${productId.toString(16)} not supported`);
  }
});
