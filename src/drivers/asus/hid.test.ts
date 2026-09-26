import assert from "node:assert/strict";
import test from "node:test";

import {
  ASUS_MICE,
  ASUS_REPORT_SIZE,
  ASUS_USAGE,
  ASUS_USAGE_PAGE,
  ASUS_VENDOR_ID,
  asusDecodeDpiXY,
  asusDecodeLighting,
  asusDecodeProfile,
  asusDecodeSettings,
  asusReadProfileRequest,
  asusReadSettingsRequest,
  asusSaveRequest,
  asusSetActiveDpiStageRequest,
  asusSetAngleSnappingRequest,
  asusSetDebounceRequest,
  asusSetDpiRequest,
  asusSetLiftOffRequest,
  asusSetLightingRequest,
  asusSetPollingRateRequest,
  asusSetProfileRequest,
  type AsusMouseModel,
} from "../../asus/index.ts";
import { AsusHidClient } from "./hid.ts";

const GLADIUS_II = ASUS_MICE.get(0x1845)!;
const TUF_M3 = ASUS_MICE.get(0x1910)!;
const STRIX_IMPACT_III = ASUS_MICE.get(0x1a88)!;
const HARPE_ACE = ASUS_MICE.get(0x1a92)!;

function packet(hex: string): Uint8Array {
  const data = new Uint8Array(ASUS_REPORT_SIZE);
  data.set(hex.trim().split(/\s+/).map((value) => Number.parseInt(value, 16)));
  return data;
}

function expectPrefix(actual: Uint8Array, expected: number[]): void {
  assert.equal(actual.length, ASUS_REPORT_SIZE);
  assert.deepEqual([...actual.slice(0, expected.length)], expected);
  // Everything after the command stays zero-filled.
  assert.ok(actual.slice(expected.length).every((value) => value === 0));
}

/* ---------------------------------------------------------
 * VERIFIED GLADIUS II HARDWARE CAPTURES
 * --------------------------------------------------------- */

test("decodes verified Gladius II settings capture", () => {
  const result = asusDecodeSettings(GLADIUS_II, packet("12 04 00 00  0E 00  0B 00  03 00  07 00  00 00"));

  assert.deepEqual(result, { dpiStages: [1500, 1200], pollingRateHz: 1000, debounceMs: 32, angleSnapping: false });
});

test("decodes verified Gladius II profile capture", () => {
  const result = asusDecodeProfile(GLADIUS_II, packet("12 00 00 00  30 31 39 35  03 06  00  01  0E 00"));

  assert.deepEqual(result, { onboardProfile: 1, activeDpiStage: 0 });
});

test("builds the Gladius II requests confirmed on hardware", () => {
  const cases: Array<[Uint8Array, number[]]> = [
    [asusReadSettingsRequest(), [0x12, 0x04, 0x00]],
    [asusReadProfileRequest(), [0x12, 0x00]],
    [asusSetDpiRequest(GLADIUS_II, 0, 1600), [0x51, 0x31, 0x00, 0x00, 0x0f, 0x00]],
    [asusSetDpiRequest(GLADIUS_II, 1, 12000), [0x51, 0x31, 0x01, 0x00, 0x77, 0x00]],
    [asusSetActiveDpiStageRequest(GLADIUS_II, 1), [0x51, 0x31, 0x09, 0x00, 0x02]],
    [asusSetPollingRateRequest(GLADIUS_II, 125), [0x51, 0x31, 0x02, 0x00, 0x00]],
    [asusSetPollingRateRequest(GLADIUS_II, 500), [0x51, 0x31, 0x02, 0x00, 0x02]],
    [asusSetPollingRateRequest(GLADIUS_II, 1000), [0x51, 0x31, 0x02, 0x00, 0x03]],
    [asusSetProfileRequest(GLADIUS_II, 1), [0x50, 0x02, 0x00]],
    [asusSetProfileRequest(GLADIUS_II, 3), [0x50, 0x02, 0x02]],
    [asusSetAngleSnappingRequest(GLADIUS_II, true), [0x51, 0x31, 0x04, 0x00, 0x01]],
    [asusSetAngleSnappingRequest(GLADIUS_II, false), [0x51, 0x31, 0x04, 0x00, 0x00]],
    [asusSetDebounceRequest(GLADIUS_II, 12), [0x51, 0x31, 0x03, 0x00, 0x02]],
    [asusSetDebounceRequest(GLADIUS_II, 32), [0x51, 0x31, 0x03, 0x00, 0x07]],
    [asusSetLiftOffRequest("Low"), [0x51, 0x35, 0xff, 0x00, 0xff, 0x00]],
    [asusSetLiftOffRequest("High"), [0x51, 0x35, 0xff, 0x00, 0xff, 0x01]],
    [asusSetLightingRequest(GLADIUS_II, 0, 0x00, 4, 0xff, 0x00, 0x00), [0x51, 0x28, 0x00, 0x00, 0x00, 0x04, 0xff]],
    [
      asusSetLightingRequest(GLADIUS_II, 2, 0x01, 3, 0x12, 0x34, 0x56, 0x64),
      [0x51, 0x28, 0x02, 0x00, 0x01, 0x03, 0x12, 0x34, 0x56, 0x00, 0x00, 0x64],
    ],
    [asusSaveRequest(), [0x50, 0x03]],
  ];

  for (const [actual, expected] of cases) {
    expectPrefix(actual, expected);
  }
});

