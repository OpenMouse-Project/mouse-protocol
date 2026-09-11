import assert from "node:assert/strict";
import test from "node:test";

import { INCOTT_PRODUCT_ID, INCOTT_PRODUCT_ID_WIRED, INCOTT_REPORT_ID, INCOTT_USAGE_PAGE, INCOTT_VENDOR_ID } from "../../incott/index.ts";
import {
  IncottHidClient,
  IncottTransactionQueue,
  incottProbeCollection,
  incottSelectCollection,
  type FeatureTransport,
  type IncottTransactionOptions,
} from "./hid.ts";

// ---------------------------------------------------------------------------
// IncottTransactionQueue — ported from IncottHub's transaction.test.ts.
// The device latches a single shared response buffer, so these lock down the
// exact stale-frame regression the queue exists to prevent.
// ---------------------------------------------------------------------------

/** Builds a response frame with the report ID at byte 0. */
const frame = (...values: readonly number[]): Uint8Array => {
  const out = new Uint8Array(64);
  out[0] = INCOTT_REPORT_ID;
  values.forEach((value, index) => {
    out[index + 1] = value;
  });
  return out;
};

/** A transport that replays a scripted list of frames, one per read. */
class ScriptedTransport implements FeatureTransport {
  sent: Uint8Array[] = [];
  reads = 0;
  private readonly script: readonly Uint8Array[];
  constructor(script: readonly Uint8Array[]) {
    this.script = script;
  }
  async sendFeatureReport(_reportId: number, data: BufferSource): Promise<void> {
    this.sent.push(data as Uint8Array);
  }
  async receiveFeatureReport(_reportId: number): Promise<DataView> {
    const next = this.script[this.reads] ?? new Uint8Array(64);
    this.reads += 1;
    return new DataView(next.buffer, next.byteOffset, next.byteLength);
  }
}

/** Runs transactions with no real delay. */
const immediate: IncottTransactionOptions = { settleMs: 0, attempts: 4, sleep: async () => {} };

test("a matching response is returned to the caller", async () => {
  const transport = new ScriptedTransport([frame(0x85, 0x01, 0x04), frame(0x85, 0x01, 0x04)]);
  const queue = new IncottTransactionQueue(transport, immediate);
  const result = await queue.request(new Uint8Array([0x85, 0x01]), 0x85, 0x01);
  assert.equal(result?.[3], 0x04);
});

test("a stale frame from an earlier query is rejected, not decoded", async () => {
  // This is the exact failure IncottHIDApp's read loop accepts: it matches on
  // the command byte alone, so a leftover 0x85/0x01 frame satisfies a request
  // for 0x85/0x03 and its payload is decoded as a sleep timer.
  const transport = new ScriptedTransport([
    frame(0x85, 0x01, 0x04), // flush read
    frame(0x85, 0x01, 0x04), // stale: right command, wrong sub-command
    frame(0x85, 0x03, 0x3c), // the real answer
  ]);
  const queue = new IncottTransactionQueue(transport, immediate);
  const result = await queue.request(new Uint8Array([0x85, 0x03]), 0x85, 0x03);
  assert.equal(result?.[2], 0x03, "must not accept the 0x85/0x01 frame");
  assert.equal(result?.[3], 0x3c);
});

test("a response for an entirely different command is rejected", async () => {
  const transport = new ScriptedTransport([
    frame(0x84, 0x00),
    frame(0x84, 0x00),
    frame(0x88, 0x02),
  ]);
  const queue = new IncottTransactionQueue(transport, immediate);
  const result = await queue.request(new Uint8Array([0x88]), 0x88, null);
  assert.equal(result?.[1], 0x88);
  assert.equal(result?.[2], 0x02);
});

test("null is returned when no matching frame arrives within the attempt budget", async () => {
  const transport = new ScriptedTransport([frame(0x84, 0x00)]);
  const queue = new IncottTransactionQueue(transport, immediate);
  const result = await queue.request(new Uint8Array([0x85, 0x03]), 0x85, 0x03);
  assert.equal(result, null);
});

test("the first read is discarded so a pending frame cannot satisfy the request", async () => {
  const transport = new ScriptedTransport([
    frame(0x85, 0x03, 0xff), // already latched before we sent anything
    frame(0x85, 0x03, 0x3c),
  ]);
  const queue = new IncottTransactionQueue(transport, immediate);
  const result = await queue.request(new Uint8Array([0x85, 0x03]), 0x85, 0x03);
  assert.equal(result?.[3], 0x3c, "the pre-send frame must be flushed");
});

test("transactions are serialized so two requests never interleave", async () => {
  const order: string[] = [];
  const transport: FeatureTransport = {
    async sendFeatureReport(_id, data) {
      order.push(`send:${new Uint8Array(data as ArrayBuffer)[0]}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    async receiveFeatureReport() {
      const value = frame(0x84, 0x00);
      return new DataView(value.buffer, value.byteOffset, value.byteLength);
    },
  };
  const queue = new IncottTransactionQueue(transport, immediate);
  await Promise.all([
    queue.request(new Uint8Array([0x84]), 0x84, null),
    queue.request(new Uint8Array([0x85]), 0x85, null),
  ]);
  // The 0x85 send must not begin until the 0x84 transaction has finished.
  assert.deepEqual(order, ["send:132", "send:133"]);
});

test("a transport error resolves to null instead of rejecting", async () => {
  const transport: FeatureTransport = {
    async sendFeatureReport() {},
    async receiveFeatureReport() {
      throw new Error("device disconnected");
    },
  };
  const queue = new IncottTransactionQueue(transport, immediate);
  assert.equal(await queue.request(new Uint8Array([0x84]), 0x84, null), null);
});

test("send writes without waiting for a response it will never get", async () => {
  // Writes draw no reply. Routing them through request() would burn the whole
  // attempt budget (10 reads x 50 ms) waiting for a frame that never arrives.
  const transport = new ScriptedTransport([]);
  const queue = new IncottTransactionQueue(transport, immediate);
  await queue.send(new Uint8Array([0x03, 0x06, 0x02]));
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.reads, 0, "send must not read");
});

test("send stays ordered with respect to requests", async () => {
  const order: string[] = [];
  const transport: FeatureTransport = {
    async sendFeatureReport(_id, data) {
      order.push(`send:${new Uint8Array(data as ArrayBuffer)[0]}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    async receiveFeatureReport() {
      const value = frame(0x83, 0x06, 0x02);
      return new DataView(value.buffer, value.byteOffset, value.byteLength);
    },
  };
  const queue = new IncottTransactionQueue(transport, immediate);
  await Promise.all([
    queue.send(new Uint8Array([0x03, 0x06, 0x02])),
    queue.request(new Uint8Array([0x83, 0x06]), 0x83, 0x06),
  ]);
  assert.deepEqual(order, ["send:3", "send:131"]);
});

// ---------------------------------------------------------------------------
// IncottHidClient — a scripted fake HIDDevice standing in for the mouse.
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    // Six-stage DPI table, wire values for 400/800/1600/2400/3200/6400 —
    // the exact values verified on hardware 2026-09-08. Stage 1 (800 DPI) is
    // active by default.
    dpiStagesWire: [7, 15, 31, 47, 63, 127],
    // Y starts equal to X, as the factory table has it. That equality is
    // exactly what hid the per-axis read from an earlier probe.
    dpiStagesWireY: [7, 15, 31, 47, 63, 127],
    activeDpiStage: 1, // 0x83 response byte 3.
    dpiStageCount: 6, // 0x83 response byte 2 — the cycle length, not an echo.
    pollingWire: 0, // 1000 Hz
    lodWire: 0, // 10 tenths mm -> Medium
    motionSync: 1,
    ripple: 0,
    angleSnap: 0,
    performanceMode: 1,
    debounceMs: 4,
    sleepSeconds: 60,
    receiverLed: 0,
    // Read from hardware 2026-09-11: 09 85 02 03 0a.
    fireKeyTimes: 3,
    fireKeyIntervalMs: 10,
    batteryByte: 0x38 as number | null, // 56%, captured 2026-09-07
    identity: [0x01, 0x0e, 0x02, 0xf0, 0xf1, 0x00, 0xff] as number[] | null,
    // The factory bindings read from hardware 2026-09-08, by WIRE index.
    // Note index 3 is Back and index 4 is Forward — the transposition in
    // INCOTT_BUTTON_WIRE_INDEX.
    buttons: [0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007] as number[],
  };
}

