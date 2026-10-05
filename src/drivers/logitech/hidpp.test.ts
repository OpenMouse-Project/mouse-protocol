import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_INDEX_DIRECT,
  DEVICE_INDEX_RECEIVER,
  decodeBatteryLevelState,
  decodeReportRateBitmap,
  decodeUnifiedBatteryState,
  hidppDeviceIndexCandidates,
  hidpp10ErrorMessage,
  hidppErrorForRequest,
  hidppErrorMessage,
  isDirectConnection,
  isDirectConnectProduct,
  OnboardOnlyError,
  withSoftwareId,
} from "@openmouse/protocol/logitech";
import {
  LogitechHidppClient,
  connectionDetailFor,
  hasLiftOffControl,
  isPowerOnlyModeStatus,
  isWiredHidppConnection,
  supportsLiveLiftOffControl,
} from "./hidpp.ts";
import { factoryDirectoryForFormat, factoryProfileForFormat } from "./onboard-profiles.ts";

const G402 = 0xc07e;
const G403_HERO = 0xc08f;
const G703 = 0xc087;
const G502 = 0xc07d;
const G502_X_PLUS = 0xc095;
const G502_X_LIGHTSPEED = 0xc098;
const G502_X = 0xc099;
const LIGHTSPEED_RECEIVER = 0xc54d;
const SUPERSTRIKE_USB = 0xc0a8;

test("HID++ requests use a nonzero software ID", () => {
  assert.equal(withSoftwareId(0x00), 0x05);
  assert.equal(withSoftwareId(0x10), 0x15);
  assert.equal(withSoftwareId(0x20), 0x25);
});

test("HID++ software ID replaces an existing low nibble", () => {
  assert.equal(withSoftwareId(0x1e), 0x15);
});

test("runtime probing alone classifies direct and receiver connections", () => {
  assert.equal(isDirectConnection(DEVICE_INDEX_DIRECT), true);
  assert.equal(isDirectConnection(DEVICE_INDEX_RECEIVER), false);
  assert.equal(isDirectConnection(null), false);
});

test("the G502 family direct USB interfaces are recognized", () => {
  assert.equal(isDirectConnectProduct(G502), true);
  assert.equal(isDirectConnectProduct(G502_X_PLUS), true);
  assert.equal(isDirectConnectProduct(G502_X_LIGHTSPEED), true);
  assert.equal(isDirectConnectProduct(G502_X), true);
  assert.equal(isDirectConnectProduct(LIGHTSPEED_RECEIVER), false);
});

test("the G703 USB cable interface is recognized as direct-connect", () => {
  assert.equal(isDirectConnectProduct(G703), true);
  assert.equal(isDirectConnectProduct(G403_HERO), true);
  assert.equal(isWiredHidppConnection(G703, { USB: "C087" }, false), true);
});

test("extended DPI does not imply lift-off or mode-status controls", () => {
  assert.equal(supportsLiveLiftOffControl(false, null), false, "0 means no LOD control");
  assert.equal(supportsLiveLiftOffControl(true, "Medium"), false, "legacy DPI has no LOD field");
  assert.equal(supportsLiveLiftOffControl(false, "Low"), true);
});

test("the active transport comes from HID++ identity instead of a product exception", () => {
  const transports = { USB: "C0A8", Wireless: "40BD" };
  assert.equal(isWiredHidppConnection(0xc0a8, transports, false), true);
  assert.equal(isWiredHidppConnection(0x40bd, transports, false), false);
  assert.equal(isWiredHidppConnection(0xc54d, transports, false), false, "receiver PID is not the mouse's USB transport");
  assert.equal(isWiredHidppConnection(0xc07e, {}, true), true, "old direct devices use the probed-index fallback");
});

test("the PRO X 2 Superstrike's own Lightspeed receiver (0x40bd) is a known receiver", () => {
  // Confirmed from a user diagnostic: transportIds {Wireless: "40BD", USB: "C0A8"}.
  // Without this it was misclassified as a direct connection (receiverAttached
  // false), which picks the wrong device-index candidate set in resolveDeviceIndex.
  assert.equal(LogitechHidppClient.isKnownReceiver({ vendorId: 0x046d, productId: 0x40bd } as HIDDevice), true);
  assert.equal(LogitechHidppClient.isKnownReceiver({ vendorId: 0x046d, productId: SUPERSTRIKE_USB } as HIDDevice), true);
});

