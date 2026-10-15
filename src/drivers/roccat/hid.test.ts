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

/** The stage table the unit held in the awake capture, in 50-step slots. */
const STORED_TABLE = [16, 16, 24, 24, 32, 32, 64, 64, 100, 100];

interface FakeOptions {
  productId?: number;
  usagePage?: number;
  usage?: number;
  /** Initial stored stage table (X and Y interleaved); defaults to the capture. */
  table?: readonly number[];
  /** When true the mouse ignores writes, so a read-back can never match. */
  locksTable?: boolean;
  /** When true the mouse echoes an empty (all-zero) table, i.e. an idle unit. */
  silent?: boolean;
}

function fakeDevice(options: FakeOptions = {}) {
  const {
    productId = ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
    usagePage = ROCCAT_CONFIG_USAGE_PAGE,
    usage = ROCCAT_CONFIG_USAGE,
    locksTable = false,
    silent = false,
  } = options;
  let stored = Uint8Array.from(options.table ?? STORED_TABLE);
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
      // A settings write (0x10 0x50 0x14, byte 4 = 0x01) stores the table it
      // carries, unless the fake is simulating a mouse that ignores writes.
      if (data[0] === 0x10 && data[1] === 0x50 && data[2] === 0x14 && data[4] === 0x01 && !locksTable) {
        stored = data.slice(8, 18);
      }
      // Any settings-class frame echoes the current stored table.
      if (data[0] === 0x10 && data[1] === 0x50 && data[2] === 0x14) {
        const frame = new Uint8Array(24);
        frame.set([0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x0d, 0x00]);
        if (!silent) frame.set(stored, 8);
        emit(frame);
      }
    },
  } as unknown as HIDDevice;
  return { device, sent, storedTable: () => [...stored] };
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
  assert.equal(status.ui?.forceShowBattery, false);
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.dpiStages, [800, 1200, 1600, 3200, 5000]);
  assert.deepEqual(status.dpiStagesY, [800, 1200, 1600, 3200, 5000]);
  assert.equal(status.dpi, 800);
  assert.equal(status.dpiY, 800);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.valuesVerified, true);
});

test("readStatus degrades to nothing when the mouse never answers", async () => {
  const { device } = fakeDevice({ silent: true });
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.dpi, 0);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.match(status.ui?.statusNote ?? "", /did not answer/);
});

test("setPollingRateHz sends the write and commit tail without touching the DPI table", async () => {
  const { device, sent, storedTable } = fakeDevice();
  await new RoccatHidClient(device).setPollingRateHz(125);
  const frames = sent.filter((frame) => frame[1] === 0x50 && frame[2] === 0x14 && frame[4] === 0x01);
  assert.equal(frames.length, 1, "one settings write");
  assert.equal(frames[0]![2], 0x14);
  assert.equal(frames[0]![5], 0x03, "125 Hz writes code 0x03");
  const apply = sent.find((frame) => hex(frame, 4) === "10 50 18 04");
  assert.ok(apply, "commit tail sent");
  assert.equal(sent.every((frame) => frame.length === ROCCAT_PACKET_LENGTH), true);
  assert.deepEqual(storedTable(), STORED_TABLE, "the stored stages are preserved, not replaced with defaults");
  assert.deepEqual([...frames[0]!.subarray(8, 18)], STORED_TABLE, "the write carries the preserved table");
});

test("setDpiStages reads, writes the five stages, and confirms them", async () => {
  const { device, sent } = fakeDevice();
  const client = new RoccatHidClient(device);
  await client.setDpiStages([800, 1200, 1600, 3200, 5000], [400, 800, 1200, 1600, 3200]);
  const write = sent.find((frame) => frame[1] === 0x50 && frame[2] === 0x14 && frame[4] === 0x01);
  assert.ok(write);
  assert.deepEqual([...write!.subarray(8, 18)], [16, 8, 24, 16, 32, 24, 64, 32, 100, 64]);
  await assert.rejects(
    () => client.setDpiStages([800, 1200, 1600, 3200], [400, 800, 1200, 1600, 3200]),
    /five stages/,
  );
});

test("a rejected write does not poison the next write", async () => {
  const { device, sent } = fakeDevice();
  const client = new RoccatHidClient(device);
  await assert.rejects(() => client.setDpiStages([800, 1200, 1600, 3200, 19050], [800, 800, 800, 800, 800]), RangeError);
  await client.setPollingRateHz(1000);
  const write = sent.filter((frame) => frame[1] === 0x50 && frame[2] === 0x14 && frame[4] === 0x01).at(-1);
  assert.equal(write![5], 0x00, "1000 Hz -> 0x00");
  assert.deepEqual([...write!.subarray(8, 18)], STORED_TABLE, "still carrying the real stored table");
});

test("a mouse that ignores the write is not reported as success", async () => {
  const { device } = fakeDevice({ locksTable: true });
  const client = new RoccatHidClient(device);
  await assert.rejects(
    () => client.setDpiStages([400, 400, 400, 400, 400], [400, 400, 400, 400, 400]),
    /instead of the requested/,
  );
});

test("a setter refuses to guess when the mouse will not report its table", async () => {
  const { device } = fakeDevice({ silent: true });
  await assert.rejects(() => new RoccatHidClient(device).setPollingRateHz(125), /refused/);
});

test("setLighting writes one frame with both zones", async () => {
  const { device, sent } = fakeDevice();
  await new RoccatHidClient(device).setLighting("#123456", "#000000");
  assert.equal(sent.length, 1);
  assert.equal(hex(sent[0]!, 15), "10 10 0b 00 09 64 64 64 06 12 34 56 00 00 00");
  await assert.rejects(() => new RoccatHidClient(device).setLighting("blue", "#000000"), /rrggbb/);
});

test("wired mode reports the wired connection and still no battery", async () => {
  const { device } = fakeDevice({ productId: 0x2c92 });
  const status = await new RoccatHidClient(device).readStatus();
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.connectionDetail, "Wired USB");
});
