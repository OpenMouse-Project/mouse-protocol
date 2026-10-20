import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AJ200P_ACTIONS, AJ200P_COMMAND, AJ200P_PRODUCTS, AJ200P_RATES,
  aj200pBindingLabel, aj200pColorBytes, aj200pDecodeDpi, aj200pDecodeInfo,
  aj200pDecodeKeys, aj200pDecodeRate, aj200pDecodeReply, aj200pDecodeSettings,
  aj200pEncode, aj200pEncodeRate, aj200pFindAction, aj200pPatchDpi,
  aj200pSettingsLength,
} from "../../ajazz/aj200p.js";
import { AjazzAj200pHidClient } from "./aj200p-hid.js";
import { createSupportedClient, deviceBrand } from "../registry.ts";
import { SUPPORTED_HID_FILTERS } from "../vendors.ts";

// Configuration-only payloads observed on firmware 3.3.13. These contain no
// serial number, radio address, host key events or other identifying data.
const SETTINGS = Uint8Array.from([1,32,7,3,0,0,0,1,1,6,0,2,2,0,18,1,0,0,0,0,0,255,255,255,2,18,180,2,255,3,0,7,1,16,5,120,0,25,10]);
const DPI = Uint8Array.from([0,144,1,144,1,255,255,255,0,32,3,32,3,255,255,255,0,176,4,176,4,255,255,255,0,108,7,108,7,255,255,255,0,96,9,96,9,255,255,255,0,128,12,128,12,255,255,255,17,128,56,128,56,255,255,255,0,52,8,52,8,255,255,255]);
const KEYS = Uint8Array.from([1,1,0,1,4,0,1,2,0,1,8,0,1,16,0,8,255,0,0,0,0,9,1,0,9,2,0,3,1,0,3,2,0]);
function info(profile = 0): Uint8Array {
  const data = new Uint8Array(54);
  data.set([0x3d, 3, 0x3d, 3], 7);
  data[14] = 88; data[16] = 1; data[17] = profile;
  return data;
}
function response(command: number, payload = new Uint8Array(), status = 0): Uint8Array {
  const data = new Uint8Array(127);
  data[0] = command; data[1] = payload.length + (command === 0x19 ? 0 : 1); data[2] = status;
  data.set(payload, 3);
  return data;
}

