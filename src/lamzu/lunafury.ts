/** LunaFury's public XviUpdater commands, inspected 2026-10-05.
 * Report ID 0 is absent from received WebHID buffers (vendor hidIndex = 1).
 * Offsets below are relative to the shared six-byte CompX response header.
 */
export type LunaFuryLightningMode = 0 | 1 | 2;
export type LunaFuryButton = "left" | "right" | "middle";
export interface LunaFuryWheelGuard { enabled: boolean; windowMs: number }
export interface LunaFurySettings {
  lightningMode?: LunaFuryLightningMode;
  leftDebounceMs?: number;
  rightDebounceMs?: number;
  middleDebounceMs?: number;
  wheelGuard?: LunaFuryWheelGuard;
}

const BUTTON_ID = { left: 1, right: 2, middle: 3 } as const;
const request = (page: number, command: number, length: number, args: number[]) => {
  whole(args[0], 1, 255, "Profile ID");
  return { target: 0x02, page, command, length, args };
};

export const LUNAFURY_READ = {
  angle: (profile: number) => request(0x01, 0x94, 2, [profile]),
  lightning: (profile: number) => request(0x00, 0x98, 4, [profile]),
  buttonDebounce: (profile: number, button: LunaFuryButton) =>
    request(0x00, 0x92, 19, [profile, 0, BUTTON_ID[button]]),
  wheelGuard: (profile: number) => request(0x00, 0x99, 4, [profile]),
};

function whole(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
  }
}

export const LUNAFURY_WRITE = {
  angle(profile: number, degrees: number) {
    whole(degrees, -30, 30, "Sensor angle");
    return request(0x01, 0x14, 2, [profile, degrees & 0xff]);
  },
  lightning(profile: number, mode: LunaFuryLightningMode) {
    whole(mode, 0, 2, "Lightning Trigger mode");
    return request(0x00, 0x18, 4, [profile, mode]);
  },
  buttonDebounce(profile: number, button: LunaFuryButton, milliseconds: number) {
    if (!Object.hasOwn(BUTTON_ID, button)) throw new Error("Unknown LunaFury button.");
    whole(milliseconds, button === "middle" ? 1 : 0, button === "middle" ? 30 : 15, "Button latency");
    // The vendor writes the same latency into both timing fields, with the
    // remaining timing fields fixed at 0/20. Preserve the full 19-byte layout.
    return request(0x00, 0x12, 19, [
      profile, 0, BUTTON_ID[button], 0, milliseconds, 0, 0,
      0, milliseconds, 0, 0, 0, 20, 0, 0, 0, 20, 0, 0,
    ]);
  },
  wheelGuard(profile: number, guard: LunaFuryWheelGuard) {
    if (typeof guard.enabled !== "boolean") throw new Error("Wheel guard needs an on/off value.");
    // Firmware can report a disabled zero window. It must be writable too
    // so applying and restoring a game profile preserves the original value.
    if (!guard.enabled && guard.windowMs === 0) return request(0x00, 0x19, 4, [profile, 0, 0, 0]);
    whole(guard.windowMs, 20, 200, "Wheel guard window");
    if (guard.windowMs % 20 !== 0) throw new Error("Wheel guard window must use 20 ms steps.");
    return request(0x00, 0x19, 4, [profile, guard.enabled ? 1 : 0, 0, guard.windowMs]);
  },
};

export function lunafuryDecodeAngle(payload: Uint8Array | null): number | null {
  if (!payload || payload.length < 2) return null;
  const angle = payload[1] > 127 ? payload[1] - 256 : payload[1];
  return angle >= -30 && angle <= 30 ? angle : null;
}

export function lunafuryDecodeLightning(payload: Uint8Array | null): LunaFuryLightningMode | undefined {
  return payload && payload.length >= 2 && payload[1] <= 2
    ? payload[1] as LunaFuryLightningMode : undefined;
}

export function lunafuryDecodeButtonDebounce(payload: Uint8Array | null, button: LunaFuryButton): number | undefined {
  if (!payload || payload.length < 5 || payload[2] !== BUTTON_ID[button]) return undefined;
  const value = (payload[3] << 8) | payload[4];
  return value >= (button === "middle" ? 1 : 0) && value <= (button === "middle" ? 30 : 15)
    ? value : undefined;
}

export function lunafuryDecodeWheelGuard(payload: Uint8Array | null): LunaFuryWheelGuard | undefined {
  if (!payload || payload.length < 4 || payload[1] > 1) return undefined;
  const windowMs = (payload[2] << 8) | payload[3];
  const enabled = payload[1] === 1;
  if (!(windowMs >= 20 && windowMs <= 200 && windowMs % 20 === 0) && !(!enabled && windowMs === 0)) return undefined;
  return { enabled, windowMs };
}
