import assert from "node:assert/strict";
import test from "node:test";

import {
  OT_COMTYPE,
  OT_DEVICE_PROFILES,
  OT_EFFECT_OFFSETS,
  OT_EFFECT_SIZE,
  OT_PACKET_SIZE,
  OT_PAYLOAD_INDEX,
  OT_POLL_RATE_HZ,
  OT_PROFILE_BLOCK,
  OT_PROFILE_FLAG,
  OT_UNMAPPED_WIRELESS_PID,
  OT_VENDOR_ID,
  otClampCpi,
  otDecodeButtonRemap,
  otDecodeEffect,
  otEncodeEffect,
  otEncodeFirmwarePacket,
  otEncodeFirmwareReset,
  otEncodeFirmwareSetup,
  otEncodeProfilePacket,
  otEncodeProfilePackets,
  otEncodeQueryPacket,
  otFirmwarePackets,
  otIsValidCpi,
  otLodLabel,
  otLodRaw,
  otNormalizeFeatureReport,
  otParseWirelessTelemetry,
  otPollRateHz,
  otProfileBlocks,
  otExposedFeatures,
  otProfileForPid,
  otReassembleEffect,
  type OtEffect,
} from "@openmouse/protocol/endgame-gear-ot";

function sampleEffect(): OtEffect {
  return {
    transferFlags: 0,
    profileIndex: 1,
    activeProfile: 0,
    maxProfile: 5,
    cpi: [400, 800, 1600, 3200],
    profileFlags: OT_PROFILE_FLAG.angleSnapping | OT_PROFILE_FLAG.slamClickFilter,
    cpiIndex: 1,
    pollrateIndex: 0,
    pollRates: [0, 1, 2],
    sensitivityX: 10,
    sensitivityY: 10,
    dcuThreshold: 1,
    acceleration: 0,
    angleSnap: 3,
    jitterCorrection: 0,
    red: [0, 0, 255, 255],
    green: [0, 255, 255, 0],
    blue: [255, 0, 0, 0],
    buttonRemap: [0, 1, 4, 6, 5, 9, 9],
    lcdBrightness: 0,
    lcdContrast: 0,
    winPointerSpeed: 10,
    winSpare: 0,
    hidUsage: [0, 0, 0, 0, 0, 0, 0],
    modifier: [0, 0, 0, 0, 0, 0, 0],
    profileName: "Test",
    cpiY: [400, 800, 1600, 3200],
    wirelessMode: 0,
    rgbMode: 2,
    rgbRed: 255,
    rgbGreen: 0,
    rgbBlue: 128,
    rgbBrightness: 7,
    rgbSpeed: 3,
  };
}

test("the OT catalog names XM1r, OP1, and OP1 RGB with their vendor PIDs", () => {
  assert.deepEqual([...OT_DEVICE_PROFILES.keys()], [0x1903, 0x1906, 0x1905]);
  assert.equal(OT_DEVICE_PROFILES.get(0x1903)?.name, "Endgame Gear XM1r");
  assert.equal(OT_DEVICE_PROFILES.get(0x1906)?.name, "Endgame Gear OP1");
  assert.equal(OT_DEVICE_PROFILES.get(0x1905)?.name, "Endgame Gear OP1 RGB");
  assert.equal(OT_VENDOR_ID, 0x3367);
  assert.equal(OT_DEVICE_PROFILES.get(0x1903)?.maxCpi, 19_000);
  assert.equal(OT_DEVICE_PROFILES.get(0x1905)?.maxCpi, 26_000);
  assert.equal(OT_DEVICE_PROFILES.get(0x1905)?.hasRgbEffect, true);
  assert.equal(OT_DEVICE_PROFILES.get(0x1903)?.hasRgbEffect, false);
});

test("the 0x1910 wireless page stays unmapped until a device name is tied to it", () => {
  assert.equal(OT_UNMAPPED_WIRELESS_PID, 0x1910);
  assert.throws(() => otProfileForPid(0x1910), /Unsupported Endgame Gear OT product/);
});

