import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GLORIOUS_CORE2_BANK,
  GLORIOUS_CORE2_POLLING_CODES,
  GLORIOUS_CORE2_PROFILE_CAPTURED,
  GLORIOUS_CORE2_REGISTER,
  GLORIOUS_CORE2_WIRELESS_MAX_POLLING_HZ,
  decodeGloriousCore2Battery,
  decodeGloriousCore2Firmware,
  decodeGloriousCore2Reply,
  encodeGloriousCore2ActiveDpiStage,
  encodeGloriousCore2AdvancedDebounce,
  encodeGloriousCore2BatteryRequest,
  encodeGloriousCore2Debounce,
  encodeGloriousCore2DpiColors,
  encodeGloriousCore2DpiStages,
  encodeGloriousCore2FirmwareRequest,
  encodeGloriousCore2MotionSync,
  encodeGloriousCore2PollingRate,
  encodeGloriousCore2Profile,
  gloriousCore2PollingCode,
  gloriousCore2Request,
} from "../../glorious-core2/index.ts";

const CAPTURE = new URL("../../../captures/glorious-o2-pro-4k8k-wired/", import.meta.url);

/** `<seconds> <dir> <hex>` lines, zero-padded back to 64 bytes. */
function capture(file: string): Array<{ dir: string; bytes: Uint8Array }> {
  return readFileSync(new URL(file, CAPTURE), "utf8").split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
    const [, dir, ...hex] = line.trim().split(/\s+/);
    const bytes = new Uint8Array(64);
    bytes.set(hex.map((byte) => Number.parseInt(byte, 16)));
    return { dir: dir!, bytes };
  });
}

const key = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const FACTORY_STAGES = [400, 800, 1600, 3200];
const FACTORY_COLORS = ["#ffa40d", "#26b4ff", "#ff2626", "#18b30a"];
const profile = GLORIOUS_CORE2_PROFILE_CAPTURED;

/** Every distinct request CORE sent, with the call that must reproduce it. */
function expectedRequests(): Array<[string, Uint8Array]> {
  const cases: Array<[string, Uint8Array]> = [
    ["firmware read", encodeGloriousCore2FirmwareRequest()],
    ["battery read", encodeGloriousCore2BatteryRequest()],
    ["DPI stages", encodeGloriousCore2DpiStages(FACTORY_STAGES, profile)],
    ["DPI colors", encodeGloriousCore2DpiColors(FACTORY_COLORS, profile)],
    ["active DPI stage 1", encodeGloriousCore2ActiveDpiStage(0, profile)],
    // CORE writes 1 for both of its lift-off options, so there is no encoder, only the raw frame.
    ["lift-off", gloriousCore2Request(GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.liftOff, [profile, 1])],
    ["motion sync on", encodeGloriousCore2MotionSync(true, profile)],
    ["motion sync off", encodeGloriousCore2MotionSync(false, profile)],
    ...[0, 4, 8, 12, 16].map((ms): [string, Uint8Array] => [`debounce ${ms} ms`, encodeGloriousCore2Debounce(ms, profile)]),
    ["advanced debounce", encodeGloriousCore2AdvancedDebounce({ beforePress: 0, beforeRelease: 0, afterPress: 10, afterRelease: 10, liftOffPress: 8 }, profile)],
  ];
  // The seven rates in the order CORE's list steps through them, each in both bytes ...
  for (const [hertz] of GLORIOUS_CORE2_POLLING_CODES) cases.push([`polling ${hertz} Hz`, encodeGloriousCore2PollingRate(hertz, hertz, profile)]);
  // ... then 8000 Hz on the cable with 4000 Hz on 2.4 GHz.
  cases.push(["polling 8000 Hz wired, 4000 Hz wireless", encodeGloriousCore2PollingRate(8000, 4000, profile)]);
  return cases;
}

test("re-encodes every request CORE sent, byte for byte", () => {
  const sent = capture("core-session.hex").filter((entry) => entry.dir === ">");
  assert.equal(sent.length, 116);
  const known = new Map(expectedRequests().map(([name, bytes]) => [key(bytes), name]));
  const unexplained = sent.filter(({ bytes }) => !known.has(key(bytes)));
  assert.deepEqual(unexplained.map(({ bytes }) => key(bytes).slice(0, 40)), []);
  // The other direction: every case above was really sent, and 22 is all there is.
  const seen = new Set(sent.map(({ bytes }) => key(bytes)));
  assert.deepEqual([...known].filter(([hex]) => !seen.has(hex)).map(([, name]) => name), []);
  assert.equal(seen.size, 22);
});

