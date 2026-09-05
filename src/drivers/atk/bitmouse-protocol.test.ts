import assert from "node:assert/strict";
import test from "node:test";

import {
  bitmouseAddressDataRequest,
  bitmouseChecksum,
  bitmouseDecodeCidMid,
  bitmouseDecodeConfig,
  bitmouseDecodeDeviceType,
  bitmouseDecodeDpiBlock,
  bitmouseDecodePollingRate,
  bitmouseDecodeReply,
  bitmouseDecodeVersion,
  bitmouseDpiBlockAddresses,
  bitmouseDecodeLiftOffLevel,
  bitmouseLiftOffCode,
  bitmouseLiftOffMillimetres,
  bitmouseDecodeSensorMode,
  bitmouseDpiOptions,
  bitmouseEnabledStages,
  bitmouseEncodePollingRate,
  bitmouseEncodeRequest,
  bitmouseEncodeSensorMode,
  bitmouseSetDpiRequest,
  bitmouseSetFarDistanceRequest,
  bitmouseSetLiftOffRequest,
  bitmouseSetSensorModeRequest,
  bitmouseSetSleepRequest,
  BITMOUSE_COMMAND,
  BITMOUSE_COMMAND_CODE,
  BITMOUSE_ADDRESS,
  BITMOUSE_DPI_RANGES,
  BITMOUSE_FRAME_LENGTH,
  BITMOUSE_LENGTHS,
  BITMOUSE_TARGET,
} from "@openmouse/protocol/bitmouse";

/** Pads a captured reply prefix out to the 63 bytes the device really sends. */
function reply(...bytes: number[]): Uint8Array {
  const frame = new Uint8Array(BITMOUSE_FRAME_LENGTH);
  frame.set(bytes);
  return frame;
}

test("a request carries the command code, target and a trailing-sum checksum", () => {
  const [paramLen, cmdLen] = BITMOUSE_LENGTHS.getDeviceVersion;
  const frame = bitmouseEncodeRequest({
    commandId: BITMOUSE_COMMAND.getDeviceVersion,
    paramLen,
    cmdLen,
    target: BITMOUSE_TARGET.mouseBehindReceiver,
  });

  assert.equal(frame.length, BITMOUSE_FRAME_LENGTH);
  assert.equal(frame[1], BITMOUSE_COMMAND_CODE);
  assert.equal(frame[2], 5);
  assert.equal(frame[4], BITMOUSE_TARGET.mouseBehindReceiver);
  assert.equal(frame[5], BITMOUSE_COMMAND.getDeviceVersion);
  assert.equal(frame[6], 3);
  assert.equal(frame[0], bitmouseChecksum(frame));
});

test("requests address the device directly unless a target is given", () => {
  const frame = bitmouseEncodeRequest({ commandId: BITMOUSE_COMMAND.getBatteryLevel, paramLen: 2, cmdLen: 1 });

  assert.equal(frame[4], BITMOUSE_TARGET.device);
});

test("a payload longer than the frame is refused rather than truncated", () => {
  assert.throws(() => bitmouseEncodeRequest({
    commandId: BITMOUSE_COMMAND.setDpi,
    paramLen: 12,
    cmdLen: 10,
    payload: new Array(57).fill(0),
  }), /at most 56 bytes/);
});

/**
 * Captured from an ATK ZERO over its receiver. Everything past the reported
 * length is the previous exchange's payload, still sitting in the buffer.
 */
test("a reply is trimmed to the length the device reports", () => {
  const frame = reply(0x72, 0x00, 0x3a, 0x00, 0x1a, 0x01,
    0x03, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x08, 0x07, 0x04);
  const decoded = bitmouseDecodeReply(frame);

  assert.ok(decoded);
  assert.equal(decoded.commandId, BITMOUSE_COMMAND.getDeviceType);
  assert.equal(decoded.isError, false);
  assert.deepEqual([...decoded.payload], [0x03]);
  assert.equal(bitmouseDecodeDeviceType(decoded.payload[0]!), "wired8K");
});

