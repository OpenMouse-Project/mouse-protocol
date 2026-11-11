import assert from "node:assert/strict";
import test from "node:test";

Object.assign(globalThis, { window: globalThis });

import { createSupportedClient } from "../registry.ts";

const { PulsarProHidClient } = await import("./pulsar-pro-hid.ts");

class FakePulsarProDevice {
  opened = true;
  readonly vendorId = 0x3710;
  readonly productId = 0x5405;
  readonly productName = "Pulsar PRO Dongle";
  readonly collections = [];
  sends = 0;
  opens = 0;
  private listener: ((event: HIDInputReportEvent) => void) | null = null;

  addEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void): void {
    if (this.listener === listener) this.listener = null;
  }

  async open(): Promise<void> { this.opens += 1; this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendReport(_reportId: number, data: BufferSource): Promise<void> {
    this.sends += 1;
    const view = data as ArrayBufferView;
    assert.equal(view.byteLength, 64, "wireless capture uses 64-byte transfers too");
    const command = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)[0] ?? 0;
    const response = new Uint8Array(64);
    response[0] = 0xa6;
    queueMicrotask(() => this.listener?.({ data: new DataView(response.buffer) } as HIDInputReportEvent));
    assert.equal(command, 0xc4);
  }
}

test("A6 rejects an optional command immediately and caches the unsupported query", async () => {
  const device = new FakePulsarProDevice();
  const client = new PulsarProHidClient(device as unknown as HIDDevice);
  await client.open();
  const optionalQuery = (client as unknown as {
    queryOptional(command: number, timeoutMs: number): Promise<Uint8Array | null>;
  }).queryOptional.bind(client);

  const started = Date.now();
  assert.equal(await optionalQuery(0xc4, 1_500), null);
  assert.ok(Date.now() - started < 250, "A6 should not wait for the request timeout");
  assert.equal(await optionalQuery(0xc4, 1_500), null);
  assert.equal(device.sends, 1, "a rejected optional query should not be probed again");
});

test("a command reopens a receiver that closed without an explicit client close", async () => {
  const device = new FakePulsarProDevice();
  device.opened = false;
  const client = new PulsarProHidClient(device as unknown as HIDDevice);
  const optionalQuery = (client as unknown as {
    queryOptional(command: number, timeoutMs: number): Promise<Uint8Array | null>;
  }).queryOptional.bind(client);

  assert.equal(await optionalQuery(0xc4, 1_500), null);
  assert.equal(device.opens, 1);
  assert.equal(device.sends, 1);
});

function wiredDevice({ productId = 0x7401 } = {}) {
  const sent: Uint8Array[] = [];
  const values = new Map<number, Uint8Array>([
    [0xb2, new Uint8Array([0xe8, 0x03])],
    [0xb5, new Uint8Array([1])],
    [0xb6, new Uint8Array([1])],
    [0xb7, new Uint8Array([1])],
    [0xc4, new Uint8Array([1])],
  ]);
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x3710,
    productId,
    opened: true,
    collections: [{
      usagePage: 0xff00, usage: 1, type: 1, children: [],
      inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      featureReports: [],
    }],
    open: async () => {}, close: async () => {},
    addEventListener: (_type: string, callback: typeof listener) => { listener = callback; },
    removeEventListener: () => { listener = null; },
    sendReport: async (reportId: number, data: Uint8Array) => {
      assert.equal(reportId, 0);
      assert.equal(data.length, 64);
      sent.push(data.slice());
      const command = data[0];
      assert.ok(values.has(command), `unexpected command 0x${command.toString(16)}`);
      if (data[1] === 1) values.set(command, data.slice(2, command === 0xb2 ? 4 : 3));
      const reply = new Uint8Array(64);
      reply[0] = command;
      reply[1] = data[1];
      reply.set(values.get(command) ?? [], 2);
      queueMicrotask(() => listener?.({ reportId: 0, data: new DataView(reply.buffer) } as HIDInputReportEvent));
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

test("selects the Pro client for wired control and rejects an input-only interface", () => {
  const { device } = wiredDevice();
  assert.equal(PulsarProHidClient.isSupported(device), true);
  assert.ok(createSupportedClient(device) instanceof PulsarProHidClient);
  const pointer = { ...device, collections: [{ ...device.collections[0]!, outputReports: [] }] } as HIDDevice;
  assert.equal(PulsarProHidClient.isSupported(pointer), false);

});

test("encodes wired polling writes through 8 kHz and reads them back", async () => {
  const { device, sent } = wiredDevice();
  const client = new PulsarProHidClient(device);
  const info = await client.readDeviceInfo();
  assert.equal(info.connection, "Wired");
  assert.equal(info.maximumPollingRateHz, 8000);
  for (const rate of [2000, 4000, 8000]) {
    assert.equal(await client.setPollingRate(rate), rate);
  }
  assert.deepEqual([...sent[4]!.slice(0, 4)], [0xb2, 1, 0x40, 0x1f]);
  await client.close();
});

test("replays captured wired polling and toggle writes without receiver save-allow", async () => {
  const { device, sent } = wiredDevice();
  const client = new PulsarProHidClient(device);
  await client.open();
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setPollingRate(1000), 1000);
  assert.equal(await client.setMotionSync(false), false);
  assert.equal(await client.setRippleControl(false), false);
  assert.equal(await client.setAngleSnapping(false), false);
  assert.equal(await client.setPerformanceMode(false), false);
  // Toggle assignments retain the existing Pro mapping; recalled action
  // order does not establish their names from the capture.
  // Frames 8259, 8591, 9935, 10575, 11023, 11589, padded to 64 bytes.
  const capturedPrefixes = ["b201f401", "b201e803", "b50100", "b60100", "b70100", "c40100"];
  const writes = sent.filter((packet) => packet[1] === 1);
  assert.deepEqual(writes.map((packet) => Buffer.from(packet).toString("hex")),
    capturedPrefixes.map((prefix) => prefix.padEnd(128, "0")));
  assert.equal(sent.length, 12, "each write is followed only by its readback query");
  await client.close();
});
