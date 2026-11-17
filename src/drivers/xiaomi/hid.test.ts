import assert from "node:assert/strict";
import test from "node:test";
import { XiaomiHidClient } from "./hid.ts";
import {
  XIAOMI_BUTTON_ACTIONS,
  XIAOMI_BUTTON_NAMES,
  XIAOMI_KEY_COMBOS,
  XIAOMI_MACRO_PACKET_SIZE,
  XIAOMI_MACRO_REPORT_DATA_SIZE,
  XIAOMI_MACRO_REPORT_ID,
  XIAOMI_PACKET_SIZE,
  XIAOMI_REPORT_DATA_SIZE,
  XIAOMI_REPORT_ID,
  xiaomiDecodeDpi,
  xiaomiDecodeLighting,
  xiaomiDecodePolling,
  type XiaomiMacroEvent,
} from "@openmouse/protocol/xiaomi";

/** Builds a 32-byte reply echoing the header and command byte. */
function reply(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(XIAOMI_PACKET_SIZE);
  data.set(bytes);
  return data;
}

/** Builds a 64-byte macro-channel reply. */
function macroReply(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(XIAOMI_MACRO_PACKET_SIZE);
  data.set(bytes);
  return data;
}

class FakeDevice implements HIDDevice {
  vendorId = 0x2717;
  productId = 0x5009;
  productName = "Mi Gaming Mouse";
  opened = false;
  collections: HIDCollectionInfo[] = [{
    usagePage: 0xff00,
    usage: 2,
    children: [],
    featureReports: [],
    inputReports: [{ reportId: XIAOMI_REPORT_ID, items: [{ reportSize: 8, reportCount: XIAOMI_REPORT_DATA_SIZE }] }],
    outputReports: [{ reportId: XIAOMI_REPORT_ID, items: [{ reportSize: 8, reportCount: XIAOMI_REPORT_DATA_SIZE }] }],
  }];
  listeners = new Set<(event: HIDInputReportEvent) => void>();
  sent: Uint8Array[] = [];
  /** Canned replies keyed by the command byte (request[1]). */
  replies = new Map<number, number[]>();
  /** Canned binding-read replies keyed by button index (all reads share command 0xb0). */
  bindingReplies = new Map<number, number[]>();
  /** Canned macro-channel read replies keyed by the requested offset. */
  macroReplies = new Map<number, number[]>();
  respond = true;
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void) { this.listeners.add(listener); }
  removeEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void) { this.listeners.delete(listener); }
  emit(payload: Uint8Array) {
    // payload is the hidraw layout (32 or 64 bytes); WebHID delivers the
    // data bytes without the report-ID byte.
    const reportId = payload[0]!;
    const data = payload.subarray(1);
    const event = { device: this, reportId, data: new DataView(data.buffer, data.byteOffset, data.byteLength) } as HIDInputReportEvent;
    for (const listener of this.listeners) listener(event);
  }
  async sendReport(reportId: number, data: BufferSource) {
    const request = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (reportId === XIAOMI_REPORT_ID) {
      assert.equal(request.length, XIAOMI_REPORT_DATA_SIZE);
      this.sent.push(request.slice());
      if (request[0] === 0xc1) {
        // DPI write: update the read-back state so verification sees the new value.
        this.replies.set(0xc2, [0x4d, 0xc2, 0, request[1]!, request[2]!, request[3]!, request[4]!, request[5]!, request[6]!]);
      }
      if (!this.respond) return;
      if (request[0] === 0xb0) {
        // Binding reads share command 0xb0; the button index is request[1].
        const canned = this.bindingReplies.get(request[1]!);
        if (canned) this.emit(reply(...canned));
        return;
      }
      const canned = this.replies.get(request[0]!);
      if (canned) this.emit(reply(...canned));
      return;
    }
    assert.equal(reportId, XIAOMI_MACRO_REPORT_ID);
    assert.equal(request.length, XIAOMI_MACRO_REPORT_DATA_SIZE);
    this.sent.push(request.slice());
    if (request[0] !== 0xf0) return; // macro writes (0xf1) are fire-and-forget
    if (!this.respond) return;
    // Data payload (report ID stripped): [0xf0, 0x0d, chunk, 0, 0, off_hi, off_lo, ...]
    const offset = (request[5]! << 8) | request[6]!;
    const canned = this.macroReplies.get(offset);
    if (canned) this.emit(macroReply(...canned));
  }
  async sendFeatureReport(): Promise<void> { throw new Error("Feature transport must not be used."); }
  async receiveFeatureReport(): Promise<DataView> { throw new Error("Feature transport must not be used."); }
}