test("the COMTYPE table carries the profile, macro, LED, and firmware opcodes", () => {
  assert.equal(OT_COMTYPE.setProfileData, 52);
  assert.equal(OT_COMTYPE.queryProfileData, 51);
  assert.equal(OT_COMTYPE.firmwareDlSetup, 8);
  assert.equal(OT_COMTYPE.firmwareDataPacket, 9);
  assert.equal(OT_COMTYPE.resetFirmware, 18);
  assert.equal(OT_COMTYPE.queryFirmwareVersion, 17);
  assert.equal(OT_COMTYPE.firmwareUpgrade, 48);
  assert.equal(OT_COMTYPE.firmwareSetup, 49);
  assert.equal(OT_COMTYPE.firmwareUpload, 50);
  assert.equal(OT_COMTYPE.ack, 20);
  assert.equal(OT_COMTYPE.response, 21);
  assert.equal(OT_COMTYPE.activateProfile, 12);
  assert.equal(OT_COMTYPE.setMacroKey, 14);
  assert.equal(OT_COMTYPE.setLedEffect, 40);
});

test("the effect struct is 118 bytes with the vendor's field offsets", () => {
  assert.equal(OT_EFFECT_SIZE, 118);
  assert.deepEqual(
    [OT_EFFECT_OFFSETS.cpi, OT_EFFECT_OFFSETS.profileFlags, OT_EFFECT_OFFSETS.pollRates,
      OT_EFFECT_OFFSETS.red, OT_EFFECT_OFFSETS.buttonRemap, OT_EFFECT_OFFSETS.hidUsage,
      OT_EFFECT_OFFSETS.profileName, OT_EFFECT_OFFSETS.cpiY, OT_EFFECT_OFFSETS.wirelessMode,
      OT_EFFECT_OFFSETS.rgbMode, OT_EFFECT_OFFSETS.rgbSpeed],
    [4, 12, 18, 27, 39, 50, 71, 103, 111, 112, 117],
  );
});

test("effect encode/decode round-trips every field", () => {
  const effect = sampleEffect();
  const decoded = otDecodeEffect(otEncodeEffect(effect));
  assert.deepEqual(decoded, effect);
});

test("profile packets slice the effect exactly like the vendor tool", () => {
  const bytes = otEncodeEffect(sampleEffect());
  const packets = otEncodeProfilePackets(bytes);
  assert.equal(packets.length, 6);
  const first = OT_EFFECT_SIZE - 68;
  const expected: Array<[number, number, number]> = [
    [OT_PROFILE_BLOCK.keyboard, first, 21],
    [OT_PROFILE_BLOCK.name, first + 21, 32],
    [OT_PROFILE_BLOCK.cpiY, first + 53, 8],
    [OT_PROFILE_BLOCK.wireless, first + 61, 1],
    [OT_PROFILE_BLOCK.rgb, first + 62, 6],
    [OT_PROFILE_BLOCK.main, 0, first],
  ];
  for (const [packet, [block, offset, length]] of packets.map((p, i) => [p, expected[i]!] as const)) {
    assert.equal(packet.length, OT_PACKET_SIZE);
    assert.equal(packet[0], 0);
    assert.equal(packet[1], OT_COMTYPE.setProfileData);
    assert.equal(packet[OT_PAYLOAD_INDEX], block);
    if (block === OT_PROFILE_BLOCK.main) {
      assert.deepEqual(packet.subarray(OT_PAYLOAD_INDEX, OT_PAYLOAD_INDEX + length), bytes.subarray(offset, offset + length));
    } else {
      // Byte 3 is the block id; the header copy lands at bytes 4..7.
      assert.equal(packet.subarray(OT_PAYLOAD_INDEX, OT_PAYLOAD_INDEX + 1)[0], block);
      assert.deepEqual(packet.subarray(OT_PAYLOAD_INDEX + 1, OT_PAYLOAD_INDEX + 4), bytes.subarray(1, 4));
      assert.deepEqual(
        packet.subarray(OT_PAYLOAD_INDEX + 4, OT_PAYLOAD_INDEX + 4 + length),
        bytes.subarray(offset, offset + length),
      );
    }
  }
  assert.throws(() => otEncodeProfilePacket(bytes, 5), /Unknown OT profile block/);
});

