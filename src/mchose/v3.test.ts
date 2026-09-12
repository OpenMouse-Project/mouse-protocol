import assert from "node:assert/strict";
import test from "node:test";
import {
  MCHOSE_V3_BODY_LENGTH,
  MCHOSE_V3_BUTTON_ACTIONS,
  MCHOSE_V3_BUTTON_UNSET,
  MCHOSE_V3_SENSOR_MOTION_SYNC,
  MCHOSE_V3_SENSOR_RIPPLE,
  mchoseV3ButtonAction,
  mchoseV3CheckSettings,
  mchoseV3EncodeButtons,
  mchoseV3EncodeDpiTable,
  mchoseV3EncodeLiftOff,
  mchoseV3EncodeSensor,
  mchoseV3RoundDpi,
  MCHOSE_V3_COMMAND,
  MCHOSE_V3_MODES,
  MCHOSE_V3_PRODUCTS,
  mchoseV3DecodeButtons,
  mchoseV3DecodeDeviceInfo,
  mchoseV3DecodeDpi,
  mchoseV3DecodeLiftOff,
  mchoseV3DecodeSensor,
  mchoseV3DecodeSettings,
  mchoseV3Encode,
  mchoseV3EncodeSettings,
  mchoseV3FindProduct,
  mchoseV3IsProductId,
  mchoseV3LiftOffLabels,
  mchoseV3LiftOffStop,
  mchoseV3OptionToRateIndex,
  mchoseV3Payload,
  mchoseV3PollingRates,
  mchoseV3RateIndexToOption,
  type MchoseV3Settings,
} from "./v3.ts";
import { MCHOSE_LOD_MASK, mchoseDecodeConfig } from "./index.ts";

/** Wrap a data block in the reply framing the mouse sends back. */
function reply(command: number, data: readonly number[]): Uint8Array {
  const body = new Uint8Array(MCHOSE_V3_BODY_LENGTH);
  body[0] = 0x01;
  body[1] = 0x01;
  body[2] = data.length;
  body[3] = command & 0xff;
  body[4] = (command >> 8) & 0xff;
  body.set(data, 7);
  let sum = 0;
  for (let index = 1; index <= 6 + data.length; index += 1) sum ^= body[index]!;
  body[7 + data.length] = sum;
  return body;
}

test("a request frame carries the M magic's header and a checksum", () => {
  const body = mchoseV3Encode(MCHOSE_V3_COMMAND.readDeviceInfo);
  // The 0x4d magic is the report id and is not part of the body.
  assert.equal(body.length, MCHOSE_V3_BODY_LENGTH);
  assert.equal(body[0], 0x01, "protocol version");
  assert.equal(body[1], 0x01, "checksum flag");
  assert.equal(body[2], 0, "no data");
  assert.equal(body[3], 0x00, "command low byte");
  assert.equal(body[4], 0x09, "command high byte");
  // XOR of bytes 1..6 = 0x01 ^ 0 ^ 0x00 ^ 0x09 ^ 0 ^ 0 = 0x08.
  assert.equal(body[7], 0x08, "checksum lands right after the empty data block");
});

test("the command id goes out little-endian", () => {
  const body = mchoseV3Encode(MCHOSE_V3_COMMAND.writeLiftOff, [0, 3]);
  assert.equal(body[3], 0x09);
  assert.equal(body[4], 0x01);
  assert.equal(body[2], 2, "data length");
  assert.deepEqual([...body.subarray(7, 9)], [0, 3]);
});

test("data too long to leave room for the checksum is refused, not truncated", () => {
  // 56 bytes fit; 57 would push the checksum past the end of the body.
  assert.doesNotThrow(() => mchoseV3Encode(0x0001, new Array<number>(55).fill(1)));
  assert.throws(() => mchoseV3Encode(0x0001, new Array<number>(57).fill(1)), RangeError);
});

test("a reply is matched on its command id and rejected on a bad checksum", () => {
  const frame = reply(MCHOSE_V3_COMMAND.readLiftOff, [3]);
  assert.deepEqual([...mchoseV3Payload(frame, MCHOSE_V3_COMMAND.readLiftOff)!], [3]);
  assert.equal(
    mchoseV3Payload(frame, MCHOSE_V3_COMMAND.readSettings), null,
    "a frame answering another command is not this command's payload",
  );

  const corrupted = Uint8Array.from(frame);
  corrupted[8] = (corrupted[8]! ^ 0xff) & 0xff;
  assert.equal(mchoseV3Payload(corrupted, MCHOSE_V3_COMMAND.readLiftOff), null);
});

