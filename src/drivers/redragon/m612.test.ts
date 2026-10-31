import assert from "node:assert/strict";
import test from "node:test";

import {
  REDRAGON_M612_BUTTON_OPTIONS,
  redragonM612DecodeButtonAction,
  redragonM612EncodeButtonAction,
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_M612_DPI_LABELS,
  REDRAGON_M612_PRODUCT_ID,
  REDRAGON_PRODUCTS,
  REDRAGON_REPORT_ID,
  redragonDecodeRead,
  redragonEncodeRead,
  redragonEncodeWrite,
  redragonM612DecodeDpi,
  redragonM612DpiCodeAt,
  redragonM612EncodeDpi,
  redragonM612SlotAddress,
} from "@openmouse/protocol/redragon";
import { RedragonHidClient } from "./hid.ts";

const hex = (text: string): number[] => text.match(/../g)!.map((byte) => parseInt(byte, 16));

/**
 * The factory settings memory RDCfg 1.0.58 pushes on startup (usbmon
 * capture): every profile holds 500/1000/2000/3000/4000, polling 500 Hz.
 */
function factoryMemory(): Uint8Array {
  const memory = new Uint8Array(0x500);
  // Polling per profile: 0x32 holds profiles 1-3, 0x38 profiles 4-5 (capture lines 18-19).
  memory.set([0x02, 0x00, 0x02, 0x00, 0x02, 0x00], 0x32);
  memory.set([0x02, 0x00, 0x02, 0x00], 0x38);
  for (const base of [0x42, 0x102, 0x1b2, 0x262, 0x312]) {
    [0x0e, 0x1b, 0x35, 0x4f, 0x6a].forEach((value, stage) => {
      memory.set([0x01, value, 0x00, value, 0x00], base + 2 + 6 * stage);
    });
  }
  // Factory button layout (identical in every profile) and lighting.
  const buttons = ["81", "82", "83", "998103", "85", "84", "8a", "89", "9b08", "8b", "8c"];
  for (const base of [0x82, 0x142, 0x1f2, 0x2a2, 0x352]) {
    [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 44].forEach((offset, slot) => memory.set(hex(buttons[slot]!), base + offset));
  }
  memory.set([0x02, 0x00], 0x446);
  memory.set(hex("80ff000005080103"), 0x448);
  memory.set(hex("81ff000002080303"), 0x450);
  memory.set(hex("81ff000002080103"), 0x458);
  memory.set(hex("81ff000004080103"), 0x460);
  memory.set(hex("81ff000001050103"), 0x468);
  return memory;
}

/**
 * Settings-memory model of the M612 config channel, with the answers the
 * hardware gives: `F2` reads answer on the next GET_FEATURE with
 * `[08 lo 32+hi len 00 FA FA data]`; a plain GET answers the 7-byte header.
 * Writes outside the `F5 00` / `F5 01` bracket are rejected, except the
 * profile byte RDCfg's MODE select writes unbracketed.
 */
class FakeM612 {
  vendorId = 0x04d9;
  productId = REDRAGON_M612_PRODUCT_ID;
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
  memory = factoryMemory();
  readonly sent: number[][] = [];
  inSession = false;
  ignoreWrites = false;
  failOnSend: number | null = null;
  private pending: number[] | null = null;

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    assert.equal(reportId, REDRAGON_REPORT_ID);
    const bytes = [...new Uint8Array(data as ArrayBuffer)];
    this.sent.push(bytes);
    if (this.sent.length === this.failOnSend) throw new Error("simulated transport failure");
    const [command, lo = 0, hi = 0, length = 0] = bytes;
    const address = lo | (hi << 8);
    if (command === 0xf5) {
      this.inSession = bytes[1] === 0x00;
    } else if (command === 0xf3) {
      // RDCfg's MODE select writes the profile byte without a bracket.
      if (!this.inSession && address !== 0x2c) throw new Error("write outside the F5 bracket");
      if (!this.ignoreWrites) this.memory.set(bytes.slice(7, 7 + length), address);
    } else if (command === 0xf1) {
      // Commits are accepted either way: RDCfg's MODE select sends them unbracketed.
    } else if (command === 0xf2) {
      this.pending = [REDRAGON_REPORT_ID, 0x08, lo, 0x32 + hi, length, 0x00, 0xfa, 0xfa, ...this.memory.slice(address, address + length)];
    } else {
      throw new Error(`unexpected command ${command}`);
    }
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    assert.equal(reportId, REDRAGON_REPORT_ID);
    const answer = new Uint8Array(this.pending ?? [REDRAGON_REPORT_ID, 0x08, 0x40, 0x32, 0x00, 0x00, 0xfa, 0xfa]);
    this.pending = null;
    return new DataView(answer.buffer);
  }

  /** Writes only, as `[cmd, ...]` hex strings without trailing zeros. */
  writes(): string[] {
    return this.sent
      .filter((bytes) => bytes[0] !== 0xf2)
      .map((bytes) => bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("").replace(/(00)+$/, ""));
  }
}

