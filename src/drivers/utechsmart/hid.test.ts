import assert from "node:assert/strict";
import test from "node:test";
import { UtechsmartVenusHidClient } from "./hid.js";

const hex = (text: string) => Uint8Array.from(text.trim().split(/\s+/).map((byte) => parseInt(byte, 16)));
// Sanitized real dump excerpts copied from src/utechsmart/venus.test.ts.
const factoryDpi = hex("05 00 00 00 01 16 00 00 00 00 01 2d 00 00 00 00 01 5a 00 00 00 00 01 5c 01 00 00 00 01 7c 04 00 00 00");
const profile2Dpi = hex("05 00 03 00 01 09 00 00 00 00 01 0b 00 00 00 00 01 12 00 00 00 00 01 16 00 00 00 00 01 1b 00 00 00 00");
const factoryButtons = hex(`14 00 81 00 00 00 82 00 00 00 83 00 00 00 99 81 03 00 8a 00 00 00 89 00 00 00
  90 00 1e 00 90 00 1f 00 90 00 20 00 90 00 21 00 90 00 22 00 90 00 23 00
  90 00 24 00 90 00 25 00 90 00 26 00 90 00 27 00 90 00 57 00 90 00 56 00
  00 00 00 00 8d 00 00 00 00 00 00 00 00 00 00 00 8b 00 00 00 8c 00 00 00 ff ff ff ff`);
const profile2Buttons = hex(`14 00 81 00 00 00 82 00 00 00 83 00 00 00 99 81 03 00 8a 00 00 00 89 00 00 00
  8f 01 1e 00 8f 01 1f 00 8f 01 20 00 8f 01 21 00 8f 01 22 00 8f 01 23 00
  8f 01 24 00 8f 01 25 00 8f 01 26 00 8f 01 27 00 8f 01 57 00 8f 01 56 00
  00 00 00 00 8d 00 00 00 00 00 00 00 00 00 00 00 8b 00 00 00 8c 00 00 00 ff ff ff ff`);
function dumpedMemory(): Uint8Array {
  const data = new Uint8Array(0x500);
  data.set(hex("01 00 00 dc 05 c0 02 00 01 00 02 00 02 00 02 00"), 0x2c);
  [0x40, 0x100, 0x1b0, 0x260, 0x310].forEach((base, p) => data.set(p === 1 ? profile2Dpi : factoryDpi, base));
  [0x80, 0x140, 0x1f0, 0x2a0, 0x350].forEach((base, p) => data.set(p === 1 ? profile2Buttons : factoryButtons, base));
  return data;
}
class FakeVenus {
  vendorId = 0x04d9;
  productId = 0xfc55;
  productName = "USB Gaming Mouse";
  opened = false;
  collections = [{ usagePage: 0xffa0, usage: 1, children: [],
    featureReports: [{ reportId: 2, items: [] }, { reportId: 3, items: [] }],
    inputReports: [], outputReports: [] }] as HIDCollectionInfo[];
  memory = dumpedMemory();
  sent: number[][] = [];
  received: number[] = [];
  ignoreWrites = false;
  failCommand: number | null = null;
  failSend?: (bytes: number[]) => Error | undefined;
  malformed = false;
  stripReportId = false;
  private pending: { address: number; length: number } | null = null;
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendFeatureReport(reportId: number, data: BufferSource) {
    assert.equal(reportId, 2);
    const bytes = [...new Uint8Array(data as ArrayBuffer)];
    assert.equal(bytes.length, 15, "WebHID send excludes report id");
    this.sent.push(bytes);
    const [cmd, lo = 0, hi = 0, length = 0] = bytes;
    const failure = this.failSend?.(bytes);
    if (failure) throw failure;
    if (cmd === this.failCommand) { this.failCommand = null; throw new Error("simulated STALL"); }
    const address = lo | (hi << 8);
    if (cmd === 0xf2) {
      assert.equal(this.pending, null, "F2/GET pairs must not overlap");
      assert.ok(length >= 1 && length <= 56);
      this.pending = { address, length };
    } else if (cmd === 0xf3) {
      if (!this.ignoreWrites) this.memory.set(bytes.slice(7, 7 + length), address);
    } else if (cmd === 0xf5) {
      assert.ok(lo === 0 || lo === 1, "F5 is a session bracket, never a polling divisor");
      assert.ok(bytes.slice(2).every((byte) => byte === 0));
    } else {
      assert.deepEqual(bytes, frame("f1 02 08"), "only the settings apply F1 is allowed");
    }
  }
  async receiveFeatureReport(reportId: number) {
    const { address, length } = this.pending!;
    this.pending = null;
    assert.equal(reportId, length <= 8 ? 2 : 3);
    this.received.push(reportId);
    const answer = new Uint8Array(length <= 8 ? 16 : 64);
    answer.set([reportId, 8, 0, 0x60 + (address >> 8), length, 0, 0xfa, 0xfa]);
    answer.set(this.memory.slice(address, address + length), 8);
    if (this.malformed) answer[6] = 0;
    // Exercise byteOffset/byteLength, not just a view of the entire buffer.
    const storage = new Uint8Array(answer.length + 7);
    storage.set(answer, 4);
    return new DataView(storage.buffer, 4 + Number(this.stripReportId), answer.length - Number(this.stripReportId));
  }
  writes() { return this.sent.filter((frame) => frame[0] !== 0xf2); }
}
const device = (fake: FakeVenus) => fake as unknown as HIDDevice;
const client = (fake = new FakeVenus()) => new UtechsmartVenusHidClient(device(fake));
const frame = (body: string) => [...hex(body), ...new Array(15 - hex(body).length).fill(0)];

