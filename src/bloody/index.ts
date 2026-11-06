/**
 * A4Tech Bloody gaming mouse protocol implementation.
 *
 * Reverse-engineered from:
 * - https://github.com/maxmati/a4tech-bloody-linux-driver
 * - https://gitlab.com/C0rn3j/a4tech_bloody_p85_driver (data.txt protocol notes)
 *
 * Bloody mice expose a vendor-defined HID collection (usage page 0xFF00-0xFFFF)
 * on USB Interface 2. All configuration commands and status queries use
 * 72-byte HID Feature Reports with Report ID 0x07.
 */

export const BLOODY_VENDOR_ID = 0x09da; // A4Tech Co., Ltd.
export const BLOODY_W70_MAX_PRODUCT_ID = 0x1865;
export const BLOODY_W70_MAX_ALT_PRODUCT_ID = 0x79ef;

export const BLOODY_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [BLOODY_W70_MAX_PRODUCT_ID, "Bloody W70 Max"],
  [BLOODY_W70_MAX_ALT_PRODUCT_ID, "Bloody W70 Max"],
]);

export const BLOODY_PRODUCT_IDS: readonly number[] = [...BLOODY_PRODUCT_NAMES.keys()];

/** Feature report ID used for all configuration commands. */
export const BLOODY_REPORT_ID = 0x07;
/** Feature report payload size in bytes (excluding report ID). */
export const BLOODY_REPORT_SIZE = 63;

/** Supported polling rates in Hz. */
export const BLOODY_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

export const BLOODY_DPI_MIN = 100;
export const BLOODY_DPI_MAX = 10000;
export const BLOODY_DPI_STEP = 100;
/** Unit of the legacy 0x02 sensitivity table (DPI / 50 per byte). */
export const BLOODY_LEGACY_DPI_UNIT = 50;

/**
 * Mapping between polling rates (Hz) and Bloody protocol codes.
 * 0x01: 1000 Hz, 0x02: 500 Hz, 0x04: 250 Hz, 0x08: 125 Hz.
 */
export const BLOODY_POLLING_CODE_MAP = {
  1000: 0x01,
  500: 0x02,
  250: 0x04,
  125: 0x08,
} as const;

/**
 * Converts a Bloody protocol polling code byte to Hertz.
 *
 * @param code - Raw protocol code byte (e.g. 0x01 for 1000 Hz).
 * @returns Polling frequency in Hz, or null if code is unrecognized.
 */
export function bloodyPollingCodeToHz(code: number): number | null {
  switch (code) {
    case 0x01: return 1000;
    case 0x02: return 500;
    case 0x04: return 250;
    case 0x08: return 125;
    default: return null;
  }
}

/**
 * Converts a polling frequency in Hertz to the Bloody protocol code byte.
 *
 * @param hz - Polling frequency in Hz (125, 250, 500, or 1000).
 * @returns Corresponding Bloody protocol byte (defaults to 0x01 for 1000 Hz).
 */
export function bloodyHzToPollingCode(hz: number): number {
  switch (hz) {
    case 125: return 0x08;
    case 250: return 0x04;
    case 500: return 0x02;
    case 1000: return 0x01;
    default: return 0x01;
  }
}

/**
 * Builds the 63-byte query report for sensitivity / DPI stages (command 0x02).
 *
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildSensitivityQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x02;
  buffer[2] = 0x2a;
  buffer[4] = 0x60;
  return buffer;
}

/**
 * Builds the 63-byte query report for current polling rate and operational status (command 0x0e).
 *
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildPollingQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x0e;
  return buffer;
}

/**
 * Builds the 63-byte query report for device ID and model info (command 0x05).
 *
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildDeviceQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x05;
  return buffer;
}

/**
 * Builds the 63-byte query report for backlight brightness (command 0x11).
 *
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildBacklightQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x11;
  return buffer;
}

/**
 * Builds the 63-byte command to set backlight brightness level (command 0x11).
 *
 * @param level - Brightness level (0: Off, 1: 25%, 2: 50%, 3: 100%).
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildSetBacklight(level: number): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x11;
  buffer[3] = 0x80; // Set command flag
  buffer[7] = Math.max(0, Math.min(3, Math.round(level)));
  return buffer;
}

/**
 * Builds the 63-byte command to commit and save current settings to mouse memory (command 0x0a).
 *
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildSaveCommand(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x0a;
  return buffer;
}

/**
 * Validates that a DPI value can be encoded in the single-byte raw step code.
 *
 * The raw step encoding is 100-DPI granular and only fits a byte up to
 * {@link BLOODY_DPI_MAX}; anything else would silently alias or wrap.
 *
 * @param dpi - Sensitivity in DPI.
 * @throws RangeError if the value is not an encodable DPI.
 */
