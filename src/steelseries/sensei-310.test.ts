import assert from "node:assert/strict";
import test from "node:test";

import {
  SENSEI310_DPI_MAX,
  SENSEI310_DPI_MIN,
  SENSEI310_FIRMWARE_RESPONSE_LENGTH,
  SENSEI310_POLLING_RATES,
  Sensei310ProtocolError,
  steelseriesSensei310DecodeFirmware,
  steelseriesSensei310DpiOptions,
  steelseriesSensei310EncodeButtonsMapping,
  steelseriesSensei310EncodeLedColor,
  steelseriesSensei310EncodePollingRate,
  steelseriesSensei310EncodeSensitivity1,
  steelseriesSensei310EncodeSensitivity2,
  steelseriesSensei310FirmwareQuery,
  steelseriesSensei310SaveCommand,
} from "./sensei-310.ts";

test("DPI options are the full linear 100..12000 range in 100 DPI steps", () => {
  const options = steelseriesSensei310DpiOptions();
  assert.equal(options[0], SENSEI310_DPI_MIN);
  assert.equal(options.at(-1), SENSEI310_DPI_MAX);
  assert.equal(options.length, (SENSEI310_DPI_MAX - SENSEI310_DPI_MIN) / 100 + 1);
});

test("encodes sensitivity presets with the linear byte and command suffix", () => {
  // byte = (dpi - 100) / 100
  assert.deepEqual([...steelseriesSensei310EncodeSensitivity1(100)], [0x53, 0x00, 0x01, 0x00, 0x00, 0x42]);
  assert.deepEqual([...steelseriesSensei310EncodeSensitivity1(800)], [0x53, 0x00, 0x01, 0x07, 0x00, 0x42]);
  assert.deepEqual([...steelseriesSensei310EncodeSensitivity2(1600)], [0x53, 0x00, 0x02, 0x0f, 0x00, 0x42]);
  assert.deepEqual([...steelseriesSensei310EncodeSensitivity1(12000)], [0x53, 0x00, 0x01, 0x77, 0x00, 0x42]);
  assert.throws(() => steelseriesSensei310EncodeSensitivity1(150), Sensei310ProtocolError);
  assert.throws(() => steelseriesSensei310EncodeSensitivity2(12100), Sensei310ProtocolError);
});

test("encodes polling rates with the Rival 310 byte values", () => {
  assert.deepEqual([...steelseriesSensei310EncodePollingRate(1000)], [0x54, 0x00, 0x01]);
  assert.deepEqual([...steelseriesSensei310EncodePollingRate(500)], [0x54, 0x00, 0x02]);
  assert.deepEqual([...steelseriesSensei310EncodePollingRate(250)], [0x54, 0x00, 0x03]);
  assert.deepEqual([...steelseriesSensei310EncodePollingRate(125)], [0x54, 0x00, 0x04]);
  assert.deepEqual([...SENSEI310_POLLING_RATES], [125, 250, 500, 1000]);
  assert.throws(() => steelseriesSensei310EncodePollingRate(2000), Sensei310ProtocolError);
});

test("save and firmware query commands", () => {
  assert.deepEqual([...steelseriesSensei310SaveCommand()], [0x59, 0x00]);
  assert.deepEqual([...steelseriesSensei310FirmwareQuery()], [0x90, 0x00]);
  assert.equal(SENSEI310_FIRMWARE_RESPONSE_LENGTH, 2);
  assert.deepEqual(steelseriesSensei310DecodeFirmware(new Uint8Array([0x25, 0x00])), {
    bytes: [0x25, 0x00],
    display: "37.0",
  });
  assert.throws(() => steelseriesSensei310DecodeFirmware(new Uint8Array([0x25])), Sensei310ProtocolError);
});

test("LED color uses the 26-byte header plus 7-byte body", () => {
  const report = steelseriesSensei310EncodeLedColor("logo", 0xff, 0x00, 0x00);
  assert.equal(report.length, 2 + 26 + 7);
  assert.deepEqual([...report.slice(0, 2)], [0x5b, 0x00]);
  const header = report.slice(2, 28);
  assert.equal(header[0], 0x00); // led id (logo)
  assert.equal(header[1], 0xe8); // duration LE low byte (1000 = 0x03E8)
  assert.equal(header[2], 0x03); // duration LE high byte
  assert.equal(header[17], 0x01); // repeat
  assert.equal(header[21], 0x00); // triggers
  assert.equal(header[25], 0x01); // color count
  const body = report.slice(28);
  assert.deepEqual([...body], [0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00]);
});

test("wheel LED uses led id 0x01; other LED names are rejected", () => {
  const report = steelseriesSensei310EncodeLedColor("wheel", 0x00, 0xff, 0x00);
  assert.equal(report[2], 0x01);
  assert.throws(
    // @ts-expect-error invalid LED name
    () => steelseriesSensei310EncodeLedColor("strip", 0, 0, 0),
    Sensei310ProtocolError,
  );
  assert.throws(() => steelseriesSensei310EncodeLedColor("logo", 256, 0, 0), Sensei310ProtocolError);
});

test("button mapping covers eight slots, unlike Rival 310's six", () => {
  const report = steelseriesSensei310EncodeButtonsMapping({
    button1: { type: "button", target: "button1" },
    button7: { type: "button", target: "button7" },
    button8: { type: "dpiSwitch" },
  });
  assert.equal(report[0], 0x31);
  assert.equal(report[1], 0x00);
  assert.equal(report.length, 2 + 8 * 5);
  assert.equal(report[2], 0x01);
  assert.equal(report[2 + 0x1e], 0x07);
  assert.equal(report[2 + 0x23], 0x30);
});

test("button mapping rejects unknown buttons and bad codes", () => {
  assert.throws(
    // @ts-expect-error invalid button name
    () => steelseriesSensei310EncodeButtonsMapping({ button9: { type: "disabled" } }),
    Sensei310ProtocolError,
  );
  assert.throws(
    () => steelseriesSensei310EncodeButtonsMapping({
      button1: { type: "button", target: "button9" as never },
    }),
    Sensei310ProtocolError,
  );
  assert.throws(
    () => steelseriesSensei310EncodeButtonsMapping({ button1: { type: "keyboard", code: 300 } }),
    Sensei310ProtocolError,
  );
});
