import assert from "node:assert/strict";
import { test } from "node:test";
import { isKeychronConfigurableReceiver, KeychronReceiverControls } from "./receiver-hid.ts";

function receiver() {
  const requests: Array<{ report: number; bytes: number[] }> = [];
  const buttons = new Map<number, number[]>();
  let light = [1, 255, 153, 10, 20, 30];
  let keepWrite = true;
  const client = new KeychronReceiverControls(async (report, length, bytes, match) => {
    requests.push({ report, bytes });
    const reply = new Uint8Array(length);
    if (bytes[0] === 2) reply.set([2, 6, 0, 0x34, 0x34, 0x5a, 0xd0, 0x23, 1]);
    else if (bytes[0] === 0x31) { reply.set([0x31, bytes[1]!, 0]); reply.set(buttons.get(bytes[1]!) ?? [0], 3); }
    else if (bytes[0] === 0x30) {
      if (keepWrite) buttons.set(bytes[1]!, bytes.slice(3));
      reply.set([0xe4, 0, 0x30]);
    } else if (bytes[0] === 0x20) { reply.set([0x20, 0, 0, 0, ...light]); }
    else throw new Error("Unexpected receiver request");
    assert.equal(match(reply), true);
    return reply;
  }, async (report, bytes) => {
    requests.push({ report, bytes: Array.from(bytes) });
    assert.equal(report, 0xb5); assert.deepEqual(Array.from(bytes.slice(0, 2)), [0x24, 0]);
    if (keepWrite) light = Array.from(bytes.slice(2, 8));
  });
  return { client, requests, buttons, rejectReadback: () => { keepWrite = false; } };
}

test("only the described TurboLink receiver exposes its own configuration", () => {
  assert.equal(isKeychronConfigurableReceiver({ vendorId: 0x3434, productId: 0xd05a } as HIDDevice), true);
  assert.equal(isKeychronConfigurableReceiver({ vendorId: 0x3434, productId: 0xd086 } as HIDDevice), false);
  assert.equal(isKeychronConfigurableReceiver({ vendorId: 0x3434, productId: 0xd028 } as HIDDevice), false);
});

test("receiver buttons use 0x30/0x31, preserve unknown assignments, and verify readback", async () => {
  const { client, requests, buttons, rejectReadback } = receiver();
  const state = await client.readStatus();
  assert.equal(Object.keys(state.buttonMappings).length, 4);
  assert.equal(state.firmware, "v1.2.3");
  await client.setButtonMapping("Switch type", "Magnetic (both)");
  assert.deepEqual(buttons.get(2)?.slice(0, 4), [15, 3, 204, 2]);
  await client.setButtonMapping("Polling", "DPI Loop");
  assert.equal((await client.readStatus()).buttonMappings.Polling, "DPI Loop");
  assert.equal(requests.some(r => r.bytes[0] === 0x52 || r.bytes[0] === 0x62 || r.bytes[0] === 0x65), false);
  buttons.set(1, [14, 99]);
  assert.equal((await client.readStatus()).buttonMappings.Lighting, "Custom");
  rejectReadback();
  await assert.rejects(() => client.setButtonMapping("Polling", "Disabled"), /did not keep/);
});

test("receiver lighting writes its target byte and verifies its separate read format", async () => {
  const { client, requests, rejectReadback } = receiver();
  const lighting = (await client.readStatus()).lighting;
  const next = { ...lighting, brightness: 50, speed: 2, color: "#20a080" };
  assert.deepEqual(await client.setLighting(next), next);
  const write = requests.find(r => r.bytes[0] === 0x24)!;
  assert.deepEqual(write.bytes.slice(0, 8), [0x24, 0, 1, 128, 102, 32, 160, 128]);
  rejectReadback();
  await assert.rejects(() => client.setLighting({ ...next, brightness: 100 }), /did not keep/);
});

test("receiver key combinations use keyboard records and retain modifiers on readback", async () => {
  const { client, buttons, rejectReadback } = receiver();
  await client.setButtonMapping("Polling", "Keyboard: Ctrl+Shift+A");
  assert.deepEqual(buttons.get(0)?.slice(0, 4), [2, 3, 4, 0]);
  assert.equal((await client.readStatus()).buttonMappings.Polling, "Keyboard: Ctrl+Shift+A");
  await client.setButtonMapping("Polling", "Keyboard: Shift+Ctrl+A");
  assert.equal((await client.readStatus()).buttonMappings.Polling, "Keyboard: Ctrl+Shift+A");
  await client.setButtonMapping("Lighting", "Keyboard: Win+F12");
  assert.deepEqual(buttons.get(1)?.slice(0, 3), [2, 8, 69]);
  await assert.rejects(() => client.setButtonMapping("Polling", "Keyboard: Ctrl+Unknown"), /Unknown/);
  rejectReadback();
  await assert.rejects(() => client.setButtonMapping("Polling", "Keyboard: Alt+Tab"), /did not keep/);
});

test("receiver lighting verifies the encoded defaults and still rejects a retained old value", async () => {
  const { client, rejectReadback } = receiver();
  const lighting = (await client.readStatus()).lighting;
  const confirmed = await client.setLighting({ ...lighting, brightness: undefined, speed: null, color: null });
  assert.equal(confirmed.brightness, 100);
  assert.equal(confirmed.speed, 5);
  assert.equal(confirmed.color, "#ffffff");
  const uppercase = await client.setLighting({ ...confirmed, color: "#ABCDEF" });
  assert.equal(uppercase.color, "#abcdef");
  rejectReadback();
  await assert.rejects(client.setLighting({ ...uppercase, brightness: 25 }), /did not keep/);
});
