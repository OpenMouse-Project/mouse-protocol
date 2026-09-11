import assert from "node:assert/strict";
import test from "node:test";

import { dareuChecksum, dareuDpiId, dareuEncodeButtonAssignment, dareuWithMemoryChecksum } from "@openmouse/protocol/dareu";
import { DareuHidClient } from "./hid.ts";

type Sent = { reportId: number; data: Uint8Array };

class FakeDareuDevice {
  vendorId = 0x260d;
  productId = 0x1114;
  productName = "2.4G Wireless Receiver";
  opened = false;
  collections = [
    { usagePage: 0xff05, usage: 0, children: [], featureReports: [], inputReports: [], outputReports: [] },
    {
      usagePage: 0xff02,
      usage: 2,
      children: [],
      featureReports: [],
      inputReports: [{ reportId: 8, items: [{ reportSize: 8, reportCount: 16 }] }],
      outputReports: [{ reportId: 8, items: [{ reportSize: 8, reportCount: 16 }] }],
    },
  ];
  readonly memory = new Uint8Array(7000);
  readonly sent: Sent[] = [];
  maxInFlight = 0;
  private inFlight = 0;
  private profile = 1;
  private listeners = new Set<(event: HIDInputReportEvent) => void>();

  constructor() {
    this.writePair(0, 16);
    this.writePair(2, 5);
    this.writePair(4, 2);
    [400, 800, 1600, 3200, 6400].forEach((dpi, stage) => this.writeDpi(stage, dpi));
    this.writePair(76, 2);
    this.writePair(78, 127);
    this.writePair(80, 3);
    this.writePair(82, 1);
    this.writePair(173, 18);
    this.writePair(181, 1);
    this.writePair(183, 18);
    ["Left Click", "Right Click", "Middle Click", "Back", "Forward", "DPI Cycle"].forEach((action, index) => {
      this.memory.set(dareuEncodeButtonAssignment(action)!, 96 + index * 4);
    });
    const macro = new Uint8Array([6, 1, 0, 0]);
    macro[3] = dareuChecksum(macro);
    this.memory.set(macro, 112);
  }

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  addEventListener(type: string, listener: (event: HIDInputReportEvent) => void): void {
    if (type === "inputreport") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: HIDInputReportEvent) => void): void {
    if (type === "inputreport") this.listeners.delete(listener);
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const frame = new Uint8Array(data as ArrayBufferLike);
    this.sent.push({ reportId, data: frame });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (frame[0] === 7) {
        const address = frame[2]! << 8 | frame[3]!;
        this.memory.set(frame.slice(5, 5 + frame[4]!), address);
      }
      const reply = new Uint8Array(16);
      reply[0] = frame[0]!;
      if (frame[0] === 3) reply[5] = 1;
      if (frame[0] === 4) { reply[5] = 86; reply[6] = 1; }
      if (frame[0] === 14) reply[5] = this.profile - 1;
      if (frame[0] === 15) this.profile = frame[5]! + 1;
      if (frame[0] === 18) { reply[5] = 1; reply[6] = 0x30; }
      if (frame[0] === 29) { reply[5] = 1; reply[6] = 1; }
      if (frame[0] === 8) {
        const address = frame[2]! << 8 | frame[3]!;
        reply.set(frame.slice(0, 5));
        reply.set(this.memory.slice(address, address + frame[4]!), 5);
      }
      queueMicrotask(() => this.listeners.forEach((listener) =>
        listener({ reportId, data: new DataView(reply.buffer) } as HIDInputReportEvent)));
      await new Promise((resolve) => setTimeout(resolve, 1));
    } finally {
      this.inFlight -= 1;
    }
  }

  private writePair(address: number, value: number): void {
    this.memory.set(dareuWithMemoryChecksum(new Uint8Array([value])), address);
  }

  private writeDpi(stage: number, dpi: number): void {
    const id = dareuDpiId(dpi);
    if (id === null) throw new Error("test DPI must be encodable");
    const record = new Uint8Array([id & 0xff, id & 0xff, id >> 8, 0]);
    record[3] = dareuChecksum(record);
    this.memory.set(record, 12 + stage * 4);
  }
}

function device(productId = 0x1114): HIDDevice {
  const fake = new FakeDareuDevice();
  fake.productId = productId;
  return fake as unknown as HIDDevice;
}

function fake(device: HIDDevice): FakeDareuDevice {
  return device as unknown as FakeDareuDevice;
}

