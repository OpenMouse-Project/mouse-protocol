import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORTED_HID_FILTERS } from "../drivers/vendors.ts";
import {
  SC380_PRO_READ_SETTINGS,
  SC380_PRO_RECEIVER_ID,
  SC380_PRO_REPORT_ID,
  SC380_PRO_SETTINGS_LENGTH,
  SC380_PRO_USAGE,
  SC380_PRO_USAGE_PAGE,
  SC380_PRO_VENDOR_ID,
  decodeSc380ProReply,
  decodeSc380ProSettings,
  encodeSc380ProReport,
  setSc380ProStageDpi,
} from "./index.ts";

function settingsBlock(): Uint8Array {
  const block = new Uint8Array(SC380_PRO_SETTINGS_LENGTH);
  block.set([0x64, 0x18, 0x04, 0x26, 0, 2, 0, 7, 0, 15, 0, 23, 0, 47, 0, 71, 0, 119, 0]);
  block.set(block.slice(7, 19), 27);
  return block;
}

// Builds a reply with the checksum at `offset` (offset 1 means a leading report ID).
function reply(command: number, argument: number, data: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(offset + 7 + data.length);
  if (offset) out[0] = SC380_PRO_REPORT_ID;
  out.set([command, argument, 1, 0, data.length & 0xff, data.length >> 8], offset + 1);
  out.set(data, offset + 7);
  out[offset] = out.subarray(offset + 1).reduce((sum, byte) => sum + byte, 0) & 0xff;
  return out;
}

test("encodeSc380ProReport builds the header, payload and checksum", () => {
  const data = Uint8Array.of(1, 2, 3);
  const report = encodeSc380ProReport(0x04, 0, 3, data);
  assert.equal(report.length, 519);
  assert.deepEqual([...report.subarray(1, 10)], [0x04, 0, 1, 0, 3, 0, 1, 2, 3]);
  assert.equal(report[0], report.subarray(1).reduce((sum, byte) => sum + byte, 0) & 0xff);
});

test("encodeSc380ProReport rejects bad lengths", () => {
  assert.throws(() => encodeSc380ProReport(1, 0, -1), /report length/);
  assert.throws(() => encodeSc380ProReport(1, 0, 513), /report length/);
  assert.throws(() => encodeSc380ProReport(1, 0, 1.5), /report length/);
  assert.throws(() => encodeSc380ProReport(1, 0, 2, Uint8Array.of(1)), /report length/);
});

test("decodeSc380ProReply accepts replies with the report ID stripped or included", () => {
  const data = Uint8Array.of(9, 8, 7);
  assert.deepEqual([...decodeSc380ProReply(reply(0x09, 1, data), 0x09, 1, 3)], [9, 8, 7]);
  assert.deepEqual([...decodeSc380ProReply(reply(0x09, 1, data, 1), 0x09, 1, 3)], [9, 8, 7]);
});

test("decodeSc380ProReply rejects wrong command, argument and truncated replies", () => {
  const data = Uint8Array.of(9, 8, 7);
  assert.throws(() => decodeSc380ProReply(reply(0x05, 1, data), 0x09, 1, 3), /Unexpected AULA SC380 Pro reply/);
  assert.throws(() => decodeSc380ProReply(reply(0x09, 2, data), 0x09, 1, 3), /Unexpected AULA SC380 Pro reply/);
  assert.throws(() => decodeSc380ProReply(reply(0x09, 1, data).subarray(0, 8), 0x09, 1, 3), /Unexpected AULA SC380 Pro reply/);
  assert.throws(() => decodeSc380ProReply(reply(0x09, 1, data), 0x09, 1, 4), /Unexpected AULA SC380 Pro reply/);
});

test("decodeSc380ProReply validates the settings checksum", () => {
  const good = reply(SC380_PRO_READ_SETTINGS, 0, settingsBlock());
  assert.equal(decodeSc380ProReply(good, SC380_PRO_READ_SETTINGS, 0, SC380_PRO_SETTINGS_LENGTH).length, 400);
  const bad = good.slice();
  bad[0] ^= 0xff;
  assert.throws(() => decodeSc380ProReply(bad, SC380_PRO_READ_SETTINGS, 0, SC380_PRO_SETTINGS_LENGTH), /checksum/);
});

test("decodeSc380ProReply falls back to offset 0 when a leading 9 is the checksum", () => {
  // Checksum byte equals the report ID, so the offset-1 parse is tried first and must fail its checksum.
  const block = settingsBlock();
  for (let pad = 0; pad < 256; pad++) {
    block[399] = pad;
    const candidate = reply(SC380_PRO_READ_SETTINGS, 0, block);
    if (candidate[0] !== SC380_PRO_REPORT_ID) continue;
    // Offset-1 view would need candidate[1] (the command) to match; force a header that parses at both offsets.
    assert.deepEqual([...decodeSc380ProReply(candidate, SC380_PRO_READ_SETTINGS, 0, SC380_PRO_SETTINGS_LENGTH)], [...block]);
    return;
  }
  assert.fail("no padding produced a report-ID-valued checksum");
});

test("decodeSc380ProSettings checks block length before reading", () => {
  assert.throws(() => decodeSc380ProSettings(new Uint8Array(0)), /settings block/);
  assert.throws(() => decodeSc380ProSettings(new Uint8Array(2)), /settings block/);
  const settings = decodeSc380ProSettings(settingsBlock());
  assert.equal(settings.x.length, 6);
});

test("setSc380ProStageDpi enforces stage, range and step", () => {
  const block = settingsBlock();
  setSc380ProStageDpi(block, 0, 1600, 800);
  const settings = decodeSc380ProSettings(block);
  assert.equal(settings.x[0], 1600);
  assert.equal(settings.y[0], 800);
  assert.throws(() => setSc380ProStageDpi(block, 6, 800, 800), /DPI stage/);
  assert.throws(() => setSc380ProStageDpi(block, -1, 800, 800), /DPI stage/);
  assert.throws(() => setSc380ProStageDpi(block, 0, 50, 800), /DPI value/);
  assert.throws(() => setSc380ProStageDpi(block, 0, 800, 12100), /DPI value/);
  assert.throws(() => setSc380ProStageDpi(block, 0, 850, 800), /DPI value/);
  assert.throws(() => setSc380ProStageDpi(block, 0, 800.5, 800), /DPI value/);
});

test("SUPPORTED_HID_FILTERS offers the AULA SC380 Pro receiver", () => {
  const matches = SUPPORTED_HID_FILTERS.filter((filter) =>
    filter.vendorId === SC380_PRO_VENDOR_ID && filter.productId === SC380_PRO_RECEIVER_ID);
  assert.deepEqual(matches, [{
    vendorId: SC380_PRO_VENDOR_ID,
    productId: SC380_PRO_RECEIVER_ID,
    usagePage: SC380_PRO_USAGE_PAGE,
    usage: SC380_PRO_USAGE,
  }]);
});
