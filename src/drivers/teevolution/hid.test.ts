import assert from "node:assert/strict";
import test from "node:test";

import { TeevolutionHidClient } from "./hid.ts";
import {
  TEEVOLUTION_COMMAND,
  TEEVOLUTION_FLASH,
  TEEVOLUTION_KEY_CLASS,
  TEEVOLUTION_LCD_REPORT_ID,
  TEEVOLUTION_PACKET_LENGTH,
  TEEVOLUTION_PROFILE_COUNT,
  TEEVOLUTION_REPORT_ID,
  teevolutionBuildLcdTimePacket,
  teevolutionEncodeKeyFunction,
  teevolutionPacketChecksum,
} from "@openmouse/protocol/teevolution";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

function device(productId: number, reportId = TEEVOLUTION_REPORT_ID): HIDDevice {
  return {
    vendorId: 0x3554,
    productId,
    productName: "RapidSync",
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      children: [],
      featureReports: [],
      inputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
      outputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

function lcdDevice(productId = 0xf523): HIDDevice & { sent: Array<{ reportId: number; data: Uint8Array }> } {
  const sent: Array<{ reportId: number; data: Uint8Array }> = [];
  const fake = {
    vendorId: 0x3554,
    productId,
    productName: "RapidSync LCD",
    opened: false,
    sent,
    collections: [{
      usagePage: 0xff08,
      usage: 2,
      children: [],
      featureReports: [],
      inputReports: [{ reportId: TEEVOLUTION_LCD_REPORT_ID, items: [{ reportCount: 39, reportSize: 8 }] }],
      outputReports: [{ reportId: TEEVOLUTION_LCD_REPORT_ID, items: [{ reportCount: 39, reportSize: 8 }] }],
    }],
    async open() {
      fake.opened = true;
    },
    async close() {
      fake.opened = false;
    },
    async sendReport(reportId: number, data: BufferSource) {
      sent.push({ reportId, data: new Uint8Array(data as Uint8Array) });
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return fake as unknown as HIDDevice & { sent: Array<{ reportId: number; data: Uint8Array }> };
}

test("support is limited to Terra Pro Compx transports with report 8", () => {
  // Arrange
  const receiver = device(0xf523);
  const wired = device(0xf520);
  const alt = device(0xf5bb);
  const wrongPid = device(0xfb56);
  const wrongReport = device(0xf523, 0x09);

  // Act / Assert
  assert.equal(TeevolutionHidClient.isSupported(receiver), true);
  assert.equal(TeevolutionHidClient.isSupported(wired), true);
  assert.equal(TeevolutionHidClient.isSupported(alt), true);
  assert.equal(TeevolutionHidClient.isSupported(device(0xf522)), true);
  assert.equal(TeevolutionHidClient.isSupported(wrongPid), false);
  assert.equal(TeevolutionHidClient.isSupported(wrongReport), false);
  assert.equal(TeevolutionHidClient.isSupported(lcdDevice()), false);
});

test("mouseOfflineMessage tells RapidSync users to wake or pair", () => {
  assert.equal(
    TeevolutionHidClient.mouseOfflineMessage(true),
    TeevolutionHidClient.RAPIDSYNC_OFFLINE_ERROR,
  );
  assert.equal(
    TeevolutionHidClient.mouseOfflineMessage(false),
    TeevolutionHidClient.MOUSE_OFFLINE_ERROR,
  );
});

test("syncDongleClock writes host time on the authorized LCD interface", async () => {
  // Arrange
  const config = device(0xf523);
  const lcd = lcdDevice();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { hid: { getDevices: async () => [config, lcd] } },
  });
  const client = new TeevolutionHidClient(config);
  const now = new Date(2026, 7, 15, 21, 27, 0);
  const expected = teevolutionBuildLcdTimePacket(now);

  // Act
  const written = await client.syncDongleClock(now);

  // Assert
  assert.equal(written, true);
  assert.equal(lcd.sent.length, 1);
  assert.equal(lcd.sent[0]?.reportId, TEEVOLUTION_LCD_REPORT_ID);
  assert.deepEqual([...lcd.sent[0]!.data], [...expected.subarray(1)]);
  assert.equal(await client.syncDongleClock(now), true);
  assert.equal(lcd.sent.length, 1, "clock sync is once per connection");
});

class FakeTerraDevice {
  vendorId = 0x3554;
  productId = 0xf520;
  productName = "Terra Pro";
  opened = false;
  collections = [{
    usagePage: 0xff00,
    usage: 1,
    children: [],
    featureReports: [],
    inputReports: [{ reportId: TEEVOLUTION_REPORT_ID, items: [{ reportCount: 16, reportSize: 8 }] }],
    outputReports: [{ reportId: TEEVOLUTION_REPORT_ID, items: [{ reportCount: 16, reportSize: 8 }] }],
  }];
  readonly flash = new Uint8Array(256);
  currentProfile = 0;
  readonly sent: Array<{ reportId: number; data: Uint8Array }> = [];
  private listeners = new Set<(event: HIDInputReportEvent) => void>();

  constructor() {
    const defaults: Array<readonly [number, number]> = [
      [TEEVOLUTION_KEY_CLASS.mouse, 0x0100],
      [TEEVOLUTION_KEY_CLASS.mouse, 0x0200],
      [TEEVOLUTION_KEY_CLASS.mouse, 0x0400],
      [TEEVOLUTION_KEY_CLASS.mouse, 0x0800],
      [TEEVOLUTION_KEY_CLASS.mouse, 0x1000],
      [TEEVOLUTION_KEY_CLASS.dpi, 0x0100],
    ];
    defaults.forEach(([cls, param], index) => {
      this.flash.set(teevolutionEncodeKeyFunction(cls, param), TEEVOLUTION_FLASH.keyFunction + index * 4);
    });
    this.flash[TEEVOLUTION_FLASH.reportRate] = 1;
    this.flash[TEEVOLUTION_FLASH.maxDpiStage] = 4;
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

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const packet = new Uint8Array(data as Uint8Array);
    this.sent.push({ reportId, data: packet });
    const reply = new Uint8Array(TEEVOLUTION_PACKET_LENGTH);
    const command = packet[0] ?? 0;
    reply[0] = command;
    if (command === TEEVOLUTION_COMMAND.deviceOnline) {
      reply[5] = 1;
    } else if (command === TEEVOLUTION_COMMAND.encryptionData) {
      reply[9] = 14;
      reply[10] = 2;
      reply[11] = 2;
    } else if (command === TEEVOLUTION_COMMAND.getCurrentConfig) {
      reply[5] = this.currentProfile;
    } else if (command === TEEVOLUTION_COMMAND.setCurrentConfig) {
      this.currentProfile = packet[5] ?? 0;
      reply[5] = this.currentProfile;
    } else if (command === TEEVOLUTION_COMMAND.readFlashData) {
      const address = ((packet[2] ?? 0) << 8) | (packet[3] ?? 0);
      const length = packet[4] ?? 0;
      reply[2] = packet[2] ?? 0;
      reply[3] = packet[3] ?? 0;
      reply[4] = length;
      reply.set(this.flash.subarray(address, address + length), 5);
    } else if (command === TEEVOLUTION_COMMAND.writeFlashData) {
      const address = ((packet[2] ?? 0) << 8) | (packet[3] ?? 0);
      const length = packet[4] ?? 0;
      this.flash.set(packet.subarray(5, 5 + length), address);
      reply[2] = packet[2] ?? 0;
      reply[3] = packet[3] ?? 0;
      reply[4] = length;
    }
    reply[15] = teevolutionPacketChecksum(reply);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({
          reportId: TEEVOLUTION_REPORT_ID,
          data: new DataView(reply.buffer),
        } as HIDInputReportEvent);
      }
    });
  }
}

