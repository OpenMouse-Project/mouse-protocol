import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MchoseV3HidClient } from "./v3-hid.ts";
import { MchoseHidClient } from "./hid.ts";
import { MchoseDockHidClient } from "./dock-hid.ts";
import {
  MCHOSE_V3_BODY_LENGTH,
  MCHOSE_V3_COMMAND,
  mchoseV3IsBusy,
  mchoseV3IsRejection,
  mchoseV3Payload,
} from "@openmouse/protocol/mchose";

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
  /** Answer these commands with the firmware's refusal frame. */
  reject?: number[];
  /** Answer everything with the one-byte ask-again a stranded receiver sends. */
  busy?: boolean;
  /** Override the `0x0900` reply, to replay a real capture. */
  deviceInfo?: number[];
}

function fakeMouse(options: FakeOptions = {}) {
  const listeners: Array<(event: unknown) => void> = [];
  const sent: number[] = [];
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
      if (options.reject?.includes(command)) {
        // Command 0x0000, checksum flag clear, 0xff in the sequence byte.
        const nak = new Uint8Array(MCHOSE_V3_BODY_LENGTH);
        nak.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00]);
        queueMicrotask(() => { emit(nak); });
        return;
      }
      if (options.busy) {
        queueMicrotask(() => { emit(frame(command, [0xff])); });
        return;
      }
      if (options.silent?.includes(command)) return;
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

  return { device, sent, sentData };
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

  it("offers no settings, and says why", async () => {
    const { device } = fakeMouse();
    const client = new MchoseV3HidClient(device);
    const status = await client.readStatus();

    assert.equal(status.ui!.settingsReady, false, "nothing here can be written yet");
    assert.equal(status.ui!.valuesVerified, true, "but what is shown was read off the mouse");
    assert.match(status.ui!.statusNote!, /cannot change them yet/);
    // The read-only promise is part of the contract, not just the prose.
    assert.equal("setDpi" in client, false);
    assert.equal("setPollingRate" in client, false);
    assert.equal("setLiftOffDistance" in client, false);
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

/**
 * Three reply shapes a real A7 V3 Ultra+ sends that are not data, captured
 * 2026-09-12. Mistaking any of them for silence is what made a live mouse look
 * dead.
 */
describe("MCHOSE A7 V3 reply handling", () => {
  it("recognises the refusal the firmware sends for an unsupported command", () => {
    // Verbatim: what 0x0901 answers, about a second after every request.
    const nak = new Uint8Array(MCHOSE_V3_BODY_LENGTH);
    nak.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00]);
    assert.equal(mchoseV3IsRejection(nak), true);
    // It carries command 0x0000, so it can never be mistaken for a payload.
    assert.equal(mchoseV3Payload(nak, MCHOSE_V3_COMMAND.readVersion), null);

    // A real reply is not a refusal.
    const real = frame(MCHOSE_V3_COMMAND.readLiftOff, [0x04]);
    assert.equal(mchoseV3IsRejection(real), false);
  });

  it("recognises the one-byte ask-again a receiver sends with no mouse behind it", () => {
    const payload = mchoseV3Payload(
      frame(MCHOSE_V3_COMMAND.readDeviceInfo, [0xff]), MCHOSE_V3_COMMAND.readDeviceInfo,
    )!;
    assert.equal(mchoseV3IsBusy(payload), true);

    // Stricter than M HUB's own test, which looks at the first byte alone: a
    // button table legitimately starts with 0xff when button one is unassigned.
    const buttons = new Uint8Array([0xff, 0xff, 0xff, 0x00, 0x00, 0x02]);
    assert.equal(mchoseV3IsBusy(buttons), false);
  });

  it("gives up on a refused command instead of spending the whole budget", async () => {
    const { device, sent } = fakeMouse({ reject: [MCHOSE_V3_COMMAND.readVersion] });
    const status = await new MchoseV3HidClient(device).readStatus();

    const versionAsks = sent.filter((c) => c === MCHOSE_V3_COMMAND.readVersion).length;
    assert.equal(versionAsks, 1, "asked once, told no, moved on");
    // And a refusal on one command must not poison the rest of the read.
    assert.equal(status.name, "MCHOSE A7 V3 Ultra+");
    assert.equal(status.dpi, 800);
    assert.deepEqual(status.firmware, []);
  });

  it("keeps reading the rest of the status after a command is refused", async () => {
    const { device, sent } = fakeMouse({ reject: [MCHOSE_V3_COMMAND.readVersion] });
    await new MchoseV3HidClient(device).readStatus();
    // A device that says "no" is awake; the old code treated it as silence and
    // abandoned every command after it.
    for (const command of [
      MCHOSE_V3_COMMAND.readDeviceInfo,
      MCHOSE_V3_COMMAND.readSettings,
      MCHOSE_V3_COMMAND.readDpi,
      MCHOSE_V3_COMMAND.readButtons,
    ]) {
      assert.ok(sent.includes(command), `0x${command.toString(16)} was still asked`);
    }
  });

  it("stops asking a receiver whose mouse is not reachable, and says so", async () => {
    // A real receiver reports the paired mouse's name, which is how the panel
    // still names the model while the mouse itself is unreachable.
    const { device, sent } = fakeMouse({ busy: true, productName: "MCHOSE A7 V3 Ultra+" });
    const status = await new MchoseV3HidClient(device).readStatus();

    assert.equal(
      sent.filter((c) => c === MCHOSE_V3_COMMAND.readDeviceInfo).length, 2,
      "one retry, then stop — each ask costs a second on real hardware",
    );
    assert.match(status.ui!.statusNote!, /not reachable/);
    assert.doesNotMatch(status.ui!.statusNote!, /did not answer/);
    // The model still comes from the product string, so the panel is not blank.
    assert.equal(status.name, "MCHOSE A7 V3 Ultra+");
  });

  it("still concludes nothing is listening when nothing ever arrives", async () => {
    const { device } = fakeMouse({ silent: Object.values(MCHOSE_V3_COMMAND) });
    const status = await new MchoseV3HidClient(device).readStatus();
    assert.match(status.ui!.statusNote!, /did not answer/);
  });
});
