import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  RYUNIX_COMMAND_REPORT_ID,
  RYUNIX_CONFIG_REPORT_ID,
  RYUNIX_TELEMETRY_REPORT_ID,
  RYUNIX_USAGE,
  RYUNIX_USAGE_PAGE,
  RYUNIX_VENDOR_ID,
  RYUNIX_WIRED_PRODUCT_ID,
  RYUNIX_WIRELESS_PRODUCT_ID,
} from "@openmouse/protocol/ryunix";
import { AMKETTE_XS_BLUETOOTH_PRODUCT_ID, AMKETTE_XS_USAGE } from "@openmouse/protocol/amkette";
import { AmketteXsHidClient, isAmketteDevice, resetAmketteXsWriteState } from "./xs-hid.ts";

beforeEach(() => resetAmketteXsWriteState());

function report(reportId: number): HIDReportInfo {
  return { reportId, items: [] } as unknown as HIDReportInfo;
}

function controlCollection(): HIDCollectionInfo {
  return {
    usagePage: RYUNIX_USAGE_PAGE,
    usage: AMKETTE_XS_USAGE,
    type: 1,
    children: [],
    featureReports: [report(RYUNIX_CONFIG_REPORT_ID), report(RYUNIX_COMMAND_REPORT_ID)],
    inputReports: [report(RYUNIX_TELEMETRY_REPORT_ID)],
    outputReports: [],
  } as unknown as HIDCollectionInfo;
}

interface Sent {
  reportId: number;
  data: Uint8Array;
}

/** Telemetry body: active, DPI stage, rate code, battery, charging, LED mode, -, max rate, sensor. */
const TELEMETRY = [1, 2, 0x02, 73, 0, 0x03, 0, 0x08, 0x20];

function fakeDevice(overrides: Partial<HIDDevice> = {}): {
  device: HIDDevice;
  sent: Sent[];
  featureReads: number[];
  emit(reportId: number, body: ArrayLike<number>): void;
  /** Called after every command with its frame; use it to change what telemetry reports. */
  onCommand(handler: (frame: Uint8Array) => void): void;
  setAck(...acks: number[]): void;
  listenerAttached(): boolean;
} {
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const sent: Sent[] = [];
  const featureReads: number[] = [];
  let commandHandler: (frame: Uint8Array) => void = () => {};
  let acks: number[] = [];
  let telemetry = Uint8Array.from(TELEMETRY);

  const emit = (reportId: number, body: ArrayLike<number>): void => {
    const bytes = Uint8Array.from(body);
    const framed = Uint8Array.of(0xaa, 0xbb, ...bytes, 0xcc);
    if (reportId === RYUNIX_TELEMETRY_REPORT_ID) telemetry = bytes;
    listener?.({
      device,
      reportId,
      data: new DataView(framed.buffer, 2, bytes.length),
    } as HIDInputReportEvent);
  };

  const device = {
    vendorId: RYUNIX_VENDOR_ID,
    productId: RYUNIX_WIRELESS_PRODUCT_ID,
    productName: "",
    opened: false,
    collections: [controlCollection()],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener(_type: string, value: (event: HIDInputReportEvent) => void) { listener = value; },
    removeEventListener(_type: string, value: (event: HIDInputReportEvent) => void) {
      if (listener === value) listener = null;
    },
    async sendFeatureReport(reportId: number, data: BufferSource) {
      const bytes = new Uint8Array(data as ArrayBuffer | ArrayBufferView as ArrayBuffer);
      const copy = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : new Uint8Array(bytes);
      sent.push({ reportId, data: copy });
      commandHandler(copy);
    },
    async receiveFeatureReport(reportId: number) {
      featureReads.push(reportId);
      if (reportId === RYUNIX_CONFIG_REPORT_ID) {
        queueMicrotask(() => emit(RYUNIX_TELEMETRY_REPORT_ID, telemetry));
        return new DataView(new ArrayBuffer(31));
      }
      const ack = acks.length > 0 ? acks.shift()! : 1;
      return new DataView(Uint8Array.of(0, ack).buffer);
    },
    ...overrides,
  } as unknown as HIDDevice;

  return {
    device,
    sent,
    featureReads,
    emit,
    onCommand(handler) { commandHandler = handler; },
    setAck(...values) { acks = values; },
    listenerAttached: () => listener !== null,
  };
}

