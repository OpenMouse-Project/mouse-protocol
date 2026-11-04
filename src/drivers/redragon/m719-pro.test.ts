import assert from "node:assert/strict";
import test from "node:test";

import {
  REDRAGON_M719_PRO_BRIGHTNESS_LUT,
  REDRAGON_M719_PRO_BUTTONS,
  REDRAGON_M719_PRO_COMMAND,
  REDRAGON_M719_PRO_COMMAND_REPORT_ID,
  REDRAGON_M719_PRO_COMMAND_USAGE,
  REDRAGON_M719_PRO_COMMAND_USAGE_PAGE,
  REDRAGON_M719_PRO_DPI_OPTIONS,
  REDRAGON_M719_PRO_EEPROM,
  REDRAGON_M719_PRO_NEON_SPEED_LUT,
  REDRAGON_M719_PRO_NOTIFY_REPORT_ID,
  REDRAGON_M719_PRO_NOTIFY_USAGE,
  REDRAGON_M719_PRO_NOTIFY_USAGE_PAGE,
  REDRAGON_M719_PRO_PAW3325_DPI_TABLE,
  REDRAGON_M719_PRO_RECEIVER_PRODUCT_ID,
  REDRAGON_M719_PRO_RESPONSE_REPORT_ID,
  REDRAGON_M719_PRO_RGB_EFFECT,
  REDRAGON_M719_PRO_SPEED_LUT,
  REDRAGON_M719_PRO_VENDOR_ID,
  REDRAGON_M719_PRO_WIRED_PRODUCT_ID,
  redragonM719ProComputeHandshakeResponse,
  redragonM719ProDataChecksum,
  redragonM719ProDecodeBattery,
  redragonM719ProDecodeButtonAction,
  redragonM719ProDecodeConnectStatus,
  redragonM719ProDecodeDpiLedEffect,
  redragonM719ProDecodeDpiStage,
  redragonM719ProDecodeDpiStageColors,
  redragonM719ProDecodeDpiStages,
  redragonM719ProDecodeHardwareNotification,
  redragonM719ProDecodePollingRate,
  redragonM719ProDecodeRgbLighting,
  redragonM719ProEncodeButtonAction,
  redragonM719ProEncodeDpiLedEffect,
  redragonM719ProEncodeDpiStage,
  redragonM719ProEncodeDpiStageColors,
  redragonM719ProEncodeDpiStages,
  redragonM719ProEncodeHandshake,
  redragonM719ProEncodePollingRate,
  redragonM719ProEncodeRgbLighting,
  redragonM719ProNearestDpi,
  redragonM719ProPackScalar,
  redragonM719ProPacketChecksum,
  redragonM719ProUnpackScalar,
  redragonM719ProVerifyDataChecksum,
  redragonM719ProVerifyHandshakeReply,
} from "@openmouse/protocol/redragon";
import { createSupportedClient, deviceBrand } from "../registry.ts";
import { RedragonM719ProHidClient } from "./m719-pro-hid.ts";

test("computes packet and EEPROM data checksums (0x55 - sum)", () => {
  const payload = new Uint8Array(16);
  payload[0] = 0x04;
  payload[4] = 0x02;
  const csum = redragonM719ProPacketChecksum(payload, REDRAGON_M719_PRO_COMMAND_REPORT_ID);
  assert.equal(csum, (0x55 - (0x08 + 0x04 + 0x02)) & 0xff);

  const scalar = redragonM719ProPackScalar(0x02);
  assert.deepEqual([...scalar], [0x02, 0x53]);
  assert.equal(redragonM719ProUnpackScalar(scalar), 0x02);
  assert.equal(redragonM719ProUnpackScalar([0x02, 0x52]), null);

  assert.equal(redragonM719ProDataChecksum([0x01]), 0x54);
  assert.equal(redragonM719ProVerifyDataChecksum([0x01, 0x54]), true);
  assert.equal(redragonM719ProVerifyDataChecksum([0x01, 0x53]), false);
});

