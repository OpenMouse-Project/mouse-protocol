import assert from "node:assert/strict";
import test from "node:test";

import {
  SCYROX_CID,
  SCYROX_PRODUCT_IDS,
  SCYROX_V8S_LIFT_OFF_MILLIMETRES,
  SCYROX_VENDOR_ID,
  scyroxDecodeHandshake,
  scyroxEncodeHandshake,
  scyroxModelForMid,
  scyroxProduct,
} from "@openmouse/protocol/scyrox";
import {
  lamzuAtlantisDecodeDpiStage3955,
  lamzuAtlantisDecodePollingRate,
  lamzuAtlantisEncodePollingRate,
} from "@openmouse/protocol/lamzu";
import { ScyroxHidClient } from "./hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";

/** The V8S on its cable and its Turbo 8k dongle; the V8 on its cable and its dongle. */
const V8S_PRODUCT_IDS = [0xf515, 0xf517];
const V8_WIRED = 0xf5f6;
const V8_DONGLE = 0xf5f7;
const V8_PRODUCT_IDS = [V8_WIRED, V8_DONGLE];

function collection(
  usagePage: number,
  usage: number,
  options: { input?: number[]; output?: number[]; feature?: number[] } = {},
): HIDCollectionInfo {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    inputReports: (options.input ?? []).map((reportId) => ({ reportId })),
    outputReports: (options.output ?? []).map((reportId) => ({ reportId })),
    featureReports: (options.feature ?? []).map((reportId) => ({ reportId })),
  } as unknown as HIDCollectionInfo;
}

/** The collection shape both Scyrox endpoints present, as captured in the
 * diagnostics logs: six vendor collections, of which only 0xff02 usage 2
 * carries report 8. */
const SCYROX_COLLECTIONS: HIDCollectionInfo[] = [
  collection(0xff05, 0x0000),
  collection(0xff03, 0x0000),
  collection(0x000c, 0x0001),
  collection(0xff02, 0x0002, { input: [8], output: [8] }),
  collection(0xff04, 0x0002, { feature: [6] }),
  collection(0xff06, 0x0002),
];

const device = (
  vendorId: number,
  productId: number,
  collections: HIDCollectionInfo[] = SCYROX_COLLECTIONS,
): HIDDevice => ({ vendorId, productId, productName: "Scyrox V8S", collections } as unknown as HIDDevice);

test("the V8S and the V8 are claimed on both transports", () => {
  for (const productId of SCYROX_PRODUCT_IDS) {
    assert.ok(ScyroxHidClient.isSupported(device(SCYROX_VENDOR_ID, productId)));
  }
});

test("other devices on CompX's shared vendor id are left alone", () => {
  // A Lamzu Atlantis, a VXE R1 Pro Max transport, a Teevolution Terra Pro and
  // Pulsar's own 4K receiver all enumerate under 0x3554.
  for (const productId of [0xf50f, 0xf58c, 0xf520, 0x0002]) {
    assert.equal(ScyroxHidClient.isSupported(device(SCYROX_VENDOR_ID, productId)), false);
  }
});

test("a Scyrox product id under a different vendor id is not claimed", () => {
  for (const productId of SCYROX_PRODUCT_IDS) {
    assert.equal(ScyroxHidClient.isSupported(device(0x1234, productId)), false);
  }
});

test("the config collection must carry report 8", () => {
  for (const productId of SCYROX_PRODUCT_IDS) {
    const withoutReport8 = [collection(0xff02, 0x0002, { input: [6], output: [6] })];
    assert.equal(ScyroxHidClient.isSupported(device(SCYROX_VENDOR_ID, productId, withoutReport8)), false);
    assert.equal(ScyroxHidClient.isSupported(device(SCYROX_VENDOR_ID, productId, [])), false);
  }
});