test("a reply that claims no checksum is still accepted on its command id", () => {
  const frame = reply(MCHOSE_V3_COMMAND.readLiftOff, [2]);
  frame[1] = 0x00;
  assert.deepEqual([...mchoseV3Payload(frame, MCHOSE_V3_COMMAND.readLiftOff)!], [2]);
});

test("device info yields the mouse's own product id, not the receiver's", () => {
  const info = mchoseV3DecodeDeviceInfo(new Uint8Array([
    0x37, 0x38, // vendor 0x3837
    0x33, 0x40, // product 0x4033 — an A7 V3 Ultra+ behind its receiver
    0x03, 0x01, 0x00, 0x04, 0x20, 0x00, 0x01, 0x00, 0x57, 0x02,
  ]))!;
  assert.equal(info.vendorId, 0x3837);
  assert.equal(info.productId, 0x4033);
  assert.equal(info.profileCount, 3);
  assert.equal(info.connectStatus, 1);
  assert.equal(info.chargeStatus, 0);
  assert.equal(info.batteryPercent, 87);
  assert.equal(mchoseV3FindProduct(info.productId)!.name, "A7 V3 Ultra+");
});

test("a truncated device info is rejected rather than read as zeroes", () => {
  assert.equal(mchoseV3DecodeDeviceInfo(new Uint8Array(13)), null);
});

test("settings unpack both links, and the angle is signed", () => {
  const settings = mchoseV3DecodeSettings(new Uint8Array([
    0x01, // profile 1
    0x32, // wired: rate slot 3, stage 2
    0x62, // wireless: rate slot 6, stage 2
    0x0a, // ten minutes
    0x01,
    0x00,
    0xf1, // −15°
    0x08, 0x04,
  ]))!;
  assert.equal(settings.profileIndex, 1);
  assert.equal(settings.dpiIndex, 2);
  // Slot 3 and slot 6 map down past the rate the vendor UI hides.
  assert.equal(settings.wiredRateIndex, 2);
  assert.equal(settings.wirelessRateIndex, 5);
  assert.equal(settings.sleep, 10);
  assert.equal(settings.angleTuning, -15, "two's complement, not 241");
  assert.equal(settings.leftDebounceMs, 8);
  assert.equal(settings.rightDebounceMs, 4);
});

test("the hidden polling slot makes the index maps deliberately asymmetric", () => {
  // Anything the UI can pick survives a round trip…
  for (let option = 0; option < 6; option += 1) {
    assert.equal(mchoseV3RateIndexToOption(mchoseV3OptionToRateIndex(option)), option);
  }
  // …but slot 1, which it never writes, still reads as something sensible.
  assert.equal(mchoseV3RateIndexToOption(1), 1);
  assert.equal(mchoseV3OptionToRateIndex(1), 2);
});

test("encoding settings restores the wire's rate slots", () => {
  const settings: MchoseV3Settings = {
    profileIndex: 1,
    dpiIndex: 2,
    wiredRateIndex: 2,
    wirelessRateIndex: 5,
    sleep: 10,
    sleepMode: 1,
    sensor: 0x00,
    angleTuning: -15,
    leftDebounceMs: 8,
    rightDebounceMs: 4,
    extra: [],
  };
  const data = mchoseV3EncodeSettings(settings);
  assert.equal(data[1], 0x32, "wired slot 3 with stage 2");
  assert.equal(data[2], 0x62, "wireless slot 6 with stage 2");
  assert.equal(data[6], 0xf1, "the negative angle goes back out as two's complement");
  assert.deepEqual(
    mchoseV3DecodeSettings(new Uint8Array(data)),
    // A block built from nothing pads the tail, exactly as M HUB does.
    { ...settings, extra: new Array<number>(10).fill(0) },
    "a decode of the encode is the settings that went in",
  );
});

/**
 * The trap this generation sets: the sensor byte carries the same fields as the
 * A7 V2's but lift-off and the power mode have swapped ends of it. Reading a V3
 * byte with the V2 masks turns a lift-off level into a power mode and back.
 */
