import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CMD,
  FantechHidClient,
  REPORT_RATE_DECODE,
  REPORT_RATE_ENCODE,
} from "./hid.ts";

function fakeDevice(overrides?: Partial<HIDDevice>): HIDDevice {
  return {
    vendorId: 0x3151,
    productId: 0x503d,
    productName: "Fantech WG14P",
    opened: false,
    collections: [
      { usagePage: 0xffff, usage: 0x02, type: 0, children: [], input: 0, output: 0, feature: 0 },
    ],
    open: async () => { (overrides ?? {}).opened = true; },
    close: async () => {},
    sendFeatureReport: async () => {},
    receiveFeatureReport: async () => new DataView(new ArrayBuffer(64)),
    ...overrides,
  } as unknown as HIDDevice;
}

describe("FantechHidClient", () => {
  it("isSupported detects Fantech vendor config interface", () => {
    const device = fakeDevice();
    assert.equal(FantechHidClient.isSupported(device), true);
  });

  it("isSupported rejects non-Fantech devices", () => {
    const device = fakeDevice({ vendorId: 0x046d } as Partial<HIDDevice>);
    assert.equal(FantechHidClient.isSupported(device), false);
  });

  it("sendCommand writes correct command byte", async () => {
    let sent: Uint8Array | undefined;
    const device = fakeDevice({
      sendFeatureReport: async (_id: number, data: ArrayBuffer | ArrayLike<number>) => {
        sent = data instanceof Uint8Array ? data : new Uint8Array(data);
      },
      receiveFeatureReport: async () => new DataView(new ArrayBuffer(64)),
    });
    const client = new FantechHidClient(device);
    await client.sendCommand(CMD.GET_DPI, 0);
    assert.ok(sent);
    assert.equal(sent![0], CMD.GET_DPI);
    assert.equal(sent![1], 0);
  });

  it("getReportRate decodes response correctly", async () => {
    const device = fakeDevice({
      sendFeatureReport: async () => {},
      receiveFeatureReport: async () => {
        const buf = new ArrayBuffer(64);
        const view = new DataView(buf);
        view.setUint8(0, CMD.GET_REPORT_RATE);
        view.setUint8(2, 3); // 1000 Hz
        return view;
      },
    });
    const client = new FantechHidClient(device);
    const rate = await client.getReportRate();
    assert.equal(rate, 1000);
  });

  it("getDpi decodes response correctly", async () => {
    const device = fakeDevice({
      sendFeatureReport: async () => {},
      receiveFeatureReport: async () => {
        const buf = new ArrayBuffer(64);
        const view = new DataView(buf);
        view.setUint8(2, 0); // slot 0
        view.setUint8(3, 1); // 1 slot
        // X DPI = 1600 at bytes [8..9] LE
        view.setUint8(8, 0x40);
        view.setUint8(9, 0x06);
        // Y DPI = 1600 at bytes [24..25] LE
        view.setUint8(24, 0x40);
        view.setUint8(25, 0x06);
        return view;
      },
    });
    const client = new FantechHidClient(device);
    const dpi = await client.getDpi();
    assert.equal(dpi.dpiX, 1600);
    assert.equal(dpi.dpiY, 1600);
    assert.equal(dpi.slot, 0);
    assert.equal(dpi.numSlots, 1);
  });

  it("report rate encode/decode round-trips", () => {
    for (const [hz, code] of Object.entries(REPORT_RATE_ENCODE)) {
      assert.equal(REPORT_RATE_DECODE[code], Number(hz));
    }
  });

  it("setReportRate rejects unsupported rates", async () => {
    const device = fakeDevice();
    const client = new FantechHidClient(device);
    await assert.rejects(() => client.setReportRate(9999), /Unsupported rate/);
  });
});
