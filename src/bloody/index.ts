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

export const BLOODY_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [BLOODY_W70_MAX_PRODUCT_ID, "Bloody W70 Max"],
]);

export const BLOODY_PRODUCT_IDS: readonly number[] = [...BLOODY_PRODUCT_NAMES.keys()];

/** Feature report ID used for all configuration commands. */
export const BLOODY_REPORT_ID = 0x07;
/** Feature report payload size in bytes (excluding report ID). */
export const BLOODY_REPORT_SIZE = 63;

/** Supported polling rates in Hz. */
export const BLOODY_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

export const BLOODY_DPI_MIN = 100;
export const BLOODY_DPI_MAX = 16000;
export const BLOODY_DPI_STEP = 50;

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

export function bloodyPollingCodeToHz(code: number): number | null {
  switch (code) {
    case 0x01: return 1000;
    case 0x02: return 500;
    case 0x04: return 250;
    case 0x08: return 125;
    default: return null;
  }
}

export function bloodyHzToPollingCode(hz: number): number {
  switch (hz) {
    case 125: return 0x08;
    case 250: return 0x04;
    case 500: return 0x02;
    case 1000: return 0x01;
    default: return 0x01;
  }
}

/** Builds the 72-byte query report for sensitivity / DPI stages. */
export function bloodyBuildSensitivityQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x02;
  buffer[2] = 0x2a;
  buffer[4] = 0x60;
  return buffer;
}

/** Builds the 72-byte query report for current polling rate and operational status. */
export function bloodyBuildPollingQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x0e;
  return buffer;
}

/** Builds the 72-byte query report for device ID / model info. */
export function bloodyBuildDeviceQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x05;
  return buffer;
}

/** Builds the 72-byte query report for backlight brightness. */
export function bloodyBuildBacklightQuery(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x11;
  return buffer;
}

/**
 * Builds the 72-byte command to set backlight brightness level.
 * @param level 0: Off, 1: 25%, 2: 50%, 3: 100% (max).
 */
export function bloodyBuildSetBacklight(level: number): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x11;
  buffer[3] = 0x80; // Set command flag
  buffer[7] = Math.max(0, Math.min(3, Math.round(level)));
  return buffer;
}

/** Builds the 63-byte command to commit/save current settings to mouse memory. */
export function bloodyBuildSaveCommand(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x0a;
  return buffer;
}

export function bloodyDpiToRawStep(dpi: number): number {
  const input = Math.max(1, Math.min(100, Math.round(dpi / 100)));
  let x = 0;
  for (let i = 0; i < input; i++) {
    if (i % 3 === 1) x++;
  }
  const y = input - x - 1;
  return (0x01 + 0x03 * x + 0x02 * y) & 0xff;
}

/**
 * Builds the 63-byte command to set current DPI stage, active stage, and polling rate.
 * Byte 7 (wire byte 8): modes enabled (totalStages - 1)
 * Byte 8 (wire byte 9): active stage index
 * Bytes 9-10 (wire bytes 10-11): 0x40 0x40 base config word
 * Byte 11 (wire byte 12): target DPI step code
 * Byte 12 (wire byte 13): polling rate code
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
 * Decodes active DPI, stage, and modes count from command 0x05 response.
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
 * Builds the 63-byte command to update the sensitivity stages in flash memory (command 0x02).
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
    const dpiStep = Math.max(1, Math.min(255, Math.round(dpi / BLOODY_DPI_STEP)));
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
 * Builds the 63-byte command to unlock/lock flash programming mode (command 0x20).
 */
export function bloodyBuildFlashUnlock(unlock: boolean): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x20;
  buffer[6] = unlock ? 0x01 : 0x00;
  return buffer;
}

/**
 * Builds the 63-byte command to write a 32-byte chunk to flash memory (command 0x2f 0x01).
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
 */
