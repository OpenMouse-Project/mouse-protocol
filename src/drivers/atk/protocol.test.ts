import assert from "node:assert/strict";
import test from "node:test";

import {
  ATK_BUTTON_CLASS,
  ATK_COMPX_COMMAND,
  ATK_COMPX_FIRMWARE_HEADER_LENGTH,
  ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET,
  ATK_R1_BUTTONS,
  ATK_R1_MACRO_BASE,
  ATK_R1_MACRO_SLOT_COUNT,
  ATK_R1_MACRO_SLOT_LENGTH,
  ATK_R1_PROFILE_COUNT,
  ATK_R1_SHORTCUT_BASE,
  ATK_R1_SHORTCUT_SLOT_LENGTH,
  ATK_SENSORS,
  atkBuildReceiverPairRequest,
  atkBuildSetCurrentProfile,
  atkCompxPayloadCrc,
  atkDecodeButtonAssignment,
  atkDecodeCurrentProfile,
  atkDecodeLiftOff,
  atkDecodePairingStatus,
  atkDecodeReceiverStatus,
  atkDpiOptionsForSensor,
  atkDecodeVxeR1PollingCode,
  atkPackDpiStage,
  atkPackDpiStageForSensor,
  atkPackVxeR1LiveSetting,
  atkPackVxeR1PollingSetting,
  atkParseCompxFirmware,
  atkUnpackDpiStage,
  atkUnpackDpiStageForSensor,
  ATK_VXE_R1_ANGLE_SELECTOR,
  ATK_VXE_R1_DEBOUNCE_SELECTOR,
  ATK_VXE_R1_LOD_SELECTOR,
  ATK_VXE_R1_POLLING_RATES,
} from "@openmouse/protocol/atk";
import { ATK_PRODUCTS } from "./products.ts";

test("DPI stages survive a round trip across every step range", () => {
  for (const [x, y] of [[50, 50], [800, 800], [10000, 1600], [10050, 10050], [26000, 26000], [42000, 42000]]) {
    const stage = atkPackDpiStage(x!, y!);
    const sum = stage.reduce((total, byte) => total + byte, 0);

    assert.equal(sum & 0xff, 0x55, `stage checksum for ${x}/${y}`);
    assert.deepEqual(atkUnpackDpiStage(stage), { x, y });
  }
});

test("DPI stages with a corrupt checksum are rejected", () => {
  const stage = atkPackDpiStage(1600, 1600);
  stage[3] ^= 0xff;

  assert.equal(atkUnpackDpiStage(stage), null);
  assert.equal(atkUnpackDpiStage([1, 2, 3]), null);
});

test("PAW3395SE decodes exact wired EEPROM captures", () => {
  const captures: ReadonlyArray<readonly [readonly number[], number]> = [
    [[0x12, 0x12, 0x00, 0x31], 800],
    [[0x25, 0x25, 0x00, 0x0b], 1600],
    [[0x4b, 0x4b, 0x00, 0xbf], 3200],
  ];
  for (const [stage, dpi] of captures) {
    assert.deepEqual(atkUnpackDpiStageForSensor("PAW3395SE", stage), { x: dpi, y: dpi });
    assert.deepEqual(atkPackDpiStageForSensor("PAW3395SE", dpi, dpi), stage);
  }
});

test("PAW3395SE uses independent doubled bits above 10000 DPI", () => {
  const stage = atkPackDpiStageForSensor("PAW3395SE", 10100, 18000);
  assert.ok(stage);
  assert.equal(stage[2], 0x22);
  assert.deepEqual(atkUnpackDpiStageForSensor("PAW3395SE", stage), { x: 10100, y: 18000 });

  const xOnly = atkPackDpiStageForSensor("PAW3395SE", 10100, 3200);
  const yOnly = atkPackDpiStageForSensor("PAW3395SE", 3200, 10100);
  assert.equal(xOnly?.[2], 0x02);
  assert.equal(yOnly?.[2], 0x20);
});

test("PAW3395SE rejects code holes and invalid doubled values", () => {
  const invalidCodes = [
    0, 7, 13, 20, 26, 33, 40, 46, 53, 60, 66, 73, 80, 86, 93, 100, 106,
    113, 120, 126, 133, 140, 146, 153, 160, 166, 173, 180, 186, 193, 200,
    206, 213, 220, 226, 233, 236, 255,
  ];
  for (const code of invalidCodes) {
    const checksum = (0x55 - code * 2) & 0xff;
    assert.equal(atkUnpackDpiStageForSensor("PAW3395SE", [code, code, 0, checksum]), null, `code ${code}`);
  }
  assert.equal(atkUnpackDpiStageForSensor("PAW3395SE", [0x12, 0x12, 0x22, 0x0f]), null);
  assert.equal(atkPackDpiStageForSensor("PAW3395SE", 10050, 10050), null);
  assert.equal(atkPackDpiStageForSensor("PAW3395SE", 18100, 18100), null);
});

