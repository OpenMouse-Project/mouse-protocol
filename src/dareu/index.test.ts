import assert from "node:assert/strict";
import test from "node:test";

import {
  DAREU_DIRECT_PRODUCT_ID,
  DAREU_MAX_BUFFER_CHUNK,
  DAREU_RECEIVER_PRODUCT_ID,
  DAREU_REPORT_SIZE,
  dareuCheckActiveRequest,
  dareuChecksum,
  dareuDecodeButtonAssignment,
  dareuDecodeBattery,
  dareuDecodeDpiLedState,
  dareuDecodeFirmwareVersion,
  dareuDecodeActiveProfile,
  dareuDecodeReadBufferReply,
  dareuDpiFromId,
  dareuDpiId,
  dareuEncodeButtonAssignment,
  dareuEncodeDpiLedBrightness,
  dareuGetBatteryRequest,
  dareuGetActiveProfileRequest,
  dareuGetMouseFirmwareRequest,
  dareuGetReceiverFirmwareRequest,
  dareuIsValidDpi,
  dareuIsValidDpiLedSetting,
  dareuIsValidSleepTimeout,
  dareuMatchesReply,
  dareuPollingRateHz,
  dareuPollingRateId,
  dareuReadBufferRequests,
  dareuSetActiveProfileRequest,
  dareuWithMemoryChecksum,
  dareuWriteBufferRequests,
} from "./index.js";

test("Dareu catalog keeps direct mouse and receiver distinct", () => {
  assert.equal(DAREU_DIRECT_PRODUCT_ID, 0x1117);
  assert.equal(DAREU_RECEIVER_PRODUCT_ID, 0x1114);
});

test("Dareu Jm frames include report ID 8 in their checksum", () => {
  const active = dareuCheckActiveRequest();
  const battery = dareuGetBatteryRequest();
  assert.equal(active.length, DAREU_REPORT_SIZE);
  assert.deepEqual([active[0], active[15]], [3, 74]);
  assert.deepEqual([battery[0], battery[15]], [4, 73]);
  assert.equal(dareuChecksum(new Uint8Array([1, 0])), 84);
  assert.deepEqual([...dareuWithMemoryChecksum(new Uint8Array([100]))], [100, 241]);
  assert.throws(() => dareuChecksum(new Uint8Array()), RangeError);
});

test("Dareu buffer reads are ten-byte bounded and decode only matching replies", () => {
  const requests = dareuReadBufferRequests(0x0fff, 25);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((request) => [request[0], request[2], request[3], request[4]]),
    [[8, 0x0f, 0xff, 10], [8, 0x10, 0x09, 10], [8, 0x10, 0x13, 5]],
  );

  const reply = new Uint8Array(DAREU_REPORT_SIZE);
  reply[0] = 8;
  reply.set(requests[2]!.slice(1, 5), 1);
  reply.set([1, 2, 3, 4, 5], 5);
  assert.deepEqual([...dareuDecodeReadBufferReply(requests[2], reply) ?? []], [1, 2, 3, 4, 5]);
  reply[3] = 0x14;
  assert.equal(dareuDecodeReadBufferReply(requests[2], reply), null);
  reply[0] = 10;
  assert.equal(dareuDecodeReadBufferReply(requests[2], reply), null);
  assert.equal(dareuDecodeReadBufferReply(requests[2], new Uint8Array(15)), null);
  assert.throws(() => dareuReadBufferRequests(0x10000, 1), RangeError);
  assert.throws(() => dareuReadBufferRequests(0xffff, 2), RangeError);
});

