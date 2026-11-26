import assert from "node:assert/strict";
import test from "node:test";

import { SteelSeriesRival650HidClient } from "./rival650-hid.ts";

function fakeDevice(
  options: {
    productId?: number;
    answerBattery?: boolean;
    battery?: number[];
    beforeBattery?: number[][];
    buttons?: number[];
    answerButtons?: boolean;
    beforeButtons?: Array<{ reportId: number; bytes: number[] }>;
    acceptButtonWrites?: boolean;
    mapBeforeEdit?: number[];
    ignoreSave?: boolean;
    loseReadbackAfterWrite?: boolean;
  } = {},
) {
  const sent: Array<{ reportId: number; payload: number[] }> = [];
  let writtenMapping: number[] | undefined;
  let savedMapping: number[] | undefined;
  let buttonReads = 0;
  let saveErrorPending = false;
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: 0x1038,
    productId: options.productId ?? 0x172b,
    productName: "SteelSeries Rival 650 Wireless",
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
        queueMicrotask(() => {
          for (const bytes of options.beforeBattery ?? []) {
            const stale = Uint8Array.from(bytes);
            listener?.({ reportId: 0, data: new DataView(stale.buffer), device } as unknown as HIDInputReportEvent);
          }
          listener?.({ reportId: 0, data: new DataView(response.buffer), device } as unknown as HIDInputReportEvent);
        });
      }
      if (payload[0] === 0x19) writtenMapping = payload.slice(1);
      if (payload[0] === 0x09) {
        if (saveErrorPending) {
          saveErrorPending = false;
          throw new Error("Save report failed.");
        }
        if (!options.ignoreSave) savedMapping = writtenMapping;
      }
      if (payload[0] === 0x99 && !(writtenMapping && options.loseReadbackAfterWrite)) {
        buttonReads++;
        const response = new Uint8Array(64);
        response.set((options.acceptButtonWrites && (writtenMapping ?? savedMapping))
          || (buttonReads > 1 && options.mapBeforeEdit) || options.buttons
          || [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0,
            0x61, 0xea, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x30]);
        const emit = (reportId: number, data: Uint8Array) =>
          listener?.({ reportId, data: new DataView(data.buffer), device } as unknown as HIDInputReportEvent);
        queueMicrotask(() => {
          for (const { reportId, bytes } of options.beforeButtons ?? []) {
            const stray = new Uint8Array(64);
            stray.set(bytes);
            emit(reportId, stray);
          }
          if (options.answerButtons !== false) emit(0, response);
        });
      }
    },
    sendFeatureReport: async () => { throw new Error("the Rival 650 Wireless protocol does not use feature reports"); },
    receiveFeatureReport: async () => { throw new Error("the Rival 650 Wireless protocol does not use feature reports"); },
    addEventListener: (_type: string, attached: (event: HIDInputReportEvent) => void) => { listener = attached; },
    removeEventListener: () => { listener = null; },
  };
  const powerCycle = () => { writtenMapping = savedMapping; };
  const failNextSave = () => { saveErrorPending = true; };
  return { device: device as unknown as HIDDevice, sent, powerCycle, failNextSave };
}

test("claims only the Rival 650 Wireless product ids", () => {
  const { device } = fakeDevice();
  assert.equal(SteelSeriesRival650HidClient.isSupported(device), true);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1726 } as HIDDevice), true);
  // Every sibling PID from clusters 1-4 must not be claimed.
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1824 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x184c } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1836 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1830 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1850 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1854 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x185e } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1862 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1852 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x185c } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, productId: 0x1860 } as HIDDevice), false);
  assert.equal(SteelSeriesRival650HidClient.isSupported({ ...device, vendorId: 0x1532 } as HIDDevice), false);
});

