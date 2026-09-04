import assert from "node:assert/strict";
import test from "node:test";

import { LamzuHidClient } from "./hid.ts";
import { deviceBrand } from "../registry.ts";
import {
  ATTACKSHARK_PRODUCT_IDS,
  LAMZU_INCA_PRODUCTS,
  LAMZU_INCA_VENDOR_ID,
  LAMZU_VENDOR_ID,
  lamzuProduct,
} from "@openmouse/protocol/lamzu";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout } };
globals.window ??= { setTimeout };

function fakeKoOne(productId: 0x006a | 0x006b) {
  const sent: Uint8Array[] = [];
  const device = {
    vendorId: LAMZU_VENDOR_ID,
    productId,
    productName: "KO-ONE",
    opened: true,
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      type: 1,
      children: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      inputReports: [],
      outputReports: [],
    }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => void sent.push(new Uint8Array(data)),
    receiveFeatureReport: async () => {
      const request = sent[sent.length - 1]!;
      const reply = new Uint8Array(64);
      const payload = request[4] === 0x01 && request[5] === 0x81
        ? [0x01, 0x01, 0x06, 0x40, 0x06, 0x40]
        : [0x01, 0x01, 0x00, 0x01];
      reply[0] = 0xa1;
      reply[3] = payload.length;
      reply[4] = request[4]!;
      reply[5] = request[5]!;
      reply.set(payload, 6);
      return new DataView(reply.buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HIDDevice;
  return { device, sent };
}

test("CRDRAKO KO-ONE wired uses device target 0x00", async () => {
  const { device, sent } = fakeKoOne(0x006a);
  const client = new LamzuHidClient(device);
  const status = await client.readStatus();

  assert.equal(status.brand, "CRDRAKO");
  assert.equal(status.name, "CRDRAKO KO-ONE");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.dpi, 1600);
  assert.equal(status.performanceMode, true);
  assert.equal(status.hyperMode, true);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.equal(deviceBrand(client), "CRDRAKO");
  assert.ok(sent.some((packet) => packet[4] === 0x01 && packet[5] === 0x93));
  assert.ok(sent.some((packet) => packet[4] === 0x01 && packet[5] === 0x8b));
  assert.ok(sent.every((packet) => packet[2] === 0x00));
});

test("CRDRAKO performance controls use the panel's fixed-FPS and Hyper commands", async () => {
  const { device, sent } = fakeKoOne(0x006a);
  const client = new LamzuHidClient(device);

  await client.setPerformanceMode(true);
  await client.setHyperMode(true);

  assert.ok(sent.some((packet) => packet[4] === 0x01 && packet[5] === 0x13 && packet[6] === 0x01 && packet[7] === 0x01));
  assert.ok(sent.some((packet) => packet[4] === 0x01 && packet[5] === 0x0b && packet[6] === 0x01 && packet[7] === 0x01));
});

test("CRDRAKO KO-ONE receiver addresses the mouse as target 0x02", async () => {
  const { device, sent } = fakeKoOne(0x006b);
  const status = await new LamzuHidClient(device).readStatus();

  assert.equal(status.connectionType, "Wireless");
  const mouseRequests = sent.filter((packet) => packet[4] === 0x01 || packet[5] !== 0x81);
  assert.ok(mouseRequests.length > 0);
  assert.ok(mouseRequests.every((packet) => packet[2] === 0x02));
});

function fakeR5Ultra(productId: 0x0046 | 0x0047, busyBatteryReplies = 0, activeProfile = 1) {
  const sent: Uint8Array[] = [];
  let batterySends = 0;
  let liftOff = 0x01;
  let debounce = 0x00;
  const device = {
    vendorId: LAMZU_VENDOR_ID,
    productId,
    productName: "R5 Ultra Mouse 2.4G",
    opened: true,
    collections: [{
      usagePage: 0xffff,
      usage: 0,
      type: 1,
      children: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      inputReports: [],
      outputReports: [],
    }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => void sent.push(new Uint8Array(data)),
    receiveFeatureReport: async () => {
      const request = sent[sent.length - 1]!;
      const page = request[4]!;
      const command = request[5]!;
      const reply = new Uint8Array(64);
      if (page === 0x01 && command === 0x08) liftOff = request[7]!;
      if (page === 0x00 && command === 0x08) debounce = request[7]!;
      if (page === 0x00 && command === 0x83) {
        batterySends += 1;
        if (batterySends <= busyBatteryReplies) {
          reply[0] = 0xa3;
          reply[4] = page;
          reply[5] = command;
          return new DataView(reply.buffer);
        }
      }
      const payload = page === 0x00 && command === 0x85
        ? [activeProfile, 0x00]
        : page === 0x01 && command === 0x88
          ? [0x01, liftOff]
          : page === 0x00 && command === 0x88
            ? [0x01, debounce]
            : page === 0x01 && command === 0x81
              ? [0x01, 0x01, 0x06, 0x40, 0x06, 0x40]
              : page === 0x01 && command === 0x80
                ? [0x01, 0x80]
                : page === 0x00 && command === 0x83
                  ? [0x00, 0x64]
                  : page === 0x00 && command === 0x81
                    ? [0x00, 0x00, 0x01, 0x02]
                    : [0x01, 0x01];
      reply[0] = 0xa1;
      reply[3] = payload.length;
      reply[4] = page;
      reply[5] = command;
      reply.set(payload, 6);
      return new DataView(reply.buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HIDDevice;
  return { device, sent, batterySends: () => batterySends };
}

test("the Attack Shark R5 Ultra wireless decodes through the shared driver", async () => {
  const { device } = fakeR5Ultra(0x0047);
  const client = new LamzuHidClient(device);
  const status = await client.readStatus();

  assert.equal(status.brand, "Attack Shark");
  assert.equal(status.name, "Attack Shark R5 Ultra");
  assert.equal(status.ui?.family, "attack-shark");
  assert.equal(deviceBrand(client), "Attack Shark");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "2.4 GHz receiver");
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 8000);
  assert.deepEqual(status.supportedPollingRates, [500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(status.firmware, ["Mouse 1.2", "Dongle 1.2"]);
});

test("the Attack Shark R5 Ultra wired decodes as a 1 kHz wired mouse", async () => {
  const { device } = fakeR5Ultra(0x0046);
  const status = await new LamzuHidClient(device).readStatus();
  assert.equal(status.brand, "Attack Shark");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
});

test("a busy status keeps retrying instead of failing", async () => {
  const { device, batterySends } = fakeR5Ultra(0x0047, 2);
  const status = await new LamzuHidClient(device).readStatus();
  assert.equal(status.batteryPercent, 100);
  assert.ok(batterySends() > 2, `expected the battery request to be re-sent, saw ${batterySends()}`);
});

test("the Attack Shark R5 Ultra addresses the reported active profile", async () => {
  const { device, sent } = fakeR5Ultra(0x0047, 0, 2);
  const client = new LamzuHidClient(device);

  const status = await client.readStatus();
  assert.equal(status.activeProfile, 2);

  await client.setPollingRate(8000);
  await client.setLiftOffDistance("Low");
  await client.setPerformanceMode(true);
  await client.setDpi(1600);
  await client.setDebounceTime(4);

  const isProfileScoped = (packet: Uint8Array): boolean =>
    packet[4] === 0x01 || (packet[4] === 0x00 && (packet[5] === 0x87 || packet[5] === 0x88));
  const scoped = sent.filter(isProfileScoped);
  assert.ok(scoped.length > 0, "expected profile-scoped commands");
  assert.ok(scoped.every((packet) => packet[6] === 0x02),
    `expected every profile-scoped command to address profile 2, saw:\n`
    + scoped.map((packet) => [...packet.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ")).join("\n"));
});

test("the catalog offers the wired and wireless R5 Ultra", () => {
  assert.deepEqual([...ATTACKSHARK_PRODUCT_IDS], [0x0046, 0x0047]);
});

/**
 * Byte-for-byte replay of a real Lamzu Inca 8K on its receiver, captured with
 * hidapi on Windows 11 (docs/lamzu-inca-testing.md). Keyed by target:page:
 * command, because page 0x00 command 0x88 is debounce while page 0x01 command
 * 0x88 is lift-off, and firmware differs only by target.
 */
const INCA_CAPTURE: Record<string, readonly number[]> = {
  "0:0:129": [0x00, 0x00, 0x00, 0x12, 0x00, 0x37, 0xb0, 0x00, 0x10, 0, 0, 0, 0, 0, 0, 0],
  "2:0:129": [0x00, 0x00, 0x00, 0x12, 0x00, 0x09],
  "2:0:131": [0x00, 0x64],
  "2:0:133": [0x01],
  "2:0:135": [0x01, 0x00, 0x3c],
  "2:0:136": [0x01, 0x00],
  "2:1:128": [0x01, 0x40],
  "2:1:129": [
    0x01, 0x05, 0x01, 0x90, 0x01, 0x90, 0x07, 0xd0, 0x07, 0xd0, 0x06, 0x40,
    0x06, 0x40, 0x0c, 0x80, 0x0c, 0x80, 0x19, 0x00, 0x19, 0x00,
  ],
  "2:1:130": [0x01, 0x02],
  "2:1:132": [0x01, 0x00],
  "2:1:136": [0x01, 0x01],
  "2:1:137": [0x01, 0x00],
  "2:1:138": [0x01, 0x00],
  "2:1:139": [0x01, 0x00],
  "2:1:141": [0x01, 0x00],
  "2:1:147": [0x01, 0x00],
};

/**
 * `productId` picks the receiver (0x0010) or the cable (0x0009); `overrides`
 * carries the few replies that genuinely differed between the two captures.
 */
function fakeInca(productId = 0x0010, overrides: Record<string, readonly number[]> = {}) {
  const capture = { ...INCA_CAPTURE, ...overrides };
  const sent: Uint8Array[] = [];
  return {
    vendorId: LAMZU_INCA_VENDOR_ID,
    productId,
    productName: "LAMZU INCA 8K Receiver",
    opened: true,
    collections: [{
      usagePage: 0xffff,
      usage: 0,
      type: 1,
      children: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      inputReports: [],
      outputReports: [],
    }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => void sent.push(new Uint8Array(data)),
    receiveFeatureReport: async () => {
      const request = sent[sent.length - 1]!;
      const payload = capture[`${request[2]}:${request[4]}:${request[5]}`];
      const reply = new Uint8Array(64);
      if (!payload) {
        reply[0] = 0xa2;
        return new DataView(reply.buffer);
      }
      reply[0] = 0xa1;
      reply[3] = payload.length;
      reply[4] = request[4]!;
      reply[5] = request[5]!;
      reply.set(payload, 6);
      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;
}

test("the Inca 8K is recognised under Lamzu's own vendor id", () => {
  assert.equal(LamzuHidClient.isSupported(fakeInca()), true);
});

/**
 * Every collection the Inca exposes, read back with a WebHID enumeration in
 * Chrome on Windows — the receiver and the cable report the identical seven,
 * and Chrome delivers them on a single HIDDevice
 * (docs/lamzu-inca-testing.md). Only the MI_02 config collection declares
 * feature report 0.
 */
const INCA_COLLECTIONS: ReadonlyArray<readonly [number, number, readonly number[]]> = [
  [0x0001, 0x0002, []],
  [0x000c, 0x0001, []],
  [0x0001, 0x0080, []],
  [0x0001, 0x0006, []],
  [0xffa0, 0x0001, []],
  [0xffff, 0x0001, []],
  [0xffff, 0x0000, [0]],
];

function incaCollection(usagePage: number, usage: number, featureIds: readonly number[]): HIDCollectionInfo {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: featureIds.map((reportId) => ({ reportId, items: [{ reportSize: 8, reportCount: 64 }] })),
  } as unknown as HIDCollectionInfo;
}

function incaDevice(collections: HIDCollectionInfo[], productId = 0x0010): HIDDevice {
  return {
    vendorId: LAMZU_INCA_VENDOR_ID,
    productId,
    productName: "LAMZU INCA 8K Receiver",
    collections,
  } as unknown as HIDDevice;
}

test("the Inca is recognised across its real seven-collection layout", () => {
  const full = incaDevice(INCA_COLLECTIONS.map(([page, usage, ids]) => incaCollection(page, usage, ids)));
  assert.equal(LamzuHidClient.isSupported(full), true);
});

test("MI_01's vendor collection is never mistaken for the config channel", () => {
  // 0xffff/0x0001 passes the WebHID usage-page filter, so it is the one entry
  // the filter cannot exclude. The enumeration shows it declaring no feature
  // reports at all, so isSupported() drops it; otherwise the picker would gain
  // an entry that cannot answer a single command.
  assert.equal(LamzuHidClient.isSupported(incaDevice([incaCollection(0xffff, 0x0001, [])])), false);
  // The mouse collection on MI_00 is likewise not a control channel.
  assert.equal(LamzuHidClient.isSupported(incaDevice([incaCollection(0x0001, 0x0002, [])])), false);
});

test("a device on the shared CompX vendor id is not read as an Inca", () => {
  const stranger = { ...fakeInca(), vendorId: LAMZU_VENDOR_ID } as unknown as HIDDevice;
  // 0x0010 under 0x373e is not a catalogued CompX product.
  assert.equal(LamzuHidClient.isSupported(stranger), false);
});

test("lamzuProduct resolves nothing for a vendor id this brand does not use", () => {
  // The lookup must not fall through to the 0x373e catalog: 0x001c is a Maya X
  // only under Lamzu's ODM id, and 0x0046 an R5 Ultra only under the same.
  assert.equal(lamzuProduct(0x046d, 0x001c), undefined);
  assert.equal(lamzuProduct(0x0000, 0x0046), undefined);
  // The two ids this brand does use still resolve.
  assert.equal(lamzuProduct(LAMZU_VENDOR_ID, 0x001c)?.model, "Maya X");
  assert.equal(lamzuProduct(LAMZU_INCA_VENDOR_ID, 0x0010)?.model, "Inca 8K");
});

test("each Inca connection gets the rate list that connection actually offers", () => {
  // 1000 Hz is encoded 0x01 in the wired family and 0x10 in the wireless one;
  // the hardware answered 0x01 on the cable and 0x40 on the 8K receiver.
  assert.deepEqual(LAMZU_INCA_PRODUCTS.get(0x0009)?.pollingRates, [125, 250, 500, 1000]);
  assert.deepEqual(LAMZU_INCA_PRODUCTS.get(0x000f)?.pollingRates, [125, 250, 500, 1000]);
  assert.deepEqual(LAMZU_INCA_PRODUCTS.get(0x0010)?.pollingRates, [500, 1000, 2000, 4000, 8000]);
  assert.equal(LAMZU_INCA_PRODUCTS.get(0x0009)?.wireless, false);
  assert.equal(LAMZU_INCA_PRODUCTS.get(0x000f)?.wireless, true);
  assert.equal(LAMZU_INCA_PRODUCTS.get(0x0010)?.wireless, true);
});

test("the Inca's DFU bootloader identities are not offered as mice", () => {
  // 0x000a is the mouse's flashing identity and 0x0002 the dongle's; neither
  // speaks the config protocol, so a picker entry for them would be dead.
  for (const bootloader of [0x000a, 0x0002]) {
    assert.equal(LAMZU_INCA_PRODUCTS.has(bootloader), false);
    assert.equal(LamzuHidClient.isSupported(fakeInca(bootloader)), false);
  }
});

test("the wired Inca is recognised and reads as a wired 1000 Hz mouse", async () => {
  // On the cable the mouse reported polling 0x01 and a charging battery.
  const wired = fakeInca(0x0009, { "2:1:128": [0x01, 0x01], "2:0:131": [0x01, 0x64] });
  assert.equal(LamzuHidClient.isSupported(wired), true);
  const status = await new LamzuHidClient(wired).readStatus();
  assert.equal(status.name, "Lamzu Inca 8K");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.batteryState, "Charging");
  // A wired device skips the dongle read, so only the mouse firmware is listed.
  assert.deepEqual(status.firmware, ["Mouse 0.18"]);
});

test("the Inca 8K capture decodes into the settings the mouse was holding", async () => {
  const client = new LamzuHidClient(fakeInca());
  const status = await client.readStatus();

  assert.equal(status.brand, "Lamzu");
  assert.equal(status.name, "Lamzu Inca 8K");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Discharging");
  // Stage 2 of five, reported 1-based, so the second entry: 0x07d0 = 2000.
  assert.equal(status.dpi, 2000);
  assert.equal(status.dpiY, 2000);
  assert.equal(status.pollingRateHz, 4000);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.debounceMs, 0);
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.activeProfile, 1);
  assert.deepEqual(status.firmware, ["Mouse 0.18", "Dongle 0.18"]);
});