test("the sensor byte is not laid out like the A7 V2's", () => {
  // Lift-off step 2, ripple on, mode 1.
  const sensor = 0x45;
  const decoded = mchoseV3DecodeSensor(sensor);
  assert.equal(decoded.liftOffIndex, 2);
  assert.equal(decoded.rippleControl, true);
  assert.equal(decoded.angleSnapping, false);
  assert.equal(decoded.motionSync, false);
  assert.equal(decoded.glassMode, false);
  assert.equal(MCHOSE_V3_MODES[decoded.modeIndex], "eSports");

  // The V2 codec reads the very same byte as lift-off 1 — which is the whole
  // reason the two drivers must never claim each other's devices.
  assert.equal(sensor & MCHOSE_LOD_MASK, 1);
});

test("glass mode sits on the top bit the A7 V2 leaves alone", () => {
  assert.equal(mchoseV3DecodeSensor(0x80).glassMode, true);
  assert.equal(mchoseV3DecodeSensor(0x80).liftOffIndex, 0);
  assert.equal(mchoseV3DecodeSensor(0x7f).glassMode, false);
});

test("the DPI table reads six little-endian stages", () => {
  const dpi = mchoseV3DecodeDpi(new Uint8Array([
    0x00, 0x00, 0x04, 0x01, 0x01,
    0x90, 0x01, // 400
    0x20, 0x03, // 800
    0x40, 0x06, // 1600
    0x80, 0x0c, // 3200
    0x00, 0x19, // 6400
    0x50, 0xc3, // 50000
  ]))!;
  assert.equal(dpi.stageCount, 4);
  assert.equal(dpi.activeStage, 1);
  assert.equal(dpi.hasSeparateY, true);
  assert.deepEqual(dpi.stages, [400, 800, 1600, 3200, 6400, 50000]);
  assert.equal(dpi.stages[dpi.activeStage], 800);
});

test("a DPI reply missing stages is rejected", () => {
  assert.equal(mchoseV3DecodeDpi(new Uint8Array(16)), null);
});

test("lift-off comes back as a bare index", () => {
  assert.equal(mchoseV3DecodeLiftOff(new Uint8Array([4])), 4);
  assert.equal(mchoseV3DecodeLiftOff(new Uint8Array()), null);
});

test("the button table is walked by type, since entries vary in width", () => {
  // Left is type 0x01 (three value bytes); the rest are the two-byte default.
  const buttons = mchoseV3DecodeButtons(new Uint8Array([
    0x01, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x02,
    0x00, 0x00, 0x04,
    0x02, 0x00, 0x42,
    0x02, 0x00, 0x43,
    0x05, 0x00, 0x01,
  ]))!;
  assert.equal(buttons.Left!.type, 0x01);
  assert.deepEqual(buttons.Left!.value, [0x01, 0x00, 0x00]);
  assert.equal(buttons.Right!.type, 0x00);
  assert.equal(buttons.DPI!.type, 0x05);
  assert.equal(Object.keys(buttons).length, 6);
});

test("a button table that would run past the payload is rejected", () => {
  // Announces a wide type with nothing behind it.
  assert.equal(mchoseV3DecodeButtons(new Uint8Array([0x23, 0x00])), null);
  assert.equal(mchoseV3DecodeButtons(new Uint8Array()), null);
});

test("models resolve by id, and the longest name wins on a string match", () => {
  assert.equal(mchoseV3FindProduct(0x4033)!.name, "A7 V3 Ultra+");
  assert.equal(mchoseV3FindProduct(0x4030)!.dpiMax, 26000);
  assert.equal(
    mchoseV3FindProduct(null, "MCHOSE A7 V3 Pro+")!.name, "A7 V3 Pro+",
    "\"A7 V3 Pro+\" must not be swallowed by \"A7 V3 Pro\"",
  );
  assert.equal(mchoseV3FindProduct(null, "MCHOSE A7 V2 Ultra+"), null, "a V2 is not a V3");
  assert.equal(mchoseV3FindProduct(0x4021), null);
});

test("the V3 id set covers the mice and their shared receivers, and no V2", () => {
  assert.ok(mchoseV3IsProductId(0x4033), "A7 V3 Ultra+ over its cable");
  assert.ok(mchoseV3IsProductId(0x1014), "the shared receiver");
  assert.ok(mchoseV3IsProductId(0x1018));
  assert.ok(!mchoseV3IsProductId(0x4021), "A7 V2 Ultra+");
  assert.ok(!mchoseV3IsProductId(0x100b), "the V2 receiver");
  assert.ok(!mchoseV3IsProductId(0x1012), "the MagDock");
});