type FakeState = ReturnType<typeof defaultState>;

interface FakeOptions {
  productId?: number;
  productName?: string;
  collections?: HIDCollectionInfo[];
  state?: Partial<FakeState>;
  /** Query commands (byte 0) the device stays silent on. */
  silent?: number[];
  /** Drop every SET on the floor, as if the write did not take. */
  ignoreWrites?: boolean;
  /**
   * Simulates the wired mouse's dead look-alike 0xFF05 collection
   * (hardware-verified 2026-09-08): every `sendFeatureReport` call throws,
   * exactly like Windows' `HidD_SetFeature: (0x00000001) Incorrect function`
   * on the real dead collection. See `open()`'s identity probe.
   */
  deadCollection?: boolean;
}

function vendorCollection(usagePage: number = INCOTT_USAGE_PAGE): HIDCollectionInfo {
  return {
    usagePage,
    usage: 0x01,
    type: 1,
    children: [],
    featureReports: [{ reportId: INCOTT_REPORT_ID, items: [] }],
    inputReports: [],
    outputReports: [],
  } as unknown as HIDCollectionInfo;
}

function fakeDevice(options: FakeOptions = {}) {
  const state: FakeState = { ...defaultState(), ...options.state };
  const sent: Uint8Array[] = [];
  // OUTPUT reports, which only the macro upload uses.
  const outputs: Array<{ reportId: number; bytes: Uint8Array }> = [];
  let buffer = new Uint8Array(64);
  let opened = false;
  // Only "inputreport" is ever registered by this driver; a single slot is
  // enough (open()/close() add and remove exactly one listener each).
  let inputReportListener: ((event: HIDInputReportEvent) => void) | null = null;

  const reply = (payload: Uint8Array): Uint8Array | null => {
    const cmd = payload[0]!;
    const sub = payload[1]!;
    if (options.silent?.includes(cmd)) return null;
    switch (cmd) {
      case 0x81:
        return frame(0x81, state.pollingWire);
      case 0x82: {
        // Per-stage DPI value read, little-endian at bytes 3-4. Request byte
        // 2 selects the axis (0 both/X, 1 X, 2 Y) and the reply echoes it at
        // byte 8 — see incottEncodeQueryDpiAxis.
        const axis = payload[2] ?? 0;
        const table = axis === 2 ? state.dpiStagesWireY : state.dpiStagesWire;
        const wire = table[sub];
        if (wire === undefined) return null;
        return frame(0x82, sub, wire & 0xff, (wire >> 8) & 0xff, 0, 0, 0, axis);
      }
      case 0x83:
        // The DPI cycle: byte 2 the stage COUNT, byte 3 the active index.
        // Answers whatever sub-command was sent, because byte 2 is data, not
        // an echo — real hardware answers `09 83 00` with `09 83 06 01`, and
        // this fake used to answer only sub 0x06, which is what let the
        // driver's wrong echo assumption pass its tests.
        return frame(0x83, state.dpiStageCount, state.activeDpiStage);
      case 0x84:
        // sub 0x00 is the legacy packed byte-7 form (still decodable via
        // incottDecodeLiftOff/incottDecodeMotionSync, cross-checked against
        // the symmetric reads below on hardware 2026-09-08); the driver's
        // real read path uses subs 0x01/0x04 instead.
        if (sub === 0x00) return frame(0x84, 0x00, 0, 0, 0, 0, (state.lodWire << 4) | state.motionSync);
        if (sub === 0x01) return frame(0x84, 0x01, state.lodWire);
        if (sub === 0x02) return frame(0x84, 0x02, state.ripple);
        if (sub === 0x03) return frame(0x84, 0x03, state.angleSnap);
        if (sub === 0x04) return frame(0x84, 0x04, state.motionSync);
        if (sub === 0x05) return frame(0x84, 0x05, state.performanceMode);
        return null;
      case 0x85:
        if (sub === 0x01) return frame(0x85, 0x01, state.debounceMs);
        if (sub === 0x02) return frame(0x85, 0x02, state.fireKeyTimes, state.fireKeyIntervalMs);
        if (sub === 0x03) return frame(0x85, 0x03, state.sleepSeconds & 0xff, (state.sleepSeconds >> 8) & 0xff);
        return null;
      case 0x86: {
        // Echoes the button index, then the 32-bit binding little-endian.
        const code = state.buttons[sub];
        if (code === undefined) return null;
        return frame(0x86, sub, code & 0xff, (code >>> 8) & 0xff, (code >>> 16) & 0xff, (code >>> 24) & 0xff);
      }
      case 0x88:
        return frame(0x88, state.receiverLed);
      case 0x89:
        // Real hardware returned this same constant byte on every capture, in
        // every state — it is not a battery reading and nothing decodes it.
        return frame(0x89, 0, 0, 0, 0, 0, 0, 0x5a);
      case 0x8e:
        // Battery: byte 6, only on sub-command 0x01 — see incottDecodeBattery.
        return sub === 0x01 && state.batteryByte !== null
          ? frame(0x8e, 0x01, 0x5a, 0x04, 0x84, state.batteryByte, 0x01, 0x00)
          : null;
      case 0x8f:
        return state.identity === null ? null : frame(0x8f, ...state.identity);
      default:
        return null;
    }
  };

  const apply = (payload: Uint8Array): void => {
    const cmd = payload[0]!;
    const sub = payload[1]!;
    const value = payload[2]!;
    // cmd 0x02: `sub` here is a DPI STAGE INDEX (0-5), not a fixed
    // sub-command — the bug this driver used to have. See incottEncodeSetDpi.
    if (cmd === 0x02 && sub >= 0 && sub < state.dpiStagesWire.length) {
      // Payload byte 7 is the axis: 0 writes both, 1 X only, 2 Y only.
      const wire = value | ((payload[3] ?? 0) << 8);
      const axis = payload[7] ?? 0;
      if (axis !== 2) state.dpiStagesWire[sub] = wire;
      if (axis !== 1) state.dpiStagesWireY[sub] = wire;
    }
    // cmd 0x03: writes the CYCLE — byte 1 the stage count, byte 2 the active
    // index. Must never touch dpiStagesWire: this is the operation
    // IncottHIDApp mislabels "set DPI" and the one the driver's setDpi() used
    // to be conflated with. The count is stored, so a driver that sends a
    // hardcoded 6 here visibly resizes a shorter cycle.
    else if (cmd === 0x03 && sub >= 1 && sub <= state.dpiStagesWire.length && value >= 0 && value < sub) {
      state.dpiStageCount = sub;
      state.activeDpiStage = value;
    }
    else if (cmd === 0x01) state.pollingWire = sub; // no sub-command: wire value sits at byte 1
    else if (cmd === 0x04 && sub === 0x01) state.lodWire = value;
    else if (cmd === 0x04 && sub === 0x02) state.ripple = value;
    else if (cmd === 0x04 && sub === 0x03) state.angleSnap = value;
    else if (cmd === 0x04 && sub === 0x04) state.motionSync = value;
    else if (cmd === 0x04 && sub === 0x05) state.performanceMode = value;
    else if (cmd === 0x05 && sub === 0x01) state.debounceMs = value;
    else if (cmd === 0x05 && sub === 0x02) { state.fireKeyTimes = value; state.fireKeyIntervalMs = payload[3] ?? 0; }
    else if (cmd === 0x05 && sub === 0x03) state.sleepSeconds = value | ((payload[3] ?? 0) << 8);
    else if (cmd === 0x08) state.receiverLed = sub; // no sub-command: mode sits at byte 1
    // cmd 0x06: `sub` is the button WIRE index, then the 32-bit action.
    else if (cmd === 0x06 && sub >= 0 && sub < state.buttons.length) {
      state.buttons[sub] =
        ((value | ((payload[3] ?? 0) << 8) | ((payload[4] ?? 0) << 16) | ((payload[5] ?? 0) << 24)) >>> 0);
    }
  };

  const device = {
    vendorId: INCOTT_VENDOR_ID,
    productId: options.productId ?? INCOTT_PRODUCT_ID,
    productName: options.productName ?? "incott 8K wireless mouse",
    get opened() {
      return opened;
    },
    collections: options.collections ?? [vendorCollection()],
    open: async () => {
      opened = true;
    },
    close: async () => {
      opened = false;
    },
    // Only the macro upload sends these; everything else is a feature report.
    sendReport: async (reportId: number, data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      outputs.push({ reportId, bytes: new Uint8Array(view) });
    },
    sendFeatureReport: async (_reportId: number, data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const payload = new Uint8Array(view);
      sent.push(payload);
      if (options.deadCollection) {
        // Real hardware attempts the write and only THEN fails it — Windows'
        // HidD_SetFeature rejects it at the OS level. Recording the attempt
        // before throwing keeps `sent` a faithful attempt count.
        throw new Error("HidD_SetFeature: (0x00000001) Incorrect function");
      }
      if (payload[0]! < 0x80) {
        if (!options.ignoreWrites) apply(payload);
        return;
      }
      const answer = reply(payload);
      if (answer) buffer = answer;
    },
    receiveFeatureReport: async (_reportId: number) => new DataView(new Uint8Array(buffer).buffer),
    addEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport") inputReportListener = listener;
    },
    removeEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport" && inputReportListener === listener) inputReportListener = null;
    },
  };

  return {
    device: device as unknown as HIDDevice,
    sent,
    outputs,
    state,
    /**
     * Simulates the mouse's unsolicited input report arriving — only fires
     * once `open()` has attached the listener (real WebHID would simply drop
     * the event with nothing listening). `bytes` excludes the report id, the
     * same WebHID convention `onInputReport` expects (see its doc comment).
     */
    fireInputReport: (bytes: readonly [number, number, ...number[]]) => {
      if (!inputReportListener) return;
      const data = new Uint8Array(bytes);
      inputReportListener({
        reportId: INCOTT_REPORT_ID,
        data: new DataView(data.buffer, data.byteOffset, data.byteLength),
      } as unknown as HIDInputReportEvent);
    },
  };
}

