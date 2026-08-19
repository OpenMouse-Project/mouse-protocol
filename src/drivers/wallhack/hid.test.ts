import assert from "node:assert/strict";
import test from "node:test";

import { WallhackMouseHidClient } from "./mouse-hid.ts";
import { WallhackKeyboardHidClient } from "./keyboard-hid.ts";
import { deviceBrand } from "../registry.ts";
import {
  WALLHACK_COMMAND,
  WALLHACK_FLASH,
  WALLHACK_KEYBOARD_USAGE_PAGE,
  WALLHACK_MOUSE_USAGE_PAGE,
  WALLHACK_VENDOR_ID,
} from "@openmouse/protocol/wallhack";

/**
 * A fake M-001 that keeps a config-byte map and answers function-area reads,
 * version and battery on the input-report channel — the same shape the real
 * mouse uses (report id 4, command echoed at byte 2, payload from byte 7).
 */
function fakeMouse(config: Record<number, number> = {}) {
  const store = new Map<number, number>(Object.entries(config).map(([k, v]) => [Number(k), v]));
  let inputListener: ((event: HIDInputReportEvent) => void) | null = null;
  let opened = false;
  const sent: Uint8Array[] = [];

  const answer = (packet: Uint8Array): Uint8Array | null => {
    const command = packet[2]!;
    const response = new Uint8Array(63);
    response[2] = command;
    if (command === WALLHACK_COMMAND.readFunctionArea) {
      const address = packet[4]! | (packet[5]! << 8);
      response[4] = packet[4]!;
      response[5] = packet[5]!;
      if (address === WALLHACK_FLASH.dpi8Block) {
        const dpi = store.get(WALLHACK_FLASH.dpi8Block) ?? 1600;
        response[7] = 1;
        response[9] = dpi & 0xff;
        response[10] = (dpi >> 8) & 0xff;
      } else {
        response[7] = store.get(address) ?? 0;
      }
      return response;
    }
    if (command === WALLHACK_COMMAND.writeFunctionArea) {
      return null; // writes are silent; the driver reads back to verify
    }
    if (command === WALLHACK_COMMAND.readVersion) {
      response.set([1, 4, 2, 13, 0, 9], 7);
      return response;
    }
    if (command === WALLHACK_COMMAND.battery) {
      response[7] = 77;
      response[8] = 0;
      return response;
    }
    return null;
  };

  const device = {
    vendorId: WALLHACK_VENDOR_ID,
    productId: 0x1110,
    productName: "WALLHACK M-001",
    get opened() { return opened; },
    collections: [{
      usagePage: WALLHACK_MOUSE_USAGE_PAGE,
      usage: 0x92,
      children: [],
      inputReports: [{ reportId: 4, items: [] }],
      outputReports: [{ reportId: 4, items: [] }],
      featureReports: [],
    }],
    open: async () => void (opened = true),
    close: async () => void (opened = false),
    sendReport: async (_reportId: number, data: Uint8Array) => {
      const packet = new Uint8Array(data);
      sent.push(packet);
      // Apply writes to the store so a read-back reflects the change.
      if (packet[2] === WALLHACK_COMMAND.writeFunctionArea) {
        const address = packet[4]! | (packet[5]! << 8);
        if (address === WALLHACK_FLASH.dpi8Block) {
          store.set(WALLHACK_FLASH.dpi8Block, packet[9]! | (packet[10]! << 8));
        } else {
          store.set(address, packet[7]!);
        }
      }
      const response = answer(packet);
      if (response) inputListener?.({ data: new DataView(response.buffer) } as HIDInputReportEvent);
    },
    addEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport") inputListener = listener;
    },
    removeEventListener: () => { inputListener = null; },
  } as unknown as HIDDevice;

  return { device, sent, store };
}

test("mouse isSupported matches VID/PID on the 0xFF1C command page", () => {
  const { device } = fakeMouse();
  assert.ok(WallhackMouseHidClient.isSupported(device));
});

test("mouse readStatus decodes config, polling, LOD and firmware", async () => {
  const { device } = fakeMouse({
    [WALLHACK_FLASH.reportUsb]: 3, // 1000 Hz
    [WALLHACK_FLASH.silentHeight]: 1, // Medium
    [WALLHACK_FLASH.motionSyncEnable]: 1,
    [WALLHACK_FLASH.dpi8Block]: 1600,
  });
  const client = new WallhackMouseHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.brand, "WALLHACK");
  assert.equal(status.name, "WALLHACK M-001");
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.motionSync, true);
  assert.equal(status.batteryPercent, 77);
  assert.deepEqual(status.firmware, [
    "Mouse firmware: 1.4",
    "Receiver firmware: 2.13",
    "Receiver (NXP): 0.9",
  ]);
  await client.close();
});

test("mouse setMotionSync writes and verifies via read-back", async () => {
  const { device, store } = fakeMouse({ [WALLHACK_FLASH.motionSyncEnable]: 0 });
  const client = new WallhackMouseHidClient(device);
  await client.open();
  const result = await client.setMotionSync(true);
  assert.equal(result, true);
  assert.equal(store.get(WALLHACK_FLASH.motionSyncEnable), 1);
  await client.close();
});

test("mouse setPollingRate rejects an unsupported rate", async () => {
  const { device } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  await client.open();
  await assert.rejects(() => client.setPollingRate(1234), /not a supported/);
  await client.close();
});

test("mouse setDpi round-trips through the DPI-stage record", async () => {
  const { device } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  await client.open();
  assert.equal(await client.setDpi(3200), 3200);
  await client.close();
});

test("deviceBrand resolves the mouse client to WALLHACK", () => {
  const { device } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  assert.equal(deviceBrand(client), "WALLHACK");
});

test("keyboard isSupported matches on the 0xFFA0 command page", () => {
  const device = {
    vendorId: WALLHACK_VENDOR_ID,
    productId: 0x0806,
    productName: "WALLHACK K-001",
    opened: false,
    collections: [{
      usagePage: WALLHACK_KEYBOARD_USAGE_PAGE,
      usage: 1,
      children: [],
      inputReports: [{ reportId: 4, items: [] }],
      outputReports: [],
      featureReports: [],
    }],
    open: async () => {},
    close: async () => {},
  } as unknown as HIDDevice;
  assert.ok(WallhackKeyboardHidClient.isSupported(device));
});

test("keyboard readStatus identifies the board and hides the settings grid", async () => {
  const device = {
    vendorId: WALLHACK_VENDOR_ID,
    productId: 0x0806,
    productName: "WALLHACK K-001",
    opened: false,
    collections: [{
      usagePage: WALLHACK_KEYBOARD_USAGE_PAGE, usage: 1, children: [],
      inputReports: [], outputReports: [], featureReports: [],
    }],
    open: async () => {},
    close: async () => {},
  } as unknown as HIDDevice;
  const client = new WallhackKeyboardHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.brand, "WALLHACK");
  assert.equal(status.name, "WALLHACK K-001");
  assert.equal(status.ui?.settingsReady, false);
  assert.deepEqual(client.getDpiOptions(), []);
});
