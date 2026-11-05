import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeReceiverPairingReply,
  encodeReceiverPairingRequest,
  isPointingKind,
  readLogitechReceiverPairings,
  receiverPairingSubRegister,
  type LogitechDeviceKind,
} from "./receiver-pairing.ts";

const LIGHTSPEED = 0xc54d;
const BOLT = 0xc548;

function collection(usage: number): HIDCollectionInfo {
  return { usagePage: 0xff00, usage, inputReports: [], outputReports: [], featureReports: [], children: [] } as unknown as HIDCollectionInfo;
}

/** A pairing-info reply, without its report id, with `kindByte` at Solaar's offset. */
function pairingReply(productId: number, slot: number, kindByte: number): Uint8Array {
  const reply = new Uint8Array(19);
  reply.set([0xff, 0x83, 0xb5]);
  const pairInfo = reply.subarray(3);
  pairInfo[0] = receiverPairingSubRegister(productId, slot);
  pairInfo[productId === BOLT ? 1 : 7] = kindByte;
  return reply;
}

interface FakeReceiver {
  interfaces: HIDDevice[];
  sent: Uint8Array[];
  closed: HIDDevice[];
}

/**
 * A receiver whose short and long HID++ collections are separate interfaces,
 * as WebHID reports them on Windows: requests go out on the short one and
 * long replies come back on the long one.
 */
function fakeReceiver(
  productId: number,
  slots: Record<number, number | "busy" | "silent">,
  options: { silent?: boolean; hangSend?: boolean } = {},
): FakeReceiver {
  const sent: Uint8Array[] = [];
  const closed: HIDDevice[] = [];
  const listeners = new Map<HIDDevice, Set<(event: HIDInputReportEvent) => void>>();
  const deliver = (device: HIDDevice, reportId: number, data: Uint8Array) => {
    const event = { reportId, data: new DataView(data.buffer, data.byteOffset, data.byteLength), device } as unknown as HIDInputReportEvent;
    for (const listener of listeners.get(device) ?? []) listener(event);
  };
  const make = (usage: number): HIDDevice => {
    const device = {
      vendorId: 0x046d,
      productId,
      productName: "USB Receiver",
      collections: [collection(usage)],
      opened: false,
      async open() { device.opened = true; },
      async close() { device.opened = false; closed.push(device as unknown as HIDDevice); },
      addEventListener(_type: string, listener: (event: HIDInputReportEvent) => void) {
        const set = listeners.get(device as unknown as HIDDevice) ?? new Set();
        set.add(listener);
        listeners.set(device as unknown as HIDDevice, set);
      },
      removeEventListener(_type: string, listener: (event: HIDInputReportEvent) => void) {
        listeners.get(device as unknown as HIDDevice)?.delete(listener);
      },
      async sendReport(reportId: number, data: Uint8Array) {
        assert.equal(reportId, 0x10);
        sent.push(data);
        if (options.hangSend) return new Promise<void>(() => undefined);
        if (options.silent) return;
        const subRegister = data[3]!;
        const slot = [1, 2, 3, 4, 5, 6].find((candidate) => receiverPairingSubRegister(productId, candidate) === subRegister)!;
        const answer = slots[slot];
        queueMicrotask(() => {
          // An unrelated report first: the reader must skip it.
          deliver(longInterface, 0x11, new Uint8Array([0x01, 0x04, 0x00, 0x00]));
          if (answer === "silent") return;
          if (answer === undefined || answer === "busy") {
            // 0x03 invalid value: nothing on the slot. 0x07 busy: says nothing.
            deliver(shortInterface, 0x10, new Uint8Array([0xff, 0x8f, 0x83, 0xb5, answer === "busy" ? 0x07 : 0x03, 0x00]));
          } else {
            deliver(longInterface, 0x11, pairingReply(productId, slot, answer));
          }
        });
      },
    };
    return device as unknown as HIDDevice;
  };
  const shortInterface = make(1);
  const longInterface = make(2);
  return { interfaces: [longInterface, shortInterface], sent, closed };
}

test("pairing requests use the Unifying sub-registers, or Bolt's", () => {
  assert.deepEqual([...encodeReceiverPairingRequest(LIGHTSPEED, 1)], [0xff, 0x83, 0xb5, 0x20, 0, 0]);
  assert.deepEqual([...encodeReceiverPairingRequest(LIGHTSPEED, 6)], [0xff, 0x83, 0xb5, 0x25, 0, 0]);
  assert.deepEqual([...encodeReceiverPairingRequest(BOLT, 1)], [0xff, 0x83, 0xb5, 0x51, 0, 0]);
});