const fast: IncottTransactionOptions = { settleMs: 0, attempts: 3, sleep: async () => {} };

/** A vendor collection that declares some OTHER feature report id. */
function siblingCollection(usagePage: number, reportId: number): HIDCollectionInfo {
  return {
    usagePage,
    usage: 0x01,
    type: 1,
    children: [],
    featureReports: [{ reportId, items: [] }],
    inputReports: [],
    outputReports: [],
  } as unknown as HIDCollectionInfo;
}

test("isSupported requires the 0xFF05 collection that declares feature report 0x09", () => {
  assert.equal(IncottHidClient.isSupported(fakeDevice().device), true);
  assert.equal(IncottHidClient.isSupported(fakeDevice({ productId: INCOTT_PRODUCT_ID_WIRED }).device), true);
  assert.equal(IncottHidClient.isSupported(fakeDevice({ productId: 0x1234 }).device), false);
  assert.equal(IncottHidClient.isSupported({ ...fakeDevice().device, vendorId: 0x1532 } as HIDDevice), false);
  assert.equal(IncottHidClient.isSupported(fakeDevice({ collections: [vendorCollection(0x0001)] }).device), false);
  assert.equal(IncottHidClient.isSupported(fakeDevice({ collections: [] }).device), false);
  // A vendor page alone is not enough — it must also declare report 0x09.
  assert.equal(IncottHidClient.isSupported(fakeDevice({ collections: [vendorCollection(0xff00)] }).device), false);
  assert.equal(
    IncottHidClient.isSupported(fakeDevice({ collections: [siblingCollection(INCOTT_USAGE_PAGE, 0x03)] }).device),
    false,
  );
});

test("isSupported claims the mouse exactly once across its real collection set", () => {
  // Enumerated from a connected G23V2Pro on 2026-09-10. The mouse presents as
  // several HIDDevices; only the 0xFF05 collection declaring feature report
  // 0x09 speaks the protocol. Its vendor-page siblings declare 0x03 and 0x04
  // and never answer, so claiming them made the app list the mouse once per
  // collection with every card but one inert.
  const protocolDevice = fakeDevice({ collections: [vendorCollection(INCOTT_USAGE_PAGE)] }).device;
  const siblingDevice = fakeDevice({
    collections: [siblingCollection(0xff00, 0x03), siblingCollection(0xff01, 0x04)],
  }).device;
  const plainMouse = fakeDevice({ collections: [vendorCollection(0x0001)] }).device;

  const claimed = [protocolDevice, siblingDevice, plainMouse].filter((d) => IncottHidClient.isSupported(d));
  assert.equal(claimed.length, 1, "exactly one collection may be claimed");
  assert.equal(claimed[0], protocolDevice);
});

test("filters request both product ids on the vendor usage page", () => {
  assert.deepEqual(IncottHidClient.filters, [
    { vendorId: INCOTT_VENDOR_ID, productId: INCOTT_PRODUCT_ID, usagePage: INCOTT_USAGE_PAGE },
    { vendorId: INCOTT_VENDOR_ID, productId: INCOTT_PRODUCT_ID_WIRED, usagePage: INCOTT_USAGE_PAGE },
  ]);
});

test("getDebounceMaxMs, getDebounceOptions and getSleepOptions expose the verified ranges", () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.equal(client.getDebounceMaxMs(), 30);
  assert.deepEqual(client.getDebounceOptions(), Array.from({ length: 31 }, (_, ms) => ms));
  assert.deepEqual(client.getSleepOptions(), [10, 30, 60, 120, 300, 600, 900]);
});

test("readStatus decodes every field from the device's current state", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  // DPI is a genuine live read as of 2026-09-08 (see the class comment in
  // hid.ts): no write needed first. Default state has stage 1 (800 DPI)
  // active.
  const status = await client.readStatus();
  assert.equal(status.brand, "Incott");
  // Read FROM THE DEVICE, not from the product string: the dongle reports a
  // generic "incott 8K wireless mouse" with no model in it, while the
  // identity reply names the model (see `incottDecodeIdentity`). The raw
  // string remains available as client.device.productName.
  assert.equal(status.name, "G23V2 Pro");
  assert.equal(device.productName, "incott 8K wireless mouse", "the raw product string stays available on the device");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.equal(status.activeProfile, null);
  assert.equal(status.liftOffDistance, "Medium");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "Medium", "High"]);
  assert.equal(status.motionSync, true);
  assert.equal(status.rippleControl, false);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.debounceMs, 4);
  assert.equal(status.sleepTimeout, 60);
  // Default state's performanceMode wire value is 1 -> "Corded" (see
  // incottPerformanceModeFromWire / INCOTT_SUB_PERFORMANCE for the confirmed,
  // UI-order-reversed mapping).
  assert.equal(status.powerMode, "Corded");
  assert.deepEqual(status.powerModes, ["HP", "Corded", "LP"]);
  // Battery is read from the mouse's unsolicited input report, not from any
  // feature-report query readStatus() issues (0x8e/byte 6 and 0x89/byte 8 are
  // BOTH disproven constants — see incottDecodeBattery/INCOTT_CMD_QUERY_STATUS
  // in src/incott/index.ts). This test never fires that input report, so
  // battery must stay null/"Unknown" — see the dedicated input-report tests
  // below for the populated case.
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
  assert.deepEqual(status.firmware, ["Identity 01 0e 02 f0 f1 00 ff"]);
  assert.equal(status.ui?.family, "incott");
  assert.equal(status.ui?.showAdvancedSection, true);
  assert.equal(status.ui?.hideSignalCard, true);
  assert.equal(status.ui?.defaultDisplayName, "G23V2 Pro");
  assert.equal(status.ui?.hideUnsupportedPollingRates, true);
  assert.equal(status.ui?.pollingNote, "Up to 8,000 Hz wireless; 1,000 Hz over the cable.");
  // The mouse has a real internal battery even while wired, so the app's
  // "hide battery when wired and unread" default must be overridden — see
  // the comment on this flag in hid.ts.
  assert.equal(status.ui?.forceShowBattery, true);
  // Six-stage table, populated in full since every stage answered.
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 2400, 3200, 6400]);
  assert.equal(status.activeDpiStage, 1);
  assert.deepEqual(status.ui?.dpiStageEditor, {
    maxStages: 6,
    countEditable: true,
    minDpi: 50,
    maxDpi: 45000,
    stepDpi: 50,
  });
});

