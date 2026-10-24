import assert from "node:assert/strict";
import test from "node:test";

import { GWolvesHidClient } from "./hid.ts";
import { GWolvesXviHidClient } from "./xvi-hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// Answers like the XVI firmware as the web driver reads it: the reply is the
// request with status 0xa1 in slot 0 and the values written in place.
function xviDevice(productId: number, { prefixReplies = false, pollingCode = 128, lod = 1 } = {}) {
  const state = {
    pollingCode, lod, active: 2, stages: [[400, 400], [800, 800], [1600, 1600]],
    sleep: 60, debounce: [2, 5, 35, 10], motionSync: 0, angleSnap: 1,
    // Left, Right, Middle, Back, Forward, DPI; Forward holds a macro.
    buttons: [1, 1, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 24, 3, 0, 1, 1, 0, 11, 1, 0, 0, 0, 0],
  };
  const sent: Uint8Array[] = [];
  let reply = new Uint8Array(64);
  const answer = (request: Uint8Array): Uint8Array => {
    const out = request.slice();
    out[0] = 0xa1;
    if (request[1] === 0) {
      const command = request[5];
      if (command === 0x81 && request[4] === 0) out.set([1, 2, 3, 4], 6);
      if (command === 0x81 && request[4] === 1) {
        out[7] = state.stages.length;
        state.stages.forEach(([x, y], stage) => out.set([x! >> 8, x! & 0xff, y! >> 8, y! & 0xff], 8 + stage * 4));
      }
      if (command === 0x82) out[7] = state.active;
      if (command === 0x87) out.set([state.sleep >> 8, state.sleep & 0xff], 6);
      if (command === 0x07) state.sleep = (request[6]! << 8) | request[7]!;
      if (command === 0x01) {
        state.stages = Array.from({ length: request[7]! }, (_, stage) => {
          const at = 8 + stage * 4;
          return [(request[at]! << 8) | request[at + 1]!, (request[at + 2]! << 8) | request[at + 3]!];
        });
      }
    } else {
      const command = request[2];
      if (command === 0x8f) out.set([0, 76], 4);
      if (command === 0x82) out[4] = state.pollingCode;
      if (command === 0x02) state.pollingCode = request[4]!;
      if (command === 0x86) out[4] = state.lod;
      if (command === 0x06) state.lod = request[4]!;
      if (command === 0x85) out.set(state.debounce, 4);
      if (command === 0x05) state.debounce = [...request.slice(4, 8)];
      if (command === 0x91) out[4] = state.motionSync;
      if (command === 0x11) state.motionSync = request[4]!;
      if (command === 0x87) out[4] = state.angleSnap;
      if (command === 0x07) state.angleSnap = request[4]!;
      if (command === 0x84) out.set(state.buttons, 4);
      if (command === 0x04) state.buttons = [...request.slice(4, 40)];
    }
    return out;
  };
  const device = {
    vendorId: 0x33e4,
    productId,
    productName: "HTX Mini",
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
    async receiveFeatureReport() {
      const bytes = prefixReplies ? Uint8Array.of(0, ...reply) : reply;
      return new DataView(bytes.buffer);
    },
  };
  return { device: device as unknown as HIDDevice, state, sent };
}

test("the HTX Mini 8K dongle goes to the XVI client, not the XVI:0 one", () => {
  const { device } = xviDevice(0x2717);
  assert.equal(GWolvesXviHidClient.isSupported(device), true);
  assert.equal(GWolvesHidClient.isSupported(device), false);
  assert.equal(GWolvesXviHidClient.isSupported({ ...device, productId: 0x3854 } as HIDDevice), false);
  assert.equal(GWolvesXviHidClient.isSupported({ ...device, collections: [device.collections[0]!] } as HIDDevice), false);
});

for (const prefixReplies of [false, true]) {
  test(`reads and writes settings${prefixReplies ? " when Chrome prefixes the report id" : ""}`, async () => {
    const { device, state, sent } = xviDevice(0x2717, { prefixReplies });
    const client = new GWolvesXviHidClient(device);

    const status = await client.readStatus();
    assert.equal(status.name, "G-Wolves HTX Mini");
    assert.equal(status.dpi, 800);
    assert.equal(status.pollingRateHz, 8000);
    assert.equal(status.batteryPercent, 76);
    assert.equal(status.liftOffDistance, "Low");
    assert.deepEqual(status.firmware, ["Mouse 1.2.3.4"]);

    assert.equal(await client.setDpi(1200), 1200);
    assert.deepEqual(state.stages, [[400, 400], [1200, 1200], [1600, 1600]]);
    assert.equal(await client.setPollingRate(2000), 2000);
    assert.equal(state.pollingCode, 32);
    assert.equal(await client.setLiftOffDistance("High"), "High");
    // Wireless legacy requests carry the receiver flag in byte 3.
    assert.ok(sent.filter((packet) => packet[1] !== 0).every((packet) => packet[3] === 1));
  });
}

