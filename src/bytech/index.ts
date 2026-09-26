export const BYTECH_VENDOR_ID = 0x372e;
export const BYTECH_REPORT_ID = 3;
export const BYTECH_PAYLOAD_LENGTH = 63;
export const BYTECH_USAGE_PAGE = 0xff00;
export const BYTECH_USAGE = 0x0001;

export const BYTECH_PIAO_PRODUCT_IDS: readonly number[] = [0x1014, 0x1015];

export const BYTECH_POLLING_RATES: ReadonlyArray<readonly [number, number]> = [
  [0, 1000],
  [1, 500],
  [2, 250],
  [3, 125],
  [4, 8000],
  [5, 4000],
  [6, 2000],
] as const;

export function bytechPollingCodeToHz(code: number): number {
  const match = BYTECH_POLLING_RATES.find(([c]) => c === code);
  return match ? match[1] : 1000;
}

export function bytechPollingHzToCode(hz: number): number {
  const match = BYTECH_POLLING_RATES.find(([, h]) => h === hz);
  return match ? match[0] : 0;
}

export function bytechSetCrc(payload: Uint8Array): Uint8Array {
  let sum = 0;
  for (let i = 1; i < payload.length; i++) {
    sum = (sum + (payload[i] ?? 0)) & 0xff;
  }
  payload[0] = sum;
  return payload;
}

export function bytechBuildSensorQuery(): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80; // 0x50
  packet[2] = 0;
  packet[3] = 10;
  packet[4] = 79;
  packet[5] = 64;
  return bytechSetCrc(packet);
}

export function bytechBuildBasicInfoQuery(): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = 0;
  packet[3] = 2;
  packet[4] = 79;
  packet[5] = 129;
  return bytechSetCrc(packet);
}

export function bytechBuildDpiStagesQuery(step: number): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = 0;
  packet[3] = 0;
  packet[4] = 79;
  packet[5] = 65 + step;
  return bytechSetCrc(packet);
}

export function bytechBuildSetPollingRate(rateCode: number, wireless: boolean): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = 1;
  packet[3] = 49;
  packet[4] = 53;
  packet[5] = 1;
  if (wireless && rateCode >= 4) {
    packet[6] = rateCode;
  } else {
    packet[6] = (rateCode << 4) | rateCode;
  }
  return bytechSetCrc(packet);
}

export function bytechBuildSetSensor(options: {
  lod: number;
  debounce: number;
  angleSnap: boolean;
  glassMode: boolean;
  rippleControl: boolean;
  motionSync: boolean;
  workSpeedMode: number;
}): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = 3;
  packet[3] = 50;
  packet[4] = 53;
  packet[5] = 3;
  packet[6] = options.lod;
  packet[7] = options.debounce;

  let flags = 0;
  if (options.workSpeedMode === 1) flags = 64;
  else if (options.workSpeedMode === 2) flags = 128;
  if (options.glassMode) flags |= 2;
  if (options.angleSnap) flags |= 1;
  if (options.rippleControl) flags |= 16;
  if (options.motionSync) flags |= 32;

  packet[8] = flags;
  return bytechSetCrc(packet);
}

export function bytechBuildSetDpi(stageIndex: number, dpi: number, stageCount = 6): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = 6;
  packet[3] = 80;
  packet[4] = 58;
  packet[5] = 0;
  packet[6] = (((stageIndex + 1) & 0x0f) << 4) | (stageCount & 0x0f);

  const rawVal = dpi >= 30000 ? dpi : Math.round(dpi / 50) - 1;
  packet[7] = rawVal & 0xff;
  packet[8] = (rawVal >> 8) & 0xff;
  packet[9] = 255;
  packet[10] = 255;
  packet[11] = 255;
  return bytechSetCrc(packet);
}

export function bytechBuildSetSleep(units: number): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = 1;
  packet[3] = 49;
  packet[4] = 53;
  packet[5] = 8;
  packet[6] = Math.max(1, Math.min(255, units));
  return bytechSetCrc(packet);
}

export function bytechDecodeDpiValue(low: number, high: number): number {
  const val = (low & 0xff) | ((high & 0xff) << 8);
  return val >= 30000 ? val : (val + 1) * 50;
}

export const BYTECH_BUTTON_NAMES = [
  "Left Click",
  "Right Click",
  "Middle Click",
  "Back",
  "Forward",
  "DPI Loop",
] as const;

export const BYTECH_BUTTON_ACTIONS: Readonly<Record<string, number>> = {
  "Left Click": 0x01010100,
  "Right Click": 0x01020100,
  "Middle Click": 0x01030100,
  Forward: 0x01040100,
  Back: 0x01050100,
  "DPI Loop": 0x05040000,
  "DPI Up": 0x05010000,
  "DPI Down": 0x05020000,
  Disabled: 0x00000000,
};

export const BYTECH_BUTTON_OPTIONS = Object.keys(BYTECH_BUTTON_ACTIONS);

export function bytechActionFromCode(code: number): string {
  if (code === 0x05040100 || code === 0x05040000) return "DPI Loop";
  for (const [name, val] of Object.entries(BYTECH_BUTTON_ACTIONS)) {
    if (val === code) return name;
  }
  return "Left Click";
}

export function bytechBuildFetchKeys(chunkIndex: number): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = 0;
  packet[3] = chunkIndex;
  packet[4] = 79;
  packet[5] = chunkIndex;
  return bytechSetCrc(packet);
}

export function bytechBuildSetKeyChunk(
  chunkIndex: number,
  offset: number,
  chunk: Uint8Array,
  isLast: boolean,
): Uint8Array {
  const packet = new Uint8Array(BYTECH_PAYLOAD_LENGTH);
  packet[1] = 80;
  packet[2] = chunk.length;
  packet[3] = 128 + chunkIndex;
  packet[4] = isLast ? 50 : 49;
  packet[5] = offset;
  for (let c = 0; c < chunk.length; c++) {
    packet[6 + c] = chunk[c]!;
  }
  return bytechSetCrc(packet);
}