test("readStatus reports a live DPI reading without any write this session", async () => {
  // Proves the 2026-09-08 fix: DPI used to be a write-only cache that started
  // null every session (see git history); it is now read from the six-stage
  // table (active stage index via 0x83/0x06, then that stage's value via
  // 0x82) with no write required first.
  const { device } = fakeDevice();
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.dpi, 800);
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.pollingRateHz, 1000);
  // Battery is independent of the feature-report DPI/polling reads (it comes
  // from the input report instead), and no input report was fired here.
  assert.equal(status.batteryPercent, null);
});

test("readStatus degrades gracefully when the active DPI stage cannot be read", async () => {
  const { device } = fakeDevice({ silent: [0x83] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.dpi, 0, "inert placeholder, never rendered because settingsReady is false");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  // Polling rate is still genuinely readable independent of DPI. Battery
  // stays null regardless (no input report fired, and it never came from a
  // feature-report query in the first place).
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.batteryPercent, null);
});

test("readStatus degrades gracefully when the DPI stage's value cannot be read", async () => {
  const { device } = fakeDevice({ silent: [0x82] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.dpi, 0, "inert placeholder, never rendered because settingsReady is false");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  // Every one of the six stage reads failed, so the table is omitted rather
  // than fabricated with placeholder entries.
  assert.equal(status.dpiStages, undefined);
});

test("readStatus omits activeDpiStage but still reads the six-stage table when only the active-index query fails", async () => {
  // The active-stage index (0x83) and the six per-stage values (0x82) are
  // independent reads; one failing must not fabricate or suppress the other.
  const { device } = fakeDevice({ silent: [0x83] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.activeDpiStage, undefined);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 2400, 3200, 6400]);
});

test("the wired product id (0x622C) reports connectionType Wired but battery state Unknown until an input report arrives", async () => {
  // Hardware-verified 2026-09-08: plugged in over USB the mouse enumerates
  // as 0x622C, which is the CONNECTION type (see incottIsWiredProduct) — NOT
  // a source for batteryState any more. Being wired does imply charging in
  // practice, but the input report is the authoritative source for the
  // charging bit, and none has arrived in this test, so battery stays
  // Unknown/null even though the mouse is wired. See the dedicated
  // input-report tests below for the charging=true case.
  const { device } = fakeDevice({ productId: INCOTT_PRODUCT_ID_WIRED });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.batteryPercent, null);
});

test("the wireless product id (0x522C) reports connectionType Wireless and battery state Unknown until an input report arrives", async () => {
  const { device } = fakeDevice({ productId: INCOTT_PRODUCT_ID });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryState, "Unknown");
});

test("battery state is Unknown before any input report has arrived, regardless of product id or feature-report state", async () => {
  // The old `state.batteryByte` fake-device field fed the disproven 0x8e
  // feature-report battery read; it is kept here (still answering 0x38) to
  // prove readStatus() no longer looks at it at all — see the dedicated
  // 0x8e regression test further down for the sharper version of this claim.
  const { device } = fakeDevice({ productId: INCOTT_PRODUCT_ID_WIRED, state: { batteryByte: null } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.connectionType, "Wired", "connection type is independent of the battery read");
});

test("readStatus leaves powerMode/powerModes undefined when 0x84/0x05 cannot be read", async () => {
  // Never fabricated: an unreadable performance mode must not default to any
  // label, and powerModes (the option list) is withheld alongside it so the
  // shell does not offer a selector it cannot back with a current value.
  const { device } = fakeDevice({ silent: [0x84] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.powerMode, undefined);
  assert.equal(status.powerModes, undefined);
});

test("supportedPollingRates and the polling footnote are narrower over the wired connection", async () => {
  // Hardware-verified: the owner confirmed the mouse only reaches 1000 Hz
  // over the cable; 2000/4000/8000 Hz are wireless-only. Offering them wired
  // would let the shell stage a write the device silently refuses.
  const { device } = fakeDevice({ productId: INCOTT_PRODUCT_ID_WIRED });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
  assert.equal(status.ui?.hideUnsupportedPollingRates, true);
  assert.equal(status.ui?.pollingNote, "Up to 1,000 Hz over the cable; 8,000 Hz needs the wireless dongle.");
});

test("supportedPollingRates offers the full ladder over the wireless connection", async () => {
  const { device } = fakeDevice({ productId: INCOTT_PRODUCT_ID });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.equal(status.ui?.pollingNote, "Up to 8,000 Hz wireless; 1,000 Hz over the cable.");
});

test("readStatus trims the published stage table to the cycle the mouse actually uses", async () => {
  // The device keeps six stored values regardless; only the first `count` are
  // in the rotation, and offering the rest would let the user select a stage
  // the mouse never visits.
  const { device } = fakeDevice({ state: { dpiStageCount: 4, activeDpiStage: 2 } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 2400]);
  assert.equal(status.activeDpiStage, 2);
  assert.equal(status.dpi, 1600);
});

test("REGRESSION: a cycle shorter than six still reads, instead of failing the sub-echo match", async () => {
  // 0x83's byte 2 is the stage count, which the driver used to require to
  // equal the 0x06 it sent. On a four-stage mouse every DPI read returned
  // null and the whole settings grid was hidden.
  const { device } = fakeDevice({ state: { dpiStageCount: 3, activeDpiStage: 0 } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.activeDpiStage, 0);
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
});

test("REGRESSION: selecting a stage preserves the cycle length instead of resetting it to six", async () => {
  // The count shares the write with the index. Sending a hardcoded 0x06 here
  // silently grew a four-stage cycle back to six every time the user picked a
  // different DPI stage.
  const { device, state } = fakeDevice({ state: { dpiStageCount: 4, activeDpiStage: 0 } });
  await new IncottHidClient(device, fast).setActiveDpiStage(3);
  assert.equal(state.activeDpiStage, 3);
  assert.equal(state.dpiStageCount, 4, "the cycle length must survive a stage select");
});

test("setActiveDpiStage refuses a stage outside the mouse's current cycle", async () => {
  const { device, state } = fakeDevice({ state: { dpiStageCount: 3, activeDpiStage: 0 } });
  await assert.rejects(
    () => new IncottHidClient(device, fast).setActiveDpiStage(4),
    /outside this mouse's 3-stage cycle/,
  );
  assert.equal(state.activeDpiStage, 0, "nothing was written");
});

test("setDpiStageCount resizes the cycle and leaves every stored DPI value alone", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  const before = [...state.dpiStagesWire];
  await client.setDpiStageCount(3);
  assert.equal(state.dpiStageCount, 3);
  assert.deepEqual(state.dpiStagesWire, before, "stage values are untouched by a resize");
  const status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
});

test("setDpiStageCount clamps an active stage that would fall outside the new cycle", async () => {
  // The active index rides along in the same write, so it cannot be left
  // pointing past the end of the shortened cycle.
  const { device, state } = fakeDevice({ state: { activeDpiStage: 5 } });
  await new IncottHidClient(device, fast).setDpiStageCount(2);
  assert.equal(state.dpiStageCount, 2);
  assert.equal(state.activeDpiStage, 1);
});

test("setDpiStageCount rejects a count outside 1-6 without writing", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await assert.rejects(() => client.setDpiStageCount(0), RangeError);
  await assert.rejects(() => client.setDpiStageCount(7), RangeError);
  assert.equal(state.dpiStageCount, 6);
});

test("the stage-count picker is hidden when the cycle cannot be read", async () => {
  // setDpiStageCount needs a real current count to preserve the active stage;
  // offering the control against an unreadable one would write a guess.
  const { device } = fakeDevice({ silent: [0x83] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.ui?.dpiStageEditor?.countEditable, false);
});

test("readStatus publishes the six factory bindings by physical button name", async () => {
  const { device } = fakeDevice();
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.deepEqual(status.buttonMappings, {
    Left: "Left click",
    Right: "Right click",
    Middle: "Middle click",
    // Proves the wire transposition is undone: wire index 4 holds 0x00F40001
    // (forward) and is published as Forward, not as the button at array
    // position 4.
    Forward: "Forward",
    Back: "Back",
    DPI: "DPI cycle",
  });
  assert.equal(status.buttonOptions?.[0], "Left click");
  assert.ok(status.buttonOptions?.includes("Disabled"));
});

test("readStatus hides the remapper entirely when a button read fails", async () => {
  // Partial assignments would be published as real ones, and the shared
  // remapper writes back what it shows.
  const { device } = fakeDevice({ silent: [0x86] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.buttonMappings, undefined);
  assert.equal(status.buttonOptions, undefined);
});

test("readStatus reports an unrecognised binding as a raw code, not as a known action", async () => {
  // Nothing this driver can name — not a mouse, media, keyboard or macro
  // encoding — so it must be reported rather than mislabelled.
  const { device } = fakeDevice({ state: { buttons: [0x12345678, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007] } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.buttonMappings?.Left, "Unknown (0x12345678)");
});

test("readStatus labels a keyboard binding read back from the mouse", async () => {
  const { device } = fakeDevice({ state: { buttons: [0x00f00001, 0x00f10001, 0x00060100, 0x00f30001, 0x00f40001, 0x00030007] } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.buttonMappings?.Middle, "Ctrl + C");
});

test("setButtonMapping writes the action and verifies the read-back", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.setButtonMapping("Middle", "Mute");
  const status = await client.readStatus();
  assert.equal(status.buttonMappings?.Middle, "Mute");
  // Nothing else moved.
  assert.equal(status.buttonMappings?.Left, "Left click");
  assert.equal(status.buttonMappings?.DPI, "DPI cycle");
});

test("setButtonMapping addresses Forward and Back by their wire index, not their position", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.setButtonMapping("Forward", "Disabled");
  // Wire index 4 is Forward. If the driver had used the display position (3)
  // it would have silently disabled Back instead.
  assert.equal(state.buttons[4], 0);
  assert.equal(state.buttons[3], 0x00f30001, "Back is untouched");
});

test("setButtonMapping rejects an unknown button or action without writing", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await assert.rejects(() => client.setButtonMapping("Thumb", "Mute"), /no "Thumb" button/);
  await assert.rejects(() => client.setButtonMapping("Middle", "Teleport"), /Unknown button action/);
  assert.deepEqual(state.buttons, [0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007]);
});

test("setButtonMapping throws when the mouse does not take the binding", async () => {
  const { device } = fakeDevice({ ignoreWrites: true });
  const client = new IncottHidClient(device, fast);
  await assert.rejects(() => client.setButtonMapping("Middle", "Mute"), /instead of Mute/);
});

test("readStatus reports the same model name wired as wireless", async () => {
  // The wired product string does carry a model ("incott Esports G23V2Pro
  // mouse", verified 2026-09-08) while the dongle's does not, so relying on
  // it would name the mouse differently depending on how it is plugged in.
  // The identity reply is the same either way, so the name is too. The raw
  // string stays available for anything that wants it.
  const { device } = fakeDevice({ productId: INCOTT_PRODUCT_ID_WIRED, productName: "incott Esports G23V2Pro mouse" });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.name, "G23V2 Pro");
  assert.equal(device.productName, "incott Esports G23V2Pro mouse", "the raw string stays available on the device");
});

test("readStatus falls back to the product string when the model code is unknown", async () => {
  // An Incott model this table has never seen must report whatever the
  // device called itself, never a guess.
  const { device } = fakeDevice({
    productId: INCOTT_PRODUCT_ID_WIRED,
    productName: "incott Esports G99 mouse",
    state: { identity: [0x01, 0x7f, 0x02, 0xf0, 0xf1, 0x00, 0xff] },
  });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.name, "Esports G99");
});

