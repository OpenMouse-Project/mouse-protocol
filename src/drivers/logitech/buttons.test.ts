import assert from "node:assert/strict";
import test from "node:test";

import { LogitechHidppClient } from "./hidpp.ts";

(globalThis as unknown as { window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }).window = {
  setTimeout,
  clearTimeout,
};

const CONTROLS_INDEX = 0x0a;

/**
 * getControlIdInfo payloads captured from an MX Master 4 over a Logi Bolt
 * receiver: [cid(2), tid(2), flags, pos, group, gmask, additional].
 */
const CONTROL_TABLE = [
  [0x00, 0x50, 0x00, 0x38, 0x01, 0x00, 0x01, 0x00, 0x04], // Left click
  [0x00, 0x51, 0x00, 0x39, 0x01, 0x00, 0x01, 0x00, 0x04], // Right click
  [0x00, 0x52, 0x00, 0x3a, 0x31, 0x00, 0x02, 0x03, 0x05], // Middle click
  [0x00, 0x53, 0x00, 0x3c, 0x31, 0x00, 0x02, 0x03, 0x05], // Back
  [0x00, 0x56, 0x00, 0x3e, 0x31, 0x00, 0x02, 0x03, 0x05], // Forward
  [0x00, 0xc3, 0x00, 0x9c, 0x31, 0x00, 0x02, 0x03, 0x05], // Gesture button
  [0x00, 0xc4, 0x00, 0x9d, 0x31, 0x00, 0x02, 0x03, 0x05], // SmartShift button
  [0x01, 0xa0, 0x01, 0x09, 0x31, 0x00, 0x02, 0x03, 0x05], // Actions Ring
  [0x00, 0xd7, 0x00, 0xb4, 0xa0, 0x00, 0x03, 0x00, 0x03], // Virtual gesture button
];

interface ControlState { mappedTo: number; flags: number }

interface DeviceState {
  controls: Map<number, ControlState>;
  /** Requests to the controls feature, so a test can assert what was NOT sent. */
  calls: Array<{ featureIndex: number; functionId: number; payload: number[] }>;
  /** Every request of any kind, including the root-feature lookups. */
  allCalls: Array<{ featureIndex: number; functionId: number }>;
}

function initialState(overrides: Record<number, Partial<ControlState>> = {}): DeviceState {
  const controls = new Map<number, ControlState>();
  for (const row of CONTROL_TABLE) {
    const controlId = (row[0]! << 8) | row[1]!;
    controls.set(controlId, { mappedTo: controlId, flags: 0, ...overrides[controlId] });
  }
  return { controls, calls: [], allCalls: [] };
}

/**
 * A receiver exposing 0x1B04.
 *
 * Its write handler implements the protocol's two-bit flag semantics — a flag
 * changes only when its "valid" bit, one position higher, is set — rather than
 * applying whatever byte it is handed. A fake that applied the byte directly
 * would let a wrong flags value pass unnoticed, which is exactly how the
 * 0x2150 echo bug survived a green suite.
 *
 * The reply to a write deliberately carries no payload. Nothing here reads it:
 * every write is confirmed by re-reading the reporting.
 */
