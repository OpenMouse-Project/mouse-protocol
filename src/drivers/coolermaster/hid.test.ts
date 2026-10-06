import assert from "node:assert/strict";
import test from "node:test";

import {
  COOLERMASTER_MM711_PRODUCT_ID,
  COOLERMASTER_REPORT_ID,
  COOLERMASTER_USAGE,
  COOLERMASTER_USAGE_PAGE,
  COOLERMASTER_VENDOR_ID,
  coolermasterDecodeDpi,
  coolermasterEncodeDpi,
} from "@openmouse/protocol/coolermaster";
import { CoolerMasterHidClient } from "./hid.ts";
import { clientSupportScore, createSupportedClient, deviceBrand } from "../registry.ts";

function fromHex(text: string): Uint8Array {
  const clean = text.replace(/#.*$/gm, "").trim().replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

class FakeCoolerMasterDevice {
  vendorId = COOLERMASTER_VENDOR_ID;
  productId = COOLERMASTER_MM711_PRODUCT_ID;
  productName = "Cooler Master MM711";
  opened = false;
  collections: HIDCollectionInfo[] = [
    {
      usagePage: COOLERMASTER_USAGE_PAGE,
      usage: COOLERMASTER_USAGE,
      children: [],
      featureReports: [],
      inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
      outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
    },
  ];

  // Internal state modeled after captured MM711 hardware responses
  private activeStage = 1;
  private stageCount = 7;
  private dpiStages = [400, 800, 1600, 1200, 3200, 6400, 16000];
  private pollingCode = 1; // 1000 Hz
  private debounceMs = 5;
  private angleTuning = 0;
  private angleSnapping = false;
  private liftOffDistance: "Low" | "High" = "Low";
  private lightingMode = 2; // Color cycle
  private lightingSpeed = 40;
  private lightingBrightness = 255;
  private lightingRandom = false;
  private lightingColor = { r: 255, g: 0, b: 0 };
  private customWheel = { r: 255, g: 0, b: 0 };
  private customLogo = { r: 0, g: 255, b: 0 };

  private listeners = new Set<(event: HIDInputReportEvent) => void>();
  readonly sentReports: Array<{ reportId: number; data: Uint8Array }> = [];

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

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const frame = new Uint8Array(data as ArrayBufferLike);
    this.sentReports.push({ reportId, data: new Uint8Array(frame) });

    const reply = new Uint8Array(64);

    if (frame[0] === 0x41 && frame[1] === 0x80) {
      // Handshake echo
      reply[0] = 0x41;
      reply[1] = 0x80;
    } else if (frame[0] === 0x52 && frame[1] === 0x40) {
      // Get Performance
      reply[0] = 0x52;
      reply[1] = 0x40;
      reply[4] = this.activeStage;
      reply[5] = this.stageCount;
      for (let i = 0; i < 7; i++) {
        reply[6 + i] = coolermasterEncodeDpi(this.dpiStages[i]!);
        reply[13 + i] = coolermasterEncodeDpi(this.dpiStages[i]!);
      }
      reply[27] = this.angleTuning & 0xff;
      reply[28] = (this.angleSnapping ? 0x01 : 0x00) | (this.liftOffDistance === "High" ? 0x06 : 0x02);
      reply[29] = 10;
      reply[30] = 6;
    } else if (frame[0] === 0x51 && frame[1] === 0x40) {
      // Set Performance
      reply.set(frame);
      this.activeStage = frame[4]!;
      if (frame[5]! > 0) this.stageCount = frame[5]!;
      for (let i = 0; i < 7; i++) {
        this.dpiStages[i] = coolermasterDecodeDpi(frame[6 + i]!);
      }
      this.angleTuning = (frame[27]! << 24) >> 24;
      this.angleSnapping = (frame[28]! & 0x01) === 0x01;
      this.liftOffDistance = (frame[28]! & 0x06) === 0x06 ? "High" : "Low";
    } else if (frame[0] === 0x52 && frame[1] === 0xf0) {
      // Get Polling Rate
      reply[0] = 0x52;
      reply[1] = 0xf0;
      reply[4] = this.pollingCode;
    } else if (frame[0] === 0x51 && frame[1] === 0xf0) {
      // Set Polling Rate
      this.pollingCode = frame[4]!;
      reply.set(frame);
    } else if (frame[0] === 0x52 && frame[1] === 0x10) {
      // Get Debounce
      reply[0] = 0x52;
      reply[1] = 0x10;
      reply[12] = this.debounceMs;
    } else if (frame[0] === 0x51 && frame[1] === 0x10) {
      // Set Debounce
      this.debounceMs = frame[12]!;
      reply.set(frame);
    } else if (frame[0] === 0x52 && frame[1] === 0x28) {
      // Get Effect Mode
      reply[0] = 0x52;
      reply[1] = 0x28;
      reply[4] = this.lightingMode;
    } else if (frame[0] === 0x51 && frame[1] === 0x28) {
      // Set Effect Mode
      this.lightingMode = frame[4]!;
      reply.set(frame);
    } else if (frame[0] === 0x52 && frame[1] === 0xa8) {
      // Get Custom Effect
      reply[0] = 0x52;
      reply[1] = 0xa8;
      reply[4] = this.customWheel.r;
      reply[5] = this.customWheel.g;
      reply[6] = this.customWheel.b;
      reply[7] = this.customLogo.r;
      reply[8] = this.customLogo.g;
      reply[9] = this.customLogo.b;
    } else if (frame[0] === 0x51 && frame[1] === 0xa8) {
      // Set Custom Effect
      this.customWheel = { r: frame[4]!, g: frame[5]!, b: frame[6]! };
      this.customLogo = { r: frame[7]!, g: frame[8]!, b: frame[9]! };
      reply.set(frame);
    } else if (frame[0] === 0x52 && frame[1] === 0x2b) {
      // Get General Effect
      reply[0] = 0x52;
      reply[1] = 0x2b;
      reply[4] = this.lightingMode;
      reply[5] = this.lightingSpeed;
      reply[6] = this.lightingRandom ? 0xa0 : 0x20;
      reply[7] = 0xff;
      reply[8] = 0xff;
      reply[9] = this.lightingBrightness;
      reply[10] = this.lightingColor.r;
      reply[11] = this.lightingColor.g;
      reply[12] = this.lightingColor.b;
    } else if (frame[0] === 0x51 && frame[1] === 0x2b) {
      // Set General Effect
      this.lightingSpeed = frame[5]!;
      this.lightingRandom = (frame[6]! & 0x80) !== 0;
      this.lightingBrightness = frame[9]!;
      this.lightingColor = { r: frame[10]!, g: frame[11]!, b: frame[12]! };
      reply.set(frame);
    }

    queueMicrotask(() => {
      const event = {
        reportId: 0,
        data: new DataView(reply.buffer, reply.byteOffset, reply.byteLength),
        device: this as unknown as HIDDevice,
      } as unknown as HIDInputReportEvent;
      for (const listener of this.listeners) {
        listener(event);
      }
    });
  }
}

test("CoolerMasterHidClient.isSupported detects matching MM711 device", () => {
  const fake = new FakeCoolerMasterDevice();
  assert.equal(CoolerMasterHidClient.isSupported(fake as unknown as HIDDevice), true);

  const wrongVid = new FakeCoolerMasterDevice();
  wrongVid.vendorId = 0x1234;
  assert.equal(CoolerMasterHidClient.isSupported(wrongVid as unknown as HIDDevice), false);

  const wrongPid = new FakeCoolerMasterDevice();
  wrongPid.productId = 0x9999;
  assert.equal(CoolerMasterHidClient.isSupported(wrongPid as unknown as HIDDevice), false);

  const wrongCollection = new FakeCoolerMasterDevice();
  wrongCollection.collections = [
    {
      usagePage: 0x0001,
      usage: 0x0002,
      children: [],
      featureReports: [],
      inputReports: [],
      outputReports: [],
    },
  ];
  assert.equal(CoolerMasterHidClient.isSupported(wrongCollection as unknown as HIDDevice), false);
});

test("CoolerMasterHidClient reads complete status from device", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  const status = await client.readStatus();
  assert.equal(status.brand, "Cooler Master");
  assert.equal(status.name, "Cooler Master MM711");
  assert.equal(status.dpi, 800);
  assert.equal(status.dpiY, 800);
  assert.equal(status.activeDpiStage, 1);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 1200, 3200, 6400, 16000]);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.debounceMs, 5);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.angleSnapping, false);
  assert.equal(status.angleTuning, 0);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryPercent, null);
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.ui?.settingsReady, true);
  assert.deepEqual(status.ui?.dpiStageEditor, {
    maxStages: 7,
    countEditable: true,
    minDpi: 100,
    maxDpi: 16000,
    stepDpi: 100,
  });
  assert.ok(status.lighting);
  assert.equal(status.lighting.zone, "Mouse");
  assert.equal(status.lighting.mode, "Cycling");
  assert.equal(status.lightingZones, undefined);
});