test("query replies reassemble into the original effect", () => {
  const bytes = otEncodeEffect(sampleEffect());
  const replies = new Map<number, Uint8Array>();
  const first = OT_EFFECT_SIZE - 68;
  // Hardware-shaped replies: block id + header echo, slice at payload + 4.
  const main = new Uint8Array(61);
  main.set(bytes.subarray(0, first), 0);
  replies.set(OT_PROFILE_BLOCK.main, main);
  const slices: Array<[number, number, number]> = [
    [OT_PROFILE_BLOCK.keyboard, first, 21],
    [OT_PROFILE_BLOCK.name, first + 21, 32],
    [OT_PROFILE_BLOCK.cpiY, first + 53, 8],
    [OT_PROFILE_BLOCK.wireless, first + 61, 1],
    [OT_PROFILE_BLOCK.rgb, first + 62, 6],
  ];
  for (const [block, offset, length] of slices) {
    const payload = new Uint8Array(61);
    payload[0] = block;
    payload.set(bytes.subarray(1, 4), 1);
    payload.set(bytes.subarray(offset, offset + length), 4);
    replies.set(block, payload);
  }
  assert.deepEqual(otReassembleEffect(replies), bytes);
  replies.delete(OT_PROFILE_BLOCK.rgb);
  assert.throws(() => otReassembleEffect(replies), /Missing OT profile block 6/);
});

test("query packets address one block of one profile", () => {
  const packet = otEncodeQueryPacket(OT_PROFILE_BLOCK.cpiY, 2);
  assert.equal(packet[1], OT_COMTYPE.queryProfileData);
  assert.equal(packet[OT_PAYLOAD_INDEX], OT_PROFILE_BLOCK.cpiY);
  assert.equal(packet[OT_PAYLOAD_INDEX + 1], 2);
});

test("wireless telemetry parses the block-4 reply shape", () => {
  const payload = new Uint8Array([9, 9, 9, 9, 3, 0x80 | 75, 42, 43, 0]);
  const telemetry = otParseWirelessTelemetry(payload);
  assert.deepEqual(telemetry, {
    wirelessMode: 3,
    batteryRaw: 0x80 | 75,
    batteryLevel: 75,
    charging: true,
    mouseLevel: 42,
    dongleLevel: 43,
    spacer: 0,
  });
});

test("CPI clamps to the device ceiling in vendor steps", () => {
  const xm1r = OT_DEVICE_PROFILES.get(0x1903)!;
  const op1 = OT_DEVICE_PROFILES.get(0x1906)!;
  assert.equal(otClampCpi(xm1r, 20_000), 19_000);
  assert.equal(otClampCpi(op1, 19_123), 19_100);
  assert.equal(otClampCpi(op1, 8123), 8100);
  assert.equal(otIsValidCpi(op1, 800), true);
  assert.equal(otIsValidCpi(op1, 801), false);
});

test("lift-off and poll-rate helpers follow the vendor UI", () => {
  assert.equal(otLodLabel(1), "1 mm");
  assert.equal(otLodLabel(2), "2 mm");
  assert.equal(otLodLabel(0), null);
  assert.equal(otLodRaw("1 mm"), 1);
  assert.equal(otPollRateHz(0), 1000);
  assert.equal(otPollRateHz(3), 125);
  assert.equal(otPollRateHz(9), null);
  assert.deepEqual([...OT_POLL_RATE_HZ.values()], [1000, 500, 250, 125]);
});