const asDevice = (fake: FakeM612): HIDDevice => fake as unknown as HIDDevice;
const m612 = (fake = new FakeM612()) => new RedragonHidClient(asDevice(fake));

test("M612 catalog entry and slider table", () => {
  const product = REDRAGON_PRODUCTS.get(0xfc61);
  assert.equal(product?.model, "M612");
  assert.equal(product?.maxDpi, 8000);
  assert.equal(REDRAGON_M612_DPI_LABELS.length, 146);
  for (let index = 1; index < REDRAGON_M612_DPI_LABELS.length; index++) {
    assert.ok(REDRAGON_M612_DPI_LABELS[index]! > REDRAGON_M612_DPI_LABELS[index - 1]!, `label ${index} ascends`);
  }
});

test("slider positions give the codes RDCfg applied (usbmon)", () => {
  const captured: Array<[number, number, 0 | 1, number]> = [
    // position, value, range, RDCfg label
    [0, 0x0e, 0, 500], [1, 0x0f, 0, 570], [2, 0x10, 0, 600], [3, 0x11, 0, 640],
    [4, 0x12, 0, 680], [5, 0x13, 0, 700], [6, 0x14, 0, 760],
    [13, 0x1b, 0, 1000], [39, 0x35, 0, 2000], [65, 0x4f, 0, 3000], [92, 0x6a, 0, 4000],
    [93, 0x36, 1, 4100], [94, 0x37, 1, 4180], [120, 0x51, 1, 6150], [144, 0x69, 1, 7980], [145, 0x6a, 1, 8000],
  ];
  for (const [position, value, range, label] of captured) {
    assert.deepEqual(redragonM612DpiCodeAt(position), { value, range }, `position ${position}`);
    assert.equal(REDRAGON_M612_DPI_LABELS[position], label, `label ${position}`);
    assert.equal(redragonM612DecodeDpi(value, range), label);
    assert.deepEqual(redragonM612EncodeDpi(label), { dpi: label, value, range });
  }
  assert.throws(() => redragonM612DpiCodeAt(146), /outside/);
});

test("DPI requests snap to the nearest slider label", () => {
  assert.equal(redragonM612EncodeDpi(550).dpi, 570);
  assert.equal(redragonM612EncodeDpi(535).dpi, 500, "ties go to the lower label");
  assert.equal(redragonM612EncodeDpi(1234).dpi, 1250);
  assert.equal(redragonM612EncodeDpi(8000).dpi, 8000);
  assert.throws(() => redragonM612EncodeDpi(499), /outside/);
  assert.throws(() => redragonM612EncodeDpi(8001), /outside/);
  assert.throws(() => redragonM612EncodeDpi(1000.5), /outside/);
});

test("codes outside the slider decode on the linear scale", () => {
  assert.equal(redragonM612DecodeDpi(0x0a, 0), 380);
  assert.equal(redragonM612DecodeDpi(0x80, 0), 4830);
  assert.equal(redragonM612DecodeDpi(0x20, 1), 2420);
});