function device(vendorId = 0x2717, productId = 0x5009): FakeDevice {
  const fake = new FakeDevice();
  fake.vendorId = vendorId;
  fake.productId = productId;
  return fake;
}

test("Xiaomi identity accepts both PIDs only with an input/output collection", () => {
  for (const productId of [0x5009, 0x500b]) {
    assert.equal(XiaomiHidClient.isSupported(device(0x2717, productId)), true);
  }
  assert.equal(XiaomiHidClient.isSupported(device(0x2717, 0x500c)), false);
  assert.equal(XiaomiHidClient.isSupported(device(0x1234, 0x5009)), false);
  const bare = device();
  bare.collections[0]!.outputReports = [];
  assert.equal(XiaomiHidClient.isSupported(bare), false);
});

test("readStatus reports battery, DPI, polling and both lighting zones", async () => {
  const fake = device();
  fake.replies.set(0x90, [0x4d, 0x90, 0x90, 87]);
  fake.replies.set(0xc2, [0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1]);
  fake.replies.set(0xc4, [0x4d, 0xc4, 0, 1]);
  fake.replies.set(0xa0, [0x4d, 0xa0, 0, 0, 1, 4, 0, 0, 0, 255, 0]);
  for (const [button, combo] of factoryBindings()) fake.bindingReplies.set(button, bindingReply(combo));
  const client = new XiaomiHidClient(fake);
  const status = await client.readStatus();
  assert.equal(status.brand, "Xiaomi");
  assert.equal(status.batteryPercent, 87);
  assert.equal(status.dpi, 800);
  assert.deepEqual(status.dpiStages, [100, 800, 1600, 2400, 4800]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.lightingZones.length, 2);
  assert.equal(status.lightingZones[0]!.zone, "TAIL");
  assert.equal(status.lightingZones[0]!.mode, "Static");
  assert.equal(status.lightingZones[0]!.color, "#00ff00");
  assert.equal(status.lightingZones[1]!.zone, "WHEEL");
  assert.deepEqual(status.lightingZones[1]!.modes, ["Off", "Static"]);
});

