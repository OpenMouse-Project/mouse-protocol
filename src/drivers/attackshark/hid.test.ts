import assert from "node:assert/strict";
import test from "node:test";

import {
  AttackSharkHidClient,
  attackSharkNativeOnlyMessage,
  checksum25a7,
  POLLING_CODES_25A7,
} from "./hid.ts";

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