async function openClient(overrides: Partial<HIDDevice> = {}) {
  const transport = fakeDevice(overrides);
  const client = new AmketteXsHidClient(transport.device);
  await client.open();
  return { transport, client };
}

test("support requires an XS product id and the usage 0x00 configuration collection", () => {
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice().device), true);
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice({ productId: RYUNIX_WIRED_PRODUCT_ID }).device), true);
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice({ productId: AMKETTE_XS_BLUETOOTH_PRODUCT_ID }).device), true);
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice({ productId: 0x1234 }).device), false);
  // The Kyu Pro MX1's usage 0xC7 collection stays with the Ryunix driver, even
  // next to a usage 0x00 one.
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice({
    collections: [{ ...controlCollection(), usage: RYUNIX_USAGE } as HIDCollectionInfo],
  }).device), false);
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice({
    collections: [controlCollection(), { ...controlCollection(), usage: RYUNIX_USAGE } as HIDCollectionInfo],
  }).device), false);
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice({
    collections: [{ ...controlCollection(), usage: 0x01 } as HIDCollectionInfo],
  }).device), false);
  assert.equal(AmketteXsHidClient.isSupported(fakeDevice({
    collections: [{ ...controlCollection(), featureReports: [] } as unknown as HIDCollectionInfo],
  }).device), false);
});

test("Amkette is recognised by name only, never guessed", async () => {
  // Only the labels the firmware and Amkette's configurators use, not retail names.
  assert.equal(isAmketteDevice({ productName: "XS Flow 2 Speed" }), false);
  assert.equal(isAmketteDevice({ productName: "XS speed 2" }), true);
  assert.equal(isAmketteDevice({ productName: "XS Speed" }), true);
  assert.equal(isAmketteDevice({ productName: " xs_flow+ " }), true);
  assert.equal(isAmketteDevice({ productName: "XS Natural+" }), true);
  assert.equal(isAmketteDevice({ productName: "XS Mouse" }), false);
  assert.equal(isAmketteDevice({ productName: "Kyu Pro MX1" }), false);
  assert.equal(isAmketteDevice({ productName: "" }), false);
  assert.equal(isAmketteDevice({ productName: null }), false);

  const named = await openClient({ productName: "XS Speed" } as Partial<HIDDevice>);
  assert.equal(named.client.deviceBrand(), "Amkette");
  assert.equal((await named.client.readStatus()).brand, "Amkette");
  assert.equal((await named.client.readStatus()).name, "XS Flow 2 Speed");

  // The usage-0x00 collection chose this driver, so the brand is Amkette even
  // without a name; the name only refines the model.
  const unnamed = await openClient();
  assert.equal(unnamed.client.deviceBrand(), "Amkette");
  assert.equal((await unnamed.client.readStatus()).brand, "Amkette");
  assert.equal((await unnamed.client.readStatus()).name, "XS series");
  assert.equal((await unnamed.client.readStatus()).ui?.family, "amkette-xs");

  // The 2.4 GHz receiver's generic string names the dongle, not the mouse.
  const dongle = await openClient({ productName: "2.4G Wireless Receiver" } as Partial<HIDDevice>);
  assert.equal(dongle.client.deviceBrand(), "Amkette");
  assert.equal((await dongle.client.readStatus()).name, "XS series");

  // Any other reported name is kept.
  const custom = await openClient({ productName: "Kyu Pro MX1" } as Partial<HIDDevice>);
  assert.equal((await custom.client.readStatus()).name, "Kyu Pro MX1");
});

