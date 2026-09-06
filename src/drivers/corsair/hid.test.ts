import assert from "node:assert/strict";
import test from "node:test";

import { CORSAIR_NIGHTSWORD_PRODUCT_ID, CORSAIR_VENDOR_ID } from "../../corsair/index.ts";
import { CorsairHidClient, corsairTransferError } from "./hid.ts";

function key(bytes: Uint8Array): string {
  return [...bytes.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function packet(...bytes: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(bytes);
  return out;
}

interface Slot { x: number; y: number; rgb: [number, number, number] }

/**
 * A NIGHTSWORD RGB on fw 3.41 holding the iCUE-loaded live profile from
 * captures/corsair-nightsword: Sniper 400 in slot 0, 800 / 2400 / 5700 in
 * slots 1–3, slot 2 selected, lift 5, snap off. GETs answer from this state
 * (big-endian DPI); SETs mutate it (little-endian DPI) and leave the feature
 * buffer untouched, exactly like the hardware.
 */
function initialState() {
  return {
    mask: 0x0f,
    current: 2,
    slots: [
      { x: 400, y: 400, rgb: [0xff, 0xff, 0x00] },
      { x: 800, y: 800, rgb: [0x00, 0xbf, 0xff] },
      { x: 2400, y: 2400, rgb: [0x00, 0xbf, 0xff] },
      { x: 5700, y: 5700, rgb: [0x00, 0xbf, 0xff] },
      { x: 0, y: 0, rgb: [0, 0, 0] },
      { x: 0, y: 0, rgb: [0, 0, 0] },
    ] as Slot[],
    lift: 5,
    snap: 0,
  };
}

interface FakeOptions {
  collections?: HIDCollectionInfo[];
  /** Requests (by first four bytes) the device stays silent on, leaving the stale buffer. */
  silent?: string[];
  /** Throw this from every transfer. */
  transferError?: Error;
  /** Return the previous buffer this many times before the fresh reply. */
  staleReads?: number;
  /** Drop every SET on the floor, as if the write did not take. */
  ignoreWrites?: boolean;
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
  const state = initialState();
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  const received: number[] = [];
  let buffer = new Uint8Array(64);
  let staleLeft = 0;
  let lastKey = "";
  let opened = false;

  const be = (value: number) => [value >> 8, value & 0xff];
  const reply = (request: Uint8Array): Uint8Array | null => {
    const [, field, sub] = request;
    if (field === 0x01) return packet(0x0e, 0x01, 0x00, 0x00, 1, 1, 0, 1, 0x41, 0x03, 0x08, 0x03, 0x1c, 0x1b, 0x5c, 0x1b, 1);
    if (field !== 0x13) return null;
    if (sub === 0x05) return packet(0x0e, 0x13, 0x05, 0x00, state.mask);
    if (sub === 0x03) return packet(0x0e, 0x13, 0x03, 0x00, state.lift);
    if (sub === 0x04) return packet(0x0e, 0x13, 0x04, 0x00, state.snap);
    if (sub === 0x02) {
      const slot = state.slots[state.current]!;
      return packet(0x0e, 0x13, 0x02, 0x00, state.current, ...be(slot.x), ...be(slot.y));
    }
    if ((sub! & 0xf0) === 0xd0) {
      const slot = state.slots[sub! & 0x0f]!;
      return packet(0x0e, 0x13, sub!, 0x00, slot.x !== slot.y ? 1 : 0, ...be(slot.x), ...be(slot.y), ...slot.rgb);
    }
    return null;
  };
  const apply = (request: Uint8Array): void => {
    if (options.ignoreWrites) return;
    const [, field, sub] = request;
    if (field !== 0x13) return;
    if (sub === 0x02) state.current = request[4]!;
    else if (sub === 0x05) state.mask = request[4]!;
    else if (sub === 0x03) state.lift = request[4]!;
    else if (sub === 0x04) state.snap = request[4]!;
    else if ((sub! & 0xf0) === 0xd0) {
      state.slots[sub! & 0x0f] = {
        x: request[5]! | (request[6]! << 8),
        y: request[7]! | (request[8]! << 8),
        rgb: [request[9]!, request[10]!, request[11]!],
      };
    }
  };

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
      // A fresh request answers stale first; a retry of the same request answers fresh.
      staleLeft = requestKey === lastKey ? staleLeft : (options.staleReads ?? 0);
      lastKey = requestKey;
      if (payload[0] === 0x07) { apply(payload); return; }
      if (options.silent?.includes(requestKey)) return;
      const answer = reply(payload);
      if (answer) buffer = answer;
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
  return { device: device as unknown as HIDDevice, sent, received, state };
}

const sets = (sent: Array<{ payload: Uint8Array }>) =>
  sent.filter(({ payload }) => payload[0] === 0x07).map(({ payload }) => [...payload.subarray(0, 12)]);

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
  assert.deepEqual(status.dpiStageColors, ["#00bfff", "#00bfff", "#00bfff"]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.liftOffDistance, "High");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.firmware, [
    "Firmware 3.41",
    "Bootloader 3.08",
    "Sniper 400 #ffff00",
    "DPI stages 1: 800 #00bfff, 2: 2400 #00bfff, 3: 5700 #00bfff",
    "Lift-off height 5",
  ]);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.ui?.pollingReadOnly, true);
  assert.deepEqual(status.ui?.dpiStageEditor, { maxStages: 5, countEditable: true, minDpi: 100, maxDpi: 18_000, stepDpi: 50 });
  assert.equal(status.ui?.defaultDisplayName, "Corsair NIGHTSWORD RGB");
});