test("the registry creates the Scyrox client under the Scyrox brand", () => {
  for (const productId of SCYROX_PRODUCT_IDS) {
    const client = createSupportedClient(device(SCYROX_VENDOR_ID, productId));
    assert.ok(client instanceof ScyroxHidClient);
    assert.equal(deviceBrand(client), "Scyrox");
    assert.equal(client.displayName(), V8_PRODUCT_IDS.includes(productId) ? "Scyrox V8" : "Scyrox V8S");
  }
});

test("only the dongles report themselves as wireless", () => {
  assert.equal(new ScyroxHidClient(device(SCYROX_VENDOR_ID, 0xf515)).isWireless(), false);
  assert.equal(new ScyroxHidClient(device(SCYROX_VENDOR_ID, 0xf517)).isWireless(), true);
  assert.equal(new ScyroxHidClient(device(SCYROX_VENDOR_ID, V8_WIRED)).isWireless(), false);
  assert.equal(new ScyroxHidClient(device(SCYROX_VENDOR_ID, V8_DONGLE)).isWireless(), true);
});

test("the vendor's polling-rate list is offered on both transports", () => {
  for (const productId of SCYROX_PRODUCT_IDS.filter((id) => id !== V8_WIRED)) {
    assert.deepEqual(
      new ScyroxHidClient(device(SCYROX_VENDOR_ID, productId)).getSupportedPollingRates(),
      [125, 250, 500, 1000, 2000, 4000, 8000],
    );
  }
});

test("the V8 and V6 on their cable stop at 1,000 Hz; the rest is dongle-only", () => {
  assert.deepEqual(
    new ScyroxHidClient(device(SCYROX_VENDOR_ID, V8_WIRED)).getSupportedPollingRates(),
    [125, 250, 500, 1000],
  );
  assert.deepEqual(
    new ScyroxHidClient(device(SCYROX_VENDOR_ID, V8_DONGLE)).getSupportedPollingRates(),
    [125, 250, 500, 1000, 2000, 4000, 8000],
  );
});

test("lift-off is the 3955's five-height scale, not the two-stop write", async () => {
  for (const productId of V8S_PRODUCT_IDS) {
    assert.deepEqual(
      scyroxProduct(SCYROX_VENDOR_ID, productId)!.liftOffMillimetres,
      SCYROX_V8S_LIFT_OFF_MILLIMETRES,
    );
  }
  assert.deepEqual([...SCYROX_V8S_LIFT_OFF_MILLIMETRES], [0.7, 0.9, 1.2, 1.4, 1.6]);
  const client = new ScyroxHidClient(device(SCYROX_VENDOR_ID, 0xf515));
  await assert.rejects(() => client.setLiftOffDistance("Low"));
});

test("the V8S offers angle tuning, restore, and the vendor's sleep write", () => {
  for (const productId of V8S_PRODUCT_IDS) {
    const product = scyroxProduct(SCYROX_VENDOR_ID, productId)!;
    assert.equal(product.supportsAngleTuning, true);
    assert.equal(product.supportsFactoryReset, true);
    assert.equal(product.mirrorSleepToPerformanceTime, true);
    // "Highest performance" in the configurator is flash 181, this client's
    // performance mode, so it must not be switched off.
    assert.notEqual(product.supportsPerformanceMode, false);
  }
});

test("every transport uses CompX's own rate bytes, not Lamzu's", () => {
  for (const productId of SCYROX_PRODUCT_IDS) {
    assert.equal(scyroxProduct(SCYROX_VENDOR_ID, productId)!.rateFamily, "pulsar");
  }
  // Lamzu's wired-family byte for 2,000 Hz (0x20) means 4,000 Hz on this
  // firmware, and decoding it with the Lamzu table would "confirm" a rate the
  // mouse is not on.
  assert.equal(lamzuAtlantisEncodePollingRate(2000, "pulsar"), 0x10);
  assert.equal(lamzuAtlantisDecodePollingRate(0x20, "pulsar"), 4000);
  assert.equal(lamzuAtlantisDecodePollingRate(0x20), 2000);
});

