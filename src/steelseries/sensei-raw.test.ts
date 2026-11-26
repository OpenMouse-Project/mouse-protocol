import assert from "node:assert/strict";
import test from "node:test";

import {
  SENSEI_RAW_BRIGHTNESS_TO_BYTE,
  SENSEI_RAW_DEFAULT_DPI_PRESET_1,
  SENSEI_RAW_DEFAULT_DPI_PRESET_2,
  SENSEI_RAW_DEFAULT_POLLING_RATE,
  SENSEI_RAW_DPI_MAX,
  SENSEI_RAW_DPI_MIN,
  SENSEI_RAW_EFFECT_TO_BYTE,
  SENSEI_RAW_POLLING_RATES,
  SenseiRawProtocolError,
  steelseriesSenseiRawActiveCpiQuery,
  steelseriesSenseiRawDecodeFirmware,
  steelseriesSenseiRawDpiOptions,
  steelseriesSenseiRawEncodeButtonsMapping,
  steelseriesSenseiRawEncodeLedBrightness,
  steelseriesSenseiRawEncodeLedEffect,
  steelseriesSenseiRawEncodePollingRate,
  steelseriesSenseiRawEncodeSensitivity1,
  steelseriesSenseiRawEncodeSensitivity2,
  steelseriesSenseiRawFirmwareQuery,
  steelseriesSenseiRawSaveCommand,
} from "./sensei-raw.ts";

test("DPI options are the linear 90..5670 range in 90 DPI steps", () => {
  const options = steelseriesSenseiRawDpiOptions();
  assert.equal(options[0], SENSEI_RAW_DPI_MIN);
  assert.equal(options.at(-1), SENSEI_RAW_DPI_MAX);
  assert.equal(options.length, (SENSEI_RAW_DPI_MAX - SENSEI_RAW_DPI_MIN) / 90 + 1);
  assert.equal(options.length, 63);
  assert.equal(SENSEI_RAW_DEFAULT_DPI_PRESET_1, 1620);
  assert.equal(SENSEI_RAW_DEFAULT_DPI_PRESET_2, 3240);
  assert.equal(SENSEI_RAW_DEFAULT_POLLING_RATE, 1000);
});

test("encodes sensitivity presets with the linear+1 byte", () => {
  // byte = (dpi - 90) / 90 + 1
  assert.deepEqual([...steelseriesSenseiRawEncodeSensitivity1(90)], [0x03, 0x01, 0x01]);
  assert.deepEqual([...steelseriesSenseiRawEncodeSensitivity1(1620)], [0x03, 0x01, 0x12]);
  assert.deepEqual([...steelseriesSenseiRawEncodeSensitivity2(3240)], [0x03, 0x02, 0x24]);
  assert.deepEqual([...steelseriesSenseiRawEncodeSensitivity1(5670)], [0x03, 0x01, 0x3f]);
  assert.throws(() => steelseriesSenseiRawEncodeSensitivity1(135), SenseiRawProtocolError);
  assert.throws(() => steelseriesSenseiRawEncodeSensitivity2(5760), SenseiRawProtocolError);
});

test("polling, save, firmware, and active-CPI queries", () => {
  assert.deepEqual([...steelseriesSenseiRawEncodePollingRate(1000)], [0x04, 0x00, 0x01]);
  assert.deepEqual([...steelseriesSenseiRawEncodePollingRate(125)], [0x04, 0x00, 0x04]);
  assert.deepEqual([...SENSEI_RAW_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesSenseiRawEncodePollingRate(2000), SenseiRawProtocolError);
  assert.deepEqual([...steelseriesSenseiRawSaveCommand()], [0x09, 0x00]);
  assert.deepEqual([...steelseriesSenseiRawFirmwareQuery()], [0x10, 0x00]);
  assert.deepEqual([...steelseriesSenseiRawActiveCpiQuery()], [0x16, 0x00]);
  assert.deepEqual(steelseriesSenseiRawDecodeFirmware(new Uint8Array([0x03, 0x01])), {
    bytes: [0x03, 0x01],
    display: "1.3",
  });
  assert.throws(() => steelseriesSenseiRawDecodeFirmware(new Uint8Array([0x03])), SenseiRawProtocolError);
});

test("LED brightness and effect are choice encodings on the single LED", () => {
  assert.deepEqual([...steelseriesSenseiRawEncodeLedBrightness("off")], [0x05, 0x01, 0x01]);
  assert.deepEqual([...steelseriesSenseiRawEncodeLedBrightness("high")], [0x05, 0x01, 0x04]);
  assert.deepEqual([...steelseriesSenseiRawEncodeLedEffect("steady")], [0x07, 0x01, 0x01]);
  assert.deepEqual([...steelseriesSenseiRawEncodeLedEffect("trigger")], [0x07, 0x01, 0x05]);
  assert.throws(() => steelseriesSenseiRawEncodeLedBrightness("max" as never), SenseiRawProtocolError);
  assert.throws(() => steelseriesSenseiRawEncodeLedEffect("pulse" as never), SenseiRawProtocolError);
  assert.deepEqual(SENSEI_RAW_BRIGHTNESS_TO_BYTE, { off: 0x01, low: 0x02, medium: 0x03, high: 0x04 });
  assert.deepEqual(SENSEI_RAW_EFFECT_TO_BYTE, { steady: 0x01, breath: 0x03, trigger: 0x05 });
});

test("button mapping covers eight 3-byte slots with rivalcfg's offset order", () => {
  const report = steelseriesSenseiRawEncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button6: { type: "dpiSwitch" },
    button7: { type: "keyboard", code: 0x4a }, // H
  });
  assert.equal(report[0], 0x31);
  assert.equal(report[1], 0x00);
  assert.equal(report.length, 2 + 8 * 3);
  assert.equal(report[2 + 0x12], 0x30); // button6 -> dpi switch
  assert.equal(report[2 + 0x0f], 0x10); // button7 -> keyboard
  assert.equal(report[2 + 0x0f + 1], 0x4a);
});

test("button mapping rejects unknown slots and bad codes", () => {
  assert.throws(
    () => steelseriesSenseiRawEncodeButtonsMapping({ ["button9" as never]: { type: "disabled" } }),
    SenseiRawProtocolError,
  );
  assert.throws(
    () => steelseriesSenseiRawEncodeButtonsMapping({ button1: { type: "multimedia", code: 300 } }),
    SenseiRawProtocolError,
  );
});
