import assert from "node:assert/strict";
import test from "node:test";

import { GWolvesHidClient } from "./hid.ts";
import { GWolvesXviHidClient } from "./xvi-hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// Answers like the XVI firmware as the web driver reads it: the reply is the
// request with status 0xa1 in slot 0 and the values written in place.
function xviDevice(productId: number, { prefixReplies = false, pollingCode = 128 } = {}) {
  const state = { pollingCode, lod: 1, active: 2, stages: [[400, 400], [800, 800], [1600, 1600]] };
  const sent: Uint8Array[] = [];
  let reply = new Uint8Array(64);
  const answer = (request: Uint8Array): Uint8Array => {
    const out = request.slice();
    out[0] = 0xa1;
    if (request[1] === 0) {
      const command = request[5];
      if (command === 0x81 && request[4] === 0) out.set([1, 2, 3, 4], 6);
      if (command === 0x81 && request[4] === 1) {
        out[7] = state.stages.length;
        state.stages.forEach(([x, y], stage) => out.set([x! >> 8, x! & 0xff, y! >> 8, y! & 0xff], 8 + stage * 4));
      }
      if (command === 0x82) out[7] = state.active;
      if (command === 0x01) {
        state.stages = Array.from({ length: request[7]! }, (_, stage) => {
          const at = 8 + stage * 4;
          return [(request[at]! << 8) | request[at + 1]!, (request[at + 2]! << 8) | request[at + 3]!];
        });
      }
    } else {
      const command = request[2];
      if (command === 0x8f) out.set([0, 76], 4);
      if (command === 0x82) out[4] = state.pollingCode;
      if (command === 0x02) state.pollingCode = request[4]!;
      if (command === 0x86) out[4] = state.lod;
      if (command === 0x06) state.lod = request[4]!;
    }
    return out;
  };
  const device = {
    vendorId: 0x33e4,
    productId,
    productName: "HTX Mini",
    opened: false,
    collections: [
      { usagePage: 0x01, usage: 0x02, children: [], featureReports: [], inputReports: [], outputReports: [] },
      {
        usagePage: 0xff00,
        usage: 0x01,
        children: [],
        featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
        inputReports: [],
        outputReports: [],
      },
    ],
    async open() { device.opened = true; },
    async close() { device.opened = false; },
    async sendFeatureReport(_reportId: number, data: Uint8Array) {
      sent.push(new Uint8Array(data));
      reply = answer(new Uint8Array(data));
    },
    async receiveFeatureReport() {
      const bytes = prefixReplies ? Uint8Array.of(0, ...reply) : reply;
      return new DataView(bytes.buffer);
    },
  };
  return { device: device as unknown as HIDDevice, state, sent };
}

test("the HTX Mini 8K dongle goes to the XVI client, not the VGN-family one", () => {
  const { device } = xviDevice(0x2717);
  assert.equal(GWolvesXviHidClient.isSupported(device), true);
  assert.equal(GWolvesHidClient.isSupported(device), false);
  assert.equal(GWolvesXviHidClient.isSupported({ ...device, productId: 0x3854 } as HIDDevice), false);
  assert.equal(GWolvesXviHidClient.isSupported({ ...device, collections: [device.collections[0]!] } as HIDDevice), false);
});

for (const prefixReplies of [false, true]) {
  test(`reads and writes settings${prefixReplies ? " when Chrome prefixes the report id" : ""}`, async () => {
    const { device, state, sent } = xviDevice(0x2717, { prefixReplies });
    const client = new GWolvesXviHidClient(device);

    const status = await client.readStatus();
    assert.equal(status.name, "G-Wolves HTX Mini");
    assert.equal(status.dpi, 800);
    assert.equal(status.pollingRateHz, 8000);
    assert.equal(status.batteryPercent, 76);
    assert.equal(status.liftOffDistance, "Low");
    assert.deepEqual(status.firmware, ["Mouse 1.2.3.4"]);

    assert.equal(await client.setDpi(1200), 1200);
    assert.deepEqual(state.stages, [[400, 400], [1200, 1200], [1600, 1600]]);
    assert.equal(await client.setPollingRate(2000), 2000);
    assert.equal(state.pollingCode, 32);
    assert.equal(await client.setLiftOffDistance("High"), "High");
    // Wireless legacy requests carry the receiver flag in byte 3.
    assert.ok(sent.filter((packet) => packet[1] !== 0).every((packet) => packet[3] === 1));
  });
}

test("over the cable the web driver's 64 reads as 1 kHz and faster rates are refused", async () => {
  const { device } = xviDevice(0x2708, { pollingCode: 64 });
  const client = new GWolvesXviHidClient(device);
  assert.equal((await client.readStatus()).pollingRateHz, 1000);
  await assert.rejects(client.setPollingRate(8000), /does not support 8000 Hz/);
});
