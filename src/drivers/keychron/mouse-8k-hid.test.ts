import assert from "node:assert/strict";
import { test } from "node:test";
import type { MouseLighting } from "../mouse-types.ts";
import { Keychron8kHidClient } from "./mouse-8k-hid.ts";

const ACK = 0xe4;

/**
 * Speaks the "8k" Keychron mouse protocol the way the M6 does: 63-byte
 * queries on 0xb3 answered on 0xb4, 20-byte settings on 0xb5 acknowledged on
 * 0xb6 with [0xe4, 0, command]. The flag, X/Y, split polling, button and
 * lighting paths follow Launcher's code for them.
 */
class FakeKeychronMouse {
  vendorId = 0x3434;
  productId = 0xd060;
  opened = false;
  readonly sent: Array<{ reportId: number; packet: Uint8Array }> = [];
  private listeners = new Map<string, (event: unknown) => void>();
  heRecords = [0, 2].map(index => {
    const r = new Uint8Array(22); r[0] = index; r.set([2, 3, 25, 30], 1);
    r[5] = 25; r[7] = 15; r[10] = 40; r[12] = 0x12; r[13] = 5; r[15] = 5;
    return r;
  });
  failHeWrite = false;
  pairMask = 9;
  receiverButtons = new Map<number, number[]>();
  dynamic = { profile: 1, enabled: true, mode: 0, points: [{ speed: 0, gain: 16 }, { speed: 200, gain: 56 }] };
  workMode = 0;
  /** Protocol version in the 0x02 answer; from 6 the feature flags move there. */
  version = 5;
  /** The product ID the 0x02 answer carries. */
  reportedProductId = 0xd060;
  /** feature1-4: status [26], [53], [60] before protocol 6, 0x02 [11], [12], [13], [15] from it. */
  features = [0, 0x04, 0, 0];
  /** Mice behind a receiver's 0x03 list: [pid, connected]. */
  paired: Array<[number, boolean]> = [];
  profile = 1;
  profileCount = 3;
  /** Per connection (USB, 2.4 GHz, Bluetooth): DPI stage low nibble, polling high nibble. */
  levels = [0x10, 0x21, 0x32];
  dpiStages = [400, 800, 1600, 3200, 5000];
  dpiY = [400, 800, 1600, 3200, 5000];
  xyEnable = [0, 0, 0, 0, 0, 0, 0, 0];
  stageCount = 3;
  dpiMax = 0;
  dpiStep = 0;
  pollingTable = [0, 1, 2, 3, 4, 5];
  /** 0x4b's USB and 2.4 GHz sets. */
  pollingSets = [
    { level: 2, count: 3, table: [0, 1, 2, 0, 0, 0] },
    { level: 5, count: 6, table: [0, 1, 2, 3, 4, 5] },
  ];
  lod = 1;
  lodLevel = 0;
  lodCount = 0;
  ripple = false;
  angleSnap = false;
  motion = true;
  scrollReversed = false;
  maxSpeed = false;
  angle = 0;
  rejectNext = false;
  failStatus = false;
  debounce = 8;
  sleep = 10;
  battery = 0x80 | 100;
  /** 0x62 records by button index: [type, data...]; missing ones answer type 0 (default). */
  buttons = new Map<number, number[]>();
  light = { mode: 1, brightness: 255, speed: 128, rgb: [0, 96, 255] };
  readonly collections = [{
    usagePage: 0xffc1,
    usage: 0x01,
    outputReports: [{ reportId: 0xb3 }, { reportId: 0xb5 }],
    inputReports: [{ reportId: 0xb4 }, { reportId: 0xb6 }],
  }];

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }

  async sendReport(reportId: number, data: ArrayBuffer): Promise<void> {
    const packet = new Uint8Array(data);
    this.sent.push({ reportId, packet });
    if (reportId === 0xb3 && packet[0] === 0x31) {
      const reply = new Uint8Array(63); reply.set([0x31, packet[1]!, 0]); reply.set(this.receiverButtons.get(packet[1]!) ?? [0], 3); this.emit(0xb4, reply); return;
    }
    if (reportId === 0xb3 && packet[0] === 0x30) {
      this.receiverButtons.set(packet[1]!, Array.from(packet.slice(3))); this.emit(0xb4, new Uint8Array([ACK, 0, 0x30])); return;
    }
    if (reportId === 0xb3 && packet[0] === 0x4f) {
      const r = new Uint8Array(63); r.set([0x4f, packet[1]!, +this.dynamic.enabled, this.dynamic.mode, 0, this.dynamic.points.length]);
      this.dynamic.points.forEach((p, i) => { r[6 + i * 4] = p.speed & 255; r[7 + i * 4] = p.speed >> 8; r[8 + i * 4] = p.gain; });
      this.emit(0xb4, r); return;
    }
    if (reportId === 0xb3 && packet[0] === 0x4e) {
      this.dynamic = { profile: packet[1]!, enabled: !!packet[2], mode: packet[3]!, points: Array.from({ length: packet[5]! }, (_, i) => ({ speed: packet[6 + 4 * i]! | packet[7 + 4 * i]! << 8, gain: packet[8 + 4 * i]! })) }; return;
    }
    if (reportId === 0xb3 && packet[0] === 0x65) {
      const reply = new Uint8Array(63); reply.set([0x65, 2]);
      this.heRecords.forEach((r, i) => reply.set(r, 2 + i * 22));
      this.emit(0xb4, reply); return;
    }
    if (reportId === 0xb3 && packet[0] === 0x55) {
      if (!this.failHeWrite) this.heRecords = [packet.slice(2, 24), packet.slice(24, 46)];
      this.emit(0xb4, new Uint8Array([ACK, 0, 0x55])); return;
    }
    if (reportId === 0xb3) return this.command(packet);
    if (reportId !== 0xb5) return;
    if (this.rejectNext) {
      this.rejectNext = false;
      this.emit(0xb6, new Uint8Array([ACK, 7, packet[0] ?? 0]));
      return;
    }
    switch (packet[0]) {
      case 0x0b: {
        if (packet[1] === 1) this.pairMask = packet[2]!;
        this.emit(0xb6, packet[1] === 1 ? new Uint8Array([ACK, 0, 0x0b]) : new Uint8Array([0x0b, 2, this.pairMask, 4])); return;
      }
      case 0x0f: this.emit(0xb6, new Uint8Array([ACK, 0, 0x0f])); return;
      case 0x02: {
        const reply = new Uint8Array(20);
        reply.set([0x02, this.version, 0, 0x34, 0x34, this.reportedProductId & 0xff, this.reportedProductId >> 8, 0x03, 0x01, this.workMode]);
        reply.set(this.features.slice(0, 3), 11);
        reply[15] = this.features[3] ?? 0;
        this.emit(0xb6, reply);
        return;
      }
      case 0x03: {
        const reply = new Uint8Array(20);
        reply[0] = 0x03;
        reply[1] = this.paired.length;
        this.paired.forEach(([pid, connected], index) => {
          reply.set([0x34, 0x34, pid & 0xff, pid >> 8, connected ? 1 : 0], 2 + index * 5);
        });
        this.emit(0xb6, reply);
        return;
      }
      case 0x20: this.emit(0xb6, new Uint8Array([0x20, 0, 0, 0, this.light.mode, this.light.brightness, this.light.speed, ...this.light.rgb])); return;
      case 0x23:
        this.emit(0xb6, new Uint8Array([0x21, this.light.mode, this.light.brightness, this.light.speed, ...this.light.rgb]));
        return;
      case 0x4b: {
        const reply = new Uint8Array(20);
        reply[0] = 0x4b;
        this.pollingSets.forEach((set, index) => {
          reply[1 + index] = set.level;
          reply[3 + index] = set.count;
          reply.set(set.table, 5 + index * 6);
        });
        this.emit(0xb6, reply);
        return;
      }
      case 0x24:
        this.light = { mode: packet[1] ?? 0, brightness: packet[2] ?? 0, speed: packet[3] ?? 0, rgb: Array.from(packet.slice(4, 7)) };
        break;
      case 0x40:
        this.levels = this.levels.map((level, index) => (level & 0xf0) | (packet[1 + index] ?? 0));
        this.stageCount = packet[14] ?? this.stageCount;
        this.dpiStages = this.dpiStages.map((_, index) => (packet[4 + index * 2] ?? 0) | ((packet[5 + index * 2] ?? 0) << 8));
        break;
      case 0x41:
        this.levels = this.levels.map((level) => (level & 0x0f) | ((packet[1] ?? 0) << 4));
        this.pollingTable = Array.from(packet.slice(3, 3 + (packet[9] ?? 0)));
        break;
      case 0x4a:
        this.pollingSets = [0, 1].map((index) => ({
          level: packet[1 + index] ?? 0,
          count: packet[3 + index] ?? 0,
          table: Array.from(packet.slice(5 + index * 6, 11 + index * 6)),
        }));
        break;
      case 0x42:
        if (packet[9] === 2) {
          this.angle = (packet[10] ?? 0) > 127 ? (packet[10] ?? 0) - 256 : (packet[10] ?? 0);
          break;
        }
        if (packet[1]) this.lod = packet[1];
        if (packet[2]) this.ripple = packet[2] === 1;
        if (packet[3]) this.angleSnap = packet[3] === 1;
        if (packet[4]) this.motion = packet[4] === 1;
        if (packet[6]) this.scrollReversed = packet[6] === 2;
        if (packet[8]) this.maxSpeed = packet[8] === 2;
        if (packet[11]) this.lodLevel = packet[11];
        break;
      case 0x43:
        this.debounce = packet[1] ?? 0;
        break;
      case 0x0a:
        if (packet[1] === 1) this.sleep = packet[2] ?? 0;
        break;
      case 0x0e:
        this.profile = packet[1] ?? 0;
        break;
      default:
        return;
    }
    this.emit(0xb6, new Uint8Array([ACK, 0, packet[0] ?? 0]));
  }

  private command(packet: Uint8Array): void {
    switch (packet[0]) {
      case 0x06:
        if (this.failStatus) throw new Error("device stalled");
        this.emit(0xb4, this.statusPacket());
        return;
      case 0x04:
        this.emit(0xb4, new Uint8Array([0x04, 6, ...Array.from("1.0.3", (c) => c.charCodeAt(0)), 0]));
        return;
      case 0x49: {
        const reply = new Uint8Array(63);
        reply[0] = 0x49;
        this.levels.forEach((level, index) => {
          const stage = level & 0x0f;
          reply[1 + index] = this.version >= 6 ? stage : (stage << 4) | stage;
        });
        reply[4] = this.stageCount;
        this.dpiStages.forEach((dpi, index) => reply.set([dpi & 0xff, dpi >> 8], 5 + index * 2));
        this.dpiY.forEach((dpi, index) => reply.set([dpi & 0xff, dpi >> 8], 21 + index * 2));
        if (this.version >= 6) reply[37] = this.xyEnable.reduce((mask, bit, index) => mask | (bit << index), 0);
        else reply.set(this.xyEnable, 37);
        this.emit(0xb4, reply);
        return;
      }
      case 0x48:
        this.levels = this.levels.map((level, index) => (level & 0xf0) | ((packet[1 + index] ?? 0) & 0x0f));
        this.stageCount = packet[4] ?? this.stageCount;
        this.dpiStages = this.dpiStages.map((_, index) => (packet[5 + index * 2] ?? 0) | ((packet[6 + index * 2] ?? 0) << 8));
        this.dpiY = this.dpiY.map((_, index) => (packet[21 + index * 2] ?? 0) | ((packet[22 + index * 2] ?? 0) << 8));
        this.emit(0xb4, new Uint8Array([ACK, 0, 0x48]));
        return;
      case 0x62: {
        const index = packet[1] ?? 0;
        const reply = new Uint8Array(63);
        reply.set([0x62, index, 0, ...(this.buttons.get(index) ?? [0])]);
        this.emit(0xb4, reply);
        return;
      }
      case 0x52: {
        const record = Array.from(packet.slice(3, 7));
        if (record[0] === 0) this.buttons.delete(packet[1] ?? 0);
        else this.buttons.set(packet[1] ?? 0, record);
        this.emit(0xb4, new Uint8Array([ACK, 0, 0x52]));
        return;
      }
      default:
    }
  }

  private statusPacket(): Uint8Array {
    const packet = new Uint8Array(63);
    packet[0] = 0x06;
    packet[1] = this.profile;
    packet.set(this.levels, 2);
    this.dpiStages.forEach((dpi, index) => {
      packet[5 + index * 2] = dpi & 0xff;
      packet[6 + index * 2] = (dpi >> 8) & 0xff;
    });
    packet[15] = this.lod | (this.ripple ? 0x04 : 0) | (this.angleSnap ? 0x08 : 0) | (this.motion ? 0x10 : 0)
      | (this.scrollReversed ? 0x40 : 0);
    packet[16] = this.stageCount;
    packet[17] = this.debounce;
    packet[18] = this.sleep;
    packet[19] = this.battery;
    packet.set([this.dpiMax & 0xff, this.dpiMax >> 8, this.dpiStep], 40);
    packet.set(this.pollingTable, 43);
    packet[49] = this.pollingTable.length;
    packet[50] = this.profileCount;
    packet[52] = this.maxSpeed ? 1 : 0;
    packet[55] = this.angle & 0xff;
    packet[61] = (this.lodCount << 4) | this.lodLevel;
    if (this.version < 6) {
      packet[26] = this.features[0] ?? 0;
      packet[53] = this.features[1] ?? 0;
      packet[60] = this.features[2] ?? 0;
    }
    return packet;
  }

  private emit(reportId: number, bytes: Uint8Array): void {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    queueMicrotask(() => this.listeners.get("inputreport")?.({ reportId, data }));
  }
}

