import assert from "node:assert/strict";
import test from "node:test";

import {
  AttackSharkHidClient,
  attackSharkNativeOnlyMessage,
  checksum25a7,
  POLLING_CODES_25A7,
  resetAttackSharkX11DpiState,
  resetAttackSharkX11RuntimeState,
} from "./hid.ts";
import { deviceBrand } from "../registry.ts";

function device(vendorId: number, usagePage = 0xffff): HIDDevice {
  return {
    vendorId,
    productId: 1,
    productName: "X11 Wireless",
    collections: [{
      usagePage,
      usage: 1,
      type: 0,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [{ reportId: 6, items: [] }],
    }],
  } as unknown as HIDDevice;
}

test("Attack Shark OEM devices require the expected feature-report collection", () => {
  assert.equal(AttackSharkHidClient.isSupported(device(0x1d57)), true);
  assert.equal(AttackSharkHidClient.isSupported(device(0x25a7)), true);
  assert.equal(AttackSharkHidClient.isSupported(device(0x25a7, 0x0001)), false);
});

// The four HID entries a real X11 wireless receiver (0x1d57:0xfa60) presents
// to Chrome: two keyboards, a boot mouse, and a system-control/consumer
// composite — none with visible feature reports (Chrome hides reports on
// protected keyboard/system collections; nothing else declares any).
function x11Entry(productId: number, collections: Array<[number, number]>): HIDDevice {
  return {
    vendorId: 0x1d57,
    productId,
    productName: "2.4G Wireless Device",
    collections: collections.map(([usagePage, usage]) => ({
      usagePage,
      usage,
      type: 0,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [],
    })),
  } as unknown as HIDDevice;
}

test("X11 boot entries are refused; the composite status entry is claimed", () => {
  const refused = [
    x11Entry(0xfa60, [[0x01, 0x06]]),
    x11Entry(0xfa60, [[0x01, 0x06]]),
    x11Entry(0xfa60, [[0x01, 0x02]]),
  ];
  for (const entry of refused) {
    assert.equal(AttackSharkHidClient.isSupported(entry), false);
  }
  const composite = x11Entry(0xfa60, [[0x01, 0x80], [0x0c, 0x01], [0x0a, 0x00], [0x0b, 0x00]]);
  assert.equal(AttackSharkHidClient.isSupported(composite), true);
  // An unknown 0x1d57 PID with the same shape stays refused: the read-only
  // claim is scoped to units whose battery stream is documented.
  const unknownPid = x11Entry(0x1234, [[0x01, 0x80], [0x0c, 0x01]]);
  assert.equal(AttackSharkHidClient.isSupported(unknownPid), false);
});

test("X11 read-only client reports battery from input reports and refuses writes", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const base = x11Entry(0xfa60, [[0x01, 0x80], [0x0c, 0x01]]);
  // A unit whose battery report (id 0x03) is visible on the consumer collection.
  (base.collections[1] as { inputReports: unknown[] }).inputReports = [{ reportId: 0x03, items: [] }];
  const composite = {
    ...base,
    opened: false,
    open() { (this as { opened: boolean }).opened = true; return Promise.resolve(); },
    close() { (this as { opened: boolean }).opened = false; return Promise.resolve(); },
    addEventListener(type: string, handler: (event: unknown) => void) { listeners.set(type, handler); },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as HIDDevice;

  const client = new AttackSharkHidClient(composite);
  const before = await client.readStatus();
  assert.equal(before.name, "Attack Shark mouse (2.4 GHz receiver)");
  assert.equal(before.ui?.settingsReady, false);
  assert.equal(before.ui?.forceShowBattery, true);
  assert.match(before.ui?.statusNote ?? "", /needs a native driver/);
  assert.equal(before.batteryPercent, null);
  assert.equal(before.connectionType, "Wireless");

  // Raw packet 03 55 40 01 50: WebHID moves the leading 0x03 into reportId.
  const payload = new Uint8Array([0x55, 0x40, 0x01, 0x50]);
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(payload.buffer) });
  const after = await client.readStatus();
  assert.equal(after.batteryPercent, 80);
  assert.equal(after.batteryState, "Discharging");

  await assert.rejects(() => client.setPollingRate(1000), /needs the OpenMouse Bridge or the desktop app/);
});

