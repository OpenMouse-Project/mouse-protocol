import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOODY_POLLING_RATES,
  BLOODY_PRODUCT_IDS,
  BLOODY_REPORT_ID,
  BLOODY_REPORT_SIZE,
  BLOODY_VENDOR_ID,
  BLOODY_W70_MAX_ALT_PRODUCT_ID,
  BLOODY_W70_MAX_PRODUCT_ID,
  bloodyBuildBacklightQuery,
  bloodyBuildDeviceQuery,
  bloodyBuildFlashChunk,
  bloodyBuildFlashMagicCommit,
  bloodyBuildFlashReset,
  bloodyBuildFlashSector,
  bloodyDecodeFlashSector,
  bloodyBuildFlashUnlock,
  bloodyBuildPollingQuery,
  bloodyBuildSensitivityQuery,
  bloodyBuildSensitivitySet,
  bloodyBuildSetBacklight,
  bloodyBuildSetDpi,
  bloodyDpiToRawStep,
  bloodyDecodeBacklight,
  bloodyDecodeDeviceStatus,
  bloodyDecodePollingRate,
  bloodyDecodeSensitivity,
  bloodyGetDpiOptions,
  bloodyHzToPollingCode,
  bloodyPollingCodeToHz,
} from "./index.ts";

test("Bloody constants are defined correctly", () => {
  assert.equal(BLOODY_VENDOR_ID, 0x09da);
  assert.equal(BLOODY_W70_MAX_PRODUCT_ID, 0x1865);
  assert.equal(BLOODY_W70_MAX_ALT_PRODUCT_ID, 0x79ef);
  assert.deepEqual(BLOODY_PRODUCT_IDS, [0x1865, 0x79ef]);
  assert.equal(BLOODY_REPORT_ID, 0x07);
  assert.equal(BLOODY_REPORT_SIZE, 63);
  assert.deepEqual(BLOODY_POLLING_RATES, [125, 250, 500, 1000]);
});

test("bloodyPollingCodeToHz and bloodyHzToPollingCode round-trip correctly", () => {
  assert.equal(bloodyPollingCodeToHz(0x01), 1000);
  assert.equal(bloodyPollingCodeToHz(0x02), 500);
  assert.equal(bloodyPollingCodeToHz(0x04), 250);
  assert.equal(bloodyPollingCodeToHz(0x08), 125);
  assert.equal(bloodyPollingCodeToHz(0xff), null);

  assert.equal(bloodyHzToPollingCode(1000), 0x01);
  assert.equal(bloodyHzToPollingCode(500), 0x02);
  assert.equal(bloodyHzToPollingCode(250), 0x04);
  assert.equal(bloodyHzToPollingCode(125), 0x08);
});

test("query report builders produce 63-byte buffers with correct command headers", () => {
  const sens = bloodyBuildSensitivityQuery();
  assert.equal(sens.length, 63);
  assert.equal(sens[0], 0x02);
  assert.equal(sens[2], 0x2a);
  assert.equal(sens[4], 0x60);

  const poll = bloodyBuildPollingQuery();
  assert.equal(poll.length, 63);
  assert.equal(poll[0], 0x0e);

  const dev = bloodyBuildDeviceQuery();
  assert.equal(dev.length, 63);
  assert.equal(dev[0], 0x05);

  const back = bloodyBuildBacklightQuery();
  assert.equal(back.length, 63);
  assert.equal(back[0], 0x11);
});

test("bloodyBuildSetBacklight produces valid command buffer", () => {
  const cmd = bloodyBuildSetBacklight(3);
  assert.equal(cmd.length, 63);
  assert.equal(cmd[0], 0x11);
  assert.equal(cmd[3], 0x80);
  assert.equal(cmd[7], 0x03);

  const cmdOff = bloodyBuildSetBacklight(0);
  assert.equal(cmdOff[7], 0x00);
});

test("bloodyBuildSetDpi encodes target DPI step and polling code", () => {
  const cmd = bloodyBuildSetDpi(1600, 1, 5, 1000);
  assert.equal(cmd.length, 63);
  assert.equal(cmd[0], 0x0d);
  assert.equal(cmd[7], 4); // 5 stages - 1
  assert.equal(cmd[8], 1); // active stage 1
  assert.equal(cmd[9], 0x40);
  assert.equal(cmd[10], 0x40);
  assert.equal(cmd[11], 0x24); // bloodyDpiToRawStep(1600) = 0x24
  assert.equal(cmd[12], 0x01); // 1000 Hz
});

