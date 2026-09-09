import assert from "node:assert/strict";
import test from "node:test";

import {
  LAMZU_ATLANTIS_USAGE,
  LAMZU_ATLANTIS_USAGE_PAGE,
  LAMZU_ATLANTIS_VENDOR_ID,
} from "@openmouse/protocol/lamzu";
import { LamzuAtlantisHidClient } from "./hid.ts";

function collection(
  usagePage: number,
  usage: number,
  options: { input?: number[]; output?: number[]; feature?: number[]; children?: HIDCollectionInfo[] } = {},
): HIDCollectionInfo {
  return {
    usagePage,
    usage,
    type: 1,
    children: options.children ?? [],
    inputReports: (options.input ?? []).map((reportId) => ({ reportId })),
    outputReports: (options.output ?? []).map((reportId) => ({ reportId })),
    featureReports: (options.feature ?? []).map((reportId) => ({ reportId })),
  } as unknown as HIDCollectionInfo;
}

/** The collection shape a wired Atlantis presents: five vendor collections
 * alongside the keyboard, consumer and system-control ones, of which only
 * 0xff02 usage 2 carries report 8. */
const ATLANTIS_COLLECTIONS: HIDCollectionInfo[] = [
  collection(0x0001, 0x0006),
  collection(0xff05, 0x0000),
  collection(0xff03, 0x0000),
  collection(0x000c, 0x0001),
  collection(0x0001, 0x0080),
  collection(LAMZU_ATLANTIS_USAGE_PAGE, LAMZU_ATLANTIS_USAGE, { input: [8], output: [8] }),
  collection(0xff04, 0x0002, { feature: [6] }),
  collection(0x0001, 0x0002),
];

const device = (
  vendorId: number,
  productId: number,
  collections: HIDCollectionInfo[] = ATLANTIS_COLLECTIONS,
): HIDDevice => ({ vendorId, productId, productName: "LAMZU Atlantis Pro", collections } as unknown as HIDDevice);

test("the wired mouse and every catalogued receiver are claimed", () => {
  for (const productId of [0xf50f, 0xf50d, 0xf510, 0xf517]) {
    assert.ok(LamzuAtlantisHidClient.isSupported(device(LAMZU_ATLANTIS_VENDOR_ID, productId)));
  }
});

test("other devices on CompX's shared vendor id are left alone", () => {
  // VXE R1 SE+ transports, a Teevolution Terra Pro, a VGN Dragonfly F2 Master+
  // and Pulsar's own 4K receiver all enumerate under 0x3554.
  for (const productId of [0xf58e, 0xf58f, 0xf520, 0xfb56, 0x0002]) {
    assert.equal(LamzuAtlantisHidClient.isSupported(device(LAMZU_ATLANTIS_VENDOR_ID, productId)), false);
  }
});

test("a Lamzu product id under a different vendor id is not claimed", () => {
  // 0x373e and 0x37b0 are the other two Lamzu generations, which speak the
  // feature-report protocol instead.
  assert.equal(LamzuAtlantisHidClient.isSupported(device(0x373e, 0xf50f)), false);
  assert.equal(LamzuAtlantisHidClient.isSupported(device(0x37b0, 0xf50f)), false);
});

test("the config collection must actually carry report 8", () => {
  const withoutReport8 = [
    collection(LAMZU_ATLANTIS_USAGE_PAGE, LAMZU_ATLANTIS_USAGE, { input: [6], output: [6] }),
  ];
  assert.equal(LamzuAtlantisHidClient.isSupported(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f, withoutReport8)), false);

  // Report 8 on some other collection is not the config channel either.
  const wrongCollection = [collection(0xff04, 0x0002, { input: [8], output: [8] })];
  assert.equal(LamzuAtlantisHidClient.isSupported(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f, wrongCollection)), false);

  assert.equal(LamzuAtlantisHidClient.isSupported(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f, [])), false);
});

test("a nested config collection is found", () => {
  const nested = [
    collection(0x0001, 0x0002, {
      children: [collection(LAMZU_ATLANTIS_USAGE_PAGE, LAMZU_ATLANTIS_USAGE, { input: [8], output: [8] })],
    }),
  ];
  assert.ok(LamzuAtlantisHidClient.isSupported(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f, nested)));
});

test("the receivers report themselves as wireless and the cable does not", () => {
  assert.equal(new LamzuAtlantisHidClient(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f)).isWireless(), false);
  assert.equal(new LamzuAtlantisHidClient(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf510)).isWireless(), true);
});

test("the family name is used rather than the shared USB product string", () => {
  // Six models ship this product string, so it must not become the name.
  const client = new LamzuAtlantisHidClient(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f));
  assert.equal(client.displayName(), "Lamzu Atlantis");
  assert.equal(client.deviceBrand(), "Lamzu");
});

test("the wired path offers no rate the cable cannot carry", () => {
  const wired = new LamzuAtlantisHidClient(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f));
  assert.deepEqual(wired.getSupportedPollingRates(), [125, 250, 500, 1000]);
  const receiver = new LamzuAtlantisHidClient(device(LAMZU_ATLANTIS_VENDOR_ID, 0xf510));
  assert.deepEqual(receiver.getSupportedPollingRates(), [500, 1000, 2000, 4000]);
});
