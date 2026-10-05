import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesAerox3WirelessHidClient } from "./aerox3-wireless-hid.ts";

/** usage page `0xFFC0` as read from the `1038:1838` dongle's report descriptor. */
const CONFIG_COLLECTION = {
  usagePage: 0xffc0,
  usage: 0x01,
  children: [],
  inputReports: [{ reportId: 0 }],
  outputReports: [{ reportId: 0 }],
  featureReports: [],
} as unknown as HIDCollectionInfo;

function fakeDevice(options: {
  productId?: number;
  answerBattery?: boolean;
  battery?: number[];
  readback?: boolean;
  /** unsolicited reports the dongle pushes before the battery reply. */
  events?: number[][];
} = {}) {
  const sent: number[][] = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const emit = (bytes: number[]) => {
    const response = new Uint8Array(64);
    response.set(bytes);
    queueMicrotask(() => listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
  };
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x183a,
    productName: "SteelSeries Aerox 3 Wireless",
    opened: true,
    collections: [CONFIG_COLLECTION],
    open: async () => {},
    close: async () => {},
    sendReport: async (reportId: number, data: BufferSource) => {
      assert.equal(reportId, 0);
      const payload = [...new Uint8Array(data as ArrayBuffer)];
      sent.push(payload);
      if (payload[0] === 0x92 || payload[0] === 0xd2) {
        for (const event of options.events ?? []) emit(event);
        if (options.answerBattery !== false) emit(options.battery ?? [payload[0], 0x95]);
      } else if (options.readback) {
        emit([payload[0]!]);
      }
    },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

const DEFAULT_BUTTONS = (() => {
  const packet = new Array(40).fill(0x00);
  [0x01, 0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32].forEach((id, index) => { packet[index * 5] = id; });
  return packet;
})();

test("claims the four Aerox 3 Wireless pids and not the wired Aerox 3", () => {
  const { device } = fakeDevice();
  for (const productId of [0x183a, 0x187a, 0x1838, 0x1878]) {
    assert.equal(SteelSeriesAerox3WirelessHidClient.isSupported({ ...device, productId } as HIDDevice), true);
  }
  assert.equal(SteelSeriesAerox3WirelessHidClient.isSupported({ ...device, productId: 0x1836 } as HIDDevice), false);
  // the mouse, keyboard, consumer and 0xFFC1 collections refuse output reports.
  for (const usagePage of [0x01, 0x0c, 0xffc1]) {
    const collections = [{ usagePage, usage: 0x01, children: [] }] as unknown as HIDCollectionInfo[];
    assert.equal(SteelSeriesAerox3WirelessHidClient.isSupported({ ...device, collections } as HIDDevice), false);
  }
  assert.equal(SteelSeriesAerox3WirelessHidClient.isSupported({ ...device, productId: 0x1854 } as HIDDevice), false);
  assert.equal(SteelSeriesAerox3WirelessHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus decodes the captured battery reply and reports cached defaults", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesAerox3WirelessHidClient(device).readStatus();
  assert.deepEqual(sent, [[0x92]]);
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.dpiStages, [400, 800, 1200, 2400, 3200]);
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.sleepTimeout, 300);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.buttonMappings?.DPI, "DPI Cycle");
  assert.equal(status.buttonMappings?.["Scroll Up"], "Scroll Up");
  assert.deepEqual(status.lightingZones?.map(({ zone, mode, color }) => [zone, mode, color]), [
    ["Top", "Static", "#ff0000"],
    ["Middle", "Static", "#00ff00"],
    ["Bottom", "Static", "#0000ff"],
    ["Click reaction", "Off", "#ffffff"],
  ]);
});

test("the battery probe ignores replies that do not echo its command", async () => {
  const { device } = fakeDevice({ battery: [0x2b, 0x00] });
  await assert.rejects(new SteelSeriesAerox3WirelessHidClient(device).readStatus(), /SteelSeries GG/);
});

test("the dongle battery probe skips unsolicited events and decodes the captured reply", async () => {
  const { device, sent } = fakeDevice({ productId: 0x1838, events: [[0x40, 0xff, 0x01]], battery: [0xd2, 0x15] });
  const status = await new SteelSeriesAerox3WirelessHidClient(device).readStatus();
  assert.deepEqual(sent, [[0xd2]]);
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Discharging");
});

