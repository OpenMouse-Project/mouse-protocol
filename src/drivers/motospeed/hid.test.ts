import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MotospeedHidClient } from "./hid.js";
import { createSupportedClient, deviceBrand } from "../registry.js";
import { MOTOSPEED_HID_FILTERS, SUPPORTED_HID_FILTERS } from "../vendors.js";

class InputReport extends Event implements HIDInputReportEvent {
  constructor(
    readonly device: HIDDevice,
    readonly reportId: number,
    readonly data: DataView,
  ) {
    super("inputreport");
  }
}

export class X6Device implements HIDDevice {
  vendorId = 0x0bda;
  productId = 0xffe0;
  productName = "Dongle 8K";
  opened = false;
  collections: HIDCollectionInfo[] = [
    {
      usagePage: 0xffc1,
      usage: 1,
      children: [],
      featureReports: [],
      inputReports: [
        { reportId: 0xb4, items: [{ reportSize: 8, reportCount: 63 }] },
      ],
      outputReports: [0xb3, 0xb5].map((reportId) => ({ reportId, items: [] })),
    },
  ];
  listeners = new Set<(event: HIDInputReportEvent) => void>();
  sent: Array<{ reportId: number; data: number[] }> = [];
  settings = Uint8Array.from(
    Buffer.from("060022220290012003b004800cc0120d0505012e", "hex"),
  );
  silent = false;
  retainWrites = true;
  failSend = false;
  beforeReply: (() => void) | null = null;

  async open() {
    this.opened = true;
  }

  async close() {
    this.opened = false;
  }

  addEventListener(
    _type: "inputreport",
    listener: (event: HIDInputReportEvent) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "inputreport",
    listener: (event: HIDInputReportEvent) => void,
  ) {
    this.listeners.delete(listener);
  }

  async sendFeatureReport(): Promise<void> {
    throw new Error("X6 uses output reports");
  }

  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("X6 uses input reports");
  }

  emit(reportId: number, bytes: Uint8Array) {
    const event = new InputReport(
      this,
      reportId,
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    for (const listener of this.listeners) listener(event);
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    assert.ok(this.opened);
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.sent.push({ reportId, data: [...bytes] });
    if (this.failSend) throw new Error("USB send failed");

    if (reportId === 0xb3 && bytes[0] === 6) {
      this.beforeReply?.();
      if (!this.silent) this.emit(0xb4, this.settings);
      return;
    }
    if (reportId !== 0xb5 || !this.retainWrites) return;

    switch (bytes[0]) {
      case 0x40:
        this.settings[4] = bytes[2];
        this.settings.set(bytes.subarray(4, 14), 5);
        if (bytes[14]) this.settings[16] = bytes[14];
        break;
      case 0x41:
        this.settings[2] = this.settings[3] = bytes[2] * 17;
        break;
      case 0x43:
        this.settings[17] = bytes[1];
        break;
      case 0x0a:
        this.settings[18] = bytes[2];
        break;
      case 0x42:
        this.settings[15] =
          (bytes[1] === 1 ? 1 : 2) |
          (bytes[2] === 1 ? 0x04 : 0) |
          (bytes[3] === 1 ? 0x08 : 0) |
          (bytes[4] === 1 ? 0x10 : 0) |
          (bytes[6] === 2 ? 0x40 : 0) |
          (bytes[7] === 2 ? 0x80 : 0);
        break;
    }
  }
}

describe("Motospeed X6 HID", () => {
it("registry and picker include both X6 connection paths", () => {
  const device = new X6Device();
  for (const productId of [0xffe0, 0xfff1]) {
    device.productId = productId;
    const client = createSupportedClient(device);
    assert.ok(client instanceof MotospeedHidClient);
    assert.equal(deviceBrand(client), "Motospeed");
    assert.ok(
      MOTOSPEED_HID_FILTERS.some(
        (f) =>
          f.vendorId === 0x0bda &&
          f.productId === productId &&
          f.usagePage === 0xffc1,
      ),
    );
  }
  for (const filter of MOTOSPEED_HID_FILTERS)
    assert.ok(SUPPORTED_HID_FILTERS.includes(filter));
});

it("support requires the Motospeed control collection", () => {
  const device = new X6Device();
  device.productId = 0xffff;
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.productId = 0xffe0;
  device.vendorId = 0x1234;
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.vendorId = 0x0bda;
  const control = device.collections[0];
  device.collections = [{ ...control, usagePage: 1 }];
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.collections = [{ ...control, outputReports: [] }];
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.collections = [{ ...control, usagePage: 1, children: [control] }];
  assert.equal(MotospeedHidClient.isSupported(device), true);
});

it("reads settings with listener attached before send, ignoring unrelated input", async () => {
  const device = new X6Device();
  device.beforeReply = () => {
    device.emit(1, device.settings);
    device.emit(0xb4, new Uint8Array([0x52, 0]));
  };
  const client = new MotospeedHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, 46);
  assert.equal(status.dpi, 1200);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.lighting?.mode, null);
  assert.equal(status.lighting?.writeOnly, true);
  assert.equal(device.listeners.size, 0);
  device.productId = 0xfff1;
  assert.equal((await client.readStatus()).batteryPercent, null);
  await client.close();
  assert.equal(device.opened, false);
});

