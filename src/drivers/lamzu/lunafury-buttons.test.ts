import assert from "node:assert/strict";
import test from "node:test";
import { LamzuHidClient } from "./hid.ts";

(globalThis as { window?: { setTimeout: typeof setTimeout } }).window ??= { setTimeout };

function fixture(productId = 0x33, options: { ignore?: boolean; stale?: boolean; unsupported?: boolean; malformed?: boolean } = {}) {
  let active = 1, reads = 0;
  const banks = Array.from({ length: 3 }, () => new Map<number, number[]>([
    [1, [1, 1, 1]], [2, [1, 1, 2]], [3, [1, 1, 3]], [4, [1, 1, 4]], [5, [16, 3, 1, 2, 3]],
  ]));
  const sent: Uint8Array[] = [];
  const device = {
    vendorId: 0x373e, productId, opened: true, collections: [], open: async () => {}, close: async () => {},
    sendFeatureReport: async (_id: number, packet: Uint8Array) => {
      const p = new Uint8Array(packet); sent.push(p); reads = 0;
      if (p[4] === 0 && p[5] === 5) active = p[6];
      if (p[4] === 3 && p[5] === 0 && !options.ignore) banks[p[6] - 1].set(p[7], Array.from(p.slice(9, 11 + p[10])));
    },
    receiveFeatureReport: async () => {
      const p = sent.at(-1)!, key = `${p[4]}:${p[5]}`, profile = p[6];
      let payload = [profile, 0];
      if (key === "0:129") payload = [0, 0, 26, 0];
      if (key === "0:131") payload = [0, 90];
      if (key === "0:133") payload = [active];
      if (key === "1:129") payload = [profile, 1, 3, 32, 3, 32];
      if (key === "1:130" || key === "1:128" || key === "1:136") payload = [profile, 1];
      if (key === "3:128") payload = [profile, p[7], 0, ...banks[profile - 1].get(p[7])!];
      const reply = new Uint8Array(64); reply[0] = options.unsupported && p[4] === 3 ? 0xa2 : 0xa1;
      reply[3] = payload.length; reply[4] = p[4]; reply[5] = p[5]; reply.set(payload, 6);
      if (key === "3:128" && options.stale) {
        if (reads === 0) reply[6] = profile === 1 ? 2 : 1;
        if (reads === 1) reply[7] = p[7] === 1 ? 2 : 1;
        reads++;
      }
      if (key === "3:128" && options.malformed) reply[10] = 11;
      const offset = new Uint8Array(70); offset.set(reply, 3);
      return new DataView(offset.buffer, 3, 64);
    },
  } as unknown as HIDDevice;
  return { client: new LamzuHidClient(device), sent, banks };
}

for (const [pid, target] of [[0x32, 0], [0x33, 2], [0x54, 0], [0x84, 2]] as const) {
  test(`button mappings ${pid.toString(16)} use the active bank and correct transport target`, async () => {
    const { client, banks, sent } = fixture(pid);
    let status = await client.readStatus();
    assert.deepEqual(status.buttonMappings, { Left: "Left Click", Right: "Right Click", Middle: "Middle Click", Back: "Back", Forward: "Macro:16:1,2,3" });
    assert.deepEqual(status.fixedButtons, ["Left", "Forward"]);
    await client.setProfile(3);
    await client.setButtonMapping("Right", "Keyboard:129:4");
    await client.setButtonMapping("Middle", "DPI Cycle");
    status = await client.readStatus(true);
    assert.equal(status.buttonMappings?.Right, "Keyboard:129:4");
    assert.equal(status.buttonMappings?.Middle, "DPI Cycle");
    assert.deepEqual(banks[0].get(2), [1, 1, 2]);
    assert.deepEqual(banks[2].get(5), [16, 3, 1, 2, 3]);
    const writes = sent.filter((p) => p[4] === 3 && p[5] === 0);
    assert.ok(writes.every((p) => p[2] === target && p[6] === 3));
    assert.deepEqual(Array.from(writes[0].slice(2, 13)), [target, 7, 3, 0, 3, 2, 0, 4, 2, 129, 4]);
  });
}

test("mapping readback ignores stale profile and physical-button replies", async () => {
  const { client } = fixture(0x33, { stale: true });
  assert.equal(await client.setButtonMapping("Back", "Scroll Up"), "Scroll Up");
});

test("ignored mapping writes fail and a later edit still works", async () => {
  const options = { ignore: true }, { client } = fixture(0x33, options);
  await assert.rejects(client.setButtonMapping("Right", "Disabled"), /did not confirm/);
  options.ignore = false;
  assert.equal(await client.setButtonMapping("Right", "Disabled"), "Disabled");
});

test("left, receiver buttons, invalid actions and other CompX brands cannot be written", async () => {
  const { client, sent } = fixture();
  for (const [button, action] of [["Left", "Disabled"], ["Receiver", "Back"], ["Right", "Macro:16:1"]]) {
    await assert.rejects(client.setButtonMapping(button, action));
  }
  assert.equal(sent.length, 0);
  const other = fixture(0x1c);
  await assert.rejects(other.client.setButtonMapping("Right", "Back"), /only available/);
  assert.equal(other.sent.length, 0);
});

test("an existing macro is preserved even when the caller requests a supported replacement", async () => {
  const { client, sent, banks } = fixture();
  await assert.rejects(client.setButtonMapping("Forward", "DPI Up"), /read-only/);
  assert.deepEqual(banks[0].get(5), [16, 3, 1, 2, 3]);
  assert.equal(sent.some((p) => p[4] === 3 && p[5] === 0), false);
});

test("unsupported or malformed mapping reads keep basic settings usable", async () => {
  for (const options of [{ unsupported: true }, { malformed: true }]) {
    const status = await fixture(0x33, options).client.readStatus();
    assert.equal(status.dpi, 800);
    assert.equal(status.buttonMappings, undefined);
    assert.equal(status.buttonOptions, undefined);
  }
});

test("mapping edits cannot be split by a concurrent profile switch", async () => {
  const { client, banks, sent } = fixture();
  await Promise.all([client.setButtonMapping("Back", "Mute"), client.setProfile(2), client.setButtonMapping("Back", "DPI Down")]);
  assert.deepEqual(banks[0].get(4), [5, 2, 0, 226]);
  assert.deepEqual(banks[1].get(4), [7, 1, 2]);
  assert.deepEqual(sent.filter((p) => p[4] === 3 && p[5] === 0).map((p) => p[6]), [1, 2]);
});
