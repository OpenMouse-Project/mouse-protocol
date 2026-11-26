import assert from "node:assert/strict";
import test from "node:test";

import {
  OT_COMTYPE,
  OT_EFFECT_SIZE,
  OT_PAYLOAD_INDEX,
  OT_PROFILE_BLOCK,
  otDecodeEffect,
  otEncodeEffect,
  type OtEffect,
} from "@openmouse/protocol/endgame-gear-ot";
import { EggOp1HidClient } from "./egg-op1-hid.ts";
import { EggOtHidClient } from "./egg-ot-hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

function sampleEffect(): OtEffect {
  return {
    transferFlags: 0,
    profileIndex: 1,
    activeProfile: 0,
    maxProfile: 5,
    cpi: [400, 800, 1600, 3200],
    profileFlags: 0,
    cpiIndex: 1,
    pollrateIndex: 0,
    pollRates: [0, 1, 2],
    sensitivityX: 10,
    sensitivityY: 10,
    dcuThreshold: 1,
    acceleration: 0,
    angleSnap: 0,
    jitterCorrection: 0,
    red: [0, 0, 255, 255],
    green: [0, 255, 255, 0],
    blue: [255, 0, 0, 0],
    buttonRemap: [0, 1, 4, 6, 5, 9, 9],
    lcdBrightness: 0,
    lcdContrast: 0,
    winPointerSpeed: 10,
    winSpare: 0,
    hidUsage: [0, 0, 0, 0, 0, 0, 0],
    modifier: [0, 0, 0, 0, 0, 0, 0],
    profileName: "Gaming",
    cpiY: [400, 800, 1600, 3200],
    wirelessMode: 0,
    rgbMode: 1,
    rgbRed: 255,
    rgbGreen: 0,
    rgbBlue: 0,
    rgbBrightness: 7,
    rgbSpeed: 3,
  };
}

const FIRST = OT_EFFECT_SIZE - 68;

/**
 * A vendor-shaped OT mouse: answers the six profile-block queries with
 * ack-then-response, applies setProfileData slices to its effect image, and
 * records firmware packets. Block surgery mirrors the vendor tool, written
 * out independently of otEncodeProfilePacket.
 */
function fakeOtMouse({ productId = 0x1905, silentSaves = false } = {}) {
  const effect = otEncodeEffect(sampleEffect());
  const sent: string[] = [];
  let queue: Uint8Array[] = [];
  let firmwarePackets = 0;
  let firmwareSetup: Uint8Array | null = null;
  let resets = 0;
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" ");

  const ack = (): Uint8Array => {
    const out = new Uint8Array(64);
    out[1] = OT_COMTYPE.ack;
    return out;
  };
  const response = (comtype: number, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(64);
    out[1] = comtype & 0xff;
    out.set(payload.subarray(0, 61), 3);
    return out;
  };
  const blockSlice = (block: number): Uint8Array => {
    const out = new Uint8Array(61);
    if (block === OT_PROFILE_BLOCK.main) {
      out.set(effect.subarray(0, FIRST), 0);
      return out;
    }
    const starts: Record<number, number> = {
      [OT_PROFILE_BLOCK.keyboard]: FIRST,
      [OT_PROFILE_BLOCK.name]: FIRST + 21,
      [OT_PROFILE_BLOCK.cpiY]: FIRST + 53,
      [OT_PROFILE_BLOCK.wireless]: FIRST + 61,
      [OT_PROFILE_BLOCK.rgb]: FIRST + 62,
    };
    const lengths: Record<number, number> = {
      [OT_PROFILE_BLOCK.keyboard]: 21,
      [OT_PROFILE_BLOCK.name]: 32,
      [OT_PROFILE_BLOCK.cpiY]: 8,
      [OT_PROFILE_BLOCK.wireless]: 1,
      [OT_PROFILE_BLOCK.rgb]: 6,
    };
    // Hardware shape: block id + header echo, slice at payload + 4.
    out[0] = block;
    out.set(effect.subarray(1, 4), 1);
    out.set(effect.subarray(starts[block]!, starts[block]! + lengths[block]!), 4);
    return out;
  };

  const device = {
    vendorId: 0x3367,
    productId,
    productName: "OT Mouse",
    opened: true,
    collections: [{
      usagePage: 0xffa1,
      usage: 0x00a5,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 63 }] }],
    }],
    async open() {},
    async close() {},
    addEventListener() {},
    removeEventListener() {},
    async sendFeatureReport(reportId: number, data: BufferSource) {
      const bytes = new Uint8Array(data as ArrayBuffer);
      const full = new Uint8Array(64);
      full.set(bytes.subarray(0, 63), 1);
      const comtype = full[1];
      const block = full[OT_PAYLOAD_INDEX];
      sent.push(`${comtype.toString(16)}:${block.toString(16)} ${hex(full)}`);
      queue = [ack()];
      if (comtype === OT_COMTYPE.queryProfileData) {
        queue.push(response(OT_COMTYPE.queryProfileData, blockSlice(block)));
      } else if (comtype === OT_COMTYPE.setProfileData) {
        if (silentSaves) {
          queue = [];
        } else if (block === OT_PROFILE_BLOCK.main) {
          effect.set(full.subarray(OT_PAYLOAD_INDEX, OT_PAYLOAD_INDEX + FIRST), 0);
          queue.push(response(comtype, new Uint8Array(61)));
        } else {
          const starts: Record<number, number> = {
            [OT_PROFILE_BLOCK.keyboard]: FIRST,
            [OT_PROFILE_BLOCK.name]: FIRST + 21,
            [OT_PROFILE_BLOCK.cpiY]: FIRST + 53,
            [OT_PROFILE_BLOCK.wireless]: FIRST + 61,
            [OT_PROFILE_BLOCK.rgb]: FIRST + 62,
          };
          const lengths: Record<number, number> = {
            [OT_PROFILE_BLOCK.keyboard]: 21,
            [OT_PROFILE_BLOCK.name]: 32,
            [OT_PROFILE_BLOCK.cpiY]: 8,
            [OT_PROFILE_BLOCK.wireless]: 1,
            [OT_PROFILE_BLOCK.rgb]: 6,
          };
          effect.set(full.subarray(OT_PAYLOAD_INDEX + 1, OT_PAYLOAD_INDEX + 4), 1);
          effect.set(
            full.subarray(OT_PAYLOAD_INDEX + 4, OT_PAYLOAD_INDEX + 4 + lengths[block]!),
            starts[block]!,
          );
          queue.push(response(comtype, new Uint8Array(61)));
        }
      } else if (comtype === OT_COMTYPE.queryFirmwareVersion) {
        queue.push(response(OT_COMTYPE.queryFirmwareVersion, new Uint8Array([0x37, 0x01, 0, 0])));
      } else if (comtype === OT_COMTYPE.firmwareDlSetup) {
        firmwareSetup = full.slice();
        queue.push(response(comtype, new Uint8Array(61)));
      } else if (comtype === OT_COMTYPE.firmwareDataPacket) {
        firmwarePackets += 1;
        queue.push(response(comtype, new Uint8Array(61)));
      } else if (comtype === OT_COMTYPE.resetFirmware) {
        resets += 1;
        queue.push(response(comtype, new Uint8Array(61)));
      }
      return bytes.length;
    },
    async receiveFeatureReport() {
      return new DataView((queue.shift() ?? new Uint8Array(64)).slice().buffer);
    },
  };
  return {
    device: device as unknown as HIDDevice,
    sent,
    effectState: () => otDecodeEffect(effect),
    firmware: () => ({ firmwarePackets, firmwareSetup, resets }),
  };
}