it("accepts 60-byte B3 reports and rejects unsupported lengths", async () => {
  for (const length of [60, 61, 63]) {
    const device = new X6Device();
    device.collections = [
      {
        ...device.collections[0],
        outputReports: [
          { reportId: 0xb3, items: [{ reportSize: 8, reportCount: length }] },
          { reportId: 0xb5, items: [{ reportSize: 8, reportCount: 20 }] },
        ],
      },
    ];
    const client = new MotospeedHidClient(device);
    if (length !== 60) {
      await assert.rejects(client.readStatus(), /payload length/);
      assert.equal(device.listeners.size, 0);
      continue;
    }
    await client.readStatus();
    await client.setButtonMapping(0, { kind: "disabled" });
    assert.deepEqual(
      device.sent.map((p) => p.data.length),
      [length, length],
    );
  }
});

it("concurrent DPI edits run as separate read-write-read transactions", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  assert.deepEqual(
    await Promise.all([client.setDpi(1600), client.setDpiStageValue(0, 800)]),
    [1600, 800],
  );
  assert.deepEqual(
    device.sent.map((p) => p.data[0]),
    [6, 0x40, 6, 6, 0x40, 6],
  );
  assert.deepEqual(
    (await client.readStatus()).dpiStages,
    [800, 800, 1600, 3200, 4800],
  );
});

it("DPI stage count keeps the active stage in range", async () => {
  const client = new MotospeedHidClient(new X6Device());
  assert.equal(await client.setDpiStageCount(2), 2);
  assert.equal((await client.readStatus()).activeDpiStage, 1);
  assert.equal(await client.setActiveDpiStage(0), 0);
  await assert.rejects(client.setActiveDpiStage(2), /Active DPI stage/);
});

it("general setting writes preserve the other controls", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  await client.setLiftOffDistance("Low");
  await client.setRippleControl(true);
  await client.setMotionSync(false);
  await client.setAngleSnapping(false);
  await client.setInvertScroll(true);
  await client.setPerformanceMode(true);
  const settings = await client.readSettings();
  assert.equal(settings.settingsByte, 0xd1);
  assert.equal(settings.liftOffDistance, "Low");
  assert.equal(settings.rippleControl, true);
  assert.equal(settings.motionSync, false);
  assert.equal(settings.esportsMode, true);
});

it("LOD write follows the field order observed in the diagnostic capture", async () => {
  const device = new X6Device();
  device.settings[15] = 0x99;
  const client = new MotospeedHidClient(device);

  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  assert.deepEqual(
    device.sent[1]?.data.slice(0, 8),
    [0x42, 0x01, 0x02, 0x01, 0x01, 0x00, 0x01, 0x02],
  );
  assert.equal((await client.readSettings()).settingsByte, 0x99);
});

it("unknown general bits are preserved by refusing a destructive full-settings write", async () => {
  const device = new X6Device();
  device.settings[15] |= 0x20;
  const client = new MotospeedHidClient(device);
  await assert.rejects(
    client.setMotionSync(false),
    /Unknown Motospeed general/,
  );
  assert.deepEqual(
    device.sent.map((p) => p.data[0]),
    [6],
  );
  device.settings[15] = 0;
  await assert.rejects(client.setMotionSync(false), /Unknown Motospeed LOD/);
});

it("scalar writes confirm readback and expose sleep in seconds", async () => {
  const client = new MotospeedHidClient(new X6Device());
  assert.equal(await client.setPollingRate(8000), 8000);
  assert.equal(await client.setDebounceTime(7), 7);
  assert.equal(await client.setSleepTimeout(120), 120);
  const status = await client.readStatus();
  assert.equal(status.sleepTimeout, 120);
  assert.equal(status.debounceMs, 7);
});

it("failed verification rejects instead of returning the requested value", async () => {
  const device = new X6Device();
  device.retainWrites = false;
  const client = new MotospeedHidClient(device);
  await assert.rejects(client.setPollingRate(8000), /did not retain/);
  await assert.rejects(client.setDpi(1600), /did not retain/);
  await assert.rejects(client.setMotionSync(false), /did not retain/);
});

it("invalid settings do not reach the HID transport", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  await assert.rejects(client.setPollingRate(250));
  assert.equal(device.sent.length, 0);
});

it("write-only lighting state updates only after a successful write", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  const initial = (await client.readStatus()).lighting;
  if (!initial) throw new Error("Motospeed status did not include lighting");
  const written = await client.setLighting({
    ...initial,
    mode: "Static",
    color: "#ff3332",
    brightness: 100,
    speed: 128,
  });
  written.color = "#000000";
  assert.equal((await client.readStatus()).lighting?.color, "#ff3332");
  device.failSend = true;
  await assert.rejects(
    client.setLighting({ ...initial, mode: "Off" }),
    /USB send failed/,
  );
  device.failSend = false;
  assert.equal((await client.readStatus()).lighting?.mode, "Static");
});

it("a settings timeout removes its input listener", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device, 20);
  device.silent = true;
  await assert.rejects(client.readStatus(), /Timed out/);
  assert.equal(device.listeners.size, 0);
});

it("a malformed settings reply removes its listener", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  device.settings = new Uint8Array([6]);
  await assert.rejects(client.readStatus(), /Invalid Motospeed/);
  assert.equal(device.listeners.size, 0);
});

it("the queue recovers after a send failure", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  device.failSend = true;
  await assert.rejects(client.readStatus(), /USB send failed/);
  assert.equal(device.listeners.size, 0);
  device.failSend = false;
  assert.equal((await client.readStatus()).dpi, 1200);
});
});