test("computes and verifies handshake challenge/response", () => {
  const challenge: [number, number, number, number] = [0x10, 0x20, 0x30, 0x40];
  const expected = redragonM719ProComputeHandshakeResponse(challenge);
  assert.equal(expected.length, 4);

  const req = redragonM719ProEncodeHandshake(challenge);
  assert.equal(req[0], REDRAGON_M719_PRO_COMMAND.handshake);
  assert.equal(req[4], 4);
  assert.deepEqual([...req.subarray(5, 9)], challenge);
  assert.equal(req[15], redragonM719ProPacketChecksum(req));

  const goodResp = new Uint8Array(17);
  goodResp[0] = REDRAGON_M719_PRO_RESPONSE_REPORT_ID;
  goodResp[1] = REDRAGON_M719_PRO_COMMAND.handshake;
  goodResp[2] = 0x00;
  goodResp.set(expected, 6);
  assert.equal(redragonM719ProVerifyHandshakeReply(challenge, goodResp), true);

  const badResp = Uint8Array.from(goodResp);
  badResp[6] ^= 0xff;
  assert.equal(redragonM719ProVerifyHandshakeReply(challenge, badResp), false);
});

test("decodes connect status, battery, and hardware notifications", () => {
  const connResp = new Uint8Array(17);
  connResp[0] = REDRAGON_M719_PRO_RESPONSE_REPORT_ID;
  connResp[1] = REDRAGON_M719_PRO_COMMAND.getConnectStatus;
  connResp[5] = 0x01; // length 1
  connResp[6] = 0x01; // online
  assert.equal(redragonM719ProDecodeConnectStatus(connResp), true);

  connResp[6] = 0x00; // offline
  assert.equal(redragonM719ProDecodeConnectStatus(connResp), false);

  const batResp = new Uint8Array(17);
  batResp[0] = REDRAGON_M719_PRO_RESPONSE_REPORT_ID;
  batResp[1] = REDRAGON_M719_PRO_COMMAND.getBattery;
  batResp[6] = 85;
  batResp[7] = 1;
  assert.deepEqual(redragonM719ProDecodeBattery(batResp), {
    percent: 85,
    charging: true,
    rawLevel: 85,
  });

  // 0..10 scale battery reply
  batResp[6] = 7;
  batResp[7] = 0;
  assert.deepEqual(redragonM719ProDecodeBattery(batResp), {
    percent: 70,
    charging: false,
    rawLevel: 7,
  });

  // Hardware notification on Report 0x09 (Cmd 0x0a)
  const notify09 = new Uint8Array(16);
  notify09[0] = REDRAGON_M719_PRO_COMMAND.hardwareNotify;
  notify09[5] = 0x03; // both DPI stage and profile changed
  notify09[6] = 0x02; // stage index 2
  notify09[7] = 0x01; // profile index 1 -> profile 2
  assert.deepEqual(
    redragonM719ProDecodeHardwareNotification(notify09, REDRAGON_M719_PRO_RESPONSE_REPORT_ID),
    { activeDpiStage: 2, activeProfile: 2 },
  );

  // Hardware notification on Report 0x0a
  const notify0a = new Uint8Array(16);
  notify0a[4] = 0x01;
  notify0a[5] = 0x04;
  assert.deepEqual(
    redragonM719ProDecodeHardwareNotification(notify0a, REDRAGON_M719_PRO_NOTIFY_REPORT_ID),
    { activeDpiStage: 4 },
  );
});