test("the receiver seen next to a PRO X 3 Superstrike (0xc54f) is a known receiver", () => {
  // Unknown, it was probed as a direct connection: that endpoint answers
  // HID++ with no sensor behind it, so the driver reported "USB Receiver is
  // not a mouse" instead of looking through the pairing slots for the mouse.
  assert.equal(LogitechHidppClient.isKnownReceiver({ vendorId: 0x046d, productId: 0xc54f } as HIDDevice), true);
});

test("receiver probing covers every pairing slot before the direct index", () => {
  // G HUB merging a keyboard onto the receiver can move the mouse off slot
  // 0x01, so discovery probes all six slots before the direct index.
  assert.deepEqual(hidppDeviceIndexCandidates(true), [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xff]);
});

test("direct-connect probing tries the device itself before any receiver slot", () => {
  assert.deepEqual(hidppDeviceIndexCandidates(false), [0xff, 0x01]);
});

test("the legacy report-rate bitmap decodes the G402's advertised rates", () => {
  // 0x8b = bits 0, 1, 3 and 7 => 1, 2, 4 and 8 ms.
  assert.deepEqual(decodeReportRateBitmap(0x8b), [125, 250, 500, 1000]);
});

test("report-rate bitmap bits map to (bit + 1) ms, not 1 << (interval - 1)", () => {
  assert.deepEqual(decodeReportRateBitmap(0x01), [1000]);
  assert.deepEqual(decodeReportRateBitmap(0x02), [500]);
  assert.deepEqual(decodeReportRateBitmap(0x08), [250]);
  assert.deepEqual(decodeReportRateBitmap(0x80), [125]);
  assert.deepEqual(decodeReportRateBitmap(0x00), []);
});

test("HID++ error responses are reported with their documented reason", () => {
  // The code returned when 0x8060's setter is asked to change the rate live.
  assert.match(hidppErrorMessage(0x02), /invalid argument/);
  assert.match(hidppErrorMessage(0x09), /unsupported/);
});

test("HID++ 1.0 error 0x0a is request unavailable", () => {
  assert.match(hidpp10ErrorMessage(0x0a), /HID\+\+ 1\.0: request unavailable/);
  assert.match(hidppErrorMessage(0x0a), /HID\+\+ 2\.0 error 0x0a/);
});

test("error frames are decoded by protocol and matched to their request", () => {
  const hidpp10 = new Uint8Array([0xff, 0x8f, 0x0d, withSoftwareId(0x10), 0x0a]);
  const hidpp20 = new Uint8Array([0x01, 0xff, 0x0d, withSoftwareId(0x10), 0x09]);
  assert.match(hidppErrorForRequest(hidpp10, 0x0d, 0x10) ?? "", /HID\+\+ 1\.0: request unavailable/);
  assert.match(hidppErrorForRequest(hidpp20, 0x0d, 0x10) ?? "", /unsupported/);
  assert.equal(hidppErrorForRequest(hidpp10, 0x0e, 0x10), null, "another request's error must be ignored");
});

test("an unrecognised HID++ error still reports its raw code", () => {
  assert.match(hidppErrorMessage(0x7f), /0x7f/);
});

test("the two battery features use different charging enums", () => {
  // 0x1004 UNIFIED_BATTERY.
  assert.equal(decodeUnifiedBatteryState(0x00), "Discharging");
  assert.equal(decodeUnifiedBatteryState(0x01), "Charging");
  assert.equal(decodeUnifiedBatteryState(0x02), "Charging slowly");
  assert.equal(decodeUnifiedBatteryState(0x03), "Full");
  // A charging fault is not any kind of charging.
  assert.equal(decodeUnifiedBatteryState(0x04), "Unknown");

  // 0x1000 BATTERY_LEVEL_STATUS numbers the same states differently.
  assert.equal(decodeBatteryLevelState(0x00), "Discharging");
  assert.equal(decodeBatteryLevelState(0x01), "Charging");
  assert.equal(decodeBatteryLevelState(0x02), "Almost full");
  assert.equal(decodeBatteryLevelState(0x03), "Full");
  assert.equal(decodeBatteryLevelState(0x04), "Charging slowly");
  // 5 invalid battery, 6 thermal error, 7 other charging error.
  for (const code of [0x05, 0x06, 0x07]) {
    assert.equal(decodeBatteryLevelState(code), "Unknown", `status ${code}`);
  }

  // The point of keeping them apart: 2 and 4 mean opposite things.
  assert.notEqual(decodeUnifiedBatteryState(0x02), decodeBatteryLevelState(0x02));
  assert.notEqual(decodeUnifiedBatteryState(0x04), decodeBatteryLevelState(0x04));
});