test("X11 units whose battery report is hidden do not advertise a battery column", async () => {
  // Real receivers declare the battery report under the protected
  // system-control collection, which Chrome hides — collections then show
  // no input report 0x03 at all (openmouse-1d57-fa60 diagnostics).
  const composite = {
    ...x11Entry(0xfa60, [[0x01, 0x80], [0x0c, 0x01]]),
    opened: true,
    open: () => Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HIDDevice;
  (composite.collections[1] as { inputReports: unknown[] }).inputReports = [{ reportId: 0x02, items: [] }];

  const client = new AttackSharkHidClient(composite);
  const status = await client.readStatus();
  assert.equal(status.ui?.forceShowBattery, false);
});

test("native X11 adapter writes polling over 0x06 and DPI over 0x04", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const sent: Array<{ reportId: number; data: number[] }> = [];
  const listeners = new Map<string, (event: { reportId: number; data: DataView }) => void>();
  const native = {
    vendorId: 0x1d57,
    productId: 0xfa60,
    productName: "2.4G Wireless Device",
    collections: [],
    opened: false,
    open() { (this as { opened: boolean }).opened = true; return Promise.resolve(); },
    close() { (this as { opened: boolean }).opened = false; return Promise.resolve(); },
    sendFeatureReport(reportId: number, data: BufferSource) {
      sent.push({ reportId, data: [...new Uint8Array(data as ArrayBuffer)] });
      return Promise.resolve();
    },
    receiveFeatureReport() { return Promise.resolve(new DataView(new ArrayBuffer(0))); },
    addEventListener(type: string, listener: (event: { reportId: number; data: DataView }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as HIDDevice;

  assert.equal(AttackSharkHidClient.isSupported(native), true);
  const client = new AttackSharkHidClient(native, { batteryWaitMs: 0 });
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark mouse (2.4 GHz receiver)");
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.statusNote, undefined);
  assert.equal(status.ui?.forceShowBattery, true);
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  // No read-back for polling: the last-applied/default 1,000 Hz is reported.
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.batteryPercent, null);

  // DPI defaults: active stage 2 (1-based) => 1,600 DPI, with the shared
  // six-stage editor exposed.
  assert.equal(status.dpi, 1600);
  assert.deepEqual(status.dpiStages, [800, 1600, 2400, 3200, 5000, 22000]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.rippleControl, true);
  assert.deepEqual(status.ui?.dpiStageEditor, {
    maxStages: 6, countEditable: false, minDpi: 50, maxDpi: 22000, stepDpi: 50,
  });

  const applied = await client.setPollingRate(500);
  assert.equal(applied, 500);
  assert.deepEqual(sent, [{ reportId: 0x06, data: [0x09, 0x01, 0x02, 0xfd, 0, 0, 0, 0] }]);

  // DPI write: report 0x04, payload without the leading report id.
  sent.length = 0;
  assert.equal(await client.setDpi(3200), 3200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reportId, 0x04);
  assert.deepEqual(sent[0].data.slice(0, 2), [0x38, 0x01]);
  // Stage 2 is at payload index 8; 3,200 encodes to 0x4b.
  assert.equal(sent[0].data[8], 0x4b);

  // The receiver's autonomous battery packet updates the cached status, and
  // the applied polling rate survives into the next read via module state.
  const payload = new Uint8Array([0x55, 0x40, 0x01, 0x50]);
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(payload.buffer) });
  const withBattery = await client.readStatus();
  assert.equal(withBattery.batteryPercent, 80);
  assert.equal(withBattery.batteryState, "Discharging");
  assert.equal(withBattery.pollingRateHz, 500);
});

// A native adapter in front of a genuine X11 receiver (1d57:fa60, firmware
// 0x0107), answering the 0xa0 read handshake with the reports it returned on
// hardware: three of six stages enabled, 1,000 Hz.
function nativeX11WithReadBack(options: { asleep?: boolean } = {}) {
  const hex = (text: string) => text.split(" ").map((byte) => parseInt(byte, 16));
  const reports = new Map<number, number[]>([
    [0x04, hex("04 38 01 00 01 07 20 20 0c 0e 0f 12 75 81 01 01 00 00 00 00 00 01 00 00 02 ff 00 00 00 ff 00 00 "
      + "00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 0e b3 00 00 00 00")],
    [0x06, hex("06 09 01 01 fe 00 00 00 00")],
    [0x0b, hex("0b 08 01 07 00 00 00 00")],
  ]);
  const sent: Array<{ reportId: number; data: number[] }> = [];
  const listeners = new Map<string, (event: { reportId: number; data: DataView }) => void>();
  let staged: number | null = null;
  let staleReads = 0;
  const device = {
    vendorId: 0x1d57,
    productId: 0xfa60,
    productName: "2.4G Wireless Device",
    collections: [],
    opened: false,
    open() { (this as { opened: boolean }).opened = true; return Promise.resolve(); },
    close() { return Promise.resolve(); },
    sendFeatureReport(reportId: number, data: BufferSource) {
      const bytes = [...new Uint8Array(data as ArrayBuffer)];
      sent.push({ reportId, data: bytes });
      if (reportId === 0xa0) staged = bytes[0];
      return Promise.resolve();
    },
    receiveFeatureReport(reportId: number) {
      // Without a staged request the firmware returns stale buffer bytes.
      const reply = reportId === 0xa0
        ? [0xa0, staged === null || options.asleep ? 0 : 1, 0, 0, 0, 0, 0, 0]
        : reportId === staged ? reports.get(reportId)! : [0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x15, 0x00];
      if (reportId !== 0xa0) {
        if (reportId !== staged) staleReads++;
        staged = null;
      }
      return Promise.resolve(new DataView(new Uint8Array(reply).buffer));
    },
    addEventListener(type: string, listener: (event: { reportId: number; data: DataView }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener() { return undefined; },
  } as unknown as HIDDevice;
  const announce = (model: number) => listeners.get("inputreport")?.({
    reportId: 0x03,
    data: new DataView(new Uint8Array([model, 0x40, 0x01, 0x50]).buffer),
  });
  return { device, sent, announce, reports, staleReads: () => staleReads };
}

test("a named X11 over a native adapter reads its live table, polling rate and firmware", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark X11");
  // Only the enabled stages are listed, and the index points into them.
  assert.deepEqual(status.dpiStages, [550, 600, 650]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.dpi, 600);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.firmware, ["Firmware 1.07"]);
  assert.deepEqual(
    sent.map(({ reportId, data }) => [reportId, ...data.slice(0, 4)]),
    [[0xa0, 0x04, 0x38, 0x00, 0x01], [0xa0, 0x06, 0x09, 0x00, 0x01], [0xa0, 0x0b, 0x08, 0x00, 0x00]],
  );
});

