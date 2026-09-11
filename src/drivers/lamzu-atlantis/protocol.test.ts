import assert from "node:assert/strict";
import test from "node:test";

import {
  LAMZU_ATLANTIS_COMMAND as COMMAND,
  LAMZU_ATLANTIS_FLASH as FLASH,
  LAMZU_ATLANTIS_PRODUCTS,
  LAMZU_ATLANTIS_TIMER_STEP_SECONDS,
  LAMZU_ATLANTIS_VENDOR_ID,
  LAMZU_ATLANTIS_WRITE_ACTIVE_PROFILE,
  lamzuAtlantisDecodeBattery,
  lamzuAtlantisDecodeDpiStage,
  lamzuAtlantisDecodeFirmware,
  lamzuAtlantisDecodeLiftOffDistance,
  lamzuAtlantisDecodePollingRate,
  lamzuAtlantisDecodeReply,
  lamzuAtlantisEncodeLiftOffDistance,
  lamzuAtlantisEncodePollingRate,
  lamzuAtlantisEncodeRequest,
  lamzuAtlantisFieldIsIntact,
  lamzuAtlantisProduct,
  lamzuAtlantisSealField,
} from "@openmouse/protocol/lamzu";
import { pulsarVgnDecodeDpi, pulsarVgnEncodeDpi } from "@openmouse/protocol/pulsar";

const bytes = (text: string): Uint8Array =>
  new Uint8Array(text.trim().split(/\s+/).map((value) => Number.parseInt(value, 16)));

// Every frame below was captured from a Lamzu Atlantis Mini 4K on firmware
// 1.24, wired (0x3554:0xf50f), on the usage page 0xff02 usage 2 collection.
const CAPTURE = {
  batteryRequest: bytes("04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49"),
  batteryReply: bytes("04 00 00 00 02 64 01 10 82 00 00 00 00 00 00 50"),
  firmwareRequest: bytes("12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3b"),
  firmwareReply: bytes("12 00 00 00 02 01 24 00 00 00 00 00 00 00 00 14"),
  profileReply: bytes("0e 00 00 00 01 00 00 00 00 00 00 00 00 00 00 3e"),
  sleepRequest: bytes("08 00 00 ad 02 00 00 00 00 00 00 00 00 00 00 96"),
  sleepReply: bytes("08 00 00 ad 02 06 4f 00 00 00 00 00 00 00 00 41"),
  stageRequest: bytes("08 00 00 0c 04 00 00 00 00 00 00 00 00 00 00 35"),
  stageReply: bytes("08 00 00 0c 04 07 07 00 47 00 00 00 00 00 00 e0"),
  colorReply: bytes("08 00 00 34 04 00 ff 00 56 00 00 00 00 00 00 b8"),
  rateReply: bytes("08 00 00 00 02 02 53 00 00 00 00 00 00 00 00 ee"),
};

test("requests encode to the bytes the mouse was sent", () => {
  assert.deepEqual(lamzuAtlantisEncodeRequest({ command: COMMAND.batteryLevel }), CAPTURE.batteryRequest);
  assert.deepEqual(lamzuAtlantisEncodeRequest({ command: COMMAND.readVersionId }), CAPTURE.firmwareRequest);
  assert.deepEqual(
    lamzuAtlantisEncodeRequest({ command: COMMAND.readFlashData, address: FLASH.sleepTime, payload: [0, 0] }),
    CAPTURE.sleepRequest,
  );
  assert.deepEqual(
    lamzuAtlantisEncodeRequest({ command: COMMAND.readFlashData, address: FLASH.dpiValues, payload: [0, 0, 0, 0] }),
    CAPTURE.stageRequest,
  );
});

test("a request refuses more payload than a frame holds", () => {
  assert.throws(
    () => lamzuAtlantisEncodeRequest({ command: COMMAND.writeFlashData, address: 0, payload: new Array(11).fill(0) }),
    /at most 10 payload bytes/,
  );
});