test("CORE sends a burst in a fixed order, ending with debounce and motion sync", () => {
  const sent = capture("core-session.hex").filter((entry) => entry.dir === ">");
  const first = sent.findIndex(({ bytes }) => bytes[3] === 0x12);
  const register = (offset: number) => sent[first + offset]!.bytes[5];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((offset) => [sent[first + offset]!.bytes[4], register(offset)]), [
    [GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.dpiStages],
    [GLORIOUS_CORE2_BANK.lighting, GLORIOUS_CORE2_REGISTER.dpiColors],
    [GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.liftOff],
    [GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.activeDpiStage],
    [GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.pollingRate],
    [GLORIOUS_CORE2_BANK.system, GLORIOUS_CORE2_REGISTER.debounce],
    [GLORIOUS_CORE2_BANK.profile, GLORIOUS_CORE2_REGISTER.motionSync],
  ]);
});

test("the polling frame matches the one GloriousAutoPollingRate sends for 1000 Hz, apart from the profile", () => {
  const theirs = Uint8Array.from([0x00, 0x00, 0x02, 0x03, 0x01, 0x0a, 0x01, 0x01, 0x01]);
  assert.deepEqual(encodeGloriousCore2PollingRate(1000, 1000, 1).subarray(0, theirs.length), theirs);
  assert.deepEqual(encodeGloriousCore2PollingRate(125, 125, 1).subarray(7, 9), Uint8Array.from([0x08, 0x08]));
  assert.deepEqual(encodeGloriousCore2PollingRate(4000, 4000, 1).subarray(7, 9), Uint8Array.from([0x40, 0x40]));
});

test("a chosen rate goes into both bytes, except 8000 Hz whose wireless byte is 4000 Hz", () => {
  for (const [hertz, code] of GLORIOUS_CORE2_POLLING_CODES) {
    const wirelessCode = hertz === 8000 ? 0x40 : code;
    const frame = encodeGloriousCore2PollingRate(hertz, Math.min(hertz, GLORIOUS_CORE2_WIRELESS_MAX_POLLING_HZ), profile);
    assert.deepEqual([...frame.subarray(7, 9)], [code, wirelessCode], `${hertz} Hz`);
  }
  assert.deepEqual(GLORIOUS_CORE2_POLLING_CODES.map(([, code]) => code), [0x08, 0x04, 0x02, 0x01, 0x20, 0x40, 0x80]);
  assert.equal(gloriousCore2PollingCode(1500), null);
  assert.throws(() => encodeGloriousCore2PollingRate(1500, 1000, profile), /1500/);
});

