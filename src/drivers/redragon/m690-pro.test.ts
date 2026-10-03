import assert from "node:assert/strict";
import test from "node:test";

import {
  REDRAGON_M690_PRO_BLOCK_REPORT_ID,
  REDRAGON_M690_PRO_BUTTONS_LENGTH,
  REDRAGON_M690_PRO_BUTTONS_TRAILER,
  REDRAGON_M690_PRO_COMMAND_REPORT_ID,
  REDRAGON_M690_PRO_CONFIG_LENGTH,
  REDRAGON_M690_PRO_DPI_LABELS,
  REDRAGON_M690_PRO_EFFECT_STEADY,
  REDRAGON_M690_PRO_EFFECT_STREAMING,
  REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID,
  REDRAGON_M690_PRO_USAGE,
  REDRAGON_M690_PRO_USAGE_PAGE,
  REDRAGON_M690_PRO_VENDOR_ID,
  REDRAGON_M690_PRO_WIRED_PRODUCT_ID,
  redragonM690ProDecodeButtonAction,
  redragonM690ProDecodeButtons,
  redragonM690ProDecodeConfig,
  redragonM690ProDecodeIdentity,
  redragonM690ProDecodeLink,
  redragonM690ProDecodeStatus,
  redragonM690ProEncodeBlockWrite,
  redragonM690ProEncodeButtonAction,
  redragonM690ProNearestDpi,
  redragonM690ProWithButtonAction,
  redragonM690ProWithLighting,
  redragonM690ProWithPollingRate,
  redragonM690ProWithStageColor,
  redragonM690ProWithStageDpi,
} from "@openmouse/protocol/redragon";
import type { MouseLighting } from "../mouse-types.ts";
import { RedragonM690ProHidClient } from "./m690-pro-hid.ts";

const bytes = (text: string): Uint8Array => Uint8Array.from(text.replace(/\s+/g, "").match(/../g)!.map((byte) => parseInt(byte, 16)));

/**
 * A cable settings block (firmware 2.95) as the vendor app read it at startup
 * (`05 11` -> report 8, 154 bytes): 125 Hz, stage 3 of 5 active,
 * 500/1000/2000/3000/8000 DPI, every stage indicator 00 00 40, Steady
 * lighting at brightness 0.
 */
const CABLE_CONFIG = bytes(`
  081100000000000064130135000200040008000c001800000000000000000000
  00000000000000000000000000000040000040000040000040000040ff460000
  ffffffffff02000100ff0000000700000000ff000000ffffff0000ffffff8000
  ff00ff02020000000000ff000000ffffff0000ffffff8000ff00ffff0000ff00
  00ff00000200ff00fa036a424202ff000000000102ff0000a500`);

/** The same mouse's button block (`05 12`): factory assignments. */
const CABLE_BUTTONS = bytes(`
  0812000000000000110100001102000011040000110800001110000041010000
  4102000031013203500400005001000050010000500100005001000050010000
  500100005001000050010000500100005001000050010000`);

/** The first 154 bytes of the app's polling 125 -> 500 Hz write; the rest of the 520 is zero. */
const POLLING_500_WRITE = bytes(`
  081100920000000064130335000200040008000c001800000000000000000000
  00000000000000000000000000000040000040000040000040000040ff460000
  ffffffffff02000100ff0000000700000000ff000000ffffff0000ffffff8000
  ff00ff02020000000000ff000000ffffff0000ffffff8000ff00ffff0000ff00
  00ff00000200ff00fa036a424202ff000000000102ff0000a500`);

function padded(prefix: Uint8Array): Uint8Array {
  const frame = new Uint8Array(520);
  frame.set(prefix);
  return frame;
}

