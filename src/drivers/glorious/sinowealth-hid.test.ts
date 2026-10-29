import assert from "node:assert/strict";
import test from "node:test";

import { GloriousClassicHidClient } from "./classic-hid.ts";
import { GloriousSinowealthHidClient } from "./sinowealth-hid.ts";
import {
  GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE,
  GLORIOUS_SINOWEALTH_EFFECT_STATIC,
  GLORIOUS_SINOWEALTH_EFFECT_WAVE,
  gloriousSinowealthCheckConfig,
  gloriousSinowealthConfigSize,
  gloriousSinowealthDecodeConfig,
  gloriousSinowealthDecodeDebounce,
  gloriousSinowealthEncodeCommand,
  gloriousSinowealthEncodeConfigWrite,
  gloriousSinowealthEncodeDebounce,
  gloriousSinowealthWithActiveStage,
  gloriousSinowealthWithLighting,
  gloriousSinowealthWithPollingRate,
  gloriousSinowealthWithStageDpi,
} from "../../glorious-sinowealth/index.ts";

/**
 * A Model O style settings block (report id first): PMW3360, 1000 Hz, six
 * enabled stages 400/800/1600/3200/5000/10000 with stage 3 active, two slots
 * disabled, static red on the RBG LED.
 */
function configBlock(size = 167): Uint8Array {
  const block = new Uint8Array(size);
  block[0] = 4;
  block[1] = 0x11;
  block[9] = 0x06; // PMW3360
  block[10] = 0x04; // 1000 Hz, flags 0
  block[11] = (3 << 4) | 6; // active stage 3 of 6
  block[12] = 0b11000000; // slots 6 and 7 disabled
  block.set([3, 7, 15, 31, 49, 99, 0x55, 0x55], 13); // (dpi / 100) - 1
  block[0x35] = GLORIOUS_SINOWEALTH_EFFECT_STATIC;
  block[0x38] = 0x20; // brightness 2
  block.set([0xff, 0x00, 0x00], 0x39); // red
  // Short firmwares end before the wave and single-colour breathing bytes.
  if (size > 0x80) {
    block[0x7c] = 0x22; // wave
    block[0x7d] = 0x23;
    block.set([0x00, 0x00, 0xff], 0x7e); // breathing single: [r=0, b=0, g=255] -> green
  }
  return block;
}

function fakeCollection(usagePage: number, reportIds: number[], length = 519) {
  return {
    usagePage,
    usage: 1,
    type: 1,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: reportIds.map((reportId) => ({ reportId, items: [{ reportSize: 8, reportCount: reportId === 5 ? 5 : length }] })),
  };
}

interface FakeOptions {
  vendorId?: number;
  productId?: number;
  size?: number;
  /** Report 4's declared payload length (id excluded). */
  declared?: number;
  /** When set, report 5 reads fail like a STALLed request. */
  stallShort?: boolean;
  /** Keep the write instead of storing it, to simulate a mouse that ignores it. */
  ignoreWrites?: boolean;
  debounce?: number;
}

function fakeDevice(options: FakeOptions = {}) {
  let block = configBlock(options.size ?? 167);
  let lastCommand = 0;
  const writes: Array<{ reportId: number; payload: Uint8Array }> = [];
  const device = {
    vendorId: options.vendorId ?? 0x258a,
    productId: options.productId ?? 0x0036,
    productName: "Glorious Model O",
    opened: true,
    collections: [fakeCollection(0xff00, [4, 5], options.declared ?? 166)],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      const view = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      const payload = new Uint8Array(view);
      writes.push({ reportId, payload });
      if (reportId === 5) lastCommand = payload[0]!;
      if (reportId === 4 && !options.ignoreWrites) {
        const next = new Uint8Array(block.length);
        next[0] = 4;
        next.set(payload.subarray(0, block.length - 1), 1);
        block = next;
      }
    },
    receiveFeatureReport: async (reportId: number) => {
      if (reportId === 4) return new DataView(Uint8Array.from(block.subarray(1)).buffer);
      if (options.stallShort) throw new Error("stall");
      return new DataView(Uint8Array.from([lastCommand, (options.debounce ?? 8) / 2, 0, 0, 0]).buffer);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, writes, current: () => block };
}

test("claims the original wired Model O, Model D and the Model O Eternal", () => {
  assert.equal(GloriousSinowealthHidClient.isSupported(fakeDevice().device), true);
  assert.equal(GloriousSinowealthHidClient.isSupported(fakeDevice({ productId: 0x0033 }).device), true);
  assert.equal(GloriousSinowealthHidClient.isSupported(fakeDevice({ vendorId: 0x3794, productId: 0xa000 }).device), true);
});

