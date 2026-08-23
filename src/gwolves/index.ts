/**
 * G-Wolves HTX Ultra protocol, pure functions, unit-tested without WebHID.
 *
 * G-Wolves mice enumerate under G-Wolves' own vendor id (0x33e4) but speak
 * the exact same wire protocol as the shared VGN-family reference design
 * already implemented independently in this repo for the VGN Dragonfly F2
 * Master+ and (as `pulsarVgn*` in pulsar/index.ts) the Pulsar 4K Wireless
 * Receiver: 16-byte packets on report id 8, opcode 0x07 writes an EEPROM
 * address and 0x08 reads one, and every packet's bytes (plus the report id)
 * sum to 0x55. Following the pattern already established for the Pulsar/VGN
 * case, this is an independent implementation rather than an import of
 * vgn/index.ts's functions — same algorithm, kept as its own module so a
 * G-Wolves-specific quirk (like ATK's differing DPI stage encoding
 * relative to Endgame Gear WE) can diverge cleanly later without touching
 * code another brand's driver depends on.
 *
 * Confirmed against real hardware 2026-08-21: a live HID capture (browser
 * sendReport/inputreport patch) while changing DPI, LOD, and polling rate
 * on the official G-Wolves web driver at mouse.fit, then independently
 * reproduced with hidapitester with no browser involved at all. See
 * PROTOCOL-NOTES.md in the PR for the raw captured packets this was
 * verified against.
 */

export const GWOLVES_REPORT_ID = 0x08;
export const GWOLVES_PAYLOAD_LENGTH = 16;
export const GWOLVES_MAX_CHUNK = 10;

export const GWOLVES_COMMAND = {
  handshake: 0x01,
  online: 0x03,
  battery: 0x04,
  write: 0x07,
  read: 0x08,
  profile: 0x0e,
  firmware: 0x12,
  dongleFirmware: 0x1d,
} as const;

export const GWOLVES_ADDRESS = {
  pollingRate: 0x00,
  dpiStageCount: 0x02,
  activeDpiStage: 0x04,
  lod: 0x0a,
  dpiStages: 0x0c,
  debounce: 0xa9,
  motionSync: 0xab,
  sleep: 0xad,
  angleSnapping: 0xaf,
  rippleControl: 0xb1,
  performanceMode: 0xb5,
} as const;

export interface GWolvesBattery {
  percent: number;
  charging: boolean;
  voltageMv: number;
}