function controlsResponder(
  state: DeviceState,
  options: {
    present?: boolean; sticky?: boolean; resetsMappingOnClear?: boolean;
    truncatedInfoAt?: number; truncatedReportingFor?: number;
  } = {},
) {
  const present = options.present ?? true;
  const FEATURES: Record<number, number> = { 0x0003: 0x02, 0x2201: 0x14 };
  if (present) FEATURES[0x1b04] = CONTROLS_INDEX;

  return (request: Uint8Array): Uint8Array | null => {
    const deviceIndex = request[0]!;
    const featureIndex = request[1]!;
    const functionByte = request[2]!;
    const functionId = functionByte & 0xf0;
    const answer = (data: number[]): Uint8Array =>
      new Uint8Array([deviceIndex, featureIndex, functionByte, ...data]);

    state.allCalls.push({ featureIndex, functionId });

    if (deviceIndex !== 0x02) {
      return new Uint8Array([deviceIndex, 0x8f, featureIndex, functionByte, 0x08, 0]);
    }
    if (featureIndex === 0x00) {
      if (functionId === 0x00) {
        const featureId = (request[3]! << 8) | request[4]!;
        return answer([FEATURES[featureId] ?? 0x00, 0x00, 0x02]);
      }
      return answer([0x04, 0x05, request[5] ?? 0]);
    }

    if (featureIndex === CONTROLS_INDEX) {
      state.calls.push({ featureIndex, functionId, payload: [...request.slice(3)] });

      if (functionId === 0x00) return answer([CONTROL_TABLE.length]);

      if (functionId === 0x10) {
        const row = CONTROL_TABLE[request[3]!] ?? [];
        // Firmware that answers short: without group and mask there is no way
        // to know what the control accepts.
        return answer(request[3]! === options.truncatedInfoAt ? row.slice(0, 5) : row);
      }

      if (functionId === 0x20) {
        const controlId = (request[3]! << 8) | request[4]!;
        const control = state.controls.get(controlId);
        if (!control) return answer([]);
        // Short of the high flags byte, so the mapping field cannot be read.
        if (controlId === options.truncatedReportingFor) {
          return answer([request[3]!, request[4]!, 0x00, 0x00, 0x00]);
        }
        // [cid(2), flagsLow, remap(2), flagsHigh] — the remap target sits
        // between the two halves of the mapping field.
        return answer([
          request[3]!, request[4]!,
          control.flags & 0xff,
          control.mappedTo >> 8, control.mappedTo & 0xff,
          (control.flags >> 8) & 0xff,
        ]);
      }

      if (functionId === 0x30) {
        const controlId = (request[3]! << 8) | request[4]!;
        const written = request[5]!;
        const target = (request[6]! << 8) | request[7]!;
        const control = state.controls.get(controlId);
        if (control && !options.sticky) {
          // A flag changes only when its valid bit is set; the value bit one
          // position lower carries the new state.
          for (const flag of [0x01, 0x04]) {
            if ((written & (flag << 1)) !== 0) {
              control.flags = (written & flag) !== 0 ? control.flags | flag : control.flags & ~flag;
            }
          }
          // A target of zero leaves the existing mapping alone.
          if (target !== 0) control.mappedTo = target;
          // Firmware that treats a reporting write as a full reset, dropping
          // the remap along with the diversion it was asked to clear.
          else if (options.resetsMappingOnClear) control.mappedTo = controlId;
        }
        return answer([]);
      }
    }
    return answer([0x00]);
  };
}

class FakeHidDevice {
  readonly productId = 0xc548;
  readonly productName = "USB Receiver";
  readonly vendorId = 0x046d;
  readonly collections = [
    { usagePage: 0xff00, usage: 0x0001, children: [] },
    { usagePage: 0xff00, usage: 0x0002, children: [] },
  ];
  private listeners = new Map<string, (event: unknown) => void>();
  onRequest: (request: Uint8Array) => Uint8Array | null = () => null;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(): void {}

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    const answer = this.onRequest(data.slice());
    if (answer) {
      queueMicrotask(() => {
        this.listeners.get("inputreport")?.({
          reportId,
          data: new DataView(answer.buffer.slice(answer.byteOffset, answer.byteOffset + answer.byteLength)),
        });
      });
    }
  }
}

type ButtonClient = {
  open(): Promise<void>;
  resolveDeviceIndex(): Promise<void>;
  readButtons(): Promise<Array<{
    controlId: number; name: string; mappedTo: number; diverted: boolean;
    reprogrammable: boolean; virtual: boolean; remappableTo: number[];
  }>>;
  setButtonMapping(controlId: number, targetControlId: number): Promise<unknown>;
  clearButtonDiversion(): Promise<unknown>;
};

