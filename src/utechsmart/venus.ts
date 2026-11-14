/**
 * UtechSmart Venus MMO wired, Holtek 04d9:fc55.
 * Memory layout, F2 replies, bare F3 writes, keyboard combos and the cited DPI
 * pairs were verified on the user's hardware by read probes/vendor UI/readback.
 * F1 meanings and F5 polling are inferred from a reverse-engineered Linux tool,
 * NOT hardware-verified. No Redragon session bracket, reset or LED memory writer.
 * This module has not itself been exercised against hardware. Callers must read
 * back after writing; persistence across power cycles is not established here.
 */
import {
  redragonEncodeRead, redragonEncodeWrite, redragonButtonCodec,
  REDRAGON_SINGLE_KEY_ACTION,
} from "../redragon/holtek.js";
import { REDRAGON_M724_DPI_LABELS, redragonM724EncodeDpi } from "../redragon/m724.js";
import { KEY_USAGES, NUMPAD_USAGES, keyName } from "../redragon/keys.js";

export const UTECHSMART_VENUS_VENDOR_ID = 0x04d9;
export const UTECHSMART_VENUS_PRODUCT_ID = 0xfc55;
export const UTECHSMART_VENUS_INTERFACE = 2;
export const UTECHSMART_VENUS_CONFIG_USAGE_PAGE = 0xffa0;
export const UTECHSMART_VENUS_CONFIG_USAGE = 0x01;
export const UTECHSMART_VENUS_REPORT_ID = 2;
export const UTECHSMART_VENUS_REPORT_SIZE = 16;
export const UTECHSMART_VENUS_LONG_REPORT_ID = 3;
export const UTECHSMART_VENUS_LONG_REPORT_SIZE = 64;
export const UTECHSMART_VENUS_MAX_READ = 56;
export const UTECHSMART_VENUS_MAX_WRITE = 8;
export const UTECHSMART_VENUS_PROFILE_COUNT = 5;
export const UTECHSMART_VENUS_MAX_STAGES = 10;
export const UTECHSMART_VENUS_BUTTON_COUNT = 20;
export const UTECHSMART_VENUS_ACTIVE_PROFILE_ADDRESS = 0x002c;
export const UTECHSMART_VENUS_PROFILE_BASES = [0x0040, 0x0100, 0x01b0, 0x0260, 0x0310] as const;
export const UTECHSMART_VENUS_BUTTON_BASES = [0x0080, 0x0140, 0x01f0, 0x02a0, 0x0350] as const;
export const UTECHSMART_VENUS_POLLING_RATES = [125, 250, 500, 1000] as const;

function integer(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`UtechSmart Venus ${name} ${value} is outside ${min}-${max}.`);
  }
}
function transfer(address: number, length: number, max: number): void {
  integer(address, 0, 0xffff, "address");
  integer(length, 1, max, "length");
  if (address + length > 0x10000) throw new Error("UtechSmart Venus transfer crosses 16-bit address space.");
}
function bytes(value: ArrayLike<number>, length: number): Uint8Array {
  if (value.length !== length) throw new Error(`UtechSmart Venus expected ${length} bytes.`);
  return Uint8Array.from(Array.from(value, (byte) => {
    integer(byte, 0, 255, "byte");
    return byte;
  }));
}

/** Hardware-confirmed F2 request, full 16-byte frame including report ID. */
export function utechsmartVenusEncodeRead(address: number, length: number): Uint8Array {
  transfer(address, length, UTECHSMART_VENUS_MAX_READ);
  // Same F2 request as Holtek Redragon; FC55 permits a longer GET_FEATURE reply.
  const frame = redragonEncodeRead(address, Math.min(length, 8));
  frame[4] = length;
  return frame;
}
/** Which GET_FEATURE report follows F2: 2 for <=8 bytes, otherwise 3 (<=56). */
export function utechsmartVenusReadReportId(length: number): 2 | 3 {
  integer(length, 1, UTECHSMART_VENUS_MAX_READ, "read length");
  return length <= 8 ? 2 : 3;
}
/**
 * Hardware-confirmed bare F3 write. Byte 5 stays zero; no checksum or ACK.
 * Bounds check is numeric only, NOT an address allowlist: unmapped addresses
 * can STALL the device. Prefer the scoped write planner over arbitrary writes.
 */
