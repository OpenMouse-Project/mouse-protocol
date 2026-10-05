import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GearHubHidClient } from "./hid.ts";
import { createSupportedClient } from "../registry.ts";
import { GEARHUB_HID_FILTERS } from "../vendors.ts";
import { CMD } from "@openmouse/protocol/gearhub";

function fakeBluetooth(echo = false, battery = 86, batteryMarker = 0x77, silent = false) {
  const capture = JSON.parse(readFileSync(new URL("../../../captures/ajazz-aj179-pro.json", import.meta.url), "utf8"));
  const replies = new Map([
    [CMD.GET_USB_VERSION, Buffer.from(capture.replies.usbVersion, "hex")],
    [CMD.GET_FIRMWARE, Buffer.from(capture.replies.firmware, "hex")],
    [CMD.GET_DPI, Buffer.from(capture.replies.dpi, "hex")],
    [CMD.GET_OPTIONPARAM0, Buffer.from(capture.replies.option0, "hex")],
    [CMD.GET_KEYMATRIX, Buffer.from("0100f0000100f1000100f2000100f4000100f300140000000000000000000000000000000000000000000000000000000100f9010100f9ff0100f5010100f5ff", "hex")],
  ]);
  const listeners = new Set<(event: HIDInputReportEvent) => void>();
  replies.get(CMD.GET_OPTIONPARAM0)![40] = 45; // BLE timer differs from 2.4 GHz.
  const sent: Uint8Array[] = [];
  const device = {
    vendorId: 0x3151, productId: 0x402c, productName: "pan1080xa3", opened: true,
    collections: [{ usagePage: 0xff55, usage: 0x0202, children: [] }],
    open: async () => {}, close: async () => {},
    addEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => listeners.delete(fn),
    sendFeatureReport: async () => { throw new Error("BLE has no feature reports"); },
    sendReport: async (id: number, data: Uint8Array) => {
      if (silent) { sent.push(data.slice()); return; }
      if (data[0] === 0x77) {
        assert.equal(id, 6); assert.equal(data.length, 65);
        assert.ok(data.slice(1).every(value => value === 0), "battery poll has neither USB envelope nor checksum");
        sent.push(data.slice());
        const response = echo ? data.slice() : new Uint8Array(65);
        if (!echo) response.set([batteryMarker, battery, 3, 3]);
        for (const listener of listeners) listener({ reportId: 6, data: new DataView(response.buffer) } as HIDInputReportEvent);
        return;
      }
      assert.equal(id, 6); assert.equal(data.length, 65); assert.equal(data[0], 0x55);
      assert.equal(data[8], 255 - (data.slice(1, 8).reduce((a, b) => a + b, 0) & 255));
      sent.push(data.slice());
      const block = data.slice(1);
      if (block[0] === CMD.SET_DPI) { block[0] = CMD.GET_DPI; replies.set(CMD.GET_DPI, Buffer.from(block)); return; }
      const reply = new Uint8Array(65); reply[0] = 0x55;
      reply.set(echo ? block : replies.get(block[0])!, 1);
      for (const listener of listeners) listener({ reportId: 6, data: new DataView(reply.buffer) } as HIDInputReportEvent);
    },
  } as unknown as HIDDevice;
  return { device, sent, listeners };
}

it("offers only the AJ179 Bluetooth vendor control interface", () => {
  const { device } = fakeBluetooth();
  assert.ok(GEARHUB_HID_FILTERS.some(f => f.productId === 0x402c && f.usagePage === 0xff55 && f.usage === 0x0202));
  assert.ok(createSupportedClient(device) instanceof GearHubHidClient);
  assert.equal(GearHubHidClient.isSupported({ ...device, collections: [{ usagePage: 1, usage: 2 }] } as HIDDevice), false);
  assert.equal(GearHubHidClient.isSupported({ ...device, productId: 0x402d } as HIDDevice), false);
});

it("reads Bluetooth identity/settings and writes DPI without USB feature I/O", async () => {
  const { device, listeners } = fakeBluetooth();
  const client = new GearHubHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.name, "AJAZZ AJ179 PRO");
  assert.equal(status.connectionDetail, "Bluetooth");
  assert.equal(status.batteryPercent, 86);
  assert.equal(status.batteryState, "Unknown", "percentage alone does not establish charging state");
  assert.equal(status.dpi, 1000);
  assert.equal(status.sleepTimeout, 45);
  assert.equal(status.buttonMappings?.Back, "Back");
  assert.equal(status.buttonMappings?.Forward, "Forward");
  const original = await client.getDpi();
  await client.setDpi(1050);
  const changed = await client.getDpi();
  assert.equal(changed.stages[original.activeIndex].x, 1050);
  for (let i = 0; i < original.stages.length; i++) {
    if (i !== original.activeIndex) assert.deepEqual(changed.stages[i], original.stages[i]);
    else assert.equal(changed.stages[i].rgb, original.stages[i].rgb);
  }
  assert.equal(listeners.size, 0, "listeners released after every exchange");
});

