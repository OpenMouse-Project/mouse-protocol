import assert from "node:assert/strict";
import test from "node:test";

import { EggOp1HidClient } from "./egg-op1-hid.ts";
import { EggWeHidClient } from "./egg-we-hid.ts";

import {
  WE_OFF,
  WE_REPORT_ID,
  weBuildReadEepromPayload,
  weBuildWriteEepromPayload,
  weExposedFeatures,
  wePackDpiStage,
  wePackScalarPair,
  weParseReadEepromResponse,
  weParseWriteEepromResponse,
  wePatchActiveDpi,
  weReportChecksum,
  weUnpackDpiStage,
  weUnpackScalarPair,
} from "@openmouse/protocol/endgame-gear-we";

function hidDevice(productId: number, productName = "", featureReportIds: number[] = []): HIDDevice {
  return {
    vendorId: 0x3367,
    productId,
    productName,
    collections: featureReportIds.length === 0 ? [] : [{
      usagePage: 0xff02,
      usage: 0,
      featureReports: featureReportIds.map((reportId) => ({ reportId, items: [] })),
      inputReports: [],
      outputReports: [],
      children: [],
    }],
  } as unknown as HIDDevice;
}

test("XM2we receiver revisions are supported and keep their model identity", () => {
  for (const productId of [0x1960, 0x1968, 0x1982]) {
    const device = hidDevice(productId);
    assert.equal(EggWeHidClient.isSupported(device), true);
    assert.equal(EggWeHidClient.isReceiverDevice(device), true);
    assert.equal(EggWeHidClient.displayNameForDevice(device), "Endgame Gear XM2we");
    assert.equal(new EggWeHidClient(device).displayName(), "Endgame Gear XM2we");
  }
});

test("a 0x1970 receiver exposing the OP1-8K command report is left for EggOp1HidClient (issue #107)", () => {
  const legacyWeDongle = hidDevice(0x1970);
  assert.equal(EggWeHidClient.isSupported(legacyWeDongle), true);

  const op1w4kV2Dongle = hidDevice(0x1970, "", [0xa1]);
  assert.equal(EggWeHidClient.isSupported(op1w4kV2Dongle), false);
});

test("a cabled XM2w 4K v2 (0x1982, also an XM2we receiver PID) exposing 0xa1 is left for EggOp1HidClient", () => {
  assert.equal(EggWeHidClient.isSupported(hidDevice(0x1982, "", [0xa1])), false);
  assert.equal(EggOp1HidClient.isSupported(hidDevice(0x1982, "", [0xa1])), true);
  assert.equal(EggWeHidClient.isSupported(hidDevice(0x1982)), true);
});

test("sibling interfaces of a 4K v2 dongle are not picked as WE (ticket #0126)", () => {
  const vendorSibling = hidDevice(0x1970, "", [0x05]);
  assert.deepEqual(EggWeHidClient.pickDevices([hidDevice(0x1970), vendorSibling, hidDevice(0x1970, "", [0xa1])]), []);
  assert.equal(EggWeHidClient.fromAuthorizedDevices([vendorSibling, hidDevice(0x1970, "", [0xa1])]), null);
  assert.deepEqual(EggWeHidClient.pickDevices([vendorSibling]), [vendorSibling]);
});

test("descriptor walks tolerate sparse WebHID collections (openmouse update-protocol)", () => {
  const sparse = {
    vendorId: 0x3710,
    productId: 0x1234,
    productName: "Example Mouse",
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      inputReports: [{ reportId: 0x08 }],
      outputReports: [{ reportId: 0x08 }],
      featureReports: [],
    }],
    opened: false,
  } as unknown as HIDDevice;
  assert.equal(EggWeHidClient.isSupported(sparse), false);
  assert.deepEqual(EggWeHidClient.pickDevices([sparse, sparse]), []);

  const sparseEndgame = {
    vendorId: 0x3367,
    productId: 0x1962,
    productName: "OP1we",
    collections: [{
      usagePage: 0xff02,
      usage: 0,
      featureReports: [{ reportId: 0x04 }],
    }],
    opened: false,
  } as unknown as HIDDevice;
  assert.equal(EggWeHidClient.isSupported(sparseEndgame), true);
  assert.deepEqual(EggWeHidClient.pickDevices([sparse, sparseEndgame]), [sparseEndgame]);
});

