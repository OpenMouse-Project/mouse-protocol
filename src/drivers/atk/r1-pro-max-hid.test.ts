import assert from "node:assert/strict";
import test from "node:test";

import { atkPackDpiStageForSensor } from "@openmouse/protocol/atk";
import { AtkHidClient } from "./hid.ts";

type Sent = { reportId: number; data: Uint8Array };

class FakeR1ProMaxDevice {
  vendorId = 0x3554;
  productId: number;
  productName: string;
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

  constructor(productId: number, productName: string) {
    this.productId = productId;
    this.productName = productName;
  }

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

  async sendFeatureReport(): Promise<void> {
    throw new Error("not used");
  }

  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("not used");
  }
}

function device(productId: number, productName: string): HIDDevice {
  return new FakeR1ProMaxDevice(productId, productName) as unknown as HIDDevice;
}

function reply(command: number, address: number, data: number[]): number[] {
  const frame = [command, 0x00, (address >> 8) & 0xff, address & 0xff, data.length, ...data];
  while (frame.length < 16) frame.push(0x00);
  frame[15] = (0x55 - 0x08 - frame.slice(0, 15).reduce((total, byte) => total + byte, 0)) & 0xff;
  return frame;
}

function writes(fake: HIDDevice): Uint8Array[] {
  return (fake as unknown as FakeR1ProMaxDevice).sent
    .filter(({ reportId, data }) => reportId === 8 && data[0] === 0x07)
    .map(({ data }) => data);
}

const SYSTEM_1000_HZ_ONE_STAGE = [0x01, 0x54, 0x01, 0x54, 0x00, 0x55];

test("R1 Pro Max COMPX transports are recognized without using the SE+ live-rate table", () => {
  const receiver = device(0xf58a, "VXE R1 Pro Max Receiver");
  const wired = device(0xf58c, "VXE R1 Pro Max");

  assert.equal(AtkHidClient.isSupported(receiver), true);
  assert.equal(AtkHidClient.isSupported(wired), true);
  assert.equal(new AtkHidClient(receiver).isWireless(), true);
  assert.equal(new AtkHidClient(wired).isWireless(), false);
  assert.deepEqual(new AtkHidClient(receiver).getSupportedPollingRates(), [125, 250, 500, 1000]);
  assert.deepEqual(new AtkHidClient(wired).getSupportedPollingRates(), [125, 250, 500, 1000]);
});

test("R1 Pro Max wired transport writes polling through the system EEPROM", async () => {
  const fake = device(0xf58c, "VXE R1 Pro Max");
  (fake as unknown as FakeR1ProMaxDevice).replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, [0x08, 0x4d, 0x01, 0x54, 0x00, 0x55]),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setPollingRate(125), 125);

  const write = writes(fake)[0];
  assert.ok(write);
  assert.equal(write![2], 0x00);
  assert.equal(write![3], 0x00);
  assert.equal(write![4], 0x02);
  assert.deepEqual([...write!.subarray(5, 7)], [0x08, 0x4d]);
  assert.equal(writes(fake).some((frame) => frame[3] === 0x70), false);
});

test("R1 Pro Max wired transport accepts PAW3395 30K DPI with independent X/Y values", async () => {
  const packed = atkPackDpiStageForSensor("PAW3395", 30000, 100);
  assert.ok(packed);

  const fake = device(0xf58c, "VXE R1 Pro Max");
  (fake as unknown as FakeR1ProMaxDevice).replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, SYSTEM_1000_HZ_ONE_STAGE),
    reply(0x08, 0x000c, packed!),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDpi(30000, 100), 30000);
  assert.equal(client.maxDpi(), 30000);

  const write = writes(fake).find((frame) => frame[2] === 0x00 && frame[3] === 0x0c);
  assert.ok(write);
  assert.deepEqual([...write!.subarray(5, 9)], packed);
});

test("R1 Pro Max receiver stays read-only for persistent EEPROM until its write path is verified", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  (fake as unknown as FakeR1ProMaxDevice).replies = [reply(0x10, 0, [0x02, 0x1b])];

  await assert.rejects(
    new AtkHidClient(fake).setPollingRate(500),
    /verified wired transport/,
  );
  assert.equal(writes(fake).length, 0);
});
