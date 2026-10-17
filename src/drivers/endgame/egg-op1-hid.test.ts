import assert from "node:assert/strict";
import test from "node:test";

import { EggOp1HidClient } from "./egg-op1-hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// Config blob from a cabled OP1w 4K v2 (firmware V1.07) diagnostics report:
// 1000 Hz, slamclick + multiclick flags, LOD 1.7 mm, one 1600 CPI stage.
const REPORTED_BLOB = [
  0x00, 0x00, 0x00, 0x03, 0x01, 0x08, 0x21, 0x00, 0x01, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x01, 0xff,
  0xff, 0x00, 0x01, 0x01, 0x00, 0x00, 0xff, 0x01, 0x02, 0xff, 0x00, 0x00, 0x01, 0x03, 0x00, 0xff,
  0x00, 0x01, 0x04, 0x00, 0x40, 0x06, 0x40, 0x06, 0x00, 0x20, 0x03, 0x20, 0x03, 0x00, 0x40, 0x06,
  0x40, 0x06, 0x00, 0x80, 0x0c, 0x80, 0x0c, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x00, 0x02,
  0x00, 0x00, 0x00, 0x00, 0xf0, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x10, 0x00, 0x00,
  0x00, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x08, 0x09, 0xf1, 0x00, 0x00, 0x00, 0x00,
  0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x08, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0x08,
];

const hex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");

/**
 * A 4K v2 that behaves like the real one: rejects the 8K whole-blob store with
 * 0x07 and applies block writes using the layout in johanneszab/endgame-op1w
 * re/PROTOCOL.md section 4, written out independently of eggBlockWrites.
 */
function fake4kV2({ productId = 0x1984, pairedPid = productId as number | null, relayLagReads = 0 } = {}) {
  const state = { pairedPid };
  // Through the dongle the mouse-info reply lags: until it lands, reads return the previous response.
  let relayed: Uint8Array | null = null;
  let lag = 0;
  const blob = new Uint8Array(1024);
  blob.set(REPORTED_BLOB);
  const writes: string[] = [];
  let reply = new Uint8Array(63);
  let stores = 0;
  const answer = (status: number, extra: number[] = []): void => {
    reply = new Uint8Array(63);
    reply.set([status, ...extra]);
  };
  const device = {
    vendorId: 0x3367,
    productId,
    productName: "OP1w 4k v2 Wireless Gaming Mouse",
    opened: true,
    collections: [{
      usagePage: 0xff01,
      usage: 2,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [
        { reportId: 0xa0, items: [{ reportSize: 8, reportCount: 1040 }] },
        { reportId: 0xa1, items: [{ reportSize: 8, reportCount: 63 }] },
      ],
    }],
    async open() {},
    async close() {},
    addEventListener() {},
    removeEventListener() {},
    async sendFeatureReport(reportId: number, data: BufferSource) {
      const bytes = new Uint8Array(data as ArrayBuffer);
      if (reportId === 0xa0) {
        stores += 1;
        return answer(0x07);
      }
      const [command, , , , , chunk] = bytes;
      const payload = bytes.subarray(15);
      if (command === 0x12) return answer(0x01);
      if (command === 0x02) return answer(0x01, [...new Array(15).fill(0), 0x07, 0x01]);
      if (command === 0x0e) {
        // Mouse asleep behind the dongle: status 0x08, no identity.
        if (state.pairedPid === null) return answer(0x08);
        const held = reply;
        answer(0x01, [...new Array(14).fill(0), 0x67, 0x33, state.pairedPid & 0xff, state.pairedPid >> 8]);
        [relayed, reply, lag] = [reply, held, relayLagReads];
        return;
      }
      writes.push(`${hex(bytes.subarray(0, 6))} | ${hex(payload.subarray(0, command === 0x15 ? 11 : 28))}`);
      if (command === 0x14) {
        [0x07, 0x08, 0x09, 0x0a, 0x0b, 0x01, 0x0e, 0x0d].forEach((offset, index) => { blob[offset] = payload[index]; });
        blob.set(payload.subarray(8, 28), 0x23);
      } else if (command === 0x15) {
        [0x0c, 0x05, 0x06, 0x04, 0x3d, 0x44, 0x4b, 0x52, 0x59, 0x03, 0x6f]
          .forEach((offset, index) => { blob[offset] = payload[index]; });
      } else if (command === 0x16) {
        blob.set(payload.subarray(0, 28), 0x37 + (chunk - 1) * 28);
      }
      answer(0x01);
    },
    async receiveFeatureReport(reportId: number) {
      if (reportId === 0xa1) {
        if (relayed && lag-- <= 0) [reply, relayed] = [relayed, null];
        return new DataView(reply.slice().buffer);
      }
      const config = new Uint8Array(1040);
      config[0] = 0x01;
      config.set(blob, 15);
      return new DataView(config.buffer);
    },
  };
  return {
    device: device as unknown as HIDDevice,
    blob,
    state,
    writes,
    stores: () => stores,
  };
}

