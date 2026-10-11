import assert from "node:assert/strict";
import test from "node:test";

import { GWolvesHidClient } from "./hid.ts";
import { GWOLVES_COMMAND, gwolvesReportChecksum } from "@openmouse/protocol/gwolves";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

interface FakeOptions {
  productId?: number;
  modelId?: number | null;
  badTrigger?: boolean;
  noDepth?: boolean;
}

function magneticDevice(options: FakeOptions = {}): HIDDevice & { flash: Uint8Array; writes: number[]; calibrations: number; handshakes: number; notify: (left: number, right: number) => void } {
  const flash = new Uint8Array(256);
  const pair = (address: number, value: number): void => { flash[address] = value; flash[address + 1] = (0x55 - value) & 0xff; };
  pair(0xef, 4);
  pair(0xf5, 4);
  pair(0xf1, 0x80 | 3);
  pair(0xf7, 3);
  if (options.badTrigger) { flash[0xef] = 7; flash[0xf0] = 7; }
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const emit = (bytes: Uint8Array): void => listener?.({ reportId: 8, data: new DataView(bytes.buffer) } as HIDInputReportEvent);
  const notify = (left: number, right: number): void => {
    const report = new Uint8Array(16);
    report[0] = 10; report[13] = left; report[14] = right;
    emit(report);
  };
  const state = { writes: [] as number[], calibrations: 0, handshakes: 0 };
  const fake = {
    vendorId: 0x33e4,
    productId: options.productId ?? 0x5219,
    productName: "G-Wolves",
    opened: true,
    flash,
    notify,
    get writes() { return state.writes; },
    get calibrations() { return state.calibrations; },
    get handshakes() { return state.handshakes; },
    collections: [{
      usagePage: 0xff02, usage: 2, children: [], featureReports: [],
      inputReports: [{ reportId: 8, items: [{ reportCount: 16, reportSize: 8 }] }],
      outputReports: [{ reportId: 8, items: [{ reportCount: 16, reportSize: 8 }] }],
    }],
    addEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => { listener = fn; },
    removeEventListener: () => { listener = null; },
    async sendReport(_: number, data: BufferSource) {
      const packet = new Uint8Array(data as ArrayBuffer);
      const reply = new Uint8Array(16);
      reply.set(packet.subarray(0, 5));
      const address = (packet[2]! << 8) | packet[3]!;
      if (packet[0] === GWOLVES_COMMAND.read) reply.set(flash.subarray(address, address + packet[4]!), 5);
      if (packet[0] === GWOLVES_COMMAND.write) { flash.set(packet.subarray(5, 5 + packet[4]!), address); state.writes.push(address); }
      if (packet[0] === GWOLVES_COMMAND.handshake) {
        state.handshakes += 1;
        if (options.modelId === null) return;
        reply[10] = options.modelId ?? 11;
      }
      if (packet[0] === GWOLVES_COMMAND.calibrate) {
        state.calibrations += 1;
        if (!options.noDepth) {
          setTimeout(() => notify(40, 20), 5);
          setTimeout(() => notify(100, 100), 15);
          setTimeout(() => notify(0, 0), 25);
        }
      }
      reply[15] = gwolvesReportChecksum(reply.subarray(0, 15));
      queueMicrotask(() => emit(reply));
    },
  };
  return fake as unknown as HIDDevice & { flash: Uint8Array; writes: number[]; calibrations: number; handshakes: number; notify: (left: number, right: number) => void };
}

test("only the magnetic catalog entry reads magnetic settings over the cable", async () => {
  const pro = await new GWolvesHidClient(magneticDevice()).readStatus();
  assert.equal(pro.name, "G-Wolves HTS Plus Pro");
  assert.deepEqual(pro.magneticButtons?.buttons.map((button) => button.triggerPoint), [5, 5]);
  assert.deepEqual(pro.magneticButtons?.buttons.map((button) => [button.rapidTriggerEnabled, button.rapidTrigger]), [[true, 3], [false, 3]]);
  assert.deepEqual(pro.magneticButtons?.rapidTriggerRange, { min: 1, max: 10 });
  assert.equal(pro.magneticButtons?.calibration, "unknown");

  const htxUltra = await new GWolvesHidClient(magneticDevice({ productId: 0x5618 })).readStatus();
  assert.equal(htxUltra.magneticButtons, undefined);
});

test("the receiver asks which mouse is behind it, and offers trigger point only", async () => {
  const pro = await new GWolvesHidClient(magneticDevice({ productId: 0x3854, modelId: 11 })).readStatus();
  assert.equal(pro.name, "G-Wolves HTS Plus Pro");
  assert.equal(pro.magneticButtons?.rapidTriggerRange, null);
  assert.equal(pro.magneticButtons?.calibration, null);

  const other = await new GWolvesHidClient(magneticDevice({ productId: 0x3854, modelId: 5 })).readStatus();
  assert.equal(other.magneticButtons, undefined);

  const silent = await new GWolvesHidClient(magneticDevice({ productId: 0x3854, modelId: null })).readStatus();
  assert.equal(silent.magneticButtons, undefined);
});

