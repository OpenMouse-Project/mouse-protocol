import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGITECH_KEY_FLAG,
  LOGITECH_MAPPING_FLAG,
  buildControlDiversionClearWrite,
  buildControlRemapWrite,
  decodeControlInfo,
  decodeControlReporting,
  logitechControlName,
  logitechTaskName,
  remappableControlTargets,
} from "./controls.js";

/**
 * Real getControlIdInfo payloads captured from an MX Master 4 over a Logi Bolt
 * receiver, so these fail if the decoding drifts from actual hardware.
 */
const MX_MASTER_4_CONTROLS = [
  [0x00, 0x50, 0x00, 0x38, 0x01, 0x00, 0x01, 0x00, 0x04], // Left click
  [0x00, 0x51, 0x00, 0x39, 0x01, 0x00, 0x01, 0x00, 0x04], // Right click
  [0x00, 0x52, 0x00, 0x3a, 0x31, 0x00, 0x02, 0x03, 0x05], // Middle click
  [0x00, 0x53, 0x00, 0x3c, 0x31, 0x00, 0x02, 0x03, 0x05], // Back
  [0x00, 0x56, 0x00, 0x3e, 0x31, 0x00, 0x02, 0x03, 0x05], // Forward
  [0x00, 0xc3, 0x00, 0x9c, 0x31, 0x00, 0x02, 0x03, 0x05], // Gesture button
  [0x00, 0xc4, 0x00, 0x9d, 0x31, 0x00, 0x02, 0x03, 0x05], // SmartShift button
  [0x01, 0xa0, 0x01, 0x09, 0x31, 0x00, 0x02, 0x03, 0x05], // Actions Ring
  [0x00, 0xd7, 0x00, 0xb4, 0xa0, 0x00, 0x03, 0x00, 0x03], // Virtual gesture button
].map((payload) => decodeControlInfo(payload)!);

const byId = (controlId: number) =>
  MX_MASTER_4_CONTROLS.find((control) => control.controlId === controlId)!;

test("control info is decoded from the wire layout", () => {
  const back = byId(0x0053);
  assert.equal(back.taskId, 0x003c);
  assert.equal(back.group, 2);
  assert.equal(back.groupMask, 0b011);

  const actionsRing = byId(0x01a0);
  assert.equal(actionsRing.taskId, 0x0109);
  assert.equal(logitechControlName(actionsRing.controlId), "Actions Ring");
});

test("a truncated control-info payload decodes as null rather than a guess", () => {
  // Group and mask live at [6] and [7]; a short read would default them to
  // zero, which silently reports every control as having no legal targets.
  assert.equal(decodeControlInfo([0x00, 0x53, 0x00, 0x3c, 0x31, 0x00]), null);
  assert.equal(decodeControlInfo([]), null);
});

test("the primary buttons report themselves as not reprogrammable", () => {
  for (const controlId of [0x0050, 0x0051]) {
    const control = byId(controlId);
    // The exact byte, not just the absence of one bit: a flags field read from
    // the wrong offset also lacks the reprogrammable bit, so a bitmask check
    // alone passes against broken decoding.
    assert.equal(control.flags, LOGITECH_KEY_FLAG.mouseButton, "primary buttons report flags 0x01");
    assert.equal(control.flags & LOGITECH_KEY_FLAG.reprogrammable, 0);
    assert.equal(control.groupMask, 0);
    assert.deepEqual(
      remappableControlTargets(control, MX_MASTER_4_CONTROLS),
      [],
      "the firmware offers no targets for a primary button, so neither may we",
    );
  }
});

test("a virtual control is not offered as a remap target", () => {
  const virtual = byId(0x00d7);
  assert.notEqual(virtual.flags & LOGITECH_KEY_FLAG.virtual, 0);
  // It sits in group 3, and no control's mask includes group 3.
  for (const control of MX_MASTER_4_CONTROLS) {
    assert.ok(
      !remappableControlTargets(control, MX_MASTER_4_CONTROLS).includes(0x00d7),
      `${logitechControlName(control.controlId)} offered the virtual gesture button as a target`,
    );
  }
});

test("remap targets come from the device's group mask", () => {
  const targets = remappableControlTargets(byId(0x00c3), MX_MASTER_4_CONTROLS);
  assert.deepEqual(targets, [0x0050, 0x0051, 0x0052, 0x0053, 0x0056, 0x00c3, 0x00c4, 0x01a0]);
  assert.ok(targets.includes(0x00c3), "a control must be able to return to its own default");
});

test("a control belonging to no group is never a target", () => {
  // No control on an MX Master 4 reports group 0, so this pins the contract
  // for devices that do rather than restating something the capture proves.
  const grouped = { controlId: 0x0052, taskId: 0x003a, flags: 0x31, group: 1, groupMask: 0xff };
  const ungrouped = { controlId: 0x00d7, taskId: 0x00b4, flags: 0xa0, group: 0, groupMask: 0x00 };
  assert.deepEqual(remappableControlTargets(grouped, [grouped, ungrouped]), [0x0052]);
});