test("replies decode, and a corrupted or truncated frame decodes to null", () => {
  const reply = lamzuAtlantisDecodeReply(CAPTURE.sleepReply);
  assert.equal(reply?.command, COMMAND.readFlashData);
  assert.equal(reply?.error, 0);
  assert.equal(reply?.address, FLASH.sleepTime);
  assert.deepEqual(reply?.payload.subarray(0, 2), bytes("06 4f"));

  const corrupted = Uint8Array.from(CAPTURE.sleepReply);
  corrupted[15] ^= 0xff;
  assert.equal(lamzuAtlantisDecodeReply(corrupted), null);
  assert.equal(lamzuAtlantisDecodeReply(CAPTURE.sleepReply.subarray(0, 9)), null);
});

test("the battery reply carries more bytes than it declares", () => {
  const reply = lamzuAtlantisDecodeReply(CAPTURE.batteryReply);
  // The mouse says 2 while sending percent, charging flag and two more bytes
  // of millivolts; decoding must not trust that length.
  assert.equal(reply?.declaredLength, 2);
  const battery = lamzuAtlantisDecodeBattery(reply!.payload);
  assert.deepEqual(battery, { percent: 100, millivolts: 4226, charging: true });
});

test("a battery reading above 100% is reported as unknown rather than clamped", () => {
  assert.equal(lamzuAtlantisDecodeBattery(bytes("ff 00 10 82")).percent, null);
  assert.deepEqual(lamzuAtlantisDecodeBattery(bytes("64 00")), { percent: null, millivolts: null, charging: false });
});

test("the firmware reply decodes to the version Lamzu ships for this model", () => {
  const reply = lamzuAtlantisDecodeReply(CAPTURE.firmwareReply);
  assert.equal(lamzuAtlantisDecodeFirmware("Mouse", reply!.payload), "Mouse v1.24");
  assert.equal(lamzuAtlantisDecodeFirmware("Mouse", new Uint8Array([1])), null);
});

test("the active profile is 0-based on the wire", () => {
  const reply = lamzuAtlantisDecodeReply(CAPTURE.profileReply);
  assert.equal(reply?.payload[0], 0);
});

test("flash fields carry a trailing checksum that must sum to 0x55", () => {
  const sleep = lamzuAtlantisDecodeReply(CAPTURE.sleepReply)!.payload.subarray(0, 2);
  assert.ok(lamzuAtlantisFieldIsIntact(sleep));
  assert.equal(sleep[0]! * LAMZU_ATLANTIS_TIMER_STEP_SECONDS, 60);

  const corrupted = Uint8Array.from(sleep);
  corrupted[1] ^= 0x01;
  assert.equal(lamzuAtlantisFieldIsIntact(corrupted), false);

  // Sealing reproduces the checksum the mouse itself stored.
  assert.deepEqual(lamzuAtlantisSealField([0x06]), [0x06, 0x4f]);
  assert.deepEqual(lamzuAtlantisSealField([0x00, 0xff, 0x00]), [0x00, 0xff, 0x00, 0x56]);
  assert.ok(lamzuAtlantisFieldIsIntact(new Uint8Array(lamzuAtlantisSealField([0x04]))));
});

test("DPI stages decode with the shared CompX 50-step encoding", () => {
  const stage = lamzuAtlantisDecodeReply(CAPTURE.stageReply)!.payload.subarray(0, 4);
  assert.equal(pulsarVgnDecodeDpi(stage), 400);
  assert.deepEqual(pulsarVgnEncodeDpi(400), stage);
  // Above 12,800 the count no longer fits one byte and rides in the flags.
  assert.equal(pulsarVgnDecodeDpi(pulsarVgnEncodeDpi(26000)), 26000);
});

test("a DPI stage colour decodes from the same four-byte field shape", () => {
  const color = lamzuAtlantisDecodeReply(CAPTURE.colorReply)!.payload.subarray(0, 3);
  assert.deepEqual([...color], [0x00, 0xff, 0x00]);
  assert.ok(lamzuAtlantisFieldIsIntact(lamzuAtlantisDecodeReply(CAPTURE.colorReply)!.payload.subarray(0, 4)));
});

test("polling rates decode from both encodings of 1,000 Hz", () => {
  const rate = lamzuAtlantisDecodeReply(CAPTURE.rateReply)!.payload[0]!;
  assert.equal(lamzuAtlantisDecodePollingRate(rate), 500);
  assert.equal(lamzuAtlantisDecodePollingRate(0x01), 1000);
  assert.equal(lamzuAtlantisDecodePollingRate(0x10), 1000);
  assert.equal(lamzuAtlantisDecodePollingRate(0x80), 8000);
  assert.equal(lamzuAtlantisDecodePollingRate(0x7f), null);
});