test("an onboard-only mouse is told how to get itself supported", () => {
  const known = new OnboardOnlyError(6);
  assert.match(known.message, /profile format 6/);
  assert.match(known.message, /Copy verification data/);
  // Never claim a format number we did not read.
  const unknown = new OnboardOnlyError(null);
  assert.doesNotMatch(unknown.message, /format (\d|null)/);
  assert.match(unknown.message, /Copy verification data/);
});
test("the G309's mode status is power-only and exposes no surface or LightForce controls", () => {
  // Model id captured from hardware: 0x8090 V2 with only the power-mode half.
  assert.equal(isPowerOnlyModeStatus("B03C40B10000"), true);
  // The G305 reports the same reserved status1 byte.
  assert.equal(isPowerOnlyModeStatus("407400000000"), true);
  // Every other model keeps the status1 fields, and unknown/absent ids must
  // not be silently downgraded.
  assert.equal(isPowerOnlyModeStatus("B03C40B10001"), false);
  assert.equal(isPowerOnlyModeStatus(""), false);
  assert.equal(isPowerOnlyModeStatus(null), false);
  assert.equal(isPowerOnlyModeStatus(undefined), false);
});

test("a sensor without lift-off control advertises no lift-off levels", () => {
  // 0x2201 legacy DPI carries no lod byte at all.
  assert.equal(hasLiftOffControl(true, null), false);
  // 0x2202 byte 0 is the "no lift-off control" value, as on the G309.
  assert.equal(hasLiftOffControl(false, 0), false);
  assert.equal(hasLiftOffControl(false, null), false);
  // The levels 1-4 (Low/Medium/High/Extra high) are driveable.
  assert.equal(hasLiftOffControl(false, 1), true);
  assert.equal(hasLiftOffControl(false, 2), true);
});

// --- Device-index discovery against a scripted HID endpoint -----------------
// resolveDeviceIndex is exercised end to end against a fake device that answers
// each HID++ request, so the merged-receiver probing is pinned down by tests.

(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
  setTimeout,
  clearTimeout,
};

const successReply = (deviceIndex: number, featureIndex: number, functionId: number, data: number[] = []): Uint8Array =>
  new Uint8Array([deviceIndex, featureIndex, withSoftwareId(functionId), ...data]);

const hidpp10ErrorReply = (deviceIndex: number, featureIndex: number, functionId: number, code: number): Uint8Array =>
  new Uint8Array([deviceIndex, 0x8f, featureIndex, withSoftwareId(functionId), code, 0]);

/**
 * Replies the way a real receiver does: an answering slot carries either a
 * mouse (firmware plus a DPI feature) or a keyboard (firmware, no DPI feature),
 * an empty slot answers with HID++ 1.0 "unknown device", and the direct index
 * answers with HID++ 1.0 "invalid command" — all exactly as captured from a
 * G HUB-merged G502 X PLUS receiver.
 */
function hidppResponder(roles: Record<number, "mouse" | "keyboard">) {
  return (request: Uint8Array): Uint8Array | null => {
    const deviceIndex = request[0];
    const featureId = (request[3] << 8) | request[4];
    const role = roles[deviceIndex];
    if (role === undefined) {
      return hidpp10ErrorReply(deviceIndex, request[1], 0x00, deviceIndex === 0xff ? 0x01 : 0x08);
    }
    if (request[1] === 0x00 && featureId === 0x0003) return successReply(deviceIndex, 0x00, 0x00, [0x01]);
    if (featureId === 0x2202 || featureId === 0x2201) {
      return successReply(deviceIndex, 0x00, 0x00, [role === "mouse" ? 0x01 : 0x00]);
    }
    return successReply(deviceIndex, 0x00, 0x00, [0x01]);
  };
}

const fakeCollection = (usagePage: number, usage: number): HIDCollectionInfo =>
  ({ usagePage, usage, children: [] }) as unknown as HIDCollectionInfo;

/** What a receiver or wired vendor interface exposes: HID++ short and long. */
const USB_HIDPP_COLLECTIONS = [fakeCollection(0xff00, 0x0001), fakeCollection(0xff00, 0x0002)];

/** What a Bluetooth-paired mouse exposes instead: one vendor collection, no 0xFF00. */
const BLUETOOTH_HIDPP_COLLECTIONS = [fakeCollection(0xff43, 0x0202)];

