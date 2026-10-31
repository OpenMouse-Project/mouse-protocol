import assert from "node:assert/strict";
import test from "node:test";

import {
  LEOBOG_GM3_BUTTON_NAMES,
  LEOBOG_GM3_DEFAULT_BUTTONS,
  LEOBOG_GM3_LINK_COMMAND,
  LEOBOG_GM3_ONBOARD_LENGTH,
  LEOBOG_GM3_POWER_COMMAND,
  LEOBOG_GM3_POWER_PACKET_LENGTH,
  LEOBOG_GM3_POWER_REPORT_ID,
  LEOBOG_GM3_RECEIVER_PRODUCT_ID,
  LEOBOG_GM3_VENDOR_ID,
  LEOBOG_GM3_WIRED_PRODUCT_ID,
  leobogGm3DecodeOnboard,
  leobogGm3EncodeButtonTable,
  leobogGm3FindButtonAction,
} from "@openmouse/protocol/leobog";
import { LeobogGm3HidClient } from "./hid.ts";

const CONFIG_READ_COMMAND = 0x44;
const CONFIG_WRITE_COMMAND = 0x04;
const BUTTON_WRITE_COMMAND = 0x01;

/** The block the receiver answered on hardware, restored to its first state. */
function capturedBlock(): Uint8Array {
  const block = new Uint8Array(LEOBOG_GM3_ONBOARD_LENGTH);
  block.set([
    0x64, 0x18, 0x04, 0x16, 0x00, 0x01, 0x00, 0x07, 0x00, 0x09,
    0x00, 0x0f, 0x00, 0x2f, 0x00, 0x47, 0x00, 0x77, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x09,
    0x00, 0x0f, 0x00, 0x2f, 0x00, 0x47, 0x00, 0x77, 0x00, 0x00,
  ]);
  // Auto-sleep 5 minutes, then the battery level the block also reports.
  block[0x4a] = 5;
  block[0x4c] = 0x5b;
  return block;
}

/**
 * Answers each captured command the way the receiver does: the short replies
 * echo their command, and `04 00` replaces the stored block.
 */
class FakeGm3 {
  vendorId = LEOBOG_GM3_VENDOR_ID;
  productName = "Gaming MS";
  opened = false;
  collections = [{
    usagePage: 0xff02,
    usage: 0x0002,
    featureReports: [{ reportId: LEOBOG_GM3_POWER_REPORT_ID }],
    inputReports: [],
    outputReports: [],
    children: [],
  }] as unknown as HIDCollectionInfo[];
  block = capturedBlock();
  /** Every payload WebHID would have sent, report id stripped. */
  readonly sent: Uint8Array[] = [];
  readonly writes: Uint8Array[] = [];
  /** How many battery replies should fail before one succeeds. */
  failPowerReceives = 0;
  /** Percentage returned by the receiver's live power query. */
  powerPercent = 100;
  /** When true the link query throws instead of answering. */
  failLink = false;
  /** When true the configuration commands time out, as they do on a sleeping mouse. */
  sleepConfig = false;
  /** When true the block reply never arrives, like a real HID timeout. */
  hangConfig = false;
  /** When true the battery reply never arrives, like a receiver gone quiet. */
  hangPower = false;
  /** Delay before the configuration reply, in milliseconds. */
  configReplyDelayMs = 0;
  /** How many stale replies precede the matching configuration reply. */
  staleConfigReplies = 0;
  /** How many block reads the driver actually attempted. */
  configReadAttempts = 0;
  /** Gap the driver left between the block read reply and the write frame. */
  gapBeforeWriteMs = -1;
  /** When true `04 00` is accepted but ignored, to exercise the read-back check. */
  ignoreWrites = false;
  /** Byte 8 of the `07 00` answer: 1 awake, 0 asleep. */
  linkState = 1;
  omitReportId = false;
  private lastCommand: number | null = null;
  private lastConfigReplyAt = 0;

  constructor(public productId: number) {}

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    assert.equal(reportId, LEOBOG_GM3_POWER_REPORT_ID);
    const payload = new Uint8Array(data as ArrayBuffer);
    this.sent.push(payload);
    this.lastCommand = payload[1]!;