test("the five-step ladder keeps its millimetres and still fits the three-stop field", () => {
  const ultra = mchoseV3FindProduct(0x4033)!;
  assert.deepEqual(
    mchoseV3LiftOffLabels(ultra),
    ["0.7 mm", "0.9 mm", "1.2 mm", "1.4 mm", "1.7 mm"],
  );
  assert.equal(mchoseV3LiftOffStop(ultra, 0), "Low");
  assert.equal(mchoseV3LiftOffStop(ultra, 2), "Medium");
  assert.equal(mchoseV3LiftOffStop(ultra, 4), "High");
  assert.equal(mchoseV3LiftOffStop(ultra, 5), null, "off the end of the ladder");

  const base = mchoseV3FindProduct(0x4030)!;
  assert.equal(mchoseV3LiftOffStop(base, 0), "Low");
  assert.equal(mchoseV3LiftOffStop(base, 1), "High", "a two-step ladder has no middle");
});

test("only the five-step models moved lift-off out of the sensor byte", () => {
  for (const product of MCHOSE_V3_PRODUCTS) {
    assert.equal(
      product.liftOffCommand, product.liftOffDistances.length > 4,
      `${product.name}: a ladder longer than the sensor byte's two bits needs 0x0009`,
    );
  }
});

test("the 1000 Hz models get the short rate list", () => {
  assert.deepEqual([...mchoseV3PollingRates(mchoseV3FindProduct(0x4029)!)], [125, 500, 1000]);
  assert.deepEqual(
    [...mchoseV3PollingRates(mchoseV3FindProduct(0x4033)!)],
    [125, 500, 1000, 2000, 4000, 8000],
  );
});

/**
 * Guards the split itself: a V3 frame decoded by the V2's config decoder must
 * not look like a plausible config. The V2 blob is read straight off a feature
 * report, so nothing but the shape stops a misrouted frame being believed.
 */
test("a V3 reply does not decode as a plausible A7 V2 config", () => {
  const frame = reply(MCHOSE_V3_COMMAND.readSettings, [
    0x01, 0x32, 0x62, 0x0a, 0x01, 0x00, 0xf1, 0x08, 0x04,
  ]);
  const asV2 = mchoseDecodeConfig(frame);
  // It decodes structurally — it is 63 bytes — but the first DPI stage is the
  // giveaway the V2 driver's own plausibility check looks at.
  assert.ok(
    asV2 === null || asV2.dpiStages[0]! < 50 || asV2.dpiStages[0]! > 42000,
    "a V3 frame must not pass as a V2 config with a believable DPI stage",
  );
});

/**
 * Captured from a real **MCHOSE A7 V3 Ultra+** on its 2.4 GHz receiver
 * (host PID 0x1018), 2026-09-12. These are the exact data blocks the mouse
 * returned, lifted out of an OpenMouse diagnostic export.
 */
const CAPTURE = {
  deviceInfo: [
    0x37, 0x38, 0x26, 0x40, 0x04, 0x00, 0x00, 0x00,
    0x00, 0x10, 0x02, 0x01, 0x55, 0x00, 0x08, 0xe4,
  ],
  settings: [
    0x00, 0x41, 0x41, 0x03, 0x00, 0x41, 0x00, 0x08, 0x08,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
  ],
  dpi: [
    0x00, 0x00, 0x06, 0x01, 0x00,
    0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x80, 0x0c, 0x00, 0x19, 0x50, 0xc3,
  ],
  buttons: [
    0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00, 0x04, 0x00,
    0x00, 0x10, 0x00, 0x00, 0x08, 0x00, 0xff, 0xff, 0xff,
  ],
};

test("the captured A7 V3 Ultra+ device info decodes to its real state", () => {
  const info = mchoseV3DecodeDeviceInfo(new Uint8Array(CAPTURE.deviceInfo))!;
  assert.equal(info.vendorId, 0x3837);
  assert.equal(info.batteryPercent, 85);
  assert.equal(info.chargeStatus, 1, "it was on the dock, charging");
  assert.equal(info.profileCount, 4);
  assert.notEqual(info.connectStatus, 0, "the mouse was linked");
});

