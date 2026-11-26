/**
 * Kmart "Wireless Gaming Mouse" (Kmart item 43499755) feature-report protocol.
 *
 * Evidence: static analysis of the vendor's Windows configurator
 * (`43499755_Wireless_Gaming_Mouse.exe` from intraindustry.com, `GamingMS.exe`),
 * confirmed on hardware through the 2.4 GHz receiver (PID 0x5b2f): the status
 * query, polling-rate write with read-back, and DPI-stage write.
 *
 * Every request is one 32-byte feature report with ID 0x0c on the vendor
 * collection (usage page 0xff00, usage 0x01). The configurator sends a request,
 * waits 10 ms and reads report 0x0c back. Byte offsets below exclude the
 * report ID, matching WebHID's `sendFeatureReport` payloads.
 */
export const KMART_VENDOR_ID = 0x248a;
export const KMART_WIRED_PRODUCT_ID = 0x5b2e;
export const KMART_RECEIVER_PRODUCT_ID = 0x5b2f;
export const KMART_PRODUCT_IDS = [KMART_WIRED_PRODUCT_ID, KMART_RECEIVER_PRODUCT_ID] as const;
export const KMART_USAGE_PAGE = 0xff00;
export const KMART_USAGE = 0x01;
export const KMART_REPORT_ID = 0x0c;
export const KMART_REPORT_SIZE = 32;
const KMART_MAX_DATA = KMART_REPORT_SIZE - 6;

export const KMART_COMMAND = {
  /** Read-only status: sensor, active DPI stage, polling interval, battery, link. */
  status: 0x20,
  /** Six DPI stages, the enabled-stage mask and the active stage (18 bytes). */
  dpiStages: 0x05,
  /** One button assignment: key index 0–5, then three action bytes (4 bytes). Not driven yet. */
  buttons: 0x04,
  /** Eight RGB colours, probably the DPI-stage indicator (24 bytes). Not driven yet. */
  dpiColors: 0x06,
  /** USB report interval in milliseconds (1 byte). */
  pollingInterval: 0x07,
  /** Lighting effect block (25 bytes). Not driven yet. */
  lighting: 0x08,
} as const;

/** Sensor codes the configurator recognises in status byte 14. */
export const KMART_SENSOR_PMW3325 = 0x25;

/**
 * PMW3325 DPI ladder from the configurator, in DPI. The wire code for a stage
 * is its index in this list plus one.
 */
export const KMART_PMW3325_DPI_VALUES: readonly number[] = [
  ...Array.from({ length: 49 }, (_, index) => (4 + index * 2) * 50),
  110 * 50, 120 * 50, 128 * 50, 140 * 50, 150 * 50, 160 * 50, 170 * 50, 180 * 50, 190 * 50, 200 * 50,
];

export const KMART_DPI_STAGE_COUNT = 6;

const POLLING_INTERVALS: Readonly<Record<number, number>> = { 125: 8, 250: 4, 500: 2, 1000: 1 };
export const KMART_POLLING_RATES = [125, 250, 500, 1000] as const;

export interface KmartStatus {
  /** False while the mouse sleeps or its radio link is idle (byte 2 is 0x02). */
  linked: boolean;
  firmwareTag: string;
  sensor: number;
  /** Zero-based active DPI stage. */
  activeStage: number;
  enabledStageCount: number;
  pollingRateHz: number | null;
  batteryPercent: number;
  /** 0 on battery, 1 charging, 2 full (the configurator then shows 100%). */
  chargeState: number;
}

/** Builds one request payload (report ID excluded). */
export function kmartRequest(command: number, sequence: number, data: readonly number[] = [], write = false): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(command) || command < 1 || command > 255) throw new RangeError("Invalid Kmart command.");
  if (data.length > KMART_MAX_DATA) throw new RangeError("Kmart payload too long.");
  const bytes = new Uint8Array(KMART_REPORT_SIZE);
  bytes[0] = 0x01;
  bytes[1] = command;
  bytes[3] = sequence & 0xff;
  if (write) {
    bytes[4] = 0x01;
    bytes[5] = data.length;
    data.forEach((value, index) => {
      if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("Invalid Kmart payload byte.");
      bytes[6 + index] = value;
    });
  }
  return bytes;
}