test("isSupported claims only Venus config collection with feature reports 2 and 3", () => {
  assert.equal(UtechsmartVenusHidClient.isSupported(device(new FakeVenus())), true);
  for (const [vendorId, productId, usagePage, usage] of [
    [0x04d9, 0xfc55, 1, 2], [0x04d9, 0xfc55, 1, 6], [0x04d9, 0xfc55, 0x0c, 1],
    [0x04d9, 0xfc7a, 0xffa0, 1], [0x04d9, 0xfc61, 0xffa0, 1], [0x1234, 0xfc55, 0xffa0, 1],
  ]) {
    const fake = new FakeVenus();
    Object.assign(fake, { vendorId, productId });
    Object.assign(fake.collections[0]!, { usagePage, usage });
    assert.equal(UtechsmartVenusHidClient.isSupported(device(fake)), false);
  }
  for (const reportIds of [[], [2], [3]]) {
    const fake = new FakeVenus();
    fake.collections[0]!.featureReports = reportIds.map((reportId) => ({ reportId, items: [] }));
    assert.equal(UtechsmartVenusHidClient.isSupported(device(fake)), false, `reports ${reportIds}`);
  }
});

test("isSupported finds both reports on a nested vendor collection, not separate collections", () => {
  const fake = new FakeVenus();
  const child = fake.collections[0]!;
  fake.collections = [{ ...child, usagePage: 1, usage: 2, featureReports: [], children: [child] }];
  assert.equal(UtechsmartVenusHidClient.isSupported(device(fake)), true);
  child.featureReports = [{ reportId: 2, items: [] }];
  assert.equal(UtechsmartVenusHidClient.isSupported(device(fake)), false);
  fake.collections.push({ ...child, featureReports: [{ reportId: 3, items: [] }] });
  assert.equal(UtechsmartVenusHidClient.isSupported(device(fake)), false);
});

test("readStatus decodes active profile 2 and Ctrl side buttons from real dump", async () => {
  const fake = new FakeVenus();
  const c = client(fake);
  const status = await c.readStatus();
  assert.equal(fake.opened, true);
  assert.equal(status.brand, "UtechSmart");
  assert.equal(status.name, "UtechSmart Venus MMO");
  assert.equal(status.activeProfile, 2);
  assert.equal(status.profileCount, 5);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.dpiStages, [400, 500, 800, 1000, 1200]);
  assert.equal(status.activeDpiStage, 3);
  assert.equal(status.dpi, 1000);
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.ui?.dpiStageEditor?.countEditable, false);
  assert.equal(status.ui?.dpiStageEditor?.maxStages, 5);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.lighting, undefined);
  assert.equal("setProfile" in c, false);
  assert.equal(Object.keys(status.buttonMappings!).length, 19, "unused slot 18 is hidden");
  assert.equal(status.buttonMappings!.Left, "Left click");
  assert.equal(status.buttonMappings!.Profile, "Profile cycle");
  for (let side = 1; side <= 12; side++) {
    const key = side <= 9 ? String(side) : side === 10 ? "0" : side === 11 ? "Numpad +" : "Numpad -";
    const action = `Keys Ctrl+${key}`;
    assert.equal(status.buttonMappings![`Side ${side}`], action);
    assert.ok(status.buttonOptions!.includes(action));
  }
  assert.equal(status.fixedButtons?.includes("Fire"), true, "unknown fire record is not guessed");
  assert.deepEqual(fake.writes(), []);
  assert.ok(fake.received.includes(3), "long reads use report 3");
  await c.close();
  assert.equal(fake.opened, false);
});

