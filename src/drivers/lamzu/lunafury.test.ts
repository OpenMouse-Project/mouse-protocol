import assert from "node:assert/strict";
import test from "node:test";
import { LamzuHidClient } from "./hid.ts";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout } };
globals.window ??= { setTimeout };
const EXTRA_READS = new Set(["1:148", "0:152", "0:146", "0:153"]);

function fakeLunaFury(productId = 0x0033, options: {
  unsupported?: boolean;
  ignoreWrites?: boolean;
  mutateReply?: (packet: Uint8Array, reply: Uint8Array, attempt: number) => void;
} = {}) {
  const sent: Uint8Array[] = [];
  let receiveAttempt = 0;
  const state = { angle: -12, lightning: 1, latency: [0, 3, 7, 10], wheel: true, window: 200 };
  const device = {
    vendorId: 0x373e, productId, productName: "LunaFury", opened: true,
    collections: [{ usagePage: 0xff00, usage: 1, type: 1, children: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      inputReports: [], outputReports: [] }],
    open: async () => {}, close: async () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    sendFeatureReport: async (id: number, packet: Uint8Array) => {
      assert.equal(id, 0);
      sent.push(new Uint8Array(packet));
      receiveAttempt = 0;
      if (options.ignoreWrites) return;
      const page = packet[4], command = packet[5];
      if (page === 1 && command === 0x14) state.angle = packet[7]! > 127 ? packet[7]! - 256 : packet[7]!;
      if (page === 0 && command === 0x18) state.lightning = packet[7]!;
      if (page === 0 && command === 0x12) state.latency[packet[8]!] = (packet[9]! << 8) | packet[10]!;
      if (page === 0 && command === 0x19) { state.wheel = packet[7] === 1; state.window = (packet[8]! << 8) | packet[9]!; }
    },
    receiveFeatureReport: async () => {
      const packet = sent.at(-1)!;
      const page = packet[4]!, command = packet[5]!, profile = packet[6]!;
      const key = `${page}:${command}`;
      const reply = new Uint8Array(64);
      reply[0] = options.unsupported && EXTRA_READS.has(key) ? 0xa2 : 0xa1;
      reply[4] = page; reply[5] = command;
      let payload: number[] = [profile, 0];
      if (key === "0:133") payload = [3];
      if (key === "0:129") payload = [0, 0, 1, 2];
      if (key === "0:131") payload = [0, 80];
      if (key === "0:135") payload = [profile, 1, 44];
      if (key === "1:129") payload = [profile, 1, 3, 32, 3, 32];
      if (key === "1:128" || key === "1:136") payload = [profile, 1];
      if (key === "1:148") payload = [profile, state.angle & 255];
      if (key === "0:152") payload = [profile, state.lightning, 0, 0];
      if (key === "0:146") payload = [profile, 0, packet[8]!, 0, state.latency[packet[8]!]!, ...Array(14).fill(0)];
      if (key === "0:153") payload = [profile, +state.wheel, state.window >> 8, state.window & 255];
      reply[3] = payload.length; reply.set(payload, 6);
      options.mutateReply?.(packet, reply, receiveAttempt++);
      // Non-zero byteOffset exercises DataView framing without a report ID.
      const buffer = new Uint8Array(70); buffer.set(reply, 3);
      return new DataView(buffer.buffer, 3, 64);
    },
  } as unknown as HIDDevice;
  return { device, sent, state };
}