test("decodes the captured cable settings block", () => {
  const config = redragonM690ProDecodeConfig(CABLE_CONFIG);
  assert.equal(config.pollingHz, 125);
  assert.equal(config.stageCount, 5);
  assert.equal(config.activeStage, 2);
  assert.deepEqual(config.stages, [500, 1000, 2000, 3000, 8000]);
  assert.deepEqual(config.stageColors[0], { r: 0, g: 0, b: 0x40 });
  assert.equal(config.lighting.effect, REDRAGON_M690_PRO_EFFECT_STEADY);
  assert.deepEqual(config.lighting.steady, { brightness: 0, slot: 0 });
  assert.deepEqual(config.lighting.steadyColors[1], { r: 0, g: 0xff, b: 0 });
});

/**
 * The receiver bank of a factory-fresh unit, as the vendor app first read
 * it: the factory settings (the same values the app's Restore writes).
 */
const FACTORY_RECEIVER_CONFIG = bytes(`
  082100000000000064130115000200040008000c001800000000000000000000
  00000000000000000000000000ff00000000ff00ff00ff00ffffff00ff460000
  ffffffffff01420140ff00004207ff000000ff000000ffffff0000ffffff8000
  ff00ff020200ff000000ff000000ffffff0000ffffff8000ff00ffff0000ff00
  00ff00000200ff00fa036a424202ff000000000102ff0000a500`);

test("decodes a factory-fresh receiver bank", () => {
  const config = redragonM690ProDecodeConfig(FACTORY_RECEIVER_CONFIG);
  assert.equal(config.pollingHz, 125);
  assert.equal(config.activeStage, 0);
  assert.deepEqual(config.stages, [500, 1000, 2000, 3000, 8000]);
  assert.deepEqual(config.stageColors, [
    { r: 0xff, g: 0, b: 0 }, { r: 0, g: 0, b: 0xff }, { r: 0, g: 0xff, b: 0 },
    { r: 0xff, g: 0, b: 0xff }, { r: 0xff, g: 0xff, b: 0 },
  ]);
  assert.equal(config.lighting.effect, REDRAGON_M690_PRO_EFFECT_STREAMING);
  assert.deepEqual(config.lighting.streaming, { brightness: 4, speed: 2 });
  assert.deepEqual(config.lighting.steady, { brightness: 4, slot: 0 });
  assert.deepEqual(config.lighting.steadyColors[0], { r: 0xff, g: 0, b: 0 });
  assert.deepEqual(config.lighting.breathing, { brightness: 4, speed: 2 });
});

test("re-encodes the app's polling write byte for byte", () => {
  const frame = redragonM690ProEncodeBlockWrite(redragonM690ProWithPollingRate(CABLE_CONFIG, 500), REDRAGON_M690_PRO_CONFIG_LENGTH);
  assert.deepEqual(frame, padded(POLLING_500_WRITE));
});

test("re-encodes the app's unchanged button write, trailer included", () => {
  const frame = redragonM690ProEncodeBlockWrite(CABLE_BUTTONS, REDRAGON_M690_PRO_BUTTONS_LENGTH, REDRAGON_M690_PRO_BUTTONS_TRAILER);
  const expected = padded(CABLE_BUTTONS);
  expected[3] = 0x50;
  expected[88] = 0xa5;
  assert.deepEqual(frame, expected);
});

/**
 * The vendor app's DPI-indicator write over the cable: the settings block it
 * read, then its write with the five stage colours changed.
 */
const COLOURS_READ = bytes(`
  081100000000000064130425000200040008000c001800000000000000000000
  00000000000000000000000000000040000040000040000040000040ff460000
  ffffffffff02440100ff0000400700000000ff000000ffffff0000ffffff8000
  ff00ff0202000bebd700ff000000ffffff0000ffffff8000ff00ffff0000ff00
  00ff00000200ff00fa036a424202ff000000000102ff0000a500`);
const COLOURS_WRITE = bytes(`
  081100920000000064130425000200040008000c001800000000000000000000
  00000000000000000000000000ff8080ffff0000ff000000ffffffffff460000
  ffffffffff02440100ff0000400700000000ff000000ffffff0000ffffff8000
  ff00ff0202000bebd700ff000000ffffff0000ffffff8000ff00ffff0000ff00
  00ff00000200ff00fa036a424202ff000000000102ff0000a500`);

