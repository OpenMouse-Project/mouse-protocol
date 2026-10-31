import assert from "node:assert/strict";
import test from "node:test";

import {
  LAMZU_ATLANTIS_COMMAND as COMMAND,
  LAMZU_ATLANTIS_FLASH as FLASH,
  LAMZU_ATLANTIS_PRODUCTS,
  LAMZU_ATLANTIS_TIMER_STEP_SECONDS,
  LAMZU_ATLANTIS_VENDOR_ID,
  LAMZU_ATLANTIS_WRITE_ACTIVE_PROFILE,
  lamzuAtlantisDecodeAngleTuning,
  lamzuAtlantisDecodeBattery,
  lamzuAtlantisDecodeDpiStage,
  lamzuAtlantisDecodeDpiStage3955,
  lamzuAtlantisDecodeFirmware,
  lamzuAtlantisDecodeLiftOffDistance,
  lamzuAtlantisDecodePollingRate,
  lamzuAtlantisDecodeReply,
  lamzuAtlantisEncodeAngleTuning,
  lamzuAtlantisEncodeDpiStage,
  lamzuAtlantisEncodeDpiStage3955,
  lamzuAtlantisEncodeLiftOffDistance,
  lamzuAtlantisEncodePollingRate,
  lamzuAtlantisEncodeRequest,
  lamzuAtlantisFieldIsIntact,
  lamzuAtlantisLiftOffScale,
  lamzuAtlantisNearestLiftOffStop,
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

test("the legacy stage encoder matches Pulsar's and reaches the decoder's ten bits", () => {
  for (let dpi = 50; dpi <= 26000; dpi += 50) {
    assert.deepEqual(lamzuAtlantisEncodeDpiStage(dpi), [...pulsarVgnEncodeDpi(dpi)]);
  }
  // The 3950's 30,000 ceiling is past Pulsar's 26,000 but inside the field.
  for (const dpi of [30000, 51200]) {
    assert.deepEqual(lamzuAtlantisDecodeDpiStage(Uint8Array.from(lamzuAtlantisEncodeDpiStage(dpi))), { x: dpi, y: dpi });
  }
  for (const dpi of [0, 25, 51250, 1625.5]) {
    assert.throws(() => lamzuAtlantisEncodeDpiStage(dpi));
  }
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

test("the pulsar family keeps CompX's own 2-8 kHz bytes", () => {
  // Scyrox's web configurator encodes `rate <= 1000 ? 1000 / rate :
  // rate / 2000 * 16`, and a V8S it set to 4,000 Hz held 0x20.
  assert.equal(lamzuAtlantisEncodePollingRate(125, "pulsar"), 0x08);
  assert.equal(lamzuAtlantisEncodePollingRate(250, "pulsar"), 0x04);
  assert.equal(lamzuAtlantisEncodePollingRate(500, "pulsar"), 0x02);
  assert.equal(lamzuAtlantisEncodePollingRate(1000, "pulsar"), 0x01);
  assert.equal(lamzuAtlantisEncodePollingRate(2000, "pulsar"), 0x10);
  assert.equal(lamzuAtlantisEncodePollingRate(4000, "pulsar"), 0x20);
  assert.equal(lamzuAtlantisEncodePollingRate(8000, "pulsar"), 0x40);
  assert.equal(lamzuAtlantisEncodePollingRate(1600, "pulsar"), null);
  assert.equal(lamzuAtlantisDecodePollingRate(0x10, "pulsar"), 2000);
  assert.equal(lamzuAtlantisDecodePollingRate(0x20, "pulsar"), 4000);
  assert.equal(lamzuAtlantisDecodePollingRate(0x40, "pulsar"), 8000);
  // The same byte means different rates per family: 0x10 is Lamzu's
  // receiver encoding of 1,000 Hz, and 0x80 exists only in the Lamzu table.
  assert.equal(lamzuAtlantisDecodePollingRate(0x10), 1000);
  assert.equal(lamzuAtlantisDecodePollingRate(0x80, "pulsar"), null);
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

test("the 3955 stage codec decodes the vendor encoder's 1,600 DPI record", () => {
  // The value the vendor configurator displayed (1,600) while the legacy
  // field at flash 12 held the 400 DPI factory default. The bytes are the
  // configurator's encoder output; this region has not been captured yet.
  assert.deepEqual(
    lamzuAtlantisDecodeDpiStage3955(bytes("3f 06 3f 06 00 cb")),
    { x: 1600, y: 1600 },
  );
  assert.equal(lamzuAtlantisDecodeDpiStage3955(bytes("3f 06 3f 06 00 cc")), null);
  assert.equal(lamzuAtlantisDecodeDpiStage3955(bytes("3f 06 3f 06 00")), null);
});

test("the 3955 stage codec round-trips both of the vendor's value bands", () => {
  // 42,000 and below store as dpi - 1; 42,002 and up store halved with the
  // 0x11 band marker in both nibbles of the flags byte.
  for (const dpi of [50, 400, 1600, 26000, 42000, 42050, 50000]) {
    assert.deepEqual(
      lamzuAtlantisDecodeDpiStage3955(Uint8Array.from(lamzuAtlantisEncodeDpiStage3955(dpi))),
      { x: dpi, y: dpi },
    );
  }
  assert.deepEqual(lamzuAtlantisEncodeDpiStage3955(1600), [0x3f, 0x06, 0x3f, 0x06, 0x00, 0xcb]);
  assert.deepEqual(lamzuAtlantisEncodeDpiStage3955(50000), [0xa7, 0x61, 0xa7, 0x61, 0x11, 0x34]);
});

test("lift-off is 1 mm or 2 mm on this generation, not Pulsar's three stops", () => {
  assert.equal(lamzuAtlantisDecodeLiftOffDistance(0x01), "Low");
  assert.equal(lamzuAtlantisDecodeLiftOffDistance(0x02), "Medium");
  assert.equal(lamzuAtlantisDecodeLiftOffDistance(0x03), null);
  assert.equal(lamzuAtlantisEncodeLiftOffDistance("Low"), 0x01);
  assert.equal(lamzuAtlantisEncodeLiftOffDistance("High"), null);
});

test("a lift-off scale carries every code's height and rejects codes outside it", () => {
  const heights = [0.7, 0.9, 1.2, 1.4, 1.6];
  assert.equal(lamzuAtlantisLiftOffScale(3, heights)?.millimetres, 1.2, "uneven steps are not interpolated");
  assert.deepEqual(lamzuAtlantisLiftOffScale(5, heights)?.millimetresByCode, heights);
  assert.equal(lamzuAtlantisLiftOffScale(0, heights), null);
  assert.equal(lamzuAtlantisLiftOffScale(6, heights), null);
  assert.deepEqual(heights.map(lamzuAtlantisNearestLiftOffStop), ["Low", "Low", "Medium", "Medium", "High"]);
});

test("the angle-tune byte is a signed degree count", () => {
  for (const degrees of [-30, -1, 0, 1, 30]) {
    assert.equal(lamzuAtlantisDecodeAngleTuning(lamzuAtlantisEncodeAngleTuning(degrees)), degrees);
  }
  assert.equal(lamzuAtlantisEncodeAngleTuning(-30), 0xe2);
  assert.equal(FLASH.angleTune, 189);
  assert.equal(FLASH.angleTuneState, 191);
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