test("encodes and decodes PAW3325 DPI values across low (200..5000) and high (5200..10000) ranges", () => {
  assert.equal(REDRAGON_M719_PRO_PAW3325_DPI_TABLE.length, 49);
  assert.equal(REDRAGON_M719_PRO_DPI_OPTIONS[0], 200);
  assert.equal(REDRAGON_M719_PRO_DPI_OPTIONS[48], 5000);
  assert.equal(REDRAGON_M719_PRO_DPI_OPTIONS[49], 5200);
  assert.equal(REDRAGON_M719_PRO_DPI_OPTIONS[REDRAGON_M719_PRO_DPI_OPTIONS.length - 1], 10000);

  for (const dpi of REDRAGON_M719_PRO_DPI_OPTIONS) {
    const entry = redragonM719ProEncodeDpiStage(dpi);
    assert.equal(entry.length, 4);
    assert.equal(entry[2], dpi > 5000 ? 0x01 : 0x00);
    assert.equal(redragonM719ProVerifyDataChecksum(entry), true);
    assert.equal(redragonM719ProDecodeDpiStage(entry), dpi);
  }

  assert.equal(redragonM719ProNearestDpi(740), 700);
  assert.equal(redragonM719ProNearestDpi(5150), 5200);

  const stages = [800, 1600, 2400, 5200, 10000];
  const block = redragonM719ProEncodeDpiStages(stages);
  assert.equal(block.length, 20);
  assert.deepEqual(redragonM719ProDecodeDpiStages(block), stages);
});

test("encodes and decodes polling rate, DPI stage colors, DPI indicator LED, and main RGB lighting", () => {
  for (const hz of [125, 250, 500, 1000] as const) {
    const encoded = redragonM719ProEncodePollingRate(hz);
    assert.equal(encoded.length, 2);
    assert.equal(redragonM719ProVerifyDataChecksum(encoded), true);
    assert.equal(redragonM719ProDecodePollingRate(encoded), hz);
  }

  const colors = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },
    { r: 255, g: 0, b: 255 },
  ];
  const colorBlock = redragonM719ProEncodeDpiStageColors(colors);
  assert.equal(colorBlock.length, 20);
  assert.deepEqual(redragonM719ProDecodeDpiStageColors(colorBlock), colors);

  for (const mode of [0, 1, 2] as const) {
    const indBlock = redragonM719ProEncodeDpiLedEffect(mode, 2);
    assert.equal(indBlock.length, mode === 0 ? 2 : 6);
    assert.equal(redragonM719ProDecodeDpiLedEffect(indBlock), mode);
  }

  // Main RGB: Neon uses NEON_SPEED_LUT, Steady/Breathing uses SPEED_LUT.
  const neonBlock = redragonM719ProEncodeRgbLighting({
    effect: REDRAGON_M719_PRO_RGB_EFFECT.neon,
    color: { r: 0x12, g: 0x34, b: 0x56 },
    speed: 4,
    brightness: 3,
  });
  assert.equal(neonBlock.length, 7);
  assert.equal(neonBlock[0], REDRAGON_M719_PRO_RGB_EFFECT.neon);
  assert.equal(neonBlock[4], REDRAGON_M719_PRO_NEON_SPEED_LUT[3]);
  assert.equal(neonBlock[5], REDRAGON_M719_PRO_BRIGHTNESS_LUT[2]);
  assert.equal(redragonM719ProVerifyDataChecksum(neonBlock), true);
  assert.deepEqual(redragonM719ProDecodeRgbLighting(neonBlock), {
    effect: REDRAGON_M719_PRO_RGB_EFFECT.neon,
    color: { r: 0x12, g: 0x34, b: 0x56 },
    speed: 4,
    brightness: 3,
  });

  const breathingBlock = redragonM719ProEncodeRgbLighting({
    effect: REDRAGON_M719_PRO_RGB_EFFECT.breathing,
    color: { r: 255, g: 0, b: 128 },
    speed: 5,
    brightness: 10,
  });
  assert.equal(breathingBlock[0], REDRAGON_M719_PRO_RGB_EFFECT.breathing);
  assert.equal(breathingBlock[4], REDRAGON_M719_PRO_SPEED_LUT[4]);
  assert.equal(breathingBlock[5], REDRAGON_M719_PRO_BRIGHTNESS_LUT[9]);
  assert.deepEqual(redragonM719ProDecodeRgbLighting(breathingBlock), {
    effect: REDRAGON_M719_PRO_RGB_EFFECT.breathing,
    color: { r: 255, g: 0, b: 128 },
    speed: 5,
    brightness: 10,
  });
});