async function harness(
  overrides: Record<number, Partial<ControlState>> = {},
  options: {
    present?: boolean; sticky?: boolean; resetsMappingOnClear?: boolean;
    truncatedInfoAt?: number; truncatedReportingFor?: number;
  } = {},
) {
  const state = initialState(overrides);
  const device = new FakeHidDevice();
  device.onRequest = controlsResponder(state, options);
  const client = new LogitechHidppClient(device as unknown as HIDDevice) as unknown as ButtonClient;
  await client.open();
  await client.resolveDeviceIndex();
  // Discovery probes the device index across several slots; a test asking what
  // a method sent should not have to subtract that.
  state.calls.length = 0;
  state.allCalls.length = 0;
  return { client, state };
}

const writes = (state: DeviceState) => state.calls.filter((call) => call.functionId === 0x30);

test("every control is read back with its name, mapping and legal targets", async () => {
  const { client } = await harness();
  const controls = await client.readButtons();
  assert.equal(controls.length, CONTROL_TABLE.length);

  const gesture = controls.find((control) => control.controlId === 0x00c3)!;
  assert.equal(gesture.name, "Gesture button");
  assert.equal(gesture.reprogrammable, true);
  assert.equal(gesture.mappedTo, 0x00c3);
  assert.ok(gesture.remappableTo.includes(0x0052));
});

test("the key flags survive the reporting merge, so virtual is read from the right field", async () => {
  // Both control info and reporting carry a numeric field; the merge must keep
  // the key flags, or the virtual bit reads as clear on every control.
  const { client } = await harness();
  const controls = await client.readButtons();
  const virtual = controls.find((control) => control.controlId === 0x00d7)!;
  assert.equal(virtual.virtual, true, "the virtual gesture button lost its key flags in the merge");
  const physical = controls.find((control) => control.controlId === 0x00c3)!;
  assert.equal(physical.virtual, false);
});

test("the primary buttons come back with nothing to remap them to", async () => {
  const { client } = await harness();
  const controls = await client.readButtons();
  for (const controlId of [0x0050, 0x0051]) {
    const control = controls.find((candidate) => candidate.controlId === controlId)!;
    assert.equal(control.reprogrammable, false);
    assert.deepEqual(control.remappableTo, []);
  }
});

test("the control table is read once per connection, the reporting every time", async () => {
  // Two round-trips per control is the reason this is not on the refresh poll;
  // re-reading the immutable half would make it three.
  const { client, state } = await harness();
  await client.readButtons();
  const firstInfoReads = state.calls.filter((call) => call.functionId === 0x10).length;
  const firstReportingReads = state.calls.filter((call) => call.functionId === 0x20).length;
  assert.equal(firstInfoReads, CONTROL_TABLE.length);
  assert.equal(firstReportingReads, CONTROL_TABLE.length);

  await client.readButtons();
  assert.equal(
    state.calls.filter((call) => call.functionId === 0x10).length,
    firstInfoReads,
    "the control table was read again",
  );
  assert.equal(state.calls.filter((call) => call.functionId === 0x20).length, firstReportingReads * 2);
});

test("remapping a button changes what the device reports", async () => {
  const { client, state } = await harness();
  const controls = await client.setButtonMapping(0x00c3, 0x0052) as Array<{
    controlId: number; mappedTo: number;
  }>;
  assert.equal(state.controls.get(0x00c3)!.mappedTo, 0x0052);
  assert.equal(controls.find((control) => control.controlId === 0x00c3)!.mappedTo, 0x0052);
});

test("a remap leaves an existing diversion exactly as it was", async () => {
  // The write carries a zero flags byte, which marks no flag valid. A device
  // that took the byte at face value would read it as "not diverted".
  const { client, state } = await harness({ 0x00c3: { flags: 0x0001 } });
  await client.setButtonMapping(0x00c3, 0x0052);
  assert.equal(state.controls.get(0x00c3)!.flags, 0x0001, "the remap cleared the diversion");
});

test("an illegal target is refused before anything is written", async () => {
  const { client, state } = await harness();
  // Left click's group mask is zero, so the firmware offers no targets at all.
  await assert.rejects(() => client.setButtonMapping(0x0050, 0x0052), /cannot be remapped/);
  assert.equal(writes(state).length, 0, "a refused remap still reached the device");
});