test("firmware falls back to a plain notice when identity cannot be read", async () => {
  const { device } = fakeDevice({ state: { identity: null } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.deepEqual(status.firmware, ["Identity unavailable"]);
});

test("readStatus degrades to identity-only fields rather than fabricate the polling rate when 0x81 never answers", async () => {
  const { device } = fakeDevice({ silent: [0x81] });
  const client = new IncottHidClient(device, fast);
  const status = await client.readStatus();
  // The identity query still answers here — only 0x81 is silent — so the
  // model is still read from the device.
  assert.equal(status.name, "G23V2 Pro");
  assert.equal(status.brand, "Incott");
  assert.equal(status.pollingRateHz, 0, "inert placeholder, never rendered because settingsReady is false");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
});

test("readStatus reflects a DPI value written earlier this session", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.setDpi(1600);
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.dpi, 1600);
});

test("setDpi writes the linear wire value to the active stage and confirms by reading it back", async () => {
  const { device, sent, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  // Captured 2026-09-08: TX 09 02 <stage> <lo> <hi> — `stage` is the active
  // stage's index (default 1 here), not the hardcoded 0x01 this driver used
  // to send regardless of which stage was active (see incottEncodeSetDpi).
  assert.equal(await client.setDpi(800), 800);
  assert.equal(state.dpiStagesWire[1], 15);
  assert.equal(await client.setDpi(25000), 25000);
  assert.equal(state.dpiStagesWire[1], 499);

  const writes = sent.filter((payload) => payload[0] === 0x02);
  assert.deepEqual([...writes[0]!.slice(0, 4)], [0x02, 0x01, 0x0f, 0x00]);
  assert.deepEqual([...writes[1]!.slice(0, 4)], [0x02, 0x01, 0xf3, 0x01]);
});

test("setDpi writes to whichever stage is actually active, not always stage 1", async () => {
  const { device, sent, state } = fakeDevice({ state: { activeDpiStage: 4 } });
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setDpi(3200), 3200);
  assert.equal(state.dpiStagesWire[4], 63);
  const write = sent.find((payload) => payload[0] === 0x02)!;
  assert.equal(write[1], 4, "the stage byte must follow the active stage, not a hardcoded constant");
});

test("setDpi throws when the mouse does not keep the new value", async () => {
  // Now that DPI has a real read-back (see the class comment in hid.ts), a
  // dropped write is detected and reported the same way every other setter
  // in this client reports one.
  const stuck = fakeDevice({ ignoreWrites: true });
  const stuckClient = new IncottHidClient(stuck.device, fast);
  await assert.rejects(stuckClient.setDpi(6400), /kept 800 DPI instead of 6400/);
  assert.equal(stuck.state.dpiStagesWire[1], 15, "the fake device's wire value never actually moved");
});

test("setDpi throws when the active DPI stage cannot be determined", async () => {
  const { device } = fakeDevice({ silent: [0x83] });
  const client = new IncottHidClient(device, fast);
  await assert.rejects(client.setDpi(800), /active DPI stage/);
});

test("setDpi rejects a value outside 50-45000 or off the 50-DPI step without touching the device", async () => {
  const { device, sent } = fakeDevice();
  await assert.rejects(new IncottHidClient(device, fast).setDpi(45050), RangeError);
  await assert.rejects(new IncottHidClient(device, fast).setDpi(825), RangeError);
  assert.equal(sent.length, 0);
});

test("setActiveDpiStage selects a stage without writing a value into it — the regression this driver used to have", async () => {
  // THE BUG: setDpi() used to be the only way to change DPI, so the app
  // called it for what the user meant as a stage select, and it silently
  // overwrote the active stage's stored value. setActiveDpiStage must not
  // reproduce that: selecting stage 4 must never emit a 0x02 (stage-value)
  // write, and the stage table must be completely unchanged afterwards.
  const { device, sent, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  const before = [...state.dpiStagesWire];
  assert.equal(await client.setActiveDpiStage(4), 4);
  assert.equal(state.activeDpiStage, 4);
  assert.deepEqual(state.dpiStagesWire, before, "selecting a stage must not alter any stage's stored value");
  assert.equal(sent.some((payload) => payload[0] === 0x02), false, "must not emit a stage-value write");
  const write = sent.find((payload) => payload[0] === 0x03)!;
  assert.deepEqual([...write.slice(0, 3)], [0x03, 0x06, 0x04], "09 03 06 <idx> — command, sub-command, stage index");
});

test("setActiveDpiStage round-trips indices 0-5 and confirms by re-reading the active index", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  for (const index of [0, 3, 5, 1]) {
    assert.equal(await client.setActiveDpiStage(index), index);
    assert.equal(state.activeDpiStage, index);
  }
});