export function utechsmartVenusEncodeWrite(address: number, data: ArrayLike<number>): Uint8Array {
  transfer(address, data.length, UTECHSMART_VENUS_MAX_WRITE);
  return redragonEncodeWrite(address, data);
}
/**
 * Validate FC55's header and return a copy of the data. Accepts full reports or
 * report-ID-stripped bodies. The unreliable echo-low byte is deliberately ignored
 * even for odd addresses. Status checking may be disabled for unknown firmware.
 */
export function utechsmartVenusDecodeRead(
  answer: Uint8Array, address: number, length: number,
  options: { validateStatus?: boolean } = {},
): Uint8Array {
  transfer(address, length, UTECHSMART_VENUS_MAX_READ);
  const reportId = utechsmartVenusReadReportId(length);
  const body = answer[0] === reportId ? answer.subarray(1) : answer;
  if (body.length < 7 + length || body[0] !== 8 || body[3] !== length ||
      body[5] !== 0xfa || body[6] !== 0xfa ||
      (options.validateStatus !== false && body[2] !== ((0x60 + (address >> 8)) & 0xff))) {
    throw new Error("UtechSmart Venus unexpected read reply.");
  }
  return body.slice(7, 7 + length);
}

export type UtechsmartVenusControl = "enter" | "buttons" | "dpi" | "led" | "exit";
/** UNVERIFIED F1 meanings from the Linux tool. No reset command is exposed. */
export function utechsmartVenusEncodeControl(control: UtechsmartVenusControl): Uint8Array {
  const codes = { enter: 1, buttons: 2, dpi: 4, led: 8, exit: 16 } as const;
  if (!Object.hasOwn(codes, control)) throw new Error("UtechSmart Venus unknown control.");
  const frame = new Uint8Array(16);
  frame.set([2, 0xf1, 2, codes[control]]);
  return frame;
}
function pollingCode(hz: number): number {
  if (!UTECHSMART_VENUS_POLLING_RATES.some((rate) => rate === hz)) throw new Error(`UtechSmart Venus unsupported polling rate ${hz}.`);
  return 1000 / hz;
}
/** UNVERIFIED F5 polling command. Unlike Redragon, F5 is NOT a session bracket. */
export function utechsmartVenusEncodePolling(hz: number): Uint8Array {
  const frame = new Uint8Array(16);
  frame.set([2, 0xf5, pollingCode(hz)]);
  return frame;
}

/** Hardware-observed profile block; indexes throughout this API are zero-based. */
export function utechsmartVenusProfileAddress(profile: number): number {
  integer(profile, 0, 4, "profile");
  return UTECHSMART_VENUS_PROFILE_BASES[profile]!;
}
/** Hardware-observed polling record is [1000 / Hz, unknown] at 0x32 + 2p. */
export function utechsmartVenusPollAddress(profile: number): number {
  utechsmartVenusProfileAddress(profile);
  return 0x32 + 2 * profile;
}
/** Six-byte stage record [flag, code, range, unknown, unknown, unknown]. */
export function utechsmartVenusStageAddress(profile: number, stage: number): number {
  const base = utechsmartVenusProfileAddress(profile);
  // Ten-stage capacity is inferred from the reference tool; five observed.
  integer(stage, 0, 9, "stage");
  return base + 4 + 6 * stage;
}
/** Only slots 0-19, never the four trailing records or FF sentinel. */
export function utechsmartVenusButtonAddress(profile: number, slot: number): number {
  utechsmartVenusProfileAddress(profile);
  integer(slot, 0, 19, "button slot");
  return UTECHSMART_VENUS_BUTTON_BASES[profile]! + 2 + 4 * slot;
}