function bareDevice(productId: number, vendorId = 0x3367, collections: HIDCollectionInfo[] = []) {
  return { vendorId, productId, productName: "", opened: false, collections } as unknown as HIDDevice;
}

const feature0 = [{
  usagePage: 0xffa1,
  usage: 0x00a5,
  children: [],
  inputReports: [],
  outputReports: [],
  featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 63 }] }],
}] as unknown as HIDCollectionInfo[];

test("the OT driver claims only its three PIDs on the report-0 control channel", () => {
  for (const pid of [0x1903, 0x1905, 0x1906]) {
    assert.equal(EggOtHidClient.isSupported(bareDevice(pid, 0x3367, feature0)), true);
  }
  for (const pid of [0x1910, 0x1964, 0x1978, 0x1972, 0x1970, 0x1960, 0x1962]) {
    assert.equal(EggOtHidClient.isSupported(bareDevice(pid, 0x3367, feature0)), false);
  }
  assert.equal(EggOtHidClient.isSupported(bareDevice(0x1905, 0x1234, feature0)), false);
  assert.equal(EggOtHidClient.isSupported(bareDevice(0x1905, 0x3367, [])), false);
});

test("the K26 driver does not claim OT mice and vice versa", () => {
  const ot = bareDevice(0x1905, 0x3367, feature0);
  assert.equal(EggOtHidClient.isSupported(ot), true);
  assert.equal(EggOp1HidClient.isSupported(ot), false);
});

test("status reads decode the six-block profile", async () => {
  const fake = fakeOtMouse({ productId: 0x1905 });
  const client = new EggOtHidClient(fake.device);
  const status = await client.readStatus();
  assert.equal(status.brand, "Endgame Gear");
  assert.equal(status.name, "Endgame Gear OP1 RGB");
  assert.equal(status.dpi, 800);
  assert.equal(status.dpiY, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.profileCount, 5);
  assert.deepEqual(status.profileNames, ["Gaming"]);
  assert.deepEqual(status.otCpiStages.map((stage) => stage.active), [false, true, false, false]);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.otLodLabel, "1 mm");
  assert.equal(status.otRgbMode, 1);
  assert.deepEqual(status.otRgbColor, { r: 255, g: 0, b: 0 });
  const queries = fake.sent.filter((line) => line.startsWith("33:"));
  assert.deepEqual(queries.map((line) => line[3]), ["0", "1", "2", "3", "4", "6"]);
});