class FakeHidDevice {
  readonly productId: number;
  readonly productName: string;
  // The driver reads these to tell a Bluetooth endpoint from a USB one, so a
  // double without them silently answers "not Bluetooth" at best and throws at
  // worst.
  readonly collections: HIDCollectionInfo[];
  opened = false;
  readonly probed: Array<{ reportId: number; data: Uint8Array }> = [];
  private listeners = new Map<string, (event: unknown) => void>();
  onRequest: (request: Uint8Array) => Uint8Array | null = () => null;

  constructor(
    productId: number,
    productName = "USB Receiver",
    collections: HIDCollectionInfo[] = USB_HIDPP_COLLECTIONS,
  ) {
    this.productId = productId;
    this.productName = productName;
    this.collections = collections;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {}

  /** Report ids this collection declares; sendReport rejects any other, like WebHID does. */
  reportIds: number[] | null = null;

  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    if (this.reportIds && !this.reportIds.includes(reportId)) {
      throw new Error("Failed to write the report.");
    }
    const request = data.slice();
    this.probed.push({ reportId, data: request });
    const reply = this.onRequest(request);
    if (reply) {
      queueMicrotask(() => {
        this.listeners.get("inputreport")?.({
          reportId,
          data: new DataView(reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength)),
        });
      });
    }
  }
}

function harness(
  productId: number,
  roles: Record<number, "mouse" | "keyboard">,
  collections?: HIDCollectionInfo[],
): {
  client: LogitechHidppClient;
  device: FakeHidDevice;
} {
  const device = new FakeHidDevice(productId, "USB Receiver", collections);
  device.onRequest = hidppResponder(roles);
  return { client: new LogitechHidppClient(device as unknown as HIDDevice), device };
}

async function resolveIndex(client: LogitechHidppClient): Promise<number | null> {
  const driver = client as unknown as {
    open(): Promise<void>;
    resolveDeviceIndex(): Promise<void>;
    readonly resolvedDeviceIndex: number | null;
  };
  await driver.open();
  await driver.resolveDeviceIndex();
  return driver.resolvedDeviceIndex;
}

/**
 * Simulates `readStatus()`'s own retry: clear the already-resolved (and, by
 * the time a real caller does this, already proven sensorless) index and
 * resolve again excluding it — same as `readStatus()` does when its
 * post-resolution DPI check comes back empty.
 */
async function resolveIndexExcluding(
  client: LogitechHidppClient,
  excluded: ReadonlySet<number>,
): Promise<number | null> {
  const driver = client as unknown as {
    open(): Promise<void>;
    resolveDeviceIndex(excluded?: ReadonlySet<number>, priorAnsweredWithoutSensor?: boolean): Promise<void>;
    resolvedDeviceIndex: number | null;
  };
  await driver.open();
  driver.resolvedDeviceIndex = null;
  // Mirrors readStatus()'s own call: excluding an index only ever happens
  // because that index already answered-without-a-sensor.
  await driver.resolveDeviceIndex(excluded, excluded.size > 0);
  return driver.resolvedDeviceIndex;
}

test("a Unifying receiver's mouse is found past a keyboard paired first", async () => {
  // Unknown receivers only try 0xFF then 0x01, which latched onto the keyboard.
  const { client } = harness(0xc52b, { 0x01: "keyboard", 0x03: "mouse" });
  assert.equal(await resolveIndex(client), 0x03);
});

test("a merged receiver's mouse is found past the empty first slot", async () => {
  // The G502 X PLUS moves off slot 0x01 once G HUB merges the keyboard in.
  const { client, device } = harness(0xc547, { 0x02: "mouse" });
  assert.equal(await resolveIndex(client), 0x02);
  // Only the empty first slot and the mouse's own slot are ever probed.
  assert.deepEqual(
    device.probed
      .filter(({ data }) => data[1] === 0x00 && ((data[3] << 8) | data[4]) === 0x0003)
      .map(({ data }) => data[0]),
    [0x01, 0x02],
  );
});

test("a keyboard on slot 0x01 does not shadow the mouse on a merged receiver", async () => {
  const { client } = harness(0xc547, { 0x01: "keyboard", 0x02: "mouse" });
  assert.equal(await resolveIndex(client), 0x02);
});

test("a mouse still on the first receiver slot resolves there", async () => {
  const { client } = harness(0xc547, { 0x01: "mouse" });
  assert.equal(await resolveIndex(client), 0x01);
});