test("both V8S transports read their DPI stages from the 3955 region", () => {
  for (const productId of V8S_PRODUCT_IDS) {
    assert.equal(scyroxProduct(SCYROX_VENDOR_ID, productId)!.dpiLayout, "sensor3955");
  }
  // The configurator showed the mouse on 1,600 DPI while the legacy field at
  // flash 12 still held the 400 DPI factory default. The bytes below are the
  // configurator's own encoding of 1,600, not a capture of flash 6912.
  assert.deepEqual(
    lamzuAtlantisDecodeDpiStage3955(Uint8Array.of(0x3f, 0x06, 0x3f, 0x06, 0x00, 0xcb)),
    { x: 1600, y: 1600 },
  );
});

test("the V8 keeps its 3950 stages in the legacy fields, up to 30,000 DPI", () => {
  for (const productId of V8_PRODUCT_IDS) {
    const product = scyroxProduct(SCYROX_VENDOR_ID, productId)!;
    // The mouse read five legacy stages matching the configurator; the
    // ceiling is the configurator's own for this mouse's 3950 sensor.
    assert.equal(product.dpiLayout ?? "legacy", "legacy");
    assert.equal(product.maxDpi, 30000);
    assert.equal(product.dpiStep, 50);
    assert.equal(product.maxDpiStages, 5);
    assert.equal(new ScyroxHidClient(device(SCYROX_VENDOR_ID, productId)).maxDpi(), 30000);
  }
});

test("the V8 catalog carries the configurator's 3950 controls", async () => {
  for (const productId of V8_PRODUCT_IDS) {
    const product = scyroxProduct(SCYROX_VENDOR_ID, productId)!;
    // Its 3950 lift-off codes (3, 1, 2 for 0.7, 1 and 2 mm) fit neither the
    // two-stop write nor the 3955 scale, so they get a stop table. Key
    // Response Time goes to 30 ms. The client offers these only once the
    // handshake names a V8 (see the Atlantis client tests).
    assert.equal(product.liftOffMillimetres, undefined);
    assert.deepEqual(product.liftOffStopCodes, { Low: 3, Medium: 1, High: 2 });
    assert.equal(product.supportsAngleTuning, true);
    assert.equal(product.supportsFactoryReset, true);
    assert.equal(product.maxDebounceMs, 30);
    assert.equal(new ScyroxHidClient(device(SCYROX_VENDOR_ID, productId)).getDebounceMaxMs(), 15, "not before the handshake");
    // Flash 173 and 183 held the same timer on hardware.
    assert.equal(product.mirrorSleepToPerformanceTime, true);
  }
});

test("the sensor-mode register is not offered as a performance toggle", async () => {
  for (const productId of SCYROX_PRODUCT_IDS) {
    const client = new ScyroxHidClient(device(SCYROX_VENDOR_ID, productId));
    await assert.rejects(() => client.setHyperMode(true));
  }
});

test("the handshake decodes the wired V8's reply and maps MIDs to models", () => {
  // Payload of the wired V8's reply on hardware: 84 bf 7a f2 3e 01 02.
  assert.deepEqual(
    scyroxDecodeHandshake(Uint8Array.of(0x84, 0xbf, 0x7a, 0xf2, 0x3e, 0x01, 0x02, 0, 0, 0)),
    { cid: SCYROX_CID, mid: 1, type: 2 },
  );
  assert.equal(scyroxDecodeHandshake(Uint8Array.of(1, 2, 3)), null);
  assert.deepEqual(scyroxEncodeHandshake([0x112, 0x34, 0x56, 0x78]), [0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0]);
  for (const mid of [1, 10, 11]) assert.equal(scyroxModelForMid(mid), "V8");
  for (const mid of [2, 12, 13]) assert.equal(scyroxModelForMid(mid), "V6");
  assert.equal(scyroxModelForMid(5), undefined);
});
