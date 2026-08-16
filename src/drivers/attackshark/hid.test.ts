import assert from "node:assert/strict";
import test from "node:test";

import { AttackSharkHidClient, attackSharkNativeOnlyMessage } from "./hid.ts";

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

test("real X11 entries expose no feature reports and are refused", () => {
  const entries = [
    x11Entry(0xfa60, [[0x01, 0x06]]),
    x11Entry(0xfa60, [[0x01, 0x06]]),
    x11Entry(0xfa60, [[0x01, 0x02]]),
    x11Entry(0xfa60, [[0x01, 0x80], [0x0c, 0x01], [0x0a, 0x00], [0x0b, 0x00]]),
  ];
  for (const entry of entries) {
    assert.equal(AttackSharkHidClient.isSupported(entry), false);
  }
});

test("X11-family grants get a native-only explanation, other refusals do not", () => {
  const wireless = attackSharkNativeOnlyMessage([x11Entry(0xfa60, [[0x01, 0x06]])]);
  assert.match(wireless ?? "", /X11 \(wireless receiver\)/);
  assert.match(wireless ?? "", /native desktop driver/);

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