test("a Bluetooth XS Flow 2 Speed is named, capped at 250 Hz and reads its lighting mode", async () => {
  const { transport, client } = await openClient({
    productId: AMKETTE_XS_BLUETOOTH_PRODUCT_ID,
    productName: "XS speed 2",
  } as Partial<HIDDevice>);
  // Body captured over Bluetooth LE: 250 Hz, battery 100, Breathe, top class 0x31.
  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 2, 0x04, 100, 0, 0x02, 0, 0x31, 0x20]);
  const status = await client.readStatus();
  assert.equal(status.brand, "Amkette");
  assert.equal(status.name, "XS Flow 2 Speed");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "Bluetooth, slot 2");
  assert.equal(status.pollingRateHz, 250);
  assert.deepEqual(status.supportedPollingRates, [125, 250]);
  assert.equal(status.lighting?.mode, "Breathing single");
  await assert.rejects(() => client.setPollingRate(1000), /does not offer 1000 Hz/);
});

test("every Bluetooth slot name identifies the mouse and shows its slot", async () => {
  for (const slot of [1, 3]) {
    const { client } = await openClient({
      productId: AMKETTE_XS_BLUETOOTH_PRODUCT_ID,
      productName: `XS speed ${slot}`,
    } as Partial<HIDDevice>);
    const status = await client.readStatus();
    assert.equal(status.name, "XS Flow 2 Speed");
    assert.equal(status.connectionDetail, `Bluetooth, slot ${slot}`);
  }
  const unnamed = await openClient({ productId: AMKETTE_XS_BLUETOOTH_PRODUCT_ID } as Partial<HIDDevice>);
  assert.equal((await unnamed.client.readStatus()).connectionDetail, "Bluetooth");
});

test("the USB label of an XS Flow 2 Speed shows its retail name", async () => {
  const { client } = await openClient({ productName: "XS Speed" } as Partial<HIDDevice>);
  const status = await client.readStatus();
  assert.equal(status.brand, "Amkette");
  assert.equal(status.name, "XS Flow 2 Speed");
  assert.ok(status.lighting, "the Flow 2 Speed has lighting");
});

test("an XS Natural Plus has no lighting card and refuses lighting writes", async () => {
  const { transport, client } = await openClient({ productName: "XS Natural+" } as Partial<HIDDevice>);
  const status = await client.readStatus();
  assert.equal(status.name, "XS Natural Plus");
  assert.equal(status.lighting, undefined);
  await assert.rejects(() => client.setLighting({ mode: "Static" }), /does not offer/);
  assert.equal(transport.sent.length, 0);
});

test("opening asks for telemetry and readStatus reports what the mouse sent", async () => {
  const { transport, client } = await openClient();
  assert.deepEqual(transport.featureReads, [RYUNIX_CONFIG_REPORT_ID]);

  const status = await client.readStatus();
  assert.equal(status.batteryPercent, 73);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.pollingRateHz, 500);
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.lighting?.mode, "Static");
  assert.equal(status.ui?.settingsReady, true);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.equal(status.ui?.dpiStageEditor?.maxDpi, 8000);
  // Nothing has been written, so the vendor's default stages stand in for the unknown table.
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 2400, 3200, 6400, 8000]);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpi, 1600);
  // Not readable from the mouse: the vendor app's defaults stand in.
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.motionSync, true);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.rippleControl, false);
  assert.equal(status.lighting?.zone, "Mouse");
  assert.deepEqual(status.buttonMappings?.["Wheel tilt left"], "Tilt left");
  assert.equal(client.getSleepOptions().length, 15);
  assert.equal(client.getSleepOptions()[0], 60);
  assert.equal(client.getSleepOptions().at(-1), 900);
});

test("every status read asks the mouse for a fresh report", async () => {
  const { transport, client } = await openClient();
  await client.readStatus();
  // The DPI button on the mouse moved it to stage 5 and the battery dropped; the
  // mouse says so only in the next report it is asked for.
  const original = transport.device.receiveFeatureReport.bind(transport.device);
  transport.device.receiveFeatureReport = async (reportId: number) => {
    if (reportId === RYUNIX_CONFIG_REPORT_ID) {
      queueMicrotask(() => transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 4, 0x02, 72, 0, 0x03, 0, 0x08, 0x20]));
      return new DataView(new ArrayBuffer(31));
    }
    return original(reportId);
  };
  const status = await client.readStatus();
  assert.equal(status.activeDpiStage, 4);
  assert.equal(status.batteryPercent, 72);
});