test("bloodyDecodeDeviceStatus decodes 0x05 state query reply", () => {
  const hex = "07050000000000000401e80300e000e29cfe0000c0ff0000000060ffe33f3847f0";
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const status = bloodyDecodeDeviceStatus(bytes);
  assert.ok(status !== null);
  assert.equal(status.dpi, 1000);
  assert.equal(status.activeStage, 1);
  assert.equal(status.modesEnabled, 5);
});

test("bloodyBuildSensitivitySet creates valid 0x02 flash command", () => {
  const cmd = bloodyBuildSensitivitySet([800, 1600], 0);
  assert.equal(cmd.length, 63);
  assert.equal(cmd[0], 0x02);
  assert.equal(cmd[7], 0xff);
  assert.equal(cmd[8], 0xff);
  assert.equal(cmd[15], 1); // 2 stages - 1
  assert.equal(cmd[17], 0); // stage 0 active

  // Stage 0: 800 DPI -> step 18 (0x12), dpiStep 16 (0x10)
  assert.equal(cmd[19], 18);
  assert.equal(cmd[20], 16);
  assert.equal(cmd[21], 18);
  assert.equal(cmd[22], 16);

  // Stage 1: 1600 DPI -> step 36 (0x24), dpiStep 32
  assert.equal(cmd[25], 36);
  assert.equal(cmd[26], 32);
});

test("bloodyDecodeSensitivity decodes live capture from hardware accurately", () => {
  // Capture from data.txt line 83: 1000 [2000] 3000 4000 5000 (stage 1 active)
  const hex = "0702002a00600000a4a4915be9460000040001001614161400002e282e280000453c453c00005c505c5000007364736400000000000000000000000000000000";
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));

  const decoded = bloodyDecodeSensitivity(bytes);
  assert.ok(decoded !== null);
  assert.equal(decoded.totalStages, 5);
  assert.equal(decoded.activeStageIndex, 1);
  assert.deepEqual(decoded.stages, [1000, 2000, 3000, 4000, 5000]);
  assert.equal(decoded.currentDpi, 2000);
});

test("bloodyDecodeSensitivity handles 72-byte payload without leading report ID", () => {
  const hex = "02002a00600000a4a4905be4460000040000001614161400002e282e280000453c453c00005c505c5000007364736400000000000000000000000000000000";
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));

  const decoded = bloodyDecodeSensitivity(bytes);
  assert.ok(decoded !== null);
  assert.equal(decoded.totalStages, 5);
  assert.equal(decoded.activeStageIndex, 0);
  assert.equal(decoded.currentDpi, 1000);
});

test("bloodyDecodeSensitivity rejects invalid packets", () => {
  assert.equal(bloodyDecodeSensitivity(new Uint8Array(20)), null);
  assert.equal(bloodyDecodeSensitivity(new Uint8Array(63)), null);
});

test("bloodyDecodePollingRate decodes polling packet correctly", () => {
  // Capture from data.txt line 285: 070e0000000000000064645a0000020100...
  const hex = "070e0000000000000064645a00000201000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));

  const rate = bloodyDecodePollingRate(bytes);
  assert.equal(rate, 1000);
});

test("bloodyDecodeBacklight decodes backlight packet correctly", () => {
  const buffer = new Uint8Array(63);
  buffer[0] = 0x11;
  buffer[7] = 2; // Level 2
  assert.equal(bloodyDecodeBacklight(buffer), 2);
});

test("bloodyGetDpiOptions generates valid 100-DPI steps up to 10,000", () => {
  const options = bloodyGetDpiOptions();
  assert.equal(options[0], 100);
  assert.equal(options[1], 200);
  assert.equal(options[options.length - 1], 10000);
});

test("bloodyBuildFlashUnlock creates valid unlock and lock commands", () => {
  const unlock = bloodyBuildFlashUnlock(true);
  assert.equal(unlock.length, 63);
  assert.equal(unlock[0], 0x20);
  assert.equal(unlock[6], 0x01);

  const lock = bloodyBuildFlashUnlock(false);
  assert.equal(lock.length, 63);
  assert.equal(lock[0], 0x20);
  assert.equal(lock[6], 0x00);
});