test("WE model names can fall back to the USB product string", () => {
  assert.equal(
    EggWeHidClient.displayNameForDevice(hidDevice(0x1962, "XM2we")),
    "Endgame Gear XM2we",
  );
  assert.equal(
    EggWeHidClient.displayNameForDevice(hidDevice(0x1962, "OP1we")),
    "Endgame Gear OP1we",
  );
});

test("commands produce a valid report checksum", () => {
  for (const payload of [weBuildReadEepromPayload(0x1234, 8), weBuildWriteEepromPayload(0x12, [1, 2, 3, 4])]) {
    assert.equal(payload.length, 16);
    assert.equal(payload[15], weReportChecksum(WE_REPORT_ID, [...payload.subarray(0, 15)]));
    assert.equal(([WE_REPORT_ID, ...payload].reduce((sum, byte) => sum + byte, 0) & 0xff), 0x55);
  }
});

test("scalar pairs reject corrupt checksums", () => {
  const [value, checksum] = wePackScalarPair(7);
  assert.equal(weUnpackScalarPair(value, checksum), 7);
  assert.equal(weUnpackScalarPair(value, checksum ^ 1), null);
});

test("read and write responses require successful status", () => {
  const read = new Uint8Array([0x08, 0, 0, 0x34, 2, 0xaa, 0xbb]);
  assert.deepEqual([...weParseReadEepromResponse(read, 0x1234, 2)!], [0xaa, 0xbb]);
  read[1] = 1;
  assert.equal(weParseReadEepromResponse(read, 0x1234, 2), null);
  assert.equal(weParseWriteEepromResponse(new Uint8Array([0x07, 0])), true);
  assert.equal(weParseWriteEepromResponse(new Uint8Array([0x07, 1])), false);
});

test("DPI changes only the active stage and preserves flags", () => {
  const profile = new Uint8Array(WE_OFF.dpiStages + WE_OFF.maxDpiStages * WE_OFF.dpiStageBytes);
  for (let index = 0; index < WE_OFF.maxDpiStages; index += 1) {
    profile.set(wePackDpiStage(400 + index * 50, 400 + index * 50, index), WE_OFF.dpiStages + index * 4);
  }
  const before = new Uint8Array(profile);
  wePatchActiveDpi(profile, 1600, 3);
  for (let index = 0; index < WE_OFF.maxDpiStages; index += 1) {
    const offset = WE_OFF.dpiStages + index * 4;
    if (index !== 3) assert.deepEqual(profile.slice(offset, offset + 4), before.slice(offset, offset + 4));
  }
  assert.deepEqual(weUnpackDpiStage(profile.slice(WE_OFF.dpiStages + 12, WE_OFF.dpiStages + 16)), { x: 1600, y: 1600, flags: 3 });
});

test("DPI patch refuses corrupt source stages", () => {
  const profile = new Uint8Array(WE_OFF.dpiStages + 4);
  assert.throws(() => wePatchActiveDpi(profile, 800, 0), /checksum is invalid/);
});

test("WE mice expose battery, DPI, polling, and lift-off distance", () => {
  assert.deepEqual(weExposedFeatures(), ["battery", "dpi", "polling-rate", "lift-off-distance"]);
});

