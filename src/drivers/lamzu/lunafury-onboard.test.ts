import assert from "node:assert/strict";
import test from "node:test";
import { LamzuHidClient } from "./hid.ts";

(globalThis as { window?: { setTimeout: typeof setTimeout } }).window ??= { setTimeout };

function fixture(productId = 0x0033, options: { ignore?: string; stale?: string; fail?: string; unsupported?: boolean; truncate?: boolean } = {}) {
  let activeProfile = 1;
  const banks = Array.from({ length: 3 }, (_, index) => ({
    count: 3, active: 2, axes: true, scan: 1, usb: 1, lod: 1, debounce: 0,
    flags: {} as Record<number, number>, angle: 0, lightning: 0,
    latency: [0, 0, 0, 3], wheel: false, window: 100,
    table: [400 + index * 50, 800, 800 + index * 50, 1600, 1600 + index * 50, 3200, 3200, 6400, 6400, 6400, 30000, 30000],
  }));
  const sent: Uint8Array[] = [];
  const writes: Array<{ key: string; profile: number; activeProfile: number }> = [];
  let attempts = 0;
  const device = {
    vendorId: 0x373e, productId, productName: "LunaFury", opened: true,
    collections: [], open: async () => {}, close: async () => {},
    sendFeatureReport: async (_id: number, packet: Uint8Array) => {
      const copy = new Uint8Array(packet); sent.push(copy); attempts = 0;
      const key = `${copy[4]}:${copy[5]}`;
      if (copy[5] < 0x80 && key !== "0:5") writes.push({ key, profile: copy[6], activeProfile });
      if (options.ignore === key) return;
      const bank = banks[copy[6] - 1];
      if (key === "0:5") activeProfile = copy[6];
      if (!bank) return;
      if (key === "0:31") bank.scan = copy[7];
      if (key === "1:0") bank.usb = copy[7];
      if (key === "1:8") bank.lod = copy[7];
      if (key === "0:8") bank.debounce = copy[7];
      if (copy[4] === 1 && [4, 9, 0x0a, 0x0b, 0x13].includes(copy[5])) bank.flags[copy[5]] = copy[7];
      if (key === "1:20") bank.angle = copy[7] > 127 ? copy[7] - 256 : copy[7];
      if (key === "0:24") bank.lightning = copy[7];
      if (key === "0:18") bank.latency[copy[8]] = (copy[9] << 8) | copy[10];
      if (key === "0:25") { bank.wheel = copy[7] === 1; bank.window = (copy[8] << 8) | copy[9]; }
      if (key === "1:2") bank.active = copy[7];
      if (key === "1:13") bank.axes = copy[7] === 1;
      if (key === "1:1") {
        bank.count = copy[7];
        bank.table = Array.from({ length: 12 }, (_, index) => (copy[8 + index * 2] << 8) | copy[9 + index * 2]);
      }
    },
    receiveFeatureReport: async () => {
      const packet = sent.at(-1)!;
      const key = `${packet[4]}:${packet[5]}`;
      if (options.fail === key) throw new Error("Injected feature-report read failure.");
      const profile = packet[6];
      const bank = banks[profile - 1] ?? banks[activeProfile - 1];
      let payload = [profile, 0];
      if (key === "0:129") payload = [0, 0, 26, 0];
      if (key === "0:131") payload = [0, 90];
      if (key === "0:133") payload = [activeProfile];
      if (key === "0:159") payload = [profile, bank.scan];
      if (key === "1:129") payload = [profile, bank.count, ...bank.table.flatMap((value) => [value >> 8, value & 255])];
      if (key === "1:130") payload = [profile, bank.active];
      if (key === "1:141") payload = [profile, +bank.axes];
      if (key === "1:128") payload = [profile, bank.usb];
      if (key === "1:136") payload = [profile, bank.lod];
      if (key === "0:136") payload = [profile, bank.debounce];
      if (packet[4] === 1 && [0x84, 0x89, 0x8a, 0x8b, 0x93].includes(packet[5])) payload = [profile, bank.flags[packet[5] - 0x80] ?? 0];
      if (key === "1:148") payload = [profile, bank.angle & 255];
      if (key === "0:152") payload = [profile, bank.lightning, 0, 0];
      if (key === "0:146") payload = [profile, 0, packet[8], 0, bank.latency[packet[8]], ...Array(14).fill(0)];
      if (key === "0:153") payload = [profile, +bank.wheel, bank.window >> 8, bank.window & 255];
      if (key === "0:135") payload = [profile, 1, 44];
      const reply = new Uint8Array(64);
      reply[0] = options.unsupported && ["0:159", "1:141"].includes(key) ? 0xa2 : 0xa1;
      reply[4] = packet[4]; reply[5] = packet[5]; reply[3] = payload.length;
      reply.set(payload, 6);
      if (options.stale === key && attempts++ === 0) reply[6] = profile === 1 ? 2 : 1;
      if (options.truncate && key === "1:129") return new DataView(reply.slice(0, 10).buffer);
      const buffer = new Uint8Array(70); buffer.set(reply, 3);
      return new DataView(buffer.buffer, 3, 64);
    },
  } as unknown as HIDDevice;
  return { client: new LamzuHidClient(device), sent, banks, device, writes };
}

