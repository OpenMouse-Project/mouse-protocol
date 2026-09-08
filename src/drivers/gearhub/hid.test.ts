import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CMD,
  OPT0_DEBOUNCE,
  OPT0_FLAG_RIPPLE,
  OPT0_FLAGS,
  OPT0_REPORT_RATE,
  OPT0_SILENT_HEIGHT,
  OPT0_SLEEP_24G,
  OPT0_SLEEP_BT,
  OPT0_STRAIGHT_CORRECTION,
  REPORT_RATE_DECODE,
  encodeCommand,
} from "@openmouse/protocol/gearhub";
import { GearHubHidClient } from "./hid.ts";

const M5_PRO_RECEIVER = { vendorId: 0x3151, productId: 0x402d };
const M5_PRO_WIRED = { vendorId: 0x3151, productId: 0x4026 };

function vendorCollection() {
  return {
    usagePage: 0xffff,
    usage: 0x02,
    type: 0,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: [],
  } as unknown as HIDCollectionInfo;
}

/** Build a GET_USB_VERSION reply carrying a device id in bytes [1..4] LE. */
function usbVersionReply(deviceId: number): number[] {
  const reply = new Array(64).fill(0);
  reply[0] = CMD.GET_USB_VERSION;
  reply[1] = deviceId & 0xff;
  reply[2] = (deviceId >> 8) & 0xff;
  reply[3] = (deviceId >> 16) & 0xff;
  reply[4] = (deviceId >> 24) & 0xff;
  return reply;
}

/**
 * Build an OPTIONPARAM0 reply. Defaults mirror a fresh R2: 1000 Hz, debounce 2,
 * lift-off 0, both corrections off, 30 s standby.
 */
function opt0Reply(
  opts: {
    rate?: number;
    debounce?: number;
    lod?: number;
    straight?: boolean;
    ripple?: boolean;
    flags?: number;
    sleep?: number;
  } = {},
) {
  const reply = new Array(64).fill(0);
  reply[0] = CMD.GET_OPTIONPARAM0;
  reply[OPT0_REPORT_RATE] = opts.rate ?? 1;
  reply[OPT0_DEBOUNCE] = opts.debounce ?? 2;
  reply[OPT0_FLAGS] = (opts.flags ?? 0) | (opts.ripple ? OPT0_FLAG_RIPPLE : 0);
  reply[OPT0_STRAIGHT_CORRECTION] = opts.straight ? 1 : 0;
  reply[OPT0_SILENT_HEIGHT] = opts.lod ?? 0;
  const sleep = opts.sleep ?? 30;
  reply[OPT0_SLEEP_24G] = sleep & 0xff;
  reply[OPT0_SLEEP_24G + 1] = sleep >> 8;
  reply[OPT0_SLEEP_BT] = sleep & 0xff;
  reply[OPT0_SLEEP_BT + 1] = sleep >> 8;
  return reply;
}

/**
 * A receiver that behaves the way the real one does: it answers its own 0xF7
 * status poll itself, and only hands back a device reply after a checksummed
 * command followed by 0xFC.
 */
function fakeReceiver(options: {
  replies?: Record<number, number[]>;
  mouseOnline?: boolean;
  mouseBattery?: number;
  /** GET_USB_VERSION answer; defaults to the M5 Pro's 2285. */
  deviceId?: number;
  ids?: Partial<{ vendorId: number; productId: number }>;
} = {}) {
  const replies = {
    [CMD.GET_USB_VERSION]: usbVersionReply(options.deviceId ?? 2285),
    ...(options.replies ?? {}),
  };
  const sent: Uint8Array[] = [];
  let pending: number[] | null = null;

  const status = () => {
    const s = new Uint8Array(64);
    s[0] = 1;                                       // canRead
    s[1] = 0;                                       // keyboard battery
    s[2] = options.mouseBattery ?? 45;              // mouse battery
    s[3] = 1;                                       // keyboard offline
    s[4] = (options.mouseOnline ?? true) ? 0 : 1;   // mouse online when 0
    s[5] = 1;                                       // canSend
    return s;
  };

  let last = status();
  const device = {
    ...M5_PRO_RECEIVER,
    ...options.ids,
    productName: "2.4G Wireless Mouse",
    opened: true,
    collections: [vendorCollection()],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => {
      sent.push(new Uint8Array(data));
      if (data[0] === 0xf7) last = status();
      else if (data[0] === 0xf6) { /* select target */ }
      else if (data[0] === 0xfc) {
        const out = new Uint8Array(64);
        if (pending) out.set(pending);
        last = out;
      } else {
        pending = replies[data[0]] ?? null;
      }
    },
    receiveFeatureReport: async () => new DataView(last.buffer.slice(0)),
  };
  return { device: device as unknown as HIDDevice, sent };
}