test("rejects values outside a model's range", () => {
  assert.throws(() => asusSetDpiRequest(GLADIUS_II, 0, 1650), /100-DPI steps/);
  assert.throws(() => asusSetDpiRequest(GLADIUS_II, 2, 1600), /stage must be 0-1/);
  assert.throws(() => asusSetPollingRateRequest(GLADIUS_II, 2000), /2000 Hz/);
  assert.throws(() => asusSetProfileRequest(GLADIUS_II, 4), /profile must be 1-3/);
  assert.throws(() => asusSetDebounceRequest(GLADIUS_II, 10), /debounce must be one of/);
  assert.throws(() => asusSetLightingRequest(GLADIUS_II, 3, 0, 4, 255, 0, 0), /RGB zone must be 0-2/);
  assert.throws(() => asusSetLightingRequest(GLADIUS_II, 0, 0, 5, 255, 0, 0), /brightness must be 0-4/);
});

/* ---------------------------------------------------------
 * MODEL TABLE
 * --------------------------------------------------------- */

test("every table entry encodes its own DPI range", () => {
  for (const [productId, model] of ASUS_MICE) {
    const label = `0x${productId.toString(16)}`;
    assert.equal(model.minDpi % model.dpiStep, 0, label);
    assert.equal(model.maxDpi % model.dpiStep, 0, label);
    assert.ok(model.maxDpi / model.dpiStep - 1 <= 0xffff, label);
    assert.ok(model.zones.length > 0 && model.profiles >= 1, label);
  }
});

test("four-stage models shift rate, debounce and snapping to fields 4-6", () => {
  expectPrefix(asusSetDpiRequest(TUF_M3, 3, 7000), [0x51, 0x31, 0x03, 0x00, 0x45, 0x00]);
  expectPrefix(asusSetPollingRateRequest(TUF_M3, 1000), [0x51, 0x31, 0x04, 0x00, 0x03]);
  expectPrefix(asusSetDebounceRequest(TUF_M3, 12), [0x51, 0x31, 0x05, 0x00, 0x02]);
  expectPrefix(asusSetAngleSnappingRequest(TUF_M3, true), [0x51, 0x31, 0x06, 0x00, 0x01]);
});

test("decodes a four-stage block with a polling-booster nibble", () => {
  const result = asusDecodeSettings(
    STRIX_IMPACT_III,
    packet("12 04 00 00  0F 00  1F 00  3B 00  77 00  13 00  00 00  01 00"),
  );

  assert.deepEqual(result, {
    dpiStages: [800, 1600, 3000, 6000],
    pollingRateHz: 1000,
    debounceMs: null,
    angleSnapping: true,
  });
});

test("reads X from the X/Y DPI block", () => {
  const result = asusDecodeDpiXY(HARPE_ACE, packet("12 04 02 00  07 00 09 00  0F 00 0F 00  CF 02 00 00  00 00 00 00"));

  assert.deepEqual(result, [400, 800, 36000, 50]);
});

