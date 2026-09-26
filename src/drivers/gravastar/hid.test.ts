import assert from "node:assert/strict";
import test from "node:test";

import { PULSAR_FLASH as FLASH } from "@openmouse/protocol/pulsar";
import { teevolutionEncodeDpi } from "@openmouse/protocol/teevolution";
import { PulsarHidClient } from "../pulsar/pulsar-hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";
import { GravaStarHidClient } from "./hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

/** Answers the report-8 protocol from an in-memory flash; CID 18 like cfg.json. */
class FakeGravaStar {
  vendorId = 0x3554;
  opened = false;
  productName = "Mercury M1 Pro";
  collections = [{
    usagePage: 0xff00,
    usage: 1,
    children: [],
    featureReports: [],
    inputReports: [{ reportId: 8, items: [{ reportCount: 16, reportSize: 8 }] }],
    outputReports: [{ reportId: 8, items: [{ reportCount: 16, reportSize: 8 }] }],
  }];
  flash = new Uint8Array(256);
  writtenAddresses: number[] = [];
  private listener: ((event: unknown) => void) | null = null;

  constructor(readonly mid: number, readonly productId = 0xf54b) {
    this.flash[FLASH.reportRate] = 1;
    this.flash.set(teevolutionEncodeDpi(mid >= 3 ? 32000 : 800), FLASH.dpiValues);
    this.flash[FLASH.liftOffDistance] = 1;
    this.flash[FLASH.sleepTime] = 6;
    this.flash[FLASH.performanceTime] = 6;
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(_type: string, listener: (event: unknown) => void) { this.listener = listener; }
  removeEventListener() { this.listener = null; }

  async sendReport(_reportId: number, data: BufferSource) {
    const packet = new Uint8Array(data as Uint8Array);
    const address = (packet[2]! << 8) | packet[3]!;
    const length = packet[4]!;
    const reply = new Uint8Array(16);
    reply[0] = packet[0]!;
    if (packet[0] === 0x01) reply.set([18, this.mid, 1], 9);
    if (packet[0] === 0x03) reply[5] = 1;
    if (packet[0] === 0x07) {
      this.flash.set(packet.slice(5, 5 + length), address);
      this.writtenAddresses.push(address);
    }
    if (packet[0] === 0x08) reply.set(this.flash.slice(address, address + length), 5);
    queueMicrotask(() => this.listener?.({ reportId: 8, data: new DataView(reply.buffer) }));
  }
}

const asDevice = (fake: FakeGravaStar) => fake as unknown as HIDDevice;

test("claims GravaStar ids ahead of the Pulsar report-8 client", () => {
  const mouse = asDevice(new FakeGravaStar(1));
  assert.equal(GravaStarHidClient.isSupported(mouse), true);
  assert.equal(GravaStarHidClient.isSupported(asDevice(new FakeGravaStar(1, 0x0002))), false);
  const client = createSupportedClient(mouse);
  assert.ok(client instanceof GravaStarHidClient);
  assert.equal(deviceBrand(client), "GravaStar");
  assert.ok(createSupportedClient(asDevice(new FakeGravaStar(1, 0x0002))) instanceof PulsarHidClient);
});

test("PAW3395 models stop at 26,000 DPI and offer only 1 mm / 2 mm LOD", async () => {
  const client = new GravaStarHidClient(asDevice(new FakeGravaStar(1)));
  const status = await client.readStatus();
  assert.equal(status.brand, "GravaStar");
  assert.equal(status.dpi, 800);
  assert.deepEqual(status.supportedLiftOffDistances, ["Medium", "High"]);
  assert.equal(client.getDpiOptions().at(-1), 26000);
  await assert.rejects(client.setLiftOffDistance("Low"));
});

test("PAW3950 models decode the x2 range and sleep writes leave byte 183 alone", async () => {
  const fake = new FakeGravaStar(3);
  const client = new GravaStarHidClient(asDevice(fake));
  const status = await client.readStatus();
  assert.equal(status.dpi, 32000);
  assert.equal(status.sleepTimeout, 60);
  assert.equal(client.getDpiOptions().at(-1), 32000);
  assert.equal(await client.setDpi(30100), 30100);
  assert.equal(await client.setSleepTimeout(180), 180);
  assert.equal(fake.flash[FLASH.sleepTime], 18);
  assert.equal(fake.flash[FLASH.performanceTime], 6);
  assert.ok(!fake.writtenAddresses.includes(FLASH.performanceTime));
});