it("rejects BLE loopback instead of inventing settings from request bytes", async () => {
  const { device, listeners } = fakeBluetooth(true);
  await assert.rejects(new GearHubHidClient(device).getDeviceId(), /echoed/);
  assert.equal(listeners.size, 0);
});

it("reads 0% and 100% Bluetooth battery, without rounding or dropping zero", async () => {
  for (const percent of [0, 100]) {
    const { device, listeners } = fakeBluetooth(false, percent);
    assert.equal(await new GearHubHidClient(device).getBluetoothBattery(), percent);
    assert.equal(listeners.size, 0);
  }
});

it("rejects sleeping, invalid, and echoed Bluetooth battery packets", async () => {
  for (const [echo, percent, marker] of [[true, 86, 0x77], [false, 255, 0x77], [false, 86, 0x88]] as const) {
    const { device, listeners } = fakeBluetooth(echo, percent, marker);
    await assert.rejects(new GearHubHidClient(device).getBluetoothBattery(), /echoed|invalid|sleeping/);
    assert.equal(listeners.size, 0);
  }
});

it("a battery failure does not prevent reading Bluetooth settings", async () => {
  const { device } = fakeBluetooth(false, 255);
  const status = await new GearHubHidClient(device).readStatus();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.dpi, 1000);
});

it("ignores unrelated and malformed BLE reports and respects DataView offsets", async () => {
  const { device, listeners } = fakeBluetooth(false, 86, 0x77, true);
  const client = new GearHubHidClient(device);
  const pending = client.getDeviceId();
  await new Promise((resolve) => setImmediate(resolve));
  const emit = (reportId: number, bytes: Uint8Array, offset = 0) => {
    const buffer = new Uint8Array(offset + bytes.length + 3);
    buffer.set(bytes, offset);
    for (const listener of listeners) {
      listener({ reportId, data: new DataView(buffer.buffer, offset, bytes.length) } as HIDInputReportEvent);
    }
  };
  emit(6, new Uint8Array(64)); // Truncated.
  emit(6, new Uint8Array(66)); // Oversized.
  const reply = new Uint8Array(65);
  reply.set([0x55, CMD.GET_USB_VERSION, 0x3b, 0x07]);
  emit(5, reply); // Wrong report id.
  emit(6, new Uint8Array(65).fill(0x77)); // Battery, not a command reply.
  const stale = reply.slice();
  stale[1] = CMD.GET_FIRMWARE;
  emit(6, stale); // Previous command, not identity.
  assert.equal(listeners.size, 1);
  emit(6, reply, 7);
  assert.equal(await pending, 1851);
  assert.equal(listeners.size, 0);
});

it("releases the BLE listener after a timeout and allows the next queued command", async () => {
  const { device, listeners } = fakeBluetooth(false, 86, 0x77, true);
  const client = new GearHubHidClient(device);
  await assert.rejects(client.getDeviceId(), /did not answer/);
  assert.equal(listeners.size, 0);
  const pending = client.getDeviceId();
  await new Promise((resolve) => setImmediate(resolve));
  const reply = new Uint8Array(65);
  reply.set([0x55, CMD.GET_USB_VERSION, 0x3b, 0x07]);
  for (const listener of listeners) {
    listener({ reportId: 6, data: new DataView(reply.buffer) } as HIDInputReportEvent);
  }
  assert.equal(await pending, 1851);
  assert.equal(listeners.size, 0);
});

it("releases BLE listeners on send failure and opens the device before a write", async () => {
  const { device, listeners } = fakeBluetooth();
  const client = new GearHubHidClient(device);
  device.sendReport = async () => { throw new Error("send failed"); };
  await assert.rejects(client.getDeviceId(), /send failed/);
  assert.equal(listeners.size, 0);
  await assert.rejects(client.getBluetoothBattery(), /send failed/);
  assert.equal(listeners.size, 0);
  Object.defineProperty(device, "opened", { value: false, configurable: true });
  let opened = false;
  device.open = async () => { opened = true; };
  device.sendReport = async () => { assert.ok(opened); };
  await client.setButtonMapping("Left", "Middle Click");
});

it("serializes concurrent Bluetooth reads", async () => {
  const { device, listeners, sent } = fakeBluetooth();
  const client = new GearHubHidClient(device);
  assert.deepEqual(await Promise.all([client.getDeviceId(), client.getFirmwareVersion(), client.getBluetoothBattery()]),
    [1851, 0x0303, 86]);
  assert.deepEqual(sent.map((packet) => packet[0] === 0x77 ? 0x77 : packet[1]),
    [CMD.GET_USB_VERSION, CMD.GET_FIRMWARE, 0x77]);
  assert.equal(listeners.size, 0);
});
