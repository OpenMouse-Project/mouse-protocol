import test from "node:test";
import assert from "node:assert/strict";
import { HitscanHidClient } from "./hid.ts";
import {
  hitscanBuildCommand, hitscanBuildReadPayload, hitscanChecksum, hitscanEncode3395Dpi, hitscanEncodeRecord,
  hitscanEncodeScalar,
} from "@openmouse/protocol/hitscan";
import { createSupportedClient, deviceBrand } from "../registry.ts";

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
  /** Data bytes (payload[5..]) answered for non-flash commands, keyed by opcode. */
  replies = new Map<number, number[]>();
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
    const canned = this.replies.get(request[0]!);
    if (canned) { reply.set(canned, 5); reply[15] = hitscanChecksum([8, ...reply.subarray(0, 15)]); }
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

/** A plausible flash image: 1000 Hz, three stages on stage 2, 2 mm LOD, shortcut on Forward. */
function seeded(productId = 0x0200): FakeDevice {
  const device = new FakeDevice();
  device.productId = productId;
  const put = (address: number, bytes: Uint8Array) => device.flash.set(bytes, address);
  put(0x00, hitscanEncodeScalar(0x01));
  put(0x02, hitscanEncodeScalar(3));
  put(0x04, hitscanEncodeScalar(1));
  put(0x0a, hitscanEncodeScalar(2));
  [400, 800, 6000].forEach((dpi, stage) => put(0x0c + stage * 4, hitscanEncode3395Dpi(dpi).record));
  [[255, 0, 0], [0, 255, 0], [0, 0, 255]].forEach((rgb, stage) => put(0x2c + stage * 4, hitscanEncodeRecord(rgb)));
  [[1, 1, 0], [1, 2, 0], [1, 4, 0], [1, 8, 0], [5, 0, 0], [2, 1, 0]]
    .forEach((action, index) => put(0x60 + index * 4, hitscanEncodeRecord(action)));
  put(0xa9, hitscanEncodeScalar(4));
  put(0xab, hitscanEncodeScalar(1));
  put(0xaf, hitscanEncodeScalar(0));
  put(0xb1, hitscanEncodeScalar(1));
  device.replies.set(0x04, [87, 0, 0x0f, 0xa0]);
  device.replies.set(0x12, [1, 0x05]);
  return device;
}

test("the registry creates the Hitscan client under the Hitscan brand", () => {
  const client = createSupportedClient(new FakeDevice());
  assert.ok(client instanceof HitscanHidClient);
  assert.equal(deviceBrand(client), "Hitscan");
});

test("status decodes the config block, battery and firmware", async () => {
  const client = new HitscanHidClient(seeded());
  const status = await client.readStatus();
  assert.equal(status.brand, "Hitscan");
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000]);
  assert.deepEqual(status.dpiStages, [400, 800, 6000]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.dpi, 800);
  assert.deepEqual(status.dpiStageColors, ["#ff0000", "#00ff00", "#0000ff"]);
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.liftOffScale?.millimetres, 2);
  assert.equal(status.debounceMs, 4);
  assert.equal(status.motionSync, true);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.rippleControl, true);
  assert.equal(status.batteryPercent, 87);
  assert.equal(status.batteryVoltageMv, 4000);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.firmware, ["Mouse v1.05"]);
  assert.deepEqual(status.buttonMappings, {
    Left: "Left Click", Right: "Right Click", Middle: "Middle Click", Back: "Backward", Forward: "Shortcut", DPI: "DPI Loop",
  });
  assert.deepEqual(status.fixedButtons, ["Left", "Forward"]);
  assert.equal(status.ui?.hideSleepCard, true);
  await client.close();
});

test("a wired mouse is not asked for its battery", async () => {
  const device = seeded(0x0100);
  const client = new HitscanHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.connectionType, "Wired");
  assert.ok(!device.sent.some(request => request[0] === 0x04));
  await client.close();
});

test("a corrupt DPI stage fails the read instead of inventing a value", async () => {
  const device = seeded();
  device.flash[0x0c + 4 + 3] ^= 1;
  const client = new HitscanHidClient(device);
  await assert.rejects(client.readStatus(), /DPI stage 2/);
  await client.close();
});

test("the live poll re-reads the active stage and polling rate", async () => {
  const device = seeded();
  const client = new HitscanHidClient(device);
  await client.readStatus();
  device.flash.set(hitscanEncodeScalar(2), 0x04);
  device.flash.set(hitscanEncodeScalar(0x20), 0x00);
  const live = await client.readStatus(true);
  assert.equal(live.activeDpiStage, 2);
  assert.equal(live.dpi, 6000);
  assert.equal(live.pollingRateHz, 4000);
  await client.close();
});

