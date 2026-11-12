import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSc380ProSettings } from "../../aula/index.ts";
import { createSupportedClient, DEVICE_DRIVERS } from "../registry.ts";
import { AulaSc380ProHidClient } from "./hid.ts";

const signature = [4, 0, 0, 0, 0, 0x2e];

function mockReceiver({ linked = true, identity = signature, keepWrites = true, corruptSettings = false } = {}) {
  const writes: Uint8Array[] = [];
  const settings = new Uint8Array(400);
  settings.set([0x64, 0x18, 0x04, 0x26, 0, 2, 0, 7, 0, 15, 0, 23, 0, 47, 0, 71, 0, 119, 0]);
  settings.set(settings.slice(7, 19), 27);
  settings[399] = 0xab;
  let request = new Uint8Array();
  const device = {
    vendorId: 0x258a,
    productId: 0x0138,
    opened: true,
    collections: [{
      usagePage: 0xff02, usage: 2, children: [],
      featureReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 519 }] }],
    }],
    async sendFeatureReport(id: number, data: Uint8Array) {
      assert.equal(id, 9);
      assert.equal(data.length, 519);
      assert.equal(data[0], data.subarray(1).reduce((sum, byte) => sum + byte, 0) & 0xff);
      request = new Uint8Array(data);
      if (request[1] === 4) {
        const next = request.slice(7, 407);
        writes.push(next);
        if (keepWrites) settings.set(next);
      }
    },
    async receiveFeatureReport(id: number) {
      assert.equal(id, 9);
      const frame = new Uint8Array(520);
      frame.set([id, ...request.slice(0, 7)]);
      const data = {
        0x05: identity, 0x07: [linked ? 1 : 0], 0x09: [100], 0x44: settings,
      }[request[1]!];
      assert.ok(data);
      frame.set(data, 8);
      if (request[1] === 0x44) {
        frame[1] = frame.subarray(2).reduce((sum, byte) => sum + byte, 0) & 0xff;
        if (corruptSettings) frame[9] ^= 0x20;
      }
      // Exercise a transport that strips the report ID for the settings reply.
      return new DataView(frame.buffer, request[1] === 0x44 ? 1 : 0);
    },
  } as unknown as HIDDevice;
  return { device, writes };
}

test("the registry selects only the SC380 Pro receiver configuration collection", async () => {
  const { device } = mockReceiver();
  assert.deepEqual(DEVICE_DRIVERS.filter((driver) => driver.supports(device)).map((driver) => driver.brand), ["AULA"]);
  const client = createSupportedClient(device);
  assert.ok(client instanceof AulaSc380ProHidClient);
  assert.equal(createSupportedClient({ ...device, productId: 0x0136 }), null);
  assert.equal(createSupportedClient({ ...device, collections: [] }), null);
  const status = await client.readStatus();
  assert.equal(status.name, "AULA SC380 Pro");
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.dpi, 1600);
  assert.deepEqual(status.dpiStages, [800, 1600, 2400, 4800, 7200, 12000]);
});

test("settings writes preserve unrelated bytes and use the latest settings block", async () => {
  const { device, writes } = mockReceiver();
  const client = new AulaSc380ProHidClient(device);
  await Promise.all([client.setPollingRate(500), client.setDpiStageAxes(0, 900, 1000), client.setActiveDpiStage(0)]);
  assert.equal(writes.length, 3);
  assert.deepEqual(decodeSc380ProSettings(writes[2]!), {
    active: 0, polling: 500, x: [900, 1600, 2400, 4800, 7200, 12000], y: [1000, 1600, 2400, 4800, 7200, 12000],
  });
  assert.equal(writes[2]![399], 0xab);
});

test("a sleeping mouse or mismatched identity never receives a settings write", async () => {
  const sleeping = mockReceiver({ linked: false });
  const sleeper = new AulaSc380ProHidClient(sleeping.device);
  assert.equal((await sleeper.readStatus()).ui?.settingsReady, false);
  await assert.rejects(sleeper.setPollingRate(500), /Wake/);
  assert.equal(sleeping.writes.length, 0);
  const other = mockReceiver({ identity: [4, 0, 0, 0, 0, 0x2f] });
  await assert.rejects(new AulaSc380ProHidClient(other.device).setPollingRate(500), /identify/);
  assert.equal(other.writes.length, 0);
});

test("a dropped settings write is reported as a failure", async () => {
  const { device } = mockReceiver({ keepWrites: false });
  await assert.rejects(new AulaSc380ProHidClient(device).setPollingRate(500), /did not keep/);
});

test("a settings reply with a bad checksum never reaches the write path", async () => {
  const { device, writes } = mockReceiver({ corruptSettings: true });
  await assert.rejects(new AulaSc380ProHidClient(device).setPollingRate(500), /checksum/);
  assert.equal(writes.length, 0);
});