test("the first status read waits for the report opening asked for", async () => {
  const { transport, client } = await openClient();
  await client.readStatus();
  assert.equal(transport.featureReads.filter((id) => id === RYUNIX_CONFIG_REPORT_ID).length, 1);
  await client.readStatus();
  assert.equal(transport.featureReads.filter((id) => id === RYUNIX_CONFIG_REPORT_ID).length, 2);
});

test("startNotifications reports that the mouse does not push status", async () => {
  const { client } = await openClient();
  assert.equal(await client.startNotifications(() => {}), false);
});

test("a timed-out confirmation does not leave a waiter behind", async () => {
  const { transport, client } = await openClient();
  // The mouse acknowledges but keeps reporting 500 Hz, so every confirmation poll times out.
  await assert.rejects(() => client.setPollingRate(1000), /still reports 500 Hz/);
  for (let index = 0; index < 5; index++) transport.emit(RYUNIX_TELEMETRY_REPORT_ID, TELEMETRY);
  assert.equal((client as unknown as { telemetryWaiters: unknown[] }).telemetryWaiters.length, 0);
});

test("a wired mouse at full charge reports battery status 2 without losing telemetry", async () => {
  const { transport, client } = await openClient();
  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 2, 0x01, 100, 2, 0, 0, 1, 0x20]);
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Full");
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.lighting?.mode, "Off");
});

test("malformed telemetry is ignored and close detaches", async () => {
  const { transport, client } = await openClient();
  assert.equal(transport.listenerAttached(), true);

  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 1, 0x04, 64, 1, 0x01]);
  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 1, 0xff, 64, 1, 0x01]);
  assert.equal((await client.readStatus()).pollingRateHz, 250);

  await client.close();
  assert.equal(transport.listenerAttached(), false);
});

test("setPollingRate sends a framed command, reads the acknowledgement and confirms by telemetry", async () => {
  const { transport, client } = await openClient();
  transport.onCommand((frame) => {
    if (frame[0] === 0x04) transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 2, frame[4]!, 73, 0, 0x03, 0, 0x08, 0x20]);
  });

  assert.equal(await client.setPollingRate(1000), 1000);
  const command = transport.sent.at(-1)!;
  assert.equal(command.reportId, RYUNIX_COMMAND_REPORT_ID);
  assert.equal(command.data.length, 31);
  assert.deepEqual([...command.data.subarray(0, 3)], [0x04, 1, 1]);
  assert.equal(command.data[4], 0x01);
  assert.ok(transport.featureReads.includes(RYUNIX_COMMAND_REPORT_ID), "the acknowledgement is read from report 6");
  assert.equal((await client.readStatus()).pollingRateHz, 1000);
});

test("setPollingRate confirms from a status report requested after the write", async () => {
  const { transport, client } = await openClient();
  // The mouse applies the rate but only reports it when asked again (feature report 5).
  let applied: number | null = null;
  transport.onCommand((frame) => { if (frame[0] === 0x04) applied = frame[4]!; });
  const originalRead = transport.device.receiveFeatureReport.bind(transport.device);
  transport.device.receiveFeatureReport = async (reportId: number) => {
    if (reportId === RYUNIX_CONFIG_REPORT_ID && applied !== null) {
      queueMicrotask(() => transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 2, applied!, 73, 0, 0x03, 0, 0x08, 0x20]));
    }
    return originalRead(reportId);
  };

  assert.equal(await client.setPollingRate(500), 500);
  assert.equal((await client.readStatus()).pollingRateHz, 500);
});

test("setPollingRate refuses rates the mouse does not offer and rates it fails to apply", async () => {
  const limited = await openClient();
  limited.transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 0, 0x02, 50, 0, 0x03, 0, 0x01, 0x20]);
  await assert.rejects(() => limited.client.setPollingRate(4000), /does not offer 4000 Hz/);
  assert.equal(limited.transport.sent.length, 0);

  const stuck = await openClient();
  // The mouse acknowledges but keeps reporting 500 Hz.
  await assert.rejects(() => stuck.client.setPollingRate(1000), /still reports 500 Hz/);
});

