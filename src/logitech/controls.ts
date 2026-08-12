/**
 * Feature 0x1B04 (REPROG CONTROLS V4) — which buttons a device has, what each
 * one currently does, and which of them may be pointed at another.
 *
 * Read from an MX Master 4 (WPID B042) over a Logi Bolt receiver, which
 * reports nine controls at version 6. Control and task names follow Solaar's
 * special_keys tables; the ids this device actually reports were confirmed
 * against it, and the rest are carried from that list unverified.
 *
 * The device decides what is legal here, not this code. Every control carries
 * a group and a mask of the groups it accepts, and the primary buttons report
 * a mask of zero — so firmware, not a rule invented here, is what refuses to
 * let left click be moved.
 */

export const LOGITECH_REPROG_CONTROLS = {
  /** getCount: [count]. */
  count: 0x00,
  /** getControlIdInfo(index): [cid(2), tid(2), flags, pos, group, gmask, ...]. */
  info: 0x10,
  /** getControlIdReporting(cid): [cid(2), flagsLow, remap(2), flagsHigh]. */
  reporting: 0x20,
  /** setControlIdReporting(cid, flags, remap(2)). */
  setReporting: 0x30,
} as const;

/** Control ids — the physical (or virtual) buttons a device exposes. */
export const LOGITECH_CONTROL_NAMES: Readonly<Record<number, string>> = {
  0x0050: "Left click",
  0x0051: "Right click",
  0x0052: "Middle click",
  0x0053: "Back",
  0x0054: "Back (alt)",
  0x0056: "Forward",
  0x0057: "Forward (as HID)",
  0x0059: "Button 6",
  0x005a: "Button 7",
  0x005b: "Button 8",
  0x005c: "Button 9",
  0x005d: "Button 10",
  0x005e: "Button 11",
  0x00c3: "Gesture button",
  0x00c4: "SmartShift button",
  0x00d7: "Virtual gesture button",
  0x00dc: "Back (long press)",
  0x00e0: "Mission Control / Task View",
  0x00e1: "Dashboard / Action Center",
  0x00e2: "Backlight down",
  0x00e3: "Backlight up",
  0x00e4: "Previous track",
  0x00e5: "Play / pause",
  0x00e6: "Next track",
  0x00e7: "Mute",
  0x00e8: "Volume down",
  0x00e9: "Volume up",
  /** The MX Master 4's Actions Ring, the panel paired with 0x19B0 haptics. */
  0x01a0: "Actions Ring",
};

/** Native task each control performs when it is neither remapped nor diverted. */
export const LOGITECH_TASK_NAMES: Readonly<Record<number, string>> = {
  0x0038: "Left click",
  0x0039: "Right click",
  0x003a: "Middle click",
  0x003c: "Back",
  0x003e: "Forward",
  0x009c: "Gesture button",
  0x009d: "SmartShift",
  0x00b4: "Virtual gesture button",
  0x0109: "App switch / Launchpad",
};

/**
 * Bits of the flags byte from getControlIdInfo. Confirmed against an
 * MX Master 4: left click reports 0x01 (a plain mouse button, not
 * reprogrammable), the gesture button 0x31, and the virtual gesture button
 * 0xA0 — virtual and divertable, but not a physical key.
 */
export const LOGITECH_KEY_FLAG = {
  mouseButton: 0x01,
  fkey: 0x02,
  hotkey: 0x04,
  fnToggle: 0x08,
  reprogrammable: 0x10,
  divertable: 0x20,
  persistentlyDivertable: 0x40,
  virtual: 0x80,
} as const;

/**
 * Bits of the mapping flags from getControlIdReporting, which is one 16-bit
 * field split across two non-adjacent payload bytes — low at [2], high at [5],
 * with the remap target wedged between them.
 */
export const LOGITECH_MAPPING_FLAG = {
  diverted: 0x0001,
  persistentlyDiverted: 0x0004,
  rawXy: 0x0010,
  forceRawXy: 0x0040,
  analyticsKeyEvents: 0x0100,
  rawWheel: 0x0400,
} as const;

export interface LogitechControlInfo {
  controlId: number;
  taskId: number;
  /** The getControlIdInfo capability flags — LOGITECH_KEY_FLAG bits. */
  flags: number;
  /** Group this control belongs to when it is used as a remap target. */
  group: number;
  /** Bitmask of the groups this control may be remapped into. */
  groupMask: number;
}

export interface LogitechControlReporting {
  controlId: number;
  /**
   * The 16-bit mapping field, reassembled from its two payload bytes.
   * Named apart from LogitechControlInfo.flags on purpose: the two are
   * different fields, and a control merges both, so a shared name would have
   * one silently overwrite the other.
   */
  mappingFlags: number;
  /** Control id this button currently acts as. */
  mappedTo: number;
  /** Another application is consuming this button's events. */
  diverted: boolean;
}

