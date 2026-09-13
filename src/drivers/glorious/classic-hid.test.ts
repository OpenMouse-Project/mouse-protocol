import assert from "node:assert/strict";
import test from "node:test";

import { GloriousClassicHidClient } from "./classic-hid.ts";
import { VENDOR_ID } from "../vendors.ts";

function fakeCollection(usagePage: number, usage = 1) {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
  };
}

function fakeDevice(vendorId: number, productId: number, productName = "") {
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  const device = {
    vendorId,
    productId,
    productName,
    opened: true,
    collections: [fakeCollection(0xff01)],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      const view = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      sent.push({ reportId, payload: new Uint8Array(view) });
    },
    receiveFeatureReport: async () => new DataView(new Uint8Array(64).buffer),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("recognizes a core1 device (Model O Wireless, VID 0x258a)", () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2022);
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("recognizes a core2 device (Model O3 Wireless, VID 0x3794)", () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousO3, 0xa312);
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("recognizes a Model D Wireless whose config lives on the 0xffff:0 collection", () => {
  // A real 0x258a:0x2012 (Model D Wireless) exposed `usage 0xffff:0 feat[0x0]`
  // as its control interface; the old 0xff01/0xff00-only match rejected it.
  const { device } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2012, "Model D Wireless");
  (device.collections[0] as { usagePage: number }).usagePage = 0xffff;
  (device.collections[0] as { usage: number }).usage = 0;
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("recognizes a Model O V2 Wired whose config channel is numbered report 7", () => {
  // A real 0x320f:0x823a rejected connection entirely: its `usage 0xff01:1`
  // collection carries feature report id 7, not the unnumbered report (0)
  // every other classic-family device uses.
  const { device } = fakeDevice(VENDOR_ID.gloriousClassicIWired, 0x823a, "Model O 2 Wired Mouse");
  (device.collections[0].featureReports[0] as { reportId: number }).reportId = 7;
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("a numbered config report is used for every write, not the unnumbered default", async () => {
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassicIWired, 0x823a);
  (device.collections[0].featureReports[0] as { reportId: number }).reportId = 7;
  const client = new GloriousClassicHidClient(device);

  await client.setDpi(1600);
  await client.setPollingRate(500);
  await client.setLiftOffDistance("High");

  assert.ok(sent.length >= 3);
  for (const report of sent) assert.equal(report.reportId, 7, "every write should use the discovered report id");
});

test("a report length other than 64 bytes refuses writes instead of guessing at the layout", async () => {
  // The real 0x320f:0x823a unit's numbered report 7 declares a 263-byte
  // length. Resizing the driver's 64-byte payload to fit no longer errors
  // at the WebHID level, but a diagnostic confirmed the mouse silently
  // ignores it - the write ACKs and nothing on the mouse changes. Refuse
  // instead of sending a payload with an unconfirmed byte layout.
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassicIWired, 0x823a);
  const report = device.collections[0].featureReports[0] as { reportId: number; items: Array<{ reportSize: number; reportCount: number }> };
  report.reportId = 7;
  report.items = [{ reportSize: 8, reportCount: 263 }];
  const client = new GloriousClassicHidClient(device);

  assert.deepEqual(client.getDpiOptions(), []);
  assert.deepEqual(client.getSupportedPollingRates(), []);
  await assert.rejects(() => client.setDpi(1600), /not confirmed/);
  await assert.rejects(() => client.setPollingRate(500), /not confirmed/);
  await assert.rejects(() => client.setLiftOffDistance("High"), /not confirmed/);
  await assert.rejects(() => client.setDebounceTime(4), /not confirmed/);
  await assert.rejects(() => client.setRgb({ effect: "solid", rate: 0, colors: ["#ff0000"] }), /not confirmed/);
  assert.equal(sent.length, 0, "nothing should be sent once the report length is unconfirmed");

  const status = await client.readStatus();
  assert.equal(status.dpi, 0);
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.liftOffDistance, null);
});

test("rejects an unrecognized VID/PID pair", () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousO3, 0x1234);
  assert.equal(GloriousClassicHidClient.isSupported(device), false);
});

// The driver caches state in `localStorage` (unavailable under plain node:test),
// so writes silently no-op between calls here — assert on the write itself
// (return value + a feature report actually sent) rather than a later read.
test("core1 device exposes full DPI/polling/LOD support", async () => {
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2011); // Model D Wireless
  const client = new GloriousClassicHidClient(device);
  assert.ok(client.getDpiOptions().length > 0);
  assert.ok(client.getSupportedPollingRates().length > 0);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.ok(sent.length >= 3, "expected DPI/stage, polling, and LOD writes");
  const status = await client.readStatus();
  assert.notEqual(status.liftOffDistance, null);
  assert.ok(status.supportedPollingRates && status.supportedPollingRates.length > 0);
});

test("core2 device (Model O3 Wireless) has no DPI/polling/LOD, only RGB/debounce/battery", async () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousO3, 0xa312);
  const client = new GloriousClassicHidClient(device);
  assert.deepEqual(client.getDpiOptions(), []);
  assert.deepEqual(client.getSupportedPollingRates(), []);
  await assert.rejects(() => client.setDpi(1600), /not confirmed/);
  await assert.rejects(() => client.setPollingRate(500), /not confirmed/);
  await assert.rejects(() => client.setLiftOffDistance("High"), /not confirmed/);
  // Still works: debounce and RGB writes go through unconditionally.
  assert.equal(await client.setDebounceTime(4), 4);
  const rgb = await client.setRgb({ effect: "solid", rate: 0, colors: ["#ff0000"] });
  assert.equal(rgb.effect, "solid");
  const status = await client.readStatus();
  assert.equal(status.dpi, 0);
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.ui?.statusNote?.includes("newer protocol generation"), true);
});

test("core2 device (Model D 2 PRO 4K/8KHz Edition, wired) also gets the reduced feature set", async () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2036);
  const client = new GloriousClassicHidClient(device);
  assert.deepEqual(client.getDpiOptions(), []);
  await assert.rejects(() => client.setDpi(1600), /not confirmed/);
});
