import assert from "node:assert/strict";
import test from "node:test";

import { AttackSharkHidClient, resetAttackSharkX11DpiState, resetAttackSharkX11RuntimeState } from "./hid.ts";
import { buildX11DpiReport, X11_DPI_DEFAULT_ACTIVE, X11_DPI_DEFAULT_STAGES } from "../../compx/x11-dpi.ts";
import { buildX3Burst, defaultX3Settings } from "../../compx/x3-config.ts";

type Sent = { reportId: number; data: number[] };
type Listener = (event: { reportId: number; data: DataView }) => void;

function fakeDevice(productId: number, collections: unknown[] = [], failAt = -1) {
  const sent: Sent[] = [];
  let listener: Listener | undefined;
  let attempts = 0;
  const unit = {
    vendorId: 0x1d57,
    productId,
    productName: "2.4G Wireless Device",
    collections,
    opened: false,
    open() { (this as { opened: boolean }).opened = true; return Promise.resolve(); },
    close() { return Promise.resolve(); },
    sendFeatureReport(reportId: number, data: BufferSource) {
      attempts++;
      sent.push({ reportId, data: [...new Uint8Array(data as ArrayBuffer)] });
      return attempts - 1 === failAt ? Promise.reject(new Error("write failed")) : Promise.resolve();
    },
    receiveFeatureReport() { return Promise.reject(new Error("no read-back")); },
    addEventListener(_type: string, l: Listener) { listener = l; },
    removeEventListener() { listener = undefined; },
  } as unknown as HIDDevice;
  const push = (bytes: number[]) => listener?.({ reportId: 0, data: new DataView(new Uint8Array(bytes).buffer) });
  return { unit, sent, push };
}

const rebuilt = (usagePage: number) => ({
  usagePage,
  usage: 0,
  type: 1,
  children: [],
  inputReports: [],
  outputReports: [],
  featureReports: [],
});

const BRIDGE_COLLECTIONS = [rebuilt(0x0c), rebuilt(0x0a), rebuilt(0x0b)];

const fresh = () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
};

async function namedX3(productId = 0xfa60, failAt = -1, collections: unknown[] = []) {
  const device = fakeDevice(productId, collections, failAt);
  const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0, x3BurstGapMs: 0 });
  await client.open();
  device.push([0x03, 0x4d, 0x50, 0x00, 0x06]);
  return { ...device, client };
}

const IDS = [0x0c, 0x04, 0x05, 0x06, 0x08];
const PAYLOAD_LENGTHS = [9, 55, 14, 8, 58];

test("X3 burst is complete and in wire order after a single setting change", async () => {
  fresh();
  const { client, sent } = await namedX3();
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent.map((s) => s.reportId), IDS);
  assert.deepEqual(sent.map((s) => s.data.length), PAYLOAD_LENGTHS);
  assert.deepEqual(sent[0].data, [0x0a, 0x01, 0xfe, 0x01, 0xfe, 0, 0, 0, 0]);
  assert.deepEqual(sent[3].data, [0x09, 0x01, 0x02, 0xfd, 0, 0, 0, 0]);
  const expected = buildX3Burst({ ...defaultX3Settings(), pollingHz: 500 });
  sent.forEach((s, i) => assert.deepEqual(s.data, [...expected[i].subarray(1)]));
});

test("X3 settings persist between changes and every change resends the full state", async () => {
  fresh();
  const { client, sent } = await namedX3();
  await client.setDpiStageValue(1, 1000);
  await client.setActiveDpiStage(2);
  sent.length = 0;
  await client.setPollingRate(250);
  assert.deepEqual(sent.map((s) => s.reportId), IDS);
  const sensor = sent[1].data;
  assert.equal(sensor[8], 19);
  assert.equal(sensor[24 - 1], 3);
  const status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [800, 1000, 2400, 3200, 5000, 26000]);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpi, 2400);
  assert.equal(status.pollingRateHz, 250);
});

