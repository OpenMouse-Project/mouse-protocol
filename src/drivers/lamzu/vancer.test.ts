import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LamzuHidClient } from "./hid.ts";
import { AttackSharkHidClient } from "../attackshark/hid.ts";
import { DEVICE_DRIVERS, deviceBrand } from "../registry.ts";
import { LAMZU_PRODUCTS, LAMZU_VENDOR_ID, VANCER_PRODUCT_IDS } from "@openmouse/protocol/lamzu";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout } };
globals.window ??= { setTimeout };

interface Capture { trace: { request: string; reply: string }[] }
const bytes = (hex: string) => Uint8Array.from(hex.split(" "), (byte) => parseInt(byte, 16));
const loadCapture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../captures/vancer-akitsu-medium/${name}.json`, import.meta.url), "utf8",
)) as Capture;
const wired = loadCapture("wired");
const receiver = loadCapture("receiver");

/**
 * Answers every read with the payload the Akitsu Medium returned on hardware
 * (captures/vancer-akitsu-medium/). Writes replace the payload the matching
 * read returns, and commands the capture never saw are refused. Replies are
 * keyed by target too: through the receiver, target 0x00 is the dongle.
 */
function fakeAkitsu(productId = 0x0066, capture = wired) {
  const sent: Uint8Array[] = [];
  const payloads = new Map<string, number[]>();
  const key = (packet: Uint8Array, command = packet[5]!) => `${packet[2]}:${packet[4]}:${command}`;
  for (const { reply } of capture.trace) {
    const packet = bytes(reply);
    payloads.set(key(packet), [...packet.slice(6, 6 + packet[3]!)]);
  }
  const device = {
    vendorId: LAMZU_VENDOR_ID, productId, productName: "Vancer Akitsu Mouse", opened: true,
    collections: [{ usagePage: 0xffff, usage: 0, type: 1, children: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      inputReports: [], outputReports: [] }],
    open: async () => {}, close: async () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    sendFeatureReport: async (id: number, packet: Uint8Array) => {
      assert.equal(id, 0);
      sent.push(new Uint8Array(packet));
      const command = packet[5]!;
      if (command < 0x80) payloads.set(key(packet, command | 0x80), [...packet.slice(6, 6 + packet[3]!)]);
    },
    receiveFeatureReport: async () => {
      const packet = sent.at(-1)!;
      const reply = new Uint8Array(64);
      const payload = packet[5]! < 0x80 ? [] : payloads.get(key(packet));
      reply[0] = payload ? 0xa1 : 0xa2;
      reply[2] = packet[2]!; reply[4] = packet[4]!; reply[5] = packet[5]!;
      reply[3] = payload?.length ?? 0;
      reply.set(payload ?? [], 6);
      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

test("the Vancer catalog holds the Akitsu Medium cable and 8K receiver", () => {
  assert.deepEqual([...VANCER_PRODUCT_IDS], [0x0066, 0x0067]);
  for (const productId of VANCER_PRODUCT_IDS) assert.equal(LAMZU_PRODUCTS.get(productId)?.brand, "Vancer");
});

test("every Akitsu runs on the CompX driver, not the Attack Shark one", () => {
  for (const productId of VANCER_PRODUCT_IDS) {
    const { device } = fakeAkitsu(productId);
    assert.equal(AttackSharkHidClient.isSupported(device), false);
    assert.deepEqual(DEVICE_DRIVERS.filter((driver) => driver.supports(device)).map((driver) => driver.brand), ["Lamzu"]);
    assert.equal(deviceBrand(new LamzuHidClient(device)), "Vancer");
  }
});

test("the Akitsu Medium cable capture replays into the settings the mouse held", async () => {
  const { device, sent } = fakeAkitsu();
  const client = new LamzuHidClient(device);
  const status = await client.readStatus();

  assert.deepEqual(sent.map((packet) => [...packet]), wired.trace.map(({ request }) => [...bytes(request)]));
  assert.equal(status.brand, "Vancer");
  assert.equal(status.name, "Vancer Akitsu Medium 3950");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.firmware, ["Mouse 7.2"]);
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.activeProfile, 1);
  assert.equal(status.dpi, 2400);
  assert.equal(status.dpiY, 2400);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [500, 1000]);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.supportedLiftOffDistances, undefined);
  assert.equal(status.debounceMs, 12);
  assert.equal(status.sleepTimeout, 300);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.motionSync, true);
  assert.equal(status.performanceMode, true);
  assert.equal(status.rippleControl, true);
  assert.equal(client.getDpiOptions().at(-1), 30000);
  assert.equal(client.maxDpiStages(), 5);
  assert.deepEqual(client.getSleepOptions(), Array.from({ length: 30 }, (_, index) => (index + 1) * 60));
});

test("controls Arbiter's app does not offer are neither read nor offered", async () => {
  const { device, sent } = fakeAkitsu();
  const client = new LamzuHidClient(device);
  const status = await client.readStatus();

  assert.equal(status.supportsSeparateDpiAxes, false);
  assert.equal(status.hyperMode, null);
  assert.ok(!sent.some((packet) => packet[4] === 0x01 && (packet[5] === 0x8d || packet[5] === 0x8b)));
  const count = sent.length;
  await assert.rejects(client.setHyperMode(true), /does not offer Hyper mode/);
  assert.equal(sent.length, count);
});

test("Akitsu writes use the CompX encodings and are confirmed by read-back", async () => {
  const { device, sent } = fakeAkitsu();
  const client = new LamzuHidClient(device);
  await client.readStatus();
  const writes = () => sent.filter((packet) => packet[5]! < 0x80).map((packet) => [...packet.slice(2, 10)]);

  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setDpi(2450), 2450);
  assert.equal(await client.setLiftOffDistance("Medium"), "Medium");
  assert.equal(await client.setPerformanceMode(false), false);
  assert.deepEqual(writes(), [
    [0x02, 0x02, 0x01, 0x00, 0x01, 0x02, 0x00, 0x00],
    [0x02, 0x06, 0x01, 0x01, 0x01, 0x01, 0x09, 0x92],
    [0x02, 0x02, 0x01, 0x08, 0x01, 0x01, 0x00, 0x00],
    [0x02, 0x02, 0x01, 0x13, 0x01, 0x00, 0x00, 0x00],
  ]);
  await assert.rejects(client.setPollingRate(2000), /does not support 2000 Hz/);
});

test("the Akitsu Medium receiver capture replays into the mouse and dongle settings", async () => {
  const { device, sent } = fakeAkitsu(0x0067, receiver);
  const client = new LamzuHidClient(device);
  const status = await client.readStatus();

  assert.deepEqual(sent.map((packet) => [...packet]), receiver.trace.map(({ request }) => [...bytes(request)]));
  assert.equal(status.name, "Vancer Akitsu Medium 3950");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "2.4 GHz receiver");
  assert.deepEqual(status.firmware, ["Mouse 7.2", "Dongle 7.0"]);
  assert.equal(status.dpi, 2400);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [500, 1000, 2000, 4000, 8000]);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.performanceMode, true);
  // Only the dongle firmware read goes to the receiver; the rest reach the mouse.
  assert.deepEqual(sent.filter((packet) => packet[2] === 0x00).map((packet) => [packet[4], packet[5]]), [[0x00, 0x81]]);
});

test("the Akitsu receiver writes every 8K rate with the CompX codes", async () => {
  const { device, sent } = fakeAkitsu(0x0067, receiver);
  const client = new LamzuHidClient(device);
  await client.readStatus();

  for (const rate of [500, 2000, 4000, 8000, 1000]) assert.equal(await client.setPollingRate(rate), rate);
  const writes = sent.filter((packet) => packet[4] === 0x01 && packet[5] === 0x00);
  assert.ok(writes.every((packet) => packet[2] === 0x02 && packet[6] === 0x01));
  assert.deepEqual(writes.map((packet) => packet[7]), [0x02, 0x20, 0x40, 0x80, 0x01]);
});