test("write and read frames match the capture", () => {
  assert.deepEqual([...redragonEncodeWrite(0x44, [0x01, 0x0e, 0x00, 0x0e, 0x00])], hex("02f3440005000000010e000e00000000"));
  assert.deepEqual([...redragonEncodeWrite(0x0314, [0x01, 0x6a, 0x00, 0x6a, 0x00])], hex("02f3140305000000016a006a00000000"));
  assert.deepEqual([...redragonEncodeWrite(0x32, [0x08, 0x00, 0x02, 0x00, 0x02, 0x00])], hex("02f33200060000000800020002000000"));
  assert.deepEqual([...redragonEncodeRead(0x0104, 5)], hex("02f20401050000000000000000000000"));
  assert.throws(() => redragonEncodeWrite(0x44, []), /length/);
  assert.throws(() => redragonEncodeRead(0x44, 9), /length/);
  assert.throws(() => redragonEncodeWrite(0x44, [256]), /byte/);
});

test("read answers decode with or without the report id", () => {
  const answer = new Uint8Array(hex("0208043305" + "00fafa" + "010e000e00"));
  assert.deepEqual([...redragonDecodeRead(answer, 0x0104, 5)], [0x01, 0x0e, 0x00, 0x0e, 0x00]);
  assert.deepEqual([...redragonDecodeRead(answer.subarray(1), 0x0104, 5)], [0x01, 0x0e, 0x00, 0x0e, 0x00]);
  assert.throws(() => redragonDecodeRead(answer, 0x0004, 5), /unexpected answer/, "high address byte");
  assert.throws(() => redragonDecodeRead(answer, 0x0104, 6), /unexpected answer/, "length");
  assert.throws(() => redragonDecodeRead(new Uint8Array(hex("0208043305000000010e000e00")), 0x0104, 5), /unexpected answer/, "marker");
  assert.throws(() => redragonDecodeRead(new Uint8Array(hex("02084032000000fafa")), 0x0104, 5), /unexpected answer/, "plain echo");
});

test("slot addresses follow the captured per-profile bases", () => {
  assert.equal(redragonM612SlotAddress(0, 0), 0x44);
  assert.equal(redragonM612SlotAddress(0, 4), 0x5c);
  assert.equal(redragonM612SlotAddress(1, 0), 0x104);
  assert.equal(redragonM612SlotAddress(4, 4), 0x32c);
  assert.throws(() => redragonM612SlotAddress(5, 0), /profile/);
  assert.throws(() => redragonM612SlotAddress(0, 5), /stage/);
});

test("the client picks the model by PID and refuses unknown ones", () => {
  assert.equal(RedragonHidClient.isSupported(asDevice(new FakeM612())), true);
  assert.deepEqual(m612().getDpiOptions(), [...REDRAGON_M612_DPI_LABELS]);
  const unknown = new FakeM612();
  unknown.productId = 0xfc00;
  assert.equal(RedragonHidClient.isSupported(asDevice(unknown)), false);
  assert.throws(() => new RedragonHidClient(asDevice(unknown)), /not a supported/);
});

test("readStatus reports the mouse's own values as verified", async () => {
  const fake = new FakeM612();
  fake.memory[0x42] = 2;
  const status = await m612(fake).readStatus();
  assert.equal(status.name, "Redragon Predator M612");
  assert.deepEqual(status.dpiStages, [500, 1000, 2000, 3000, 4000]);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpi, 2000);
  assert.equal(status.pollingRateHz, 500);
  assert.equal(status.activeProfile, 1);
  assert.equal(status.ui?.valuesVerified, true);
  assert.deepEqual(status.ui?.dpiStageEditor, { maxStages: 5, countEditable: false, minDpi: 500, maxDpi: 8000, stepDpi: 10 });
  assert.equal(status.ui?.statusNote, undefined);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.deepEqual(fake.writes(), [], "reading sends no writes or session frames");
});

test("readStatus follows the active profile", async () => {
  const fake = new FakeM612();
  fake.memory[0x2c] = 3;
  fake.memory[0x262] = 4;
  fake.memory.set([0x01, 0x6a, 0x01, 0x6a, 0x01], 0x262 + 2 + 6 * 4);
  const status = await m612(fake).readStatus();
  assert.equal(status.activeProfile, 4);
  assert.equal(status.activeDpiStage, 4);
  assert.equal(status.dpi, 8000);
});