test("LunaFury no longer exposes custom colors or sends color-table reads", async () => {
  const { client, sent } = fixture();
  assert.equal("setDpiStageColor" in client, false);
  assert.equal((await client.readStatus()).dpiStageColors, undefined);
  await client.setDpiStageCount(4);
  assert.equal(sent.some((packet) => packet[4] === 2 && [1, 0x81].includes(packet[5])), false);
});

for (const [pid, target, max] of [[0x32, 0, 6], [0x33, 2, 6], [0x54, 0, 5], [0x84, 2, 5]] as const) {
  test(`LunaFury ${pid.toString(16)} exposes model-specific onboard limits`, async () => {
    const { client } = fixture(pid);
    const status = await client.readStatus();
    assert.equal(status.profileCount, 3);
    assert.equal(status.ui?.dpiStageEditor?.maxStages, max);
    assert.equal(status.ui?.dpiStageEditor?.countEditable, true);
    assert.deepEqual(status.dpiStages, [400, 800, 1600]);
    assert.deepEqual(status.dpiStagesY, [800, 1600, 3200]);
    assert.equal(status.activeDpiStage, 1);
    assert.equal(status.supportsSeparateDpiAxes, true);
    assert.equal(status.lunafury?.separateDpiAxes, true);
    assert.deepEqual(status.lunafury?.supportedButtonPollingRates, pid === 0x32 ? [1000] : [1000, 2000, 4000, 8000]);
  });

  test(`LunaFury ${pid.toString(16)} edits both axes without touching other stages`, async () => {
    const { client, banks, sent } = fixture(pid);
    await client.readStatus();
    const previous = [...banks[0].table];
    assert.equal(await client.setDpiStageValue(0, 1200), 1200);
    assert.deepEqual(banks[0].table, [1200, previous[1], ...previous.slice(2)]);
    await client.setLunaFuryDpiStageAxes(0, 1200, 2400);
    assert.equal(banks[0].table[1], 2400);
    await client.setActiveDpiStage(0);
    const status = await client.readStatus(true);
    assert.equal(status.dpi, 1200); assert.equal(status.dpiY, 2400);
    const writes = sent.filter((packet) => packet[5] < 0x80);
    assert.ok(writes.every((packet) => packet[2] === target && packet[6] === 1));
    assert.equal(writes.find((packet) => packet[5] === 1)?.[3], 26);
  });

  test(`LunaFury ${pid.toString(16)} changes count and clamps active stage before shrinking`, async () => {
    const { client, banks, sent } = fixture(pid);
    await client.setActiveDpiStage(2);
    const previous = [...banks[0].table];
    await client.setDpiStageCount(1);
    assert.equal(banks[0].active, 1); assert.equal(banks[0].count, 1);
    assert.deepEqual(banks[0].table, previous, "dormant stage values survive shrinking");
    await client.setDpiStageCount(max);
    assert.equal(banks[0].count, max);
    assert.deepEqual(banks[0].table, previous);
    const writes = sent.filter((packet) => packet[4] === 1 && packet[5] < 0x80);
    assert.deepEqual(writes.map((packet) => packet[5]), [2, 2, 1, 1]);
  });

  test(`LunaFury ${pid.toString(16)} switches banks and discards old live cache`, async () => {
    const { client, banks, sent } = fixture(pid);
    await client.readStatus();
    assert.equal(await client.setProfile(3), 3);
    const status = await client.readStatus(true);
    assert.equal(status.activeProfile, 3); assert.equal(status.dpi, 900);
    await client.setDpiStageValue(1, 2000);
    assert.equal(banks[0].table[2], 800); assert.equal(banks[2].table[2], 2000);
    assert.ok(sent.filter((packet) => packet[5] === 5 || packet[5] === 1).every((packet) => packet[2] === target && packet[6] === 3));
  });
}