test("a receiver with nothing paired is reported as no answer", async () => {
  const { client } = harness(0xc547, {});
  await assert.rejects(resolveIndex(client), /did not answer on any HID\+\+ device index/);
});

test("a receiver holding only a keyboard is reported as not a mouse", async () => {
  const { client } = harness(0xc547, { 0x01: "keyboard" });
  const error = await resolveIndex(client).catch((reason) => reason);
  assert.equal((error as Error).name, "NotAMouseError");
  assert.match((error as Error).message, /not a mouse/);
});

test("a direct-connect mouse is latched on its own index without a sensor probe", async () => {
  const { client, device } = harness(G402, { 0xff: "mouse" });
  assert.equal(await resolveIndex(client), 0xff);
  assert.equal(device.probed.some(({ data }) => data[1] === 0x00 && ((data[3] << 8) | data[4]) === 0x2202), false);
});

test("a direct-connect product falls back to the receiver index when its own index has no sensor", async () => {
  // Confirmed on real hardware (a PRO X Superlight): DEVICE_INDEX_DIRECT can
  // answer HID++2.0 as a genuine admin/pass-through endpoint with no sensor
  // behind it, while DEVICE_INDEX_RECEIVER — the very next candidate — is
  // the mouse. `readStatus()` discovers this after the fact and re-resolves
  // excluding the sensorless index; this simulates that second call.
  const { client } = harness(G402, { 0xff: "keyboard", 0x01: "mouse" });
  assert.equal(await resolveIndex(client), 0xff, "the fast path still trusts the first answer with no probe");
  assert.equal(
    await resolveIndexExcluding(client, new Set([0xff])),
    0x01,
    "excluding the sensorless index finds the mouse on the next candidate",
  );
});

test("a direct-connect product with no sensor anywhere is reported as not a mouse", async () => {
  const { client } = harness(G402, { 0xff: "keyboard" });
  assert.equal(await resolveIndex(client), 0xff, "the fast path still trusts the first answer with no probe");
  const error = await resolveIndexExcluding(client, new Set([0xff])).catch((reason) => reason);
  assert.equal((error as Error).name, "NotAMouseError");
});

test("a long-only receiver collection is addressed on long reports", async () => {
  // Chrome on some platforms hands out one HIDDevice per top-level collection,
  // so a Lightspeed receiver can arrive as its usage-2 (report 0x11) half alone.
  // Ticket 0143: a PRO X Superlight receiver came back "not a mouse" because
  // every short probe was rejected by the host and counted as an answer.
  const { client, device } = harness(0xc539, { 0x01: "mouse" }, [fakeCollection(0xff00, 0x0002)]);
  device.reportIds = [0x11];
  assert.equal(await resolveIndex(client), 0x01);
  assert.ok(device.probed.every(({ reportId }) => reportId === 0x11));
});

test("a rejected sendReport is a transport error, not a sensorless answer", async () => {
  const { client, device } = harness(0xc539, { 0x01: "mouse" });
  device.reportIds = [];
  const error = await resolveIndex(client).catch((reason) => reason);
  assert.notEqual((error as Error).name, "NotAMouseError");
  assert.match((error as Error).message, /Failed to write the report/);
});

test("a Bluetooth mouse is addressed on long reports only", async () => {
  // BLE declares report 0x11 and nothing else, so the short-report path that
  // Lightspeed and wired mice use would be rejected by the device outright.
  const { client, device } = harness(0xb042, { 0xff: "mouse" }, BLUETOOTH_HIDPP_COLLECTIONS);
  assert.equal(await resolveIndex(client), 0xff);
  assert.ok(device.probed.length > 0, "the index probe must have sent something");
  assert.deepEqual(
    [...new Set(device.probed.map(({ reportId }) => reportId))],
    [0x11],
    "every request over Bluetooth must go out as a long report",
  );
});

test("a receiver-attached mouse keeps using short reports", async () => {
  const { client, device } = harness(0xc547, { 0x01: "mouse" });
  assert.equal(await resolveIndex(client), 0x01);
  assert.ok(
    device.probed.some(({ reportId }) => reportId === 0x10),
    "the 0xFF00 short path is unchanged for receivers",
  );
});

/**
 * A mouse whose HITS feature (0x1B0C) holds one [actuation, rapid trigger,
 * haptics] wire triple per button. The byte values are the ones captured from
 * a PRO X 3 Superstrike: 0x14 / 0x08 / 0x0c, i.e. actuation 5, rapid trigger 2
 * (off) and haptics 3, with the rapid-trigger on/off switch in bit 0.
 */
