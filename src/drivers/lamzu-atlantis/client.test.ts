import assert from "node:assert/strict";
import test from "node:test";

import {
  LAMZU_ATLANTIS_COMMAND as COMMAND,
  LAMZU_ATLANTIS_FLASH as FLASH,
  LAMZU_ATLANTIS_USAGE,
  LAMZU_ATLANTIS_USAGE_PAGE,
  LAMZU_ATLANTIS_VENDOR_ID,
  LAMZU_ATLANTIS_WRITE_ACTIVE_PROFILE as WRITE_ACTIVE_PROFILE,
  lamzuAtlantisSealField,
} from "@openmouse/protocol/lamzu";
import { pulsarVgnEncodeDpi } from "@openmouse/protocol/pulsar";
import { LamzuAtlantisHidClient } from "./hid.ts";

const REPORT_ID = 8;
const PACKET = 16;

/**
 * A mouse that keeps real flash state and answers report 8 the way the
 * hardware does, so a setter's write and its read-back go through the same
 * bytes the device would see. Replies are delivered asynchronously, which is
 * what makes the interleaving and lifecycle tests meaningful.
 */
class FakeAtlantis extends EventTarget {
  readonly vendorId = LAMZU_ATLANTIS_VENDOR_ID;
  readonly productId: number;
  readonly productName = "LAMZU Atlantis Pro";
  readonly collections = [{
    usagePage: LAMZU_ATLANTIS_USAGE_PAGE,
    usage: LAMZU_ATLANTIS_USAGE,
    children: [],
    inputReports: [{ reportId: REPORT_ID }],
    outputReports: [{ reportId: REPORT_ID }],
    featureReports: [],
  }] as unknown as HIDCollectionInfo[];

  opened = false;
  flash = new Uint8Array(256);
  profile = 0;
  sent: Uint8Array[] = [];
  opens = 0;
  /** Set to drop replies, so a caller's timeout path can be exercised. */
  mute = false;
  /** Adds a leading byte to the input DataView, as a real event can. */
  offsetReplies = false;
  /** Replies queued while held, released by releaseReplies(). */
  private held: Array<() => void> = [];
  holdReplies = false;
  /** Resolves once the device has received a report. */
  reportSeen: Promise<void>;
  private announceReport!: () => void;

  releaseReplies(): void {
    this.holdReplies = false;
    const queued = this.held;
    this.held = [];
    for (const deliver of queued) deliver();
  }

  constructor(productId = 0xf50f) {
    super();
    this.reportSeen = new Promise<void>((resolve) => { this.announceReport = resolve; });
    this.productId = productId;
    this.writeField(FLASH.reportRate, [0x02]);
    this.writeField(FLASH.dpiStageCount, [2]);
    this.writeField(FLASH.currentDpi, [0]);
    this.writeField(FLASH.liftOffDistance, [1]);
    this.writeField(FLASH.debounceTime, [4]);
    this.writeField(FLASH.sleepTime, [6]);
    this.writeField(FLASH.motionSync, [1]);
    this.writeField(FLASH.angleSnapping, [0]);
    this.writeField(FLASH.rippleControl, [0]);
    this.writeField(FLASH.performanceState, [1]);
    this.writeField(FLASH.highPerformance, [0]);
    this.flash.set(pulsarVgnEncodeDpi(400), FLASH.dpiValues);
    this.flash.set(pulsarVgnEncodeDpi(1600), FLASH.dpiValues + 4);
    this.writeField(FLASH.dpiStageColors, [0xff, 0x00, 0x00]);
    this.writeField(FLASH.dpiStageColors + 4, [0x00, 0xff, 0x00]);
  }

  writeField(address: number, values: readonly number[]): void {
    this.flash.set(lamzuAtlantisSealField([...values]), address);
  }

  async open(): Promise<void> {
    this.opens += 1;
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    assert.equal(reportId, REPORT_ID, "the report id travels separately from the body");
    const body = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);
    assert.equal(body.length, PACKET, "the body excludes the report id");
    this.sent.push(Uint8Array.from(body));
    this.announceReport();
    if (this.mute) return;

