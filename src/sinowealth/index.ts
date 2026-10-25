/**
 * SiNoWealth (`258a`) bank framing profiles.
 *
 * SiNoWealth firmware (libratbag's `driver-sinowealth.c` documents the same
 * framing, MIT) exposes its settings as one bank addressed by a short command
 * on feature report 5: the command selects what feature report 8 answers or
 * accepts, and settings travel as one block that is read, modified and
 * written back whole. The framing is shared, the banks inside it are not:
 * byte 9 of the settings bank and the ASCII identify answer tell the devices
 * apart ("2945"/0x13 is the Redragon M690 PRO, "2315"/0x11 is the Cosmic Byte
 * Kilonova 3335IC).
 *
 * The M690 PRO, the framing's first fully decoded member, keeps its codec in
 * `@openmouse/protocol/redragon`; the shared numbers here duplicate it
 * deliberately and are pinned together by `index.test.ts`, so the two
 * listings cannot silently diverge. This module is where a third member's
 * footprints would go.
 *
 * Evidence: the Redragon bank's USBPcap captures
 * (docs/redragon-m690-pro-testing.md) and a read-only probing session against
 * a Cosmic Byte Kilonova 3335IC dongle under Windows with node-hid
 * (docs/kilonova-3335ic.md).
 */

export const SINOWEALTH_VENDOR_ID = 0x258a;
/** Vendor collection on USB interface 1 carrying feature reports 5 and 8. */
export const SINOWEALTH_USAGE_PAGE = 0xff00;
export const SINOWEALTH_USAGE = 0x01;

/** 7-byte feature report (report id extra on the wire): commands and their answers. */
export const SINOWEALTH_COMMAND_REPORT_ID = 5;
export const SINOWEALTH_COMMAND_LENGTH = 8;
/** 519-byte feature report (report id extra): settings and button banks. */
export const SINOWEALTH_BLOCK_REPORT_ID = 8;
export const SINOWEALTH_BLOCK_LENGTH = 520;

export const SINOWEALTH_CMD_IDENTIFY = 0x01;
/** Receiver only: whether the mouse is linked (`[05 80 01 ..]`) or off/asleep (`[05 80 00 ..]`). */
export const SINOWEALTH_CMD_LINK = 0x80;
/** Polled every 30 s by the vendor apps: connection and battery. */
export const SINOWEALTH_CMD_STATUS = 0x90;

/** Settings-bank length, report id included. */
export const SINOWEALTH_CONFIG_LENGTH = 154;
/** Button-bank length, report id included. */
export const SINOWEALTH_BUTTONS_LENGTH = 88;
/**
 * Byte 9 of the settings bank is the model byte. The identify answer (report
 * 5) is the stronger footprint, but browsers read feature reports at the
 * device's largest size (520 bytes) and the firmware STALLs a short report-5
 * read, so the model byte stands in for it in browsers.
 */
const OFFSET_MODEL = 0x09;

export interface SinowealthBankDevice {
  /** ASCII string the identify command answers, exactly: "2315" on the Kilonova 3335IC. */
  deviceId: string;
  /** Byte 9 of every settings bank seen; what the browser-viable check reads. */
  modelByte: number;
  /** The brand OpenMouse reports for the device, as `MouseStatus["brand"]` spells it. */
  brand: "Redragon" | "Cosmic Byte";
  name: string;
}

/**
 * The banks the codecs know so far. The M690 PRO's numbers duplicate
 * `@openmouse/protocol/redragon`'s (see `index.test.ts`).
 */
export const SINOWEALTH_M690_PRO: SinowealthBankDevice = {
  deviceId: "2945",
  modelByte: 0x13,
  brand: "Redragon",
  name: "M690 PRO",
};

/**
 * The Cosmic Byte Kilonova 3335IC's dongle (SiNoWealth `258a:002f`, the M690
 * PRO receiver's id). Its settings bank shares the lengths and the `a5 00`
 * end marker but its interior layout is not decoded (its stage-table bytes do
 * not name the M690 PRO's DPI list), so this profile carries identity only;
 * see docs/kilonova-3335ic.md for the captures and open questions.
 */
export const SINOWEALTH_KILONOVA_3335IC: SinowealthBankDevice = {
  deviceId: "2315",
  modelByte: 0x11,
  brand: "Cosmic Byte",
  name: "Kilonova 3335IC",
};

/** Every bank-framing device a codec lists, in discovery order. */
export const SINOWEALTH_BANK_DEVICES: readonly SinowealthBankDevice[] = [
  SINOWEALTH_M690_PRO,
  SINOWEALTH_KILONOVA_3335IC,
];

