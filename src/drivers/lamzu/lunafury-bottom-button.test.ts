import assert from "node:assert/strict";
import test from "node:test";
import { LamzuHidClient } from "./hid.ts";
import { lunafuryDecodeBottomButton, lunafuryReadBottomButton, lunafuryWriteBottomButton } from "../../lamzu/lunafury-power.ts";

(globalThis as { window?: { setTimeout: typeof setTimeout } }).window ??= { setTimeout };

type Options = { ignore?: boolean; stale?: "profile" | "button"; unsupported?: boolean; raw?: number[]; truncate?: boolean };
function fixture(productId = 0x33, options: Options = {}) {
  let active = 2, reads = 0;
  const banks = [[0x15, 1], [7, 1, 6], [0x15, 1]];
  const sent: Uint8Array[] = [];
  const device = {
    vendorId: 0x373e, productId, opened: true, collections: [], open: async () => {}, close: async () => {},
    sendFeatureReport: async (_id: number, packet: Uint8Array) => {
      const p = new Uint8Array(packet); sent.push(p); reads = 0;
      if (p[4] === 0 && p[5] === 5) active = p[6];
      if (p[4] === 3 && p[5] === 0 && p[7] === 0x14 && !options.ignore) {
        banks[p[6] - 1] = Array.from(p.slice(9, 6 + p[3]));
      }
    },
    receiveFeatureReport: async () => {
      const p = sent.at(-1)!, key = `${p[4]}:${p[5]}`, profile = p[6];
      const bottom = key === "3:128" && p[7] === 0x14;
      let payload = [profile, 0];
      if (key === "0:129") payload = [0, 0, 26, 0];
      if (key === "0:131") payload = [0, 90];
      if (key === "0:133") payload = [active];
      if (key === "1:129") payload = [profile, 1, 3, 32, 3, 32];
      if (["1:130", "1:128", "1:136"].includes(key)) payload = [profile, 1];
      if (key === "3:128") payload = bottom
        ? [profile, 0x14, 0, ...(options.raw ?? banks[profile - 1])]
        : [profile, p[7], 0, ...(p[7] === 5 ? [16, 3, 1, 2, 3] : [1, 1, p[7]])];
      if (bottom && options.truncate) payload = payload.slice(0, 4);
      if (bottom && options.stale && reads++ === 0) {
        if (options.stale === "profile") payload[0] = profile === 1 ? 2 : 1;
        else payload[1] = 1;
      }
      const reply = new Uint8Array(64);
      reply[0] = bottom && options.unsupported ? 0xa2 : 0xa1;
      reply[3] = payload.length; reply[4] = p[4]; reply[5] = p[5]; reply.set(payload, 6);
      const offset = new Uint8Array(70); offset.set(reply, 3);
      return new DataView(offset.buffer, 3, 64);
    },
  } as unknown as HIDDevice;
  return { client: new LamzuHidClient(device), sent, banks };
}

test("bottom-button requests preserve both official layouts and reject invalid input", () => {
  assert.deepEqual(lunafuryReadBottomButton(3), { target: 2, page: 3, command: 128, length: 6, args: [3, 20] });
  assert.deepEqual(lunafuryWriteBottomButton(2, 1), { target: 2, page: 3, command: 0, length: 5, args: [2, 20, 0, 21, 1] });
  assert.deepEqual(lunafuryWriteBottomButton(2, 2), { target: 2, page: 3, command: 0, length: 6, args: [2, 20, 0, 7, 1, 6] });
  assert.equal(lunafuryDecodeBottomButton(Uint8Array.of(2, 20, 0, 21, 1), 2), 1);
  assert.equal(lunafuryDecodeBottomButton(Uint8Array.of(2, 20, 0, 21, 1, 0), 2), 1);
  assert.equal(lunafuryDecodeBottomButton(Uint8Array.of(2, 20, 0, 7, 1, 6), 2), 2);
  for (const mode of [0, 3, 1.5, NaN]) assert.throws(() => lunafuryWriteBottomButton(2, mode as 1));
  for (const profile of [0, 4, 1.5, NaN]) assert.throws(() => lunafuryReadBottomButton(profile));
  for (const payload of [null, [2, 20, 0, 7, 1], [1, 20, 0, 7, 1, 6], [2, 4, 0, 21, 1],
    [2, 20, 1, 21, 1], [2, 20, 0, 21, 2], [2, 20, 0, 21, 1, 7], [2, 20, 0, 7, 1, 2], [2, 20, 0, 7, 1, 6, 1]]) {
    assert.equal(lunafuryDecodeBottomButton(payload ? Uint8Array.from(payload) : null, 2), undefined);
  }
});