    const reply = new Uint8Array(PACKET);
    reply.set(body.subarray(0, 5));
    const command = body[0]!;
    const address = (body[2]! << 8) | body[3]!;
    const length = body[4]!;
    if (command === COMMAND.readFlashData) {
      reply.set(this.flash.subarray(address, address + length), 5);
    } else if (command === COMMAND.writeFlashData) {
      this.flash.set(body.subarray(5, 5 + length), address);
    } else if (command === COMMAND.getCurrentConfig) {
      reply[4] = 1;
      reply[5] = this.profile;
    } else if (command === WRITE_ACTIVE_PROFILE) {
      if (body[5]! > 3) reply[1] = 1;
      else this.profile = body[5]!;
    } else if (command === COMMAND.batteryLevel) {
      reply[4] = 2;
      reply.set([95, 1, 0x10, 0x82], 5);
    } else if (command === COMMAND.readVersionId) {
      reply[4] = 2;
      reply.set([1, 0x24], 5);
    } else {
      reply[1] = 1;
    }
    let sum = REPORT_ID;
    for (let i = 0; i < PACKET - 1; i += 1) sum += reply[i]!;
    reply[PACKET - 1] = (0x55 - (sum & 0xff)) & 0xff;

    const deliver = () => {
      const buffer = this.offsetReplies
        ? new Uint8Array([0xaa, ...reply]).buffer.slice(0)
        : reply.buffer.slice(0);
      const view = this.offsetReplies
        ? new DataView(buffer, 1, PACKET)
        : new DataView(buffer, 0, PACKET);
      this.dispatchEvent(Object.assign(new Event("inputreport"), { reportId: REPORT_ID, data: view }));
    };
    if (this.holdReplies) this.held.push(deliver);
    else queueMicrotask(deliver);
  }
}

const clientFor = (device: FakeAtlantis) =>
  new LamzuAtlantisHidClient(device as unknown as HIDDevice);

test("a full status read comes back from real flash bytes", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  const status = await client.readStatus();
  assert.equal(status.brand, "Lamzu");
  assert.equal(status.name, "Lamzu Atlantis");
  assert.deepEqual(status.dpiStages, [400, 1600]);
  assert.deepEqual(status.dpiStageColors, ["#ff0000", "#00ff00"]);
  assert.equal(status.pollingRateHz, 500);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.debounceMs, 4);
  assert.equal(status.sleepTimeout, 60);
  assert.equal(status.batteryPercent, 95);
  assert.equal(status.batteryVoltageMv, 4226);
  assert.equal(status.activeProfile, 1);
  assert.deepEqual(status.firmware, ["Mouse v1.24"]);
  await client.close();
});

test("a reply whose DataView has a non-zero offset is still decoded", async () => {
  const device = new FakeAtlantis();
  device.offsetReplies = true;
  const client = clientFor(device);
  assert.equal((await client.readStatus()).pollingRateHz, 500);
  await client.close();
});

test("setters land in flash and read back through the device", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();

  assert.equal(await client.setDebounceTime(9), 9);
  assert.equal(device.flash[FLASH.debounceTime], 9);
  assert.equal(await client.setSleepTimeout(30), 30);
  assert.equal(device.flash[FLASH.sleepTime], 3, "the byte counts ten-second units");
  assert.equal(await client.setPollingRate(1000), 1000);
  assert.equal(device.flash[FLASH.reportRate], 0x01, "the cable uses the wired encoding of 1000 Hz");
  assert.equal(await client.setLiftOffDistance("Medium"), "Medium");
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(device.flash[FLASH.angleSnapping], 1);
  assert.equal(await client.setDpiStageValue(1, 3200), 3200);
  assert.deepEqual((await client.readStatus()).dpiStages, [400, 3200]);
  await client.close();
});

test("the 4K receiver writes the receiver encoding of 1,000 Hz", async () => {
  const device = new FakeAtlantis(0xf510);
  const client = clientFor(device);
  await client.readStatus();
  assert.equal(await client.setPollingRate(1000), 1000);
  assert.equal(device.flash[FLASH.reportRate], 0x10);
  await client.close();
});

test("an out-of-range stage index never reaches the device", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();
  const before = Uint8Array.from(device.flash);
  const sent = device.sent.length;

  // -8 would scale to the DPI stages at address 12, and 13 to the button
  // actions at 96, with the colour reading back cleanly from either.
  await assert.rejects(() => client.setDpiStageColor(-8, "#010203"), /no DPI stage/);
  await assert.rejects(() => client.setDpiStageColor(13, "#010203"), /no DPI stage/);
  await assert.rejects(() => client.setDpiStageColor(0.5, "#010203"), /no DPI stage/);
  await assert.rejects(() => client.setDpiStageValue(99, 800), /no DPI stage/);
  await assert.rejects(() => client.setProfile(9), /profiles 1 to 4/);

  assert.deepEqual(device.flash, before, "no flash byte moved");
  assert.equal(device.sent.length, sent, "no report was sent");
  await client.close();
});

