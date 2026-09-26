import assert from "node:assert/strict";
import test from "node:test";

import { LogitechHidppClient } from "./hidpp.ts";

(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
  setTimeout,
  clearTimeout,
};

const SMART_SHIFT_INDEX = 0x0e;

/**
 * An MX Master 2S behind a Unifying receiver: 0x2110 only, no 0x2111. Its
 * functions sit one lower (get 0x00, set 0x10), and the write reply here is
 * zero-padded, the worst case for a driver that trusts it as an echo.
 */
function legacyResponder(state: { mode: number; threshold: number; defaultThreshold: number }) {
  const FEATURES: Record<number, number> = { 0x0003: 0x02, 0x2201: 0x14, 0x2110: SMART_SHIFT_INDEX };
  return (request: Uint8Array): Uint8Array | null => {
    const [deviceIndex, featureIndex, functionByte] = request;
    const functionId = functionByte & 0xf0;
    const answer = (data: number[]): Uint8Array => new Uint8Array([deviceIndex, featureIndex, functionByte, ...data]);

    if (deviceIndex !== 0x01) return new Uint8Array([deviceIndex, 0x8f, featureIndex, functionByte, 0x08, 0]);
    if (featureIndex === 0x00) {
      if (functionId === 0x00) return answer([FEATURES[(request[3] << 8) | request[4]] ?? 0x00, 0x00, 0x02]);
      return answer([0x04, 0x05, request[5] ?? 0]);
    }
    if (featureIndex === SMART_SHIFT_INDEX) {
      if (functionId === 0x00) return answer([state.mode, state.threshold, state.defaultThreshold]);
      if (functionId === 0x10) {
        state.mode = request[3];
        state.threshold = request[4];
        state.defaultThreshold = request[5];
        return answer([0x00, 0x00, 0x00]);
      }
    }
    return answer([0x00]);
  };
}

class FakeHidDevice {
  readonly productId = 0xc52b;
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

async function harness() {
  // Ratchet, SmartShift threshold 10, default 30.
  const state = { mode: 0x02, threshold: 0x0a, defaultThreshold: 0x1e };
  const device = new FakeHidDevice();
  device.onRequest = legacyResponder(state);
  const client = new LogitechHidppClient(device as unknown as HIDDevice) as unknown as {
    open(): Promise<void>;
    resolveDeviceIndex(): Promise<void>;
    readWheelState(): Promise<{ wheelMode: string | null; smartShiftThreshold: number | null }>;
    setWheelMode(mode: "Freespin" | "Ratchet"): Promise<string>;
    setSmartShiftThreshold(threshold: number | null): Promise<number>;
  };
  await client.open();
  await client.resolveDeviceIndex();
  return { client, state };
}

test("0x2110 SmartShift is read when 0x2111 is absent", async () => {
  const { client } = await harness();
  const wheel = await client.readWheelState();
  assert.equal(wheel.wheelMode, "Ratchet");
  assert.equal(wheel.smartShiftThreshold, 0x0a);
});

test("a 0x2110 wheel-mode write is confirmed by reading back, not by its zero reply", async () => {
  const { client, state } = await harness();
  assert.equal(await client.setWheelMode("Freespin"), "Freespin");
  assert.deepEqual(state, { mode: 0x01, threshold: 0x0a, defaultThreshold: 0x1e });
});

test("a 0x2110 threshold write keeps the ratchet mode and the default", async () => {
  const { client, state } = await harness();
  assert.equal(await client.setSmartShiftThreshold(20), 20);
  assert.deepEqual(state, { mode: 0x02, threshold: 20, defaultThreshold: 0x1e });
});
