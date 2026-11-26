import assert from "node:assert/strict";
import test from "node:test";

import { HitscanXviHidClient } from "./xvi-hid.ts";
import { HitscanHidClient } from "./hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";
import {
  HITSCAN_XVI_COMMAND,
  HITSCAN_XVI_VENDOR_ID,
  type HitscanXviNotification,
} from "@openmouse/protocol/hitscan";

interface FakeState {
  firmware: string;
  dongleFirmware: string;
  pid: number;
  profileCount: number;
  profileId: number;
  names: number[][];
  stages: Array<{ x: number; y: number }>;
  active: number;
  splitDpi: boolean;
  colors: number[];
  polling: number;
  lod: number;
  sleep: number;
  angle: number;
  motionSync: number;
  hyperMode: number;
  trackingMode: number;
  spdt: { left: number; right: number };
  scroll: number;
  timings: number[];
  buttons: Map<number, { functionId: number; data: number[] }>;
  macros: Map<number, { name: number[]; bytes: number[] }>;
}

function fakeDevice(pid = 0x0136) {
  const state: FakeState = {
    firmware: "1.0.2.16",
    dongleFirmware: "0.0.1.7",
    pid,
    profileCount: 4,
    profileId: 2,
    names: [[0xb2, 0xe2, 0xca, 0xd4], [..."Profile 2"].map((char) => char.charCodeAt(0)), [..."Profile 3"].map((char) => char.charCodeAt(0)), [..."Profile 4"].map((char) => char.charCodeAt(0))],
    stages: [{ x: 400, y: 400 }, { x: 800, y: 800 }, { x: 1600, y: 1600 }, { x: 3200, y: 3200 }],
    active: 2,
    splitDpi: false,
    colors: [
      0xff, 0x44, 0x44, 0x33, 0xcc, 0x66, 0x0a, 0x0a, 0xff, 0xff, 0xaa, 0x00,
      0, 0, 0, 0, 0, 0,
    ],
    polling: 1,
    lod: 0x87,
    sleep: 30,
    angle: 0,
    motionSync: 0,
    hyperMode: 1,
    trackingMode: 0,
    spdt: { left: 1, right: 1 },
    scroll: 0,
    timings: [0, 5, 20, 20],
    buttons: new Map([
      [1, { functionId: 1, data: [1] }],
      [2, { functionId: 1, data: [2] }],
      [3, { functionId: 1, data: [3] }],
      [5, { functionId: 1, data: [5] }],
      [4, { functionId: 1, data: [4] }],
      [0x14, { functionId: 7, data: [6] }],
    ]),
    macros: new Map(),
  };
  const sent: Uint8Array[] = [];
  const listeners = new Set<(event: HIDInputReportEvent) => void>();
  let pending = new Uint8Array(64);
  let prefix = false;

  const payload = (out: Uint8Array, values: readonly number[]): void => out.set(values, 6);
  const word = (value: number): [number, number] => [value >> 8, value & 0xff];
  const dword = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const at = (out: Uint8Array, offset: number): number => out[offset] ?? 0;
  const wordAt = (out: Uint8Array, offset: number): number => (at(out, offset) << 8) | at(out, offset + 1);
  const dwordAt = (out: Uint8Array, offset: number): number =>
    (at(out, offset) * 0x1000000) + (at(out, offset + 1) << 16) + (at(out, offset + 2) << 8) + at(out, offset + 3);

  const answer = (request: Uint8Array): Uint8Array => {
    const out = new Uint8Array(64);
    out[0] = 0xa1;
    out[3] = request[3] ?? 0;
    out[4] = request[4] ?? 0;
    out[5] = request[5] ?? 0;
    const commandClass = request[4] ?? 0;
    const command = request[5] ?? 0;
    if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.firmware) {
      const version = request[2] === 0 ? state.dongleFirmware : state.firmware;
      payload(out, version.split(".").map(Number));
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.battery) {
      payload(out, [1, 88]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.signal) {
      payload(out, [1, 200]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.devicePid) {
      payload(out, [0, 0, 0x37, 0x70, ...word(state.pid)]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.profileList) {
      payload(out, [state.profileCount]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.profileGet) {
      payload(out, [state.profileId]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.profileSet) {
      state.profileId = at(request, 6);
      payload(out, [state.profileId]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.profileNameGet) {
      const id = at(request, 6);
      const name = state.names[id - 1] ?? [];
      payload(out, [id, name.length, ...name]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.profileNameSet) {
      const id = at(request, 6);
      const length = at(request, 7);
      state.names[id - 1] = [...request.slice(8, 8 + length)];
      payload(out, [id, length, ...state.names[id - 1]!]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.dpiStagesGet) {
      payload(out, [state.profileId, state.stages.length, ...state.stages.flatMap((stage) => [...word(stage.x), ...word(stage.y)])]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.dpiStagesSet) {
      const count = at(request, 7);
      state.stages = Array.from({ length: count }, (_, index) => {
        const offset = 8 + index * 4;
        return { x: wordAt(request, offset), y: wordAt(request, offset + 2) };
      });
      payload(out, [state.profileId, count, ...state.stages.flatMap((stage) => [...word(stage.x), ...word(stage.y)])]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.dpiStageGet) {
      payload(out, [state.profileId, state.active]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.dpiStageSet) {
      state.active = at(request, 7);
      payload(out, [state.profileId, state.active]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.pollingGet) {
      payload(out, [state.profileId, state.polling]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.pollingSet) {
      state.polling = at(request, 7);
      payload(out, [state.profileId, state.polling]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.liftOffGet) {
      payload(out, [state.profileId, state.lod]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.liftOffSet) {
      state.lod = at(request, 7);
      payload(out, [state.profileId, state.lod]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.splitDpiGet) {
      payload(out, [state.profileId, state.splitDpi ? 1 : 0]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.splitDpiSet) {
      state.splitDpi = at(request, 7) === 1;
      payload(out, [state.profileId, state.splitDpi ? 1 : 0]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.angleGet) {
      payload(out, [state.profileId, state.angle]);
    } else if (commandClass === 1 && command === HITSCAN_XVI_COMMAND.angleSet) {
      state.angle = at(request, 7);
      payload(out, [state.profileId, state.angle]);
    } else if (commandClass === 1 && [HITSCAN_XVI_COMMAND.motionSyncGet, HITSCAN_XVI_COMMAND.hyperModeGet, HITSCAN_XVI_COMMAND.trackingModeGet].includes(command)) {
      const value = command === HITSCAN_XVI_COMMAND.motionSyncGet
        ? state.motionSync
        : command === HITSCAN_XVI_COMMAND.hyperModeGet ? state.hyperMode : state.trackingMode;
      payload(out, [state.profileId, value]);
    } else if (commandClass === 1 && [HITSCAN_XVI_COMMAND.motionSyncSet, HITSCAN_XVI_COMMAND.hyperModeSet, HITSCAN_XVI_COMMAND.trackingModeSet].includes(command)) {
      const value = at(request, 7);
      if (command === HITSCAN_XVI_COMMAND.motionSyncSet) state.motionSync = value;
      else if (command === HITSCAN_XVI_COMMAND.hyperModeSet) state.hyperMode = value;
      else state.trackingMode = value;
      payload(out, [state.profileId, value]);
    } else if (commandClass === 2 && command === HITSCAN_XVI_COMMAND.colorsGet) {
      payload(out, [state.profileId, ...state.colors]);
    } else if (commandClass === 2 && command === HITSCAN_XVI_COMMAND.colorsSet) {
      state.colors = [...request.slice(7, 7 + 18)];
      payload(out, [state.profileId, ...state.colors]);
    } else if (commandClass === 3 && command === HITSCAN_XVI_COMMAND.spdtGet) {
      payload(out, [state.profileId, state.spdt.left, state.spdt.right]);
    } else if (commandClass === 3 && command === HITSCAN_XVI_COMMAND.spdtSet) {
      state.spdt = { left: at(request, 7), right: at(request, 8) };
      payload(out, [state.profileId, state.spdt.left, state.spdt.right]);
    } else if (commandClass === 3 && command === HITSCAN_XVI_COMMAND.buttonGet) {
      const profileId = at(request, 6);
      const id = at(request, 7);
      const binding = state.buttons.get(id) ?? { functionId: 0, data: [] };
      payload(out, [profileId, id, 0, binding.functionId, binding.data.length, ...binding.data]);
    } else if (commandClass === 3 && command === HITSCAN_XVI_COMMAND.buttonSet) {
      const profileId = at(request, 6);
      const id = at(request, 7);
      const functionId = at(request, 9);
      const length = at(request, 10);
      state.buttons.set(id, { functionId, data: [...request.slice(11, 11 + length)] });
      payload(out, [profileId, id, 0, functionId, length, ...request.slice(11, 11 + length)]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.scrollHighPerformanceGet) {
      payload(out, [state.profileId, state.scroll]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.scrollHighPerformanceSet) {
      state.scroll = at(request, 7);
      payload(out, [state.profileId, state.scroll]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.timingsGet) {
      payload(out, [state.profileId, ...state.timings, 3]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.timingsSet) {
      state.timings = [...request.slice(7, 11)];
      payload(out, [state.profileId, ...state.timings, 3]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.sleepGet) {
      payload(out, [state.profileId, ...word(state.sleep)]);
    } else if (commandClass === 0 && command === HITSCAN_XVI_COMMAND.sleepSet) {
      state.sleep = wordAt(request, 7);
      payload(out, [state.profileId, ...word(state.sleep)]);
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroList) {
      const ids = [...state.macros.keys()].sort((left, right) => left - right);
      payload(out, [...word(ids.length), 0, 0, ...ids.flatMap(word)]);
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroSize) {
      const id = wordAt(request, 6);
      const macro = state.macros.get(id);
      payload(out, [...word(id), ...dword(macro?.bytes.length ?? 0)]);
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroAllocate) {
      const id = wordAt(request, 6);
      const size = dwordAt(request, 8);
      const macro = state.macros.get(id) ?? { name: [], bytes: [] };
      macro.bytes = Array.from({ length: size }, (_, index) => macro.bytes[index] ?? 0);
      state.macros.set(id, macro);
      payload(out, word(id));
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroDataSet) {
      const id = wordAt(request, 6);
      const offset = dwordAt(request, 8);
      const length = at(request, 12);
      const macro = state.macros.get(id) ?? { name: [], bytes: [] };
      request.slice(13, 13 + length).forEach((byte, index) => { macro.bytes[offset + index] = byte; });
      state.macros.set(id, macro);
      payload(out, word(id));
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroDataGet) {
      const id = wordAt(request, 6);
      const offset = dwordAt(request, 8);
      const length = at(request, 12);
      const macro = state.macros.get(id);
      const chunk = Array.from({ length }, (_, index) => macro?.bytes[offset + index] ?? 0);
      payload(out, [...word(id), ...dword(offset), length, ...chunk]);
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroNameGet) {
      const id = at(request, 6);
      const name = state.macros.get(id)?.name ?? [];
      payload(out, [id, name.length, ...name]);
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroNameSet) {
      const id = at(request, 6);
      const length = at(request, 7);
      const macro = state.macros.get(id) ?? { name: [], bytes: [] };
      macro.name = [...request.slice(8, 8 + length)];
      state.macros.set(id, macro);
      payload(out, [id, length, ...macro.name]);
    } else if (commandClass === 4 && command === HITSCAN_XVI_COMMAND.macroDelete) {
      const id = wordAt(request, 6);
      state.macros.delete(id);
      payload(out, word(id));
    }
    return out;
  };

  const device = {
    vendorId: HITSCAN_XVI_VENDOR_ID,
    productId: pid,
    productName: "Hitscan Hyperlight X",
    opened: false,
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      type: 1,
      children: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      inputReports: [{ reportId: 4, items: [{ reportSize: 8, reportCount: 16 }] }],
      outputReports: [],
    }],
    async open() { device.opened = true; },
    async close() { device.opened = false; },
    async sendFeatureReport(_reportId: number, data: Uint8Array) {
      sent.push(Uint8Array.from(data));
      pending = answer(Uint8Array.from(data));
    },
    async receiveFeatureReport() {
      const bytes = prefix ? Uint8Array.of(0, ...pending) : pending;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    addEventListener(type: string, listener: (event: HIDInputReportEvent) => void) {
      if (type === "inputreport") listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: HIDInputReportEvent) => void) {
      if (type === "inputreport") listeners.delete(listener);
    },
  };

  return {
    device: device as unknown as HIDDevice,
    state,
    sent,
    setPrefixReplies(value: boolean) { prefix = value; },
    emit(bytes: number[]) {
      const data = Uint8Array.from(bytes);
      const event = { reportId: 4, device, data: new DataView(data.buffer) } as unknown as HIDInputReportEvent;
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

test("the web-protocol interface goes to the XVi client, not the native Utility one", () => {
  const { device } = fakeDevice();
  assert.ok(HitscanXviHidClient.isSupported(device));
  assert.ok(!HitscanHidClient.isSupported(device));
  const client = createSupportedClient(device);
  assert.ok(client instanceof HitscanXviHidClient);
  if (client) assert.equal(deviceBrand(client), "Hitscan");
});

test("readStatus decodes the full control.hitscan.com settings surface", async () => {
  const fake = fakeDevice();
  const client = new HitscanXviHidClient(fake.device);
  const status = await client.readStatus();
  assert.equal(status.brand, "Hitscan");
  assert.equal(status.name, "Hitscan Hyperlight X");
  assert.equal(status.firmware?.[0], "Mouse 1.0.2.16");
  assert.equal(status.batteryPercent, 88);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.dpi, 800);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 3200]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [500, 1000, 2000, 4000, 8000]);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.sleepTimeout, 30);
  assert.equal(status.angleTuning, 0);
  assert.equal(status.motionSync, false);
  assert.equal(status.hyperMode, true);
  assert.equal(status.hitscanCompetitiveMode, false);
  assert.deepEqual(status.hitscanSpdt, { left: true, right: true });
  assert.deepEqual(status.hitscanClickTimings, { beforePress: 0, beforeRelease: 5, afterPress: 20, afterRelease: 20 });
  assert.equal(status.hitscanTournamentScroll, false);
  assert.equal(status.activeProfile, 2);
  assert.equal(status.profileCount, 4);
  assert.equal(status.profileNames?.[0], "测试");
  assert.equal(status.buttonMappings?.Left, "Left Click");
  assert.equal(status.buttonMappings?.DPI, "DPI Loop");
  assert.deepEqual(status.fixedButtons, []);
  assert.equal(status.signalStrength, null);
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.dpiStageColors?.slice(0, 2), ["#ff4444", "#33cc66"]);
  await client.close();
});

test("a receiver queries the paired mouse id and dongle firmware", async () => {
  const fake = fakeDevice(0x0300);
  fake.state.pid = 0x0194;
  const status = await new HitscanXviHidClient(fake.device).readStatus();
  assert.equal(status.name, "Hitscan Hyperlight N");
  assert.equal(status.connectionType, "Wireless");
  assert.ok(status.firmware?.includes("Dongle 0.0.1.7"));
  assert.equal(status.signalStrength, 4);
});

test("setters write and read back every exposed control", async () => {
  const fake = fakeDevice();
  const client = new HitscanXviHidClient(fake.device);
  await client.readStatus();
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(fake.state.stages[1]?.x, 1600);
  assert.equal(fake.state.stages[1]?.y, 1600);
  assert.equal(await client.setPollingRate(8000), 8000);
  assert.equal(fake.state.polling, 128);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(fake.state.lod, 2);
  assert.equal(await client.setSleepTimeout(null), null);
  assert.equal(fake.state.sleep, 0xffff);
  assert.equal(await client.setMotionSync(true), true);
  assert.equal(fake.state.motionSync, 1);
  assert.equal(await client.setHyperMode(false), false);
  assert.equal(fake.state.hyperMode, 0);
  assert.equal(await client.setTrackingMode(true), true);
  assert.equal(fake.state.trackingMode, 1);
  assert.deepEqual(await client.setSpdt(true, false), { left: true, right: false });
  assert.equal(fake.state.spdt.right, 0);
  assert.equal(await client.setScrollHighPerformance(true), true);
  assert.equal(fake.state.scroll, 1);
  assert.deepEqual(
    await client.setClickTimings({ beforePress: 2, beforeRelease: 6, afterPress: 25, afterRelease: 30 }),
    { beforePress: 2, beforeRelease: 6, afterPress: 25, afterRelease: 30 },
  );
  assert.equal(await client.setSeparateDpiAxes(true), true);
  assert.equal(fake.state.splitDpi, true);
  assert.equal(await client.setDpiStageColor(0, "#00ff88"), "#00ff88");
  assert.deepEqual(fake.state.colors.slice(0, 3), [0, 0xff, 0x88]);
  await client.close();
});

test("profile selection, naming and button remapping verify on the device", async () => {
  const fake = fakeDevice();
  const client = new HitscanXviHidClient(fake.device);
  await client.readStatus();
  assert.equal(await client.setActiveProfile(3), 3);
  assert.equal(fake.state.profileId, 3);
  assert.equal(await client.renameProfile(3, "Aim"), "Aim");
  assert.deepEqual(fake.state.names[2], [65, 105, 109]);
  await client.setButtonMapping("Forward", "DPI+");
  assert.deepEqual(fake.state.buttons.get(5), { functionId: 7, data: [1] });
  await assert.rejects(() => client.setButtonMapping("Left", "Disable"), /left button/);
  await client.close();
});

test("macro library reads, writes and deletes through the chunked storage commands", async () => {
  const fake = fakeDevice();
  const client = new HitscanXviHidClient(fake.device);
  const events = [
    { type: "down" as const, key: "KeyA" },
    { type: "delay" as const, ms: 12 },
    { type: "up" as const, key: "KeyA" },
  ];
  const macro = await client.writeMacro({ name: "Test", events });
  assert.equal(macro.id, 1);
  assert.equal(macro.name, "Test");
  assert.deepEqual(macro.events, events);
  assert.deepEqual([...macro.bytes], [2, 4, 0x20, 12, 3, 4]);
  const macros = await client.readMacros();
  assert.equal(macros.length, 1);
  fake.state.buttons.set(1, { functionId: 16, data: [0, 1, 1] });
  await assert.rejects(() => client.deleteMacro(1), /still assigned/);
  fake.state.buttons.set(1, { functionId: 1, data: [1] });
  await client.deleteMacro(1);
  assert.equal(fake.state.macros.size, 0);
  await client.close();
});

test("notification reports decode into typed updates", async () => {
  const fake = fakeDevice();
  const received: HitscanXviNotification[] = [];
  const client = new HitscanXviHidClient(fake.device, { onNotification: (notification) => received.push(notification) });
  assert.equal(client.startNotifications(), true);
  fake.emit([3, 75, 0]);
  fake.emit([0x19, 190, 2]);
  fake.emit([6, 0]);
  assert.deepEqual(received[0], { type: "battery", percent: 75, charging: false });
  assert.deepEqual(received[1], { type: "signal", level: 2, rssi: 190 });
  assert.deepEqual(received[2], { type: "sleep" });
  await client.close();
  assert.equal(fake.listenerCount(), 0);
});

test("a 65-byte reply with a leading report id still decodes", async () => {
  const fake = fakeDevice();
  fake.setPrefixReplies(true);
  const status = await new HitscanXviHidClient(fake.device).readStatus();
  assert.equal(status.dpi, 800);
});
