import assert from "node:assert/strict";
import test from "node:test";

import { pulsarVgnEncodeDpi } from "@openmouse/protocol/pulsar";
import { PulsarAresonHidClient } from "./pulsar-areson-hid.ts";
import { PulsarHidClient } from "./pulsar-hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// The X2 Mini's collections as reported in the ticket and the ardor-mouse
// descriptor: commands on feature report 8, answers on input report 9.
function aresonDevice(productId = 0xfa7c) {
  const flash = new Uint8Array(0xc0);
  const checked = (address: number, value: number) => flash.set([value, (0x55 - value) & 0xff], address);
  checked(0, 1); // 1 kHz
  checked(4, 0); // stage 1 active
  checked(10, 1); // 1 mm
  flash.set(pulsarVgnEncodeDpi(800), 12);
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const commands: number[] = [];
  const answer = (request: Uint8Array): Uint8Array => {
    const [command, , high, low, length] = request;
    const address = (high! << 8) | low!;
    const reply = new Uint8Array(16);
    reply.set([command!, 0, high!, low!, length!]);
    if (command === 0x03) reply[5] = 1;
    if (command === 0x04) reply.set([64, 0], 5);
    if (command === 0x08) reply.set(flash.slice(address, address + length!), 5);
    if (command === 0x07) flash.set(request.slice(5, 5 + length!), address);
    return reply;
  };
  const device = {
    vendorId: 0x25a7,
    productId,
    productName: "X2 Mini Wireless",
    opened: false,
    collections: [
      { usagePage: 0xff01, usage: 0, children: [], featureReports: [], inputReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 16 }] }], outputReports: [] },
      { usagePage: 0xff02, usage: 2, children: [], featureReports: [{ reportId: 8, items: [{ reportSize: 8, reportCount: 16 }] }], inputReports: [], outputReports: [] },
    ],
    async open() { device.opened = true; },
    async close() { device.opened = false; },
    addEventListener(_type: string, handler: (event: HIDInputReportEvent) => void) { listener = handler; },
    removeEventListener() { listener = null; },
    async sendFeatureReport(reportId: number, data: Uint8Array) {
      assert.equal(reportId, 8);
      commands.push(data[0]!);
      const reply = answer(new Uint8Array(data));
      setTimeout(() => listener?.({ reportId: 9, data: new DataView(reply.buffer) } as HIDInputReportEvent), 0);
    },
  };
  return { device: device as unknown as HIDDevice, flash, commands };
}

test("claims the Areson-USB X2 that the report-8 Pulsar client rejects", () => {
  const { device } = aresonDevice();
  assert.equal(PulsarAresonHidClient.isSupported(device), true);
  assert.equal(PulsarHidClient.isSupported(device), false);
  assert.equal(PulsarAresonHidClient.isSupported({ ...device, collections: [] } as HIDDevice), false);
});

test("reads status and writes DPI over feature report 8 with answers on input 9", async () => {
  const { device, flash, commands } = aresonDevice();
  const client = new PulsarAresonHidClient(device);

  const status = await client.readStatus();
  assert.equal(status.name, "Pulsar X2 Mini Wireless");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.batteryPercent, 64);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(commands.includes(0x01), false);

  assert.equal(await client.setDpi(1600), 1600);
  assert.deepEqual([...flash.slice(12, 16)], [...pulsarVgnEncodeDpi(1600)]);
  assert.equal(client.getDpiOptions().at(-1), 20_000);
});
