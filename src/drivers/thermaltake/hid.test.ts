import assert from "node:assert/strict";
import test from "node:test";
import { ThermaltakeHidClient } from "./hid.ts";
import {
  THERMALTAKE_CONFIG_USAGE,
  THERMALTAKE_CONFIG_USAGE_PAGE,
  THERMALTAKE_IRIS_PRODUCT_ID,
  THERMALTAKE_PROFILE_SIZE,
  THERMALTAKE_REPORT_ID,
  THERMALTAKE_REPORT_SIZE,
  THERMALTAKE_VENDOR_ID,
  thermaltakeApplySettings,
  thermaltakeChecksum,
  thermaltakeCommands,
  thermaltakeDecodeActiveProfile,
  thermaltakeDecodeFirmware,
  thermaltakeDecodeProfile,
  thermaltakeDecodeSettings,
  thermaltakeEncodeProfileWrite,
  thermaltakeHzToPollingCode,
  thermaltakeNearestDpi,
  thermaltakePollingCodeToHz,
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

test("command payloads match the vendor tool's frames", () => {
  assert.equal(thermaltakeCommands.readFirmware().length, THERMALTAKE_REPORT_SIZE);
  assert.equal(hex(thermaltakeCommands.readFirmware(), 4), "c4 08 00 00");
  assert.equal(hex(thermaltakeCommands.readProfile(3), 4), "c4 0c 03 00");
  assert.equal(hex(thermaltakeCommands.beginWrite(), 4), "c4 10 00 00");
  assert.equal(hex(thermaltakeCommands.endWrite(), 4), "c4 00 00 00");
  assert.equal(hex(thermaltakeCommands.readActiveProfile(), 5), "df 0d 00 00 00");
  assert.equal(hex(thermaltakeCommands.writeActiveProfile(2), 5), "de 0d 00 00 52");
  assert.throws(() => thermaltakeCommands.readProfile(5), RangeError);
});

test("decodes the firmware and profile-register replies the mouse sent", () => {
  assert.equal(thermaltakeDecodeFirmware(commandReply([0xb0, 0x55, 0xaa, 0x80, 0x00, 0x50])), 0x80);
  assert.equal(thermaltakeDecodeFirmware(commandReply([0xb0, 0x00, 0x00, 0x80])), null);
  assert.equal(thermaltakeDecodeActiveProfile(commandReply([0xb0, 0xc0, 0x0d, 0x00, 0x00, 0x50])), 0);
  assert.equal(thermaltakeDecodeActiveProfile(commandReply([0xb0, 0xc0, 0x0d, 0x00, 0x00, 0x53])), 3);
  assert.equal(thermaltakeDecodeActiveProfile(commandReply([0xb0, 0xc0, 0x0d, 0x00, 0x00, 0x57])), null);
  // Without the leading report-id byte the offsets shift back into place.
  assert.equal(thermaltakeDecodeActiveProfile(commandReply([0xc0, 0x0d, 0x00, 0x00, 0x52]).subarray(0, THERMALTAKE_REPORT_SIZE)), 2);
  assert.equal(thermaltakeDecodeActiveProfile(new Uint8Array(64)), null);
});

test("profile replies are checked for status, index and checksum", () => {
  const data = profileData(PROFILE_0_HEAD);
  const reply = profileReply(0, data);
  assert.deepEqual(thermaltakeDecodeProfile(reply, 0), data);
  assert.deepEqual(thermaltakeDecodeProfile(reply.subarray(1), 0), data);
  assert.equal(thermaltakeDecodeProfile(reply, 1), null);
  const damaged = reply.slice();
  damaged[100] ^= 1;
  assert.equal(thermaltakeDecodeProfile(damaged, 0), null);
});

test("profile writes carry the block and a checksum that zeroes the sum", () => {
  const data = profileData(PROFILE_0_HEAD);
  const payload = thermaltakeEncodeProfileWrite(4, data);
  assert.equal(payload.length, THERMALTAKE_REPORT_SIZE);
  assert.equal(hex(payload, 2), "00 04");
  assert.deepEqual(payload.subarray(3, 3 + THERMALTAKE_PROFILE_SIZE), data);
  let sum = 0;
  for (const byte of payload.subarray(2)) sum += byte;
  assert.equal(sum & 0xff, 0);
});

test("decodes the settings stored on the mouse", () => {
  assert.deepEqual(thermaltakeDecodeSettings(profileData(PROFILE_0_HEAD)), {
    pollingRateHz: 1000,
    dpiStages: [400],
    dpiTable: [400, 800, 1600, 3200],
    activeDpiStage: 0,
    angleSnapping: false,
    debounceMs: 11,
  });
  assert.deepEqual(thermaltakeDecodeSettings(profileData(PROFILE_2_HEAD)), {
    pollingRateHz: 2000,
    dpiStages: [3600, 800, 1600, 3200],
    dpiTable: [3600, 800, 1600, 3200],
    activeDpiStage: 3,
    angleSnapping: false,
    debounceMs: 8,
  });
});

test("polling codes and DPI steps", () => {
  assert.deepEqual([8, 4, 2, 1, 0x10, 0].map(thermaltakePollingCodeToHz), [125, 250, 500, 1000, 1500, 2000]);
  assert.equal(thermaltakePollingCodeToHz(0x80), null);
  assert.equal(thermaltakeHzToPollingCode(500), 2);
  assert.throws(() => thermaltakeHzToPollingCode(4000), RangeError);
  assert.equal(thermaltakeNearestDpi(1649), 1600);
  assert.equal(thermaltakeNearestDpi(50), 100);
  assert.equal(thermaltakeNearestDpi(26000), 5000);
});

test("applying settings keeps every byte it does not own", () => {
  const data = profileData(PROFILE_0_HEAD);
  const next = thermaltakeApplySettings(data, {
    pollingRateHz: 500,
    dpiStages: [800, 1600, 3200],
    activeDpiStage: 1,
    angleSnapping: true,
    debounceMs: 16,
  });
  assert.equal(hex(next, 14), "02 01 80 ff 09 75 00 1f 31 08 10 20 20 32");
  assert.deepEqual(next.subarray(14), data.subarray(14));
  assert.notEqual(next, data);
  assert.equal(data[0], 0x01);
  // Turning off what is already off leaves the factory 0x04 alone.
  assert.equal(thermaltakeApplySettings(data, { angleSnapping: false })[2], 0x04);
  assert.equal(thermaltakeApplySettings(next, { angleSnapping: false })[2], 0x00);
  // Fewer stages pull the active one inside the list.
  assert.equal(thermaltakeApplySettings(profileData(PROFILE_2_HEAD), { dpiStages: [400, 800] })[8], 0x21);
  assert.throws(() => thermaltakeApplySettings(data, { activeDpiStage: 1 }), RangeError);
  assert.throws(() => thermaltakeApplySettings(data, { debounceMs: 40 }), RangeError);
  assert.throws(() => thermaltakeApplySettings(data, { dpiStages: [] }), RangeError);
});

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
      { usagePage, usage: THERMALTAKE_CONFIG_USAGE, featureReports: [], inputReports: [], outputReports: [], children: [] },
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

test("isSupported needs the Thermaltake ids and the LED-page config collection", () => {
  assert.equal(ThermaltakeHidClient.isSupported(fakeDevice(fakeMouse()).device), true);
  assert.equal(ThermaltakeHidClient.isSupported(fakeDevice(fakeMouse(), 0xff00).device), false);
  const other = fakeDevice(fakeMouse()).device as unknown as { productId: number };
  other.productId = 0x1020;
  assert.equal(ThermaltakeHidClient.isSupported(other as unknown as HIDDevice), false);
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
