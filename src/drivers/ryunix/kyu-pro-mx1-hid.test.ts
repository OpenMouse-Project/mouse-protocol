import assert from "node:assert/strict";
import test from "node:test";

import {
  RYUNIX_CONFIG_REPORT_ID,
  RYUNIX_TELEMETRY_REPORT_ID,
  RYUNIX_USAGE,
  RYUNIX_USAGE_PAGE,
  RYUNIX_VENDOR_ID,
  RYUNIX_WIRED_PRODUCT_ID,
  RYUNIX_WIRELESS_PRODUCT_ID,
} from "@openmouse/protocol/ryunix";
import { KyuProMx1Client } from "./kyu-pro-mx1-hid.ts";

function report(reportId: number): HIDReportInfo {
  return { reportId, items: [] } as unknown as HIDReportInfo;
}

function controlCollection(): HIDCollectionInfo {
  return {
    usagePage: RYUNIX_USAGE_PAGE,
    usage: RYUNIX_USAGE,
    type: 1,
    children: [],
    featureReports: [report(RYUNIX_CONFIG_REPORT_ID)],
    inputReports: [report(RYUNIX_TELEMETRY_REPORT_ID)],
    outputReports: [],
  } as unknown as HIDCollectionInfo;
}

function fakeDevice(overrides: Partial<HIDDevice> = {}): {
  device: HIDDevice;
  emit(reportId: number, body: Uint8Array): void;
  listenerAttached(): boolean;
} {
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: RYUNIX_VENDOR_ID,
    productId: RYUNIX_WIRELESS_PRODUCT_ID,
    productName: "Ryunix Kyu Pro MX1",
    opened: false,
    collections: [controlCollection()],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener(_type: string, value: (event: HIDInputReportEvent) => void) { listener = value; },
    removeEventListener(_type: string, value: (event: HIDInputReportEvent) => void) {
      if (listener === value) listener = null;
    },
    ...overrides,
  } as unknown as HIDDevice;

  return {
    device,
    emit(reportId, body) {
      const framed = Uint8Array.of(0xaa, 0xbb, ...body, 0xcc);
      listener?.({
        device,
        reportId,
        data: new DataView(framed.buffer, 2, body.length),
      } as HIDInputReportEvent);
    },
    listenerAttached: () => listener !== null,
  };
}

test("Kyu Pro MX1 support requires the exact product and configuration collection", () => {
  assert.equal(KyuProMx1Client.isSupported(fakeDevice().device), true);
  assert.equal(KyuProMx1Client.isSupported(fakeDevice({ productId: RYUNIX_WIRED_PRODUCT_ID }).device), true);
  assert.equal(KyuProMx1Client.isSupported(fakeDevice({ productId: 0x1234 }).device), false);
  assert.equal(KyuProMx1Client.isSupported(fakeDevice({
    collections: [{
      ...controlCollection(),
      usagePage: 0x01,
      usage: 0x02,
    } as HIDCollectionInfo],
  }).device), false);
});

test("Kyu Pro MX1 exposes observed telemetry without advertising writes", async () => {
  const transport = fakeDevice();
  const client = new KyuProMx1Client(transport.device);
  await client.open();

  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, Uint8Array.of(1, 2, 0x02, 73, 0, 0x03));
  const status = await client.readStatus();

  assert.equal(status.brand, "Ryunix");
  assert.equal(status.batteryPercent, 73);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.pollingRateHz, 500);
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.lighting?.mode, "Static");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.pollingReadOnly, true);
  assert.match(status.ui?.statusNote ?? "", /active/);
  assert.equal("setDpi" in client, false);
  assert.equal("setPollingRate" in client, false);
});

test("Kyu Pro MX1 ignores malformed telemetry and detaches on close", async () => {
  const transport = fakeDevice();
  const client = new KyuProMx1Client(transport.device);
  await client.open();
  assert.equal(transport.listenerAttached(), true);

  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, Uint8Array.of(1, 1, 0x04, 64, 1, 0x01));
  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, Uint8Array.of(1, 1, 0xff, 64, 1, 0x01));
  assert.equal((await client.readStatus()).pollingRateHz, 250);

  await client.close();
  assert.equal(transport.listenerAttached(), false);
});