for (const [pid, target] of [[0x0032, 0], [0x0033, 2], [0x0054, 0], [0x0084, 2]] as const) {
  test(`LunaFury 0x${pid.toString(16)} reads independent settings on the active profile`, async () => {
    const { device, sent } = fakeLunaFury(pid);
    const client = new LamzuHidClient(device);
    const status = await client.readStatus();
    assert.equal(status.brand, "LunaFury");
    assert.equal(status.angleTuning, -12);
    assert.deepEqual(status.lunafury, {
      lightningMode: 1, leftDebounceMs: 3, rightDebounceMs: 7,
      middleDebounceMs: 10, wheelGuard: { enabled: true, windowMs: 200 },
    });
    const extra = sent.filter((packet) => EXTRA_READS.has(`${packet[4]}:${packet[5]}`));
    assert.equal(extra.length, 6);
    assert.ok(extra.every((packet) => packet[2] === target && packet[6] === 3));
    assert.deepEqual(extra.filter((packet) => packet[5] === 0x92).map((packet) => packet[8]), [1, 2, 3]);
    const count = sent.length;
    await client.readStatus(true);
    assert.ok(sent.slice(count).every((packet) => !EXTRA_READS.has(`${packet[4]}:${packet[5]}`)), "live polling must not repeatedly read static controls");
  });

  test(`LunaFury 0x${pid.toString(16)} writes and verifies all added controls`, async () => {
    const { device, sent } = fakeLunaFury(pid);
    const client = new LamzuHidClient(device);
    await client.readStatus();
    const before = sent.length;
    assert.equal(await client.setAngleTuning(-30), -30);
    assert.equal(await client.setLunaFuryLightningMode(2), 2);
    assert.equal(await client.setLunaFuryButtonDebounce("left", 15), 15);
    assert.equal(await client.setLunaFuryButtonDebounce("right", 0), 0);
    assert.equal(await client.setLunaFuryButtonDebounce("middle", 1), 1);
    assert.deepEqual(await client.setLunaFuryWheelGuard({ enabled: false, windowMs: 100 }), { enabled: false, windowMs: 100 });
    const writes = sent.slice(before).filter((packet) => packet[5]! < 0x80);
    assert.equal(writes.length, 6);
    assert.ok(writes.every((packet) => packet[2] === target && packet[6] === 3));
    const status = await client.readStatus();
    assert.equal(status.angleTuning, -30);
    assert.deepEqual(status.lunafury, {
      lightningMode: 2, leftDebounceMs: 15, rightDebounceMs: 0,
      middleDebounceMs: 1, wheelGuard: { enabled: false, windowMs: 100 },
    });
  });

  test(`LunaFury 0x${pid.toString(16)} waits past stale button replies`, async () => {
    const receives: number[][] = [];
    const { device, sent, state } = fakeLunaFury(pid, { mutateReply(packet, reply, attempt) {
      if (packet[4] !== 0 || packet[5] !== 0x92) return;
      const button = packet[8]!;
      receives.push([button, attempt]);
      if (attempt === 0 && button > 1) {
        reply[8] = button - 1;
        reply[10] = state.latency[button - 1]!;
      }
    } });
    state.latency[2] = 8;
    const status = await new LamzuHidClient(device).readStatus();
    assert.deepEqual(status.lunafury, {
      lightningMode: 1, leftDebounceMs: 3, rightDebounceMs: 8,
      middleDebounceMs: 10, wheelGuard: { enabled: true, windowMs: 200 },
    });
    assert.deepEqual(receives, [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1]]);
    assert.equal(sent.filter((packet) => packet[5] === 0x92).length, 3,
      "ignore stale replies without resending the request");
  });

  test(`LunaFury 0x${pid.toString(16)} waits past stale profile replies`, async () => {
    const receives: string[] = [];
    const { device } = fakeLunaFury(pid, { mutateReply(packet, reply, attempt) {
      const key = `${packet[4]}:${packet[5]}`;
      if (!EXTRA_READS.has(key)) return;
      receives.push(`${key}:${attempt}`);
      if (attempt !== 0) return;
      reply[6] = packet[6]! - 1;
      if (key === "0:146") reply[10] = 1;
      else reply[7] = 0;
      if (key === "0:153") { reply[8] = 0; reply[9] = 20; }
    } });
    const status = await new LamzuHidClient(device).readStatus();
    assert.equal(status.angleTuning, -12);
    assert.deepEqual(status.lunafury, {
      lightningMode: 1, leftDebounceMs: 3, rightDebounceMs: 7,
      middleDebounceMs: 10, wheelGuard: { enabled: true, windowMs: 200 },
    });
    assert.equal(receives.length, 12);
    assert.equal(receives.filter((key) => key.endsWith(":1")).length, 6);
  });
}