test("a control the mouse does not have is refused before anything is written", async () => {
  const { client, state } = await harness();
  await assert.rejects(() => client.setButtonMapping(0x00e5, 0x0052), /not present on this mouse/);
  assert.equal(writes(state).length, 0);
});

test("a device that acknowledges a remap and ignores it is reported as a failure", async () => {
  // The read-back is only worth doing if it can still fail.
  const { client } = await harness({}, { sticky: true });
  await assert.rejects(() => client.setButtonMapping(0x00c3, 0x0052), /kept Gesture button pointing at/);
});

test("a diverted button is handed back to the hardware", async () => {
  const { client, state } = await harness({
    0x00c3: { flags: 0x0001 },
    0x0053: { flags: 0x0004 },
  });
  const controls = await client.clearButtonDiversion() as Array<{ diverted: boolean }>;
  assert.equal(state.controls.get(0x00c3)!.flags, 0);
  assert.equal(state.controls.get(0x0053)!.flags, 0, "persistent diversion was left in place");
  assert.ok(controls.every((control) => !control.diverted));
  assert.equal(writes(state).length, 2, "only the diverted controls should be written");
});

test("clearing diversion leaves a remapped button pointing where it was", async () => {
  const { client, state } = await harness({ 0x00c3: { flags: 0x0001, mappedTo: 0x0052 } });
  await client.clearButtonDiversion();
  assert.equal(state.controls.get(0x00c3)!.mappedTo, 0x0052, "the clear write moved the mapping");
});

test("a clear that silently drops a remap is reported, not returned as success", async () => {
  // Restoring a button must not cost the user what that button was set to.
  const { client } = await harness(
    { 0x00c3: { flags: 0x0001, mappedTo: 0x0052 } },
    { resetsMappingOnClear: true },
  );
  await assert.rejects(
    () => client.clearButtonDiversion(),
    /Restoring Gesture button unexpectedly changed what it does/,
  );
});

test("nothing is written when no button is diverted", async () => {
  const { client, state } = await harness();
  await client.clearButtonDiversion();
  assert.equal(writes(state).length, 0);
});

test("a button that stays diverted is reported rather than assumed cleared", async () => {
  const { client } = await harness({ 0x00c3: { flags: 0x0001 } }, { sticky: true });
  await assert.rejects(() => client.clearButtonDiversion(), /kept Gesture button diverted/);
});

test("a control the mouse will not describe is dropped, not half-decoded", async () => {
  // Its group mask is what says which targets are legal; guessing at one
  // offers the user a remap the firmware will refuse.
  const { client } = await harness({}, { truncatedInfoAt: 3 });
  const controls = await client.readButtons();
  assert.equal(controls.length, CONTROL_TABLE.length - 1);
  assert.ok(!controls.some((control) => control.controlId === 0x0053));
  assert.ok(controls.every((control) => typeof control.name === "string"));
});

test("a control whose reporting will not decode is left out of the list", async () => {
  // Reported with a default mapping it may not have, the card would offer to
  // "restore" a button to something it was never set to.
  const { client } = await harness({}, { truncatedReportingFor: 0x00c3 });
  const controls = await client.readButtons();
  assert.equal(controls.length, CONTROL_TABLE.length - 1);
  assert.ok(!controls.some((control) => control.controlId === 0x00c3));
});

test("a mouse without 0x1B04 is asked once and then left alone", async () => {
  const { client, state } = await harness({}, { present: false });
  assert.deepEqual(await client.readButtons(), []);
  // Only the root-feature lookup. Without the guard the client goes on to
  // read a control count from feature index 0, which is not that feature.
  assert.deepEqual(state.allCalls.map((call) => call.featureIndex), [0x00]);
  await assert.rejects(() => client.setButtonMapping(0x00c3, 0x0052), /does not expose reprogrammable controls/);
  await assert.rejects(() => client.clearButtonDiversion(), /does not expose reprogrammable controls/);
});