test("setButtonMapping writes only that button's four flash bytes", async () => {
  const fake = new FakeTerraDevice();
  const client = new TeevolutionHidClient(fake as unknown as HIDDevice);
  const before = [...fake.flash];

  await client.setButtonMapping("Forward", "Backward");

  const address = TEEVOLUTION_FLASH.keyFunction + 4 * 4;
  const expected = teevolutionEncodeKeyFunction(TEEVOLUTION_KEY_CLASS.mouse, 0x0800);
  assert.deepEqual([...fake.flash.subarray(address, address + 4)], [...expected]);
  for (let index = 0; index < before.length; index += 1) {
    if (index >= address && index < address + 4) continue;
    assert.equal(fake.flash[index], before[index], `byte ${index} untouched`);
  }
  const write = fake.sent.find(({ data }) => data[0] === TEEVOLUTION_COMMAND.writeFlashData);
  assert.ok(write);
  assert.equal(write!.data[2], address >> 8);
  assert.equal(write!.data[3], address & 0xff);
  assert.deepEqual([...write!.data.subarray(5, 9)], [...expected]);
});

test("setButtonMapping refuses to remove the last Left Click", async () => {
  const fake = new FakeTerraDevice();
  const client = new TeevolutionHidClient(fake as unknown as HIDDevice);
  await assert.rejects(() => client.setButtonMapping("Left", "Right Click"), /Left Click/);
});

test("setButtonMapping rejects an unknown button or action", async () => {
  const client = new TeevolutionHidClient(new FakeTerraDevice() as unknown as HIDDevice);
  await assert.rejects(() => client.setButtonMapping("Thumb", "Left Click"), /no "Thumb" button/);
  await assert.rejects(() => client.setButtonMapping("Left", "Launch rocket"), /Unknown button action/);
});

test("readStatus reports four onboard profile banks", async () => {
  const fake = new FakeTerraDevice();
  fake.currentProfile = 2;
  const client = new TeevolutionHidClient(fake as unknown as HIDDevice);
  const status = await client.readStatus();
  assert.equal(status.activeProfile, 3);
  assert.equal(status.profileCount, TEEVOLUTION_PROFILE_COUNT);
});

test("setProfile switches the firmware bank and confirms", async () => {
  const fake = new FakeTerraDevice();
  const client = new TeevolutionHidClient(fake as unknown as HIDDevice);

  await client.setProfile(4);

  assert.equal(fake.currentProfile, 3);
  const write = fake.sent.find(({ data }) => data[0] === TEEVOLUTION_COMMAND.setCurrentConfig);
  assert.ok(write);
  assert.equal(write!.data[4], 1);
  assert.equal(write!.data[5], 3);
  const status = await client.readStatus();
  assert.equal(status.activeProfile, 4);
});

test("setProfile rejects an index outside the mouse's range", async () => {
  const client = new TeevolutionHidClient(new FakeTerraDevice() as unknown as HIDDevice);
  await assert.rejects(() => client.setProfile(0), /1-4/);
  await assert.rejects(() => client.setProfile(5), /1-4/);
});
