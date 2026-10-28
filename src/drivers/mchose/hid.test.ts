import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MchoseHidClient } from "./hid.ts";
import {
  MCHOSE_COMMAND,
  MCHOSE_LONG_REPORT_ID,
  MCHOSE_SHORT_REPORT_ID,
  MCHOSE_SHORT_TOKENS,
} from "@openmouse/protocol/mchose";

/**
 * Replies below are the bytes a real A7 V2 Ultra+ returned through its 2.4 GHz
 * receiver while set to 1000 Hz and 1600 DPI (mchose-research captures). They
 * are re-inverted by the fake device, because that is how they arrive.
 */
const IDENTITY = [0x01, 0x37, 0x38, 0x0b, 0x10, 0x01, 0x00];
const VERSION = [0x08, 0x35, 0x2e, 0x34, 0x36, 0x2e, 0x32, 0x2e, 0x34];
const BATTERY = [0x37, 0x38, 0x21, 0x40, 0x05, 0x2e, 0x02, 0x04, 0x09, 0x29, 0x00, 0x2c];
const CONFIG = [
  0x00, 0x30, 0x20, 0x00, 0x40, 0x06, 0x20, 0x03, 0x40, 0x06,
  0x80, 0x0c, 0x00, 0x19, 0x10, 0xa4, 0x01, 0x80, 0x00, 0x00,
  // Button table, as captured: forward and back sit on F9 and F10.
  0x00, 0x00, 0x00, 0x00,
  0x10, 0x00, 0x00, 0x00,
  0x20, 0x00, 0x00, 0x00,
  0x32, 0x00, 0x42, 0x00,
  0x42, 0x00, 0x43, 0x00,
  0x50, 0x00, 0x00, 0x00,
];

/** Build the on-the-wire feature read: [reportId, ~command, ~payload…]. */
function wireReply(reportId: number, command: number, payload: number[]): DataView {
  const buf = new Uint8Array(66);
  buf[0] = reportId;
  buf[1] = (~command) & 0xff;
  payload.forEach((byte, index) => { buf[index + 2] = (byte ^ 0xff) & 0xff; });
  return new DataView(buf.buffer);
}

/**
 * A fake that behaves like the real device: one shared reply buffer per report
 * id, and a config that a 0x57 write actually mutates, so a setter's read-back
 * check is exercised rather than stubbed.
 */
/**
 * An A7 Ultra on a `5253:1020` receiver, captured at 2000 Hz on stage 1. Its
 * receiver answers 0x04 and 0x06 with an all-zero payload.
 */
const A7_ULTRA_CONFIG = [
  0x00, 0x31, 0x31, 0x01, 0x20, 0x03, 0x80, 0x0c, 0x40, 0x06,
  0x80, 0x0c, 0x00, 0x19, 0x10, 0xa4, 0x02, 0x81, 0x08, 0x03,
  ...CONFIG.slice(20),
];

function a7UltraDevice() {
  const fake = fakeDevice({
    vendorId: 0x5253,
    productId: 0x1020,
    productName: "MCHOSE A7 Ultra",
  } as Partial<HIDDevice>);
  fake.state.config = [...A7_ULTRA_CONFIG];
  fake.state.emptyShortReplies = [MCHOSE_COMMAND.version, MCHOSE_COMMAND.battery];
  return fake;
}

/** Profile 2 as captured from the same mouse: 1000 Hz on stage 2. */
const PROFILE_2 = [
  0x02, 0x32, 0x22, 0x00, 0x40, 0x06, 0x20, 0x03, 0x40, 0x06,
  0x80, 0x0c, 0x00, 0x19, 0x10, 0xa4, 0x01, 0x80, 0x00, 0x00,
  ...CONFIG.slice(20),
];