test("a command is retried and then rejected when the mouse never acknowledges", async () => {
  const { transport, client } = await openClient();
  transport.setAck(...new Array(12).fill(0));
  await assert.rejects(() => client.setLiftOffDistance("Low"), /did not acknowledge/);
  assert.equal(transport.sent.filter((entry) => entry.data[0] === 0x05).length, 3);
});

test("a late acknowledgement is waited for instead of re-sending the command", async () => {
  const { transport, client } = await openClient();
  // As seen over the 2.4 GHz receiver: the first reads return 0, then 1.
  transport.setAck(0, 0, 1);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(transport.sent.filter((entry) => entry.data[0] === 0x05).length, 1);
  assert.equal((await client.readStatus()).liftOffDistance, "High");
});

test("the first DPI write seeds a full table and sends X, Y and colours", async () => {
  const { transport, client } = await openClient();
  assert.equal(await client.setDpi(1600), 1600);

  const commands = transport.sent.map((entry) => [entry.data[0], entry.data[2]]);
  assert.deepEqual(commands, [[0x02, 0x02], [0x02, 0x12], [0x03, 0x01]]);
  const x = transport.sent[0]!.data;
  assert.equal(x[4], 2, "active stage comes from telemetry");
  assert.equal(x[5], 0b1111111, "seven stages enabled");

  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.dpiStages?.[2], 1600);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpiStages?.length, 7);
});

test("DPI is not written until the mouse reports its sensor", async () => {
  const { transport, client } = await openClient();
  // A six-byte report carries no sensor type.
  transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 2, 0x02, 73, 0, 0x03]);
  await assert.rejects(() => client.setDpi(800), /not reported its sensor/);
  await assert.rejects(() => client.setDpiStageValue(0, 800), /not reported its sensor/);
  await assert.rejects(() => client.setDpiStageCount(3), /not reported its sensor/);
  assert.equal(transport.sent.length, 0);
});

test("choosing a stage writes the shown table with that stage active, confirmed by status", async () => {
  const { transport, client } = await openClient();
  transport.onCommand((frame) => {
    if (frame[0] === 0x02 && frame[2] === 0x02) transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, frame[4]!, 0x02, 73, 0, 0x03, 0, 0x08, 0x20]);
  });
  // No DPI was written this session: the table shown is the vendor's default.
  assert.equal(await client.setActiveDpiStage(0), 0);
  const x = transport.sent.find((entry) => entry.data[0] === 0x02 && entry.data[2] === 0x02)!.data;
  assert.equal(x[4], 0, "stage 1 active");
  assert.deepEqual([...x.subarray(6, 8)], [3, 0], "stage 1 is 400 DPI (wire value 3)");
  const status = await client.readStatus();
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.dpi, 400);
});

test("a stage switch the mouse does not take is reported", async () => {
  const { client } = await openClient();
  // Telemetry keeps reporting stage 3 (index 2).
  await assert.rejects(() => client.setActiveDpiStage(0), /still reports DPI stage 3/);
});

test("DPI stage edits clamp to the sensor and validate the stage", async () => {
  const { client } = await openClient();
  await client.setDpi(800);
  assert.equal(await client.setDpiStageValue(0, 20000), 8000);
  await assert.rejects(() => client.setDpiStageValue(9, 800), RangeError);
  await assert.rejects(() => client.setActiveDpiStage(9), RangeError);
  assert.equal(await client.setDpiStageCount(3), 3);
  const status = await client.readStatus();
  assert.equal(status.dpiStages?.length, 3);
  assert.equal(status.dpiStages?.[0], 8000);
  await assert.rejects(() => client.setDpiStageCount(8), RangeError);
});

test("DPI stage colours are validated and kept", async () => {
  const { client } = await openClient();
  await assert.rejects(() => client.setDpiStageColor(0, "red"), RangeError);
  assert.equal(await client.setDpiStageColor(1, "#00FF00"), "#00ff00");
  await client.setDpi(800);
  assert.equal((await client.readStatus()).dpiStageColors?.[1], "#00ff00");
});

