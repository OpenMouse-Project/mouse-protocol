import assert from "node:assert/strict";
import test from "node:test";

import { NinjutsoHidClient } from "./hid.ts";
import { NINJUTSO_VENDOR_ID } from "@openmouse/protocol/ninjutso";

function fakeDevice(ignoredCommands = new Set<number>(), productId = 0xe010) {
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  let dpi = 1600;
  let polling = 4;
  let lod = 1;
  let motion = 1;
  let sleep = 5;
  let stage = 1;
  let system = 2;
  let hyper = 1;
  let slam = 1;
  let optical = 0;
  let lightState = 1;
  let lightMode = 3;
  let lightSpeed = 8;
  let lightBrightness = 2;
  let lightColor = [0xff, 0, 0x99];
  const device = {
    vendorId: NINJUTSO_VENDOR_ID,
    productId,
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
      if (payload[0] === 27) stage = payload[7]!;
      if (payload[0] === 11) system = payload[7]!;
      if (payload[0] === 22) hyper = payload[7]!;
      if (payload[0] === 41) slam = payload[7]!;
      if (payload[0] === 49) optical = payload[7]!;
      if (payload[0] === 37) lightState = payload[7]!;
      if (payload[0] === 31) lightMode = payload[7]!;
      if (payload[0] === 39) lightSpeed = payload[7]!;
      if (payload[0] === 47) lightBrightness = payload[7]!;
      if (payload[0] === 33) lightColor = [...payload.slice(7, 10)];
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
        28: [stage],
        30: [4],
        4: [dpi & 0xff, dpi >> 8, 0],
        6: [polling],
        8: [lod],
        10: [251],
        14: [motion],
        12: [system],
        23: [hyper],
        42: [slam],
        50: [optical],
        25: [sleep],
        167: [0x10, 0xe0],
        38: [lightState],
        32: [lightMode],
        40: [lightSpeed],
        48: [lightBrightness],
        34: lightColor,
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
  assert.deepEqual(status.dpiStages, [1600, 1600, 1600, 1600]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.ninjutsoSystemMode, "Ultra");
  assert.equal(status.ninjutsoHyperClick, true);
  assert.equal(status.ninjutsoOpticalEngine, "Standard");
  assert.equal(status.ninjutsoSlamClick, "Medium");
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
  assert.equal(await client.setNinjutsoSystemMode("Competitive"), "Competitive");
  assert.equal(await client.setNinjutsoHyperClick(false), false);
  assert.equal(await client.setNinjutsoOpticalEngine("Burst"), "Burst");
  assert.equal(await client.setNinjutsoSlamClick("High"), "High");
  assert.equal(await client.setNinjutsoActiveDpiStage(2), 2);
  assert.ok(sent.some(({ reportId, payload }) => reportId === 3 && payload[0] === 27));
  assert.ok(sent.some(({ reportId, payload }) => reportId === 3 && payload[0] === 28));
});

test("reads and writes Sora V3 receiver lighting", async () => {
  const client = new NinjutsoHidClient(fakeDevice(new Set(), 0xeb02).device);
  const status = await client.readStatus();
  assert.deepEqual(status.lighting?.modes, ["Off", "Static", "Wave"]);
  assert.equal(status.lighting?.mode, "Wave");
  assert.equal(status.lighting?.brightness, 50);
  assert.equal(status.lighting?.speed, 12);
  assert.equal(status.lighting?.color, "#ff0099");
  const lighting = await client.setLighting({ ...status.lighting!, mode: "Static", color: "#123456", brightness: 75 });
  assert.equal(lighting.mode, "Static");
  assert.equal(lighting.color, "#123456");
  assert.equal(lighting.brightness, 75);
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
