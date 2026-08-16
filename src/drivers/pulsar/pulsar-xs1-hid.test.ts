import assert from "node:assert/strict";
import test from "node:test";

import { PULSAR_VENDOR_ID, pulsarXs1EncodeRequest } from "@openmouse/protocol/pulsar";
import { createSupportedClient, deviceBrand } from "../registry.ts";
import { PulsarXs1HidClient } from "./pulsar-xs1-hid.ts";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout } };
globals.window ??= { setTimeout };

interface FakeState {
  dpi: number;
  stage: number;
  motionSync: number;
  rippleControl: number;
  angleSnapping: number;
  liftOffDistance: number;
  debounce: number;
}

function fakeDevice(productId: number, productName = "Pulsar X3 Medium 1K Dongle") {
  const sent: Uint8Array[] = [];
  const state: FakeState = {
    dpi: 1600,
    stage: 3,
    motionSync: 1,
    rippleControl: 0,
    angleSnapping: 0,
    liftOffDistance: 0x0a,
    debounce: 3,
  };
  const device = {
    vendorId: PULSAR_VENDOR_ID,
    productId,
    productName,
    opened: true,
    collections: [{
      usagePage: 0xffff,
      usage: 1,
      type: 1,
      children: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      inputReports: [],
      outputReports: [],
    }],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => {
      const packet = new Uint8Array(data);
      sent.push(packet);
      if (packet[1] === 0x05 && packet[2] === 0x02) state.dpi = packet[7] | (packet[8] << 8);
      if (packet[1] === 0x05 && packet[2] === 0x01) state.stage = packet[7];
      if (packet[1] === 0x07 && packet[2] === 0x05) state.motionSync = packet[7];
      if (packet[1] === 0x07 && packet[2] === 0x03) state.rippleControl = packet[7];
      if (packet[1] === 0x07 && packet[2] === 0x04) state.angleSnapping = packet[7];
      if (packet[1] === 0x07 && packet[2] === 0x02) state.liftOffDistance = packet[8];
      if (packet[1] === 0x04 && packet[2] === 0x03) state.debounce = packet[7];
    },
    receiveFeatureReport: async () => {
      const request = sent[sent.length - 1]!;
      const reply = new Uint8Array(64);
      reply[0] = 0x00;
      reply[1] = request[1];
      reply[2] = request[2];
      reply[3] = request[3];
      if (request[1] === 0x08 && request[2] === 0x81) reply[6] = 80;
      if (request[1] === 0x08 && request[2] === 0x85) reply[7] = 30;
      if (request[1] === 0x05 && request[2] === 0x82) {
        reply[7] = state.dpi & 0xff;
        reply[8] = state.dpi >> 8;
        reply[9] = state.dpi & 0xff;
        reply[10] = state.dpi >> 8;
      }
      if (request[1] === 0x05 && request[2] === 0x81) reply[7] = state.stage;
      if (request[1] === 0x01 && request[2] === 0x87) {
        reply[6] = 0x16;
        reply[7] = 0x10;
      }
      if (request[1] === 0x07 && request[2] === 0x85) reply[7] = state.motionSync;
      if (request[1] === 0x07 && request[2] === 0x83) reply[7] = state.rippleControl;
      if (request[1] === 0x07 && request[2] === 0x84) reply[7] = state.angleSnapping;
      if (request[1] === 0x07 && request[2] === 0x82) reply[8] = state.liftOffDistance;
      if (request[1] === 0x04 && request[2] === 0x83) reply[7] = state.debounce;
      return new DataView(reply.buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HIDDevice;
  return { device, sent };
}

test("encodes the 64-byte request with a checksum", () => {
  const packet = pulsarXs1EncodeRequest([0x08, 0x81, 0x01]);
  assert.equal(packet.length, 64);
  assert.equal(packet[0], 0x00);
  assert.equal(packet[1], 0x08);
  assert.equal(packet[2], 0x81);
  assert.equal(packet[3], 0x01);
  const checksum = packet.slice(0, 62).reduce((sum, byte) => sum + byte, 0) & 0xffff;
  assert.equal(packet[62], checksum & 0xff);
  assert.equal(packet[63], checksum >> 8);
});

test("detects the X3 feature-report control interface", () => {
  assert.equal(PulsarXs1HidClient.isSupported(fakeDevice(0x5402).device), true);
  assert.equal(PulsarXs1HidClient.isSupported(fakeDevice(0x5403).device), true);
  assert.equal(PulsarXs1HidClient.isSupported(fakeDevice(0x3409).device), true);
  assert.equal(PulsarXs1HidClient.isSupported(fakeDevice(0x3403).device), false);
  assert.equal(PulsarXs1HidClient.isSupported(fakeDevice(0x5405).device), false);
});

test("ignores interfaces that also expose the legacy report-8 control", () => {
  const device = fakeDevice(0x5402).device;
  device.collections = [{
    usagePage: 0xffff,
    usage: 1,
    type: 1,
    children: [],
    featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
    inputReports: [{ reportId: 0x08, items: [] }],
    outputReports: [{ reportId: 0x08, items: [] }],
  }] as unknown as HIDCollectionInfo[];
  assert.equal(PulsarXs1HidClient.isSupported(device), false);
});

test("reads the X3 status from the feature interface", async () => {
  const { device, sent } = fakeDevice(0x5402);
  const client = new PulsarXs1HidClient(device);
  const status = await client.readStatus();

  assert.equal(status.brand, "Pulsar");
  assert.equal(status.name, "Pulsar X3 Medium 1K Dongle");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "XS-1 feature-report interface");
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.motionSync, true);
  assert.equal(status.rippleControl, false);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.debounceMs, 3);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.batteryPercent, 80);
  assert.equal(status.batteryState, "Discharging");
  assert.deepEqual(status.firmware, ["Mouse v10.16"]);
  assert.equal(status.ui?.family, "pulsar");
  assert.equal(status.ui?.pollingReadOnly, true);
  assert.equal(status.ui?.hideSleepCard, true);
  assert.equal(status.ui?.hideSignalCard, true);
  assert.ok(sent.some((packet) => packet[1] === 0x08 && packet[2] === 0x81));
});

