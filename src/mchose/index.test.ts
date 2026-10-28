import assert from "node:assert/strict";
import test from "node:test";
import {
  MCHOSE_COMMAND,
  MCHOSE_LONG_REPORT_ID,
  MCHOSE_LONG_TOKENS,
  MCHOSE_SHORT_TOKENS,
  mchoseDecodeBattery,
  mchoseDecodeConfig,
  mchoseDecodeIdentity,
  mchoseDecodeReply,
  mchoseDecodeVersion,
  mchoseEncodeCommand,
  mchoseEncodeConfigWrite,
  mchoseFindProduct,
  mchosePackLinkByte,
  MCHOSE_POLLING_RATES,
  MCHOSE_PROFILE_COUNT,
  mchoseEncodeSetProfile,
  mchoseDecodeLiftOffIndex,
  mchoseDecodeProcessing,
  mchoseDecodeMode,
  mchoseModeName,
  mchoseModeNumber,
  mchoseDecodeAngleTuning,
  mchoseEncodeAngleTuning,
  mchoseEncodePerformance,
  mchoseEncodeLiftOff,
  mchoseLiftOffLabels,
  mchosePollingRates,
  MCHOSE_LINK_PRODUCT_IDS,
} from "./index.ts";

/**
 * Every byte string below was captured from a real MCHOSE A7 V2 Ultra+ on its
 * 2.4 GHz receiver (0x3837:0x100b), with mchose-research/dump.mjs. They are the
 * plain (already un-inverted) reply payloads.
 */
const bytes = (hex: string): Uint8Array =>
  new Uint8Array(hex.trim().split(/\s+/).map((b) => parseInt(b, 16)));

const IDENTITY = bytes("01 37 38 0b 10 01 00");
const VERSION = bytes("08 35 2e 34 36 2e 32 2e 34");
const BATTERY = bytes("37 38 21 40 05 2e 02 04 09 29 00 2c");
const CONFIG = bytes("00 30 20 00 40 06 20 03 40 06 80 0c 00 19 10 a4 01 80 00 00");

test("commands are sent bit-inverted, with the rest of the report left zero", () => {
  const body = mchoseEncodeCommand([MCHOSE_COMMAND.battery], MCHOSE_SHORT_TOKENS);
  assert.equal(body.length, 64);
  assert.equal(body[0], 0xf9, "command 0x06 inverted");
  assert.equal(body[1], 0xff, "spelled zero argument inverted");
  assert.equal(body[MCHOSE_SHORT_TOKENS - 1], 0xff, "last spelled token still inverted");
  assert.equal(body[MCHOSE_SHORT_TOKENS], 0x00, "padding past the spelled tokens stays zero");
});

test("long commands invert all 64 tokens", () => {
  const body = mchoseEncodeCommand([MCHOSE_COMMAND.config], MCHOSE_LONG_TOKENS);
  assert.equal(body[0], 0x98, "command 0x67 inverted");
  assert.equal(body[63], 0xff);
});

test("a reply is un-inverted behind its report-id byte", () => {
  // [reportId, ~cmd, ~payload…]
  const raw = new Uint8Array([MCHOSE_LONG_REPORT_ID, 0x98, 0xff, 0xcf]);
  const reply = mchoseDecodeReply(raw);
  assert.ok(reply);
  assert.equal(reply.command, MCHOSE_COMMAND.config);
  assert.deepEqual([...reply.payload], [0x00, 0x30]);
});

test("mchoseDecodeReply rejects a truncated read", () => {
  assert.equal(mchoseDecodeReply(new Uint8Array([0x11, 0x98])), null);
});

test("identity decodes the receiver ids and link state", () => {
  const identity = mchoseDecodeIdentity(IDENTITY);
  assert.deepEqual(identity, {
    bonded: true,
    vendorId: 0x3837,
    productId: 0x100b,
    connected: true,
    gameMode: 0,
  });
});

test("version decodes the length-prefixed string the Ultra+ reports", () => {
  assert.equal(mchoseDecodeVersion(VERSION), "5.46.2.4");
});

test("version rejects a zero-length or truncated string", () => {
  assert.equal(mchoseDecodeVersion(new Uint8Array([0x00])), null);
  assert.equal(mchoseDecodeVersion(new Uint8Array([0x08, 0x35])), null);
});

test("battery reports the mouse's own id, not the receiver's", () => {
  const battery = mchoseDecodeBattery(BATTERY);
  assert.ok(battery);
  assert.equal(battery.vendorId, 0x3837);
  assert.equal(battery.productId, 0x4021, "the A7 V2 Ultra+ behind the 0x100b receiver");
  assert.equal(battery.batteryPercent, 41);
  assert.equal(battery.charging, false);
});