test("a named X11 edit keeps the mouse's disabled stages and colours", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  await client.readStatus();
  sent.length = 0;

  // UI stage 3 is hardware stage 3; stages 4-6 stay disabled. The edit
  // re-reads the table first.
  assert.equal(await client.setDpiStageValue(2, 1600), 1600);
  assert.deepEqual(sent.map(({ reportId }) => reportId), [0xa0, 0x04]);
  const payload = sent[1].data;
  assert.equal(payload[4], 0x07);
  assert.equal(payload[9], 0x25);
  assert.deepEqual(payload.slice(24, 48), [
    0xff, 0, 0, 0, 0xff, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0xff, 0xff, 0x40, 0, 0xff, 0xff, 0xff,
  ]);
  assert.deepEqual(payload.slice(13, 15), [0x01, 0x01]);
  await assert.rejects(() => client.setDpiStageValue(3, 800), /no DPI stage 4/);
  await assert.rejects(() => client.setActiveDpiStage(5), /no DPI stage 6/);
});

test("an X11 edit before any status read fetches the live table first", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  await client.setDpi(700);
  assert.deepEqual(sent.map(({ reportId }) => reportId), [0xa0, 0x04]);
  assert.equal(sent[1].data[4], 0x07);
});

test("an X11 edit starts from the stage the DPI button selected, not the cached one", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce, reports } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  await client.readStatus();
  // The user presses the DPI button: the mouse now has stage 3 active.
  const table = reports.get(0x04)!;
  table[24] = 0x03;
  table[51] += 1;
  sent.length = 0;
  await client.setDpi(700);
  const payload = sent[1].data;
  assert.equal(payload[23], 0x03);
  assert.equal(payload[9], 0x10);
});

test("once read-back has worked, an X11 edit is refused while the mouse cannot answer", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const mouse = { asleep: false };
  const { device, sent, announce } = nativeX11WithReadBack(mouse);
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  await client.readStatus();
  mouse.asleep = true;
  sent.length = 0;
  await assert.rejects(() => client.setDpiStageValue(0, 800), /did not answer/);
  // Only read requests went out; nothing was written from a guessed table.
  assert.ok(sent.every(({ reportId }) => reportId === 0xa0));
});

test("an X11 edit over a transport where read-back never worked uses the cached table", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce } = nativeX11WithReadBack({ asleep: true });
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  assert.equal(await client.setDpiStageValue(0, 800), 800);
  const write = sent.find(({ reportId }) => reportId === 0x04);
  assert.ok(write);
  assert.equal(write.data[4], 0x3f);
});

test("X11 read-back requests keep the receiver gap from config writes, both ways", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce } = nativeX11WithReadBack();
  const times: number[] = [];
  const send = device.sendFeatureReport.bind(device);
  device.sendFeatureReport = (reportId: number, data: BufferSource) => {
    times.push(Date.now());
    return send(reportId, data);
  };
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 200 });
  await client.open();
  announce(0x55);
  await client.setDpi(700);
  await client.readStatus();
  await client.setDpi(650);
  assert.deepEqual(
    sent.map(({ reportId }) => reportId),
    [0xa0, 0x04, 0xa0, 0xa0, 0xa0, 0xa0, 0x04],
  );
  // query -> write, write -> query, query -> write: each at least the gap.
  assert.ok(times[1] - times[0] >= 200);
  assert.ok(times[2] - times[1] >= 200);
  assert.ok(times[6] - times[5] >= 200);
  // Back-to-back read-backs are not spaced.
  assert.ok(times[4] - times[3] < 200);
});

test("a different model behind the same receiver drops the cached X11 table", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  await client.readStatus();
  announce(0x20);
  sent.length = 0;
  await client.setDpi(800);
  // The M600 Pro is written from the factory table, not the X11's bytes.
  assert.deepEqual(sent.map(({ reportId }) => reportId), [0x04]);
  assert.equal(sent[0].data[4], 0x3f);
});

