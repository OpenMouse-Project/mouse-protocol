import assert from "node:assert/strict";
import test from "node:test";

import { BloodyHidClient } from "./hid.ts";
import {
  BLOODY_REPORT_ID,
  BLOODY_VENDOR_ID,
  BLOODY_W70_MAX_PRODUCT_ID,
} from "../../bloody/index.ts";

function createMockBloodyDevice(productId = BLOODY_W70_MAX_PRODUCT_ID) {
  let pendingRequest: Uint8Array | null = null;
  const writes: Uint8Array[] = [];
  let mockSensStorage: Uint8Array | null = null;

  const hid = {
    vendorId: BLOODY_VENDOR_ID,
    productId,
    productName: "Bloody W70 Max",
    opened: false,
    collections: [
      {
        usagePage: 0xff00,
        usage: 1,
        children: [],
        featureReports: [
          { reportId: BLOODY_REPORT_ID, items: [{ reportSize: 8, reportCount: 63 }] },
        ],
      },
    ],
    async open() {
      this.opened = true;
    },
    async close() {
      this.opened = false;
    },
    async sendFeatureReport(reportId: number, buffer: BufferSource) {
      assert.equal(reportId, BLOODY_REPORT_ID);
      pendingRequest = new Uint8Array(buffer as ArrayBuffer);
      writes.push(pendingRequest);
      if (pendingRequest[0] === 0x02 && pendingRequest[7] === 0xff) {
        mockSensStorage = new Uint8Array(pendingRequest);
      }
    },
    async receiveFeatureReport(reportId: number) {
      assert.equal(reportId, BLOODY_REPORT_ID);
      assert.ok(pendingRequest);
      const command = pendingRequest[0];
      const reply = new Uint8Array(63);

      if (command === 0x02) {
        if (mockSensStorage) {
          reply.set(mockSensStorage);
          reply[7] = 0xa4;
          reply[8] = 0xa4;
        } else {
          // Sensitivity response: 5 stages (1000, 2000, 3000, 4000, 5000), stage 1 active
          reply[0] = 0x02;
          reply[2] = 0x2a;
          reply[4] = 0x60;
          reply[7] = 0xa4;
          reply[8] = 0xa4;
          reply[15] = 4; // 5 stages - 1
          reply[17] = 1; // stage 1 active (2000 DPI)
          // Stage 0: 1000 DPI (0x14 * 50)
          reply[19] = 0x16; reply[20] = 0x14; reply[21] = 0x16; reply[22] = 0x14;
          // Stage 1: 2000 DPI (0x28 * 50)
          reply[25] = 0x2e; reply[26] = 0x28; reply[27] = 0x2e; reply[28] = 0x28;
          // Stage 2: 3000 DPI (0x3c * 50)
          reply[31] = 0x45; reply[32] = 0x3c; reply[33] = 0x45; reply[34] = 0x3c;
          // Stage 3: 4000 DPI (0x50 * 50)
          reply[37] = 0x5c; reply[38] = 0x50; reply[39] = 0x5c; reply[40] = 0x50;
          // Stage 4: 5000 DPI (0x64 * 50)
          reply[43] = 0x73; reply[44] = 0x64; reply[45] = 0x73; reply[46] = 0x64;
        }
      } else if (command === 0x0e) {
        // Polling response: 1000 Hz (code 0x01 at index 14)
        reply[0] = 0x0e;
        reply[14] = 0x01;
      }

      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;

  return { hid, writes };
}

test("BloodyHidClient recognizes supported device by VID, PID and feature report collection", () => {
  const { hid } = createMockBloodyDevice();
  assert.equal(BloodyHidClient.isSupported(hid), true);

  // Different VID should be rejected
  assert.equal(BloodyHidClient.isSupported({ ...hid, vendorId: 0x1234 } as HIDDevice), false);

  // Different PID should be rejected
  assert.equal(BloodyHidClient.isSupported({ ...hid, productId: 0x9999 } as HIDDevice), false);

  // Missing feature report collection should be rejected
  assert.equal(BloodyHidClient.isSupported({ ...hid, collections: [] } as unknown as HIDDevice), false);
});

test("BloodyHidClient readStatus correctly parses sensitivity and hides polling card", async () => {
  const { hid } = createMockBloodyDevice();
  const client = new BloodyHidClient(hid);

  const status = await client.readStatus();
  assert.equal(status.brand, "Bloody");
  assert.equal(status.name, "Bloody W70 Max");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.dpi, 2000);
  assert.equal(status.activeDpiStage, 1);
  assert.deepEqual(status.dpiStages, [1000, 2000, 3000, 4000, 5000]);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, []);
  assert.equal(status.ui?.hidePollingCard, true);
  assert.equal(status.ui?.valuesVerified, true);
});