test("independent button polling does not change USB report frequency", async () => {
  const { client, banks } = fixture();
  await client.readStatus();
  for (const hz of [1000, 2000, 4000, 8000] as const) assert.equal(await client.setLunaFuryButtonPollingRate(hz), hz);
  assert.equal(banks[0].usb, 1);
  assert.equal((await client.readStatus(true)).lunafury?.buttonPollingRateHz, 8000);
  const wired = fixture(0x32);
  await assert.rejects(wired.client.setLunaFuryButtonPollingRate(8000), /does not support/);
  assert.equal(wired.sent.length, 0);
});

test("new setters fail on ignored writes and stale profile replies cannot confirm them", async () => {
  for (const [ignore, operation] of [
    ["0:5", (client: LamzuHidClient) => client.setProfile(3)],
    ["0:31", (client: LamzuHidClient) => client.setLunaFuryButtonPollingRate(8000)],
    ["1:2", (client: LamzuHidClient) => client.setActiveDpiStage(0)],
    ["1:13", (client: LamzuHidClient) => client.setLunaFurySeparateDpiAxes(false)],
    ["1:1", (client: LamzuHidClient) => client.setDpiStageValue(0, 1200)],
    ["1:1", (client: LamzuHidClient) => client.setDpiStageCount(4)],
  ] as const) {
    const { client } = fixture(0x33, { ignore, stale: ignore === "1:1" ? "1:129" : undefined });
    await assert.rejects(operation(client), /did not confirm/);
  }
});

test("axis lock, invalid values and disabled stages cannot write arbitrary data", async () => {
  const { client, sent, banks } = fixture();
  await client.setLunaFurySeparateDpiAxes(false);
  await client.setDpiStageValue(0, 1250);
  assert.deepEqual(banks[0].table.slice(0, 2), [1250, 1250]);
  const before = sent.filter((packet) => packet[5] < 0x80).length;
  for (const operation of [() => client.setProfile(4), () => client.setDpiStageCount(7),
    () => client.setDpiStageValue(0, 1234), () => client.setDpiStageValue(5, 800)]) await assert.rejects(operation());
  assert.equal(sent.filter((packet) => packet[5] < 0x80).length, before);
  await client.setLunaFuryDpiStageAxes(0, 800, 1600);
  assert.deepEqual(banks[0].table.slice(0, 2), [800, 1600], "axis lock must not prevent restoring dormant Y values");
});

test("multi-report stage edits and profile switches are serialized", async () => {
  const { client, banks } = fixture();
  await Promise.all([client.setDpiStageValue(0, 2000), client.setProfile(2), client.setDpiStageValue(0, 3000)]);
  assert.equal(banks[0].table[0], 2000); assert.equal(banks[1].table[0], 3000);
});

test("unsupported optional features stay absent and truncated DPI tables fail safely", async () => {
  const { client } = fixture(0x33, { unsupported: true });
  const status = await client.readStatus();
  assert.equal(status.lunafury?.buttonPollingRateHz, undefined);
  assert.equal(status.lunafury?.separateDpiAxes, undefined);
  assert.equal(status.supportsSeparateDpiAxes, undefined);
  await client.setDpi(1200);
  assert.equal((await client.readStatus()).dpi, 1200, "an unsupported axis toggle must not block the existing DPI control");
  await assert.rejects(fixture(0x33, { truncate: true }).client.setDpiStageValue(0, 1600), /Truncated/);
});

