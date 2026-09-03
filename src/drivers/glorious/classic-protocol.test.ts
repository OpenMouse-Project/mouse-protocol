import assert from "node:assert/strict";
import test from "node:test";

import {
  GLORIOUS_CLASSIC_PROFILE_DEFAULT,
  buildGloriousClassicActiveStagePayload,
  buildGloriousClassicBatteryRequestPayload,
  buildGloriousClassicDebouncePayload,
  buildGloriousClassicDpiStagesPayload,
  buildGloriousClassicLiftOffPayload,
  buildGloriousClassicPollingRatePayload,
  buildGloriousClassicRgbPayload,
  gloriousClassicDecodePollingRate,
  gloriousClassicEncodePollingRate,
  gloriousClassicRateByte,
  parseGloriousClassicBatteryResponse,
} from "../../glorious-classic/index.ts";

// Every assertion below is written against the source's own `bfr[n]` buffer
// index (a 65-byte buffer with bfr[0] as the report id) so it can be checked
// by eye against mouse.py / mxw: `body[n]` here means `bfr[n + 1]`.

test("rate byte uses the (105-rate)/5 scale for ordinary effects", () => {
  assert.equal(gloriousClassicRateByte(100, "glorious"), 1);
  assert.equal(gloriousClassicRateByte(0, "glorious"), 21);
  assert.equal(gloriousClassicRateByte(50, "tail"), 11);
});

test("rate byte uses the (105-rate)*2 scale for rave/wave", () => {
  assert.equal(gloriousClassicRateByte(100, "rave"), 10);
  assert.equal(gloriousClassicRateByte(0, "wave"), 210);
});

test("solid RGB payload matches mouse.py's set_rgb offsets", () => {
  const body = buildGloriousClassicRgbPayload({ effect: "solid", rate: 0, colors: ["#112233"] });
  assert.equal(body[2], 0x02); // bfr[3] class
  assert.equal(body[3], 0x08); // bfr[4] length for solid
  assert.equal(body[4], 0x02); // bfr[5]
  assert.equal(body[6], GLORIOUS_CLASSIC_PROFILE_DEFAULT); // bfr[7]
  assert.equal(body[7], 0xff); // bfr[8]
  assert.equal(body[8], 0x04); // bfr[9] effect id (solid)
  assert.deepEqual([body[11], body[12], body[13]], [0x11, 0x22, 0x33]); // bfr[12..14]
});

test("pulse RGB payload packs up to 6 color triplets after the rate byte", () => {
  const body = buildGloriousClassicRgbPayload({
    effect: "pulse",
    rate: 100,
    colors: ["#ff0000", "#00ff00", "#0000ff"],
  });
  assert.equal(body[3], 3 * 3 + 5); // bfr[4] = len(colors)*3+5
  assert.equal(body[10], gloriousClassicRateByte(100, "pulse")); // bfr[11]
  assert.deepEqual([body[11], body[12], body[13]], [0xff, 0x00, 0x00]); // bfr[12..14]
  assert.deepEqual([body[14], body[15], body[16]], [0x00, 0xff, 0x00]); // bfr[15..17]
  assert.deepEqual([body[17], body[18], body[19]], [0x00, 0x00, 0xff]); // bfr[18..20]
});

test("off effect carries no rate or color bytes", () => {
  const body = buildGloriousClassicRgbPayload({ effect: "off", rate: 0, colors: [] });
  assert.equal(body[3], 0x05); // bfr[4]
  assert.equal(body[8], 0x00); // bfr[9] effect id (off)
});

test("debounce payload matches set_debounce_time's offsets and clamps to 32ms", () => {
  const body = buildGloriousClassicDebouncePayload(50, 2);
  assert.equal(body[2], 0x02); // bfr[3]
  assert.equal(body[3], 0x01); // bfr[4]
  assert.equal(body[5], 0x08); // bfr[6]
  assert.equal(body[6], 2); // bfr[7] profile id
  assert.equal(body[7], 32); // bfr[8] clamped from 50 to max 32
});

test("battery request payload matches get_battery_status's write half", () => {
  const body = buildGloriousClassicBatteryRequestPayload();
  assert.equal(body[2], 0x02); // bfr[3]
  assert.equal(body[3], 0x02); // bfr[4]
  assert.equal(body[5], 0x83); // bfr[6]
});

test("battery response decodes a normal, discharging reply", () => {
  const body = new Uint8Array(64);
  body[0] = 0xa1; // bfr[1]: normal
  body[5] = 0x83; // bfr[6]: echo
  body[6] = 0; // bfr[7]: not charging
  body[7] = 76; // bfr[8]: percent
  const battery = parseGloriousClassicBatteryResponse(body);
  assert.deepEqual(battery, { state: "Normal", percent: 76, charging: false });
});