test("readStatus marks fallback DPI values unverified even on a noncurrent enabled stage", async () => {
  for (const [value, range, dpi] of [[5, 0, 220], [9, 0xfe, 400], [5, 0xfe, 220]]) {
    const fake = new FakeVenus();
    fake.memory.set([value!, range!], 0x11d); // Active profile, enabled stage 4; current stage is 3.
    const status = await client(fake).readStatus();
    assert.equal(status.dpiStages![4], dpi);
    assert.equal(status.dpi, 1000);
    assert.equal(status.ui?.valuesVerified, false, `DPI pair ${value}/${range}`);
  }
});

test("readStatus verifies known ranges and ignores fallback in inactive profiles or disabled stages", async () => {
  const fake = new FakeVenus();
  fake.memory[0x2c] = 0; // Factory profile includes ranges 0, 1 and the special range-4 cap.
  fake.memory.set([5, 0xfe], 0x105); // Inactive profile.
  fake.memory.set([5, 0xfe], 0x63); // Disabled stage 5 in the active profile.
  const status = await client(fake).readStatus();
  assert.deepEqual(status.dpiStages, [1000, 2000, 4000, 8200, 16400]);
  assert.equal(status.ui?.valuesVerified, true);
});

test("DPI setter plans minimal F3 from fresh bytes, preserves unknown bytes and verifies", async () => {
  const fake = new FakeVenus();
  fake.memory.set([0xa5, 0x09, 0, 0xc1, 0xc2, 0xc3], 0x104);
  const c = client(fake);
  assert.equal(await c.setDpiStageValue(0, 8200), 8200);
  assert.deepEqual(fake.writes(), [frame("f3 05 01 02 00 00 00 5c 01")]);
  assert.deepEqual([...fake.memory.slice(0x104, 0x10a)], [0xa5, 0x5c, 1, 0xc1, 0xc2, 0xc3]);
  assert.deepEqual(fake.sent.at(-1), frame("f2 05 01 02"), "read touched range after writing");
  assert.equal((await c.readStatus()).dpiStages![0], 8200);
});

test("polling brackets the full active-profile word, applies, closes, then verifies with exact delays", async (t) => {
  const fake = new FakeVenus();
  const delays: { frame: number[] | undefined; ms: number | undefined }[] = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    delays.push({ frame: fake.sent.at(-1), ms });
    return originalTimeout(callback, ms, ...args);
  });
  const c = client(fake);
  for (const [hz, code, second] of [[125, "08", 0x7e], [500, "02", 0]]) {
    fake.memory[0x35] = second!;
    fake.sent = [];
    delays.length = 0;
    const word = `f3 34 00 02 00 00 00 ${code} ${second!.toString(16)}`;
    assert.equal(await c.setPollingRate(hz!), hz);
    assert.deepEqual(fake.writes(), [frame("f5 00"), frame(word), frame("f1 02 08"), frame("f5 01")]);
    assert.deepEqual(delays.slice(-5), [
      { frame: frame("f5 00"), ms: 100 },
      { frame: frame(word), ms: 8 },
      { frame: frame("f1 02 08"), ms: 100 },
      { frame: frame("f5 01"), ms: 100 },
      { frame: frame("f2 34 00 02"), ms: 5 },
    ]);
    assert.equal(fake.memory[0x35], second);
    assert.equal(fake.memory[0x32], 2, "other profile unchanged");
    assert.deepEqual(fake.sent.at(-1), frame("f2 34 00 02"));
  }
});

test("unchanged polling sends no F3, F1 or session brackets", async () => {
  const fake = new FakeVenus();
  assert.equal(await client(fake).setPollingRate(1000), 1000);
  assert.deepEqual(fake.writes(), []);
});

test("polling failures attempt one best-effort close and preserve the original error", async () => {
  for (const failedCommand of [0xf3, 0xf1, 0xf5]) {
    const fake = new FakeVenus();
    const original = new Error("original failure");
    let failed = false;
    fake.failSend = (bytes) => {
      if (bytes[0] === 0xf5 && bytes[1] === 0) return;
      if (!failed && bytes[0] === failedCommand) {
        failed = true;
        return original;
      }
      if (failed && bytes[0] === 0xf5) return new Error("cleanup failure");
    };
    await assert.rejects(() => client(fake).setPollingRate(125), (error) => error === original);
    const commands = failedCommand === 0xf3 ? [frame("f5 00"), frame("f3 34 00 02 00 00 00 08 00")]
      : [frame("f5 00"), frame("f3 34 00 02 00 00 00 08 00"), frame("f1 02 08")];
    if (failedCommand === 0xf5) commands.push(frame("f5 01"));
    assert.deepEqual(fake.writes(), [...commands, frame("f5 01")]);
  }
});

test("polling readback mismatch also attempts a best-effort close", async () => {
  const fake = new FakeVenus();
  fake.ignoreWrites = true;
  await assert.rejects(() => client(fake).setPollingRate(125), /readback mismatch/);
  assert.deepEqual(fake.writes(), [frame("f5 00"), frame("f3 34 00 02 00 00 00 08 00"),
    frame("f1 02 08"), frame("f5 01"), frame("f5 01")]);
});