const client = (fake: FakeKeychronMouse): Keychron8kHidClient => new Keychron8kHidClient(fake as unknown as HIDDevice);
const lastSent = (fake: FakeKeychronMouse, command: number, reportId = 0xb5) =>
  [...fake.sent].reverse().find((entry) => entry.reportId === reportId && entry.packet[0] === command)?.packet;

test("claims any Keychron device with the 0xffc1 control interface", () => {
  const fake = new FakeKeychronMouse();
  assert.equal(Keychron8kHidClient.isSupported(fake as unknown as HIDDevice), true);
  fake.productId = 0xd050;
  assert.equal(Keychron8kHidClient.isSupported(fake as unknown as HIDDevice), true);
  const viaOnly = { ...fake, collections: [{ usagePage: 0xff60, usage: 0x61, outputReports: [{ reportId: 0 }], inputReports: [{ reportId: 0 }] }] };
  assert.equal(Keychron8kHidClient.isSupported(viaOnly as unknown as HIDDevice), false);
  const otherVendor = { ...fake, vendorId: 0x3151 };
  assert.equal(Keychron8kHidClient.isSupported(otherVendor as unknown as HIDDevice), false);
});

test("reads the full M6 status report", async () => {
  const status = await client(new FakeKeychronMouse()).readStatus();
  assert.equal(status.name, "Keychron M6");
  assert.equal(status.ui?.family, "keychron-8k");
  assert.equal(status.dpi, 400);
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.pollingRateHz, 500);
  assert.deepEqual(status.supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
  assert.equal(status.liftOffDistance, "Medium");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.equal(status.ui?.statusNote, "Lift-off: Low is 0.7 mm, Medium is 1 mm, High is 2 mm.");
  assert.equal(status.motionSync, true);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.rippleControl, false);
  assert.equal(status.performanceMode, undefined);
  assert.equal(status.angleTuning, 0);
  assert.equal(status.debounceMs, 8);
  assert.equal(status.sleepTimeout, 600);
  assert.equal(status.activeProfile, 2);
  assert.equal(status.profileCount, 3);
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.connectionDetail, "Wired USB");
  assert.deepEqual(status.firmware, ["v1.0.3"]);
  assert.deepEqual(status.ui?.dpiStageEditor, { maxStages: 5, countEditable: true, minDpi: 100, maxDpi: 26000, stepDpi: 50 });
  assert.equal(status.ui?.hideProcessingCard, undefined);
  assert.equal(status.ui?.hideSleepCard, undefined);
  assert.equal(status.lighting, undefined);
});

