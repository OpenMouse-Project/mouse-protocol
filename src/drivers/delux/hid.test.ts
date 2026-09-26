import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDeluxM800MiniDpiReport,
  DELUX_DPI_MAX,
  DELUX_DPI_REPORT_ID,
  DELUX_M600_PRO_WIRED_PID,
  DELUX_M800_MINI_WIRED_PID,
  DELUX_M800_MINI_WIRELESS_PID,
  DELUX_OEM_VENDOR_ID,
} from "../../delux/index.ts";
import { AttackSharkHidClient } from "../attackshark/hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";
import { DeluxHidClient, resetDeluxDpiState, resetDeluxRuntimeState } from "./hid.ts";

type SentReport = { reportId: number; data: Uint8Array };
type FakeDevice = HIDDevice & {
  sentFeatureReports: SentReport[];
  featureReads: number[];
  emitInputReport(reportId: number, data: Uint8Array): void;
};

function fakeDevice(
  productId: number,
  productName = "Delux M800 Mini",
  collections: Array<{ usagePage: number; usage: number; feature?: number[] }> = [],
): FakeDevice {
  const listeners = new Set<(event: HIDInputReportEvent) => void>();
  const sentFeatureReports: SentReport[] = [];
  const featureReads: number[] = [];
  return {
    vendorId: DELUX_OEM_VENDOR_ID,
    productId,
    productName,
    opened: false,
    collections: collections.map(({ feature = [], ...collection }) => ({
      ...collection,
      type: 0,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: feature.map((reportId) => ({ reportId, items: [] })),
    })),
    async open() {
      (this as FakeDevice).opened = true;
    },
    async close() {
      (this as FakeDevice).opened = false;
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "inputreport" && typeof listener === "function") {
        listeners.add(listener as (event: HIDInputReportEvent) => void);
      }
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "inputreport" && typeof listener === "function") {
        listeners.delete(listener as (event: HIDInputReportEvent) => void);
      }
    },
    async sendFeatureReport(reportId: number, data: BufferSource) {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : new Uint8Array(data.slice(0));
      sentFeatureReports.push({ reportId, data: bytes });
    },
    async receiveFeatureReport(reportId: number) {
      featureReads.push(reportId);
      throw new DOMException("The device did not answer.", "NotAllowedError");
    },
    emitInputReport(reportId: number, data: Uint8Array) {
      const view = new DataView(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      for (const listener of listeners) {
        listener({ reportId, data: view } as HIDInputReportEvent);
      }
    },
    sentFeatureReports,
    featureReads,
  } as unknown as FakeDevice;
}

test("Delux detection requires a branded name for shared 0x1d57 product IDs", () => {
  assert.equal(DeluxHidClient.isSupported(fakeDevice(DELUX_M800_MINI_WIRELESS_PID)), true);
  assert.equal(DeluxHidClient.isSupported(fakeDevice(DELUX_M800_MINI_WIRED_PID)), true);

  const webStatus = fakeDevice(
    DELUX_M800_MINI_WIRELESS_PID,
    "DELUX M800 Mini",
    [{ usagePage: 0x0c, usage: 1 }],
  );
  assert.equal(DeluxHidClient.isSupported(webStatus), true);
  assert.equal(
    DeluxHidClient.isSupported(
      fakeDevice(DELUX_M800_MINI_WIRELESS_PID, "DELUX M800 Mini", [{ usagePage: 0x01, usage: 2 }]),
    ),
    false,
  );

  const sharedReceiver = fakeDevice(DELUX_M800_MINI_WIRELESS_PID, "2.4G Wireless Device");
  assert.equal(DeluxHidClient.isSupported(sharedReceiver), false);
  assert.ok(createSupportedClient(sharedReceiver) instanceof AttackSharkHidClient);
});

test("registry creates a Delux client only for branded M800 Mini hardware", () => {
  const client = createSupportedClient(fakeDevice(DELUX_M800_MINI_WIRELESS_PID));
  assert.ok(client instanceof DeluxHidClient);
  assert.equal(deviceBrand(client), "Delux");
});

test("polling writes the verified 0x1d57 feature report", async () => {
  resetDeluxRuntimeState();
  const device = fakeDevice(DELUX_M800_MINI_WIRELESS_PID);
  const client = new DeluxHidClient(device);

  const initial = await client.readStatus();
  assert.equal(initial.name, "Delux M800 Mini (Wireless)");
  assert.equal(initial.connectionType, "Wireless");
  assert.equal(initial.pollingRateHz, 1000);

  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(device.sentFeatureReports.at(-1), {
    reportId: 0x06,
    data: new Uint8Array([0x09, 0x01, 0x02, 0xfd, 0, 0, 0, 0]),
  });
  assert.equal((await client.readStatus()).pollingRateHz, 500);
  await assert.rejects(client.setPollingRate(8000), /does not support 8000 Hz/);
});

