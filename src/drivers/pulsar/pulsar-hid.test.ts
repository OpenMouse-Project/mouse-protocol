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
function flashDevice({
  vendorId = 0x3710, productId = 0x0001, productName = "Pulsar 8K Dongle", cid = 0, mid = 0,
} = {}): HIDDevice & { flash: Uint8Array } {
  const flash = new Uint8Array(256);
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const fake = {
    ...device(vendorId, productId),
    productName,
    flash,
    opened: true,
    addEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => { listener = fn; },
    removeEventListener: () => { listener = null; },
    async sendReport(_: number, data: BufferSource) {
      const packet = new Uint8Array(data as Uint8Array);
      const reply = new Uint8Array(16);
      reply.set(packet.subarray(0, 5));
      reply[1] = 0;
      if (packet[0] === PULSAR_COMMAND.encryptionData) {
        reply[9] = cid;
        reply[10] = mid;
      }
      const address = (packet[2]! << 8) | packet[3]!;
      if (packet[0] === PULSAR_COMMAND.deviceOnline) reply[5] = 1;
      if (packet[0] === PULSAR_COMMAND.readFlashData) reply.set(flash.subarray(address, address + packet[4]!), 5);
      if (packet[0] === PULSAR_COMMAND.writeFlashData) flash.set(packet.subarray(5, 5 + packet[4]!), address);
      queueMicrotask(() => listener?.({ reportId: 8, data: new DataView(reply.buffer) } as HIDInputReportEvent));
    },
  };
  return fake as unknown as HIDDevice & { flash: Uint8Array };
}

test("resolves model names and preserves product-name and generic fallbacks", async () => {
  for (const { options, expected } of [
    { options: { productId: 0x5406, cid: 0x57, mid: 0x14 }, expected: "Pulsar X3 CrazyLight Mini" },
    { options: { productId: 0x5406, cid: 0x57, mid: 0x11 }, expected: "Pulsar Xlite CrazyLight Mini" },
    { options: { productId: 0x5406, cid: 0x57, mid: 0x12 }, expected: "Pulsar Xlite CrazyLight Mini" },
    { options: { productId: 0x5406, cid: 0x57, mid: 0x22 }, expected: "Pulsar Xlite CrazyLight Medium" },
    { options: { productId: 0x5406, cid: 0x57, mid: 0x47 }, expected: "Pulsar Xlite CrazyLight Medium" },
    { options: { productId: 0x5406, cid: 0x57, mid: 0x48 }, expected: "Pulsar X3 CrazyLight Medium" },
    { options: { productId: 0x5406, cid: 0x57, mid: 0x15 }, expected: "Pulsar X3 LHD CrazyLight Mini" },
    { options: { productId: 0x5406 }, expected: "Pulsar CrazyLight 8K Dongle" },
    { options: { productId: 0x5406, cid: 0x58, mid: 0x14 }, expected: "Pulsar CrazyLight 8K Dongle" },
    { options: { productId: 0x5406, cid: 0x57, mid: 0xff }, expected: "Pulsar CrazyLight 8K Dongle" },
    { options: { productId: 0x5403, cid: 0x57, mid: 0x04 }, expected: "Pulsar X2 CrazyLight Mini" },
    { options: { productId: 0x3414, cid: 0x57, mid: 0x14 }, expected: "Pulsar X3 CrazyLight Mini" },
    { options: { productId: 0x5403 }, expected: "Pulsar 8K Dongle" },
    { options: { vendorId: 0x3554, productId: 0x5406 }, expected: "Pulsar 8K Dongle" },
    { options: { vendorId: 0x3554, cid: 0x57, mid: 0x04 }, expected: "Pulsar 8K Dongle" },
    { options: { cid: 0x57, mid: 0xff }, expected: "Pulsar 8K Dongle" },
    { options: { cid: 0x58, mid: 0x04 }, expected: "Pulsar 8K Dongle" },
    { options: { productName: "Pulsar X2 Wireless" }, expected: "Pulsar X2 Wireless" },
    { options: { productName: "" }, expected: "Pulsar Mouse" },
  ]) {
    const status = await new PulsarHidClient(flashDevice(options)).readStatus();
    assert.equal(status.name, expected, JSON.stringify(options));
  }
});

test("names other Pulsar families and editions from the handshake on wired and receiver PIDs", async () => {
  for (const productId of [0x3506, 0x5406]) {
    for (const [mid, name] of [
      [0x07, "Pulsar TenZ Signature Edition"],
      [0x17, "Pulsar X2H CrazyLight Mini"],
      [0x19, "Pulsar X2N CrazyLight Mini"],
      [0x1f, "Pulsar X2A Medium Pulsar By You XS-1"],
      [0x24, "Pulsar Lab. X2F"],
      [0x26, "Pulsar JV-X Pro Series"],
      [0x2d, "Pulsar X VSPO! Asumi Sena"],
      [0x44, "Pulsar ZywOo The Chosen Mouse Gen.2"],
      [0x65, "Pulsar Feinmann F01 Noctua Edition"],
      [0x6b, "Pulsar TenZ 2.0 Mini Misty Blue"],
      [0x6d, "Pulsar X2 CrazyLight Medium Forest"],
      [0x93, "Pulsar X2 CrazyLight 2 Medium 2026 PRX Edition"],
    ] satisfies [number, string][]) {
      const fake = flashDevice({ productId, cid: 0x57, mid });
      assert.equal(PulsarHidClient.isSupported(fake), true);
      assert.equal((await new PulsarHidClient(fake).readStatus()).name, name);
    }
  }
});

test("unnamed vendor placeholders and out-of-range MIDs retain the fallback", async () => {
  for (const mid of [0x00, 0x6c, 0x6f, 0x89, 0x95, 0x96, 0xff]) {
    const fake = flashDevice({ productId: 0x5406, cid: 0x57, mid });
    assert.equal((await new PulsarHidClient(fake).readStatus()).name, "Pulsar CrazyLight 8K Dongle");
  }
});

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
