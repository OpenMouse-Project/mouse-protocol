import assert from "node:assert/strict";
import test from "node:test";

import { withSoftwareId } from "@openmouse/protocol/logitech";

import { LogitechHidppClient } from "./hidpp.ts";

// The driver schedules its request timeouts through window, which Node has no
// notion of. Matched to the shim the existing HID++ driver tests install.
(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
  setTimeout,
  clearTimeout,
};

/**
 * Feature indices this scripted receiver hands out, and the slot layout it
 * reports: three hosts, slots 0 and 1 paired, sitting on slot 0 — the state an
 * MX Master 4 was read in.
 */
const HOSTS_INFO_INDEX = 0x0f;
const CHANGE_HOST_INDEX = 0x0e;
const HOSTS = [true, true, false];
const CURRENT_HOST = 0;

const reply = (deviceIndex: number, featureIndex: number, functionId: number, data: number[] = []): Uint8Array =>
  new Uint8Array([deviceIndex, featureIndex, withSoftwareId(functionId), ...data]);

interface ScriptOptions {
  /** How the device behaves when told to switch. */
  onSwitch: "acknowledge" | "depart" | "refuse";
}

/**
 * A receiver that answers enough for host switching: root lookups for 0x1815
 * and 0x1814, the hosts table, and the switch itself.
 *
 * "depart" returns no reply at all, which is what a mouse that has moved to
 * another computer looks like from here — the request simply never answers.
 */
function hostResponder(options: ScriptOptions) {
  const sent: Uint8Array[] = [];
  /** Root lookups this device answers; anything else reports "not present". */
  const FEATURES: Record<number, number> = {
    0x0003: 0x02,   // firmware — probed while resolving the device index
    0x2201: 0x14,   // a DPI feature, without which the slot is not taken as a mouse
    0x1815: HOSTS_INFO_INDEX,
    0x1814: CHANGE_HOST_INDEX,
  };

  const responder = (request: Uint8Array): Uint8Array | null => {
    sent.push(request.slice());
    const deviceIndex = request[0];
    const featureIndex = request[1];
    const functionByte = request[2];
    const functionId = functionByte & 0xf0;
    // Echoes the feature and function bytes exactly, which is what the
    // driver matches a reply against.
    const answer = (data: number[]): Uint8Array =>
      new Uint8Array([deviceIndex, featureIndex, functionByte, ...data]);

    if (deviceIndex !== 0x02) {
      return new Uint8Array([deviceIndex, 0x8f, featureIndex, functionByte, 0x08, 0]);
    }

    if (featureIndex === 0x00) {
      // Root: function 0 resolves a feature id, function 1 is the ping.
      if (functionId === 0x00) {
        const featureId = (request[3] << 8) | request[4];
        return answer([FEATURES[featureId] ?? 0x00, 0x00, 0x02]);
      }
      return answer([0x04, 0x05, request[5] ?? 0]);
    }

    if (featureIndex === HOSTS_INFO_INDEX) {
      if (functionId === 0x00) return answer([0x13, 0x08, HOSTS.length, CURRENT_HOST]);
      if (functionId === 0x10) {
        const slot = request[3] ?? 0;
        return answer([slot, HOSTS[slot] ? 0x01 : 0x00, 0x05, 0x01, 0x0a, 0x18]);
      }
    }

    if (featureIndex === CHANGE_HOST_INDEX && functionId === 0x10) {
      if (options.onSwitch === "depart") return null;
      if (options.onSwitch === "refuse") {
        return new Uint8Array([deviceIndex, 0xff, featureIndex, functionByte, 0x02, 0]);
      }
      return answer([request[3] ?? 0]);
    }

    return answer([0x00]);
  };
  return { responder, sent };
}

class FakeHidDevice {
  readonly productId = 0xc548;
  readonly productName = "USB Receiver";
  readonly vendorId = 0x046d;
  /**
   * Bolt device feature traffic rides the long-report collection, and the
   * driver refuses to bind without it. Both HID++ endpoints are present here,
   * which is what the receiver offers once a user authorizes them.
   */
  readonly collections = [
    { usagePage: 0xff00, usage: 0x0001, children: [] },
    { usagePage: 0xff00, usage: 0x0002, children: [] },
  ];
  private listeners = new Map<string, (event: unknown) => void>();
  onRequest: (request: Uint8Array) => Uint8Array | null = () => null;
  sendReportFails = false;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(): void {}

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    if (this.sendReportFails) throw new Error("The device is not open.");
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

/**
 * Resolves the receiver slot before returning, the way a real session does:
 * the panel reads status first, and until the slot is known the driver talks
 * to the direct index and nothing answers.
 */
async function harness(options: ScriptOptions) {
  const device = new FakeHidDevice();
  const script = hostResponder(options);
  device.onRequest = script.responder;
  const client = new LogitechHidppClient(device as unknown as HIDDevice) as unknown as {
    open(): Promise<void>;
    resolveDeviceIndex(): Promise<void>;
    readonly resolvedDeviceIndex: number | null;
    requestHostSwitch(slot: number): Promise<void>;
  };
  await client.open();
  await client.resolveDeviceIndex();
  assert.equal(client.resolvedDeviceIndex, 0x02, "the scripted receiver was not found on slot 2");
  script.sent.length = 0;
  return { device, sent: script.sent, client };
}

const switchWrites = (sent: Uint8Array[]): Uint8Array[] =>
  sent.filter((request) => request[1] === CHANGE_HOST_INDEX && (request[2] & 0xf0) === 0x10);

test("a switch the mouse acknowledges resolves", async () => {
  const { client, sent } = await harness({ onSwitch: "acknowledge" });
  await client.requestHostSwitch(1);
  assert.equal(switchWrites(sent).length, 1);
  assert.equal(switchWrites(sent)[0]?.[3], 1, "the slot did not reach the device");
});

test("a mouse that leaves before answering still counts as a switch sent", async () => {
  // Disconnection is the expected success path: the command reached the
  // device and no reply can arrive from a mouse that is no longer ours.
  const { client, sent } = await harness({ onSwitch: "depart" });
  await client.requestHostSwitch(1);
  assert.equal(switchWrites(sent).length, 1);
});

test("a refusal from the mouse is surfaced, not swallowed as a departure", async () => {
  // An error reply means the mouse is still here and did not switch. Treating
  // that as success would report a move that never happened.
  const { client } = await harness({ onSwitch: "refuse" });
  await assert.rejects(() => client.requestHostSwitch(1), /invalid argument|INVALID_ARGUMENT|0x02/i);
});

test("a report that never reaches the transport is an error", async () => {
  const { client, device } = await harness({ onSwitch: "acknowledge" });
  device.sendReportFails = true;
  await assert.rejects(() => client.requestHostSwitch(1), /not open/);
});

test("an empty slot is refused and nothing is sent", async () => {
  const { client, sent } = await harness({ onSwitch: "acknowledge" });
  await assert.rejects(() => client.requestHostSwitch(2), /nothing paired/);
  assert.deepEqual(switchWrites(sent), [], "an empty slot reached the mouse");
});

test("the current slot and a slot that does not exist are refused", async () => {
  const { client, sent } = await harness({ onSwitch: "acknowledge" });
  await assert.rejects(() => client.requestHostSwitch(CURRENT_HOST), /already on that computer/);
  await assert.rejects(() => client.requestHostSwitch(9), /not one of/);
  await assert.rejects(() => client.requestHostSwitch(-1), /not one of/);
  assert.deepEqual(switchWrites(sent), []);
});