test("config decodes the DPI stage table past the reserved byte", () => {
  const config = mchoseDecodeConfig(CONFIG);
  assert.ok(config);
  assert.equal(config.profileIndex, 0);
  assert.deepEqual(config.dpiStages, [1600, 800, 1600, 3200, 6400, 42000]);
});

/**
 * The same mouse read at two known settings, which is what pins the nibble
 * order. Byte 1 is the wired link, byte 2 the wireless one; in each, the rate
 * is the high nibble and the DPI stage the low one.
 */
test("config splits the per-link index nibbles the way hardware does", () => {
  // Captured while the mouse was on its receiver at 1000 Hz and 1600 DPI.
  const config = mchoseDecodeConfig(CONFIG);
  assert.ok(config);
  assert.equal(config.wirelessRateIndex, 2, "0x20 high nibble -> rate index 2");
  assert.equal(config.wirelessDpiIndex, 0, "0x20 low nibble -> stage 0");
  assert.equal(config.wiredRateIndex, 3, "0x30 high nibble");
  assert.equal(config.wiredDpiIndex, 0);
});

test("the wireless indices agree with the settings the device was set to", () => {
  const config = mchoseDecodeConfig(CONFIG);
  assert.ok(config);
  const rates = MCHOSE_POLLING_RATES[8000]!;
  assert.equal(rates[config.wirelessRateIndex], 1000, "the mouse was set to 1000 Hz");
  assert.equal(config.dpiStages[config.wirelessDpiIndex], 1600, "and to 1600 DPI");
});

test("the earlier 125 Hz capture decodes to rate index 0", () => {
  // Same mouse before the polling rate was changed: wireless byte 0x00.
  const at125 = Uint8Array.from(CONFIG);
  at125[2] = 0x00;
  const config = mchoseDecodeConfig(at125);
  assert.ok(config);
  assert.equal(config.wirelessRateIndex, 0);
  assert.equal(MCHOSE_POLLING_RATES[8000]![config.wirelessRateIndex], 125);
});

test("config rejects a payload too short to hold the stage table", () => {
  assert.equal(mchoseDecodeConfig(CONFIG.subarray(0, 12)), null);
});

test("the mouse id identifies the model, since host PIDs are shared", () => {
  assert.equal(mchoseFindProduct(0x4021)?.name, "A7 V2 Ultra+");
  assert.equal(mchoseFindProduct(0x4019)?.name, "A7 V2 Ultra");
  assert.equal(mchoseFindProduct(0x4018)?.dpiMax, 26000);
});

test("the product string disambiguates when the mouse id is unknown", () => {
  assert.equal(mchoseFindProduct(null, "MCHOSE A7 V2 Ultra+")?.name, "A7 V2 Ultra+");
  // The plus model must not be swallowed by the shorter name.
  assert.equal(mchoseFindProduct(null, "MCHOSE A7 V2 Ultra")?.name, "A7 V2 Ultra");
  assert.equal(mchoseFindProduct(null, "MCHOSE A7 Ultra")?.name, "A7 Ultra");
  assert.equal(mchoseFindProduct(null, "Some Other Mouse"), null);
  assert.equal(mchoseFindProduct(null, null), null);
});

test("a config write echoes every byte it is not changing", () => {
  const tokens = mchoseEncodeConfigWrite(CONFIG, { wirelessRateIndex: 1 });
  assert.equal(tokens[0], MCHOSE_COMMAND.writeConfig, "0x57 leads the write");
  // The command byte shifts everything by one; only the wireless byte moved.
  assert.equal(tokens[1 + 2], 0x10, "rate index 1, stage 0 preserved");
  assert.equal(tokens[1 + 1], CONFIG[1], "the wired byte is untouched");
  for (let index = 3; index < CONFIG.length; index += 1) {
    assert.equal(tokens[1 + index], CONFIG[index], `byte ${index} echoed unchanged`);
  }
});

test("a stage rewrite keeps the other five stages intact", () => {
  const stages = [1600, 800, 1600, 3200, 6400, 42000];
  stages[1] = 12000;
  const tokens = mchoseEncodeConfigWrite(CONFIG, { dpiStages: stages });
  // Stage 1 lives at payload offset 6-7, so offset 7-8 once shifted.
  assert.equal(tokens[1 + 6], 12000 & 0xff);
  assert.equal(tokens[1 + 7], (12000 >> 8) & 0xff);
  assert.equal(tokens[1 + 4], 0x40, "stage 0 low byte unchanged");
  assert.equal(tokens[1 + 14], 0x10, "stage 5 low byte unchanged");
});

