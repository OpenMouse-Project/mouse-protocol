import assert from "node:assert/strict";
import test from "node:test";
import {
  THERMALTAKE_PROFILE_SIZE,
  THERMALTAKE_REPORT_ID,
  THERMALTAKE_REPORT_SIZE,
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
} from "./index.ts";

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
  // OpenMouse Bridge on Windows: hidapi reports the 8 bytes the device sent
  // and Bridge drops the first as the report id, status byte included.
  assert.equal(thermaltakeDecodeFirmware(new Uint8Array([0x55, 0xaa, 0x80, 0x00, 0x50, 0x00, 0x00])), 0x80);
  assert.equal(thermaltakeDecodeActiveProfile(new Uint8Array([0xc0, 0x0d, 0x00, 0x00, 0x50, 0x00, 0x00])), 0);
  assert.equal(thermaltakeDecodeActiveProfile(new Uint8Array(64)), null);
  assert.equal(thermaltakeDecodeActiveProfile(new Uint8Array(0)), null);
  // A reply that kept its status byte must carry 0xB0.
  assert.equal(thermaltakeDecodeActiveProfile(commandReply([0xb1, 0xc0, 0x0d, 0x00, 0x00, 0x50])), null);
  assert.equal(thermaltakeDecodeFirmware(commandReply([0x00, 0x55, 0xaa, 0x80])), null);
  assert.equal(thermaltakeDecodeActiveProfile(new Uint8Array([0x00, 0xc0, 0x0d, 0, 0, 0x50, 0, 0]), "short"), null);
});

test("profile replies are checked for status, index and checksum", () => {
  const data = profileData(PROFILE_0_HEAD);
  const reply = profileReply(0, data);
  assert.deepEqual(thermaltakeDecodeProfile(reply, 0), data);
  assert.deepEqual(thermaltakeDecodeProfile(reply.subarray(1), 0), data);
  // Bridge: no report id in front and no pad byte at the end (2051 bytes).
  assert.deepEqual(thermaltakeDecodeProfile(reply.subarray(1, -1), 0), data);
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
  assert.throws(() => thermaltakeNearestDpi(Number.NaN), RangeError);
  assert.throws(() => thermaltakeNearestDpi(Number.POSITIVE_INFINITY), RangeError);
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
  // A patch that does not touch the stages keeps the level byte as stored,
  // even one the vendor tool would only read as "four stages".
  const odd = profileData([...PROFILE_0_HEAD.slice(0, 8), 0x50, ...PROFILE_0_HEAD.slice(9)]);
  assert.equal(thermaltakeApplySettings(odd, { pollingRateHz: 500, debounceMs: 9 })[8], 0x50);
});


test("truncated profiles cannot pass with a zero checksum", () => {
  const data = new Uint8Array(THERMALTAKE_PROFILE_SIZE);
  const reply = profileReply(0, data);
  for (const length of [3, 8, 64, THERMALTAKE_PROFILE_SIZE + 2]) {
    assert.equal(thermaltakeDecodeProfile(reply.subarray(1, 1 + length), 0), null);
  }
  // Bridge omits the leading report id and trailing pad, but retains all data.
  assert.deepEqual(thermaltakeDecodeProfile(reply.subarray(1, reply.length - 1), 0), data);
});

test("failed active-profile replies are rejected on both channels", () => {
  for (const status of [0, 0xa0, 0xff]) {
    assert.equal(thermaltakeDecodeActiveProfile(commandReply([status, 0xc0, 0x0d, 0, 0, 0x50])), null);
    const short = new Uint8Array([status, 0xc0, 0x0d, 0, 0, 0x50, 0, 0]);
    assert.equal(thermaltakeDecodeActiveProfile(short, "short"), null);
    assert.equal(thermaltakeDecodeActiveProfile(new Uint8Array([0, ...short]), "short"), null);
  }
});
