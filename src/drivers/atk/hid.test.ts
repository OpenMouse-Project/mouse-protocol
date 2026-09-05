import assert from "node:assert/strict";
import test from "node:test";

import { atkPackDpiStage } from "@openmouse/protocol/atk";
import { AtkHidClient } from "./hid.ts";
import { PulsarHidClient } from "../pulsar/pulsar-hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";
import { SUPPORTED_HID_FILTERS } from "../vendors.ts";

type Sent = { reportId: number; data: Uint8Array };

/**
 * Minimal controllable stand-in for an ATK/VXE config interface: it records outgoing frames
 * and answers each incoming read with the next queued reply, dispatching the
 * input report on an idle callback so the driver's exchange promise resolves.
 */
class FakeAtkDevice {
  vendorId = 0x373b;
  productId = 0x1085;
  productName = "Wireless mouse -1k dongle";
  opened = false;
  collections = [{
    usagePage: 0xff02,
    usage: 0x0002,
    children: [],
    featureReports: [],
    inputReports: [],
    outputReports: [],
  }];

  readonly sent: Sent[] = [];
  replies: number[][] = [];
  identifyFailures = 0;
  ignoredCommands = new Set<number>();
  private listeners = new Set<(event: HIDInputReportEvent) => void>();

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async forget(): Promise<void> {}

  addEventListener(
    type: string,
    listener: (event: HIDInputReportEvent) => void,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "inputreport") this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: HIDInputReportEvent) => void,
    _options?: boolean | EventListenerOptions,
  ): void {
    if (type === "inputreport") this.listeners.delete(listener);
  }

  async sendReport(reportId: number, data: ArrayBuffer): Promise<void> {
    const frame = new Uint8Array(data);
    this.sent.push({ reportId, data: frame });
    // EEPROM writes (0x07) are fire-and-forget; read and informational
    // commands (0x04 battery, 0x08 EEPROM, 0x10 identity, 0x12 version) get a reply.
    if (frame[0] === 0x07) return;
    if (frame[0] === 0x10 && this.identifyFailures > 0) {
      this.identifyFailures -= 1;
      throw new Error("mouse asleep");
    }
    if (this.ignoredCommands.has(frame[0]!)) return;
    const reply = this.replies.shift();
    if (!reply) return;
    const payload = new Uint8Array(reply);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ reportId, data: new DataView(payload.buffer) } as HIDInputReportEvent);
      }
    });
  }

  async sendFeatureReport(_reportId: number, _data: ArrayBuffer): Promise<void> {
    throw new Error("not used by the ATK driver");
  }

  async receiveFeatureReport(_reportId: number): Promise<DataView> {
    throw new Error("not used by the ATK driver");
  }
}

function device(productId = 0x1085, productName = "Wireless mouse -1k dongle"): HIDDevice {
  const fake = new FakeAtkDevice();
  fake.productId = productId;
  fake.productName = productName;
  return fake as unknown as HIDDevice;
}

/** 16-byte EEPROM read reply for address 0x0070 carrying the given data row. */
function readReply(row: number[]): number[] {
  const frame = [0x08, 0x00, 0x00, 0x70, 0x04, ...row, 0, 0, 0, 0, 0, 0, 0];
  sealReply(frame);
  return frame;
}

/** 16-byte read reply echoing `data` at the given EEPROM address. */
function reply(cmd: number, address: number, data: number[]): number[] {
  const frame = [cmd, 0x00, (address >> 8) & 0xff, address & 0xff, data.length, ...data];
  while (frame.length < 16) frame.push(0x00);
  sealReply(frame);
  return frame;
}

function sealReply(frame: number[]): void {
  frame[15] = (0x55 - 0x08 - frame.slice(0, 15).reduce((total, byte) => total + byte, 0)) & 0xff;
}

function wrote(fake: HIDDevice): Uint8Array {
  const write = (fake as unknown as FakeAtkDevice).sent.find(({ reportId, data }) =>
    reportId === 8 && data[0] === 0x07);
  assert.ok(write, "expected a write frame");
  return write!.data;
}