test("offers 50-DPI steps from 100 to 18,000 and no polling-rate setter", async () => {
  const client = new CorsairHidClient(fakeDevice().device);
  const options = client.getDpiOptions();
  assert.equal(options[0], 100);
  assert.equal(options.at(-1), 18_000);
  assert.equal(options.length, 359);
  assert.ok([400, 800, 2400, 5700, 16_000].every((dpi) => options.includes(dpi)));
  assert.equal(await client.startNotifications(), false);
  assert.equal("setPollingRate" in client, false, "polling-rate writes re-enumerate the device and are not offered yet");
});

test("retries when the feature buffer is still the previous reply", async () => {
  const { device, sent } = fakeDevice({ staleReads: 1 });
  const status = await new CorsairHidClient(device).readStatus();
  assert.equal(status.dpi, 2400);
  // Every request went out twice: once answered stale, once answered fresh.
  assert.equal(sent.length, 18);
});

test("degrades to identity only when the DPI reads fail", async () => {
  const { device, sent } = fakeDevice({ silent: ["0e 13 02 00"] });
  const status = await new CorsairHidClient(device).readStatus();
  assert.equal(status.name, "NIGHTSWORD RGB");
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.dpi, 0);
  assert.deepEqual(status.dpiStages, []);
  assert.equal(status.activeDpiStage, undefined);
  assert.equal(status.angleSnapping, null);
  assert.equal(status.liftOffDistance, null);
  assert.deepEqual(status.firmware, ["Firmware 3.41", "Bootloader 3.08"]);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.ui?.dpiStageEditor, undefined);
  assert.match(status.ui?.statusNote ?? "", /could not be read/);
  // Lift and snap are skipped once the DPI block fails, after the retries on the stage read.
  assert.ok(!sent.some(({ payload }) => key(payload) === "0e 13 03 00"));
});