/**
 * The reason {@link mchoseV3FindProduct} prefers the product string. This exact
 * reply came from a mouse whose USB product string reads "MCHOSE A7 V3 Ultra+",
 * and its `0x0900` id is the one MCHOSE's table gives the A5 V3 Ultra+.
 */
test("a real A7 V3 Ultra+ reports an id belonging to another model", () => {
  const info = mchoseV3DecodeDeviceInfo(new Uint8Array(CAPTURE.deviceInfo))!;
  assert.equal(info.productId, 0x4026);
  assert.equal(
    MCHOSE_V3_PRODUCTS.find((p) => p.productId === 0x4026)!.name, "A5 V3 Ultra+",
    "the id alone names the wrong mouse",
  );

  const resolved = mchoseV3FindProduct(info.productId, "MCHOSE A7 V3 Ultra+")!;
  assert.equal(resolved.name, "A7 V3 Ultra+", "the product string must win");
  // The consequences of getting this wrong, both visible to the user.
  assert.equal(resolved.dpiMax, 50000, "not the A5's 42000");
  assert.equal(resolved.liftOffDistances.length, 5, "not the A5's three-step ladder");
  assert.equal(resolved.liftOffCommand, true, "and so lift-off comes from 0x0009");
});

test("the id still resolves a model when the product string says nothing", () => {
  assert.equal(mchoseV3FindProduct(0x4033, "USB Receiver")!.name, "A7 V3 Ultra+");
  assert.equal(mchoseV3FindProduct(0x4033, null)!.name, "A7 V3 Ultra+");
  assert.equal(mchoseV3FindProduct(null, "Some Other Mouse"), null);
});

test("the captured settings block decodes to the state the mouse was in", () => {
  const settings = mchoseV3DecodeSettings(new Uint8Array(CAPTURE.settings))!;
  assert.equal(settings.profileIndex, 0);
  assert.equal(settings.dpiIndex, 1);
  // Slot 4 on the wire is option 3, which is 2000 Hz on an 8K model.
  assert.equal(settings.wirelessRateIndex, 3);
  assert.equal(mchoseV3PollingRates(mchoseV3FindProduct(0x4033)!)[settings.wirelessRateIndex], 2000);
  assert.equal(settings.sleep, 3, "three minutes");
  assert.equal(settings.leftDebounceMs, 8);
  assert.equal(settings.rightDebounceMs, 8);
  assert.equal(settings.angleTuning, 0);

  const sensor = mchoseV3DecodeSensor(settings.sensor);
  assert.equal(MCHOSE_V3_MODES[sensor.modeIndex], "eSports");
  assert.equal(sensor.motionSync, false);
  assert.equal(sensor.angleSnapping, false);
  assert.equal(sensor.rippleControl, false);
  assert.equal(sensor.glassMode, false);
});

test("the captured DPI table decodes to six stages with the second active", () => {
  const dpi = mchoseV3DecodeDpi(new Uint8Array(CAPTURE.dpi))!;
  assert.equal(dpi.stageCount, 6);
  assert.equal(dpi.activeStage, 1);
  assert.equal(dpi.hasSeparateY, false);
  assert.deepEqual(dpi.stages, [400, 800, 1600, 3200, 6400, 50000]);
  assert.equal(dpi.stages[dpi.activeStage], 800);
  // The top stage is the A7 V3 Ultra+'s ceiling, and another reason the id's
  // A5 V3 Ultra+ (42000) cannot be the right model.
  assert.equal(dpi.stages[5], mchoseV3FindProduct(0x4033)!.dpiMax);
});

test("the captured button table walks six stock assignments", () => {
  const buttons = mchoseV3DecodeButtons(new Uint8Array(CAPTURE.buttons))!;
  assert.equal(Object.keys(buttons).length, 6);
  // Five factory-default buttons carrying their own mouse-button mask...
  for (const name of ["Left", "Right", "Middle", "Forward", "Back"]) {
    assert.equal(buttons[name]!.type, 0x00, `${name} is on its factory default`);
  }
  assert.deepEqual(buttons.Left!.value, [0x00, 0x01]);
  assert.deepEqual(buttons.Back!.value, [0x00, 0x08]);
  // ...and a DPI button the firmware marks unset rather than defaulted.
  assert.equal(buttons.DPI!.type, MCHOSE_V3_BUTTON_UNSET);
});

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The whole reason the settings block carries an `extra` tail. A real A7 V3
 * Ultra+ returns ten bytes of 0x08 past the nine named fields — the same value
 * as its two debounce fields, so almost certainly the other buttons' debounce.
 * M HUB pads that region with zeros; doing the same would set them all to 0 on
 * every unrelated write.
 */
