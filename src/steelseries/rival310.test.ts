import assert from "node:assert/strict";
import test from "node:test";

import {
  RIVAL310_DPI_MAX,
  RIVAL310_DPI_MIN,
  RIVAL310_SAVE_COMMAND,
  SteelSeriesRival310ProtocolError,
  steelseriesRival310DecodeFirmware,
  steelseriesRival310DpiOptions,
  steelseriesRival310EncodeButtonsMapping,
  steelseriesRival310EncodeLedColor,
  steelseriesRival310EncodePollingRate,
  steelseriesRival310EncodeSensitivity1,
  steelseriesRival310EncodeSensitivity2,
  steelseriesRival310FirmwareQuery,
  steelseriesRival310SaveCommand,
} from "./rival310.ts";

test("DPI options are the full linear 100..12000 range in 100 DPI steps", () => {
  const options = steelseriesRival310DpiOptions();
  assert.equal(options[0], RIVAL310_DPI_MIN);
  assert.equal(options.at(-1), RIVAL310_DPI_MAX);
  assert.equal(options.length, (RIVAL310_DPI_MAX - RIVAL310_DPI_MIN) / 100 + 1);
});

test("encodes sensitivity presets with the linear byte and command suffix", () => {
  // byte = (dpi - 100) / 100
  assert.deepEqual([...steelseriesRival310EncodeSensitivity1(100)], [0x53, 0x00, 0x01, 0x00, 0x00, 0x42]);
  assert.deepEqual([...steelseriesRival310EncodeSensitivity1(800)], [0x53, 0x00, 0x01, 0x07, 0x00, 0x42]);
  assert.deepEqual([...steelseriesRival310EncodeSensitivity2(1600)], [0x53, 0x00, 0x02, 0x0f, 0x00, 0x42]);
  assert.deepEqual([...steelseriesRival310EncodeSensitivity1(12000)], [0x53, 0x00, 0x01, 0x77, 0x00, 0x42]);
});

test("rejects out-of-range and off-grid DPI", () => {
  assert.throws(() => steelseriesRival310EncodeSensitivity1(50), SteelSeriesRival310ProtocolError);
  assert.throws(() => steelseriesRival310EncodeSensitivity1(13000), SteelSeriesRival310ProtocolError);
  assert.throws(() => steelseriesRival310EncodeSensitivity1(850), SteelSeriesRival310ProtocolError);
  assert.throws(() => steelseriesRival310EncodeSensitivity2(850), SteelSeriesRival310ProtocolError);
});

test("encodes every polling rate and rejects rates the mouse does not offer", () => {
  assert.deepEqual([...steelseriesRival310EncodePollingRate(1000)], [0x54, 0x00, 0x01]);
  assert.deepEqual([...steelseriesRival310EncodePollingRate(500)], [0x54, 0x00, 0x02]);
  assert.deepEqual([...steelseriesRival310EncodePollingRate(250)], [0x54, 0x00, 0x03]);
  assert.deepEqual([...steelseriesRival310EncodePollingRate(125)], [0x54, 0x00, 0x04]);
  assert.throws(() => steelseriesRival310EncodePollingRate(2000), SteelSeriesRival310ProtocolError);
});

test("frames the save and firmware commands", () => {
  assert.deepEqual([...steelseriesRival310SaveCommand()], [0x59, 0x00]);
  assert.deepEqual([...RIVAL310_SAVE_COMMAND], [0x59, 0x00]);
  assert.deepEqual([...steelseriesRival310FirmwareQuery()], [0x90, 0x00]);
});

test("decodes the two-byte firmware response in read order", () => {
  const firmware = steelseriesRival310DecodeFirmware(new Uint8Array([0x00, 0x37]));
  assert.deepEqual(firmware.bytes, [0x00, 0x37]);
  assert.equal(firmware.display, "0.55");
  assert.throws(() => steelseriesRival310DecodeFirmware(new Uint8Array([0x01])), SteelSeriesRival310ProtocolError);
});

test("encodes a steady LED color: 5B 00 + 26-byte header + 7-byte body", () => {
  const report = steelseriesRival310EncodeLedColor("logo", 0xff, 0x00, 0x00);
  assert.equal(report.length, 2 + 26 + 7);
  // command
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
  const report = steelseriesRival310EncodeLedColor("wheel", 0x00, 0xff, 0x00);
  assert.equal(report[2], 0x01);
  // @ts-expect-error invalid LED
  assert.throws(() => steelseriesRival310EncodeLedColor("scroll", 0, 0, 0), SteelSeriesRival310ProtocolError);
  assert.throws(() => steelseriesRival310EncodeLedColor("logo", 256, 0, 0), SteelSeriesRival310ProtocolError);
  assert.throws(() => steelseriesRival310EncodeLedColor("logo", -1, 0, 0), SteelSeriesRival310ProtocolError);
});

test("encodes buttons mapping: mouse-button target, special actions, keyboard/multimedia codes", () => {
  const report = steelseriesRival310EncodeButtonsMapping({
    button1: { type: "button", target: "button2" },
    button2: { type: "disabled" },
    button3: { type: "dpiSwitch" },
    button4: { type: "scrollUp" },
    button5: { type: "scrollDown" },
    button6: { type: "keyboard", code: 0x04 },
  });
  assert.deepEqual([...report.slice(0, 2)], [0x31, 0x00]);
  const packet = report.slice(2);
  assert.equal(packet.length, 30);
  assert.equal(packet[0x00], 0x02); // button1 -> button2's id
  assert.equal(packet[0x05], 0x00); // button2 -> disabled
  assert.equal(packet[0x0a], 0x30); // button3 -> dpi switch
  assert.equal(packet[0x0f], 0x31); // button4 -> scroll up
  assert.equal(packet[0x14], 0x32); // button5 -> scroll down
  assert.equal(packet[0x19], 0x51); // button6 -> keyboard
  assert.equal(packet[0x1a], 0x04); // button6 scan code
});

test("encodes a multimedia button action and leaves unmapped buttons zeroed", () => {
  const report = steelseriesRival310EncodeButtonsMapping({
    button1: { type: "multimedia", code: 0xcd },
  });
  const packet = report.slice(2);
  assert.equal(packet[0x00], 0x61);
  assert.equal(packet[0x01], 0xcd);
  for (let i = 5; i < 30; i++) assert.equal(packet[i], 0x00);
});

test("rejects unknown buttons, unknown targets, and out-of-range scan codes", () => {
  assert.throws(
    // @ts-expect-error invalid button name
    () => steelseriesRival310EncodeButtonsMapping({ button9: { type: "disabled" } }),
    SteelSeriesRival310ProtocolError,
  );
  assert.throws(
    // @ts-expect-error invalid target
    () => steelseriesRival310EncodeButtonsMapping({ button1: { type: "button", target: "button9" } }),
    SteelSeriesRival310ProtocolError,
  );
  assert.throws(
    () => steelseriesRival310EncodeButtonsMapping({ button1: { type: "keyboard", code: 300 } }),
    SteelSeriesRival310ProtocolError,
  );
  assert.throws(
    () => steelseriesRival310EncodeButtonsMapping({ button1: { type: "multimedia", code: -1 } }),
    SteelSeriesRival310ProtocolError,
  );
});
