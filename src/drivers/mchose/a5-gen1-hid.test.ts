import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MchoseA5ProMaxHidClient } from "./a5-gen1-hid.ts";

function collection(reportId = 0): HIDCollectionInfo {
  return { usagePage: 0xffff, usage: 1, type: 0, children: [], inputReports: [], outputReports: [], featureReports: [{ reportId, items: [] }] };
}

function firstGenDevice(productId = 0xf019, sent: Uint8Array[] = []): HIDDevice {
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
      sent.push(request.slice());
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

  it("exposes the hardware-verified 1K receiver path", async () => {
    const status = await new MchoseA5ProMaxHidClient(firstGenDevice(0xf013)).readStatus();
    assert.equal(status.name, "MCHOSE A5 Pro Max (1K receiver)");
    assert.equal(status.connectionType, "Wireless");
    assert.equal(status.connectionDetail, "2.4 GHz receiver");
    assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  });

  it("changes polling rate with read-back", async () => {
    const client = new MchoseA5ProMaxHidClient(firstGenDevice());
    await client.setPollingRate(500);
    assert.equal((await client.readStatus()).pollingRateHz, 500);
  });

  it("emits every hardware-tested settings command", async () => {
    const sent: Uint8Array[] = [];
    const client = new MchoseA5ProMaxHidClient(firstGenDevice(0xf013, sent));
    await client.setProfile(2);
    await client.setDpiStageValue(0, 450);
    await client.setActiveDpiStage(1);
    await client.setDpiStageCount(4);
    await client.setSleepTimeout(900);
    await client.setDebounceTime(4);
    await client.setLiftOffDistance("High");
    await client.setMotionSync(true);
    await client.setAngleSnapping(true);
    await client.setRippleControl(true);

    const wrote = (page: number, command: number, data: readonly number[]) => sent.some((frame) =>
      frame[4] === page && frame[5] === command && data.every((value, index) => frame[6 + index] === value));
    assert.equal(wrote(0, 0x05, [2]), true, "profile");
    assert.equal(wrote(1, 0x01, [2]), true, "DPI stages");
    assert.equal(wrote(1, 0x02, [2, 2]), true, "active DPI stage");
    assert.equal(wrote(0, 0x07, [0x03, 0x84]), true, "sleep timeout");
    assert.equal(wrote(0, 0x08, [2, 4]), true, "debounce");
    assert.equal(wrote(1, 0x08, [2]), true, "lift-off distance");
    assert.equal(wrote(1, 0x09, [1]), true, "Motion Sync");
    assert.equal(wrote(1, 0x04, [1]), true, "angle snapping");
    assert.equal(wrote(1, 0x0a, [1]), true, "ripple control");
  });
});