export interface LogitechReprogrammableControl extends LogitechControlInfo, LogitechControlReporting {
  name: string;
  taskName: string;
  reprogrammable: boolean;
  /** A software-side control, not a physical button anyone can press. */
  virtual: boolean;
  /** Control ids this button may legally be remapped to. */
  remappableTo: number[];
}

export const logitechControlName = (controlId: number): string =>
  LOGITECH_CONTROL_NAMES[controlId]
  ?? `Control 0x${controlId.toString(16).padStart(4, "0").toUpperCase()}`;

export const logitechTaskName = (taskId: number): string =>
  LOGITECH_TASK_NAMES[taskId] ?? `Task 0x${taskId.toString(16).padStart(4, "0").toUpperCase()}`;

/** Decodes the getControlIdInfo payload (function 0x10). */
export function decodeControlInfo(payload: Uint8Array | readonly number[]): LogitechControlInfo | null {
  if (payload.length < 8) return null;
  const at = (index: number): number => payload[index] ?? 0;
  return {
    controlId: (at(0) << 8) | at(1),
    taskId: (at(2) << 8) | at(3),
    flags: at(4),
    // Byte 5 is the physical position, which is meaningful on keyboards only.
    group: at(6),
    groupMask: at(7),
  };
}

/**
 * Decodes the getControlIdReporting payload (function 0x20).
 *
 * The mapping flags are one 16-bit field whose halves are not adjacent: the
 * low byte sits at [2] and the high byte at [5], with the remap target at
 * [3..4] between them. Reading the two as a contiguous pair puts the remap
 * target's high byte where the flags belong, which reports a button remapped
 * to anything in 0x01.. as diverted.
 */
export function decodeControlReporting(
  payload: Uint8Array | readonly number[],
): LogitechControlReporting | null {
  if (payload.length < 6) return null;
  const at = (index: number): number => payload[index] ?? 0;
  const mappingFlags = at(2) | (at(5) << 8);
  const diverted = LOGITECH_MAPPING_FLAG.diverted | LOGITECH_MAPPING_FLAG.persistentlyDiverted;
  return {
    controlId: (at(0) << 8) | at(1),
    mappingFlags,
    mappedTo: (at(3) << 8) | at(4),
    diverted: (mappingFlags & diverted) !== 0,
  };
}

/**
 * Which controls a given control may be remapped to.
 *
 * The device's group mask names the groups it accepts, and only controls
 * belonging to one of those groups are legal targets. Left and right click
 * report a mask of zero, so they come back with nothing.
 */
export function remappableControlTargets(
  control: LogitechControlInfo,
  all: readonly LogitechControlInfo[],
): number[] {
  return all
    // Group 0 means the control belongs to no group and is not a target. The
    // mask test alone would also reject it — but only via a negative shift,
    // which is an accident to rely on rather than a rule to read.
    .filter((candidate) => candidate.group > 0
      && (control.groupMask & (1 << (candidate.group - 1))) !== 0)
    .map((candidate) => candidate.controlId);
}

/**
 * Builds the setControlIdReporting payload for a pure remap.
 *
 * Each mapping flag occupies two bits — the value, and a companion "valid" bit
 * one position higher — and the device ignores any flag whose valid bit is
 * clear. A flags byte of zero therefore changes no flag at all, which is
 * exactly what is wanted here: turning diversion on would route the button to
 * HID++ notifications that nothing consumes, leaving it dead.
 */
export function buildControlRemapWrite(controlId: number, targetControlId: number): number[] {
  return [controlId >> 8, controlId & 0xff, 0x00, targetControlId >> 8, targetControlId & 0xff];
}

/**
 * Builds the payload that hands a button back to the hardware.
 *
 * A diverted button emits HID++ notifications instead of acting, which is how
 * a vendor application implements behaviours of its own. Logi Options+ uses
 * the temporary flag, which the device clears when its owner stops — but the
 * persistent flag survives, and a button left that way does nothing at all
 * until something clears it.
 *
 * Only the valid bits are set, with both value bits left clear, so this can
 * only ever turn diversion off. There is deliberately no way to turn it on:
 * nothing here consumes those notifications. A remap target of zero leaves the
 * existing mapping untouched.
 */
export function buildControlDiversionClearWrite(controlId: number): number[] {
  const clearDiverted = LOGITECH_MAPPING_FLAG.diverted << 1;
  const clearPersistent = LOGITECH_MAPPING_FLAG.persistentlyDiverted << 1;
  return [controlId >> 8, controlId & 0xff, clearDiverted | clearPersistent, 0x00, 0x00];
}
