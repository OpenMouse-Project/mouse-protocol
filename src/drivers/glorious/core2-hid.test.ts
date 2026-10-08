import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  encodeGloriousCore2ActiveDpiStage,
  encodeGloriousCore2BatteryRequest,
  encodeGloriousCore2Debounce,
  encodeGloriousCore2DpiColors,
  encodeGloriousCore2DpiStages,
  encodeGloriousCore2FirmwareRequest,
  encodeGloriousCore2MotionSync,
  encodeGloriousCore2PollingRate,
  encodeGloriousCore2Profile,
} from "../../glorious-core2/index.ts";
import { GloriousCore2HidClient } from "./core2-hid.ts";

const WIRED = 0x201b;
const RECEIVER = 0x2035;

/** The replies CORE read in the capture: firmware first, then battery. */
function capturedReplies(): { firmware: Uint8Array; battery: Uint8Array } {
  const lines = readFileSync(new URL("../../../captures/glorious-o2-pro-4k8k-wired/core-session.hex", import.meta.url), "utf8")
    .split("\n").filter((line) => line && !line.startsWith("#"));
  const reply = (register: number) => {
    const line = lines.find((entry) => entry.split(" ")[1] === "<" && Number.parseInt(entry.split(" ")[7]!, 16) === register)!;
    const bytes = new Uint8Array(64);
    bytes.set(line.split(" ").slice(2).map((byte) => Number.parseInt(byte, 16)));
    return bytes;
  };
  return { firmware: reply(0x81), battery: reply(0x83) };
}

function fakeCollection(usagePage: number, usage: number, withFeatureReport: boolean) {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: withFeatureReport ? [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }] : [],
  };
}

function fakeDevice(productId: number, options: { vendorId?: number; collections?: unknown[]; replies?: Uint8Array[] } = {}) {
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  const replies = [...(options.replies ?? [])];
  const device = {
    vendorId: options.vendorId ?? 0x258a,
    productId,
    productName: "",
    opened: true,
    collections: options.collections ?? [fakeCollection(0xffff, 0, true)],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
      sent.push({ reportId, payload: new Uint8Array(view) });
    },
    receiveFeatureReport: async () => {
      const next = replies.shift();
      if (!next) throw new Error("no reply queued");
      return new DataView(next.buffer, next.byteOffset, next.byteLength);
    },
  };
  return { device: device as unknown as HIDDevice, sent };
}

/** The driver keeps its last-written values in localStorage, which plain node does not have. */
function withLocalStorage(run: () => Promise<void>) {
  return async () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    try {
      await run();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  };
}

test("claims the cable and receiver ids on the 0xffff config collection only", () => {
  assert.equal(GloriousCore2HidClient.isSupported(fakeDevice(WIRED).device), true);
  assert.equal(GloriousCore2HidClient.isSupported(fakeDevice(RECEIVER).device), true);
  // Interface 1 carries a 0xffff collection (usage 1) with no feature report.
  assert.equal(GloriousCore2HidClient.isSupported(fakeDevice(WIRED, { collections: [fakeCollection(0xffff, 1, false)] }).device), false);
  assert.equal(GloriousCore2HidClient.isSupported(fakeDevice(WIRED, { collections: [fakeCollection(0xff01, 0, true)] }).device), false);
  assert.equal(GloriousCore2HidClient.isSupported(fakeDevice(0x2036).device), false);
  assert.equal(GloriousCore2HidClient.isSupported(fakeDevice(WIRED, { vendorId: 0x3794 }).device), false);
});

test("reads firmware and battery with the frames CORE used, and reports the captured answers", async () => {
  const { firmware, battery } = capturedReplies();
  const { device, sent } = fakeDevice(WIRED, { replies: [firmware, battery] });
  const status = await new GloriousCore2HidClient(device).readStatus();
  assert.deepEqual(sent.map(({ payload }) => payload), [encodeGloriousCore2FirmwareRequest("mouse"), encodeGloriousCore2BatteryRequest()]);
  assert.equal(status.name, "Model O2 Pro 4K/8K");
  assert.deepEqual(status.firmware, ["1.0.15.0"]);
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Full");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.profileCount, 3);
  assert.equal(status.activeProfile, 1);
});

test("a failed read still returns the identity, and the receiver reads its own firmware", async () => {
  const { device, sent } = fakeDevice(RECEIVER);
  const status = await new GloriousCore2HidClient(device).readStatus();
  assert.equal(sent[0]!.payload[2], 0x00);
  assert.equal(status.name, "Model O2 Pro 4K/8K Wireless receiver");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
  assert.deepEqual(status.firmware, []);
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000]);
});

test("polling 8000 Hz on the cable sends 8000 wired with 4000 wireless, as CORE does", withLocalStorage(async () => {
  const { device, sent } = fakeDevice(WIRED);
  const client = new GloriousCore2HidClient(device);
  assert.equal(await client.setPollingRate(8000), 8000);
  assert.deepEqual(sent.map(({ payload }) => payload), [encodeGloriousCore2PollingRate(8000, 4000, 1)]);
  assert.equal(sent[0]!.reportId, 0);
  await client.setPollingRate(1000);
  assert.deepEqual(sent[1]!.payload, encodeGloriousCore2PollingRate(1000, 1000, 1));
}));

test("the receiver takes 4000 Hz on both links and refuses 8000 Hz", async () => {
  const { device, sent } = fakeDevice(RECEIVER);
  const client = new GloriousCore2HidClient(device);
  await assert.rejects(() => client.setPollingRate(8000), /8000/);
  await assert.rejects(() => client.setPollingRate(1500), /1500/);
  assert.equal(sent.length, 0);
  await client.setPollingRate(4000);
  assert.deepEqual(sent.map(({ payload }) => payload), [encodeGloriousCore2PollingRate(4000, 4000, 1)]);
});