test("leaves other SinoWealth and Glorious product ids to their own drivers", () => {
  // 0x0027 is the generic SinoWealth id shared with other brands' mice.
  assert.equal(GloriousSinowealthHidClient.isSupported(fakeDevice({ productId: 0x0027 }).device), false);
  // The Redragon M690 PRO's cable PID.
  assert.equal(GloriousSinowealthHidClient.isSupported(fakeDevice({ productId: 0x002e }).device), false);
  // Classic wireless-era Model O: owned by the classic driver, and not this one.
  const wireless = fakeDevice({ productId: 0x2011 }).device;
  assert.equal(GloriousSinowealthHidClient.isSupported(wireless), false);
  assert.equal(GloriousClassicHidClient.isSupported(fakeDevice().device), false);
});

test("needs the vendor collection's command and settings reports", () => {
  const noSettings = fakeDevice().device;
  (noSettings.collections as unknown as unknown[])[0] = fakeCollection(0xff00, [5]);
  assert.equal(GloriousSinowealthHidClient.isSupported(noSettings), false);
  const wrongPage = fakeDevice().device;
  (wrongPage.collections as unknown as unknown[])[0] = fakeCollection(0xff01, [4, 5]);
  assert.equal(GloriousSinowealthHidClient.isSupported(wrongPage), false);
  const longReport = fakeDevice().device;
  (longReport.collections as unknown as unknown[])[0] = fakeCollection(0xff00, [5, 6]);
  assert.equal(GloriousSinowealthHidClient.isSupported(longReport), true);
});

test("encodes the command and debounce frames libratbag and OpenRGB send", () => {
  assert.deepEqual([...gloriousSinowealthEncodeCommand(0x11)], [0x05, 0x11, 0, 0, 0, 0]);
  assert.deepEqual([...gloriousSinowealthEncodeDebounce(8)], [0x05, 0x1a, 0x04, 0, 0, 0]);
  assert.equal(gloriousSinowealthDecodeDebounce(Uint8Array.from([5, 0x1a, 6, 0, 0, 0])), 12);
  assert.throws(() => gloriousSinowealthEncodeDebounce(5), /not one of/);
  assert.throws(() => gloriousSinowealthDecodeDebounce(Uint8Array.from([5, 0x11, 6, 0, 0, 0])), /answered command/);
  assert.throws(() => gloriousSinowealthDecodeDebounce(Uint8Array.from([5, 0x1a, 0xff, 0, 0, 0])), /510 ms/);
  assert.throws(() => gloriousSinowealthDecodeDebounce(Uint8Array.from([5, 0x1a, 1, 0, 0, 0])), /2 ms/);
});

test("rejects truncated, mis-addressed or wrong-command settings blocks", () => {
  assert.doesNotThrow(() => gloriousSinowealthCheckConfig(configBlock()));
  assert.throws(() => gloriousSinowealthCheckConfig(configBlock(100)), /answered its settings request/);
  const wrongReport = configBlock();
  wrongReport[0] = 8;
  assert.throws(() => gloriousSinowealthCheckConfig(wrongReport), /answered its settings request/);
  const wrongCommand = configBlock();
  wrongCommand[1] = 0x12;
  assert.throws(() => gloriousSinowealthCheckConfig(wrongCommand), /answered its settings request/);
});

test("decodes the sensor, polling rate, DPI stages and effect", () => {
  const config = gloriousSinowealthDecodeConfig(configBlock());
  assert.equal(config.sensorName, "PMW3360");
  assert.equal(config.pollingHz, 1000);
  assert.deepEqual(config.stages.map((stage) => stage.dpi), [400, 800, 1600, 3200, 5000, 10000]);
  assert.deepEqual(config.stages.map((stage) => stage.slot), [0, 1, 2, 3, 4, 5]);
  assert.equal(config.activeStage, 2);
  assert.equal(config.effect, GLORIOUS_SINOWEALTH_EFFECT_STATIC);
  // The LED takes red, blue, green: [ff 00 00] is red, [00 00 ff] is green.
  assert.deepEqual(config.staticColor, { r: 255, g: 0, b: 0 });
  assert.deepEqual(config.breathingSingleColor, { r: 0, g: 255, b: 0 });
  assert.deepEqual(config.static, { brightness: 2, speed: 0 });
});

