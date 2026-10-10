import assert from "node:assert/strict";
import test from "node:test";

import { WallhackMouseHidClient } from "./mouse-hid.ts";
import { WallhackKeyboardHidClient } from "./keyboard-hid.ts";
import { deviceBrand } from "../registry.ts";
import {
  WALLHACK_BUTTON_ORDER,
  WALLHACK_COMMAND,
  WALLHACK_CURVE_ADDRESS,
  WALLHACK_CURVE_PRESETS,
  WALLHACK_FLASH,
  WALLHACK_KEYBOARD_USAGE_PAGE,
  WALLHACK_KEY_SLOTS,
  WALLHACK_MACRO_SLOTS,
  WALLHACK_MOUSE_USAGE_PAGE,
  WALLHACK_TRIPLET_SIZE,
  WALLHACK_VENDOR_ID,
  type WallhackTriplet,
} from "@openmouse/protocol/wallhack";

/**
 * A fake M-001 that keeps a config-byte map and answers function-area reads,
 * version and battery on the input-report channel — the same shape the real
 * mouse uses (report id 4, command echoed at byte 2, payload from byte 7).
 * Key slots, macro storage and curve tables are modelled too, so button,
 * macro and curve writes can be verified by re-read.
 */
function fakeMouse(config: Record<number, number> = {}) {
  const store = new Map<number, number>(Object.entries(config).map(([k, v]) => [Number(k), v]));
  const mem = (address: number): number => store.get(address) ?? 0;
  const keySlots: WallhackTriplet[] = WALLHACK_BUTTON_ORDER.map((button) => {
    const bits = { left: 1, right: 2, middle: 4, back: 8, forward: 16 }[button]!;
    return { keyType: 16, codeL: bits, codeH: 0 };
  });
  while (keySlots.length < WALLHACK_KEY_SLOTS) keySlots.push({ keyType: 0, codeL: 0, codeH: 0 });
  const macroIndex = new Map<number, number>();
  const macroMem = new Map<number, number>();
  const curves = new Map<string, { speed: number; gain: number }[]>(
    Object.entries(WALLHACK_CURVE_PRESETS).map(([mode, points]) => [mode, points.map((p) => ({ ...p }))]),
  );
  let inputListener: ((event: HIDInputReportEvent) => void) | null = null;
  let opened = false;
  const sent: Uint8Array[] = [];

  const answer = (packet: Uint8Array): Uint8Array | null => {
    const command = packet[2]!;
    const response = new Uint8Array(63);
    response[2] = command;
    if (command === WALLHACK_COMMAND.readFunctionArea) {
      const address = packet[4]! | (packet[5]! << 8);
      const count = packet[3]!;
      response[4] = packet[4]!;
      response[5] = packet[5]!;
      const curveMode = [...curves.keys()].find((mode) => {
        const base = WALLHACK_CURVE_ADDRESS[mode as keyof typeof WALLHACK_CURVE_ADDRESS];
        return address === base;
      });
      if (curveMode) {
        const points = curves.get(curveMode)!;
        response[3] = curveMode === "custom" ? 20 : 10;
        response[6] = 0; // status OK
        if (curveMode === "custom") {
          points.forEach((point, index) => {
            response[7 + index * 4] = point.speed & 0xff;
            response[7 + index * 4 + 1] = (point.speed >> 8) & 0xff;
            const hundredths = Math.round(point.gain * 100);
            response[7 + index * 4 + 2] = hundredths & 0xff;
            response[7 + index * 4 + 3] = (hundredths >> 8) & 0xff;
          });
        } else {
          points.forEach((point, index) => {
            response[7 + index * 2] = point.speed & 0xff;
            response[7 + index * 2 + 1] = Math.round(point.gain * 100) & 0xff;
          });
        }
        return response;
      }
      if (address === WALLHACK_FLASH.dpi8Block) {
        const dpi = store.get(WALLHACK_FLASH.dpi8Block) ?? 1600;
        response[7] = 1;
        response[9] = dpi & 0xff;
        response[10] = (dpi >> 8) & 0xff;
      } else {
        for (let i = 0; i < count && 7 + i < 63; i++) response[7 + i] = mem(address + i);
      }
      return response;
    }
    if (command === WALLHACK_COMMAND.writeFunctionArea) {
      return null; // writes are silent; the driver reads back to verify
    }
    if (command === WALLHACK_COMMAND.getKeys) {
      const count = packet[3]!;
      response[3] = count;
      for (let i = 0; i < keySlots.length && 7 + i * 3 + 2 < 63; i++) {
        response[7 + i * 3] = keySlots[i]!.keyType;
        response[7 + i * 3 + 1] = keySlots[i]!.codeL;
        response[7 + i * 3 + 2] = keySlots[i]!.codeH;
      }
      return response;
    }
    if (command === WALLHACK_COMMAND.setKeys) {
      return null;
    }
    if (command === WALLHACK_COMMAND.getMacro) {
      const address = packet[4]! | (packet[5]! << 8);
      const count = packet[3]!;
      response[3] = count;
      response[4] = packet[4]!;
      response[5] = packet[5]!;
      for (let i = 0; i < count && 7 + i < 63; i++) {
        const at = address + i;
        if (at >= 16 && at < 16 + WALLHACK_MACRO_SLOTS * 2) {
          const slot = Math.floor((at - 16) / 2);
          response[7 + i] = ((macroIndex.get(slot) ?? 0) >> (((at - 16) % 2) * 8)) & 0xff;
        } else {
          response[7 + i] = macroMem.get(at) ?? 0;
        }
      }
      return response;
    }
    if (command === WALLHACK_COMMAND.setMacro) {
      return null;
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
        const count = packet[3]!;
        if (address === WALLHACK_FLASH.dpi8Block) {
          store.set(WALLHACK_FLASH.dpi8Block, packet[9]! | (packet[10]! << 8));
        } else if (
          Object.values(WALLHACK_CURVE_ADDRESS).includes(address as (typeof WALLHACK_CURVE_ADDRESS)[keyof typeof WALLHACK_CURVE_ADDRESS])
        ) {
          const mode = (Object.entries(WALLHACK_CURVE_ADDRESS) as [string, number][]).find(([, base]) => base === address)![0];
          const points = curves.get(mode)!;
          for (let i = 0; i < points.length; i++) {
            points[i] = {
              speed: (packet[7 + i * 4]! | (packet[7 + i * 4 + 1]! << 8)) & 0xffff,
              gain: ((packet[7 + i * 4 + 2]! | (packet[7 + i * 4 + 3]! << 8)) & 0xffff) / 100,
            };
          }
        } else {
          for (let i = 0; i < count; i++) store.set(address + i, packet[7 + i]!);
        }
      }
      if (packet[2] === WALLHACK_COMMAND.setKeys) {
        const start = (packet[4]! | (packet[5]! << 8)) / WALLHACK_TRIPLET_SIZE;
        const count = packet[3]! / WALLHACK_TRIPLET_SIZE;
        for (let i = 0; i < count; i++) {
          keySlots[start + i] = { keyType: packet[7 + i * 3]!, codeL: packet[7 + i * 3 + 1]!, codeH: packet[7 + i * 3 + 2]! };
        }
      }
      if (packet[2] === WALLHACK_COMMAND.setMacro) {
        const address = packet[4]! | (packet[5]! << 8);
        const count = packet[3]!;
        if (address >= 16 && address < 24 && count === 2) {
          macroIndex.set((address - 16) / 2, (packet[7]! | (packet[8]! << 8)) & 0xffff);
        }
        for (let i = 0; i < count; i++) macroMem.set(address + i, packet[7 + i]!);
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

test("mouse readStatus reports sensor angle in degrees and scanning mode", async () => {
  const { device } = fakeMouse({
    [WALLHACK_FLASH.angleTuneValue]: 22, // -8°
    [WALLHACK_FLASH.gameMode]: 1, // ACCEL
  });
  const client = new WallhackMouseHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.angleTuning, -8);
  assert.equal(status.sensorScanningMode, "ACCEL");
  await client.close();
});

test("mouse setAngleTuning writes degrees+30 and setSensorScanningMode maps ACCEL", async () => {
  const { device, store } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  await client.open();
  assert.equal(await client.setAngleTuning(-30), -30);
  assert.equal(store.get(WALLHACK_FLASH.angleTuneValue), 0);
  assert.equal(await client.setSensorScanningMode("ACCEL"), "ACCEL");
  assert.equal(store.get(WALLHACK_FLASH.gameMode), 1);
  await assert.rejects(() => client.setAngleTuning(31), /-30\.\.\+30/);
  await client.close();
});

test("mouse sleep timeout uses the u16LE second count", async () => {
  const { device } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  await client.open();
  assert.equal(await client.setSleepTimeout(5), 5);
  const status = await client.readStatus();
  assert.equal(status.sleepTimeout, 5);
  await assert.rejects(() => client.setSleepTimeout(31), /1 and 30/);
  await client.close();
});

test("mouse button mappings round-trip through GET_KEYS/SET_KEYS", async () => {
  const { device } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  await client.open();
  const before = await client.readButtonBindings();
  assert.equal(before.mappings["Left"], "Left Click");
  await client.setButtonMapping("Back", "DPI Cycle");
  const after = await client.readButtonBindings();
  assert.equal(after.mappings["Back"], "DPI Cycle");
  assert.equal(after.mappings["Left"], "Left Click");
  await client.setButtonMapping("Forward", "Macro 2 Toggle");
  assert.equal((await client.readButtonBindings()).mappings["Forward"], "Macro 2 Toggle");
  await client.resetButtonMappings();
  assert.equal((await client.readButtonBindings()).mappings["Back"], "Back");
  await assert.rejects(() => client.setButtonMapping("Wheel", "Left Click"), /no "Wheel" button/);
  await assert.rejects(() => client.setButtonMapping("Left", "Hyper Click"), /Unknown button action/);
  await client.close();
});

test("mouse macros store, re-read and clear", async () => {
  const { device } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  await client.open();
  assert.deepEqual(await client.getMacros(), [null, null, null, null]);
  const steps = [
    { delayMs: 10, event: { type: "keyDown", hidUsage: 4 } },
    { delayMs: 20, event: { type: "keyUp", hidUsage: 4 } },
    { delayMs: 0, event: { type: "buttonDown", button: "left" } },
  ] as const;
  const stored = await client.setMacroSlot(0, steps.map((s) => ({ ...s, event: { ...s.event } })));
  assert.equal(stored.length, 3);
  assert.deepEqual((await client.getMacros())[0], stored);
  await client.clearMacroSlot(0);
  assert.equal((await client.getMacros())[0], null);
  await client.close();
});

test("mouse dynamic sensitivity curves read and custom writes verify", async () => {
  const { device } = fakeMouse();
  const client = new WallhackMouseHidClient(device);
  await client.open();
  const curves = await client.getDynamicSensitivityCurves();
  assert.deepEqual(curves.classic[0], { speed: 0, gain: 1 });
  assert.deepEqual(curves.jump[2], { speed: 21, gain: 1.5 });
  const custom = [
    { speed: 0, gain: 1 }, { speed: 70, gain: 1.2 }, { speed: 140, gain: 1.4 },
    { speed: 210, gain: 1.6 }, { speed: 280, gain: 2 },
  ];
  assert.deepEqual(await client.setCustomCurve(custom), custom);
  assert.equal(await client.setDynamicSensitivityMode("custom"), "custom");
  assert.equal(await client.setDynamicSensitivityEnabled(true), true);
  await assert.rejects(
    () => client.setCustomCurve([{ speed: 0, gain: 1 }]),
    /exactly 5 points/,
  );
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