// M724_CODES is private. Derive the identical FC55 code table from the exported
// M724 codec/labels rather than duplicating src/redragon/m724.ts's 61-byte table.
const BASE_DPI_LABELS = REDRAGON_M724_DPI_LABELS.filter((dpi) => dpi <= 6200);
const BASE_CODES = BASE_DPI_LABELS.map((dpi) => redragonM724EncodeDpi(dpi).value);
/** Vendor label policy: x1, x2, x3, then the special 16400 cap/label. */
export const UTECHSMART_VENUS_DPI_LABELS: readonly number[] = [
  ...REDRAGON_M724_DPI_LABELS,
  ...Array.from({ length: 13 }, (_, i) => 12600 + i * 300), 16400,
];
export interface UtechsmartVenusDpiCode { dpi: number; value: number; range: 0 | 1 | 4 }
/** Snap to nearest vendor label (lower wins ties); reject outside 200-16400. */
export function utechsmartVenusEncodeDpi(dpi: number): UtechsmartVenusDpiCode {
  integer(dpi, 200, 16400, "DPI");
  let label = UTECHSMART_VENUS_DPI_LABELS[0]!;
  for (const candidate of UTECHSMART_VENUS_DPI_LABELS) {
    if (Math.abs(candidate - dpi) < Math.abs(label - dpi)) label = candidate;
  }
  if (label <= 12400) return redragonM724EncodeDpi(label);
  if (label === 16400) return { dpi: label, value: 124, range: 4 };
  return { dpi: label, value: redragonM724EncodeDpi(label / 3).value, range: 4 };
}
/**
 * Known-code lookup plus M724's 400/9 fallback rounded to 10 after scaling.
 * Range 4 triples; unknown ranges use x1 like the sibling, without throwing.
 * Status retains the raw code/range, so this fallback is not a semantic claim.
 */
export function utechsmartVenusDecodeDpi(value: number, range: number): number {
  if (value === 124 && range === 4) return 16400;
  const scale = range === 1 ? 2 : range === 4 ? 3 : 1;
  const index = BASE_CODES.indexOf(value);
  return index >= 0 ? BASE_DPI_LABELS[index]! * scale : Math.round(value * scale * 400 / 9 / 10) * 10;
}

/** Only FC55-observed actions; fire key and unsupported actions stay raw. */
export const UTECHSMART_VENUS_BUTTON_ACTIONS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["Left click", [0x81]], ["Right click", [0x82]], ["Middle click", [0x83]],
  ["Back", [0x84]], ["Forward", [0x85]], ["DPI down", [0x89]],
  ["DPI up", [0x8a]], ["Profile cycle", [0x8d]], ["Disabled", [0]],
];
const BUTTON_CODEC = redragonButtonCodec("FC55", UTECHSMART_VENUS_BUTTON_ACTIONS, [REDRAGON_SINGLE_KEY_ACTION, 0]);
const KEYS = [...KEY_USAGES, ...NUMPAD_USAGES];
export type UtechsmartVenusButtonAction =
  | { kind: "action"; name: string }
  | { kind: "key"; usage: number }
  | { kind: "combo"; modifiers: number; usage: number }
  | { kind: "raw"; bytes: Uint8Array };