test("a different model behind the same receiver stops reporting the X11's firmware", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, announce } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  assert.deepEqual((await client.readStatus()).firmware, ["Firmware 1.07"]);
  announce(0x20);
  assert.deepEqual((await client.readStatus()).firmware, []);
});

test("overlapping X11 status reads and edits do not interleave their read handshakes", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, announce, staleReads } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  announce(0x55);
  const [status, applied, again] = await Promise.all([
    client.readStatus(),
    client.setDpiStageValue(2, 1600),
    client.readStatus(),
  ]);
  assert.equal(applied, 1600);
  assert.deepEqual(status.firmware, ["Firmware 1.07"]);
  assert.deepEqual(again.firmware, ["Firmware 1.07"]);
  // A fetch the firmware was not asked to stage returns stale buffer bytes.
  assert.equal(staleReads(), 0);
});

test("X11 read-back is not tried before a receiver message names the X11", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { device, sent, announce } = nativeX11WithReadBack();
  const client = new AttackSharkHidClient(device, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  await client.readStatus();
  // The Delux M600 Pro shares the receiver; the handshake is unverified there.
  announce(0x20);
  await client.readStatus();
  assert.deepEqual(sent, []);
});

test("X11-family grants get a native-only explanation, other refusals do not", () => {
  const wireless = attackSharkNativeOnlyMessage([x11Entry(0xfa60, [[0x01, 0x06]])]);
  assert.match(wireless ?? "", /Attack Shark mouse \(2\.4 GHz receiver\)/);
  assert.match(wireless ?? "", /Enable native control/);
  assert.match(wireless ?? "", /OpenMouse Bridge/);

  const wired = attackSharkNativeOnlyMessage([x11Entry(0xfa55, [[0x01, 0x02]])]);
  assert.match(wired ?? "", /Attack Shark mouse \(wired\)/);

  // Unknown 0x1d57 PIDs and other vendors keep the generic error.
  assert.equal(attackSharkNativeOnlyMessage([x11Entry(0x1234, [[0x01, 0x02]])]), null);
  assert.equal(attackSharkNativeOnlyMessage([device(0x25a7)]), null);
});

test("Attack Shark battery reports validate their signature and percentage", () => {
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x55, 0x40, 0x01, 73])), 73);
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x55, 0x40, 0x00, 73])), null);
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x55, 0x40, 0x01, 101])), null);
  // Delux M600 Pro on the same 0xfa60 receiver: marker 0x20 (captured at 100 %).
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x20, 0x40, 0x01, 0x64])), 100);
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x21, 0x40, 0x01, 0x64])), null);
  // The R1 (0x10) reports charge on a 1-10 scale.
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x10, 0x40, 0x01, 7])), 70);
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x10, 0x40, 0x01, 11])), null);
  // The X11 SE (0x07) reports battery percentage directly (0-100%).
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x07, 0x40, 0x01, 85])), 85);
  // The X3 (0x4d) is named by its id, but its scale is unchecked: no battery.
  assert.equal(AttackSharkHidClient.parseBatteryReport(new Uint8Array([0x03, 0x4d, 0x40, 0x01, 0x64])), null);
});

function sizedReport(reportId: number, byteLength: number): HIDReportInfo {
  return { reportId, items: [{ reportSize: 8, reportCount: byteLength }] } as unknown as HIDReportInfo;
}