test("re-encodes the app's DPI indicator colour write byte for byte", () => {
  const colours = [
    { r: 0xff, g: 0x80, b: 0x80 }, { r: 0xff, g: 0xff, b: 0x00 }, { r: 0x00, g: 0xff, b: 0x00 },
    { r: 0x00, g: 0x00, b: 0xff }, { r: 0xff, g: 0xff, b: 0xff },
  ];
  const block = colours.reduce((next, rgb, stage) => redragonM690ProWithStageColor(next, stage, rgb), COLOURS_READ);
  assert.deepEqual(redragonM690ProEncodeBlockWrite(block, REDRAGON_M690_PRO_CONFIG_LENGTH), padded(COLOURS_WRITE));
});

test("stores DPI as the 1-based position in the vendor list", () => {
  // Captured: 250 -> 01, 3000 -> 0c, 8000 -> 18 on every stage.
  for (const [dpi, code] of [[250, 0x01], [3000, 0x0c], [8000, 0x18]] as const) {
    for (let stage = 0; stage < 5; stage++) {
      const next = redragonM690ProWithStageDpi(CABLE_CONFIG, stage, dpi);
      assert.equal(next[0x0d + 2 * stage], code);
      assert.equal(next[0x0e + 2 * stage], 0x00);
    }
  }
  assert.equal(REDRAGON_M690_PRO_DPI_LABELS.length, 24);
  assert.equal(redragonM690ProNearestDpi(760), 800);
  assert.throws(() => redragonM690ProWithStageDpi(CABLE_CONFIG, 0, 750));
  assert.throws(() => redragonM690ProWithStageDpi(CABLE_CONFIG, 5, 800));
});

test("matches the app's lighting writes", () => {
  // Steady (brightness 0) -> Colorful Streaming brightness 4 speed 2: [0x45] 02->01, [0x46] 00->42.
  const streaming = redragonM690ProWithLighting(CABLE_CONFIG, { effect: REDRAGON_M690_PRO_EFFECT_STREAMING, brightness: 4, speed: 2 });
  const changed = [...streaming].flatMap((byte, index) => (byte === CABLE_CONFIG[index] ? [] : [index]));
  assert.deepEqual(changed, [0x45, 0x46]);
  assert.equal(streaming[0x45], 0x01);
  assert.equal(streaming[0x46], 0x42);
  // Steady colour recolours the selected slot, as the app did for slot 4 (4c 22 8a).
  const recoloured = redragonM690ProWithLighting(
    Uint8Array.from(CABLE_CONFIG).fill(0x04, 0x48, 0x49),
    { effect: REDRAGON_M690_PRO_EFFECT_STEADY, brightness: 2, color: { r: 0x4c, g: 0x22, b: 0x8a } },
  );
  assert.equal(recoloured[0x48], 0x24);
  assert.deepEqual([...recoloured.subarray(0x72, 0x75)], [0x4c, 0x22, 0x8a]);
  assert.throws(() => redragonM690ProWithLighting(CABLE_CONFIG, { effect: REDRAGON_M690_PRO_EFFECT_STEADY, brightness: 5 }));
});