test("lighting maps effects to codes and confirms them by telemetry", async () => {
  const { transport, client } = await openClient();
  transport.onCommand((frame) => {
    if (frame[0] === 0x06) transport.emit(RYUNIX_TELEMETRY_REPORT_ID, [1, 2, 0x02, 73, 0, frame[5]!, 0, 0x08, 0x20]);
  });

  const status = await client.readStatus();
  assert.deepEqual(status.lighting?.modes, ["Static", "Breathing single", "Off"]);

  await client.setLighting({ mode: "Breathing single", speed: 2 });
  let frame = transport.sent.at(-1)!.data;
  assert.deepEqual([...frame.subarray(4, 8)], [0xff, 2, 2, 0]);
  assert.equal((await client.readStatus()).lighting?.mode, "Breathing single");

  await client.setLighting({ mode: "Static", brightness: 50 });
  frame = transport.sent.at(-1)!.data;
  assert.deepEqual([...frame.subarray(4, 8)], [0xff, 3, 0x20, 0]);

  // Lighting has no colour of its own: Breathe follows the active DPI stage's colour.
  assert.deepEqual((await client.readStatus()).lighting?.colorModes, []);
  assert.deepEqual([...transport.sent.at(-1)!.data.subarray(8, 11)], [255, 255, 255]);

  await assert.rejects(() => client.setLighting({ mode: "Wave" }), /does not offer/);
  await assert.rejects(() => client.setLighting({ mode: "Static", brightness: 60 }), /not available/);
});

test("sleep, processing options and buttons are written and remembered", async () => {
  const { transport, client } = await openClient();

  assert.equal(await client.setSleepTimeout(300), 300);
  assert.equal(await client.setSleepTimeout(100000), 900);
  assert.equal(await client.setSleepTimeout(1), 60);
  const power = transport.sent.filter((entry) => entry.data[0] === 0x07).at(-1)!.data;
  assert.deepEqual([...power.subarray(4, 7)], [1, 1, 0]);

  await client.setAngleSnapping(true);
  const options = transport.sent.filter((entry) => entry.data[0] === 0x08).at(-1)!.data;
  assert.deepEqual([...options.subarray(4, 7)], [1, 1, 0], "unwritten options take the vendor defaults");
  await client.setRippleControl(true);
  await client.setMotionSync(false);
  const status = await client.readStatus();
  assert.equal(status.angleSnapping, true);
  assert.equal(status.motionSync, false);
  assert.equal(status.rippleControl, true);
  assert.equal(status.sleepTimeout, 60);

  assert.equal(status.buttonMappings?.["DPI button"], "DPI cycle");
  assert.equal(status.buttonMappings?.["Upper centre button"], "Show desktop");
  assert.equal(await client.setButtonMapping("Back button", "Copy"), "Copy");
  const buttons = transport.sent.filter((entry) => entry.data[0] === 0x01);
  assert.deepEqual(buttons.map((entry) => entry.data[2]), [0x02, 0x12]);
  assert.deepEqual([...buttons[0]!.data.subarray(13, 16)], [0x70, 0x01, 0x06]);
  assert.deepEqual([...buttons[0]!.data.subarray(4, 7)], [0x10, 0x01, 0x00], "untouched slots keep the factory layout");
  assert.deepEqual([...buttons[1]!.data.subarray(4, 7)], [0x60, 0x01, 0x00], "the mode switch keeps its function");
  assert.equal((await client.readStatus()).buttonMappings?.["Back button"], "Copy");
  await assert.rejects(() => client.setButtonMapping("Nope", "Copy"), /Unknown button/);
  await assert.rejects(() => client.setButtonMapping("Back button", "Nope"), /Unknown button action/);
});

test("lift-off only offers the two heights the mouse stores", async () => {
  const { client } = await openClient();
  await assert.rejects(() => client.setLiftOffDistance("Medium"), /Low and High/);
  assert.deepEqual((await client.readStatus()).supportedLiftOffDistances, ["Low", "High"]);
});

test("commands from separate callers are serialised and sequenced", async () => {
  const { transport, client } = await openClient();
  await Promise.all([client.setLiftOffDistance("Low"), client.setSleepTimeout(120), client.setAngleSnapping(false)]);
  assert.deepEqual(transport.sent.map((entry) => entry.data[1]), [1, 2, 3]);
  assert.deepEqual(transport.sent.map((entry) => entry.data[0]), [0x05, 0x07, 0x08]);
});