test("reads the DPI and polling levels of the connection in use", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd029;
  fake.workMode = 1;
  const status = await client(fake).readStatus();
  // 2.4 GHz slot: stage 1 (800 DPI) and polling index 2 (1000 Hz).
  assert.equal(status.name, "Keychron M6");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "2.4 GHz (Keychron Link-KM Type C)");
});

test("behind a receiver that reports its own ID, the 0x03 list names the mouse", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd028;
  fake.reportedProductId = 0xd028;
  fake.workMode = 1;
  fake.paired = [[0xd060, false], [0xd050, true]];
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron M3 8K");
  assert.equal(status.connectionDetail, "2.4 GHz (Keychron Ultra-Link 8K)");
  assert.deepEqual(Array.from(lastSent(fake, 0x03)!.slice(0, 2)), [0x03, 0]);
});

test("an unknown Keychron mouse keeps the M6 defaults and hides the remapper", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd0fe;
  fake.reportedProductId = 0xd0fe;
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron mouse");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.equal(status.buttonMappings, undefined);
  assert.equal(status.ui?.dpiStageEditor?.maxDpi, 26000);
});

test("an 8K model takes its floor from the table and its ceiling and step from the mouse", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd050;
  fake.reportedProductId = 0xd050;
  fake.features = [0x08, 0, 0, 0];
  fake.dpiMax = 30_000;
  fake.dpiStep = 10;
  const m3 = client(fake);
  const status = await m3.readStatus();
  assert.equal(status.name, "Keychron M3 8K");
  assert.deepEqual(status.ui?.dpiStageEditor, { maxStages: 5, countEditable: true, minDpi: 50, maxDpi: 30000, stepDpi: 10 });
  assert.equal(m3.getDpiOptions()[0], 50);
  assert.equal(m3.getDpiOptions().at(-1), 30000);
  assert.equal(await m3.setDpiStageValue(0, 1210), 1210);
  await assert.rejects(m3.setDpiStageValue(0, 1215), /multiple of 10 between 50 and 30000/);
  assert.equal(status.angleTuning, undefined);
});

