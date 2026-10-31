import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_M724_DPI_LABELS,
  REDRAGON_M724_MODEL,
  REDRAGON_REPORT_ID,
  redragonM724DecodeDpi,
  redragonM724EncodeDpi,
} from "@openmouse/protocol/redragon";
import { RedragonHidClient } from "./hid.ts";

const hex = (text: string): number[] => text.match(/../g)!.map((byte) => parseInt(byte, 16));

/** The settings memory read from a real M724 (captures/redragon-m724/memory-dump.hex). */
function dumpedMemory(): Uint8Array {
  const memory = new Uint8Array(0x500);
  const text = readFileSync(new URL("../../../captures/redragon-m724/memory-dump.hex", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{4}): ((?:[0-9a-f]{2} ?){8})$/.exec(line.trim());
    if (match) memory.set(hex(match[2]!.replaceAll(" ", "")), parseInt(match[1]!, 16));
  }
  return memory;
}

/**
 * Settings-memory model of the M724 config channel: `F2` reads answer on
 * the next GET_FEATURE; writes need the `F5` bracket, except the profile
 * byte RDCfg's MODE select writes unbracketed.
 */
class FakeM724 {
  vendorId = 0x04d9;
  productId = 0xfc7a;
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
      this.pending = [REDRAGON_REPORT_ID, 0x08, lo, 0x32 + hi, length, 0x00, 0xfa, 0xfa, ...this.memory.slice(address, address + length)];
    } else if (command !== 0xf1) throw new Error(`unexpected command ${command}`);
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    assert.equal(reportId, REDRAGON_REPORT_ID);
    const answer = new Uint8Array(this.pending ?? [REDRAGON_REPORT_ID, 0x08, 0x40, 0x32, 0x00, 0x00, 0xfa, 0xfa]);
    this.pending = null;
    return new DataView(answer.buffer);
  }

  /** Writes only, as hex strings without trailing zeros. */
  writes(): string[] {
    return this.sent
      .filter((bytes) => bytes[0] !== 0xf2)
      .map((bytes) => bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("").replace(/(00)+$/, ""));
  }
}

const COMMIT_BLOCK = ["f10204", "f10201", "f10202", "f10208", "f10210"];
const k1ng = (fake = new FakeM724()) => new RedragonHidClient(fake as unknown as HIDDevice);

test("DPI slider labels and codes match RDCfg's 0xCFF table and the factory push", () => {
  assert.equal(REDRAGON_M724_DPI_LABELS.length, 92);
  assert.equal(REDRAGON_M724_DPI_LABELS[0], 200);
  assert.equal(REDRAGON_M724_DPI_LABELS.at(-1), 12400);
  // Factory D1-D5 (slider 11/23/34/54/92) and the 800 / 1600 DPI writes tested on hardware.
  const known: Array<[number, number, 0 | 1]> = [
    [1200, 0x1b, 0], [2400, 0x36, 0], [3500, 0x4f, 0], [5500, 0x7c, 0], [12400, 0x8c, 1],
    [800, 0x12, 0], [1600, 0x24, 0], [6200, 0x8c, 0], [6400, 0x48, 1],
  ];
  for (const [dpi, value, range] of known) {
    assert.deepEqual(redragonM724EncodeDpi(dpi), { dpi, value, range }, `${dpi} DPI`);
    assert.equal(redragonM724DecodeDpi(value, range), dpi);
  }
  for (const label of REDRAGON_M724_DPI_LABELS) {
    const code = redragonM724EncodeDpi(label);
    assert.equal(redragonM724DecodeDpi(code.value, code.range), label);
  }
});

test("DPI requests snap to the slider and stay inside it", () => {
  assert.equal(redragonM724EncodeDpi(1250).dpi, 1200, "ties go to the lower label");
  assert.equal(redragonM724EncodeDpi(6300).dpi, 6200);
  assert.equal(redragonM724EncodeDpi(6500).dpi, 6400);
  assert.throws(() => redragonM724EncodeDpi(100), /outside 200-12400/);
  assert.throws(() => redragonM724EncodeDpi(12401), /outside/);
  assert.equal(redragonM724DecodeDpi(0x80, 0), 5690, "codes RDCfg never writes use the linear scale");
});

test("isSupported needs the Holtek VID, the M724 PID, and the config collection", () => {
  assert.equal(RedragonHidClient.isSupported(new FakeM724() as unknown as HIDDevice), true);
  const mouseOnly = new FakeM724();
  mouseOnly.collections = [{ usagePage: 0x01, usage: 0x02, children: [], featureReports: [], inputReports: [], outputReports: [] }];
  assert.equal(RedragonHidClient.isSupported(mouseOnly as unknown as HIDDevice), false);
});

test("readStatus reads the dumped mouse: profile 1, its stages, rainbow, lift-off", async () => {
  const fake = new FakeM724();
  const status = await k1ng(fake).readStatus();
  assert.equal(status.name, "Redragon K1NG 1K");
  assert.equal(status.activeProfile, 1);
  assert.deepEqual(status.dpiStages, [800, 1200, 2200, 2400, 2800]);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.ui?.valuesVerified, true);
  assert.deepEqual(status.ui?.dpiStageEditor, { maxStages: 5, countEditable: false, minDpi: 200, maxDpi: 12400, stepDpi: 100 });
  assert.deepEqual(status.buttonMappings, {
    Left: "Left click", Right: "Right click", "Wheel click": "Middle click", "Side front": "Forward", "Side rear": "Back",
    "DPI button": "DPI cycle", "Profile button": "Profile cycle", "Wheel up": "Scroll up", "Wheel down": "Scroll down",
  });
  const lighting = status.lighting!;
  assert.equal(lighting.mode, "Spectrum");
  assert.equal(lighting.speed, 8, "wire 01 is the fastest");
  assert.equal(lighting.brightness, 100);
  assert.deepEqual(lighting.colorModes, ["Static", "Breathing single", "Single Flash"]);
  assert.equal(status.liftOffDistance, "Low");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.deepEqual(fake.writes(), [], "reading sends no writes");
});