test("Dareu only claims the measured VID, PID, service, and report-8 collection", () => {
  const receiver = device();
  const wired = device(0x1117);
  assert.equal(DareuHidClient.isSupported(receiver), true);
  assert.equal(DareuHidClient.isSupported(wired), true);
  assert.equal(DareuHidClient.isSupported({ ...receiver, vendorId: 0x1234 }), false);
  fake(receiver).collections[1]!.outputReports[0]!.items[0]!.reportCount = 15;
  assert.equal(DareuHidClient.isSupported(receiver), false);
});

test("Dareu reads legacy DPI, profiles, firmware, and leaves macros read-only", async () => {
  const receiver = device();
  const status = await new DareuHidClient(receiver).readStatus();

  assert.equal(status.batteryPercent, 86);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.dpi, 1600);
  assert.equal(status.dpiY, undefined);
  assert.equal(status.supportsSeparateDpiAxes, false);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 3200, 6400]);
  assert.equal(status.pollingRateHz, 2000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000]);
  assert.equal(status.activeProfile, 1);
  assert.equal(status.profileCount, 4);
  assert.deepEqual(status.fixedButtons, ["Forward"]);
  assert.equal(status.buttonMappings?.Forward, "Custom (read-only)");
  assert.equal(status.buttonMappings?.DPI, "DPI Cycle");
  assert.equal(status.dpiLedMode, 2);
  assert.equal(status.dpiLedBrightness, 5);
  assert.equal(status.dpiLedSpeed, 3);
  assert.equal(status.dpiLedSleepTimeout, 180);
  assert.equal(status.sleepTimeout, 180);
  assert.equal(status.ui?.powerOverview, true);
  assert.deepEqual(status.firmware, ["Mouse 1.30", "Receiver 1.01"]);
});

test("Dareu writes legacy DPI, profiles, and settings serially with read-back", async () => {
  const receiver = device();
  const client = new DareuHidClient(receiver);

  await Promise.all([client.setDpi(1800), client.setPollingRate(4000)]);
  await client.setButtonMapping("Back", "Forward");
  await client.setButtonMapping("DPI", "DPI Up");
  await client.setProfile(3);
  await client.setDpiLedSleepTimeout(600);
  await client.setSleepTimeout(300);

  const record = fake(receiver).memory.slice(12 + 2 * 4, 12 + 3 * 4);
  assert.deepEqual([...record], [35, 35, 0, 15]);
  assert.equal(fake(receiver).memory[0], 32);
  assert.equal(fake(receiver).memory[96 + 3 * 4 + 1], 16);
  assert.deepEqual([...fake(receiver).memory.slice(116, 120)], [2, 2, 0, 81]);
  assert.equal(fake(receiver).memory[173], 60);
  assert.equal(fake(receiver).memory[181], 1);
  assert.equal(fake(receiver).memory[183], 30);
  assert.equal(fake(receiver).maxInFlight, 1);
  assert.equal((await client.readStatus()).activeProfile, 3);
});

test("Dareu applies breathing after acknowledging the DPI-indicator enable write", async () => {
  const receiver = device();
  const client = new DareuHidClient(receiver);

  await client.setDpiLighting(2, 4, 5);

  const writes = fake(receiver).sent
    .filter(({ data }) => data[0] === 7)
    .map(({ data }) => [data[2], data[3], data[5]]);
  assert.deepEqual(writes, [[0, 82, 1], [0, 76, 2], [0, 78, 102], [0, 80, 5]]);
  assert.equal((await client.readStatus()).dpiLedMode, 2);
});

test("Dareu rejects unsupported rates and unknown button records before writing them", async () => {
  const receiver = device();
  const client = new DareuHidClient(receiver);
  await assert.rejects(client.setButtonMapping("Forward", "Back"), /unknown or macro/i);
  const writesBefore = fake(receiver).sent.filter(({ data }) => data[0] === 7).length;
  await assert.rejects(client.setPollingRate(8000), /unavailable/i);
  await assert.rejects(client.setDpiAxes(800, 850), /shared X\/Y/i);
  await assert.rejects(client.setProfile(5), /between 1 and 4/i);
  assert.equal(fake(receiver).sent.filter(({ data }) => data[0] === 7).length, writesBefore);

  const wired = new DareuHidClient(device(0x1117));
  await assert.rejects(wired.setPollingRate(4000), /unavailable/i);
});