test("setActiveDpiStage throws when the mouse does not keep the new active index", async () => {
  const stuck = fakeDevice({ ignoreWrites: true });
  const client = new IncottHidClient(stuck.device, fast);
  await assert.rejects(client.setActiveDpiStage(3), /kept DPI stage 1 instead of 3/);
});

test("setActiveDpiStage rejects a stage index outside 0-5 without touching the device", async () => {
  const { device, sent } = fakeDevice();
  await assert.rejects(new IncottHidClient(device, fast).setActiveDpiStage(6), RangeError);
  await assert.rejects(new IncottHidClient(device, fast).setActiveDpiStage(-1), RangeError);
  assert.equal(sent.length, 0);
});

test("setDpiStageValue edits the requested stage regardless of which stage is active", async () => {
  const { device, sent, state } = fakeDevice({ state: { activeDpiStage: 1 } });
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setDpiStageValue(4, 3200), 3200);
  assert.equal(state.dpiStagesWire[4], 63);
  assert.equal(state.dpiStagesWire[1], 15, "the active stage's own value must be untouched");
  const write = sent.find((payload) => payload[0] === 0x02)!;
  assert.deepEqual([...write.slice(0, 4)], [0x02, 0x04, 0x3f, 0x00]);
});

test("setDpiStageValue throws when the mouse does not keep the new value", async () => {
  const stuck = fakeDevice({ ignoreWrites: true });
  const client = new IncottHidClient(stuck.device, fast);
  await assert.rejects(client.setDpiStageValue(2, 6400), /kept 1600 DPI instead of 6400 on stage 2/);
});

test("setDpiStageValue rejects an out-of-range stage or DPI value without touching the device", async () => {
  const { device, sent } = fakeDevice();
  await assert.rejects(new IncottHidClient(device, fast).setDpiStageValue(6, 800), RangeError);
  await assert.rejects(new IncottHidClient(device, fast).setDpiStageValue(0, 825), RangeError);
  assert.equal(sent.length, 0);
});

test("setPollingRate round-trips through the wire table", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setPollingRate(8000), 8000);
  assert.equal(state.pollingWire, 4);
});

test("setPollingRate rejects an unsupported rate", async () => {
  await assert.rejects(new IncottHidClient(fakeDevice().device, fast).setPollingRate(333), /polling/i);
});

test("setLiftOffDistance maps the three named stops onto tenths of a millimetre", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  assert.equal(state.lodWire, 2);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.equal(state.lodWire, 1);
  const stuck = fakeDevice({ ignoreWrites: true });
  await assert.rejects(new IncottHidClient(stuck.device, fast).setLiftOffDistance("Low"), /kept a Medium lift-off/);
});

test("setMotionSync, setAngleSnapping and setRippleControl are independent toggles", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setMotionSync(false), false);
  assert.equal(state.motionSync, 0);
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(state.angleSnap, 1);
  assert.equal(await client.setRippleControl(true), true);
  assert.equal(state.ripple, 1);
  // Setting one toggle must not disturb the others.
  assert.equal(state.motionSync, 0);
});

test("toggles fail loudly when the mouse does not keep the new value", async () => {
  const stuck = fakeDevice({ ignoreWrites: true });
  const client = new IncottHidClient(stuck.device, fast);
  await assert.rejects(client.setMotionSync(false), /kept Motion Sync on/);
  await assert.rejects(client.setAngleSnapping(true), /kept angle snapping off/);
  await assert.rejects(client.setRippleControl(true), /kept ripple control off/);
});

test("setDebounceTime and setSleepTimeout round-trip and reject out-of-range values", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setDebounceTime(12), 12);
  assert.equal(state.debounceMs, 12);
  assert.equal(await client.setSleepTimeout(900), 900);
  assert.equal(state.sleepSeconds, 900);
  await assert.rejects(client.setDebounceTime(31), /debounce/i);
  await assert.rejects(client.setSleepTimeout(0), /sleep/i);
});

test("setReceiverLed round-trips and rejects an unimplemented mode", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setReceiverLed(2), 2);
  assert.equal(state.receiverLed, 2);
  await assert.rejects(client.setReceiverLed(3), /receiver/i);
});

test("getDpiOptions publishes the real 50-45000 linear range in steps of 50; presets are a separate convenience list", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  const options = client.getDpiOptions();
  assert.equal(options.length, 900);
  assert.equal(options[0], 50);
  assert.equal(options[options.length - 1]!, 45000);
  assert.equal(options.includes(12000), true, "an arbitrary in-range, on-step value must be selectable");
  assert.equal(options.includes(825), false, "off the 50-DPI step");
  assert.deepEqual(client.getDpiDefaultStagePresets(), [400, 800, 1600, 2400, 3200, 6400]);

  assert.equal(device.opened, false);
  await client.open();
  assert.equal(device.opened, true);
  await client.close();
  assert.equal(device.opened, false);
});

test("setPerformanceMode writes the raw 0-2 value and round-trips through the best-effort read-back", async () => {
  const { device, sent, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.setPerformanceMode(2), 2);
  assert.equal(state.performanceMode, 2);
  assert.deepEqual([...sent[0]!.slice(0, 3)], [0x04, 0x05, 0x02]);
  assert.equal(await client.getPerformanceMode(), 2);
});

test("setPerformanceMode does not throw when the device never answers the read-back", async () => {
  const { device } = fakeDevice({ silent: [0x84] });
  const client = new IncottHidClient(device, fast);
  // Nothing to compare against, so this must succeed rather than fabricate a failure.
  assert.equal(await client.setPerformanceMode(1), 1);
  assert.equal(await client.getPerformanceMode(), null);
});

test("setPerformanceMode throws when a confirmed read-back disagrees", async () => {
  const { device } = fakeDevice({ ignoreWrites: true });
  await assert.rejects(new IncottHidClient(device, fast).setPerformanceMode(2), /kept performance mode 1/);
});

test("setPerformanceMode rejects a value outside 0-2", async () => {
  await assert.rejects(new IncottHidClient(fakeDevice().device, fast).setPerformanceMode(3), RangeError);
});

// ---------------------------------------------------------------------------
// getPowerModes / setPowerMode — OpenMouse's shared power/performance-mode
// contract (openmouse/src/device/controller.ts's requireClientMethod
// ("setPowerMode", …)). Hardware-confirmed 2026-09-10: HP=2, Corded=1, LP=0,
// the REVERSE of the vendor UI's own left-to-right display order — see
// INCOTT_SUB_PERFORMANCE in src/incott/index.ts and
// captures/incott-8k-wireless/vendor-tool-session-2026-09-10.hex.
// ---------------------------------------------------------------------------

test("getPowerModes advertises the vendor UI's own left-to-right order", () => {
  const client = new IncottHidClient(fakeDevice().device, fast);
  assert.deepEqual(client.getPowerModes(), ["HP", "Corded", "LP"]);
});