function assertR1LiveSettingsWrite(fake: HIDDevice, selector: number, value: number): void {
  const write = wrote(fake);
  assert.equal(write[2], 0x00);
  assert.equal(write[3], 0x70, "live-settings register");
  assert.equal(write[4], 0x04);
  assert.equal(write[5], selector);
  assert.equal(write[6], value);
  assert.equal(write[7], 0x00);
  assert.equal(write[8], 0x55 - value, "0x55 - value");
  assert.equal(sumFrame(8, write), 0x55, "frame checksum");
}

function sumFrame(reportId: number, payload: Uint8Array): number {
  let sum = reportId;
  for (const byte of payload) sum += byte & 0xff;
  return sum & 0xff;
}

function button(keyClass: number, value1: number, value2 = 0): number[] {
  return [keyClass, value1, value2, (0x55 - keyClass - value1 - value2) & 0xff];
}

test("support is limited to 0x373b with the vendor config collection", () => {
  assert.equal(AtkHidClient.isSupported(device(0x1085)), true);
  assert.equal(AtkHidClient.isSupported(device(0x11d5, "ATK dongle")), true);
  assert.equal(AtkHidClient.isSupported({ ...device(), vendorId: 0x1234 }), false);
});

test("R1 SE+ transports are claimed without overlapping the Pulsar fallback", () => {
  const wired = device(0xf58f, "VXE R1SE+");
  Object.assign(wired, { vendorId: 0x3554 });
  const collection = wired.collections[0]!;
  collection.inputReports = [{ reportId: 0x08, items: [] }];
  collection.outputReports = [{ reportId: 0x08, items: [] }];
  const receiver = device(0xf58e, "VXE Mouse 1K Dongle");
  Object.assign(receiver, { vendorId: 0x3554 });

  assert.equal(AtkHidClient.isSupported(wired), true);
  assert.equal(AtkHidClient.isSupported(receiver), true);
  assert.equal(PulsarHidClient.isSupported(wired), false);
  assert.equal(PulsarHidClient.isSupported(receiver), false);
  assert.ok(createSupportedClient(wired) instanceof AtkHidClient);
  assert.ok(createSupportedClient(receiver) instanceof AtkHidClient);
  assert.equal(SUPPORTED_HID_FILTERS.some((filter) =>
    filter.vendorId === 0x3554 && filter.productId === 0xf58f
      && filter.usagePage === 0xff02 && filter.usage === 2), true);
  assert.equal(SUPPORTED_HID_FILTERS.some((filter) =>
    filter.vendorId === 0x3554 && filter.productId === 0xf58e
      && filter.usagePage === 0xff02 && filter.usage === 2), true);
});

test("R1 receiver advertises only its stock polling rates", () => {
  const wlmouseStyle = new AtkHidClient(device(0x1085));
  const compxReceiverDevice = device(0xf58e, "VXE Mouse 1K Dongle");
  Object.assign(compxReceiverDevice, { vendorId: 0x3554 });
  const compxReceiver = new AtkHidClient(compxReceiverDevice);
  const notR1 = new AtkHidClient(device(0x11d5, "ATK dongle"));

  assert.deepEqual(wlmouseStyle.getSupportedPollingRates(), [250, 500, 1000]);
  assert.deepEqual(compxReceiver.getSupportedPollingRates(), [250, 500, 1000]);
  assert.deepEqual(notR1.getSupportedPollingRates(), [125, 250, 500, 1000, 2000, 4000, 8000]);
});

test("the COMPX receiver is wireless even without a product string", () => {
  const receiver = device(0xf58e, "");
  Object.assign(receiver, { vendorId: 0x3554 });
  assert.equal(new AtkHidClient(receiver).isWireless(), true);
});

test("wired R1 SE+ advertises its HUB polling, debounce, and sleep options", () => {
  const wired = device(0xf58f, "VXE R1SE+");
  Object.assign(wired, { vendorId: 0x3554 });
  const client = new AtkHidClient(wired);

  assert.deepEqual(client.getSupportedPollingRates(), [125, 250, 500, 1000]);
  assert.deepEqual(client.getDebounceOptions(), [0, 1, 2, 4, 8, 15, 20]);
  assert.deepEqual(client.getSleepOptions(), [30, 60, 120, 180, 300, 1200, 1500, 1800]);
});