test("over the cable the web driver's 64 reads as 1 kHz and faster rates are refused", async () => {
  const { device } = xviDevice(0x2708, { pollingCode: 64 });
  const client = new GWolvesXviHidClient(device);
  assert.equal((await client.readStatus()).pollingRateHz, 1000);
  await assert.rejects(client.setPollingRate(8000), /does not support 8000 Hz/);
});

test("30K models read and write the 0.7 mm lift-off as 7", async () => {
  // Fenrir 0x3508 over the cable, as captured from a unit set to 0.7 mm in
  // the web driver: the 0x86 read answers a1 01 86 00 07.
  const { device, state } = xviDevice(0x3508, { pollingCode: 1, lod: 7 });
  const client = new GWolvesXviHidClient(device);

  const status = await client.readStatus();
  assert.equal(status.liftOffDistance, "Low");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.equal(await client.setLiftOffDistance("Medium"), "Medium");
  assert.equal(state.lod, 1);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(state.lod, 2);
  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  assert.equal(state.lod, 7);
});

test("26K models keep the 1 mm / 2 mm lift-off pair", async () => {
  const { device } = xviDevice(0x2717);
  const client = new GWolvesXviHidClient(device);
  assert.deepEqual((await client.readStatus()).supportedLiftOffDistances, ["Low", "High"]);
  await assert.rejects(client.setLiftOffDistance("Medium"), /only the 1 mm and 2 mm/);
});

test("reads and writes sleep, debounce, the sensor toggles and the buttons", async () => {
  const { device, state } = xviDevice(0x2717);
  const client = new GWolvesXviHidClient(device);

  const status = await client.readStatus();
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.debounceMs, 2);
  assert.equal(status.motionSync, false);
  assert.equal(status.angleSnapping, true);
  assert.equal(status.ui?.hideRippleControl, true);
  assert.deepEqual(status.buttonMappings, {
    Left: "Left Click", Right: "Right Click", Middle: "Middle Click", Back: "Backward", Forward: "Custom",
  });

  assert.equal(await client.setSleepTimeout(300), 300);
  assert.equal(state.sleep, 300);
  await assert.rejects(client.setSleepTimeout(10), /30-600 seconds/);
  assert.equal(await client.setDebounceTime(4), 4);
  // Only the before-press timing moves.
  assert.deepEqual(state.debounce, [4, 5, 35, 10]);
  assert.equal(await client.setMotionSync(true), true);
  assert.equal(await client.setAngleSnapping(false), false);
  assert.deepEqual([state.motionSync, state.angleSnap], [1, 0]);

  await client.setButtonMapping("Forward", "DPI+");
  // The macro's data bytes stay, as they do in the web driver; the unset type
  // byte on Middle is stored back as 1.
  assert.deepEqual(state.buttons.slice(12, 14), [3, 1]);
  assert.deepEqual(state.buttons.slice(24, 30), [9, 1, 0, 1, 1, 0]);
  assert.equal((await client.readStatus()).buttonMappings?.Forward, "DPI+");
  await assert.rejects(client.setButtonMapping("Left", "Right Click"), /Keep at least one button as Left Click/);
  await assert.rejects(client.setButtonMapping("DPI", "DPI Loop"), /no "DPI" button/);

  state.sleep = 0xffff;
  assert.equal((await client.readStatus()).sleepTimeout, null);
});

test("a 4K dongle caps polling at 4 kHz while an 8K dongle allows 8 kHz", async () => {
  const fourK = xviDevice(0x5807);
  const fourKStatus = await new GWolvesXviHidClient(fourK.device).readStatus();
  assert.deepEqual(fourKStatus.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000]);
  await assert.rejects(new GWolvesXviHidClient(fourK.device).setPollingRate(8000), /does not support 8000 Hz/);

  const eightK = xviDevice(0x5817);
  const eightKStatus = await new GWolvesXviHidClient(eightK.device).readStatus();
  assert.ok(eightKStatus.supportedPollingRates?.includes(8000));
});

test("a 1K receiver stops at 1 kHz", async () => {
  const { device } = xviDevice(0x5803);
  const status = await new GWolvesXviHidClient(device).readStatus();
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
});
