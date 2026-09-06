import assert from "node:assert/strict";
import test from "node:test";

import { CORSAIR_NIGHTSWORD_PRODUCT_ID, CORSAIR_VENDOR_ID } from "../../corsair/index.ts";
import { CorsairHidClient, corsairTransferError } from "./hid.ts";

function packet(hex: string): Uint8Array {
  const bytes = hex.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16));
  const out = new Uint8Array(64);
  out.set(bytes);
  return out;
}

function key(bytes: Uint8Array): string {
  return [...bytes.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

// Canned GET replies from captures/corsair-nightsword/PROTOCOL.md, keyed by
// the request's first four bytes. The iCUE-loaded live profile.
const REPLIES: ReadonlyMap<string, Uint8Array> = new Map([
  ["0e 01 00 00", packet("0e 01 00 00 01 01 00 01 41 03 08 03 1c 1b 5c 1b 01")],
  ["0e 13 05 00", packet("0e 13 05 00 0f")],
  ["0e 13 02 00", packet("0e 13 02 00 02 09 60 09 60")],
  ["0e 13 03 00", packet("0e 13 03 00 05")],
  ["0e 13 04 00", packet("0e 13 04 00 00")],
  ["0e 13 d0 00", packet("0e 13 d0 00 00 01 90 01 90 ff ff 00")],
  ["0e 13 d1 00", packet("0e 13 d1 00 00 03 20 03 20 00 bf ff")],
  ["0e 13 d2 00", packet("0e 13 d2 00 00 09 60 09 60 00 bf ff")],
  ["0e 13 d3 00", packet("0e 13 d3 00 00 16 44 16 44 00 bf ff")],
  ["0e 13 d4 00", packet("0e 13 d4 00")],
  ["0e 13 d5 00", packet("0e 13 d5 00")],
]);

interface FakeOptions {
  collections?: HIDCollectionInfo[];
  /** Replace the reply for a request key; `null` makes the device stay silent (stale buffer). */
  overrides?: Map<string, Uint8Array | null>;
  /** Throw this from every transfer. */
  transferError?: Error;
  /** Return the previous buffer this many times before the fresh reply. */
  staleReads?: number;
}

function collection(usage: number, feature: boolean): HIDCollectionInfo {
  return {
    usagePage: 0xffc2,
    usage,
    type: 1,
    children: [],
    inputReports: feature ? [{ reportId: 0, items: [] }] : [{ reportId: 14, items: [] }],
    outputReports: feature ? [{ reportId: 0, items: [] }] : [],
    featureReports: feature ? [{ reportId: 0, items: [] }] : [],
  } as unknown as HIDCollectionInfo;
}

function fakeDevice(options: FakeOptions = {}) {
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  const received: number[] = [];
  let buffer = new Uint8Array(64);
  let staleLeft = 0;
  let lastKey = "";
  let opened = false;
  const device = {
    vendorId: CORSAIR_VENDOR_ID,
    productId: CORSAIR_NIGHTSWORD_PRODUCT_ID,
    productName: "CORSAIR NIGHTSWORD RGB Gaming Mouse",
    get opened() { return opened; },
    collections: options.collections ?? [collection(4, true)],
    open: async () => { opened = true; },
    close: async () => { opened = false; },
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      if (options.transferError) throw options.transferError;
      const view = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      const payload = new Uint8Array(view);
      sent.push({ reportId, payload });
      const requestKey = key(payload);
      const override = options.overrides?.get(requestKey);
      const reply = override === undefined ? REPLIES.get(requestKey) : override;
      // A fresh request answers stale first; a retry of the same request answers fresh.
      staleLeft = requestKey === lastKey ? staleLeft : (options.staleReads ?? 0);
      lastKey = requestKey;
      // A GET refreshes the feature buffer; a SET or an unknown request leaves it stale.
      if (reply && payload[0] === 0x0e) buffer = reply;
    },
    receiveFeatureReport: async (reportId: number) => {
      if (options.transferError) throw options.transferError;
      received.push(reportId);
      if (staleLeft > 0) {
        staleLeft -= 1;
        return new DataView(new Uint8Array(64).buffer);
      }
      return new DataView(new Uint8Array(buffer).buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent, received };
}

test("claims only the usage-4 config collection with a feature report on id 0", () => {
  assert.equal(CorsairHidClient.isSupported(fakeDevice().device), true);
  // MI_00's 0xffc2 collection (usage 3, input report 14 only) must be rejected.
  assert.equal(CorsairHidClient.isSupported(fakeDevice({ collections: [collection(3, false)] }).device), false);
  assert.equal(CorsairHidClient.isSupported(fakeDevice({ collections: [collection(4, false)] }).device), false);
  assert.equal(CorsairHidClient.isSupported(fakeDevice({ collections: [] }).device), false);
  assert.equal(CorsairHidClient.isSupported({ ...fakeDevice().device, productId: 0x1b3c } as HIDDevice), false);
  assert.equal(CorsairHidClient.isSupported({ ...fakeDevice().device, vendorId: 0x1532 } as HIDDevice), false);
  // Nested collections still count.
  const nested = { ...collection(1, false), usagePage: 0x01, children: [collection(4, true)] } as HIDCollectionInfo;
  assert.equal(CorsairHidClient.isSupported(fakeDevice({ collections: [nested] }).device), true);
});

test("reads identity, mask, current stage, each enabled stage, lift, and snap in order", async () => {
  const { device, sent, received } = fakeDevice();
  const status = await new CorsairHidClient(device).readStatus();

  assert.deepEqual(sent.map(({ payload }) => key(payload)), [
    "0e 01 00 00",
    "0e 13 05 00",
    "0e 13 02 00",
    "0e 13 d0 00",
    "0e 13 d1 00",
    "0e 13 d2 00",
    "0e 13 d3 00",
    "0e 13 03 00",
    "0e 13 04 00",
  ]);
  assert.ok(sent.every(({ reportId, payload }) => reportId === 0 && payload.length === 64));
  assert.ok(received.every((reportId) => reportId === 0));
  assert.equal(received.length, sent.length);
  // Only the live profile is ever addressed.
  assert.ok(sent.every(({ payload }) => payload[3] === 0));

  assert.equal(status.brand, "Corsair");
  assert.equal(status.name, "NIGHTSWORD RGB");
  assert.equal(status.dpi, 2400);
  assert.equal(status.dpiY, 2400);
  assert.equal(status.pollingRateHz, 1000);
  // Slot 0 is the Sniper stage; iCUE's Stage 1–3 are slots 1–3, and the
  // device's "current stage 2" is iCUE's Stage 2.
  assert.deepEqual(status.dpiStages, [800, 2400, 5700]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.firmware, [
    "Firmware 3.41",
    "Bootloader 3.08",
    "Sniper 400 #ffff00",
    "DPI stages 1: 800 #00bfff, 2: 2400 #00bfff, 3: 5700 #00bfff",
    "Lift-off height 5",
  ]);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.ui?.pollingReadOnly, true);
  assert.equal(status.ui?.defaultDisplayName, "Corsair NIGHTSWORD RGB");
});

test("exposes no setters and no DPI options", async () => {
  const client = new CorsairHidClient(fakeDevice().device);
  assert.deepEqual(client.getDpiOptions(), []);
  assert.equal(await client.startNotifications(), false);
  for (const name of ["setDpi", "setPollingRate", "setLiftOffDistance", "setAngleSnapping", "setDpiStages"]) {
    assert.equal(name in client, false, `${name} must not exist on the read-only client`);
  }
});

test("retries when the feature buffer is still the previous reply", async () => {
  const { device, sent } = fakeDevice({ staleReads: 1 });
  const status = await new CorsairHidClient(device).readStatus();
  assert.equal(status.dpi, 2400);
  // Every request went out twice: once answered stale, once answered fresh.
  assert.equal(sent.length, 18);
});

test("degrades to identity only when the DPI reads fail", async () => {
  const { device, sent } = fakeDevice({ overrides: new Map([["0e 13 02 00", null]]) });
  const status = await new CorsairHidClient(device).readStatus();
  assert.equal(status.name, "NIGHTSWORD RGB");
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.dpi, 0);
  assert.deepEqual(status.dpiStages, []);
  assert.equal(status.activeDpiStage, undefined);
  assert.equal(status.angleSnapping, null);
  assert.deepEqual(status.firmware, ["Firmware 3.41", "Bootloader 3.08"]);
  assert.equal(status.ui?.valuesVerified, false);
  assert.match(status.ui?.statusNote ?? "", /could not be read/);
  // Lift and snap are skipped once the DPI block fails, after the retries on the stage read.
  assert.ok(!sent.some(({ payload }) => key(payload) === "0e 13 03 00"));
});

test("a silent identity read fails loudly", async () => {
  const { device } = fakeDevice({ overrides: new Map([["0e 01 00 00", null]]) });
  await assert.rejects(new CorsairHidClient(device).readStatus(), /did not answer command 0x01\/0x00/);
});

test("maps NotAllowedError to the wrong-interface / close-iCUE guidance", async () => {
  const held = new Error("Failed to write the feature report.");
  held.name = "NotAllowedError";
  const { device } = fakeDevice({ transferError: held });
  await assert.rejects(new CorsairHidClient(device).readStatus(), /usage 4/);
  assert.match(corsairTransferError(held).message, /close iCUE/);
  assert.match(corsairTransferError(held).message, /Corsair Service/);
  // Other errors pass through untouched.
  const other = new Error("The device is not open.");
  assert.equal(corsairTransferError(other), other);
});

test("serialises overlapping status reads through one queue", async () => {
  const { device, sent } = fakeDevice();
  const client = new CorsairHidClient(device);
  const [first, second] = await Promise.all([client.readStatus(), client.readStatus()]);
  assert.equal(first.dpi, 2400);
  assert.equal(second.dpi, 2400);
  // Two complete, non-interleaved sequences.
  const keys = sent.map(({ payload }) => key(payload));
  assert.deepEqual(keys.slice(0, 9), keys.slice(9));
});