test("polling follows the active profile up to profile 5 (0x3a)", async () => {
  const fake = new FakeM612();
  fake.memory[0x2c] = 4;
  fake.memory[0x3a] = 0x08;
  assert.equal((await m612(fake).readStatus()).pollingRateHz, 125);
  fake.memory[0x2c] = 3;
  assert.equal((await m612(fake).readStatus()).pollingRateHz, 500, "profile 4 keeps its own byte at 0x38");
});

test("readStatus rejects values the firmware never holds", async () => {
  const badProfile = new FakeM612();
  badProfile.memory[0x2c] = 7;
  await assert.rejects(() => m612(badProfile).readStatus(), /profile 7/);
  const badPoll = new FakeM612();
  badPoll.memory[0x32] = 3;
  await assert.rejects(() => m612(badPoll).readStatus(), /polling code 3/);
});

test("setDpiStageValue writes one slot of the active profile and reads it back", async () => {
  const fake = new FakeM612();
  fake.memory[0x2c] = 1;
  fake.memory[0x102 + 2 + 6] = 0x00; // stage 2 disabled: the enabled byte must survive
  const client = m612(fake);
  assert.equal(await client.setDpiStageValue(1, 1234), 1250);
  assert.deepEqual(fake.writes(), [
    "f5",
    "f30a010500000000210021",
    "f10204", "f10201", "f10202", "f10208", "f10210",
    "f501",
  ]);
  assert.deepEqual([...fake.memory.slice(0x10a, 0x10f)], [0x00, 0x21, 0x00, 0x21, 0x00]);
  assert.deepEqual((await client.readStatus()).dpiStages, [500, 1250, 2000, 3000, 4000]);
});

test("setDpiStageValue validates before touching the mouse", async () => {
  const fake = new FakeM612();
  const client = m612(fake);
  await assert.rejects(() => client.setDpiStageValue(5, 800), /stage/);
  await assert.rejects(() => client.setDpiStageValue(0, 9000), /outside/);
  assert.equal(fake.sent.length, 0);
});

test("setActiveDpiStage moves the active profile's stage pointer", async () => {
  const fake = new FakeM612();
  const client = m612(fake);
  assert.equal(await client.setActiveDpiStage(4), 4);
  assert.deepEqual(fake.writes(), ["f5", "f342000100000004", "f10204", "f10201", "f10202", "f10208", "f10210", "f501"]);
  const status = await client.readStatus();
  assert.equal(status.activeDpiStage, 4);
  assert.equal(status.dpi, 4000);
  await assert.rejects(() => client.setActiveDpiStage(5), /stage/);
});

test("setPollingRate rewrites only the active profile's rate byte", async () => {
  const fake = new FakeM612();
  fake.memory.set([0x02, 0x00, 0x03, 0x00, 0x05, 0x00], 0x32);
  const client = m612(fake);
  assert.equal(await client.setPollingRate(125), 125);
  assert.deepEqual([...fake.memory.slice(0x32, 0x38)], [0x08, 0x00, 0x03, 0x00, 0x05, 0x00]);
  assert.equal((await client.readStatus()).pollingRateHz, 125);
  await assert.rejects(() => client.setPollingRate(2000), /not offered/);
});

test("a write the mouse does not keep is reported, not assumed", async () => {
  const fake = new FakeM612();
  fake.ignoreWrites = true;
  await assert.rejects(() => m612(fake).setPollingRate(1000), /kept 02 00 at 0x32/);
  await assert.rejects(() => m612(fake).setDpiStageValue(0, 800), /kept/);
});