test("readStatus reads battery and the current button map without writing settings", async () => {
  const { device, sent } = fakeDevice();
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.deepEqual(sent, [{ reportId: 0, payload: [0xaa, 0x01] }, { reportId: 0, payload: [0x99] }]);
  assert.deepEqual(status.rival650ButtonMappings?.button4, { type: "multimedia", code: 0xea });
  assert.deepEqual(status.rival650ButtonMappings?.button6, { type: "disabled" });
  assert.deepEqual(status.rival650ButtonMappings?.button7, { type: "dpiSwitch" });
  assert.equal(status.brand, "SteelSeries");
  assert.equal(status.name, "SteelSeries Rival 650 Wireless");
  assert.deepEqual(status.firmware, []);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryPercent, 72);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.ui?.valuesVerified, false);
  assert.ok(status.ui?.pollingNote);
});

test("readStatus reports a charging battery", async () => {
  const { device } = fakeDevice({ battery: [55, 0x00, 0x01] });
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.equal(status.batteryPercent, 55);
  assert.equal(status.batteryState, "Charging");
});

test("a silent interface fails the battery probe loudly and names SteelSeries GG", async () => {
  const { device, sent } = fakeDevice({ answerBattery: false });
  await assert.rejects(new SteelSeriesRival650HidClient(device).readStatus(), /SteelSeries GG/);
  assert.deepEqual(sent, [{ reportId: 0, payload: [0xaa, 0x01] }]);
});

test("setDpi, setPollingRate, and setLiftOffDistance write the value then save, all on report id 0", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setLiftOffDistanceMm(2), 2);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x15, 0x01, 0x0f] },
    { reportId: 0, payload: [0x09] },
    { reportId: 0, payload: [0x17, 0x02] },
    { reportId: 0, payload: [0x09] },
    { reportId: 0, payload: [0x20, 0x01, 0x6f, 0x73] },
    { reportId: 0, payload: [0x09] },
  ]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 1600);
  assert.equal(status.pollingRateHz, 500);
});

test("setSleepTimer writes the value then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await client.setSleepTimer(5);
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x2b, 0x01, 0x01, 0x00, 0x00, 0x00, 0x2c, 0x01] },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("setButtonsMapping writes the packet then save", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await client.setButtonsMapping({ button6: { type: "dpiSwitch" } });
  const expected = new Array(35).fill(0x00);
  expected[0x19] = 0x30;
  assert.deepEqual(sent, [
    { reportId: 0, payload: [0x19, ...expected] },
    { reportId: 0, payload: [0x09] },
  ]);
});

test("invalid values are rejected before any report reaches the mouse", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await assert.rejects(client.setDpi(150), /100 DPI steps/);
  await assert.rejects(client.setPollingRate(2000), /125, 250, 500, or 1000 Hz/);
  await assert.rejects(client.setLiftOffDistanceMm(9), Error);
  await assert.rejects(client.setSleepTimer(21), /1–20 minutes/);
  assert.deepEqual(sent, []);
});

test("concurrent setters never interleave their write/save pairs", async () => {
  const { device, sent } = fakeDevice();
  const client = new SteelSeriesRival650HidClient(device);
  await Promise.all([client.setDpi(400), client.setPollingRate(125), client.setLiftOffDistanceMm(8)]);
  assert.deepEqual(sent.map(({ payload }) => payload), [
    [0x15, 0x01, 0x03],
    [0x09],
    [0x17, 0x04],
    [0x09],
    [0x20, 0x01, 0x51, 0x55],
    [0x09],
  ]);
});

test("readStatus does not publish a blank response as the button map", async () => {
  const { device } = fakeDevice({ buttons: [] });
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.equal(status.rival650ButtonMappings, undefined);
  assert.equal(status.batteryPercent, 72);
});