test("setters write checksummed records and keep the cache current", async () => {
  const device = seeded(0x0300);
  const client = new HitscanHidClient(device);
  await client.readStatus();
  assert.equal(await client.setPollingRate(8000), 8000);
  assert.deepEqual([...device.flash.subarray(0, 2)], [0x40, 0x15]);
  assert.equal(await client.setDpiStageValue(2, 4100), 4100);
  assert.deepEqual([...device.flash.subarray(0x14, 0x18)], [0x28, 0x28, 0x11, 0xf4]);
  await assert.rejects(client.setDpiStageValue(2, 4150), /100-DPI steps/);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setActiveDpiStage(0), 0);
  assert.equal(await client.setDpiStageColor(0, "#12ABef"), "#12abef");
  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  assert.equal(await client.setDebounceTime(8), 8);
  await assert.rejects(client.setDebounceTime(9), /between 0 and 8/);
  assert.equal(await client.setMotionSync(false), false);
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(await client.setRippleControl(false), false);
  await client.setButtonMapping("DPI", "Polling Rate Switch");
  assert.deepEqual([...device.flash.subarray(0x74, 0x78)], [7, 0, 0, 0x4e]);
  await assert.rejects(client.setButtonMapping("Left", "Right Click"), /cannot be remapped/);
  await assert.rejects(client.setButtonMapping("Back", "Macro"), /not an action/);
  const status = await client.readStatus(true);
  assert.equal(status.pollingRateHz, 8000);
  assert.deepEqual(status.dpiStages, [400, 1600, 4100]);
  assert.equal(status.dpi, 400);
  assert.equal(status.dpiStageColors?.[0], "#12abef");
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.debounceMs, 8);
  assert.equal(status.buttonMappings?.DPI, "Polling Rate Switch");
  await client.close();
});

test("8000 Hz is refused on the wired mouse and the normal receiver", async () => {
  for (const productId of [0x0100, 0x0200]) {
    const client = new HitscanHidClient(seeded(productId));
    await assert.rejects(client.setPollingRate(8000), /8000 Hz/);
    await client.close();
  }
});

test("shrinking the stage list moves the active stage first", async () => {
  const device = seeded();
  device.flash.set(hitscanEncodeScalar(2), 0x04);
  const client = new HitscanHidClient(device);
  await client.readStatus();
  device.sent = [];
  assert.equal(await client.setDpiStageCount(2), 2);
  const writes = device.sent.filter(request => request[0] === 7).map(request => request[3]);
  assert.deepEqual(writes, [0x04, 0x02]);
  const status = await client.readStatus();
  assert.equal(status.activeDpiStage, 1);
  assert.deepEqual(status.dpiStages, [400, 800]);
  await client.close();
});

test("shrinking the stage list without a prior status read still reads the active stage", async () => {
  const device = seeded();
  device.flash.set(hitscanEncodeScalar(2), 0x04);
  const client = new HitscanHidClient(device);
  assert.equal(await client.setDpiStageCount(2), 2);
  assert.deepEqual([...device.flash.subarray(0x04, 0x06)], [...hitscanEncodeScalar(1)]);
  await client.close();
});

test("setDpi writes the stage the mouse is on, not the cached one", async () => {
  const device = seeded();
  const client = new HitscanHidClient(device);
  await client.readStatus();
  // A DPI-button press moves the mouse from stage 2 to stage 3.
  device.flash.set(hitscanEncodeScalar(2), 0x04);
  assert.equal(await client.setDpi(3200), 3200);
  assert.deepEqual([...device.flash.subarray(0x14, 0x18)], [...hitscanEncode3395Dpi(3200).record]);
  assert.deepEqual([...device.flash.subarray(0x10, 0x14)], [...hitscanEncode3395Dpi(800).record]);
  const status = await client.readStatus(true);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpi, 3200);
  await client.close();
});

test("a corrupt active-stage record fails setDpi instead of writing stage 1", async () => {
  const device = seeded();
  device.flash[0x05] ^= 1;
  const client = new HitscanHidClient(device);
  await assert.rejects(client.setDpi(1600), /corrupt active DPI stage/);
  assert.ok(!device.sent.some(request => request[0] === 7));
  await client.close();
});

test("closing while the device is still opening leaves no listener behind", async () => {
  const device = new FakeDevice();
  let finishOpen!: () => void;
  device.open = () => new Promise<void>(resolve => { finishOpen = () => { device.opened = true; resolve(); }; });
  const client = new HitscanHidClient(device);
  const opening = client.open();
  const closing = client.close();
  finishOpen();
  await assert.rejects(opening, /closed/);
  await closing;
  assert.equal(device.listeners.size, 0);
  assert.equal(device.opened, false);
});
