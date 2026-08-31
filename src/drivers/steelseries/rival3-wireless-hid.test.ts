import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival3WirelessHidClient } from "./rival3-wireless-hid.ts";

function fakeDevice(
  options: {
    productId?: number;
    answerBattery?: boolean;
    answerFirmware?: boolean;
    battery?: number[];
    firmware?: number[];
  } = {},
) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x1830,
    productName: "SteelSeries Rival 3 Wireless",
    opened: true,
    collections: [],
    open: async () => {},
    close: async () => {},
    sendReport: async (reportId: number, data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const payload = [...view];
      sent.push({ reportId, payload });
      if (payload[0] === 0xaa && payload[1] === 0x01 && options.answerBattery !== false) {
        const response = new Uint8Array(options.battery ?? [72, 0x00, 0x00]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
      if (payload[0] === 0x90 && payload[1] === 0x00 && options.answerFirmware !== false) {
        const response = new Uint8Array(options.firmware ?? [0x25, 0x00]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Rival 3 Wireless protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 3 Wireless protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Rival 3 Wireless product id", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesRival3WirelessHidClient.isSupported(device), true);
  // Rival 3 Gen 1, Aerox 3, Rival 3 Gen 2, and Rival 3 Wireless Gen 2 must not be claimed.
  assert.equal(SteelSeriesRival3WirelessHidClient.isSupported({ ...device, productId: 0x1824 } as HIDDevice), false);
  assert.equal(SteelSeriesRival3WirelessHidClient.isSupported({ ...device, productId: 0x184c } as HIDDevice), false);
  assert.equal(SteelSeriesRival3WirelessHidClient.isSupported({ ...device, productId: 0x1836 } as HIDDevice), false);
  assert.equal(SteelSeriesRival3WirelessHidClient.isSupported({ ...device, productId: 0x1870 } as HIDDevice), false);
  assert.equal(SteelSeriesRival3WirelessHidClient.isSupported({ ...device, productId: 0x1872 } as HIDDevice), false);
  assert.equal(SteelSeriesRival3WirelessHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes battery and firmware, and never claims to have read DPI/polling", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival3WirelessHidClient(device).readStatus();
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0xaa, 0x01] },
    { reportId: 0, payload: [0x90, 0x00] },
  ]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 3 Wireless");
  assert.deepEqual(status.firmware, ["37.0"]);
  assert.equal(status.connectionType, "Wireless");
  // Battery is a real read, unlike Rival 3 Gen 1/Aerox 3.
  assert.equal(status.batteryPercent, 72);
  assert.equal(status.batteryState, "Discharging");
  // rivalcfg defaults for the still-write-only settings, flagged as assumptions.
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("readStatus reports a charging battery", async () => {
  const { device } = fakeDevice({ battery: [55, 0x00, 0x01] });
  const status = await new SteelSeriesRival3WirelessHidClient(device).readStatus();
  assert.equal(status.batteryPercent, 55);
  assert.equal(status.batteryState, "Charging");
});

test("a silent interface fails the battery probe loudly and names SteelSeries GG", async () => {
  const { device, sent } = fakeDevice({ answerBattery: false });
  await assert.rejects(new SteelSeriesRival3WirelessHidClient(device).readStatus(), /SteelSeries GG/);
  // The battery probe was the only report sent; the firmware probe never ran.
  assert.deepEqual(sent, [{ reportId: 0, payload: [0xaa, 0x01] }]);
});

test("a silent interface fails the firmware probe loudly after battery succeeds", async () => {
  const { device, sent } = fakeDevice({ answerFirmware: false });
  await assert.rejects(new SteelSeriesRival3WirelessHidClient(device).readStatus(), /firmware query/);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0xaa, 0x01] },
    { reportId: 0, payload: [0x90, 0x00] },
  ]);
});

test("setDpi and setPollingRate write the value then save, all on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3WirelessHidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x20, 0x01, 0x01, 0x12, 0x00] },
    { reportId: 0, payload: [0x09] },
    { reportId: 0, payload: [0x17, 0x01] },
    { reportId: 0, payload: [0x09] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("setButtonsMapping writes the packet then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3WirelessHidClient(device);
  await client.setButtonsMapping({ button6: { type: "dpiSwitch" } });
  const expected = new Array(30).fill(0x00);
  expected[0x19] = 0x30;
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x19, ...expected] },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("invalid values are rejected before any report reaches the mouse", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3WirelessHidClient(device);
  await assert.rejects(client.setDpi(150), /100 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /125, 250, 500, or 1000 Hz/);
  assert.deepEqual(sent, []);
});

test("concurrent setters never interleave their write/save pairs", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival3WirelessHidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125)]);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    [0x20, 0x01, 0x01, 0x04, 0x00],
    [0x09],
    [0x17, 0x03],
    [0x09],
  ]);
});