test("setPowerMode writes the reversed wire value for each name and verifies the read-back", async () => {
  // Each setPowerMode call sends TWO feature reports: the write, then the
  // 0x84/0x05 read-back query (which sends its own request payload too) — so
  // the write is the SECOND-TO-LAST entry in `sent`, not the last.
  const { device, sent, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  const lastWrite = () => sent[sent.length - 2]!;

  await client.setPowerMode("HP");
  assert.equal(state.performanceMode, 2, "HP must write wire value 2, not 0");
  assert.deepEqual([...lastWrite().slice(0, 3)], [0x04, 0x05, 0x02]);

  await client.setPowerMode("Corded");
  assert.equal(state.performanceMode, 1);
  assert.deepEqual([...lastWrite().slice(0, 3)], [0x04, 0x05, 0x01]);

  await client.setPowerMode("LP");
  assert.equal(state.performanceMode, 0, "LP must write wire value 0, not 2");
  assert.deepEqual([...lastWrite().slice(0, 3)], [0x04, 0x05, 0x00]);
});

test("setPowerMode rejects an unknown mode name before writing anything", async () => {
  const { device, sent } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await assert.rejects(client.setPowerMode("Ultra"), /no "Ultra" performance mode/);
  assert.equal(sent.length, 0, "an unknown name must never reach the device");
});

test("setPowerMode reports failure when the read-back disagrees", async () => {
  // ignoreWrites: the device drops every SET, so the write never actually
  // takes — the read-back keeps reporting the untouched default (Corded).
  const { device } = fakeDevice({ ignoreWrites: true });
  const client = new IncottHidClient(device, fast);
  await assert.rejects(client.setPowerMode("HP"), /kept performance mode Corded instead of HP/);
});

test("setPowerMode reports failure, not success, when the read-back never answers", async () => {
  // Unlike the lower-level setPerformanceMode (which tolerates a silent
  // read-back), setPowerMode must treat an unverifiable write as a failure.
  const { device } = fakeDevice({ silent: [0x84] });
  const client = new IncottHidClient(device, fast);
  await assert.rejects(client.setPowerMode("HP"), /Could not read back the performance mode/);
});

// ---------------------------------------------------------------------------
// incottProbeCollection / incottSelectCollection — the wired dead-collection
// fix. Hardware-verified 2026-09-08: the wired mouse exposes two
// identical-looking 0xFF05 collections on the same interface; only one
// answers feature reports, and the other fails Windows' HidD_SetFeature call
// outright. Usage page alone cannot distinguish them — only probing can.
// ---------------------------------------------------------------------------

/** A transport whose sendFeatureReport always throws — the dead collection. */
class ThrowingTransport implements FeatureTransport {
  async sendFeatureReport(): Promise<void> {
    throw new Error("HidD_SetFeature: (0x00000001) Incorrect function");
  }
  async receiveFeatureReport(): Promise<DataView> {
    return new DataView(new Uint8Array(64).buffer);
  }
}

/** A transport that answers the identity query like the live collection. */
class IdentityTransport implements FeatureTransport {
  sent: Uint8Array[] = [];
  async sendFeatureReport(_reportId: number, data: BufferSource): Promise<void> {
    this.sent.push(new Uint8Array(data as ArrayBuffer));
  }
  async receiveFeatureReport(): Promise<DataView> {
    const value = frame(0x8f, 0x01, 0x0e, 0x02, 0xf0, 0xf1, 0x00, 0xff);
    return new DataView(value.buffer, value.byteOffset, value.byteLength);
  }
}

test("incottProbeCollection returns true when the collection answers the identity probe", async () => {
  assert.equal(await incottProbeCollection(new IdentityTransport(), immediate), true);
});

test("incottProbeCollection returns false, never throws, when sendFeatureReport rejects", async () => {
  await assert.doesNotReject(async () => {
    assert.equal(await incottProbeCollection(new ThrowingTransport(), immediate), false);
  });
});

test("incottProbeCollection returns false when the collection never replies", async () => {
  const silent: FeatureTransport = {
    async sendFeatureReport() {},
    async receiveFeatureReport() {
      return new DataView(new Uint8Array(64).buffer);
    },
  };
  assert.equal(await incottProbeCollection(silent, immediate), false);
});

test("incottSelectCollection picks the second candidate when the first throws on sendFeatureReport", async () => {
  // Mirrors the real wired scenario: ordered 0xFF05-first candidates, the
  // first one dead, the second one live.
  const dead = new ThrowingTransport();
  const live = new IdentityTransport();
  const chosen = await incottSelectCollection([dead, live], immediate);
  assert.equal(chosen, live);
});

test("incottSelectCollection returns null when every candidate is dead", async () => {
  const chosen = await incottSelectCollection([new ThrowingTransport(), new ThrowingTransport()], immediate);
  assert.equal(chosen, null);
});

test("incottSelectCollection returns the sole candidate when it is the only one and it answers", async () => {
  const live = new IdentityTransport();
  assert.equal(await incottSelectCollection([live], immediate), live);
});

// ---------------------------------------------------------------------------
// IncottHidClient.open() + readStatus() — the WebHID single-collection path.
// ---------------------------------------------------------------------------

test("open() probes the identity query and readStatus() still reads normally when the collection is live", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.open();
  const status = await client.readStatus();
  // The probe itself must not disturb a live collection's normal readout.
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.dpi, 800);
});

test("open() never throws when the collection is dead, and readStatus() degrades gracefully without wasting the retry budget on every field", async () => {
  const { device, sent } = fakeDevice({ deadCollection: true });
  const client = new IncottHidClient(device, fast);
  // Neither call may throw — this IS the graceful-degradation contract.
  await client.open();
  const sentAfterOpen = sent.length;
  const status = await client.readStatus();
  // Fast path: readStatus() must not have issued a single further send once
  // open()'s probe already proved this collection dead (it would otherwise
  // attempt ~12 more queries, each burning its own retry budget).
  assert.equal(sent.length, sentAfterOpen, "readStatus must not query a collection already known to be dead");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.dpi, 0, "inert placeholder, never rendered because settingsReady is false");
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.dpiStages, undefined);
  assert.equal(status.motionSync, null);
  assert.equal(status.debounceMs, null);
  // Identity, brand and name come from the USB descriptor / fallback string,
  // not a feature report, so they remain genuinely available.
  assert.equal(status.brand, "Incott");
  assert.equal(status.name, "8K wireless");
  assert.deepEqual(status.firmware, ["Identity unavailable"]);
  assert.match(status.ui?.statusNote ?? "", /second, identical-looking collection/);
});

test("readStatus without ever calling open() is unaffected by the dead-collection fast path", async () => {
  // Every pre-existing test in this file calls readStatus() without open()
  // first; collectionVerified must stay null (not false) in that case so
  // this fast path never engages for callers that never probed.
  const { device } = fakeDevice({ silent: [0x81, 0x82, 0x83, 0x84, 0x85, 0x88, 0x89, 0x8e, 0x8f] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.statusNote, undefined, "no probe ran, so there is nothing to report as a dead collection");
});

// ---------------------------------------------------------------------------
// Battery via the mouse's unsolicited input report (hardware-verified
// 2026-09-08) — NOT the disproven 0x8e/byte-6 or 0x89/byte-8 feature-report
// reads. See the class comment on IncottHidClient and incottDecodeInputStatus
// in src/incott/index.ts.
// ---------------------------------------------------------------------------

test("battery is null and state Unknown before any input report has arrived, even after open()", async () => {
  // Attaching the listener in open() must not itself fabricate a reading —
  // only an actual input report may populate battery.
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.open();
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
});

test("an unsolicited discharging input report (0x5f) is cached and reported as 95% Discharging", async () => {
  // Captured on hardware 2026-09-08: 09 5f 10 04 00 0f 0f 10 (node-hid).
  // fireInputReport's bytes exclude the report id, matching the WebHID
  // convention onInputReport expects: byte0 = 0x5f, byte1 = 0x10.
  const { device, fireInputReport } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.open();
  fireInputReport([0x5f, 0x10, 0x04, 0x00, 0x0f, 0x0f, 0x10]);
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, 95);
  assert.equal(status.batteryState, "Discharging");
});

test("an unsolicited charging input report (0xe1) is cached and reported as 97% Charging", async () => {
  // Captured on hardware 2026-09-08: 09 e1 10 04 00 0f 0f 10 (node-hid).
  const { device, fireInputReport } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.open();
  fireInputReport([0xe1, 0x10, 0x04, 0x00, 0x0f, 0x0f, 0x10]);
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, 97);
  assert.equal(status.batteryState, "Charging");
});

test("the charging state comes from the input report's own bit, not from wired-ness", async () => {
  // A wireless unit (0x522C) reporting a charging byte (e.g. on a charging
  // dock/cable that does not change the enumerated product id) must still
  // show Charging: the report is authoritative, not the product id.
  const { device, fireInputReport } = fakeDevice({ productId: INCOTT_PRODUCT_ID });
  const client = new IncottHidClient(device, fast);
  await client.open();
  fireInputReport([0xe1, 0x10, 0x04, 0x00, 0x0f, 0x0f, 0x10]);
  const status = await client.readStatus();
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.batteryPercent, 97);
});

