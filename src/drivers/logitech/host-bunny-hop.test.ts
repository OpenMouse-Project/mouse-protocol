import assert from "node:assert/strict";
import test from "node:test";

import { LogitechHidppClient } from "./hidpp.ts";

// The driver schedules its request timeouts through window, which Node has no
// notion of. Matched to the shim the existing HID++ driver tests install.
(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
  setTimeout,
  clearTimeout,
};

/** Feature index the scripted mouse hands out for 0x80E0, as on a PRO X 3 Superstrike. */
const BUNNY_HOP_INDEX = 0x20;

/** A receiver slot that answers root lookups and echoes every other request. */
function responder(features: Record<number, number>) {
  const sent: Uint8Array[] = [];
  const answer = (request: Uint8Array): Uint8Array | null => {
    sent.push(request.slice());
    const [deviceIndex, featureIndex, functionByte] = request;
    if (deviceIndex !== 0x02) {
      return new Uint8Array([deviceIndex, 0x8f, featureIndex, functionByte, 0x08, 0]);
    }
    if (featureIndex === 0x00 && (functionByte & 0xf0) === 0x00) {
      const featureId = (request[3] << 8) | request[4];
      return new Uint8Array([deviceIndex, featureIndex, functionByte, features[featureId] ?? 0x00, 0x00, 0x02]);
    }
    if (featureIndex === 0x00) return new Uint8Array([deviceIndex, featureIndex, functionByte, 0x04, 0x05, request[5] ?? 0]);
    return new Uint8Array([deviceIndex, featureIndex, functionByte, 0x00]);
  };
  return { answer, sent };
}

class FakeHidDevice {
  readonly productId = 0xc548;
  readonly productName = "USB Receiver";
  readonly vendorId = 0x046d;
  readonly collections = [
    { usagePage: 0xff00, usage: 0x0001, children: [] },
    { usagePage: 0xff00, usage: 0x0002, children: [] },
  ];
  private listeners = new Map<string, (event: unknown) => void>();
  onRequest: (request: Uint8Array) => Uint8Array | null = () => null;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(): void {}

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    const reply = this.onRequest(data.slice());
    if (!reply) return;
    queueMicrotask(() => {
      this.listeners.get("inputreport")?.({
        reportId,
        data: new DataView(reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength)),
      });
    });
  }
}

async function harness(features: Record<number, number>) {
  const device = new FakeHidDevice();
  const script = responder(features);
  device.onRequest = script.answer;
  const client = new LogitechHidppClient(device as unknown as HIDDevice) as unknown as {
    open(): Promise<void>;
    resolveDeviceIndex(): Promise<void>;
    setHostBunnyHopMs(milliseconds: number): Promise<void>;
  };
  await client.open();
  await client.resolveDeviceIndex();
  script.sent.length = 0;
  return { client, sent: script.sent };
}

const withBunnyHop = { 0x0003: 0x02, 0x2201: 0x14, 0x80e0: BUNNY_HOP_INDEX };
const bunnyHopWrites = (sent: Uint8Array[]): Uint8Array[] => sent.filter((request) => request[1] === BUNNY_HOP_INDEX);

test("host bunny hop writes the time in 10 ms units to feature 0x80E0, function 2", async () => {
  const { client, sent } = await harness(withBunnyHop);
  await client.setHostBunnyHopMs(100);
  await client.setHostBunnyHopMs(200);
  await client.setHostBunnyHopMs(0);
  const writes = bunnyHopWrites(sent);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map((request) => request[2] & 0xf0), [0x20, 0x20, 0x20]);
  assert.deepEqual(writes.map((request) => request[3]), [0x0a, 0x14, 0x00], "G HUB's captured bytes");
});

test("a time the mouse cannot store is refused before anything is sent", async () => {
  const { client, sent } = await harness(withBunnyHop);
  await assert.rejects(() => client.setHostBunnyHopMs(95), /multiple of 10/);
  await assert.rejects(() => client.setHostBunnyHopMs(50), /between 100 and 1000/);
  assert.deepEqual(bunnyHopWrites(sent), []);
});

test("a mouse without the feature says so", async () => {
  const { client, sent } = await harness({ 0x0003: 0x02, 0x2201: 0x14 });
  await assert.rejects(() => client.setHostBunnyHopMs(100), /does not expose a Host mode bunny hop/);
  assert.deepEqual(bunnyHopWrites(sent), []);
});