/** Decode exactly four bytes; noncanonical and unknown actions round-trip raw. */
export function utechsmartVenusDecodeButtonAction(value: ArrayLike<number>): UtechsmartVenusButtonAction {
  const raw = bytes(value, 4);
  const name = BUTTON_CODEC.decode(raw);
  if (UTECHSMART_VENUS_BUTTON_ACTIONS.some(([action]) => action === name)) return { kind: "action", name };
  if (raw[0] === 0x90 && raw[1] === 0 && raw[3] === 0) return { kind: "key", usage: raw[2]! };
  if (raw[0] === 0x8f && raw[3] === 0) return { kind: "combo", modifiers: raw[1]!, usage: raw[2]! };
  return { kind: "raw", bytes: raw };
}
/** Preserve raw records; standard HID modifier bitmask includes right-side bits. */
export function utechsmartVenusEncodeButtonAction(action: UtechsmartVenusButtonAction): Uint8Array {
  switch (action.kind) {
    case "raw": return bytes(action.bytes, 4);
    case "action": {
      if (!UTECHSMART_VENUS_BUTTON_ACTIONS.some(([name]) => name === action.name)) throw new Error("UtechSmart Venus unknown button action.");
      return Uint8Array.from(BUTTON_CODEC.encode(action.name));
    }
    case "key": {
      integer(action.usage, 0, 255, "key usage");
      const key = KEY_USAGES.find(([, usage]) => usage === action.usage);
      return key ? Uint8Array.from(BUTTON_CODEC.encode(`Key ${key[0]}`)) : Uint8Array.from([0x90, 0, action.usage, 0]);
    }
    case "combo": {
      integer(action.usage, 0, 255, "key usage");
      integer(action.modifiers, 0, 255, "modifiers");
      // Shared codec covers named shortcuts. Arbitrary combos/keypad/right
      // modifiers need the same wire format but aren't offered by its encoder.
      const raw = [0x8f, action.modifiers, action.usage, 0];
      const name = BUTTON_CODEC.decode(raw);
      return Uint8Array.from(BUTTON_CODEC.options.includes(name) ? BUTTON_CODEC.encode(name) : raw);
    }
    default: throw new Error("UtechSmart Venus unknown button action kind.");
  }
}
/** Shared Holtek naming, extended for keypad and standard right modifiers. */
export function utechsmartVenusButtonActionName(action: UtechsmartVenusButtonAction): string {
  const raw = utechsmartVenusEncodeButtonAction(action);
  const shared = BUTTON_CODEC.decode(raw);
  if (action.kind === "key") {
    const key = KEYS.find(([, usage]) => usage === action.usage)?.[0];
    return key ? `Key ${key}` : shared;
  }
  if (action.kind === "combo") {
    const name = keyName(action.modifiers, action.usage, KEYS);
    if (name) return shared.startsWith("Vendor action") ? `Keys ${name}` : shared;
    const key = KEYS.find(([, usage]) => usage === action.usage)?.[0];
    if (key) {
      const modifiers = ["Ctrl", "Shift", "Alt", "Win", "Right Ctrl", "Right Shift", "Right Alt", "Right Win"];
      return `Keys ${[...modifiers.filter((_, bit) => action.modifiers & (1 << bit)), key].join("+")}`;
    }
  }
  return shared;
}

/** Contiguous memory excerpt; address is the absolute address of data[0]. */
export interface UtechsmartVenusMemory { address: number; data: Uint8Array }
function readMemory(memory: UtechsmartVenusMemory, address: number, length: number): Uint8Array {
  integer(memory.address, 0, 0xffff, "excerpt address");
  if (memory.address + memory.data.length > 0x10000) throw new Error("UtechSmart Venus excerpt exceeds address space.");
  const offset = address - memory.address;
  if (offset < 0 || offset + length > memory.data.length) throw new Error(`UtechSmart Venus excerpt missing bytes at 0x${address.toString(16)}.`);
  return memory.data.slice(offset, offset + length);
}
function profileHeader(memory: UtechsmartVenusMemory, profile: number): Uint8Array {
  const header = readMemory(memory, utechsmartVenusProfileAddress(profile), 4);
  integer(header[0]!, 1, 10, "enabled stage count");
  integer(header[2]!, 0, header[0]! - 1, "current stage");
  return header;
}
function buttonCount(memory: UtechsmartVenusMemory, profile: number): void {
  const count = readMemory(memory, utechsmartVenusButtonAddress(profile, 0) - 2, 2);
  if ((count[0]! | count[1]! << 8) !== 20) throw new Error("UtechSmart Venus unexpected button slot count.");
}
export interface UtechsmartVenusStage {
  dpi: number; value: number; range: number; raw: Uint8Array;
}
export interface UtechsmartVenusProfile {
  index: number; pollingHz: number | null; pollingCode: number;
  currentStage: number; stages: UtechsmartVenusStage[]; buttons: UtechsmartVenusButtonAction[];
}
export interface UtechsmartVenusStatus { activeProfile: number; profiles: UtechsmartVenusProfile[] }
/** Decode only observed settings, not LED/calibration memory. Requires all five profiles. */
export function utechsmartVenusDecodeStatus(memory: UtechsmartVenusMemory): UtechsmartVenusStatus {
  const activeProfile = readMemory(memory, UTECHSMART_VENUS_ACTIVE_PROFILE_ADDRESS, 1)[0]!;
  integer(activeProfile, 0, 4, "active profile");
  const profiles = Array.from({ length: 5 }, (_, index): UtechsmartVenusProfile => {
    const header = profileHeader(memory, index);
    const polling = readMemory(memory, utechsmartVenusPollAddress(index), 2)[0]!;
    buttonCount(memory, index);
    const stages = Array.from({ length: header[0]! }, (_, stage): UtechsmartVenusStage => {
      const raw = readMemory(memory, utechsmartVenusStageAddress(index, stage), 6);
      return { dpi: utechsmartVenusDecodeDpi(raw[1]!, raw[2]!), value: raw[1]!, range: raw[2]!, raw };
    });
    return {
      index, pollingHz: [1, 2, 4, 8].includes(polling) ? 1000 / polling : null, pollingCode: polling,
      currentStage: header[2]!, stages,
      buttons: Array.from({ length: 20 }, (_, slot) => utechsmartVenusDecodeButtonAction(readMemory(memory, utechsmartVenusButtonAddress(index, slot), 4))),
    };
  });
  return { activeProfile, profiles };
}

