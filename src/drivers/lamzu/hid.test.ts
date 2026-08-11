import assert from "node:assert/strict";
import test from "node:test";

import { LamzuHidClient } from "./hid.ts";
import { deviceBrand } from "../registry.ts";
import { LAMZU_VENDOR_ID } from "@openmouse/protocol/lamzu";

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