test("a setter that arrives mid-operation waits its turn", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();

  // The second setter must start only once the first is genuinely in flight,
  // with its reply withheld. Starting both synchronously proves nothing: they
  // queue before the first has sent anything.
  device.holdReplies = true;
  const first = client.setDebounceTime(4);
  await device.reportSeen;
  const second = client.setDebounceTime(6);
  await Promise.resolve();
  device.releaseReplies();

  assert.equal(await first, 4, "the first setter verifies its own write, not the second's");
  assert.equal(await second, 6);
  assert.equal(device.flash[FLASH.debounceTime], 6);
  await client.close();
});

test("a read arriving mid-setter cannot steal the in-flight reply", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();

  device.holdReplies = true;
  const write = client.setPollingRate(125);
  await device.reportSeen;
  const read = client.readStatus();
  await Promise.resolve();
  device.releaseReplies();

  assert.equal(await write, 125);
  assert.equal((await read).pollingRateHz, 125);
  await client.close();
});

test("both DPI axes stay consistent across a stage write and a stage switch", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  const initial = await client.readStatus();
  assert.equal(initial.dpi, 400);
  assert.equal(initial.dpiY, 400);

  // The encoder writes one value to both axes, so the cached Y has to follow.
  await client.setDpiStageValue(0, 800);
  const written = await client.readStatus(true);
  assert.equal(written.dpi, 800);
  assert.equal(written.dpiY, 800, "Y moved with X");

  await client.setActiveDpiStage(1);
  const switched = await client.readStatus(true);
  assert.equal(switched.dpi, 1600);
  assert.equal(switched.dpiY, 1600, "Y belongs to the newly selected stage");
  await client.close();
});

test("switching profiles drops the settings cached for the old one", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();
  await client.setActiveDpiStage(1);

  // Profile 2 has different stages and sits on stage 0.
  await client.setProfile(2);
  device.writeField(FLASH.currentDpi, [0]);
  device.flash.set(pulsarVgnEncodeDpi(800), FLASH.dpiValues);

  // setDpi must not reuse the old profile's active stage (1).
  await client.setDpi(2400);
  assert.equal((await client.readStatus()).dpiStages?.[0], 2400);
  await client.close();
});

test("changing the stage count invalidates the cached list in both directions", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();

  device.flash.set(pulsarVgnEncodeDpi(6400), FLASH.dpiValues + 8);
  device.writeField(FLASH.dpiStageColors + 8, [0x00, 0x00, 0xff]);
  assert.equal(await client.setDpiStageCount(3), 3);
  const grown = await client.readStatus(true);
  assert.deepEqual(grown.dpiStages, [400, 1600, 6400], "the new stage is loaded, not left missing");
  assert.deepEqual(grown.dpiStageColors, ["#ff0000", "#00ff00", "#0000ff"]);

  await client.setActiveDpiStage(2);
  assert.equal(await client.setDpiStageCount(1), 1);
  const shrunk = await client.readStatus(true);
  assert.deepEqual(shrunk.dpiStages, [400]);
  assert.equal(shrunk.activeDpiStage, 0, "the active stage cannot point past the list");
  await client.close();
});

test("closing settles a request already on the wire", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();

  // Wait until the device has actually received a report, so close() lands on
  // an exchange waiting for a reply rather than on one that has not sent yet.
  device.mute = true;
  const started = Date.now();
  const pending = client.readStatus().then(() => "resolved", (error: Error) => error.message);
  await device.reportSeen;
  await client.close();

  const outcome = await pending;
  assert.match(String(outcome), /closed/, "cancelled, not left to time out");
  assert.ok(Date.now() - started < 600, "close did not wait for the response timeout");
  assert.equal(device.opened, false);
});

test("closing and reopening leaves the client usable", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await client.readStatus();

  // Overlapping these let the reopen memoize a resolved open while the close
  // was still about to remove the listener, wedging every later open.
  const closing = client.close();
  const reopening = client.open();
  await Promise.all([closing, reopening]);

  await client.open();
  assert.equal(device.opened, true, "the device is open again");
  assert.equal((await client.readStatus()).pollingRateHz, 500, "and still answers");
  await client.close();
});

test("open is not attempted twice by concurrent reads", async () => {
  const device = new FakeAtlantis();
  const client = clientFor(device);
  await Promise.all([client.readStatus(), client.readStatus()]);
  assert.equal(device.opens, 1, "a second open() would reject in Chrome");
  await client.close();
});