test("CoolerMasterHidClient sets active DPI stage and stage values", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  // Set active stage to 0 (400 DPI)
  const activeStage = await client.setActiveDpiStage(0);
  assert.equal(activeStage, 0);

  // Set active DPI to 1200
  const newDpi = await client.setDpi(1200);
  assert.equal(newDpi, 1200);

  // Set stage 3 value to 2000
  const stageVal = await client.setDpiStageValue(3, 2000);
  assert.equal(stageVal, 2000);

  const status = await client.readStatus();
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.dpi, 1200);
  assert.equal(status.dpiStages?.[3], 2000);
});

test("CoolerMasterHidClient sets DPI stage count", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  const count3 = await client.setDpiStageCount(3);
  assert.equal(count3, 3);

  const status = await client.readStatus();
  assert.equal(status.dpiStages?.length, 3);
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);

  await assert.rejects(() => client.setDpiStageCount(0), RangeError);
  await assert.rejects(() => client.setDpiStageCount(8), RangeError);
});

test("CoolerMasterHidClient sets polling rate", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  const rate500 = await client.setPollingRate(500);
  assert.equal(rate500, 500);

  const rate250 = await client.setPollingRate(250);
  assert.equal(rate250, 250);

  const rate125 = await client.setPollingRate(125);
  assert.equal(rate125, 125);

  const rate1000 = await client.setPollingRate(1000);
  assert.equal(rate1000, 1000);

  await assert.rejects(() => client.setPollingRate(2000), /RangeError/);
});

