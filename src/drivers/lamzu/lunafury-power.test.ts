import assert from "node:assert/strict";
import test from "node:test";
import { LamzuHidClient } from "./hid.ts";
import { lunafuryDecodeReceiverLight, lunafuryDecodeSleep, lunafuryEncodeSleep,
  lunafuryWriteReceiverLight } from "../../lamzu/lunafury-power.ts";

(globalThis as { window?: { setTimeout: typeof setTimeout } }).window ??= { setTimeout };

function fixture(productId = 0x33, options: { ignore?: string; stale?: string; light?: number; unsupported?: boolean; truncate?: boolean } = {}) {
  let active = 2, light = options.light ?? 2, attempts = 0;
  const sleeps = [60, 300, 1800];
  const sent: Uint8Array[] = [];
  const device = {
    vendorId: 0x373e, productId, opened: true, collections: [],
    open: async () => {}, close: async () => {},
    sendFeatureReport: async (_id: number, packet: Uint8Array) => {
      const copy = new Uint8Array(packet); sent.push(copy); attempts = 0;
      const key = `${copy[4]}:${copy[5]}`;
      if (key === options.ignore) return;
      if (key === "0:5") active = copy[6];
      if (key === "0:7") sleeps[copy[6] - 1] = (copy[7] << 8) | copy[8];
      if (key === "2:0") light = copy[8];
    },
    receiveFeatureReport: async () => {
      const packet = sent.at(-1)!;
      const key = `${packet[4]}:${packet[5]}`, profile = packet[6];
      let payload = [profile, 0];
      if (key === "0:129") payload = [0, 0, 26, 0];
      if (key === "0:131") payload = [0, 90];
      if (key === "0:133") payload = [active];
      if (key === "1:129") payload = [profile, 1, 3, 32, 3, 32];
      if (["1:130", "1:128", "1:136"].includes(key)) payload = [profile, 1];
      if (key === "0:135") payload = [profile, sleeps[profile - 1] >> 8, sleeps[profile - 1] & 255];
      if (key === "2:128") payload = [1, 0, light, 0, 0, 0];
      if (options.truncate && ["0:135", "2:128"].includes(key)) payload = payload.slice(0, 2);
      if (options.stale === key && attempts++ === 0) payload[0] = key === "2:128" ? 2 : profile === 1 ? 2 : 1;
      const reply = new Uint8Array(64);
      reply[0] = options.unsupported && key === "2:128" ? 0xa2 : 0xa1;
      reply[3] = payload.length; reply[4] = packet[4]; reply[5] = packet[5]; reply.set(payload, 6);
      const buffer = new Uint8Array(70); buffer.set(reply, 3);
      return new DataView(buffer.buffer, 3, 64);
    },
  } as unknown as HIDDevice;
  return { client: new LamzuHidClient(device), device, sent, sleeps };
}

test("sleep codec preserves Never without accepting reserved or malformed values", () => {
  assert.equal(lunafuryEncodeSleep(0), 0xffff);
  assert.equal(lunafuryDecodeSleep(Uint8Array.of(2, 255, 255)), 0);
  assert.equal(lunafuryDecodeSleep(Uint8Array.of(2, 1, 44)), 300);
  for (const payload of [null, Uint8Array.of(2, 0), Uint8Array.of(2, 0, 0), Uint8Array.of(2, 255, 0)]) {
    assert.equal(lunafuryDecodeSleep(payload), null);
  }
  for (const invalid of [-1, 1.5, 65535, NaN, Infinity]) assert.throws(() => lunafuryEncodeSleep(invalid));
});