test("PAW3395SE exposes only the representable vendor range", () => {
  const options = atkDpiOptionsForSensor("PAW3395SE");
  assert.deepEqual(options.slice(0, 3), [200, 250, 300]);
  assert.deepEqual(options.slice(-3), [17800, 17900, 18000]);
  assert.equal(options.length, 277);
  assert.ok(options.every((dpi) => dpi <= 10000 ? dpi % 50 === 0 : dpi % 100 === 0));
  assert.equal(options.includes(10050), false);
  assert.equal(options.includes(10100), true);
  for (const dpi of options) {
    const stage = atkPackDpiStageForSensor("PAW3395SE", dpi, dpi);
    assert.ok(stage, `${dpi} DPI encodes`);
    assert.deepEqual(atkUnpackDpiStageForSensor("PAW3395SE", stage), { x: dpi, y: dpi });
  }
});

test("the verified R1 SE+ identity selects PAW3395SE", () => {
  assert.deepEqual(ATK_PRODUCTS["2,32"], {
    brand: "VXE",
    model: "R1 SE+",
    sensor: "PAW3395SE",
    family: "r1",
    verified: true,
  });
  assert.equal(ATK_SENSORS.PAW3395SE.maxDpi, 18000);
});

test("Lift-off codes decode to millimetres", () => {
  assert.equal(atkDecodeLiftOff(1), 0.7);
  assert.equal(atkDecodeLiftOff(4), 1);
  assert.equal(atkDecodeLiftOff(11), 1.7);
  assert.equal(atkDecodeLiftOff(0), null);
});

test("R1 polling pack is the 0x0b live-settings row with a checksum pair", () => {
  assert.deepEqual(atkPackVxeR1PollingSetting(1000), [0x0b, 0x01, 0x00, 0x54]);
  assert.deepEqual(atkPackVxeR1PollingSetting(500), [0x0b, 0x02, 0x00, 0x53]);
  assert.deepEqual(atkPackVxeR1PollingSetting(250), [0x0b, 0x03, 0x00, 0x52]);
  assert.equal(atkPackVxeR1PollingSetting(2000), null);
  assert.equal(atkPackVxeR1PollingSetting(125), null);
});

test("R1 polling codes decode back to hertz and reject unknown bytes", () => {
  assert.equal(atkDecodeVxeR1PollingCode(0x01), 1000);
  assert.equal(atkDecodeVxeR1PollingCode(0x02), 500);
  assert.equal(atkDecodeVxeR1PollingCode(0x03), 250);
  assert.equal(atkDecodeVxeR1PollingCode(0x00), null);
  assert.equal(atkDecodeVxeR1PollingCode(0x40), null);
  assert.deepEqual(ATK_VXE_R1_POLLING_RATES, [250, 500, 1000]);
});

test("R1 angle/debounce/LOD settings pack as their live-settings selectors", () => {
  assert.deepEqual(atkPackVxeR1LiveSetting(ATK_VXE_R1_ANGLE_SELECTOR, 0x10), [0x01, 0x10, 0x00, 0x45]);
  assert.deepEqual(atkPackVxeR1LiveSetting(ATK_VXE_R1_ANGLE_SELECTOR, 0x00), [0x01, 0x00, 0x00, 0x55]);
  assert.deepEqual(atkPackVxeR1LiveSetting(ATK_VXE_R1_DEBOUNCE_SELECTOR, 4), [0x02, 0x04, 0x00, 0x51]);
  assert.deepEqual(atkPackVxeR1LiveSetting(ATK_VXE_R1_LOD_SELECTOR, 1), [0x03, 0x01, 0x00, 0x54]);
  assert.deepEqual(atkPackVxeR1LiveSetting(ATK_VXE_R1_LOD_SELECTOR, 2), [0x03, 0x02, 0x00, 0x53]);
});

test("COMPX command ids and R1 storage geometry match the vendor protocol", () => {
  assert.equal(ATK_COMPX_COMMAND.getWirelessMouseOnline, 0x03);
  assert.equal(ATK_COMPX_COMMAND.getCurrentConfig, 0x0e);
  assert.equal(ATK_COMPX_COMMAND.setCurrentConfig, 0x0f);
  assert.equal(ATK_COMPX_COMMAND.reportMouseUpgradeError, 0x5a);
  assert.equal(ATK_COMPX_COMMAND.reportMouseUpgradeStatus, 0x5b);
  assert.equal(ATK_R1_PROFILE_COUNT, 4);
  assert.deepEqual(ATK_R1_BUTTONS.map(({ address }) => address), [0x60, 0x64, 0x68, 0x6c, 0x70, 0x74]);
  assert.equal(ATK_R1_SHORTCUT_BASE, 0x100);
  assert.equal(ATK_R1_SHORTCUT_SLOT_LENGTH, 32);
  assert.equal(ATK_R1_MACRO_BASE, 0x300);
  assert.equal(ATK_R1_MACRO_SLOT_LENGTH, 384);
  assert.equal(ATK_R1_MACRO_SLOT_COUNT, 12);
});

