import assert from "node:assert/strict";
import test from "node:test";

import { BloodyHidClient } from "./hid.ts";
import {
  BLOODY_FLASH_SECTOR_HEADER,
  bloodyDpiToRawStep,
  BLOODY_REPORT_ID,
  BLOODY_VENDOR_ID,
  BLOODY_W70_MAX_PRODUCT_ID,
} from "../../bloody/index.ts";

function createMockBloodyDevice(
  productId = BLOODY_W70_MAX_PRODUCT_ID,
  options: { emptySens?: boolean; noSector?: boolean } = {},
) {
  // Profile sector (0xe000) as stored on the device, with custom button mappings.
  const sector = new Uint8Array(256);
  sector.set(BLOODY_FLASH_SECTOR_HEADER, 0);
  sector[8] = 4;
  [1000, 1200, 1600, 2000, 4000].forEach((dpi, i) => { sector[12 + i * 6 + 4] = bloodyDpiToRawStep(dpi); });
  for (let i = 0x48; i < 0x80; i++) sector[i] = (i * 7 + 3) & 0xff; // distinctive button map
  sector[0x3c] = 0x05;
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
      if (pendingRequest[0] === 0x2f && pendingRequest[1] === 0x01 && pendingRequest[23] === 0x08) {
        sector.set(pendingRequest.subarray(31, 63), pendingRequest[27]);
      }
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
      } else if (command === 0x2f && pendingRequest[1] === 0x00) {
        if (!options.noSector) {
          reply[0] = 0x2f;
          reply.set(sector.subarray(pendingRequest[27], pendingRequest[27] + 32), 31);
        }
      } else if (command === 0x0e) {
        // Polling response: 1000 Hz (code 0x01 at index 14)
        reply[0] = 0x0e;
        reply[14] = 0x01;
      }

      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;

  return { hid, writes, sector };
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

test("BloodyHidClient reads stages from the flash sector when the 0x02 reply is all zeros", async () => {
  const { hid } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);

  const status = await client.readStatus();
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.dpi, 1000);
  assert.deepEqual(status.dpiStages, [1000, 1200, 1600, 2000, 4000]);
});

test("BloodyHidClient marks stages unknown and refuses writes when neither 0x02 nor the sector is readable", async () => {
  const { hid, writes } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true, noSector: true });
  const client = new BloodyHidClient(hid);

  const status = await client.readStatus();
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.ui?.settingsReady, false);
  assert.deepEqual(status.dpiStages, []);

  const before = writes.length;
  await assert.rejects(() => client.setDpiStageValue(0, 800), /unknown/);
  await assert.rejects(() => client.setDpiStageCount(3), /unknown/);
  await assert.rejects(() => client.setActiveDpiStage(0), /unknown/);
  assert.equal(writes.length, before, "no packets may be sent");
});

test("BloodyHidClient refuses to write when the sector cannot be read", async () => {
  const { hid, writes, sector } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);
  await client.readStatus();
  // Device stops answering sector reads after the initial status read.
  const originalReceive = hid.receiveFeatureReport.bind(hid);
  hid.receiveFeatureReport = async (id: number) => {
    const view = await originalReceive(id);
    return new DataView(new Uint8Array(view.byteLength).buffer);
  };
  const before = writes.length;
  const snapshot = new Uint8Array(sector);
  await assert.rejects(() => client.setDpiStageValue(0, 800), /refusing to overwrite/);
  const sent = writes.slice(before);
  assert.ok(sent.every((w) => !(w[0] === 0x20 || (w[0] === 0x2f && w[1] === 0x01) || w[0] === 0x0a)), "no unlock/program/save packets");
  assert.deepEqual(sector, snapshot);
});

test("BloodyHidClient rejects unencodable DPI values", async () => {
  const { hid, writes } = createMockBloodyDevice();
  const client = new BloodyHidClient(hid);
  await client.readStatus();
  const before = writes.length;
  for (const bad of [0, 50, 1250, 10100, 16000, Number.NaN]) {
    await assert.rejects(() => client.setDpiStageValue(0, bad), RangeError);
  }
  assert.equal(writes.length, before);
});

test("flash write preserves button mappings and every non-DPI byte of the sector", async () => {
  const { hid, writes, sector } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);
  await client.readStatus();
  const original = new Uint8Array(sector);

  await client.setDpiStageValue(2, 2400);
  await client.setDpiStageCount(3);

  const dpiBytes = new Set<number>([8]);
  for (let i = 0; i < 5; i++) dpiBytes.add(12 + i * 6 + 4);
  for (let i = 0; i < sector.length; i++) {
    if (!dpiBytes.has(i)) assert.equal(sector[i], original[i], `byte 0x${i.toString(16)} must be preserved`);
  }
  assert.equal(sector[12 + 2 * 6 + 4], bloodyDpiToRawStep(2400));
  assert.equal(sector[8], 2);
  // Unchanged chunks are not reprogrammed: stage edits live in the first chunk only.
  const programmed = writes.filter((w) => w[0] === 0x2f && w[1] === 0x01 && w[23] === 0x08);
  assert.ok(programmed.every((w) => w[27] === 0));
});