test("reports the wired X3 as wired", async () => {
  const status = await new PulsarXs1HidClient(fakeDevice(0x3409).device).readStatus();
  assert.equal(status.connectionType, "Wired");
});

test("writes and confirms the DPI", async () => {
  const { device, sent } = fakeDevice(0x5402);
  const client = new PulsarXs1HidClient(device);
  assert.equal(await client.setDpi(800), 800);
  const write = sent.find((packet) => packet[1] === 0x05 && packet[2] === 0x02);
  assert.deepEqual([...write!.slice(1, 11)], [0x05, 0x02, 0x05, 0x00, 0x00, 0x01, 0x20, 0x03, 0x20, 0x03]);
  assert.equal((await client.readStatus()).dpi, 800);
});

test("rejects unsupported DPI values", async () => {
  const client = new PulsarXs1HidClient(fakeDevice(0x5402).device);
  await assert.rejects(client.setDpi(12345), /not supported/);
});

test("writes and confirms Motion Sync", async () => {
  const { device, sent } = fakeDevice(0x5402);
  const client = new PulsarXs1HidClient(device);
  assert.equal(await client.setMotionSync(false), false);
  assert.ok(sent.some((packet) => packet[1] === 0x07 && packet[2] === 0x05 && packet[7] === 0));
  assert.equal((await client.readStatus()).motionSync, false);
});

test("writes and confirms angle snapping and ripple control", async () => {
  const { device } = fakeDevice(0x5402);
  const client = new PulsarXs1HidClient(device);
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(await client.setRippleControl(true), true);
  const status = await client.readStatus();
  assert.equal(status.angleSnapping, true);
  assert.equal(status.rippleControl, true);
});

test("writes and confirms the lift-off distance", async () => {
  const { device, sent } = fakeDevice(0x5402);
  const client = new PulsarXs1HidClient(device);
  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  const write = sent.find((packet) => packet[1] === 0x07 && packet[2] === 0x02);
  assert.deepEqual([...write!.slice(1, 9)], [0x07, 0x02, 0x03, 0x00, 0x00, 0x01, 0x02, 0x07]);
  assert.equal((await client.readStatus()).liftOffDistance, "Low");
});

test("writes and confirms the debounce time", async () => {
  const { device, sent } = fakeDevice(0x5402);
  const client = new PulsarXs1HidClient(device);
  assert.equal(await client.setDebounceTime(4), 4);
  const write = sent.find((packet) => packet[1] === 0x04 && packet[2] === 0x03);
  assert.deepEqual([...write!.slice(1, 8)], [0x04, 0x03, 0x03, 0x00, 0x00, 0x01, 0x04]);
  assert.equal((await client.readStatus()).debounceMs, 4);
});

test("fills the checksum on every packet it sends", async () => {
  const { device, sent } = fakeDevice(0x5402);
  const client = new PulsarXs1HidClient(device);
  await client.setDebounceTime(8);
  for (const packet of sent) {
    const expected = packet.slice(0, 62).reduce((sum, byte) => sum + byte, 0) & 0xffff;
    assert.equal(packet[62], expected & 0xff);
    assert.equal(packet[63], expected >> 8);
  }
});

test("the registry creates the X3 client", () => {
  const { device } = fakeDevice(0x5402);
  const client = createSupportedClient(device);
  assert.ok(client instanceof PulsarXs1HidClient);
  assert.equal(deviceBrand(client!), "Pulsar");
});
