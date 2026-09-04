import assert from "node:assert/strict";
import test from "node:test";

import { AtkHidClient } from "./hid.ts";

type Sent = { reportId: number; data: Uint8Array };

/**
 * Minimal controllable stand-in for the R1 dongle: it records outgoing frames
 * and answers each incoming read with the next queued reply, dispatching the
 * input report on an idle callback so the driver's exchange promise resolves.
 */
class FakeAtkDevice {
  vendorId = 0x373b;
  productId = 0x1085;
  productName = "Wireless mouse -1k dongle";
  opened = false;
  collections = [{
    usagePage: 0xff02,
    usage: 0x0002,
    children: [],
    featureReports: [],
    inputReports: [],
    outputReports: [],
  }];

  readonly sent: Sent[] = [];
  replies: number[][] = [];
  private listeners = new Set<(event: HIDInputReportEvent) => void>();

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async forget(): Promise<void> {}

  addEventListener(
    type: string,
    listener: (event: HIDInputReportEvent) => void,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "inputreport") this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: HIDInputReportEvent) => void,
    _options?: boolean | EventListenerOptions,
  ): void {
    if (type === "inputreport") this.listeners.delete(listener);
  }

  async sendReport(reportId: number, data: ArrayBuffer): Promise<void> {
    const frame = new Uint8Array(data);
    this.sent.push({ reportId, data: frame });
    // EEPROM writes (0x07) are fire-and-forget; read and informational
    // commands (0x04 battery, 0x08 EEPROM, 0x12 version) get a reply.
    if (frame[0] === 0x07) return;
    const reply = this.replies.shift();
    if (!reply) return;
    const payload = new Uint8Array(reply);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ reportId, data: new DataView(payload.buffer) } as HIDInputReportEvent);
      }
    });
  }

  async sendFeatureReport(_reportId: number, _data: ArrayBuffer): Promise<void> {
    throw new Error("not used by the ATK driver");
  }

  async receiveFeatureReport(_reportId: number): Promise<DataView> {
    throw new Error("not used by the ATK driver");
  }
}

function device(productId = 0x1085, productName = "Wireless mouse -1k dongle"): HIDDevice {
  const fake = new FakeAtkDevice();
  fake.productId = productId;
  fake.productName = productName;
  return fake as unknown as HIDDevice;
}

/** 16-byte EEPROM read reply for address 0x0070 carrying the given data row. */
function readReply(row: number[]): number[] {
  return [0x08, 0x00, 0x00, 0x70, 0x04, ...row, 0, 0, 0, 0, 0, 0, 0];
}

/** 16-byte read reply echoing `data` at the given EEPROM address. */
function reply(cmd: number, address: number, data: number[]): number[] {
  const frame = [cmd, 0x00, (address >> 8) & 0xff, address & 0xff, data.length, ...data];
  while (frame.length < 16) frame.push(0x00);
  return frame;
}

function wrote(fake: HIDDevice): Uint8Array {
  const write = (fake as unknown as FakeAtkDevice).sent.find(({ reportId, data }) =>
    reportId === 8 && data[0] === 0x07);
  assert.ok(write, "expected a write frame");
  return write!.data;
}

function assertR1LiveSettingsWrite(fake: HIDDevice, selector: number, value: number): void {
  const write = wrote(fake);
  assert.equal(write[2], 0x00);
  assert.equal(write[3], 0x70, "live-settings register");
  assert.equal(write[4], 0x04);
  assert.equal(write[5], selector);
  assert.equal(write[6], value);
  assert.equal(write[7], 0x00);
  assert.equal(write[8], 0x55 - value, "0x55 - value");
  assert.equal(sumFrame(8, write), 0x55, "frame checksum");
}

function sumFrame(reportId: number, payload: Uint8Array): number {
  let sum = reportId;
  for (const byte of payload) sum += byte & 0xff;
  return sum & 0xff;
}

test("support is limited to 0x373b with the vendor config collection", () => {
  assert.equal(AtkHidClient.isSupported(device(0x1085)), true);
  assert.equal(AtkHidClient.isSupported(device(0x11d5, "ATK dongle")), true);
  assert.equal(AtkHidClient.isSupported({ ...device(), vendorId: 0x1234 }), false);
});

test("R1 receiver advertises only its stock polling rates", () => {
  const wlmouseStyle = new AtkHidClient(device(0x1085));
  const notR1 = new AtkHidClient(device(0x11d5, "ATK dongle"));

  assert.deepEqual(wlmouseStyle.getSupportedPollingRates(), [250, 500, 1000]);
  assert.deepEqual(notR1.getSupportedPollingRates(), [125, 250, 500, 1000, 2000, 4000, 8000]);
});