test("encodes and decodes direct, multimedia, and keyboard shortcut button actions", () => {
  // Direct action: Three click (Fire) -> [0x04, 0x32, 0x03, 0x1c]
  const fire = redragonM719ProEncodeButtonAction("Three click");
  assert.deepEqual([...fire.slotBytes], [0x04, 0x32, 0x03, 0x1c]);
  assert.equal(fire.comboPayload, undefined);
  assert.equal(redragonM719ProDecodeButtonAction(fire.slotBytes), "Three click");

  // Multimedia action: Play/Pause -> 0x00cd
  const playPause = redragonM719ProEncodeButtonAction("Play/Pause");
  assert.deepEqual([...playPause.slotBytes], [0x05, 0x00, 0x00, 0x50]);
  assert.ok(playPause.comboPayload);
  assert.deepEqual([...playPause.comboPayload.subarray(0, 7)], [
    0x02,
    0x82, 0xcd, 0x00,
    0x42, 0xcd, 0x00,
  ]);
  assert.equal(
    redragonM719ProDecodeButtonAction(playPause.slotBytes, playPause.comboPayload),
    "Play/Pause",
  );

  // Keyboard shortcut action: Copy (Ctrl+C) -> modifier 0x01 + key 0x06
  const copy = redragonM719ProEncodeButtonAction("Copy (Ctrl+C)");
  assert.deepEqual([...copy.slotBytes], [0x05, 0x00, 0x00, 0x50]);
  assert.ok(copy.comboPayload);
  assert.deepEqual([...copy.comboPayload.subarray(0, 13)], [
    0x04,
    0x80, 0x01, 0x00,
    0x81, 0x06, 0x00,
    0x40, 0x01, 0x00,
    0x41, 0x06, 0x00,
  ]);
  assert.equal(
    redragonM719ProDecodeButtonAction(copy.slotBytes, copy.comboPayload),
    "Copy (Ctrl+C)",
  );

  // Single key and multi-modifier key combination
  const keyA = redragonM719ProEncodeButtonAction("Key A");
  assert.equal(
    redragonM719ProDecodeButtonAction(keyA.slotBytes, keyA.comboPayload),
    "Key A",
  );
  const ctrlShiftR = redragonM719ProEncodeButtonAction("Keys Ctrl+Shift+R");
  assert.equal(
    redragonM719ProDecodeButtonAction(ctrlShiftR.slotBytes, ctrlShiftR.comboPayload),
    "Keys Ctrl+Shift+R",
  );
});

/**
 * Fake Redragon M719RGB-PRO device with a 1 KB EEPROM backing store that
 * answers Feature Report 0x08 commands with Input Report 0x09 responses.
 */
class FakeM719Pro {
  vendorId = REDRAGON_M719_PRO_VENDOR_ID;
  productName = "Redragon M719RGB-PRO";
  opened = false;
  collections: HIDCollectionInfo[];
  online = true;
  batteryPercent = 90;
  batteryCharging = false;
  readonly eeprom = new Uint8Array(0x0400);
  private readonly listeners = new Set<(event: HIDInputReportEvent) => void>();
  notifyPeer: FakeM719Pro | null = null;

