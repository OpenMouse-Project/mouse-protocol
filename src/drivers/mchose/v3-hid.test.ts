import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MchoseV3HidClient } from "./v3-hid.ts";
import { MchoseHidClient } from "./hid.ts";
import { MchoseDockHidClient } from "./dock-hid.ts";
import { MCHOSE_V3_BODY_LENGTH, MCHOSE_V3_COMMAND } from "@openmouse/protocol/mchose";

/** What an A7 V3 Ultra+ behind its receiver would answer, command by command. */
const ANSWERS: Readonly<Record<number, number[]>> = {
  [MCHOSE_V3_COMMAND.readDeviceInfo]: [
    0x37, 0x38, 0x33, 0x40, 0x03, 0x01, 0x00, 0x04, 0x20, 0x00, 0x01, 0x00, 0x57, 0x02,
  ],
  // Profile 1, wired slot 3 / wireless slot 6, stage 2, ten-minute sleep,
  // sensor 0x45 (lift-off 2, ripple on, eSports), −15°, 8/4 ms debounce.
  [MCHOSE_V3_COMMAND.readSettings]: [
    0x01, 0x32, 0x62, 0x0a, 0x01, 0x45, 0xf1, 0x08, 0x04,
  ],
  [MCHOSE_V3_COMMAND.readDpi]: [
    0x01, 0x00, 0x04, 0x01, 0x00,
    0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x80, 0x0c, 0x00, 0x19, 0x50, 0xc3,
  ],
  // The Ultra+ keeps lift-off behind its own command: step 4 of five.
  [MCHOSE_V3_COMMAND.readLiftOff]: [0x04],
  [MCHOSE_V3_COMMAND.readVersion]: [0x01, 0x07],
  [MCHOSE_V3_COMMAND.readButtons]: [
    0x01, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x02,
    0x00, 0x00, 0x04,
    0x02, 0x00, 0x42,
    0xff, 0x00, 0x00,
    0x05, 0x00, 0x01,
  ],
};

function frame(command: number, data: readonly number[]): Uint8Array {
  const body = new Uint8Array(MCHOSE_V3_BODY_LENGTH);
  body[0] = 0x01;
  body[1] = 0x01;
  body[2] = data.length;
  body[3] = command & 0xff;
  body[4] = (command >> 8) & 0xff;
  body.set(data, 7);
  let sum = 0;
  for (let index = 1; index <= 6 + data.length; index += 1) sum ^= body[index]!;
  body[7 + data.length] = sum;
  return body;
}

interface FakeOptions {
  productId?: number;
  productName?: string;
  /** Commands the device refuses to answer. */
  silent?: number[];
  /** Emit an unrelated input report before every real answer. */
  noisy?: boolean;
  /** Record writes but never apply them, as a firmware ignoring a command would. */
  ignoreWrites?: boolean;
  /** Override the `0x0900` reply, to replay a real capture. */
  deviceInfo?: number[];
}

/** Which slice of the fake's state each read command serves. */
const STATE_BY_READ: Readonly<Record<number, "settings" | "dpi" | "buttons" | "liftOff">> = {
  [MCHOSE_V3_COMMAND.readSettings]: "settings",
  [MCHOSE_V3_COMMAND.readDpi]: "dpi",
  [MCHOSE_V3_COMMAND.readButtons]: "buttons",
  [MCHOSE_V3_COMMAND.readLiftOff]: "liftOff",
};

/**
 * Apply a write the way the firmware would, so the driver's read-back
 * verification is actually exercised rather than always agreeing with itself.
 */
function applyWrite(
  state: { settings: number[]; dpi: number[]; buttons: number[]; liftOff: number[] },
  command: number,
  data: number[],
): void {
  switch (command) {
    case MCHOSE_V3_COMMAND.writeSettings:
      state.settings = data.slice(0, state.settings.length);
      break;
    case MCHOSE_V3_COMMAND.writeDpi: {
      // The write and read orders differ: the write puts hasSeparateY third
      // and the read puts it fifth. Getting this backwards in the fake would
      // hide a driver that had it backwards too.
      const [profile, axis, hasY, count, active, ...stages] = data;
      state.dpi = [profile!, axis!, count!, active!, hasY!, ...stages];
      break;
    }
    case MCHOSE_V3_COMMAND.writeLiftOff:
      state.liftOff = [data[1]!];
      break;
    case MCHOSE_V3_COMMAND.writeButtons:
      state.buttons = data.slice(3);
      break;
    default:
      break;
  }
}