export function bloodyValidateDpi(dpi: number): void {
  if (!Number.isInteger(dpi) || dpi < BLOODY_DPI_MIN || dpi > BLOODY_DPI_MAX || dpi % BLOODY_DPI_STEP !== 0) {
    throw new RangeError(`DPI ${dpi} must be a multiple of ${BLOODY_DPI_STEP} between ${BLOODY_DPI_MIN} and ${BLOODY_DPI_MAX}`);
  }
}

/**
 * Converts a DPI value to the Bloody protocol raw step code byte.
 *
 * @param dpi - Sensitivity in DPI (e.g. 1000).
 * @returns Raw step code byte used in Bloody sensitivity tables and commands.
 */
export function bloodyDpiToRawStep(dpi: number): number {
  bloodyValidateDpi(dpi);
  const input = dpi / 100;
  let x = 0;
  for (let i = 0; i < input; i++) {
    if (i % 3 === 1) x++;
  }
  const y = input - x - 1;
  return (0x01 + 0x03 * x + 0x02 * y) & 0xff;
}

/**
 * Builds the 63-byte command to set current DPI stage, active stage, and polling rate (command 0x0d).
 *
 * @param dpi - Sensitivity in DPI for the active stage.
 * @param activeStage - Zero-based index of the active stage (0..4).
 * @param totalStages - Total number of enabled stages (1..5).
 * @param pollingHz - Operational polling rate in Hz (125, 250, 500, or 1000).
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildSetDpi(
  dpi: number,
  activeStage = 0,
  totalStages = 5,
  pollingHz = 1000,
): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x0d;
  buffer[7] = Math.max(0, Math.min(4, totalStages - 1));
  buffer[8] = Math.max(0, Math.min(4, activeStage));
  buffer[9] = 0x40;
  buffer[10] = 0x40;
  buffer[11] = bloodyDpiToRawStep(dpi);
  buffer[12] = bloodyHzToPollingCode(pollingHz);
  return buffer;
}

export interface BloodyDeviceStatus {
  dpi: number;
  activeStage: number;
  modesEnabled: number;
}

/**
 * Decodes active DPI, stage index, and enabled stage count from command 0x05 response.
 *
 * @param reply - Raw HID response buffer from command 0x05.
 * @returns Parsed device status, or null if the response is invalid or not command 0x05.
 */
export function bloodyDecodeDeviceStatus(reply: Uint8Array): BloodyDeviceStatus | null {
  const bytes = reply.length > 0 && reply[0] === BLOODY_REPORT_ID ? reply.subarray(1) : reply;
  if (bytes.length < 12 || bytes[0] !== 0x05) return null;
  const dpi = bytes[9] | (bytes[10] << 8);
  return {
    dpi: dpi > 0 ? dpi : 1000,
    activeStage: bytes[8] ?? 0,
    modesEnabled: (bytes[7] ?? 0) + 1,
  };
}

