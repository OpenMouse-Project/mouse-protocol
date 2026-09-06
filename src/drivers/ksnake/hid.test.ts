import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KSNAKE_PRODUCT_ID,
  KSNAKE_USAGE,
  KSNAKE_USAGE_PAGE,
  ksnakeDecodeBattery,
  ksnakeDecodeConfig,
  ksnakeDecodeKeys,
  ksnakeDecodePollingRate,
  ksnakeDecodeVersion,
  ksnakeEncodePollingRate,
  ksnakeEncodeSetConfig,
  ksnakeEncodeSetKeys,
  ksnakeGetBatteryRequest,
  ksnakeGetConfigRequest,
  ksnakeGetKeysRequest,
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

function configReply(stages: number[], reportRate: number, dpiIndex: number, lodValue = 1): Uint8Array {
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
  reply[49] = lodValue;
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
  lodValue = 1;
  /** 7 key slots, mirroring a retail dump (slot 4 = macro reference). */
  keys = [
    { type: 32, code1: 1, code2: 0, code3: 0 },
    { type: 32, code1: 2, code2: 0, code3: 0 },
    { type: 32, code1: 4, code2: 0, code3: 0 },
    { type: 32, code1: 8, code2: 0, code3: 0 },
    { type: 112, code1: 0, code2: 1, code3: 3 },
    { type: 33, code1: 85, code2: 0, code3: 0 },
    { type: 33, code1: 56, code2: 1, code3: 0 },
  ];
  /** Upcoming replies to swallow (simulates a sleeping dongle). */
  dropReplies = 0;
  /** Next version reply decodes to null once (simulates a crossed report). */
  badVersionOnce = false;
  /** Next battery reply exceeds 100% once (simulates a crossed report). */
  badBatteryOnce = false;
  /** Next keys reply is zeroed once (simulates a stray report). */
  badKeysOnce = false;
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
    let reply: Uint8Array;
    if (body[1] === 0x03) {
      reply = new Uint8Array(64);
      if (!this.badVersionOnce) {
        reply[23] = 50; // "2"
        reply[24] = 49; // "1"
        reply[25] = 55; // "7"
      }
      this.badVersionOnce = false;
    } else if (body[1] === 0x30) {
      reply = new Uint8Array(64);
      reply[8] = this.badBatteryOnce ? 200 : 81;
      reply[9] = 0;
      this.badBatteryOnce = false;
    } else if (body[1] === 0x08) {
      reply = new Uint8Array(64);
      if (!this.badKeysOnce) {
        this.keys.forEach((key, i) => {
          reply[8 + i * 4] = key.type;
          reply[9 + i * 4] = key.code1;
          reply[10 + i * 4] = key.code2;
          reply[11 + i * 4] = key.code3;
        });
      }
      this.badKeysOnce = false;
    } else if (body[1] === 0x09) {
      for (let i = 0; i < 6; i++) {
        this.keys[i] = { type: body[9 + i * 4], code1: body[10 + i * 4], code2: body[11 + i * 4], code3: body[12 + i * 4] };
      }
      reply = new Uint8Array(64);
      this.keys.forEach((key, i) => {
        reply[8 + i * 4] = key.type;
        reply[9 + i * 4] = key.code1;
        reply[10 + i * 4] = key.code2;
        reply[11 + i * 4] = key.code3;
      });
    } else {
      if (body[1] === 0x0f) {
        for (let i = 0; i < 6; i++) {
          this.stages[i] = body[13 + i * 2] | (body[14 + i * 2] << 8);
        }
        this.reportRate = body[10] - 1;
        this.dpiIndex = body[12] - 1;
        this.lodValue = body[49];
      }
      reply = configReply(this.stages, this.reportRate, this.dpiIndex, this.lodValue);
    }
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

  it("switches the active DPI stage and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setActiveDpiStage(4), 4);
    assert.equal(device.dpiIndex, 4);
    assert.deepEqual(device.sent, [0x0e, 0x0f, 0x0e]);
  });

  it("rejects out-of-range DPI stages without writing", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setActiveDpiStage(6), /between 1 and 6/);
    await assert.rejects(() => fastClient(device).setDpiStageValue(0, 100), /between 200 and 12000/);
    assert.ok(!device.sent.includes(0x0f), "no SET must be sent");
  });

  it("edits a single DPI stage value and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setDpiStageValue(0, 600), 600);
    assert.equal(device.stages[0], 600);
  });

  it("retries status reads that fail validation", async () => {
    const device = new FakeKsnakeDevice();
    device.badVersionOnce = true;
    device.badBatteryOnce = true;
    const status = await fastClient(device).readStatus();
    assert.deepEqual(status.firmware, ["X11 2.1.7"]);
    assert.equal(status.batteryPercent, 81);
    assert.equal(status.liftOffDistance, "Low");
    assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  });

  it("writes the lift-off distance and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setLiftOffDistance("High"), "High");
    assert.equal(device.lodValue, 2);
  });

  it("rejects the unsupported medium lift-off distance", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setLiftOffDistance("Medium"), /does not support a medium/);
  });

  it("decodes the 7 button slots from a keys reply", () => {
    const reply = new Uint8Array(64);
    const slots = [
      [32, 1, 0, 0], [32, 2, 0, 0], [32, 4, 0, 0], [32, 8, 0, 0],
      [112, 0, 1, 3], [33, 85, 0, 0], [33, 56, 1, 0],
    ];
    slots.forEach(([type, c1, c2, c3], i) => {
      reply[8 + i * 4] = type;
      reply[9 + i * 4] = c1;
      reply[10 + i * 4] = c2;
      reply[11 + i * 4] = c3;
    });
    assert.deepEqual(ksnakeDecodeKeys(reply), slots.map(([type, code1, code2, code3]) => ({ type, code1, code2, code3 })));
    assert.equal(ksnakeDecodeKeys(new Uint8Array(10)), null);
  });

  it("encodes setKeys with the vendor layout and fixed tail", () => {
    const req = ksnakeEncodeSetKeys([
      { type: 32, code1: 1, code2: 0, code3: 0 },
      { type: 32, code1: 2, code2: 0, code3: 0 },
      { type: 32, code1: 4, code2: 0, code3: 0 },
      { type: 32, code1: 8, code2: 0, code3: 0 },
      { type: 32, code1: 16, code2: 0, code3: 0 },
      { type: 33, code1: 85, code2: 0, code3: 0 },
    ]);
    assert.deepEqual([...req.slice(0, 5)], [0x55, 0x09, 0xa5, 0x22, 0x20]);
    assert.deepEqual([...req.slice(9, 13)], [32, 1, 0, 0]);
    assert.deepEqual([...req.slice(29, 33)], [33, 85, 0, 0]);
    assert.deepEqual([...req.slice(33, 41)], [33, 56, 1, 0, 33, 56, 255, 0]);
  });

  it("writes a button map and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    device.keys = [
      { type: 32, code1: 1, code2: 0, code3: 0 },
      { type: 32, code1: 2, code2: 0, code3: 0 },
      { type: 32, code1: 4, code2: 0, code3: 0 },
      { type: 32, code1: 8, code2: 0, code3: 0 },
      { type: 32, code1: 16, code2: 0, code3: 0 },
      { type: 33, code1: 85, code2: 0, code3: 0 },
      { type: 33, code1: 56, code2: 1, code3: 0 },
    ];
    const next = device.keys.slice(0, 6).map((key) => ({ ...key }));
    next[4] = { type: 48, code1: 233, code2: 0, code3: 0 }; // Forward -> Volume+
    const returned = await fastClient(device).setKeys(next);
    assert.deepEqual(returned, next);
    assert.deepEqual(device.keys[4], { type: 48, code1: 233, code2: 0, code3: 0 });
    assert.ok(device.sent.includes(0x09));
  });

  it("refuses to overwrite macro bindings", async () => {
    const device = new FakeKsnakeDevice();
    const next = device.keys.slice(0, 6).map((key) => ({ ...key }));
    await assert.rejects(() => fastClient(device).setKeys(next), /not remappable/);
    assert.ok(!device.sent.includes(0x09));
  });

  it("skips stray zeroed reports when reading the button map", async () => {
    const device = new FakeKsnakeDevice();
    device.badKeysOnce = true;
    const keys = await fastClient(device).getKeys();
    assert.deepEqual(keys, device.keys);
  });

  it("rejects out-of-range DPI without touching the mouse", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setDpi(100), /between 200 and 12000/);
    await assert.rejects(() => fastClient(device).setDpi(26000), /between 200 and 12000/);
    assert.deepEqual(device.sent, []);
  });
});