test("LunaFury readback waits past stale profiles and button selectors", async () => {
  let inject = false;
  let readbacks = 0;
  const { device, sent } = fakeLunaFury(0x0033, { mutateReply(packet, reply, attempt) {
    if (!inject || !EXTRA_READS.has(`${packet[4]}:${packet[5]}`)) return;
    readbacks += 1;
    if (attempt === 0) reply[6] = packet[6]! - 1;
    else if (attempt === 1 && packet[5] === 0x92) reply[8] = packet[8] === 1 ? 2 : 1;
  } });
  const client = new LamzuHidClient(device);
  await client.readStatus();
  inject = true;
  const before = sent.length;
  assert.equal(await client.setAngleTuning(15), 15);
  assert.equal(await client.setLunaFuryLightningMode(2), 2);
  assert.equal(await client.setLunaFuryButtonDebounce("left", 4), 4);
  assert.equal(await client.setLunaFuryButtonDebounce("right", 8), 8);
  assert.equal(await client.setLunaFuryButtonDebounce("middle", 12), 12);
  assert.deepEqual(await client.setLunaFuryWheelGuard({ enabled: false, windowMs: 100 }),
    { enabled: false, windowMs: 100 });
  assert.equal(readbacks, 15);
  assert.equal(sent.slice(before).filter((packet) => EXTRA_READS.has(`${packet[4]}:${packet[5]}`)).length, 6);
  const status = await client.readStatus(true);
  assert.equal(status.angleTuning, 15);
  assert.deepEqual(status.lunafury, {
    lightningMode: 2, leftDebounceMs: 4, rightDebounceMs: 8,
    middleDebounceMs: 12, wheelGuard: { enabled: false, windowMs: 100 },
  });
});

test("LunaFury stale readback cannot confirm an ignored write", async () => {
  let inject = false;
  const { device } = fakeLunaFury(0x0033, { ignoreWrites: true, mutateReply(packet, reply, attempt) {
    if (!inject || packet[4] !== 0 || packet[5] !== 0x92 || attempt !== 0) return;
    reply[6] = packet[6]! - 1;
    reply[10] = 5;
  } });
  const client = new LamzuHidClient(device);
  await client.readStatus();
  inject = true;
  await assert.rejects(client.setLunaFuryButtonDebounce("left", 5), /did not confirm/);
  assert.equal((await client.readStatus(true)).lunafury?.leftDebounceMs, 3);
});

test("LunaFury exhausted stale replies stay absent and bounded", async () => {
  let receives = 0;
  const { device } = fakeLunaFury(0x0033, { mutateReply(packet, reply) {
    if (!EXTRA_READS.has(`${packet[4]}:${packet[5]}`)) return;
    receives += 1;
    reply[6] = packet[6]! - 1;
  } });
  const status = await new LamzuHidClient(device).readStatus();
  assert.equal(status.dpi, 800);
  assert.equal(status.batteryPercent, 80);
  assert.equal(status.angleTuning, null);
  assert.ok(Object.values(status.lunafury!).every((value) => value === undefined));
  assert.equal(receives, 12, "each optional read keeps its two-attempt limit");
});

test("other CompX profile replies retain their existing matching rules", async () => {
  const { device } = fakeLunaFury(0x006a, { mutateReply(packet, reply) {
    if (packet[5] === 0x88 || (packet[4] === 1 && packet[5] === 0x80)) reply[6] = 1;
  } });
  const status = await new LamzuHidClient(device).readStatus();
  assert.equal(status.brand, "CRDRAKO");
  assert.equal(status.activeProfile, 3);
  assert.equal(status.debounceMs, 0);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.lunafury, undefined);
});

