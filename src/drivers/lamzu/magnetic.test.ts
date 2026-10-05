import assert from "node:assert/strict";
import test from "node:test";

import { LamzuHidClient } from "./hid.ts";
import { LAMZU_VENDOR_ID, lamzuProduct } from "@openmouse/protocol/lamzu";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout } };
globals.window ??= { setTimeout };

interface Options { productId?: number; calibrated?: boolean; calibration?: Array<Record<string, number>> }

function v4gt(options: Options = {}) {
  const state = {
    types: [3, 3], calibrated: options.calibrated ?? true, recal: false,
    travel: [[4, 9], [4, 9]], rapid: [0, 0], writes: [] as string[], step: 0,
  };
  const sent: Uint8Array[] = [];
  const device = {
    vendorId: LAMZU_VENDOR_ID, productId: options.productId ?? 0x0098, productName: "Leviathan V4 GT", opened: true,
    collections: [{ usagePage: 0xff00, usage: 1, type: 1, children: [], featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }], inputReports: [], outputReports: [] }],
    open: async () => {}, close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => { sent.push(new Uint8Array(data)); },
    receiveFeatureReport: async () => {
      const q = sent[sent.length - 1]!;
      const page = q[4]!, command = q[5]!, a = q.subarray(6);
      const reply = new Uint8Array(64);
      reply[0] = 0xa1; reply[3] = q[3]!; reply[4] = page; reply[5] = command;
      const key = (page << 8) | command;
      let payload: number[] = [1, 1, 0, 1];
      switch (key) {
        case 0x0081: payload = [0, 0, 1, 2, 3, 4]; break;
        case 0x0083: payload = [0, 76]; break;
        case 0x0085: payload = [1]; break;
        case 0x0087: payload = [1, 0, 60]; break;
        case 0x0088: payload = [1, 4]; break;
        case 0x0181: payload = [1, 1, 0x06, 0x40, 0x06, 0x40]; break;
        case 0x0182: payload = [1, 1]; break;
        case 0x0180: payload = [1, 0x01]; break;
        case 0x0188: payload = [1, 0x01]; break;
        case 0x0086 + 0x0300: payload = [0, 0, 0, 0, state.calibrated ? 0 : 1, state.recal ? 64 : 0]; break;
        case 0x0095: payload = [0, state.types[0]!, state.types[1]!]; break;
        case 0x0082: payload = [0, 255]; break;
        case 0x0015: state.types = [a[1]!, a[2]!]; state.writes.push("types"); break;
        case 0x0385: payload = [a[0]!, a[1]!, state.travel[a[1]! - 1]![0]!, state.travel[a[1]! - 1]![1]!]; break;
        case 0x0305: state.travel[a[1]! - 1] = [a[2]!, a[3]!]; state.writes.push("travel"); break;
        case 0x0098: payload = [a[0]!, a[1]!, state.rapid[a[1]! - 1]!]; break;
        case 0x0018: state.rapid[a[1]! - 1] = a[2]!; state.writes.push("rapid"); break;
        case 0x0307: {
          payload = new Array(40).fill(0);
          if (a[0] === 5 || a[0] === 3) {
            payload[21] = 7;
            const frame = options.calibration?.[Math.min(state.step, options.calibration.length - 1)] ?? { state: 7 };
            state.step += 1;
            payload[1] = frame.state ?? 0; payload[3] = frame.code ?? 0; payload[19] = frame.mask ?? 0;
            payload[24] = frame.left ?? 0; payload[25] = frame.right ?? 0;
          }
          break;
        }
      }
      reply.set(payload, 6);
      if (key !== 0x0307) reply[3] = payload.length;
      return new DataView(reply.buffer);
    },
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as HIDDevice;
  return { device, sent, state };
}

test("the Leviathan V4 GT is catalogued as a magnetic RAWM mouse on both connections", () => {
  assert.equal(lamzuProduct(LAMZU_VENDOR_ID, 0x0098)?.magnetic, true);
  assert.equal(lamzuProduct(LAMZU_VENDOR_ID, 0x0099)?.wireless, true);
  assert.equal(lamzuProduct(LAMZU_VENDOR_ID, 0x0098)?.brand, "RAWM");
  assert.equal(LamzuHidClient.isSupported(v4gt().device), true);
});

