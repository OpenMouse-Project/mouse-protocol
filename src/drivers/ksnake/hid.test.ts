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
  });

  it("round-trips polling rates", () => {
    for (const hz of [125, 250, 500, 1000, 2000, 4000, 8000]) {
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
