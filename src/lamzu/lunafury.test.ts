import assert from "node:assert/strict";
import test from "node:test";
import { compaxEncodeRequest } from "../compx/codec.ts";
import {
  LUNAFURY_READ, LUNAFURY_WRITE, lunafuryDecodeAngle,
  lunafuryDecodeLightning, lunafuryDecodeButtonDebounce, lunafuryDecodeWheelGuard,
} from "./lunafury.ts";

test("LunaFury read requests preserve page, length, profile and button ID", () => {
  const fixtures = [
    [LUNAFURY_READ.angle(3), [0, 0, 2, 2, 1, 0x94, 3]],
    [LUNAFURY_READ.lightning(3), [0, 0, 2, 4, 0, 0x98, 3]],
    [LUNAFURY_READ.buttonDebounce(3, "left"), [0, 0, 2, 19, 0, 0x92, 3, 0, 1]],
    [LUNAFURY_READ.buttonDebounce(3, "right"), [0, 0, 2, 19, 0, 0x92, 3, 0, 2]],
    [LUNAFURY_READ.buttonDebounce(3, "middle"), [0, 0, 2, 19, 0, 0x92, 3, 0, 3]],
    [LUNAFURY_READ.wheelGuard(3), [0, 0, 2, 4, 0, 0x99, 3]],
  ] as const;
  for (const [request, prefix] of fixtures) {
    const packet = compaxEncodeRequest(request);
    assert.equal(packet.length, 64);
    assert.deepEqual([...packet.slice(0, prefix.length)], prefix);
    assert.ok(packet.slice(prefix.length).every((byte) => byte === 0));
  }
});

test("sensor angle uses signed eight-bit degrees, including both boundaries", () => {
  for (const degrees of [-30, -12, 0, 12, 30]) {
    const packet = compaxEncodeRequest(LUNAFURY_WRITE.angle(3, degrees));
    assert.deepEqual([...packet.slice(0, 8)], [0, 0, 2, 2, 1, 0x14, 3, degrees & 255]);
    assert.equal(lunafuryDecodeAngle(Uint8Array.of(3, degrees & 255)), degrees);
  }
});

test("Lightning Trigger supports off, left priority and right priority", () => {
  for (const mode of [0, 1, 2] as const) {
    assert.deepEqual([...compaxEncodeRequest(LUNAFURY_WRITE.lightning(3, mode)).slice(0, 10)],
      [0, 0, 2, 4, 0, 0x18, 3, mode, 0, 0]);
    assert.equal(lunafuryDecodeLightning(Uint8Array.of(3, mode, 0, 0)), mode);
  }
});

test("per-button latency writes the complete vendor 19-byte timing layout", () => {
  for (const [button, id, ms] of [["left", 1, 0], ["right", 2, 15], ["middle", 3, 30]] as const) {
    const packet = compaxEncodeRequest(LUNAFURY_WRITE.buttonDebounce(3, button, ms));
    assert.deepEqual([...packet.slice(0, 25)], [0, 0, 2, 19, 0, 0x12,
      3, 0, id, 0, ms, 0, 0, 0, ms, 0, 0, 0, 20, 0, 0, 0, 20, 0, 0]);
    assert.equal(lunafuryDecodeButtonDebounce(packet.slice(6, 25), button), ms);
    assert.ok(packet.slice(25).every((byte) => byte === 0));
  }
});

test("wheel guard keeps the enable bit separate from the big-endian window", () => {
  for (const enabled of [false, true]) {
    for (const windowMs of [20, 100, 200]) {
      const guard = { enabled, windowMs };
      const packet = compaxEncodeRequest(LUNAFURY_WRITE.wheelGuard(3, guard));
      assert.deepEqual([...packet.slice(0, 10)], [0, 0, 2, 4, 0, 0x19, 3, +enabled, 0, windowMs]);
      assert.deepEqual(lunafuryDecodeWheelGuard(packet.slice(6, 10)), guard);
    }
  }
  assert.deepEqual(lunafuryDecodeWheelGuard(Uint8Array.of(3, 0, 0, 0)), { enabled: false, windowMs: 0 });
  assert.deepEqual([...compaxEncodeRequest(LUNAFURY_WRITE.wheelGuard(3, { enabled: false, windowMs: 0 })).slice(0, 10)],
    [0, 0, 2, 4, 0, 0x19, 3, 0, 0, 0]);
});

test("LunaFury requests reject invalid profile bytes instead of wrapping them", () => {
  for (const profile of [0, -1, 256, 1.5, NaN, Infinity]) {
    assert.throws(() => LUNAFURY_READ.angle(profile), /Profile ID/);
    assert.throws(() => LUNAFURY_WRITE.lightning(profile, 1), /Profile ID/);
    assert.throws(() => LUNAFURY_WRITE.wheelGuard(profile, { enabled: false, windowMs: 0 }), /Profile ID/);
  }
});

test("invalid values cannot produce write requests", () => {
  for (const value of [-31, 31, 0.5, NaN, Infinity]) assert.throws(() => LUNAFURY_WRITE.angle(1, value));
  for (const mode of [-1, 3, 1.5]) assert.throws(() => LUNAFURY_WRITE.lightning(1, mode as 0));
  for (const value of [-1, 16, 0.5]) assert.throws(() => LUNAFURY_WRITE.buttonDebounce(1, "left", value));
  for (const value of [0, 31, 1.5]) assert.throws(() => LUNAFURY_WRITE.buttonDebounce(1, "middle", value));
  assert.throws(() => LUNAFURY_WRITE.buttonDebounce(1, "toString" as "left", 1));
  for (const windowMs of [0, 10, 21, 201, NaN]) assert.throws(() => LUNAFURY_WRITE.wheelGuard(1, { enabled: true, windowMs }));
  assert.throws(() => LUNAFURY_WRITE.wheelGuard(1, { enabled: 1 as unknown as boolean, windowMs: 100 }));
});

test("malformed or unsupported responses stay unknown instead of inventing defaults", () => {
  for (const payload of [null, new Uint8Array(), Uint8Array.of(1)]) {
    assert.equal(lunafuryDecodeAngle(payload), null);
    assert.equal(lunafuryDecodeLightning(payload), undefined);
    assert.equal(lunafuryDecodeButtonDebounce(payload, "left"), undefined);
    assert.equal(lunafuryDecodeWheelGuard(payload), undefined);
  }
  assert.equal(lunafuryDecodeAngle(Uint8Array.of(1, 31)), null);
  assert.equal(lunafuryDecodeLightning(Uint8Array.of(1, 3)), undefined);
  assert.equal(lunafuryDecodeButtonDebounce(Uint8Array.of(1, 0, 2, 0, 10), "left"), undefined);
  assert.equal(lunafuryDecodeButtonDebounce(Uint8Array.of(1, 0, 1, 1, 0), "left"), undefined);
  assert.equal(lunafuryDecodeButtonDebounce(Uint8Array.of(1, 0, 3, 0, 0), "middle"), undefined);
  for (const bytes of [[1, 2, 0, 100], [1, 1, 0, 0], [1, 0, 0, 21], [1, 1, 1, 20]]) {
    assert.equal(lunafuryDecodeWheelGuard(Uint8Array.from(bytes)), undefined);
  }
});
