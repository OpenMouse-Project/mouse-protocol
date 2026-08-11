import assert from "node:assert/strict";
import test from "node:test";

// `hid.ts` schedules write delays and query timeouts through `window`.
Object.assign(globalThis, { window: globalThis });

const { KeychronHidClient } = await import("./hid.ts");
const {
  KEYCHRON_COMMAND,
  KEYCHRON_MISC_COMMAND,
  KEYCHRON_NAPE_COMMAND,
  KEYCHRON_PACKET_LENGTH,
  KEYCHRON_POLLING_TABLE,
} = await import("@openmouse/protocol/keychron");
const { VENDOR_ID } = await import("../vendors.ts");

const CMD = KEYCHRON_COMMAND;
const MISC = KEYCHRON_MISC_COMMAND;
const NAPE = KEYCHRON_NAPE_COMMAND;

type FakeOptions = {
  productId?: number;
  productName?: string;
  /** Force orientation/DPI values that fail Nape Pro receiver verification. */
  incompatibleReceiver?: boolean;
};

class FakeHidDevice {
  readonly vendorId = VENDOR_ID.keychron;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  opened = false;
  readonly sent: Uint8Array[] = [];

  private listeners = new Map<string, (event: unknown) => void>();
  private dpiStages = [400, 800, 1600, 2400, 4000];
  private dpiStage = 1;
  private customDpi = 800;
  private pollingIndex = 3; // 1000 Hz
  private pollingMask = 0b0001_1111; // 8K…500
  private batteryPercent = 76;
  private batteryStatus = 0;
  private orientation = 2; // 90°
  private firmware = "1.0.4";

