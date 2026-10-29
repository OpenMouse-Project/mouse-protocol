import assert from "node:assert/strict";
import test from "node:test";
import { RoccatHidClient } from "./hid.ts";
import {
  ROCCAT_CONFIG_USAGE,
  ROCCAT_CONFIG_USAGE_PAGE,
  ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
  ROCCAT_VENDOR_ID,
} from "../../roccat/index.ts";

/** The stage table the unit held in the awake capture, in 50-step slots. */
const STORED_TABLE = [16, 16, 24, 24, 32, 32, 64, 64, 100, 100];

interface FakeOptions {
  productId?: number;
  usagePage?: number;
  usage?: number;
  /** Initial stored stage table (X and Y interleaved); defaults to the capture. */
  table?: readonly number[];
  /** When true the mouse echoes an empty (all-zero) table, i.e. a sleeping unit. */
  silent?: boolean;
}

function fakeDevice(options: FakeOptions = {}) {
  const {
    productId = ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
    usagePage = ROCCAT_CONFIG_USAGE_PAGE,
    usage = ROCCAT_CONFIG_USAGE,
  } = options;
  const silent = options.silent ?? false;
  const stored = Uint8Array.from(options.table ?? STORED_TABLE);
  const sent: Uint8Array[] = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const emit = (frame: Uint8Array) => {
    if (!listener) return;
    listener({ data: new DataView(frame.buffer, frame.byteOffset, frame.byteLength) } as unknown as HIDInputReportEvent);
  };
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
      // The settings query echoes the stored table, or an empty body while the
      // mouse is asleep.
      if (data[0] === 0x10 && data[1] === 0x50 && data[2] === 0x14) {
        const frame = new Uint8Array(24);
        frame.set([0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x0d, 0x00]);
        if (!silent) frame.set(stored, 8);
        emit(frame);
      }
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

test("isSupported needs the ROCCAT VID, a known PID and the 0xFF00 vendor collection", () => {
  assert.equal(RoccatHidClient.isSupported(fakeDevice().device), true);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ productId: 0x2c92 }).device), true);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ usagePage: 0x01 }).device), false);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ usage: 0x11 }).device), false);
  assert.equal(RoccatHidClient.isSupported(fakeDevice({ productId: 0x2de6 }).device), false);
});

test("readStatus surfaces the stored DPI table and claims no battery", async () => {
  const { device } = fakeDevice();
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.brand, "ROCCAT");
  assert.equal(status.name, "ROCCAT Kone Pro Air");
  assert.equal(status.batteryPercent, null, "the unconfirmed status byte is never surfaced as a percent");
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.dpiStages, [800, 1200, 1600, 3200, 5000]);
  assert.deepEqual(status.dpiStagesY, [800, 1200, 1600, 3200, 5000]);
  assert.equal(status.dpi, 800);
  assert.equal(status.dpiY, 800);
  assert.equal(status.ui?.valuesVerified, true);
});

test("readStatus keeps the settings grid hidden and the polling control read-only", async () => {
  const { device } = fakeDevice();
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.ui?.settingsReady, false, "no setter ships, so the grid must not offer one");
  assert.equal(status.ui?.pollingReadOnly, true);
  assert.equal(status.pollingRateHz, 0, "the echo does not decode a rate, so none is claimed");
  assert.equal(status.debounceMs, null);
  assert.equal(status.angleSnapping, null);
  assert.equal(status.liftOffDistance, null);
});

test("readStatus degrades to nothing when the mouse answers with an empty body", async () => {
  const { device } = fakeDevice({ silent: true });
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.dpi, 0);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.dpiStages, undefined, "an all-zero echo is no data, not five stages of 0 DPI");
  assert.match(status.ui?.statusNote ?? "", /did not answer/);
});

test("the driver sends only the settings query and exposes no setter", async () => {
  const { device, sent } = fakeDevice();
  const client = new RoccatHidClient(device);
  await client.readStatus();
  assert.deepEqual(sent.map((frame) => [...frame.subarray(0, 3)]), [[0x10, 0x50, 0x14]], "one query, nothing else");
  for (const setter of [
    "setDpiStages",
    "setPollingRateHz",
    "setAngleSnapping",
    "setLiftOffDistance",
    "setDebounceMs",
    "setLedTimeout",
    "setLighting",
  ]) {
    assert.equal(setter in client, false, `${setter} must not ship while the write path is unverified`);
  }
});

test("reads are serialized through one queue", async () => {
  const { device, sent } = fakeDevice();
  const client = new RoccatHidClient(device);
  await Promise.all([client.readDpiTable(), client.readDpiTable(), client.readDpiTable()]);
  assert.equal(sent.length, 3);
});

test("wired mode reports the wired connection and still no battery", async () => {
  const { device } = fakeDevice({ productId: 0x2c92 });
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.connectionDetail, "Wired USB");
});