    if (this.lastCommand === CONFIG_WRITE_COMMAND) {
      this.gapBeforeWriteMs = this.lastConfigReplyAt === 0
        ? -1
        : Date.now() - this.lastConfigReplyAt;
      // WebHID payloads drop the report id, so the length sits at 5-6 and the
      // payload starts at 7.
      const length = payload[5]! | (payload[6]! << 8);
      const block = payload.slice(7, 7 + length);
      this.writes.push(block);
      if (!this.ignoreWrites) this.block = block;
    }
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    assert.equal(reportId, LEOBOG_GM3_POWER_REPORT_ID);
    const command = this.lastCommand;

    if (command === LEOBOG_GM3_LINK_COMMAND) {
      if (this.failLink) throw new Error("Failed to receive the feature report.");
      return this.view(this.frame(LEOBOG_GM3_LINK_COMMAND, 0x00, Uint8Array.of(this.linkState)));
    }

    if (command === CONFIG_READ_COMMAND) {
      this.configReadAttempts++;
      if (this.sleepConfig) throw new Error("Failed to receive the feature report.");
      if (this.hangConfig) await new Promise<never>(() => undefined);
      if (this.configReplyDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.configReplyDelayMs));
      }
      this.lastConfigReplyAt = Date.now();
      if (this.staleConfigReplies > 0) {
        this.staleConfigReplies--;
        return this.view(this.frame(LEOBOG_GM3_POWER_COMMAND, 0x01, Uint8Array.of(0x5b)));
      }
      return this.view(this.frame(CONFIG_READ_COMMAND, 0x00, this.block));
    }

    if (command === LEOBOG_GM3_POWER_COMMAND) {
      if (this.hangPower) await new Promise<never>(() => undefined);
      if (this.failPowerReceives > 0) {
        this.failPowerReceives--;
        throw new Error("Failed to receive the feature report.");
      }
      return this.view(this.frame(LEOBOG_GM3_POWER_COMMAND, 0x01, Uint8Array.of(this.powerPercent)));
    }

    throw new Error(`unexpected command ${command}`);
  }

  private frame(command: number, subCommand: number, payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(LEOBOG_GM3_POWER_PACKET_LENGTH);
    frame[0] = LEOBOG_GM3_POWER_REPORT_ID;
    frame[2] = command;
    frame[3] = subCommand;
    frame[4] = 0x01;
    frame[6] = payload.length & 0xff;
    frame[7] = (payload.length >> 8) & 0xff;
    frame.set(payload, 8);
    frame[1] = frame.subarray(2).reduce((sum, byte) => sum + byte, 0) & 0xff;
    return this.omitReportId ? frame.slice(1) : frame;
  }

  private view(frame: Uint8Array): DataView {
    return new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  }
}

const client = (fake: FakeGm3) =>
  new LeobogGm3HidClient(fake as unknown as HIDDevice);

test("claims the GM3 receiver control collection", () => {
  assert.equal(
    LeobogGm3HidClient.isSupported(new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID) as unknown as HIDDevice),
    true,
  );
  assert.equal(
    LeobogGm3HidClient.isSupported(new FakeGm3(LEOBOG_GM3_WIRED_PRODUCT_ID) as unknown as HIDDevice),
    true,
  );
  assert.equal(
    LeobogGm3HidClient.isSupported(new FakeGm3(0x002f) as unknown as HIDDevice),
    false,
  );
});

test("rejects a 258a device without the report-9 collection", () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.collections = [{ usagePage: 0xff02, usage: 2, featureReports: [], children: [] }] as unknown as HIDCollectionInfo[];
  assert.equal(LeobogGm3HidClient.isSupported(fake as unknown as HIDDevice), false);
});

test("reports the settings the hardware-confirmed block describes", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const status = await client(fake).readStatus();

  assert.equal(status.brand, "LEOBOG");
  assert.equal(status.name, "LEOBOG GM3");
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.connectionType, "Wireless");
  assert.deepEqual(status.dpiStages, [800, 1000, 1600, 4800, 7200, 12000]);
  assert.equal(status.dpi, 800);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.debounceMs, 2);
  assert.equal(status.sleepTimeout, 300);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.ui?.hideSleepCard, undefined);
  assert.deepEqual(status.ui?.dpiStageEditor, {
    maxStages: 6,
    countEditable: true,
    minDpi: 100,
    maxDpi: 24000,
    stepDpi: 100,
  });

  // Link, the 400-byte block, then live battery. The receiver's power query
  // is the freshest battery reading; the block carries the last known level.
  assert.deepEqual([...fake.sent[0]!.subarray(0, 7)], [0x09, 0x07, 0x00, 0x01, 0x00, 0x01, 0x00]);
  assert.deepEqual([...fake.sent[1]!.subarray(0, 7)], [0xd6, 0x44, 0x00, 0x01, 0x00, 0x90, 0x01]);
  assert.deepEqual([...fake.sent[2]!.subarray(0, 7)], [0x0c, 0x09, 0x01, 0x01, 0x00, 0x01, 0x00]);
});

