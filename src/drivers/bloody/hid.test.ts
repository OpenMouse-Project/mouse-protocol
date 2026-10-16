import assert from "node:assert/strict";
import test from "node:test";

import { BloodyHidClient } from "./hid.ts";
import {
  BLOODY_REPORT_ID,
  BLOODY_VENDOR_ID,
  BLOODY_W70_MAX_PRODUCT_ID,
} from "../../bloody/index.ts";

function createMockBloodyDevice(
  productId = BLOODY_W70_MAX_PRODUCT_ID,
  options: { emptySens?: boolean } = {},
) {
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
        if (options.emptySens) {
          // Hardware like W70 Max returns all zeros for opcode 0x02
          return new DataView(reply.buffer);
        }
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

test("BloodyHidClient reports valuesVerified: false when sensitivity reply is all zeros", async () => {
  const { hid } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);

  const status = await client.readStatus();
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.dpi, 1000);
  assert.deepEqual(status.dpiStages, [1000, 1200, 1600, 2000, 4000]);
});

test("BloodyHidClient executes full W70 Max flash sector write sequence when lastSensRaw is unset", async () => {
  const { hid, writes } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);

  await client.readStatus();
  const writeCountBefore = writes.length;

  // Change stage 0 to 800 DPI on W70 Max
  await client.setDpiStageValue(0, 800);

  const flashWrites = writes.slice(writeCountBefore);
  // Total writes: 1 (unlock) + 8 (chunks) + 1 (commit) + 1 (reset) + 1 (runtime 0x0d) + 1 (lock) + 1 (save) = 14
  assert.equal(flashWrites.length, 14);

  // 1. Unlock flash programming mode (0x20 with 0x01 at index 6)
  assert.equal(flashWrites[0][0], 0x20);
  assert.equal(flashWrites[0][6], 0x01);

  // 2. 8 flash chunks to sector 0xe000..0xe0e0
  for (let c = 0; c < 8; c++) {
    const chunkPkt = flashWrites[1 + c];
    assert.equal(chunkPkt[0], 0x2f);
    assert.equal(chunkPkt[1], 0x01);
    assert.equal(chunkPkt[23], 0x08); // size 8 (32 bytes)
    assert.equal(chunkPkt[27], c * 32); // offset
    assert.equal(chunkPkt[28], 0xe0); // address high byte
  }

  // First chunk holds the updated stage 0: 800 DPI (raw step 18 at byte offset 16 in sector, which is pkt[31 + 16])
  assert.equal(flashWrites[1][31 + 16], 18);

  // 3. Magic commit signature (0xa4a4a4a4)
  const commitPkt = flashWrites[9];
  assert.equal(commitPkt[0], 0x2f);
  assert.equal(commitPkt[1], 0x01);
  assert.equal(commitPkt[23], 0x01);
  assert.equal(commitPkt[28], 0xe0);
  assert.equal(commitPkt[31], 0xa4);
  assert.equal(commitPkt[32], 0xa4);
  assert.equal(commitPkt[33], 0xa4);
  assert.equal(commitPkt[34], 0xa4);

  // 4. Reset notification packet (0x13)
  const resetPkt = flashWrites[10];
  assert.equal(resetPkt[0], 0x13);
  assert.equal(resetPkt[3], 0x80);

  // 5. Runtime DPI command (0x0d)
  const runtimePkt = flashWrites[11];
  assert.equal(runtimePkt[0], 0x0d);
  assert.equal(runtimePkt[11], 18); // bloodyDpiToRawStep(800) = 18

  // 6. Lock flash programming mode (0x20 with 0x00 at index 6)
  assert.equal(flashWrites[12][0], 0x20);
  assert.equal(flashWrites[12][6], 0x00);

  // 7. Save settings (0x0a)
  assert.equal(flashWrites[13][0], 0x0a);
});

test("writeFlashSector guarantees flash locking and saving run even if an intermediate write fails", async () => {
  const { hid, writes } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);

  await client.readStatus();
  const writeCountBefore = writes.length;

  let chunkCount = 0;
  const originalSend = hid.sendFeatureReport.bind(hid);
  hid.sendFeatureReport = async (reportId: number, buffer: BufferSource) => {
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    if (bytes[0] === 0x2f && bytes[28] === 0xe0) {
      chunkCount++;
      if (chunkCount === 3) {
        throw new Error("Simulated USB transport failure during chunk write");
      }
    }
    return originalSend(reportId, buffer);
  };

  await assert.rejects(
    async () => client.setDpiStageValue(0, 1200),
    /Simulated USB transport failure/,
  );

  const errorWrites = writes.slice(writeCountBefore);
  // Verify that even after failure, the finally block sent lock (0x20 0x00) and save (0x0a)
  const lockPkt = errorWrites.find((w) => w[0] === 0x20 && w[1] === 0x00);
  const savePkt = errorWrites.find((w) => w[0] === 0x0a);
  assert.ok(lockPkt, "Flash lock (0x20 0x00) should be called in finally");
  assert.ok(savePkt, "Save command (0x0a) should be called in finally");
});
