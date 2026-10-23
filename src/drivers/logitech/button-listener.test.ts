import assert from "node:assert/strict";
import test from "node:test";

import { LogitechHidppClient } from "./hidpp.ts";

// The driver schedules its request timeouts through window, which Node has no
// notion of. Matched to the shim the existing HID++ driver tests install.
(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
  setTimeout,
  clearTimeout,
};

/** Feature index the scripted mouse hands out for 0x8110, as on a PRO X 3 Superstrike. */
const LISTENER_INDEX = 0x22;
const BUTTONS = [1, 2, 3, 4, 5];

/** A receiver slot that answers root lookups and the listener's count and list, and echoes the rest. */
function responder(features: Record<number, number>) {
  const sent: Uint8Array[] = [];
  const answer = (request: Uint8Array): Uint8Array | null => {
    sent.push(request.slice());
    const [deviceIndex, featureIndex, functionByte] = request;
    const reply = (data: number[]): Uint8Array => new Uint8Array([deviceIndex, featureIndex, functionByte, ...data]);
    if (deviceIndex !== 0x02) return new Uint8Array([deviceIndex, 0x8f, featureIndex, functionByte, 0x08, 0]);
    if (featureIndex === 0x00 && (functionByte & 0xf0) === 0x00) {
      const featureId = (request[3] << 8) | request[4];
      return reply([features[featureId] ?? 0x00, 0x00, 0x02]);
    }
    if (featureIndex === 0x00) return reply([0x04, 0x05, request[5] ?? 0]);
    if (featureIndex === LISTENER_INDEX && (functionByte & 0xf0) === 0x00) return reply([BUTTONS.length]);
    if (featureIndex === LISTENER_INDEX && (functionByte & 0xf0) === 0x30) return reply([...BUTTONS, 0x00]);
    return reply([0x00]);
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

  push(report: number[]): void {
    const bytes = Uint8Array.from(report);
    this.listeners.get("inputreport")?.({ reportId: 0x11, data: new DataView(bytes.buffer) });
  }

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

interface ListenerClient {
  open(): Promise<void>;
  resolveDeviceIndex(): Promise<void>;
  startButtonListener(): Promise<number[]>;
  stopButtonListener(): Promise<void>;
  close(): Promise<void>;
  onButtonChange(listener: (buttons: number) => void): () => void;
}

async function harness(features: Record<number, number>) {
  const device = new FakeHidDevice();
  const script = responder(features);
  device.onRequest = script.answer;
  const client = new LogitechHidppClient(device as unknown as HIDDevice) as unknown as ListenerClient;
  await client.open();
  await client.resolveDeviceIndex();
  script.sent.length = 0;
  return { client, device, sent: script.sent };
}

const withListener = { 0x0003: 0x02, 0x2201: 0x14, 0x8110: LISTENER_INDEX };
const listenerCalls = (sent: Uint8Array[]): Uint8Array[] => sent.filter((request) => request[1] === LISTENER_INDEX);

test("starting the listener replays G HUB's sequence: count, list, start, then the list back", async () => {
  const { client, sent } = await harness(withListener);
  assert.deepEqual(await client.startButtonListener(), BUTTONS);
  const calls = listenerCalls(sent);
  assert.deepEqual(calls.map((request) => request[2] & 0xf0), [0x00, 0x30, 0x10, 0x40]);
  assert.deepEqual([...calls[3].slice(3, 3 + BUTTONS.length)], BUTTONS, "the setList call must name every button");
});

test("button events reach listeners as a bitmask, until they unsubscribe", async () => {
  const { client, device } = await harness(withListener);
  await client.startButtonListener();
  const seen: number[] = [];
  const stop = client.onButtonChange((buttons) => seen.push(buttons));
  const event = (mask: number) => [0x02, LISTENER_INDEX, 0x00, 0x00, mask, 0x00, 0x00];
  device.push(event(0x10));
  device.push(event(0x00));
  device.push(event(0x08));
  stop();
  device.push(event(0x04));
  assert.deepEqual(seen, [0x10, 0x00, 0x08]);
});

test("events from another feature are not mistaken for buttons", async () => {
  const { client, device } = await harness(withListener);
  await client.startButtonListener();
  const seen: number[] = [];
  client.onButtonChange((buttons) => seen.push(buttons));
  device.push([0x02, 0x16, 0x00, 0x00, 0x10, 0x00]);
  assert.deepEqual(seen, []);
});

test("stopping sends function 2", async () => {
  const { client, sent } = await harness(withListener);
  await client.startButtonListener();
  sent.length = 0;
  await client.stopButtonListener();
  assert.deepEqual(listenerCalls(sent).map((request) => request[2] & 0xf0), [0x20]);
});

const buttonEvent = (mask: number) => [0x02, LISTENER_INDEX, 0x00, 0x00, mask, 0x00, 0x00];

test("a start that fails on the last step stops the listener again and gives up the events", async () => {
  const { client, device, sent } = await harness(withListener);
  const answer = device.onRequest;
  device.onRequest = (request) => {
    if (request[1] !== LISTENER_INDEX || (request[2] & 0xf0) !== 0x40) return answer(request);
    sent.push(request.slice());
    return new Uint8Array([0x02, 0xff, LISTENER_INDEX, request[2], 0x02, 0x00]); // the mouse refuses setList
  };
  await assert.rejects(() => client.startButtonListener());
  assert.deepEqual(listenerCalls(sent).map((request) => request[2] & 0xf0), [0x00, 0x30, 0x10, 0x40, 0x20]);
  const seen: number[] = [];
  client.onButtonChange((buttons) => seen.push(buttons));
  device.push(buttonEvent(0x10));
  assert.deepEqual(seen, []);
});

test("after stopping or closing, button events are no longer delivered", async () => {
  const { client, device } = await harness(withListener);
  const seen: number[] = [];
  client.onButtonChange((buttons) => seen.push(buttons));
  await client.startButtonListener();
  await client.stopButtonListener();
  device.push(buttonEvent(0x10));
  await client.startButtonListener();
  await client.close();
  device.push(buttonEvent(0x08));
  assert.deepEqual(seen, []);
});

test("a mouse without the feature says so and sends nothing", async () => {
  const { client, sent } = await harness({ 0x0003: 0x02, 0x2201: 0x14 });
  await assert.rejects(() => client.startButtonListener(), /does not report its buttons/);
  assert.deepEqual(listenerCalls(sent), []);
});