function fakeDevice(overrides?: Partial<HIDDevice>) {
  const state = {
    config: [...CONFIG],
    writes: [] as number[][],
    profile: 0,
    sleepEnabled: 0,
    mouseProductId: 0x4021,
    emptyShortReplies: [] as number[],
  };
  let pendingShort = MCHOSE_COMMAND.identity;
  let pendingLong = MCHOSE_COMMAND.config;

  const device = {
    vendorId: 0x3837,
    productId: 0x100b,
    productName: "MCHOSE A7 V2 Ultra+",
    opened: true,
    collections: [
      { usagePage: 0xff01, usage: 0x0001, type: 0, children: [], input: 0, output: 0, feature: 0 },
    ],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (id: number, data: ArrayBuffer | ArrayLike<number>) => {
      const raw = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const tokens = [...raw].map((b) => (b ^ 0xff) & 0xff);
      const command = tokens[0]!;
      if (id === MCHOSE_SHORT_REPORT_ID) {
        if (command === MCHOSE_COMMAND.setPerformance) {
          // [command, lod, ripple, line, motionSync]: lift-off replaces bits
          // 0-1, and each toggle is 1 = on, 2 = off, 0 = leave alone.
          let sensor = (state.config[17]! & ~0x03) | (tokens[1]! & 0x03);
          const apply = (raw: number, bit: number): void => {
            if (raw === 1) sensor |= bit;
            if (raw === 2) sensor &= ~bit;
          };
          apply(tokens[2]!, 0x04); // ripple
          apply(tokens[3]!, 0x08); // linear correction
          apply(tokens[4]!, 0x10); // motion sync
          // Mode is a two-bit field: 1 stores 00, 2 stores 10, 3 stores 11.
          if (tokens[7]! >= 1 && tokens[7]! <= 3) {
            sensor = (sensor & ~0xc0) | ((tokens[7] === 1 ? 0 : tokens[7]!) << 6);
          }
          state.config[17] = sensor & 0xff;
          // rotateOpen gates whether the angle value is applied.
          if (tokens[8] === 1) state.config[49] = tokens[9]!;
        }
        if (command === MCHOSE_COMMAND.setSleep) {
          // Sleep has its own command but lands in the config blob at 19.
          state.sleepEnabled = tokens[1]!;
          state.config[19] = tokens[2]!;
        }
        if (command === MCHOSE_COMMAND.setProfile) {
          // Each profile holds its own settings, so the config changes with it.
          state.profile = tokens[1]!;
          state.config = state.profile === 0 ? [...CONFIG] : [...PROFILE_2];
          state.config[0] = state.profile;
        }
        pendingShort = command;
        return;
      }
      if (command === MCHOSE_COMMAND.writeConfig) {
        // The write layout is the read layout with the command byte in front.
        state.writes.push(tokens);
        state.config = tokens.slice(1, 1 + CONFIG.length);
        pendingLong = MCHOSE_COMMAND.writeConfig;
        return;
      }
      if (command === MCHOSE_COMMAND.setButton) {
        // A standalone command: it touches one button's four bytes and nothing
        // else, which is what the hardware was observed to do.
        const at = 20 + tokens[1]! * 4;
        state.config[at] = ((tokens[1]! & 0x0f) << 4) | (tokens[3]! & 0x0f);
        state.config[at + 1] = tokens[4]!;
        state.config[at + 2] = tokens[5]!;
        state.config[at + 3] = tokens[6]!;
        pendingLong = MCHOSE_COMMAND.setButton;
        return;
      }
      pendingLong = command;
    },
    receiveFeatureReport: async (id: number) => {
      if (id === MCHOSE_SHORT_REPORT_ID) {
        if (state.emptyShortReplies.includes(pendingShort)) {
          return wireReply(id, pendingShort, new Array(MCHOSE_SHORT_TOKENS - 1).fill(0));
        }
        const payload = pendingShort === MCHOSE_COMMAND.identity ? IDENTITY
          : pendingShort === MCHOSE_COMMAND.version ? VERSION
            : pendingShort === MCHOSE_COMMAND.battery
              ? [...BATTERY.slice(0, 2), state.mouseProductId & 0xff, (state.mouseProductId >> 8) & 0xff, ...BATTERY.slice(4)]
              : [];
        return wireReply(id, pendingShort, payload);
      }
      // A write leaves no readable answer; the driver must re-issue 0x67.
      if (pendingLong === MCHOSE_COMMAND.writeConfig || pendingLong === MCHOSE_COMMAND.setButton) {
        return wireReply(id, pendingLong, []);
      }
      return wireReply(id, MCHOSE_COMMAND.config, state.config);
    },
    ...overrides,
  } as unknown as HIDDevice;

  return { device, state };
}

