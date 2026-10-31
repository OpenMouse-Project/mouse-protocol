import assert from "node:assert/strict";
import test from "node:test";

import {
  LEOBOG_GM3_BUTTON_TABLE_LENGTH,
  LEOBOG_GM3_DEBOUNCE_OPTIONS,
  LEOBOG_GM3_DPI_MAX,
  LEOBOG_GM3_DPI_MIN,
  LEOBOG_GM3_LINK_REPORT_ID,
  LEOBOG_GM3_ONBOARD_LENGTH,
  LEOBOG_GM3_POLLING_RATES,
  LEOBOG_GM3_POWER_REPORT_ID,
  LEOBOG_GM3_PRODUCTS,
  LEOBOG_GM3_RECEIVER_PRODUCT_ID,
  LEOBOG_GM3_WIRED_PRODUCT_ID,
  leobogGm3BuildConfigReadRequest,
  leobogGm3BuildConfigWriteRequest,
  leobogGm3BuildButtonRequest,
  leobogGm3BuildLinkRequest,
  leobogGm3BuildPowerRequest,
  leobogGm3DecodeOnboard,
  leobogGm3IsDpiValue,
  leobogGm3ParseConfig,
  leobogGm3ParseLink,
  leobogGm3ParsePower,
  leobogGm3WithActiveStage,
  leobogGm3WithDebounce,
  leobogGm3WithDpiStage,
  leobogGm3WithPollingRate,
  leobogGm3WithSleepMinutes,
  leobogGm3WithStageCount,
} from "@openmouse/protocol/leobog";

const bytes = (text: string): Uint8Array =>
  Uint8Array.from(text.replace(/\s+/g, "").match(/../g)!.map((byte) => parseInt(byte, 16)));

test("builds the captured GM3 battery request", () => {
  const request = leobogGm3BuildPowerRequest();

  assert.equal(request.length, 520);
  assert.deepEqual([...request.subarray(0, 8)], [0x09, 0x0c, 0x09, 0x01, 0x01, 0x00, 0x01, 0x00]);
  assert.ok(request.subarray(8).every((byte) => byte === 0));
  assert.equal(LEOBOG_GM3_POWER_REPORT_ID, 0x09);
});

test("decodes the hardware-confirmed 100 percent answer", () => {
  const response = bytes(
    "09 0C 09 01 01 00 01 00 64 00 00 00 00 00 00 00 " +
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
  );

  assert.equal(leobogGm3ParsePower(response), 100);
  assert.equal(leobogGm3ParsePower(response.subarray(1)), 100);
});

test("rejects mismatched, truncated and out-of-range answers", () => {
  assert.equal(leobogGm3ParsePower(bytes("09 0C 08 01 01 00 01 00 64")), null);
  assert.equal(leobogGm3ParsePower(bytes("09 0C 09 01 01 00 01")), null);
  assert.equal(leobogGm3ParsePower(bytes("09 0C 09 01 01 00 01 00 65")), null);
});

test("builds the link request captured from the vendor app", () => {
  const request = leobogGm3BuildLinkRequest();

  assert.equal(request.length, 520);
  assert.deepEqual([...request.subarray(0, 8)], [0x09, 0x09, 0x07, 0x00, 0x01, 0x00, 0x01, 0x00]);
  assert.equal(LEOBOG_GM3_LINK_REPORT_ID, 0x09);
});

test("decodes the link flag and rejects anything that is not 0 or 1", () => {
  // Awake: the vendor application read exactly this while the mouse answered.
  assert.equal(leobogGm3ParseLink(bytes("09 09 07 00 01 00 01 00 01")), true);
  // Asleep: the same query answered 0 while the config reads timed out.
  assert.equal(leobogGm3ParseLink(bytes("09 09 07 00 01 00 01 00 00")), false);
  assert.equal(leobogGm3ParseLink(bytes("09 09 07 00 01 00 01 00 02")), null);
  assert.equal(leobogGm3ParseLink(bytes("09 09 08 00 01 00 01 00 01")), null);
  assert.equal(leobogGm3ParseLink(bytes("09 09 07 00 01 00 01")), null);
  assert.equal(leobogGm3ParseLink(bytes("09 09 07 00 01 00 01 00 01").subarray(1)), true);
});