test("a silent identity read fails loudly", async () => {
  const { device } = fakeDevice({ silent: ["0e 01 00 00"] });
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

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

test("setDpi rewrites the selected slot little-endian and carries its colour back", async () => {
  const { device, sent, state } = fakeDevice();
  assert.equal(await new CorsairHidClient(device).setDpi(1600), 1600);
  // Slot 2 was selected: read it for RGB, write, read back. DPI LE, colour preserved.
  assert.deepEqual(sets(sent), [[0x07, 0x13, 0xd2, 0x00, 0x00, 0x40, 0x06, 0x40, 0x06, 0x00, 0xbf, 0xff]]);
  assert.deepEqual(state.slots[2], { x: 1600, y: 1600, rgb: [0x00, 0xbf, 0xff] });
  // Sniper slot untouched.
  assert.deepEqual(state.slots[0], { x: 400, y: 400, rgb: [0xff, 0xff, 0x00] });
});

test("setDpi with separate axes sets the independent flag", async () => {
  const { device, sent } = fakeDevice();
  await new CorsairHidClient(device).setDpi(1600, 800);
  assert.deepEqual(sets(sent)[0], [0x07, 0x13, 0xd2, 0x00, 0x01, 0x40, 0x06, 0x20, 0x03, 0x00, 0xbf, 0xff]);
});

test("setDpi rejects values outside 100–18,000 without touching the device", async () => {
  const { device, sent } = fakeDevice();
  const client = new CorsairHidClient(device);
  await assert.rejects(client.setDpi(50), /100–18,000/);
  await assert.rejects(client.setDpi(18_001), /100–18,000/);
  await assert.rejects(client.setDpi(1600.5), /100–18,000/);
  assert.equal(sent.length, 0);
});

test("setDpi fails when the read-back disagrees", async () => {
  const { device } = fakeDevice({ ignoreWrites: true });
  await assert.rejects(new CorsairHidClient(device).setDpi(1600), /kept 2,400 DPI on stage 2/);
});

test("setDpiStageValue addresses numbered stages, skipping the Sniper slot", async () => {
  const { device, sent, state } = fakeDevice();
  const client = new CorsairHidClient(device);
  // Stage index 0 = slot 1 (iCUE Stage 1).
  assert.equal(await client.setDpiStageValue(0, 1000), 1000);
  assert.deepEqual(sets(sent).at(-1), [0x07, 0x13, 0xd1, 0x00, 0x00, 0xe8, 0x03, 0xe8, 0x03, 0x00, 0xbf, 0xff]);
  assert.deepEqual(state.slots[1], { x: 1000, y: 1000, rgb: [0x00, 0xbf, 0xff] });
  assert.deepEqual(state.slots[0], { x: 400, y: 400, rgb: [0xff, 0xff, 0x00] });
  await assert.rejects(client.setDpiStageValue(3, 1000), /does not have a DPI stage 4/);
});

test("setDpiStageValue keeps an existing separate Y axis", async () => {
  const { device, state } = fakeDevice();
  state.slots[3] = { x: 5700, y: 2000, rgb: [1, 2, 3] };
  await new CorsairHidClient(device).setDpiStageValue(2, 6000);
  assert.deepEqual(state.slots[3], { x: 6000, y: 2000, rgb: [1, 2, 3] });
});

test("setDpiStageColor rewrites the slot with its current DPI and the new colour", async () => {
  const { device, sent, state } = fakeDevice();
  assert.equal(await new CorsairHidClient(device).setDpiStageColor(1, "#FF8000"), "#ff8000");
  assert.deepEqual(sets(sent), [[0x07, 0x13, 0xd2, 0x00, 0x00, 0x60, 0x09, 0x60, 0x09, 0xff, 0x80, 0x00]]);
  assert.deepEqual(state.slots[2], { x: 2400, y: 2400, rgb: [0xff, 0x80, 0x00] });
  await assert.rejects(new CorsairHidClient(device).setDpiStageColor(1, "red"), /#rrggbb/);
});

test("setActiveDpiStage selects the numbered slot and confirms", async () => {
  const { device, sent, state } = fakeDevice();
  const client = new CorsairHidClient(device);
  assert.equal(await client.setActiveDpiStage(0), 0);
  assert.deepEqual(sets(sent), [[0x07, 0x13, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0]]);
  assert.equal(state.current, 1);
  assert.equal(await client.setActiveDpiStage(2), 2);
  assert.equal(state.current, 3);
  await assert.rejects(client.setActiveDpiStage(3), /does not have a DPI stage 4/);
  const stuck = fakeDevice({ ignoreWrites: true });
  await assert.rejects(new CorsairHidClient(stuck.device).setActiveDpiStage(0), /stayed on DPI slot 2/);
});

test("setDpiStageCount grows by seeding empty slots and keeps the Sniper bit", async () => {
  const { device, sent, state } = fakeDevice();
  assert.equal(await new CorsairHidClient(device).setDpiStageCount(5), 5);
  const writes = sets(sent);
  // Slots 4 and 5 were empty: seeded from slot 3 (5700, cyan) before the mask write.
  assert.deepEqual(writes[0], [0x07, 0x13, 0xd4, 0x00, 0x00, 0x44, 0x16, 0x44, 0x16, 0x00, 0xbf, 0xff]);
  assert.deepEqual(writes[1], [0x07, 0x13, 0xd5, 0x00, 0x00, 0x44, 0x16, 0x44, 0x16, 0x00, 0xbf, 0xff]);
  assert.deepEqual(writes[2], [0x07, 0x13, 0x05, 0x00, 0x3f, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(state.mask, 0x3f);
  assert.deepEqual(state.slots[5], { x: 5700, y: 5700, rgb: [0x00, 0xbf, 0xff] });
});

test("setDpiStageCount shrinks, moving the selection inside the enabled range", async () => {
  const { device, sent, state } = fakeDevice();
  state.current = 3;
  assert.equal(await new CorsairHidClient(device).setDpiStageCount(1), 1);
  const writes = sets(sent);
  assert.deepEqual(writes[0], [0x07, 0x13, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(writes[1], [0x07, 0x13, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(state.mask, 0x03);
  assert.equal(state.current, 1);
  // Slot contents are not erased; re-enabling later restores them.
  assert.deepEqual(state.slots[3], { x: 5700, y: 5700, rgb: [0x00, 0xbf, 0xff] });
});

test("setDpiStageCount rejects counts outside 1–5", async () => {
  const client = new CorsairHidClient(fakeDevice().device);
  await assert.rejects(client.setDpiStageCount(0), /between 1 and 5/);
  await assert.rejects(client.setDpiStageCount(6), /between 1 and 5/);
});

test("setLiftOffDistance maps the three stops onto the 1–5 scale and reads back", async () => {
  const { device, sent, state } = fakeDevice();
  const client = new CorsairHidClient(device);
  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  assert.equal(state.lift, 1);
  assert.equal(await client.setLiftOffDistance("Medium"), "Medium");
  assert.equal(state.lift, 3);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(state.lift, 5);
  assert.deepEqual(sets(sent).map((bytes) => bytes.slice(0, 5)), [
    [0x07, 0x13, 0x03, 0x00, 1],
    [0x07, 0x13, 0x03, 0x00, 3],
    [0x07, 0x13, 0x03, 0x00, 5],
  ]);
  const stuck = fakeDevice({ ignoreWrites: true });
  await assert.rejects(new CorsairHidClient(stuck.device).setLiftOffDistance("Low"), /kept lift-off height 5/);
});

test("setAngleSnapping writes with the ckb-next trailing byte and confirms", async () => {
  const { device, sent, state } = fakeDevice();
  const client = new CorsairHidClient(device);
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(state.snap, 1);
  assert.equal(await client.setAngleSnapping(false), false);
  assert.equal(state.snap, 0);
  assert.deepEqual(sets(sent).map((bytes) => bytes.slice(0, 6)), [
    [0x07, 0x13, 0x04, 0x00, 1, 0x05],
    [0x07, 0x13, 0x04, 0x00, 0, 0x05],
  ]);
  const stuck = fakeDevice({ ignoreWrites: true });
  await assert.rejects(new CorsairHidClient(stuck.device).setAngleSnapping(true), /kept angle snapping off/);
});

test("a status read after writes reflects the new live values", async () => {
  const { device } = fakeDevice();
  const client = new CorsairHidClient(device);
  await client.setDpiStageValue(1, 3200);
  await client.setDpiStageColor(1, "#112233");
  await client.setActiveDpiStage(2);
  await client.setLiftOffDistance("Medium");
  await client.setAngleSnapping(true);
  const status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [800, 3200, 5700]);
  assert.deepEqual(status.dpiStageColors, ["#00bfff", "#112233", "#00bfff"]);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpi, 5700);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.angleSnapping, true);
});