test("DPI writes follow the active stage and keep the stage count", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  await m6.setActiveDpiStage(1);
  await m6.setDpi(2400);
  const status = await m6.readStatus();
  assert.deepEqual(status.dpiStages, [400, 2400, 1600]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.dpi, 2400);
  assert.equal(await m6.setDpiStageValue(2, 3200), 3200);
  assert.deepEqual((await m6.readStatus()).dpiStages, [400, 2400, 3200]);
  assert.equal(lastSent(fake, 0x40)?.[14], 3);
});

test("rejects stages past the count the mouse reports", async () => {
  const m6 = client(new FakeKeychronMouse());
  await assert.rejects(m6.setActiveDpiStage(3), /between 1 and 3/);
  await assert.rejects(m6.setDpiStageValue(4, 800), /between 1 and 3/);
});

test("the stage count grows and shrinks without disturbing the stored DPI", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  assert.equal(await m6.setDpiStageCount(5), 5);
  // Growing reveals slots the mouse was already holding, it does not invent them.
  assert.deepEqual((await m6.readStatus()).dpiStages, [400, 800, 1600, 3200, 5000]);
  assert.equal(lastSent(fake, 0x40)?.[14], 5);
  assert.equal(await m6.setDpiStageCount(2), 2);
  assert.deepEqual((await m6.readStatus()).dpiStages, [400, 800]);
  // Shrinking keeps the hidden slots intact for the next time they are shown.
  assert.equal(await m6.setDpiStageCount(5), 5);
  assert.deepEqual((await m6.readStatus()).dpiStages, [400, 800, 1600, 3200, 5000]);
});

test("shrinking below the active stage pulls it back into range", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  await m6.setActiveDpiStage(2);
  assert.equal((await m6.readStatus()).activeDpiStage, 2);
  await m6.setDpiStageCount(1);
  const status = await m6.readStatus();
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.dpi, 400);
});

test("rejects a stage count the mouse cannot hold", async () => {
  const m6 = client(new FakeKeychronMouse());
  for (const count of [0, 6, 2.5, Number.NaN]) {
    await assert.rejects(m6.setDpiStageCount(count), /between 1 and 5/);
  }
});

