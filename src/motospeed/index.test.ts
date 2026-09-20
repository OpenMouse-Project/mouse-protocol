import assert from "node:assert/strict";
import test from "node:test";
import {
  MOTOSPEED_COMMAND_REPORT_ID,
  MOTOSPEED_SETTINGS_REPORT_ID,
  motospeedBuildButtonCommand,
  motospeedBuildDebounceCommand,
  motospeedBuildDpiCommand,
  motospeedBuildGeneralCommand,
  motospeedBuildLightingCommand,
  motospeedBuildPollingCommand,
  motospeedBuildSettingsRequest,
  motospeedBuildSleepCommand,
  motospeedDecodeSettings,
} from "./index.js";

const CAPTURED_SETTINGS = Uint8Array.from(
  Buffer.from("060022220290012003b004800cc0120d0505012e", "hex"),
);

test("decodes a captured wireless settings reply", () => {
  const settings = motospeedDecodeSettings(CAPTURED_SETTINGS, true);

  assert.deepEqual(settings.dpiStages, [400, 800, 1200, 3200, 4800]);
  assert.equal(settings.activeDpiStage, 2);
  assert.equal(settings.dpiStageCount, 5);
  assert.equal(settings.pollingRateHz, 1000);
  assert.equal(settings.liftOffDistance, "Low");
  assert.equal(settings.motionSync, true);
  assert.equal(settings.angleSnapping, true);
  assert.equal(settings.rippleControl, false);
  assert.equal(settings.debounceMs, 5);
  assert.equal(settings.sleepMinutes, 1);
  assert.equal(settings.batteryPercent, 46);
  assert.equal(settings.charging, false);
});

test("settings requests and DPI writes use their documented report layouts", () => {
  const request = motospeedBuildSettingsRequest();
  assert.equal(request.reportId, MOTOSPEED_SETTINGS_REPORT_ID);
  assert.equal(request.data[0], 0x06);

  const command = motospeedBuildDpiCommand({
    dpiStages: [400, 800, 1600, 3200, 4800],
    activeDpiStage: 2,
    dpiStageCount: 5,
  });
  assert.equal(command.reportId, MOTOSPEED_COMMAND_REPORT_ID);
  assert.deepEqual([...command.data.slice(0, 15)], [
    0x40, 0xff, 2, 0xff,
    0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x80, 0x0c, 0xc0, 0x12,
    5,
  ]);
});

test("scalar commands encode polling, debounce, and sleep", () => {
  assert.deepEqual(
    [...motospeedBuildPollingCommand(8000).data.slice(0, 4)],
    [0x41, 0xff, 5, 0xff],
  );
  assert.deepEqual(
    [...motospeedBuildDebounceCommand(7).data.slice(0, 2)],
    [0x43, 7],
  );
  assert.deepEqual(
    [...motospeedBuildSleepCommand(2).data.slice(0, 3)],
    [0x0a, 1, 2],
  );
});

test("general settings use the hardware-confirmed write order", () => {
  const command = motospeedBuildGeneralCommand({
    liftOffDistance: "Low",
    rippleControl: false,
    angleSnapping: true,
    motionSync: true,
    invertScroll: false,
    esportsMode: false,
  });

  assert.deepEqual(
    [...command.data.slice(0, 8)],
    [0x42, 1, 1, 1, 2, 0, 1, 1],
  );
});

test("lighting and button commands encode their write-only payloads", () => {
  const lighting = motospeedBuildLightingCommand({
    mode: "static",
    brightness: 255,
    speed: 128,
    color: [255, 51, 50],
  });
  assert.deepEqual(
    [...lighting.data.slice(0, 7)],
    [0x24, 1, 255, 128, 255, 51, 50],
  );

  const mapping = motospeedBuildButtonCommand(3, {
    kind: "shortcut",
    code: 0x070106,
  });
  assert.equal(mapping.reportId, MOTOSPEED_SETTINGS_REPORT_ID);
  assert.deepEqual(
    [...mapping.data.slice(0, 7)],
    [0x52, 3, 0, 8, 7, 1, 6],
  );
});

test("invalid values are rejected before a packet is returned", () => {
  assert.throws(() => motospeedBuildPollingCommand(250));
  assert.throws(() => motospeedBuildDebounceCommand(21));
  assert.throws(() => motospeedBuildSleepCommand(0));
  assert.throws(() =>
    motospeedBuildDpiCommand({
      dpiStages: [400, 800, 150, 3200, 4800],
      activeDpiStage: 2,
    }),
  );
  assert.throws(() =>
    motospeedBuildButtonCommand(7, { kind: "disabled" }),
  );
  assert.throws(() =>
    motospeedBuildLightingCommand({
      mode: "rainbow",
      brightness: 256,
      speed: 128,
    }),
  );
});
