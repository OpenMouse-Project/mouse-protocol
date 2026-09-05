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

  it("only advertises polling rates it can encode", () => {
    const client = new FantechHidClient(fakeDevice());
    for (const hz of client.supportedPollingRates) {
      assert.ok(hz in REPORT_RATE_ENCODE, `${hz} Hz is advertised but cannot be encoded`);
    }
    assert.deepEqual(client.supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
  });

  // A device on the wrong protocol family (VID 0x3151 PID 0x402D, measured)
  // ACKs the write and answers 64 zero bytes. Decoding that used to yield
  // 1600 DPI and 8000 Hz, both invented.
  it("getDpi rejects an all-zero response instead of reporting 1600", async () => {
    const client = new FantechHidClient(fakeDevice());
    await assert.rejects(() => client.getDpi(), /not answered/);
  });

  it("getReportRate rejects an all-zero response instead of decoding 8000 Hz", async () => {
    const client = new FantechHidClient(fakeDevice());
    await assert.rejects(() => client.getReportRate(), /not answered/);
  });

  it("readStatus throws when the device answers nothing", async () => {
    const client = new FantechHidClient(fakeDevice());
    await assert.rejects(() => client.readStatus(), /did not answer/);
  });

  it("readStatus reports only what was answered, with no fabricated link type", async () => {
    const device = fakeDevice({
      receiveFeatureReport: async () => {
        const view = new DataView(new ArrayBuffer(64));
        view.setUint8(2, 3); // report-rate code 3 = 1000 Hz; also DPI slot 3
        view.setUint8(3, 4); // four DPI slots
        view.setUint16(8 + 3 * 2, 1600, true);
        view.setUint16(24 + 3 * 2, 1600, true);
        return view;
      },
    });
    const status = await new FantechHidClient(device).readStatus();
    assert.equal(status.dpi, 1600);
    assert.equal(status.pollingRateHz, 1000);
    assert.equal(status.ui?.settingsReady, true);
    assert.equal(status.connectionType, undefined);
    assert.deepEqual(status.firmware, []);
  });

  it("setDpiForSlot leaves the other DPI slots untouched", async () => {
    const sent: Uint8Array[] = [];
    const device = fakeDevice({
      sendFeatureReport: async (_id: number, data: ArrayBuffer | ArrayLike<number>) => {
        sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
      },
      receiveFeatureReport: async () => {
        const view = new DataView(new ArrayBuffer(64));
        view.setUint8(2, 0); // active slot
        view.setUint8(3, 2); // two slots in use
        view.setUint16(8, 800, true);   // slot 0 X
        view.setUint16(10, 3200, true); // slot 1 X
        view.setUint16(24, 800, true);  // slot 0 Y
        view.setUint16(26, 3200, true); // slot 1 Y
        return view;
      },
    });

    await new FantechHidClient(device).setDpiForSlot(1600, 1600, 0);

    const write = sent[sent.length - 1];
    const u16 = (buf: Uint8Array, i: number) => buf[i] | (buf[i + 1] << 8);
    assert.equal(write[0], CMD.SET_DPI);
    assert.equal(u16(write, 8), 1600);   // slot 0 X updated
    assert.equal(u16(write, 24), 1600);  // slot 0 Y updated
    assert.equal(u16(write, 10), 3200);  // slot 1 X carried over
    assert.equal(u16(write, 26), 3200);  // slot 1 Y carried over
  });
});
