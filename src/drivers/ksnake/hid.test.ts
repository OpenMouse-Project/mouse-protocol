import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KSNAKE_PRODUCT_ID,
  KSNAKE_USAGE,
  KSNAKE_USAGE_PAGE,
  ksnakeDecodeBattery,
  ksnakeDecodeConfig,
  ksnakeDecodePollingRate,
  ksnakeDecodeVersion,
  ksnakeEncodePollingRate,
  ksnakeEncodeSetConfig,
  ksnakeGetBatteryRequest,
  ksnakeGetConfigRequest,
  ksnakeGetVersionRequest,
  ksnakeIsValidDpi,
} from "../../ksnake/index.js";
import { KsnakeHidClient } from "./hid.ts";

function fakeDevice(overrides?: Partial<HIDDevice>): HIDDevice {
  return {
    vendorId: 0xa8a5,
    productId: KSNAKE_PRODUCT_ID,
    productName: "USB Receiver",
    opened: false,
    collections: [{ usagePage: KSNAKE_USAGE_PAGE, usage: KSNAKE_USAGE, children: [] }],
    open: async () => {},
    close: async () => {},
    sendReport: async () => {},
    sendFeatureReport: async () => {},
    receiveFeatureReport: async () => new DataView(new ArrayBuffer(64)),
    addEventListener: () => {},
    removeEventListener: () => {},
    ...overrides,
  } as unknown as HIDDevice;
}

describe("ksnake codec", () => {
  it("frames version/battery/config requests", () => {
    assert.equal(ksnakeGetVersionRequest()[1], 0x03);
    assert.equal(ksnakeGetBatteryRequest()[1], 0x30);
    assert.deepEqual([...ksnakeGetConfigRequest().slice(0, 7)], [0x55, 0x0e, 0xa5, 0x0b, 0x2f, 0x01, 0x01]);
  });

  it("decodes version ASCII", () => {
    const reply = new Uint8Array(64);
    reply[23] = 49;
    reply[24] = 50;
    reply[25] = 51;
    assert.equal(ksnakeDecodeVersion(reply), "1.2.3");
  });

  it("decodes battery", () => {
    const reply = new Uint8Array(64);
    reply[8] = 87;
    reply[9] = 1;
    assert.deepEqual(ksnakeDecodeBattery(reply), { percent: 87, charging: 1 });
  });

  it("falls back to defaults on blank config", () => {
    const config = ksnakeDecodeConfig(new Uint8Array(64));
    assert.ok(config);
    assert.deepEqual(config?.stages.slice(0, 4), [800, 1200, 1600, 3200]);
    // Retail hardware reports 6 enabled stages.
    assert.equal(config?.dpiCount, 6);
  });

  it("validates the vendor DPI range (200-12000, whole numbers)", () => {
    for (const dpi of [200, 600, 800, 1200, 1600, 3200, 5000, 12000]) {
      assert.equal(ksnakeIsValidDpi(dpi), true);
    }
    for (const dpi of [0, 100, 150, 12001, 26000, 1600.5, Number.NaN]) {
      assert.equal(ksnakeIsValidDpi(dpi), false);
    }
  });

  it("round-trips polling rates (X11: 125-1000 Hz)", () => {
    for (const hz of [125, 250, 500, 1000]) {
      const index = ksnakeEncodePollingRate(hz);
      assert.ok(index !== null);
      assert.equal(ksnakeDecodePollingRate(index as number), hz);
    }
  });

  it("encodes setConfig with vendor layout", () => {
    const req = ksnakeEncodeSetConfig({
      lightMode: 2,
      reportRate: 3,
      dpiIndex: 2,
      dpiCount: 5,
      stages: [800, 1200, 1600, 3200, 5000, 12000],
      scrollFlag: 0,
      lodValue: 1,
      sensorFlag: 53,
      keyRespond: 2,
      sleepLight: 10,
      highspeedMode: 0,
      wakeupFlag: 1,
      moveLightFlag: 1,
    });
    assert.equal(req[10], 4);
    assert.equal(req[12], 3);
    assert.equal(req[17], 0x40);
    assert.equal(req[18], 0x06);
  });
});