test("replies that are truncated or not BITMOUSE frames are rejected", () => {
  assert.equal(bitmouseDecodeReply(new Uint8Array([0x72, 0x00])), null);
  assert.equal(bitmouseDecodeReply(reply(0x55, 0x00, 0x3a, 0x00, 0x1c, 0x03)), null);
});

test("a reply claiming more bytes than it carries is clamped", () => {
  const decoded = bitmouseDecodeReply(new Uint8Array([0x72, 0x00, 0x3a, 0x00, 0x1c, 0x40, 0x03, 0x00]));

  assert.ok(decoded);
  assert.deepEqual([...decoded.payload], [0x03, 0x00]);
});

test("an error status is surfaced", () => {
  const decoded = bitmouseDecodeReply(reply(0x72, 0xff, 0x3a, 0x00, 0x1c, 0x00));

  assert.ok(decoded);
  assert.equal(decoded.isError, true);
});

test("polling-rate codes round trip", () => {
  for (const hertz of [125, 250, 500, 1000, 2000, 4000, 8000]) {
    assert.equal(bitmouseDecodePollingRate(bitmouseEncodePollingRate(hertz)!), hertz);
  }
  assert.equal(bitmouseEncodePollingRate(3000), null);
  assert.equal(bitmouseDecodePollingRate(0x7f), null);
});

/** Captured with the mouse on 2000 Hz, motion sync on, 30 min sleep, 4 ms debounce. */
test("the config block decodes a captured ATK ZERO reply", () => {
  const frame = reply(0x72, 0x00, 0x3a, 0x00, 0x09, 0x11,
    0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x08, 0x07, 0x04,
    0x00, 0x00, 0x00, 0x00, 0x00);
  const decoded = bitmouseDecodeReply(frame);
  const config = bitmouseDecodeConfig(decoded!.payload);

  assert.deepEqual(config, {
    profile: 0,
    configVersion: 0,
    pollingRateHz: 2000,
    silentHeight: 0,
    offsetCalibration: 0,
    motionSync: true,
    linearCorrection: true,
    rippleControl: true,
    sleepSeconds: 1800,
    debounceMs: 4,
  });
});

test("a config payload shorter than the fields it needs decodes to null", () => {
  assert.equal(bitmouseDecodeConfig(new Uint8Array(11)), null);
});

test("CID/MID identifies the model", () => {
  const decoded = bitmouseDecodeReply(reply(0x72, 0x00, 0x3a, 0x00, 0x4a, 0x06,
    0x00, 0x01, 0x01, 0x00, 0x00, 0x00));

  assert.deepEqual(bitmouseDecodeCidMid(decoded!.payload), { cid: 1, mid: 1 });
  assert.equal(bitmouseDecodeCidMid(new Uint8Array(5)), null);
});

test("versions decode from the captured mouse and dongle replies", () => {
  const mouse = bitmouseDecodeReply(reply(0x72, 0x00, 0x3a, 0x00, 0x1c, 0x03, 0x03, 0x00, 0x03, 0xff));
  const dongle = bitmouseDecodeReply(reply(0x72, 0x00, 0x3a, 0x00, 0x88, 0x03, 0x03, 0x00, 0x02, 0x43));

  assert.equal(bitmouseDecodeVersion(mouse!.payload), "3.0.3");
  assert.equal(bitmouseDecodeVersion(dongle!.payload), "3.0.2");
  assert.equal(bitmouseDecodeVersion(new Uint8Array(2)), null);
});

test("the DPI table is swept in ten-byte chunks from address one", () => {
  assert.deepEqual(bitmouseDpiBlockAddresses(), [1, 11, 21, 31, 41, 51, 61]);

  const request = bitmouseAddressDataRequest(11, 10);
  const frame = bitmouseEncodeRequest(request);

  assert.equal(frame[5], BITMOUSE_COMMAND.getAddressData);
  assert.deepEqual([...frame.slice(7, 10)], [11, 0, 10]);
});