// Interface 2 of an 0xfa60 receiver as Chrome on Linux presents it: hidraw
// hands over the whole descriptor, so the 0x0b config collection and its
// feature reports are visible (captures/delux-m600-pro/descriptors.hex).
function linuxX11Receiver(dpiReportBytes: number) {
  const sent: Array<{ reportId: number; data: number[] }> = [];
  const reads: number[] = [];
  const listeners = new Map<string, (event: { reportId: number; data: DataView }) => void>();
  const collection = (usagePage: number, usage: number, input: number[], feature: HIDReportInfo[] = []) => ({
    usagePage,
    usage,
    type: 1,
    children: [],
    inputReports: input.map((reportId) => ({ reportId, items: [] })),
    outputReports: [],
    featureReports: feature,
  });
  const unit = {
    vendorId: 0x1d57,
    productId: 0xfa60,
    productName: "2.4G Wireless Device",
    collections: [
      collection(0x01, 0x80, [1]),
      collection(0x0c, 0x01, [2]),
      collection(0x0a, 0x00, [3]),
      collection(0x0b, 0x00, [], [
        sizedReport(0x04, dpiReportBytes),
        sizedReport(0x05, 12),
        sizedReport(0x06, 8),
        sizedReport(0xa0, 7),
      ]),
    ],
    opened: false,
    open() { (this as { opened: boolean }).opened = true; return Promise.resolve(); },
    close() { (this as { opened: boolean }).opened = false; return Promise.resolve(); },
    sendFeatureReport(reportId: number, data: BufferSource) {
      sent.push({ reportId, data: [...new Uint8Array(data as ArrayBuffer)] });
      return Promise.resolve();
    },
    receiveFeatureReport(reportId: number) {
      reads.push(reportId);
      return Promise.reject(new DOMException("timed out", "NetworkError"));
    },
    addEventListener(type: string, listener: (event: { reportId: number; data: DataView }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as HIDDevice;
  return { unit, sent, reads, listeners };
}

test("an X11 receiver whose config channel the browser exposes is X11, not R1", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit, sent, reads, listeners } = linuxX11Receiver(51);
  assert.equal(AttackSharkHidClient.isSupported(unit), true);

  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.statusNote, undefined);
  assert.equal(status.ui?.forceShowBattery, true);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.dpi, 1600);
  // No R1 0xa0 read request and no GET_FEATURE: both fail on this firmware.
  assert.deepEqual(sent, []);
  assert.deepEqual(reads, []);

  // 125 Hz, measured at 126 Hz on the M600 Pro receiver.
  assert.equal(await client.setPollingRate(125), 125);
  assert.deepEqual(sent, [{ reportId: 0x06, data: [0x09, 0x01, 0x08, 0xf7, 0, 0, 0, 0] }]);
  assert.deepEqual(reads, []);

  // The app snaps stage edits to these options; every encodable value is offered.
  const options = client.getDpiOptions();
  assert.equal(options[0], 50);
  assert.equal(options.at(-1), 22000);
  assert.ok(options.includes(1650));

  // The descriptor declares 51 bytes for 0x04, so the 52-byte form is sent.
  sent.length = 0;
  assert.equal(await client.setDpi(3200), 3200);
  assert.equal(sent[0].reportId, 0x04);
  assert.equal(sent[0].data.length, 51);

  assert.equal(status.name, "Attack Shark mouse (2.4 GHz receiver)");
  const battery = new Uint8Array([0x20, 0x40, 0x01, 0x64]);
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(battery.buffer) });
  const identified = await client.readStatus();
  assert.equal(identified.batteryPercent, 100);
  // Byte 1 of receiver messages is the paired mouse's model id: 0x20 is the
  // Delux M600 Pro sharing this 0xfa60 receiver.
  assert.equal(identified.name, "Delux M600 Pro (Wireless)");
  assert.equal(identified.brand, "Delux");
  assert.equal(deviceBrand(client), "Delux");
});

test("unknown receiver model ids neither rename the unit nor count as battery", async () => {
  resetAttackSharkX11RuntimeState();
  const { unit, listeners } = linuxX11Receiver(51);
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  await client.readStatus();
  const other = new Uint8Array([0x21, 0x40, 0x01, 0x07]);
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(other.buffer) });
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark mouse (2.4 GHz receiver)");
  assert.equal(status.brand, "Attack Shark");
  assert.equal(status.batteryPercent, null);
});

// The 0xfa60 receiver and the wired PIDs are shared across the platform: an
// R1 on its dongle and an X3 by cable enumerate exactly like an X11.
test("the receiver's model id names the mouse, never the PID", async () => {
  resetAttackSharkX11RuntimeState();
  const { unit, listeners } = linuxX11Receiver(51);
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  assert.equal((await client.readStatus()).name, "Attack Shark mouse (2.4 GHz receiver)");

  const r1 = new Uint8Array([0x10, 0x40, 0x01, 0x07]);
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(r1.buffer) });
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark R1");
  assert.equal(status.brand, "Attack Shark");
  assert.equal(status.batteryPercent, 70);

  resetAttackSharkX11RuntimeState();
  const x3 = new Uint8Array([0x4d, 0x50, 0x00, 0x06]);
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(x3.buffer) });
  const identified = await client.readStatus();
  assert.equal(identified.name, "Attack Shark X3");
  assert.equal(identified.batteryPercent, null);

  // With no battery scale to wait for, a named X3 skips the battery wait.
  const patient = new AttackSharkHidClient(unit, { batteryWaitMs: 10_000 });
  const started = Date.now();
  await patient.readStatus();
  assert.ok(Date.now() - started < 1_000);

  for (const productId of [0xfa55, 0xfa61]) {
    const wired = new AttackSharkHidClient(x11Entry(productId, [[0x01, 0x80], [0x0c, 0x01]]));
    assert.equal(wired.displayName(), "Attack Shark mouse (wired)");
  }
});

test("the declared DPI report length picks the 56-byte receiver form", async () => {
  resetAttackSharkX11DpiState();
  const { unit, sent } = linuxX11Receiver(55);
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(sent[0].data.length, 55);
});