test("reads PMW3389 DPI without the off-by-one the PMW3360 has", () => {
  const block = configBlock();
  block[9] = 0x0f;
  // Slot 0 stores 3: 400 DPI on a PMW3360, 300 on a PMW3389.
  assert.equal(gloriousSinowealthDecodeConfig(block).stages[0]!.dpi, 300);
  block[9] = 0x77;
  assert.equal(gloriousSinowealthDecodeConfig(block).stages[0]!.dpi, null);
  assert.equal(gloriousSinowealthDecodeConfig(block).sensorName, null);
});

test("reads independent X/Y stages from the x byte of each pair", () => {
  const block = configBlock();
  block[10] = 0x84; // XY independent flag, 1000 Hz
  block.fill(0, 13, 29);
  block.set([7, 3, 15, 15], 13); // slot 0: x=800 y=400, slot 1: 1600 / 1600
  const config = gloriousSinowealthDecodeConfig(block);
  assert.equal(config.xyIndependent, true);
  assert.deepEqual(config.stages.slice(0, 2).map((stage) => stage.dpi), [800, 1600]);
});

test("changes one field and keeps every other byte, including unknown ones", () => {
  const block = configBlock();
  block[2] = 0xaa;
  block[104] = 0xbb; // unknown3
  const changed = gloriousSinowealthWithPollingRate(block, 500);
  assert.equal(changed[10], 0x03);
  assert.equal(block[10], 0x04, "the caller's block is not mutated");
  assert.deepEqual([...changed.subarray(0, 10)], [...block.subarray(0, 10)]);
  assert.deepEqual([...changed.subarray(11)], [...block.subarray(11)]);

  const flagged = configBlock();
  flagged[10] = 0x84;
  assert.equal(gloriousSinowealthWithPollingRate(flagged, 125)[10], 0x81);
  assert.throws(() => gloriousSinowealthWithPollingRate(block, 2000), /not one of/);
});

test("writes a stage DPI into its own slot, skipping disabled slots", () => {
  const block = configBlock();
  block[12] = 0b00000010; // slot 1 disabled: stage 1 is slot 2
  const changed = gloriousSinowealthWithStageDpi(block, 1, 1200);
  assert.equal(changed[13 + 2], 11);
  assert.equal(changed[13 + 1], block[13 + 1]);
  assert.throws(() => gloriousSinowealthWithStageDpi(block, 1, 12100), /not a multiple/);
  assert.throws(() => gloriousSinowealthWithStageDpi(block, 1, 450), /not a multiple/);
  assert.throws(() => gloriousSinowealthWithStageDpi(block, 1, 300), /not a multiple/);
  assert.throws(() => gloriousSinowealthWithStageDpi(block, 9, 800), /outside/);
});

test("writes both axes of an independent stage", () => {
  const block = configBlock();
  block[10] = 0x84;
  const changed = gloriousSinowealthWithStageDpi(block, 1, 2000);
  assert.deepEqual([...changed.subarray(15, 17)], [19, 19]);
  // Slot 0 sits at the start of the table, so its Y byte must still be written.
  const first = gloriousSinowealthWithStageDpi(block, 0, 2000);
  assert.deepEqual([...first.subarray(13, 15)], [19, 19]);
});

test("selects the active stage among the enabled ones, keeping the stage count", () => {
  const changed = gloriousSinowealthWithActiveStage(configBlock(), 5);
  assert.equal(changed[11], (6 << 4) | 6);
  assert.throws(() => gloriousSinowealthWithActiveStage(configBlock(), 6), /outside/);
});

test("writes lighting into the effect's own bytes, red/blue/green order", () => {
  const block = configBlock();
  const changed = gloriousSinowealthWithLighting(block, {
    effect: GLORIOUS_SINOWEALTH_EFFECT_STATIC,
    brightness: 4,
    color: { r: 0x11, g: 0x22, b: 0x33 },
  });
  assert.equal(changed[0x35], GLORIOUS_SINOWEALTH_EFFECT_STATIC);
  assert.equal(changed[0x38], 0x40);
  assert.deepEqual([...changed.subarray(0x39, 0x3c)], [0x11, 0x33, 0x22]);
  assert.equal(changed[0x7c], block[0x7c], "other effects keep their bytes");

  const wave = gloriousSinowealthWithLighting(block, { effect: GLORIOUS_SINOWEALTH_EFFECT_WAVE, speed: 3 });
  assert.equal(wave[0x35], GLORIOUS_SINOWEALTH_EFFECT_WAVE);
  assert.equal(wave[0x7c], 0x23);

  assert.throws(() => gloriousSinowealthWithLighting(block, { effect: GLORIOUS_SINOWEALTH_EFFECT_STATIC, speed: 1 }), /no speed/);
  assert.throws(() => gloriousSinowealthWithLighting(block, { effect: GLORIOUS_SINOWEALTH_EFFECT_WAVE, speed: 4 }), /outside/);
  assert.throws(() => gloriousSinowealthWithLighting(block, { effect: GLORIOUS_SINOWEALTH_EFFECT_WAVE, color: { r: 0, g: 0, b: 0 } }), /Only Static/);
});