test("X3 setters cover lift-off, ripple, snapping, motion sync, sleep, deep sleep, debounce, stages", async () => {
  fresh();
  const { client, sent } = await namedX3();
  await client.setLiftOffDistance("Low");
  await client.setRippleControl(true);
  await client.setAngleSnapping(true);
  await client.setMotionSync(true);
  await client.setSleepTimeout(90);
  await client.setDeepSleepTimeout(45);
  await client.setDebounceTime(10);
  await client.setDpiStageCount(4);
  await client.setDpiStageColor(0, "#102030");
  const status = await client.readStatus();
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.rippleControl, true);
  assert.equal(status.angleSnapping, true);
  assert.equal(status.motionSync, true);
  assert.equal(status.sleepTimeout, 90);
  assert.equal(status.debounceMs, 10);
  assert.equal(client.getDeepSleepTimeout(), 45);
  assert.equal(status.dpiStages?.length, 4);
  assert.equal(status.dpiStageColors?.[0], "#102030");
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.dpiStageEditor?.countEditable, true);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  const last = sent.slice(-5);
  assert.deepEqual(last.map((s) => s.reportId), IDS);
  assert.equal(last[1].data[5 - 1], 0x0f);
  assert.equal(last[2].data[4 - 1], 0x23);
  assert.equal(last[2].data[5 - 1], 0xd8);
  assert.equal(last[2].data[9 - 1], 3);
  assert.equal(last[2].data[10 - 1], 5);
});

test("X3 rejects invalid values before anything is sent", async () => {
  fresh();
  const { client, sent } = await namedX3();
  await assert.rejects(() => client.setDpiStageValue(0, 125));
  await assert.rejects(() => client.setDpiStageValue(9, 800), /no DPI stage/);
  await assert.rejects(() => client.setPollingRate(2000));
  await assert.rejects(() => client.setDebounceTime(5));
  await assert.rejects(() => client.setSleepTimeout(45));
  await assert.rejects(() => client.setDeepSleepTimeout(0));
  await assert.rejects(() => client.setDpiStageCount(9));
  await assert.rejects(() => client.setDpiStageColor(0, "red"));
  await assert.rejects(() => client.setLiftOffDistance("Medium"));
  assert.deepEqual(sent, []);
});

test("X3 waits 500 ms after every report on the receiver and 15 ms on wired", async () => {
  for (const [productId, gap] of [[0xfa60, 500], [0xfa61, 15]] as const) {
    fresh();
    const device = fakeDevice(productId);
    const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0 });
    await client.open();
    device.push([0x03, 0x4d, 0x50, 0x00, 0x06]);
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      waits.push(ms ?? 0);
      return realSetTimeout(fn, 0, ...rest);
    }) as typeof setTimeout;
    try {
      await client.setPollingRate(125);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.deepEqual(waits, [gap, gap, gap, gap, gap]);
    assert.equal(device.sent.length, 5);
  }
});

test("X3 state is kept per product id", async () => {
  fresh();
  const receiver = await namedX3(0xfa60);
  const wired = await namedX3(0xfa61);
  await receiver.client.setPollingRate(125);
  assert.equal((await wired.client.readStatus()).pollingRateHz, 1000);
  assert.equal((await receiver.client.readStatus()).pollingRateHz, 125);
  assert.equal((await wired.client.readStatus()).connectionType, "Wired");
});

test("a failed X3 burst stops, reports the error and keeps the saved state", async () => {
  fresh();
  const { client, sent } = await namedX3(0xfa60, 3);
  await assert.rejects(() => client.setPollingRate(500), /write failed/);
  assert.deepEqual(sent.map((s) => s.reportId), [0x0c, 0x04, 0x05, 0x06]);
  assert.equal((await client.readStatus()).pollingRateHz, 1000);
});

test("X3 battery packet 03 10 raw 01 09 is parsed once the X3 is named, not read as an R1", async () => {
  fresh();
  const { client, push } = await namedX3();
  assert.equal((await client.readStatus()).batteryPercent, null);
  push([0x03, 0x10, 0x40, 0x01, 0x09]);
  let status = await client.readStatus();
  assert.equal(status.name, "Attack Shark X3");
  assert.equal(status.batteryPercent, 77);
  assert.equal(status.batteryVoltageMv, 4000);
  assert.equal(status.batteryState, "Discharging");
  push([0x03, 0x10, 0x40, 0x03, 0x09]);
  status = await client.readStatus();
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.name, "Attack Shark X3");
  assert.equal(await client.setPollingRate(500), 500);
});

