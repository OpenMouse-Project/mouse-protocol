import assert from "node:assert/strict";
import test from "node:test";
import { RoccatHidClient } from "./hid.ts";
import {
  ROCCAT_CONFIG_USAGE,
  ROCCAT_CONFIG_USAGE_PAGE,
  ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
  ROCCAT_PACKET_LENGTH,
  ROCCAT_VENDOR_ID,
} from "../../roccat/index.ts";

const hex = (bytes: Uint8Array, count: number) => [...bytes.subarray(0, count)].map((b) => b.toString(16).padStart(2, "0")).join(" ");

interface FakeOptions {
  /** Replies the mouse returns for each frame class it sees (by byte 1). */
  replies?: Record<number, number[]>;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

function fakeDevice(options: FakeOptions = {}) {
  const {
    replies = {},
    productId = ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
    usagePage = ROCCAT_CONFIG_USAGE_PAGE,
    usage = ROCCAT_CONFIG_USAGE,
  } = options;
  const sent: Uint8Array[] = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: ROCCAT_VENDOR_ID,
    productId,
    productName: "ROCCAT Kone Pro Air Dongle",
    opened: false,
    collections: [{ usagePage, usage, featureReports: [], inputReports: [], outputReports: [], children: [] }],
    open: async () => { (device as { opened?: boolean }).opened = true; },
    close: async () => {},
    addEventListener: (_type: string, fn: (event: HIDInputReportEvent) => void) => { listener = fn; },
    removeEventListener: () => { listener = null; },
    sendReport: async (_id: number, data: Uint8Array) => {
      sent.push(new Uint8Array(data));
      const reply = replies[data[0]!];
      if (reply && listener) {
        const payload = new Uint8Array(reply);
        listener({ data: new DataView(payload.buffer) } as unknown as HIDInputReportEvent);
      }
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

const SETTINGS_ECHO = [0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x0d, 0x00, 0x10, 0x10, 0x18, 0x18, 0x20, 0x20, 0x40, 0x40, 0x64, 0x64, 0x06];
const BATTERY_ECHO = [0x90, 0x0a, 0x04, 0x00, 0x00, 0x1e];

test("isSupported needs the ROCCAT VID, a known PID and the 0xFF00 vendor collection", () => {
  assert.equal(RoccatHidClient.isSupported(fakeDevice().device), true);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ productId: 0x2c92 }).device), true);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ usagePage: 0x01 }).device), false);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ usage: 0x11 }).device), false);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ productId: 0x2de6 }).device), false);
});

test("readStatus reads battery and the DPI table, neither invented", async () => {
  const { device } = fakeDevice({ replies: { 0x10: SETTINGS_ECHO, 0x90: BATTERY_ECHO } });
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.brand, "ROCCAT");
  assert.equal(status.name, "ROCCAT Kone Pro Air");
  assert.equal(status.batteryPercent, 0x1e, 'byte 5 of the recorded echo; the percent mapping is unconfirmed');
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.dpiStages, [800, 1200, 1600, 3200, 5000]);
  assert.deepEqual(status.dpiStagesY, [800, 1200, 1600, 3200, 5000]);
  assert.equal(status.dpi, 800);
  assert.equal(status.dpiY, 800);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.valuesVerified, true);
});

test("readStatus degrades to nothing when the mouse never answers", async () => {
  const { device } = fakeDevice();
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.dpi, 0);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.match(status.ui?.statusNote ?? "", /did not answer/);
});

test("setPollingRateHz sends the settings write then the commit tail", async () => {
  const { device, sent } = fakeDevice();
  await new RoccatHidClient(device).setPollingRateHz(125);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]![0], 0x10);
  assert.equal(sent[0]![1], 0x50);
  assert.equal(sent[0]![2], 0x14);
  assert.equal(sent[0]![5], 0x03, "125 Hz writes code 0x03");
  assert.equal(hex(sent[1]!, 4), "10 50 18 04", "commit tail");
  assert.equal(sent.every((frame) => frame.length === ROCCAT_PACKET_LENGTH), true);
});

test("setDpiStages validates stage counts and encodes the five stages", async () => {
  const { device, sent } = fakeDevice();
  const client = new RoccatHidClient(device);
  await client.setDpiStages([800, 1200, 1600, 3200, 5000], [400, 800, 1200, 1600, 3200]);
  assert.deepEqual([...sent[0]!.subarray(8, 18)], [16, 8, 24, 16, 32, 24, 64, 32, 100, 64]);
  await assert.rejects(
    () => client.setDpiStages([800, 1200, 1600, 3200], [400, 800, 1200, 1600, 3200]),
    /five stages/,
  );
});

test("setDpiStages rejects out-of-scale and off-step DPI", async () => {
  const { device } = fakeDevice();
  const client = new RoccatHidClient(device);
  await assert.rejects(() => client.setDpiStages([800, 1200, 1600, 3200, 19050], [800, 800, 800, 800, 800]), RangeError);
  await assert.rejects(() => client.setDpiStages([800, 1200, 1600, 3200, 801], [800, 800, 800, 800, 800]), RangeError);
});

test("setLighting writes one frame with both zones", async () => {
  const { device, sent } = fakeDevice();
  await new RoccatHidClient(device).setLighting("#123456", "#000000");
  assert.equal(sent.length, 1);
  assert.equal(hex(sent[0]!, 15), "10 10 0b 00 09 64 64 64 06 12 34 56 00 00 00");
  await assert.rejects(() => new RoccatHidClient(device).setLighting("blue", "#000000"), /rrggbb/);
});

test("wired mode reports Charging and the 2.4 GHz dongle reports Discharging", async () => {
  const { device } = fakeDevice({
    productId: 0x2c92,
    replies: { 0x90: BATTERY_ECHO, 0x10: SETTINGS_ECHO },
  });
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.connectionDetail, "Wired USB");
});
