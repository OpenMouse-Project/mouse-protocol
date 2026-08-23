import assert from "node:assert/strict";
import test from "node:test";

import {
  EGG_DEVICE_PROFILES,
  EGG_OFFSET,
  eggButtonControlOffset,
  eggButtonMappingOffset,
  eggClampCpi,
  eggDecodeButtonAction,
  eggDpiOptions,
  eggEncodeButtonAction,
  eggFormatFirmwareVersion,
  eggIsValidCpi,
  eggLodOptions,
  eggNormalizeFeatureReport,
  eggReadUint16LE,
  eggWriteEnabledCpiStages,
} from "@openmouse/protocol/endgame-gear-op1";

const op1 = EGG_DEVICE_PROFILES.get(0x1964)!;
const purple = EGG_DEVICE_PROFILES.get(0x1976)!;
const op1v2 = EGG_DEVICE_PROFILES.get(0x1978)!;

test("all seven Endgame Gear 8K devices have explicit capability profiles", () => {
  assert.deepEqual(
    [...EGG_DEVICE_PROFILES.keys()],
    [0x1964, 0x1966, 0x1976, 0x1978, 0x1980, 0x1984, 0x1970],
  );
  assert.equal(op1.motionSyncAt8k, false);
  assert.equal(EGG_DEVICE_PROFILES.get(0x1966)!.motionSyncAt8k, false);
  assert.equal(purple.motionSyncAt8k, true);
  assert.equal(op1v2.motionSyncAt8k, true);
});

test("OP1w 4K v2 wireless models are capped at 4000 Hz while wired 8K models keep 8000 Hz", () => {
  assert.equal(op1.maxPollingHz, 8000);
  assert.equal(op1v2.maxPollingHz, 8000);
  assert.equal(EGG_DEVICE_PROFILES.get(0x1984)!.maxPollingHz, 4000);
  assert.equal(EGG_DEVICE_PROFILES.get(0x1970)!.maxPollingHz, 4000);
});

test("CPI ranges and quantization follow each sensor generation", () => {
  assert.equal(eggClampCpi(op1, 30_000), 26_000);
  assert.equal(eggClampCpi(op1, 31_000), 26_000);
  assert.equal(eggClampCpi(purple, 30_000), 30_000);
  assert.equal(eggClampCpi(op1v2, 31_000), 30_000);
  assert.equal(eggClampCpi(op1v2, 1_605), 1_610);
  assert.equal(eggClampCpi(op1v2, 10_024), 10_000);
  assert.equal(eggClampCpi(op1v2, 10_025), 10_050);
  assert.equal(eggIsValidCpi(op1v2, 1_610), true);
  assert.equal(eggIsValidCpi(op1v2, 1_605), false);
  assert.deepEqual(eggDpiOptions(op1v2).slice(0, 3), [10, 20, 30]);
  assert.deepEqual(eggDpiOptions(op1v2).slice(-3), [29_900, 29_950, 30_000]);
});

test("a generic CPI change updates every enabled stage without touching disabled stages", () => {
  const config = new Uint8Array(80);
  config[EGG_OFFSET.reserved29] = 0x02; // Not a runtime CPI-stage index.
  config[EGG_OFFSET.cpiLevels] = 3;
  eggWriteEnabledCpiStages(config, 3_200, 3_200);

  for (let level = 0; level < 3; level += 1) {
    const offset = EGG_OFFSET.firstCpiSplit + level * 5;
    assert.equal(config[offset], 0);
    assert.equal(eggReadUint16LE(config, offset + 1), 3_200);
    assert.equal(eggReadUint16LE(config, offset + 3), 3_200);
  }
  assert.equal(eggReadUint16LE(config, EGG_OFFSET.firstCpiSplit + 3 * 5 + 1), 0);
  assert.equal(config[EGG_OFFSET.reserved29], 0x02);
});

test("LOD options switch by device and glass mode", () => {
  assert.deepEqual(eggLodOptions(op1, false), ["0.7 mm", "1 mm", "2 mm"]);
  assert.equal(eggLodOptions(op1v2, false).length, 11);
  assert.deepEqual(eggLodOptions(op1v2, true), ["1.0 mm", "2.0 mm"]);
  assert.deepEqual(eggLodOptions(purple, true), ["1.0 mm", "2.0 mm"]);
});

test("firmware version bytes are decoded as BCD", () => {
  const acknowledgement = new Uint8Array(20);
  acknowledgement[1] = 0x01;
  assert.equal(eggFormatFirmwareVersion(acknowledgement), null);

  const v107 = new Uint8Array(20);
  v107[17] = 0x07;
  v107[18] = 0x01;
  assert.equal(eggFormatFirmwareVersion(v107), "V1.07");

  const v137 = new Uint8Array(20);
  v137[17] = 0x37;
  v137[18] = 0x01;
  assert.equal(eggFormatFirmwareVersion(v137), "V1.37");
});

test("firmware response normalization preserves an included report ID", () => {
  const raw = new Uint8Array(65);
  raw[0] = 0xa1;
  raw[17] = 0x07;
  raw[18] = 0x01;
  const normalized = eggNormalizeFeatureReport(raw, 0xa1, 64, 63);
  assert.equal(normalized.length, 65);
  assert.equal(eggFormatFirmwareVersion(normalized), "V1.07");
});

test("oversized Windows command replies do not duplicate the wire header", () => {
  const raw = new Uint8Array(1040);
  raw[0] = 0xa1;
  raw[1] = 0x01;
  raw[17] = 0x24;
  raw[18] = 0x01;

  const normalized = eggNormalizeFeatureReport(raw, 0xa1, 64, 1040);
  assert.equal(normalized.length, 1040);
  assert.deepEqual(Array.from(normalized.slice(0, 3)), [0xa1, 0x01, 0x00]);
  assert.equal(eggFormatFirmwareVersion(normalized), "V1.24");
});

test("oversized Windows busy replies retain their status byte", () => {
  const raw = new Uint8Array(1040);
  raw[0] = 0xa1;
  raw[1] = 0x03;

  const normalized = eggNormalizeFeatureReport(raw, 0xa1, 64, 1040);
  assert.equal(normalized[0], 0xa1);
  assert.equal(normalized[1], 0x03);
});

test("button control and mapping offsets follow the shifted physical layout", () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, button) => eggButtonControlOffset(button)), [77, 84, 91, 98, 105, null, null]);
  assert.deepEqual(Array.from({ length: 7 }, (_, button) => eggButtonMappingOffset(button, false)), [null, 78, 85, 92, 99, 113, 120]);
  assert.deepEqual(Array.from({ length: 7 }, (_, button) => eggButtonMappingOffset(button, true)), [71, null, 85, 92, 99, 113, 120]);
});

test("all supported button actions round-trip through the wire codec", () => {
  const actions = [
    { key: "mouse-left" },
    { key: "scroll-down" },
    { key: "keyboard", modifiers: 0x05, usage: 0x06 },
    { key: "cpi-loop" },
    { key: "fixed-cpi", x: 800, y: 1600 },
    { key: "media-mute" },
    { key: "browser-home" },
    { key: "disabled" },
  ] as const;
  for (const action of actions) {
    const encoded = eggEncodeButtonAction(action)!;
    assert.deepEqual(eggEncodeButtonAction(eggDecodeButtonAction(encoded.type, encoded.params)), encoded);
  }
  assert.deepEqual(eggEncodeButtonAction({ key: "cpi-loop" })!.params, [0xf1, 0, 0, 0, 0]);
});