test("simple debounce clears the advanced times; the advanced block is the five times and a zero", () => {
  assert.deepEqual([...encodeGloriousCore2Debounce(12, 1).subarray(2, 13)], [0x02, 7, 0, 0x08, 1, 12, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    [...encodeGloriousCore2AdvancedDebounce({ beforePress: 1, beforeRelease: 2, afterPress: 3, afterRelease: 4, liftOffPress: 5 }, 1).subarray(6, 13)],
    [1, 1, 2, 3, 4, 5, 0],
  );
  assert.throws(() => encodeGloriousCore2Debounce(17, 1), /0 to 16/);
  assert.throws(() => encodeGloriousCore2AdvancedDebounce({ beforePress: 0, beforeRelease: 0, afterPress: 0, afterRelease: 0, liftOffPress: 18 }, 1), /0 to 16/);
});

test("the profile select frame is mxw's and CORE's: bank 0, register 5, the profile", () => {
  assert.deepEqual([...encodeGloriousCore2Profile(2).subarray(0, 7)], [0x00, 0x00, 0x02, 0x01, 0x00, 0x05, 0x02]);
  assert.throws(() => encodeGloriousCore2Profile(0), /1 to 3/);
  assert.throws(() => encodeGloriousCore2Profile(4), /1 to 3/);
  assert.throws(() => encodeGloriousCore2DpiStages([800], 4), /1 to 3/);
});

test("CORE reads a receiver's own firmware with target 0 and the mouse's with target 2", () => {
  assert.deepEqual([...encodeGloriousCore2FirmwareRequest("mouse").subarray(0, 6)], [0x00, 0x00, 0x02, 0x03, 0x00, 0x81]);
  assert.deepEqual([...encodeGloriousCore2FirmwareRequest("receiver").subarray(0, 6)], [0x00, 0x00, 0x00, 0x03, 0x00, 0x81]);
});

test("decodes the firmware reply: version 1.0.15.0 and the wired product id", () => {
  const reply = capture("core-session.hex").find((entry) => entry.dir === "<" && entry.bytes[5] === 0x81)!;
  assert.deepEqual(decodeGloriousCore2Firmware(reply.bytes), { version: "1.0.15.0", productId: 0x201b });
  const short = Uint8Array.from(reply.bytes);
  short[3] = 4;
  assert.deepEqual(decodeGloriousCore2Firmware(short), { version: "1.0.15.0", productId: null });
});

test("decodes every battery reply CORE read: 100 %, not charging", () => {
  const replies = capture("core-session.hex").filter((entry) => entry.dir === "<" && entry.bytes[5] === 0x83);
  assert.equal(replies.length, 10);
  for (const { bytes } of replies) assert.deepEqual(decodeGloriousCore2Battery(bytes), { percent: 100, charging: false });
});

test("an asleep, waking or foreign reply is not a battery or firmware answer", () => {
  const reply = capture("core-session.hex").find((entry) => entry.dir === "<" && entry.bytes[5] === 0x83)!.bytes;
  for (const status of [0xa0, 0xa2, 0xa4]) {
    const other = Uint8Array.from(reply);
    other[0] = status;
    assert.equal(decodeGloriousCore2Battery(other), null);
  }
  assert.equal(decodeGloriousCore2Firmware(reply), null);
  assert.equal(decodeGloriousCore2Battery(new Uint8Array(3)), null);
  assert.equal(decodeGloriousCore2Battery(new Uint8Array(64)), null);
  assert.equal(decodeGloriousCore2Reply(new Uint8Array(3)), null);
});

test("the last write of every burst is answered with an echo whose status is ok", () => {
  const echoes = capture("core-session.hex").filter((entry) => entry.dir === "<" && entry.bytes[5] === GLORIOUS_CORE2_REGISTER.motionSync);
  assert.equal(echoes.length, 30);
  for (const { bytes } of echoes) assert.equal(decodeGloriousCore2Reply(bytes)?.status, 0xa1);
});

test("the DPI button reports agree with the stage table CORE wrote", () => {
  const written = capture("core-session.hex").find((entry) => entry.bytes[3] === 0x12 && entry.bytes[5] === 0x01)!.bytes;
  const count = written[7]!;
  const table = Array.from({ length: count }, (_, stage) => {
    const at = 8 + stage * 4;
    return { x: (written[at]! << 8) | written[at + 1]!, y: (written[at + 2]! << 8) | written[at + 3]! };
  });
  assert.deepEqual(table.map(({ x }) => x), FACTORY_STAGES);
  const reports = capture("dpi-button-reports.hex");
  assert.equal(reports.length, 11);
  for (const { bytes } of reports) {
    assert.equal(bytes[0], 0x01);
    const stage = table[bytes[1]! - 1]!;
    assert.deepEqual([(bytes[2]! << 8) | bytes[3]!, (bytes[4]! << 8) | bytes[5]!], [stage.x, stage.y]);
  }
});

test("rejects DPI, stage and color values the frame cannot carry", () => {
  assert.throws(() => encodeGloriousCore2DpiStages([], 1), /1 to 6/);
  assert.throws(() => encodeGloriousCore2DpiStages([800, 800, 800, 800, 800, 800, 800], 1), /1 to 6/);
  assert.throws(() => encodeGloriousCore2DpiStages([99], 1), /DPI/);
  assert.throws(() => encodeGloriousCore2DpiStages([26_001], 1), /DPI/);
  assert.throws(() => encodeGloriousCore2DpiStages([800.5], 1), /DPI/);
  assert.throws(() => encodeGloriousCore2DpiColors(["#12345"], 1), /#rrggbb/);
  assert.throws(() => encodeGloriousCore2DpiColors(new Array(7).fill("#000000"), 1), /6 stage colors/);
  assert.throws(() => encodeGloriousCore2ActiveDpiStage(6, 1), /out of range/);
  assert.throws(() => gloriousCore2Request(1, 1, new Array(59).fill(0)), /fit/);
});

test("26000 DPI is 0x6590 on both axes", () => {
  assert.deepEqual([...encodeGloriousCore2DpiStages([26_000], profile).subarray(6, 14)], [profile, 1, 0x65, 0x90, 0x65, 0x90, 0, 0]);
});
