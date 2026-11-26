import test from "node:test";
import assert from "node:assert/strict";
import { AjazzAk820HidClient } from "./ak820-hid.ts";
import { AJAZZ_AK820_VENDOR_ID, AJAZZ_AK820_WIRED_PID } from "../../ajazz/ak820.ts";

// ── minimal HID stubs ──────────────────────────────────────────────────────

function report(reportId: number, byteLength = 16): HIDReportInfo {
  return {
    reportId,
    items: [{ reportSize: 8, reportCount: byteLength }],
  } as unknown as HIDReportInfo;
}

function collection(
  usagePage: number,
  usage: number,
  options: { feature?: number[] } = {},
): HIDCollectionInfo {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    featureReports: (options.feature ?? []).map((id) => report(id)),
    inputReports: [],
    outputReports: [],
  } as unknown as HIDCollectionInfo;
}

function makeDevice(overrides: Partial<HIDDevice> = {}): HIDDevice {
  return {
    vendorId: AJAZZ_AK820_VENDOR_ID,
    productId: AJAZZ_AK820_WIRED_PID,
    productName: "Ajazz AK820",
    collections: [collection(0xff00, 1, { feature: [0] })],
    opened: false,
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async () => {},
    receiveFeatureReport: async () => new DataView(new ArrayBuffer(64)),
    ...overrides,
  } as unknown as HIDDevice;
}

// ── isSupported ─────────────────────────────────────────────────────────────

test("isSupported: accepts AK820 with 0xff00 vendor collection", () => {
  const device = makeDevice();
  assert.ok(AjazzAk820HidClient.isSupported(device));
});

test("isSupported: accepts AK820 with 0xff60 vendor collection", () => {
  const device = makeDevice({
    collections: [collection(0xff60, 1, { feature: [0] })],
  });
  assert.ok(AjazzAk820HidClient.isSupported(device));
});

test("isSupported: rejects wrong vendor id", () => {
  const device = makeDevice({ vendorId: 0x046d });
  assert.equal(AjazzAk820HidClient.isSupported(device), false);
});

test("isSupported: rejects unknown product id on correct VID", () => {
  const device = makeDevice({ productId: 0x1234 });
  assert.equal(AjazzAk820HidClient.isSupported(device), false);
});

test("isSupported: rejects device with no vendor-specific collection", () => {
  const device = makeDevice({
    collections: [collection(0x0001, 2)], // Generic Desktop Mouse — not vendor
  });
  assert.equal(AjazzAk820HidClient.isSupported(device), false);
});

test("isSupported: accepts vendor collection nested inside a parent", () => {
  const parent = {
    ...collection(0x0001, 6),
    children: [collection(0xff00, 1, { feature: [0] })],
  } as unknown as HIDCollectionInfo;
  const device = makeDevice({ collections: [parent] });
  assert.ok(AjazzAk820HidClient.isSupported(device));
});

// ── readStatus ──────────────────────────────────────────────────────────────

test("readStatus: returns correct brand and name", async () => {
  const device = makeDevice();
  const client = new AjazzAk820HidClient(device);
  const status = await client.readStatus();
  assert.equal(status.brand, "AJAZZ");
  assert.equal(status.name, "Ajazz AK820 (Wired)");
});

test("readStatus: sets settingsReady false (phase 1 — no protocol yet)", async () => {
  const device = makeDevice();
  const client = new AjazzAk820HidClient(device);
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, false);
});

test("readStatus: connectionType is Wired", async () => {
  const device = makeDevice();
  const client = new AjazzAk820HidClient(device);
  const status = await client.readStatus();
  assert.equal(status.connectionType, "Wired");
});

// ── getDpiOptions ────────────────────────────────────────────────────────────

test("getDpiOptions: returns empty array (keyboard, no mouse DPI)", () => {
  const device = makeDevice();
  const client = new AjazzAk820HidClient(device);
  assert.deepEqual(client.getDpiOptions(), []);
});