test("button remap bytes decode to mouse, CPI, and raw actions", () => {
  assert.deepEqual(otDecodeButtonRemap(0, 7), { key: "mouse", eventId: 1 });
  assert.deepEqual(otDecodeButtonRemap(2, 3), { key: "mouse", eventId: 4 });
  assert.deepEqual(otDecodeButtonRemap(2, 9), { key: "cpi-loop", eventId: 10 });
  assert.deepEqual(otDecodeButtonRemap(2, 10), { key: "cpi-plus", eventId: 11 });
  assert.deepEqual(otDecodeButtonRemap(2, 11), { key: "cpi-minus", eventId: 12 });
  assert.deepEqual(otDecodeButtonRemap(2, 12), { key: "cpi-custom", eventId: 13 });
});

test("firmware setup, packets, and reset match the vendor flash flow", () => {
  const image = new Uint8Array(130).map((_, i) => i & 0xff);
  const { setup, chunks } = otFirmwarePackets(image);
  assert.equal(setup.chunkSize, 57);
  assert.equal(setup.packetCount, 3);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2]!.length, 130 - 57 * 2);
  setup.major = 1;
  setup.minor = 2;
  setup.build = 3;
  const dlSetup = otEncodeFirmwareSetup(setup);
  assert.equal(dlSetup[1], OT_COMTYPE.firmwareDlSetup);
  assert.equal(dlSetup[OT_PAYLOAD_INDEX], 0x01);
  assert.equal(dlSetup[OT_PAYLOAD_INDEX + 1] | (dlSetup[OT_PAYLOAD_INDEX + 2]! << 8), 130);
  assert.equal(dlSetup[OT_PAYLOAD_INDEX + 3], 3);
  assert.equal(dlSetup[OT_PAYLOAD_INDEX + 11], 1);
  assert.equal(dlSetup[OT_PAYLOAD_INDEX + 12], 1);
  assert.equal(dlSetup[OT_PAYLOAD_INDEX + 13], 2);
  assert.equal(dlSetup[OT_PAYLOAD_INDEX + 14], 3);
  const first = otEncodeFirmwarePacket(0, chunks[0]!);
  assert.equal(first[1], OT_COMTYPE.firmwareDataPacket);
  assert.equal(first[OT_PAYLOAD_INDEX], 0);
  assert.equal(first[OT_PAYLOAD_INDEX + 1], 0);
  assert.deepEqual(first.subarray(OT_PAYLOAD_INDEX + 2, OT_PAYLOAD_INDEX + 2 + 57), chunks[0]);
  const reset = otEncodeFirmwareReset();
  assert.equal(reset[1], OT_COMTYPE.resetFirmware);
  assert.equal(reset[OT_PAYLOAD_INDEX], 0x01);
  assert.deepEqual(
    Array.from(reset.subarray(OT_PAYLOAD_INDEX + 1, OT_PAYLOAD_INDEX + 9)),
    [0x0b, 0xad, 0xf0, 0x0d, 0xf0, 0x0d, 0xba, 0xd0],
  );
});

test("feature replies normalize with or without the report id", () => {
  const withId = new Uint8Array(64);
  withId[1] = OT_COMTYPE.ack;
  assert.equal(otNormalizeFeatureReport(withId)[1], OT_COMTYPE.ack);
  const withoutId = new Uint8Array(63);
  withoutId[0] = OT_COMTYPE.ack;
  const normalized = otNormalizeFeatureReport(withoutId);
  assert.equal(normalized.length, 64);
  assert.equal(normalized[1], OT_COMTYPE.ack);
});

test("each OT device lists its exposed features", () => {
  const base = [
    "profiles", "dpi-stages", "polling-rate", "lift-off-distance",
    "angle-snapping", "ripple-control", "slamclick-filter", "motion-sync",
    "sensitivity", "acceleration", "jitter-correction", "led-stages",
    "button-mapping", "battery-telemetry", "firmware-query",
    "firmware-flash", "firmware-reset",
  ];
  assert.deepEqual(otExposedFeatures(OT_DEVICE_PROFILES.get(0x1903)!), base);
  assert.deepEqual(otExposedFeatures(OT_DEVICE_PROFILES.get(0x1906)!), base);
  assert.deepEqual(otExposedFeatures(OT_DEVICE_PROFILES.get(0x1905)!), [...base, "rgb-effect"]);
});