test("wired R1 reads the active profile and six lossless button records", async () => {
  const fake = device(0xf58f, "VXE R1SE+");
  Object.assign(fake, { vendorId: 0x3554 });
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0, [0x02, 0x20]),
    reply(0x0e, 0, [0x02]),
    reply(0x08, 0x0060, [...button(1, 1), ...button(1, 2)]),
    reply(0x08, 0x0068, [...button(1, 4), ...button(1, 8)]),
    reply(0x08, 0x0070, [...button(1, 16), ...button(9, 1)]),
  ];

  const stored = await new AtkHidClient(fake).readR1StoredConfiguration();
  assert.equal(stored.activeProfile, 3);
  assert.deepEqual(stored.buttons.map(({ id, action, checksumValid }) => ({ id, action, checksumValid })), [
    { id: "left", action: "Left click", checksumValid: true },
    { id: "right", action: "Right click", checksumValid: true },
    { id: "middle", action: "Middle click", checksumValid: true },
    { id: "back", action: "Back", checksumValid: true },
    { id: "forward", action: "Forward", checksumValid: true },
    { id: "bottom", action: "Profile control (0x01, 0x00)", checksumValid: true },
  ]);
  assert.deepEqual((fake as unknown as FakeAtkDevice).sent.map(({ data }) => data[0]), [0x10, 0x0e, 0x08, 0x08, 0x08]);
});

test("wired R1 switches configuration banks with readback", async () => {
  const fake = device(0xf58f, "VXE R1SE+");
  Object.assign(fake, { vendorId: 0x3554 });
  const transport = fake as unknown as FakeAtkDevice;
  transport.ignoredCommands.add(0x0f);
  transport.replies = [reply(0x10, 0, [2, 32]), reply(0x0e, 0, [2])];

  assert.equal(await new AtkHidClient(fake).setR1ActiveProfile(3), 3);
  const selection = transport.sent.find(({ data }) => data[0] === 0x0f)?.data;
  assert.ok(selection);
  assert.deepEqual([...selection!.subarray(0, 7)], [0x0f, 0, 0, 0, 1, 2, 0]);
  assert.equal(sumFrame(8, selection!), 0x55);
});

test("R1 receiver telemetry reads online identity and pairing countdown without entering pairing", async () => {
  const fake = device();
  const online = reply(0x03, 0, [1, 0xaa, 0xbb, 0xcc]);
  // The Nordic 0xf58e receiver declares only the status byte while retaining
  // its fixed-position RF identifier in the following frame bytes.
  online[4] = 1;
  sealReply(online);
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0, [0x02, 0x20]),
    online,
    reply(0x06, 0, [2, 29]),
  ];

  assert.deepEqual(await new AtkHidClient(fake).readR1ReceiverInfo(), {
    online: true,
    status: 1,
    rfId: "CCBBAA",
    pairingStatus: 2,
    pairingSecondsRemaining: 29,
  });
  assert.deepEqual((fake as unknown as FakeAtkDevice).sent.map(({ data }) => data[0]), [0x10, 0x03, 0x06]);
  assert.equal((fake as unknown as FakeAtkDevice).sent.some(({ data }) => data[0] === 0x05), false);
});

test("R1 receiver pairing sends the verified R1 SE+ identity", async () => {
  const fake = device(0xf58e, "VXE Mouse 1K Dongle");
  Object.assign(fake, { vendorId: 0x3554 });
  const transport = fake as unknown as FakeAtkDevice;
  transport.replies = [reply(0x10, 0, [0x02, 0x20]), reply(0x05, 0, [])];

  await new AtkHidClient(fake).startR1ReceiverPairing(0x02, 0x20);

  const request = transport.sent.find(({ data }) => data[0] === 0x05)?.data;
  assert.ok(request);
  assert.deepEqual([...request!.subarray(0, 8)], [0x05, 0, 0, 0, 2, 0x02, 0x20, 0]);
  assert.equal(sumFrame(8, request!), 0x55);
});