for (const pid of [0x32, 0x33, 0x54, 0x84]) {
  test(`LunaFury ${pid.toString(16)} keeps axis-read failures unknown and recovers on a full reread`, async () => {
    const options: { fail?: string } = { fail: "1:141" };
    const { client, banks, sent } = fixture(pid, options);
    const failed = await client.readStatus();
    assert.equal(failed.supportsSeparateDpiAxes, undefined);
    assert.equal(failed.lunafury?.separateDpiAxes, undefined);
    assert.deepEqual(failed.dpiStages, [400, 800, 1600]);
    assert.deepEqual(failed.dpiStagesY, [800, 1600, 3200]);
    assert.ok(sent.some(packet => packet[4] === 1 && packet[5] === 0x8d));

    options.fail = undefined;
    banks[0].axes = false;
    const recovered = await client.readStatus();
    assert.equal(recovered.supportsSeparateDpiAxes, true, "disabled X/Y is still a supported control");
    assert.equal(recovered.lunafury?.separateDpiAxes, false);
    assert.deepEqual(recovered.dpiStagesY, failed.dpiStagesY);
    assert.ok(sent.every(packet => packet[5] >= 0x80), "capability reads must not write the device");
  });
}

test("live status detects a profile switched outside this client", async () => {
  const { client, device } = fixture();
  await client.readStatus();
  const other = new LamzuHidClient(device);
  await other.setProfile(3);
  const status = await client.readStatus(true);
  assert.equal(status.activeProfile, 3);
  assert.deepEqual(status.dpiStages, [500, 900, 1700]);
});

for (const pid of [0x32, 0x33, 0x54, 0x84]) {
  test(`LunaFury ${pid.toString(16)} live refresh reads physical DPI switches and changed tables`, async () => {
    const { client, banks, sent } = fixture(pid);
    await client.readStatus();
    banks[0].active = 3;
    let live = await client.readStatus(true);
    assert.equal(live.activeDpiStage, 2);
    assert.equal(live.dpi, 1600); assert.equal(live.dpiY, 3200);
    banks[0].count = 4; banks[0].active = 4;
    banks[0].table[6] = 2000; banks[0].table[7] = 4000;
    live = await client.readStatus(true);
    assert.equal(live.activeDpiStage, 3);
    assert.equal(live.dpi, 2000); assert.equal(live.dpiY, 4000);
    assert.deepEqual(live.dpiStages, [400, 800, 1600, 2000]);
    assert.deepEqual(live.dpiStagesY, [800, 1600, 3200, 4000]);
    assert.equal(sent.some((packet) => packet[5] < 0x80), false, "refresh must not write the device");
  });
}

const oldSetters = [
  ["USB polling", (client: LamzuHidClient) => client.setPollingRate(1000)],
  ["LOD", (client: LamzuHidClient) => client.setLiftOffDistance("High")],
  ["angle snap", (client: LamzuHidClient) => client.setAngleSnapping(true)],
  ["motion sync", (client: LamzuHidClient) => client.setMotionSync(true)],
  ["tracking", (client: LamzuHidClient) => client.setPerformanceMode(true)],
  ["competitive", (client: LamzuHidClient) => client.setHyperMode(true)],
  ["ripple", (client: LamzuHidClient) => client.setRippleControl(true)],
  ["global debounce", (client: LamzuHidClient) => client.setDebounceTime(5)],
  ["sensor angle", (client: LamzuHidClient) => client.setAngleTuning(-15)],
  ["Lightning Trigger", (client: LamzuHidClient) => client.setLunaFuryLightningMode(1)],
  ["button debounce", (client: LamzuHidClient) => client.setLunaFuryButtonDebounce("middle", 8)],
  ["wheel guard", (client: LamzuHidClient) => client.setLunaFuryWheelGuard({ enabled: true, windowMs: 200 })],
] as const;

for (const [name, operation] of oldSetters) {
  test(`${name} shares the LunaFury bank queue with switches, new edits and live reads`, async () => {
    const { client, writes } = fixture();
    await client.readStatus();
    const [, , , , live] = await Promise.all([
      operation(client), client.setProfile(2), client.setDpiStageValue(0, 2000), operation(client), client.readStatus(true),
    ]);
    assert.deepEqual(writes.map(({ profile, activeProfile }) => [profile, activeProfile]), [[1, 1], [2, 2], [2, 2]]);
    assert.equal(live.activeProfile, 2, "a queued live read must not restore the previous bank cache");
    assert.equal(live.dpiStages?.[0], 2000);
    // Also cover the reverse ordering: a switch invoked first owns the next edit.
    await Promise.all([client.setProfile(3), operation(client)]);
    assert.deepEqual(writes.at(-1)?.profile, 3);
    assert.equal(writes.at(-1)?.activeProfile, 3);
  });
}