test("packing a link byte is the inverse of decoding it", () => {
  assert.equal(mchosePackLinkByte(2, 0), 0x20);
  assert.equal(mchosePackLinkByte(3, 0), 0x30);
  const round = mchoseDecodeConfig(CONFIG)!;
  assert.equal(mchosePackLinkByte(round.wirelessRateIndex, round.wirelessDpiIndex), CONFIG[2]);
  assert.equal(mchosePackLinkByte(round.wiredRateIndex, round.wiredDpiIndex), CONFIG[1]);
});

test("a write refuses a payload it cannot decode", () => {
  assert.throws(() => mchoseEncodeConfigWrite(CONFIG.subarray(0, 8)));
});

test("the profile command carries a 0-based index", () => {
  assert.deepEqual(mchoseEncodeSetProfile(0), [MCHOSE_COMMAND.setProfile, 0]);
  assert.deepEqual(mchoseEncodeSetProfile(2), [MCHOSE_COMMAND.setProfile, 2]);
});

test("the profile command refuses an index the mouse does not have", () => {
  assert.throws(() => mchoseEncodeSetProfile(-1), /0-2/);
  assert.throws(() => mchoseEncodeSetProfile(MCHOSE_PROFILE_COUNT), /0-2/);
  assert.throws(() => mchoseEncodeSetProfile(1.5), /0-2/);
});

test("each profile carries its own link settings", () => {
  // Profiles 0 and 2 as captured from the same mouse, one after the other.
  const profile0 = mchoseDecodeConfig(bytes("00 30 30 00 40 06 20 03 40 06 80 0c 00 19 10 a4 01 80 00 00"))!;
  const profile2 = mchoseDecodeConfig(bytes("02 32 22 00 40 06 20 03 40 06 80 0c 00 19 10 a4 01 80 00 00"))!;
  assert.equal(profile0.profileIndex, 0);
  assert.equal(profile2.profileIndex, 2);
  const rates = MCHOSE_POLLING_RATES[8000]!;
  assert.equal(rates[profile0.wirelessRateIndex], 2000);
  assert.equal(rates[profile2.wirelessRateIndex], 1000);
  assert.equal(profile0.dpiStages[profile0.wirelessDpiIndex], 1600);
  assert.equal(profile2.dpiStages[profile2.wirelessDpiIndex], 1600);
});

test("lift-off decodes out of the low bits of the sensor byte", () => {
  // Captured: sensor 0x80 at the lowest step, 0x81 and 0x82 after writing 1/2.
  assert.equal(mchoseDecodeLiftOffIndex(0x80), 0);
  assert.equal(mchoseDecodeLiftOffIndex(0x81), 1);
  assert.equal(mchoseDecodeLiftOffIndex(0x82), 2);
  assert.equal(mchoseDecodeConfig(CONFIG)!.liftOffIndex, 0);
});

test("the sensor byte's upper bits are not part of lift-off", () => {
  const raised = Uint8Array.from(CONFIG);
  raised[17] = 0x82;
  const config = mchoseDecodeConfig(raised)!;
  assert.equal(config.liftOffIndex, 2);
  assert.equal(config.sensor, 0x82, "the whole byte is still exposed for writers to preserve");
});