function analogButtonsMouse(): { client: LogitechHidppClient; wire: number[][] } {
  const FEATURE_INDEX = 0x16;
  const wire = [[0x14, 0x08, 0x0c], [0x14, 0x08, 0x0c]];
  const { client, device } = harness(0xc54d, { 1: "mouse" });
  const base = hidppResponder({ 1: "mouse" });
  device.onRequest = (request) => {
    const deviceIndex = request[0];
    const featureId = (request[3] << 8) | request[4];
    if (request[1] === 0x00 && featureId === 0x1b0c) return successReply(deviceIndex, 0x00, 0x00, [FEATURE_INDEX, 0x00, 0x00]);
    if (request[1] !== FEATURE_INDEX) return base(request);
    const fn = request[2] >> 4;
    const button = request[3];
    if (fn === 0) return successReply(deviceIndex, FEATURE_INDEX, 0x00, [0x00, 0x03, 0x28, 0x14, 0x14, 0x01]);
    if (fn === 2) return successReply(deviceIndex, FEATURE_INDEX, 0x20, [button, ...wire[button], 0x00]);
    if (fn === 1) {
      wire[button] = [request[4], request[5], request[6]];
      return successReply(deviceIndex, FEATURE_INDEX, 0x10, [button, request[4], request[5], request[6], 0x00]);
    }
    if (fn === 3) return successReply(deviceIndex, FEATURE_INDEX, 0x30, [request[3], request[4], request[5]]);
    return null;
  };
  return { client, wire };
}

test("HITS tuning reads rapid trigger's on/off state from bit 0, apart from its sensitivity", async () => {
  const { client, wire } = analogButtonsMouse();
  await resolveIndex(client);
  const read = () => (client as unknown as {
    readAnalogButtonTuning(index: number): Promise<{ buttons: Array<Record<string, unknown>> }>;
  }).readAnalogButtonTuning(0x16);

  assert.deepEqual((await read()).buttons[0], { actuation: 5, rapidTrigger: 2, haptics: 3, rapidTriggerEnabled: false });
  wire[0][1] = 0x09; // the same sensitivity with the switch on, as captured
  assert.deepEqual((await read()).buttons[0], { actuation: 5, rapidTrigger: 2, haptics: 3, rapidTriggerEnabled: true });
  wire[0][1] = 0x0d; // sensitivity 3, switch on
  assert.deepEqual((await read()).buttons[0], { actuation: 5, rapidTrigger: 3, haptics: 3, rapidTriggerEnabled: true });
});

test("HITS tuning turns rapid trigger on and off without touching sensitivity or the other button", async () => {
  const { client, wire } = analogButtonsMouse();
  await resolveIndex(client);

  await client.setAnalogButtonTuning(0, { actuation: 5, rapidTrigger: 2, haptics: 3, rapidTriggerEnabled: true });
  assert.equal(wire[0][1], 0x09);
  assert.equal(wire[1][1], 0x08, "the other button is untouched");

  await client.setAnalogButtonTuning(0, { actuation: 5, rapidTrigger: 2, haptics: 3, rapidTriggerEnabled: false });
  assert.equal(wire[0][1], 0x08);
});

test("a HITS write that does not name the rapid trigger state keeps the current one", async () => {
  const { client, wire } = analogButtonsMouse();
  await resolveIndex(client);
  wire[0][1] = 0x09; // on

  await client.setAnalogButtonTuning(0, { actuation: 5, rapidTrigger: 3, haptics: 3 });
  assert.equal(wire[0][1], 0x0d, "sensitivity changed, switch still on");
  wire[0][1] = 0x0c; // off, sensitivity 3
  await client.setAnalogButtonTuning(0, { actuation: 5, rapidTrigger: 4, haptics: 3 });
  assert.equal(wire[0][1], 0x10, "sensitivity changed, switch still off");
});