test("R1 inspection rejects unsuccessful and corrupt command replies", async () => {
  const failedProfile = device(0xf58f, "VXE R1SE+");
  Object.assign(failedProfile, { vendorId: 0x3554 });
  const failed = reply(0x0e, 0, [0]);
  failed[1] = 1;
  sealReply(failed);
  (failedProfile as unknown as FakeAtkDevice).replies = [reply(0x10, 0, [2, 32]), failed];
  await assert.rejects(new AtkHidClient(failedProfile).readR1StoredConfiguration(), /did not answer/);

  const corruptReceiver = device();
  const corrupt = reply(0x03, 0, [1, 0xaa, 0xbb, 0xcc]);
  corrupt[15] ^= 0xff;
  (corruptReceiver as unknown as FakeAtkDevice).replies = [reply(0x10, 0, [2, 32]), corrupt];
  await assert.rejects(new AtkHidClient(corruptReceiver).readR1ReceiverInfo(), /did not answer/);

  const corruptButtons = device(0xf58f, "VXE R1SE+");
  Object.assign(corruptButtons, { vendorId: 0x3554 });
  const corruptButtonGroup = reply(0x08, 0x0060, [...button(1, 1), ...button(1, 2)]);
  corruptButtonGroup[15] ^= 0xff;
  (corruptButtons as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0, [2, 32]),
    reply(0x0e, 0, [0]),
    corruptButtonGroup,
  ];
  await assert.rejects(new AtkHidClient(corruptButtons).readR1StoredConfiguration(), /did not answer/);

  const otherR1 = device(0xf58f, "VXE R1");
  Object.assign(otherR1, { vendorId: 0x3554 });
  (otherR1 as unknown as FakeAtkDevice).replies = [reply(0x10, 0, [2, 12])];
  await assert.rejects(new AtkHidClient(otherR1).setR1ActiveProfile(2), /verified wired transport/);
  assert.equal((otherR1 as unknown as FakeAtkDevice).sent.some(({ data }) => data[0] === 0x0f), false);

  const corruptColor = device(0xf58f, "VXE R1SE+");
  Object.assign(corruptColor, { vendorId: 0x3554 });
  const invalidGroup = reply(0x08, 0x002c, [1, 2, 3, 4, 5, 6, 7, 8]);
  invalidGroup[15] ^= 0xff;
  (corruptColor as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0, [2, 32]),
    reply(0x08, 0, [1, 0x54, 2, 0x53, 0, 0x55]),
    invalidGroup,
  ];
  await assert.rejects(new AtkHidClient(corruptColor).setDpiStageColor(0, "#112233"), /did not answer/);
  assert.equal((corruptColor as unknown as FakeAtkDevice).sent.some(({ data }) => data[0] === 0x07), false);
});

test("R1 setPollingRate writes the 0x0070 live-settings row", async () => {
  const fake = device(0x1085);
  (fake as unknown as FakeAtkDevice).replies = [readReply([0x0b, 0x02, 0x00, 0x53])];
  const client = new AtkHidClient(fake);

  assert.equal(await client.setPollingRate(500), 500);

  const writes = (fake as unknown as FakeAtkDevice).sent.filter(({ reportId, data }) =>
    reportId === 8 && data[0] === 0x07);
  assert.equal(writes.length, 1);
  const write = writes[0]!.data;
  assert.equal(write[2], 0x00);
  assert.equal(write[3], 0x70);
  assert.equal(write[4], 0x04);
  assert.equal(write[5], 0x0b, "polling selector");
  assert.equal(write[6], 0x02, "500 Hz code");
  assert.equal(write[7], 0x00);
  assert.equal(write[8], 0x53, "0x55 - 0x02");
  assert.equal(sumFrame(8, write), 0x55, "frame checksum");
});

test("R1 polling write is still emitted when the settings row does not echo", async () => {
  const fake = device(0x1085);
  (fake as unknown as FakeAtkDevice).replies = [readReply([0x00, 0x00, 0x00, 0x00])];
  const client = new AtkHidClient(fake);

  const confirmed = await client.setPollingRate(500);
  assert.equal(confirmed, 1000, "falls back to the receiver ceiling on an unknown row");

  const write = (fake as unknown as FakeAtkDevice).sent.find(({ reportId, data }) =>
    reportId === 8 && data[0] === 0x07);
  assert.ok(write, "write should still be sent");
  assert.equal(write!.data[6], 0x02, "500 Hz code");
});