test("a trigger point that fails its pair check is unknown rather than the most sensitive setting", async () => {
  const status = await new GWolvesHidClient(magneticDevice({ badTrigger: true })).readStatus();
  assert.equal(status.magneticButtons?.buttons[0]?.triggerPoint, null);
  assert.equal(status.magneticButtons?.buttons[1]?.triggerPoint, 5);
});

test("the shared receiver identifies Fenrir Pro from MID 9 without enabling magnetic controls", async () => {
  const fake = magneticDevice({ productId: 0x3854, modelId: 9 });
  const client = new GWolvesHidClient(fake);
  const status = await client.readStatus();
  assert.equal(status.name, "G-Wolves Fenrir Pro");
  assert.equal(status.ui?.defaultDisplayName, "G-Wolves Fenrir Pro");
  assert.match(status.ui!.pollingNote!, /Fenrir Pro/);
  assert.equal(status.magneticButtons, undefined);
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.equal((await client.readStatus()).name, "G-Wolves Fenrir Pro");
  assert.equal(fake.handshakes, 1, "identity reuses the existing receiver handshake cache");
  assert.equal(fake.writes.length, 0, "reading the identity writes no settings");
});

test("both HTX Ultra MIDs retain their existing display identity", async () => {
  for (const modelId of [5, 7]) {
    const status = await new GWolvesHidClient(magneticDevice({ productId: 0x3854, modelId })).readStatus();
    assert.equal(status.name, "G-Wolves HTX Ultra");
    assert.equal(status.magneticButtons, undefined);
  }
});

test("an unknown or silent shared receiver is not labelled as an HTX Ultra", async () => {
  for (const modelId of [99, null]) {
    const status = await new GWolvesHidClient(magneticDevice({ productId: 0x3854, modelId })).readStatus();
    assert.equal(status.name, "G-Wolves 8K receiver");
    assert.equal(status.magneticButtons, undefined);
  }
});

test("trigger point and rapid trigger write the stored value with its complement", async () => {
  const fake = magneticDevice();
  const client = new GWolvesHidClient(fake);
  assert.equal(await client.setMagneticTriggerPoint(0, 12), 12);
  assert.deepEqual([...fake.flash.subarray(0xef, 0xf1)], [11, 0x55 - 11]);
  assert.deepEqual(await client.setMagneticRapidTrigger(1, true, 7), { enabled: true, level: 7 });
  assert.deepEqual([...fake.flash.subarray(0xf7, 0xf9)], [0x80 | 7, (0x55 - (0x80 | 7)) & 0xff]);
  await assert.rejects(() => client.setMagneticTriggerPoint(0, 21), /1 to 20/);
  await assert.rejects(() => client.setMagneticRapidTrigger(0, true, 11), /1 to 10/);
});

test("rapid trigger is refused on the receiver", async () => {
  const client = new GWolvesHidClient(magneticDevice({ productId: 0x3854 }));
  await assert.rejects(() => client.setMagneticRapidTrigger(0, true, 3), /cable/);
  await assert.rejects(() => client.calibrateMagneticButtons(() => {}), /cable/);
});

test("calibration finishes after both buttons are pressed fully and released", async () => {
  const fake = magneticDevice();
  const client = new GWolvesHidClient(fake);
  client.calibrationTiming = { settleMs: 1, noReadingsMs: 500, idleMs: 500, maxMs: 2_000 };
  const steps: number[] = [];
  await client.calibrateMagneticButtons((progress) => steps.push(progress.step));
  assert.equal(fake.calibrations, 1);
  assert.equal(steps[0], 1);
  assert.equal(steps.at(-1), 3);
});

test("calibration fails when the mouse sends no press readings", async () => {
  const client = new GWolvesHidClient(magneticDevice({ noDepth: true }));
  client.calibrationTiming = { settleMs: 1, noReadingsMs: 100, idleMs: 100, maxMs: 1_000 };
  await assert.rejects(() => client.calibrateMagneticButtons(() => {}), /No live button readings/);
});

test("live depth reaches listeners and stops after unsubscribing", async () => {
  const fake = magneticDevice();
  const client = new GWolvesHidClient(fake);
  await client.open();
  const seen: Array<[number, number]> = [];
  const stop = client.onButtonDepth((left, right) => seen.push([left, right]));
  fake.notify(40, 0x80 | 12);
  stop();
  fake.notify(10, 10);
  assert.deepEqual(seen, [[40, 12]]);
});