test("invalid polling rates reject before opening or sending any I/O", async () => {
  const fake = new FakeVenus();
  const c = client(fake);
  for (const hz of [2000, 0, NaN, Infinity, 125.5]) {
    await assert.rejects(() => c.setPollingRate(hz), /polling/);
  }
  assert.equal(fake.opened, false);
  assert.deepEqual(fake.sent, []);
});

test("buttons support singles, modifier combinations and native actions with minimal writes", async () => {
  const fake = new FakeVenus();
  const c = client(fake);
  await c.setButtonMapping("Side 1", "Keys Ctrl+Shift+1");
  assert.deepEqual(fake.writes(), [frame("f3 5b 01 01 00 00 00 03")]);
  assert.deepEqual(fake.sent.at(-1), frame("f2 5b 01 01"));
  for (const action of ["Key A", "Keys Shift+A", "Switch window (Alt+Tab)", "File explorer (Win+E)", "Keys Ctrl+Shift+Alt+Win+1", "DPI up", "DPI down", "Profile cycle", "Disabled", "Right click"]) {
    await c.setButtonMapping("Side 2", action);
    assert.equal((await c.readStatus()).buttonMappings!["Side 2"], action);
  }
  assert.ok(fake.writes().every((bytes) => bytes[0] === 0xf3));
});

test("last left click safety, hidden slot and invalid requests send no writes", async () => {
  const fake = new FakeVenus();
  const c = client(fake);
  await assert.rejects(() => c.setButtonMapping("Left", "Disabled"), /Keep Left click/);
  await assert.rejects(() => c.setButtonMapping("Unused", "Left click"), /no button/);
  await assert.rejects(() => c.setButtonMapping("Side 1", "Teleport"), /not offered/);
  await assert.rejects(() => c.setDpiStageValue(5, 800), /stage/);
  await assert.rejects(() => c.setDpiStageValue(0, 16401), /DPI/);
  await assert.rejects(() => c.setPollingRate(2000), /polling/);
  assert.deepEqual(fake.writes(), []);
  await c.setButtonMapping("Side 1", "Left click");
  await c.setButtonMapping("Left", "Right click");
  assert.equal((await c.readStatus()).buttonMappings!["Side 1"], "Left click");
});

test("every setter rejects readback mismatch", async () => {
  for (const operation of [
    (c: UtechsmartVenusHidClient) => c.setDpiStageValue(0, 8200),
    (c: UtechsmartVenusHidClient) => c.setPollingRate(125),
    (c: UtechsmartVenusHidClient) => c.setButtonMapping("Side 1", "Disabled"),
  ]) {
    const fake = new FakeVenus();
    fake.ignoreWrites = true;
    await assert.rejects(() => operation(client(fake)), /readback mismatch.*0x/i);
  }
});

test("thrown read or write send rejects and releases queue for next operation", async () => {
  for (const command of [0xf2, 0xf3, 0xf5]) {
    const fake = new FakeVenus();
    fake.failCommand = command;
    const c = client(fake);
    const failure = c.setPollingRate(125);
    const recovery = c.readStatus();
    await assert.rejects(() => failure, /simulated STALL/);
    assert.equal((await recovery).activeProfile, 2);
  }
});

test("malformed replies reject; report-ID-stripped replies and subviews work", async () => {
  const fake = new FakeVenus();
  const c = client(fake);
  fake.malformed = true;
  await assert.rejects(() => c.readStatus(), /unexpected read reply/);
  fake.malformed = false;
  fake.stripReportId = true;
  assert.equal((await c.readStatus()).dpi, 1000);
});

test("concurrent requests serialize F2/GET and setters use new memory, no-op emits no F3", async () => {
  const fake = new FakeVenus();
  const c = client(fake);
  await Promise.all([c.readStatus(), c.setDpiStageValue(0, 800), c.setDpiStageValue(0, 400), c.readStatus()]);
  assert.deepEqual(fake.writes(), [frame("f3 05 01 01 00 00 00 12"), frame("f3 05 01 01 00 00 00 09")]);
  await c.setDpiStageValue(0, 400);
  assert.equal(fake.writes().length, 2);
});

test("status rejects corrupt profile, stage/count or polling rather than inventing values", async () => {
  for (const [address, value] of [[0x2c, 5], [0x100, 0], [0x102, 5], [0x140, 21], [0x34, 3]]) {
    const fake = new FakeVenus();
    fake.memory[address!] = value!;
    await assert.rejects(() => client(fake).readStatus(), /profile|stage|count|polling/);
  }
});