test("R1 setPollingRate rejects rates the dongle cannot do", async () => {
  const client = new AtkHidClient(device(0x1085));
  await assert.rejects(client.setPollingRate(2000), /does not support 2000 Hz/);
});

test("R1 setLiftOffDistance writes the 0x0070 LOD live-settings row", async () => {
  const low = new AtkHidClient(device(0x1085));
  assert.equal(await low.setLiftOffDistance("Low"), "Low");
  assertR1LiveSettingsWrite(low.device, 0x03, 1);

  const high = new AtkHidClient(device(0x1085));
  assert.equal(await high.setLiftOffDistance("High"), "High");
  assertR1LiveSettingsWrite(high.device, 0x03, 2);

  const medium = new AtkHidClient(device(0x1085));
  await assert.rejects(medium.setLiftOffDistance("Medium"), /does not support a medium lift-off distance/);
});

test("R1 setDebounceTime writes the 0x0070 debounce live-settings row", async () => {
  const client = new AtkHidClient(device(0x1085));
  assert.equal(await client.setDebounceTime(4), 4);
  assertR1LiveSettingsWrite(client.device, 0x02, 4);

  const oversized = new AtkHidClient(device(0x1085));
  await assert.rejects(oversized.setDebounceTime(21), /between 1 and 20/);
  const zero = new AtkHidClient(device(0x1085));
  await assert.rejects(zero.setDebounceTime(0), /between 1 and 20/);
});

test("R1 setAngleSnapping writes the 0x0070 angle live-settings row", async () => {
  const on = new AtkHidClient(device(0x1085));
  assert.equal(await on.setAngleSnapping(true), true);
  assertR1LiveSettingsWrite(on.device, 0x01, 0x10);

  const off = new AtkHidClient(device(0x1085));
  assert.equal(await off.setAngleSnapping(false), false);
  assertR1LiveSettingsWrite(off.device, 0x01, 0x00);
});

test("wired R1 writes 125 Hz through the system EEPROM and confirms it", async () => {
  const fake = device(0xf58f, "VXE R1SE+");
  Object.assign(fake, { vendorId: 0x3554 });
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x0000, [0x08, 0x4d, 0x02, 0x53, 0x00, 0x55]),
  ];

  assert.equal(await new AtkHidClient(fake).setPollingRate(125), 125);
  assert.deepEqual(Array.from(wrote(fake).subarray(2, 7)), [0x00, 0x00, 0x02, 0x08, 0x4d]);
});

test("wired R1 persists zero debounce through the advanced EEPROM", async () => {
  const fake = device(0xf58f, "VXE R1SE+");
  Object.assign(fake, { vendorId: 0x3554 });
  const advanced = [0x04, 0x51, 0x00, 0x55, 0x06, 0x4f, 0x00, 0x55, 0x00, 0x55];
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x00a9, advanced),
    reply(0x08, 0x00a9, [0x00, 0x55, ...advanced.slice(2)]),
  ];

  assert.equal(await new AtkHidClient(fake).setDebounceTime(0), 0);
  assert.deepEqual(Array.from(wrote(fake).subarray(2, 15)), [0x00, 0xa9, 0x0a, 0x00, 0x55, ...advanced.slice(2)]);
});