test("a settings write puts back the tail the mouse reported", () => {
  const settings = mchoseV3DecodeSettings(new Uint8Array(CAPTURE.settings))!;
  assert.deepEqual(settings.extra, new Array<number>(10).fill(0x08), "the mouse's own tail");

  settings.sleep = 5;
  const data = mchoseV3EncodeSettings(settings);
  assert.deepEqual(
    data.slice(9), new Array<number>(10).fill(0x08),
    "the tail goes back untouched, not zeroed",
  );
  assert.equal(data[3], 5, "and the edited field did change");
});

test("a settings block is range-checked before it can reach the wire", () => {
  const base = mchoseV3DecodeSettings(new Uint8Array(CAPTURE.settings))!;
  assert.doesNotThrow(() => mchoseV3CheckSettings(base));

  const bad = (edit: (s: MchoseV3Settings) => void): (() => void) => () => {
    const copy: MchoseV3Settings = { ...base, extra: [...base.extra] };
    edit(copy);
    mchoseV3CheckSettings(copy);
  };
  assert.throws(bad((s) => { s.leftDebounceMs = 21; }), RangeError, "debounce past 20 ms");
  assert.throws(bad((s) => { s.angleTuning = 31; }), RangeError, "angle past +30");
  assert.throws(bad((s) => { s.angleTuning = -31; }), RangeError, "angle past -30");
  assert.throws(bad((s) => { s.dpiIndex = 6; }), RangeError, "a seventh DPI stage");
  assert.throws(bad((s) => { s.sleep = 61; }), RangeError, "more than an hour of sleep");
});

test("the sensor encoder changes one field and leaves the rest of the byte alone", () => {
  // Bit 5 of the A7 V2's sensor byte was never explained; assigning rather than
  // masking is how a codec quietly destroys a field it does not know about.
  const before = 0b1010_0101;
  const after = mchoseV3EncodeSensor(before, { motionSync: true });
  assert.equal(after & MCHOSE_V3_SENSOR_MOTION_SYNC, MCHOSE_V3_SENSOR_MOTION_SYNC);
  assert.equal(
    after & ~MCHOSE_V3_SENSOR_MOTION_SYNC & 0xff,
    before & ~MCHOSE_V3_SENSOR_MOTION_SYNC & 0xff,
    "every other bit survived",
  );

  assert.equal(mchoseV3EncodeSensor(0xff, { rippleControl: false }) & MCHOSE_V3_SENSOR_RIPPLE, 0);
  assert.equal(mchoseV3DecodeSensor(mchoseV3EncodeSensor(0x00, { modeIndex: 2 })).modeIndex, 2);
  assert.equal(mchoseV3DecodeSensor(mchoseV3EncodeSensor(0x00, { liftOffIndex: 3 })).liftOffIndex, 3);
  assert.throws(() => mchoseV3EncodeSensor(0, { liftOffIndex: 4 }), RangeError, "two bits only");
  assert.throws(() => mchoseV3EncodeSensor(0, { modeIndex: 4 }), RangeError, "two bits here too");
});

/**
 * A decode fed straight back into the encoder must be a no-op, including for
 * the mode's unnamed fourth value: MCHOSE labels three of the two bits' four
 * states, and a mouse reporting the fourth must not be blocked from having any
 * other setting written.
 */
test("every sensor round trip survives its own encoder", () => {
  for (const sensor of [0x00, 0x41, 0x45, 0x80, 0xff, 0b1010_1010]) {
    const decoded = mchoseV3DecodeSensor(sensor);
    const reencoded = mchoseV3EncodeSensor(sensor, decoded);
    assert.equal(reencoded, sensor, `0x${sensor.toString(16)} came back changed`);
  }
});

test("DPI is rounded to a step the firmware stores, and refused out of range", () => {
  const ultra = mchoseV3FindProduct(0x4033)!;
  assert.equal(mchoseV3RoundDpi(1600, ultra), 1600);
  assert.equal(mchoseV3RoundDpi(1620, ultra), 1600, "rounds to the nearest 50");
  assert.equal(mchoseV3RoundDpi(1630, ultra), 1650);
  assert.equal(mchoseV3RoundDpi(50000, ultra), 50000);
  assert.throws(() => mchoseV3RoundDpi(199, ultra), RangeError, "below the vendor's own floor");
  assert.throws(() => mchoseV3RoundDpi(50050, ultra), RangeError, "past this model's ceiling");

  // A 26,000 DPI model must not be handed the Ultra+'s ceiling.
  assert.throws(() => mchoseV3RoundDpi(42000, mchoseV3FindProduct(0x4030)!), RangeError);
});