test("separate X/Y firmware reads and writes DPI through 0x49 and 0x48", async () => {
  for (const version of [5, 6]) {
    const fake = new FakeKeychronMouse();
    fake.version = version;
    fake.features = version >= 6 ? [0, 0x04, 0x01, 0] : [0, 0x04, 0x01, 0];
    fake.dpiY = [450, 800, 1600, 3200, 5000];
    fake.xyEnable = [1, 0, 0, 0, 0, 0, 0, 0];
    const m6 = client(fake);
    assert.deepEqual((await m6.readStatus()).dpiStages, [400, 800, 1600]);
    assert.equal(await m6.setDpiStageValue(1, 2000), 2000);
    const packet = lastSent(fake, 0x48, 0xb3)!;
    assert.equal(packet[4], 3);
    // The edited stage gets X = Y; stage 1 keeps its separate Y and enable flag.
    assert.deepEqual(fake.dpiStages.slice(0, 3), [400, 2000, 1600]);
    assert.deepEqual(fake.dpiY.slice(0, 3), [450, 2000, 1600]);
    if (version >= 6) assert.equal(packet[37], 0x01);
    else assert.deepEqual(Array.from(packet.slice(37, 45)), [1, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(lastSent(fake, 0x40), undefined, `protocol ${version} should not fall back to 0x40`);
    assert.equal(await m6.setActiveDpiStage(2), 2);
    assert.equal(lastSent(fake, 0x48, 0xb3)![1], version >= 6 ? 2 : 0x22);
  }
});

test("writes the polling rate as an index into the mouse's table", async () => {
  const fake = new FakeKeychronMouse();
  assert.equal(await client(fake).setPollingRate(4000), 4000);
  const packet = lastSent(fake, 0x41)!;
  assert.deepEqual(Array.from(packet.slice(0, 10)), [0x41, 4, 4, 0, 1, 2, 3, 4, 5, 6]);
  await assert.rejects(client(fake).setPollingRate(250), /does not support 250 Hz/);
});

test("editable gears take a rate the table lacks, within the model's limit", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd050;
  fake.reportedProductId = 0xd050;
  fake.features = [0x10, 0, 0, 0];
  fake.pollingTable = [0, 1, 2];
  const m3 = client(fake);
  assert.deepEqual((await m3.readStatus()).supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
  assert.equal(await m3.setPollingRate(8000), 8000);
  // The active gear (1, 500 Hz on USB) now holds 8000 Hz.
  assert.deepEqual(Array.from(lastSent(fake, 0x41)!.slice(0, 10)), [0x41, 1, 1, 0, 5, 2, 0, 0, 0, 3]);
  const locked = new FakeKeychronMouse();
  locked.pollingTable = [0, 1, 2];
  await assert.rejects(client(locked).setPollingRate(8000), /does not support 8000 Hz/);
});

test("split polling tables are read and written as a pair", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd029;
  fake.workMode = 1;
  fake.features = [0, 0x04, 0x02, 0];
  const m6 = client(fake);
  // The 2.4 GHz set is in use: gear 5 of [125 ... 8000].
  assert.equal((await m6.readStatus()).pollingRateHz, 8000);
  assert.equal(await m6.setPollingRate(1000), 1000);
  const packet = lastSent(fake, 0x4a)!;
  assert.deepEqual(Array.from(packet.slice(0, 17)), [0x4a, 2, 2, 3, 6, 0, 1, 2, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
  assert.equal(lastSent(fake, 0x41), undefined);
});

test("sensor options are resent together with 1 = on and 2 = off", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  assert.equal(await m6.setLiftOffDistance("High"), "High");
  assert.equal(await m6.setMotionSync(false), false);
  assert.equal(await m6.setAngleSnapping(true), true);
  assert.equal(await m6.setRippleControl(true), true);
  const packet = lastSent(fake, 0x42)!;
  assert.deepEqual(Array.from(packet.slice(0, 12)), [0x42, 2, 1, 1, 2, 0, 1, 0, 1, 0, 0, 0]);
  const status = await m6.readStatus();
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.motionSync, false);
  assert.equal(status.angleSnapping, true);
  assert.equal(status.rippleControl, true);
  assert.equal(await m6.setLiftOffDistance("Low"), "Low");
  assert.equal(fake.lod, 3);
});

test("a model with 1 and 2 mm only offers Low and High", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd03f;
  fake.reportedProductId = 0xd03f;
  const m6 = client(fake);
  const status = await m6.readStatus();
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.ui?.statusNote, "Lift-off: Low is 1 mm, High is 2 mm.");
  await assert.rejects(m6.setLiftOffDistance("Medium"), /no Medium lift-off/);
  assert.equal(await m6.setLiftOffDistance("High"), "High");
  assert.equal(fake.lod, 2);
});

test("lift-off level firmware gets the slider and writes the level byte", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd086;
  fake.reportedProductId = 0xd086;
  fake.version = 6;
  fake.features = [0, 0, 0, 0x10];
  fake.lodLevel = 4;
  fake.lodCount = 11;
  const g6 = client(fake);
  const status = await g6.readStatus();
  assert.equal(status.name, "Keychron G6 HE 8K");
  assert.deepEqual(status.liftOffScale, { value: 4, min: 1, max: 11, millimetres: 1, minMillimetres: 0.7, maxMillimetres: 1.7 });
  assert.equal(status.liftOffDistance, null);
  assert.equal(await g6.setLiftOffScale(7), 7);
  const packet = lastSent(fake, 0x42)!;
  assert.equal(packet[1], 0);
  assert.equal(packet[11], 7);
  assert.equal(fake.lodLevel, 7);
  await assert.rejects(g6.setLiftOffScale(12), /no lift-off level 12/);
});