describe("MchoseHidClient", () => {
  it("matches an MCHOSE device exposing the 0xff01 config collection", () => {
    assert.equal(MchoseHidClient.isSupported(fakeDevice().device), true);
  });

  it("rejects another vendor on the same usage page", () => {
    const { device } = fakeDevice({ vendorId: 0x046d } as Partial<HIDDevice>);
    assert.equal(MchoseHidClient.isSupported(device), false);
  });

  it("matches the A7 Ultra receiver under vendor id 0x5253", () => {
    assert.equal(MchoseHidClient.isSupported(a7UltraDevice().device), true);
  });

  it("rejects other 0x5253 product ids on the same usage page", () => {
    const { device } = fakeDevice({ vendorId: 0x5253, productId: 0x1234 } as Partial<HIDDevice>);
    assert.equal(MchoseHidClient.isSupported(device), false);
  });

  it("reads an A7 Ultra whose receiver leaves battery and version empty", async () => {
    const status = await new MchoseHidClient(a7UltraDevice().device).readStatus();
    assert.equal(status.name, "MCHOSE A7 Ultra", "identified by the product string");
    assert.equal(status.batteryPercent, null);
    assert.deepEqual(status.firmware, []);
    assert.equal(status.pollingRateHz, 2000, "wireless byte 0x31 -> rate index 3");
    assert.equal(status.dpi, 3200, "stage 1");
    assert.deepEqual(status.supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
    assert.equal(status.ui?.dpiStageEditor?.maxDpi, 42000);
  });

  it("sets the A7 Ultra's polling rate through the same config write", async () => {
    const { device, state } = a7UltraDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setPollingRate(1000);
    assert.equal(state.config[2], 0x21);
    assert.deepEqual(
      state.config.filter((_, index) => index !== 2),
      A7_ULTRA_CONFIG.filter((_, index) => index !== 2),
    );
  });

  it("rejects an MCHOSE device with only the firmware-update collection", () => {
    const { device } = fakeDevice({
      collections: [
        { usagePage: 0xff0b, usage: 0x0104, type: 0, children: [], input: 0, output: 0, feature: 0 },
      ],
    } as unknown as Partial<HIDDevice>);
    assert.equal(MchoseHidClient.isSupported(device), false);
  });

  it("finds the config collection nested under a parent", () => {
    const { device } = fakeDevice({
      collections: [{
        usagePage: 0x0001, usage: 0x0002, type: 0, input: 0, output: 0, feature: 0,
        children: [
          { usagePage: 0xff01, usage: 0x0001, type: 0, children: [], input: 0, output: 0, feature: 0 },
        ],
      }],
    } as unknown as Partial<HIDDevice>);
    assert.equal(MchoseHidClient.isSupported(device), true);
  });

  it("sends commands bit-inverted, padded to the report length", async () => {
    const sent: Array<{ id: number; bytes: Uint8Array }> = [];
    const base = fakeDevice();
    const device = {
      ...base.device,
      sendFeatureReport: async (id: number, data: ArrayBuffer | ArrayLike<number>) => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        sent.push({ id, bytes });
        await base.device.sendFeatureReport(id, data as ArrayBuffer);
      },
    } as unknown as HIDDevice;
    await new MchoseHidClient(device).readStatus();
    assert.equal(sent[0]!.id, MCHOSE_SHORT_REPORT_ID);
    assert.equal(sent[0]!.bytes[0], (~MCHOSE_COMMAND.identity) & 0xff);
    assert.equal(sent[0]!.bytes.length, 64);
  });

  it("reads a full status matching the captured device state", async () => {
    const status = await new MchoseHidClient(fakeDevice().device).readStatus();
    assert.equal(status.brand, "MCHOSE");
    assert.equal(status.name, "MCHOSE A7 V2 Ultra+", "identified by the mouse id in the battery reply");
    assert.equal(status.batteryPercent, 41);
    assert.equal(status.batteryState, "Discharging");
    assert.deepEqual(status.dpiStages, [1600, 800, 1600, 3200, 6400, 42000]);
    assert.equal(status.activeDpiStage, 0);
    assert.equal(status.dpi, 1600, "the wireless link is on stage 0");
    assert.equal(status.pollingRateHz, 1000, "wireless byte 0x20 -> rate index 2");
    assert.equal(status.connectionType, "Wireless");
    assert.deepEqual(status.firmware, ["Receiver 5.46.2.4"]);
  });

  it("offers the 8K rate list and an editable stage list", async () => {
    const status = await new MchoseHidClient(fakeDevice().device).readStatus();
    assert.deepEqual(status.supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
    assert.equal(status.ui?.settingsReady, true);
    assert.equal(status.ui?.dpiStageEditor?.maxStages, 6);
    assert.equal(status.ui?.dpiStageEditor?.maxDpi, 42000);
  });

  it("setPollingRate rewrites only the link byte and preserves the rest", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setPollingRate(500);

    assert.equal(state.writes.length, 1);
    const written = state.writes[0]!;
    assert.equal(written[0], MCHOSE_COMMAND.writeConfig);
    assert.equal(written[1 + 2], 0x10, "rate index 1, stage 0 kept");
    assert.equal(written[1 + 1], CONFIG[1], "the wired byte is untouched");
    for (let index = 3; index < CONFIG.length; index += 1) {
      assert.equal(written[1 + index], CONFIG[index], `byte ${index} echoed`);
    }
    assert.equal((await client.readStatus()).pollingRateHz, 500);
  });

  it("setPollingRate refuses a rate this link cannot do", async () => {
    const client = new MchoseHidClient(fakeDevice().device);
    await client.readStatus();
    await assert.rejects(() => client.setPollingRate(3000), /does not support/);
  });

  it("setActiveDpiStage moves the stage and reads back", async () => {
    const { device } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setActiveDpiStage(3);
    const status = await client.readStatus();
    assert.equal(status.activeDpiStage, 3);
    assert.equal(status.dpi, 3200);
    assert.equal(status.pollingRateHz, 1000, "changing the stage left the rate alone");
  });

  it("setActiveDpiStage rejects an out-of-range stage", async () => {
    const client = new MchoseHidClient(fakeDevice().device);
    await assert.rejects(() => client.setActiveDpiStage(6), /0-5/);
  });

  it("setDpiStageValue rewrites one stage only", async () => {
    const { device } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setDpiStageValue(1, 12000);
    const status = await client.readStatus();
    assert.deepEqual(status.dpiStages, [1600, 12000, 1600, 3200, 6400, 42000]);
  });

  it("setDpiStageValue refuses a DPI above the model's ceiling", async () => {
    const { device } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await assert.rejects(() => client.setDpiStageValue(0, 60000), /between 50 and 42000/);
  });

  it("setDpi changes the stage the live link is using", async () => {
    const { device } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setDpi(3200);
    const status = await client.readStatus();
    assert.equal(status.dpiStages?.[0], 3200, "stage 0 is the active wireless stage");
    assert.equal(status.dpi, 3200);
  });

  it("reports profiles one-based, as the shell displays them", async () => {
    const status = await new MchoseHidClient(fakeDevice().device).readStatus();
    assert.equal(status.activeProfile, 1, "wire index 0 is shown as profile 1");
    assert.equal(status.profileCount, 3);
  });

  it("setProfile switches and confirms", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setProfile(3);
    assert.equal(state.profile, 2, "one-based 3 is written as wire index 2");
    const status = await client.readStatus();
    assert.equal(status.activeProfile, 3);
  });

  it("a profile brings its own DPI and polling with it", async () => {
    const { device } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setProfile(3);
    const status = await client.readStatus();
    // Profile 2 was captured at 1000 Hz on stage 2.
    assert.equal(status.pollingRateHz, 1000);
    assert.equal(status.activeDpiStage, 2);
  });

  it("setProfile rejects an index outside the mouse's range", async () => {
    const client = new MchoseHidClient(fakeDevice().device);
    await assert.rejects(() => client.setProfile(0), /1-3/);
    await assert.rejects(() => client.setProfile(4), /1-3/);
  });

  it("reports sleep in seconds, converting from the firmware's minutes", async () => {
    const { device, state } = fakeDevice();
    state.config[19] = 3;
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.sleepTimeout, 180);
    assert.equal(status.debounceMs, 0);
  });

  it("setSleepTimeout rounds seconds to whole minutes", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.setSleepTimeout(300);
    assert.equal(state.config[19], 5, "300 s stored as 5 minutes");
    assert.equal(state.sleepEnabled, 1);
  });

  it("setSleepTimeout(0) turns the timer off", async () => {
    const { device, state } = fakeDevice();
    await new MchoseHidClient(device).setSleepTimeout(0);
    assert.equal(state.config[19], 0);
    assert.equal(state.sleepEnabled, 0);
  });

  it("setDebounceTime writes through the config blob", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.setDebounceTime(8);
    assert.equal(state.config[18], 8);
    // Everything else must survive the read-modify-write.
    assert.equal(state.config[1], CONFIG[1]);
    assert.equal(state.config[19], CONFIG[19]);
    assert.equal((await client.readStatus()).debounceMs, 8);
  });

  it("setDebounceTime refuses a value the firmware will not take", async () => {
    const client = new MchoseHidClient(fakeDevice().device);
    await assert.rejects(() => client.setDebounceTime(25), /0-20 ms/);
    await assert.rejects(() => client.setDebounceTime(-1), /0-20 ms/);
  });

  it("publishes its own sleep options and debounce ceiling", () => {
    const client = new MchoseHidClient(fakeDevice().device);
    assert.deepEqual(client.getSleepOptions(), [0, 60, 120, 180, 300, 600, 1800]);
    assert.equal(client.getDebounceMaxMs(), 20);
  });

  it("reports lift-off and the steps this model offers", async () => {
    const status = await new MchoseHidClient(fakeDevice().device).readStatus();
    assert.equal(status.liftOffDistance, "Low", "sensor 0x80 -> step 0");
    assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  });

  it("setLiftOffDistance writes the step and preserves the sensor's upper bits", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setLiftOffDistance("High");
    assert.equal(state.config[17], 0x82, "0x80 flag kept, step 2 in the low bits");
    assert.equal((await client.readStatus()).liftOffDistance, "High");
  });

  it("setLiftOffDistance does not disturb DPI or polling", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setLiftOffDistance("Medium");
    assert.equal(state.config[1], CONFIG[1], "wired link byte untouched");
    assert.equal(state.config[2], CONFIG[2], "wireless link byte untouched");
    assert.equal(state.config[4], CONFIG[4], "stage 0 untouched");
  });

  it("a two-step model rejects the middle lift-off step", async () => {
    // An A7 V2 Pro (mouse id 0x4018) offers only 1 mm and 2 mm.
    const pro = fakeDevice();
    pro.state.mouseProductId = 0x4018;
    const client = new MchoseHidClient(pro.device);
    const status = await client.readStatus();
    assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
    await assert.rejects(() => client.setLiftOffDistance("Medium"), /does not offer/);
    await assert.doesNotReject(() => client.setLiftOffDistance("High"));
  });

  it("reports the button map and the actions it accepts", async () => {
    const status = await new MchoseHidClient(fakeDevice().device).readStatus();
    assert.deepEqual(Object.keys(status.buttonMappings ?? {}), [
      "Left", "Middle", "Right", "Forward", "Back", "DPI",
    ]);
    assert.equal(status.buttonMappings?.Forward, "F9", "matches the captured device");
    assert.equal(status.buttonMappings?.Left, "Default");
    assert.ok((status.buttonOptions?.length ?? 0) > 20);
    assert.ok(status.buttonOptions?.includes("Default"));
  });

  it("setButtonMapping writes only that button's four bytes", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    const before = [...state.config];
    await client.setButtonMapping("Forward", "Play / Pause");

    const at = 20 + 3 * 4;
    assert.equal(state.config[at + 1], 0xcd, "media play/pause, big-endian");
    for (let i = 0; i < before.length; i += 1) {
      if (i >= at && i < at + 4) continue;
      assert.equal(state.config[i], before[i], `byte ${i} untouched`);
    }
    assert.equal((await client.readStatus()).buttonMappings?.Forward, "Play / Pause");
  });

  it("setButtonMapping can restore a button to its factory function", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setButtonMapping("Back", "Default");
    const at = 20 + 4 * 4;
    assert.equal(state.config[at] & 0x0f, 0, "type 0");
    assert.equal(state.config[at + 1]! | state.config[at + 2]! | state.config[at + 3]!, 0);
    assert.equal((await client.readStatus()).buttonMappings?.Back, "Default");
  });

  it("setButtonMapping rejects an unknown button or action", async () => {
    const client = new MchoseHidClient(fakeDevice().device);
    await assert.rejects(() => client.setButtonMapping("Thumb", "Default"), /no "Thumb" button/);
    await assert.rejects(() => client.setButtonMapping("Left", "Launch rocket"), /Unknown button action/);
  });

  it("reports the processing toggles out of the sensor byte", async () => {
    const { device, state } = fakeDevice();
    state.config[17] = 0x9c; // every toggle on, lift-off 0
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.motionSync, true);
    assert.equal(status.rippleControl, true);
    assert.equal(status.angleSnapping, true);
    assert.equal(status.liftOffDistance, "Low", "the toggles are not part of the level");
  });

  it("each processing toggle round-trips independently", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();

    await client.setMotionSync(true);
    assert.equal(state.config[17], 0x90);
    await client.setRippleControl(true);
    assert.equal(state.config[17], 0x94);
    await client.setAngleSnapping(true);
    assert.equal(state.config[17], 0x9c);
    await client.setMotionSync(false);
    assert.equal(state.config[17], 0x8c, "only motion sync cleared");
  });

  it("changing a toggle leaves lift-off alone, and vice versa", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();

    await client.setLiftOffDistance("High");
    await client.setMotionSync(true);
    assert.equal((await client.readStatus()).liftOffDistance, "High", "toggle did not disturb lift-off");

    await client.setLiftOffDistance("Low");
    assert.equal(state.config[17] & 0x10, 0x10, "lift-off change did not clear motion sync");
    assert.equal((await client.readStatus()).motionSync, true);
  });

  it("reports the mode, angle tuning and stage count", async () => {
    const { device, state } = fakeDevice();
    state.config[49] = 5;
    state.config[16] = 4;
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.powerMode, "eSports", "sensor 0x80 -> eSports");
    assert.deepEqual(status.powerModes, ["Performance", "eSports", "Ultra"]);
    assert.equal(status.angleTuning, 5);
    assert.equal(status.ui?.dpiStageEditor?.countEditable, true);
  });

  it("setPowerMode moves through all three modes", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();

    await client.setPowerMode("Performance");
    assert.equal(state.config[17] & 0xc0, 0x00);
    assert.equal((await client.readStatus()).powerMode, "Performance");

    await client.setPowerMode("Ultra");
    assert.equal(state.config[17] & 0xc0, 0xc0);
    assert.equal((await client.readStatus()).powerMode, "Ultra");

    await client.setPowerMode("eSports");
    assert.equal(state.config[17] & 0xc0, 0x80);
  });

  it("setPowerMode rejects a mode this mouse does not have", async () => {
    const client = new MchoseHidClient(fakeDevice().device);
    await assert.rejects(() => client.setPowerMode("Turbo"), /no "Turbo" mode/);
  });

  it("changing the mode does not disturb lift-off or the toggles", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setMotionSync(true);
    await client.setLiftOffDistance("High");
    await client.setPowerMode("Ultra");
    assert.equal(state.config[17] & 0x10, 0x10, "motion sync survived");
    assert.equal(state.config[17] & 0x03, 2, "lift-off survived");
    const status = await client.readStatus();
    assert.equal(status.liftOffDistance, "High");
    assert.equal(status.motionSync, true);
  });

  it("setAngleTuning handles negative degrees and validates the range", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setAngleTuning(7);
    assert.equal(state.config[49], 7);
    assert.equal((await client.readStatus()).angleTuning, 7);

    await client.setAngleTuning(-15);
    assert.equal(state.config[49], 0xf1, "two's complement on the wire");
    assert.equal((await client.readStatus()).angleTuning, -15);

    await assert.rejects(() => client.setAngleTuning(45), /-30 to 30/);
    await assert.rejects(() => client.setAngleTuning(-45), /-30 to 30/);
  });

  it("setDpiStageCount rewrites only the count", async () => {
    const { device, state } = fakeDevice();
    const client = new MchoseHidClient(device);
    await client.readStatus();
    const before = [...state.config];
    await client.setDpiStageCount(4);
    assert.equal(state.config[16], 4);
    for (let i = 0; i < before.length; i += 1) {
      if (i === 16) continue;
      assert.equal(state.config[i], before[i], `byte ${i} untouched`);
    }
    await assert.rejects(() => client.setDpiStageCount(0), /1-6/);
    await assert.rejects(() => client.setDpiStageCount(7), /1-6/);
  });

  /**
   * Over a cable the host talks to the mouse itself (0x4021 for an Ultra+),
   * not the shared receiver id, and the *wired* half of the byte pair is the
   * live one. Confirmed on hardware with the cable plugged in.
   */
  it("reads the wired half when connected over a cable", async () => {
    const { device, state } = fakeDevice({ productId: 0x4021 } as Partial<HIDDevice>);
    // Give the two links different settings so the wrong one is obvious.
    state.config[1] = 0x10; // wired: rate index 1 (500 Hz), stage 0
    state.config[2] = 0x33; // wireless: rate index 3, stage 3
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.connectionType, "Wired");
    assert.equal(status.pollingRateHz, 500, "the wired byte, not the wireless one");
    assert.equal(status.activeDpiStage, 0);
  });

  it("a wired write moves the wired byte and leaves the wireless one alone", async () => {
    const { device, state } = fakeDevice({ productId: 0x4021 } as Partial<HIDDevice>);
    const client = new MchoseHidClient(device);
    await client.readStatus();
    const wirelessBefore = state.config[2];

    await client.setPollingRate(500);
    assert.equal(state.config[1] >> 4, 1, "wired rate index moved");
    assert.equal(state.config[2], wirelessBefore, "wireless byte untouched");
    assert.equal((await client.readStatus()).pollingRateHz, 500);
  });

  it("degrades to identity-only when the mouse never answers", async () => {
    const { device } = fakeDevice({
      receiveFeatureReport: async () => new DataView(new ArrayBuffer(66)),
    });
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.batteryPercent, null);
    assert.equal(status.batteryState, "Unknown");
    assert.equal(status.dpiStages, undefined);
    assert.equal(status.ui?.settingsReady, false, "no settings grid without a config read");
  });

  it("never mistakes another command's reply for a configuration", async () => {
    // The shared reply buffer still holds the battery answer.
    const { device } = fakeDevice({
      receiveFeatureReport: async (id: number) =>
        wireReply(id as number, MCHOSE_COMMAND.battery, BATTERY),
    });
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.dpiStages, undefined, "a battery payload is not accepted as config");
    assert.equal(status.ui?.settingsReady, false);
  });

  it("getDpiOptions is callable, as the app calls it for every client", () => {
    assert.deepEqual(new MchoseHidClient(fakeDevice().device).getDpiOptions(), []);
  });
});
