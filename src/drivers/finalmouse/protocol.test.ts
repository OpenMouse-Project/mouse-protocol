import assert from "node:assert/strict";
import test from "node:test";
import { FinalmouseHidClient } from "./hid.ts";
import {
  buildFinalmouseReport,
  decodeFinalmouseReport,
  encodeFinalmouseClickMode,
  encodeFinalmouseDongleLedData,
  encodeFinalmouseIndicatorColor,
  encodeFinalmouseProfileData,
  encodeFinalmouseProfileEnable,
  encodeFinalmouseProfileName,
  encodeFinalmouseTmrActuation,
  encodeFinalmouseTmrMsp,
  finalmouseActuationMmToSteps,
  finalmouseBatteryPercent,
  finalmouseActuationStepsToMm,
  finalmousePawLodMmToRaw,
  finalmousePawLodRawIsCustom,
  finalmousePawLodRawToMm,
  finalmouseSignalStrength,
  FINALMOUSE_REPORT,
} from "@openmouse/protocol/finalmouse";

function input(command: number, payload: number[]): Uint8Array {
  return new Uint8Array([2 + payload.length, command, payload.length, ...payload]);
}

test("Finalmouse writes use xpanel report framing without duplicating the WebHID report ID", () => {
  const report = buildFinalmouseReport(17, new Uint8Array([0x40, 0x1f]));
  assert.equal(report.length, 63);
  assert.deepEqual([...report.slice(0, 6)], [4, 0x91, 2, 0x40, 0x1f, 0]);
});

test("Finalmouse status reports decode settings, signed RSSI, and terminated firmware strings", () => {
  assert.deepEqual(decodeFinalmouseReport(FINALMOUSE_REPORT.mainInput, input(3, [0x40, 0x06])), { dpi: 1600 });
  assert.deepEqual(decodeFinalmouseReport(FINALMOUSE_REPORT.mainInput, input(4, [0x40, 0x1f])), { pollingRateHz: 8000 });
  assert.deepEqual(decodeFinalmouseReport(FINALMOUSE_REPORT.mainInput, input(13, [0xc9])), { rssiDbm: -55 });
  assert.deepEqual(decodeFinalmouseReport(FINALMOUSE_REPORT.mainInput, input(18, [1])), { motionSync: true });
  assert.deepEqual(decodeFinalmouseReport(FINALMOUSE_REPORT.mainInput, input(21, [2])), { liftOffDistanceMm: 2 });
  assert.deepEqual(decodeFinalmouseReport(FINALMOUSE_REPORT.mainInput, input(24, [15])), { tournamentScrollTimeoutMs: 1500 });
  assert.deepEqual(decodeFinalmouseReport(FINALMOUSE_REPORT.mainInput, input(12, [49, 46, 50, 46, 51, 0])), { mouseFirmware: "1.2.3" });
});

test("Finalmouse battery conversion preserves xpanel calibration points", () => {
  assert.equal(finalmouseBatteryPercent(3000), 0);
  assert.equal(finalmouseBatteryPercent(3880), 50);
  assert.equal(finalmouseBatteryPercent(4276), 88);
  assert.equal(finalmouseBatteryPercent(4380), 100);
});

test("Finalmouse selects only the ULX vendor control collection", () => {
  const control = {
    vendorId: 0x361d,
    productId: 0x0100,
    collections: [{ usagePage: 0xff00, usage: 1 }],
  } as HIDDevice;
  const ordinaryMouse = {
    ...control,
    collections: [{ usagePage: 1, usage: 2 }],
  } as HIDDevice;
  assert.equal(FinalmouseHidClient.isSupported(control), true);
  assert.equal(FinalmouseHidClient.isSupported(ordinaryMouse), false);
  assert.equal(new FinalmouseHidClient(control).displayName(), "Finalmouse UltralightX");
});

test("Finalmouse settings use the main control report and little-endian values", async () => {
  const writes: Array<{ reportId: number; bytes: number[] }> = [];
  let opened = false;
  const device = {
    vendorId: 0x361d,
    productId: 0x0100,
    productName: "Finalmouse ULX",
    collections: [{ usagePage: 0xff00, usage: 1 }],
    get opened() { return opened; },
    async open() { opened = true; },
    async close() { opened = false; },
    addEventListener() {},
    removeEventListener() {},
    async sendReport(reportId: number, data: BufferSource) {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      writes.push({ reportId, bytes: [...bytes.slice(0, 5)] });
    },
  } as unknown as HIDDevice;
  const client = new FinalmouseHidClient(device);

  await client.setDpi(1600);
  await client.setPollingRate(8000);
  await client.setMotionSync(true);

  assert.deepEqual(writes, [
    { reportId: FINALMOUSE_REPORT.main, bytes: [4, 0x90, 2, 0x40, 0x06] },
    { reportId: FINALMOUSE_REPORT.main, bytes: [4, 0x91, 2, 0x40, 0x1f] },
    { reportId: FINALMOUSE_REPORT.main, bytes: [3, 0x92, 1, 1, 0] },
  ]);
});