test("wired R1 persists LOD and straight-line correction through EEPROM", async () => {
  const lod = device(0xf58f, "VXE R1SE+");
  Object.assign(lod, { vendorId: 0x3554 });
  (lod as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x000a, [0x02, 0x53]),
  ];
  assert.equal(await new AtkHidClient(lod).setLiftOffDistance("High"), "High");
  assert.deepEqual(Array.from(wrote(lod).subarray(2, 7)), [0x00, 0x0a, 0x02, 0x02, 0x53]);

  const line = device(0xf58f, "VXE R1SE+");
  Object.assign(line, { vendorId: 0x3554 });
  const advanced = [0x00, 0x55, 0x00, 0x55, 0x06, 0x4f, 0x00, 0x55, 0x00, 0x55];
  (line as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x00a9, advanced),
    reply(0x08, 0x00a9, [...advanced.slice(0, 6), 0x01, 0x54, ...advanced.slice(8)]),
  ];
  assert.equal(await new AtkHidClient(line).setAngleSnapping(true), true);
  assert.deepEqual(Array.from(wrote(line).subarray(5, 15)), [...advanced.slice(0, 6), 0x01, 0x54, ...advanced.slice(8)]);

  const motion = device(0xf58f, "VXE R1SE+");
  Object.assign(motion, { vendorId: 0x3554 });
  (motion as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x00a9, advanced),
    reply(0x08, 0x00a9, [...advanced.slice(0, 2), 0x01, 0x54, ...advanced.slice(4)]),
  ];
  assert.equal(await new AtkHidClient(motion).setMotionSync(true), true);
  assert.deepEqual(Array.from(wrote(motion).subarray(5, 15)), [...advanced.slice(0, 2), 0x01, 0x54, ...advanced.slice(4)]);
});

test("wired R1 edits the active stage and an arbitrary stage value", async () => {
  const activeDevice = device(0xf58f, "VXE R1SE+");
  Object.assign(activeDevice, { vendorId: 0x3554 });
  (activeDevice as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x08, 0x4d, 0x00, 0x55]),
    reply(0x08, 0x0004, [0x07, 0x4e]),
    reply(0x08, 0x0028, [0x25, 0x25, 0x00, 0x0b]),
  ];
  assert.equal(await new AtkHidClient(activeDevice).setActiveDpiStage(7), 7);
  assert.deepEqual(Array.from(wrote(activeDevice).subarray(2, 7)), [0x00, 0x04, 0x02, 0x07, 0x4e]);

  const valueDevice = device(0xf58f, "VXE R1SE+");
  Object.assign(valueDevice, { vendorId: 0x3554 });
  (valueDevice as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x08, 0x4d, 0x00, 0x55]),
    reply(0x08, 0x0028, [0x25, 0x25, 0x00, 0x0b]),
  ];
  assert.equal(await new AtkHidClient(valueDevice).setDpiStageValue(7, 1600), 1600);
  assert.deepEqual(Array.from(wrote(valueDevice).subarray(2, 9)), [0x00, 0x28, 0x04, 0x25, 0x25, 0x00, 0x0b]);
});

test("wired R1 writes performance, long-range, stage color, and DPI lighting", async () => {
  const performance = device(0xf58f, "VXE R1SE+");
  Object.assign(performance, { vendorId: 0x3554 });
  (performance as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x00b5, [0x01, 0x54, 0x0c, 0x49, 0x01, 0x54]),
    reply(0x08, 0x00b5, [0x01, 0x54, 0x0c, 0x49, 0x00, 0x55]),
  ];
  assert.equal(await new AtkHidClient(performance).setPerformanceMode(false), false);

  const longRange = device(0xf58f, "VXE R1SE+");
  Object.assign(longRange, { vendorId: 0x3554 });
  (longRange as unknown as FakeAtkDevice).ignoredCommands.add(0x16);
  (longRange as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x17, 0x0000, [0x01]),
  ];
  assert.equal(await new AtkHidClient(longRange).setLongRangeMode(true), true);
  assert.equal((longRange as unknown as FakeAtkDevice).sent.some(({ data }) => data[0] === 0x16 && data[5] === 1), true);

  const color = device(0xf58f, "VXE R1SE+");
  Object.assign(color, { vendorId: 0x3554 });
  (color as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x02, 0x53, 0x00, 0x55]),
    reply(0x08, 0x002c, [0x04, 0x00, 0xff, 0x52, 0xff, 0x00, 0x00, 0x56]),
    reply(0x08, 0x002c, [0x01, 0x02, 0x03, 0x4f, 0xff, 0x00, 0x00, 0x56]),
  ];
  assert.equal(await new AtkHidClient(color).setDpiStageColor(0, "#010203"), "#010203");

  const lighting = device(0xf58f, "VXE R1SE+");
  Object.assign(lighting, { vendorId: 0x3554 });
  const expectedLighting = [0x02, 0x53, 0xff, 0x56, 0x03, 0x52, 0x01, 0x54];
  (lighting as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x004c, [0x01, 0x54, 0x80, 0xd5, 0x05, 0x50, 0x00, 0x55]),
    reply(0x08, 0x004c, expectedLighting),
  ];
  await new AtkHidClient(lighting).setDpiLighting(2, 2, 1);
  assert.deepEqual(Array.from(wrote(lighting).subarray(5, 13)), expectedLighting);
});