test("DPI writes use the shared X11 codec and clamp to its verified ceiling", async () => {
  resetDeluxDpiState();
  const device = fakeDevice(DELUX_M800_MINI_WIRELESS_PID);
  const client = new DeluxHidClient(device);

  assert.equal(await client.setDpi(26000), DELUX_DPI_MAX);
  const sent = device.sentFeatureReports.at(-1);
  assert.ok(sent);
  assert.equal(sent.reportId, DELUX_DPI_REPORT_ID);
  const fullReport = new Uint8Array(sent.data.length + 1);
  fullReport[0] = sent.reportId;
  fullReport.set(sent.data, 1);
  const decoded = decodeDeluxM800MiniDpiReport(fullReport);
  assert.ok(decoded);
  assert.equal(decoded.stages[decoded.activeStage - 1], DELUX_DPI_MAX);
  assert.equal(client.getDpiOptions().at(-1), DELUX_DPI_MAX);
});

test("wireless battery input updates subsequent status reads", async () => {
  resetDeluxRuntimeState();
  const device = fakeDevice(DELUX_M800_MINI_WIRELESS_PID);
  const client = new DeluxHidClient(device);
  await client.readStatus();

  device.emitInputReport(0x03, new Uint8Array([0x55, 0x40, 0x01, 73]));
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, 73);
  assert.equal(status.batteryState, "Discharging");
});

// Linux hidraw shape of the M600 Pro's interface 2 as WebHID sees it: the
// config channel lives in a 0x0b collection beside system control/consumer.
const M600_PRO_CONFIG_COLLECTIONS = [
  { usagePage: 0x01, usage: 0x80 },
  { usagePage: 0x0c, usage: 0x01 },
  { usagePage: 0x0a, usage: 0x00 },
  { usagePage: 0x0b, usage: 0x00, feature: [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0xa0] },
];

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.split(" ").map((byte) => Number.parseInt(byte, 16)));
}

test("M600 Pro wired is claimed by product id alone on its config channel", () => {
  const generic = "USB Gaming Mouse";
  assert.equal(DeluxHidClient.isSupported(fakeDevice(DELUX_M600_PRO_WIRED_PID, generic)), true);
  assert.equal(
    DeluxHidClient.isSupported(fakeDevice(DELUX_M600_PRO_WIRED_PID, generic, M600_PRO_CONFIG_COLLECTIONS)),
    true,
  );
  // Boot keyboard/mouse entries of the same unit carry no config channel.
  assert.equal(
    DeluxHidClient.isSupported(fakeDevice(DELUX_M600_PRO_WIRED_PID, generic, [{ usagePage: 0x01, usage: 2 }])),
    false,
  );

  const client = createSupportedClient(
    fakeDevice(DELUX_M600_PRO_WIRED_PID, generic, M600_PRO_CONFIG_COLLECTIONS),
  );
  assert.ok(client instanceof DeluxHidClient);
  assert.equal(deviceBrand(client), "Delux");
  assert.equal(
    AttackSharkHidClient.isSupported(fakeDevice(DELUX_M600_PRO_WIRED_PID, generic, M600_PRO_CONFIG_COLLECTIONS)),
    false,
  );
});

test("M600 Pro wired status is configurable over WebHID and never reads back", async () => {
  resetDeluxDpiState();
  resetDeluxRuntimeState();
  const device = fakeDevice(DELUX_M600_PRO_WIRED_PID, "USB Gaming Mouse", M600_PRO_CONFIG_COLLECTIONS);
  const status = await new DeluxHidClient(device).readStatus();

  assert.equal(status.name, "Delux M600 Pro (Wired)");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.statusNote, undefined);
  assert.equal(status.ui?.forceShowBattery, false);
  // Every GET_FEATURE times out on this firmware (about 5 s each over USB).
  assert.deepEqual(device.featureReads, []);
});

test("M600 Pro wired writes match the packets verified on hardware", async () => {
  resetDeluxDpiState();
  resetDeluxRuntimeState();
  const device = fakeDevice(DELUX_M600_PRO_WIRED_PID, "USB Gaming Mouse", M600_PRO_CONFIG_COLLECTIONS);
  const client = new DeluxHidClient(device);

  // Measured 126 Hz after this write (docs/delux-m600-pro-testing.md).
  assert.equal(await client.setPollingRate(125), 125);
  assert.deepEqual(device.sentFeatureReports.at(-1), {
    reportId: 0x06,
    data: hexBytes("09 01 08 f7 00 00 00 00"),
  });

  await client.setRippleControl(false);
  for (let stage = 0; stage < 6; stage++) await client.setDpiStageValue(stage, 400);
  await client.setActiveDpiStage(0);
  // The 52-byte report (51 on the wire after the id) measured at 400 DPI.
  assert.deepEqual(device.sentFeatureReports.at(-1), {
    reportId: DELUX_DPI_REPORT_ID,
    data: hexBytes(
      "38 01 00 00 3f 00 00 09 09 09 09 09 09 00 00 00 00 00 00 00 00 00 00 01 ff 00 00 00 ff 00 00 00 "
      + "ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 0d ab",
    ),
  });
});