test("DPI stages decode little-endian with the colour stored blue first", () => {
  const block = new Uint8Array(2 + 8 * 8);
  block[0] = 1;
  block[1] = 4;
  block.set([0x40, 0x06, 0x40, 0x06, 0x11, 0x22, 0x33, 0x01], 2);       // stage 0: 1600
  block.set([0x20, 0x03, 0xe8, 0x03, 0x00, 0x00, 0x00, 0x00], 2 + 8);   // stage 1: 800 x 1000

  const decoded = bitmouseDecodeDpiBlock(block);

  assert.equal(decoded!.currentIndex, 1);
  assert.equal(decoded!.stageCount, 4);
  assert.deepEqual(decoded!.stages[0], { x: 1600, y: 1600, blue: 0x11, green: 0x22, red: 0x33, reserved: 1 });
  assert.deepEqual(decoded!.stages[1], { x: 800, y: 1000, blue: 0, green: 0, red: 0, reserved: 0 });
  assert.equal(bitmouseDecodeDpiBlock(new Uint8Array(20)), null);
});

test("a DPI write mirrors the layout the table is read back in", () => {
  const frame = bitmouseEncodeRequest(bitmouseSetDpiRequest({
    index: 2, x: 1600, y: 800, red: 0x33, green: 0x22, blue: 0x11, enable: true,
  }));

  assert.equal(frame[5], BITMOUSE_COMMAND.setDpi);
  assert.deepEqual([...frame.slice(7, 17)], [2, 0x40, 0x06, 0x20, 0x03, 0x11, 0x22, 0x33, 0x00, 0x01]);
});

/**
 * Captured from an ATK ZERO holding two configured stages. Byte 1 still reads
 * 8, so the count field cannot be trusted to mean "enabled".
 */
test("only the stages carrying a DPI value are treated as enabled", () => {
  const captured = [
    0x00, 0x08,
    0x20, 0x03, 0x20, 0x03, 0x00, 0x00, 0xff, 0x00,
    0x90, 0x01, 0x90, 0x01, 0x00, 0x00, 0xff, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x90, 0x01, 0x90, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00,
    ...new Array(32).fill(0),
  ];
  const block = bitmouseDecodeDpiBlock(captured);

  assert.equal(block!.currentIndex, 0);
  assert.equal(block!.stageCount, 8);
  assert.equal(block!.stages[0]!.x, 800);
  assert.equal(block!.stages[1]!.x, 400);

  const enabled = bitmouseEnabledStages(block!);

  assert.equal(enabled.length, 2);
  assert.deepEqual(enabled.map((stage) => stage.x), [800, 400]);
  // Colour bytes survive in the empty slots, so DPI is the only usable signal.
  assert.equal(block!.stages[2]!.red, 0x90);
});

/**
 * The stored record is eight bytes, and a write prefixes it with the stage
 * index — so the write byte that lines up with the record's last byte is the
 * literal 0 at +8, and `enable` at +9 has no counterpart in the table at all.
 * Reading the record's last byte back as an enable flag is what made a DPI
 * write store the value without the sensor ever adopting it.
 */
test("enable is a command bit, not the record byte that reads back as reserved", () => {
  const on = bitmouseEncodeRequest(bitmouseSetDpiRequest({
    index: 0, x: 800, y: 800, red: 0xff, green: 0, blue: 0, enable: true,
  }));
  const off = bitmouseEncodeRequest(bitmouseSetDpiRequest({
    index: 0, x: 800, y: 800, red: 0xff, green: 0, blue: 0, enable: false,
  }));

  // Frame offset 7 is payload[0]; the record byte and the enable bit follow.
  assert.equal(on[7 + 8], 0, "the byte the table stores stays a literal zero");
  assert.equal(on[7 + 9], 1);
  assert.equal(off[7 + 9], 0);
});

