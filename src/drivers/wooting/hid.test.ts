import assert from "node:assert/strict";
import test from "node:test";

import { WootingHidClient } from "./hid.ts";
import { deviceBrand } from "../registry.ts";
import { WOOTING_VENDOR_ID } from "@openmouse/protocol/wooting";

interface FakeOptions {
  /** Layout byte the fake answers with, "silent" for no reply, "throw" to reject the send. */
  reply?: number | "silent" | "throw";
  /** Which channel the reply comes back on. */
  channel?: "input" | "feature";
  productId?: number;
  usagePage?: number;
  featureReportId?: number;
}

function fakeWooting(
  { reply = 0, channel = "input", productId = 0x1322, usagePage = 0xff55, featureReportId = 1 }: FakeOptions = {},
) {
  let inputListener: ((event: HIDInputReportEvent) => void) | null = null;
  const sent: Array<{ reportId: number; data: Uint8Array }> = [];
  let opened = false;
  let lastCommand = 0;
  // Echo the command that was just sent; the DEVICE_CONFIG reply (0x13) also
  // carries the layout byte at the WebHID offset (9).
  const answer = () => {
    const response = new Uint8Array(64);
    response[0] = 0xd1; // the 60HE+ answers with the multi-report magic
    response[1] = 0xda;
    response[2] = lastCommand;
    response[3] = 0x88; // OK status
    if (lastCommand === 0x13) response[9] = typeof reply === "number" ? reply : 0;
    if (lastCommand === 0x01) response.set([0x03, 0x00, 0x02, 0x0d], 4); // version 3.0.2 build 13
    return response;
  };
  const device = {
    vendorId: WOOTING_VENDOR_ID,
    productId,
    productName: "Wooting 60HE+",
    get opened() {
      return opened;
    },
    collections: [{
      usagePage,
      usage: 1,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [{ reportId: featureReportId, items: [] }],
    }],
    open: async () => void (opened = true),
    close: async () => void (opened = false),
    sendFeatureReport: async (reportId: number, data: Uint8Array) => {
      sent.push({ reportId, data: new Uint8Array(data) });
      lastCommand = data[2] ?? 0;
      if (reply === "throw") throw new Error("This interface has no feature report to write to.");
      if (reply !== "silent" && channel === "input") {
        inputListener?.({ data: new DataView(answer().buffer) } as HIDInputReportEvent);
      }
    },
    receiveFeatureReport: async (_reportId: number) => {
      if (reply === "silent" || reply === "throw" || channel !== "feature") {
        return new DataView(new Uint8Array(64).buffer);
      }
      return new DataView(answer().buffer);
    },
    addEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport") inputListener = listener;
    },
    removeEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport" && inputListener === listener) inputListener = null;
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

test("isSupported accepts only the 0xFF55 config interface", () => {
  assert.equal(WootingHidClient.isSupported(fakeWooting().device), true);
  // The legacy 0xFF00 and analog 0xFF53 collections are not the command
  // interface, so they are rejected (this is what kept the board off the picker
  // twice).
  assert.equal(WootingHidClient.isSupported(fakeWooting({ usagePage: 0xff00 }).device), false);
  assert.equal(WootingHidClient.isSupported(fakeWooting({ usagePage: 0xff53 }).device), false);
  // Wrong product id (not in the catalog) is rejected.
  assert.equal(WootingHidClient.isSupported(fakeWooting({ productId: 0x0001 }).device), false);
});

test("readStatus identifies the board, hides the grid, and shows live data", async () => {
  const { device, sent } = fakeWooting({ reply: 3 });
  const client = new WootingHidClient(device);
  const status = await client.readStatus();

  assert.equal(status.brand, "Wooting");
  assert.equal(status.name, "Wooting 60HE+");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.family, "wooting");
  assert.equal(deviceBrand(client), "Wooting");
  // Two commands went out on the declared feature report id (1) with the
  // multi-report magic word (0xD1): get_version (0x01) then get_device_config (0x13).
  assert.equal(sent.length, 2);
  assert.ok(sent.every((packet) => packet.reportId === 1));
  assert.deepEqual([...sent[0]!.data.slice(0, 3)], [0xd1, 0xda, 0x01]);
  assert.deepEqual([...sent[1]!.data.slice(0, 3)], [0xd1, 0xda, 0x13]);
  // A fully-decoded board reads as a clean two-line card: version + layout, no raw hex.
  assert.deepEqual(status.firmware, ["Firmware: 2.13.0", "Layout: ANSI Split"]);
});

test("readStatus reads a reply delivered as a feature report", async () => {
  const { device } = fakeWooting({ reply: 1, channel: "feature" });
  const status = await new WootingHidClient(device).readStatus();
  assert.ok(status.firmware.includes("Layout: ISO"));
});

test("a header-only config reply shows the raw bytes but no invented layout", async () => {
  // reply 0 lands in the header region only; there is no real payload to decode.
  const { device } = fakeWooting({ reply: 0 });
  const status = await new WootingHidClient(device).readStatus();
  assert.ok(status.firmware.some((line) => line.startsWith("Config reply: d1 da 13")));
  assert.ok(!status.firmware.some((line) => line.startsWith("Layout:")));
});

test("readStatus still connects when the browser refuses the feature write", async () => {
  const { device } = fakeWooting({ reply: "throw" });
  const client = new WootingHidClient(device);
  const status = await client.readStatus();

  assert.equal(status.brand, "Wooting");
  assert.equal(status.name, "Wooting 60HE+");
  assert.equal(status.ui?.settingsReady, false);
  // No live config, so no layout line — but the board is still identified.
  assert.deepEqual(status.firmware, []);
});

test("startAnalog opens the 0xFF53 sibling and streams decoded frames", async () => {
  // A separate HIDDevice for the analog interface, discovered via navigator.hid.
  let analogListener: ((event: HIDInputReportEvent) => void) | null = null;
  let analogOpened = false;
  const analog = {
    vendorId: WOOTING_VENDOR_ID,
    productId: 0x1322,
    productName: "Wooting 60HE+",
    get opened() {
      return analogOpened;
    },
    collections: [{ usagePage: 0xff53, usage: 1, children: [], inputReports: [], outputReports: [], featureReports: [] }],
    open: async () => void (analogOpened = true),
    close: async () => void (analogOpened = false),
    addEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport") analogListener = listener;
    },
    removeEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport" && analogListener === listener) analogListener = null;
    },
  } as unknown as HIDDevice;

  const priorNavigator = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { hid: { getDevices: async () => [analog] } },
    configurable: true,
  });
  try {
    const { device } = fakeWooting();
    const client = new WootingHidClient(device);
    const frames: number[][] = [];
    const stop = await client.startAnalog((keys) => frames.push(keys.map((k) => k.value)));

    assert.equal(analogOpened, true);
    // A live frame: A (0x04) at 180.
    analogListener!({ data: new DataView(new Uint8Array([0x00, 0x04, 0xb4]).buffer) } as HIDInputReportEvent);
    assert.deepEqual(frames, [[180]]);

    stop();
    assert.equal(analogListener, null);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: priorNavigator, configurable: true });
  }
});

test("failing reads are attempted once, not on every refresh", async () => {
  const { device, sent } = fakeWooting({ reply: "throw" });
  const client = new WootingHidClient(device);
  await client.readStatus();
  await client.readStatus();
  await client.readStatus();
  // Only the first readStatus tried the two commands; later refreshes reuse the cache.
  assert.equal(sent.length, 2);
});