/** Resolves a settings bank to the device it belongs to, or null when it is not one. */
export function sinowealthDeviceOfBlock(block: Uint8Array): SinowealthBankDevice | null {
  if (block.length < SINOWEALTH_CONFIG_LENGTH) return null;
  return SINOWEALTH_BANK_DEVICES.find((device) => device.modelByte === block[OFFSET_MODEL]) ?? null;
}

/** A 7-byte command frame, report id first: `[05 cmd 00 00 00 00 00 00]`. */
export function sinowealthEncodeCommand(command: number): Uint8Array {
  const frame = new Uint8Array(SINOWEALTH_COMMAND_LENGTH);
  frame[0] = SINOWEALTH_COMMAND_REPORT_ID;
  frame[1] = command;
  return frame;
}

/** Throws unless `reply` is report 5 answering `command`. */
export function sinowealthCheckCommandReply(reply: Uint8Array, command: number): void {
  if (reply.length < 4 || reply[0] !== SINOWEALTH_COMMAND_REPORT_ID || reply[1] !== command) {
    throw new Error(`The SiNoWealth device answered command 0x${command.toString(16)} with ${reply.length} bytes starting ${replyHex(reply.subarray(0, 8))}.`);
  }
}

/**
 * Throws unless `block` is a report-8 answer to `command` long enough to hold
 * `length` bytes. The settings bank also ends in the family's `a5 00` marker
 * (captured on the M690 PRO and the Kilonova 3335IC alike); the marker fits
 * inside a 520-byte read, beyond `length`.
 */
export function sinowealthCheckBlock(block: Uint8Array, command: number, length: number): void {
  if (block.length < length || block[0] !== SINOWEALTH_BLOCK_REPORT_ID || block[1] !== command) {
    throw new Error(`The SiNoWealth device answered block 0x${command.toString(16)} with ${block.length} bytes starting ${replyHex(block.subarray(0, 8))}.`);
  }
  if (length === SINOWEALTH_CONFIG_LENGTH && block[length - 2] !== 0xa5) {
    throw new Error("The SiNoWealth settings bank lacks its a5 end marker; not using it.");
  }
}

/** `[05 01 32 33 31 35 ..]` -> "2315". */
export function sinowealthDecodeIdentity(reply: Uint8Array): string {
  sinowealthCheckCommandReply(reply, SINOWEALTH_CMD_IDENTIFY);
  return String.fromCharCode(...reply.subarray(2, 6));
}

/** `[05 80 01 01 ..]` linked; `[05 80 00 01 ..]` mouse off or asleep. */
export function sinowealthDecodeLink(reply: Uint8Array): boolean {
  sinowealthCheckCommandReply(reply, SINOWEALTH_CMD_LINK);
  return reply[2] === 0x01;
}

export interface SinowealthStatus {
  wireless: boolean;
  /** Battery percent: the receiver's byte, or 100 once a cable reports the battery charged. */
  batteryPercent: number | null;
  /** Over a cable only: `01` charging, `02` charged (M690 PRO captures). */
  charge: "Charging" | "Full" | null;
  raw: number;
}

/**
 * `[05 90 11 46 ..]` through a receiver: bit 0 of byte 2 selects wireless
 * and byte 3 is the battery percent (captured 0x46 -> 70 on the Kilonova
 * 3335IC's dongle, the M690 PRO receiver answers the same shape with 0x64 ->
 * 100). Over a cable byte 3 is the charge state (`01` charging, `02`
 * charged) per the M690 PRO captures; no wired Kilonova path has been seen.
 */
export function sinowealthDecodeStatus(reply: Uint8Array): SinowealthStatus {
  sinowealthCheckCommandReply(reply, SINOWEALTH_CMD_STATUS);
  const wireless = (reply[2]! & 0x01) === 0x01;
  const raw = reply[3]!;
  if (wireless) return { wireless, batteryPercent: raw <= 100 ? raw : null, charge: null, raw };
  const charge = raw === 0x01 ? "Charging" : raw === 0x02 ? "Full" : null;
  return { wireless, batteryPercent: charge === "Full" ? 100 : null, charge, raw };
}

function replyHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/**
 * The Kilonova 3335IC's DPI stage table lives in the settings bank at
 * OFFSET_KILONOVA_STAGE_DPI (0x0d): six 16-bit little-endian values that are
 * 0-based indexes; the DPI is `(index + 1) * 100`. The active stage is the
 * high nibble of byte 0x0b (1-based, same as the M690 PRO), and the stage
 * count is the low nibble of 0x0b.
 *
 * Captured bank: 0x0b=0x36 (6 stages, active=3), 0x0d..0x18 LE16=[3,7,15,31,63,159]
 * -> stages 1..6 = 400, 800, 1600, 3200, 6400, 16000 DPI.
 * Mouse power-on boots to the saved active stage (3); the first DPI-button
 * press reports stage 4 (report 7: [11 04 04 1f ...]), confirming 1-based
 * active stage semantics.
 *
 * Polling rate: byte 0x0a low nibble matches the M690 PRO's codes
 * (1=125, 2=250, 3=500, 4=1000) based on captured bank (0x04 -> 1000 Hz).
 */
