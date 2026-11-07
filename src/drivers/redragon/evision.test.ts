import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EVISION_MODEL,
  EVISION_PRODUCT_ID,
  EVISION_VENDOR_ID,
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_REPORT_ID,
  redragonDecodeRead,
  redragonEvisionEncodeDpi,
} from "@openmouse/protocol/redragon";
import type { MouseLighting } from "@openmouse/protocol/drivers/mouse-types";
import { RedragonHidClient } from "./hid.ts";

const hex = (text: string): number[] => text.match(/../g)!.map((byte) => parseInt(byte, 16));

/** The settings memory read from the Evision USB Gaming Mouse on 2026-11-07. */
function dumpedMemory(): Uint8Array {
  const memory = new Uint8Array(0x500);
  const text = readFileSync(new URL("../../../captures/evision-usb-gaming-mouse/memory-dump.hex", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{4}): ((?:[0-9a-f]{2} ?){8})$/.exec(line.trim());
    if (match) memory.set(hex(match[2]!.replaceAll(" ", "")), parseInt(match[1]!, 16));
  }
  return memory;
}

/**
 * Settings-memory model of the Evision config channel. It is the M724's
 * transport with this firmware's answer header: byte 3 is `0x60 + addressHigh`.
 */
class FakeEvision {
  vendorId = EVISION_VENDOR_ID;
  productId = EVISION_PRODUCT_ID;
  productName = "USB Gaming Mouse";
  opened = false;
  collections: HIDCollectionInfo[] = [{
    usagePage: REDRAGON_CONFIG_USAGE_PAGE,
    usage: REDRAGON_CONFIG_USAGE,
    children: [],
    featureReports: [{ reportId: REDRAGON_REPORT_ID, items: [] }],
    inputReports: [],
    outputReports: [],
  }];
  memory = dumpedMemory();
  readonly sent: number[][] = [];
  private inSession = false;
  private pending: number[] | null = null;

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    assert.equal(reportId, REDRAGON_REPORT_ID);
    const bytes = [...new Uint8Array(data as ArrayBuffer)];
    this.sent.push(bytes);
    const [command, lo = 0, hi = 0, length = 0] = bytes;
    const address = lo | (hi << 8);
    if (command === 0xf5) this.inSession = bytes[1] === 0x00;
    else if (command === 0xf3) {
      if (!this.inSession && address !== 0x2c) throw new Error("write outside the F5 bracket");
      this.memory.set(bytes.slice(7, 7 + length), address);
    } else if (command === 0xf2) {
      this.pending = [REDRAGON_REPORT_ID, 0x08, lo, 0x60 + hi, length, 0x00, 0xfa, 0xfa, ...this.memory.slice(address, address + length)];
    } else if (command !== 0xf1) throw new Error(`unexpected command ${command}`);
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    assert.equal(reportId, REDRAGON_REPORT_ID);
    const answer = new Uint8Array(this.pending ?? []);
    this.pending = null;
    return new DataView(answer.buffer);
  }
}

const client = (fake = new FakeEvision()) => new RedragonHidClient(fake as unknown as HIDDevice);

test("a read answer uses the Evision header, and the M724 header is rejected", () => {
  const answer = new Uint8Array([0x02, 0x08, 0x32, 0x60, 0x02, 0x00, 0xfa, 0xfa, 0x02, 0x00]);
  assert.deepEqual([...redragonDecodeRead(answer, 0x0032, 2, EVISION_MODEL.replyAddressBase)], [0x02, 0x00]);
  assert.throws(() => redragonDecodeRead(answer, 0x0032, 2), /unexpected answer/);
});

test("isSupported needs the Holtek VID, the Evision PID and the config collection", () => {
  assert.equal(RedragonHidClient.isSupported(new FakeEvision() as unknown as HIDDevice), true);

  const wrongVendor = new FakeEvision();
  wrongVendor.vendorId = 0x1234;
  assert.equal(RedragonHidClient.isSupported(wrongVendor as unknown as HIDDevice), false);

  const wrongProduct = new FakeEvision();
  wrongProduct.productId = 0x1111;
  assert.equal(RedragonHidClient.isSupported(wrongProduct as unknown as HIDDevice), false);

  const noConfig = new FakeEvision();
  noConfig.collections = [];
  assert.equal(RedragonHidClient.isSupported(noConfig as unknown as HIDDevice), false);
});

test("readStatus reports the Evision brand and the captured DPI stages and polling", async () => {
  const status = await client().readStatus();
  assert.equal(status.brand, "Evision");
  assert.equal(status.name, "Evision USB Gaming Mouse");
  assert.deepEqual(status.dpiStages, [500, 1000, 2000, 3000, 6200]);
  assert.equal(status.dpi, 1000);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.pollingRateHz, 500);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.activeProfile, 2);
  assert.equal(status.profileCount, 5);
});

test("the unattested button and lighting layouts stay out of the status", async () => {
  const status = await client().readStatus();
  assert.equal(status.buttonMappings, undefined);
  assert.equal(status.buttonOptions, undefined);
  assert.equal(status.lighting, undefined);
  await assert.rejects(client().setButtonMapping("Side front", "Left click"), /no captured button layout/);
  await assert.rejects(client().setLighting({} as MouseLighting), /no captured lighting layout/);
});

test("DPI stages use the 0xCFF table with the Evision name in range errors", async () => {
  assert.deepEqual(redragonEvisionEncodeDpi(500), { dpi: 500, value: 11, range: 0 });
  assert.deepEqual(redragonEvisionEncodeDpi(800), { dpi: 800, value: 18, range: 0 });
  assert.throws(() => redragonEvisionEncodeDpi(100), /Evision DPI 100 is outside/);

  const fake = new FakeEvision();
  assert.equal(await client(fake).setDpiStageValue(0, 800), 800);
  assert.deepEqual([...fake.memory.subarray(0x0104, 0x0109)], [1, 18, 0, 18, 0]);
});

test("a polling write uses the bracket and commit block and reads back", async () => {
  const fake = new FakeEvision();
  assert.equal(await client(fake).setPollingRate(500), 500);
  assert.equal(fake.memory[0x34], 2);
  const commits = fake.sent.filter((bytes) => bytes[0] === 0xf1).map((bytes) => bytes[2]);
  assert.deepEqual(commits, [0x04, 0x01, 0x02, 0x08, 0x10]);
  const bracket = fake.sent.find((bytes) => bytes[0] === 0xf5);
  assert.deepEqual(bracket?.slice(0, 2), [0xf5, 0x00]);
});