test("X3 works through a Bridge rebuilt config collection", async () => {
  fresh();
  const { client, sent } = await namedX3(0xfa60, -1, BRIDGE_COLLECTIONS);
  await client.setMotionSync(true);
  assert.deepEqual(sent.map((s) => s.reportId), IDS);
});

test("the X3 path stays off until the receiver names model 0x4d", async () => {
  fresh();
  const device = fakeDevice(0xfa60, BRIDGE_COLLECTIONS);
  const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0, x3BurstGapMs: 0 });
  await client.open();
  await assert.rejects(() => client.setMotionSync(true), /only available on the Attack Shark X3/);
  await assert.rejects(() => client.setDpiStageCount(3), /only available/);
  assert.deepEqual(device.sent, []);
  assert.equal((await client.readStatus()).ui?.settingsReady, false);
});

test("a mouse reporting an unknown model id never writes through the X3 path", async () => {
  for (const id of [0x21, 0x4e, 0x01, 0x07]) {
    fresh();
    const device = fakeDevice(0xfa60);
    const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0, x3BurstGapMs: 0 });
    await client.open();
    device.push([0x03, id, 0x50, 0x00, 0x06]);
    await assert.rejects(() => client.setMotionSync(true));
    await assert.rejects(() => client.setDebounceTime(10));
    await assert.rejects(() => client.setSleepTimeout(60));
    await assert.rejects(() => client.setLiftOffDistance("Low"));
    assert.ok(device.sent.every((s) => s.reportId !== 0x0c && s.reportId !== 0x05 && s.reportId !== 0x08));
  }
  fresh();
  const device = fakeDevice(0xfa60);
  const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0, x3BurstGapMs: 0 });
  await client.open();
  await assert.rejects(() => client.setMotionSync(true));
  assert.deepEqual(device.sent, []);
});

async function named(id: number) {
  const device = fakeDevice(0xfa60);
  if (id === 0x55) {
    const send = device.unit.sendFeatureReport.bind(device.unit);
    device.unit.sendFeatureReport = async (reportId, data) => {
      await send(reportId, data);
      if (reportId === 0x04 || reportId === 0x06) device.push([0x03, id, 0x50, 0x00, reportId]);
    };
  }
  const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0, x3BurstGapMs: 0 });
  await client.open();
  device.push([0x03, id, 0x50, 0x00, 0x06]);
  return { ...device, client };
}

test("other models keep their exact single-report writes", async () => {
  for (const id of [0x10, 0x55, 0x85]) {
    fresh();
    const { client, sent } = await named(id);
    assert.equal(await client.setPollingRate(500), 500);
    assert.deepEqual(sent, [{ reportId: 0x06, data: [0x09, 0x01, 0x02, 0xfd, 0, 0, 0, 0] }]);
  }
  fresh();
  const x11 = await named(0x55);
  await x11.client.setDpi(1600);
  const expected = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES].map((v, i) => (i === X11_DPI_DEFAULT_ACTIVE - 1 ? 1600 : v)),
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
    wired: false,
  });
  // The edit first asks for the live DPI table (0xa0); this fake never answers, so the cached table is written.
  assert.deepEqual(x11.sent.map((s) => s.reportId), [0xa0, 0x04]);
  assert.deepEqual(x11.sent[1].data, [...expected.subarray(1)]);
  assert.equal(x11.client.getDpiOptions().at(-1), 22000);
});

test("M600 Pro keeps its 51-byte DPI write through the Bridge shape", async () => {
  fresh();
  const device = fakeDevice(0xfa60, BRIDGE_COLLECTIONS);
  const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0, receiverWriteGapMs: 0, x3BurstGapMs: 0 });
  await client.open();
  device.push([0x03, 0x20, 0x40, 0x01, 0x4c]);
  assert.equal(await client.setDpi(400), 400);
  assert.equal(device.sent.length, 1);
  assert.equal(device.sent[0].reportId, 0x04);
  assert.equal(device.sent[0].data.length, 51);
});

