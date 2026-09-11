import assert from "node:assert/strict";
import { test } from "node:test";
import { KeychronM6HidClient } from "./m6-hid.ts";

if (typeof globalThis.window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}

const ACK = 0xe4;

/**
 * Speaks the "8k" Keychron mouse protocol the way the M6 does: 63-byte
 * queries on 0xb3 answered on 0xb4, 20-byte settings on 0xb5 acknowledged on
 * 0xb6 with [0xe4, 0, command].
 */
class FakeM6Device {
  vendorId = 0x3434;
  productId = 0xd060;
  opened = false;
  readonly sent: Array<{ reportId: number; packet: Uint8Array }> = [];
  private listeners = new Map<string, (event: unknown) => void>();
  workMode = 0;
  profile = 1;
  profileCount = 3;
  /** Per connection (USB, 2.4 GHz, Bluetooth): DPI stage low nibble, polling high nibble. */
  levels = [0x10, 0x21, 0x32];
  dpiStages = [400, 800, 1600, 3200, 5000];
  stageCount = 3;
  pollingTable = [0, 1, 2, 3, 4, 5];
  lod = 1;
  ripple = false;
  angleSnap = false;
  motion = true;
  scrollReversed = false;
  maxSpeed = false;
  angle = 0;
  angleSupported = true;
  rejectNext = false;
  debounce = 8;
  sleep = 10;
  battery = 0x80 | 100;
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
    if (reportId === 0xb3) {
      if (packet[0] === 0x06) this.emit(0xb4, this.statusPacket());
      if (packet[0] === 0x04) this.emit(0xb4, new Uint8Array([0x04, 6, ...Array.from("1.0.3", (c) => c.charCodeAt(0)), 0]));
      return;
    }
    if (reportId !== 0xb5) return;
    if (this.rejectNext) {
      this.rejectNext = false;
      this.emit(0xb6, new Uint8Array([ACK, 7, packet[0] ?? 0]));
      return;
    }
    switch (packet[0]) {
      case 0x02: {
        const reply = new Uint8Array(20);
        reply.set([0x02, 5, 0, 0x34, 0x34, 0x60, 0xd0, 0x03, 0x01, this.workMode]);
        this.emit(0xb6, reply);
        return;
      }
      case 0x40:
        this.levels = this.levels.map((level, index) => (level & 0xf0) | (packet[1 + index] ?? 0));
        this.stageCount = packet[14] ?? this.stageCount;
        this.dpiStages = this.dpiStages.map((_, index) => (packet[4 + index * 2] ?? 0) | ((packet[5 + index * 2] ?? 0) << 8));
        break;
      case 0x41:
        this.levels = this.levels.map((level) => (level & 0x0f) | ((packet[1] ?? 0) << 4));
        this.pollingTable = Array.from(packet.slice(3, 3 + (packet[9] ?? 0)));
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
    packet.set(this.pollingTable, 43);
    packet[49] = this.pollingTable.length;
    packet[50] = this.profileCount;
    packet[52] = this.maxSpeed ? 1 : 0;
    packet[53] = this.angleSupported ? 0x04 : 0;
    packet[55] = this.angle & 0xff;
    return packet;
  }

  private emit(reportId: number, bytes: Uint8Array): void {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    queueMicrotask(() => this.listeners.get("inputreport")?.({ reportId, data }));
  }
}

const client = (fake: FakeM6Device): KeychronM6HidClient => new KeychronM6HidClient(fake as unknown as HIDDevice);
const lastSent = (fake: FakeM6Device, command: number) =>
  [...fake.sent].reverse().find(({ reportId, packet }) => reportId === 0xb5 && packet[0] === command)?.packet;

test("Keychron M6 is limited to its verified 0xffc1 control interface", () => {
  const fake = new FakeM6Device();
  assert.equal(KeychronM6HidClient.isSupported(fake as unknown as HIDDevice), true);
  const viaOnly = { ...fake, collections: [{ usagePage: 0xff60, usage: 0x61, outputReports: [{ reportId: 0 }], inputReports: [{ reportId: 0 }] }] };
  assert.equal(KeychronM6HidClient.isSupported(viaOnly as unknown as HIDDevice), false);
});