test("offers every DPI the block can encode", () => {
  const options = client(new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID)).getDpiOptions();

  assert.equal(options.length, 240);
  assert.equal(options[0], 100);
  assert.equal(options.at(-1), 24000);
  assert.deepEqual(client(new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID)).getDebounceOptions(), [2, 4, 6, 8, 10, 12]);
  assert.deepEqual(
    client(new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID)).getSleepOptions(),
    [0, 60, 120, 180, 300, 600, 900, 1200],
  );
});

test("falls back to battery plus a note while the mouse sleeps", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.sleepConfig = true;
  fake.linkState = 0;
  const status = await client(fake).readStatus();

  assert.equal(status.batteryPercent, 100);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.dpiStages, undefined);
  assert.match(status.ui?.statusNote ?? "", /press a button/i);
});

/**
 * A sleeping receiver accepts the block request and then never answers, so the
 * raw HID call sits on its own ~5 s timeout. Status polls run every 5 s, so
 * without a deadline one poll would freeze the page.
 */
test("a block read that never answers cannot stall a status poll", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.hangConfig = true;
  const unit = client(fake);

  const started = Date.now();
  const status = await unit.readStatus();
  const elapsed = Date.now() - started;

  assert.equal(status.batteryPercent, 100);
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /did not answer a settings refresh/);
  assert.ok(elapsed < 1500, `status poll took ${elapsed} ms`);
  assert.equal(fake.configReadAttempts, 1);

  // While backing off, the next poll must not queue another doomed read.
  await unit.readStatus();
  assert.equal(fake.configReadAttempts, 1);
});

/**
 * WebHID cannot cancel a receive, so the one a deadline abandons stays on the
 * handle until the browser gives up on it. Polling again straight away would
 * stack a second wait on top of the first, which is the stutter that reached
 * beyond the page into the browser's own tab switching.
 */
test("after an abandoned receive the next poll leaves the handle alone", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.hangConfig = true;
  const unit = client(fake);

  const first = await unit.readStatus();
  const traffic = fake.sent.length;

  const replayed = await unit.readStatus();
  assert.deepEqual(replayed, { ...first });
  assert.equal(fake.sent.length, traffic, "a skipped poll must not touch the device");

  await new Promise((resolve) => setTimeout(resolve, 4_100));
  await unit.readStatus();
  assert.ok(fake.sent.length > traffic, "the poll resumes once the handle has settled");
});

test("reuses the block it just read instead of re-reading every poll", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  await unit.readStatus();
  assert.equal(fake.configReadAttempts, 1);
  const status = await unit.readStatus();
  assert.equal(fake.configReadAttempts, 1);
  assert.deepEqual(status.dpiStages, [800, 1000, 1600, 4800, 7200, 12000]);
});

test("notices a DPI stage changed by a mouse button within two seconds", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_WIRED_PRODUCT_ID);
  const unit = client(fake);

  assert.equal(unit.pollIntervalMs, 2_000);
  assert.equal((await unit.readStatus()).activeDpiStage, 0);

  // The mouse's DPI button changes the active stage on the device itself.
  fake.block[3] = 0x26;
  await new Promise((resolve) => setTimeout(resolve, 2_100));

  const status = await unit.readStatus();
  assert.equal(fake.configReadAttempts, 2);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.dpi, 1000);
});

/**
 * A reply that takes 2.1 s measured on the cable is beyond a poll's budget, so
 * the poll gives up instead of holding the page and the browser behind it for
 * two seconds. There is no earlier block to fall back on here, so it says the
 * refresh did not land.
 */