test("a rejected old setter does not stall later bank operations", async () => {
  const { client, writes } = fixture(0x33, { ignore: "1:0" });
  const results = await Promise.allSettled([client.setPollingRate(2000), client.setProfile(2), client.setDpiStageValue(0, 2000)]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled"); assert.equal(results[2].status, "fulfilled");
  assert.ok(writes.every(({ profile, activeProfile }) => profile === activeProfile));
  assert.equal((await client.readStatus(true)).activeProfile, 2);
});

test("new controls are gated to LunaFury and do not expose generic Lamzu banks", async () => {
  const { device, sent } = fixture();
  Object.defineProperty(device, "productId", { value: 0x001d });
  const client = new LamzuHidClient(device);
  await assert.rejects(client.setProfile(2), /only available on LunaFury/);
  await assert.rejects(client.setDpiStageCount(4), /only available on LunaFury/);
  await assert.rejects(client.setLunaFuryButtonPollingRate(8000), /only available on LunaFury/);
  assert.equal(sent.length, 0);
});

for (const pid of [0x32, 0x33, 0x54, 0x84]) {
  test(`LunaFury ${pid.toString(16)} restores all stored slots without activating dormant reserved values`, async () => {
    const { client, banks } = fixture(pid);
    // Invalid as enabled DPI, but legitimate opaque storage while disabled.
    banks[0].table[8] = 0; banks[0].table[9] = 65535;
    const original = [...banks[0].table];
    const saved = (await client.readStatus()).lunafury!.dpiStorage!;
    assert.equal(saved.stages.length, pid === 0x32 || pid === 0x33 ? 6 : 5);
    await client.setDpiStageCount(4);
    await client.setLunaFuryDpiStageAxes(3, 2000, 4000);
    await client.setActiveDpiStage(3);
    await client.setLunaFuryDpiStorage(saved);
    assert.equal(banks[0].count, 3); assert.equal(banks[0].active, 3);
    assert.deepEqual(banks[0].table, original);
    assert.deepEqual((await client.readStatus(true)).lunafury!.dpiStorage, saved);
    await client.setDpiStageCount(4);
    const reenabled = await client.readStatus(true);
    assert.equal(reenabled.dpiStages![3], 3200); assert.equal(reenabled.dpiStagesY![3], 6400);
    assert.deepEqual(banks[0].table, original);
  });
}

test("stored DPI restores reject ignored writes and malformed or wrong-bank backups", async () => {
  const { client, banks, writes } = fixture(0x33, { ignore: "1:1" });
  const saved = (await client.readStatus()).lunafury!.dpiStorage!;
  banks[0].table[6] = 2000;
  await assert.rejects(client.setLunaFuryDpiStorage(saved), /complete stored/);
  for (const invalid of [{ ...saved, count: 0 }, { ...saved, stages: saved.stages.slice(0, 3) },
    { ...saved, stages: saved.stages.map((stage, index) => index === 0 ? { ...stage, x: 51 } : stage) }]) {
    const count = writes.length;
    await assert.rejects(client.setLunaFuryDpiStorage(invalid));
    assert.equal(writes.length, count);
  }
  await client.setProfile(2);
  const count = writes.length;
  await assert.rejects(client.setLunaFuryDpiStorage(saved), /another onboard/);
  assert.equal(writes.length, count);
  await client.setProfile(1);
  assert.equal((await client.readStatus(true)).activeProfile, 1, "a rejected restore must not stall the queue");
});

test("stored DPI backups are cloned before waiting for bank operations", async () => {
  const { client, banks, writes } = fixture();
  const saved = (await client.readStatus()).lunafury!.dpiStorage!;
  const pending = client.setLunaFuryDpiStorage(saved);
  saved.stages[0].x = 2000;
  await pending;
  assert.equal(banks[0].table[0], 400);
  const [, result] = await Promise.allSettled([client.setProfile(2), client.setLunaFuryDpiStorage(saved)]);
  assert.equal(result.status, "rejected");
  assert.ok(writes.every(write => write.profile === write.activeProfile));
  Object.defineProperty(client.device, "productId", { value: 0x001d });
  await assert.rejects(client.setLunaFuryDpiStorage(saved), /only available on LunaFury/);
});
