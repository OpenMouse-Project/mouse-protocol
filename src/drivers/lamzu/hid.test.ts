import assert from "node:assert/strict";
import test from "node:test";

import { LamzuHidClient } from "./hid.ts";
import { deviceBrand } from "../registry.ts";
import {
  ATTACKSHARK_PRODUCT_IDS,
  LAMZU_VENDOR_ID,
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

function fakeR5Ultra(productId: 0x0046 | 0x0047, busyBatteryReplies = 0) {
  const sent: Uint8Array[] = [];
  let batterySends = 0;
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
      if (page === 0x00 && command === 0x83) {
        batterySends += 1;
        if (batterySends <= busyBatteryReplies) {
          reply[0] = 0xa3;
          reply[4] = page;
          reply[5] = command;
          return new DataView(reply.buffer);
        }
      }
      const payload = page === 0x01 && command === 0x81
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

test("the catalog offers the wired and wireless R5 Ultra", () => {
  assert.deepEqual([...ATTACKSHARK_PRODUCT_IDS], [0x0046, 0x0047]);
});