export function bloodyBuildFlashReset(): Uint8Array {
  const buffer = new Uint8Array(BLOODY_REPORT_SIZE);
  buffer[0] = 0x13;
  buffer[3] = 0x80;
  buffer[7] = 0x80;
  return buffer;
}

/**
 * Builds the 256-byte flash profile sector for W70/W90 Max (sector 0xe000).
 * If baseSector is provided, preserves existing bytes and modifies only stage count and DPI stages.
 */
export function bloodyBuildFlashSector(
  stages: readonly number[],
  enabledStageCount = 5,
  baseSector?: Uint8Array,
): Uint8Array {
  const sector = new Uint8Array(256);
  if (baseSector && baseSector.length >= 256) {
    sector.set(baseSector.subarray(0, 256));
  } else {
    // Header: ff ff ff ff d4 92 45 97
    sector[0] = 0xff;
    sector[1] = 0xff;
    sector[2] = 0xff;
    sector[3] = 0xff;
    sector[4] = 0xd4;
    sector[5] = 0x92;
    sector[6] = 0x45;
    sector[7] = 0x97;

    // Polling / LOD config indicator
    sector[0x3c] = 0x02;

    // Standard button mapping table
    const defaultButtons = [
      0x07, 0x00, 0x40, 0x00, 0x40, 0x01, 0x40, 0x02, 0x40, 0x04, 0x40, 0x05, 0x40, 0x06, 0x40, 0x07,
      0x40, 0x08, 0x40, 0x09, 0x40, 0x0a, 0x40, 0x0c, 0x40, 0x0d, 0x40, 0x0e, 0x40, 0x0f, 0x40, 0x10,
      0x40, 0x11,
    ];
    sector.set(defaultButtons, 0x48);
  }

  // Enabled stage count - 1 (32-bit LE)
  const count = Math.max(1, Math.min(5, Math.round(enabledStageCount)));
  sector[8] = count - 1;

  // 5 DPI stages at offsets 12, 18, 24, 30, 36
  for (let i = 0; i < 5; i++) {
    const dpi = stages[i] ?? 1000;
    const offset = 12 + i * 6;
    sector[offset] = 0x40;
    sector[offset + 1] = 0x00;
    sector[offset + 2] = 0x40;
    sector[offset + 3] = 0x00;
    sector[offset + 4] = bloodyDpiToRawStep(dpi);
    sector[offset + 5] = 0x00;
  }

  return sector;
}

export interface BloodySensitivityInfo {
  totalStages: number;
  activeStageIndex: number;
  stages: number[];
  currentDpi: number;
}

/**
 * Decodes the sensitivity feature report response (command 0x02).
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
    const dpi = step > 0 ? step * BLOODY_DPI_STEP : 1000;
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
 */
export function bloodyDecodePollingRate(reply: Uint8Array): number | null {
  const bytes = reply.length > 0 && reply[0] === BLOODY_REPORT_ID ? reply.subarray(1) : reply;
  if (bytes.length < 15 || bytes[0] !== 0x0e) return null;
  return bloodyPollingCodeToHz(bytes[14]!) ?? (bytes[13] !== undefined ? bloodyPollingCodeToHz(bytes[13]) : null);
}

/**
 * Decodes backlight level (0..3) from response to command 0x11.
 */
export function bloodyDecodeBacklight(reply: Uint8Array): number | null {
  const bytes = reply[0] === BLOODY_REPORT_ID ? reply.subarray(1) : reply;
  if (bytes.length < 8 || bytes[0] !== 0x11) return null;
  const level = bytes[7];
  if (level !== undefined && level >= 0 && level <= 3) return level;
  return null;
}

/**
 * Returns available DPI options in 50-DPI steps up to 16,000.
 */
export function bloodyGetDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = BLOODY_DPI_MIN; dpi <= BLOODY_DPI_MAX; dpi += BLOODY_DPI_STEP) {
    options.push(dpi);
  }
  return options;
}
