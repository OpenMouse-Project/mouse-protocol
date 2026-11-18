import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTANT_REPORT_ID,
  INSTANT_USAGE,
  INSTANT_USAGE_PAGE,
  INSTANT_VENDOR_ID,
} from "@openmouse/protocol/instant";
import { InstantA825HidClient } from "./a825-hid.ts";

function report(reportId: number): HIDReportInfo {
  return { reportId, items: [] } as unknown as HIDReportInfo;
}

function controlCollection(): HIDCollectionInfo {
  return {
    usagePage: INSTANT_USAGE_PAGE,
    usage: INSTANT_USAGE,
    type: 1,
    children: [],
    featureReports: [report(INSTANT_REPORT_ID)],
    inputReports: [],
    outputReports: [],
  } as unknown as HIDCollectionInfo;
}

const STATUS = Uint8Array.of(
  0x07, 0x00, 0x54, 0x09, 0x27, 0x00, 0x03, 0xcb, 0x11, 0x02, 0x00, 0x26,
  0x06, 0x00, 0x00, 0x10, 0x24, 0x5a, 0xa5, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
);

function fakeDevice(options: {
  rate?: number;
  productId?: number;
} = {}) {
  let rate = options.rate ?? 0x0b;
  let statusRead = false;
  let readSetup = false;
  const sent: Uint8Array[] = [];
  let pendingWrite: { address: number; data: number[] } | null = null;
  let writeFinished = false;

  const device = {
    vendorId: INSTANT_VENDOR_ID,
    productId: options.productId ?? 0x1440,
    productName: "USB GAMING MOUSE",
    opened: false,
    collections: [controlCollection()],
    async open() {
      this.opened = true;
    },
    async close() {
      this.opened = false;
    },
    async sendFeatureReport(_reportId: number, data: BufferSource) {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const frame = Uint8Array.of(INSTANT_REPORT_ID, ...view);
      sent.push(frame);
      const address = frame[4]! | (frame[5]! << 8);
      if (frame[1] === 0x18 && frame[2] === 0x03) {
        readSetup = true;
        if (frame[7] === 0) {
          pendingWrite = { address, data: [frame[6]!] };
        } else if (pendingWrite?.address === address) {
          pendingWrite.data[frame[3]!] = frame[6]!;
        }
      }
      if (frame[1] === 0x18 && frame[2] === 0x09) {
        writeFinished = true;
      }
      if (frame[1] === 0x18 && frame[2] === 0x00 && writeFinished) {
        if (pendingWrite?.address === 0x3a) rate = pendingWrite.data[0]!;
        pendingWrite = null;
        writeFinished = false;
      }
    },
    async receiveFeatureReport(_reportId: number) {
      if (readSetup) {
        readSetup = false;
        return new DataView(Uint8Array.of(INSTANT_REPORT_ID, rate, 0, 0, 0, 0, 0, 0).buffer);
      }
      statusRead = true;
      return new DataView(STATUS.slice().buffer);
    },
  } as unknown as HIDDevice;

  return { device, sent, get rate() { return rate; } };
}

test("A825 identifies the Sades Kaze control collection", () => {
  const { device } = fakeDevice();
  assert.equal(InstantA825HidClient.isSupported(device), true);
  assert.equal(
    InstantA825HidClient.isSupported({ ...device, productId: 0x1234 } as HIDDevice),
    false,
  );
  assert.equal(InstantA825HidClient.isSupported({ ...device, vendorId: 0x1234 } as HIDDevice), false);
});

test("readStatus decodes firmware and stays read-only", async () => {
  const { device } = fakeDevice({ rate: 0x0b });
  const client = new InstantA825HidClient(device);
  const status = await client.readStatus();
  assert.equal(status.brand, "Sades");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.supportedPollingRates?.join(","), "125,250,500,1000");
  assert.equal(status.activeProfile, null);
  assert.equal(status.dpi, 0);
  assert.deepEqual(status.firmware, ["Build 0x0954"]);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.family, "sades-a825");
});