test("DPI, CPI stage, polling, lift-off, and flags round-trip through the fake", async () => {
  const fake = fakeOtMouse({ productId: 0x1903 });
  const client = new EggOtHidClient(fake.device);
  assert.equal(await client.setDpi(1600), 1600);
  assert.deepEqual(fake.effectState().cpi, [1600, 1600, 1600, 1600]);
  await client.setCpiStage(0, 400, 800);
  assert.equal(fake.effectState().cpi[0], 400);
  assert.equal(fake.effectState().cpiY[0], 800);
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(fake.effectState().pollrateIndex, 1);
  await client.setLiftOffDistance("High");
  assert.equal(fake.effectState().dcuThreshold, 2);
  await client.setAngleSnapping(true);
  await client.setSlamClickFilter(true);
  const flags = fake.effectState().profileFlags;
  assert.equal((flags & (1 << 3)) !== 0, true);
  assert.equal((flags & (1 << 15)) !== 0, true);
  await assert.rejects(() => client.setDpi(20_000), /CPI must be/);
  await assert.rejects(() => client.setPollingRate(8000), /Unsupported OT polling rate/);
});

test("flash sends setup, indexed packets, and progress, reset stays separate", async () => {
  const fake = fakeOtMouse();
  const client = new EggOtHidClient(fake.device);
  const image = new Uint8Array(130).map((_, i) => i & 0xff);
  const progress: number[] = [];
  await client.flashFirmware(image, { major: 1, minor: 2, build: 3 }, (p) => progress.push(p.packet));
  const { firmwarePackets, firmwareSetup, resets } = fake.firmware();
  assert.equal(firmwarePackets, 3);
  assert.equal(resets, 0);
  assert.equal(firmwareSetup?.[1], OT_COMTYPE.firmwareDlSetup);
  assert.deepEqual(progress, [0, 1, 2]);
  await client.resetFirmware();
  assert.equal(fake.firmware().resets, 1);
  const raw = await client.queryFirmwareRaw();
  assert.deepEqual(raw?.slice(0, 2), [0x37, 0x01]);
});

test("unacknowledged writes reject instead of silently succeeding", async () => {
  const fake = fakeOtMouse({ silentSaves: true });
  const client = new EggOtHidClient(fake.device);
  await assert.rejects(() => client.setDpi(1600), /did not acknowledge/);
});

test("a mouse that never sends the response packet reports the raw tx/rx trace", async () => {
  const fake = fakeOtMouse();
  const device = fake.device as unknown as {
    sendFeatureReport: (reportId: number, data: BufferSource) => Promise<number>;
    receiveFeatureReport: () => Promise<DataView>;
  };
  const send = device.sendFeatureReport.bind(device);
  const receive = device.receiveFeatureReport.bind(device);
  let reads = 0;
  // Ack only: the vendor response never arrives, like the first OP1 RGB hardware report.
  device.sendFeatureReport = async (reportId, data) => {
    reads = 0;
    return send(reportId, data);
  };
  device.receiveFeatureReport = async () => (reads++ === 0 ? receive() : new DataView(new ArrayBuffer(64)));
  const client = new EggOtHidClient(fake.device);
  await assert.rejects(
    () => client.readStatus(),
    /did not answer OT profile block 0\. Trace: tx 33 [0-9a-f ]+ \| rx 00 14 [0-9a-f ]+ \| rx 00 00 [0-9a-f ]+ x\d+.*\. Collections: usage 0xffa1:0xa5 · feature 0x0/,
  );
});

test("the OT driver rejects interfaces other than the vendor 0xFFA1:0x00A5 collection", () => {
  const withUsage = (usagePage: number, usage: number) => [{
    usagePage,
    usage,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 63 }] }],
  }] as unknown as HIDCollectionInfo[];
  assert.equal(EggOtHidClient.isSupported(bareDevice(0x1905, 0x3367, withUsage(0xffa1, 0x00a5))), true);
  assert.equal(EggOtHidClient.isSupported(bareDevice(0x1905, 0x3367, withUsage(0x0001, 0x0002))), false);
  assert.equal(EggOtHidClient.isSupported(bareDevice(0x1905, 0x3367, withUsage(0xffa1, 0x0001))), false);
});

test("a session opens with the vendor password, then the firmware version, before any profile query", async () => {
  const fake = fakeOtMouse();
  await new EggOtHidClient(fake.device).readStatus();
  assert.match(fake.sent[0]!, /^13:/);
  assert.match(fake.sent[0]!, / 47 45 47 4a 47$/, "payload starts with ASCII GEGJG");
  assert.match(fake.sent[1]!, /^11:/);
  assert.match(fake.sent[2]!, /^33:/);
});

test("a mouse that answers queries with a lone response and no ack is still read", async () => {
  const fake = fakeOtMouse();
  const device = fake.device as unknown as { receiveFeatureReport: () => Promise<DataView> };
  const receive = device.receiveFeatureReport.bind(device);
  device.receiveFeatureReport = async () => {
    for (;;) {
      const view = await receive();
      if (new Uint8Array(view.buffer, view.byteOffset, view.byteLength)[1] !== OT_COMTYPE.ack) return view;
    }
  };
  const status = await new EggOtHidClient(fake.device).readStatus();
  assert.equal(status.dpi, 800);
});