/**
 * Builds the 63-byte command to update legacy sensitivity stages in mouse memory (command 0x02).
 *
 * @param stages - Array of DPI values for each stage.
 * @param activeStageIndex - Zero-based index of the active stage.
 * @param baseBuffer - Optional base report buffer to preserve unrelated fields.
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildSensitivitySet(
  stages: readonly number[],
  activeStageIndex: number,
  baseBuffer?: Uint8Array | null,
): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  if (baseBuffer && baseBuffer.length >= 25) {
    const src = baseBuffer[0] === BLOODY_REPORT_ID ? baseBuffer.subarray(1) : baseBuffer;
    buffer.set(src.subarray(0, Math.min(buffer.length, src.length)));
  } else {
    buffer[0] = 0x02;
    buffer[2] = 0x2a;
    buffer[4] = 0x60;
  }
  // Setting command flags
  buffer[0] = 0x02;
  buffer[7] = 0xff;
  buffer[8] = 0xff;

  const totalStages = Math.min(5, Math.max(1, stages.length));
  buffer[15] = totalStages - 1;
  buffer[17] = Math.min(totalStages - 1, Math.max(0, activeStageIndex));

  for (let i = 0; i < totalStages; i++) {
    const dpi = stages[i] ?? 1000;
    const offset = 19 + i * 6;
    const step = bloodyDpiToRawStep(dpi);
    const dpiStep = Math.max(1, Math.min(255, Math.round(dpi / BLOODY_LEGACY_DPI_UNIT)));
    buffer[offset] = step;
    buffer[offset + 1] = dpiStep;
    buffer[offset + 2] = step;
    buffer[offset + 3] = dpiStep;
    buffer[offset + 4] = 0x00;
    buffer[offset + 5] = 0x00;
  }
  return buffer;
}

/**
 * Builds the 63-byte command to unlock or lock flash programming mode (command 0x20).
 *
 * @param unlock - True to unlock flash programming mode (0x01), false to lock (0x00).
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildFlashUnlock(unlock: boolean): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x20;
  buffer[6] = unlock ? 0x01 : 0x00;
  return buffer;
}

/**
 * Builds the 63-byte command to write a 32-byte chunk to flash memory (command 0x2f 0x01).
 *
 * @param sectorOffset - Byte offset within the sector (0, 32, 64, ..., 224).
 * @param chunk32 - 32-byte slice of sector data to write.
 * @param sectorAddr - Target sector base address code (defaults to 0xe0 for sector 0xe000).
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildFlashChunk(
  sectorOffset: number,
  chunk32: Uint8Array,
  sectorAddr = 0xe0,
): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x2f;
  buffer[1] = 0x01;
  buffer[23] = 0x08; // 8 blocks of 4 bytes = 32 bytes
  buffer[27] = sectorOffset & 0xff;
  buffer[28] = sectorAddr & 0xff;
  buffer.set(chunk32.subarray(0, 32), 31);
  return buffer;
}

/**
 * Builds the 63-byte magic commit packet for flash memory (command 0x2f 0x01 with 0xa4a4a4a4).
 *
 * @param sectorAddr - Target sector base address code (defaults to 0xe0).
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildFlashMagicCommit(sectorAddr = 0xe0): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x2f;
  buffer[1] = 0x01;
  buffer[23] = 0x01; // 1 block
  buffer[27] = 0x00;
  buffer[28] = sectorAddr & 0xff;
  buffer[31] = 0xa4;
  buffer[32] = 0xa4;
  buffer[33] = 0xa4;
  buffer[34] = 0xa4;
  return buffer;
}

/**
 * Builds the 63-byte notification/reset packet after flash commit (command 0x13).
 *
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildFlashReset(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x13;
  buffer[3] = 0x80;
  buffer[7] = 0x80;
  return buffer;
}

/** Signature at the start of a valid profile sector (sector 0xe000). */
export const BLOODY_FLASH_SECTOR_HEADER: readonly number[] = [0xff, 0xff, 0xff, 0xff, 0xd4, 0x92, 0x45, 0x97];
export const BLOODY_FLASH_SECTOR_SIZE = 256;
const BLOODY_FLASH_STAGE_BASE = 12;
const BLOODY_FLASH_STAGE_SIZE = 6;
const BLOODY_FLASH_STAGE_RAW_OFFSET = 4;