test("refuses lighting a short block cannot hold, and mice without LEDs", () => {
  const short = configBlock(123);
  assert.throws(() => gloriousSinowealthWithLighting(short, { effect: GLORIOUS_SINOWEALTH_EFFECT_WAVE }), /cannot hold/);
  assert.throws(() => gloriousSinowealthWithLighting(short, { effect: GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE }), /cannot hold/);
  assert.doesNotThrow(() => gloriousSinowealthWithLighting(short, { effect: GLORIOUS_SINOWEALTH_EFFECT_STATIC }));
  const noLeds = configBlock();
  noLeds[0x35] = 0xff;
  assert.throws(() => gloriousSinowealthWithLighting(noLeds, { effect: GLORIOUS_SINOWEALTH_EFFECT_STATIC }), /cannot hold/);
});

test("resolves the block size from the reply, or from the descriptor when the reply is padded", () => {
  assert.equal(gloriousSinowealthConfigSize(167, null), 167);
  assert.equal(gloriousSinowealthConfigSize(131, 520), 131);
  assert.equal(gloriousSinowealthConfigSize(520, 167), 167);
  assert.equal(gloriousSinowealthConfigSize(520, 520), null);
  assert.equal(gloriousSinowealthConfigSize(520, null), null);
  assert.equal(gloriousSinowealthConfigSize(100, null), null);
});

test("encodes the write with the size minus 8 in byte 3, as OpenRGB's 0x7b for 131 bytes", () => {
  const frame = gloriousSinowealthEncodeConfigWrite(configBlock(131), 131, 520);
  assert.equal(frame.length, 520);
  assert.equal(frame[3], 0x7b);
  assert.equal(frame[0], 4);
  assert.equal(frame[1], 0x11);
  assert.equal(frame[131], 0);
  assert.equal(gloriousSinowealthEncodeConfigWrite(configBlock(167), 167, 167)[3], 159);
  assert.throws(() => gloriousSinowealthEncodeConfigWrite(configBlock(131), 167, 520), /expected 167/);
  assert.throws(() => gloriousSinowealthEncodeConfigWrite(configBlock(167), 167, 160), /cannot hold/);
});

test("reports the mouse's own settings, marked experimental", async () => {
  const { device } = fakeDevice();
  const status = await new GloriousSinowealthHidClient(device).readStatus();
  assert.equal(status.brand, "Glorious");
  assert.equal(status.name, "Glorious Model O / O-");
  assert.equal(status.dpi, 1600);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 3200, 5000, 10000]);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.debounceMs, 8);
  assert.equal(status.ui?.settingsReady, true);
  assert.match(status.ui?.statusNote ?? "", /Experimental/);
  assert.equal(status.lighting?.mode, "Static");
  assert.equal(status.lighting?.color, "#ff0000");
  assert.equal(status.lighting?.brightness, 50);
  assert.deepEqual(status.lighting?.modes, ["Off", "Static", "Cycling", "Breathing random", "Wave", "Breathing single"]);
});

test("leaves debounce off when the short report cannot be read", async () => {
  const { device } = fakeDevice({ stallShort: true });
  const client = new GloriousSinowealthHidClient(device);
  const status = await client.readStatus();
  assert.equal(status.debounceMs, undefined);
  assert.equal(status.ui?.showAdvancedSection, undefined);
  await assert.rejects(client.setDebounceTime(8), /cannot be read/);
});

test("offers only the effects a short settings block can hold", async () => {
  const { device } = fakeDevice({ size: 123, declared: 122 });
  const status = await new GloriousSinowealthHidClient(device).readStatus();
  assert.deepEqual(status.lighting?.modes, ["Off", "Static", "Cycling", "Breathing random"]);
});