test("status carries the magnetic buttons", async () => {
  const { device } = v4gt();
  const status = await new LamzuHidClient(device).readStatus();
  assert.equal(status.brand, "RAWM");
  const magnetic = status.magneticButtons!;
  assert.deepEqual(magnetic.buttons.map((button) => button.switchType), ["magnetic", "magnetic"]);
  assert.deepEqual(magnetic.buttons.map((button) => [button.triggerPoint, button.releasePoint, button.rapidTrigger, button.rapidTriggerEnabled]), [[4, null, null, false], [4, null, null, false]]);
  assert.equal(magnetic.calibration, "calibrated");
  assert.equal(magnetic.rapidTriggerUnit, "ms");
});

test("an uncalibrated mouse reads as optical and needing calibration", async () => {
  const { device } = v4gt({ calibrated: false });
  const magnetic = (await new LamzuHidClient(device).readStatus()).magneticButtons!;
  assert.deepEqual(magnetic.buttons.map((button) => button.switchType), ["optical", "optical"]);
  assert.equal(magnetic.calibration, "needed");
});

test("trigger, release and rapid trigger writes are read back", async () => {
  const { device, state } = v4gt();
  const client = new LamzuHidClient(device);
  assert.equal(await client.setMagneticTriggerPoint(1, 7), 7);
  assert.deepEqual(state.travel[1], [7, 9]);
  assert.equal(await client.setMagneticReleasePoint(1, 5), 5);
  assert.deepEqual(state.travel[1], [7, 5]);
  await client.setMagneticReleasePoint(1, null);
  assert.deepEqual(state.travel[1], [7, 9]);
  assert.deepEqual(await client.setMagneticRapidTrigger(0, true, 6), { enabled: true, level: 6 });
  assert.equal(state.rapid[0], 6);
  await client.setMagneticRapidTrigger(0, false, 6);
  assert.equal(state.rapid[0], 0);
  await assert.rejects(() => client.setMagneticTriggerPoint(0, 11), /1 to 10/);
  await assert.rejects(() => client.setMagneticReleasePoint(0, 9), /other than 9/);
  await assert.rejects(() => client.setMagneticRapidTrigger(0, true, 16), /1 to 15/);
});

test("the switch type is written with the model id and confirmed", async () => {
  const { device, state } = v4gt();
  await new LamzuHidClient(device).setMagneticSwitchTypes(["optical", "magnetic"]);
  assert.deepEqual(state.types, [2, 3]);
});

test("Magnetic is refused until the switches are calibrated", async () => {
  const { device, state } = v4gt({ calibrated: false });
  const client = new LamzuHidClient(device);
  await assert.rejects(() => client.setMagneticSwitchTypes(["magnetic", "optical"]), /Calibrate/);
  assert.equal(state.writes.includes("types"), false);
  await client.setMagneticSwitchTypes(["optical", "optical"]);
});

test("calibration reports progress and resolves on success", async () => {
  const { device } = v4gt({ calibration: [
    { state: 0 }, { state: 10, mask: 12 }, { state: 10, mask: 16, left: 60, right: 40 }, { state: 11, mask: 3, left: 100, right: 100 }, { state: 6 }, { state: 7 },
  ] });
  const messages: string[] = [];
  await new LamzuHidClient(device).calibrateMagneticButtons((progress) => messages.push(progress.message));
  assert.ok(messages.some((message) => message.includes("Left: Press and hold fully")));
  assert.equal(messages.at(-1), "Calibration Successful");
});

test("a failed calibration rejects with the mouse's own reason", async () => {
  const { device } = v4gt({ calibration: [{ state: 0 }, { state: 10, mask: 12 }, { state: 8, code: 4 }] });
  await assert.rejects(() => new LamzuHidClient(device).calibrateMagneticButtons(() => {}), /Unstable calibration data/);
});