test("Rival 650 preserves an existing keyboard chord when rewriting a different button", async () => {
  const bytes = Array(35).fill(0);
  bytes[0] = 1;
  bytes.splice(15, 5, 0x51, 0xe0, 0xe5, 0x06, 0);
  const { device, sent } = fakeDevice({ buttons: bytes });
  const client = new SteelSeriesRival650HidClient(device);
  const { rival650ButtonMappings } = await client.readStatus();
  assert.deepEqual(rival650ButtonMappings?.button4, { type: "raw", bytes: [0x51, 0xe0, 0xe5, 0x06, 0] });
  await client.setButtonsMapping({ ...rival650ButtonMappings, button5: { type: "multimedia", code: 0xea } });
  bytes.splice(20, 5, 0x61, 0xea, 0, 0, 0);
  assert.deepEqual(sent.at(-2)?.payload, [0x19, ...bytes]);
});

test("Rival 650 receiver uses the same button read request and identifies as wireless", async () => {
  const { device, sent } = fakeDevice({ productId: 0x1726 });
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(sent.at(-1), { reportId: 0, payload: [0x99] });
  assert.deepEqual(status.rival650ButtonMappings?.button4, { type: "multimedia", code: 0xea });
});

test("Rival 650 skips a padded battery reply and a wrong report ID before decoding the map", async () => {
  const { device } = fakeDevice({ beforeButtons: [
    { reportId: 0, bytes: [72, 0, 1] },
    { reportId: 1, bytes: [1, 0, 0, 0, 0, 3] },
  ] });
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.deepEqual(status.rival650ButtonMappings?.button4, { type: "multimedia", code: 0xea });
});

for (const { name, acceptButtonWrites, loseReadbackAfterWrite, error } of [
  { name: "accepts matching readback", acceptButtonWrites: true, loseReadbackAfterWrite: false, error: null },
  { name: "rejects a mismatched readback", acceptButtonWrites: false, loseReadbackAfterWrite: false, error: /does not match/ },
  { name: "rejects missing readback", acceptButtonWrites: true, loseReadbackAfterWrite: true, error: /could not read back/i },
]) {
  test(`Rival 650 verified button writer ${name}`, async () => {
    const { device, sent } = fakeDevice({ acceptButtonWrites, loseReadbackAfterWrite });
    const client = new SteelSeriesRival650HidClient(device);
    const { rival650ButtonMappings } = await client.readStatus();
    assert.ok(rival650ButtonMappings);
    const result = client.setVerifiedButtonsMapping({
      ...rival650ButtonMappings,
      button4: { type: "multimedia", code: 0xe9 },
    });
    if (error) await assert.rejects(result, error);
    else await result;
    assert.deepEqual(sent.slice(-3).map(({ payload }) => payload[0]), [0x19, 0x09, 0x99]);
  });
}

test("Rival 650 reads and verifies a map with only the primary click enabled", async () => {
  const primaryOnly = Array(35).fill(0);
  primaryOnly[0] = 1;
  const { device, sent } = fakeDevice({
    buttons: primaryOnly, acceptButtonWrites: true, beforeButtons: [{ reportId: 0, bytes: [72, 0, 0] }],
  });
  const client = new SteelSeriesRival650HidClient(device);
  const { rival650ButtonMappings: mapping } = await client.readStatus();
  assert.ok(mapping);
  assert.deepEqual(mapping.button1, { type: "button", target: "button1" });
  assert.deepEqual(mapping.button7, { type: "disabled" });
  await client.setVerifiedButtonsMapping(mapping);
  assert.deepEqual(sent.map(({ payload }) => payload[0]), [0xaa, 0x99, 0xaa, 0x99, 0x19, 0x09, 0x99, 0xaa, 0x99]);
});

test("Rival 650 edits start with a fresh read and preserve unrelated fields", async () => {
  const latest = Array(35).fill(0);
  latest[0] = 1;
  const chord = [0x51, 0xe0, 0xe5, 0x06, 0];
  latest.splice(20, 5, ...chord);
  const { device, sent } = fakeDevice({ acceptButtonWrites: true, mapBeforeEdit: latest });
  const client = new SteelSeriesRival650HidClient(device);
  await client.readStatus();
  await client.updateVerifiedButtonsMapping(mapping => ({
    ...mapping, button4: { type: "multimedia", code: 0xe9 },
  }));
  const packets = sent.slice(2).map(({ payload }) => payload);
  assert.deepEqual(packets.map(packet => packet[0]), [0x99, 0x19, 0x09, 0x99]);
  assert.deepEqual(packets[1]?.slice(21, 26), chord);
});