  constructor(options: FakeOptions = {}) {
    this.productId = options.productId ?? 0x0440;
    this.productName = options.productName ?? "Keychron Nape Pro";
    this.collections = [{
      usagePage: 0xff60,
      usage: 0x61,
      children: [],
      featureReports: [],
      inputReports: [{ reportId: 0, items: [{ reportCount: 32, reportSize: 8 }] }],
      outputReports: [{ reportId: 0, items: [{ reportCount: 32, reportSize: 8 }] }],
    }] as unknown as HIDCollectionInfo[];
    if (options.incompatibleReceiver) {
      this.orientation = 0xff;
      this.dpiStages = [40, 40, 40, 40, 40];
    }
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendReport(_reportId: number, data: BufferSource): Promise<void> {
    const request = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(request.slice());

    const command = request[0] ?? 0;
    const sub = request[1] ?? 0;
    const reply = new Uint8Array(KEYCHRON_PACKET_LENGTH);

    if (command === CMD.firmwareVersion) {
      reply[0] = CMD.firmwareVersion;
      for (let index = 0; index < this.firmware.length; index += 1) {
        reply[1 + index] = this.firmware.charCodeAt(index);
      }
      this.emit(reply);
      return;
    }

    if (command !== CMD.miscGroup) return;
    reply[0] = CMD.miscGroup;
    reply[1] = sub;

    if (sub === NAPE.getOrientation) {
      reply[2] = this.orientation;
      this.emit(reply);
      return;
    }
    if (sub === NAPE.getDpiStage) {
      reply[2] = this.dpiStage;
      this.emit(reply);
      return;
    }
    if (sub === NAPE.setDpiStage) {
      this.dpiStage = Math.min(request[2] ?? 0, this.dpiStages.length - 1);
      return;
    }
    if (sub === NAPE.setDpiValue) {
      const stage = request[2] ?? 0;
      const dpi = (request[3] ?? 0) | ((request[4] ?? 0) << 8);
      if (stage >= 0 && stage < this.dpiStages.length) this.dpiStages[stage] = dpi;
      return;
    }
    if (sub === NAPE.getDpiValue) {
      const stage = request[2] ?? 0;
      const dpi = this.dpiStages[stage] ?? 0;
      reply[2] = dpi & 0xff;
      reply[3] = (dpi >> 8) & 0xff;
      this.emit(reply);
      return;
    }
    if (sub === NAPE.getBattery) {
      reply[2] = this.batteryPercent;
      reply[3] = this.batteryStatus;
      this.emit(reply);
      return;
    }
    if (sub === NAPE.getCustomDpi) {
      reply[2] = this.customDpi & 0xff;
      reply[3] = (this.customDpi >> 8) & 0xff;
      this.emit(reply);
      return;
    }
    if (sub === NAPE.setCustomDpi) {
      this.customDpi = (request[2] ?? 0) | ((request[3] ?? 0) << 8);
      return;
    }
    if (sub === MISC.getPolling) {
      reply[5] = this.pollingMask;
      reply[6] = this.pollingIndex;
      this.emit(reply);
      return;
    }
    if (sub === MISC.setPolling) {
      this.pollingIndex = request[2] ?? this.pollingIndex;
    }
  }

  private emit(reply: Uint8Array): void {
    queueMicrotask(() => {
      this.listeners.get("inputreport")?.({
        reportId: 0,
        data: new DataView(reply.buffer, reply.byteOffset, reply.byteLength),
      });
    });
  }
}

function device(productId: number, usagePage = 0xff60, usage = 0x61): HIDDevice {
  return {
    vendorId: VENDOR_ID.keychron,
    productId,
    productName: "Keychron Nape Pro",
    collections: [{
      usagePage,
      usage,
      children: [],
      featureReports: [],
      inputReports: [{ reportId: 0, items: [{ reportCount: 32, reportSize: 8 }] }],
      outputReports: [{ reportId: 0, items: [{ reportCount: 32, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

test("support is limited to Nape Pro and Link-KM VIA raw HID collections", () => {
  assert.equal(KeychronHidClient.isSupported(device(0x0440)), true);
  assert.equal(KeychronHidClient.isSupported(device(0xd026)), true);
  assert.equal(KeychronHidClient.isSupported(device(0xd029)), true);
  assert.equal(KeychronHidClient.isSupported(device(0x0441)), false);
  assert.equal(KeychronHidClient.isSupported(device(0x0440, 0xff00, 0x61)), false);
  assert.equal(KeychronHidClient.isSupported(device(0x0440, 0xff60, 1)), false);
});

test("DPI options follow the Nape Pro 50–4000 step-50 ladder", () => {
  const options = new KeychronHidClient(device(0x0440)).getDpiOptions();
  assert.equal(options[0], 50);
  assert.equal(options.at(-1), 4000);
  assert.equal(options.length, (4000 - 50) / 50 + 1);
  assert.ok(options.every((dpi, index) => index === 0 || dpi - options[index - 1]! === 50));
});

test("reads wired Nape Pro status from Launcher misc commands", async () => {
  const fake = new FakeHidDevice();
  const status = await new KeychronHidClient(fake as unknown as HIDDevice).readStatus();
  assert.equal(status.brand, "Keychron");
  assert.equal(status.name, "Nape Pro");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [500, 1000, 2000, 4000, 8000]);
  assert.equal(status.batteryPercent, 76);
  assert.equal(status.batteryState, "Discharging");
  assert.deepEqual(status.firmware, ["v1.0.4"]);
  assert.match(status.connectionDetail ?? "", /Wired USB/);
  assert.match(status.connectionDetail ?? "", /90° orientation/);
  assert.equal(status.ui?.family, "keychron-nape");
  assert.equal(status.ui?.hideProcessingCard, true);
  assert.equal(status.liftOffDistance, null);
});

test("writes DPI and polling then confirms them by reading back", async () => {
  const fake = new FakeHidDevice();
  const client = new KeychronHidClient(fake as unknown as HIDDevice);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(2000), 2000);
  assert.ok(fake.sent.some((packet) =>
    packet[0] === CMD.miscGroup && packet[1] === NAPE.setDpiValue
    && ((packet[3] ?? 0) | ((packet[4] ?? 0) << 8)) === 1600));
  assert.ok(fake.sent.some((packet) =>
    packet[0] === CMD.miscGroup && packet[1] === MISC.setPolling
    && packet[2] === KEYCHRON_POLLING_TABLE.indexOf(2000)));
});

test("rejects receiver paths that are not paired to a Nape Pro", async () => {
  const fake = new FakeHidDevice({
    productId: 0xd026,
    productName: "Keychron Link-KM",
    incompatibleReceiver: true,
  });
  await assert.rejects(
    () => new KeychronHidClient(fake as unknown as HIDDevice).open(),
    /not paired to a Nape Pro/,
  );
});

test("unsupported sensor controls stay unavailable on this protocol", async () => {
  const client = new KeychronHidClient(new FakeHidDevice() as unknown as HIDDevice);
  await assert.rejects(() => client.setLiftOffDistance("Medium"), /not exposed/);
  await assert.rejects(() => client.setMotionSync(true), /not exposed/);
  await assert.rejects(() => client.setAngleSnapping(false), /not exposed/);
  await assert.rejects(() => client.setDebounceTime(4), /not exposed/);
});