test("a status poll gives up on a slow cable reply instead of stalling", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_WIRED_PRODUCT_ID);
  fake.configReplyDelayMs = 2_100;
  const unit = client(fake);

  const started = Date.now();
  const status = await unit.readStatus();
  const elapsed = Date.now() - started;

  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /did not answer a settings refresh/);
  assert.equal(status.dpiStages, undefined);
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Charging");
  assert.ok(elapsed < 1_500, `a slow cable reply held the poll for ${elapsed} ms`);
});

/**
 * The same slow reply is fine for a write: a write has to see the block it is
 * modifying and read it back, so it waits the full budget.
 */
test("a write still waits for the slow cable reply", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_WIRED_PRODUCT_ID);
  fake.configReplyDelayMs = 2_100;
  const unit = client(fake);

  const started = Date.now();
  const kept = await unit.setDpiStageValue(0, 1600);
  const elapsed = Date.now() - started;

  assert.equal(kept, 1600);
  assert.equal(leobogGm3DecodeOnboard(fake.block)?.dpiStages[0], 1600);
  assert.ok(elapsed >= 2_100, `the write gave up on a reply that was still coming: ${elapsed} ms`);
});

/**
 * A reply that takes 1.5 s is beyond a poll's budget, so the poll gives up and
 * the next one gives the handle and the browser room instead of queueing
 * straight behind whatever is still settling.
 */
test("a poll that had to give up paces the next one down", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_WIRED_PRODUCT_ID);
  fake.configReplyDelayMs = 1_500;
  const unit = client(fake);

  const status = await unit.readStatus();
  assert.equal(status.ui?.settingsReady, false);
  const traffic = fake.sent.length;

  await unit.readStatus();
  assert.equal(fake.sent.length, traffic, "the poll right after a rough one must wait");
});

test("skips a stale battery reply and keeps reading the configuration", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.staleConfigReplies = 2;
  const unit = client(fake);

  const status = await unit.readStatus();
  assert.equal(status.batteryPercent, 100);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(fake.configReadAttempts, 3);
});

test("writes one DPI stage and confirms the read-back", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  assert.equal(await unit.setDpiStageValue(1, 1100), 1100);
  assert.equal(fake.writes.length, 1);
  // The write is `04 00` with a 400-byte block; the read-back follows it.
  const write = fake.sent.find((payload) => payload[1] === CONFIG_WRITE_COMMAND)!;
  assert.deepEqual([...write.subarray(1, 7)], [0x04, 0x00, 0x01, 0x00, 0x90, 0x01]);
  assert.deepEqual([...fake.writes[0]!.subarray(0, 4)], [0x64, 0x18, 0x04, 0x16]);
  assert.equal(leobogGm3DecodeOnboard(fake.block)?.dpiStages[1], 1100);
  assert.equal(leobogGm3DecodeOnboard(fake.block)?.dpiStages[0], 800);
  assert.deepEqual((await unit.readStatus()).dpiStages, [800, 1100, 1600, 4800, 7200, 12000]);
});

test("writes the active stage, polling rate and debounce", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  assert.equal(await unit.setActiveDpiStage(4), 4);
  assert.equal(fake.block[3], 0x56);
  assert.equal(await unit.setPollingRate(500), 500);
  assert.equal(fake.block[2], 3);
  assert.equal(await unit.setDebounceTime(12), 12);
  assert.equal(fake.block[5], 6);

  const status = await unit.readStatus();
  assert.equal(status.activeDpiStage, 4);
  assert.equal(status.dpi, 7200);
  assert.equal(status.pollingRateHz, 500);
  assert.equal(status.debounceMs, 12);
});

test("writes the auto-sleep idle time and can turn it off", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  assert.equal(await unit.setSleepTimeout(1200), 1200);
  assert.equal(fake.block[0x4a], 20);
  assert.equal((await unit.readStatus()).sleepTimeout, 1200);

  assert.equal(await unit.setSleepTimeout(0), 0);
  assert.equal(fake.block[0x4a], 0);
  assert.equal((await unit.readStatus()).sleepTimeout, 0);

  assert.equal(await unit.setSleepTimeout(300), 300);
  assert.equal(fake.block[0x4a], 5);

  await assert.rejects(unit.setSleepTimeout(90), /whole minutes/);
  await assert.rejects(unit.setSleepTimeout(1260), /whole minutes/);
});

/**
 * The plain DPI control (`setDpi`, used by both the preset list and the
 * custom-value box) edits the selected stage, exactly like the vendor's DPI
 * slider, and must not move the selection.
 */