describe("AJ200P MASTER codecs", () => {
  it("frames only configuration commands with their exact lengths", () => {
    assert.deepEqual([...aj200pEncode(0x21, [4]).slice(0, 4)], [0x21, 1, 4, 0]);
    assert.equal(aj200pEncode(0x13).length, 127);
    assert.equal(aj200pEncode(0x1a, DPI)[1], 64);
    assert.throws(() => aj200pEncode(0x18, SETTINGS.slice(0, 29)));
    assert.throws(() => aj200pEncode(0x21, [5]));
    assert.throws(() => aj200pEncode(0x21, [-1]));
    assert.throws(() => aj200pEncode(0x16, Array(33).fill(256)));
    assert.throws(() => aj200pEncode(0x30 as never));
    assert.throws(() => aj200pEncode(0xef as never));
  });
  it("handles the DPI length exception and DataView-sized replies", () => {
    assert.deepEqual(aj200pDecodeReply(10, response(0x17, SETTINGS), 0x17), SETTINGS);
    assert.deepEqual(aj200pDecodeReply(11, response(0x19, DPI), 0x19), DPI);
    assert.equal(aj200pDecodeReply(1, response(0x17, SETTINGS), 0x17), null);
    assert.equal(aj200pDecodeReply(10, response(0x15, KEYS), 0x17), null);
    assert.throws(() => aj200pDecodeReply(10, response(0x17, SETTINGS).slice(0, 41), 0x17), /truncated/);
    assert.throws(() => aj200pDecodeReply(10, response(0x19, DPI.slice(0, 63)), 0x19), /layout/);
    assert.throws(() => aj200pDecodeReply(10, response(0x16, new Uint8Array(), 255), 0x16), /status 255/);
    assert.throws(() => aj200pDecodeReply(10, Uint8Array.of(0x15), 0x15), /Truncated/);
    assert.throws(() => aj200pDecodeReply(10, response(0x17, new Uint8Array(29)), 0x17), /layout/);
  });
  it("decodes identity without exposing radio identifiers", () => {
    assert.deepEqual(aj200pDecodeInfo(info()), { profile: 1, wireless: true, receiverVersion: "3.3.13", mouseVersion: "3.3.13", battery: 88, charging: false });
    const data = info(4); data[14] = 255;
    assert.equal(aj200pDecodeInfo(data).battery, null);
    assert.equal(aj200pDecodeInfo(data).profile, 5);
    data[17] = 5; assert.throws(() => aj200pDecodeInfo(data));
  });
  it("reads all 39 setting bytes while keeping non-boolean ripple and flywheel fields", () => {
    const config = aj200pDecodeSettings(SETTINGS);
    assert.equal(config.count, 7); assert.equal(config.active, 3);
    assert.equal(config.wirelessRate, 1000); assert.equal(config.wiredRate, 4000);
    assert.equal(config.ripple, 2); assert.equal(config.sleepSeconds, 180);
    assert.deepEqual(config.raw, SETTINGS);
    assert.throws(() => aj200pDecodeSettings(new Uint8Array(39)));
  });
  it("round-trips every rate and rejects unsupported values", () => {
    for (const hz of AJ200P_RATES) assert.equal(aj200pDecodeRate(aj200pEncodeRate(hz)), hz);
    assert.equal(aj200pDecodeRate(0), null);
    assert.throws(() => aj200pEncodeRate(750));
  });
  it("decodes 20-bit independent DPI axes and patches only one slot", () => {
    assert.deepEqual(aj200pDecodeDpi(DPI).map((stage) => stage.x), [400,800,1200,1900,2400,3200,80000,2100]);
    const updated = aj200pPatchDpi(DPI, 6, { x: 1, y: 79999, color: "#1234ab" });
    assert.deepEqual(aj200pDecodeDpi(updated)[6], { x: 1, y: 79999, color: "#1234ab" });
    assert.deepEqual(updated.slice(0, 48), DPI.slice(0, 48));
    assert.deepEqual(updated.slice(56), DPI.slice(56));
    assert.deepEqual(aj200pPatchDpi(DPI, 6, { x: 80000 }), DPI);
    assert.deepEqual(aj200pDecodeDpi(aj200pPatchDpi(DPI, 0, { x: 65536 }))[0], { x: 65536, y: 400, color: "#ffffff" });
    for (const value of [0, 80001, 1.5, NaN]) assert.throws(() => aj200pPatchDpi(DPI, 0, { x: value }));
    assert.throws(() => aj200pPatchDpi(DPI, 8, { x: 800 }));
    assert.throws(() => aj200pColorBytes("#f00"));
    assert.deepEqual(DPI.slice(0, 8), Uint8Array.of(0,144,1,144,1,255,255,255));
  });
  it("provides unique action names/encodings and preserves opaque assignments", () => {
    assert.equal(AJ200P_ACTIONS.length, new Set(AJ200P_ACTIONS.map((a) => a.label)).size);
    assert.equal(AJ200P_ACTIONS.length, new Set(AJ200P_ACTIONS.map((a) => a.binding.join(","))).size);
    assert.deepEqual(aj200pFindAction("Cycle profiles"), [8,255,0]);
    assert.deepEqual(aj200pFindAction("Profile 5"), [8,4,0]);
    assert.deepEqual(aj200pFindAction("Polling rate 8000 Hz"), [7,64,0]);
    assert.deepEqual(aj200pFindAction("Left Ctrl"), [11,0xe0,8]);
    assert.deepEqual(aj200pFindAction("W"), [11,26,0]);
    assert.deepEqual(aj200pFindAction("Volume up"), [10,0xe9,0]);
    assert.equal(aj200pBindingLabel([12,9,0]), "Custom (12,9,0)");
    assert.equal(aj200pBindingLabel([6,2,1]), "Macro 3");
    assert.equal(aj200pFindAction("Unknown"), null);
    assert.equal(aj200pDecodeKeys(KEYS).length, 11);
    assert.throws(() => aj200pDecodeKeys(KEYS.slice(0, 32)));
    assert.equal(AJ200P_ACTIONS.some((a) => a.binding[0] === 12 || a.binding[0] === 13), false);
  });
});

