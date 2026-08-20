import assert from "node:assert/strict";
import test from "node:test";

import { AttackSharkHidClient, checksum25a7, POLLING_CODES_25A7 } from "./hid.ts";

function device(vendorId: number, usagePage = 0xffff): HIDDevice {
  return {
    vendorId,
    productId: 1,
    productName: "X11 Wireless",
    collections: [{
      usagePage,
      usage: 1,
      type: 0,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [{ reportId: 6, items: [] }],
    }],
  } as unknown as HIDDevice;
}

test("Attack Shark OEM devices require the expected feature-report collection", () => {
  assert.equal(AttackSharkHidClient.isSupported(device(0x1d57)), true);
  assert.equal(AttackSharkHidClient.isSupported(device(0x25a7)), true);
  assert.equal(AttackSharkHidClient.isSupported(device(0x25a7, 0x0001)), false);
});

test("Attack Shark battery reports validate their signature and percentage", () => {
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x55, 0x40, 0x01, 73])), 73);
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x55, 0x40, 0x00, 73])), null);
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x55, 0x40, 0x01, 101])), null);
});

// ── 0x25a7 protocol tests ────────────────────────────────────────────────

test("checksum25a7 pads to 9 bytes and places checksum at byte 7", () => {
  // Simple command: [0x80, 0, 0, 0, 0, 0, 0] → sum=0x80, checksum = 0xff-0x80 = 0x7f
  const cmd = new Uint8Array([0x80]);
  const result = checksum25a7(cmd);
  assert.equal(result.length, 9);
  assert.equal(result[0], 0x80);
  assert.equal(result[7], 0x7f); // 0xff - 0x80
  assert.equal(result[8], 0); // unused
});

test("checksum25a7 computes correct checksum for multi-byte command", () => {
  // Command: [0xd4, 0x01, 0, 0, 0, 0, 0] → sum = 0xd4 + 0x01 = 0xd5
  const cmd = new Uint8Array([0xd4, 0x01]);
  const result = checksum25a7(cmd);
  assert.equal(result[0], 0xd4);
  assert.equal(result[1], 0x01);
  assert.equal(result[7], (0xff - 0xd5) & 0xff); // 0x2a
});

test("checksum25a7 wraps sum at byte boundary (mod 256)", () => {
  // Craft bytes that sum to exactly 0x100 → sum & 0xff = 0 → checksum = 0xff
  const cmd = new Uint8Array([0x80, 0x80, 0, 0, 0, 0, 0]);
  const result = checksum25a7(cmd);
  assert.equal(result[7], 0xff); // 0xff - (0x100 & 0xff) = 0xff - 0 = 0xff
});

test("POLLING_CODES_25A7 maps standard rates", () => {
  assert.equal(POLLING_CODES_25A7.get(125), 0x08);
  assert.equal(POLLING_CODES_25A7.get(250), 0x04);
  assert.equal(POLLING_CODES_25A7.get(500), 0x02);
  assert.equal(POLLING_CODES_25A7.get(1000), 0x01);
  assert.equal(POLLING_CODES_25A7.get(2000), 0x84);
  assert.equal(POLLING_CODES_25A7.get(4000), 0x82);
  assert.equal(POLLING_CODES_25A7.get(8000), 0x81);
});

test("POLLING_CODES_25A7 returns undefined for unsupported rates", () => {
  assert.equal(POLLING_CODES_25A7.get(3000), undefined);
  assert.equal(POLLING_CODES_25A7.get(1500), undefined);
});