test("close() removes the input-report listener; a report fired afterwards is not cached", async () => {
  const { device, fireInputReport } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.open();
  await client.close();
  fireInputReport([0x5f, 0x10, 0x04, 0x00, 0x0f, 0x0f, 0x10]);
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, null, "no listener was attached to receive this report");
});

test("REGRESSION: battery is not read from the 0x8e/0x01 feature-report reply, even when its byte 6 carries a plausible value", async () => {
  // The default fake device answers 0x8e/0x01 with byte 6 = 0x38 (56) — the
  // exact constant a full hardware charge cycle proved never changes (see
  // INCOTT_CMD_QUERY_BATTERY in src/incott/index.ts). readStatus() must not
  // query 0x8e for battery at all any more; battery stays null without an
  // input report, and 56 in particular must never appear.
  const { device } = fakeDevice({ state: { batteryByte: 0x38 } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.notEqual(status.batteryPercent, 56);
  assert.equal(status.batteryPercent, null);
  assert.equal(status.batteryState, "Unknown");
});

test("getFireKey reads the rapid-fire parameters", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.deepEqual(await client.getFireKey(), { times: 3, intervalMs: 10 });
});

test("setFireKey writes both parameters and verifies the read-back", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.deepEqual(await client.setFireKey(2, 50), { times: 2, intervalMs: 50 });
  assert.deepEqual([state.fireKeyTimes, state.fireKeyIntervalMs], [2, 50]);
});

test("setFireKey throws when the mouse does not take the value", async () => {
  const { device } = fakeDevice({ ignoreWrites: true });
  await assert.rejects(() => new IncottHidClient(device, fast).setFireKey(1, 20), /instead of 1 at 20 ms/);
});

test("setFireKey rejects out-of-range values without writing", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await assert.rejects(() => client.setFireKey(4, 10), RangeError);
  await assert.rejects(() => client.setFireKey(3, 300), RangeError);
  assert.deepEqual([state.fireKeyTimes, state.fireKeyIntervalMs], [3, 10]);
});

test("readStatus publishes dpiY for the active stage", async () => {
  // Stage 1 is active; give its axes different values.
  const { device } = fakeDevice({ state: { dpiStagesWireY: [7, 31, 31, 47, 63, 127] } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.dpi, 800, "X");
  assert.equal(status.dpiY, 1600, "Y");
  // The capability flag the shared UI gates the X/Y display on.
  assert.equal(status.supportsSeparateDpiAxes, true);
});

test("readStatus omits dpiY rather than mirroring X when the axis read fails", async () => {
  // Claiming the axes match would be a fabricated reading; the app falls
  // back to showing a single number instead.
  const { device } = fakeDevice({ silent: [0x82] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.dpiY, undefined);
  assert.equal(status.supportsSeparateDpiAxes, undefined, "no axes claimed without a reading");
});

test("setDpiStageAxis writes one axis and leaves the other alone", async () => {
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.setDpiStageAxis(2, 3200, "y");
  assert.equal(await client.readDpiStageAxis(2, "y"), 3200);
  assert.equal(await client.readDpiStageAxis(2, "x"), 1600, "X untouched");
  assert.equal(state.dpiStagesWire[2], 31, "the X table did not move");
});

test("setDpiStageAxis with 'both' moves the two axes together", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.setDpiStageAxis(4, 400, "both");
  assert.equal(await client.readDpiStageAxis(4, "x"), 400);
  assert.equal(await client.readDpiStageAxis(4, "y"), 400);
});

test("REGRESSION: reading X then Y on one stage does not return X twice", async () => {
  // The two requests carry an identical command and sub-command, so without
  // matching the axis echo at byte 8 the second read is satisfied by the
  // first's latched frame — the reading that made this driver conclude no
  // per-axis read existed.
  const { device } = fakeDevice({ state: { dpiStagesWireY: [7, 15, 63, 47, 63, 127] } });
  const client = new IncottHidClient(device, fast);
  assert.equal(await client.readDpiStageAxis(2, "x"), 1600);
  assert.equal(await client.readDpiStageAxis(2, "y"), 3200);
});

test("readStatus publishes the receiver LED mode and rapid-fire settings", async () => {
  const { device } = fakeDevice({ state: { receiverLed: 2, fireKeyTimes: 2, fireKeyIntervalMs: 40 } });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.incottReceiverLedMode, 2);
  assert.equal(status.incottFireKeyTimes, 2);
  assert.equal(status.incottFireKeyIntervalMs, 40);
});

test("readStatus omits the receiver LED over the cable, where it has no meaning", async () => {
  // There is no dongle in wired mode, so the control is absent rather than
  // present-but-inert. Rapid fire is unaffected: it lives in the mouse.
  const { device } = fakeDevice({ productId: INCOTT_PRODUCT_ID_WIRED });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.incottReceiverLedMode, undefined);
  assert.equal(status.incottFireKeyTimes, 3);
});

test("readStatus omits both rather than guessing when the queries fail", async () => {
  const { device } = fakeDevice({ silent: [0x85, 0x88] });
  const status = await new IncottHidClient(device, fast).readStatus();
  assert.equal(status.incottReceiverLedMode, undefined);
  assert.equal(status.incottFireKeyTimes, undefined);
  assert.equal(status.incottFireKeyIntervalMs, undefined);
});

test("setFireKey accepts 0 times, which is hold-to-fire rather than no fire", async () => {
  // Confirmed against the vendor software 2026-09-11: 0 makes the button
  // fire continuously while held and stop on release.
  const { device, state } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  assert.deepEqual(await client.setFireKey(0, 25), { times: 0, intervalMs: 25 });
  assert.equal(state.fireKeyTimes, 0);
});

test("setAxisDpi writes both axes of the active stage", async () => {
  const { device } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.setAxisDpi(800, 3200);
  // Stage 1 is the active one in the default fake state.
  assert.equal(await client.readDpiStageAxis(1, "x"), 800);
  assert.equal(await client.readDpiStageAxis(1, "y"), 3200);
});

test("setAxisDpi sends a single linked write when the axes match", async () => {
  const { device, sent } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.setAxisDpi(1600, 1600);
  const dpiWrites = sent.filter((payload) => payload[0] === 0x02);
  assert.equal(dpiWrites.length, 1, "one write, not one per axis");
  assert.equal(dpiWrites[0]![7], 0, "the 'both' axis flag");
});

test("uploadMacro interleaves ten headers with ten 32-byte output reports", async () => {
  // Exactly the shape captured from the vendor tool: an 8-byte feature
  // report announcing each chunk, then the chunk itself as an OUTPUT report
  // on the same id.
  const { device, sent, outputs } = fakeDevice();
  const client = new IncottHidClient(device, fast);
  await client.uploadMacro({
    bufferId: 3,
    loop: "untilAnyKey",
    cycles: 1,
    uid: 0x8fba0e90,
    steps: [{ key: 0x0f, press: true, delayMs: 124 }, { key: 0x0f, press: false, delayMs: 1510 }],
  });

  const headers = sent.filter((payload) => payload[0] === 0x07);
  assert.equal(headers.length, 10);
  assert.equal(outputs.length, 10);
  assert.ok(outputs.every((report) => report.bytes.length === 32), "every chunk is 32 bytes");
  assert.ok(outputs.every((report) => report.reportId === 0x09), "same report id as the feature path");
  headers.forEach((header, index) => {
    assert.deepEqual([...header.slice(0, 5)], [0x07, 0x0a, index, 0x20, 0x03]);
  });
  // The chunks rejoin into the buffer the encoder produced.
  const rejoined = outputs.flatMap((report) => [...report.bytes]);
  assert.equal(rejoined.length, 320);
  assert.deepEqual(rejoined.slice(0, 8), [0x03, 0x01, 0x01, 0x00, 0x01, 0x0f, 0x7c, 0x00]);
});

test("uploadMacro fails clearly on a transport with no output-report support", async () => {
  const { device } = fakeDevice();
  delete (device as unknown as { sendReport?: unknown }).sendReport;
  const client = new IncottHidClient(device, fast);
  await assert.rejects(
    () => client.uploadMacro({ bufferId: 0, loop: "cycle", cycles: 1, uid: 0, steps: [] }),
    /cannot send output reports/,
  );
});