  constructor(
    public productId: number = REDRAGON_M719_PRO_RECEIVER_PRODUCT_ID,
    mode: "combined" | "command-only" | "notify-only" = "combined",
  ) {
    const cmdCol = {
      usagePage: REDRAGON_M719_PRO_COMMAND_USAGE_PAGE,
      usage: REDRAGON_M719_PRO_COMMAND_USAGE,
      featureReports: [{ reportId: REDRAGON_M719_PRO_COMMAND_REPORT_ID }],
      inputReports: [],
      outputReports: [],
      children: [],
    };
    const notifyCol = {
      usagePage: REDRAGON_M719_PRO_NOTIFY_USAGE_PAGE,
      usage: REDRAGON_M719_PRO_NOTIFY_USAGE,
      featureReports: [],
      inputReports: [
        { reportId: REDRAGON_M719_PRO_RESPONSE_REPORT_ID },
        { reportId: REDRAGON_M719_PRO_NOTIFY_REPORT_ID },
      ],
      outputReports: [],
      children: [],
    };
    this.collections = (
      mode === "combined" ? [cmdCol, notifyCol]
      : mode === "command-only" ? [cmdCol]
      : [notifyCol]
    ) as unknown as HIDCollectionInfo[];

    // Seed factory EEPROM state
    this.eeprom.set(redragonM719ProEncodePollingRate(1000), REDRAGON_M719_PRO_EEPROM.pollingRate);
    this.eeprom.set(redragonM719ProPackScalar(5), REDRAGON_M719_PRO_EEPROM.dpiStageCount);
    this.eeprom.set(redragonM719ProPackScalar(1), REDRAGON_M719_PRO_EEPROM.activeDpiStage);
    this.eeprom.set(
      redragonM719ProEncodeDpiStages([400, 800, 1600, 2400, 3200]),
      REDRAGON_M719_PRO_EEPROM.dpiStages,
    );
    this.eeprom.set(
      redragonM719ProEncodeDpiStageColors([
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 255, b: 0 },
        { r: 0, g: 0, b: 255 },
        { r: 255, g: 255, b: 0 },
        { r: 0, g: 255, b: 255 },
      ]),
      REDRAGON_M719_PRO_EEPROM.dpiColors,
    );
    this.eeprom.set(
      redragonM719ProEncodeDpiLedEffect(1, 1),
      REDRAGON_M719_PRO_EEPROM.dpiLedEffect,
    );
    this.eeprom.set(
      redragonM719ProEncodeRgbLighting({
        effect: REDRAGON_M719_PRO_RGB_EFFECT.steady,
        color: { r: 255, g: 0, b: 0 },
        speed: 5,
        brightness: 10,
      }),
      REDRAGON_M719_PRO_EEPROM.rgbLighting,
    );