test("decodes one-reply and per-zone lighting", () => {
  const allZones = packet("12 03 00 00  00 04 FF 00 80  00 04 00 FF FF  05 02 12 34 56");
  assert.deepEqual(asusDecodeLighting(GLADIUS_II, allZones, 2), {
    mode: 0x05, brightness: 2, red: 0x12, green: 0x34, blue: 0x56,
  });

  const perZone = packet("12 03 01 00  04 64 00 FF 00");
  assert.deepEqual(asusDecodeLighting(STRIX_IMPACT_III, perZone, 1), {
    mode: 0x04, brightness: 100, red: 0x00, green: 0xff, blue: 0x00,
  });
});

/* ---------------------------------------------------------
 * CLIENT AGAINST A SIMULATED MOUSE
 * --------------------------------------------------------- */

/** Firmware stand-in: keeps the settings block in the model's own layout. */
class FakeAsusMouse {
  readonly vendorId = ASUS_VENDOR_ID;
  opened = false;
  collections = [{
    usagePage: ASUS_USAGE_PAGE,
    usage: ASUS_USAGE,
    children: [],
    featureReports: [],
    inputReports: [{ reportId: 0, items: [] }],
    outputReports: [{ reportId: 0, items: [] }],
  }];

  readonly model: AsusMouseModel;
  readonly sent: Uint8Array[] = [];
  asleep = false;
  /** Wire DPI values; `(value + 1) * step`. */
  readonly dpi: number[];
  readonly colors: number[][];
  /** Rate index, debounce, angle snapping. */
  readonly fields = [3, 7, 0];
  profile = 0;
  stage = 1;
  readonly zones: number[][];
  liftOff = 0;
  battery = 80;

  private listeners = new Set<(event: HIDInputReportEvent) => void>();

  constructor(readonly productId: number) {
    this.model = ASUS_MICE.get(productId)!;
    this.dpi = Array.from({ length: this.model.dpiStages }, (_, i) => ((i + 1) * 400) / this.model.dpiStep - 1);
    this.colors = this.dpi.map(() => [0x11, 0x22, 0x33]);
    this.zones = this.model.zones.map(() => [0x00, this.model.brightnessMax, 0xff, 0x00, 0x00]);
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  addEventListener(type: string, listener: (event: HIDInputReportEvent) => void): void {
    if (type === "inputreport") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: HIDInputReportEvent) => void): void {
    if (type === "inputreport") this.listeners.delete(listener);
  }

  async sendReport(_reportId: number, data: BufferSource): Promise<void> {
    const request = new Uint8Array(data as ArrayBuffer);
    this.sent.push(request);
    const reply = this.reply(request);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ reportId: 0, data: new DataView(reply.buffer) } as HIDInputReportEvent);
      }
    });
  }

  private reply(p: Uint8Array): Uint8Array {
    const r = new Uint8Array(ASUS_REPORT_SIZE);
    if (this.asleep) {
      r.set([0xff, 0xaa]);
      return r;
    }

    r.set(p.subarray(0, 3));
    const stages = this.model.dpiStages;
    const command = (p[0] << 8) | p[1];

    if (command === 0x1204 && p[2] === 0x00) {
      // An X/Y model's plain block is left blank so only the X/Y read can supply DPI.
      if (!this.model.dpiXY) this.dpi.forEach((v, i) => r.set([v & 0xff, v >> 8], 4 + i * 2));
      this.fields.forEach((v, n) => { r[4 + stages * 2 + n * 2] = v; });
    } else if (command === 0x1204 && p[2] === 0x02) {
      this.dpi.forEach((v, i) => r.set([v & 0xff, v >> 8, v & 0xff, v >> 8], 4 + i * 4));
    } else if (command === 0x1204 && p[2] === 0x03) {
      this.colors.forEach((c, i) => r.set(c, 4 + i * 3));
    } else if (command === 0x1200) {
      r.set([this.profile, this.stage], 10);
    } else if (command === 0x1203) {
      if (this.model.lightingAllZones) this.zones.forEach((z, i) => r.set(z, 4 + i * 5));
      else r.set(this.zones[p[2]], 4);
    } else if (command === 0x1206) {
      r[7] = this.liftOff;
    } else if (command === 0x1207) {
      r[4] = this.battery;
    } else if (command === 0x5131) {
      if (p[2] < stages) {
        this.dpi[p[2]] = p[4] | (p[5] << 8);
        if (this.model.dpiColors) this.colors[p[2]] = [p[6], p[7], p[8]];
      } else if (p[2] === 0x09) {
        this.stage = p[4];
      } else {
        this.fields[p[2] - stages] = p[4];
      }
    } else if (command === 0x5128) {
      this.zones[p[2]] = [...p.subarray(4, 9)];
    } else if (command === 0x5002) {
      this.profile = p[2];
    } else if (command === 0x5135) {
      this.liftOff = p[5];
    }

    return r;
  }
}

