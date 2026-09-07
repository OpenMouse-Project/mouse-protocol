import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MchoseA5ProMaxHidClient } from "./a5-gen1-hid.ts";

function collection(reportId = 0): HIDCollectionInfo {
  return { usagePage: 0xffff, usage: 1, type: 0, children: [], inputReports: [], outputReports: [], featureReports: [{ reportId, items: [] }] };
}

function firstGenDevice(productId = 0xf019): HIDDevice {
  let profile = 1;
  let polling = 1;
  const dpi = [400, 800, 1600, 3200, 6400, 12000];
  let active = 3;
  let reply = new Uint8Array(64);
  return {
    vendorId: 0x2023, productId, productName: "MCHOSE", opened: true,
    collections: [collection()], oninputreport: null,
    open: async () => {}, close: async () => {}, forget: async () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    sendReport: async () => {}, receiveFeatureReport: async () => new DataView(reply.buffer),
    sendFeatureReport: async (_id, source) => {
      const request = source instanceof Uint8Array ? source : new Uint8Array(source as ArrayBuffer);
      const page = request[4]!, command = request[5]!;
      if (page === 0 && command === 0x05) profile = request[6]!;
      if (page === 1 && command === 0x00) polling = request[6]!;
      if (page === 1 && command === 0x02) active = request[7]!;
      reply = new Uint8Array(64);
      reply.set([0xa1, 0, 2, request[3]!, page, command]);
      if (page === 0 && command === 0x81) reply.set([1, 0, 15, 0], 6);
      if (page === 0 && command === 0x83) reply.set([0, 82], 6);
      if (page === 0 && command === 0x85) reply[6] = profile;
      if (page === 0 && command === 0x87) reply.set([0x03, 0x84], 6);
      if (page === 0 && command === 0x88) reply[7] = 4;
      if (page === 1 && command === 0x80) reply[6] = polling;
      if (page === 1 && command === 0x81) {
        reply[7] = dpi.length;
        dpi.forEach((value, index) => reply.set([(value >> 8) & 0xff, value & 0xff, (value >> 8) & 0xff, value & 0xff], 8 + index * 4));
      }
      if (page === 1 && command === 0x82) reply[7] = active;
      if (page === 1 && command === 0x88) reply[6] = 1;
      if (page === 1 && [0x84, 0x89, 0x8a].includes(command)) reply[6] = 1;
      if (page === 1 && command === 0x01) {
        const count = request[7]!;
        dpi.splice(0, dpi.length, ...Array.from({ length: count }, (_, index) => (request[8 + index * 4]! << 8) | request[9 + index * 4]!));
      }
    },
  } as HIDDevice;
}

describe("MchoseA5ProMaxHidClient", () => {
  it("claims only known XVI products on the feature collection", () => {
    assert.equal(MchoseA5ProMaxHidClient.isSupported(firstGenDevice()), true);
    assert.equal(MchoseA5ProMaxHidClient.isSupported({ ...firstGenDevice(), productId: 0xf017 } as HIDDevice), false);
  });

  it("reads the A5 Pro Max status and exposes the wired rate set", async () => {
    const status = await new MchoseA5ProMaxHidClient(firstGenDevice()).readStatus();
    assert.equal(status.name, "MCHOSE A5 Pro Max");
    assert.equal(status.dpi, 1600);
    assert.equal(status.pollingRateHz, 1000);
    assert.deepEqual(status.supportedPollingRates, [125, 500, 1000]);
    assert.equal(status.batteryPercent, 82);
    assert.equal(status.ui?.settingsReady, true);
  });

  it("changes polling rate with read-back", async () => {
    const client = new MchoseA5ProMaxHidClient(firstGenDevice());
    await client.setPollingRate(500);
    assert.equal((await client.readStatus()).pollingRateHz, 500);
  });
});
