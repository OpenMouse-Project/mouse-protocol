import assert from "node:assert/strict";
import test from "node:test";

import { NinjutsoHidClient } from "./hid.ts";
import { NINJUTSO_VENDOR_ID } from "@openmouse/protocol/ninjutso";

function fakeDevice(ignoredCommands = new Set<number>()) {
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  let dpi = 1600;
  let polling = 4;
  let lod = 1;
  let motion = 1;
  let sleep = 5;
  const device = {
    vendorId: NINJUTSO_VENDOR_ID,
    productId: 0xe010,
    productName: "Ninjutso Sora V3",
    opened: true,
    collections: [{
      usagePage: 0xff,
      usage: 1,
      type: 1,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [{ reportId: 6, items: [{ reportSize: 8, reportCount: 15 }] }],
    }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      const view = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      const payload = new Uint8Array(view);
      sent.push({ reportId, payload });
      if (reportId !== 6) return;
      if (payload[0] === 3) dpi = payload[8]! | payload[9]! << 8;
      if (payload[0] === 5) polling = payload[7]!;
      if (payload[0] === 7) lod = payload[7]!;
      if (payload[0] === 13) motion = payload[7]!;
      if (payload[0] === 24) sleep = payload[7]!;
    },
    receiveFeatureReport: async () => {
      const request = sent.findLast((entry) => entry.reportId === 6)!.payload;
      const command = request[0]!;
      const reply = new Uint8Array(15);
      if (ignoredCommands.has(command)) return new DataView(reply.buffer);
      reply[1] = command;
      const values: Record<number, number[]> = {
        16: [1],
        17: [1],
        18: [73],
        21: [3, 15, 174],
        28: [1],
        4: [dpi & 0xff, dpi >> 8, 0],
        6: [polling],
        8: [lod],
        10: [251],
        14: [motion],
        25: [sleep],
      };
      reply.set(values[command] ?? [], 8);
      return new DataView(reply.buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("supports only a known product with the NinjaForce feature report", () => {
  const { device } = fakeDevice();
  assert.equal(NinjutsoHidClient.isSupported(device), true);
  const wrong = { ...device, productId: 0xffff } as HIDDevice;
  assert.equal(NinjutsoHidClient.isSupported(wrong), false);
});

test("reads current Sora V3 status using report-6 commands", async () => {
  const status = await new NinjutsoHidClient(fakeDevice().device).readStatus();
  assert.equal(status.brand, "Ninjutso");
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 8000);
  assert.equal(status.batteryPercent, 73);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.motionSync, true);
  assert.equal(status.sleepTimeout, 300);
  assert.equal(status.angleTuning, -5);
  assert.deepEqual(status.firmware, ["Mouse AE0F03"]);
});

test("loads Sora V3 settings when optional commands are unsupported", async () => {
  const status = await new NinjutsoHidClient(fakeDevice(new Set([10, 14, 21, 25])).device).readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.motionSync, null);
  assert.equal(status.ui?.hideMotionSync, true);
  assert.equal(status.angleTuning, null);
  assert.equal(status.sleepTimeout, null);
  assert.equal(status.ui?.hideSleepCard, true);
  assert.deepEqual(status.firmware, []);
});

test("writes current settings and confirms each one by reading it back", async () => {
  const { device, sent } = fakeDevice();
  const client = new NinjutsoHidClient(device);
  assert.equal(await client.setDpi(3200), 3200);
  assert.equal(await client.setPollingRate(2000), 2000);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(await client.setMotionSync(false), false);
  assert.equal(await client.setSleepTimeout(600), 600);
  assert.ok(sent.some(({ reportId, payload }) => reportId === 3 && payload[0] === 27));
  assert.ok(sent.some(({ reportId, payload }) => reportId === 3 && payload[0] === 28));
});

test("reads the legacy Sora V2 settings block and verifies its checksum", async () => {
  let lastReport = 0;
  let lastCommand = 0;
  const settings = new Uint8Array(704);
  const data = settings.subarray(9);
  data[7] = 87;
  data[11] = 4;
  data[12] = 31;
  data[13] = 0;
  data[20] = 0;
  data[22] = 1;
  data[23] = 1;
  const checksum = settings.slice(0, 701).reduce((sum, byte) => sum + byte, 0);
  settings[702] = checksum & 0xff;
  settings[703] = checksum >> 8;
  const device = {
    vendorId: 0x1915,
    productId: 0xae11,
    productName: "Ninjutso Sora V2",
    opened: true,
    collections: [{
      usagePage: 0xff,
      usage: 1,
      type: 1,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [4, 5].map((reportId) => ({ reportId, items: [{ reportSize: 8, reportCount: reportId === 4 ? 704 : 31 }] })),
    }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      const bytes = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      lastReport = reportId;
      lastCommand = bytes[0]!;
    },
    receiveFeatureReport: async () => {
      if (lastReport === 4) return new DataView(settings.buffer);
      const reply = new Uint8Array(31);
      if (lastCommand === 13) reply[9] = 1;
      if (lastCommand === 9) reply.set([3, 15, 1, 174], 9);
      return new DataView(reply.buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HIDDevice;
  const status = await new NinjutsoHidClient(device).readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.batteryPercent, 87);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.motionSync, true);
  assert.deepEqual(status.supportedLiftOffDistances, ["Medium", "High"]);
  assert.deepEqual(status.firmware, ["Mouse AE010F03"]);
});