test("catalog marks both hardware-exercised connection paths verified", () => {
  assert.equal(LEOBOG_GM3_WIRED_PRODUCT_ID, 0x0136);
  assert.equal(LEOBOG_GM3_RECEIVER_PRODUCT_ID, 0x0138);
  // The cable path was verified 2026-10-25: `44 00` answers and `04 00`
  // applies once the write follows the read reply by the vendor's ~60 ms.
  assert.equal(LEOBOG_GM3_PRODUCTS.get(LEOBOG_GM3_WIRED_PRODUCT_ID)?.verified, true);
  assert.equal(LEOBOG_GM3_PRODUCTS.get(LEOBOG_GM3_RECEIVER_PRODUCT_ID)?.verified, true);
});

/**
 * The 400-byte block the 258a:0138 receiver answered to `44 00` on
 * 2026-10-24, after every experiment had been restored. Trailing zero bytes
 * are re-added because the capture helper trims them.
 */
const CAPTURED_ONBOARD = (() => {
  const raw = bytes(
    "64 18 04 16 00 01 00 07 00 09 00 0F 00 2F 00 47 00 77 00 00 00 00 00 00 00 00 00 07 " +
    "00 09 00 0F 00 2F 00 47 00 77 00 00 00 00 00 00 00 00 00 FF 00 00 00 FF 00 00 00 FF " +
    "FF 00 FF FF FF 00 00 FF FF 00 00 00 00 00 00 00 00 00 05 00 5B 00 44 01 FF 00 00 00 " +
    "FF 00 00 00 FF FF FF 00 00 FF FF FF 00 FF FF FF FF FF FF FF 44 01 FF 00 00 00 FF 00 " +
    "00 00 FF FF FF 00 00 FF FF FF 00 FF FF FF FF FF FF FF 44 01 FF 00 FF FF 00 00 FF 40 " +
    "00 FF FF 00 00 FF 00 00 FF FF FF 00 FF FF FF FF 44 07 00 00 FF FF 00 00 FF 40 00 00 " +
    "FF 00 FF FF 00 00 FF FF FF 00 FF FF FF FF 44 01 FF 00 00 FF 40 00 FF FF 00 00 FF 00 " +
    "00 FF FF 00 00 FF FF 00 FF FF FF FF 44 01 FF 00 00 FF 40 00 FF FF 00 00 FF 00 00 FF " +
    "FF 00 00 FF FF 00 FF FF FF FF 44 01 00 00 FF FF 00 00 00 FF 00 00 FF FF FF 00 FF FF " +
    "40 00 FF FF 00 FF FF FF 44 01 FF 00 00 FF 40 00 FF FF 00 00 FF 00 00 FF FF 00 00 FF " +
    "FF 00 FF FF FF FF 44 01 FF 00 00 FF 40 00 FF FF 00 00 FF 00 00 FF FF 00 00 FF FF 00 " +
    "FF FF FF FF 44 01 FF 00 00 FF 40 00 FF FF 00 00 FF 00 00 FF FF 00 00 FF FF 00 FF FF " +
    "FF FF 44 01 FF 00 00 FF 40 00 FF FF 00 00 FF 00 00 FF FF 00 00 FF FF 00 FF FF FF FF",
  );
  const payload = new Uint8Array(LEOBOG_GM3_ONBOARD_LENGTH);
  payload.set(raw);
  return payload;
})();

test("decodes the captured onboard block", () => {
  const config = leobogGm3DecodeOnboard(CAPTURED_ONBOARD);

  assert.deepEqual(config, {
    stageCount: 6,
    activeStage: 0,
    dpiStages: [800, 1000, 1600, 4800, 7200, 12000],
    pollingRateHz: 1000,
    debounceMs: 2,
    sleepMinutes: 5,
    reportedBatteryPercent: 91,
  });
  assert.deepEqual(LEOBOG_GM3_POLLING_RATES, [125, 250, 500, 1000]);
  assert.deepEqual(LEOBOG_GM3_DEBOUNCE_OPTIONS, [2, 4, 6, 8, 10, 12]);
});

test("rejects a block whose fields are outside the vendor's range", () => {
  assert.equal(leobogGm3DecodeOnboard(CAPTURED_ONBOARD.slice(0, 200)), null);

  const noStages = CAPTURED_ONBOARD.slice();
  noStages[3] = 0x00;
  assert.equal(leobogGm3DecodeOnboard(noStages), null);

  const stageOutOfRange = CAPTURED_ONBOARD.slice();
  stageOutOfRange[3] = 0x75; // active stage 7 of a 5-stage cycle
  assert.equal(leobogGm3DecodeOnboard(stageOutOfRange), null);

  const badPolling = CAPTURED_ONBOARD.slice();
  badPolling[2] = 0;
  assert.equal(leobogGm3DecodeOnboard(badPolling), null);

  const badDebounce = CAPTURED_ONBOARD.slice();
  badDebounce[5] = 7;
  assert.equal(leobogGm3DecodeOnboard(badDebounce), null);

  const sillySleep = CAPTURED_ONBOARD.slice();
  sillySleep[0x4a] = 121;
  assert.equal(leobogGm3DecodeOnboard(sillySleep), null);

  const stageTooHigh = CAPTURED_ONBOARD.slice();
  stageTooHigh[7 + 2 * 2] = 0xff; // stage 2 reads 6,553,500 DPI
  stageTooHigh[7 + 2 * 2 + 1] = 0xff;
  assert.equal(leobogGm3DecodeOnboard(stageTooHigh), null);
});