test("connection wording follows the product id, not the 0xFF43 usage page alone", () => {
  const base = { wired: false, directConnect: false, bluetoothPage: false, knownUsbProduct: false, boltReceiver: false };

  // PRO X 3 Superstrike on its cable (PID 0xC0A9): a USB mouse whose HID++
  // interface is on the Bluetooth page. It was labelled "Bluetooth".
  assert.equal(connectionDetailFor({ ...base, wired: true, bluetoothPage: true, knownUsbProduct: true }), "Wired USB");
  // The same mouse on its Lightspeed receiver (PID 0xC54F), also on 0xFF43: no
  // special wording, so the shell shows its usual 2.4 GHz text.
  assert.equal(connectionDetailFor({ ...base, bluetoothPage: true, knownUsbProduct: true }), undefined);
  // A real Bluetooth mouse: the page and a product id that is not a USB one.
  assert.equal(connectionDetailFor({ ...base, bluetoothPage: true }), "Bluetooth");
  // Everything that was already right stays right.
  assert.equal(connectionDetailFor({ ...base, directConnect: true }), "Wired USB");
  assert.equal(connectionDetailFor({ ...base, boltReceiver: true }), "Logi Bolt");
  assert.equal(connectionDetailFor(base), undefined);
});

test("persisting HITS validates against the mouse's limits, then hands both buttons to one profile write", async () => {
  const { client } = analogButtonsMouse();
  await resolveIndex(client);
  const writes: unknown[] = [];
  (client as unknown as { writeActiveProfile(values: unknown): Promise<void> }).writeActiveProfile = async (values) => {
    writes.push(values);
  };

  // Outside the limits (actuation 1-10): refused before any profile write.
  await assert.rejects(
    () => client.persistAnalogButtonTuning([{ button: 0, actuation: 11, rapidTrigger: 2, haptics: 3 }]),
    /outside the mouse's supported range/,
  );
  assert.equal(writes.length, 0);

  const both = { actuation: 8, rapidTrigger: 2, haptics: 2, rapidTriggerEnabled: false };
  await client.persistAnalogButtonTuning([{ button: 0, ...both }, { button: 1, ...both }]);
  assert.deepEqual(writes, [{ analogButtons: [{ button: 0, ...both }, { button: 1, ...both }] }]);
});

test("HITS press depth events reach listeners and stop after unsubscribing", async () => {
  const { client } = analogButtonsMouse();
  await resolveIndex(client);
  const internals = client as unknown as {
    getFeature(id: number): Promise<unknown>;
    deviceIndex: number;
    onInputReport(event: { reportId: number; data: DataView }): void;
  };
  await internals.getFeature(0x1b0c);
  const push = (feature: number, fn: number, left: number, right = 0) => {
    const report = new Uint8Array([internals.deviceIndex, feature, fn, left, right, 0, 0]);
    internals.onInputReport({ reportId: 0x11, data: new DataView(report.buffer) });
  };
  const seen: number[][] = [];
  const stop = client.onAnalogPress((left, right) => seen.push([left, right]));
  push(0x16, 0x00, 4);
  push(0x16, 0x00, 0, 10);
  push(0x16, 0x3b, 1); // a different event on the same feature
  push(0x05, 0x00, 7); // another feature
  stop();
  push(0x16, 0x00, 2);
  assert.deepEqual(seen, [[4, 0], [0, 10]]);
});

test("HITS press stream start replays G HUB's captured arm sequence, stop clears the enable byte", async () => {
  const { client } = analogButtonsMouse();
  await resolveIndex(client);
  const internals = client as unknown as {
    device: { probed: Array<{ data: Uint8Array }> };
  };
  await client.startAnalogPressStream();
  await client.stopAnalogPressStream();
  const short = internals.device.probed.filter((p) => p.data.length === 6 && p.data[1] === 0x16 && p.data[2] >> 4 === 3);
  assert.deepEqual(Array.from(short[0].data.slice(3, 6)), [0x01, 0x3c, 0x00]);
  assert.deepEqual(Array.from(short[1].data.slice(3, 6)), [0x00, 0x00, 0x00]);
});

/**
 * A format 8 mouse whose onboard memory is a map of 255-byte sectors, driven by
 * the same HID++ 0x8100 functions the driver uses: info, mode, current profile,
 * memory read, and the address/data/end write sequence. Starts blank (every
 * sector erased) like a mouse G HUB has never linked.
 */