function fakeMouse(options: FakeOptions = {}) {
  const listeners: Array<(event: unknown) => void> = [];
  const sent: number[] = [];
  /** Mutable device state, so a write is visible to the read that follows. */
  const state = {
    settings: [...ANSWERS[MCHOSE_V3_COMMAND.readSettings]!],
    dpi: [...ANSWERS[MCHOSE_V3_COMMAND.readDpi]!],
    buttons: [...ANSWERS[MCHOSE_V3_COMMAND.readButtons]!],
    liftOff: [...ANSWERS[MCHOSE_V3_COMMAND.readLiftOff]!],
  };
  /** Every write, by command, so the exact bytes can be asserted. */
  const writes = new Map();
  /** The data block sent with each command, so arguments can be asserted. */
  const sentData = new Map<number, number[]>();

  const emit = (body: Uint8Array): void => {
    const event = { data: new DataView(body.buffer.slice(0)) };
    for (const listener of [...listeners]) listener(event);
  };

  const device = {
    vendorId: 0x3837,
    productId: options.productId ?? 0x1014,
    productName: options.productName ?? "MCHOSE Receiver",
    opened: true,
    collections: [
      { usagePage: 0xff01, usage: 0x0001, type: 0, children: [], input: 0, output: 0, feature: 0 },
    ],
    open: async () => {},
    close: async () => {},
    addEventListener: (_type: string, fn: (event: unknown) => void) => { listeners.push(fn); },
    removeEventListener: (_type: string, fn: (event: unknown) => void) => {
      const at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
    },
    sendReport: async (id: number, data: ArrayBuffer | ArrayLike<number>) => {
      assert.equal(id, 0x4d, "every V3 command rides output report 0x4d");
      const body = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const command = body[3]! | (body[4]! << 8);
      sent.push(command);
      sentData.set(command, [...body.subarray(7, 7 + body[2]!)]);
      if (command >= 0x0100 && command <= 0x01ff) {
        writes.set(command, [...body.subarray(7, 7 + body[2])]);
        if (!options.ignoreWrites) applyWrite(state, command, writes.get(command));
        return;
      }
      if (options.silent?.includes(command)) return;
      const live = STATE_BY_READ[command];
      if (live) {
        const current = state[live];
        queueMicrotask(() => { emit(frame(command, current)); });
        return;
      }
      const answer = command === MCHOSE_V3_COMMAND.readDeviceInfo && options.deviceInfo
        ? options.deviceInfo
        : ANSWERS[command];
      if (!answer) return;
      queueMicrotask(() => {
        // The mouse pushes movement and battery down the same pipe; a driver
        // that took the first input report it saw would decode noise.
        if (options.noisy) emit(frame(0x09f0, [0xde, 0xad]));
        emit(frame(command, answer));
      });
    },
  } as unknown as HIDDevice;

  return { device, sent, sentData, writes };
}