test("the DPI table encodes back into the shape it was decoded from", () => {
  const dpi = mchoseV3DecodeDpi(new Uint8Array(CAPTURE.dpi))!;
  const ultra = mchoseV3FindProduct(0x4033)!;
  const data = mchoseV3EncodeDpiTable(dpi, ultra);

  assert.equal(data[0], dpi.profileIndex);
  assert.equal(data[1], dpi.axis);
  assert.equal(data[2], 0, "hasSeparateY");
  assert.equal(data[3], dpi.stageCount);
  assert.equal(data[4], dpi.activeStage);
  // Stage values go back little-endian, matching the read.
  assert.deepEqual([...data.slice(5, 7)], [0x90, 0x01]);
  assert.deepEqual([...data.slice(15, 17)], [0x50, 0xc3]);
});

test("a DPI table with an impossible shape is refused", () => {
  const dpi = mchoseV3DecodeDpi(new Uint8Array(CAPTURE.dpi))!;
  const ultra = mchoseV3FindProduct(0x4033)!;
  assert.throws(
    () => mchoseV3EncodeDpiTable({ ...dpi, activeStage: dpi.stageCount }, ultra),
    RangeError,
    "an active stage past the end of the enabled list",
  );
  assert.throws(() => mchoseV3EncodeDpiTable({ ...dpi, stageCount: 0 }, ultra), RangeError);
  assert.throws(
    () => mchoseV3EncodeDpiTable({ ...dpi, stages: dpi.stages.slice(0, 5) }, ultra),
    RangeError,
    "a short table would leave a stage holding whatever was there",
  );
});

test("lift-off writes are bounded by the model's own ladder", () => {
  const ultra = mchoseV3FindProduct(0x4033)!;
  assert.deepEqual(mchoseV3EncodeLiftOff(1, 4, ultra), [1, 4]);
  assert.throws(() => mchoseV3EncodeLiftOff(0, 5, ultra), RangeError, "five steps, not six");
  // The three-step models must not be handed a five-step index.
  assert.throws(() => mchoseV3EncodeLiftOff(0, 3, mchoseV3FindProduct(0x4031)!), RangeError);
});

test("the button table is written in the same variable-width shape it is read", () => {
  const buttons = mchoseV3DecodeButtons(new Uint8Array(CAPTURE.buttons))!;
  const data = mchoseV3EncodeButtons(0, buttons);
  assert.deepEqual(
    data.slice(3), [...CAPTURE.buttons],
    "re-encoding an untouched table reproduces the capture byte for byte",
  );
  assert.deepEqual(data.slice(0, 3), [0, 0, 6], "profile, reserved, button count");
});

test("only actions with a captured encoding are offered", () => {
  assert.deepEqual([...MCHOSE_V3_BUTTON_ACTIONS], ["Default", "Disabled"]);
  assert.deepEqual(mchoseV3ButtonAction("Back", "Default"), { type: 0x00, value: [0x00, 0x08] });
  assert.deepEqual(
    mchoseV3ButtonAction("DPI", "Disabled"),
    { type: MCHOSE_V3_BUTTON_UNSET, value: [0xff, 0xff] },
  );
  // Nothing is invented for the actions whose values have never been seen.
  assert.equal(mchoseV3ButtonAction("Left", "Keyboard"), null);
  assert.equal(mchoseV3ButtonAction("Nonexistent", "Default"), null);
});

test("a button assignment whose value is the wrong width is refused", () => {
  const buttons = mchoseV3DecodeButtons(new Uint8Array(CAPTURE.buttons))!;
  assert.throws(
    () => mchoseV3EncodeButtons(0, { ...buttons, Left: { type: 0x00, value: [1] } }),
    RangeError,
    "a short value would shift every entry after it",
  );
  const withoutDpi = { ...buttons };
  delete withoutDpi.DPI;
  assert.throws(() => mchoseV3EncodeButtons(0, withoutDpi), /missing "DPI"/);
});