// An 0xfa60 receiver as OpenMouse Bridge presents it on Windows: every
// interface merged into one device, with descriptors hidapi rebuilt from the
// preparsed data. The 0x0a battery collection reads as unnumbered and the
// 0x0b config collection declares nothing
// (captures/delux-m600-pro/windows-bridge.txt).
function windowsBridgeX11Receiver() {
  const sent: Array<{ reportId: number; data: number[] }> = [];
  const reads: number[] = [];
  const listeners = new Map<string, (event: { reportId: number; data: DataView }) => void>();
  const collection = (
    usagePage: number,
    usage: number,
    input: number[],
    output: number[] = [],
    children: unknown[] = [],
  ) => ({
    usagePage,
    usage,
    type: 1,
    children,
    inputReports: input.map((reportId) => ({ reportId, items: [] })),
    outputReports: output.map((reportId) => ({ reportId, items: [] })),
    featureReports: [],
  });
  const unit = {
    vendorId: 0x1d57,
    productId: 0xfa60,
    productName: "2.4G Wireless Device",
    collections: [
      collection(0x01, 0x80, [1]),
      collection(0x0c, 0x01, [2]),
      collection(0x0a, 0x00, [0]),
      collection(0x01, 0x06, [0]),
      collection(0x0b, 0x00, []),
      collection(0x01, 0x06, [0], [0]),
      collection(0x01, 0x02, [], [], [collection(0x01, 0x01, [0])]),
    ],
    opened: false,
    open() { (this as { opened: boolean }).opened = true; return Promise.resolve(); },
    close() { (this as { opened: boolean }).opened = false; return Promise.resolve(); },
    sendFeatureReport(reportId: number, data: BufferSource) {
      sent.push({ reportId, data: [...new Uint8Array(data as ArrayBuffer)] });
      return Promise.resolve();
    },
    receiveFeatureReport(reportId: number) {
      reads.push(reportId);
      return Promise.reject(new DOMException("not declared", "NotAllowedError"));
    },
    addEventListener(type: string, listener: (event: { reportId: number; data: DataView }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as HIDDevice;
  const push = (bytes: number[]) => {
    listeners.get("inputreport")?.({ reportId: 0x00, data: new DataView(new Uint8Array(bytes).buffer) });
  };
  return { unit, sent, reads, push };
}

test("Bridge on Windows: the M600 Pro is named by its unnumbered receiver message and becomes writable", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit, sent, reads, push } = windowsBridgeX11Receiver();
  assert.equal(AttackSharkHidClient.isSupported(unit), true);
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0, receiverWriteGapMs: 0 });

  // No receiver message yet: nothing names the mouse, so nothing is writable.
  const before = await client.readStatus();
  assert.equal(before.name, "Attack Shark mouse (2.4 GHz receiver)");
  assert.equal(before.ui?.settingsReady, false);
  assert.equal(before.ui?.forceShowBattery, true);
  assert.equal(before.batteryPercent, null);
  await assert.rejects(() => client.setPollingRate(500), /not reachable from a browser/);

  // Captured through Bridge: 03 20 40 01 4c, the M600 Pro at 76 %.
  push([0x03, 0x20, 0x40, 0x01, 0x4c]);
  const status = await client.readStatus();
  assert.equal(status.name, "Delux M600 Pro (Wireless)");
  assert.equal(status.brand, "Delux");
  assert.equal(status.batteryPercent, 76);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.statusNote, undefined);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.dpi, 1600);
  assert.deepEqual(reads, []);

  // Same packets as the verified Linux writes.
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [{ reportId: 0x06, data: [0x09, 0x01, 0x02, 0xfd, 0, 0, 0, 0] }]);
  sent.length = 0;
  assert.equal(await client.setDpi(400), 400);
  assert.equal(sent[0].reportId, 0x04);
  // The 52-byte form the M600 Pro descriptor declares, minus the report id.
  assert.equal(sent[0].data.length, 51);
  assert.deepEqual(sent[0].data.slice(0, 2), [0x38, 0x01]);
  assert.deepEqual(reads, []);
});

test("Bridge on Windows: the X11 is named by its receiver message and becomes writable", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit, sent, reads, push } = windowsBridgeX11Receiver();
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();

  // Issue #161: a genuine X11 (model id 0x55) over the same rebuilt collection.
  push([0x03, 0x55, 0x40, 0x01, 0x50]);
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark X11");
  assert.equal(status.batteryPercent, 80);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.statusNote, undefined);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.deepEqual(reads, []);

  // Same 0x06 packet as the verified M600 Pro write.
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [{ reportId: 0x06, data: [0x09, 0x01, 0x02, 0xfd, 0, 0, 0, 0] }]);
  sent.length = 0;
  assert.equal(await client.setDpi(800), 800);
  assert.equal(sent[0].reportId, 0x04);
  // The receiver's 56-byte DPI frame the reference driver documents, minus the
  // report id — not the M600 Pro's 52-byte one.
  assert.equal(sent[0].data.length, 55);
  assert.deepEqual(reads, []);
});

test("Bridge on Windows: models with no established frame shape still stay read-only", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit, sent, push } = windowsBridgeX11Receiver();
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  // The R1 (0x10) uses a different DPI map per the reference driver.
  push([0x03, 0x10, 0x40, 0x01, 0x05]);
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark R1");
  assert.equal(status.ui?.settingsReady, false);
  await assert.rejects(() => client.setDpi(800), /not reachable from a browser/);
  assert.deepEqual(sent, []);
});