test("Dareu buffer writes preserve byte order and do not mutate the source", () => {
  const data = Uint8Array.from({ length: DAREU_MAX_BUFFER_CHUNK + 2 }, (_, index) => index + 1);
  const writes = dareuWriteBufferRequests(96, data);
  assert.equal(writes.length, 2);
  assert.deepEqual([...writes[0].slice(0, 15)], [7, 0, 0, 96, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...writes[1].slice(0, 7)], [7, 0, 0, 106, 2, 11, 12]);
  assert.deepEqual([...data], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.throws(() => dareuWriteBufferRequests(0, new Uint8Array()), RangeError);
});

test("Dareu reply and value validation reject malformed and unsupported values", () => {
  const request = dareuGetBatteryRequest();
  const reply = new Uint8Array(DAREU_REPORT_SIZE);
  reply[0] = 4;
  reply[5] = 87;
  reply[6] = 1;
  assert.equal(dareuMatchesReply(request, reply), true);
  assert.deepEqual(dareuDecodeBattery(reply), { percent: 87, status: 1 });
  reply[5] = 101;
  assert.equal(dareuDecodeBattery(reply), null);
  reply[0] = 10;
  assert.equal(dareuMatchesReply(request, reply), false);

  for (const dpi of [100, 400, 1600, 26000]) assert.equal(dareuIsValidDpi(dpi), true);
  for (const dpi of [99, 125, 26050, 1600.5, Number.NaN]) assert.equal(dareuIsValidDpi(dpi), false);
  assert.equal(dareuPollingRateId(4000, "wired"), null);
  assert.equal(dareuPollingRateId(4000, "receiver"), 32);
  assert.equal(dareuPollingRateHz(32, "wired"), null);
  assert.equal(dareuPollingRateHz(32, "receiver"), 4000);
  assert.equal(dareuIsValidDpiLedSetting(2, 10, 5), true);
  assert.equal(dareuIsValidDpiLedSetting(3, 10, 5), false);
  assert.equal(dareuIsValidSleepTimeout(1800), true);
  assert.equal(dareuIsValidSleepTimeout(120), false);
});

test("Dareu profiles, firmware, and legacy DPI ids follow the JmMouse codec", () => {
  const profileRead = dareuGetActiveProfileRequest();
  const profileWrite = dareuSetActiveProfileRequest(3);
  assert.deepEqual([profileRead[0], profileWrite[0], profileWrite[4], profileWrite[5]], [14, 15, 0x81, 2]);
  assert.throws(() => dareuSetActiveProfileRequest(5), RangeError);

  const profileReply = new Uint8Array(DAREU_REPORT_SIZE);
  profileReply[0] = 14;
  profileReply[5] = 2;
  assert.equal(dareuDecodeActiveProfile(profileReply), 3);

  const firmware = new Uint8Array(DAREU_REPORT_SIZE);
  firmware[0] = 18;
  firmware[5] = 1;
  firmware[6] = 2;
  assert.equal(dareuGetMouseFirmwareRequest()[0], 18);
  assert.equal(dareuGetReceiverFirmwareRequest()[0], 29);
  assert.equal(dareuDecodeFirmwareVersion(firmware, 18), 0x0102);
  assert.equal(dareuDecodeFirmwareVersion(firmware, 29), null);

  for (const dpi of [100, 12_800, 25_600, 26_000]) {
    const id = dareuDpiId(dpi);
    assert.notEqual(id, null);
    assert.equal(dareuDpiFromId(id!), dpi);
  }
  assert.equal(dareuDpiFromId(0x4500), null);
});

test("Dareu button and DPI-indicator codecs retain only verified values", () => {
  const back = dareuEncodeButtonAssignment("Back");
  assert.deepEqual([...back ?? []], [1, 8, 0, 76]);
  assert.equal(dareuDecodeButtonAssignment(back ?? new Uint8Array()), "Back");
  assert.deepEqual([...dareuEncodeButtonAssignment("DPI Cycle") ?? []], [2, 1, 0, 82]);
  assert.equal(dareuDecodeButtonAssignment(dareuEncodeButtonAssignment("DPI Up")!), "DPI Up");
  assert.equal(dareuEncodeButtonAssignment("Macro 1"), null);
  assert.equal(dareuDecodeButtonAssignment(new Uint8Array([8, 0, 251, 0])), null);

  const led = new Uint8Array([
    2, dareuChecksum(new Uint8Array([2, 0])),
    127, dareuChecksum(new Uint8Array([127, 0])),
    3, dareuChecksum(new Uint8Array([3, 0])),
    1, dareuChecksum(new Uint8Array([1, 0])),
  ]);
  assert.deepEqual(dareuDecodeDpiLedState(led), { mode: 2, brightness: 5, speed: 3 });
  assert.deepEqual([...dareuEncodeDpiLedBrightness(5) ?? []], [127, 214]);
  assert.equal(dareuEncodeDpiLedBrightness(11), null);
});