test("readStatus follows the active profile: factory table and red breathing", async () => {
  const fake = new FakeM724();
  fake.memory[0x2c] = 1;
  const status = await k1ng(fake).readStatus();
  assert.equal(status.activeProfile, 2);
  assert.deepEqual(status.dpiStages, [1200, 2400, 3500, 5500, 12400]);
  assert.equal(status.dpi, 2400, "factory profile 2 starts on stage 2");
  assert.equal(status.lighting!.mode, "Breathing single");
  assert.equal(status.lighting!.color, "#ff0000");
  assert.equal(status.lighting!.speed, 5);
  assert.equal(status.lighting!.brightness, 67);
});

test("setDpiStageValue writes the slot tested on hardware and reads it back", async () => {
  const fake = new FakeM724();
  const client = k1ng(fake);
  assert.equal(await client.setDpiStageValue(0, 1600), 1600);
  assert.deepEqual(fake.writes(), ["f5", "f344000500000001240024", ...COMMIT_BLOCK, "f501"]);
  await client.setDpiStageValue(1, 12400);
  assert.deepEqual([...fake.memory.slice(0x4a, 0x4f)], [0x00, 0x8c, 0x01, 0x8c, 0x01], "the disabled stage stays disabled");
});

test("setProfile sends the profile byte with the full commit block", async () => {
  const fake = new FakeM724();
  const client = k1ng(fake);
  await client.setProfile(2);
  assert.deepEqual(fake.writes(), ["f32c000200000001", "f10201", ...COMMIT_BLOCK]);
  assert.equal((await client.readStatus()).activeProfile, 2);
});

test("active stage and polling follow the active profile", async () => {
  const fake = new FakeM724();
  fake.memory[0x2c] = 1;
  const client = k1ng(fake);
  await client.setActiveDpiStage(3);
  assert.equal(fake.memory[0x102], 3);
  await client.setPollingRate(125);
  assert.deepEqual([...fake.memory.slice(0x32, 0x36)], [0x01, 0x00, 0x08, 0x00], "profile 1 keeps 1000 Hz");
  const status = await client.readStatus();
  assert.equal(status.dpi, 5500);
  assert.equal(status.pollingRateHz, 125);
});

test("setLighting rewrites the active profile's block", async () => {
  const fake = new FakeM724();
  const client = k1ng(fake);
  const shown = (await client.readStatus()).lighting!;
  await client.setLighting({ ...shown, mode: "Static", color: "#00ff00", brightness: 100 });
  assert.deepEqual([...fake.memory.slice(0x448, 0x450)], hex("8000ff0001010103"));
  await client.setLighting({ ...shown, mode: "Breathing random", speed: 1 });
  assert.deepEqual([...fake.memory.slice(0x448, 0x450)], hex("8000ff0002080303"), "colour kept, kind 3, slowest speed");
  await client.setLighting({ ...shown, mode: "Off" });
  const off = (await client.readStatus()).lighting!;
  assert.equal(off.mode, "Off");
  assert.equal(off.brightnessLevels, undefined);
  assert.deepEqual([...fake.memory.slice(0x450, 0x458)], hex("80ff000002040102"), "other profiles untouched");
  await assert.rejects(() => client.setLighting({ ...shown, mode: "Reactive" }), /no "Reactive"/);
});

test("buttons: M724 lighting cycle and media codes, RDCfg single keys decode", async () => {
  const codec = REDRAGON_M724_MODEL.buttons;
  assert.deepEqual(codec.encode("Lighting effect cycle"), hex("9b040000"));
  assert.deepEqual(codec.encode("Volume up"), hex("8e01e900"));
  assert.deepEqual(codec.encode("Paste (Ctrl+V)"), hex("8f011900"));
  assert.deepEqual(codec.encode("Key A"), hex("90000400"));
  assert.equal(codec.decode(hex("8f000400")), "Keys A", "the M612 form still reads");
  assert.equal(new Set(codec.options).size, codec.options.length, "options are unique");
  for (const option of codec.options) assert.equal(codec.decode(codec.encode(option)), option);
  const fake = new FakeM724();
  const client = k1ng(fake);
  await client.setButtonMapping("Side front", "Key A");
  assert.deepEqual([...fake.memory.slice(0x8e, 0x92)], hex("90000400"), "as RDCfg's SINGLE KEY, tested on hardware");
  await client.setButtonMapping("Wheel down", "Volume down");
  assert.deepEqual([...fake.memory.slice(0xae, 0xb2)], hex("8e01ea00"));
  await assert.rejects(() => client.setButtonMapping("Button 9", "Back"), /no button/);
});

test("setLiftOffDistance writes 0x2a and reads it back", async () => {
  const fake = new FakeM724();
  const client = k1ng(fake);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.deepEqual(fake.writes(), ["f5", "f32a000200000002", ...COMMIT_BLOCK, "f501"]);
  assert.equal((await client.readStatus()).liftOffDistance, "High");
});