/**
 * Checks that a buffer looks like a real profile sector (size and header signature).
 *
 * @param sector - Candidate sector bytes read from the device.
 * @returns True if the sector can safely be patched and written back.
 */
export function bloodyIsValidFlashSector(sector: Uint8Array | null | undefined): sector is Uint8Array {
  return !!sector && sector.length === BLOODY_FLASH_SECTOR_SIZE
    && BLOODY_FLASH_SECTOR_HEADER.every((byte, i) => sector[i] === byte);
}

/**
 * Builds the 63-byte command to read a 32-byte chunk of flash memory (command 0x2f 0x00).
 * Mirrors the layout of {@link bloodyBuildFlashChunk}; the device echoes the data at payload offset 31.
 *
 * @param sectorOffset - Byte offset within the sector (0, 32, ..., 224).
 * @param sectorAddr - Target sector base address code (defaults to 0xe0).
 * @returns HID feature report payload buffer.
 */
export function bloodyBuildFlashReadChunk(sectorOffset: number, sectorAddr = 0xe0): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x2f;
  buffer[1] = 0x00;
  buffer[23] = 0x08;
  buffer[27] = sectorOffset & 0xff;
  buffer[28] = sectorAddr & 0xff;
  return buffer;
}

/**
 * Extracts the 32 data bytes from a flash read response.
 *
 * @param reply - Raw HID response buffer for a flash read.
 * @returns 32-byte chunk, or null if the reply is not a flash read response.
 */
export function bloodyParseFlashReadChunk(reply: Uint8Array): Uint8Array | null {
  const bytes = reply.length > 0 && reply[0] === BLOODY_REPORT_ID ? reply.subarray(1) : reply;
  if (bytes.length < 63 || bytes[0] !== 0x2f) return null;
  return new Uint8Array(bytes.subarray(31, 63));
}

/**
 * Patches the enabled stage count and DPI stages into an existing 256-byte profile sector.
 * Only those bytes are modified; button mappings and every other byte are preserved.
 *
 * @param baseSector - Sector read from the device (must pass {@link bloodyIsValidFlashSector}).
 * @param stages - Array of DPI values for each of the 5 stages.
 * @param enabledStageCount - Number of enabled stages (1..5).
 * @returns A new 256-byte sector ready for chunked flash programming.
 * @throws Error if baseSector is not a valid sector; RangeError for unencodable DPI values.
 */
export function bloodyBuildFlashSector(
  stages: readonly number[],
  enabledStageCount: number,
  baseSector: Uint8Array,
): Uint8Array {
  if (!bloodyIsValidFlashSector(baseSector)) {
    throw new Error("Bloody flash sector is missing or invalid; refusing to build a replacement");
  }
  const sector = new Uint8Array(baseSector);

  // Enabled stage count - 1
  sector[8] = Math.max(1, Math.min(5, Math.round(enabledStageCount))) - 1;

  for (let i = 0; i < 5; i++) {
    const dpi = stages[i];
    if (dpi === undefined) throw new RangeError(`Missing DPI for stage ${i}`);
    sector[BLOODY_FLASH_STAGE_BASE + i * BLOODY_FLASH_STAGE_SIZE + BLOODY_FLASH_STAGE_RAW_OFFSET] = bloodyDpiToRawStep(dpi);
  }

  return sector;
}

export interface BloodyFlashProfile {
  enabledStageCount: number;
  stages: number[];
}

/**
 * Decodes the enabled stage count and the 5 DPI stages from a profile sector.
 *
 * @param sector - 256-byte sector read from the device.
 * @returns Parsed profile, or null if the sector is invalid or a stage code is unrecognized.
 */
