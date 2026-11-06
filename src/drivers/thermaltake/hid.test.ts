import assert from "node:assert/strict";
import test from "node:test";
import { ThermaltakeHidClient, thermaltakeChannel } from "./hid.ts";
import {
  THERMALTAKE_CONFIG_USAGE,
  THERMALTAKE_CONFIG_USAGE_PAGE,
  THERMALTAKE_IRIS_PRODUCT_ID,
  THERMALTAKE_PROFILE_SIZE,
  THERMALTAKE_REPORT_ID,
  THERMALTAKE_REPORT_SIZE,
  THERMALTAKE_VENDOR_ID,
  thermaltakeChecksum,
  thermaltakeCommands,
  thermaltakeDecodeActiveProfile,
  thermaltakeDecodeFirmware,
  thermaltakeEncodeProfileWrite,
  thermaltakeShortCommand,
} from "../../thermaltake/index.ts";

const hex = (bytes: Uint8Array, length = bytes.length) =>
  [...bytes.subarray(0, length)].map((b) => b.toString(16).padStart(2, "0")).join(" ");

// First 32 bytes of profiles read from an Iris Optical RGB Miku Edition
// (firmware byte 0x80); the rest of each profile is lighting and buttons.
const PROFILE_0_HEAD = [0x01, 0x01, 0x04, 0xff, 0x04, 0x75, 0x00, 0x1f, 0x10, 0x04, 0x08, 0x10, 0x20, 0x32];
const PROFILE_2_HEAD = [0x00, 0x01, 0x00, 0xff, 0x01, 0x75, 0x00, 0x1f, 0x43, 0x24, 0x08, 0x10, 0x20, 0x32];

function profileData(head: readonly number[]): Uint8Array {
  const data = new Uint8Array(THERMALTAKE_PROFILE_SIZE);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 7 + 3) & 0xff;
  data.set(head);
  return data;
}

/** A 0x05 reply as Windows hands it back: report id kept, status 0xB0 after it. */
function profileReply(profile: number, data: Uint8Array): Uint8Array {
  const reply = new Uint8Array(THERMALTAKE_REPORT_SIZE + 1);
  reply[0] = THERMALTAKE_REPORT_ID.profile;
  reply[1] = 0xb0;
  reply[2] = profile;
  reply[3] = thermaltakeChecksum(data);
  reply.set(data, 4);
  return reply;
}

function commandReply(head: readonly number[]): Uint8Array {
  const reply = new Uint8Array(THERMALTAKE_REPORT_SIZE + 1);
  reply.set(head);
  return reply;
}

interface FakeMouse {
  profiles: Uint8Array[];
  active: number;
  /** Drop writes on the floor, like flash that never took them. */
  ignoreWrites?: boolean;
}

