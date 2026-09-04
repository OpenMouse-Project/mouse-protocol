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
    // Writes (0x07) are fire-and-forget; only read (0x08) commands get a reply.
    if (frame[0] !== 0x08) return;
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