test("decodes and encodes button slots", () => {
  assert.deepEqual(redragonM690ProDecodeButtons(CABLE_BUTTONS), {
    "Left (1)": "Left click",
    "Right (2)": "Right click",
    "Wheel click (3)": "Middle click",
    "Forward (4)": "Forward",
    "Back (5)": "Back",
    "DPI up (6)": "DPI up",
    "DPI down (7)": "DPI down",
    "Fire (8)": "Three click",
  });
  // Captured: Refresh on button 8, Disable on the wheel click, a macro on button 4.
  assert.deepEqual(redragonM690ProEncodeButtonAction("Web refresh"), [0x22, 0x00, 0x00, 0x20]);
  assert.deepEqual(redragonM690ProEncodeButtonAction("Disabled"), [0x50, 0x01, 0x00, 0x00]);
  assert.equal(redragonM690ProDecodeButtonAction([0x70, 0x01, 0x01, 0x01]), "Macro 1");
  // Keyboard keys, as captured and pressed: 21 modifiers usage 00.
  assert.equal(redragonM690ProDecodeButtonAction([0x21, 0x03, 0x15, 0x00]), "Keys Ctrl+Shift+R");
  assert.equal(redragonM690ProDecodeButtonAction([0x21, 0x04, 0x04, 0x00]), "Keys Alt+A");
  assert.equal(redragonM690ProDecodeButtonAction([0x21, 0x08, 0x1a, 0x00]), "Keys Win+W");
  assert.equal(redragonM690ProDecodeButtonAction([0x21, 0x00, 0x04, 0x00]), "Key A");
  for (const [key, usage] of [["\\", 0x31], ["Delete", 0x4c], ["Up arrow", 0x52], ["F12", 0x45], ["Numpad 5", 0x5d], ["Backspace", 0x2a]] as const) {
    assert.deepEqual(redragonM690ProEncodeButtonAction(`Key ${key}`), [0x21, 0x00, usage, 0x00]);
  }
  assert.deepEqual(redragonM690ProEncodeButtonAction("Copy (Ctrl+C)"), [0x21, 0x01, 0x06, 0x00]);
  assert.equal(redragonM690ProDecodeButtonAction([0x21, 0x10, 0x04, 0x00]), "Custom (21 10 04 00)");
  // App button 4 lives in slot 5 (offset 0x18).
  const next = redragonM690ProWithButtonAction(CABLE_BUTTONS, "Forward (4)", "Web refresh");
  assert.deepEqual([...next.subarray(0x18, 0x1c)], [0x22, 0x00, 0x00, 0x20]);
  assert.deepEqual([...next.subarray(0x14, 0x18)], [0x11, 0x08, 0x00, 0x00]);
});

test("decodes identity, link, and battery replies", () => {
  assert.equal(redragonM690ProDecodeIdentity(bytes("0501323934350000")), "2945");
  assert.equal(redragonM690ProDecodeLink(bytes("0580010100000000")), true);
  assert.equal(redragonM690ProDecodeLink(bytes("0580000100000000")), false);
  assert.deepEqual(redragonM690ProDecodeStatus(bytes("0590116300000000")), { wireless: true, batteryPercent: 99, charge: null, raw: 0x63 });
  // Over the cable: charging, then charged (the app shows 100 %).
  assert.deepEqual(redragonM690ProDecodeStatus(bytes("0590100100000000")), { wireless: false, batteryPercent: null, charge: "Charging", raw: 0x01 });
  assert.deepEqual(redragonM690ProDecodeStatus(bytes("0590100200000000")), { wireless: false, batteryPercent: 100, charge: "Full", raw: 0x02 });
  assert.throws(() => redragonM690ProDecodeLink(bytes("0590116300000000")));
});

/**
 * The M690 PRO's vendor channel as captured: a command on report 5 selects
 * what report 8 answers, report-8 writes replace a bank's block, and the
 * receiver answers reads even while the mouse is off. Answers keep the
 * report id first, as Chrome on Windows returns them.
 */