test("writes one DPI stage into both tables and nothing else", () => {
  const next = leobogGm3WithDpiStage(CAPTURED_ONBOARD, 1, 1100);

  assert.notEqual(next, CAPTURED_ONBOARD);
  assert.deepEqual([...next.subarray(9, 11)], [10, 0]);
  assert.deepEqual([...next.subarray(29, 31)], [10, 0]);
  const different = [...next].flatMap((byte, index) => (byte === CAPTURED_ONBOARD[index] ? [] : [index]));
  assert.deepEqual(different, [9, 29]);
  assert.equal(leobogGm3DecodeOnboard(next)?.dpiStages[1], 1100);
});

test("moves the active stage without touching the DPI table", () => {
  const next = leobogGm3WithActiveStage(CAPTURED_ONBOARD, 4);

  assert.equal(next[3], 0x56);
  const different = [...next].flatMap((byte, index) => (byte === CAPTURED_ONBOARD[index] ? [] : [index]));
  assert.deepEqual(different, [3]);
  assert.equal(leobogGm3DecodeOnboard(next)?.activeStage, 4);
});

test("encodes the polling rate and the debounce step", () => {
  const slower = leobogGm3WithPollingRate(CAPTURED_ONBOARD, 500);
  assert.equal(slower[2], 3);
  assert.equal(leobogGm3DecodeOnboard(slower)?.pollingRateHz, 500);

  const slowerStill = leobogGm3WithPollingRate(CAPTURED_ONBOARD, 125);
  assert.equal(slowerStill[2], 1);

  const sluggish = leobogGm3WithDebounce(CAPTURED_ONBOARD, 12);
  assert.equal(sluggish[5], 6);
  assert.equal(leobogGm3DecodeOnboard(sluggish)?.debounceMs, 12);

  assert.throws(() => leobogGm3WithPollingRate(CAPTURED_ONBOARD, 2000), /does not support 2000 Hz/);
  assert.throws(() => leobogGm3WithDebounce(CAPTURED_ONBOARD, 3), /does not support 3 ms/);
});

test("shrinking the stage count blanks the trailing entries the vendor way", () => {
  const five = leobogGm3WithStageCount(CAPTURED_ONBOARD, 5);

  assert.equal(five[3], 0x15);
  assert.deepEqual([...five.subarray(17, 19)], [0, 0]);
  assert.deepEqual([...five.subarray(37, 39)], [0, 0]);
  const config = leobogGm3DecodeOnboard(five);
  assert.equal(config?.stageCount, 5);
  assert.equal(config?.dpiStages[4], 7200);

  const six = leobogGm3WithStageCount(five, 6);
  assert.equal(six[3], 0x16);
  assert.deepEqual([...six.subarray(17, 19)], [0x47, 0x00]);
  assert.equal(leobogGm3DecodeOnboard(six)?.dpiStages[5], 7200);

  assert.throws(() => leobogGm3WithStageCount(CAPTURED_ONBOARD, 0), /out of range/);
  assert.throws(() => leobogGm3WithStageCount(CAPTURED_ONBOARD, 7), /out of range/);
});

test("an enabled stage holding the 100 DPI floor survives a count change", () => {
  // The vendor blanks a disabled stage to 100 DPI, which is also a value the
  // user can pick, so only stages that were already disabled may be refilled.
  const floored = leobogGm3WithDpiStage(leobogGm3WithStageCount(CAPTURED_ONBOARD, 4), 2, LEOBOG_GM3_DPI_MIN);
  const grown = leobogGm3WithStageCount(floored, 6);

  assert.equal(leobogGm3DecodeOnboard(grown)?.dpiStages[2], LEOBOG_GM3_DPI_MIN);
  // Stages 4 and 5 were disabled before the change, so they take the fill value.
  assert.equal(leobogGm3DecodeOnboard(grown)?.dpiStages[5], 4800);
});