function connect(productId: number): { fake: FakeAsusMouse; client: AsusHidClient } {
  const fake = new FakeAsusMouse(productId);
  return { fake, client: new AsusHidClient(fake as unknown as HIDDevice) };
}

function sentWith(fake: FakeAsusMouse, ...prefix: number[]): number[][] {
  return fake.sent
    .filter((p) => prefix.every((byte, i) => p[i] === byte))
    .map((p) => [...p.subarray(0, 9)]);
}

test("only claims product ids in the table", () => {
  assert.equal(AsusHidClient.isSupported(new FakeAsusMouse(0x1845) as unknown as HIDDevice), true);

  const omni = Object.assign(new FakeAsusMouse(0x1845), { productId: 0x1ace });
  assert.equal(AsusHidClient.isSupported(omni as unknown as HIDDevice), false);
});

test("reads a Harpe Ace receiver's DPI from the X/Y block, plus battery", async () => {
  const { client } = connect(0x1a94);
  const status = await client.readStatus();

  assert.equal(status.name, "ROG Harpe Ace Aim Lab Edition");
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.dpiStages, [400, 800, 1200, 1600]);
  assert.equal(status.dpi, 400);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.debounceMs, 32);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.batteryPercent, 80);
  assert.equal(status.batteryState, "Discharging");
  assert.deepEqual(status.lightingZones?.map((zone) => [zone.zone, zone.brightness]), [["Scroll wheel", 100]]);
  assert.equal(status.ui?.dpiStageEditor?.maxStages, 4);
  assert.match(status.ui?.statusNote ?? "", /not been tested/);
});

test("reads every Gladius II zone from one lighting reply", async () => {
  const { fake, client } = connect(0x1845);
  const status = await client.readStatus();

  assert.deepEqual(status.lightingZones?.map((zone) => zone.zone), ["Logo", "Scroll wheel", "Underglow"]);
  assert.equal(sentWith(fake, 0x12, 0x03).length, 1);
  assert.equal(status.ui?.statusNote, "ROG Gladius II hardware controls are enabled.");
});

test("writes a four-stage model's polling and snapping to fields 4 and 6", async () => {
  const { fake, client } = connect(0x1a88);

  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setAngleSnapping(true), true);

  assert.deepEqual(sentWith(fake, 0x51, 0x31), [
    [0x51, 0x31, 0x04, 0x00, 0x02, 0, 0, 0, 0],
    [0x51, 0x31, 0x06, 0x00, 0x01, 0, 0, 0, 0],
  ]);
  await assert.rejects(client.setDebounceTime(12), /no debounce setting/);
});

test("resends the stage colour with a Harpe Ace DPI write", async () => {
  const { fake, client } = connect(0x1a92);

  assert.equal(await client.setDpiStageValue(2, 36000), 36000);

  assert.deepEqual(sentWith(fake, 0x51, 0x31), [[0x51, 0x31, 0x02, 0x00, 0xcf, 0x02, 0x11, 0x22, 0x33]]);
  assert.deepEqual(fake.colors[2], [0x11, 0x22, 0x33]);
});

test("sends TUF Reactive as 0x03 on a 0-4 brightness scale", async () => {
  const { fake, client } = connect(0x1898);
  const { lighting } = await client.readStatus();

  const result = await client.setLighting({ ...lighting!, mode: "Reactive", color: "#00ff00", brightness: 50 });

  assert.deepEqual(sentWith(fake, 0x51, 0x28), [[0x51, 0x28, 0x00, 0x00, 0x03, 0x02, 0x00, 0xff, 0x00]]);
  assert.equal(result.mode, "Reactive");
  assert.equal(result.brightness, 50);
});

test("fails fast when the mouse answers FF AA", async () => {
  const { fake, client } = connect(0x1a94);
  fake.asleep = true;

  await assert.rejects(client.readStatus(), /asleep/);
});