test("wired R1 accepts its exact sleep options before identity is cached", async () => {
  const fake = device(0xf58f, "VXE R1SE+");
  Object.assign(fake, { vendorId: 0x3554 });
  const advanced = [0x00, 0x55, 0x00, 0x55, 0x06, 0x4f, 0x00, 0x55, 0x00, 0x55];
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x08, 0x00a9, advanced),
    reply(0x08, 0x00a9, [...advanced.slice(0, 4), 0x12, 0x43, ...advanced.slice(6)]),
  ];
  assert.equal(await new AtkHidClient(fake).setSleepTimeout(180), 180);
  assert.deepEqual(Array.from(wrote(fake).subarray(9, 11)), [0x12, 0x43]);
});

test("NON-R1 debounce ceiling still applies on the A9 family", () => {
  assert.equal(new AtkHidClient(device(0x1085)).getDebounceMaxMs(), 20);
  assert.equal(new AtkHidClient(device(0x11d5, "ATK dongle")).getDebounceMaxMs(), 15);
});

test("wired R1 SE+ status uses identity, PAW3395SE, and all configured DPI stages", async () => {
  const fake = device(0xf58f, "VXE R1SE+");
  Object.assign(fake, { vendorId: 0x3554 });
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0x02, 0x20]),
    reply(0x04, 0x0000, [0x5f, 0x01]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x02, 0x53, 0x00, 0x55]),
    reply(0x08, 0x000c, [0x12, 0x12, 0x00, 0x31]),
    reply(0x08, 0x0010, [0x25, 0x25, 0x00, 0x0b]),
    reply(0x12, 0x0000, [0x03, 0x15]),
    reply(0x08, 0x000a, [0x01, 0x54]),
    reply(0x08, 0x00a9, [0x00, 0x55, 0x00, 0x55, 0x06, 0x4f, 0x00, 0x55, 0x00, 0x55]),
    reply(0x08, 0x00bd, [0x00, 0x55, 0x00, 0x55]),
    reply(0x08, 0x00b5, [0x01, 0x54, 0x0c, 0x49, 0x01, 0x54]),
    reply(0x08, 0x004c, [0x01, 0x54, 0x80, 0xd5, 0x05, 0x50, 0x00, 0x55]),
    reply(0x08, 0x002c, [0x04, 0x00, 0xff, 0x52, 0xff, 0x00, 0x00, 0x56]),
    reply(0x17, 0x0000, [0x00]),
    reply(0x0e, 0x0000, [0x00]),
    reply(0x08, 0x0060, [...button(1, 1), ...button(1, 2)]),
    reply(0x08, 0x0068, [...button(1, 4), ...button(1, 8)]),
    reply(0x08, 0x0070, [...button(1, 16), ...button(2, 1)]),
  ];
  const client = new AtkHidClient(fake);

  const status = await client.readStatus();
  assert.equal(status.brand, "VXE");
  assert.equal(status.name, "VXE R1 SE+");
  assert.equal(deviceBrand(client), "VXE");
  assert.equal(status.dpi, 800);
  assert.deepEqual(status.dpiStages, [800, 1600]);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.activeProfile, 1);
  assert.equal(status.atkProfileCount, 4);
  assert.equal(status.atkButtonMappings?.length, 6);
  assert.equal(status.ui?.dpiStageEditor?.maxStages, 8);
  assert.equal(status.batteryPercent, 95);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.batteryVoltageMv, null);
  assert.deepEqual(status.firmware, ["Mouse 3.15"]);
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.debounceMs, 0);
  assert.equal(status.motionSync, false);
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.angleTuning, 0);
  assert.equal(status.performanceMode, true);
  assert.equal(status.longRangeMode, false);
  assert.deepEqual(status.dpiStageColors, ["#0400ff", "#ff0000"]);
  assert.equal(status.dpiLedMode, 0);
  assert.equal(status.dpiLedBrightness, 1);
  assert.equal(status.dpiLedSpeed, 2);
});

