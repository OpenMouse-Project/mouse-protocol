import assert from "node:assert/strict";
import test from "node:test";

import { GWolvesHidClient } from "./hid.ts";
import { GWolvesXviHidClient } from "./xvi-hid.ts";
import { GWolvesXviNewHidClient } from "./xvi-new-hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// Answers like an XVI-new firmware (HTM Plus / HSK Pro 2.0 / HTXU / Fenrir
// Pro) as the vendor page drives it: profile-addressed frames
// `[2, len, class, cmd, profile, ...]`, status 0xa1 in slot 0 with the
// command echoed in slot 5.
function xviNewDevice(productId: number, { asleep = false, pollingCode = 128, ignoreWrites = false } = {}) {
  const state = {
    pollingCode, lod: 2,
    active: 2,
    stages: [[400, 400], [800, 800], [1600, 1600]],
    sleep: 60,
    debounce: [2, 5, 35],
    motionSync: 0,
    angleSnap: 1,
    // [type, code] keyed by 1-based firmware slot; slot 3 starts on a DPI
    // action (type 7) and slot 5 on another non-click action.
    buttons: new Map([[1, [1, 1]], [2, [1, 2]], [3, [1, 4]], [4, [1, 8]], [5, [7, 0]]]),
  };
  const sent: Uint8Array[] = [];
  let reply = new Uint8Array(64);
  const answer = (request: Uint8Array): Uint8Array => {
    const out = request.slice();
    out[0] = asleep ? 2 : 0xa1;
    const cls = request[4];
    const command = request[5];
    const profile = request[6];
    if (ignoreWrites) {
      // Reads still answer; writes land nowhere, so read-back confirms fail.
      if (cls === 1 && command === 128) out[7] = state.pollingCode;
      if (cls === 1 && command === 129 && request[3] === 10) {
        out[7] = state.stages.length;
        state.stages.forEach(([x, y], stage) => out.set([x! >> 8, x! & 0xff, y! >> 8, y! & 0xff], 8 + stage * 4));
      }
      if (cls === 1 && command === 130) out[7] = state.active;
      return out;
    }
    if (cls === 0 && command === 129) out.set([1, 2, 3, 4], 6); // firmware
    if (cls === 0 && command === 131) out.set([2, 0, 131, 0, 76], 3); // discharging, 76%
    if (cls === 1 && command === 128) out[7] = state.pollingCode;
    if (cls === 1 && command === 0) state.pollingCode = request[7]!;
    if (cls === 1 && command === 136 && request[3] === 2) out[7] = state.lod;
    if (cls === 1 && command === 8) state.lod = request[7]!;
    if (cls === 1 && command === 129 && request[3] === 10) {
      out[7] = state.stages.length;
      state.stages.forEach(([x, y], stage) => out.set([x! >> 8, x! & 0xff, y! >> 8, y! & 0xff], 8 + stage * 4));
    }
    if (cls === 1 && command === 130) out[7] = state.active;
    if (cls === 1 && command === 2) state.active = request[7]!;
    if (cls === 1 && command === 1 && request[3] === 30) {
      const count = request[7]!;
      state.stages = Array.from({ length: count }, (_, stage) => {
        const at = 8 + stage * 4;
        return [(request[at]! << 8) | request[at + 1]!, (request[at + 2]! << 8) | request[at + 3]!];
      });
    }
    if (cls === 0 && command === 135 && request[3] === 3) out.set([state.sleep >> 8, state.sleep & 0xff], 7);
    if (cls === 0 && command === 7) state.sleep = (request[7]! << 8) | request[8]!;
    if (cls === 0 && command === 136 && request[3] === 5) out.set([state.debounce[0]!, state.debounce[1]!, state.debounce[2]!], 8);
    if (cls === 0 && command === 8 && request[3] === 5) {
      state.debounce = [request[8]!, request[9]!, request[10]!];
    }
    if (cls === 1 && command === 137) out[7] = state.motionSync;
    if (cls === 1 && command === 9) state.motionSync = request[7]!;
    if (cls === 1 && command === 132) out[7] = state.angleSnap;
    if (cls === 1 && command === 4) state.angleSnap = request[7]!;
    if (cls === 3 && command === 128) {
      // Button query: slot arrives 1-based, type reports at [9], code at [11].
      const slot = request[7]!;
      const [type, code] = state.buttons.get(slot) ?? [255, 0];
      out[9] = type!;
      out[11] = code!;
    }
    if (cls === 3 && command === 0) {
      // Remap write: slot arrives 1-based, [type, len, ...data].
      state.buttons.set(request[7]!, [request[9]!, request[11] ?? 0]);
    }
    // Every command takes the profile byte except firmware and battery.
    if (!(cls === 0 && (command === 129 || command === 131))) assert.equal(profile, 1);
    return out;
  };
  const device = {
    vendorId: 0x33e4,
    productId,
    productName: "Fenrir Pro",
    opened: false,
    collections: [
      { usagePage: 0x01, usage: 0x02, children: [], featureReports: [], inputReports: [], outputReports: [] },
      {
        usagePage: 0xff00,
        usage: 0x01,
        children: [],
        featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
        inputReports: [],
        outputReports: [],
      },
    ],
    async open() { device.opened = true; },
    async close() { device.opened = false; },
    async sendFeatureReport(_reportId: number, data: Uint8Array) {
      sent.push(new Uint8Array(data));
      reply = answer(new Uint8Array(data));
    },
    async receiveFeatureReport(_reportId: number) {
      return new DataView(reply.buffer);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return { device: device as unknown as HIDDevice, state, sent };
}

test("an xvi-new receiver goes to the new client, not the older ones", () => {
  const { device } = xviNewDevice(0x3617);
  assert.equal(GWolvesXviNewHidClient.isSupported(device), true);
  assert.equal(GWolvesXviHidClient.isSupported(device), false);
  assert.equal(GWolvesHidClient.isSupported(device), false);
  assert.equal(GWolvesXviNewHidClient.isSupported({ ...device, productId: 0x2717 } as HIDDevice), false);
  assert.equal(GWolvesXviNewHidClient.isSupported({ ...device, vendorId: 0x3554 } as HIDDevice), false);
  assert.equal(GWolvesXviNewHidClient.isSupported({ ...device, collections: [device.collections[0]!] } as HIDDevice), false);
});

test("reads status through profile-addressed commands", async () => {
  const { device } = xviNewDevice(0x3617);
  const status = await new GWolvesXviNewHidClient(device).readStatus();
  assert.equal(status.name, "G-Wolves Fenrir Pro");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 8000);
  assert.equal(status.batteryPercent, 76);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.liftOffDistance, "High");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.debounceMs, 2);
  assert.equal(status.motionSync, false);
  assert.equal(status.angleSnapping, true);
  assert.deepEqual(status.firmware, ["Mouse 1.2.3.4"]);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(status.buttonMappings, {
    Left: "Left Click", Right: "Right Click", Middle: "Middle Click", Back: "Backward", Forward: "Custom",
  });
  assert.deepEqual(status.buttonOptions, ["Left Click", "Right Click", "Middle Click", "Backward", "Forward", "Disable"]);
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
  assert.equal(status.activeDpiStage, 1);
  assert.deepEqual(status.ui?.dpiStageEditor, { maxStages: 7, countEditable: false, minDpi: 50, maxDpi: 30000, stepDpi: 50 });
});