class FakeM690Pro {
  vendorId = REDRAGON_M690_PRO_VENDOR_ID;
  productName = "M690-PRO";
  opened = false;
  // Interface 1 as WebHID lists it: separate top-level collections.
  collections = [
    { usagePage: 0x0c, usage: 0x01, featureReports: [], children: [] },
    { usagePage: REDRAGON_M690_PRO_USAGE_PAGE, usage: REDRAGON_M690_PRO_USAGE, featureReports: [{ reportId: 8 }], children: [] },
    { usagePage: REDRAGON_M690_PRO_USAGE_PAGE, usage: REDRAGON_M690_PRO_USAGE, featureReports: [], children: [] },
    { usagePage: REDRAGON_M690_PRO_USAGE_PAGE, usage: REDRAGON_M690_PRO_USAGE, featureReports: [{ reportId: 5 }], children: [] },
    { usagePage: 0xff01, usage: 0x01, featureReports: [{ reportId: 6 }], children: [] },
  ] as unknown as HIDCollectionInfo[];
  linked = true;
  banks = new Map<number, Uint8Array>();
  readonly blockWrites: Uint8Array[] = [];
  /** Fail this many reads with Chrome's error, as a transport that could not complete them. */
  failReceives = 0;
  /**
   * Chrome reads every feature report with the device's largest length (520),
   * which the firmware STALLs on report 5, so report-5 answers never arrive.
   */
  chromeReads = false;
  readonly shortReads: number[] = [];
  private lastCommand = 0;

  constructor(public productId: number) {
    const wireless = productId === REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID;
    const config = Uint8Array.from(CABLE_CONFIG);
    const buttons = Uint8Array.from(CABLE_BUTTONS);
    config[1] = wireless ? 0x21 : 0x11;
    buttons[1] = wireless ? 0x22 : 0x12;
    this.banks.set(config[1]!, config);
    this.banks.set(buttons[1]!, buttons);
  }

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    const body = new Uint8Array(data as ArrayBuffer);
    if (reportId === REDRAGON_M690_PRO_COMMAND_REPORT_ID) {
      assert.equal(body.length, 7);
      this.lastCommand = body[0]!;
      return;
    }
    assert.equal(reportId, REDRAGON_M690_PRO_BLOCK_REPORT_ID);
    assert.equal(body.length, 519);
    const frame = Uint8Array.from([REDRAGON_M690_PRO_BLOCK_REPORT_ID, ...body]);
    this.blockWrites.push(frame);
    const command = frame[1]!;
    const length = this.banks.get(command)!.length;
    assert.equal(frame[3], length - 8, "write length byte");
    const stored = frame.slice(0, length);
    stored[3] = 0x00;
    this.banks.set(command, stored);
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    if (this.failReceives > 0) {
      this.failReceives--;
      throw new Error("Failed to receive the feature report.");
    }
    if (reportId === REDRAGON_M690_PRO_BLOCK_REPORT_ID) {
      const block = this.banks.get(this.lastCommand)!;
      const out = new Uint8Array(520);
      out.set(block);
      return new DataView(out.buffer);
    }
    this.shortReads.push(this.lastCommand);
    if (this.chromeReads) throw new Error("Failed to receive the feature report.");
    const reply = new Uint8Array(8);
    reply.set([REDRAGON_M690_PRO_COMMAND_REPORT_ID, this.lastCommand]);
    if (this.lastCommand === 0x80) reply.set([this.linked ? 0x01 : 0x00, 0x01], 2);
    if (this.lastCommand === 0x90) {
      reply.set(this.productId === REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID ? [0x11, 0x64] : [0x10, 0x01], 2);
    }
    return new DataView(reply.buffer);
  }
}

const client = (fake: FakeM690Pro) => new RedragonM690ProHidClient(fake as unknown as HIDDevice);

test("claims the M690 PRO interface but not other 0x258a devices", () => {
  assert.equal(RedragonM690ProHidClient.isSupported(new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID) as unknown as HIDDevice), true);
  assert.equal(RedragonM690ProHidClient.isSupported(new FakeM690Pro(REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID) as unknown as HIDDevice), true);
  const glorious = new FakeM690Pro(0x2011);
  assert.equal(RedragonM690ProHidClient.isSupported(glorious as unknown as HIDDevice), false);
  const keyboardOnly = new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID);
  keyboardOnly.collections = keyboardOnly.collections.slice(0, 1);
  assert.equal(RedragonM690ProHidClient.isSupported(keyboardOnly as unknown as HIDDevice), false);
});