test("failed write leaves cached stage state untouched", async () => {
  const { hid } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);
  const status = await client.readStatus();
  const originalSend = hid.sendFeatureReport.bind(hid);
  hid.sendFeatureReport = async (id: number, buffer: BufferSource) => {
    const b = new Uint8Array(buffer as ArrayBuffer);
    if (b[0] === 0x2f && b[1] === 0x01 && b[23] === 0x08) throw new Error("boom");
    return originalSend(id, buffer);
  };
  await assert.rejects(() => client.setDpiStageValue(0, 1200), /boom/);
  await assert.rejects(() => client.setDpiStageCount(2), /boom/);
  assert.deepEqual(status.dpiStages, [1000, 1200, 1600, 2000, 4000]);
  assert.equal(status.dpi, 1000);
  hid.sendFeatureReport = originalSend;
  const after = await client.readStatus();
  assert.deepEqual(after.dpiStages, [1000, 1200, 1600, 2000, 4000]);
});

test("cleanup failures do not mask the original error and every cleanup step is attempted", async () => {
  const { hid, writes } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);
  await client.readStatus();
  const before = writes.length;
  const originalSend = hid.sendFeatureReport.bind(hid);
  hid.sendFeatureReport = async (id: number, buffer: BufferSource) => {
    const b = new Uint8Array(buffer as ArrayBuffer);
    if (b[0] === 0x2f && b[1] === 0x01 && b[23] === 0x08) throw new Error("chunk failed");
    if (b[0] === 0x20 && b[6] === 0x00) { writes.push(b); throw new Error("lock failed"); }
    return originalSend(id, buffer);
  };
  await assert.rejects(() => client.setDpiStageValue(0, 1200), /chunk failed/);
  const sent = writes.slice(before);
  assert.ok(sent.some((w) => w[0] === 0x20 && w[6] === 0x00), "lock attempted");
  assert.ok(sent.some((w) => w[0] === 0x0a), "save still attempted after lock failure");
});

test("BloodyHidClient executes full W70 Max flash sector write sequence when lastSensRaw is unset", async () => {
  const { hid, writes } = createMockBloodyDevice(BLOODY_W70_MAX_PRODUCT_ID, { emptySens: true });
  const client = new BloodyHidClient(hid);

  await client.readStatus();
  const writeCountBefore = writes.length;

  // Change stage 0 to 800 DPI on W70 Max
  await client.setDpiStageValue(0, 800);

  const flashWrites = writes.slice(writeCountBefore);
  // Sector reads precede the write; only the changed chunk is programmed.
  const isRead = (w: Uint8Array) => w[0] === 0x2f && w[1] === 0x00;
  assert.equal(flashWrites.filter(isRead).length, 8);
  const seq = flashWrites.filter((w) => !isRead(w));
  // 1 (unlock) + 1 (changed chunk) + 1 (commit) + 1 (reset) + 1 (runtime 0x0d) + 1 (lock) + 1 (save) = 7
  assert.equal(seq.length, 7);

  // 1. Unlock flash programming mode (0x20 with 0x01 at index 6)
  assert.equal(seq[0][0], 0x20);
  assert.equal(seq[0][6], 0x01);

  // 2. Changed chunk (offset 0 of sector 0xe000) holding stage 0: 800 DPI (raw step 18 at sector byte 16)
  const chunkPkt = seq[1];
  assert.equal(chunkPkt[0], 0x2f);
  assert.equal(chunkPkt[1], 0x01);
  assert.equal(chunkPkt[23], 0x08);
  assert.equal(chunkPkt[27], 0);
  assert.equal(chunkPkt[28], 0xe0);
  assert.equal(chunkPkt[31 + 16], 18);

  // 3. Magic commit signature (0xa4a4a4a4)
  const commitPkt = seq[2];
  assert.equal(commitPkt[0], 0x2f);
  assert.equal(commitPkt[1], 0x01);
  assert.equal(commitPkt[23], 0x01);
  assert.equal(commitPkt[28], 0xe0);
  assert.deepEqual([...commitPkt.subarray(31, 35)], [0xa4, 0xa4, 0xa4, 0xa4]);

  // 4. Reset notification packet (0x13)
  assert.equal(seq[3][0], 0x13);
  assert.equal(seq[3][3], 0x80);

  // 5. Runtime DPI command (0x0d)
  assert.equal(seq[4][0], 0x0d);
  assert.equal(seq[4][11], 18); // bloodyDpiToRawStep(800) = 18

  // 6. Lock flash programming mode (0x20 with 0x00 at index 6)
  assert.equal(seq[5][0], 0x20);
  assert.equal(seq[5][6], 0x00);

  // 7. Save settings (0x0a)
  assert.equal(seq[6][0], 0x0a);
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
    if (bytes[0] === 0x2f && bytes[1] === 0x01 && bytes[23] === 0x08) {
      chunkCount++;
      if (chunkCount === 1) {
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
  const lockPkt = errorWrites.find((w) => w[0] === 0x20 && w[6] === 0x00);
  const savePkt = errorWrites.find((w) => w[0] === 0x0a);
  assert.ok(lockPkt, "Flash lock (0x20, byte 6 = 0) should be called in finally");
  assert.ok(savePkt, "Save command (0x0a) should be called in finally");
});
