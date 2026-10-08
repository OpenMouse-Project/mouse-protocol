import assert from "node:assert/strict";
import test from "node:test";

import {
  LAMZU_ATLANTIS_USAGE,
  LAMZU_ATLANTIS_USAGE_PAGE,
  LAMZU_ATLANTIS_VENDOR_ID,
} from "@openmouse/protocol/lamzu";
import { NOIR_M1_NEX_PRODUCT_ID, NoirM1NexHidClient } from "./m1-nex-hid.ts";

const REPORT_ID = 8;

function device(
  vendorId = LAMZU_ATLANTIS_VENDOR_ID,
  productId = NOIR_M1_NEX_PRODUCT_ID,
  usagePage = LAMZU_ATLANTIS_USAGE_PAGE,
  usage = LAMZU_ATLANTIS_USAGE,
  outputReportId = REPORT_ID,
): HIDDevice {
  const report = { reportId: outputReportId, items: [{ reportSize: 8, reportCount: 16 }] };
  return {
    vendorId,
    productId,
    productName: "USB Gaming Mouse",
    collections: [{
      usagePage,
      usage,
      type: 1,
      children: [],
      inputReports: [report],
      outputReports: [report],
      featureReports: [],
    }],
  } as unknown as HIDDevice;
}

test("M1-NEX is selected only for its wired CompX PID and report-8 config channel", () => {
  assert.equal(NoirM1NexHidClient.isSupported(device()), true);
  assert.equal(NoirM1NexHidClient.isSupported(device(0x1234)), false);
  assert.equal(NoirM1NexHidClient.isSupported(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f)), false);
  assert.equal(NoirM1NexHidClient.isSupported(device(
    LAMZU_ATLANTIS_VENDOR_ID,
    NOIR_M1_NEX_PRODUCT_ID,
    LAMZU_ATLANTIS_USAGE_PAGE,
    LAMZU_ATLANTIS_USAGE,
    6,
  )), false);
  assert.equal(NoirM1NexHidClient.isSupported(device(
    LAMZU_ATLANTIS_VENDOR_ID,
    NOIR_M1_NEX_PRODUCT_ID,
    0xff04,
    LAMZU_ATLANTIS_USAGE,
  )), false);
});

test("M1-NEX keeps Noir Gear identity and its wired DPI/polling limits", () => {
  const client = new NoirM1NexHidClient(device());

  assert.equal(client.displayName(), "M1-NEX");
  assert.equal(client.deviceBrand(), "Noir Gear");
  assert.equal(client.isWireless(), false);
  assert.equal(client.maxDpi(), 12000);
  assert.deepEqual(client.getSupportedPollingRates(), [125, 250, 500, 1000]);
  assert.equal(client.getDpiOptions()[0], 400);
  assert.equal(client.getDpiOptions().at(-1), 12000);
});