/** Normalises a feature-report read to the 32-byte payload, dropping a leading report ID if present. */
export function kmartPayload(source: DataView | Uint8Array): Uint8Array {
  const bytes = source instanceof Uint8Array
    ? source
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return bytes[0] === KMART_REPORT_ID && bytes[1] === 0x01 ? bytes.subarray(1) : bytes;
}

export function kmartPollingInterval(rateHz: number): number {
  const interval = POLLING_INTERVALS[rateHz];
  if (!interval) throw new RangeError(`Unsupported Kmart polling rate ${rateHz}.`);
  return interval;
}

export function kmartPollingRate(intervalMs: number): number | null {
  const entry = Object.entries(POLLING_INTERVALS).find(([, interval]) => interval === intervalMs);
  return entry ? Number(entry[0]) : null;
}

export function kmartDecodeStatus(source: DataView | Uint8Array): KmartStatus {
  const bytes = kmartPayload(source);
  if (bytes.length < 21 || bytes[1] !== KMART_COMMAND.status) throw new Error("Invalid Kmart status reply.");
  const tag = String.fromCharCode(bytes[7]!, bytes[8]!, bytes[9]!, bytes[10]!);
  // Only the "M" prefix is checked so other firmware revisions still decode.
  if (tag[0] !== "M") throw new Error("Kmart status reply has an unknown signature.");
  const stageByte = bytes[15]!;
  return {
    linked: bytes[2] === 0x00 && bytes[20] === 0x01,
    firmwareTag: tag + String.fromCharCode(bytes[11]!),
    sensor: bytes[14]!,
    activeStage: Math.max(0, (stageByte >> 4) - 1),
    enabledStageCount: stageByte & 0x0f,
    pollingRateHz: kmartPollingRate(bytes[16]!),
    batteryPercent: bytes[18] === 2 ? 100 : Math.min(100, bytes[17]!),
    chargeState: bytes[18]!,
  };
}

/** Wire code for a DPI on the PMW3325 ladder. */
export function kmartPmw3325DpiCode(dpi: number): number {
  const index = KMART_PMW3325_DPI_VALUES.indexOf(dpi);
  if (index < 0) throw new RangeError(`DPI ${dpi} is not on the Kmart PMW3325 ladder.`);
  return index + 1;
}

/**
 * Data bytes for command 0x05: (active+1)<<4 | enabled count, enabled-stage
 * mask, then six little-endian stage codes and four zero bytes.
 */
export function kmartDpiStagesData(
  stagesDpi: readonly number[], activeStage: number, enabledCount = stagesDpi.length,
): number[] {
  if (stagesDpi.length < 1 || stagesDpi.length > KMART_DPI_STAGE_COUNT) throw new RangeError("Kmart supports 1–6 DPI stages.");
  if (!Number.isInteger(enabledCount) || enabledCount < 1 || enabledCount > stagesDpi.length) {
    throw new RangeError("Enabled DPI stage count is out of range.");
  }
  if (!Number.isInteger(activeStage) || activeStage < 0 || activeStage >= enabledCount) {
    throw new RangeError("Active DPI stage is out of range.");
  }
  const data = new Array<number>(18).fill(0);
  data[0] = ((activeStage + 1) << 4) | enabledCount;
  data[1] = (1 << enabledCount) - 1;
  stagesDpi.forEach((dpi, index) => {
    const code = kmartPmw3325DpiCode(dpi);
    data[2 + index * 2] = code & 0xff;
    data[3 + index * 2] = code >> 8;
  });
  return data;
}
