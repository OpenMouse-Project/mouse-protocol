import assert from "node:assert/strict";
import test from "node:test";

import {
  boltSupportScore,
  classifyHidpp20Probe,
  collapseBoltPeers,
  hasHidppBluetoothCollection,
  hasHidppLongCollection,
  hasHidppShortCollection,
  hidppIndexCandidates,
  resolveBoltReportDevice,
} from "./bolt.ts";
import { LogitechHidppClient } from "./hidpp.ts";
import { LOGITECH_BLUETOOTH_FILTERS, SUPPORTED_HID_FILTERS } from "../vendors.ts";
import {
  BOLT_PAIRING_SLOTS,
  DEVICE_INDEX_DIRECT,
  DEVICE_INDEX_RECEIVER,
  HIDPP_BLUETOOTH_USAGE_PAGE,
  isBoltReceiverProduct,
  isDirectConnectProduct,
} from "@openmouse/protocol/logitech";

const LIGHTSPEED_RECEIVER = 0xc54d;
const BOLT_RECEIVER = 0xc548;
const KNOWN_RECEIVERS = new Set([LIGHTSPEED_RECEIVER, BOLT_RECEIVER, 0xc539, 0xc547, 0xc0a8]);

function fakeHidDevice(productId: number, collections: HIDCollectionInfo[]): HIDDevice {
  return {
    vendorId: 0x046d,
    productId,
    productName: "test",
    collections,
  } as unknown as HIDDevice;
}

function hidppCollection(usage: number, usagePage = 0xff00): HIDCollectionInfo {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    featureReports: [],
    inputReports: [],
    outputReports: [],
  } as unknown as HIDCollectionInfo;
}

test("Logi Bolt receivers are distinct from Lightspeed and direct-connect mice", () => {
  assert.equal(isBoltReceiverProduct(BOLT_RECEIVER), true);
  assert.equal(isBoltReceiverProduct(LIGHTSPEED_RECEIVER), false);
  assert.equal(isDirectConnectProduct(BOLT_RECEIVER), false);
  assert.deepEqual([...BOLT_PAIRING_SLOTS], [0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
});

test("Bolt index candidates cover all pairing slots; Lightspeed stays 0x01 then 0xFF", () => {
  assert.deepEqual(hidppIndexCandidates(BOLT_RECEIVER, KNOWN_RECEIVERS), [...BOLT_PAIRING_SLOTS]);
  assert.deepEqual(
    hidppIndexCandidates(LIGHTSPEED_RECEIVER, KNOWN_RECEIVERS),
    [DEVICE_INDEX_RECEIVER, DEVICE_INDEX_DIRECT],
  );
  assert.deepEqual(
    hidppIndexCandidates(0xc084, KNOWN_RECEIVERS),
    [DEVICE_INDEX_DIRECT, DEVICE_INDEX_RECEIVER],
  );
});

test("Bolt HID++ support accepts short and long collections and prefers long", () => {
  const shortOnly = fakeHidDevice(BOLT_RECEIVER, [hidppCollection(0x0001)]);
  const longOnly = fakeHidDevice(BOLT_RECEIVER, [hidppCollection(0x0002)]);
  const lightspeed = fakeHidDevice(LIGHTSPEED_RECEIVER, [hidppCollection(0x0001)]);

  assert.equal(hasHidppShortCollection(shortOnly), true);
  assert.equal(hasHidppLongCollection(shortOnly), false);
  assert.equal(hasHidppLongCollection(longOnly), true);
  assert.equal(boltSupportScore(longOnly, true), 8);
  assert.equal(boltSupportScore(shortOnly, true), 6);
  assert.equal(boltSupportScore(lightspeed, true), 6);
  assert.equal(boltSupportScore(longOnly, false), 0);
});

test("Bolt short and long peers collapse to one logical device", () => {
  const shortOnly = fakeHidDevice(BOLT_RECEIVER, [hidppCollection(0x0001)]);
  const longOnly = fakeHidDevice(BOLT_RECEIVER, [hidppCollection(0x0002)]);
  const lightspeed = fakeHidDevice(LIGHTSPEED_RECEIVER, [hidppCollection(0x0001)]);

  assert.deepEqual(
    collapseBoltPeers([shortOnly, longOnly, lightspeed]),
    [longOnly, lightspeed],
  );
  assert.deepEqual(
    collapseBoltPeers([shortOnly, lightspeed]),
    [shortOnly, lightspeed],
    "short collection is kept when no long peer is authorized yet",
  );
});

test("Bolt report device resolves to the long-report peer when needed", () => {
  const shortOnly = fakeHidDevice(BOLT_RECEIVER, [hidppCollection(0x0001)]);
  const longOnly = fakeHidDevice(BOLT_RECEIVER, [hidppCollection(0x0002)]);
  assert.equal(resolveBoltReportDevice(longOnly, []), longOnly);
  assert.equal(resolveBoltReportDevice(shortOnly, [longOnly]), longOnly);
  assert.throws(() => resolveBoltReportDevice(shortOnly, []), /usage 2/);
});

test("HID++ 1.0 probe errors are treated as absent indices", () => {
  assert.equal(classifyHidpp20Probe(new Error("timeout"), true), "absent");
  assert.equal(
    classifyHidpp20Probe(new Error("The mouse rejected that setting (HID++ 1.0: invalid command)."), false),
    "absent",
  );
  assert.equal(
    classifyHidpp20Probe(new Error("The mouse rejected that setting (unsupported)."), false),
    "hidpp20",
  );
});

/**
 * An MX Master 4 paired over Bluetooth, as reported by the diagnostics scan on
 * macOS: a mouse collection plus one vendor collection on 0xFF43, and nothing
 * at all on 0xFF00.
 */
const MX_MASTER_4_BLUETOOTH = fakeHidDevice(0xb042, [
  { usagePage: 0x01, usage: 0x02, children: [] } as unknown as HIDCollectionInfo,
  hidppCollection(0x0202, HIDPP_BLUETOOTH_USAGE_PAGE),
]);

test("HID++ over Bluetooth is recognised on its own vendor page", () => {
  assert.equal(hasHidppBluetoothCollection(MX_MASTER_4_BLUETOOTH), true);
  assert.equal(
    hasHidppShortCollection(MX_MASTER_4_BLUETOOTH), false,
    "Bluetooth carries no 0xFF00 collection, which is why the 0xFF00-only check missed it",
  );
  assert.equal(hasHidppLongCollection(MX_MASTER_4_BLUETOOTH), false);
  assert.equal(
    hasHidppBluetoothCollection(fakeHidDevice(BOLT_RECEIVER, [hidppCollection(0x0002)])), false,
    "a Bolt receiver is not a Bluetooth endpoint",
  );
});

test("a Bluetooth-only Logitech mouse is driven, and offered by the picker", () => {
  assert.equal(
    LogitechHidppClient.isSupported(MX_MASTER_4_BLUETOOTH), true,
    "listed in the sidebar but unsupported is exactly the reported symptom",
  );
  const offered = SUPPORTED_HID_FILTERS.map((filter) => JSON.stringify(filter));
  for (const filter of LOGITECH_BLUETOOTH_FILTERS) {
    assert.ok(
      offered.includes(JSON.stringify(filter)),
      "the Bluetooth filter must reach the picker or the mouse is never detected",
    );
  }
});