function slxDevice() {
  let opened = false;
  const writes: Array<{ reportId: number; bytes: number[] }> = [];
  const device = {
    vendorId: 0x361d,
    productId: 0x0300,
    productName: "Finalmouse SLX",
    collections: [{ usagePage: 0xff00, usage: 1 }],
    get opened() { return opened; },
    async open() { opened = true; },
    async close() { opened = false; },
    addEventListener() {},
    removeEventListener() {},
    async sendReport(reportId: number, data: BufferSource) {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      writes.push({ reportId, bytes: [...bytes.slice(0, 12)] });
    },
  } as unknown as HIDDevice;
  return { device, writes, client: new FinalmouseHidClient(device) };
}

test("Finalmouse detects Starlight X dongles and routes them to report 0x01", async () => {
  const supported = {
    vendorId: 0x361d,
    productId: 0x0301,
    collections: [{ usagePage: 0xff00, usage: 9 }],
  } as HIDDevice;
  assert.equal(FinalmouseHidClient.isSupported(supported), true);
  assert.equal(
    FinalmouseHidClient.isSupported({ vendorId: 0x361d, productId: 0x1234, collections: [] } as unknown as HIDDevice),
    false,
  );
  const { client, writes } = slxDevice();
  assert.equal(client.isSlx, true);
  assert.equal(client.displayName(), "Finalmouse Starlight X");
  await client.setDpi(800);
  assert.deepEqual(writes, [{ reportId: FINALMOUSE_REPORT.slx, bytes: [4, 0x90, 2, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0] }]);
});

test("Finalmouse SLX-only setters reject Ultralight X hardware", async () => {
  const device = {
    vendorId: 0x361d,
    productId: 0x0100,
    collections: [{ usagePage: 0xff00, usage: 1 }],
    opened: true,
    async open() {},
    async close() {},
    addEventListener() {},
    removeEventListener() {},
    async sendReport() {},
  } as unknown as HIDDevice;
  const client = new FinalmouseHidClient(device);
  await assert.rejects(client.setClickMode(1, 1), /Starlight X/);
  await assert.rejects(client.setTmrActuation(0.2, 0.2), /Starlight X/);
  await assert.rejects(client.setLiftOffScale(10), /Starlight X/);
  await assert.rejects(client.setActiveProfile(0), /Starlight X/);
});

test("Finalmouse Starlight X reports decode click mode, TMR, profiles and PAW LOD", () => {
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(31, [1, 0, 2, 0])),
    { clickModeR: 1, clickModeL: 0, clickReleaseR: 2, clickReleaseL: 0 },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(53, [0x14, 0, 0x0a, 0, 0xdc, 0, 0xe6, 0])),
    { tmrThrR: 20, tmrThrL: 10, tmrHystR: 220, tmrHystL: 230 },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(55, [0x64, 0, 0x6e, 0])),
    { tmrMspR: 100, tmrMspL: 110 },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(57, [1, 5])),
    { profileActive: 1, profileCount: 5 },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(63, [2, 5, 0b10111])),
    { profileActive: 2, profileCount: 5, profileEnabledMask: 0b10111 },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(25, [10])),
    { pawLodMm: 1, pawLodCustom: true },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(25, [3])),
    { pawLodMm: 2, pawLodCustom: false },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(36, [1])),
    { linkState: 1 },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(38, [76, 0x44, 0x0f])),
    { batterySoc: 76, batteryVoltageMv: 0x0f44 },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(54, [255, 128, 0])),
    { indicatorColor: { r: 255, g: 128, b: 0 } },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(62, [2, 67, 111, 109, 112, 0])),
    { profileNames: { 2: "Comp" } },
  );
  assert.deepEqual(
    decodeFinalmouseReport(FINALMOUSE_REPORT.slxInput, input(61, [1, 2, 200, 10, 20, 30])),
    { profileLeds: { 1: { id: 1, mode: 2, brightness: 200, r: 10, g: 20, b: 30 } } },
  );
});