test("reads the cable status from the mouse", async () => {
  const status = await client(new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID)).readStatus();
  assert.equal(status.name, "Redragon M690 PRO");
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.pollingRateHz, 125);
  assert.deepEqual(status.dpiStages, [500, 1000, 2000, 3000, 8000]);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpi, 2000);
  assert.equal(status.dpiStageColors?.[0], "#000040");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.ui?.statusNote, undefined); // readable here, as through Bridge
  assert.equal(status.lighting?.mode, "Off");
  // Effects without a speed report the factory speed, so switching to Wave or
  // Breathing in the panel starts with one selected.
  assert.equal(status.lighting?.speed, 3);
  assert.equal(status.buttonMappings?.["Fire (8)"], "Three click");
  assert.deepEqual(status.fixedButtons, []);
});

test("reads battery and link state through the receiver", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID);
  assert.equal((await client(fake).readStatus()).batteryPercent, 100);
  fake.linked = false;
  const asleep = await client(fake).readStatus();
  assert.equal(asleep.batteryPercent, null);
  assert.match(asleep.ui?.statusNote ?? "", /off or asleep/);
});

test("writes polling exactly as the app does, then reads it back", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID);
  assert.equal(await client(fake).setPollingRate(500), 500);
  assert.equal(fake.blockWrites.length, 2);
  assert.deepEqual(fake.blockWrites[0], padded(POLLING_500_WRITE));
  assert.equal(fake.blockWrites[1]![1], 0x12);
  assert.equal(fake.blockWrites[1]![88], 0xa5);
  assert.equal(redragonM690ProDecodeConfig(fake.banks.get(0x11)!).pollingHz, 500);
});

test("writes the receiver's own bank", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID);
  assert.equal(await client(fake).setDpiStageValue(0, 790), 800);
  assert.deepEqual(fake.blockWrites.map((frame) => frame[1]), [0x21, 0x22]);
  assert.equal(fake.banks.get(0x21)![0x0d], 0x03);
});

test("refuses writes while the receiver's mouse is off", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID);
  fake.linked = false;
  await assert.rejects(client(fake).setPollingRate(250), /off or asleep/);
  assert.equal(fake.blockWrites.length, 0);
});

test("refuses a 0x258a receiver whose settings block is not the M690 PRO's", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID);
  fake.banks.get(0x21)![0x09] = 0x10;
  const status = await client(fake).readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /not the Redragon M690 PRO's/);
  assert.equal(status.dpiStages, undefined);
  await assert.rejects(client(fake).setPollingRate(250), /not the Redragon M690 PRO's/);
  assert.equal(fake.blockWrites.length, 0);
});

test("works where report-5 answers cannot be read, and stops asking", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID);
  fake.chromeReads = true;
  const mouse = client(fake);
  const status = await mouse.readStatus();
  assert.deepEqual(status.dpiStages, [500, 1000, 2000, 3000, 8000]);
  assert.equal(status.batteryPercent, null);
  assert.equal(status.ui?.statusNote, "Charging status needs OpenMouse Bridge.");
  await mouse.readStatus();
  assert.equal(await mouse.setPollingRate(500), 500);
  assert.deepEqual(fake.shortReads, [0x90], "one failed report-5 read, then none");
});

test("through the receiver, an unreadable link check does not block writes", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_RECEIVER_PRODUCT_ID);
  fake.chromeReads = true;
  const status = await client(fake).readStatus();
  assert.equal(status.batteryPercent, null);
  assert.match(status.ui?.statusNote ?? "", /need OpenMouse Bridge\. Without it, changes made while the mouse is off/);
  assert.equal(await client(fake).setPollingRate(250), 250);
  assert.equal(redragonM690ProDecodeConfig(fake.banks.get(0x21)!).pollingHz, 250);
});

