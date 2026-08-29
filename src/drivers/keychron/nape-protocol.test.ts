import assert from "node:assert/strict";
import test from "node:test";

/** Nape Pro VIA keymap and layer codec tests. */

import {
  KEYCHRON_NAPE_DPI_MAX,
  KEYCHRON_NAPE_DPI_MIN,
  KEYCHRON_NAPE_DPI_STEP,
  KEYCHRON_NAPE_SLEEP_MAX_SECONDS,
  KEYCHRON_NAPE_SLEEP_MIN_SECONDS,
  KEYCHRON_NAPE_LAYER_COUNT,
  KEYCHRON_PACKET_LENGTH,
  KEYCHRON_POLLING_TABLE,
  KEYCHRON_VIA_COMMAND,
  KEYCHRON_NAPE_KEYCODE,
  KEYCHRON_NAPE_BUTTON_ACTIONS,
  keychronActionForKeycode,
  keychronDecodeKeymapBuffer,
  keychronEncodeGetBuffer,
  keychronEncodeGetLayerOrientation,
  keychronEncodeSetEncoder,
  keychronEncodeSetKeycode,
  keychronKeycodeForAction,
  keychronLayerKeymapFromCodes,
  keychronLayerLabel,
  keychronUserLayerToVia,
  keychronDecodeBattery,
  keychronDecodeCurrentLayer,
  keychronDecodeFirmware,
  keychronDecodeLayerCount,
  keychronDecodePolling,
  keychronDecodeSleepTimeout,
  keychronEncodeSetLayer,
  keychronEncodeSetLayerOrientation,
  keychronEncodeSetOrientation,
  keychronEncodeSleepTimeout,
  keychronOrientationDegrees,
  keychronOrientationLabel,
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

test("VIA layer count and current-layer get/set use 1–8", () => {
  assert.equal(KEYCHRON_VIA_COMMAND.getLayerCount, 17);
  assert.equal(KEYCHRON_NAPE_LAYER_COUNT, 8);
  assert.equal(keychronDecodeLayerCount(new Uint8Array([17, 8])), 8);
  assert.equal(keychronDecodeCurrentLayer(new Uint8Array([163, 1])), 1);
  assert.equal(keychronDecodeCurrentLayer(new Uint8Array([163, 3])), 3);
  assert.equal(keychronDecodeCurrentLayer(new Uint8Array([163, 8])), 8);
  assert.equal(keychronDecodeCurrentLayer(new Uint8Array([163, 0])), 1);
  assert.deepEqual(keychronEncodeSetLayer(1), [167, 45, 1]);
  assert.deepEqual(keychronEncodeSetLayer(2), [167, 45, 2]);
  assert.deepEqual(keychronEncodeSetLayer(8), [167, 45, 8]);
});

test("per-layer orientation is eight 45° steps packed as [57, layer, index]", () => {
  assert.equal(keychronOrientationDegrees(0), 0);
  assert.equal(keychronOrientationDegrees(2), 90);
  assert.equal(keychronOrientationLabel(5), "225°");
  assert.deepEqual(keychronEncodeSetOrientation(2), [167, 52, 2]);
  assert.deepEqual(keychronEncodeGetLayerOrientation(3), [167, 56, 3]);
  assert.deepEqual(keychronEncodeSetLayerOrientation(3, 5), [167, 57, 3, 5]);
});

test("VIA keymap buffer is packed 7 big-endian keycodes per layer", () => {
  assert.equal(KEYCHRON_VIA_COMMAND.getBuffer, 18);
  assert.deepEqual(keychronEncodeGetBuffer(0), [18, 0, 0, 14]);
  assert.deepEqual(keychronEncodeGetBuffer(2), [18, 0, 28, 14]);
  assert.deepEqual(keychronEncodeGetBuffer(3), [18, 0, 42, 14]);
  const reply = new Uint8Array(32);
  reply[0] = 18;
  reply[3] = 14;
  reply[4] = 0x00;
  reply[5] = 0xd1;
  reply[6] = 0x52;
  reply[7] = 0x2a;
  assert.deepEqual(keychronDecodeKeymapBuffer(reply).slice(0, 2), [0x00d1, 0x522a]);
});

test("SET_KEYCODE and SET_ENCODER pack protocol-12 codes big-endian", () => {
  assert.deepEqual(keychronEncodeSetKeycode(2, 5, 0x00d4), [5, 2, 0, 5, 0x00, 0xd4]);
  assert.deepEqual(keychronEncodeSetEncoder(2, false, 0x00aa), [21, 2, 0, 0, 0x00, 0xaa]);
  assert.deepEqual(keychronEncodeSetEncoder(2, true, 0x00a9), [21, 2, 0, 1, 0x00, 0xa9]);
});

test("protocol-12 mouse and CUSTOM actions round-trip through the Nape catalog", () => {
  assert.equal(keychronUserLayerToVia(1), 1);
  assert.equal(keychronUserLayerToVia(3), 3);
  assert.equal(keychronLayerLabel(1), "Layer 0");
  assert.equal(keychronLayerLabel(3), "Layer 2");
  assert.equal(keychronKeycodeForAction("Left click"), KEYCHRON_NAPE_KEYCODE.leftClick);
  assert.equal(keychronActionForKeycode(KEYCHRON_NAPE_KEYCODE.volumeDown), "Volume down");
  assert.equal(keychronActionForKeycode(KEYCHRON_NAPE_KEYCODE.scrollMode), "Scroll mode");
  assert.equal(keychronActionForKeycode(KEYCHRON_NAPE_KEYCODE.dpiCycle), "DPI cycle");
  assert.equal(keychronActionForKeycode(KEYCHRON_NAPE_KEYCODE.customDpi), "Custom");
  assert.equal(keychronActionForKeycode(0x1234), "Custom");
  assert.ok(KEYCHRON_NAPE_BUTTON_ACTIONS.includes("Volume up"));
  assert.ok(!KEYCHRON_NAPE_BUTTON_ACTIONS.includes("Custom DPI"));
  const map = keychronLayerKeymapFromCodes(3, [0x00d1, 0x522a, 0x00d2, 0x7e2c, 0x00d5, 0x00d4], 0x00aa, 0x00a9);
  assert.equal(map.layer, 3);
  assert.deepEqual(map.keys.map((key) => key.name), ["03", "04", "01", "02", "M1", "M2"]);
  assert.equal(map.keys[0]?.action, "Left click");
  assert.equal(map.keys[1]?.action, "Scroll mode");
  assert.equal(map.keys[3]?.action, "DPI cycle");
  assert.equal(map.wheel.ccw.action, "Volume down");
  assert.equal(map.wheel.cw.action, "Volume up");
  assert.equal(map.orientationIndex, 0);
});