test("a pairing reply decodes the kind from the low nibble at the receiver's offset", () => {
  assert.equal(decodeReceiverPairingReply(LIGHTSPEED, 1, 0x11, pairingReply(LIGHTSPEED, 1, 0x42)), "mouse");
  assert.equal(decodeReceiverPairingReply(BOLT, 2, 0x11, pairingReply(BOLT, 2, 0x01)), "keyboard");
  assert.equal(decodeReceiverPairingReply(LIGHTSPEED, 1, 0x11, pairingReply(LIGHTSPEED, 1, 0x0e)), "unknown");
  // A reply for another slot, or a HID++ 2.0 report, is not this answer.
  assert.equal(decodeReceiverPairingReply(LIGHTSPEED, 2, 0x11, pairingReply(LIGHTSPEED, 1, 0x02)), undefined);
  assert.equal(decodeReceiverPairingReply(LIGHTSPEED, 1, 0x11, new Uint8Array([0x01, 0x04, 0, 0])), undefined);
  // Only the errors that mean "nothing here" make a slot empty.
  for (const code of [0x02, 0x03, 0x08]) {
    assert.equal(decodeReceiverPairingReply(LIGHTSPEED, 1, 0x10, new Uint8Array([0xff, 0x8f, 0x83, 0xb5, code, 0])), "empty");
  }
  for (const code of [0x04, 0x07, 0x09, 0x0a]) {
    assert.equal(decodeReceiverPairingReply(LIGHTSPEED, 1, 0x10, new Uint8Array([0xff, 0x8f, 0x83, 0xb5, code, 0])), "failed");
  }
});

test("a LIGHTSPEED receiver with only a mouse reports one pointing slot", async () => {
  const receiver = fakeReceiver(LIGHTSPEED, { 1: 0x02 });
  const pairings = await readLogitechReceiverPairings(receiver.interfaces);
  assert.deepEqual(pairings, [{ slot: 1, kind: "mouse" }]);
  assert.equal(receiver.sent.length, 6);
  // It opened both interfaces and closes them again.
  assert.equal(receiver.closed.length, 2);
});

test("a Bolt receiver lists a keyboard and a mouse on their own slots", async () => {
  const receiver = fakeReceiver(BOLT, { 1: 0x01, 3: 0x02 });
  assert.deepEqual(await readLogitechReceiverPairings(receiver.interfaces), [
    { slot: 1, kind: "keyboard" },
    { slot: 3, kind: "mouse" },
  ]);
});

test("a receiver that never answers, or refuses every slot, is unknown rather than empty", async () => {
  assert.equal(await readLogitechReceiverPairings(fakeReceiver(LIGHTSPEED, {}, { silent: true }).interfaces, 20), null);
  const refusing = fakeReceiver(LIGHTSPEED, {});
  assert.equal(await readLogitechReceiverPairings(refusing.interfaces), null);
  assert.equal(refusing.closed.length, 2);
});

test("an interface that was already open is left open", async () => {
  const receiver = fakeReceiver(LIGHTSPEED, { 1: 0x02 });
  const [longInterface] = receiver.interfaces;
  await longInterface!.open();
  await readLogitechReceiverPairings(receiver.interfaces);
  assert.equal(longInterface!.opened, true);
  assert.equal(receiver.closed.includes(longInterface!), false);
});

test("without a short HID++ collection there is nothing to ask", async () => {
  const receiver = fakeReceiver(LIGHTSPEED, { 1: 0x02 });
  assert.equal(await readLogitechReceiverPairings([receiver.interfaces[0]!]), null);
});

test("mice, trackballs and touchpads are pointing kinds; keyboards are not", () => {
  const kinds: LogitechDeviceKind[] = ["mouse", "trackball", "touchpad", "keyboard", "numpad", "unknown"];
  assert.deepEqual(kinds.map(isPointingKind), [true, true, true, false, false, false]);
});

test("an error that does not mean empty, on any slot, makes the table unknown", async () => {
  // Slot 2 is occupied but busy: dropping it would read as nothing paired there.
  const receiver = fakeReceiver(LIGHTSPEED, { 1: 0x02, 2: "busy" });
  assert.equal(await readLogitechReceiverPairings(receiver.interfaces), null);
  assert.equal(receiver.sent.length, 2);
  assert.equal(receiver.closed.length, 2);
});

test("a later slot that times out makes the table unknown instead of partial", async () => {
  const receiver = fakeReceiver(BOLT, { 1: 0x02, 3: "silent" }, {});
  assert.equal(await readLogitechReceiverPairings(receiver.interfaces, 20), null);
  // It stops at the silent slot, so no late reply can answer a later one.
  assert.equal(receiver.sent.length, 3);
});

test("a send that never settles is bounded by the reply deadline and still closes", async () => {
  const receiver = fakeReceiver(LIGHTSPEED, { 1: 0x02 }, { hangSend: true });
  assert.equal(await readLogitechReceiverPairings(receiver.interfaces, 20), null);
  assert.equal(receiver.closed.length, 2);
});