test("setDpi edits the active stage without changing the selection", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  assert.equal(await unit.setDpi(1100), 1100);
  const first = leobogGm3DecodeOnboard(fake.block)!;
  assert.equal(first.activeStage, 0);
  assert.deepEqual(first.dpiStages, [1100, 1000, 1600, 4800, 7200, 12000]);
  assert.equal((await unit.readStatus()).dpi, 1100);

  assert.equal(await unit.setActiveDpiStage(2), 2);
  assert.equal(await unit.setDpi(1300), 1300);
  const second = leobogGm3DecodeOnboard(fake.block)!;
  assert.equal(second.activeStage, 2);
  assert.deepEqual(second.dpiStages, [1100, 1000, 1300, 4800, 7200, 12000]);
});

test("grows and shrinks the stage cycle", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  assert.equal(await unit.setDpiStageCount(5), 5);
  assert.equal(fake.block[3], 0x15);
  assert.deepEqual((await unit.readStatus()).dpiStages, [800, 1000, 1600, 4800, 7200]);

  assert.equal(await unit.setDpiStageCount(6), 6);
  assert.equal(leobogGm3DecodeOnboard(fake.block)?.dpiStages[5], 7200);
});

test("refuses a write the mouse did not keep", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.ignoreWrites = true;

  await assert.rejects(
    client(fake).setPollingRate(500),
    /did not keep 500 Hz/,
  );
});

test("rejects values the block cannot encode", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  await assert.rejects(unit.setPollingRate(2000), /does not support 2000 Hz/);
  await assert.rejects(unit.setDebounceTime(3), /does not support 3 ms/);
  await assert.rejects(unit.setDpiStageValue(0, 1050), /100-24000 DPI/);
  await assert.rejects(unit.setDpiStageValue(9, 800), /stage out of range/);
  assert.equal(fake.writes.length, 0);
});

test("accepts Chrome's response without a leading report id", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.omitReportId = true;
  const status = await client(fake).readStatus();

  assert.equal(status.batteryPercent, 100);
  assert.equal(status.pollingRateHz, 1000);
});

test("falls back to the block battery when the live power query fails", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.failPowerReceives = Infinity;
  const status = await client(fake).readStatus();

  assert.equal(status.batteryPercent, 91);
  assert.deepEqual(status.dpiStages, [800, 1000, 1600, 4800, 7200, 12000]);
  assert.equal(fake.sent.some((payload) => payload[1] === LEOBOG_GM3_POWER_COMMAND), true);
});

/**
 * The three power attempts share one 600 ms budget, so a receiver that has
 * gone quiet cannot hold a single poll on this step for 1.8 s. Measured: a
 * silent power query cost the poll exactly one budget, not three.
 */
test("a quiet receiver costs one battery budget per poll, not three", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  fake.hangPower = true;
  const unit = client(fake);

  const started = Date.now();
  const status = await unit.readStatus();
  const elapsed = Date.now() - started;

  // The block's cached level stands in for the live one.
  assert.equal(status.batteryPercent, 91);
  assert.ok(status.dpiStages !== undefined, "the block read still succeeded");
  assert.ok(
    elapsed < 1_900,
    `a quiet power query cost the poll ${elapsed} ms; it must share one budget`,
  );
});

test("shows a changed receiver battery on the next status poll", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const unit = client(fake);

  assert.equal((await unit.readStatus()).batteryPercent, 100);
  fake.powerPercent = 87;
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const status = await unit.readStatus();
  assert.equal(status.batteryPercent, 87);
});

/**
 * Over the cable the battery query is never answered. The block still carries
 * the receiver's last cached percentage, but presenting that as live would be
 * wrong, so the cable reports no battery and keeps the settings it did read.
 */
test("reports an unknown battery on the cable instead of failing", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_WIRED_PRODUCT_ID);
  fake.failPowerReceives = Infinity;
  fake.failLink = true;
  const status = await client(fake).readStatus();

  assert.equal(status.batteryPercent, null);
  assert.match(status.ui?.statusNote ?? "", /Battery level is not reported/);
  assert.equal(status.ui?.forceShowBattery, false);
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.dpiStages, [800, 1000, 1600, 4800, 7200, 12000]);
  assert.equal(status.sleepTimeout, 300);
});

/**
 * The cable path ignores a write that follows the block read reply with no
 * gap, so every write waits first — verified against the vendor's own capture.
 */