function fakeDevice(mouse: FakeMouse, usagePage = THERMALTAKE_CONFIG_USAGE_PAGE) {
  const sent: string[] = [];
  let pendingCommand = new Uint8Array(0);
  let selected = 0;
  const device = {
    vendorId: THERMALTAKE_VENDOR_ID,
    productId: THERMALTAKE_IRIS_PRODUCT_ID,
    productName: "Iris Optical RGB",
    opened: false,
    collections: [
      { usagePage: 0x01, usage: 0x06, featureReports: [], inputReports: [], outputReports: [], children: [] },
      { usagePage, usage: THERMALTAKE_CONFIG_USAGE, featureReports: [{ reportId: THERMALTAKE_REPORT_ID.command, items: [] }], inputReports: [], outputReports: [], children: [] },
    ],
    open: async () => { (device as { opened: boolean }).opened = true; },
    close: async () => {},
    sendFeatureReport: async (reportId: number, data: Uint8Array) => {
      assert.equal(data.length, THERMALTAKE_REPORT_SIZE);
      if (reportId === THERMALTAKE_REPORT_ID.profile) {
        sent.push(`05 ${hex(data, 3)}`);
        const profile = data[1]!;
        const block = data.slice(3, 3 + THERMALTAKE_PROFILE_SIZE);
        assert.equal(data[2], thermaltakeChecksum(block));
        if (!mouse.ignoreWrites) mouse.profiles[profile] = block;
        return;
      }
      sent.push(hex(data, 5));
      pendingCommand = data.slice(0, 5);
      if (data[0] === 0xc4 && data[1] === 0x0c) selected = data[2]!;
      if (data[0] === 0xde && data[1] === 0x0d) mouse.active = data[4]! & 0x0f;
    },
    receiveFeatureReport: async (reportId: number) => {
      if (reportId === THERMALTAKE_REPORT_ID.profile) {
        return new DataView(profileReply(selected, mouse.profiles[selected]!).buffer);
      }
      if (pendingCommand[0] === 0xc4 && pendingCommand[1] === 0x08) {
        return new DataView(commandReply([0xb0, 0x55, 0xaa, 0x80]).buffer);
      }
      if (pendingCommand[0] === 0xdf && pendingCommand[1] === 0x0d) {
        return new DataView(commandReply([0xb0, 0xc0, 0x0d, 0x00, 0x00, 0x50 + mouse.active]).buffer);
      }
      throw new Error("STALL");
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

function fakeMouse(): FakeMouse {
  return {
    profiles: [PROFILE_0_HEAD, PROFILE_0_HEAD, PROFILE_2_HEAD, PROFILE_0_HEAD, PROFILE_0_HEAD].map(profileData),
    active: 0,
  };
}

/**
 * Interface 0 as Chrome on Windows shows it: the mouse collection with its
 * unnumbered 8-byte feature report. Replies come back with the leading 0x00
 * report id, as `HidD_GetFeature` returned them on hardware.
 */
function fakeMouseInterface(mouse: FakeMouse) {
  const sent: string[] = [];
  let last = new Uint8Array(8);
  const device = {
    vendorId: THERMALTAKE_VENDOR_ID,
    productId: THERMALTAKE_IRIS_PRODUCT_ID,
    productName: "Iris Optical RGB",
    opened: false,
    collections: [{
      usagePage: 0x01,
      usage: 0x02,
      featureReports: [{ reportId: 0, items: [] }],
      inputReports: [],
      outputReports: [],
      children: [],
    }],
    open: async () => { (device as { opened: boolean }).opened = true; },
    close: async () => {},
    sendFeatureReport: async (reportId: number, data: Uint8Array) => {
      assert.equal(reportId, 0);
      assert.equal(data.length, 8);
      sent.push(hex(data, 5));
      last = data.slice();
      if (data[0] === 0xde && data[1] === 0x0d) mouse.active = data[4]! & 0x0f;
    },
    receiveFeatureReport: async (reportId: number) => {
      assert.equal(reportId, 0);
      const body = last[0] === 0xc4 && last[1] === 0x08
        ? [0xb0, 0x55, 0xaa, 0x80, 0x00, 0x50]
        : [0xb0, 0xc0, last[1]!, 0x00, 0x00, 0x50 + mouse.active];
      const reply = new Uint8Array(9);
      reply.set(body, 1);
      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

test("isSupported claims the Iris ids; the channel decides what works", () => {
  assert.equal(ThermaltakeHidClient.isSupported(fakeDevice(fakeMouse()).device), true);
  assert.equal(thermaltakeChannel(fakeDevice(fakeMouse()).device), "config");
  assert.equal(thermaltakeChannel(fakeMouseInterface(fakeMouse()).device), "short");
  assert.equal(ThermaltakeHidClient.isSupported(fakeDevice(fakeMouse(), 0x0c).device), true);
  assert.equal(thermaltakeChannel(fakeDevice(fakeMouse(), 0x0c).device), null);
  const other = fakeDevice(fakeMouse()).device as unknown as { productId: number };
  other.productId = 0x1020;
  assert.equal(ThermaltakeHidClient.isSupported(other as unknown as HIDDevice), false);
});

test("short commands are the first 8 bytes and refuse anything longer", () => {
  assert.equal(hex(thermaltakeShortCommand(thermaltakeCommands.writeActiveProfile(1))), "de 0d 00 00 51 00 00 00");
  assert.throws(() => thermaltakeShortCommand(thermaltakeEncodeProfileWrite(0, profileData(PROFILE_0_HEAD))), RangeError);
  // The 8-byte reply decodes like the 0x0C one, with or without the id byte.
  assert.equal(thermaltakeDecodeFirmware(new Uint8Array([0x00, 0xb0, 0x55, 0xaa, 0x80, 0, 0x50, 0, 0]), "short"), 0x80);
  assert.equal(thermaltakeDecodeActiveProfile(new Uint8Array([0xb0, 0xc0, 0x0d, 0, 0, 0x52, 0, 0]), "short"), 2);
});

// What Chrome on Windows shows of interface 1: the config collection has no
// caps, so only the consumer collection (usage 0x0C:0x01) survives.
test("the keyboard interface alone is status only and sends nothing", async () => {
  const { device, sent } = fakeDevice(fakeMouse(), 0x0c);
  const client = new ThermaltakeHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.name, "Tt eSPORTS Iris Optical RGB");
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /OpenMouse Bridge/);
  await assert.rejects(client.setPollingRate(500), /OpenMouse Bridge/);
  await assert.rejects(client.setProfile(2), /OpenMouse Bridge/);
  assert.deepEqual(sent, []);
});

test("the mouse interface reads firmware and switches profiles but edits nothing", async () => {
  const mouse = fakeMouse();
  mouse.active = 1;
  const { device, sent } = fakeMouseInterface(mouse);
  const client = new ThermaltakeHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /switch onboard profiles/);
  assert.equal(status.activeProfile, 2);
  assert.equal(status.profileCount, 5);
  assert.deepEqual(status.firmware, ["Firmware V1.128"]);
  assert.equal(status.dpiStages, undefined);

  assert.equal(await client.setProfile(5), 5);
  assert.equal(mouse.active, 4);
  await assert.rejects(client.setDpi(800), /OpenMouse Bridge/);
  assert.deepEqual(sent, [
    "c4 08 00 00 00",
    "df 0d 00 00 00",
    "de 0d 00 00 54",
    "c4 00 00 00 00",
    "df 0d 00 00 00",
  ]);
});

test("readStatus reports the active profile's settings", async () => {
  const mouse = fakeMouse();
  mouse.active = 2;
  const { device } = fakeDevice(mouse);
  const status = await new ThermaltakeHidClient(device).readStatus();
  assert.equal(status.brand, "Thermaltake");
  assert.equal(status.name, "Tt eSPORTS Iris Optical RGB");
  assert.equal(status.activeProfile, 3);
  assert.equal(status.profileCount, 5);
  assert.equal(status.pollingRateHz, 2000);
  assert.deepEqual(status.dpiStages, [3600, 800, 1600, 3200]);
  assert.equal(status.activeDpiStage, 3);
  assert.equal(status.dpi, 3200);
  assert.equal(status.debounceMs, 8);
  assert.deepEqual(status.firmware, ["Firmware V1.128"]);
});

test("a setting rewrites the active profile inside a write window and reads it back", async () => {
  const mouse = fakeMouse();
  const { device, sent } = fakeDevice(mouse);
  const client = new ThermaltakeHidClient(device);
  const before = mouse.profiles[0]!.slice();
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    "df 0d 00 00 00",
    "c4 0c 00 00 00",
    "c4 10 00 00 00",
    `05 00 00 ${thermaltakeChecksum(mouse.profiles[0]!).toString(16).padStart(2, "0")}`,
    "c4 00 00 00 00",
    "c4 0c 00 00 00",
  ]);
  assert.equal(mouse.profiles[0]![0], 0x02);
  assert.deepEqual(mouse.profiles[0]!.subarray(1), before.subarray(1));
  // Other profiles are untouched.
  assert.deepEqual(mouse.profiles[1], profileData(PROFILE_0_HEAD));
});

test("DPI stage edits", async () => {
  const mouse = fakeMouse();
  const client = new ThermaltakeHidClient(fakeDevice(mouse).device);
  await client.setDpiStageCount(3);
  let status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
  await client.setDpiStageValue(2, 2450);
  await client.setActiveDpiStage(2);
  status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [400, 800, 2500]);
  assert.equal(status.dpi, 2500);
  await client.setDpi(5000);
  assert.equal((await client.readStatus()).dpi, 5000);
  await assert.rejects(client.setDpiStageValue(3, 800), RangeError);
  await assert.rejects(client.setDpiStageCount(5), RangeError);
});