test("a control whose mask is empty is offered nothing at all", () => {
  const leftClick = byId(0x0050);
  assert.equal(leftClick.groupMask, 0);
  // Every candidate is in some group, so an empty result can only come from
  // the mask — this is the rule that keeps the primary buttons where they are.
  assert.ok(MX_MASTER_4_CONTROLS.every((control) => control.group > 0));
  assert.deepEqual(remappableControlTargets(leftClick, MX_MASTER_4_CONTROLS), []);
});

test("the mapping flags are reassembled from two non-adjacent bytes", () => {
  // [cid(2), flagsLow, remap(2), flagsHigh] — the remap target sits between
  // the two halves of one 16-bit field.
  const reporting = decodeControlReporting([0x00, 0xc3, 0x01, 0x00, 0x52, 0x04])!;
  assert.equal(reporting.controlId, 0x00c3);
  assert.equal(reporting.mappedTo, 0x0052);
  assert.equal(reporting.mappingFlags, 0x0401);
  assert.equal(reporting.mappingFlags & LOGITECH_MAPPING_FLAG.rawWheel, LOGITECH_MAPPING_FLAG.rawWheel);
  assert.equal(reporting.diverted, true);
});

test("a button remapped to a high control id is not mistaken for a diverted one", () => {
  // Reading flags as the contiguous pair at [2..3] folds the remap target's
  // high byte into them, so remapping anything to 0x01A0 — the Actions Ring —
  // would set the analytics bit and, on the low half, look diverted.
  const reporting = decodeControlReporting([0x00, 0xc3, 0x00, 0x01, 0xa0, 0x00])!;
  assert.equal(reporting.mappedTo, 0x01a0);
  assert.equal(reporting.mappingFlags, 0x0000);
  assert.equal(reporting.diverted, false, "the remap target leaked into the mapping flags");
});

test("persistent diversion counts as diverted, and an undiverted button does not", () => {
  const persistent = decodeControlReporting([0x00, 0x53, 0x04, 0x00, 0x53, 0x00])!;
  assert.equal(persistent.diverted, true);

  const plain = decodeControlReporting([0x00, 0x53, 0x00, 0x00, 0x53, 0x00])!;
  assert.equal(plain.diverted, false);

  // The high byte alone carries no diversion bit, so a control reporting only
  // analytics events is still the user's to press.
  const analytics = decodeControlReporting([0x00, 0x53, 0x00, 0x00, 0x53, 0x01])!;
  assert.equal(analytics.mappingFlags, LOGITECH_MAPPING_FLAG.analyticsKeyEvents);
  assert.equal(analytics.diverted, false);
});

test("a truncated reporting payload decodes as null", () => {
  // The high flags byte is the last one, so a short read would quietly report
  // every control as carrying no high-half flags.
  assert.equal(decodeControlReporting([0x00, 0xc3, 0x01, 0x00, 0x52]), null);
  assert.equal(decodeControlReporting([]), null);
});

test("a remap write changes the mapping and no flags", () => {
  const payload = buildControlRemapWrite(0x00c3, 0x0052);
  assert.deepEqual(payload, [0x00, 0xc3, 0x00, 0x00, 0x52]);
  // Every mapping flag needs a companion "valid" bit one position higher, so a
  // zero flags byte marks nothing valid and leaves diversion exactly as it was.
  assert.equal(payload[2], 0x00, "a non-zero flags byte would rewrite diversion state");
});

test("a diversion-clear write can only ever turn diversion off", () => {
  const payload = buildControlDiversionClearWrite(0x0053);
  assert.deepEqual(payload, [0x00, 0x53, 0x0a, 0x00, 0x00]);

  const flags = payload[2]!;
  // Valid bits set for diverted (0x02) and persistently diverted (0x08)...
  assert.equal(flags & 0x02, 0x02);
  assert.equal(flags & 0x08, 0x08);
  // ...with both value bits clear, so the flags can only be turned off.
  assert.equal(flags & LOGITECH_MAPPING_FLAG.diverted, 0, "the write would switch diversion on");
  assert.equal(
    flags & LOGITECH_MAPPING_FLAG.persistentlyDiverted,
    0,
    "the write would switch persistent diversion on",
  );
  // A zero remap target leaves the button pointing where it already did.
  assert.deepEqual(payload.slice(3), [0x00, 0x00]);
});

test("control and task ids fall back to a readable hex label", () => {
  assert.equal(logitechControlName(0x0abc), "Control 0x0ABC");
  assert.equal(logitechTaskName(0x0abc), "Task 0x0ABC");
});