test("a settings read that fails leaves an identity-only status with controls off", async () => {
  const { device } = fakeDevice();
  (device as unknown as { receiveFeatureReport: () => Promise<DataView> }).receiveFeatureReport = async () => {
    throw new Error("stall");
  };
  const status = await new GloriousSinowealthHidClient(device).readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.name, "Glorious Model O / O-");
  assert.match(status.ui?.statusNote ?? "", /could not be read/);
});

test("writes a polling rate as the whole block on report 4 and verifies it by reading back", async () => {
  const { device, writes, current } = fakeDevice();
  const client = new GloriousSinowealthHidClient(device);
  assert.equal(await client.setPollingRate(500), 500);
  const write = writes.find((entry) => entry.reportId === 4)!;
  assert.equal(write.payload.length, 166);
  assert.equal(write.payload[2], 159, "byte [3] of the report is the size minus 8");
  assert.equal(current()[10], 0x03);
  assert.deepEqual([...current().subarray(11, 167)], [...configBlock().subarray(11, 167)]);
});

test("writes a stage DPI and the active stage", async () => {
  const { device, current } = fakeDevice();
  const client = new GloriousSinowealthHidClient(device);
  assert.equal(await client.setDpiStageValue(0, 450), 500);
  assert.equal(current()[13], 4);
  assert.equal(await client.setActiveDpiStage(4), 4);
  assert.equal(current()[11] >> 4, 5);
});

test("applies lighting with the panel's values, defaulting a dark or frozen effect", async () => {
  const { device, current } = fakeDevice();
  const client = new GloriousSinowealthHidClient(device);
  const status = await client.readStatus();
  const lighting = status.lighting!;
  await client.setLighting({ ...lighting, mode: "Wave", speed: null, brightness: null, color: null });
  // The wave bytes in the fixture are 0x22: brightness 2, speed 2, kept as stored.
  assert.equal(current()[0x35], GLORIOUS_SINOWEALTH_EFFECT_WAVE);
  assert.equal(current()[0x7c], 0x22);

  await client.setLighting({ ...lighting, mode: "Breathing random", speed: null, brightness: null, color: null });
  // The fixture stores 0 for this effect, which would leave it dark and frozen.
  assert.equal(current()[0x54], 0x22);

  await client.setLighting({ ...lighting, mode: "Static", brightness: 100, color: "#102030" });
  assert.equal(current()[0x38], 0x40);
  assert.deepEqual([...current().subarray(0x39, 0x3c)], [0x10, 0x30, 0x20]);

  await client.setLighting({ ...lighting, mode: "Off" });
  assert.equal(current()[0x35], 0);
  await assert.rejects(client.setLighting({ ...lighting, mode: "Neon" }), /no "Neon"/);
});

test("reports a write the mouse ignored instead of claiming success", async () => {
  const { device } = fakeDevice({ ignoreWrites: true });
  await assert.rejects(new GloriousSinowealthHidClient(device).setPollingRate(250), /did not keep/);
});

test("refuses to write when the block's size cannot be established", async () => {
  // A reply padded to 520 bytes with no declared settings length: byte [3] of
  // the write would be a guess.
  const fake = fakeDevice({ size: 520, declared: 520 });
  const client = new GloriousSinowealthHidClient(fake.device);
  await assert.rejects(client.setPollingRate(250), /size is unclear/);
  assert.equal(fake.writes.some((entry) => entry.reportId === 4), false);
});

test("writes debounce after confirming it can be read, and checks the read-back", async () => {
  const { device } = fakeDevice({ debounce: 8 });
  await assert.rejects(new GloriousSinowealthHidClient(device).setDebounceTime(8.5), /not one of/);
  // The fake keeps answering 8 ms, so a requested 12 ms does not stick.
  await assert.rejects(new GloriousSinowealthHidClient(device).setDebounceTime(12), /did not keep/);
});

test("offers only the effects a short block can hold even when the reply is padded to 520 bytes", async () => {
  const fake = fakeDevice({ size: 520, declared: 122 });
  // A 123-byte block padded out to the interface's largest report.
  const padded = fake.current();
  padded.fill(0, 123);
  const status = await new GloriousSinowealthHidClient(fake.device).readStatus();
  assert.deepEqual(status.lighting?.modes, ["Off", "Static", "Cycling", "Breathing random"]);
});

test("offers the DPI choices of the sensor it read, none before", async () => {
  const client = new GloriousSinowealthHidClient(fakeDevice().device);
  assert.deepEqual(client.getDpiOptions(), []);
  await client.readStatus();
  const options = client.getDpiOptions();
  assert.equal(options[0], 400);
  assert.equal(options[options.length - 1], 12000);
});
