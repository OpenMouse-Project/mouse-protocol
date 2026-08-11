import assert from "node:assert/strict";
import test from "node:test";

import { withSoftwareId } from "@openmouse/protocol/logitech";

import { LogitechHidppClient } from "./hidpp.ts";

(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
  setTimeout,
  clearTimeout,
};

const THUMB_INDEX = 0x13;

/**
 * A receiver whose 0x2150 write reply carries nothing, which is how a real
 * MX Master 4 behaves — unlike 0x2111, 0x2121 and 0x19B0, this feature does
 * not echo the values it was given.
 *
 * Confirming from that reply read the empty payload as "not inverted", so
 * setting inversion off appeared to succeed and setting it on appeared to
 * fail, while the device had in fact applied both.
 */
function thumbResponder(state: { diverted: boolean; inverted: boolean }) {
  const FEATURES: Record<number, number> = { 0x0003: 0x02, 0x2201: 0x14, 0x2150: THUMB_INDEX };
  return (request: Uint8Array): Uint8Array | null => {
    const deviceIndex = request[0];
    const featureIndex = request[1];
    const functionByte = request[2];
    const functionId = functionByte & 0xf0;
    const answer = (data: number[]): Uint8Array =>
      new Uint8Array([deviceIndex, featureIndex, functionByte, ...data]);

    if (deviceIndex !== 0x02) {
      return new Uint8Array([deviceIndex, 0x8f, featureIndex, functionByte, 0x08, 0]);
    }
    if (featureIndex === 0x00) {
      if (functionId === 0x00) {
        const featureId = (request[3] << 8) | request[4];
        return answer([FEATURES[featureId] ?? 0x00, 0x00, 0x02]);
      }
      return answer([0x04, 0x05, request[5] ?? 0]);
    }
    if (featureIndex === THUMB_INDEX) {
      // getThumbwheelInfo — capability 0x0003 at [4..5], inversion supported.
      if (functionId === 0x00) return answer([0x00, 0x14, 0x00, 0x78, 0x00, 0x03, 0x03, 0xe8]);
      if (functionId === 0x10) return answer([state.diverted ? 1 : 0, state.inverted ? 1 : 0]);
      if (functionId === 0x20) {
        state.diverted = (request[3] ?? 0) !== 0;
        state.inverted = (request[4] ?? 0) !== 0;
        // The device applies the write and answers with an empty payload.
        return answer([]);
      }
    }
    return answer([0x00]);
  };
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
    const answer = this.onRequest(data.slice());
    if (answer) {
      queueMicrotask(() => {
        this.listeners.get("inputreport")?.({
          reportId,
          data: new DataView(answer.buffer.slice(answer.byteOffset, answer.byteOffset + answer.byteLength)),
        });
      });
    }
  }
}

async function harness(initial: { diverted: boolean; inverted: boolean }) {
  const state = { ...initial };
  const device = new FakeHidDevice();
  device.onRequest = thumbResponder(state);
  const client = new LogitechHidppClient(device as unknown as HIDDevice) as unknown as {
    open(): Promise<void>;
    resolveDeviceIndex(): Promise<void>;
    setThumbWheelInverted(inverted: boolean): Promise<boolean>;
  };
  await client.open();
  await client.resolveDeviceIndex();
  return { client, state };
}

test("inverting the thumb wheel is confirmed even though the write echoes nothing", async () => {
  const { client, state } = await harness({ diverted: true, inverted: false });
  assert.equal(await client.setThumbWheelInverted(true), true);
  assert.equal(state.inverted, true);
});

test("restoring the thumb wheel is confirmed the same way", async () => {
  const { client, state } = await harness({ diverted: true, inverted: true });
  assert.equal(await client.setThumbWheelInverted(false), false);
  assert.equal(state.inverted, false);
});

test("the diversion Logi Options+ set survives an inversion write", async () => {
  // Options+ sets diversion to implement horizontal scrolling; clearing it
  // silently takes that away.
  const { client, state } = await harness({ diverted: true, inverted: false });
  await client.setThumbWheelInverted(true);
  assert.equal(state.diverted, true, "diversion was cleared by an inversion write");
});

test("a device that ignores the write is reported as a failure", async () => {
  // The re-read is only worth doing if it can still fail. This device
  // acknowledges the write and keeps its old value.
  const state = { diverted: true, inverted: false };
  const responder = thumbResponder(state);
  const device = new FakeHidDevice();
  device.onRequest = (request) => {
    const reply = responder(request);
    state.inverted = false;
    return reply;
  };
  const client = new LogitechHidppClient(device as unknown as HIDDevice) as unknown as {
    open(): Promise<void>;
    resolveDeviceIndex(): Promise<void>;
    setThumbWheelInverted(inverted: boolean): Promise<boolean>;
  };
  await client.open();
  await client.resolveDeviceIndex();
  await assert.rejects(() => client.setThumbWheelInverted(true), /kept its previous/);
});