function onboardMemoryMouse(options: { ignoreWrites?: boolean; profileCount?: number; preload?: Record<number, Uint8Array> } = {}) {
  const FEATURE_INDEX = 0x21;
  const memory = new Map<number, Uint8Array>(Object.entries(options.preload ?? {}).map(([sector, bytes]) => [Number(sector), bytes.slice()]));
  const state = { mode: 0x01, current: 0x0001, writes: 0 };
  let pending: { sector: number; length: number; bytes: number[] } | null = null;
  const { client, device } = harness(0xc54d, { 1: "mouse" });
  const base = hidppResponder({ 1: "mouse" });
  const sectorBytes = (sector: number) => memory.get(sector) ?? new Uint8Array(255).fill(0xff);
  device.onRequest = (request) => {
    const deviceIndex = request[0];
    const featureId = (request[3] << 8) | request[4];
    if (request[1] === 0x00 && featureId === 0x8100) return successReply(deviceIndex, 0x00, 0x00, [FEATURE_INDEX, 0x00, 0x00]);
    if (request[1] !== FEATURE_INDEX) return base(request);
    const fn = request[2] >> 4;
    const params = Array.from(request.slice(3));
    if (fn === 0) return successReply(deviceIndex, FEATURE_INDEX, 0x00, [0x01, 0x08, 0x00, options.profileCount ?? 0x05, 0x00, 0x06, 0x05, 0x00, 0xff]);
    if (fn === 1) { state.mode = params[0]; return successReply(deviceIndex, FEATURE_INDEX, 0x10); }
    if (fn === 2) return successReply(deviceIndex, FEATURE_INDEX, 0x20, [state.mode]);
    if (fn === 3) { state.current = (params[0] << 8) | params[1]; return successReply(deviceIndex, FEATURE_INDEX, 0x30); }
    if (fn === 4) return successReply(deviceIndex, FEATURE_INDEX, 0x40, [state.current >> 8, state.current & 0xff]);
    if (fn === 5) {
      const sector = (params[0] << 8) | params[1];
      const offset = (params[2] << 8) | params[3];
      return successReply(deviceIndex, FEATURE_INDEX, 0x50, Array.from(sectorBytes(sector).slice(offset, offset + 16)));
    }
    if (fn === 6) {
      pending = { sector: (params[0] << 8) | params[1], length: (params[4] << 8) | params[5], bytes: [] };
      return successReply(deviceIndex, FEATURE_INDEX, 0x60);
    }
    if (fn === 7 && pending) { pending.bytes.push(...params.slice(0, 16)); return successReply(deviceIndex, FEATURE_INDEX, 0x70); }
    if (fn === 8 && pending) {
      if (!options.ignoreWrites) memory.set(pending.sector, Uint8Array.from(pending.bytes.slice(0, pending.length)));
      state.writes += 1;
      pending = null;
      return successReply(deviceIndex, FEATURE_INDEX, 0x80);
    }
    return null;
  };
  return { client, memory, state };
}

test("initialising a blank format 8 mouse writes the factory sectors, then the directory, then selects profile 1", async () => {
  const { client, memory, state } = onboardMemoryMouse();
  await resolveIndex(client);
  await client.initializeBlankOnboardProfiles();

  const factory = factoryProfileForFormat(8, 255);
  const directory = factoryDirectoryForFormat(8, 255);
  assert.ok(factory && directory);
  for (const sector of [1, 2, 3, 4, 5]) assert.deepEqual([...memory.get(sector)!], [...factory], `sector ${sector}`);
  assert.deepEqual([...memory.get(0)!], [...directory]);
  assert.equal(state.current, 0x0001);
  assert.equal(state.mode, 0x01, "left in onboard mode");
  assert.equal(state.writes, 6);
});

test("initialising refuses a mouse that already has profiles and writes nothing", async () => {
  const directory = factoryDirectoryForFormat(8, 255)!;
  const { client, state } = onboardMemoryMouse({ preload: { 0: directory } });
  await resolveIndex(client);
  await assert.rejects(client.initializeBlankOnboardProfiles(), /already has onboard profiles/);
  assert.equal(state.writes, 0);
  assert.equal(state.mode, 0x01);
});

test("initialising leaves the directory blank and the mouse in onboard mode when a write does not stick", async () => {
  const { client, memory, state } = onboardMemoryMouse({ ignoreWrites: true });
  await resolveIndex(client);
  await assert.rejects(client.initializeBlankOnboardProfiles(), /did not confirm/);
  assert.equal(memory.has(0), false, "directory never written");
  assert.equal(state.mode, 0x01, "not stranded in host mode");
});

test("initialising refuses a mouse that reports fewer profiles than the captured layout and writes nothing", async () => {
  const { client, state } = onboardMemoryMouse({ profileCount: 3 });
  await resolveIndex(client);
  await assert.rejects(client.initializeBlankOnboardProfiles(), /reports 3 profiles/);
  assert.equal(state.writes, 0);
  assert.equal(state.mode, 0x01);
});