test("writes DPI, polling, lift-off, sleep, debounce and toggles with read-back", async () => {
  const { device, state, sent } = xviNewDevice(0x3608);
  const client = new GWolvesXviNewHidClient(device);

  assert.equal(await client.setDpi(1200), 1200);
  assert.deepEqual(state.stages, [[400, 400], [1200, 1200], [1600, 1600]]);
  // DPI travels as a full stage table with the profile byte up front.
  const dpiWrite = sent.find((packet) => packet[5] === 1 && packet[3] === 30)!;
  assert.deepEqual([...dpiWrite.slice(2, 8)], [2, 30, 1, 1, 1, 3]);

  assert.equal(await client.setPollingRate(2000), 2000);
  assert.equal(state.pollingCode, 32);
  // The new-protocol set-polling command is 0 with the profile byte.
  const pollingWrite = sent.find((packet) => packet[5] === 0)!;
  assert.deepEqual([...pollingWrite.slice(2, 8)], [2, 2, 1, 0, 1, 32]);

  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  assert.equal(state.lod, 135); // 0.7 mm rides above bit 7
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(state.lod, 2);

  assert.equal(await client.setSleepTimeout(300), 300);
  assert.equal(state.sleep, 300);
  await assert.rejects(client.setSleepTimeout(10), /30-600 seconds/);

  assert.equal(await client.setDebounceTime(4), 4);
  assert.deepEqual(state.debounce, [4, 5, 35]);
  await assert.rejects(client.setDebounceTime(99), /0-50 ms/);

  assert.equal(await client.setMotionSync(true), true);
  assert.equal(await client.setAngleSnapping(false), false);
  assert.deepEqual([state.motionSync, state.angleSnap], [1, 0]);
});

