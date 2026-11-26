/** LunaFury XviUpdater sleep and receiver-light commands. */
export type LunaFuryReceiverLightMode = 0 | 2 | 6 | 11;
export type LunaFuryBottomButtonMode = 1 | 2;

function bottomProfile(profile: number): void {
  if (!Number.isInteger(profile) || profile < 1 || profile > 3) throw new Error("Invalid LunaFury profile.");
}

/** The vendor reads physical button 0x14 using its shorter, six-byte layout. */
export function lunafuryReadBottomButton(profile: number) {
  bottomProfile(profile);
  return { target: 2, page: 3, command: 0x80, length: 6, args: [profile, 0x14] };
}

export function lunafuryWriteBottomButton(profile: number, mode: LunaFuryBottomButtonMode) {
  bottomProfile(profile);
  if (mode !== 1 && mode !== 2) throw new Error("Unknown LunaFury bottom-button mode.");
  // Preserve the vendor's five-byte power binding; do not use the ordinary
  // remapping codec, which would append another byte to this special function.
  const args = mode === 1 ? [profile, 0x14, 0, 0x15, 1] : [profile, 0x14, 0, 7, 1, 6];
  return { target: 2, page: 3, command: 0, length: args.length, args };
}

export function lunafuryDecodeBottomButton(payload: Uint8Array | null, profile: number): LunaFuryBottomButtonMode | undefined {
  bottomProfile(profile);
  if (!payload || payload.length < 5 || payload[0] !== profile || payload[1] !== 0x14
    || payload[2] !== 0 || payload[4] !== 1 || payload.slice(6).some((byte) => byte !== 0)) return undefined;
  if (payload[3] === 0x15 && (payload.length === 5 || payload[5] === 0)) return 1;
  if (payload[3] === 7 && payload.length >= 6 && payload[5] === 6) return 2;
  return undefined;
}
export const LUNAFURY_SLEEP_OPTIONS: readonly number[] = [0, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 60)];

export function lunafuryEncodeSleep(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xfeff) {
    throw new Error("LunaFury sleep timeout must be 0 (never) or 1–65279 seconds.");
  }
  return seconds === 0 ? 0xffff : seconds;
}

export function lunafuryDecodeSleep(payload: Uint8Array | null): number | null {
  if (!payload || payload.length < 3) return null;
  const value = (payload[1] << 8) | payload[2];
  return value === 0xffff ? 0 : value > 0 && value <= 0xfeff ? value : null;
}

export function lunafuryReceiverLightTarget(productId: number): number | undefined {
  return productId === 0x0033 ? 0 : productId === 0x0084 ? 1 : undefined;
}

export function lunafuryReadReceiverLight(productId: number) {
  const target = lunafuryReceiverLightTarget(productId);
  if (target === undefined) throw new Error("Receiver lighting requires a LunaFury 8K receiver.");
  return { target, page: 2, command: 0x80, length: 6, args: [1] };
}

export function lunafuryWriteReceiverLight(productId: number, mode: LunaFuryReceiverLightMode) {
  if (![0, 2, 6, 11].includes(mode)) throw new Error("Unknown LunaFury receiver light mode.");
  return { ...lunafuryReadReceiverLight(productId), command: 0, args: [1, 0, mode] };
}

export function lunafuryDecodeReceiverLight(payload: Uint8Array | null): LunaFuryReceiverLightMode | undefined {
  return payload && payload.length >= 3 && payload[0] === 1 && [0, 2, 6, 11].includes(payload[2])
    ? payload[2] as LunaFuryReceiverLightMode : undefined;
}
