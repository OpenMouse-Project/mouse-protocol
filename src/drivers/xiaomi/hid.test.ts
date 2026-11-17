import assert from "node:assert/strict";
import test from "node:test";
import { XiaomiHidClient } from "./hid.ts";
import {
  XIAOMI_PACKET_SIZE,
  XIAOMI_REPORT_DATA_SIZE,
  XIAOMI_REPORT_ID,
  xiaomiDecodeDpi,
  xiaomiDecodeLighting,
  xiaomiDecodePolling,
} from "@openmouse/protocol/xiaomi";

/** Builds a 32-byte reply echoing the header and command byte. */
function reply(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(XIAOMI_PACKET_SIZE);
  data.set(bytes);
  return data;
}

class FakeDevice implements HIDDevice {
  vendorId = 0x2717;
  productId = 0x5009;
  productName = "Mi Gaming Mouse";
  opened = false;
  collections: HIDCollectionInfo[] = [{
    usagePage: 0xff00,
    usage: 2,
    children: [],
    featureReports: [],
    inputReports: [{ reportId: XIAOMI_REPORT_ID, items: [{ reportSize: 8, reportCount: XIAOMI_REPORT_DATA_SIZE }] }],
    outputReports: [{ reportId: XIAOMI_REPORT_ID, items: [{ reportSize: 8, reportCount: XIAOMI_REPORT_DATA_SIZE }] }],
  }];
  listeners = new Set<(event: HIDInputReportEvent) => void>();
  sent: Uint8Array[] = [];
  /** Canned replies keyed by the command byte (request[1]). */
  replies = new Map<number, number[]>();
  respond = true;
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void) { this.listeners.add(listener); }
  removeEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void) { this.listeners.delete(listener); }
  emit(payload: Uint8Array) {
    // payload is the 32-byte hidraw layout; WebHID delivers the 31 data
    // bytes without the report-ID byte.
    const data = payload.subarray(1);
    const event = { device: this, reportId: XIAOMI_REPORT_ID, data: new DataView(data.buffer, data.byteOffset, data.byteLength) } as HIDInputReportEvent;
    for (const listener of this.listeners) listener(event);
  }
  async sendReport(reportId: number, data: BufferSource) {
    assert.equal(reportId, XIAOMI_REPORT_ID);
    const request = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    assert.equal(request.length, XIAOMI_REPORT_DATA_SIZE);
    this.sent.push(request.slice());
    if (request[0] === 0xc1) {
      // DPI write: update the read-back state so verification sees the new value.
      this.replies.set(0xc2, [0x4d, 0xc2, 0, request[1]!, request[2]!, request[3]!, request[4]!, request[5]!, request[6]!]);
    }
    if (!this.respond) return;
    const canned = this.replies.get(request[0]!);
    if (canned) this.emit(reply(...canned));
  }
  async sendFeatureReport(): Promise<void> { throw new Error("Feature transport must not be used."); }
  async receiveFeatureReport(): Promise<DataView> { throw new Error("Feature transport must not be used."); }
}

function device(vendorId = 0x2717, productId = 0x5009): FakeDevice {
  const fake = new FakeDevice();
  fake.vendorId = vendorId;
  fake.productId = productId;
  return fake;
}

test("Xiaomi identity accepts both PIDs only with an input/output collection", () => {
  for (const productId of [0x5009, 0x500b]) {
    assert.equal(XiaomiHidClient.isSupported(device(0x2717, productId)), true);
  }
  assert.equal(XiaomiHidClient.isSupported(device(0x2717, 0x500c)), false);
  assert.equal(XiaomiHidClient.isSupported(device(0x1234, 0x5009)), false);
  const bare = device();
  bare.collections[0]!.outputReports = [];
  assert.equal(XiaomiHidClient.isSupported(bare), false);
});