test("Bridge on Windows: unnumbered mouse and keyboard reports are not receiver messages", async () => {
  resetAttackSharkX11RuntimeState();
  const { unit, push } = windowsBridgeX11Receiver();
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  await client.open();
  // Boot mouse, left+right held and X = +0x0020: 7 bytes, starts like a receiver message.
  push([0x03, 0x20, 0x40, 0x01, 0x4c, 0x00, 0x00]);
  // Keyboard with modifiers 0x03: 8 bytes.
  push([0x03, 0x20, 0x40, 0x01, 0x4c, 0x00, 0x00, 0x00]);
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark mouse (2.4 GHz receiver)");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.ui?.settingsReady, false);
});

test("Bridge on Windows: status waits for the receiver message that names the mouse", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit, push } = windowsBridgeX11Receiver();
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 2_000 });
  await client.open();
  setTimeout(() => push([0x03, 0x20, 0x40, 0x01, 0x4c]), 150);
  const status = await client.readStatus();
  assert.equal(status.name, "Delux M600 Pro (Wireless)");
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.batteryPercent, 76);
});

test("Bridge on Windows: a write acknowledgement names the mouse without counting as battery", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit, push } = windowsBridgeX11Receiver();
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  await client.open();
  // 03 20 50 00 06: model, feature-report status event, success, report id.
  push([0x03, 0x20, 0x50, 0x00, 0x06]);
  const status = await client.readStatus();
  assert.equal(status.name, "Delux M600 Pro (Wireless)");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.ui?.settingsReady, true);
});

test("Bridge on Windows: an unknown model id neither renames the unit nor unlocks writes", async () => {
  resetAttackSharkX11RuntimeState();
  const { unit, sent, push } = windowsBridgeX11Receiver();
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  await client.open();
  push([0x03, 0x21, 0x40, 0x01, 0x4c]);
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark mouse (2.4 GHz receiver)");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.ui?.settingsReady, false);
  assert.deepEqual(sent, []);
});

test("Bridge on Windows: receiver writes keep the minimum gap", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit, push } = windowsBridgeX11Receiver();
  const sentAt: number[] = [];
  const send = unit.sendFeatureReport.bind(unit);
  (unit as { sendFeatureReport: HIDDevice["sendFeatureReport"] }).sendFeatureReport = (reportId, data) => {
    sentAt.push(Date.now());
    return send(reportId, data);
  };
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0, receiverWriteGapMs: 200 });
  await client.open();
  push([0x03, 0x20, 0x40, 0x01, 0x4c]);
  await Promise.all([client.setPollingRate(500), client.setPollingRate(1000)]);
  assert.equal(sentAt.length, 2);
  assert.ok(sentAt[1] - sentAt[0] >= 195, `second write came ${sentAt[1] - sentAt[0]} ms after the first`);
});

test("Bridge on Windows: wired X11-family PIDs name no model and stay read-only", async () => {
  resetAttackSharkX11RuntimeState();
  for (const productId of [0xfa55, 0xfa61]) {
    const { unit, sent } = windowsBridgeX11Receiver();
    (unit as { productId: number }).productId = productId;
    (unit as { productName: string }).productName = "USB Gaming Mouse";
    assert.equal(AttackSharkHidClient.isSupported(unit), true);
    const patient = new AttackSharkHidClient(unit, { batteryWaitMs: 10_000 });
    const started = Date.now();
    const status = await patient.readStatus();
    // Wired units send no receiver messages, so the status read does not wait for one.
    assert.ok(Date.now() - started < 1_000, `0x${productId.toString(16)} waited for a receiver message`);
    assert.equal(status.name, "Attack Shark mouse (wired)");
    assert.equal(status.ui?.settingsReady, false);
    assert.equal(status.ui?.forceShowBattery, false);
    assert.deepEqual(sent, []);
  }
});

test("a native adapter keeps the product-id DPI length even once the M600 Pro is named", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const sent: Array<{ reportId: number; data: number[] }> = [];
  const listeners = new Map<string, (event: { reportId: number; data: DataView }) => void>();
  const native = {
    vendorId: 0x1d57,
    productId: 0xfa60,
    productName: "2.4G Wireless Device",
    collections: [],
    opened: false,
    open() { (this as { opened: boolean }).opened = true; return Promise.resolve(); },
    close() { return Promise.resolve(); },
    sendFeatureReport(reportId: number, data: BufferSource) {
      sent.push({ reportId, data: [...new Uint8Array(data as ArrayBuffer)] });
      return Promise.resolve();
    },
    receiveFeatureReport() { return Promise.resolve(new DataView(new ArrayBuffer(0))); },
    addEventListener(type: string, listener: (event: { reportId: number; data: DataView }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener() { return undefined; },
  } as unknown as HIDDevice;
  const client = new AttackSharkHidClient(native, { batteryWaitMs: 0, receiverWriteGapMs: 0 });
  await client.open();
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(new Uint8Array([0x20, 0x40, 0x01, 0x4c]).buffer) });
  assert.equal((await client.readStatus()).name, "Delux M600 Pro (Wireless)");
  await client.setDpi(800);
  // Unchanged from before the Bridge shape was recognised: 56-byte form for 0xfa60.
  assert.equal(sent[0].data.length, 55);
});