test("an unchanged setting sends no write", async () => {
  const mouse = fakeMouse();
  const { device, sent } = fakeDevice(mouse);
  await new ThermaltakeHidClient(device).setPollingRate(1000);
  assert.deepEqual(sent, ["df 0d 00 00 00", "c4 0c 00 00 00"]);
});

test("the write window is closed even when opening it reports an error", async () => {
  const mouse = fakeMouse();
  const { device, sent } = fakeDevice(mouse);
  const send = device.sendFeatureReport.bind(device);
  (device as { sendFeatureReport: HIDDevice["sendFeatureReport"] }).sendFeatureReport = async (reportId, data) => {
    const bytes = new Uint8Array(data as ArrayBuffer);
    await send(reportId, bytes);
    if (reportId === THERMALTAKE_REPORT_ID.command && bytes[0] === 0xc4 && bytes[1] === 0x10) throw new Error("NAK");
  };
  await assert.rejects(new ThermaltakeHidClient(device).setPollingRate(500), /NAK/);
  assert.deepEqual(sent.slice(-2), ["c4 10 00 00 00", "c4 00 00 00 00"]);
  await assert.rejects(new ThermaltakeHidClient(fakeDevice(fakeMouse()).device).setDpi(Number.NaN), RangeError);
});

test("a write the mouse did not keep is an error", async () => {
  const mouse = fakeMouse();
  mouse.ignoreWrites = true;
  const client = new ThermaltakeHidClient(fakeDevice(mouse).device);
  await assert.rejects(client.setAngleSnapping(true), /did not keep/);
});