/** Build a GET_KEYMATRIX reply. Slots default to Left/Right/Middle/Back/
 *  Forward/DPI-Loop; pass overrides as { slot: [d0,d1,d2,d3] }. */
function keyMatrixReply(overrides: Record<number, number[]> = {}) {
  const reply = new Array(64).fill(0);
  // The real GET_KEYMATRIX reply has no echo byte — it starts straight at the
  // slot-0 action.
  const defaults: Record<number, number[]> = {
    0: [1, 0, 0xf0, 0],
    1: [1, 0, 0xf1, 0],
    2: [1, 0, 0xf2, 0],
    3: [1, 0, 0xf3, 0],
    4: [1, 0, 0xf4, 0],
    5: [20, 0, 0, 0],
  };
  for (const [slot, v] of Object.entries({ ...defaults, ...overrides })) {
    const o = Number(slot) * 4;
    reply[o] = v[0]; reply[o + 1] = v[1]; reply[o + 2] = v[2]; reply[o + 3] = v[3];
  }
  return reply;
}

/** Build a GET_DPI reply with the given per-stage X values. */
function dpiReply(xs: number[], activeIndex: number, rgb: number[] = []) {
  const reply = new Array(64).fill(0);
  reply[0] = CMD.GET_DPI;
  reply[2] = activeIndex;
  reply[3] = xs.length;
  xs.forEach((value, i) => {
    reply[8 + i * 2] = value & 0xff;
    reply[9 + i * 2] = value >> 8;
    reply[24 + i * 2] = value & 0xff;
    reply[25 + i * 2] = value >> 8;
    if (rgb[i] !== undefined) {
      reply[40 + i * 3] = (rgb[i] >> 16) & 0xff;
      reply[41 + i * 3] = (rgb[i] >> 8) & 0xff;
      reply[42 + i * 3] = rgb[i] & 0xff;
    }
  });
  return reply;
}

