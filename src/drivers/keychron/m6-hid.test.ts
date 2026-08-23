import assert from "node:assert/strict";
import test from "node:test";

Object.assign(globalThis, { window: globalThis });

const { KeychronM6HidClient } = await import("./m6-hid.ts");
const { VENDOR_ID } = await import("../vendors.ts");

class FakeM6Device {
  readonly vendorId = VENDOR_ID.keychron;
  readonly productId = 0xd060;
  readonly productName = "Keychron M6";
  readonly collections: HIDCollectionInfo[] = [{
    usagePage: 0xffc1,
    usage: 0x01,
    children: [],
    featureReports: [],
    inputReports: [{ reportId: 0xb4, items: [{ reportCount: 63, reportSize: 8 }] }],
    outputReports: [{ reportId: 0xb3, items: [{ reportCount: 63, reportSize: 8 }] }],
  }] as unknown as HIDCollectionInfo[];
  opened = false;
  readonly sent: Array<{ reportId: number; packet: Uint8Array }> = [];
  private listeners = new Map<string, (event: unknown) => void>();
  private activeDpiStage = 0;
  private dpiStages = [400, 800, 1600, 3200, 5000];
  private pollingIndex = 1;
  private readonly pollingTable = [0, 1, 2];

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const packet = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push({ reportId, packet: packet.slice() });
    if (reportId === 0xb3 && packet[0] === 6) {
      this.emit(0xb4, this.statusPacket());
      return;
    }
    if (reportId === 0xb5 && packet[0] === 0x40) {
      this.activeDpiStage = packet[1] ?? this.activeDpiStage;
      this.dpiStages = this.dpiStages.map((_, index) => (packet[4 + index * 2] ?? 0) | ((packet[5 + index * 2] ?? 0) << 8));
      this.emit(0xb6, new Uint8Array([0xe4]));
      return;
    }
    if (reportId === 0xb5 && packet[0] === 0x41) {
      this.pollingIndex = packet[1] ?? this.pollingIndex;
      this.emit(0xb6, new Uint8Array([0xe4]));
    }
  }

  private statusPacket(): Uint8Array {
    const packet = new Uint8Array(63);
    packet[0] = 6;
    packet[1] = this.activeDpiStage;
    packet[2] = this.pollingIndex << 4;
    this.dpiStages.forEach((dpi, index) => {
      packet[5 + index * 2] = dpi & 0xff;
      packet[6 + index * 2] = (dpi >> 8) & 0xff;
    });
    packet[19] = 0x80 | 99;
    packet.set(this.pollingTable, 43);
    packet[49] = this.pollingTable.length;
    packet[50] = this.dpiStages.length;
    return packet;
  }

  private emit(reportId: number, reply: Uint8Array): void {
    queueMicrotask(() => this.listeners.get("inputreport")?.({
      reportId,
      data: new DataView(reply.buffer, reply.byteOffset, reply.byteLength),
    }));
  }
}

function device(productId = 0xd060, usagePage = 0xffc1): HIDDevice {
  return {
    vendorId: VENDOR_ID.keychron,
    productId,
    productName: "Keychron M6",
    collections: [{
      usagePage,
      usage: 0x01,
      children: [],
      featureReports: [],
      inputReports: [{ reportId: 0xb4, items: [{ reportCount: 63, reportSize: 8 }] }],
      outputReports: [{ reportId: 0xb3, items: [{ reportCount: 63, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

test("Keychron M6 is limited to its verified 0xffc1 control interface", () => {
  assert.equal(KeychronM6HidClient.isSupported(device()), true);
  assert.equal(KeychronM6HidClient.isSupported(device(0xd060, 0xff60)), false);
  assert.equal(KeychronM6HidClient.isSupported(device(0xd029)), true);
  assert.equal(KeychronM6HidClient.isSupported({ ...device(), productId: 0xd061 } as HIDDevice), false);
});

test("reads the M6 8k-protocol status report", async () => {
  const status = await new KeychronM6HidClient(new FakeM6Device() as unknown as HIDDevice).readStatus();
  assert.equal(status.name, "Keychron M6");
  assert.equal(status.dpi, 400);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 3200, 5000]);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.pollingRateHz, 500);
  assert.deepEqual(status.supportedPollingRates, [125, 500, 1000]);
  assert.equal(status.batteryPercent, 99);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.ui?.family, "keychron-m6");
});

test("writes M6 DPI and polling settings, then reads them back", async () => {
  const fake = new FakeM6Device();
  const client = new KeychronM6HidClient(fake as unknown as HIDDevice);
  assert.equal(await client.setDpi(1200), 1200);
  assert.equal(await client.setActiveDpiStage(2), 2);
  assert.equal(await client.setPollingRate(1000), 1000);
  assert.ok(fake.sent.some(({ reportId, packet }) => reportId === 0xb5 && packet[0] === 0x40));
  assert.ok(fake.sent.some(({ reportId, packet }) => reportId === 0xb5 && packet[0] === 0x41));
});