test("the OP1w 4K v2 writes settings through the vendor's block commands, never the whole-blob store", async () => {
  const mouse = fake4kV2();
  const client = new EggOp1HidClient(mouse.device);

  // Byte for byte what the vendor tool sends for 1000 -> 2000 Hz (capture 07), on this mouse's state.
  assert.equal(await client.setPollingRate(2000), 2000);
  assert.deepEqual(mouse.writes, ["15 0f 0a 00 00 00 | 00 04 21 01 f0 f0 08 08 08 03 00"]);

  mouse.writes.length = 0;
  await client.setDpi(800);
  assert.deepEqual(mouse.writes, [
    "14 0f 1c 00 00 00 | 00 01 0a 00 00 00 01 00 00 20 03 20 03 00 20 03 20 03 00 40 06 40 06 00 80 0c 80 0c",
  ]);

  mouse.writes.length = 0;
  await client.setSensorAngleTuning(-10);
  await client.setForceMaxSensorFps(true);
  assert.equal(mouse.writes.length, 2);
  assert.equal(mouse.blob[0x01], 0xf6);
  assert.equal(mouse.blob[0x06], 0x61);

  const status = await client.readStatus();
  assert.equal(status.eggAngleTuning, -10);
  assert.equal(status.eggForceMaxFps, true);
  assert.equal(status.motionJitterFilter, null);
  assert.equal(status.firmware[0], "Firmware V1.07");
  assert.equal(mouse.stores(), 0);
});

test("OP1w 4K v2 glass mode rescales lift-off like the vendor tool and sends both sensor blocks", async () => {
  const mouse = fake4kV2();
  const client = new EggOp1HidClient(mouse.device);

  await client.setGlassMode(true);
  // Sensor block first with LOD 1.7 mm rewritten to 2 (whole mm), then glass on in byte 11.
  assert.deepEqual(mouse.writes.map((write) => write.slice(0, 2)), ["14", "15"]);
  assert.equal(mouse.blob[0x09], 2);
  assert.equal(mouse.blob[0x6f], 1);

  let status = await client.readStatus();
  assert.equal(status.eggSupportsGlassMode, true);
  assert.equal(status.eggGlassMode, true);
  assert.deepEqual(status.eggLodOptions, ["1.0 mm", "2.0 mm"]);
  assert.equal(status.eggLodIndex, 1);
  assert.equal(status.liftOffDistance, "High");

  await client.setLiftOffDistance("Medium");
  assert.equal(mouse.blob[0x09], 1);

  await client.setGlassMode(false);
  assert.equal(mouse.blob[0x09], 3);
  status = await client.readStatus();
  assert.equal(status.eggGlassMode, false);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(mouse.stores(), 0);
});

test("OP1w 4K v2 polling follows the vendor enum: 0x80 reads as 1000 Hz and free dividers are refused", async () => {
  const mouse = fake4kV2();
  mouse.blob[0x05] = 0x80; // 1000 Hz with wireless power saving
  const client = new EggOp1HidClient(mouse.device);

  const status = await client.readStatus();
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 1000, 2000, 4000]);
  assert.equal(status.eggPollingDivider, undefined);
  await assert.rejects(client.setPollingRate(500), /Unsupported/);
  await assert.rejects(client.setCustomPollingDivider(16), /listed polling rates/);
  assert.deepEqual(mouse.writes, []);
});

test("over the shared 0x1970 dongle, the mouse-info reply names the paired 4K v2", async () => {
  const xm2w = fake4kV2({ productId: 0x1970, pairedPid: 0x1982 });
  assert.equal((await new EggOp1HidClient(xm2w.device).readStatus()).name, "Endgame Gear XM2w 4K v2");

  // Asleep: keep the neutral name, then pick up the model once the mouse answers.
  const sleepy = fake4kV2({ productId: 0x1970, pairedPid: null });
  const client = new EggOp1HidClient(sleepy.device);
  assert.equal((await client.readStatus()).name, "Endgame Gear OP1w/XM2w 4K");
  sleepy.state.pairedPid = 0x1984;
  assert.equal((await client.readStatus()).name, "Endgame Gear OP1w 4K v2");
});

