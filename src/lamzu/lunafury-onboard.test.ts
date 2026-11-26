import assert from "node:assert/strict";
import test from "node:test";
import { compaxEncodeRequest } from "../compx/codec.ts";
import { LUNAFURY_ONBOARD_READ as read, LUNAFURY_ONBOARD_WRITE as write,
  lunafuryDecodeButtonRate, lunafuryDecodeSeparateAxes, lunafuryDecodeDpiStages, lunafuryWriteDpiStages,
  lunafuryDecodeDpiStorage, lunafuryWriteDpiStorage } from "./lunafury-onboard.ts";

test("onboard commands use the vendor pages, lengths and one-based wire indices", () => {
  for (const [spec, prefix] of [
    [read.profile(), [0, 0, 2, 1, 0, 0x85]],
    [write.profile(3), [0, 0, 2, 1, 0, 5, 3]],
    [read.buttonRate(2), [0, 0, 2, 2, 0, 0x9f, 2]],
    [write.buttonRate(2, 8000), [0, 0, 2, 2, 0, 0x1f, 2, 128]],
    [read.dpiStages(3, 5), [0, 0, 2, 10, 1, 0x81, 3, 5]],
    [write.activeStage(3, 4, 5), [0, 0, 2, 2, 1, 2, 3, 5]],
    [write.separateAxes(3, true), [0, 0, 2, 2, 1, 0x0d, 3, 1]],
  ] as const) assert.deepEqual([...compaxEncodeRequest(spec).slice(0, prefix.length)], prefix);
});

test("button scan encodings differ from USB polling encodings", () => {
  for (const [code, hz] of [[1, 1000], [32, 2000], [64, 4000], [128, 8000]] as const) {
    assert.equal(lunafuryDecodeButtonRate(Uint8Array.of(2, code)), hz);
    assert.equal(write.buttonRate(2, hz).args[1], code);
  }
  for (const payload of [null, Uint8Array.of(1), Uint8Array.of(1, 2), Uint8Array.of(1, 16)]) {
    assert.equal(lunafuryDecodeButtonRate(payload), undefined);
  }
  assert.equal(lunafuryDecodeSeparateAxes(Uint8Array.of(1, 0)), false);
  assert.equal(lunafuryDecodeSeparateAxes(Uint8Array.of(1, 1)), true);
  for (const payload of [null, Uint8Array.of(1), Uint8Array.of(1, 2)]) assert.equal(lunafuryDecodeSeparateAxes(payload), undefined);
});

test("DPI table edits preserve dormant stage and trailing bytes", () => {
  const previous = Uint8Array.of(3, 1, 3, 32, 6, 64, ...Array.from({ length: 20 }, (_, index) => 100 + index));
  assert.deepEqual(lunafuryDecodeDpiStages(previous, 6), [{ x: 800, y: 1600 }]);
  const spec = lunafuryWriteDpiStages(3, [{ x: 1200, y: 2400 }], previous, 6);
  assert.equal(spec.length, 26);
  assert.deepEqual(spec.args.slice(0, 6), [3, 1, 4, 176, 9, 96]);
  assert.deepEqual(spec.args.slice(6), [...previous.slice(6)]);
});

test("onboard codecs reject invalid profiles, counts, axes and truncated DPI tables", () => {
  for (const id of [0, 4, -1, 1.5, NaN]) {
    assert.throws(() => write.profile(id));
    assert.throws(() => read.buttonRate(id));
  }
  assert.throws(() => write.buttonRate(1, 125 as 1000));
  assert.throws(() => write.separateAxes(1, 1 as unknown as boolean));
  for (const stage of [-1, 3, 0.5]) assert.throws(() => write.activeStage(1, stage, 3));
  for (const max of [0, 4, 7]) assert.throws(() => read.dpiStages(1, max));
  for (const payload of [new Uint8Array(), Uint8Array.of(1, 0), Uint8Array.of(1, 6), Uint8Array.of(1, 1, 3, 32)]) {
    assert.throws(() => lunafuryDecodeDpiStages(payload, 5));
  }
  const previous = Uint8Array.of(1, 1, 3, 32, 3, 32);
  for (const dpi of [0, 25, 51, 30050, NaN]) assert.throws(() => lunafuryWriteDpiStages(1, [{ x: dpi, y: 800 }], previous, 6));
  assert.throws(() => lunafuryWriteDpiStages(2, [{ x: 800, y: 800 }], previous, 6), /another profile/);
});

test("complete storage codec separates enabled count, dormant data and TYPE33 trailing bytes", () => {
  const previous = Uint8Array.of(3, 1, 3, 32, 6, 64, ...Array.from({ length: 20 }, (_, index) => 100 + index));
  assert.equal(lunafuryDecodeDpiStorage(previous.slice(0, 6), 6), undefined);
  for (const max of [5, 6]) {
    const saved = lunafuryDecodeDpiStorage(previous, max)!;
    assert.equal(saved.count, 1); assert.equal(saved.stages.length, max);
    assert.deepEqual(lunafuryWriteDpiStorage(saved, previous, max).args, [...previous]);
    assert.throws(() => lunafuryWriteDpiStorage({ ...saved, profile: 2 }, previous, max), /another profile/);
    assert.throws(() => lunafuryWriteDpiStorage({ ...saved, stages: saved.stages.slice(1) }, previous, max), /Incomplete/);
    const reserved = { ...saved, stages: saved.stages.map((stage, index) => index === 1 ? { x: 0, y: 65535 } : stage) };
    assert.deepEqual(lunafuryWriteDpiStorage(reserved, previous, max).args.slice(6, 10), [0, 0, 255, 255]);
    assert.throws(() => lunafuryWriteDpiStorage({ ...reserved, count: 2 }, previous, max));
  }
});