test("setProfile switches the onboard profile, one-based", async () => {
  const mouse = fakeMouse();
  const { device, sent } = fakeDevice(mouse);
  const client = new ThermaltakeHidClient(device);
  assert.equal(await client.setProfile(4), 4);
  assert.equal(mouse.active, 3);
  assert.deepEqual(sent, ["de 0d 00 00 53", "c4 00 00 00 00", "df 0d 00 00 00"]);
  assert.equal((await client.readStatus()).activeProfile, 4);
});

test("config collections require feature reports and preserve the short fallback", () => {
  const { device } = fakeDevice(fakeMouse());
  device.collections[1]!.featureReports.length = 0;
  assert.equal(thermaltakeChannel(device), null);
  device.collections.push(...fakeMouseInterface(fakeMouse()).device.collections);
  assert.equal(thermaltakeChannel(device), "short");
  const nested = fakeDevice(fakeMouse()).device.collections[1]!;
  device.collections[1]!.children.push(nested);
  assert.equal(thermaltakeChannel(device), "config");
});

/**
 * Interface 1 as OpenMouse Bridge lists it on Windows, measured on the Miku
 * Edition: the config collection carries only the input report 0 hidapi
 * rebuilt, and replies lose their first byte and stop where the device's
 * transfer ended (7 bytes for 0x0C, 2051 for a profile). `refuses` mimics
 * Bridge v1.0.0-beta.20, which will not read an undeclared feature report.
 */
function fakeBridgeInterface(mouse: FakeMouse, refuses = false) {
  const fake = fakeDevice(mouse);
  const config = fake.device.collections[1]!;
  config.featureReports.length = 0;
  (config.inputReports as HIDReportInfo[]).push({ reportId: 0, items: [] } as unknown as HIDReportInfo);
  const receive = fake.device.receiveFeatureReport.bind(fake.device);
  fake.device.receiveFeatureReport = async (reportId) => {
    if (refuses) throw new Error(`feature report ${reportId} is not declared by this interface`);
    const reply = await receive(reportId);
    const bytes = new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
    const end = reportId === THERMALTAKE_REPORT_ID.profile ? THERMALTAKE_PROFILE_SIZE + 4 : 8;
    return new DataView(bytes.slice(1, end).buffer);
  };
  return fake;
}