export type UtechsmartVenusChange =
  | { kind: "dpi"; profile: number; stage: number; dpi: number }
  | { kind: "currentStage"; profile: number; stage: number }
  | { kind: "polling"; profile: number; hz: number }
  | { kind: "button"; profile: number; slot: number; action: UtechsmartVenusButtonAction };
/**
 * Plan ONE change using current readback. Returns no frames for a no-op, otherwise
 * one minimal contiguous F3 span (<=4 bytes). Never mutates the excerpt, rewrites
 * unknown bytes, enables extra stages, touches trailing wheel records, or emits
 * F1/F5 automatically. A stage change requires its four-byte profile header plus
 * the six-byte stage record; button edits require count+slot; polling needs two
 * bytes. Refresh readback before planning and verify again after applying.
 * Writes applying bare was confirmed; durability/commit requirements remain open.
 */
export function utechsmartVenusPlanWrite(memory: UtechsmartVenusMemory, change: UtechsmartVenusChange): Uint8Array[] {
  let address: number;
  let before: Uint8Array;
  let after: Uint8Array;
  switch (change.kind) {
    case "dpi":
    case "currentStage": {
      const header = profileHeader(memory, change.profile);
      integer(change.stage, 0, header[0]! - 1, "enabled stage");
      if (change.kind === "currentStage") {
        address = utechsmartVenusProfileAddress(change.profile) + 2;
        before = header.slice(2, 3);
        after = Uint8Array.of(change.stage);
      } else {
        address = utechsmartVenusStageAddress(change.profile, change.stage);
        before = readMemory(memory, address, 6);
        after = before.slice();
        const encoded = utechsmartVenusEncodeDpi(change.dpi);
        after[1] = encoded.value;
        after[2] = encoded.range;
      }
      break;
    }
    case "polling": {
      address = utechsmartVenusPollAddress(change.profile);
      before = readMemory(memory, address, 2);
      after = before.slice();
      after[0] = pollingCode(change.hz);
      break;
    }
    case "button": {
      address = utechsmartVenusButtonAddress(change.profile, change.slot);
      buttonCount(memory, change.profile);
      before = readMemory(memory, address, 4);
      after = utechsmartVenusEncodeButtonAction(change.action);
      break;
    }
    default: throw new Error("UtechSmart Venus unsupported change.");
  }
  let first = 0;
  while (first < before.length && before[first] === after[first]) first++;
  if (first === before.length) return [];
  let end = before.length;
  while (before[end - 1] === after[end - 1]) end--;
  return [utechsmartVenusEncodeWrite(address + first, after.slice(first, end))];
}
