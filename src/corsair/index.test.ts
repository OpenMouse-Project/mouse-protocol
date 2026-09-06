import assert from "node:assert/strict";
import test from "node:test";

import {
  CORSAIR_CONFIG_USAGE,
  CORSAIR_NIGHTSWORD_PRODUCT_ID,
  CORSAIR_PRODUCTS,
  CORSAIR_USAGE_PAGE,
  CORSAIR_VENDOR_ID,
  corsairDecode as decode,
  corsairEnabledStages,
  corsairEncode as encode,
  corsairFormatVersion,
  corsairIsEcho,
  corsairRgbHex,
} from "./index.ts";

/** Parse a spaced-hex capture line into a zero-padded 64-byte reply. */
function reply(hex: string): Uint8Array {
  const bytes = hex.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16));
  const packet = new Uint8Array(64);
  packet.set(bytes);
  return packet;
}

function head(packet: Uint8Array, count: number): number[] {
  return [...packet.subarray(0, count)];
}

// Fixtures from captures/corsair-nightsword/PROTOCOL.md (fw 3.41, bl 3.08).
const IDENT = reply("0e 01 00 00 01 01 00 01 41 03 08 03 1c 1b 5c 1b 01");
const MASK = reply("0e 13 05 00 0f");
const CURRENT_STAGE = reply("0e 13 02 00 02 09 60 09 60");
const LIFT = reply("0e 13 03 00 05");
const SNAP = reply("0e 13 04 00 00");

// Live profile as loaded by iCUE: 400 / 800 / 2400 / 5700, stage 2 active.
const ICUE_STAGES = [
  reply("0e 13 d0 00 00 01 90 01 90 ff ff 00"),
  reply("0e 13 d1 00 00 03 20 03 20 00 bf ff"),
  reply("0e 13 d2 00 00 09 60 09 60 00 bf ff"),
  reply("0e 13 d3 00 00 16 44 16 44 00 bf ff"),
];

// Factory onboard profile after replug with iCUE stopped: 800 / 1500 / 3000 / 6000.
// d1/d2 colours confirmed 00 bf ff from the live diagnostics log (2026-09-06).
const FACTORY_STAGES = [
  reply("0e 13 d0 00 00 03 20 03 20 ff ff 00"),
  reply("0e 13 d1 00 00 05 dc 05 dc 00 bf ff"),
  reply("0e 13 d2 00 00 0b b8 0b b8 00 bf ff"),
  reply("0e 13 d3 00 00 17 70 17 70 00 bf ff"),
];

test("catalog pins the NIGHTSWORD RGB on the usage-4 config collection", () => {
  assert.equal(CORSAIR_VENDOR_ID, 0x1b1c);
  assert.equal(CORSAIR_USAGE_PAGE, 0xffc2);
  assert.equal(CORSAIR_CONFIG_USAGE, 4);
  assert.deepEqual(CORSAIR_PRODUCTS.get(CORSAIR_NIGHTSWORD_PRODUCT_ID), {
    name: "NIGHTSWORD RGB",
    dpiMax: 18_000,
    dpiStep: 1,
    stages: 6,
    verifiedFirmware: "3.41",
  });
});

test("GET requests are 64-byte packets addressing the live profile", () => {
  for (const packet of [encode.ident(), encode.dpiMask(), encode.dpiStage(), encode.lift(), encode.snap(), encode.stage(3)]) {
    assert.equal(packet.length, 64);
    assert.ok(packet.subarray(4).every((byte) => byte === 0));
  }
  assert.deepEqual(head(encode.ident(), 4), [0x0e, 0x01, 0x00, 0x00]);
  assert.deepEqual(head(encode.dpiMask(), 4), [0x0e, 0x13, 0x05, 0x00]);
  assert.deepEqual(head(encode.dpiStage(), 4), [0x0e, 0x13, 0x02, 0x00]);
  assert.deepEqual(head(encode.lift(), 4), [0x0e, 0x13, 0x03, 0x00]);
  assert.deepEqual(head(encode.snap(), 4), [0x0e, 0x13, 0x04, 0x00]);
  assert.deepEqual(head(encode.stage(0), 4), [0x0e, 0x13, 0xd0, 0x00]);
  assert.deepEqual(head(encode.stage(5), 4), [0x0e, 0x13, 0xd5, 0x00]);
  assert.throws(() => encode.stage(6), /0–5/);
  assert.throws(() => encode.stage(-1), /0–5/);
});

test("decodes the identity packet little-endian", () => {
  const ident = decode.ident(IDENT);
  assert.deepEqual(ident, {
    firmware: 0x0341,
    bootloader: 0x0308,
    vendorId: 0x1b1c,
    productId: 0x1b5c,
    pollIntervalMs: 1,
    pollingRateHz: 1000,
  });
  assert.equal(corsairFormatVersion(ident.firmware), "3.41");
  assert.equal(corsairFormatVersion(ident.bootloader), "3.08");
  assert.throws(() => decode.ident(IDENT.subarray(0, 16)), /shorter than 17/);
});

test("decodes the enabled-stage mask, lift height, and angle snap", () => {
  assert.equal(decode.dpiMask(MASK), 0x0f);
  assert.deepEqual(corsairEnabledStages(0x0f), [0, 1, 2, 3]);
  assert.deepEqual(corsairEnabledStages(0x25), [0, 2, 5]);
  assert.deepEqual(corsairEnabledStages(0), []);
  assert.equal(decode.lift(LIFT), 5);
  assert.equal(decode.snap(SNAP), false);
  assert.equal(decode.snap(reply("0e 13 04 00 01")), true);
});

