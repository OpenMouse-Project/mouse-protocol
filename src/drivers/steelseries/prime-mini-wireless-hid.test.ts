import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesPrimeMiniWirelessHidClient } from "./prime-mini-wireless-hid.ts";

function fakeDevice(
  options: {
    productId?: number;
    answerBattery?: boolean;
    battery?: number[];
  } = {},
) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x184a, // wired-mode by default
    productName: "SteelSeries Prime Mini Wireless",
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
      if ((payload[0] === 0x92 || payload[0] === 0xd2) && options.answerBattery !== false) {
        const response = new Uint8Array(options.battery ?? [0x00, 0x0b]);
        queueMicrotask(() =>
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent));
      }
    },
    sendFeatureReport: async () => { throw new Error("the Prime Mini Wireless protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Prime Mini Wireless protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("claims only the Prime Mini Wireless PIDs (both transports) and nothing else", () => {
  const { device } = fakeDevice();
  for (const productId of [0x184a, 0x1848]) {
    assert.equal(
      SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId } as HIDDevice),
      true,
      `expected 0x${productId.toString(16)} to be claimed`,
    );
  }
  // Sibling SteelSeries PIDs already claimed by other families must not be claimed.
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1824 } as HIDDevice), false); // Rival 3
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x184c } as HIDDevice), false); // Rival 3 (post-firmware)
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1836 } as HIDDevice), false); // Aerox 3
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1830 } as HIDDevice), false); // Rival 3 Wireless
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1850 } as HIDDevice), false); // plain Aerox 5
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1854 } as HIDDevice), false); // Aerox 5 Wireless (wired)
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x185e } as HIDDevice), false); // Aerox 5 Wireless Destiny 2
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1862 } as HIDDevice), false); // Aerox 5 Wireless Diablo IV
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1852 } as HIDDevice), false); // Aerox 5 Wireless (2.4GHz)
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x185c } as HIDDevice), false); // Aerox 5 Wireless Destiny 2 (2.4GHz)
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1860 } as HIDDevice), false); // Aerox 5 Wireless Diablo IV (2.4GHz)
  // Out-of-scope sibling PIDs from the same rivalcfg profile (plain Prime Wireless) must not be claimed.
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1842 } as HIDDevice), false); // Prime Wireless (wired)
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, productId: 0x1840 } as HIDDevice), false); // Prime Wireless (2.4GHz)
  assert.equal(SteelSeriesPrimeMiniWirelessHidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus probes battery (wired-mode command byte) and never claims to have read DPI/polling", async () => {
  const { device, sent } = fakeDevice({ productId: 0x184a });
  const status = await new SteelSeriesPrimeMiniWirelessHidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x92] }]);
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryPercent, 50);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, false);
});

test("readStatus in 2.4 GHz mode probes battery with the flagged command byte", async () => {
  const { device, sent } = fakeDevice({ productId: 0x1848 });
  const status = await new SteelSeriesPrimeMiniWirelessHidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0xd2] }]);
  assert.equal(status.connectionType, "Wireless");
});

test("readStatus reports a charging battery", async () => {
  const { device } = fakeDevice({ battery: [0x00, 0x8b] });
  const status = await new SteelSeriesPrimeMiniWirelessHidClient(device).readStatus();
  assert.equal(status.batteryPercent, 50);
  assert.equal(status.batteryState, "Charging");
});

test("a silent interface fails the battery probe loudly and names SteelSeries GG", async () => {
  const { device, sent } = fakeDevice({ answerBattery: false });
  await assert.rejects(new SteelSeriesPrimeMiniWirelessHidClient(device).readStatus(), /SteelSeries GG/);
  assert.deepEqual(sent, [{ reportId: 0, payload: [0x92] }]);
});

test("setDpi and setPollingRate write the value then save, wired-mode bytes", async () => {
  const { device, sent } = fakeDevice({ productId: 0x184a });
  const client = new SteelSeriesPrimeMiniWirelessHidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2d, 0x01, 0x00, 0x12] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x2b, 0x01] },
    { reportId: 0, payload: [0x11, 0x00] },
  ]);
});

test("setDpi and setPollingRate use the flagged bytes in 2.4 GHz mode", async () => {
  const { device, sent } = fakeDevice({ productId: 0x1848 });
  const client = new SteelSeriesPrimeMiniWirelessHidClient(device);
  await client.setDpi(1600);
  await client.setPollingRate(500);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x6d, 0x01, 0x00, 0x12] },
    { reportId: 0, payload: [0x51, 0x00] },
    { reportId: 0, payload: [0x6b, 0x01] },
    { reportId: 0, payload: [0x51, 0x00] },
  ]);
});

test("setColor, setSleepTimer, and setButtonsMapping write the packet then save", async () => {
  const { device, sent } = fakeDevice({ productId: 0x184a });
  const client = new SteelSeriesPrimeMiniWirelessHidClient(device);
  await client.setColor(0, 255, 0);
  await client.setSleepTimer(5);
  const expected = new Array(40).fill(0x00);
  expected[0x19] = 0x30;
  await client.setButtonsMapping({ button6: { type: "dpiSwitch" } });
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x21, 0x01, 0x00, 0, 255, 0] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x29, 0xe0, 0x93, 0x04] },
    { reportId: 0, payload: [0x11, 0x00] },
    { reportId: 0, payload: [0x2a, ...expected] },
    { reportId: 0, payload: [0x11, 0x00] },
  ]);
});

test("invalid values are rejected before any report reaches the mouse", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesPrimeMiniWirelessHidClient(device);
  await assert.rejects(client.setDpi(150), /100 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /125, 250, 500, or 1000 Hz/);
  await assert.rejects(client.setSleepTimer(21), /0–20/);
  assert.deepEqual(sent, []);
});

test("concurrent setters never interleave their write/save pairs", async () => {
  const { device, sent } = fakeDevice({ productId: 0x184a });
  const client = new SteelSeriesPrimeMiniWirelessHidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125)]);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    [0x2d, 0x01, 0x00, 0x04],
    [0x11, 0x00],
    [0x2b, 0x03],
    [0x11, 0x00],
  ]);
});
