import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORTED_HID_FILTERS, VENDOR_ID } from "../vendors.ts";
import { GWOLVES_PRODUCTS } from "./products.ts";

// Guards the catalog-to-picker wiring: every product a driver can speak must
// be offered by exactly the filter shape its driver needs, so a newly added
// model shows up in the browser picker (and Bridge enumeration) instead of
// failing silently with "No compatible devices found".
test("every G-Wolves product has a matching WebHID filter", () => {
  for (const [productId, product] of GWOLVES_PRODUCTS) {
    const filters = SUPPORTED_HID_FILTERS.filter(
      (filter) => filter.vendorId === VENDOR_ID.gwolves && filter.productId === productId,
    );
    assert.ok(filters.length > 0, `0x${productId.toString(16)} (${product.model}) has no filter`);
    if (product.protocol === "gwolves") {
      // The G-Wolves XVI:0 driver only answers on its 0xff02 collection.
      assert.ok(
        filters.some((filter) => filter.usagePage === 0xff02),
        `0x${productId.toString(16)} (${product.model}) needs its 0xff02 usage-page filter`,
      );
    } else {
      // Both XVI generations match on product id alone: their 64-byte
      // feature report is found by shape, not usage page.
      assert.ok(
        filters.some((filter) => filter.usagePage === undefined),
        `0x${productId.toString(16)} (${product.model}) must match on product id alone`,
      );
    }
  }
});