test("R1 setPollingRate writes the 0x0070 live-settings row", async () => {
  const fake = device(0x1085);
  (fake as unknown as FakeAtkDevice).replies = [readReply([0x0b, 0x01, 0x00, 0x54])];
  const client = new AtkHidClient(fake);

  assert.equal(await client.setPollingRate(1000), 1000);

  const writes = (fake as unknown as FakeAtkDevice).sent.filter(({ reportId, data }) =>
    reportId === 8 && data[0] === 0x07);
  assert.equal(writes.length, 1);
  const write = writes[0]!.data;
  assert.equal(write[2], 0x00);
  assert.equal(write[3], 0x70);
  assert.equal(write[4], 0x04);
  assert.equal(write[5], 0x0b, "polling selector");
  assert.equal(write[6], 0x01, "1000 Hz code");
  assert.equal(write[7], 0x00);
  assert.equal(write[8], 0x54, "0x55 - 0x01");
  assert.equal(sumFrame(8, write), 0x55, "frame checksum");
});

test("R1 polling write is still emitted when the settings row does not echo", async () => {
  const fake = device(0x1085);
  (fake as unknown as FakeAtkDevice).replies = [readReply([0x00, 0x00, 0x00, 0x00])];
  const client = new AtkHidClient(fake);

  const confirmed = await client.setPollingRate(500);
  assert.equal(confirmed, 1000, "falls back to the receiver ceiling on an unknown row");

  const write = (fake as unknown as FakeAtkDevice).sent.find(({ reportId, data }) =>
    reportId === 8 && data[0] === 0x07);
  assert.ok(write, "write should still be sent");
  assert.equal(write!.data[6], 0x02, "500 Hz code");
});

test("R1 setPollingRate rejects rates the dongle cannot do", async () => {
  const client = new AtkHidClient(device(0x1085));
  await assert.rejects(client.setPollingRate(2000), /does not support 2000 Hz/);
});

test("R1 setLiftOffDistance writes the 0x0070 LOD live-settings row", async () => {
  const low = new AtkHidClient(device(0x1085));
  assert.equal(await low.setLiftOffDistance("Low"), "Low");
  assertR1LiveSettingsWrite(low.device, 0x03, 1);

  const high = new AtkHidClient(device(0x1085));
  assert.equal(await high.setLiftOffDistance("High"), "High");
  assertR1LiveSettingsWrite(high.device, 0x03, 2);

  const medium = new AtkHidClient(device(0x1085));
  await assert.rejects(medium.setLiftOffDistance("Medium"), /does not support a medium lift-off distance/);
});

test("R1 setDebounceTime writes the 0x0070 debounce live-settings row", async () => {
  const client = new AtkHidClient(device(0x1085));
  assert.equal(await client.setDebounceTime(4), 4);
  assertR1LiveSettingsWrite(client.device, 0x02, 4);

  const oversized = new AtkHidClient(device(0x1085));
  await assert.rejects(oversized.setDebounceTime(21), /between 1 and 20/);
  const zero = new AtkHidClient(device(0x1085));
  await assert.rejects(zero.setDebounceTime(0), /between 1 and 20/);
});

test("R1 setAngleSnapping writes the 0x0070 angle live-settings row", async () => {
  const on = new AtkHidClient(device(0x1085));
  assert.equal(await on.setAngleSnapping(true), true);
  assertR1LiveSettingsWrite(on.device, 0x01, 0x10);

  const off = new AtkHidClient(device(0x1085));
  assert.equal(await off.setAngleSnapping(false), false);
  assertR1LiveSettingsWrite(off.device, 0x01, 0x00);
});

test("NON-R1 debounce ceiling still applies on the A9 family", () => {
  assert.equal(new AtkHidClient(device(0x1085)).getDebounceMaxMs(), 20);
  assert.equal(new AtkHidClient(device(0x11d5, "ATK dongle")).getDebounceMaxMs(), 15);
});

test("R1 readStatus hides the unsupported medium lift-off level", async () => {
  const fake = device(0x1085);
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x04, 0x0000, [0x5f]),
    reply(0x08, 0x0000, [0x40, 0x15, 0x02, 0x53, 0x00, 0x55]),
    reply(0x08, 0x000c, [0x4f, 0x4f, 0x00, 0xb7]),
    reply(0x12, 0x0000, [0x03, 0x13]),
    reply(0x08, 0x000a, [0x04, 0x51]),
    reply(0x08, 0x00a9, [0x08, 0x4d, 0x00, 0x55, 0x1e, 0x37, 0x00, 0x55, 0x00, 0x55]),
    reply(0x08, 0x00bd, [0xff, 0xff, 0xff, 0xff]),
    reply(0x08, 0x0070, [0x01, 0x10, 0x00, 0x44]),
  ];
  const client = new AtkHidClient(fake);

  const status = await client.readStatus();
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.debounceMs, 8);
  assert.equal(status.motionSync, false);
  assert.equal(status.sleepTimeout, 300);
  assert.equal(status.angleSnapping, false);
});