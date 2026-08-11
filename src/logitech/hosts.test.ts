import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGITECH_HOST_STATUS_PAIRED,
  buildHostSwitchWrite,
  decodeHostPaired,
  decodeHostsInfo,
  rejectHostSwitch,
} from "./hosts.js";

/** Read from an MX Master 4: capabilities 0x1308, three slots, on slot 0. */
const HOSTS_INFO = [0x13, 0x08, 0x03, 0x00];

test("decodes the hosts reply captured from hardware", () => {
  const info = decodeHostsInfo(HOSTS_INFO);
  assert.deepEqual(info, { hostCount: 3, currentHost: 0, capabilities: 0x1308 });
});

test("the counts are read past the capability bytes", () => {
  // Reading them one byte early reports eight slots on a device whose slots
  // three and up refuse outright, which is how this was first got wrong.
  const info = decodeHostsInfo(HOSTS_INFO);
  assert.notEqual(info?.hostCount, 0x08, "the count came from a capability byte");
  assert.equal(info?.hostCount, 3);
});

test("a reply that cannot be trusted decodes as null", () => {
  assert.equal(decodeHostsInfo([]), null);
  assert.equal(decodeHostsInfo([0x13, 0x08]), null);
  assert.equal(decodeHostsInfo([0x13, 0x08, 0x00, 0x00]), null, "zero slots is not a device");
  // A device claiming to sit on a slot it says it does not have is incoherent,
  // and trusting it would offer a switch to a slot that cannot exist.
  assert.equal(decodeHostsInfo([0x13, 0x08, 0x03, 0x05]), null);
});

test("slot status decodes paired against empty", () => {
  assert.equal(decodeHostPaired([0x00, LOGITECH_HOST_STATUS_PAIRED, 0x05]), true);
  assert.equal(decodeHostPaired([0x02, 0x00, 0x00]), false);
  assert.equal(decodeHostPaired([0x02]), null);
});

const INFO = { hostCount: 3, currentHost: 0, capabilities: 0x1308 };
const PAIRED = [true, true, false];

test("a switch to a paired slot is allowed", () => {
  assert.equal(rejectHostSwitch(1, INFO, PAIRED), null);
});

test("a switch into an empty slot is refused", () => {
  // The whole safety design rests on this: an empty slot leaves the mouse
  // unreachable until someone presses the button on its underside.
  assert.equal(rejectHostSwitch(2, INFO, PAIRED), "empty-slot");
});

test("a switch that would go nowhere is refused", () => {
  assert.equal(rejectHostSwitch(0, INFO, PAIRED), "already-current");
  assert.equal(rejectHostSwitch(3, INFO, PAIRED), "out-of-range");
  assert.equal(rejectHostSwitch(-1, INFO, PAIRED), "out-of-range");
  assert.equal(rejectHostSwitch(1.5, INFO, PAIRED), "out-of-range");
  assert.equal(rejectHostSwitch(1, null, PAIRED), "no-hosts");
});

test("a slot with no status read is treated as empty, not as switchable", () => {
  // A transient read failure must fail towards refusing the switch.
  assert.equal(rejectHostSwitch(1, INFO, []), "empty-slot");
});

test("the write carries the slot index", () => {
  assert.deepEqual(buildHostSwitchWrite(1), [1]);
  assert.deepEqual(buildHostSwitchWrite(0x1ff), [0xff]);
});
