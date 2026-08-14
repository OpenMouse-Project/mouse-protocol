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
      const page = request[4];
      const command = request[5];
      if (page === 0x01 && command === 0x08) liftOff = request[7]!;
      if (page === 0x00 && command === 0x08) debounce = request[7]!;
      const payload = page === 0x00 && command === 0x85
        ? [activeProfile, 0x00]
        : page === 0x01 && command === 0x88
          ? [0x01, liftOff]
          : page === 0x00 && command === 0x88
            ? [0x01, debounce]
            : page === 0x01 && command === 0x81
              ? [0x01, 0x01, 0x06, 0x40, 0x06, 0x40]
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
