import assert from "node:assert/strict";
import test from "node:test";
import { MotospeedHidClient } from "./hid.js";
import { X6Device } from "./test-device.test-helper.js";
import { createSupportedClient, deviceBrand } from "../registry.js";
import { MOTOSPEED_HID_FILTERS, SUPPORTED_HID_FILTERS } from "../vendors.js";

test("registry and picker include both X6 connection paths", () => {
  const device = new X6Device();
  for (const productId of [0xffe0, 0xfff1]) {
    device.productId = productId;
    const client = createSupportedClient(device);
    assert.ok(client instanceof MotospeedHidClient);
    assert.equal(deviceBrand(client), "Motospeed");
    assert.ok(
      MOTOSPEED_HID_FILTERS.some(
        (f) =>
          f.vendorId === 0x0bda &&
          f.productId === productId &&
          f.usagePage === 0xffc1,
      ),
    );
  }
  for (const filter of MOTOSPEED_HID_FILTERS)
    assert.ok(SUPPORTED_HID_FILTERS.includes(filter));
});

test("support requires the Motospeed control collection", () => {
  const device = new X6Device();
  device.productId = 0xffff;
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.productId = 0xffe0;
  device.vendorId = 0x1234;
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.vendorId = 0x0bda;
  const control = device.collections[0];
  device.collections = [{ ...control, usagePage: 1 }];
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.collections = [{ ...control, outputReports: [] }];
  assert.equal(MotospeedHidClient.isSupported(device), false);
  device.collections = [{ ...control, usagePage: 1, children: [control] }];
  assert.equal(MotospeedHidClient.isSupported(device), true);
});

test("reads settings with listener attached before send, ignoring unrelated input", async () => {
  const device = new X6Device();
  device.beforeReply = () => {
    device.emit(1, device.settings);
    device.emit(0xb4, new Uint8Array([0x52, 0]));
  };
  const client = new MotospeedHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, 46);
  assert.equal(status.dpi, 1200);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.lighting?.mode, null);
  assert.equal(status.lighting?.writeOnly, true);
  assert.equal(device.listeners.size, 0);
  device.productId = 0xfff1;
  assert.equal((await client.readStatus()).batteryPercent, null);
  await client.close();
  assert.equal(device.opened, false);
});

test("B3 output framing follows the descriptor for both documented lengths", async () => {
  for (const length of [60, 63, 61]) {
    const device = new X6Device();
    device.collections = [
      {
        ...device.collections[0],
        outputReports: [
          { reportId: 0xb3, items: [{ reportSize: 8, reportCount: length }] },
          { reportId: 0xb5, items: [{ reportSize: 8, reportCount: 20 }] },
        ],
      },
    ];
    const client = new MotospeedHidClient(device);
    if (length === 61) {
      await assert.rejects(client.readStatus(), /payload length/);
      assert.equal(device.listeners.size, 0);
      continue;
    }
    await client.readStatus();
    await client.setButtonMapping(0, { kind: "disabled" });
    assert.deepEqual(
      device.sent.map((p) => p.data.length),
      [length, length],
    );
  }
});

test("concurrent DPI edits run as separate read-write-read transactions", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  assert.deepEqual(
    await Promise.all([client.setDpi(1600), client.setDpiStageValue(0, 800)]),
    [1600, 800],
  );
  assert.deepEqual(
    device.sent.map((p) => p.data[0]),
    [6, 0x40, 6, 6, 0x40, 6],
  );
  assert.deepEqual(
    (await client.readStatus()).dpiStages,
    [800, 800, 1600, 3200, 4800],
  );
});

test("DPI stage count keeps the active stage in range", async () => {
  const client = new MotospeedHidClient(new X6Device());
  assert.equal(await client.setDpiStageCount(2), 2);
  assert.equal((await client.readStatus()).activeDpiStage, 1);
  assert.equal(await client.setActiveDpiStage(0), 0);
  await assert.rejects(client.setActiveDpiStage(2), /Active DPI stage/);
});

test("general setting writes preserve the other controls", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  await client.setLiftOffDistance("Low");
  await client.setRippleControl(true);
  await client.setMotionSync(false);
  await client.setAngleSnapping(false);
  await client.setInvertScroll(true);
  await client.setPerformanceMode(true);
  const settings = await client.readSettings();
  assert.equal(settings.settingsByte, 0xd2);
  assert.equal(settings.liftOffDistance, "Low");
  assert.equal(settings.rippleControl, true);
  assert.equal(settings.motionSync, false);
  assert.equal(settings.esportsMode, true);
});

test("unknown general bits are preserved by refusing a destructive full-settings write", async () => {
  const device = new X6Device();
  device.settings[15] |= 0x20;
  const client = new MotospeedHidClient(device);
  await assert.rejects(
    client.setMotionSync(false),
    /Unknown Motospeed general/,
  );
  assert.deepEqual(
    device.sent.map((p) => p.data[0]),
    [6],
  );
  device.settings[15] = 0;
  await assert.rejects(client.setMotionSync(false), /Unknown Motospeed LOD/);
});

test("scalar writes confirm readback and expose sleep in seconds", async () => {
  const client = new MotospeedHidClient(new X6Device());
  assert.equal(await client.setPollingRate(8000), 8000);
  assert.equal(await client.setDebounceTime(7), 7);
  assert.equal(await client.setSleepTimeout(120), 120);
  const status = await client.readStatus();
  assert.equal(status.sleepTimeout, 120);
  assert.equal(status.debounceMs, 7);
});

test("failed verification rejects instead of returning the requested value", async () => {
  const device = new X6Device();
  device.retainWrites = false;
  const client = new MotospeedHidClient(device);
  await assert.rejects(client.setPollingRate(8000), /did not retain/);
  await assert.rejects(client.setDpi(1600), /did not retain/);
  await assert.rejects(client.setMotionSync(false), /did not retain/);
});

test("invalid settings do not reach the HID transport", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  await assert.rejects(client.setPollingRate(250));
  assert.equal(device.sent.length, 0);
});

test("write-only lighting state updates only after a successful write", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  const initial = (await client.readStatus()).lighting;
  if (!initial) throw new Error("Motospeed status did not include lighting");
  const written = await client.setLighting({
    ...initial,
    mode: "Static",
    color: "#ff3332",
    brightness: 100,
    speed: 128,
  });
  written.color = "#000000";
  assert.equal((await client.readStatus()).lighting?.color, "#ff3332");
  device.failSend = true;
  await assert.rejects(
    client.setLighting({ ...initial, mode: "Off" }),
    /USB send failed/,
  );
  device.failSend = false;
  assert.equal((await client.readStatus()).lighting?.mode, "Static");
});

test("a settings timeout removes its input listener", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device, 20);
  device.silent = true;
  await assert.rejects(client.readStatus(), /Timed out/);
  assert.equal(device.listeners.size, 0);
});

test("a malformed settings reply removes its listener", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  device.settings = new Uint8Array([6]);
  await assert.rejects(client.readStatus(), /Invalid Motospeed/);
  assert.equal(device.listeners.size, 0);
});

test("the queue recovers after a send failure", async () => {
  const device = new X6Device();
  const client = new MotospeedHidClient(device);
  device.failSend = true;
  await assert.rejects(client.readStatus(), /USB send failed/);
  assert.equal(device.listeners.size, 0);
  device.failSend = false;
  assert.equal((await client.readStatus()).dpi, 1200);
});
