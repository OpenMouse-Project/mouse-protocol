import test from "node:test";
import assert from "node:assert/strict";
import { HitscanHidClient } from "./hid.js";
import { hitscanBuildCommand, hitscanBuildReadPayload, hitscanChecksum } from "../../hitscan/index.js";

class FakeDevice implements HIDDevice {
  vendorId = 0x3770;
  productId = 0x0100;
  productName = "Hitscan";
  opened = false;
  collections: HIDCollectionInfo[] = [{ usagePage: 0xff02, usage: 2, children: [], featureReports: [],
    inputReports: [{ reportId: 8, items: [{ reportSize: 8, reportCount: 16 }] }],
    outputReports: [{ reportId: 8, items: [{ reportSize: 8, reportCount: 16 }] }],
  }];
  listeners = new Set<(event: HIDInputReportEvent) => void>();
  sent: Uint8Array[] = [];
  flash = new Uint8Array(0x1b00);
  respond = true;
  corruptReadback = false;
  beforeReply?: (request: Uint8Array) => void;
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void) { this.listeners.add(listener); }
  removeEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void) { this.listeners.delete(listener); }
  emit(payload: Uint8Array) {
    const buffer = new Uint8Array(payload.length + 4);
    buffer.set(payload, 2);
    const event = { device: this, reportId: 8, data: new DataView(buffer.buffer, 2, payload.length) } as HIDInputReportEvent;
    for (const listener of this.listeners) listener(event);
  }
  async sendReport(reportId: number, data: BufferSource) {
    assert.equal(reportId, 8);
    const request = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(request.slice());
    this.beforeReply?.(request);
    if (!this.respond) return;
    const reply = request.slice();
    const address = (request[2]! << 8) | request[3]!;
    const length = request[4]!;
    if (request[0] === 7) this.flash.set(request.subarray(5, 5 + length), address);
    if (request[0] === 8) {
      reply.set(this.flash.subarray(address, address + length), 5);
      if (this.corruptReadback) reply[5] ^= 1;
      reply[15] = hitscanChecksum([8, ...reply.subarray(0, 15)]);
    }
    this.emit(reply); // Deliberately before the send promise resolves.
  }
  async sendFeatureReport(): Promise<void> { throw new Error("Feature transport must not be used."); }
  async receiveFeatureReport(): Promise<DataView> { throw new Error("Feature transport must not be used."); }
}

test("Hitscan identity accepts all configured transports only with input/output report shape", () => {
  const device = new FakeDevice();
  for (const productId of [0x0100, 0x0200, 0x0300]) {
    device.productId = productId;
    assert.equal(HitscanHidClient.isSupported(device), true);
  }
  device.productId = 0x0400;
  assert.equal(HitscanHidClient.isSupported(device), false);
  device.productId = 0x0100;
  device.collections[0]!.outputReports = [];
  assert.equal(HitscanHidClient.isSupported(device), false);
});

test("output exchange ignores notifications, unrelated and invalid replies with DataView offsets", async () => {
  const device = new FakeDevice();
  let notifications = 0;
  const client = new HitscanHidClient(device, { onNotification: () => notifications++ });
  device.beforeReply = request => {
    device.emit(hitscanBuildCommand(0x0a));
    device.emit(hitscanBuildCommand(0x12));
    const invalid = request.slice(); invalid[15] ^= 1; device.emit(invalid);
    device.emit(hitscanBuildReadPayload(0x20, 2));
  };
  assert.deepEqual(await client.readFlash(0x10, 2), new Uint8Array(2));
  assert.equal(notifications, 1);
  await client.close();
  assert.equal(device.listeners.size, 0);
});

test("multi-chunk writes are serialized and verified by complete readback", async () => {
  const device = new FakeDevice();
  const client = new HitscanHidClient(device);
  const data = Uint8Array.from({ length: 23 }, (_, i) => i + 1);
  await Promise.all([client.writeFlash(0x100, data), client.readFlash(0x200, 1)]);
  assert.deepEqual(device.sent.map(p => p[0]), [7, 7, 7, 8, 8, 8, 8]);
  assert.deepEqual(await client.readFlash(0x100, data.length), data);
  device.corruptReadback = true;
  await assert.rejects(client.writeFlash(0x100, data), /did not retain/);
  await client.close();
});

test("timeout retries are bounded and do not poison the command queue", async () => {
  const device = new FakeDevice();
  device.respond = false;
  const client = new HitscanHidClient(device, { replyTimeoutMs: 5, attempts: 2 });
  await assert.rejects(client.exchange(hitscanBuildCommand(3)), /did not answer/);
  assert.equal(device.sent.length, 2);
  device.respond = true;
  await client.exchange(hitscanBuildCommand(3));
  await client.close();
});

test("closing a client rejects an active waiter and removes its listener", async () => {
  const device = new FakeDevice();
  device.respond = false;
  const client = new HitscanHidClient(device, { replyTimeoutMs: 1000 });
  let sent!: () => void;
  const started = new Promise<void>(resolve => { sent = resolve; });
  device.beforeReply = () => sent();
  const result = assert.rejects(client.exchange(hitscanBuildCommand(3)), /closed/);
  await started;
  await client.close();
  await result;
  assert.equal(device.opened, false);
  assert.equal(device.listeners.size, 0);
});