test("encoding 1,000 Hz follows the transport's declared family", () => {
  assert.equal(lamzuAtlantisEncodePollingRate(1000, "wired"), 0x01);
  assert.equal(lamzuAtlantisEncodePollingRate(1000, "receiver"), 0x10);
  assert.equal(lamzuAtlantisEncodePollingRate(500, "wired"), 0x02);
  assert.equal(lamzuAtlantisEncodePollingRate(4000, "receiver"), 0x40);
  assert.equal(lamzuAtlantisEncodePollingRate(3000, "receiver"), null);
});

test("the rate family is declared per product, not guessed from the rate list", () => {
  // The 1K receiver tops out at 1,000 Hz exactly like the cable, so a ceiling
  // test would quietly decide its encoding. It is wireless and unverified.
  const oneK = LAMZU_ATLANTIS_PRODUCTS.get(0xf50d)!;
  assert.equal(oneK.wireless, true);
  assert.equal(oneK.verified, false);
  assert.equal(oneK.rateFamily, "wired");
  assert.equal(LAMZU_ATLANTIS_PRODUCTS.get(0xf510)!.rateFamily, "receiver");
});

test("a DPI stage decodes both axes, including one Lamzu set separately", () => {
  // 07 07 00 47 is the captured 400 DPI stage; x and y match there.
  const symmetric = lamzuAtlantisDecodeDpiStage(bytes("07 07 00 47"));
  assert.deepEqual(symmetric, { x: 400, y: 400 });

  // Separate axes are a valid, correctly checksummed field. pulsarVgnDecodeDpi
  // returns null for these because the Pulsar driver only writes axes in
  // lockstep, which would make a perfectly good stage read as corrupt.
  const asymmetric = lamzuAtlantisSealField([0x07, 0x0f, 0x00]);
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array(asymmetric)), null);
  assert.deepEqual(lamzuAtlantisDecodeDpiStage(new Uint8Array(asymmetric)), { x: 400, y: 800 });

  // The flags byte carries each axis's high bits: 2-3 for x, 6-7 for y.
  const high = lamzuAtlantisSealField([0xff, 0xff, (1 << 2) | (1 << 6)]);
  assert.deepEqual(lamzuAtlantisDecodeDpiStage(new Uint8Array(high)), { x: 25600, y: 25600 });

  // A corrupt field stays null rather than decoding to something plausible.
  assert.equal(lamzuAtlantisDecodeDpiStage(bytes("07 07 00 48")), null);
  assert.equal(lamzuAtlantisDecodeDpiStage(bytes("07 07 00")), null);
});

test("lift-off is 1 mm or 2 mm on this generation, not Pulsar's three stops", () => {
  assert.equal(lamzuAtlantisDecodeLiftOffDistance(0x01), "Low");
  assert.equal(lamzuAtlantisDecodeLiftOffDistance(0x02), "Medium");
  assert.equal(lamzuAtlantisDecodeLiftOffDistance(0x03), null);
  assert.equal(lamzuAtlantisEncodeLiftOffDistance("Low"), 0x01);
  assert.equal(lamzuAtlantisEncodeLiftOffDistance("High"), null);
});

test("the catalog answers only for Lamzu's vendor id", () => {
  assert.equal(lamzuAtlantisProduct(LAMZU_ATLANTIS_VENDOR_ID, 0xf50f)?.wireless, false);
  assert.equal(lamzuAtlantisProduct(LAMZU_ATLANTIS_VENDOR_ID, 0xf510)?.wireless, true);
  // 0xf58f is a VXE transport on the same shared CompX vendor id.
  assert.equal(lamzuAtlantisProduct(LAMZU_ATLANTIS_VENDOR_ID, 0xf58f), undefined);
  assert.equal(lamzuAtlantisProduct(0x373e, 0xf50f), undefined);
});

test("the profile write command is the counterpart of the profile read", () => {
  assert.equal(LAMZU_ATLANTIS_WRITE_ACTIVE_PROFILE, COMMAND.getCurrentConfig + 1);
});
