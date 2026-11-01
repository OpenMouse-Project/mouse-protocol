import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MchoseHidClient } from "./hid.ts";

/**
 * Replays captures of an L7 Pro+ (firmware 5.32.5.0) taken from the vendor's web
 * driver. Each feature read answers with the last reply captured for the same
 * request, so a capture also stands for the device state after its change.
 */
interface CapturedEvent { kind: string; reportId: string | number; hex: string }

const capture = (name: string): CapturedEvent[] =>
  JSON.parse(readFileSync(
    new URL(`../../../captures/mchose-l7-pro-plus/${name}.json`, import.meta.url),
    "utf8",
  )) as CapturedEvent[];

const toBytes = (hex: string): number[] => hex.split(" ").map((h) => parseInt(h, 16));
/** Report id plus the masked command and its first argument. */
const requestKey = (id: number, bytes: number[]): string => `${id}:${bytes[0]}:${bytes[1]}`;

function replayDevice(name: string, productId: number, vendorId = 0x3837) {
  const replies = new Map<string, number[]>();
  let lastKey = "";
  for (const event of capture(name)) {
    const id = Number(event.reportId);
    const bytes = toBytes(event.hex);
    if (event.kind === "feature-out") lastKey = requestKey(id, bytes);
    if (event.kind === "feature-in") replies.set(lastKey, bytes);
  }
  const sent: Array<{ id: number; bytes: number[] }> = [];
  const pending = new Map<number, string>();
  const device = {
    vendorId,
    productId,
    productName: "MCHOSE L7 Pro+",
    opened: true,
    collections: [
      { usagePage: 0xff01, usage: 0x0001, type: 0, children: [], input: 0, output: 0, feature: 0 },
    ],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (id: number, data: ArrayBuffer | ArrayLike<number>) => {
      const bytes = [...(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))];
      sent.push({ id, bytes });
      pending.set(id, requestKey(id, bytes));
    },
    receiveFeatureReport: async (id: number) => {
      const reply = replies.get(pending.get(id) ?? "") ?? [id];
      return new DataView(Uint8Array.from([...reply, ...new Array(66).fill(0)].slice(0, 66)).buffer);
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

describe("MCHOSE L7 Pro+ captures", () => {
  it("identifies the model from the mouse id in the battery reply", async () => {
    const { device } = replayDevice("00-connect", 0x4015);
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.name, "MCHOSE L7 Pro+");
    assert.equal(status.batteryPercent, 57);
    assert.equal(status.batteryState, "Charging");
    assert.equal(status.connectionType, "Wired");
  });

  it("reads DPI, polling, mode, debounce and profile names", async () => {
    const { device } = replayDevice("00-connect", 0x4015);
    const status = await new MchoseHidClient(device).readStatus();
    assert.deepEqual(status.dpiStages, [800, 800, 1600, 3200, 6400, 26000]);
    assert.equal(status.dpi, 800);
    assert.equal(status.pollingRateHz, 1000);
    assert.deepEqual(status.supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
    assert.equal(status.debounceMs, 0);
    assert.deepEqual(status.profileNames, ["Profile 1", "Default onboard 2", "Default onboard 3"]);
    assert.equal(status.ui?.dpiStageEditor?.maxDpi, 26000);
  });

  it("reads the wired polling rate from the wired half", async () => {
    const { device } = replayDevice("11-polling-8000", 0x4015);
    assert.equal((await new MchoseHidClient(device).readStatus()).pollingRateHz, 8000);
  });

  it("reads the wireless polling rate through the dongle", async () => {
    const { device } = replayDevice("19-wireless-4000hz", 0x1020, 0x5253);
    assert.equal(MchoseHidClient.isSupported(device), true);
    const status = await new MchoseHidClient(device).readStatus();
    assert.equal(status.name, "MCHOSE L7 Pro+");
    assert.equal(status.connectionType, "Wireless");
    assert.equal(status.pollingRateHz, 4000);
  });

  it("reads lift-off 1 mm and 2 mm as Low and High", async () => {
    const low = replayDevice("13-lod-1mm", 0x4015);
    const high = replayDevice("12-lod-2mm", 0x4015);
    assert.equal((await new MchoseHidClient(low.device).readStatus()).liftOffDistance, "Low");
    const status = await new MchoseHidClient(high.device).readStatus();
    assert.equal(status.liftOffDistance, "High");
    assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  });

  it("writes lift-off 2 mm with the command bytes the vendor driver sent", async () => {
    const { device, sent } = replayDevice("12-lod-2mm", 0x4015);
    const client = new MchoseHidClient(device);
    await client.readStatus();
    await client.setLiftOffDistance("High");
    const vendor = capture("12-lod-2mm").find(
      (e) => e.kind === "feature-out" && toBytes(e.hex)[0] === (~0x42 & 0xff),
    );
    const write = sent.find((s) => s.bytes[0] === (~0x42 & 0xff));
    // The driver pads every 0x11 request to 64 bytes; the vendor sent 20.
    assert.deepEqual(write?.bytes.slice(0, 20), toBytes(vendor!.hex));
  });
});
