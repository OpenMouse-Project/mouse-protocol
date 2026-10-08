import assert from "node:assert/strict";
import test from "node:test";

import { CorsairBragiHidClient } from "./bragi-hid.ts";

const WIRED = 0x1b4c;
const RECEIVER = 0x1bdc;
const NIGHTSWORD = 0x1b5c;

const hex = (bytes: Uint8Array) => [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");

function collection(usagePage: number, output: boolean): HIDCollectionInfo {
  const report = [{ reportId: 0, items: [] }];
  return { usagePage, usage: 1, children: [], inputReports: report, outputReports: output ? report : [], featureReports: [] } as unknown as HIDCollectionInfo;
}

/**
 * The mouse's properties as ckb-next / OpenRGB / OpenLinkHub read them: an
 * IRONCLAW RGB WIRELESS at 1391 DPI (the capture's first slider value), 1000
 * Hz, hardware mode, 88.0 % and discharging, firmware 3.11.42.
 */
const MOUSE: Record<number, number> = {
  0x01: 4,
  0x03: 1,
  0x0f: 880,
  0x10: 2,
  0x12: WIRED,
  0x13: 0x002a0b03,
  0x21: 1391,
  0x22: 1391,
};

interface FakeOptions {
  productId?: number;
  /** Receiver property 0x36. */
  slots?: number;
  /** Properties the mouse never answers. */
  silent?: number[];
  collections?: HIDCollectionInfo[];
}

/**
 * Answers each GET with an input report the way the receiver does: byte 0 is
 * the slot, byte 1 echoes the command, byte 2 is the status (5 = unsupported
 * for anything unknown), bytes 3-6 the value.
 */
function fakeDevice(options: FakeOptions = {}) {
  const productId = options.productId ?? WIRED;
  const sent: Uint8Array[] = [];
  const listeners = new Set<(event: HIDInputReportEvent) => void>();
  const device = {
    vendorId: 0x1b1c,
    productId,
    productName: "CORSAIR",
    opened: false,
    collections: options.collections ?? [collection(0xff42, true)],
    open: async () => { device.opened = true; },
    close: async () => { device.opened = false; },
    addEventListener: (_type: string, listener: (event: HIDInputReportEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: HIDInputReportEvent) => void) => listeners.delete(listener),
    sendReport: async (_reportId: number, data: ArrayBuffer) => {
      const request = new Uint8Array(data.slice(0));
      sent.push(request);
      const slot = request[0]! & 0x07;
      const property = request[2]!;
      if (options.silent?.includes(property)) return;
      const value = slot === 0 && productId === RECEIVER
        ? (property === 0x36 ? options.slots : undefined)
        : MOUSE[property];
      const reply = new Uint8Array(64);
      reply.set(value === undefined
        ? [slot, request[1]!, 0x05]
        : [slot, request[1]!, 0x00, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]);
      setTimeout(() => listeners.forEach((listener) => listener({ reportId: 0, data: new DataView(reply.buffer) } as HIDInputReportEvent)), 1);
    },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims the 0xFF42 command interface of the IRONCLAW and its receivers only", () => {
  assert.equal(CorsairBragiHidClient.isSupported(fakeDevice().device), true);
  assert.equal(CorsairBragiHidClient.isSupported(fakeDevice({ productId: RECEIVER }).device), true);
  // Interface 2 is 0xFF42 too, but input-only.
  assert.equal(CorsairBragiHidClient.isSupported(fakeDevice({ collections: [collection(0xff42, false)] }).device), false);
  assert.equal(CorsairBragiHidClient.isSupported(fakeDevice({ productId: NIGHTSWORD }).device), false);
  assert.equal(CorsairBragiHidClient.isSupported(fakeDevice({ collections: [collection(0xffc2, true)] }).device), false);
});

test("reads the wired mouse on slot 0 and never writes", async () => {
  const { device, sent } = fakeDevice();
  const status = await new CorsairBragiHidClient(device).readStatus();
  assert.deepEqual(sent.map(hex), ["08 02 12 00", "08 02 13 00", "08 02 03 00", "08 02 01 00", "08 02 0f 00", "08 02 10 00", "08 02 21 00", "08 02 22 00"]);
  assert.equal(status.name, "IRONCLAW RGB WIRELESS");
  assert.equal(status.dpi, 1391);
  assert.equal(status.dpiY, 1391);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.batteryPercent, 88);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.deviceMode, "Onboard");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.firmware, ["Firmware 3.11.42", "Mode: hardware (onboard settings)", "Product id 0x1b4c"]);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, true);
  assert.deepEqual(new CorsairBragiHidClient(device).getDpiOptions(), []);
});

test("through the receiver, reads the mouse in slot 1 like iCUE addresses it", async () => {
  const { device, sent } = fakeDevice({ productId: RECEIVER, slots: 0b10 });
  const status = await new CorsairBragiHidClient(device).readStatus();
  assert.equal(hex(sent[0]!), "08 02 36 00");
  assert.ok(sent.slice(1).every((request) => request[0] === 0x09 && request[1] === 0x02));
  assert.equal(status.name, "IRONCLAW RGB WIRELESS");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "SLIPSTREAM WIRELESS USB Receiver");
  assert.equal(status.dpi, 1391);
  assert.equal(status.firmware.at(-1), "Product id 0x1b4c in receiver slot 1");
});

test("a receiver that refuses the slot read falls back to slot 1", async () => {
  const { device, sent } = fakeDevice({ productId: RECEIVER });
  const status = await new CorsairBragiHidClient(device).readStatus();
  assert.equal(hex(sent[1]!), "09 02 12 00");
  assert.equal(status.dpi, 1391);
});

test("a receiver with nothing connected reports itself and reads no further", async () => {
  const { device, sent } = fakeDevice({ productId: RECEIVER, slots: 0 });
  const status = await new CorsairBragiHidClient(device).readStatus();
  assert.deepEqual(sent.map(hex), ["08 02 36 00"]);
  assert.equal(status.name, "SLIPSTREAM WIRELESS USB Receiver");
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /no mouse is connected/);
});

test("a mouse that does not answer the DPI read still identifies", async () => {
  const { device, sent } = fakeDevice({ silent: [0x21] });
  const status = await new CorsairBragiHidClient(device).readStatus();
  assert.equal(sent.some((request) => request[2] === 0x22), false);
  assert.equal(status.name, "IRONCLAW RGB WIRELESS");
  assert.equal(status.dpi, 0);
  assert.equal(status.ui?.valuesVerified, false);
  assert.match(status.ui?.statusNote ?? "", /did not answer the DPI read/);
});