test("a stale command channel is closed, reopened and the OP1we write retried once", async () => {
  let stale = true;
  const calls: string[] = [];
  const device = {
    vendorId: 0x3367,
    productId: 0x1962,
    productName: "OP1we",
    opened: true,
    collections: [
      { usagePage: 0xff02, usage: 0, featureReports: [{ reportId: WE_REPORT_ID, items: [] }], inputReports: [], outputReports: [], children: [] },
      { usagePage: 0xff01, usage: 0, featureReports: [], inputReports: [{ reportId: 0x09, items: [] }], outputReports: [], children: [] },
    ],
    async open() { calls.push("open"); this.opened = true; stale = false; },
    async close() { calls.push("close"); this.opened = false; },
    addEventListener() {},
    removeEventListener() {},
    async sendFeatureReport() {
      if (stale) throw new DOMException("Failed to write the feature report.", "NetworkError");
      calls.push("sent");
    },
  } as unknown as HIDDevice;
  const client = new EggWeHidClient(device);
  const send = (client as unknown as {
    sendReportRecovering(channels: { cmd: HIDDevice; notify: HIDDevice }, data: ArrayBuffer): Promise<void>;
  }).sendReportRecovering.bind(client);
  await send({ cmd: device, notify: device }, new ArrayBuffer(16));
  assert.deepEqual(calls, ["close", "open", "sent"]);
});

type WeListener = (event: unknown) => void;

function transactDevice(sendFeatureReport: (self: { opened: boolean }, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const listeners = new Set<WeListener>();
  const device = {
    vendorId: 0x3367,
    productId: 0x1962,
    productName: "OP1we",
    opened: true,
    collections: [
      { usagePage: 0xff02, usage: 0, featureReports: [{ reportId: WE_REPORT_ID, items: [] }], inputReports: [], outputReports: [], children: [] },
      { usagePage: 0xff01, usage: 0, featureReports: [], inputReports: [{ reportId: 0x09, items: [] }], outputReports: [], children: [] },
    ],
    async open() { calls.push("open"); this.opened = true; },
    async close() { calls.push("close"); this.opened = false; },
    addEventListener(_type: string, listener: WeListener) { listeners.add(listener); },
    removeEventListener(_type: string, listener: WeListener) { listeners.delete(listener); },
    async sendFeatureReport() { await sendFeatureReport(this, calls); },
  } as unknown as HIDDevice;
  const client = new EggWeHidClient(device);
  client.bindPeers([device]);
  const reply = (command: number) => {
    for (const listener of [...listeners]) {
      listener({ reportId: 0x09, data: new DataView(new Uint8Array([command, 0, 0, 0, 0, 0, 0, 0]).buffer) });
    }
  };
  const transact = (client as unknown as {
    transact(channels: { cmd: HIDDevice; notify: HIDDevice }, command: number, payload: Uint8Array): Promise<Uint8Array>;
  }).transact.bind(client);
  return { client, device, calls, reply, run: () => transact({ cmd: device, notify: device }, 0x04, new Uint8Array(16)) };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
(globalThis as { window?: unknown }).window ??= globalThis;

test("transact keeps the reply window after a slow stale-handle recovery", async () => {
  let stale = true;
  const t = transactDevice(async (self, calls) => {
    if (stale) {
      await wait(1000); // longer than the 900 ms response timeout
      stale = false;
      throw new DOMException("Failed to write the feature report.", "NetworkError");
    }
    calls.push("sent");
  });
  const pending = t.run();
  await wait(1100);
  t.reply(0x04);
  assert.equal((await pending)[0], 0x04);
  assert.deepEqual(t.calls, ["close", "open", "sent"]);
});

test("transact surfaces the error when the retry after reopen also fails", async () => {
  const t = transactDevice(async () => { throw new DOMException("Failed to write the feature report.", "NetworkError"); });
  await assert.rejects(t.run(), /Failed to write the feature report/);
  assert.deepEqual(t.calls, ["close", "open"]);
});

test("transact does not resend after close() during recovery", async () => {
  let writes = 0;
  const t = transactDevice(async () => { writes += 1; throw new DOMException("Failed to write the feature report.", "NetworkError"); });
  const original = t.device.open.bind(t.device);
  t.device.open = async () => { await wait(20); await original(); };
  const pending = t.run();
  const outcome = assert.rejects(pending, /cancelled|closed/);
  await wait(5);
  await t.client.close();
  await outcome;
  assert.equal(writes, 1);
});

test("transact does not retry a non-stale write error", async () => {
  const t = transactDevice(async () => { throw new DOMException("Rejected by device.", "NotAllowedError"); });
  await assert.rejects(t.run(), /Rejected by device/);
  assert.deepEqual(t.calls, []);
});