test("a mouse-info reply that lags behind the dongle's held response still names the paired 4K v2", async () => {
  // Hardware test over 0x1970: settings wrote fine, yet the name never resolved.
  const lagging = fake4kV2({ productId: 0x1970, pairedPid: 0x1982, relayLagReads: 2 });
  assert.equal((await new EggOp1HidClient(lagging.device).readStatus()).name, "Endgame Gear XM2w 4K v2");
});

test("an OP1w 4K v1 behind the shared dongle switches to the v1 encodings", async () => {
  // Ticket #0126: an original OP1w 4K was read and written as a v2 (re/PROTOCOL.md section 12).
  const v1 = fake4kV2({ productId: 0x1970, pairedPid: 0x1972 });
  v1.blob[0x09] = 2; // LOD 2 mm: v1 stores whole millimetres
  v1.blob[0x6f] = 1; // v2's glass-mode byte, which the v1 power block must not carry
  const client = new EggOp1HidClient(v1.device);

  const status = await client.readStatus();
  assert.equal(status.name, "Endgame Gear OP1w 4K");
  assert.deepEqual(status.eggLodOptions, ["1 mm", "2 mm"]);
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.eggSupportsGlassMode, false);
  assert.equal(status.eggSupportsV2SensorControls, false);
  assert.equal(status.motionJitterFilter, false);
  assert.deepEqual(status.supportedPollingRates, [1000, 2000, 4000]);
  assert.equal(status.eggCpiMax, 26_000);

  await client.setLiftOffDistance("Medium");
  assert.equal(v1.blob[0x09], 1);
  v1.writes.length = 0;
  await client.setPollingRate(2000);
  assert.deepEqual(v1.writes, ["15 0f 0a 00 00 00 | 00 04 21 01 f0 f0 08 08 08 03 00"]);
  await client.setMotionJitterFilter(true);
  assert.equal(v1.blob[0x06] & 0x10, 0x10);
  await assert.rejects(client.setGlassMode(true), /Glass Mode/);
  await assert.rejects(client.setPollingRate(125), /Unsupported/);
  assert.equal(EggOp1HidClient.isSupported(fake4kV2({ productId: 0x1972 }).device), true);
});

test("writes over the shared dongle wait until the paired mouse identifies itself", async () => {
  const sleepy = fake4kV2({ productId: 0x1970, pairedPid: null });
  const client = new EggOp1HidClient(sleepy.device);
  await assert.rejects(client.setDpi(800), /not identified itself/);
  assert.deepEqual(sleepy.writes, []);
  sleepy.state.pairedPid = 0x1984;
  assert.equal(await client.setDpi(800), 800);
});

test("a stale handle that rejects the first write is closed, reopened and retried once", async () => {
  const mouse = fake4kV2();
  const device = mouse.device as unknown as {
    opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  };
  const send = device.sendFeatureReport.bind(device);
  let stale = true;
  const calls: string[] = [];
  device.open = async () => { calls.push("open"); device.opened = true; stale = false; };
  device.close = async () => { calls.push("close"); device.opened = false; };
  device.sendFeatureReport = async (reportId, data) => {
    if (stale) throw new DOMException("Failed to write the feature report.", "NetworkError");
    return send(reportId, data);
  };

  const status = await new EggOp1HidClient(mouse.device).readStatus();
  assert.equal(status.firmware[0], "Firmware V1.07");
  assert.deepEqual(calls.slice(0, 2), ["close", "open"]);
});

test("a write that still fails after the reopen surfaces the error", async () => {
  const mouse = fake4kV2();
  const device = mouse.device as unknown as { sendFeatureReport(): Promise<void> };
  device.sendFeatureReport = async () => { throw new Error("Failed to write the feature report."); };
  await assert.rejects(new EggOp1HidClient(mouse.device).readStatus(), /Failed to write the feature report/);
});

test("a non-stale write error is not closed and reopened", async () => {
  const mouse = fake4kV2();
  const device = mouse.device as unknown as { close(): Promise<void>; sendFeatureReport(): Promise<void> };
  const calls: string[] = [];
  device.close = async () => { calls.push("close"); };
  device.sendFeatureReport = async () => { throw new DOMException("Rejected by device.", "NotAllowedError"); };
  await assert.rejects(new EggOp1HidClient(mouse.device).readStatus(), /Rejected by device/);
  assert.deepEqual(calls, []);
});
