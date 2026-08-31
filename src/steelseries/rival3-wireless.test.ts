import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL3_WIRELESS_BATTERY_RESPONSE_LENGTH,
  RIVAL3_WIRELESS_DPI_MAX,
  RIVAL3_WIRELESS_DPI_MIN,
  RIVAL3_WIRELESS_FIRMWARE_RESPONSE_LENGTH,
  RIVAL3_WIRELESS_MAX_DPI_PRESETS,
  Rival3WirelessProtocolError,
  steelseriesRival3WirelessBatteryQuery,
  steelseriesRival3WirelessDecodeBattery,
  steelseriesRival3WirelessDecodeFirmware,
  steelseriesRival3WirelessDpiOptions,
  steelseriesRival3WirelessEncodeButtonsMapping,
  steelseriesRival3WirelessEncodeDpiPresets,
  steelseriesRival3WirelessEncodePollingRate,
  steelseriesRival3WirelessFirmwareQuery,
  steelseriesRival3WirelessSaveCommand,
  TRUEMOVE_AIR_DPI_TO_BYTE,
} from "./rival3-wireless.ts";

test("DPI options mirror the TrueMove Air table, distinct from TrueMove Core", () => {
  const options = steelseriesRival3WirelessDpiOptions();
  assert.equal(options[0], RIVAL3_WIRELESS_DPI_MIN);
  assert.equal(options.at(-1), RIVAL3_WIRELESS_DPI_MAX);
  assert.equal(options.length, (RIVAL3_WIRELESS_DPI_MAX - RIVAL3_WIRELESS_DPI_MIN) / 100 + 1);
  // Pinned against rivalcfg/devices/dpi/truemove_air.py directly.
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(100), 0x00);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(400), 0x04);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(1600), 0x12);
  assert.equal(TRUEMOVE_AIR_DPI_TO_BYTE.get(18000), 0xd6);
  // Same DPI numbers, different bytes than TrueMove Core (rival3.ts).
  assert.notEqual(TRUEMOVE_AIR_DPI_TO_BYTE.get(400), 0x08); // Core's 400 DPI byte
  assert.notEqual(TRUEMOVE_AIR_DPI_TO_BYTE.get(1600), 0x24); // Core's 1600 DPI byte
});

test("encodes rivalcfg's default five-preset configuration byte for byte, two bytes per DPI", () => {
  // rivalcfg default "400, 800, 1200, 2400, 3200", first preset selected.
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeDpiPresets([400, 800, 1200, 2400, 3200], 0)],
    [0x20, 0x05, 0x01, 0x04, 0x00, 0x09, 0x00, 0x0d, 0x00, 0x1b, 0x00, 0x26, 0x00],
  );
  assert.deepEqual([...steelseriesRival3WirelessEncodeDpiPresets([100], 0)], [0x20, 0x01, 0x01, 0x00, 0x00]);
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeDpiPresets([18000], 0)],
    [0x20, 0x01, 0x01, 0xd6, 0x00],
  );
});

test("selects a non-first preset as 1-based on the wire", () => {
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeDpiPresets([400, 800], 1)],
    [0x20, 0x02, 0x02, 0x04, 0x00, 0x09, 0x00],
  );
});