test("a Bridge-rebuilt config collection is probed and used once it answers", async () => {
  const mouse = fakeMouse();
  const { device } = fakeBridgeInterface(mouse);
  assert.equal(thermaltakeChannel(device), null);
  const client = new ThermaltakeHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, undefined);
  assert.deepEqual(status.firmware, ["Firmware V1.128"]);
  assert.deepEqual(status.dpiStages, [400]);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(mouse.profiles[0]![0], 0x02);
});

test("a Bridge that refuses undeclared reads falls back to status only", async (t) => {
  const mouse = fakeMouse();
  const { device, sent } = fakeBridgeInterface(mouse, true);
  const warning = t.mock.method(console, "warn", () => {});
  const client = new ThermaltakeHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /Update OpenMouse Bridge/);
  assert.ok(warning.mock.calls.some((call) => call.arguments[0] === "OpenMouse Bridge could not read the Thermaltake settings collection."));
  // The refusal sticks: later reads send nothing and settings explain why.
  const probe = sent.length;
  assert.match((await client.readStatus()).ui?.statusNote ?? "", /Update OpenMouse Bridge/);
  await assert.rejects(client.setPollingRate(500), /Update OpenMouse Bridge/);
  assert.equal(sent.length, probe);
  assert.equal(mouse.profiles[0]![0], 0x01);
});

test("firmware transport failures are logged while settings remain readable", async (t) => {
  const { device } = fakeDevice(fakeMouse());
  const receive = device.receiveFeatureReport.bind(device);
  const failure = new Error("firmware STALL");
  let first = true;
  device.receiveFeatureReport = async (reportId) => {
    if (first) { first = false; throw failure; }
    return receive(reportId);
  };
  const warning = t.mock.method(console, "warn", () => {});
  const status = await new ThermaltakeHidClient(device).readStatus();
  assert.deepEqual(status.firmware, []);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(warning.mock.calls[0]!.arguments, ["Could not read Thermaltake firmware.", failure]);
});

test("short status propagates a failed active-profile reply", async () => {
  const { device } = fakeMouseInterface(fakeMouse());
  const receive = device.receiveFeatureReport.bind(device);
  let calls = 0;
  device.receiveFeatureReport = async (reportId) => {
    const reply = await receive(reportId);
    if (++calls === 2) reply.setUint8(1, 0);
    return reply;
  };
  await assert.rejects(new ThermaltakeHidClient(device).readStatus(), /did not report its active profile/);
});

test("a truncated profile prevents all flash writes", async () => {
  const { device, sent } = fakeDevice(fakeMouse());
  const receive = device.receiveFeatureReport.bind(device);
  device.receiveFeatureReport = async (reportId) => reportId === THERMALTAKE_REPORT_ID.profile
    ? new DataView(new Uint8Array([0xb0, 0, 0, 0, 0, 0, 0, 0]).buffer)
    : receive(reportId);
  await assert.rejects(new ThermaltakeHidClient(device).setPollingRate(500), /damaged copy/);
  assert.deepEqual(sent, ["df 0d 00 00 00", "c4 0c 00 00 00"]);
});

test("a truncated firmware reply is not displayed or cached", async () => {
  const { device } = fakeDevice(fakeMouse());
  const receive = device.receiveFeatureReport.bind(device);
  let first = true;
  device.receiveFeatureReport = async (reportId) => {
    if (first) {
      first = false;
      return new DataView(new Uint8Array([0x55, 0xaa]).buffer);
    }
    return receive(reportId);
  };
  const client = new ThermaltakeHidClient(device);
  assert.deepEqual((await client.readStatus()).firmware, []);
  assert.deepEqual((await client.readStatus()).firmware, ["Firmware V1.128"]);
});