test("the vendor's 16-means-1kHz quirk reads as 1000 Hz", async () => {
  const { device } = xviNewDevice(0x3617, { pollingCode: 16 });
  assert.equal((await new GWolvesXviNewHidClient(device).readStatus()).pollingRateHz, 1000);
});

test("an asleep mouse fails loudly instead of timing out silently", async () => {
  const { device } = xviNewDevice(0x3617, { asleep: true });
  await assert.rejects(new GWolvesXviNewHidClient(device).readStatus(), /asleep or out of range/);
});

test("writes DPI stages and the active stage by index", async () => {
  const { device, state } = xviNewDevice(0x3617);
  const client = new GWolvesXviNewHidClient(device);

  assert.equal(await client.setDpiStageValue(0, 1200), 1200);
  assert.deepEqual(state.stages[0], [1200, 1200]);
  // A split X/Y stage keeps its Y axis instead of being flattened.
  state.stages[1] = [800, 1600];
  assert.equal(await client.setDpiStageValue(1, 1000), 1000);
  assert.deepEqual(state.stages[1], [1000, 1600]);

  assert.equal(await client.setActiveDpiStage(0), 0);
  assert.equal(state.active, 1);
  assert.equal((await client.readStatus()).dpi, 1200);

  await assert.rejects(client.setDpiStageValue(9, 800), /does not have a DPI stage 10/);
  await assert.rejects(client.setActiveDpiStage(9), /does not have a DPI stage 10/);
  await assert.rejects(client.setDpiStageValue(0, 999999), /50-30,000/);
});

test("an ignored write fails on read-back rather than lying", async () => {
  const { device } = xviNewDevice(0x3617, { ignoreWrites: true });
  const client = new GWolvesXviNewHidClient(device);
  await assert.rejects(client.setDpi(1200), /kept 800 DPI instead of 1200 DPI/);
  await assert.rejects(client.setPollingRate(2000), /kept 8000 Hz instead of 2000 Hz/);
  await assert.rejects(client.setDpi(999999), /50-30,000/);
});

test("remaps plain clicks with the vendor's type/code framing", async () => {
  const { device, state, sent } = xviNewDevice(0x3608);
  const client = new GWolvesXviNewHidClient(device);

  // Reads and writes address the slot 1-based with the query shape.
  await client.setButtonMapping("Forward", "Forward");
  assert.deepEqual(state.buttons.get(5), [1, 16]);
  const query = sent.find((packet) => packet[5] === 128 && packet[7] === 5)!;
  assert.deepEqual([...query.slice(2, 11)], [2, 15, 3, 128, 1, 5, 0, 255, 10]);
  const write = sent.find((packet) => packet[5] === 0)!;
  assert.deepEqual([...write.slice(2, 12)], [2, 6, 3, 0, 1, 5, 0, 1, 1, 16]);

  await client.setButtonMapping("Back", "Disable");
  assert.deepEqual(state.buttons.get(4), [0, 0]);
  const disableWrites = sent.filter((packet) => packet[5] === 0);
  const disableWrite = disableWrites[disableWrites.length - 1]!;
  assert.deepEqual([...disableWrite.slice(2, 11)], [2, 5, 3, 0, 1, 4, 0, 0, 0]);

  await assert.rejects(client.setButtonMapping("Left", "Right Click"), /Keep at least one button as Left Click/);
  await assert.rejects(client.setButtonMapping("DPI", "DPI Loop"), /has no "DPI" button/);
  await assert.rejects(client.setButtonMapping("Left", "Macro 1"), /Unknown button action/);
});