test("validates DPI values the block can encode", () => {
  assert.equal(LEOBOG_GM3_DPI_MIN, 100);
  assert.equal(LEOBOG_GM3_DPI_MAX, 24000);
  assert.equal(leobogGm3IsDpiValue(100), true);
  assert.equal(leobogGm3IsDpiValue(8700), true);
  assert.equal(leobogGm3IsDpiValue(24000), true);
  assert.equal(leobogGm3IsDpiValue(50), false);
  assert.equal(leobogGm3IsDpiValue(1050), false);
  assert.equal(leobogGm3IsDpiValue(24100), false);
  assert.throws(() => leobogGm3WithDpiStage(CAPTURED_ONBOARD, 6, 800), /stage out of range/);
  assert.throws(() => leobogGm3WithDpiStage(CAPTURED_ONBOARD, 0, 1050), /DPI out of range/);
});

test("encodes the auto-sleep idle time and its off switch", () => {
  const twenty = leobogGm3WithSleepMinutes(CAPTURED_ONBOARD, 20);
  assert.equal(twenty[0x4a], 20);
  assert.equal(leobogGm3DecodeOnboard(twenty)?.sleepMinutes, 20);

  // 0 is what the vendor's on/off switch writes when auto-sleep is disabled.
  const off = leobogGm3WithSleepMinutes(CAPTURED_ONBOARD, 0);
  assert.equal(off[0x4a], 0);
  assert.equal(leobogGm3DecodeOnboard(off)?.sleepMinutes, 0);

  const different = [...twenty].flatMap((byte, index) => (byte === CAPTURED_ONBOARD[index] ? [] : [index]));
  assert.deepEqual(different, [0x4a]);

  assert.throws(() => leobogGm3WithSleepMinutes(CAPTURED_ONBOARD, 21), /off \(0\) or 1-20 whole minutes/);
  assert.throws(() => leobogGm3WithSleepMinutes(CAPTURED_ONBOARD, 1.5), /whole minutes/);
});

test("builds the captured configuration frames", () => {
  const read = leobogGm3BuildConfigReadRequest();
  assert.equal(read.length, 520);
  assert.deepEqual([...read.subarray(0, 8)], [0x09, 0xd6, 0x44, 0x00, 0x01, 0x00, 0x90, 0x01]);
  assert.ok(read.subarray(8).every((byte) => byte === 0));

  const write = leobogGm3BuildConfigWriteRequest(CAPTURED_ONBOARD);
  assert.deepEqual([...write.subarray(0, 8)], [0x09, 0x45, 0x04, 0x00, 0x01, 0x00, 0x90, 0x01]);
  assert.deepEqual(
    [...write.subarray(8, 8 + LEOBOG_GM3_ONBOARD_LENGTH)],
    [...CAPTURED_ONBOARD],
  );
  assert.throws(() => leobogGm3BuildConfigWriteRequest(new Uint8Array(10)), /must be 400 bytes/);
});

test("parses the configuration payload out of a reply", () => {
  const reply = new Uint8Array(520);
  reply[0] = 0x09;
  reply[2] = 0x44;
  reply.set(CAPTURED_ONBOARD, 8);

  assert.deepEqual([...leobogGm3ParseConfig(reply)!], [...CAPTURED_ONBOARD]);
  assert.deepEqual([...leobogGm3ParseConfig(reply.subarray(1))!], [...CAPTURED_ONBOARD]);
  assert.equal(leobogGm3ParseConfig(reply.slice(0, 400)), null);

  const wrongCommand = reply.slice();
  wrongCommand[2] = 0x43;
  assert.equal(leobogGm3ParseConfig(wrongCommand), null);
});

test("frames the button table as vendor command 01 00", () => {
  const table = new Uint8Array(LEOBOG_GM3_BUTTON_TABLE_LENGTH);
  table.set([0x05, 0x04, 0x00, 0x00], 20);
  const request = leobogGm3BuildButtonRequest(table);

  assert.equal(request.length, 520);
  assert.equal(request[0], 0x09);
  assert.equal(request[2], 0x01);
  assert.equal(request[3], 0x00);
  assert.equal(request[4], 0x01);
  assert.equal(request[6] | (request[7] << 8), LEOBOG_GM3_BUTTON_TABLE_LENGTH);
  assert.deepEqual([...request.subarray(8, 8 + LEOBOG_GM3_BUTTON_TABLE_LENGTH)], [...table]);
  assert.equal(
    request[1],
    request.subarray(2).reduce((sum, byte) => sum + byte, 0) & 0xff,
  );
  assert.throws(
    () => leobogGm3BuildButtonRequest(new Uint8Array(20)),
    /must be 80 bytes/,
  );
});