test("reads the full M6 status report", async () => {
  const status = await client(new FakeM6Device()).readStatus();
  assert.equal(status.name, "Keychron M6");
  assert.equal(status.dpi, 400);
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.pollingRateHz, 500);
  assert.deepEqual(status.supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
  assert.equal(status.liftOffDistance, "Medium");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.equal(status.motionSync, true);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.rippleControl, false);
  assert.equal(status.angleTuning, 0);
  assert.equal(status.debounceMs, 8);
  assert.equal(status.sleepTimeout, 600);
  assert.equal(status.activeProfile, 2);
  assert.equal(status.profileCount, 3);
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Charging");
  assert.deepEqual(status.firmware, ["v1.0.3"]);
  assert.equal(status.ui?.hideProcessingCard, undefined);
  assert.equal(status.ui?.hideSleepCard, undefined);
});

test("reads the DPI and polling levels of the connection in use", async () => {
  const fake = new FakeM6Device();
  fake.productId = 0xd029;
  fake.workMode = 1;
  const status = await client(fake).readStatus();
  // 2.4 GHz slot: stage 1 (800 DPI) and polling index 2 (1000 Hz).
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.connectionType, "Wireless");
});

test("DPI writes follow the active stage and keep the stage count", async () => {
  const fake = new FakeM6Device();
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
  const m6 = client(new FakeM6Device());
  await assert.rejects(m6.setActiveDpiStage(3), /between 1 and 3/);
  await assert.rejects(m6.setDpiStageValue(4, 800), /between 1 and 3/);
});

test("writes the polling rate as an index into the mouse's table", async () => {
  const fake = new FakeM6Device();
  assert.equal(await client(fake).setPollingRate(4000), 4000);
  const packet = lastSent(fake, 0x41)!;
  assert.deepEqual(Array.from(packet.slice(0, 10)), [0x41, 4, 4, 0, 1, 2, 3, 4, 5, 6]);
  await assert.rejects(client(fake).setPollingRate(250), /does not support 250 Hz/);
});

test("sensor options are resent together with 1 = on and 2 = off", async () => {
  const fake = new FakeM6Device();
  const m6 = client(fake);
  assert.equal(await m6.setLiftOffDistance("High"), "High");
  assert.equal(await m6.setMotionSync(false), false);
  assert.equal(await m6.setAngleSnapping(true), true);
  assert.equal(await m6.setRippleControl(true), true);
  const packet = lastSent(fake, 0x42)!;
  assert.deepEqual(Array.from(packet.slice(0, 9)), [0x42, 2, 1, 1, 2, 0, 1, 0, 1]);
  const status = await m6.readStatus();
  assert.equal(status.liftOffDistance, "High");
  assert.equal(status.motionSync, false);
  assert.equal(status.angleSnapping, true);
  assert.equal(status.rippleControl, true);
  assert.equal(await m6.setLiftOffDistance("Low"), "Low");
  assert.equal(fake.lod, 3);
});

test("angle tuning uses the dedicated 0x42 form with a signed byte", async () => {
  const fake = new FakeM6Device();
  const m6 = client(fake);
  assert.equal(await m6.setAngleTuning(-15), -15);
  const packet = lastSent(fake, 0x42)!;
  assert.equal(packet[9], 2);
  assert.equal(packet[10], 0xf1);
  assert.equal((await m6.readStatus()).angleTuning, -15);
  await assert.rejects(m6.setAngleTuning(45), /between -30 and 30/);
});

test("debounce, sleep and profile round-trip through their own commands", async () => {
  const fake = new FakeM6Device();
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
  const fake = new FakeM6Device();
  fake.angleSupported = false;
  const m6 = client(fake);
  assert.equal((await m6.readStatus()).angleTuning, undefined);
  await assert.rejects(m6.setAngleTuning(5), /does not support angle tuning/);
  assert.equal(lastSent(fake, 0x42), undefined);
});

test("a non-zero ack code fails the write instead of a silent re-read", async () => {
  const fake = new FakeM6Device();
  fake.rejectNext = true;
  await assert.rejects(client(fake).setDebounceTime(3), /rejected command 0x43 \(code 7\)/);
});

test("a mouse that hides its profiles shows no profile card", async () => {
  const fake = new FakeM6Device();
  fake.profileCount = 0;
  const status = await client(fake).readStatus();
  assert.equal(status.activeProfile, null);
  assert.equal(status.profileCount, undefined);
});