    const defaultButtons = [
      [0, "Left click"],
      [1, "Right click"],
      [2, "Middle click"],
      [4, "Forward"],
      [3, "Back"],
      [8, "Three click"],
      [10, "DPI up"],
      [11, "DPI down"],
    ] as const;
    for (const [slot, label] of defaultButtons) {
      const encoded = redragonM719ProEncodeButtonAction(label);
      this.eeprom.set(encoded.slotBytes, REDRAGON_M719_PRO_EEPROM.buttonMatrix + slot * 4);
    }
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  addEventListener(type: string, listener: (event: HIDInputReportEvent) => void): void {
    if (type === "inputreport") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: HIDInputReportEvent) => void): void {
    if (type === "inputreport") this.listeners.delete(listener);
  }

  emitInputReport(reportId: number, payload16: Uint8Array): void {
    const target = this.notifyPeer ?? this;
    const event = {
      device: target as unknown as HIDDevice,
      reportId,
      data: new DataView(payload16.buffer, payload16.byteOffset, payload16.byteLength),
    } as unknown as HIDInputReportEvent;
    for (const listener of target.listeners) listener(event);
  }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    assert.equal(reportId, REDRAGON_M719_PRO_COMMAND_REPORT_ID);
    const body =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    assert.equal(body.length, 16);
    assert.equal(
      body[15],
      redragonM719ProPacketChecksum(body, REDRAGON_M719_PRO_COMMAND_REPORT_ID),
      "valid command packet checksum",
    );

    const cmd = body[0]!;
    const addr = ((body[2]! << 8) | body[3]!) & 0xffff;
    const len = body[4]!;
    const resp = new Uint8Array(16);
    resp[0] = cmd;
    resp[1] = 0x00;
    resp[2] = body[2]!;
    resp[3] = body[3]!;
    resp[4] = len;

    if (cmd === REDRAGON_M719_PRO_COMMAND.handshake) {
      const challenge: [number, number, number, number] = [
        body[5]!,
        body[6]!,
        body[7]!,
        body[8]!,
      ];
      const expected = redragonM719ProComputeHandshakeResponse(challenge);
      resp.set(expected, 5);
    } else if (cmd === REDRAGON_M719_PRO_COMMAND.tellDriverStatus) {
      // ACK
    } else if (cmd === REDRAGON_M719_PRO_COMMAND.getConnectStatus) {
      resp[4] = 0x01;
      resp[5] = this.online ? 0x01 : 0x00;
    } else if (cmd === REDRAGON_M719_PRO_COMMAND.getBattery) {
      resp[4] = 0x02;
      resp[5] = this.batteryPercent;
      resp[6] = this.batteryCharging ? 0x01 : 0x00;
    } else if (cmd === REDRAGON_M719_PRO_COMMAND.readEeprom) {
      resp.set(this.eeprom.subarray(addr, addr + len), 5);
    } else if (cmd === REDRAGON_M719_PRO_COMMAND.writeEeprom) {
      this.eeprom.set(body.subarray(5, 5 + len), addr);
    }

    resp[15] = redragonM719ProPacketChecksum(resp, REDRAGON_M719_PRO_RESPONSE_REPORT_ID);

    queueMicrotask(() => {
      this.emitInputReport(REDRAGON_M719_PRO_RESPONSE_REPORT_ID, resp);
    });
  }
}

test("registry selects RedragonM719ProHidClient for 0x25a7:0xfa7e and 0x25a7:0xfab0", () => {
  const wireless = new FakeM719Pro(REDRAGON_M719_PRO_RECEIVER_PRODUCT_ID);
  const wired = new FakeM719Pro(REDRAGON_M719_PRO_WIRED_PRODUCT_ID);

  assert.equal(RedragonM719ProHidClient.isSupported(wireless as unknown as HIDDevice), true);
  assert.equal(RedragonM719ProHidClient.isSupported(wired as unknown as HIDDevice), true);

  const client = createSupportedClient(wireless as unknown as HIDDevice);
  assert.ok(client instanceof RedragonM719ProHidClient);
  assert.equal(deviceBrand(client), "Redragon");
});