describe("KsnakeHidClient", () => {
  it("matches the X11 control collection", () => {
    assert.equal(KsnakeHidClient.isSupported(fakeDevice()), true);
    assert.equal(KsnakeHidClient.isSupported(fakeDevice({ vendorId: 0x046d })), false);
    assert.equal(KsnakeHidClient.isSupported(fakeDevice({ productId: 0x1234 })), false);
  });

  it("rejects unsupported polling rates without touching HID", async () => {
    const client = new KsnakeHidClient(fakeDevice());
    await assert.rejects(() => client.setPollingRate(9999), /does not support/);
  });
});

type FakeListener = (event: { data: DataView }) => void;

function configReply(stages: number[], reportRate: number, dpiIndex: number): Uint8Array {
  const reply = new Uint8Array(64);
  reply[9] = 2;
  reply[10] = reportRate + 1;
  reply[11] = 6;
  reply[12] = dpiIndex + 1;
  stages.forEach((stage, i) => {
    reply[13 + i * 2] = stage & 0xff;
    reply[14 + i * 2] = (stage >> 8) & 0xff;
  });
  reply[48] = 0;
  reply[49] = 1;
  reply[50] = 53;
  reply[51] = 2;
  reply[52] = 10;
  reply[53] = 0;
  reply[55] = 0x11;
  return reply;
}

/** HIDDevice stand-in backed by emulated mouse state. */
class FakeKsnakeDevice {
  vendorId = 0xa8a5;
  productId = KSNAKE_PRODUCT_ID;
  productName = "USB Receiver";
  collections = [{ usagePage: KSNAKE_USAGE_PAGE, usage: KSNAKE_USAGE, children: [] }];
  opened = false;
  stages = [800, 1200, 1600, 3200, 5000, 12000];
  reportRate = 3;
  dpiIndex = 2;
  /** Upcoming replies to swallow (simulates a sleeping dongle). */
  dropReplies = 0;
  sent: number[] = [];
  private listeners = new Map<string, Set<FakeListener>>();

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  addEventListener(type: string, listener: FakeListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  async sendReport(_reportId: number, payload: ArrayBuffer): Promise<void> {
    const body = new Uint8Array(payload);
    this.sent.push(body[1]);
    if (body[1] === 0x0f) {
      for (let i = 0; i < 6; i++) {
        this.stages[i] = body[13 + i * 2] | (body[14 + i * 2] << 8);
      }
      this.reportRate = body[10] - 1;
      this.dpiIndex = body[12] - 1;
    }
    const reply = configReply(this.stages, this.reportRate, this.dpiIndex);
    queueMicrotask(() => {
      if (this.dropReplies > 0) {
        this.dropReplies -= 1;
        return;
      }
      const data = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      this.listeners.get("inputreport")?.forEach((listener) => listener({ data }));
    });
  }
}

function fastClient(device: FakeKsnakeDevice): KsnakeHidClient {
  return new KsnakeHidClient(device as unknown as HIDDevice, {
    replyTimeoutMs: 20,
    settleAfterWriteMs: 0,
  });
}

describe("KsnakeHidClient writes", () => {
  it("writes the active DPI stage and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setDpi(800), 800);
    assert.equal(device.stages[2], 800);
    assert.deepEqual(device.sent, [0x0e, 0x0f, 0x0e]);
  });

  it("recovers when the first reply is lost", async () => {
    const device = new FakeKsnakeDevice();
    device.dropReplies = 1;
    assert.equal(await fastClient(device).setDpi(2400), 2400);
    assert.equal(device.stages[2], 2400);
  });

  it("reports an unreadable config when the mouse stays silent", async () => {
    const device = new FakeKsnakeDevice();
    device.dropReplies = 99;
    await assert.rejects(() => fastClient(device).setDpi(800), /Could not read the current config/);
  });

  it("writes the polling-rate index and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setPollingRate(500), 500);
    assert.equal(device.reportRate, 2);
  });

  it("rejects out-of-range DPI without touching the mouse", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setDpi(100), /between 200 and 12000/);
    await assert.rejects(() => fastClient(device).setDpi(26000), /between 200 and 12000/);
    assert.deepEqual(device.sent, []);
  });
});