test("BloodyHidClient setDpi sends feature report and updates status", async () => {
  const { hid, writes } = createMockBloodyDevice();
  const client = new BloodyHidClient(hid);

  await client.readStatus();
  const writeCountBefore = writes.length;
  const newDpi = await client.setDpi(3200);
  assert.equal(newDpi, 3200);

  const setWrites = writes.slice(writeCountBefore);
  const flashWrite = setWrites.find((w) => w[0] === 0x02);
  assert.ok(flashWrite);
  assert.equal(flashWrite[7], 0xff);
  assert.equal(flashWrite[8], 0xff);

  const setWrite = setWrites.find((w) => w[0] === 0x0d);
  assert.ok(setWrite);
  assert.equal(setWrite[9], 0x40);
  assert.equal(setWrite[10], 0x40);
  assert.equal(setWrite[11], 74); // bloodyDpiToRawStep(3200) = 74 (0x4a)

  const saveWrite = setWrites.find((w) => w[0] === 0x0a);
  assert.ok(saveWrite);

  // Subsequent readStatus should preserve and reflect the set DPI
  const afterStatus = await client.readStatus();
  assert.equal(afterStatus.dpi, 3200);
});

test("BloodyHidClient hides polling card and setPollingRate is no-op", async () => {
  const { hid } = createMockBloodyDevice();
  const client = new BloodyHidClient(hid);

  const status = await client.readStatus();
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, []);
  assert.equal(status.ui?.hidePollingCard, true);

  const reportedRate = await client.setPollingRate(500);
  assert.equal(reportedRate, 1000);
});

test("BloodyHidClient setActiveDpiStage, setDpiStageValue, and setDpiStageCount work as expected", async () => {
  const { hid } = createMockBloodyDevice();
  const client = new BloodyHidClient(hid);

  await client.readStatus();

  // Test setDpiStageCount
  const count = await client.setDpiStageCount(3);
  assert.equal(count, 3);
  const statusAfterCount = await client.readStatus();
  assert.equal(statusAfterCount.dpiStages.length, 3);

  // Test setDpiStageValue
  const val = await client.setDpiStageValue(1, 2400);
  assert.equal(val, 2400);
  const statusAfterVal = await client.readStatus();
  assert.equal(statusAfterVal.dpiStages[1], 2400);

  // Test setActiveDpiStage
  const active = await client.setActiveDpiStage(1);
  assert.equal(active, 1);
  const statusAfterActive = await client.readStatus();
  assert.equal(statusAfterActive.activeDpiStage, 1);
  assert.equal(statusAfterActive.dpi, 2400);

  // Calling setDpi while on stage 1 should update stage 1, NOT stage 0
  await client.setDpi(3200);
  const statusAfterDpi = await client.readStatus();
  assert.equal(statusAfterDpi.activeDpiStage, 1);
  assert.equal(statusAfterDpi.dpi, 3200);
  assert.equal(statusAfterDpi.dpiStages[1], 3200);
});

test("BloodyHidClient setBacklight sends feature report with brightness level", async () => {
  const { hid, writes } = createMockBloodyDevice();
  const client = new BloodyHidClient(hid);

  const level = await client.setBacklight(3);
  assert.equal(level, 3);

  const lastWrite = writes[writes.length - 1];
  assert.ok(lastWrite);
  assert.equal(lastWrite[0], 0x11);
  assert.equal(lastWrite[3], 0x80);
  assert.equal(lastWrite[7], 3);
});