for (const [pid, target] of [[0x32, 0], [0x33, 2], [0x54, 0], [0x84, 2]] as const) {
  test(`LunaFury ${pid.toString(16)} sets Never and restores the active bank timeout`, async () => {
    const { client, sent, sleeps } = fixture(pid, { stale: "0:135" });
    assert.equal(client.getSleepOptions()[0], 0);
    assert.equal(client.getSleepOptions().at(-1), 1800);
    assert.equal((await client.readStatus()).sleepTimeout, 300);
    assert.equal(await client.setSleepTimeout(0), 0);
    assert.equal((await client.readStatus(true)).sleepTimeout, 0);
    assert.deepEqual(sleeps, [60, 65535, 1800]);
    assert.equal(await client.setSleepTimeout(300), 300);
    const writes = sent.filter((p) => p[4] === 0 && p[5] === 7);
    assert.deepEqual(writes.map((p) => Array.from(p.slice(6, 9))), [[2, 255, 255], [2, 1, 44]]);
    assert.ok(writes.every((p) => p[2] === target && p[3] === 3));
  });
}

for (const [pid, target] of [[0x33, 0], [0x84, 1]] as const) {
  test(`LunaFury ${pid.toString(16)} addresses receiver lighting independently of the bank`, async () => {
    const { client, sent, sleeps } = fixture(pid, { stale: "2:128" });
    assert.equal((await client.readStatus()).lunafury?.receiverLightMode, 2);
    for (const mode of [6, 11, 0, 2] as const) assert.equal(await client.setLunaFuryReceiverLightMode(mode), mode);
    await client.setProfile(3);
    assert.equal((await client.readStatus()).lunafury?.receiverLightMode, 2);
    const packets = sent.filter((p) => p[4] === 2 && (p[5] === 0 || p[5] === 0x80));
    assert.ok(packets.every((p) => p[2] === target && p[3] === 6 && p[6] === 1));
    assert.deepEqual(packets.filter((p) => p[5] === 0).map((p) => Array.from(p.slice(6, 12))),
      [[1, 0, 6, 0, 0, 0], [1, 0, 11, 0, 0, 0], [1, 0, 0, 0, 0, 0], [1, 0, 2, 0, 0, 0]]);
    assert.deepEqual(sleeps, [60, 300, 1800]);
  });
}

test("wired and non-LunaFury devices cannot write receiver lighting or Never", async () => {
  for (const pid of [0x32, 0x54, 0x1d]) {
    const { client, sent } = fixture(pid);
    await assert.rejects(client.setLunaFuryReceiverLightMode(2));
    assert.equal(sent.length, 0);
    if (pid === 0x1d) {
      assert.ok(!client.getSleepOptions().includes(0));
      await assert.rejects(client.setSleepTimeout(0));
    } else {
      assert.equal((await client.readStatus()).lunafury?.receiverLightMode, undefined);
      assert.ok(!sent.some((p) => p[4] === 2 && (p[5] === 0 || p[5] === 0x80)));
    }
  }
});

test("ignored writes are not reported as success", async () => {
  await assert.rejects(fixture(0x33, { ignore: "0:7" }).client.setSleepTimeout(0), /did not confirm/);
  await assert.rejects(fixture(0x33, { ignore: "2:0" }).client.setLunaFuryReceiverLightMode(6), /did not confirm/);
});

test("unknown, unsupported and truncated receiver modes stay hidden and cannot write", async () => {
  for (const options of [{ light: 99 }, { unsupported: true }, { truncate: true }]) {
    const { client, sent } = fixture(0x33, options);
    assert.equal((await client.readStatus()).lunafury?.receiverLightMode, undefined);
    await assert.rejects(client.setLunaFuryReceiverLightMode(6));
    assert.ok(!sent.some((p) => p[4] === 2 && p[5] === 0));
  }
  assert.equal(lunafuryDecodeReceiverLight(Uint8Array.of(2, 0, 2)), undefined);
  assert.throws(() => lunafuryWriteReceiverLight(0x33, 3 as 2));
});

test("sleep edits cannot be split by a profile switch", async () => {
  const { client, sleeps } = fixture();
  await Promise.all([client.setSleepTimeout(0), client.setProfile(3), client.setSleepTimeout(120)]);
  assert.deepEqual(sleeps, [60, 65535, 120]);
});