test("lift-off level firmware with a three-height config writes the level byte, as Launcher does", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd050;
  fake.reportedProductId = 0xd050;
  fake.version = 6;
  fake.features = [0, 0, 0, 0x10];
  fake.lodLevel = 1;
  fake.lodCount = 3;
  const m3 = client(fake);
  const status = await m3.readStatus();
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(await m3.setLiftOffDistance("Low"), "Low");
  const packet = lastSent(fake, 0x42)!;
  assert.equal(packet[1], 0);
  assert.equal(packet[11], 3);
});

test("the 20K FPS switch appears and writes only when flagged", async () => {
  const fake = new FakeKeychronMouse();
  fake.features = [0x80, 0x04, 0, 0];
  const m6 = client(fake);
  assert.equal((await m6.readStatus()).performanceMode, false);
  assert.equal(await m6.setPerformanceMode(true), true);
  assert.equal(lastSent(fake, 0x42)?.[8], 2);
  assert.equal((await m6.readStatus()).performanceMode, true);
  await assert.rejects(client(new FakeKeychronMouse()).setPerformanceMode(true), /no 20K FPS mode/);
});

test("angle tuning uses the dedicated 0x42 form with a signed byte", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  assert.equal(await m6.setAngleTuning(-15), -15);
  const packet = lastSent(fake, 0x42)!;
  assert.equal(packet[9], 2);
  assert.equal(packet[10], 0xf1);
  assert.equal((await m6.readStatus()).angleTuning, -15);
  assert.equal(await m6.setAngleTuning(90), 90);
  await assert.rejects(m6.setAngleTuning(91), /between -90 and 90/);
});

test("from protocol 6 the feature flags come from the 0x02 answer", async () => {
  const fake = new FakeKeychronMouse();
  fake.version = 6;
  fake.features = [0x80, 0, 0, 0];
  const status = await client(fake).readStatus();
  assert.equal(status.performanceMode, false);
  assert.equal(status.angleTuning, undefined);
});

test("debounce, sleep and profile round-trip through their own commands", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  assert.equal(await m6.setDebounceTime(4), 4);
  assert.deepEqual(Array.from(lastSent(fake, 0x43)!.slice(0, 2)), [0x43, 4]);
  assert.equal(await m6.setSleepTimeout(300), 300);
  assert.deepEqual(Array.from(lastSent(fake, 0x0a)!.slice(0, 3)), [0x0a, 1, 5]);
  assert.equal(await m6.setProfile(3), 3);
  assert.deepEqual(Array.from(lastSent(fake, 0x0e)!.slice(0, 2)), [0x0e, 2]);
  const status = await m6.readStatus();
  assert.equal(status.debounceMs, 4);
  assert.equal(status.sleepTimeout, 300);
  assert.equal(status.activeProfile, 3);
  await assert.rejects(m6.setProfile(4), /between 1 and 3/);
  await assert.rejects(m6.setDebounceTime(21), /between 0 and 20/);
  await assert.rejects(m6.setSleepTimeout(90), /must be one of/);
  assert.deepEqual(m6.getSleepOptions().slice(0, 3), [60, 180, 300]);
  assert.equal(m6.getDebounceOptions().length, 21);
});

test("angle tuning is offered only when the mouse flags support for it", async () => {
  const fake = new FakeKeychronMouse();
  fake.features = [0, 0, 0, 0];
  const m6 = client(fake);
  assert.equal((await m6.readStatus()).angleTuning, undefined);
  await assert.rejects(m6.setAngleTuning(5), /does not support angle tuning/);
  assert.equal(lastSent(fake, 0x42), undefined);
});

test("a non-zero ack code fails the write instead of a silent re-read", async () => {
  const fake = new FakeKeychronMouse();
  fake.rejectNext = true;
  await assert.rejects(client(fake).setDebounceTime(3), /rejected command 0x43 \(code 7\)/);
});

test("a mouse that hides its profiles shows no profile card", async () => {
  const fake = new FakeKeychronMouse();
  fake.profileCount = 0;
  const status = await client(fake).readStatus();
  assert.equal(status.activeProfile, null);
  assert.equal(status.profileCount, undefined);
});

test("a mouse that stops answering falls back to its name alone", async () => {
  const fake = new FakeKeychronMouse();
  fake.failStatus = true;
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron M6");
  assert.equal(status.ui?.settingsReady, false);
  assert.deepEqual(status.firmware, ["v1.0.3"]);
});

test("buttons read as their default until remapped, named from the model's config", async () => {
  const fake = new FakeKeychronMouse();
  const status = await client(fake).readStatus();
  assert.deepEqual(status.buttonMappings, {
    Left: "Left Click",
    Middle: "Middle Click",
    Right: "Right Click",
    Back: "Back",
    Forward: "Forward",
    "Tilt Right": "Default",
    "Tilt Left": "Default",
    "Scroll Right": "Scroll Right",
    "Scroll Left": "Scroll Left",
    "Scroll Down": "Scroll Down",
    "Scroll Up": "Scroll Up",
  });
  assert.equal(status.buttonOptions?.[0], "Left Click");
  assert.ok(status.buttonOptions?.includes("Default"));
  assert.deepEqual(Array.from(lastSent(fake, 0x62, 0xb3)!.slice(0, 2)), [0x62, 14]);
});