test("bloodyBuildFlashChunk formats 32-byte chunk with correct address and size headers", () => {
  const chunkData = new Uint8Array(32);
  chunkData[0] = 0xaa;
  chunkData[31] = 0xbb;

  const chunkPkt = bloodyBuildFlashChunk(0x20, chunkData, 0xe0);
  assert.equal(chunkPkt.length, 63);
  assert.equal(chunkPkt[0], 0x2f);
  assert.equal(chunkPkt[1], 0x01);
  assert.equal(chunkPkt[23], 0x08);
  assert.equal(chunkPkt[27], 0x20);
  assert.equal(chunkPkt[28], 0xe0);
  assert.equal(chunkPkt[31], 0xaa);
  assert.equal(chunkPkt[62], 0xbb);
});

test("bloodyBuildFlashMagicCommit creates magic commit report", () => {
  const magic = bloodyBuildFlashMagicCommit(0xe0);
  assert.equal(magic.length, 63);
  assert.equal(magic[0], 0x2f);
  assert.equal(magic[1], 0x01);
  assert.equal(magic[23], 0x01);
  assert.equal(magic[27], 0x00);
  assert.equal(magic[28], 0xe0);
  assert.equal(magic[31], 0xa4);
  assert.equal(magic[32], 0xa4);
  assert.equal(magic[33], 0xa4);
  assert.equal(magic[34], 0xa4);
});

test("bloodyBuildFlashReset produces reset notification packet", () => {
  const reset = bloodyBuildFlashReset();
  assert.equal(reset.length, 63);
  assert.equal(reset[0], 0x13);
  assert.equal(reset[3], 0x80);
  assert.equal(reset[7], 0x80);
});

function makeSector(): Uint8Array {
  const base = new Uint8Array(256);
  base.fill(0xee);
  base.set([0xff, 0xff, 0xff, 0xff, 0xd4, 0x92, 0x45, 0x97], 0);
  base[0x3c] = 0x77;
  base[0x48] = 0x99;
  return base;
}

test("bloodyBuildFlashSector patches only stage count and raw step bytes of the base sector", () => {
  const base = makeSector();
  const sector = bloodyBuildFlashSector([1000, 1200, 1600, 2000, 4000], 3, base);
  assert.equal(sector.length, 256);
  assert.notEqual(sector, base);

  // Stage count - 1 (3 stages - 1 = 2)
  assert.equal(sector[8], 2);
  // Raw steps live at offset 12 + i * 6 + 4
  assert.equal(sector[16], 0x16); // 1000
  assert.equal(sector[22], 0x1b); // 1200
  assert.equal(sector[28], 0x24); // 1600

  const patched = new Set([8, 16, 22, 28, 34, 40]);
  for (let i = 0; i < 256; i++) {
    if (!patched.has(i)) assert.equal(sector[i], base[i], `byte ${i} must be preserved`);
  }
});

test("bloodyBuildFlashSector refuses a missing or invalid base sector", () => {
  const stages = [1000, 1200, 1600, 2000, 4000];
  assert.throws(() => bloodyBuildFlashSector(stages, 5, undefined as unknown as Uint8Array), /refusing/);
  assert.throws(() => bloodyBuildFlashSector(stages, 5, new Uint8Array(256)), /refusing/);
  assert.throws(() => bloodyBuildFlashSector(stages, 5, makeSector().subarray(0, 128)), /refusing/);
});

test("bloodyDecodeFlashSector round-trips built sectors", () => {
  const stages = [800, 1600, 2400, 6400, 10000];
  const decoded = bloodyDecodeFlashSector(bloodyBuildFlashSector(stages, 4, makeSector()));
  assert.deepEqual(decoded, { enabledStageCount: 4, stages });
  assert.equal(bloodyDecodeFlashSector(new Uint8Array(256)), null);
});

test("bloodyDpiToRawStep and bloodyBuildSetDpi reject unencodable DPI", () => {
  for (const bad of [0, 50, 150, 10100, 16000, -100, Number.NaN]) {
    assert.throws(() => bloodyDpiToRawStep(bad), RangeError);
    assert.throws(() => bloodyBuildSetDpi(bad), RangeError);
  }
  // Every advertised option fits in a byte and is unique
  const raws = bloodyGetDpiOptions().map(bloodyDpiToRawStep);
  assert.equal(new Set(raws).size, raws.length);
  assert.ok(raws.every((r) => r >= 1 && r <= 255));
});


