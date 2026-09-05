import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CMD,
  LingbaoHidClient,
  REPORT_RATE_DECODE,
  encodeCommand,
} from "./hid.ts";

const M5_PRO_RECEIVER = { vendorId: 0x3151, productId: 0x402d };
const M5_PRO_WIRED = { vendorId: 0x3151, productId: 0x4026 };

function vendorCollection() {
  return {
    usagePage: 0xffff,
    usage: 0x02,
    type: 0,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: [],
  } as unknown as HIDCollectionInfo;
}

/**
 * A receiver that behaves the way the real one does: it answers its own 0xF7
 * status poll itself, and only hands back a device reply after a checksummed
 * command followed by 0xFC.
 */
function fakeReceiver(options: {
  replies?: Record<number, number[]>;
  mouseOnline?: boolean;
  mouseBattery?: number;
  ids?: Partial<{ vendorId: number; productId: number }>;
} = {}) {
  const replies = options.replies ?? {};
  const sent: Uint8Array[] = [];
  let pending: number[] | null = null;

  const status = () => {
    const s = new Uint8Array(64);
    s[0] = 1;                                       // canRead
    s[1] = 0;                                       // keyboard battery
    s[2] = options.mouseBattery ?? 45;              // mouse battery
    s[3] = 1;                                       // keyboard offline
    s[4] = (options.mouseOnline ?? true) ? 0 : 1;   // mouse online when 0
    s[5] = 1;                                       // canSend
    return s;
  };

  let last = status();
  const device = {
    ...M5_PRO_RECEIVER,
    ...options.ids,
    productName: "2.4G Wireless Mouse",
    opened: true,
    collections: [vendorCollection()],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => {
      sent.push(new Uint8Array(data));
      if (data[0] === 0xf7) last = status();
      else if (data[0] === 0xf6) { /* select target */ }
      else if (data[0] === 0xfc) {
        const out = new Uint8Array(64);
        if (pending) out.set(pending);
        last = out;
      } else {
        pending = replies[data[0]] ?? null;
      }
    },
    receiveFeatureReport: async () => new DataView(last.buffer.slice(0)),
  };
  return { device: device as unknown as HIDDevice, sent };
}

/** Build a GET_DPI reply with the given per-stage X values. */
function dpiReply(xs: number[], activeIndex: number, rgb: number[] = []) {
  const reply = new Array(64).fill(0);
  reply[0] = CMD.GET_DPI;
  reply[2] = activeIndex;
  reply[3] = xs.length;
  xs.forEach((value, i) => {
    reply[8 + i * 2] = value & 0xff;
    reply[9 + i * 2] = value >> 8;
    reply[24 + i * 2] = value & 0xff;
    reply[25 + i * 2] = value >> 8;
    if (rgb[i] !== undefined) {
      reply[40 + i * 3] = (rgb[i] >> 16) & 0xff;
      reply[41 + i * 3] = (rgb[i] >> 8) & 0xff;
      reply[42 + i * 3] = rgb[i] & 0xff;
    }
  });
  return reply;
}