test("current profile, receiver, and pairing replies are decoded without writes", () => {
  assert.equal(atkDecodeCurrentProfile([0]), 0);
  assert.equal(atkDecodeCurrentProfile([3]), 3);
  assert.equal(atkDecodeCurrentProfile([4]), null);
  assert.equal(atkDecodeCurrentProfile([]), null);
  assert.deepEqual(atkDecodeReceiverStatus([1, 0xaa, 0xbb, 0xcc]), {
    online: true,
    status: 1,
    rfId: "CCBBAA",
  });
  assert.deepEqual(atkDecodeReceiverStatus([0, 0, 0, 0]), { online: false, status: 0, rfId: "000000" });
  assert.deepEqual(atkDecodeReceiverStatus([2, 0xaa, 0xbb, 0xcc]), {
    online: false,
    status: 2,
    rfId: "CCBBAA",
  });
  assert.equal(atkDecodeReceiverStatus([1, 2, 3]), null);
  assert.deepEqual(atkDecodePairingStatus([2, 29]), { status: 2, secondsRemaining: 29 });
  assert.equal(atkDecodePairingStatus([2]), null);
});

test("profile selection uses the vendor length field and zero-based bank", () => {
  assert.deepEqual([...atkBuildSetCurrentProfile(2)], [
    0x0f, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3b,
  ]);
  assert.throws(() => atkBuildSetCurrentProfile(-1), /between 0 and 3/);
  assert.throws(() => atkBuildSetCurrentProfile(4), /between 0 and 3/);
});

test("receiver pairing encodes the exact mouse CID and MID", () => {
  assert.deepEqual([...atkBuildReceiverPairRequest(0x02, 0x20)], [
    0x05, 0, 0, 0, 2, 0x02, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0x24,
  ]);
  assert.throws(() => atkBuildReceiverPairRequest(-1, 0x20), /must be bytes/);
  assert.throws(() => atkBuildReceiverPairRequest(0x02, 0x100), /must be bytes/);
});

test("button assignments preserve unknown values and report checksum corruption", () => {
  assert.deepEqual(atkDecodeButtonAssignment([ATK_BUTTON_CLASS.mouse, 1, 0, 0x53]), {
    keyClass: 1,
    value1: 1,
    value2: 0,
    checksum: 0x53,
    checksumValid: true,
    label: "Left click",
    raw: "01 01 00 53",
  });
  const unknown = atkDecodeButtonAssignment([0xfe, 0xaa, 0xbb, 0x00]);
  assert.equal(unknown?.checksumValid, false);
  assert.equal(unknown?.label, "Unknown class 0xfe (0xaa, 0xbb)");
  assert.equal(atkDecodeButtonAssignment([1, 2, 3]), null);
});

test("COMPX firmware parser checks endpoints, geometry, and raw payload CRC", () => {
  const payload = new Uint8Array([1, 2, 3]);
  assert.equal(atkCompxPayloadCrc(payload), 0xaa437fe2);
  const file = new Uint8Array(ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET + payload.length);
  const view = new DataView(file.buffer);
  view.setUint32(0, 0x55552135, true);
  view.setUint32(4, ATK_COMPX_FIRMWARE_HEADER_LENGTH, true);
  view.setUint32(8, payload.length, true);
  view.setUint32(16, 0x315, true);
  view.setUint8(20, 1);
  view.setUint8(21, 2);
  view.setUint8(22, 32);
  const writeField = (index: number, value: string): void => {
    file.set(new TextEncoder().encode(value), 23 + index * 64);
  };
  writeField(0, "ComUsbUpgradeFile");
  writeField(1, "CX52850P");
  writeField(2, "vid_3554&pid_f406&mi_01&col01");
  writeField(3, "vid_3554&pid_f406&mi_01&col02");
  writeField(4, "vid_3554&pid_f58f&mi_01&col05");
  writeField(5, "vid_3554&pid_f58f&mi_01&col05");
  writeField(9, "3395se");
  const prepare = 23 + 7 * 64;
  file.set([49, 1, 6, 0xb0], prepare);
  view.setUint32(prepare + 19, atkCompxPayloadCrc(payload), false);
  file.set(payload, ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET);

  const parsed = atkParseCompxFirmware(file);
  assert.equal(parsed.version, "315");
  assert.equal(parsed.cid, 2);
  assert.equal(parsed.mid, 32);
  assert.equal(parsed.icName, "CX52850P");
  assert.equal(parsed.sensorName, "3395se");
  assert.deepEqual(parsed.normalInput, {
    vendorId: 0x3554,
    productId: 0xf58f,
    path: "vid_3554&pid_f58f&mi_01&col05",
  });
  assert.equal(parsed.payloadCrcValid, true);

  file[ATK_COMPX_FIRMWARE_PAYLOAD_OFFSET] ^= 0xff;
  assert.equal(atkParseCompxFirmware(file).payloadCrcValid, false);
  view.setUint32(8, payload.length + 1, true);
  assert.throws(() => atkParseCompxFirmware(file), /payload length exceeds/);
});