test("decodes the current stage reply with big-endian DPI", () => {
  // "09 60" is 2400 only when read big-endian; little-endian would give 24585.
  assert.deepEqual(decode.dpiStage(CURRENT_STAGE), { stage: 2, x: 2400, y: 2400 });
  assert.notEqual(decode.dpiStage(CURRENT_STAGE).x, 0x6009);
  assert.throws(() => decode.dpiStage(CURRENT_STAGE.subarray(0, 8)), /shorter than 9/);
});

test("decodes the iCUE-loaded stages d0–d3 big-endian with their colours", () => {
  assert.deepEqual(ICUE_STAGES.map((stage) => decode.stage(stage)), [
    { x: 400, y: 400, rgb: [0xff, 0xff, 0x00] },
    { x: 800, y: 800, rgb: [0x00, 0xbf, 0xff] },
    { x: 2400, y: 2400, rgb: [0x00, 0xbf, 0xff] },
    { x: 5700, y: 5700, rgb: [0x00, 0xbf, 0xff] },
  ]);
  assert.equal(corsairRgbHex(decode.stage(ICUE_STAGES[0]!).rgb), "#ffff00");
});

test("decodes the factory onboard stages d0–d3", () => {
  assert.deepEqual(FACTORY_STAGES.map((stage) => decode.stage(stage)), [
    { x: 800, y: 800, rgb: [0xff, 0xff, 0x00] },
    { x: 1500, y: 1500, rgb: [0x00, 0xbf, 0xff] },
    { x: 3000, y: 3000, rgb: [0x00, 0xbf, 0xff] },
    { x: 6000, y: 6000, rgb: [0x00, 0xbf, 0xff] },
  ]);
  const unused = reply("0e 13 d4 00");
  assert.deepEqual(decode.stage(unused), { x: 0, y: 0, rgb: [0, 0, 0] });
});

test("setStageDpi writes DPI little-endian and always carries RGB", () => {
  // 800 read back as "03 20" must be sent as "20 03".
  const packet = encode.setStageDpi(1, 800, 800, [0x00, 0xbf, 0xff]);
  assert.deepEqual(head(packet, 12), [0x07, 0x13, 0xd1, 0x00, 0x00, 0x20, 0x03, 0x20, 0x03, 0x00, 0xbf, 0xff]);
  assert.equal(packet.length, 64);
  // Hardware check from the capture: LE "06 40" stores 0x4006 = 16390.
  const high = encode.setStageDpi(0, 16_390, 16_390, [0xff, 0xff, 0x00]);
  assert.deepEqual(head(high, 12), [0x07, 0x13, 0xd0, 0x00, 0x00, 0x06, 0x40, 0x06, 0x40, 0xff, 0xff, 0x00]);
  // Independent axes set byte 4.
  assert.deepEqual(head(encode.setStageDpi(2, 1600, 800, [1, 2, 3]), 12),
    [0x07, 0x13, 0xd2, 0x00, 0x01, 0x40, 0x06, 0x20, 0x03, 1, 2, 3]);
  assert.throws(() => encode.setStageDpi(0, 70_000, 70_000, [0, 0, 0]), /0 to 65535/);
  assert.throws(() => encode.setStageDpi(0, 800, 800, [0, 0] as unknown as [number, number, number]), /triple/);
  assert.throws(() => encode.setStageDpi(0, 800, 800, [0, 0, 256]), /out of range/);
});

test("encode then decode round-trips DPI across the asymmetric byte order", () => {
  for (const dpi of [1, 400, 800, 2400, 5700, 16_390, 18_000]) {
    const written = encode.setStageDpi(0, dpi, dpi, [0, 0, 0]);
    // A GET reply would present the same value big-endian.
    const asRead = reply(`0e 13 d0 00 00 ${hex(dpi >> 8)} ${hex(dpi & 0xff)} ${hex(dpi >> 8)} ${hex(dpi & 0xff)} 00 00 00`);
    assert.equal(written[5], dpi & 0xff);
    assert.equal(written[6], dpi >> 8);
    assert.equal(decode.stage(asRead).x, dpi);
  }
});

test("remaining SET packets follow the ckb-next layout", () => {
  assert.deepEqual(head(encode.setStage(3), 5), [0x07, 0x13, 0x02, 0x00, 0x03]);
  assert.deepEqual(head(encode.setDpiMask(0x0f), 5), [0x07, 0x13, 0x05, 0x00, 0x0f]);
  assert.throws(() => encode.setDpiMask(0x40), /0x3f/);
  assert.deepEqual(head(encode.setLift(5), 5), [0x07, 0x13, 0x03, 0x00, 0x05]);
  assert.deepEqual(head(encode.setSnap(true), 6), [0x07, 0x13, 0x04, 0x00, 0x01, 0x05]);
  assert.deepEqual(head(encode.setPollMs(1), 5), [0x07, 0x0a, 0x00, 0x00, 0x01]);
  assert.deepEqual(head(encode.setPollMs(8), 5), [0x07, 0x0a, 0x00, 0x00, 0x08]);
  assert.throws(() => encode.setPollMs(3 as 1), /1, 2, 4, or 8/);
});

test("isEcho matches on the first four request bytes only", () => {
  assert.equal(corsairIsEcho(encode.ident(), IDENT), true);
  assert.equal(corsairIsEcho(encode.dpiStage(), CURRENT_STAGE), true);
  assert.equal(corsairIsEcho(encode.stage(2), ICUE_STAGES[2]!), true);
  assert.equal(corsairIsEcho(encode.stage(1), ICUE_STAGES[2]!), false);
  // A stale buffer from the previous GET must not pass for a new request.
  assert.equal(corsairIsEcho(encode.dpiMask(), CURRENT_STAGE), false);
  assert.equal(corsairIsEcho(encode.ident(), new Uint8Array(3)), false);
});

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
