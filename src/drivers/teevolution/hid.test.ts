import assert from "node:assert/strict";
import test from "node:test";

import { TeevolutionHidClient } from "./hid.ts";
import {
  TEEVOLUTION_LCD_REPORT_ID,
  TEEVOLUTION_REPORT_ID,
  teevolutionBuildLcdTimePacket,
} from "@openmouse/protocol/teevolution";

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