test("unsupported LunaFury controls do not break the base device status", async () => {
  const { device } = fakeLunaFury(0x0033, { unsupported: true });
  const status = await new LamzuHidClient(device).readStatus();
  assert.equal(status.dpi, 800);
  assert.equal(status.batteryPercent, 80);
  assert.equal(status.angleTuning, null);
  assert.ok(Object.values(status.lunafury!).every((value) => value === undefined));
});

test("LunaFury keeps only explicitly reported EL/ES color suffixes", () => {
  for (const pid of [0x0032, 0x0033, 0x0054, 0x0084]) {
    const { device } = fakeLunaFury(pid);
    const model = pid === 0x0032 || pid === 0x0033 ? "LUNA33" : "TYPE33";
    for (const suffix of ["EL", "ES", "el", "es"]) {
      Object.assign(device, { productName: `LunaFury ${model} ${suffix}` });
      assert.equal(new LamzuHidClient(device).displayName(), `LunaFury ${model} ${suffix.toUpperCase()}`);
    }
    for (const name of ["LunaFury", "WIRELESS RECEIVER", "ELSE", "SHELL", undefined]) {
      Object.assign(device, { productName: name });
      assert.equal(new LamzuHidClient(device).displayName(), `LunaFury ${model}`);
    }
  }
  const { device } = fakeLunaFury(0x006a);
  Object.assign(device, { productName: "CRDRAKO KO-ONE ES" });
  assert.equal(new LamzuHidClient(device).displayName(), "CRDRAKO KO-ONE");
});

test("a disabled zero wheel window can be restored exactly", async () => {
  const { device, state } = fakeLunaFury();
  state.wheel = false;
  state.window = 0;
  const client = new LamzuHidClient(device);
  const before = (await client.readStatus()).lunafury!.wheelGuard!;
  await client.setLunaFuryWheelGuard({ enabled: true, windowMs: 100 });
  assert.deepEqual(await client.setLunaFuryWheelGuard(before), { enabled: false, windowMs: 0 });
  assert.deepEqual((await client.readStatus()).lunafury!.wheelGuard, before);
});

test("ignored writes are rejected instead of updating the cached status", async () => {
  const { device } = fakeLunaFury(0x0033, { ignoreWrites: true });
  const client = new LamzuHidClient(device);
  await client.readStatus();
  await assert.rejects(client.setAngleTuning(10), /did not confirm/);
  await assert.rejects(client.setLunaFuryLightningMode(0), /did not confirm/);
  await assert.rejects(client.setLunaFuryButtonDebounce("left", 5), /did not confirm/);
  await assert.rejects(client.setLunaFuryButtonDebounce("right", 5), /did not confirm/);
  await assert.rejects(client.setLunaFuryButtonDebounce("middle", 5), /did not confirm/);
  await assert.rejects(client.setLunaFuryWheelGuard({ enabled: false, windowMs: 20 }), /did not confirm/);
  const status = await client.readStatus();
  assert.equal(status.angleTuning, -12);
  assert.equal(status.lunafury?.lightningMode, 1);
  assert.equal(status.lunafury?.leftDebounceMs, 3);
  assert.deepEqual(status.lunafury?.wheelGuard, { enabled: true, windowMs: 200 });
});

test("other CompX brands never receive LunaFury commands", async () => {
  const { device, sent } = fakeLunaFury(0x006a);
  const client = new LamzuHidClient(device);
  assert.equal((await client.readStatus()).lunafury, undefined);
  const count = sent.length;
  await assert.rejects(client.setAngleTuning(1), /only available on LunaFury/);
  await assert.rejects(client.setLunaFuryLightningMode(1), /only available on LunaFury/);
  await assert.rejects(client.setLunaFuryButtonDebounce("left", 1), /only available on LunaFury/);
  await assert.rejects(client.setLunaFuryWheelGuard({ enabled: true, windowMs: 100 }), /only available on LunaFury/);
  assert.equal(sent.length, count);
  assert.ok(sent.every((packet) => !EXTRA_READS.has(`${packet[4]}:${packet[5]}`)));
});
