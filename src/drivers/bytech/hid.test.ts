import assert from "node:assert/strict";
import test from "node:test";
import { BytechHidClient } from "./hid.ts";
import {
  BYTECH_PIAO_PRODUCT_IDS,
  BYTECH_REPORT_ID,
  BYTECH_USAGE,
  BYTECH_USAGE_PAGE,
  BYTECH_VENDOR_ID,
  bytechPollingCodeToHz,
  bytechPollingHzToCode,
  bytechSetCrc,
} from "../../bytech/index.ts";

function fakeDevice(productId: number) {
  const sentReports: Array<{ reportId: number; data: Uint8Array }> = [];
  const device = {
    vendorId: BYTECH_VENDOR_ID,
    productId,
    productName: "PIAO",
    opened: true,
    collections: [
      {
        usagePage: BYTECH_USAGE_PAGE,
        usage: BYTECH_USAGE,
        featureReports: [{ reportId: BYTECH_REPORT_ID, items: [] }],
        inputReports: [],
        outputReports: [],
        children: [],
      },
    ],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, data: Uint8Array) => {
      sentReports.push({ reportId, data: new Uint8Array(data) });
    },
    receiveFeatureReport: async (reportId: number) => {
      const reply = new Uint8Array(64);
      reply[0] = reportId; // 3
      reply[1] = 0x50; // 'P'
      reply[2] = 0x00;
      reply[3] = 0x0b;
      reply[4] = 0x0a;
      reply[5] = 0x00;
      reply[6] = 0x01; // status OK
      reply[7] = 0x00; // rate code 0 = 1000 Hz
      reply[8] = 0x12; // active DPI stage
      reply[9] = 0x01; // LOD 1mm
      reply[10] = 0x02; // debounce 2ms
      reply[11] = 0x20; // motion sync bit
      reply[14] = 0x02; // sleep: 2 units * 30s = 60s
      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;
  return { device, sentReports };
}

test("BytechHidClient identifies Bytech devices", () => {
  const { device } = fakeDevice(0x1015);
  assert.equal(BytechHidClient.isSupported(device), true);
});

test("BytechHidClient rejects non-matching vendor ID", () => {
  const { device } = fakeDevice(0x1015);
  (device as unknown as { vendorId: number }).vendorId = 0x1234;
  assert.equal(BytechHidClient.isSupported(device), false);
});

test("BytechHidClient reads wired status correctly", async () => {
  const { device } = fakeDevice(0x1015);
  const client = new BytechHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.brand, "IPI");
  assert.equal(status.name, "IPI Float 88 (Wired)");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.motionSync, true);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.dpi, 800);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.dpiStages?.length, 2);
  assert.equal(status.ui?.dpiStageEditor?.countEditable, true);
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  assert.equal(status.powerMode, "Normal");
  assert.deepEqual(status.powerModes, ["Game", "High Speed", "Normal"]);
  assert.equal(status.debounceMs, 2);
  assert.equal(status.sleepTimeout, 60);
});

test("BytechHidClient setDebounceTime updates debounce", async () => {
  const { device } = fakeDevice(0x1015);
  const client = new BytechHidClient(device);
  await client.readStatus();
  assert.equal(await client.setDebounceTime(4), 4);
  assert.equal(await client.setDebounceTime(60), 60);
});

test("BytechHidClient setSleepTimeout sets timeout in seconds", async () => {
  const { device, sentReports } = fakeDevice(0x1015);
  const client = new BytechHidClient(device);
  await client.readStatus();
  assert.equal(await client.setSleepTimeout(300), 300); // 5 mins
  const lastSent = sentReports[sentReports.length - 1];
  assert.equal(lastSent?.reportId, 3);
  assert.equal(lastSent?.data[6], 10); // 10 units * 30s = 300s
});

test("BytechHidClient setPowerMode changes the operation mode", async () => {
  const { device } = fakeDevice(0x1015);
  const client = new BytechHidClient(device);
  await client.readStatus();
  assert.equal(await client.setPowerMode("Game"), "Game");
  assert.equal(await client.setPowerMode("High Speed"), "High Speed");
  assert.equal(await client.setPowerMode("Normal"), "Normal");
});

test("BytechHidClient setLiftOffDistance handles two-level LOD", async () => {
  const { device } = fakeDevice(0x1015);
  const client = new BytechHidClient(device);
  await client.readStatus();
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  await assert.rejects(() => client.setLiftOffDistance("Medium"), RangeError);
});

test("BytechHidClient setDpiStageCount changes the stage count", async () => {
  const { device, sentReports } = fakeDevice(0x1015);
  const client = new BytechHidClient(device);
  await client.readStatus();
  const newCount = await client.setDpiStageCount(4);
  assert.equal(newCount, 4);
  const lastSent = sentReports[sentReports.length - 1];
  assert.equal(lastSent?.reportId, 3);
  assert.equal(lastSent?.data[6], 0x14);
});

test("BytechHidClient reads wireless status correctly", async () => {
  const { device } = fakeDevice(0x1014);
  const client = new BytechHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.brand, "IPI");
  assert.equal(status.name, "IPI Float 88 (Wireless)");
  assert.equal(status.connectionType, "Wireless");
});

test("BytechHidClient polling rate codes map correctly", () => {
  assert.equal(bytechPollingCodeToHz(0), 1000);
  assert.equal(bytechPollingCodeToHz(4), 8000);
  assert.equal(bytechPollingHzToCode(8000), 4);
  assert.equal(bytechPollingHzToCode(1000), 0);
});

test("Bytech checksum sums bytes 1..62 modulo 256", () => {
  const buf = new Uint8Array(63);
  buf[1] = 80;
  buf[2] = 10;
  bytechSetCrc(buf);
  assert.equal(buf[0], 90);
});
