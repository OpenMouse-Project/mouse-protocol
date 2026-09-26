import assert from "node:assert/strict";
import test from "node:test";

import { PulsarHidClient } from "./pulsar-hid.ts";
import { PULSAR_COMMAND } from "@openmouse/protocol/pulsar";
import { TEEVOLUTION_KEY_CLASS as KEY, teevolutionEncodeKeyFunction } from "@openmouse/protocol/teevolution";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

function device(vendorId: number, productId: number, reportId = 0x08): HIDDevice {
  return {
    vendorId,
    productId,
    productName: "Pulsar Mouse",
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      children: [],
      featureReports: [],
      inputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
      outputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

test("supports Pulsar receivers on the native vendor id", () => {
  assert.equal(PulsarHidClient.isSupported(device(0x3710, 0x0001)), true);
});

test("supports the Pulsar 4K Wireless Receiver on the shared VGN vendor id", () => {
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0x0002)), true);
});

test("does not claim product ids owned by the Teevolution and VGN drivers", () => {
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0xf520)), false);
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0xfb56)), false);
  assert.equal(PulsarHidClient.isSupported(device(0x3554, 0xf58f)), false);
});

test("rejects devices without the report-8 control collection", () => {
  const wrong = device(0x3554, 0x0002, 0x09);
  assert.equal(PulsarHidClient.isSupported(wrong), false);
});

/** Answers report 8 from a flash image, enough for a write and its read-back. */
function flashDevice(): HIDDevice & { flash: Uint8Array } {
  const flash = new Uint8Array(256);
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const fake = {
    ...device(0x3710, 0x0001),
    flash,
    opened: true,
    addEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => { listener = fn; },
    removeEventListener: () => { listener = null; },
    async sendReport(_: number, data: BufferSource) {
      const packet = new Uint8Array(data as Uint8Array);
      const reply = new Uint8Array(16);
      reply.set(packet.subarray(0, 5));
      const address = (packet[2]! << 8) | packet[3]!;
      if (packet[0] === PULSAR_COMMAND.deviceOnline) reply[5] = 1;
      if (packet[0] === PULSAR_COMMAND.readFlashData) reply.set(flash.subarray(address, address + packet[4]!), 5);
      if (packet[0] === PULSAR_COMMAND.writeFlashData) flash.set(packet.subarray(5, 5 + packet[4]!), address);
      queueMicrotask(() => listener?.({ reportId: 8, data: new DataView(reply.buffer) } as HIDInputReportEvent));
    },
  };
  return fake as unknown as HIDDevice & { flash: Uint8Array };
}

test("setButtonMapping writes one key record at 96 + 4 * slot", async () => {
  const fake = flashDevice();
  [[KEY.mouse, 0x0100], [KEY.mouse, 0x0200], [KEY.mouse, 0x0400], [KEY.mouse, 0x0800], [KEY.mouse, 0x1000], [KEY.dpi, 0x0100]]
    .forEach(([cls, param], index) => fake.flash.set(teevolutionEncodeKeyFunction(cls!, param!), 96 + index * 4));
  const client = new PulsarHidClient(fake);
  await client.open();
  await client.setButtonMapping("DPI", "Middle Click");
  assert.deepEqual([...fake.flash.subarray(116, 120)], [...teevolutionEncodeKeyFunction(KEY.mouse, 0x0400)]);
  await assert.rejects(() => client.setButtonMapping("Left", "Backward"), /Left Click/);
});