test("the PAW3950 Ultra DPI ladder changes step at 10k and 30k", () => {
  const options = bitmouseDpiOptions(BITMOUSE_DPI_RANGES.PAW3950Ultra);

  assert.equal(options[0], 10);
  assert.equal(options[options.length - 1], 42000);
  assert.ok(options.includes(1600));
  assert.ok(options.includes(10050));
  assert.ok(options.includes(30100));
  assert.ok(!options.includes(10025));
  assert.ok(!options.includes(30050));
  // Strictly ascending, no duplicates.
  assert.ok(options.every((dpi, index) => index === 0 || dpi > options[index - 1]!));
});

test("sleep is written as little-endian seconds", () => {
  const frame = bitmouseEncodeRequest(bitmouseSetSleepRequest(1800));

  assert.equal(frame[5], BITMOUSE_COMMAND.setSensorSleepTime);
  assert.deepEqual([...frame.slice(7, 9)], [0x08, 0x07]);
});

/**
 * The vendor software shows lift-off as a 0.7-1.7 mm slider. That is the A9
 * register scale: tenths of a millimetre offset by six, carried here in the
 * config block's offsetCalibration byte rather than its silentHeight byte,
 * which reads zero on an ATK ZERO.
 */
test("lift-off codes are tenths of a millimetre offset by six", () => {
  assert.equal(bitmouseLiftOffMillimetres(1), 0.7);
  assert.equal(bitmouseLiftOffMillimetres(4), 1);
  assert.equal(bitmouseLiftOffMillimetres(11), 1.7);
  assert.equal(bitmouseLiftOffMillimetres(0), null);

  for (const mm of [0.7, 1, 1.2, 1.7]) {
    assert.equal(bitmouseLiftOffMillimetres(bitmouseLiftOffCode(mm)), mm);
  }
});

test("lift-off is carried by offsetCalibration, not the silentHeight byte", () => {
  // An ATK ZERO reporting offsetCalibration 0 is sitting at 0.7 mm.
  assert.equal(bitmouseDecodeLiftOffLevel(0), 1);
  assert.equal(bitmouseLiftOffMillimetres(bitmouseDecodeLiftOffLevel(0)), 0.7);

  const frame = bitmouseEncodeRequest(bitmouseSetLiftOffRequest(11));

  assert.equal(frame[5], BITMOUSE_COMMAND.setSilentHeight);
  assert.deepEqual([...frame.slice(7, 9)], [0, 10]);
});

test("a lift-off code outside the register range is refused", () => {
  assert.throws(() => bitmouseSetLiftOffRequest(0), /runs 1 to 11/);
  assert.throws(() => bitmouseSetLiftOffRequest(12), /runs 1 to 11/);
});

test("sensor sampling modes round trip across the vendor's three codes", () => {
  for (const name of ["Eco", "High", "Ultra"] as const) {
    assert.equal(bitmouseDecodeSensorMode(bitmouseEncodeSensorMode(name)!), name);
  }
  assert.equal(bitmouseDecodeSensorMode(3), null);
  assert.equal(bitmouseEncodeSensorMode("Turbo"), null);

  const frame = bitmouseEncodeRequest(bitmouseSetSensorModeRequest(bitmouseEncodeSensorMode("Ultra")!));

  assert.equal(frame[5], BITMOUSE_COMMAND.setSensorModel);
  assert.equal(frame[7], 5);
});

test("long-range mode is a one-byte write read back from its own address", () => {
  assert.equal(BITMOUSE_ADDRESS.farDistance, 75);
  assert.equal(BITMOUSE_ADDRESS.sensorModel, 74);

  const on = bitmouseEncodeRequest(bitmouseSetFarDistanceRequest(true));
  const off = bitmouseEncodeRequest(bitmouseSetFarDistanceRequest(false));

  assert.equal(on[5], BITMOUSE_COMMAND.setFarDistance);
  assert.equal(on[7], 1);
  assert.equal(off[7], 0);
});