describe("MCHOSE A7 V3 driver", () => {
  it("claims the V3 mice and receivers", () => {
    assert.ok(MchoseV3HidClient.isSupported(fakeMouse().device));
    assert.ok(MchoseV3HidClient.isSupported(fakeMouse({ productId: 0x4033 }).device));
    assert.ok(MchoseV3HidClient.isSupported(fakeMouse({ productId: 0x1018 }).device));
  });

  it("leaves the A7 V2 and the MagDock to their own drivers", () => {
    // The V2 shares this exact usage page, so only the id keeps them apart.
    const v2 = fakeMouse({ productId: 0x4021, productName: "MCHOSE A7 V2 Ultra+" });
    assert.equal(MchoseV3HidClient.isSupported(v2.device), false);
    assert.ok(MchoseHidClient.isSupported(v2.device), "the V2 driver still wants it");

    const dock = fakeMouse({ productId: 0x1012 });
    assert.equal(MchoseV3HidClient.isSupported(dock.device), false);
  });

  it("does not let the A7 V2 driver claim a V3 device", () => {
    // Before the V3 landed, the V2 matched on the usage page alone and would
    // have talked inverted feature reports at a mouse that speaks none.
    for (const productId of [0x4033, 0x1014, 0x1018]) {
      const device = fakeMouse({ productId }).device;
      assert.equal(
        MchoseHidClient.isSupported(device), false,
        `0x${productId.toString(16)} belongs to the V3 driver`,
      );
      assert.equal(MchoseDockHidClient.isSupported(device), false);
    }
  });

  it("reads a whole status off the receiver", async () => {
    const { device } = fakeMouse();
    const status = await new MchoseV3HidClient(device).readStatus();

    assert.equal(status.brand, "MCHOSE");
    // This fake's product string names no model, so the id in the device-info
    // reply is the fallback that resolves it.
    assert.equal(status.name, "MCHOSE A7 V3 Ultra+");
    assert.equal(status.batteryPercent, 87);
    assert.equal(status.batteryState, "Discharging");
    assert.equal(status.connectionType, "Wireless");
    assert.equal(status.dpi, 800, "stage 1 of the table");
    assert.deepEqual(status.dpiStages, [400, 800, 1600, 3200]);
    assert.equal(status.pollingRateHz, 8000, "wireless slot 6 is the top rate");
    assert.equal(status.activeProfile, 2, "the wire's 0-based profile shown from one");
    assert.equal(status.profileCount, 3);
    assert.equal(status.debounceMs, 8);
    assert.equal(status.sleepTimeout, 600);
    assert.equal(status.angleTuning, -15);
    assert.equal(status.rippleControl, true);
    assert.equal(status.motionSync, false);
    assert.equal(status.powerMode, "eSports");
    assert.deepEqual(status.firmware, ["Firmware 107"]);
  });

  it("takes lift-off from the dedicated command on a five-step model", () => {
    // 0x0009 answered 4, the top of the Ultra+'s ladder — the sensor byte's
    // own two bits say 2, which would be wrong here.
    const { device } = fakeMouse();
    return new MchoseV3HidClient(device).readStatus().then((status) => {
      assert.equal(status.liftOffDistance, "High");
      assert.match(status.ui!.statusNote!, /1\.7 mm/, "the real height survives in the note");
    });
  });

  it("ignores unrelated input reports while waiting for its answer", async () => {
    const { device } = fakeMouse({ noisy: true });
    const status = await new MchoseV3HidClient(device).readStatus();
    assert.equal(status.name, "MCHOSE A7 V3 Ultra+");
    assert.equal(status.dpi, 800);
  });

  it("degrades to a named, empty status when the mouse says nothing", async () => {
    const { device, sent } = fakeMouse({
      silent: Object.values(MCHOSE_V3_COMMAND),
      productId: 0x4033,
      productName: "MCHOSE A7 V3 Ultra+",
    });
    const status = await new MchoseV3HidClient(device).readStatus();

    // One command's retries are enough to conclude nothing is listening.
    // Spending the full budget on all six would stall the connect flow.
    assert.deepEqual(
      [...new Set(sent)], [MCHOSE_V3_COMMAND.readDeviceInfo],
      "the rest of the status is abandoned after the first silent command",
    );

    // Falls back to the product string rather than throwing the connect flow.
    assert.equal(status.name, "MCHOSE A7 V3 Ultra+");
    assert.equal(status.batteryPercent, null);
    assert.equal(status.dpi, 0);
    assert.equal(status.activeProfile, null);
    assert.equal(status.connectionType, "Wired", "its own id means the cable");
    assert.match(status.ui!.statusNote!, /did not answer/);
  });

  it("reports an unlinked mouse instead of showing the receiver's own state", async () => {
    const { device } = fakeMouse({ silent: [MCHOSE_V3_COMMAND.readSettings] });
    const status = await new MchoseV3HidClient(device).readStatus();
    assert.equal(status.name, "MCHOSE A7 V3 Ultra+", "the receiver still knows the model");
    assert.equal(status.activeProfile, null, "but nothing behind the link answered");
    assert.equal(status.dpi, 0);
  });

  /**
   * Replays the real A7 V3 Ultra+ capture: its 0x0900 reply carries 0x4026,
   * the id MCHOSE lists for the A5 V3 Ultra+. Before the product string won,
   * this mouse was named A5 V3 Ultra+ and inherited a 42,000 DPI ceiling and a
   * three-step lift-off ladder it does not have.
   */
  it("names the mouse from its product string, not its reported id", async () => {
    const { device } = fakeMouse({
      productName: "MCHOSE A7 V3 Ultra+",
      deviceInfo: [
        0x37, 0x38, 0x26, 0x40, 0x04, 0x00, 0x00, 0x00,
        0x00, 0x10, 0x02, 0x01, 0x55, 0x00, 0x08, 0xe4,
      ],
    });
    const status = await new MchoseV3HidClient(device).readStatus();
    assert.equal(status.name, "MCHOSE A7 V3 Ultra+");
    assert.equal(status.batteryPercent, 85);
    assert.equal(status.batteryState, "Charging");
    assert.equal(status.profileCount, 4);
  });

  it("asks 0x0901 which side it wants the version from", async () => {
    // Sent bare, the mouse answers with an empty block and no firmware at all.
    const { device, sentData } = fakeMouse();
    await new MchoseV3HidClient(device).readStatus();
    assert.deepEqual(sentData.get(MCHOSE_V3_COMMAND.readVersion), [0], "the mouse, not the receiver");
  });
});