test("remaps write Launcher's 0x52 records and restore with type 0", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  await m6.setButtonMapping("Forward", "DPI Loop");
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0xb3)!.slice(0, 6)), [0x52, 4, 0, 5, 1, 0]);
  await m6.setButtonMapping("Back", "Forward");
  // "8k" mouse codes: Back 0x080000, Forward 0x100000, high byte first.
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0xb3)!.slice(0, 7)), [0x52, 3, 0, 1, 0x10, 0x00, 0x00]);
  await m6.setButtonMapping("Tilt Left", "Volume Up");
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0xb3)!.slice(0, 6)), [0x52, 9, 0, 3, 0xe9, 0x00]);
  let status = await m6.readStatus();
  assert.equal(status.buttonMappings?.Forward, "DPI Loop");
  assert.equal(status.buttonMappings?.Back, "Forward");
  assert.equal(status.buttonMappings?.["Tilt Left"], "Volume Up");
  await m6.setButtonMapping("Forward", "Default");
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0xb3)!.slice(0, 4)), [0x52, 4, 0, 0]);
  status = await m6.readStatus();
  assert.equal(status.buttonMappings?.Forward, "Forward");
  fake.buttons.set(2, [4, 0, 1, 0]);
  assert.equal((await m6.readStatus()).buttonMappings?.Right, "Macro");
  await assert.rejects(m6.setButtonMapping("Left", "Disabled"), /at least one button as Left Click/);
  await assert.rejects(m6.setButtonMapping("Wheel", "Disabled"), /no "Wheel" button/);
  await assert.rejects(m6.setButtonMapping("Left", "Teleport"), /Unknown button action/);
});

test("repeated default functions get numbered button names", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd035;
  fake.reportedProductId = 0xd035;
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron M1");
  assert.deepEqual(Object.keys(status.buttonMappings ?? {}), ["Left", "Middle", "Right", "Forward", "Back", "Forward 2", "Back 2", "Scroll Down", "Scroll Up"]);
});

test("budget sensors hide the processing toggles and lift-off", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd064;
  fake.reportedProductId = 0xd064;
  const status = await client(fake).readStatus();
  assert.equal(status.ui?.hideProcessingCard, true);
  assert.equal(status.motionSync, undefined);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.supportedLiftOffDistances, undefined);
  assert.equal(status.ui?.dpiStageEditor?.maxDpi, 12000);
});

test("lit models read and write Launcher's 0x23/0x24 lighting", async () => {
  const fake = new FakeKeychronMouse();
  fake.productId = 0xd033;
  fake.reportedProductId = 0xd033;
  const m3 = client(fake);
  const lighting = (await m3.readStatus()).lighting!;
  assert.equal(lighting.mode, "Static");
  assert.equal(lighting.color, "#0060ff");
  assert.equal(lighting.brightness, 100);
  assert.equal(lighting.speed, 3);
  assert.deepEqual(lighting.modes, ["Off", "Static", "Breathing single", "Spectrum", "Wave"]);
  const next: MouseLighting = { ...lighting, mode: "Breathing single", color: "#ff0000", brightness: 50, speed: 5 };
  const confirmed = await m3.setLighting(next);
  assert.deepEqual(Array.from(lastSent(fake, 0x24)!.slice(0, 7)), [0x24, 2, 128, 255, 255, 0, 0]);
  assert.equal(confirmed.mode, "Breathing single");
  assert.equal(confirmed.color, "#ff0000");
  await m3.setLighting({ ...confirmed, mode: "Off" });
  assert.equal(fake.light.mode, 0);
  await assert.rejects(client(new FakeKeychronMouse()).setLighting(next), /has no lighting/);
});

test("shortcut presets remap like Launcher and polling keys follow feature1 bit 4", async () => {
  const fake = new FakeKeychronMouse();
  const m6 = client(fake);
  let status = await m6.readStatus();
  assert.ok(status.buttonOptions?.includes("Copy (Ctrl+C)"));
  assert.ok(!status.buttonOptions?.includes("Polling Loop"));
  await m6.setButtonMapping("Tilt Left", "Copy (Ctrl+C)");
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0xb3)!.slice(0, 7)), [0x52, 9, 0, 8, 0x07, 0x01, 0x06]);
  fake.features = [0x10, 0, 0, 0];
  await m6.setButtonMapping("Tilt Right", "Polling +");
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0xb3)!.slice(0, 6)), [0x52, 8, 0, 13, 2, 0]);
  status = await m6.readStatus();
  assert.ok(status.buttonOptions?.includes("Polling Loop"));
  assert.equal(status.buttonMappings?.["Tilt Left"], "Copy (Ctrl+C)");
  assert.equal(status.buttonMappings?.["Tilt Right"], "Polling +");
});