test("CoolerMasterHidClient sets debounce time", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  assert.equal(client.getDebounceMaxMs(), 32);
  assert.equal(client.getDebounceOptions().length, 29);
  assert.equal(client.getDebounceOptions()[0], 4);
  assert.equal(client.getDebounceOptions().at(-1), 32);

  const debounce = await client.setDebounceTime(12);
  assert.equal(debounce, 12);

  await assert.rejects(() => client.setDebounceTime(0), /RangeError/);
  await assert.rejects(() => client.setDebounceTime(40), /RangeError/);
});

test("CoolerMasterHidClient sets LOD, angle snapping, and angle tuning", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  const lodHigh = await client.setLiftOffDistance("High");
  assert.equal(lodHigh, "High");

  const snapOn = await client.setAngleSnapping(true);
  assert.equal(snapOn, true);

  const tune = await client.setAngleTuning(5);
  assert.equal(tune, 5);

  const status = await client.readStatus();
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.angleSnapping, true);
  assert.equal(status.angleTuning, 5);
});

test("Cooler Master device is registered and resolved in the driver registry", () => {
  const fake = new FakeCoolerMasterDevice();
  const client = createSupportedClient(fake as unknown as HIDDevice);
  assert.ok(client instanceof CoolerMasterHidClient);
  assert.equal(deviceBrand(client), "Cooler Master");
  assert.equal(clientSupportScore(fake as unknown as HIDDevice), 7);
});

test("CoolerMasterHidClient sets static lighting for mouse zone", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  const status = await client.readStatus();
  assert.ok(status.lighting);

  // Set mouse zone to blue
  const updated = await client.setLighting({
    ...status.lighting,
    mode: "Static",
    color: "#0000ff",
  });
  assert.equal(updated.zone, "Mouse");
  assert.equal(updated.mode, "Static");
  assert.equal(updated.color, "#0000ff");

  // Re-read status and verify color persisted
  const recheck = await client.readStatus();
  assert.equal(recheck.lighting?.color, "#0000ff");
  assert.equal(recheck.lighting?.mode, "Static");
});

test("CoolerMasterHidClient sets breathing and color cycle lighting", async () => {
  const fake = new FakeCoolerMasterDevice();
  const client = new CoolerMasterHidClient(fake as unknown as HIDDevice);

  const status = await client.readStatus();
  const zone = status.lighting!;

  // Breathing single color
  const breath = await client.setLighting({
    ...zone,
    mode: "Breathing single",
    color: "#00ff00",
    speed: 4,
    brightness: 80,
  });
  assert.equal(breath.mode, "Breathing single");
  assert.equal(breath.color, "#00ff00");
  assert.equal(breath.speed, 4);

  // Breathing random colors
  const breathRandom = await client.setLighting({
    ...zone,
    mode: "Breathing random",
    speed: 2,
  });
  assert.equal(breathRandom.mode, "Breathing random");
  assert.equal(breathRandom.color, null);
  assert.equal(breathRandom.speed, 2);

  // Color cycle (Cycling)
  const cycle = await client.setLighting({
    ...zone,
    mode: "Cycling",
    speed: 5,
    brightness: 100,
  });
  assert.equal(cycle.mode, "Cycling");
  assert.equal(cycle.speed, 5);
  assert.equal(cycle.color, null);

  // Off
  const off = await client.setLighting({
    ...zone,
    mode: "Off",
  });
  assert.equal(off.mode, "Off");
  assert.equal(off.brightness, 0);

  // Validation
  await assert.rejects(
    () => client.setLighting({ ...zone, zone: "Underglow" }),
    /Unknown Cooler Master lighting zone/,
  );
  await assert.rejects(
    () => client.setLighting({ ...zone, mode: null }),
    /Choose an RGB effect first/,
  );
  await assert.rejects(
    () => client.setLighting({ ...zone, mode: "Wave" as any }),
    /Unsupported Cooler Master lighting mode/,
  );
});