test("waits between the block read and the write frame", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_WIRED_PRODUCT_ID);
  await client(fake).setPollingRate(500);

  assert.ok(
    fake.gapBeforeWriteMs >= 60,
    `expected a write gap of at least 60 ms, saw ${fake.gapBeforeWriteMs}`,
  );
});

/** The 80-byte table the factory bindings encode to. */
function factoryButtonTable(): Uint8Array {
  return leobogGm3EncodeButtonTable(LEOBOG_GM3_BUTTON_NAMES.map(
    (name) => leobogGm3FindButtonAction(LEOBOG_GM3_DEFAULT_BUTTONS[name])!,
  ));
}

/** The 80-byte payloads of every `01 00` frame the client handed to the device. */
function buttonTableWrites(fake: FakeGm3): Uint8Array[] {
  return fake.sent
    .filter((payload) => payload[1] === BUTTON_WRITE_COMMAND && payload[2] === 0x00)
    .map((payload) => {
      const length = payload[5]! | (payload[6]! << 8);
      return payload.slice(7, 7 + length);
    });
}

test("offers the button catalog seeded with the factory assignments", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const status = await client(fake).readStatus();

  assert.equal(status.buttonOptions?.includes("DPI loop"), true);
  assert.equal(status.buttonOptions?.includes("Volume +"), true);
  assert.equal(status.buttonOptions?.includes("Disabled"), true);
  assert.deepEqual(status.buttonMappings, {
    Left: "Left click",
    Middle: "Middle click",
    Right: "Right click",
    Forward: "Forward",
    Backward: "Backward",
    DPI: "DPI loop",
  });
  // The catalog is a plain option list, not a device read, so every poll
  // returns it even while the mouse is asleep.
  assert.equal((await client(fake).readStatus()).buttonOptions?.length, status.buttonOptions?.length);
});

test("writes the whole table for a single remap", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);
  await device.setButtonMapping("Forward", "Disabled");

  const writes = buttonTableWrites(fake);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.length, 80);
  assert.deepEqual([...writes[0]!.slice(0, 24)], [
    0x01, 0x01, 0x01, 0x00,
    0x01, 0x02, 0x01, 0x00,
    0x01, 0x03, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x00,
    0x05, 0x04, 0x00, 0x00,
  ]);
  assert.deepEqual([...writes[0]!.slice(24)], new Array(56).fill(0));
  assert.equal((await device.readStatus()).buttonMappings?.Forward, "Disabled");
});

test("the client's own copy carries earlier remaps into the next write", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);
  await device.setButtonMapping("Left", "Disabled");
  await device.setButtonMapping("Right", "Volume +");

  const writes = buttonTableWrites(fake);
  assert.equal(writes.length, 2);
  assert.deepEqual([...writes[1]!.slice(0, 12)], [
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x02, 0x01, 0x00,
    0x02, 0x00, 0x00, 0xe9,
  ]);
  const mappings = (await device.readStatus()).buttonMappings;
  assert.equal(mappings?.Left, "Disabled");
  assert.equal(mappings?.Right, "Volume +");
});

test("refuses a button or an action this model does not have", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);

  await assert.rejects(
    () => device.setButtonMapping("Thumb", "Left click"),
    /no "Thumb" button/,
  );
  await assert.rejects(
    () => device.setButtonMapping("Left", "Macro 4"),
    /not one of the GM3 button actions/,
  );
  assert.equal(buttonTableWrites(fake).length, 0);
});

test("restores the factory table, remaps it again afterwards", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);
  await device.setButtonMapping("Left", "Disabled");

  const status = await device.readStatus();
  assert.equal(status.defaultButtonMappings?.Left, "Left click");
  assert.notEqual(status.buttonMappings?.Left, status.defaultButtonMappings?.Left);

  await device.resetButtonMappings();

  const writes = buttonTableWrites(fake);
  assert.equal(writes.length, 2);
  // The second write is the factory table again, byte for byte.
  assert.deepEqual([...writes[1]!], [...factoryButtonTable()]);
  const restored = await device.readStatus();
  assert.deepEqual(restored.buttonMappings, status.defaultButtonMappings);

  // The restored table stays resident, so a later remap writes the rest of it.
  await device.setButtonMapping("Right", "Volume +");
  assert.deepEqual([...buttonTableWrites(fake)[2]!.slice(0, 12)], [
    0x01, 0x01, 0x01, 0x00,
    0x01, 0x02, 0x01, 0x00,
    0x02, 0x00, 0x00, 0xe9,
  ]);
});