test("Linux hidraw: report-0 packets are not receiver messages", async () => {
  resetAttackSharkX11RuntimeState();
  const { unit, listeners } = linuxX11Receiver(51);
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  await client.readStatus();
  // Linux hands the battery report over as report 0x03; a report-0 packet of
  // the same bytes comes from an unnumbered collection and must not count.
  listeners.get("inputreport")?.({ reportId: 0x00, data: new DataView(new Uint8Array([0x03, 0x20, 0x40, 0x01, 0x4c, 0x00, 0x00]).buffer) });
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark mouse (2.4 GHz receiver)");
  assert.equal(status.batteryPercent, null);
});

test("Chrome on Windows lists only the consumer collection: read-only, no battery column", async () => {
  resetAttackSharkX11RuntimeState();
  // captures/delux-m600-pro/windows-webhid.txt (Chrome 154)
  const composite = {
    ...x11Entry(0xfa60, [[0x0c, 0x01]]),
    opened: true,
    open: () => Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HIDDevice;
  (composite.collections[0] as { inputReports: unknown[] }).inputReports = [{ reportId: 0x02, items: [] }];
  assert.equal(AttackSharkHidClient.isSupported(composite), true);
  const status = await new AttackSharkHidClient(composite, { batteryWaitMs: 0 }).readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.forceShowBattery, false);
  assert.match(status.ui?.statusNote ?? "", /needs a native driver/);
});

// ── 0x25a7 protocol tests ────────────────────────────────────────────────

test("checksum25a7 pads to 9 bytes and places checksum at byte 7", () => {
  // Simple command: [0x80, 0, 0, 0, 0, 0, 0] → sum=0x80, checksum = 0xff-0x80 = 0x7f
  const cmd = new Uint8Array([0x80]);
  const result = checksum25a7(cmd);
  assert.equal(result.length, 9);
  assert.equal(result[0], 0x80);
  assert.equal(result[7], 0x7f); // 0xff - 0x80
  assert.equal(result[8], 0); // unused
});

test("checksum25a7 computes correct checksum for multi-byte command", () => {
  // Command: [0xd4, 0x01, 0, 0, 0, 0, 0] → sum = 0xd4 + 0x01 = 0xd5
  const cmd = new Uint8Array([0xd4, 0x01]);
  const result = checksum25a7(cmd);
  assert.equal(result[0], 0xd4);
  assert.equal(result[1], 0x01);
  assert.equal(result[7], (0xff - 0xd5) & 0xff); // 0x2a
});

test("checksum25a7 wraps sum at byte boundary (mod 256)", () => {
  // Craft bytes that sum to exactly 0x100 → sum & 0xff = 0 → checksum = 0xff
  const cmd = new Uint8Array([0x80, 0x80, 0, 0, 0, 0, 0]);
  const result = checksum25a7(cmd);
  assert.equal(result[7], 0xff); // 0xff - (0x100 & 0xff) = 0xff - 0 = 0xff
});

test("POLLING_CODES_25A7 maps standard rates", () => {
  assert.equal(POLLING_CODES_25A7.get(125), 0x08);
  assert.equal(POLLING_CODES_25A7.get(250), 0x04);
  assert.equal(POLLING_CODES_25A7.get(500), 0x02);
  assert.equal(POLLING_CODES_25A7.get(1000), 0x01);
  assert.equal(POLLING_CODES_25A7.get(2000), 0x84);
  assert.equal(POLLING_CODES_25A7.get(4000), 0x82);
  assert.equal(POLLING_CODES_25A7.get(8000), 0x81);
});

test("POLLING_CODES_25A7 returns undefined for unsupported rates", () => {
  assert.equal(POLLING_CODES_25A7.get(3000), undefined);
  assert.equal(POLLING_CODES_25A7.get(1500), undefined);
});

test("receiver writes are spaced by the minimum gap, even from overlapping calls", async () => {
  resetAttackSharkX11DpiState();
  resetAttackSharkX11RuntimeState();
  const { unit } = linuxX11Receiver(51);
  const sentAt: number[] = [];
  const send = unit.sendFeatureReport.bind(unit);
  (unit as { sendFeatureReport: HIDDevice["sendFeatureReport"] }).sendFeatureReport = (reportId, data) => {
    sentAt.push(Date.now());
    return send(reportId, data);
  };
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0, receiverWriteGapMs: 200 });

  // The hardware test's round-trip: a write immediately followed by a restore.
  await Promise.all([client.setPollingRate(500), client.setPollingRate(1000)]);
  await client.setDpi(800);
  assert.equal(sentAt.length, 3);
  for (let i = 1; i < sentAt.length; i++) {
    assert.ok(sentAt[i] - sentAt[i - 1] >= 195, `write ${i} came ${sentAt[i] - sentAt[i - 1]} ms after the previous one`);
  }
});