test("Finalmouse PAW LOD helpers follow xpanel's preset and custom tables", () => {
  assert.equal(finalmousePawLodRawToMm(2), 1);
  assert.equal(finalmousePawLodRawToMm(3), 2);
  assert.equal(finalmousePawLodRawToMm(10), 1);
  assert.equal(finalmousePawLodRawToMm(7), 0.7);
  assert.equal(finalmousePawLodRawToMm(4), null);
  assert.equal(finalmousePawLodMmToRaw(1), 2);
  assert.equal(finalmousePawLodMmToRaw(2), 3);
  assert.equal(finalmousePawLodMmToRaw(1.2), 12);
  assert.equal(finalmousePawLodMmToRaw(1.25), null);
  assert.equal(finalmousePawLodRawIsCustom(10), true);
  assert.equal(finalmousePawLodRawIsCustom(2), false);
});

test("Finalmouse TMR helpers convert actuation steps and clamp the range", () => {
  assert.equal(finalmouseActuationMmToSteps(0.2), 20);
  assert.equal(finalmouseActuationMmToSteps(0.001), 1);
  assert.equal(finalmouseActuationMmToSteps(9), 40);
  assert.equal(finalmouseActuationStepsToMm(25), 0.25);
  assert.deepEqual([...encodeFinalmouseTmrActuation(20, 10, 220, 230)], [20, 0, 10, 0, 220, 0, 230, 0]);
  assert.deepEqual([...encodeFinalmouseTmrMsp(100, 110)], [100, 0, 110, 0]);
  assert.deepEqual([...encodeFinalmouseClickMode(1, 0, 2, 0)], [1, 0, 2, 0]);
  assert.deepEqual([...encodeFinalmouseClickMode(0, 0)], [0, 0]);
  assert.deepEqual([...encodeFinalmouseIndicatorColor(1, 2, 3)], [1, 2, 3]);
  assert.deepEqual([...encodeFinalmouseProfileEnable(2, true)], [2, 1]);
  assert.deepEqual([...encodeFinalmouseProfileName(0, "Hi")], [0, 72, 105]);
  assert.deepEqual(
    [...encodeFinalmouseProfileData({
      dpi: 800, lod: 10, motionSync: 1, jscrollMode: 3, jscrollTimeout100ms: 5,
      thrUmR: 20, thrUmL: 10, modeR: 1, modeL: 0, enabled: 1,
    })],
    [0x20, 0x03, 10, 1, 3, 5, 20, 0, 10, 0, 1, 0, 1],
  );
  assert.deepEqual(
    [...encodeFinalmouseDongleLedData({ id: 1, mode: 2, brightness: 200, r: 10, g: 20, b: 30 })],
    [1, 2, 200, 10, 20, 30],
  );
  assert.throws(() => encodeFinalmouseClickMode(2, 0), /click mode/);
  assert.throws(() => encodeFinalmouseTmrActuation(0, 10), /actuation/);
  assert.throws(() => encodeFinalmouseTmrActuation(10, 10, 100, 220), /sensitivity/);
});

test("Finalmouse RSSI maps to xpanel's 1-4 signal scale", () => {
  assert.equal(finalmouseSignalStrength(-30), 4);
  assert.equal(finalmouseSignalStrength(-45), 3);
  assert.equal(finalmouseSignalStrength(-60), 2);
  assert.equal(finalmouseSignalStrength(-80), 1);
  assert.equal(finalmouseSignalStrength(undefined), null);
  assert.equal(finalmouseSignalStrength(-30, 0), null);
});

test("Finalmouse SLX setters frame TMR, profiles and PAW LOD on report 0x01", async () => {
  const { client, writes } = slxDevice();
  await client.setClickMode(0, 1, 0, 2);
  await client.setTmrActuation(0.1, 0.2, 220, 230);
  await client.setActiveProfile(2);
  await client.setLiftOffScale(12);
  assert.deepEqual(writes.map((write) => write.reportId), [1, 1, 1, 1]);
  assert.deepEqual(writes[0]!.bytes.slice(0, 7), [6, 0x9f, 4, 1, 0, 2, 0]);
  assert.deepEqual(writes[1]!.bytes.slice(0, 11), [10, 0xb5, 8, 20, 0, 10, 0, 230, 0, 220, 0]);
  assert.deepEqual(writes[2]!.bytes.slice(0, 4), [3, 0xb9, 1, 2]);
  assert.deepEqual(writes[3]!.bytes.slice(0, 4), [3, 0x99, 1, 12]);
});