test("R1 receiver readStatus fails before fallback decoding when CID/MID times out", async () => {
  const fake = device(0x1085);
  const client = new AtkHidClient(fake);

  await assert.rejects(client.readStatus(), /did not answer CID\/MID; refusing to use the fallback DPI codec/);
  assert.deepEqual((fake as unknown as FakeAtkDevice).sent.map(({ data }) => data[0]), [0x10]);
});

test("wired R1 setDpi fails before fallback writing when CID/MID times out", async () => {
  const fake = device(0xf58f, "VXE R1SE+");
  Object.assign(fake, { vendorId: 0x3554 });
  const raw = fake as unknown as FakeAtkDevice;
  const client = new AtkHidClient(fake);

  await assert.rejects(client.setDpi(800), /did not answer CID\/MID; refusing to use the fallback DPI codec/);
  assert.deepEqual(raw.sent.map(({ data }) => data[0]), [0x10]);
});

test("R1 stays fail-closed after its CID/MID retry budget is exhausted", async () => {
  const fake = device(0x1085);
  const raw = fake as unknown as FakeAtkDevice;
  raw.identifyFailures = 3;
  const client = new AtkHidClient(fake);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(client.setDpi(800), /did not answer CID\/MID; refusing to use the fallback DPI codec/);
  }
  assert.deepEqual(raw.sent.map(({ data }) => data[0]), [0x10, 0x10, 0x10]);
});

test("generic ATK setDpi retains fallback when CID/MID does not answer", async () => {
  const fake = device(0x11d5, "ATK dongle");
  const raw = fake as unknown as FakeAtkDevice;
  raw.ignoredCommands.add(0x10);
  raw.replies = [
    reply(0x08, 0x0000, [0x01, 0x54, 0x01, 0x54, 0x00, 0x55]),
    reply(0x08, 0x000c, atkPackDpiStage(800, 800)),
  ];

  assert.equal(await new AtkHidClient(fake).setDpi(800), 800);
  assert.deepEqual(Array.from(wrote(fake).subarray(5, 9)), atkPackDpiStage(800, 800));
});

test("successful unknown CID/MID uses the generic fallback codec", async () => {
  const fake = device(0x11d5, "ATK dongle");
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0xfe, 0xed]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x01, 0x54, 0x00, 0x55]),
    reply(0x08, 0x000c, atkPackDpiStage(800, 800)),
  ];

  assert.equal(await new AtkHidClient(fake).setDpi(800), 800);
  assert.deepEqual(Array.from(wrote(fake).subarray(5, 9)), atkPackDpiStage(800, 800));
});

test("one-byte battery reply leaves state and voltage unknown", async () => {
  const fake = device(0x11d5, "ATK dongle");
  (fake as unknown as FakeAtkDevice).replies = [
    reply(0x10, 0x0000, [0xfe, 0xed]),
    reply(0x04, 0x0000, [0x5f]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x01, 0x54, 0x00, 0x55]),
    reply(0x08, 0x000c, atkPackDpiStage(800, 800)),
    reply(0x12, 0x0000, [0x01, 0x23]),
    reply(0x08, 0x000a, [0x04, 0x51]),
    reply(0x08, 0x00a9, [0x08, 0x4d, 0x00, 0x55, 0x1e, 0x37, 0x00, 0x55, 0x00, 0x55]),
    reply(0x08, 0x00bd, [0x00, 0x55, 0x00, 0x55]),
  ];

  const status = await new AtkHidClient(fake).readStatus();
  assert.equal(status.batteryPercent, 95);
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.batteryVoltageMv, null);
});