describe("LingbaoHidClient", () => {
  it("stamps the Bit7 checksum the M5 Pro echoed back", () => {
    // Checksums observed live in the device's own replies.
    assert.equal(encodeCommand([CMD.GET_FIRMWARE])[7], 0x7f);
    assert.equal(encodeCommand([CMD.GET_USB_VERSION])[7], 0x70);
    assert.equal(encodeCommand([CMD.GET_REPORT_RATE])[7], 0x7c);
    assert.equal(encodeCommand([CMD.GET_DPI, 0x00])[7], 0x2b);
  });

  it("claims only the M5 Pro product ids on VID 0x3151", () => {
    assert.equal(LingbaoHidClient.isSupported(fakeReceiver().device), true);
    assert.equal(LingbaoHidClient.isSupported(fakeReceiver({ ids: M5_PRO_WIRED }).device), true);
    // 0x503d is Fantech's WG14P on the same shared ODM vendor id.
    assert.equal(LingbaoHidClient.isSupported(fakeReceiver({ ids: { productId: 0x503d } }).device), false);
    assert.equal(LingbaoHidClient.isSupported(fakeReceiver({ ids: { vendorId: 0x046d } }).device), false);
  });

  it("relays over 2.4G but talks directly when wired", () => {
    assert.equal(new LingbaoHidClient(fakeReceiver().device).transport, "dongle");
    assert.equal(new LingbaoHidClient(fakeReceiver({ ids: M5_PRO_WIRED }).device).transport, "direct");
  });

  it("caps polling at 8 kHz on the receiver and 1 kHz wired", () => {
    assert.deepEqual(
      new LingbaoHidClient(fakeReceiver().device).supportedPollingRates,
      [125, 250, 500, 1000, 2000, 4000, 8000],
    );
    assert.deepEqual(
      new LingbaoHidClient(fakeReceiver({ ids: M5_PRO_WIRED }).device).supportedPollingRates,
      [125, 250, 500, 1000],
    );
  });

  it("decodes the DPI table captured from the real M5 Pro", async () => {
    // Live bytes: D4 00 02 06 00 00 00 2B  90 01 20 03 40 06 80 0C 00 19 90 65
    const xs = [400, 800, 1600, 3200, 6400, 26000];
    const { device } = fakeReceiver({ replies: { [CMD.GET_DPI]: dpiReply(xs, 2, [0, 0, 0x0000ff]) } });
    const { stages, activeIndex } = await new LingbaoHidClient(device).getDpi();

    assert.equal(activeIndex, 2);
    assert.deepEqual(stages.map((s) => s.x), xs);
    assert.equal(stages[2].x, 1600, "active stage is 1600 DPI");
    assert.equal(stages[5].x, 26000, "PAW3395 tops out at 26000");
    assert.equal(stages[2].rgb, 0x0000ff);
  });

  it("decodes report rate with the seven-entry mouse table", async () => {
    // The keyboard table maps code 5 to 125 Hz; on a mouse it is 250 Hz.
    assert.equal(REPORT_RATE_DECODE[5], 250);
    assert.equal(REPORT_RATE_DECODE[6], 125);

    const reply = new Array(64).fill(0);
    reply[0] = CMD.GET_REPORT_RATE;
    reply[2] = 0;
    const { device } = fakeReceiver({ replies: { [CMD.GET_REPORT_RATE]: reply } });
    assert.equal(await new LingbaoHidClient(device).getReportRate(), 8000);
  });

  it("performs the receiver handshake in order before a read", async () => {
    const { device, sent } = fakeReceiver({ replies: { [CMD.GET_DPI]: dpiReply([1600], 0) } });
    await new LingbaoHidClient(device).getDpi();

    const ids = sent.map((buf) => buf[0]);
    assert.equal(ids[0], 0xf6, "select the mouse as target first");
    assert.equal(sent[0][1], 0x05, "target code for the mouse");
    assert.ok(ids.indexOf(0xf7) > 0, "poll receiver status");
    const command = ids.indexOf(CMD.GET_DPI);
    assert.ok(command > ids.indexOf(0xf7), "command goes out after a ready poll");
    assert.ok(ids.indexOf(0xfc) > command, "notice-read comes after the command");
  });

  it("rejects an unanswered command instead of reading zeros as data", async () => {
    const { device } = fakeReceiver({ replies: {} });
    await assert.rejects(
      () => new LingbaoHidClient(device).getDpi(),
      /not answered \(all-zero response\)/,
    );
  });

  it("reports an unlinked mouse as its own failure, not a protocol failure", async () => {
    const { device } = fakeReceiver({ mouseOnline: false });
    await assert.rejects(
      () => new LingbaoHidClient(device).readStatus(),
      /no mouse is linked/,
    );
  });

  it("readStatus reports battery, link type and sensor", async () => {
    const rate = new Array(64).fill(0);
    rate[0] = CMD.GET_REPORT_RATE;
    rate[2] = 0; // 8000 Hz
    const { device } = fakeReceiver({
      mouseBattery: 45,
      replies: { [CMD.GET_DPI]: dpiReply([400, 800, 1600], 2), [CMD.GET_REPORT_RATE]: rate },
    });

    const status = await new LingbaoHidClient(device).readStatus();
    assert.equal(status.brand, "Lingbao");
    assert.equal(status.name, "Lingbao M5 Pro (2.4G receiver)");
    assert.equal(status.batteryPercent, 45);
    assert.equal(status.connectionType, "Wireless");
    assert.equal(status.connectionDetail, "2.4 GHz");
    assert.equal(status.dpi, 1600);
    assert.equal(status.activeDpiStage, 2);
    assert.deepEqual(status.dpiStages, [400, 800, 1600]);
    assert.equal(status.pollingRateHz, 8000);
    assert.ok(status.firmware.includes("PixArt PAW3395"));
  });

  it("setDpiForStage keeps the other stages and their indicator colours", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_DPI]: dpiReply([800, 1600, 3200], 0, [0x100000, 0x110000, 0x120000]) },
    });
    await new LingbaoHidClient(device).setDpiForStage(6400, 6400, 1);

    const write = sent.filter((buf) => buf[0] === CMD.SET_DPI).at(-1);
    assert.ok(write, "a SET_DPI report should have been sent");
    const u16 = (buf: Uint8Array, i: number) => buf[i] | (buf[i + 1] << 8);
    assert.equal(write![3], 3, "stage count preserved");
    assert.equal(u16(write!, 8), 800);    // stage 0 untouched
    assert.equal(u16(write!, 10), 6400);  // stage 1 updated
    assert.equal(u16(write!, 12), 3200);  // stage 2 untouched
    assert.equal(u16(write!, 26), 6400);  // stage 1 Y updated
    assert.equal(write![40], 0x10);       // indicator colours carried over
    assert.equal(write![43], 0x11);
    assert.equal(write![46], 0x12);
  });

  it("refuses a rate the wired mode cannot reach", async () => {
    const client = new LingbaoHidClient(fakeReceiver({ ids: M5_PRO_WIRED }).device);
    await assert.rejects(() => client.setPollingRate(8000), /Unsupported rate 8000 Hz/);
  });
});
