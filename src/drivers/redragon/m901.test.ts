import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_M901_MODEL,
  REDRAGON_M901_PRODUCT_ID,
  REDRAGON_REPORT_ID,
  REDRAGON_VENDOR_ID,
  redragonDecodeRead,
  redragonM901EncodeDpi,
} from "@openmouse/protocol/redragon";
import type { MouseLighting } from "@openmouse/protocol/drivers/mouse-types";
import { RedragonHidClient } from "./hid.ts";

const hex = (text: string): number[] => text.match(/../g)!.map((byte) => parseInt(byte, 16));

/** The settings memory read from the M901 on 2026-11-07. */
function dumpedMemory(): Uint8Array {
  const memory = new Uint8Array(0x500);
  const text = readFileSync(new URL("../../../captures/redragon-m901/memory-dump.hex", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{4}): ((?:[0-9a-f]{2} ?){8})$/.exec(line.trim());
    if (match) memory.set(hex(match[2]!.replaceAll(" ", "")), parseInt(match[1]!, 16));
  }
  return memory;
}

/**
 * Settings-memory model of the M901 config channel: the M724 transport with
 * this firmware's answer header, byte 3 = `0x60 + addressHigh`.
 */
class FakeM901 {
  vendorId = REDRAGON_VENDOR_ID;
  productId = REDRAGON_M901_PRODUCT_ID;
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

const client = (fake = new FakeM901()) => new RedragonHidClient(fake as unknown as HIDDevice);

test("the M901 read answer uses 0x60, and the M612/M724 header is rejected", () => {
  const answer = new Uint8Array([0x02, 0x08, 0x32, 0x60, 0x02, 0x00, 0xfa, 0xfa, 0x02, 0x00]);
  assert.deepEqual([...redragonDecodeRead(answer, 0x0032, 2, REDRAGON_M901_MODEL.replyAddressBase)], [0x02, 0x00]);
  assert.throws(() => redragonDecodeRead(answer, 0x0032, 2), /unexpected answer/);
});

test("isSupported needs the Holtek VID, the M901 PID and the config collection", () => {
  assert.equal(RedragonHidClient.isSupported(new FakeM901() as unknown as HIDDevice), true);

  const wrongVendor = new FakeM901();
  wrongVendor.vendorId = 0x1234;
  assert.equal(RedragonHidClient.isSupported(wrongVendor as unknown as HIDDevice), false);

  const wrongProduct = new FakeM901();
  wrongProduct.productId = 0x1111;
  assert.equal(RedragonHidClient.isSupported(wrongProduct as unknown as HIDDevice), false);

  const noConfig = new FakeM901();
  noConfig.collections = [];
  assert.equal(RedragonHidClient.isSupported(noConfig as unknown as HIDDevice), false);
});

test("readStatus reports the M901 and the captured DPI stages and polling", async () => {
  const status = await client().readStatus();
  assert.equal(status.brand, "Redragon");
  assert.equal(status.name, "Redragon M901 Perdition");
  assert.deepEqual(status.dpiStages, [500, 1000, 2000, 3000, 6200]);
  assert.equal(status.dpi, 1000);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.pollingRateHz, 500);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.activeProfile, 2);
  assert.equal(status.profileCount, 5);
});

test("the unverified button and lighting layouts stay out of the status", async () => {
  const status = await client().readStatus();
  assert.equal(status.buttonMappings, undefined);
  assert.equal(status.buttonOptions, undefined);
  assert.equal(status.lighting, undefined);
  await assert.rejects(client().setButtonMapping("Side 1", "Left click"), /no captured button layout/);
  await assert.rejects(client().setLighting({} as MouseLighting), /no captured lighting layout/);
});

test("DPI stages use the 0xCFF table with the M901 name in range errors", async () => {
  assert.deepEqual(redragonM901EncodeDpi(500), { dpi: 500, value: 11, range: 0 });
  assert.deepEqual(redragonM901EncodeDpi(800), { dpi: 800, value: 18, range: 0 });
  assert.throws(() => redragonM901EncodeDpi(100), /Redragon M901 DPI 100 is outside/);

  const fake = new FakeM901();
  assert.equal(await client(fake).setDpiStageValue(0, 800), 800);
  assert.deepEqual([...fake.memory.subarray(0x0104, 0x0109)], [1, 18, 0, 18, 0]);
});

test("a polling write uses the bracket and commit block and reads back", async () => {
  const fake = new FakeM901();
  assert.equal(await client(fake).setPollingRate(500), 500);
  assert.equal(fake.memory[0x34], 2);
  const commits = fake.sent.filter((bytes) => bytes[0] === 0xf1).map((bytes) => bytes[2]);
  assert.deepEqual(commits, [0x04, 0x01, 0x02, 0x08, 0x10]);
  const bracket = fake.sent.find((bytes) => bytes[0] === 0xf5);
  assert.deepEqual(bracket?.slice(0, 2), [0xf5, 0x00]);
});