test("rejects off-grid DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesRival3WirelessEncodeDpiPresets([150], 0), Rival3WirelessProtocolError);
  assert.throws(
    () => steelseriesRival3WirelessEncodeDpiPresets([], 0),
    new RegExp(`1–${RIVAL3_WIRELESS_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(
    () => steelseriesRival3WirelessEncodeDpiPresets([100, 100, 100, 100, 100, 100], 0),
    new RegExp(`1–${RIVAL3_WIRELESS_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesRival3WirelessEncodeDpiPresets([400, 800], -1), Rival3WirelessProtocolError);
  assert.throws(() => steelseriesRival3WirelessEncodeDpiPresets([400, 800], 2), Rival3WirelessProtocolError);
});

test("encodes every polling rate with the wireless-specific byte order and rejects unsupported rates", () => {
  assert.deepEqual([...steelseriesRival3WirelessEncodePollingRate(1000)], [0x17, 0x00]);
  assert.deepEqual([...steelseriesRival3WirelessEncodePollingRate(500)], [0x17, 0x01]);
  assert.deepEqual([...steelseriesRival3WirelessEncodePollingRate(250)], [0x17, 0x02]);
  assert.deepEqual([...steelseriesRival3WirelessEncodePollingRate(125)], [0x17, 0x03]);
  assert.throws(() => steelseriesRival3WirelessEncodePollingRate(2000), Rival3WirelessProtocolError);
});

test("frames the save, firmware, and battery commands distinctly from Rival 3 Gen 1's and Aerox 3's", () => {
  assert.deepEqual([...steelseriesRival3WirelessSaveCommand()], [0x09]);
  assert.deepEqual([...steelseriesRival3WirelessFirmwareQuery()], [0x90, 0x00]);
  assert.deepEqual([...steelseriesRival3WirelessBatteryQuery()], [0xaa, 0x01]);
});

test("decodes the two-byte firmware response in read order", () => {
  const firmware = steelseriesRival3WirelessDecodeFirmware(new Uint8Array([0x25, 0x01]));
  assert.deepEqual(firmware.bytes, [0x25, 0x01]);
  assert.equal(firmware.display, "37.1");
  assert.throws(
    () => steelseriesRival3WirelessDecodeFirmware(new Uint8Array([0x25])),
    Rival3WirelessProtocolError,
  );
  assert.equal(RIVAL3_WIRELESS_FIRMWARE_RESPONSE_LENGTH, 2);
});

test("decodes the three-byte battery response — level from byte 0, charging from byte 2", () => {
  const idle = steelseriesRival3WirelessDecodeBattery(new Uint8Array([72, 0x00, 0x00]));
  assert.deepEqual(idle, { level: 72, isCharging: false });
  const charging = steelseriesRival3WirelessDecodeBattery(new Uint8Array([100, 0xff, 0x01]));
  assert.deepEqual(charging, { level: 100, isCharging: true });
  assert.throws(
    () => steelseriesRival3WirelessDecodeBattery(new Uint8Array([1, 2])),
    Rival3WirelessProtocolError,
  );
  assert.equal(RIVAL3_WIRELESS_BATTERY_RESPONSE_LENGTH, 3);
});

test("buttons mapping encodes remap targets, special actions, and keyboard/multimedia codes", () => {
  const zeros = () => new Array(30).fill(0x00);

  const dpiSwitch = zeros();
  dpiSwitch[0x19] = 0x30;
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeButtonsMapping({ button6: { type: "dpiSwitch" } })],
    [0x19, ...dpiSwitch],
  );

  const scrolls = zeros();
  scrolls[0x00] = 0x31;
  scrolls[0x05] = 0x32;
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeButtonsMapping({
      button1: { type: "scrollUp" },
      button2: { type: "scrollDown" },
    })],
    [0x19, ...scrolls],
  );

  const swapped = zeros();
  swapped[0x00] = 0x02; // button1 -> button2's id
  swapped[0x05] = 0x01; // button2 -> button1's id
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeButtonsMapping({
      button1: { type: "button", target: "button2" },
      button2: { type: "button", target: "button1" },
    })],
    [0x19, ...swapped],
  );

  const disabled = zeros();
  disabled[0x0a] = 0x00;
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeButtonsMapping({ button3: { type: "disabled" } })],
    [0x19, ...disabled],
  );

  const keyboard = zeros();
  keyboard[0x0f] = 0x51;
  keyboard[0x10] = 0x04;
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeButtonsMapping({ button4: { type: "keyboard", code: 0x04 } })],
    [0x19, ...keyboard],
  );

  const multimedia = zeros();
  multimedia[0x14] = 0x61;
  multimedia[0x15] = 0xcd;
  assert.deepEqual(
    [...steelseriesRival3WirelessEncodeButtonsMapping({ button5: { type: "multimedia", code: 0xcd } })],
    [0x19, ...multimedia],
  );
});

test("rejects unknown buttons and out-of-range scan codes before producing a packet", () => {
  assert.throws(
    () => steelseriesRival3WirelessEncodeButtonsMapping({ ["scrollUp" as never]: { type: "disabled" } }),
    Rival3WirelessProtocolError,
  );
  assert.throws(
    () => steelseriesRival3WirelessEncodeButtonsMapping({ button1: { type: "keyboard", code: 999 } }),
    Rival3WirelessProtocolError,
  );
  assert.throws(
    () => steelseriesRival3WirelessEncodeButtonsMapping({ button1: { type: "multimedia", code: -1 } }),
    Rival3WirelessProtocolError,
  );
});