test("sets a stage colour the way OpenMouse's applyDpiStageColor does", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID);
  const mouse = client(fake);
  const before = await mouse.readStatus();
  assert.equal(before.dpiStageColors?.length, before.dpiStages?.length);
  assert.ok(before.dpiStageColors?.every((color) => /^#[0-9a-f]{6}$/.test(color)));
  await mouse.setDpiStageColor(2, "#00ff00");
  const after = await mouse.readStatus();
  assert.deepEqual(after.dpiStageColors, ["#000040", "#000040", "#00ff00", "#000040", "#000040"]);
  assert.deepEqual([...fake.banks.get(0x11)!.subarray(0x33, 0x36)], [0x00, 0xff, 0x00]);
  await assert.rejects(mouse.setDpiStageColor(5, "#00ff00"));
  await assert.rejects(mouse.setDpiStageColor(0, "green"));
});

test("switches lighting modes and keeps the last left click", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID);
  const mouse = client(fake);
  const shown = (await mouse.readStatus()).lighting!;
  assert.equal(shown.brightness, 50); // Off (stored 0) shows the default, so switching starts from it
  await mouse.setLighting({ ...shown, mode: "Wave" } as MouseLighting);
  let lighting = (await mouse.readStatus()).lighting!;
  assert.equal(lighting.mode, "Wave");
  assert.equal(lighting.brightness, 50);
  await mouse.setLighting({ ...lighting, mode: "Breathing random", brightness: null } as unknown as MouseLighting);
  assert.equal((await mouse.readStatus()).lighting?.brightness, 50); // the stored 0 is lifted to the default
  await mouse.setLighting({ ...lighting, mode: "Static", color: "#ff0000", brightness: 50 } as MouseLighting);
  lighting = (await mouse.readStatus()).lighting!;
  assert.equal(lighting.mode, "Static");
  assert.equal(lighting.color, "#ff0000");
  assert.equal(lighting.brightness, 50);
  await mouse.setLighting({ ...lighting, mode: "Off" } as MouseLighting);
  assert.equal((await mouse.readStatus()).lighting?.mode, "Off");
  // Brightness stays offered under Off, so picking Static next shows it at once.
  assert.deepEqual((await mouse.readStatus()).lighting?.brightnessLevels, [25, 50, 75, 100]);
  // Captured through OpenMouse: Wave at speed 4, then Breathing with the
  // panel still showing speed 4 must store Breathing speed 4, not keep its own.
  await mouse.setLighting({ ...lighting, mode: "Wave", speed: 4, brightness: 100 } as MouseLighting);
  await mouse.setLighting({ ...lighting, mode: "Breathing random", speed: 4, brightness: 100 } as MouseLighting);
  lighting = (await mouse.readStatus()).lighting!;
  assert.equal(lighting.mode, "Breathing random");
  assert.equal(lighting.speed, 4);
  assert.equal(fake.banks.get(0x11)![0x4c], 0x43);

  await assert.rejects(mouse.setButtonMapping("Left (1)", "Back"), /Left click/);
  await mouse.setButtonMapping("Right (2)", "Left click");
  await mouse.setButtonMapping("Left (1)", "Right click");
  const buttons = (await mouse.readStatus()).buttonMappings!;
  assert.equal(buttons["Left (1)"], "Right click");
  assert.equal(buttons["Right (2)"], "Left click");
});

test("re-requests a block read that failed", async () => {
  const fake = new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID);
  fake.failReceives = 2;
  assert.equal((await client(fake).readStatus()).pollingRateHz, 125);
  const stuck = new FakeM690Pro(REDRAGON_M690_PRO_WIRED_PRODUCT_ID);
  stuck.failReceives = Infinity;
  const status = await client(stuck).readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /did not answer command 0x11 on report 8 \(Failed to receive the feature report\.\)/);
  await assert.rejects(client(stuck).setPollingRate(500), /did not answer command 0x11/);
  assert.equal(stuck.blockWrites.length, 0);
});