describe("GearHubHidClient", () => {
  it("stamps the Bit7 checksum the hardware echoed back", () => {
    // Checksums observed live in the device's own replies.
    assert.equal(encodeCommand([CMD.GET_FIRMWARE])[7], 0x7f);
    assert.equal(encodeCommand([CMD.GET_USB_VERSION])[7], 0x70);
    assert.equal(encodeCommand([CMD.GET_OPTIONPARAM0])[7], 0x2c);
    assert.equal(encodeCommand([CMD.GET_DPI, 0x00])[7], 0x2b);
  });

  it("claims the GearHub-V5 transport product ids on VID 0x3151", () => {
    assert.equal(GearHubHidClient.isSupported(fakeReceiver().device), true);
    assert.equal(GearHubHidClient.isSupported(fakeReceiver({ ids: M5_PRO_WIRED }).device), true);
    // 0x503d is Fantech's WG14P on the same shared ODM vendor id.
    assert.equal(GearHubHidClient.isSupported(fakeReceiver({ ids: { productId: 0x503d } }).device), false);
    assert.equal(GearHubHidClient.isSupported(fakeReceiver({ ids: { vendorId: 0x046d } }).device), false);
  });

  it("relays over 2.4G but talks directly when wired", () => {
    assert.equal(new GearHubHidClient(fakeReceiver().device).transport, "dongle");
    assert.equal(new GearHubHidClient(fakeReceiver({ ids: M5_PRO_WIRED }).device).transport, "direct");
  });

  it("caps polling at 8 kHz on the receiver and 1 kHz wired", () => {
    assert.deepEqual(
      new GearHubHidClient(fakeReceiver().device).supportedPollingRates,
      [125, 250, 500, 1000, 2000, 4000, 8000],
    );
    assert.deepEqual(
      new GearHubHidClient(fakeReceiver({ ids: M5_PRO_WIRED }).device).supportedPollingRates,
      [125, 250, 500, 1000],
    );
  });

  it("decodes the DPI table captured from the real M5 Pro", async () => {
    // Live bytes: D4 00 02 06 00 00 00 2B  90 01 20 03 40 06 80 0C 00 19 90 65
    const xs = [400, 800, 1600, 3200, 6400, 26000];
    const { device } = fakeReceiver({ replies: { [CMD.GET_DPI]: dpiReply(xs, 2, [0, 0, 0x0000ff]) } });
    const { stages, activeIndex } = await new GearHubHidClient(device).getDpi();

    assert.equal(activeIndex, 2);
    assert.deepEqual(stages.map((s) => s.x), xs);
    assert.equal(stages[2].x, 1600, "active stage is 1600 DPI");
    assert.equal(stages[5].x, 26000, "PAW3395 tops out at 26000");
    assert.equal(stages[2].rgb, 0x0000ff);
  });

  it("reads the report rate from OPTIONPARAM0 byte 9", async () => {
    // The R2 read back code 1 at 1000 Hz; code 129 is 8000 Hz. NOT a 0..6 index.
    assert.equal(REPORT_RATE_DECODE[1], 1000);
    assert.equal(REPORT_RATE_DECODE[129], 8000);

    const { device } = fakeReceiver({ replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 129 }) } });
    assert.equal(await new GearHubHidClient(device).getReportRate(), 8000);
  });

  it("sets the report rate by patching OPTIONPARAM0, keeping the other bytes", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 1, debounce: 3, lod: 2 }) },
    });
    await new GearHubHidClient(device).setReportRate(8000);

    const write = sent.filter((buf) => buf[0] === CMD.SET_OPTIONPARAM0).at(-1);
    assert.ok(write, "a SET_OPTIONPARAM0 report should have been sent");
    assert.equal(write![OPT0_REPORT_RATE], 129, "report rate updated to the 8000 Hz code");
    assert.equal(write![10], 3, "debounce carried over");
    assert.equal(write![OPT0_SILENT_HEIGHT], 2, "lift-off carried over");
  });

  it("sets the lift-off distance by patching OPTIONPARAM0 byte 52", async () => {
    // No readStatus() first, so the generic fallback profile is in effect:
    // the common three stops, Low (0) / Medium (1) / High (2).
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 3, lod: 0 }) },
    });
    await new GearHubHidClient(device).setLiftOffDistance("High");

    const write = sent.filter((buf) => buf[0] === CMD.SET_OPTIONPARAM0).at(-1);
    assert.ok(write, "a SET_OPTIONPARAM0 report should have been sent");
    assert.equal(write![OPT0_SILENT_HEIGHT], 2, "High maps to index 2 on a three-stop list");
    assert.equal(write![OPT0_REPORT_RATE], 3, "report rate carried over");
  });

  it("reads debounce, corrections and standby time from OPTIONPARAM0", async () => {
    const { device } = fakeReceiver({
      replies: {
        [CMD.GET_DPI]: dpiReply([1600], 0),
        [CMD.GET_OPTIONPARAM0]: opt0Reply({
          debounce: 4,
          straight: true,
          ripple: true,
          flags: 0x01, // some other flag bit already set
          sleep: 120,
        }),
      },
    });
    const status = await new GearHubHidClient(device).readStatus();
    assert.equal(status.debounceMs, 4);
    assert.equal(status.angleSnapping, true);
    assert.equal(status.rippleControl, true);
    assert.equal(status.sleepTimeout, 120);
  });

  it("sets debounce, keeping the report rate and lift-off", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 129, lod: 2, debounce: 2 }) },
    });
    await new GearHubHidClient(device).setDebounceTime(7);

    const write = sent.filter((buf) => buf[0] === CMD.SET_OPTIONPARAM0).at(-1)!;
    assert.equal(write[OPT0_DEBOUNCE], 7);
    assert.equal(write[OPT0_REPORT_RATE], 129, "report rate carried over");
    assert.equal(write[OPT0_SILENT_HEIGHT], 2, "lift-off carried over");
  });

  it("clamps debounce to 0..10", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply() },
    });
    const client = new GearHubHidClient(device);
    assert.equal(await client.setDebounceTime(99), 10);
    assert.equal(sent.filter((b) => b[0] === CMD.SET_OPTIONPARAM0).at(-1)![OPT0_DEBOUNCE], 10);
  });

  it("toggles straight correction as byte 53", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ straight: false }) },
    });
    await new GearHubHidClient(device).setAngleSnapping(true);
    assert.equal(
      sent.filter((b) => b[0] === CMD.SET_OPTIONPARAM0).at(-1)![OPT0_STRAIGHT_CORRECTION],
      1,
    );
  });

  it("toggles ripple correction as flag bit 2, leaving the other flags", async () => {
    const { device, sent } = fakeReceiver({
      // flags 0x01 = an unrelated bit that must survive the toggle.
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ flags: 0x01, ripple: false }) },
    });
    await new GearHubHidClient(device).setRippleControl(true);
    const write = sent.filter((b) => b[0] === CMD.SET_OPTIONPARAM0).at(-1)!;
    assert.equal(write[OPT0_FLAGS] & OPT0_FLAG_RIPPLE, OPT0_FLAG_RIPPLE, "ripple bit set");
    assert.equal(write[OPT0_FLAGS] & 0x01, 0x01, "the pre-existing flag bit survived");

    // …and clearing it leaves the other bit alone too.
    const { device: d2, sent: s2 } = fakeReceiver({
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ flags: 0x01, ripple: true }) },
    });
    await new GearHubHidClient(d2).setRippleControl(false);
    const w2 = s2.filter((b) => b[0] === CMD.SET_OPTIONPARAM0).at(-1)!;
    assert.equal(w2[OPT0_FLAGS] & OPT0_FLAG_RIPPLE, 0, "ripple bit cleared");
    assert.equal(w2[OPT0_FLAGS] & 0x01, 0x01, "the pre-existing flag bit survived");
  });

  it("writes the standby time to both the 2.4G and Bluetooth timers", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_OPTIONPARAM0]: opt0Reply({ sleep: 30 }) },
    });
    await new GearHubHidClient(device).setSleepTimeout(300);
    const write = sent.filter((b) => b[0] === CMD.SET_OPTIONPARAM0).at(-1)!;
    assert.equal(write[OPT0_SLEEP_24G] | (write[OPT0_SLEEP_24G + 1] << 8), 300);
    assert.equal(write[OPT0_SLEEP_BT] | (write[OPT0_SLEEP_BT + 1] << 8), 300);
  });

  it("advertises debounce and sleep capabilities", () => {
    const client = new GearHubHidClient(fakeReceiver().device);
    assert.equal(client.getDebounceMaxMs(), 10);
    assert.ok(client.getSleepOptions().includes(0), "0 = never is offered");
  });

  it("reads the button map out of the keymatrix", async () => {
    const { device } = fakeReceiver({
      replies: {
        [CMD.GET_DPI]: dpiReply([1600], 0),
        [CMD.GET_OPTIONPARAM0]: opt0Reply(),
        // slot 4 (Forward) is remapped to Middle on this unit.
        [CMD.GET_KEYMATRIX]: keyMatrixReply({ 4: [1, 0, 0xf2, 0] }),
      },
    });
    const status = await new GearHubHidClient(device).readStatus();
    assert.deepEqual(status.buttonMappings, {
      Left: "Left Click",
      Right: "Right Click",
      Middle: "Middle Click",
      Back: "Back",
      Forward: "Middle Click",
      DPI: "DPI Loop",
    });
    assert.ok(status.buttonOptions?.includes("Disabled"));
    assert.ok(status.buttonOptions?.includes("DPI Loop"));
  });

  it("labels an unrecognised (keyboard/macro) slot as Custom", async () => {
    const { device } = fakeReceiver({
      replies: {
        [CMD.GET_DPI]: dpiReply([1600], 0),
        [CMD.GET_OPTIONPARAM0]: opt0Reply(),
        [CMD.GET_KEYMATRIX]: keyMatrixReply({ 3: [0, 0, 0x1a, 0] }), // some keyboard key
      },
    });
    const status = await new GearHubHidClient(device).readStatus();
    assert.equal(status.buttonMappings?.Back, "Custom");
  });

  it("writes a button remap via SET_KEYMATRIX at the right slot", async () => {
    const { device, sent } = fakeReceiver();
    await new GearHubHidClient(device).setButtonMapping("Forward", "Middle Click");

    const write = sent.filter((buf) => buf[0] === CMD.SET_KEYMATRIX).at(-1)!;
    assert.equal(write[1], 0, "profile 0");
    assert.equal(write[2], 4, "Forward is slot 4");
    assert.deepEqual([write[8], write[9], write[10], write[11]], [1, 0, 0xf2, 0], "Middle Click value");
  });

  it("disables a button by writing the all-zero action", async () => {
    const { device, sent } = fakeReceiver();
    await new GearHubHidClient(device).setButtonMapping("Back", "Disabled");
    const write = sent.filter((buf) => buf[0] === CMD.SET_KEYMATRIX).at(-1)!;
    assert.equal(write[2], 3);
    assert.deepEqual([write[8], write[9], write[10], write[11]], [0, 0, 0, 0]);
  });

  it("rejects an unknown button or action", async () => {
    const client = new GearHubHidClient(fakeReceiver().device);
    await assert.rejects(() => client.setButtonMapping("Sniper", "Left Click"), /Unknown button/);
    await assert.rejects(() => client.setButtonMapping("Left", "Play Macro"), /Unsupported button action/);
  });

  it("rejects a lift-off level the model does not offer", async () => {
    // Resolve the M5 Pro profile (device id 2285, PAW3395): two stops, no "Medium".
    const { device } = fakeReceiver({
      replies: { [CMD.GET_DPI]: dpiReply([800, 1600], 0), [CMD.GET_OPTIONPARAM0]: opt0Reply() },
    });
    const client = new GearHubHidClient(device);
    await client.readStatus();

    await assert.rejects(
      () => client.setLiftOffDistance("Medium"),
      /not available on this model/,
    );
  });

  it("performs the receiver handshake in order before a read", async () => {
    const { device, sent } = fakeReceiver({ replies: { [CMD.GET_DPI]: dpiReply([1600], 0) } });
    await new GearHubHidClient(device).getDpi();

    const ids = sent.map((buf) => buf[0]);
    assert.equal(ids[0], 0xf6, "select the mouse as target first");
    assert.equal(sent[0][1], 0x05, "target code for the mouse");
    assert.ok(ids.indexOf(0xf7) > 0, "poll receiver status");
    const command = ids.indexOf(CMD.GET_DPI);
    assert.ok(command > ids.indexOf(0xf7), "command goes out after a ready poll");
    assert.ok(ids.indexOf(0xfc) > command, "notice-read comes after the command");
  });

  it("rejects an unanswered command instead of reading zeros as data", async () => {
    const { device } = fakeReceiver({ replies: {} });
    await assert.rejects(
      () => new GearHubHidClient(device).getDpi(),
      /not answered \(all-zero response\)/,
    );
  });

  it("reports an unlinked mouse as its own failure, not a protocol failure", async () => {
    const { device } = fakeReceiver({ mouseOnline: false });
    await assert.rejects(
      () => new GearHubHidClient(device).readStatus(),
      /no mouse is linked/,
    );
  });

  it("readStatus reports battery, link type, rate, lift-off and sensor", async () => {
    const { device } = fakeReceiver({
      mouseBattery: 45,
      replies: {
        [CMD.GET_DPI]: dpiReply([400, 800, 1600], 2),
        [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 129, lod: 1 }), // 8000 Hz, PAW3395 index 1 = High
      },
    });

    const status = await new GearHubHidClient(device).readStatus();
    assert.equal(status.brand, "Lingbao");
    assert.equal(status.name, "Lingbao M5 Pro");
    assert.equal(status.batteryPercent, 45);
    assert.equal(status.connectionType, "Wireless");
    assert.equal(status.connectionDetail, "2.4 GHz");
    assert.equal(status.dpi, 1600);
    assert.equal(status.activeDpiStage, 2);
    assert.deepEqual(status.dpiStages, [400, 800, 1600]);
    assert.equal(status.pollingRateHz, 8000);
    assert.equal(status.liftOffDistance, "High");
    assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"], "PAW3395 offers only two stops");
    assert.ok(status.firmware.includes("PixArt PAW3395"));
  });

  it("identifies the Attack Shark R2 by its GET_USB_VERSION device id", async () => {
    const { device } = fakeReceiver({
      deviceId: 1893,
      replies: {
        [CMD.GET_DPI]: dpiReply([400, 800, 1600, 5600, 8000, 42000], 2),
        [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 1, lod: 2 }), // 1000 Hz, PAW3950 index 2 = High
      },
    });
    const client = new GearHubHidClient(device);
    const status = await client.readStatus();

    assert.equal(status.brand, "Attack Shark");
    assert.equal(status.name, "Attack Shark R2");
    assert.equal(status.ui?.defaultDisplayName, "Attack Shark R2");
    assert.ok(status.firmware.includes("PixArt PAW3950"));
    assert.equal(status.pollingRateHz, 1000);
    assert.equal(status.liftOffDistance, "High");
    assert.equal(status.supportedLiftOffDistances, undefined, "PAW3950 offers all three stops");
    assert.equal(status.supportedPollingRates.at(-1), 8000);
    assert.ok(client.getDpiOptions().includes(42000), "DPI stops reach the PAW3950 ceiling");

    // After readStatus() the R2 profile is resolved, so its three-stop sensor
    // accepts "Medium" — which the two-stop fallback would have rejected.
    assert.equal(await client.setLiftOffDistance("Medium"), "Medium");
  });

  it("maps the later R2 firmware batch (device id 3009) to the R2 profile", async () => {
    const { device } = fakeReceiver({
      deviceId: 3009,
      replies: {
        [CMD.GET_DPI]: dpiReply([400, 800, 1600, 5600, 8000, 42000], 2),
        [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 1, lod: 2 }),
      },
    });
    const status = await new GearHubHidClient(device).readStatus();

    assert.equal(status.name, "Attack Shark R2");
    assert.ok(status.firmware.includes("PixArt PAW3950"));
  });

  it("falls back to the generic profile for an unknown device id", async () => {
    const { device } = fakeReceiver({
      deviceId: 9999,
      replies: { [CMD.GET_DPI]: dpiReply([400, 800, 1600], 0), [CMD.GET_OPTIONPARAM0]: opt0Reply() },
    });
    const client = new GearHubHidClient(device);
    const status = await client.readStatus();

    assert.equal(status.brand, "GearHub");
    assert.equal(status.name, "GearHub V5 mouse");
    assert.equal(client.getDpiOptions().at(-1), 42000, "DPI stops are not clamped below the platform ceiling");
  });

  it("survives a device that will not answer GET_USB_VERSION", async () => {
    const { device } = fakeReceiver({
      replies: {
        [CMD.GET_USB_VERSION]: new Array(64).fill(0),
        [CMD.GET_DPI]: dpiReply([800, 1600], 0),
        [CMD.GET_OPTIONPARAM0]: opt0Reply(),
      },
    });
    const status = await new GearHubHidClient(device).readStatus();

    assert.equal(status.brand, "GearHub");
    assert.equal(status.name, "GearHub V5 mouse");
  });

  it("keeps working when OPTIONPARAM0 cannot be read", async () => {
    // No GET_OPTIONPARAM0 reply — rate falls to a safe default, lift-off unreported.
    const { device } = fakeReceiver({ replies: { [CMD.GET_DPI]: dpiReply([1600], 0) } });
    const status = await new GearHubHidClient(device).readStatus();
    assert.equal(status.pollingRateHz, 1000);
    assert.equal(status.liftOffDistance, null);
  });

  it("setDpiForStage keeps the other stages and their indicator colours", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_DPI]: dpiReply([800, 1600, 3200], 0, [0x100000, 0x110000, 0x120000]) },
    });
    await new GearHubHidClient(device).setDpiForStage(6400, 6400, 1);

    const write = sent.filter((buf) => buf[0] === CMD.SET_DPI).at(-1);
    assert.ok(write, "a SET_DPI report should have been sent");
    const u16 = (buf: Uint8Array, i: number) => buf[i] | (buf[i + 1] << 8);
    assert.equal(write![3], 3, "stage count preserved");
    assert.equal(u16(write!, 8), 800);    // stage 0 untouched
    assert.equal(u16(write!, 10), 6400);  // stage 1 updated
    assert.equal(u16(write!, 12), 3200);  // stage 2 untouched
    assert.equal(u16(write!, 26), 6400);  // stage 1 Y updated
    assert.equal(write![40], 0x10);       // indicator colours carried over
    assert.equal(write![43], 0x11);
    assert.equal(write![46], 0x12);
  });

  it("setDpiStageColor recolours one stage and keeps the other stages", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_DPI]: dpiReply([800, 1600, 3200], 0, [0x111111, 0x222222, 0x333333]) },
    });
    const confirmed = await new GearHubHidClient(device).setDpiStageColor(1, "#40c8ff");

    assert.equal(confirmed, "#40c8ff");
    const write = sent.filter((buf) => buf[0] === CMD.SET_DPI).at(-1);
    assert.ok(write, "a SET_DPI report should have been sent");
    const u16 = (buf: Uint8Array, i: number) => buf[i] | (buf[i + 1] << 8);
    assert.equal(u16(write!, 8), 800);    // stage 0 resolution untouched
    assert.equal(u16(write!, 10), 1600);  // stage 1 resolution untouched
    assert.deepEqual([write![40], write![41], write![42]], [0x11, 0x11, 0x11]); // stage 0 colour kept
    assert.deepEqual([write![43], write![44], write![45]], [0x40, 0xc8, 0xff]); // stage 1 recoloured
    assert.deepEqual([write![46], write![47], write![48]], [0x33, 0x33, 0x33]); // stage 2 colour kept
    assert.equal(write![2], 0, "active stage kept, not moved to the edited one");
  });

  it("setActiveDpiStage re-sends the table with the new active index", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_DPI]: dpiReply([800, 1600, 3200], 0, [0x111111, 0x222222, 0x333333]) },
    });
    const at = await new GearHubHidClient(device).setActiveDpiStage(2);

    assert.equal(at, 2);
    const write = sent.filter((buf) => buf[0] === CMD.SET_DPI).at(-1);
    assert.ok(write, "a SET_DPI report should have been sent");
    assert.equal(write![2], 2, "active index moved to stage 3");
    const u16 = (buf: Uint8Array, i: number) => buf[i] | (buf[i + 1] << 8);
    assert.equal(u16(write!, 8), 800);    // resolutions untouched
    assert.equal(u16(write!, 12), 3200);
    assert.deepEqual([write![40], write![43], write![46]], [0x11, 0x22, 0x33]); // colours untouched
  });

  it("setActiveDpiStage clamps an out-of-range index", async () => {
    const { device, sent } = fakeReceiver({
      replies: { [CMD.GET_DPI]: dpiReply([800, 1600], 0) },
    });
    assert.equal(await new GearHubHidClient(device).setActiveDpiStage(9), 1);
    assert.equal(sent.filter((buf) => buf[0] === CMD.SET_DPI).at(-1)![2], 1);
  });

  it("readStatus reports every DPI stage colour as #rrggbb", async () => {
    const { device } = fakeReceiver({
      deviceId: 1893,
      replies: {
        [CMD.GET_DPI]: dpiReply([400, 800, 1600], 1, [0x000000, 0xff8000, 0x00ff00]),
        [CMD.GET_OPTIONPARAM0]: opt0Reply({ rate: 1, lod: 2 }),
      },
    });
    const status = await new GearHubHidClient(device).readStatus();

    assert.deepEqual(status.dpiStageColors, ["#000000", "#ff8000", "#00ff00"]);
  });

  it("refuses a rate the wired mode cannot reach", async () => {
    const client = new GearHubHidClient(fakeReceiver({ ids: M5_PRO_WIRED }).device);
    await assert.rejects(() => client.setPollingRate(8000), /Unsupported rate 8000 Hz/);
  });
});