export interface GWolvesProfile {
  dpi: number;
  dpiStageCount: number;
  activeDpiStage: number;
  pollingRateHz: number;
  liftOffDistance: "Low" | "Medium" | "High" | null;
  debounceMs: number | null;
  sleepTimeout: number | null;
  motionSync: boolean | null;
  angleSnapping: boolean | null;
  rippleControl: boolean | null;
  performanceMode: boolean | null;
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${label} must be one byte.`);
  }
}

export function gwolvesReportChecksum(data15: Iterable<number>): number {
  let sum = GWOLVES_REPORT_ID;
  for (const byte of data15) sum += byte & 0xff;
  return (0x55 - (sum & 0xff)) & 0xff;
}

export function gwolvesReportChecksumIsValid(payload: Uint8Array | readonly number[]): boolean {
  if (payload.length !== GWOLVES_PAYLOAD_LENGTH) return false;
  return ((GWOLVES_REPORT_ID + [...payload].reduce((sum, byte) => sum + (byte & 0xff), 0)) & 0xff) === 0x55;
}

function finalize(payload: Uint8Array): Uint8Array {
  payload[15] = gwolvesReportChecksum(payload.subarray(0, 15));
  return payload;
}

export function gwolvesBuildSimplePayload(command: number): Uint8Array {
  assertByte(command, "G-Wolves command");
  const payload = new Uint8Array(GWOLVES_PAYLOAD_LENGTH);
  payload[0] = command;
  return finalize(payload);
}

export function gwolvesBuildReadPayload(address: number, length: number): Uint8Array {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) throw new Error("G-Wolves address is out of range.");
  if (!Number.isInteger(length) || length < 1 || length > GWOLVES_MAX_CHUNK) throw new Error("G-Wolves read length must be 1–10 bytes.");
  const payload = gwolvesBuildSimplePayload(GWOLVES_COMMAND.read);
  payload[2] = address >> 8;
  payload[3] = address & 0xff;
  payload[4] = length;
  return finalize(payload);
}

export function gwolvesBuildWritePayload(address: number, data: readonly number[]): Uint8Array {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) throw new Error("G-Wolves address is out of range.");
  if (data.length < 1 || data.length > GWOLVES_MAX_CHUNK) throw new Error("G-Wolves write length must be 1–10 bytes.");
  const payload = gwolvesBuildSimplePayload(GWOLVES_COMMAND.write);
  payload[2] = address >> 8;
  payload[3] = address & 0xff;
  payload[4] = data.length;
  payload.set(data.map((byte) => byte & 0xff), 5);
  return finalize(payload);
}

export function gwolvesBuildWriteScalarPayload(address: number, value: number): Uint8Array {
  assertByte(value, "G-Wolves scalar");
  return gwolvesBuildWritePayload(address, [value, (0x55 - value) & 0xff]);
}

export function gwolvesParseReadResponse(response: Uint8Array, address: number, length: number): Uint8Array | null {
  if (!gwolvesReportChecksumIsValid(response)) return null;
  if (response[0] !== GWOLVES_COMMAND.read || response[1] !== 0) return null;
  if (response[2] !== ((address >> 8) & 0xff) || response[3] !== (address & 0xff)) return null;
  if (response[4] !== length || response.length < 5 + length) return null;
  return response.slice(5, 5 + length);
}

export function gwolvesParseBattery(response: Uint8Array): GWolvesBattery | null {
  if (!gwolvesReportChecksumIsValid(response) || response[0] !== GWOLVES_COMMAND.battery || response[1] !== 0) return null;
  const percent = response[5];
  if (percent === undefined || percent > 100) return null;
  return {
    percent,
    charging: response[6] === 1,
    voltageMv: ((response[7] ?? 0) << 8) | (response[8] ?? 0),
  };
}

// Confirmed on real hardware across all 7 rates: rates <=1000Hz encode as the
// polling period in whole milliseconds (1000/rate); rates above 1000Hz can't
// be a whole-ms period, so the firmware switches to a one-hot bit flag
// instead (bit 4/5/6 for 2000/4000/8000Hz respectively).
export function gwolvesEncodePollingRate(rate: number): number {
  const raw: Record<number, number> = { 125: 8, 250: 4, 500: 2, 1000: 1, 2000: 16, 4000: 32, 8000: 64 };
  const value = raw[rate];
  if (value === undefined) throw new Error("G-Wolves polling rate must be 125, 250, 500, 1000, 2000, 4000, or 8000 Hz.");
  return value;
}

export function gwolvesDecodePollingRate(raw: number): number | null {
  return ({ 8: 125, 4: 250, 2: 500, 1: 1000, 16: 2000, 32: 4000, 64: 8000 } as Record<number, number>)[raw] ?? null;
}

// Confirmed on real hardware (1600 <-> 1650 DPI captures): 4-byte stage
// entries, [xStep, xStep, flags, checksum], flat 50-DPI steps encoded as
// step-1, with the checksum making all 4 payload bytes sum to 0x55.
export function gwolvesEncodeDpi(dpi: number): Uint8Array {
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 26000 || dpi % 50 !== 0) {
    throw new Error("G-Wolves DPI must be 50–26,000 in 50 DPI steps.");
  }
  const encoded = dpi / 50 - 1;
  const low = encoded & 0xff;
  const high = (encoded >> 8) & 0x03;
  const flags = (high << 2) | (high << 6);
  return new Uint8Array([low, low, flags, (0x55 - low - low - flags) & 0xff]);
}

export function gwolvesDecodeDpi(stage: Uint8Array | readonly number[]): number | null {
  if (stage.length < 4) return null;
  const low = stage[0]! & 0xff;
  const duplicate = stage[1]! & 0xff;
  const flags = stage[2]! & 0xff;
  const checksum = stage[3]! & 0xff;
  if (low !== duplicate || ((low + duplicate + flags + checksum) & 0xff) !== 0x55) return null;
  return ((((flags >> 2) & 0x03) << 8) + low + 1) * 50;
}

export function gwolvesUnpackScalar(value: number, parity: number): number | null {
  return ((value + parity) & 0xff) === 0x55 ? value : null;
}

// Confirmed on real hardware: LOD Low=3, Medium=1, High=2 (not sequential —
// this is the firmware's own internal ordering).
export function gwolvesDecodeProfile(profile: Uint8Array): GWolvesProfile {
  const scalar = (address: number): number | null => profile.length > address + 1
    ? gwolvesUnpackScalar(profile[address]!, profile[address + 1]!)
    : null;
  const stageCount = Math.min(Math.max(scalar(GWOLVES_ADDRESS.dpiStageCount) ?? 1, 1), 8);
  const activeStage = Math.min(Math.max(scalar(GWOLVES_ADDRESS.activeDpiStage) ?? 0, 0), stageCount - 1);
  const stageOffset = GWOLVES_ADDRESS.dpiStages + activeStage * 4;
  const dpi = gwolvesDecodeDpi(profile.subarray(stageOffset, stageOffset + 4)) ?? 800;
  const lodRaw = scalar(GWOLVES_ADDRESS.lod);
  const pollingRaw = scalar(GWOLVES_ADDRESS.pollingRate);
  const boolean = (address: number): boolean | null => {
    const value = scalar(address);
    return value === null ? null : value !== 0;
  };

  return {
    dpi,
    dpiStageCount: stageCount,
    activeDpiStage: activeStage,
    pollingRateHz: pollingRaw === null ? 1000 : (gwolvesDecodePollingRate(pollingRaw) ?? 1000),
    liftOffDistance: lodRaw === 3 ? "Low" : lodRaw === 1 ? "Medium" : lodRaw === 2 ? "High" : null,
    debounceMs: scalar(GWOLVES_ADDRESS.debounce),
    sleepTimeout: (scalar(GWOLVES_ADDRESS.sleep) ?? 0) * 10 || null,
    motionSync: boolean(GWOLVES_ADDRESS.motionSync),
    angleSnapping: boolean(GWOLVES_ADDRESS.angleSnapping),
    rippleControl: boolean(GWOLVES_ADDRESS.rippleControl),
    performanceMode: boolean(GWOLVES_ADDRESS.performanceMode),
  };
}