test("Rival 650 edits never write without a current map", async () => {
  const { device, sent } = fakeDevice({ buttons: [] });
  const client = new SteelSeriesRival650HidClient(device);
  await assert.rejects(client.updateVerifiedButtonsMapping(mapping => mapping), /could not read/i);
  assert.equal(sent.some(({ payload }) => payload[0] === 0x19), false);
});

test("Rival 650 fixture distinguishes a matching active map from saved settings", async () => {
  for (const ignoreSave of [false, true]) {
    const { device, powerCycle } = fakeDevice({ acceptButtonWrites: true, ignoreSave });
    const client = new SteelSeriesRival650HidClient(device);
    const { rival650ButtonMappings: original } = await client.readStatus();
    assert.ok(original);
    const button4 = { type: "multimedia", code: 0xe9 } as const;
    await client.setVerifiedButtonsMapping({ ...original, button4 });
    powerCycle();
    const { rival650ButtonMappings: afterPowerCycle } = await client.readStatus();
    assert.deepEqual(afterPowerCycle?.button4, ignoreSave ? original.button4 : button4);
  }
});

test("Rival 650 retry saves the edited map even when it already matches active settings", async () => {
  const { device, failNextSave, powerCycle, sent } = fakeDevice({ acceptButtonWrites: true });
  const client = new SteelSeriesRival650HidClient(device);
  const button4 = { type: "multimedia", code: 0xe9 } as const;
  const edit: Parameters<typeof client.updateVerifiedButtonsMapping>[0] = mapping => ({ ...mapping, button4 });
  failNextSave();
  await assert.rejects(client.updateVerifiedButtonsMapping(edit), /save report failed/i);
  await client.updateVerifiedButtonsMapping(edit);
  powerCycle();
  assert.deepEqual((await client.readStatus()).rival650ButtonMappings?.button4, button4);
  assert.equal(sent.filter(({ payload }) => payload[0] === 0x09).length, 2);
});

for (const batteryLevel of [1, 2]) {
  test(`Rival 650 never writes from repeated stale battery reports with a battery probe of ${batteryLevel}%`, async () => {
    const { device, sent } = fakeDevice({
      battery: [batteryLevel, 0, 0],
      answerButtons: false,
      beforeButtons: [{ reportId: 0, bytes: [1, 0, 0] }],
    });
    const client = new SteelSeriesRival650HidClient(device);
    await assert.rejects(client.updateVerifiedButtonsMapping(mapping => ({
      ...mapping, button4: { type: "multimedia", code: 0xea },
    })), /could not read/i);
    assert.equal(sent.some(({ payload }) => payload[0] === 0x19 || payload[0] === 0x09), false);
  });
}

test("Rival 650 ignores a delayed full button report while probing the battery", async () => {
  const fullMap = [1, 0, 0, 0, 0, 2, ...Array(58).fill(0)];
  const { device } = fakeDevice({ beforeBattery: [fullMap] });
  const status = await new SteelSeriesRival650HidClient(device).readStatus();
  assert.equal(status.batteryPercent, 72);
});

test("Rival 650 verified APIs reject incomplete JavaScript mappings before writing", async () => {
  const { device, sent } = fakeDevice({ acceptButtonWrites: true });
  const client = new SteelSeriesRival650HidClient(device);
  const partial = { button4: { type: "multimedia", code: 0xe9 } } as
    Parameters<typeof client.setVerifiedButtonsMapping>[0];
  await assert.rejects(client.setVerifiedButtonsMapping(partial), /requires all seven/i);
  await assert.rejects(client.updateVerifiedButtonsMapping(() => partial), /requires all seven/i);
  assert.equal(sent.some(({ payload }) => payload[0] === 0x19 || payload[0] === 0x09), false);
});
