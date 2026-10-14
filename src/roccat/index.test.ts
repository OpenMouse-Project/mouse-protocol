import assert from "node:assert/strict";
import test from "node:test";
import {
  ROCCAT_APPLY_FRAME,
  ROCCAT_DPI_MAX,
  ROCCAT_DPI_MIN,
  ROCCAT_DPI_STEP,
  ROCCAT_FRAME_PREFIX,
  ROCCAT_PACKET_LENGTH,
  ROCCAT_PERFORMANCE_CLASS,
  ROCCAT_STATUS_COMMAND_ID,
  roccatDecodeBattery,
  roccatDecodeSettingsReply,
  roccatEncodeApply,
  roccatEncodeLighting,
  roccatEncodePerformanceWrite,
  roccatEncodeSettingsQuery,
  roccatEncodeStatus,
  roccatIsStatusReply,
  roccatStagedDpi,
  type RoccatSettings,
} from "./index.ts";

const hex = (bytes: Uint8Array, count: number) => [...bytes.subarray(0, count)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const pad = (list: number[]): RoccatSettings => ({
  pollingRateHz: 1000,
  angleSnapping: false,
  lod: "Low",
  ledTimeoutMinutes: 15,
  debounceMs: 10,
  dpi: { stages: list, stagesY: list },
});

test("the settings write matches the vendor-replayed frame byte for byte", () => {
  const view = roccatEncodePerformanceWrite(pad([400, 800, 1200, 1600, 3200]));
  assert.equal(view.length, ROCCAT_PACKET_LENGTH);
  assert.equal(
    hex(view, 24),
    "10 50 14 00 01 00 00 00 08 08 10 10 18 18 20 20 40 40 06 00 80 0f 00 0a",
  );
  assert.equal([...view.subarray(24)].every((b) => b === 0), true);
});

test("the apply commit tail and query are the recorded frames", () => {
  assert.equal(hex(roccatEncodeApply(), 4), "10 50 18 04");
  assert.equal(hex(roccatEncodeSettingsQuery(), 3), "10 50 14");
  assert.equal(hex(roccatEncodeStatus(), 2), "90 0a");
});

test("DPI is stored per 50 and validates scale and step", () => {
  assert.equal(roccatStagedDpi(800), 16);
  assert.equal(roccatStagedDpi(1000), 20);
  assert.equal(ROCCAT_DPI_MAX / ROCCAT_DPI_STEP, 380);
  assert.throws(() => roccatStagedDpi(801), RangeError);
  assert.throws(() => roccatStagedDpi(ROCCAT_DPI_MIN - 50), RangeError);
});

test("settings writes validate every driven field", () => {
  const settings = pad([800, 800, 800, 800, 800]);
  const view = roccatEncodePerformanceWrite({
    ...settings,
    pollingRateHz: 125,
    angleSnapping: true,
    lod: "High",
    ledTimeoutMinutes: 0,
    debounceMs: 0,
  });
  assert.equal(view[0], ROCCAT_FRAME_PREFIX);
  assert.equal(view[1], ROCCAT_PERFORMANCE_CLASS);
  assert.equal(view[5], 0x03, "125 Hz -> 0x03, opposite of the Burst Core dict");
  assert.equal(view[6], 1, "angle snapping flag");
  assert.equal(view[18], 0x07, "LOD high");
  assert.equal(view[21], 0x00, "LED timeout minutes");
  assert.equal(view[23], 0x00, "debounce ms");
  assert.throws(() => roccatEncodePerformanceWrite({ ...settings, pollingRateHz: 2000 }), /polling rate/i);
  assert.throws(() => roccatEncodePerformanceWrite({ ...settings, debounceMs: 11 }), /Debounce/);
  assert.throws(() => roccatEncodePerformanceWrite({ ...settings, ledTimeoutMinutes: 31 }), /LED timeout/);
});

test("stage lists land in the two neighbouring byte slots", () => {
  const settings: RoccatSettings = {
    ...pad([800, 800, 800, 800, 800]),
    dpi: { stages: [800, 1200, 1600, 3200, 5000], stagesY: [400, 800, 1200, 1600, 3200] },
  };
  const view = roccatEncodePerformanceWrite(settings);
  assert.deepEqual([...view.subarray(8, 18)], [16, 8, 24, 16, 32, 24, 64, 32, 100, 64]);
  const decoded = roccatDecodeSettingsReply(view)!;
  assert.deepEqual(decoded.dpi.stages, [800, 1200, 1600, 3200, 5000]);
  assert.deepEqual(decoded.dpi.stagesY, [400, 800, 1200, 1600, 3200]);
});

test("the settings echo decoder accepts the recorded factory frame", () => {
  // The mouse's interrupt-IN reply to a settings query on this unit (this
  // unit's stage table had five entries, both axes identical). Reported as
  // `10 50 03 00 ec fa 0d 00 10 10 18 18 20 20 40 40 64 64 01 02 00 00`.
  const echo = new Uint8Array([
    0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x0d, 0x00,
    0x10, 0x10, 0x18, 0x18, 0x20, 0x20, 0x40, 0x40, 0x64, 0x64,
    0x01, 0x02, 0x00, 0x00,
  ]);
  const decoded = roccatDecodeSettingsReply(echo);
  assert.deepEqual(decoded?.dpi.stages, [800, 1200, 1600, 3200, 5000]);
  assert.deepEqual(decoded?.dpi.stagesY, [800, 1200, 1600, 3200, 5000]);
});

test("the settings echo decoder refuses foreign frames", () => {
  assert.equal(roccatDecodeSettingsReply(new Uint8Array([0x90, 0x0a, 0x04])), null);
  assert.equal(roccatDecodeSettingsReply(new Uint8Array([0x10, 0x10, 0x0b])), null);
  assert.equal(roccatDecodeSettingsReply(new Uint8Array([0x10, 0x50, 0x51])), null);
  assert.equal(roccatDecodeSettingsReply(new Uint8Array(10)), null);
});

test("an all-zero stage table decodes as no-data, the sleeper echo", () => {
  // What an idle/sleeping mouse returns per poll in the second capture: the
  // echo of `10 50 03 00 ec fa 04` with an empty body.
  const sleeper = new Uint8Array([
    0x10, 0x50, 0x03, 0x00, 0xec, 0xfa, 0x04, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.equal(roccatDecodeSettingsReply(sleeper), null);
  // One non-zero slot is a real table again.
  const one = new Uint8Array([...sleeper]);
  one[8] = 0x10;
  assert.deepEqual(roccatDecodeSettingsReply(one)?.dpi.stages, [800, 0, 0, 0, 0]);
});

test("battery decodes from the status echo recorded on hardware", () => {
  assert.equal(roccatIsStatusReply(new Uint8Array([0x90, 0x0a])), true);
  assert.equal(roccatIsStatusReply(new Uint8Array([0x10, 0x50, 0x03])), false);
  // The echo every poll of this unit returned; byte 5 held 0x1e.
  assert.equal(roccatDecodeBattery(new Uint8Array([0x90, 0x0a, 0x04, 0x00, 0x00, 0x1e])), 0x1e);
  assert.equal(roccatDecodeBattery(new Uint8Array([0x90, 0x0a, 0x04, 0x00, 0x00])), null);
  assert.equal(roccatDecodeBattery(new Uint8Array([0x90, 0x0a, 0x04, 0x00, 0x00, 101])), null);
  assert.equal(roccatDecodeBattery(new Uint8Array([0x10, 0x50, 0x03])), null);
  assert.equal(ROCCAT_STATUS_COMMAND_ID, 0x90);
});

test("lighting frames carry the two zones after the vendor prefix", () => {
  const view = roccatEncodeLighting([0x12, 0x34, 0x56], [0, 0, 0]);
  assert.equal(hex(view, 15), "10 10 0b 00 09 64 64 64 06 12 34 56 00 00 00");
  assert.equal([...view.subarray(15)].every((b) => b === 0), true);
});
