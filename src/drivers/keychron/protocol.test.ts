import assert from "node:assert/strict";
import test from "node:test";

import {
  KEYCHRON_NAPE_DPI_MAX,
  KEYCHRON_NAPE_DPI_MIN,
  KEYCHRON_NAPE_DPI_STEP,
  KEYCHRON_NAPE_SLEEP_MAX_SECONDS,
  KEYCHRON_NAPE_SLEEP_MIN_SECONDS,
  KEYCHRON_PACKET_LENGTH,
  KEYCHRON_POLLING_TABLE,
  keychronDecodeBattery,
  keychronDecodeFirmware,
  keychronDecodePolling,
  keychronDecodeSleepTimeout,
  keychronEncodeSleepTimeout,
  keychronPacket,
} from "@openmouse/protocol/keychron";

test("Nape Pro DPI range is model-specific (50–4000 step 50)", () => {
  assert.equal(KEYCHRON_NAPE_DPI_MIN, 50);
  assert.equal(KEYCHRON_NAPE_DPI_MAX, 4000);
  assert.equal(KEYCHRON_NAPE_DPI_STEP, 50);
});

test("packets are fixed 32-byte VIA raw HID reports", () => {
  const packet = keychronPacket([167, 36, 2]);
  assert.equal(packet.length, KEYCHRON_PACKET_LENGTH);
  assert.deepEqual([...packet.slice(0, 3)], [167, 36, 2]);
  assert.ok(packet.slice(3).every((byte) => byte === 0));
});

test("polling falls back when the misc reply is blank", () => {
  const blank = new Uint8Array(KEYCHRON_PACKET_LENGTH);
  blank[0] = 167;
  blank[1] = 13;
  assert.deepEqual(keychronDecodePolling(blank), {
    rateHz: 1000,
    supported: [125, 500, 1000],
  });
});

test("polling decodes the Keychron rate mask and active index", () => {
  const response = new Uint8Array(KEYCHRON_PACKET_LENGTH);
  response[0] = 167;
  response[1] = 13;
  // Bits 0–3 advertise 8K/4K/2K/1K; index 1 is 4000 Hz.
  response[5] = 0b0000_1111;
  response[6] = 1;
  assert.deepEqual(keychronDecodePolling(response), {
    rateHz: 4000,
    supported: [1000, 2000, 4000, 8000],
  });
  assert.equal(KEYCHRON_POLLING_TABLE[1], 4000);
});

test("firmware strings keep a leading v when the device omits it", () => {
  const withPrefix = new Uint8Array([161, 0x76, 0x31, 0x2e, 0x32, 0x2e, 0x33, 0]);
  const bare = new Uint8Array([161, 0x31, 0x2e, 0x30, 0x2e, 0x31, 0]);
  assert.equal(keychronDecodeFirmware(withPrefix), "v1.2.3");
  assert.equal(keychronDecodeFirmware(bare), "v1.0.1");
  assert.equal(keychronDecodeFirmware(new Uint8Array([161, 0])), null);
});

test("battery decodes percent and charge state", () => {
  assert.deepEqual(keychronDecodeBattery(new Uint8Array([167, 49, 88, 0])), {
    percent: 88,
    state: "Discharging",
  });
  assert.deepEqual(keychronDecodeBattery(new Uint8Array([167, 49, 90, 1])), {
    percent: 90,
    state: "Charging",
  });
  assert.deepEqual(keychronDecodeBattery(new Uint8Array([167, 49, 100, 2])), {
    percent: 100,
    state: "Full",
  });
});

test("sleep decodes little-endian seconds from the Get_Sleep reply layout", () => {
  assert.equal(keychronDecodeSleepTimeout(new Uint8Array([167, 11, 0, 0, 0, 0x3d, 0])), 61);
  assert.equal(keychronDecodeSleepTimeout(new Uint8Array([167, 11, 0, 0, 0, 0x78, 0])), 120);
  assert.equal(keychronDecodeSleepTimeout(new Uint8Array([167, 11, 0, 0, 0, 0xcf, 0xb6])), 46799);
  assert.equal(KEYCHRON_NAPE_SLEEP_MIN_SECONDS, 60);
  assert.equal(KEYCHRON_NAPE_SLEEP_MAX_SECONDS, 12 * 3600 + 59 * 60 + 59);
});

test("sleep encodes the trackball Set_Sleep payload (sleep LE at bytes 4–5)", () => {
  assert.deepEqual(keychronEncodeSleepTimeout(61), [167, 12, 0, 0, 0x3d, 0, 0, 0]);
  assert.deepEqual(keychronEncodeSleepTimeout(43200), [167, 12, 0, 0, 0xc0, 0xa8, 0, 0]);
});