for (const [pid, target] of [[0x32, 0], [0x33, 2], [0x54, 0], [0x84, 2]] as const) {
  test(`bottom-button mode ${pid.toString(16)} reads, writes and restores only the active bank`, async () => {
    const { client, sent, banks } = fixture(pid, { stale: "profile" });
    const status = await client.readStatus();
    assert.equal(status.lunafury?.bottomButtonMode, 2);
    assert.equal(status.buttonMappings?.Forward, "Macro:16:1,2,3");
    assert.equal(await client.setLunaFuryBottomButtonMode(1), 1);
    assert.equal((await client.readStatus(true)).lunafury?.bottomButtonMode, 1);
    assert.equal(await client.setLunaFuryBottomButtonMode(2), 2);
    assert.deepEqual(banks, [[21, 1], [7, 1, 6], [21, 1]]);
    const writes = sent.filter((p) => p[4] === 3 && p[5] === 0);
    assert.deepEqual(writes.map((p) => Array.from(p.slice(2, 6 + p[3]))),
      [[target, 5, 3, 0, 2, 20, 0, 21, 1], [target, 6, 3, 0, 2, 20, 0, 7, 1, 6]]);
    assert.ok(sent.filter((p) => p[4] === 3 && p[5] === 128 && p[7] === 20).every((p) => p[3] === 6 && p[8] === 0));
  });
}

test("stale ordinary-button replies cannot confirm a bottom-button operation", async () => {
  const { client } = fixture(0x33, { stale: "button" });
  assert.equal((await client.readStatus()).lunafury?.bottomButtonMode, 2);
  assert.equal(await client.setLunaFuryBottomButtonMode(1), 1);
});

test("unsupported or unfamiliar bottom bindings are hidden and never overwritten", async () => {
  for (const options of [{ unsupported: true }, { truncate: true }, { raw: [16, 1, 7] }, { raw: [7, 1, 2] }]) {
    const { client, sent } = fixture(0x33, options);
    assert.equal((await client.readStatus()).lunafury?.bottomButtonMode, undefined);
    await assert.rejects(client.setLunaFuryBottomButtonMode(1));
    assert.equal(sent.some((p) => p[4] === 3 && p[5] === 0), false);
  }
});

test("ignored bottom-button writes do not report success", async () => {
  await assert.rejects(fixture(0x33, { ignore: true }).client.setLunaFuryBottomButtonMode(1), /did not confirm/);
});

test("bottom edits cannot be split by an onboard profile switch", async () => {
  const { client, banks } = fixture();
  await Promise.all([client.setLunaFuryBottomButtonMode(1), client.setProfile(3), client.setLunaFuryBottomButtonMode(2)]);
  assert.deepEqual(banks, [[21, 1], [21, 1], [7, 1, 6]]);
});

test("invalid modes and other brands cannot issue bottom-button requests", async () => {
  const { client, sent } = fixture();
  await assert.rejects(client.setLunaFuryBottomButtonMode(0 as 1));
  assert.equal(sent.length, 0);
  const other = fixture(0x1d);
  await assert.rejects(other.client.setLunaFuryBottomButtonMode(1));
  assert.equal(other.sent.length, 0);
});
