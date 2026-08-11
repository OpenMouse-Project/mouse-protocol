/**
 * Features 0x1815 (Hosts Info) and 0x1814 (Change Host) — Easy-Switch.
 *
 * Read from an MX Master 4 (WPID B042) over a Logi Bolt receiver. 0x1815
 * fn 0x00 answers [capabilities(2), hostCount, currentHost]: the two leading
 * capability bytes matter, because reading the counts one byte earlier reports
 * eight slots on a device whose slots 3 and up refuse outright. That device
 * reports three slots with two paired, itself on slot 0.
 *
 * Slot indices are zero-based on the wire. The button on the underside of the
 * mouse and its indicator both count from one, so anything user-facing has to
 * add one or it disagrees with the hardware in the user's hand.
 */

export const LOGITECH_HOSTS = {
  /** getHostsInfo: [capabilities(2), hostCount, currentHost]. */
  info: 0x00,
  /** getHostInfo(slot): [slot, status, ..., nameLength, maxNameLength]. */
  host: 0x10,
  /**
   * getHostFriendlyName(slot, offset). NOT the host's label: on an MX Master 4
   * this answers six non-text bytes per slot regardless of the reported name
   * length, which is an address rather than a name. Where the label actually
   * lives is unknown, and the remaining function ids on this feature are
   * reportedly set-name, move and delete-host — a blind call to the last would
   * unpair one of the user's computers, so it was left alone.
   */
  hostName: 0x20,
} as const;

export const LOGITECH_CHANGE_HOST = {
  /** getCurrentHost. */
  current: 0x00,
  /** setCurrentHost(slot) — disconnects this host on success. */
  set: 0x10,
} as const;

/** Status 1 means a computer is paired to the slot; 0 means it is empty. */
export const LOGITECH_HOST_STATUS_PAIRED = 0x01;

export interface LogitechHostsInfo {
  hostCount: number;
  currentHost: number;
  capabilities: number;
}

export function decodeHostsInfo(payload: Uint8Array | readonly number[]): LogitechHostsInfo | null {
  const capabilityHigh = payload[0];
  const capabilityLow = payload[1];
  const hostCount = payload[2];
  const currentHost = payload[3];
  if (capabilityHigh === undefined || capabilityLow === undefined) return null;
  if (hostCount === undefined || currentHost === undefined || hostCount === 0) return null;
  if (currentHost >= hostCount) return null;
  return {
    hostCount,
    currentHost,
    capabilities: (capabilityHigh << 8) | capabilityLow,
  };
}

export function decodeHostPaired(payload: Uint8Array | readonly number[]): boolean | null {
  const status = payload[1];
  return status === undefined ? null : status === LOGITECH_HOST_STATUS_PAIRED;
}

export type LogitechHostSwitchRejection = "no-hosts" | "out-of-range" | "already-current" | "empty-slot";

/**
 * Why a host switch must not be sent, or null when it may be.
 *
 * Refusing an empty slot is the important one. Switching into a slot with no
 * computer paired leaves the mouse unreachable until someone presses the
 * button on its underside, and no warning text makes that an acceptable thing
 * for a misclick to do.
 */
export function rejectHostSwitch(
  slot: number,
  info: LogitechHostsInfo | null,
  paired: readonly boolean[],
): LogitechHostSwitchRejection | null {
  if (!info) return "no-hosts";
  if (!Number.isInteger(slot) || slot < 0 || slot >= info.hostCount) return "out-of-range";
  if (slot === info.currentHost) return "already-current";
  if (paired[slot] !== true) return "empty-slot";
  return null;
}

export function buildHostSwitchWrite(slot: number): number[] {
  return [slot & 0xff];
}