test("a failed write still closes the vendor session", async () => {
  const fake = new FakeM612();
  const client = m612(fake);
  // Reads: profile + slot (2 frames); then F5 00, the slot write fails.
  fake.failOnSend = 4;
  await assert.rejects(() => client.setDpiStageValue(0, 800), /simulated transport failure/);
  assert.deepEqual(fake.sent.at(-1), [0xf5, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(fake.inSession, false);
});

test("button actions encode as captured and every option round-trips", () => {
  const captured: Array<[string, string]> = [
    ["Left click", "81000000"], ["Back", "84000000"], ["Forward", "85000000"], ["Rapid fire", "99810300"],
    ["DPI cycle", "88000000"], ["DPI up", "8a000000"], ["DPI down", "89000000"],
    ["Profile cycle", "8d000000"], ["Profile up", "94000000"], ["Profile down", "95000000"],
    ["Polling rate up", "97000000"], ["Polling rate down", "98000000"],
    ["Lighting effect cycle", "9b080000"], ["Disabled", "00000000"],
    ["Paste (Ctrl+V)", "8f011900"], ["Select all (Ctrl+A)", "8f010400"], ["Find (Ctrl+F)", "8f010900"],
    ["New (Ctrl+N)", "8f011100"], ["Switch window (Alt+Tab)", "8f042b00"], ["Close window (Alt+F4)", "8f043d00"],
    ["File explorer (Win+E)", "8f080800"], ["Run (Win+R)", "8f081500"], ["Show desktop (Win+D)", "8f080700"],
    ["Lock PC (Win+L)", "8f080f00"],
  ];
  for (const [action, bytes] of captured) {
    assert.deepEqual(redragonM612EncodeButtonAction(action), hex(bytes), action);
    assert.equal(redragonM612DecodeButtonAction(hex(bytes)), action);
  }
  assert.deepEqual(redragonM612EncodeButtonAction("Key A"), hex("8f000400"));
  assert.deepEqual(redragonM612EncodeButtonAction("Copy (Ctrl+C)"), hex("8f010600"));
  assert.equal(new Set(REDRAGON_M612_BUTTON_OPTIONS).size, REDRAGON_M612_BUTTON_OPTIONS.length, "options are unique");
  for (const option of REDRAGON_M612_BUTTON_OPTIONS) {
    assert.equal(redragonM612DecodeButtonAction(redragonM612EncodeButtonAction(option)), option);
  }
  assert.equal(redragonM612DecodeButtonAction(hex("8f030400")), "Keys Ctrl+Shift+A");
  assert.equal(redragonM612DecodeButtonAction(hex("a1020000")), "Vendor action (a1 02 00 00)");
  assert.throws(() => redragonM612EncodeButtonAction("Launch rockets"), /not offered/);
});

test("readStatus reports profiles, buttons, and lighting from the mouse", async () => {
  const status = await m612().readStatus();
  assert.equal(status.profileCount, 5);
  assert.equal(status.ui?.showAdvancedSection, true);
  assert.deepEqual(status.buttonMappings, {
    "Left (1)": "Left click", "Right (2)": "Right click", "Wheel click (3)": "Middle click", "Fire (4)": "Rapid fire",
    "Button 5": "Forward", "Button 6": "Back", "Button 7": "DPI up", "Button 8": "DPI down",
    "Button 9": "Lighting effect cycle", "Wheel up": "Scroll up", "Wheel down": "Scroll down",
  });
  assert.deepEqual(status.buttonOptions, [...REDRAGON_M612_BUTTON_OPTIONS]);
  const lighting = status.lighting!;
  assert.equal(lighting.mode, "Breathing random");
  assert.deepEqual(lighting.modes, ["Static", "Breathing single", "Breathing random", "Wave", "Off"]);
  assert.deepEqual(lighting.colorModes, ["Static", "Breathing single"]);
  assert.deepEqual(lighting.reactiveModes, ["Breathing single", "Breathing random", "Wave"]);
  assert.equal(lighting.speed, 1, "wire 08 is the slowest");
  assert.equal(lighting.brightness, 100);
  assert.deepEqual(lighting.brightnessLevels, [33, 67, 100]);
});

test("lighting OFF hides brightness and FLASH is reported as no mode", async () => {
  const off = new FakeM612();
  off.memory[0x446] = 0x20;
  const offLighting = (await m612(off).readStatus()).lighting!;
  assert.equal(offLighting.mode, "Off");
  assert.equal(offLighting.brightnessLevels, undefined);
  const flash = new FakeM612();
  flash.memory[0x446] = 0x08;
  assert.equal((await m612(flash).readStatus()).lighting!.mode, null);
});

test("setProfile replays RDCfg's MODE select and the status follows", async () => {
  const fake = new FakeM612();
  fake.memory[0x1b2 + 2 + 6 * 1] = 0x01;
  fake.memory.set([0x01, 0x21, 0x00, 0x21, 0x00], 0x1b2 + 2 + 6 * 0);
  const client = m612(fake);
  await client.setProfile(3);
  assert.deepEqual(fake.writes(), ["f32c000200000002", "f10201", "f10204", "f10201", "f10202", "f10208", "f10210"]);
  const status = await client.readStatus();
  assert.equal(status.activeProfile, 3);
  assert.equal(status.dpiStages![0], 1250);
  await assert.rejects(() => client.setProfile(0), /outside/);
  await assert.rejects(() => client.setProfile(6), /outside/);
});

test("setButtonMapping writes the active profile's slot and reads it back", async () => {
  const fake = new FakeM612();
  fake.memory[0x2c] = 1;
  const client = m612(fake);
  await client.setButtonMapping("Button 5", "Copy (Ctrl+C)");
  assert.deepEqual(fake.writes(), ["f5", "f35201040000008f0106", "f10204", "f10201", "f10202", "f10208", "f10210", "f501"]);
  assert.equal((await client.readStatus()).buttonMappings!["Button 5"], "Copy (Ctrl+C)");
  await client.setButtonMapping("Wheel down", "Key Page Down");
  assert.deepEqual([...fake.memory.slice(0x16e, 0x172)], [0x8f, 0x00, 0x4e, 0x00]);
  await assert.rejects(() => client.setButtonMapping("Button 12", "Back"), /no button/);
  await assert.rejects(() => client.setButtonMapping("Button 5", "Teleport"), /not offered/);
});

test("the last left click cannot be remapped away", async () => {
  const fake = new FakeM612();
  const client = m612(fake);
  await assert.rejects(() => client.setButtonMapping("Left (1)", "Back"), /Keep Left click/);
  assert.deepEqual(fake.writes(), []);
  await client.setButtonMapping("Button 6", "Left click");
  await client.setButtonMapping("Left (1)", "Back");
  const mappings = (await client.readStatus()).buttonMappings!;
  assert.equal(mappings["Left (1)"], "Back");
  assert.equal(mappings["Button 6"], "Left click");
});

test("setLighting writes the effect block and selector in one session", async () => {
  const fake = new FakeM612();
  const client = m612(fake);
  const shown = (await client.readStatus()).lighting!;
  // Effect change only: Static keeps its own stored red and brightness.
  await client.setLighting({ ...shown, mode: "Static" });
  assert.deepEqual(fake.writes(), ["f5", "f368040800000081ff000001050103", "f346040200000010", "f10204", "f10201", "f10202", "f10208", "f10210", "f501"]);
  let lighting = (await client.readStatus()).lighting!;
  assert.equal(lighting.mode, "Static");
  assert.equal(lighting.color, "#ff0000");
  // Colour and brightness on Static.
  await client.setLighting({ ...lighting, color: "#00ff80", brightness: 33 });
  assert.deepEqual([...fake.memory.slice(0x468, 0x470)], hex("8100ff8001050101"));
  // Speed on an animated effect: UI 8 (fastest) is wire 01.
  lighting = (await client.readStatus()).lighting!;
  await client.setLighting({ ...lighting, mode: "Wave", speed: 8 });
  assert.equal(fake.memory[0x446], 0x01);
  assert.equal(fake.memory[0x448 + 5], 0x01);
  // Off writes only the selector.
  lighting = (await client.readStatus()).lighting!;
  const before = fake.sent.length;
  await client.setLighting({ ...lighting, mode: "Off" });
  assert.ok(fake.writes().slice(-8).includes("f346040200000020"));
  assert.ok(fake.sent.length > before);
  assert.equal((await client.readStatus()).lighting!.mode, "Off");
});

test("setLighting rejects what the mouse cannot show", async () => {
  const client = m612();
  const shown = (await client.readStatus()).lighting!;
  await assert.rejects(() => client.setLighting({ ...shown, mode: "Spectrum" }), /no "Spectrum"/);
  await assert.rejects(() => client.setLighting({ ...shown, mode: null }), /no "null"/);
  await assert.rejects(() => client.setLighting({ ...shown, speed: 9 }), /speed/);
  await assert.rejects(() => client.setLighting({ ...shown, brightness: 50 }), /brightness/);
  await assert.rejects(() => client.setLighting({ ...shown, mode: "Static", color: "red" }), /#rrggbb/);
});