test("a DPI stage edit rewrites the table and re-selects the active stage", withLocalStorage(async () => {
  const { device, sent } = fakeDevice(WIRED);
  const client = new GloriousCore2HidClient(device);
  assert.equal(await client.setDpiStageValue(1, 900), 900);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    encodeGloriousCore2DpiStages([400, 900, 1600, 3200], 1),
    encodeGloriousCore2ActiveDpiStage(2, 1),
  ]);
  // The edit is remembered: the next read of the status shows it.
  const status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [400, 900, 1600, 3200]);
  await assert.rejects(() => client.setDpiStageValue(4, 800), /between 1 and 4/);
  await assert.rejects(() => client.setDpiStageValue(0, 99), /DPI/);
}));

test("changing the stage count sends the colors too, and the active stage follows", withLocalStorage(async () => {
  const { device, sent } = fakeDevice(WIRED);
  const client = new GloriousCore2HidClient(device);
  assert.equal(await client.setDpiStageCount(2), 2);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    encodeGloriousCore2DpiStages([400, 800], 1),
    encodeGloriousCore2DpiColors(["#ffa40d", "#26b4ff"], 1),
    encodeGloriousCore2ActiveDpiStage(1, 1),
  ]);
  await assert.rejects(() => client.setDpiStageCount(7), /1 to 6/);
}));

test("raising the stage count doubles the last stage for each new one and gives them the palette's next colors", withLocalStorage(async () => {
  const { device, sent } = fakeDevice(WIRED);
  assert.equal(await new GloriousCore2HidClient(device).setDpiStageCount(6), 6);
  assert.deepEqual(sent[0]!.payload, encodeGloriousCore2DpiStages([400, 800, 1600, 3200, 6400, 12_800], 1));
  assert.deepEqual(sent[1]!.payload, encodeGloriousCore2DpiColors(["#ffa40d", "#26b4ff", "#ff2626", "#18b30a", "#5500ff", "#00ffff"], 1));
}));

test("a new stage never doubles past the maximum", withLocalStorage(async () => {
  const { device, sent } = fakeDevice(WIRED);
  const client = new GloriousCore2HidClient(device);
  await client.setDpiStageValue(3, 20_000);
  await client.setDpiStageCount(6);
  assert.deepEqual(sent[2]!.payload, encodeGloriousCore2DpiStages([400, 800, 1600, 20_000, 26_000, 26_000], 1));
}));

test("selecting a stage, recoloring one, debounce and motion sync send one frame each", withLocalStorage(async () => {
  const { device, sent } = fakeDevice(WIRED);
  const client = new GloriousCore2HidClient(device);
  await client.setActiveDpiStage(0);
  await client.setDpiStageColor(3, "#112233");
  await client.setDebounceTime(8);
  await client.setMotionSync(false);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    encodeGloriousCore2ActiveDpiStage(0, 1),
    encodeGloriousCore2DpiColors(["#ffa40d", "#26b4ff", "#ff2626", "#112233"], 1),
    encodeGloriousCore2Debounce(8, 1),
    encodeGloriousCore2MotionSync(false, 1),
  ]);
  assert.deepEqual(client.getDebounceOptions(), [4, 6, 8, 10, 12, 14, 16]);
  await assert.rejects(() => client.setDebounceTime(3), /4 to 16/);
  await assert.rejects(() => client.setDebounceTime(18), /4 to 16/);
}));

test("picking a profile selects it on the mouse, and every later write carries it", withLocalStorage(async () => {
  const { device, sent } = fakeDevice(WIRED);
  const client = new GloriousCore2HidClient(device);
  assert.equal(await client.setProfile(3), 3);
  await client.setMotionSync(true);
  await client.setPollingRate(2000);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    encodeGloriousCore2Profile(3),
    encodeGloriousCore2MotionSync(true, 3),
    encodeGloriousCore2PollingRate(2000, 2000, 3),
  ]);
  assert.equal((await client.readStatus()).activeProfile, 3);
  // Each profile keeps its own shown values.
  await client.setPollingRate(500);
  await client.setProfile(1);
  assert.equal((await client.readStatus()).pollingRateHz, 1000);
  await assert.rejects(() => client.setProfile(4), /1 to 3/);
}));

test("what was written over the cable shows on the receiver, with 8000 Hz shown as 4000 Hz", withLocalStorage(async () => {
  const cable = new GloriousCore2HidClient(fakeDevice(WIRED).device);
  const receiver = new GloriousCore2HidClient(fakeDevice(RECEIVER).device);
  await cable.setPollingRate(8000);
  await cable.setDpiStageValue(0, 500);
  const onReceiver = await receiver.readStatus();
  assert.equal(onReceiver.pollingRateHz, 4000);
  assert.deepEqual(onReceiver.dpiStages, [500, 800, 1600, 3200]);
  assert.equal((await cable.readStatus()).pollingRateHz, 8000);
}));

test("two status reads at once do not interleave their request and reply", async () => {
  const { firmware, battery } = capturedReplies();
  const { device, sent } = fakeDevice(WIRED, { replies: [firmware, battery, firmware, battery] });
  const client = new GloriousCore2HidClient(device);
  const [first, second] = await Promise.all([client.readStatus(), client.readStatus()]);
  assert.deepEqual(first.firmware, ["1.0.15.0"]);
  assert.deepEqual(second.firmware, ["1.0.15.0"]);
  assert.deepEqual(sent.map(({ payload }) => payload[5]), [0x81, 0x83, 0x81, 0x83]);
});
