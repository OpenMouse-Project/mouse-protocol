import type { CompaxDpiStage } from "../compx/codec.js";

/** LunaFury runtime controls from the public configurator, inspected 2026-10-07.
 * Profiles and wire DPI stages are 1-based; the driver exposes stages 0-based.
 */
export type LunaFuryButtonPollingRate = 1000 | 2000 | 4000 | 8000;
/** Complete stored slots, separate from the enabled stage count. */
export interface LunaFuryDpiStorage {
  profile: number;
  count: number;
  stages: CompaxDpiStage[];
}
export const LUNAFURY_BUTTON_RATES = [[1, 1000], [32, 2000], [64, 4000], [128, 8000]] as const;
export const LUNAFURY_DPI_DEFAULTS = [400, 800, 1600, 3200, 6400, 30000] as const;

function whole(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
}

function profile(id: number): void { whole(id, 1, 3, "LunaFury profile"); }
function maximum(count: number): void { if (count !== 5 && count !== 6) throw new Error("LunaFury supports five or six DPI stages."); }
export function lunafuryValidateDpi(value: number): void {
  whole(value, 50, 30000, "DPI");
  if (value % 50 !== 0) throw new Error("DPI must use 50 DPI steps.");
}
const request = (page: number, command: number, length: number, args: number[]) =>
  ({ target: 2, page, command, length, args });
const scoped = (id: number, page: number, command: number, length = 2, rest: number[] = []) => {
  profile(id);
  return request(page, command, length, [id, ...rest]);
};

export const LUNAFURY_ONBOARD_READ = {
  profile: () => request(0, 0x85, 1, []),
  buttonRate: (id: number) => scoped(id, 0, 0x9f),
  dpiStages: (id: number, maxStages: number) => {
    maximum(maxStages);
    return scoped(id, 1, 0x81, 10, [maxStages]);
  },
  activeStage: (id: number) => scoped(id, 1, 0x82),
  separateAxes: (id: number) => scoped(id, 1, 0x8d),
};

export const LUNAFURY_ONBOARD_WRITE = {
  profile: (id: number) => scoped(id, 0, 0x05, 1),
  buttonRate: (id: number, hertz: LunaFuryButtonPollingRate) => {
    const code = LUNAFURY_BUTTON_RATES.find(([, rate]) => rate === hertz)?.[0];
    if (code === undefined) throw new Error("Unknown LunaFury button polling rate.");
    return scoped(id, 0, 0x1f, 2, [code]);
  },
  activeStage: (id: number, stage: number, count: number) => {
    whole(count, 1, 6, "DPI stage count");
    whole(stage, 0, count - 1, "DPI stage index");
    return scoped(id, 1, 0x02, 2, [stage + 1]);
  },
  separateAxes: (id: number, enabled: boolean) => {
    if (typeof enabled !== "boolean") throw new Error("Separate DPI axes needs an on/off value.");
    return scoped(id, 1, 0x0d, 2, [+enabled]);
  },
};

export function lunafuryDecodeButtonRate(payload: Uint8Array | null): LunaFuryButtonPollingRate | undefined {
  return payload && payload.length >= 2 ? LUNAFURY_BUTTON_RATES.find(([code]) => code === payload[1])?.[1] : undefined;
}

export function lunafuryDecodeSeparateAxes(payload: Uint8Array | null): boolean | undefined {
  return payload && payload.length >= 2 && payload[1] <= 1 ? payload[1] === 1 : undefined;
}

export function lunafuryDecodeDpiStages(payload: Uint8Array, maxStages: number): CompaxDpiStage[] {
  maximum(maxStages);
  const count = payload[1];
  whole(count, 1, maxStages, "DPI stage count");
  if (payload.length < 2 + count * 4) throw new Error("Truncated LunaFury DPI table.");
  return Array.from({ length: count }, (_, index) => {
    const offset = 2 + index * 4;
    const x = (payload[offset] << 8) | payload[offset + 1];
    const y = (payload[offset + 2] << 8) | payload[offset + 3];
    lunafuryValidateDpi(x);
    lunafuryValidateDpi(y);
    return { x, y };
  });
}

export function lunafuryDecodeDpiStorage(payload: Uint8Array, maxStages: number): LunaFuryDpiStorage | undefined {
  lunafuryDecodeDpiStages(payload, maxStages);
  if (payload.length < 26) return undefined;
  profile(payload[0]);
  return { profile: payload[0], count: payload[1], stages: Array.from({ length: maxStages }, (_, index) => {
    const offset = 2 + index * 4;
    return { x: (payload[offset] << 8) | payload[offset + 1], y: (payload[offset + 2] << 8) | payload[offset + 3] };
  }) };
}

/** Dormant slots may contain reserved values; preserve their exact 16-bit storage. */
export function lunafuryWriteDpiStorage(storage: LunaFuryDpiStorage, previous: Uint8Array, maxStages: number) {
  maximum(maxStages); profile(storage.profile); whole(storage.count, 1, maxStages, "DPI stage count");
  if (!Array.isArray(storage.stages) || storage.stages.length !== maxStages) throw new Error("Incomplete LunaFury DPI storage.");
  if (!lunafuryDecodeDpiStorage(previous, maxStages) || previous[0] !== storage.profile) throw new Error("DPI storage belongs to another profile or is incomplete.");
  const args = Array.from(previous.slice(0, 26));
  args[1] = storage.count;
  storage.stages.forEach(({ x, y }, index) => {
    whole(x, 0, 65535, "Stored X DPI"); whole(y, 0, 65535, "Stored Y DPI");
    if (index < storage.count) { lunafuryValidateDpi(x); lunafuryValidateDpi(y); }
    args.splice(2 + index * 4, 4, x >> 8, x & 255, y >> 8, y & 255);
  });
  return request(1, 1, 26, args);
}

/** Retain dormant slots and trailing vendor bytes in the fixed 26-byte table. */
export function lunafuryWriteDpiStages(id: number, stages: readonly CompaxDpiStage[], previous: Uint8Array, maxStages: number) {
  profile(id);
  lunafuryDecodeDpiStages(previous, maxStages);
  if (previous[0] !== id) throw new Error("DPI table belongs to another profile.");
  whole(stages.length, 1, maxStages, "DPI stage count");
  const args = Array.from({ length: 26 }, (_, index) => previous[index] ?? 0);
  args[1] = stages.length;
  stages.forEach(({ x, y }, index) => {
    lunafuryValidateDpi(x);
    lunafuryValidateDpi(y);
    args.splice(2 + index * 4, 4, x >> 8, x & 255, y >> 8, y & 255);
  });
  return request(1, 1, 26, args);
}
