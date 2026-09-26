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
  assert.equal(before.name, "Attack Shark X11");
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

  await assert.rejects(() => client.setPollingRate(1000), /native Attack Shark X11 driver/);
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
  assert.equal(status.name, "Attack Shark X11");
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

test("X11-family grants get a native-only explanation, other refusals do not", () => {
  const wireless = attackSharkNativeOnlyMessage([x11Entry(0xfa60, [[0x01, 0x06]])]);
  assert.match(wireless ?? "", /X11 \(wireless receiver\)/);
  assert.match(wireless ?? "", /Enable native control/);
  assert.match(wireless ?? "", /OpenMouse Bridge/);

  const wired = attackSharkNativeOnlyMessage([x11Entry(0xfa55, [[0x01, 0x02]])]);
  assert.match(wired ?? "", /X11 \(wired\)/);

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

  assert.equal(status.name, "Attack Shark X11");
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
  // 0x85 is the X6, whose battery uses a 1-10 scale.
  const other = new Uint8Array([0x85, 0x40, 0x01, 0x07]);
  listeners.get("inputreport")?.({ reportId: 0x03, data: new DataView(other.buffer) });
  const status = await client.readStatus();
  assert.equal(status.name, "Attack Shark X11");
  assert.equal(status.brand, "Attack Shark");
  assert.equal(status.batteryPercent, null);
});

test("the declared DPI report length picks the 56-byte receiver form", async () => {
  resetAttackSharkX11DpiState();
  const { unit, sent } = linuxX11Receiver(55);
  const client = new AttackSharkHidClient(unit, { batteryWaitMs: 0 });
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(sent[0].data.length, 55);
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