const LEGACY_DPI = Uint8Array.from([7,7,51,255,0,0,15,15,51,0,255,0,23,23,51,0,0,255,31,31,51,255,255,0,47,47,51,255,0,255,63,63,51,0,255,255,127,127,51,255,255,255,255,255,51,255,255,255]);
interface MockOptions { ignoreWrites?: boolean; rejectWrites?: boolean; silent?: boolean; delayedAck?: boolean; productId?: number }
function fakeMouse(options: MockOptions = {}) {
  const productId = options.productId ?? 0xed1c;
  const product = AJ200P_PRODUCTS.get(productId)!;
  const banks = Array.from({ length: 5 }, () => ({ settings: SETTINGS.slice(0, aj200pSettingsLength(product)), dpi: product.sensor === "PAW3955" ? DPI.slice() : LEGACY_DPI.slice(), keys: KEYS.slice(0, product.flywheel ? 33 : 21) }));
  for (const bank of banks) bank.settings[1] = 1;
  if (productId === 0xed1c) for (const bank of banks) bank.settings[1] = SETTINGS[1];
  const state = { profile: 0, wireless: !product.wired, beforeCommand: (_command: number) => {} };
  const listeners = new Set<(event: HIDInputReportEvent) => void>();
  const commands: number[] = [];
  let awaitingAck = false;
  const emit = (data: Uint8Array, reportId = 10) => {
    // Nonzero DataView offset catches decoders that use the entire buffer.
    const storage = new Uint8Array(data.length + 9); storage.set(data, 5);
    const event = { reportId, data: new DataView(storage.buffer, 5, data.length) } as HIDInputReportEvent;
    for (const fn of [...listeners]) fn(event);
  };
  const device = {
    vendorId: 0x363c, productId, opened: false,
    collections: [{ usagePage: 0xffa0, usage: 2, children: [] }],
    open: async () => { device.opened = true; }, close: async () => { device.opened = false; },
    addEventListener: (_type: string, fn: (event: HIDInputReportEvent) => void) => { listeners.add(fn); },
    removeEventListener: (_type: string, fn: (event: HIDInputReportEvent) => void) => { listeners.delete(fn); },
    sendReport: async (reportId: number, source: BufferSource) => {
      assert.equal(reportId, 11);
      const body = new Uint8Array(source as ArrayBuffer);
      assert.equal(body.length, 127);
      const command = body[0]; commands.push(command); state.beforeCommand(command);
      assert.equal(awaitingAck, false, "a read must not overtake a write acknowledgement");
      if (options.silent) return;
      emit(response(0x12)); // unrelated unsolicited notification
      const bank = banks[state.profile];
      if (command === 0x13) { const data = info(state.profile); data[16] = Number(state.wireless); emit(response(command, data)); }
      else if (command === 0x17) emit(response(command, bank.settings));
      else if (command === 0x19) emit(response(command, bank.dpi), 11);
      else if (command === 0x15) emit(response(command, bank.keys));
      else {
        const acknowledge = () => {
          awaitingAck = false;
          if (!options.ignoreWrites && !options.rejectWrites) {
            if (command === 0x21) state.profile = body[2];
            else if (command === 0x18) bank.settings.set(body.slice(2, 2 + body[1]));
            else if (command === 0x1a) bank.dpi.set(body.slice(2, 2 + body[1]));
            else if (command === 0x16) bank.keys.set(body.slice(2, 2 + body[1]));
            else assert.fail("Unexpected command");
          }
          emit(response(command, new Uint8Array(), options.rejectWrites ? 255 : 0));
        };
        if (options.delayedAck) { awaitingAck = true; setTimeout(acknowledge, 1); }
        else acknowledge();
      }
    },
  };
  const client = new AjazzAj200pHidClient(device as unknown as HIDDevice, { replyTimeoutMs: 50, settleAfterWriteMs: 0 });
  return { client, device: device as unknown as HIDDevice, state, banks, commands, listeners };
}