test("reads status, updates polling, DPI, stage colors, dual lighting zones, and buttons", async () => {
  const fake = new FakeM719Pro(REDRAGON_M719_PRO_RECEIVER_PRODUCT_ID);
  const client = new RedragonM719ProHidClient(fake as unknown as HIDDevice);

  const status = await client.readStatus();
  assert.equal(status.name, "Redragon M719RGB-PRO");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryPercent, 90);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.dpi, 800);
  assert.equal(status.activeDpiStage, 1);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 2400, 3200]);
  assert.equal(status.lightingZones?.length, 2);

  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setDpiStageValue(1, 5200), 5200);
  assert.equal(await client.setActiveDpiStage(3), 3);
  assert.equal(await client.setDpiStageCount(3), 3);
  assert.equal(await client.setDpiStageColor(2, "#112233"), "#112233");

  // Update main RGB zone ("Mouse")
  const afterRgb = await client.setLighting({
    zone: "Mouse",
    mode: "Neon",
    color: "#0080ff",
    brightness: 40,
    speed: 5,
  });
  assert.equal(afterRgb.mode, "Neon");
  assert.equal(afterRgb.brightness, 40);
  assert.equal(afterRgb.speed, 5);

  // Update DPI indicator zone ("DPI indicator")
  const afterInd = await client.setLighting({
    zone: "DPI indicator",
    mode: "Breathing single",
  });
  assert.equal(afterInd.mode, "Breathing single");

  // Update button mappings (multimedia and keyboard shortcut) and verify left-click guard
  await assert.rejects(
    () => client.setButtonMapping(REDRAGON_M719_PRO_BUTTONS[0].label, "Right click"),
    /Keep Left click/,
  );

  await client.setButtonMapping(REDRAGON_M719_PRO_BUTTONS[4].label, "Calculator");
  await client.setButtonMapping(REDRAGON_M719_PRO_BUTTONS[3].label, "Copy (Ctrl+C)");

  const refreshed = await client.readStatus();
  assert.equal(refreshed.pollingRateHz, 500);
  assert.equal(refreshed.dpiStages?.length, 3);
  assert.equal(refreshed.activeDpiStage, 2);
  assert.equal(refreshed.dpiStages?.[1], 5200);
  assert.equal(refreshed.dpiStageColors?.[2], "#112233");
  assert.equal(refreshed.lighting?.mode, "Neon");
  assert.equal(refreshed.lightingZones?.[1]?.mode, "Breathing single");
  assert.equal(refreshed.buttonMappings?.[REDRAGON_M719_PRO_BUTTONS[4].label], "Calculator");
  assert.equal(refreshed.buttonMappings?.[REDRAGON_M719_PRO_BUTTONS[3].label], "Copy (Ctrl+C)");

  const slot4ComboOffset =
    REDRAGON_M719_PRO_EEPROM.comboBase +
    REDRAGON_M719_PRO_BUTTONS[3].slot * REDRAGON_M719_PRO_EEPROM.comboSlotStride;
  assert.deepEqual(
    [...fake.eeprom.subarray(slot4ComboOffset, slot4ComboOffset + 13)],
    [
      0x04,
      0x80, 0x01, 0x00,
      0x81, 0x06, 0x00,
      0x40, 0x01, 0x00,
      0x41, 0x06, 0x00,
    ],
  );
});

test("supports split sibling command/notify HIDDevices via bindPeers and hardware notifications", async () => {
  const cmdDevice = new FakeM719Pro(REDRAGON_M719_PRO_WIRED_PRODUCT_ID, "command-only");
  const notifyDevice = new FakeM719Pro(REDRAGON_M719_PRO_WIRED_PRODUCT_ID, "notify-only");
  cmdDevice.notifyPeer = notifyDevice;

  assert.ok(
    RedragonM719ProHidClient.supportScore(cmdDevice as unknown as HIDDevice) >
      RedragonM719ProHidClient.supportScore(notifyDevice as unknown as HIDDevice),
  );

  const client = new RedragonM719ProHidClient(cmdDevice as unknown as HIDDevice);
  client.bindPeers([
    cmdDevice as unknown as HIDDevice,
    notifyDevice as unknown as HIDDevice,
  ]);

  const status = await client.readStatus();
  assert.equal(status.name, "Redragon M719RGB-PRO");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.activeDpiStage, 1);

  let notified = 0;
  await client.startNotifications(() => {
    notified += 1;
  });

  const notifyPayload = new Uint8Array(16);
  notifyPayload[4] = 0x01; // DPI stage changed flag
  notifyPayload[5] = 0x03; // Stage index 3
  notifyDevice.emitInputReport(REDRAGON_M719_PRO_NOTIFY_REPORT_ID, notifyPayload);
  assert.equal(notified, 1);

  await client.close();
});

test("reports offline receiver gracefully when wireless mouse is asleep", async () => {
  const fake = new FakeM719Pro(REDRAGON_M719_PRO_RECEIVER_PRODUCT_ID);
  fake.online = false;
  const client = new RedragonM719ProHidClient(fake as unknown as HIDDevice);

  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.batteryPercent, null);

  await assert.rejects(
    () => client.setPollingRate(500),
    /off or asleep/,
  );
});