test("readStatus exposes the 8 button mappings and the 20 preset options", async () => {
  const fake = device();
  fake.replies.set(0x90, [0x4d, 0x90, 0x90, 87]);
  fake.replies.set(0xc2, [0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1]);
  fake.replies.set(0xc4, [0x4d, 0xc4, 0, 1]);
  fake.replies.set(0xa0, [0x4d, 0xa0, 0, 0, 1, 4, 0, 0, 0, 255, 0]);
  for (const [button, combo] of factoryBindings()) fake.bindingReplies.set(button, bindingReply(combo));
  const client = new XiaomiHidClient(fake);
  const status = await client.readStatus();
  assert.deepEqual(Object.keys(status.buttonMappings!), XIAOMI_BUTTON_NAMES);
  assert.deepEqual(status.buttonMappings, {
    Left: "Left-click",
    Right: "Right-click",
    Scroll: "Middle-click",
    M5: "Move forward",
    M4: "Move back",
    "Rise DPI": "Rise DPI",
    "Lower DPI": "Lower DPI",
    Aiming: "Turn DPI",
  });
  assert.deepEqual(status.buttonOptions, XIAOMI_BUTTON_ACTIONS.map((action) => action.label));
  assert.equal(status.buttonOptions!.length, 20);
  // One binding read per button, in order.
  const reads = fake.sent.filter((frame) => frame[0] === 0xb0);
  assert.equal(reads.length, 8);
  assert.deepEqual(reads.map((frame) => frame[1]), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("readStatus labels custom combos and macros instead of presets", async () => {
  const fake = device();
  fake.replies.set(0x90, [0x4d, 0x90, 0x90, 87]);
  fake.replies.set(0xc2, [0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1]);
  fake.replies.set(0xc4, [0x4d, 0xc4, 0, 1]);
  fake.replies.set(0xa0, [0x4d, 0xa0, 0, 0, 1, 4, 0, 0, 0, 255, 0]);
  for (const [button, combo] of factoryBindings()) fake.bindingReplies.set(button, bindingReply(combo));
  // M5 (3): custom combo Ctrl+Shift+N; M4 (4): no-delay macro of 3 events (12 bytes).
  fake.bindingReplies.set(3, [0x4d, 0xb0, 0, 0, 0x01, 0x00, 0x03, 0x11]);
  fake.bindingReplies.set(4, [0x4d, 0xb0, 0, 0, 0x02, 0x00, 0x00, 12]);
  const client = new XiaomiHidClient(fake);
  const status = await client.readStatus();
  assert.equal(status.buttonMappings!["M5"], "Custom (Ctrl+Shift+N)");
  assert.equal(status.buttonMappings!["M4"], "Macro (3 events)");
  // Preset bindings are untouched.
  assert.equal(status.buttonMappings!["Left"], "Left-click");
});

test("setButtonMapping writes the preset combo for the named button", async () => {
  const fake = device();
  const client = new XiaomiHidClient(fake);
  await client.setButtonMapping("M5", "Ctrl+C");
  const write = fake.sent.find((frame) => frame[0] === 0xb1);
  assert.ok(write, "a binding write must be sent");
  // M5 is button 3; Ctrl+C is combo 0x0109.
  assert.equal(write![1], 3);
  assert.equal(write![2], 0x01);
  assert.equal(write![3], 0x09);
  assert.equal(write![4], 0);
  assert.equal(write![5], 0);
});

test("setButtonMapping rejects unknown buttons and actions", async () => {
  const fake = device();
  const client = new XiaomiHidClient(fake);
  await assert.rejects(() => client.setButtonMapping("M9", "Ctrl+C"), /Unknown .* button: M9/);
  await assert.rejects(() => client.setButtonMapping("M5", "Ctrl+D"), /Unknown .* button action: Ctrl\+D/);
  assert.equal(fake.sent.length, 0);
});

test("setDpi writes the full level table and verifies by read-back", async () => {
  const fake = device();
  fake.replies.set(0xc2, [0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1]);
  const client = new XiaomiHidClient(fake);
  const dpi = await client.setDpi(1200);
  assert.equal(dpi, 1200);
  const write = fake.sent.find((frame) => frame[0] === 0xc1);
  assert.ok(write, "a DPI write must be sent");
  // 1200/50 = 24 at the active level (index 1).
  assert.equal(write![1], 2);
  assert.equal(write![2], 24);
  assert.equal(write![6], 1);
});

test("setPollingRate rejects unsupported rates and verifies by read-back", async () => {
  const fake = device();
  fake.replies.set(0xc4, [0x4d, 0xc4, 0, 4]);
  const client = new XiaomiHidClient(fake);
  await assert.rejects(() => client.setPollingRate(750), /not supported/);
  const rate = await client.setPollingRate(250);
  assert.equal(rate, 250);
  const write = fake.sent.find((frame) => frame[0] === 0xc3);
  assert.ok(write, "a polling write must be sent");
  assert.equal(write![1], 4);
});

test("setLighting writes the wire effect and reads the zone back", async () => {
  const fake = device();
  // Read-back echoes the written wire effect: Spectrum is logical 6 → wire 7.
  fake.replies.set(0xa0, [0x4d, 0xa0, 0, 0, 7, 3, 0, 0, 255, 0, 0]);
  const client = new XiaomiHidClient(fake);
  const zone = await client.setLighting({ zone: "TAIL", mode: "Spectrum", color: "#ff0000", speed: 3 });
  assert.equal(zone.mode, "Spectrum");
  assert.equal(zone.color, "#ff0000");
  const write = fake.sent.find((frame) => frame[0] === 0xa1);
  assert.ok(write, "a lighting write must be sent");
  // Spectrum is logical effect 6 → wire 7.
  assert.equal(write![2], 7);
  assert.equal(write![3], 3);
  assert.equal(write![6], 255);
});

test("setLighting rejects an effect the wheel zone does not support", async () => {
  const fake = device();
  const client = new XiaomiHidClient(fake);
  await assert.rejects(
    () => client.setLighting({ zone: "WHEEL", mode: "Spectrum", color: "#ff0000", speed: 3 }),
    /not supported for the wheel zone/,
  );
});

test("a read that never answers times out", async () => {
  const fake = device();
  fake.respond = false;
  const client = new XiaomiHidClient(fake);
  await assert.rejects(() => client.readStatus(), /did not answer/);
});

test("decoders agree with the driver on the wire layout", () => {
  const lighting = xiaomiDecodeLighting(reply(0x4d, 0xa0, 0, 0, 6, 3, 0, 0, 255, 0, 0));
  assert.equal(lighting.effect, 5);
  const dpi = xiaomiDecodeDpi(reply(0x4d, 0xc2, 0, 2, 16, 32, 48, 96, 1));
  assert.equal(dpi.levels[1], 800);
  assert.equal(xiaomiDecodePolling(reply(0x4d, 0xc4, 0, 1)), 1000);
});

/** Builds a binding read reply carrying `combo`. The real device does not
 * echo the button index in byte 2 (always 0x00). */
function bindingReply(combo: number): number[] {
  return [0x4d, 0xb0, 0, 0, (combo >> 8) & 0xff, combo & 0xff, 0, 0];
}

/** Factory-default bindings as reported by the reference app. */
function factoryBindings(): Map<number, number> {
  return new Map([
    [0, XIAOMI_KEY_COMBOS.LEFT_CLICK],
    [1, XIAOMI_KEY_COMBOS.RIGHT_CLICK],
    [2, XIAOMI_KEY_COMBOS.MIDDLE_CLICK],
    [3, XIAOMI_KEY_COMBOS.MOVE_FORWARD],
    [4, XIAOMI_KEY_COMBOS.MOVE_BACK],
    [5, XIAOMI_KEY_COMBOS.RISE_DPI],
    [6, XIAOMI_KEY_COMBOS.LOWER_DPI],
    [7, XIAOMI_KEY_COMBOS.TURN_DPI],
  ]);
}

/** Builds a 64-byte macro read reply carrying `events` (4 bytes each). */
function macroChunkReply(events: readonly XiaomiMacroEvent[]): number[] {
  const bytes = [0x57, 0xf0, 0x0d, events.length * 4, 0, 0, 0, 0];
  for (const event of events) bytes.push(event.key, event.state, (event.delayMs >> 8) & 0xff, event.delayMs & 0xff);
  return bytes;
}

test("readBinding decodes a custom key combo from the control channel", async () => {
  const fake = device();
  fake.bindingReplies.set(2, [0x4d, 0xb0, 0, 0, 0x01, 0x00, 0x02, 0x11]);
  const client = new XiaomiHidClient(fake);
  const binding = await client.readBinding(2);
  assert.equal(binding.mode, XIAOMI_KEY_COMBOS.CUSTOM_KEY_COMBO);
  assert.equal(binding.modifiers, 0x02);
  assert.equal(binding.key, 0x11);
  const read = fake.sent.find((frame) => frame[0] === 0xb0);
  assert.ok(read, "a binding read must be sent");
  assert.equal(read![1], 2);
});

test("setBinding writes the combo on the control channel", async () => {
  const fake = device();
  const client = new XiaomiHidClient(fake);
  await client.setBinding(3, XIAOMI_KEY_COMBOS.CUSTOM_KEY_COMBO, 0x04, 0x2a);
  const write = fake.sent.find((frame) => frame[0] === 0xb1);
  assert.ok(write, "a binding write must be sent");
  assert.equal(write![1], 3);
  assert.equal(write![2], 0x01);
  assert.equal(write![3], 0x00);
  assert.equal(write![4], 0x04);
  assert.equal(write![5], 0x2a);
});

test("readMacro streams the macro body in chunks until the size is reached", async () => {
  const fake = device();
  // Button 4 is bound to a no-delay macro of 21 events (84 event bytes).
  fake.bindingReplies.set(4, [0x4d, 0xb0, 0, 0, 0x02, 0x00, 0x00, 84]);
  const first: XiaomiMacroEvent[] = [];
  for (let i = 0; i < 14; i++) first.push({ key: i, state: i % 2, delayMs: 0 });
  const second: XiaomiMacroEvent[] = [];
  for (let i = 14; i < 21; i++) second.push({ key: i, state: i % 2, delayMs: 10 });
  fake.macroReplies.set(0, macroChunkReply(first));
  fake.macroReplies.set(56, macroChunkReply(second));
  const client = new XiaomiHidClient(fake);
  const events = await client.readMacro(4);
  assert.equal(events.length, 21);
  assert.deepEqual(events[0], { key: 0, state: 0, delayMs: 0 });
  assert.deepEqual(events[14], { key: 14, state: 0, delayMs: 10 });
  assert.deepEqual(events[20], { key: 20, state: 0, delayMs: 10 });
  const reads = fake.sent.filter((frame) => frame[0] === 0xf0);
  assert.equal(reads.length, 2);
  // Data payload: [0xf0, 0x0d, chunkSize, 0, 0, off_hi, off_lo, ...].
  // First request: 56 event bytes at offset 0; second: the remaining 28 at offset 56.
  assert.equal(reads[0]![2], 56);
  assert.equal(reads[0]![5], 0);
  assert.equal(reads[0]![6], 0);
  assert.equal(reads[1]![2], 28);
  assert.equal(reads[1]![5], 0);
  assert.equal(reads[1]![6], 56);
});

test("readMacro stops early when the device signals the end of the macro", async () => {
  const fake = device();
  fake.bindingReplies.set(4, [0x4d, 0xb0, 0, 0, 0x02, 0x01, 0x00, 84]);
  const events: XiaomiMacroEvent[] = [];
  for (let i = 0; i < 7; i++) events.push({ key: i, state: 1, delayMs: 5 });
  fake.macroReplies.set(0, macroChunkReply(events));
  // The offset accumulates by the *requested* diff (56), so the second read
  // goes to offset 56. packetSize 0 (< 8) marks the end of the macro.
  fake.macroReplies.set(56, [0x57, 0xf0, 0x0d, 0, 0, 0, 0, 0]);
  const client = new XiaomiHidClient(fake);
  const read = await client.readMacro(4);
  assert.equal(read.length, 7);
  assert.deepEqual(read[0], { key: 0, state: 1, delayMs: 5 });
});

test("setMacro writes the binding first, then streams the macro packets", async () => {
  const fake = device();
  const client = new XiaomiHidClient(fake);
  const events: XiaomiMacroEvent[] = [];
  for (let i = 0; i < 21; i++) events.push({ key: i, state: i % 2, delayMs: i * 10 });
  await client.setMacro(5, XIAOMI_KEY_COMBOS.MACROS_WITH_DELAY, events);
  const binding = fake.sent.find((frame) => frame[0] === 0xb1);
  assert.ok(binding, "the binding write must be sent");
  assert.equal(binding![1], 5);
  assert.equal(binding![2], 0x02);
  assert.equal(binding![3], 0x01);
  // 21 events × 4 bytes = 84 event bytes.
  assert.equal(binding![4], 0);
  assert.equal(binding![5], 84);
  const packets = fake.sent.filter((frame) => frame[0] === 0xf1);
  assert.equal(packets.length, 2);
  // Data payload: [0xf1, 0x0d, pktSize, 0, 0, off_hi, off_lo, ...events].
  // Packet 1: 14 events (56 bytes) at offset 0.
  assert.equal(packets[0]![2], 56);
  assert.equal(packets[0]![5], 0);
  assert.equal(packets[0]![6], 0);
  assert.equal(packets[0]![7], 0); // first event key
  assert.equal(packets[0]![8], 0); // first event state
  // Packet 2: the remaining 7 events (28 bytes) at offset 56.
  assert.equal(packets[1]![2], 28);
  assert.equal(packets[1]![5], 0);
  assert.equal(packets[1]![6], 56);
  assert.equal(packets[1]![7], 14); // first event key of the second packet
  assert.equal(packets[1]![31], 20); // last event key (event 6, byte 7)
});