test("a sleeping mouse behind the dongle gets its own error, not the SteelSeries GG hint", async () => {
  const { device } = fakeDevice({ productId: 0x1838, events: [[0x40, 0xff, 0x01]], answerBattery: false });
  await assert.rejects(new SteelSeriesAerox3WirelessHidClient(device).readStatus(), /asleep or out of range/);
});

test("2.4 GHz mode flags every command", async () => {
  const { device, sent } = fakeDevice({ productId: 0x1838, readback: true });
  const client = new SteelSeriesAerox3WirelessHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.connectionType, "Wireless");
  await client.setPollingRate(500);
  assert.deepEqual(sent, [[0xd2], [0x6b, 0x01], [0x51, 0x00]]);
});

test("dpi stage edits rewrite the whole preset table then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3WirelessHidClient(device);
  await client.setDpiStageValue(1, 1600);
  await client.setActiveDpiStage(1);
  await client.setDpiStageCount(2);
  assert.deepEqual(sent, [
    [0x2d, 0x05, 0x00, 0x04, 0x12, 0x0d, 0x1b, 0x26],
    [0x11, 0x00],
    [0x2d, 0x05, 0x01, 0x04, 0x12, 0x0d, 0x1b, 0x26],
    [0x11, 0x00],
    [0x2d, 0x02, 0x01, 0x04, 0x12],
    [0x11, 0x00],
  ]);
  const status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [400, 1600]);
  assert.equal(status.dpi, 1600);
});

test("setSleepTimeout takes seconds and writes whole minutes", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3WirelessHidClient(device);
  assert.equal(await client.setSleepTimeout(600), 600);
  assert.deepEqual(sent[0], [0x29, 0xc0, 0x27, 0x09]);
  await assert.rejects(client.setSleepTimeout(90), /whole minutes/);
});

test("lighting zones map to zone colors, rainbow and reactive color", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3WirelessHidClient(device);
  const [top, , , reactive] = (await client.readStatus()).lightingZones!;
  sent.length = 0;
  await client.setLighting({ ...top!, mode: "Static", color: "#123456" });
  await assert.rejects(client.setLighting({ ...top!, mode: "Spectrum" }), /does not support Spectrum/);
  await client.setLighting({ ...reactive!, mode: "Reactive", color: "#00ff00" });
  await client.setLighting({ ...top!, mode: "Off" });
  assert.deepEqual(sent, [
    [0x21, 0x01, 0x00, 0x12, 0x34, 0x56],
    [0x11, 0x00],
    [0x26, 0x01, 0x00, 0x00, 0xff, 0x00],
    [0x11, 0x00],
    [0x21, 0x01, 0x00, 0x00, 0x00, 0x00],
    [0x11, 0x00],
  ]);
  const zones = (await client.readStatus()).lightingZones!;
  assert.deepEqual(zones.map(({ mode }) => mode), ["Off", "Static", "Static", "Reactive"]);
  assert.deepEqual(zones[0]!.modes, ["Static", "Off"]);
});

test("remapping one button keeps the rest of the default layout", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3WirelessHidClient(device);
  await client.setButtonMapping("DPI", "Play/Pause");
  const expected = [...DEFAULT_BUTTONS];
  expected[0x19] = 0x61;
  expected[0x1a] = 0xcd;
  assert.deepEqual(sent, [[0x2a, ...expected], [0x11, 0x00]]);
  assert.equal((await client.readStatus()).buttonMappings?.DPI, "Play/Pause");
  await assert.rejects(client.setButtonMapping("Left", "Disabled"), /Left Click/);
  await assert.rejects(client.setButtonMapping("Wheel", "Disabled"), /no "Wheel" button/);
});

test("invalid values never reach the mouse", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3WirelessHidClient(device);
  await assert.rejects(client.setDpi(150), /100 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /1000 Hz/);
  await assert.rejects(client.setDpiStageValue(5, 800), /stages 1 to 5/);
  await assert.rejects(client.setDimTimer(5000), /0 to 1200/);
  assert.deepEqual(sent, []);
});

test("concurrent setters never interleave their write and save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesAerox3WirelessHidClient(device);
  await Promise.all([client.setPollingRate(125), client.setDimTimer(0)]);
  assert.deepEqual(sent, [
    [0x2b, 0x03],
    [0x11, 0x00],
    [0x23, 0x0f, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0x11, 0x00],
  ]);
});