test("the lift-off write leaves the performance toggles at zero", () => {
  // [command, lod, ripple, line, motionSync, _, _, gameMode, rotateOpen,
  // rotateVal] — every zero means "leave this one alone".
  assert.deepEqual(
    mchoseEncodeLiftOff(2),
    [MCHOSE_COMMAND.setPerformance, 2, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  const encoded = mchoseEncodeCommand(mchoseEncodeLiftOff(2), MCHOSE_SHORT_TOKENS);
  assert.equal(encoded[0], (~MCHOSE_COMMAND.setPerformance) & 0xff);
  assert.equal(encoded[1], (~2) & 0xff);
  assert.equal(encoded[2], 0xff, "ripple left untouched");
  assert.equal(encoded[4], 0xff, "motion sync left untouched");
  assert.equal(encoded[7], 0xff, "game mode left untouched");
  assert.equal(encoded[8], 0xff, "angle tuning not applied");
});

test("the sensor byte carries the processing toggles alongside lift-off", () => {
  // Mapped on hardware: 0x80 -> 0x90 -> 0x94 -> 0x9c as each was switched on.
  assert.deepEqual(mchoseDecodeProcessing(0x00), {
    angleSnapping: false, rippleControl: false, motionSync: false,
  });
  assert.equal(mchoseDecodeProcessing(0x90).motionSync, true);
  assert.equal(mchoseDecodeProcessing(0x94).rippleControl, true);
  assert.equal(mchoseDecodeProcessing(0x9c).angleSnapping, true);
});

test("bits 6-7 are a three-way mode, not a boolean", () => {
  // Written on hardware as field values 1, 2 and 3 in turn.
  assert.equal(mchoseModeName(0x00), "Performance");
  assert.equal(mchoseModeName(0x80), "eSports");
  assert.equal(mchoseModeName(0xc0), "Ultra");
  // The stored pattern is the mode number, except Performance stores 0.
  assert.equal(mchoseDecodeMode(0x00), 1);
  assert.equal(mchoseDecodeMode(0x80), 2);
  assert.equal(mchoseDecodeMode(0xc0), 3);
  // The mode must not bleed into lift-off or the toggles.
  assert.equal(mchoseDecodeLiftOffIndex(0xc2), 2);
  assert.equal(mchoseDecodeProcessing(0xc0).motionSync, false);
});

test("mode names round-trip to the numbers the firmware wants", () => {
  assert.equal(mchoseModeNumber("Performance"), 1);
  assert.equal(mchoseModeNumber("eSports"), 2);
  assert.equal(mchoseModeNumber("Ultra"), 3);
  assert.equal(mchoseModeNumber("Turbo"), null);
  assert.deepEqual(mchoseEncodePerformance(0, { mode: 3 })[7], 3);
  assert.equal(mchoseEncodePerformance(0, {})[7], 0, "untouched when not named");
  assert.throws(() => mchoseEncodePerformance(0, { mode: 4 }), /1-3/);
});

test("angle tuning is signed, spanning the -30 to +30 the vendor offers", () => {
  assert.equal(mchoseEncodeAngleTuning(15), 0x0f);
  assert.equal(mchoseEncodeAngleTuning(-15), 0xf1, "two's complement");
  assert.equal(mchoseDecodeAngleTuning(0xf1), -15);
  assert.equal(mchoseDecodeAngleTuning(0x0f), 15);
  assert.equal(mchoseDecodeAngleTuning(0), 0);
  assert.throws(() => mchoseEncodePerformance(0, { angleTuning: 31 }), /-30 to 30/);
  assert.throws(() => mchoseEncodePerformance(0, { angleTuning: -31 }), /-30 to 30/);
  assert.equal(mchoseEncodePerformance(0, { angleTuning: -15 })[9], 0xf1);
});

test("ripple's bit is not mistaken for part of the lift-off level", () => {
  // 0x84 is lift-off 0 with ripple on; a three-bit mask would read level 4.
  assert.equal(mchoseDecodeLiftOffIndex(0x84), 0);
  assert.equal(mchoseDecodeProcessing(0x84).rippleControl, true);
  assert.equal(mchoseDecodeLiftOffIndex(0x9e), 2, "level 2 with every toggle on");
});

test("a toggle write carries lift-off and only the toggles named", () => {
  assert.deepEqual(
    mchoseEncodePerformance(1, { motionSync: true }),
    [MCHOSE_COMMAND.setPerformance, 1, 0, 0, 1, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    mchoseEncodePerformance(0, { rippleControl: false, angleSnapping: true }),
    [MCHOSE_COMMAND.setPerformance, 0, 2, 1, 0, 0, 0, 0, 0, 0],
  );
});

test("lift-off labels follow how many steps the model has", () => {
  assert.deepEqual(mchoseLiftOffLabels(3), ["Low", "Medium", "High"]);
  // The Pro and Pro+ only offer 1 mm and 2 mm.
  assert.deepEqual(mchoseLiftOffLabels(2), ["Low", "High"]);
});

test("the lift-off write refuses an index outside the field", () => {
  assert.throws(() => mchoseEncodeLiftOff(-1), /0-3/);
  assert.throws(() => mchoseEncodeLiftOff(4), /0-3/);
});

test("Bluetooth is capped at 1000 Hz even on an 8K model", () => {
  const ultraPlus = mchoseFindProduct(0x4021);
  assert.ok(ultraPlus);
  assert.deepEqual(
    mchosePollingRates(ultraPlus, MCHOSE_LINK_PRODUCT_IDS.receiver),
    [125, 500, 1000, 2000, 4000, 8000],
  );
  assert.deepEqual(
    mchosePollingRates(ultraPlus, MCHOSE_LINK_PRODUCT_IDS.bluetooth),
    [125, 500, 1000],
  );
});