test("HE capability flags expose actual button records only on supported firmware", async () => {
  const fake = new FakeKeychronMouse(), hid = client(fake);
  assert.equal((await hid.readStatus()).magneticButtons, undefined);
  fake.version = 6; fake.features[1] = 8;
  await hid.close();
  const status = await client(fake).readStatus();
  assert.equal(status.magneticButtons?.buttons[0]?.triggerPoint, 4);
  assert.equal(status.magneticButtons?.buttons[1]?.switchType, "magnetic");
  assert.equal(status.magneticButtons?.canChooseSwitchType, true); await hid.close();
});
test("HE writes preserve the other button and reserved settings and verify readback", async () => {
  const fake = new FakeKeychronMouse(), hid = client(fake); await hid.open();
  const other = fake.heRecords[1]!.slice(0, 17);
  await hid.setMagneticTriggerPoint(0, 6);
  assert.equal(fake.heRecords[0]![5], 35); assert.equal(fake.heRecords[0]![7], 25);
  assert.deepEqual(fake.heRecords[1]!.slice(0, 17), other);
  assert.deepEqual(Array.from(fake.heRecords[0]!.slice(1, 5)), [2,3,25,30]);
  await hid.setMagneticRapidTrigger(1, true, 3);
  assert.equal(fake.heRecords[1]![13], 15); assert.equal(fake.heRecords[1]![15], 15);
  await hid.setMagneticSwitchTypes(["optical", "magnetic"]);
  assert.equal(fake.heRecords[0]![12], 0x11);
  await hid.setMagneticTriggerPoint(0, 12); assert.equal(fake.heRecords[0]![12], 1);
  await assert.rejects(() => hid.setMagneticRapidTrigger(0, true, 1), /remaining/);
  fake.failHeWrite = true; await assert.rejects(() => hid.setMagneticTriggerPoint(1, 2), /did not keep/);
  await hid.close();
});
test("scroll reversal preserves sensor flags and lift off", async () => {
  const fake = new FakeKeychronMouse(), hid = client(fake); await hid.open();
  await hid.setScrollDirection("Reverse");
  assert.equal(fake.scrollReversed, true); assert.equal(fake.motion, true); assert.equal(fake.lod, 1);
  assert.equal((await hid.readStatus()).scrollDirection, "Reverse"); await hid.close();
});

test("pairing shortcut and dynamic DPI are capability-gated and round-trip", async () => {
  const fake = new FakeKeychronMouse(); fake.version = 6; fake.features[1] = 2; fake.features[3] = 32;
  const hid = client(fake); const status = await hid.readStatus();
  assert.deepEqual(status.keychronMouse?.pairing, { mask: 9, holdTime: 4 });
  assert.deepEqual(status.keychronMouse?.dynamicDpi, fake.dynamic);
  await hid.setKeychronPairingShortcut({ mask: 3, holdTime: 99 });
  assert.equal(fake.pairMask, 3); assert.equal(lastSent(fake, 0x0b)![1], 2);
  await assert.rejects(() => hid.setKeychronPairingShortcut({ mask: 31, holdTime: 4 }), /three/);
  const next = { ...fake.dynamic, points: [{ speed: 0, gain: 8 }, { speed: 100, gain: 32 }] };
  await hid.setKeychronDynamicDpi(next); assert.deepEqual(fake.dynamic, next);
  await assert.rejects(() => hid.setKeychronDynamicDpi({ ...next, profile: 0 }), /profile changed/);
  await assert.rejects(() => hid.setKeychronDynamicDpi({ ...next, points: [{ speed: 10, gain: 8 }, { speed: 5, gain: 20 }] }), /Invalid/);
  await hid.close();
});
test("live travel uses device samples, serializes writes and stops after unsubscribe", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fake = new FakeKeychronMouse(), hid = client(fake); await hid.open();
  const samples: Array<[number, number]> = [];
  const stop = hid.onButtonDepth((left, right) => samples.push([left, right]));
  t.mock.timers.tick(50);
  await Promise.all([hid.setMagneticTriggerPoint(0, 4), hid.setScrollDirection("Reverse")]);
  assert.deepEqual(samples, [[40 / 65 * 100, 40 / 65 * 100]]);
  stop();
  const before = fake.sent.length;
  t.mock.timers.tick(200);
  assert.equal(fake.sent.length, before);
  await hid.close();
  assert.equal(fake.opened, false);
});

test("TurboLink controls stay nested in the G6 mouse status and use their own button commands", async () => {
  const fake = new FakeKeychronMouse(); fake.productId = 0xd05a; fake.reportedProductId = 0xd086; fake.workMode = 1;
  const hid = client(fake), status = await hid.readStatus();
  assert.equal(status.name, "Keychron G6 HE 8K");
  assert.equal(status.keychronReceiver?.name, "Keychron TurboLink 8K");
  assert.equal(status.keychronReceiver?.buttonMappings.Polling, "Polling Loop");
  assert.equal(status.keychronReceiver?.lighting.zone, "Receiver");
  await hid.setKeychronReceiverButton({ button: "Switch type", action: "Magnetic (both)" });
  assert.deepEqual(fake.receiverButtons.get(2)?.slice(0, 4), [15, 3, 204, 2]);
  assert.equal(fake.buttons.size, 0);
  await hid.close();
});