describe("AjazzAj200pHidClient", () => {
  it("claims only exact product ids and configuration collections, and is registered", () => {
    const { device } = fakeMouse();
    assert.ok(AjazzAj200pHidClient.isSupported(device));
    assert.ok(createSupportedClient(device) instanceof AjazzAj200pHidClient);
    assert.equal(deviceBrand(createSupportedClient(device)!), "AJAZZ");
    for (const patch of [{ vendorId: 0x1234 }, { productId: 0xffff }, { collections: [] }]) assert.equal(AjazzAj200pHidClient.isSupported({ ...device, ...patch }), false);
    for (const productId of AJ200P_PRODUCTS.keys()) assert.ok(SUPPORTED_HID_FILTERS.some((f) => f.vendorId === device.vendorId && f.productId === productId && f.usagePage === 0xffa0 && f.usage === 2));
  });
  it("reads the active bank without switching or writing any profile", async () => {
    const { client, commands, listeners } = fakeMouse();
    const status = await client.readStatus();
    assert.equal(status.name, "AJAZZ AJ200P AI MASTER");
    assert.equal(status.activeProfile, 1); assert.equal(status.profileCount, 5);
    assert.equal(status.batteryPercent, 88); assert.equal(status.dpi, 1900);
    assert.equal(status.dpiY, 1900); assert.equal(status.pollingRateHz, 1000);
    assert.equal(status.buttonMappings?.Bottom, "Cycle profiles");
    assert.equal(Object.keys(status.buttonMappings!).length, 11);
    assert.equal(status.lighting?.color, "#ffffff");
    assert.equal(status.lighting?.mode, "Breathing single");
    assert.equal(status.dpiStageColors?.[0], "#ffffff");
    assert.equal(status.rippleControl, undefined);
    assert.deepEqual(status.firmware, ["Mouse 3.3.13", "Receiver 3.3.13"]);
    assert.deepEqual(commands, [0x13,0x17,0x19,0x15,0x13]);
    assert.equal(listeners.size, 0);
  });
  it("serializes complete transactions, preserves unknown bytes, and waits for acknowledgements", async () => {
    const { client, banks } = fakeMouse({ delayedAck: true });
    await client.readStatus();
    await Promise.all([client.setDebounceTime(5), client.setMotionSync(false), client.setPollingRate(2000)]);
    const expected = SETTINGS.slice(); expected[7] = 5; expected[8] = 0; expected[0] = 16;
    assert.deepEqual(banks[0].settings, expected);
    for (const bank of banks.slice(1)) assert.deepEqual(bank.settings, SETTINGS);
  });
  it("edits all 11 slots while retaining macros and unclassified actions in others", async () => {
    const { client, banks } = fakeMouse();
    banks[0].keys.set([6,3,2], 18); banks[0].keys.set([12,9,0], 27);
    const before = banks[0].keys.slice();
    await client.readStatus(); await client.setButtonMapping("Bottom", "Profile 5");
    const expected = before.slice(); expected.set([8,4,0], 15);
    assert.deepEqual(banks[0].keys, expected);
    await assert.rejects(client.setButtonMapping("Left", "Disabled"), /left-click/);
    await client.setButtonMapping("Forward", "Left click");
    await client.setButtonMapping("Left", "Disabled");
  });
  it("writes independent axes, stage colours/count and active stage", async () => {
    const { client, banks } = fakeMouse();
    await client.readStatus();
    await client.setDpiStageAxes(0, 65536, 80000);
    await client.setDpiStageColor(0, "#006400");
    assert.deepEqual(aj200pDecodeDpi(banks[0].dpi)[0], { x: 65536, y: 80000, color: "#006400" });
    assert.deepEqual(banks[0].dpi.slice(8), DPI.slice(8));
    await client.setDpiStageCount(2);
    assert.equal(banks[0].settings[2], 2); assert.equal(banks[0].settings[3], 1);
    await client.setDpi(801);
    assert.deepEqual(aj200pDecodeDpi(banks[0].dpi)[1], { x: 801, y: 801, color: "#ffffff" });
    await client.setDpiStageCount(8); await client.setActiveDpiStage(7);
    assert.equal(banks[0].settings[3], 7);
    await assert.rejects(client.setActiveDpiStage(8));
  });
  it("keeps DPI theme colour distinct from stage colours and retains rounded brightness", async () => {
    const { client, banks } = fakeMouse(); banks[0].settings[28] = 127;
    const lighting = (await client.readStatus()).lighting!;
    await client.setLighting({ ...lighting, color: "#ff00ff", mode: "Static" });
    assert.deepEqual(banks[0].settings.slice(21, 24), Uint8Array.of(255,0,255));
    assert.equal(banks[0].settings[28], 127);
    assert.deepEqual(banks[0].dpi, DPI);
    await client.setLighting({ ...lighting, brightness: 20, speed: 5 });
    assert.equal(banks[0].settings[28], 51); assert.equal(banks[0].settings[29], 5);
  });
  it("switches and edits the selected bank only", async () => {
    const { client, state, banks } = fakeMouse();
    await client.readStatus(); await client.setProfile(5); await client.setDebounceTime(4);
    assert.equal(state.profile, 4); assert.equal(banks[4].settings[7], 4);
    assert.deepEqual(banks[0].settings, SETTINGS);
    await assert.rejects(client.setProfile(0)); await assert.rejects(client.setProfile(6));
  });
  it("refuses stale-bank writes and a bank change inside a transaction", async () => {
    const { client, state, commands } = fakeMouse();
    await client.readStatus(); state.profile = 1;
    await assert.rejects(client.setDebounceTime(5), /profile changed/);
    assert.equal(commands.includes(0x18), false);
    await client.readStatus();
    state.beforeCommand = (command) => { if (command === 0x17) state.profile = 2; };
    await assert.rejects(client.setDebounceTime(5), /profile changed/);
    assert.equal(commands.includes(0x18), false);
  });
  it("detects ignored or rejected writes and leaves the queue usable", async () => {
    const mock = fakeMouse({ ignoreWrites: true }); await mock.client.readStatus();
    await assert.rejects(mock.client.setDebounceTime(5), /read-back differed/);
    assert.equal((await mock.client.readStatus()).debounceMs, 1);
    const rejected = fakeMouse({ rejectWrites: true });
    await assert.rejects(rejected.client.setDebounceTime(5), /status 255/);
    assert.equal(rejected.listeners.size, 0);
  });
  it("rejects invalid settings before sending writes", async () => {
    const { client, commands } = fakeMouse();
    for (const run of [() => client.setDpi(0), () => client.setPollingRate(750), () => client.setDebounceTime(0), () => client.setSleepTimeout(0), () => client.setButtonMapping("No button", "W")]) await assert.rejects(run);
    assert.equal(commands.length, 0);
  });
  it("cleans listeners on timeout and cancellation", async () => {
    const { client, listeners } = fakeMouse({ silent: true });
    await assert.rejects(client.readStatus(), /timed out/); assert.equal(listeners.size, 0);
    const pending = assert.rejects(client.readStatus(), /closed/);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await client.close(); await pending; assert.equal(listeners.size, 0);
  });
  it("decodes and patches the legacy 6-byte format without clearing reserved bits", () => {
    assert.deepEqual(aj200pDecodeDpi(LEGACY_DPI).map((stage) => stage.x), [400,800,1200,1600,2400,3200,6400,12800]);
    const changed = aj200pPatchDpi(LEGACY_DPI, 0, { x: 42000, y: 50, color: "#123456" });
    assert.deepEqual([...changed.slice(0, 6)], [71,0,243,18,52,86]);
    assert.deepEqual(aj200pDecodeDpi(changed)[0], { x: 42000, y: 50, color: "#123456" });
    assert.deepEqual(changed.slice(6), LEGACY_DPI.slice(6));
    assert.throws(() => aj200pPatchDpi(LEGACY_DPI, 0, { x: 401 }), /50-DPI/);
  });
  it("covers every catalogued interface with model-specific layouts and limits", async () => {
    assert.equal(AJ200P_PRODUCTS.size, 22);
    assert.deepEqual([...AJ200P_PRODUCTS].filter(([,p]) => p.verified).map(([id]) => id), [0xed1c]);
    for (const [productId, product] of AJ200P_PRODUCTS) {
      const { client, banks, device } = fakeMouse({ productId });
      assert.ok(AjazzAj200pHidClient.isSupported(device));
      const status = await client.readStatus();
      assert.equal(status.name, product.name);
      assert.equal(Object.keys(status.buttonMappings!).length, product.flywheel ? 11 : 7);
      assert.equal(status.ui?.dpiStageEditor?.maxDpi, product.maxDpi);
      assert.equal(status.buttonOptions?.includes("Cycle profiles"), true);
      assert.equal(Boolean(status.ui?.statusNote), !product.hiddenActionsAnalyzed);
      await client.setDpiStageAxes(0, product.maxDpi, product.minDpi);
      assert.equal(aj200pDecodeDpi(banks[0].dpi)[0].x, product.maxDpi);
      await client.setButtonMapping("Forward", "W");
      assert.deepEqual([...banks[0].keys.slice(12,15)], [11,26,0]);
      const unsupportedRate = product.wired ? 16000 : product.wirelessRates.includes(8000) ? 16000 : 8000;
      await assert.rejects(client.setPollingRate(unsupportedRate));
      await assert.rejects(client.setDpi(product.maxDpi + product.stepDpi));
      if (product.lodCodes.length === 0) await assert.rejects(client.setLiftOffDistance("Low"));
      if (!product.flywheel) await assert.rejects(client.setButtonMapping("Scroll up", "W"));
      await client.setButtonMapping("Bottom", "Cycle profiles");
    }
  });
});