test("a poll drops its optional battery query when a write is already waiting", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);
  // The first poll fills the block cache and confirms the live query works,
  // so the next one has only that optional battery query left to spend.
  assert.equal((await device.readStatus()).batteryPercent, 100);
  const sent = fake.sent.length;
  const statusPromise = device.readStatus();
  const stageWrite = device.setDpiStageValue(0, 800);
  const status = await statusPromise;
  await stageWrite;

  // The link query is the one step the poll cannot skip: it decides whether
  // the mouse is asleep at all. Its next frame belongs to the queued write,
  // not to a battery query the poll decided not to spend.
  assert.equal(fake.sent[sent]?.[1], LEOBOG_GM3_LINK_COMMAND);
  assert.notEqual(fake.sent[sent + 1]?.[1], LEOBOG_GM3_POWER_COMMAND);
  // The block's cached level stands in for the live query.
  assert.equal(status.batteryPercent, 91);
});

/** The payloads of every `03 00` macro frame the client handed to the device. */
function macroWrites(fake: FakeGm3): Uint8Array[] {
  return fake.sent
    .filter((payload) => payload[1] === 0x03 && payload[2] === 0x00)
    .map((payload) => {
      const length = payload[5]! | (payload[6]! << 8);
      return payload.slice(7, 7 + length);
    });
}

/** The vendor's OM2 record: press C, release C, press D, release D. */
const OM2_RECORD = [
  0x04, 0x00, 0x17, 0x00, 0x06, 0x4f, 0x00, 0x4d, 0x00, 0x32,
  0x00, 0x00, 0x00, 0xea, 0x06, 0x80, 0x01, 0xd5, 0x06, 0x00,
  0x00, 0x7d, 0x07, 0x80, 0x00, 0x00, 0x07,
];

const OM2_STEPS = [
  { delayMs: 234, event: { type: "keyDown" as const, hidUsage: 0x06 } },
  { delayMs: 469, event: { type: "keyUp" as const, hidUsage: 0x06 } },
  { delayMs: 125, event: { type: "keyDown" as const, hidUsage: 0x07 } },
  { delayMs: 0, event: { type: "keyUp" as const, hidUsage: 0x07 } },
];

test("uploads a macro as the captured 03 00 record", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);
  await device.setMacro(0, "OM2", OM2_STEPS);

  const writes = macroWrites(fake);
  assert.equal(writes.length, 1);
  assert.deepEqual([...writes[0]!], OM2_RECORD);
  const macros = (await device.readStatus()).leobogMacros;
  assert.equal(macros?.length, 3);
  assert.deepEqual(macros?.[0], { name: "OM2", steps: OM2_STEPS });
  assert.equal(macros?.[1], null);
});

test("the button catalog gains one entry per macro slot", async () => {
  const status = await client(new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID)).readStatus();
  const options = status.buttonOptions ?? [];
  assert.equal(options.includes("Macro 1"), true);
  assert.equal(options.includes("Macro 3"), true);
  assert.equal(options.includes("Macro 4"), false);
  // Macros come after the fixed catalog so existing labels keep their order.
  assert.equal(options.indexOf("Macro 1"), options.length - 3);
});

test("binding a macro writes 03 <mode> <count> <slot>", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);
  await device.setButtonMapping("Forward", "Macro 2");

  const writes = buttonTableWrites(fake);
  assert.equal(writes.length, 1);
  assert.deepEqual([...writes[0]!.slice(12, 16)], [0x03, 0x01, 0x01, 0x01]);
  assert.equal((await device.readStatus()).buttonMappings?.Forward, "Macro 2");
});

test("refuses a macro slot this model does not have", async () => {
  const fake = new FakeGm3(LEOBOG_GM3_RECEIVER_PRODUCT_ID);
  const device = client(fake);

  await assert.rejects(() => device.setMacro(3, "OM2", OM2_STEPS), /3 macro slots/);
  await assert.rejects(() => device.setButtonMapping("Left", "Macro 4"), /not one of the GM3/);
  assert.equal(macroWrites(fake).length, 0);
  assert.equal(buttonTableWrites(fake).length, 0);
});