describe("MCHOSE A7 V3 writes", () => {
  it("reads, edits and writes back the whole settings block", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setPollingRate(1000);

    const write = writes.get(MCHOSE_V3_COMMAND.writeSettings)!;
    assert.ok(write, "a settings write went out");
    // The block that came back from the read, with one nibble changed.
    assert.equal(write[0], 0x01, "the profile it read, not a default");
    assert.equal(write[3], 0x0a, "sleep untouched");
    assert.equal(write[5], 0x45, "sensor flags untouched");
    assert.equal(write[6], 0xf1, "the negative angle survived the round trip");
  });

  it("writes only the link it is connected through", async () => {
    const wireless = fakeMouse();
    await new MchoseV3HidClient(wireless.device).setPollingRate(1000);
    const overRf = wireless.writes.get(MCHOSE_V3_COMMAND.writeSettings)!;
    assert.equal(overRf[1], 0x32, "the wired byte is exactly what was read");
    assert.notEqual(overRf[2], 0x62, "and the wireless byte moved");

    const wired = fakeMouse({ productId: 0x4033 });
    await new MchoseV3HidClient(wired.device).setPollingRate(2000);
    const overCable = wired.writes.get(MCHOSE_V3_COMMAND.writeSettings)!;
    assert.equal(overCable[2], 0x62, "the wireless byte is exactly what was read");
    assert.notEqual(overCable[1], 0x32, "and the wired byte moved");
  });

  it("refuses a rate the model does not have, without writing anything", async () => {
    const { device, writes } = fakeMouse();
    await assert.rejects(
      new MchoseV3HidClient(device).setPollingRate(16000),
      /does not support/,
    );
    assert.equal(writes.has(MCHOSE_V3_COMMAND.writeSettings), false, "nothing was sent");
  });

  it("refuses a DPI outside the model's range, without writing anything", async () => {
    const { device, writes } = fakeMouse();
    await assert.rejects(new MchoseV3HidClient(device).setDpi(90000), RangeError);
    assert.equal(writes.has(MCHOSE_V3_COMMAND.writeDpi), false);
  });

  it("rounds a DPI to a step the firmware stores", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setDpi(1637);
    const write = writes.get(MCHOSE_V3_COMMAND.writeDpi)!;
    // Stage 1 is the active one in the fake's table; 1637 rounds to 1650.
    assert.deepEqual(write.slice(7, 9), [1650 & 0xff, 1650 >> 8]);
  });

  it("leaves the other DPI stages exactly as they were read", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setDpi(1650);
    const write = writes.get(MCHOSE_V3_COMMAND.writeDpi)!;
    assert.deepEqual(write.slice(5, 7), [0x90, 0x01], "stage 0 untouched");
    assert.deepEqual(write.slice(9, 11), [0x40, 0x06], "stage 2 untouched");
    assert.deepEqual(write.slice(15, 17), [0x50, 0xc3], "stage 5 untouched");
  });

  it("does not let the active stage point past a shortened list", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setDpiStageCount(1);
    const write = writes.get(MCHOSE_V3_COMMAND.writeDpi)!;
    assert.equal(write[3], 1, "one stage");
    assert.equal(write[4], 0, "and the active stage pulled back into range");
  });

  it("moves one sensor bit and preserves the rest of the byte", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setMotionSync(true);
    const write = writes.get(MCHOSE_V3_COMMAND.writeSettings)!;
    // Read sensor was 0x45: ripple on, eSports, lift-off 2.
    assert.equal(write[5], 0x55, "motion sync added, nothing else disturbed");
  });

  it("takes the dedicated lift-off command on a five-step model", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setLiftOffDistance("1.7 mm");
    assert.deepEqual(writes.get(MCHOSE_V3_COMMAND.writeLiftOff), [0x01, 4]);
    assert.equal(
      writes.has(MCHOSE_V3_COMMAND.writeSettings), false,
      "the sensor byte is not where this model keeps it",
    );
  });

  it("refuses a lift-off step the model does not have", async () => {
    const { device, writes } = fakeMouse();
    await assert.rejects(new MchoseV3HidClient(device).setLiftOffDistance("2 mm"), /no 2 mm/);
    assert.equal(writes.size, 0);
  });

  it("throws when the mouse reports something other than what it was told", async () => {
    // The mouse answers every read with its original block, so the read-back
    // never matches — which is exactly what a silently ignored write looks like.
    const { device } = fakeMouse({ ignoreWrites: true });
    await assert.rejects(
      new MchoseV3HidClient(device).setPollingRate(1000),
      /did not accept/,
    );
  });

  it("aborts rather than writing defaults over a block it could not read", async () => {
    const { device, writes } = fakeMouse({ silent: [MCHOSE_V3_COMMAND.readSettings] });
    await assert.rejects(
      new MchoseV3HidClient(device).setDebounceTime(4),
      /did not return its settings/,
    );
    assert.equal(writes.size, 0, "nothing invented and sent");
  });

  it("moves both primary debounce fields together", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setDebounceTime(4);
    const write = writes.get(MCHOSE_V3_COMMAND.writeSettings)!;
    assert.equal(write[7], 4);
    assert.equal(write[8], 4, "the right button cannot be left on a value nobody can see");
  });

  it("refuses a debounce the firmware will not take", async () => {
    const { device, writes } = fakeMouse();
    await assert.rejects(new MchoseV3HidClient(device).setDebounceTime(30), RangeError);
    assert.equal(writes.size, 0);
  });

  it("treats a zero sleep timeout as never", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setSleepTimeout(0);
    const write = writes.get(MCHOSE_V3_COMMAND.writeSettings)!;
    assert.equal(write[3], 0, "no minutes");
    assert.equal(write[4], 1, "and the mode byte agrees");
  });

  it("rewrites the button table with five entries untouched", async () => {
    const { device, writes } = fakeMouse();
    await new MchoseV3HidClient(device).setButtonMapping("Back", "Disabled");
    const write = writes.get(MCHOSE_V3_COMMAND.writeButtons)!;
    assert.deepEqual(write.slice(0, 3), [0x01, 0, 6], "profile, reserved, count");
    // The fake's table: left type 1 (4 bytes), then four 3-byte entries.
    assert.deepEqual(write.slice(3, 7), [0x01, 0x00, 0x00, 0x01], "left untouched");
    assert.equal(write[write.length - 3], 0x05, "the DPI button kept its own action");
  });

  it("refuses an action whose encoding has never been captured", async () => {
    const { device, writes } = fakeMouse();
    await assert.rejects(
      new MchoseV3HidClient(device).setButtonMapping("Back", "Teleport"),
      /Unknown button action/,
    );
    assert.equal(writes.has(MCHOSE_V3_COMMAND.writeButtons), false);
  });

  it("offers the settings grid now that something is behind it", async () => {
    const { device } = fakeMouse();
    const status = await new MchoseV3HidClient(device).readStatus();
    assert.equal(status.ui!.settingsReady, true);
    assert.ok(status.buttonOptions!.length > 100, "M HUB's whole vocabulary");
    assert.equal(status.buttonOptions![0], "Default");
    assert.ok(status.buttonOptions!.includes("Alt + Tab"));
    assert.equal(status.ui!.dpiStageEditor!.maxDpi, 50000, "this model's own ceiling");
    assert.match(status.ui!.statusNote!, /not been confirmed on hardware/);
  });
});