test("battery response reports the charging bit independently of the status byte", () => {
  const body = new Uint8Array(64);
  body[0] = 0xa1;
  body[5] = 0x83;
  body[6] = 1; // bfr[7]: charging
  body[7] = 42;
  assert.deepEqual(parseGloriousClassicBatteryResponse(body), { state: "Normal", percent: 42, charging: true });
});

test("battery response treats a raw 0% as 1% so it never reads as falsy", () => {
  const body = new Uint8Array(64);
  body[0] = 0xa1;
  body[5] = 0x83;
  body[7] = 0;
  assert.equal(parseGloriousClassicBatteryResponse(body).percent, 1);
});

test("battery response reports asleep and waking-up states without a percentage", () => {
  const asleep = new Uint8Array(64);
  asleep[0] = 0xa4;
  asleep[5] = 0x83;
  assert.deepEqual(parseGloriousClassicBatteryResponse(asleep), { state: "Asleep", percent: null, charging: false });

  const waking = new Uint8Array(64);
  waking[0] = 0xa0;
  waking[5] = 0x83;
  assert.deepEqual(parseGloriousClassicBatteryResponse(waking), { state: "WakingUp", percent: null, charging: false });
});

test("battery response without the expected echo byte is unknown", () => {
  const body = new Uint8Array(64);
  body[0] = 0xa1;
  body[5] = 0x00;
  assert.deepEqual(parseGloriousClassicBatteryResponse(body), { state: "Unknown", percent: null, charging: false });
});

test("DPI stages payload matches mxw's dpi_stages.rs header and doubled big-endian values", () => {
  const body = buildGloriousClassicDpiStagesPayload([400, 800, 1600, 26000], 2);
  assert.equal(body[2], 0x02); // bfr[3]
  assert.equal(body[3], 0x12); // bfr[4]
  assert.equal(body[4], 0x01); // bfr[5]
  assert.equal(body[5], 0x01); // bfr[6]
  assert.equal(body[6], 2); // bfr[7] profile
  assert.equal(body[7], 4); // bfr[8] stage count
  // Stage 0 (400 = 0x0190) at bfr[9..12], doubled.
  assert.deepEqual([body[8], body[9], body[10], body[11]], [0x01, 0x90, 0x01, 0x90]);
  // Stage 3 DPI is clamped to the mxw max of 19000 (0x4A38).
  assert.deepEqual([body[8 + 4 * 3], body[9 + 4 * 3], body[10 + 4 * 3], body[11 + 4 * 3]], [0x4a, 0x38, 0x4a, 0x38]);
});

test("DPI stages payload clamps below the 100 DPI floor", () => {
  const body = buildGloriousClassicDpiStagesPayload([1]);
  assert.deepEqual([body[8], body[9]], [0x00, 0x64]); // 100 = 0x0064
});

test("active DPI stage payload matches mxw's dpi_stage.rs", () => {
  const body = buildGloriousClassicActiveStagePayload(3, 2);
  assert.equal(body[2], 0x02); // bfr[3]
  assert.equal(body[3], 0x02); // bfr[4]
  assert.equal(body[4], 0x01); // bfr[5]
  assert.equal(body[5], 0x02); // bfr[6]
  assert.equal(body[6], 2); // bfr[7] profile
  assert.equal(body[7], 3); // bfr[8] stage id
});

test("polling rate payload sends the millisecond interval, not Hz", () => {
  const body = buildGloriousClassicPollingRatePayload(2);
  assert.equal(body[2], 0x02); // bfr[3]
  assert.equal(body[3], 0x01); // bfr[4]
  assert.equal(body[4], 0x01); // bfr[5]
  assert.equal(body[6], 2); // bfr[7] interval ms (500 Hz)
});

test("polling rate Hz<->ms table round-trips the four supported rates", () => {
  for (const [ms, hz] of [[1, 1000], [2, 500], [4, 250], [8, 125]] as const) {
    assert.equal(gloriousClassicEncodePollingRate(hz), ms);
    assert.equal(gloriousClassicDecodePollingRate(ms), hz);
  }
  assert.equal(gloriousClassicEncodePollingRate(2000), null);
});

test("lift-off distance payload encodes millimetres-1", () => {
  const oneMm = buildGloriousClassicLiftOffPayload(1);
  assert.equal(oneMm[2], 0x02); // bfr[3]
  assert.equal(oneMm[3], 0x01); // bfr[4]
  assert.equal(oneMm[4], 0x01); // bfr[5]
  assert.equal(oneMm[5], 0x07); // bfr[6]
  assert.equal(oneMm[6], 0x00); // bfr[7] = 1mm - 1

  const twoMm = buildGloriousClassicLiftOffPayload(2);
  assert.equal(twoMm[6], 0x01); // bfr[7] = 2mm - 1
});