test("an R1 battery packet before any X3 is named still reads as an R1", async () => {
  fresh();
  const { client } = await named(0x10);
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark R1");
  assert.equal(status.ui?.family, "attackshark");
  assert.equal(client.getSupportedPollingRates().length, 4);
});

test("X3 button remap sends the full burst with keys, media, DPI and macro slots in place", async () => {
  fresh();
  const { client, sent } = await namedX3();
  await client.setButtonMapping("Forward", "Ctrl+X");
  assert.deepEqual(sent.map((s) => s.reportId), IDS);
  assert.deepEqual(sent[4].data.slice(21 - 1, 24 - 1), [0x11, 0x01, 0x1b]);
  assert.deepEqual(sent[4].data.slice(-2), [0x00, 0xe9]);
  await client.setButtonMapping("Back", "DPI Cycle");
  await client.setButtonMapping("Middle", "Play/Pause");
  await client.setButtonMapping("Right", "Macro");
  const status = await client.readStatus();
  assert.deepEqual(status.buttonMappings, {
    Left: "Left Click", Right: "Macro", Middle: "Play/Pause", Forward: "Ctrl+X", Back: "DPI Cycle",
  });
  assert.ok(status.buttonOptions?.includes("Macro"));
  const last = sent.slice(-5)[4].data;
  assert.deepEqual(last.slice(5, 8), [0x12, 0x00, 0x02]);
  assert.deepEqual(last.slice(12 - 1, 15 - 1), [0x0d, 0, 0]);
});

test("X3 button remap rejects bad input and the no-left-click state before sending", async () => {
  fresh();
  const { client, sent } = await namedX3();
  await assert.rejects(client.setButtonMapping("Nope", "Mute"), /Unknown X3 button/);
  await assert.rejects(client.setButtonMapping("Left", "Ctrl+Ctrl+X"), /not an X3 button action/);
  await assert.rejects(client.setButtonMapping("Left", "Off"), /Left click/);
  assert.equal(sent.length, 0);
  await client.setButtonMapping("Right", "Left Click");
  await client.setButtonMapping("Left", "Off");
  assert.equal(sent.length, 10);
  await client.resetButtonMappings();
  assert.equal((await client.readStatus()).buttonMappings?.Left, "Left Click");
});

test("X3 macro upload sends three chunks, no commit lead, and keeps button state", async () => {
  fresh();
  const { client, sent } = await namedX3();
  const events = Array.from({ length: 7 }, () => [{ usage: 6, down: true }, { usage: 6, down: false }]).flat();
  await client.uploadMacro({ events });
  assert.deepEqual(sent.map((s) => s.reportId), [0x09, 0x09, 0x09]);
  assert.deepEqual(sent.map((s) => s.data.length), [63, 63, 11]);
  assert.deepEqual(sent.map((s) => s.data.slice(0, 3)), [[0x40, 0x08, 0], [0x40, 0x08, 1], [0x0c, 0x08, 2]]);
  assert.deepEqual(sent[2].data.slice(-2), [0x03, 0xf3]);
  await assert.rejects(client.uploadMacro({ events: Array(51).fill({ usage: 4, down: true }) }), /at most 50/);
  await assert.rejects(client.uploadMacro({ slot: 0, events }), /slot/);
  assert.equal(sent.length, 3);
});

test("X3 button and macro methods are refused when the X3 is not named", async () => {
  fresh();
  const device = fakeDevice(0xfa60);
  const client = new AttackSharkHidClient(device.unit, { batteryWaitMs: 0, x3BurstGapMs: 0 });
  await client.open();
  await assert.rejects(client.setButtonMapping("Left", "Mute"), /only available on the Attack Shark X3/);
  await assert.rejects(client.uploadMacro({ events: [] }), /only available on the Attack Shark X3/);
  assert.equal(device.sent.length, 0);
});