test("readStatus reports battery, DPI, polling and both lighting zones", async () => {
  const fake = device();
  fake.replies.set(0x90, [0x4d, 0x90, 0x90, 87]);
  fake.replies.set(0xc2, [0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1]);
  fake.replies.set(0xc4, [0x4d, 0xc4, 0, 1]);
  fake.replies.set(0xa0, [0x4d, 0xa0, 0, 0, 1, 4, 0, 0, 0, 255, 0]);
  const client = new XiaomiHidClient(fake);
  const status = await client.readStatus();
  assert.equal(status.brand, "Xiaomi");
  assert.equal(status.batteryPercent, 87);
  assert.equal(status.dpi, 800);
  assert.deepEqual(status.dpiStages, [100, 800, 1600, 2400, 4800]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.lightingZones.length, 2);
  assert.equal(status.lightingZones[0]!.zone, "TAIL");
  assert.equal(status.lightingZones[0]!.mode, "Static");
  assert.equal(status.lightingZones[0]!.color, "#00ff00");
  assert.equal(status.lightingZones[1]!.zone, "WHEEL");
  assert.deepEqual(status.lightingZones[1]!.modes, ["Off", "Static"]);
});

test("setDpi writes the full level table and verifies by read-back", async () => {
  const fake = device();
  fake.replies.set(0xc2, [0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1]);
  const client = new XiaomiHidClient(fake);
  const dpi = await client.setDpi(1200);
  assert.equal(dpi, 1200);
  const write = fake.sent.find((frame) => frame[0] === 0xc1);
  assert.ok(write, "a DPI write must be sent");
  // 1200/50 = 24 at the active level (index 1).
  assert.equal(write![1], 2);
  assert.equal(write![2], 24);
  assert.equal(write![6], 1);
});

test("setPollingRate rejects unsupported rates and verifies by read-back", async () => {
  const fake = device();
  fake.replies.set(0xc4, [0x4d, 0xc4, 0, 4]);
  const client = new XiaomiHidClient(fake);
  await assert.rejects(() => client.setPollingRate(750), /not supported/);
  const rate = await client.setPollingRate(250);
  assert.equal(rate, 250);
  const write = fake.sent.find((frame) => frame[0] === 0xc3);
  assert.ok(write, "a polling write must be sent");
  assert.equal(write![1], 4);
});

test("setLighting writes the wire effect and reads the zone back", async () => {
  const fake = device();
  // Read-back echoes the written wire effect: Spectrum is logical 6 → wire 7.
  fake.replies.set(0xa0, [0x4d, 0xa0, 0, 0, 7, 3, 0, 0, 255, 0, 0]);
  const client = new XiaomiHidClient(fake);
  const zone = await client.setLighting({ zone: "TAIL", mode: "Spectrum", color: "#ff0000", speed: 3 });
  assert.equal(zone.mode, "Spectrum");
  assert.equal(zone.color, "#ff0000");
  const write = fake.sent.find((frame) => frame[0] === 0xa1);
  assert.ok(write, "a lighting write must be sent");
  // Spectrum is logical effect 6 → wire 7.
  assert.equal(write![2], 7);
  assert.equal(write![3], 3);
  assert.equal(write![6], 255);
});

test("setLighting rejects an effect the wheel zone does not support", async () => {
  const fake = device();
  const client = new XiaomiHidClient(fake);
  await assert.rejects(
    () => client.setLighting({ zone: "WHEEL", mode: "Spectrum", color: "#ff0000", speed: 3 }),
    /not supported for the wheel zone/,
  );
});

test("a read that never answers times out", async () => {
  const fake = device();
  fake.respond = false;
  const client = new XiaomiHidClient(fake);
  await assert.rejects(() => client.readStatus(), /did not answer/);
});

test("decoders agree with the driver on the wire layout", () => {
  const lighting = xiaomiDecodeLighting(reply(0x4d, 0xa0, 0, 0, 6, 3, 0, 0, 255, 0, 0));
  assert.equal(lighting.effect, 5);
  const dpi = xiaomiDecodeDpi(reply(0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1));
  assert.equal(dpi.levels[1], 800);
  assert.equal(xiaomiDecodePolling(reply(0x4d, 0xc4, 0, 1)), 1000);
});