const KILONOVA_STAGE_COUNT = 6;
const KILONOVA_STAGE_DPI_OFFSETS = [0x0d, 0x0f, 0x11, 0x13, 0x15, 0x17];
export const KILONOVA_POLLING_CODES: Readonly<Record<number, number>> = {
  125: 0x01,
  250: 0x02,
  500: 0x03,
  1000: 0x04,
};
export const KILONOVA_POLLING_RATES = [125, 250, 500, 1000] as const;

export function sinowealthDecodeKilonovaConfig(block: Uint8Array): { stageCount: number; activeStage: number; dpiStages: number[]; pollingHz: number | null } {
  if (block.length < SINOWEALTH_CONFIG_LENGTH) throw new Error("Kilonova block too short");
  const stageCount = block[0x0b]! & 0x0f;
  if (stageCount === 0 || stageCount > KILONOVA_STAGE_COUNT) throw new Error(`Kilonova stage count ${stageCount} invalid`);
  const activeStage = (block[0x0b]! >> 4) - 1;
  if (activeStage < 0 || activeStage >= stageCount) throw new Error(`Kilonova active stage ${activeStage} out of range`);
  const dpiStages: number[] = [];
  for (let i = 0; i < stageCount; i++) {
    const offset = KILONOVA_STAGE_DPI_OFFSETS[i]!;
    const index = block[offset]! | (block[offset + 1]! << 8);
    if (index > 0xffff) throw new Error(`Kilonova stage ${i} index ${index} out of range`);
    dpiStages.push((index + 1) * 100);
  }
  const pollingCode = block[0x0a]! & 0x0f;
  const pollingHz = pollingCode === 0x01 ? 125 : pollingCode === 0x02 ? 250 : pollingCode === 0x03 ? 500 : pollingCode === 0x04 ? 1000 : null;
  return { stageCount, activeStage, dpiStages, pollingHz };
}

export function sinowealthWithKilonovaPollingRate(block: Uint8Array, hz: number): Uint8Array {
  const code = KILONOVA_POLLING_CODES[hz];
  if (code === undefined) throw new Error(`Kilonova polling rate ${hz} Hz is not one of ${KILONOVA_POLLING_RATES.join(", ")}.`);
  const next = Uint8Array.from(block.subarray(0, SINOWEALTH_CONFIG_LENGTH));
  next[0x0a] = (next[0x0a]! & 0xf0) | code;
  return next;
}

export function sinowealthWithKilonovaActiveStage(block: Uint8Array, stage: number): Uint8Array {
  if (!Number.isInteger(stage) || stage < 0 || stage >= KILONOVA_STAGE_COUNT) {
    throw new Error(`Kilonova DPI stage ${stage} is outside 0-${KILONOVA_STAGE_COUNT - 1}.`);
  }
  const next = Uint8Array.from(block.subarray(0, SINOWEALTH_CONFIG_LENGTH));
  const stageCount = next[0x0b]! & 0x0f;
  if (stage >= stageCount) throw new Error(`Kilonova DPI stage ${stage} is outside active stages.`);
  next[0x0b] = ((stage + 1) << 4) | (next[0x0b]! & 0x0f);
  return next;
}

// Kilonova uses index+1 formula: DPI = (index+1)*100, so index = (DPI/100)-1
export function sinowealthWithKilonovaStageDpi(block: Uint8Array, stage: number, dpi: number): Uint8Array {
  if (!Number.isInteger(stage) || stage < 0 || stage >= KILONOVA_STAGE_COUNT) {
    throw new Error(`Kilonova DPI stage ${stage} is outside 0-${KILONOVA_STAGE_COUNT - 1}.`);
  }
  if (dpi % 100 !== 0 || dpi < 400 || dpi > 16000) {
    throw new Error(`Kilonova DPI ${dpi} is not supported.`);
  }
  const index = (dpi / 100) - 1;
  if (index < 0 || index > 0xffff) throw new Error(`Kilonova DPI ${dpi} is out of range.`);
  const next = Uint8Array.from(block.subarray(0, SINOWEALTH_CONFIG_LENGTH));
  const offset = KILONOVA_STAGE_DPI_OFFSETS[stage]!;
  next[offset] = index & 0xff;
  next[offset + 1] = (index >> 8) & 0xff;
  return next;
}
