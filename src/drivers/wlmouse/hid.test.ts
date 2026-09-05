import assert from "node:assert/strict";
import test from "node:test";

import { WLMouseHidClient } from "./hid.ts";
import { VENDOR_ID } from "../vendors.ts";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout } };
globals.window ??= { setTimeout };

function fakeDevice(offset: number, sleepingReplies = 0, activeProfile = 1) {
  const sent: Uint8Array[] = [];
  let liftOff = 0x01;
  let debounce = 0x00;
  let stages = [{ x: 1600, y: 1600 }];
  let activeStage = 1;
  let angleTuning = 0x00;
  let buttonCombination = 0x00;
  const device = {
    vendorId: VENDOR_ID.wlmouse,
    productId: 0xa863,
    productName: "Huan",
    opened: true,
    collections: [],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => void sent.push(new Uint8Array(data)),
    receiveFeatureReport: async () => {
      const request = sent[sent.length - 1];
      const reply = new Uint8Array(64);
      if (sent.length <= sleepingReplies) {
        reply[offset] = 0xa0;
        return new DataView(reply.buffer);
      }
      const target = request[2];
      const page = request[4];
      const command = request[5];
      if (page === 0x01 && command === 0x14) angleTuning = request[7]!;
      if (page === 0x03 && command === 0x01) buttonCombination = request[7]!;
      if (page === 0x01 && command === 0x08) liftOff = request[7]!;
      if (page === 0x00 && command === 0x08) debounce = request[7]!;
      if (page === 0x01 && command === 0x02) activeStage = request[7]!;
      if (page === 0x01 && command === 0x01) {
        stages = Array.from({ length: request[7]! }, (_, index) => ({
          x: (request[8 + index * 4]! << 8) | request[9 + index * 4]!,
          y: (request[10 + index * 4]! << 8) | request[11 + index * 4]!,
        }));
      }
      const payload = target === 0x01 && command === 0x8b
        ? [0x00, 0x00, 0x00, 0x00, 0xa8, 0x80]
        : page === 0x01 && command === 0x94
          ? [0x01, angleTuning]
          : page === 0x03 && command === 0x81
            ? [0x01, buttonCombination]
            : page === 0x00 && command === 0x85
        ? [activeProfile, 0x00]
        : page === 0x01 && command === 0x88
          ? [0x01, liftOff]
          : page === 0x00 && command === 0x88
            ? [0x01, debounce]
            : page === 0x01 && command === 0x81
              ? [0x01, stages.length, ...stages.flatMap(({ x, y }) =>
                [x >> 8 & 0xff, x & 0xff, y >> 8 & 0xff, y & 0xff])]
              : page === 0x01 && command === 0x82
                ? [0x01, activeStage]
                : [0x01, 0x01];
      reply[offset] = 0xa1;
      reply[3 + offset] = payload.length;
      reply[4 + offset] = page;
      reply[5 + offset] = command;
      reply.set(payload, 6 + offset);
      return new DataView(reply.buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

for (const offset of [0, 1]) {
  test(`a reply shifted by ${offset} byte(s) is decoded`, async () => {
    const status = await new WLMouseHidClient(fakeDevice(offset).device).readStatus();
    assert.equal(status.dpi, 1600);
  });
}

test("a sleeping mouse gets the command re-sent", async () => {
  const { device, sent } = fakeDevice(1, 2);
  await new WLMouseHidClient(device).readStatus();
  assert.ok(sent.length > 3, `expected re-sends while asleep, saw ${sent.length}`);
});

test("profile-scoped commands address the reported active profile", async () => {
  const { device, sent } = fakeDevice(0, 0, 2);
  const client = new WLMouseHidClient(device);

  const status = await client.readStatus();
  assert.equal(status.activeProfile, 2);

  await client.setDpi(1600);
  await client.setLiftOffDistance("Low");
  await client.setAngleSnapping(true);
  await client.setDebounceTime(4);

  const isProfileScoped = (packet: Uint8Array): boolean =>
    packet[4] === 0x01 || (packet[4] === 0x00 && (packet[5] === 0x87 || packet[5] === 0x88));
  const scoped = sent.filter(isProfileScoped);
  assert.ok(scoped.length > 0, "expected profile-scoped commands");
  assert.ok(scoped.every((packet) => packet[6] === 0x02),
    `expected every profile-scoped command to address profile 2, saw:\n`
    + scoped.map((packet) => [...packet.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ")).join("\n"));
});

test("the DPI stage table round-trips through the shared stage editor", async () => {
  const client = new WLMouseHidClient(fakeDevice(0).device);
  const before = await client.readStatus();
  assert.deepEqual(before.dpiStages, [1600]);
  assert.equal(before.activeDpiStage, 0);
  assert.equal(before.ui?.dpiStageEditor?.maxStages, 6);

  assert.equal(await client.setDpiStageCount(3), 3);
  assert.equal(await client.setDpiStageValue(2, 3200), 3200);
  assert.equal(await client.setActiveDpiStage(2), 2);

  const after = await client.readStatus();
  assert.deepEqual(after.dpiStages, [1600, 1600, 3200]);
  assert.equal(after.activeDpiStage, 2);
  assert.equal(after.dpi, 3200);
});

test("editing one stage leaves a separate Y axis alone", async () => {
  const { device, sent } = fakeDevice(0);
  const client = new WLMouseHidClient(device);
  await client.readStatus();
  await client.setDpi(1600, 800);

  await client.setDpiStageValue(0, 3200);

  const written = sent.filter((packet) => packet[4] === 0x01 && packet[5] === 0x01).at(-1)!;
  assert.equal((written[8]! << 8) | written[9]!, 3200, "X should follow the edit");
  assert.equal((written[10]! << 8) | written[11]!, 800, "Y should be left where it was");
});

test("a rejected stage count is reported, not silently kept", async () => {
  const client = new WLMouseHidClient(fakeDevice(0).device);
  await client.readStatus();
  await assert.rejects(() => client.setDpiStageCount(7), /between 1 and 6/);
  await assert.rejects(() => client.setDpiStageValue(0, 1601), /not a supported DPI value/);
  await assert.rejects(() => client.setActiveDpiStage(4), /does not have a DPI stage 5/);
});

test("a negative sensor angle survives the round trip as two's complement", async () => {
  const { device, sent } = fakeDevice(0);
  const client = new WLMouseHidClient(device);
  await client.readStatus();

  assert.equal(await client.setAngleTuning(-12), -12);
  const written = sent.filter((packet) => packet[4] === 0x01 && packet[5] === 0x14).at(-1)!;
  assert.equal(written[7], 0xf4, "-12 should go out as 0xf4");

  assert.equal(await client.setAngleTuning(12), 12);
  assert.equal((await client.readStatus()).angleTuning, 12);
  await assert.rejects(() => client.setAngleTuning(31), /between -30 and 30/);
});

test("button combinations are written on the button page, not the profile page", async () => {
  const { device, sent } = fakeDevice(0);
  const client = new WLMouseHidClient(device);
  await client.readStatus();

  assert.equal(await client.setButtonCombination(true), true);
  const written = sent.filter((packet) => packet[5] === 0x01 && packet[4] === 0x03).at(-1);
  assert.ok(written, "expected a write on page 0x03");
  assert.equal(written![6], 0x01, "the profile still addresses the packet");
  assert.equal((await client.readStatus()).buttonCombination, true);
});

test("a mouse behind the shared receiver is named after the mouse", async () => {
  const { device } = fakeDevice(0);
  // The 1K receiver enumerates under its own product id whatever it is paired with.
  (device as { productId: number }).productId = 0xa882;
  (device as { productName: string }).productName = "WLmouse 1K receiver";
  const status = await new WLMouseHidClient(device).readStatus();
  assert.equal(status.name, "WLmouse Beast Max");
});