export function bloodyDecodeFlashSector(sector: Uint8Array): BloodyFlashProfile | null {
  if (!bloodyIsValidFlashSector(sector)) return null;
  const count = sector[8]! + 1;
  if (count < 1 || count > 5) return null;
  const byRaw = new Map<number, number>();
  for (let dpi = BLOODY_DPI_MIN; dpi <= BLOODY_DPI_MAX; dpi += BLOODY_DPI_STEP) {
    byRaw.set(bloodyDpiToRawStep(dpi), dpi);
  }
  const stages: number[] = [];
  for (let i = 0; i < 5; i++) {
    const dpi = byRaw.get(sector[BLOODY_FLASH_STAGE_BASE + i * BLOODY_FLASH_STAGE_SIZE + BLOODY_FLASH_STAGE_RAW_OFFSET]!);
    if (dpi === undefined) return null;
    stages.push(dpi);
  }
  return { enabledStageCount: count, stages };
}

export interface BloodySensitivityInfo {
  totalStages: number;
  activeStageIndex: number;
  stages: number[];
  currentDpi: number;
}

/**
 * Decodes the sensitivity feature report response (command 0x02).
 *
 * @param reply - Raw HID response buffer from command 0x02 query.
 * @returns Parsed sensitivity information, or null if empty or invalid.
 */
export function bloodyDecodeSensitivity(reply: Uint8Array): BloodySensitivityInfo | null {
  const bytes = reply.length > 0 && reply[0] === BLOODY_REPORT_ID ? reply.subarray(1) : reply;
  if (bytes.length < 25 || bytes[0] !== 0x02) return null;
  if (bytes[2] !== 0x2a && bytes[2] !== 0x00) return null;

  // If the device returns an empty dummy reply (e.g. W70/W90 Max which does not use 0x02 query),
  // stage 0 bytes will be all 0x00.
  const stage0Step = bytes[19] ?? 0;
  const stage0DpiStep = bytes[20] ?? 0;
  if (stage0Step === 0 && stage0DpiStep === 0) return null;

  const extraStages = bytes[15] ?? 0;
  const totalStages = Math.min(5, Math.max(1, extraStages + 1));
  const activeStageIndex = Math.min(totalStages - 1, Math.max(0, bytes[17] ?? 0));

  const stages: number[] = [];
  for (let i = 0; i < totalStages; i++) {
    const offset = 19 + i * 6;
    const step = bytes[offset + 1] ?? 0;
    const dpi = step > 0 ? step * BLOODY_LEGACY_DPI_UNIT : 1000;
    stages.push(dpi);
  }

  const currentDpi = stages[activeStageIndex] ?? stages[0] ?? 1000;

  return {
    totalStages,
    activeStageIndex,
    stages,
    currentDpi,
  };
}

/**
 * Decodes polling rate from response to command 0x0e.
 *
 * @param reply - Raw HID response buffer from command 0x0e query.
 * @returns Polling rate in Hz, or null if unrecognized or invalid.
 */
export function bloodyDecodePollingRate(reply: Uint8Array): number | null {
  const bytes = reply.length > 0 && reply[0] === BLOODY_REPORT_ID ? reply.subarray(1) : reply;
  if (bytes.length < 15 || bytes[0] !== 0x0e) return null;
  return bloodyPollingCodeToHz(bytes[14]!) ?? (bytes[13] !== undefined ? bloodyPollingCodeToHz(bytes[13]) : null);
}

/**
 * Decodes backlight level (0..3) from response to command 0x11.
 *
 * @param reply - Raw HID response buffer from command 0x11 query.
 * @returns Brightness level (0..3), or null if invalid.
 */
export function bloodyDecodeBacklight(reply: Uint8Array): number | null {
  const bytes = reply[0] === BLOODY_REPORT_ID ? reply.subarray(1) : reply;
  if (bytes.length < 8 || bytes[0] !== 0x11) return null;
  const level = bytes[7];
  if (level !== undefined && level >= 0 && level <= 3) return level;
  return null;
}

/**
 * Returns available DPI options in 100-DPI steps up to 10,000.
 *
 * @returns Array of supported DPI values.
 */
export function bloodyGetDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = BLOODY_DPI_MIN; dpi <= BLOODY_DPI_MAX; dpi += BLOODY_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}

