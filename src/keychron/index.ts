export const KEYCHRON_VENDOR_ID = 0x3434;
export const KEYCHRON_RAW_USAGE_PAGE = 0xff60;
export const KEYCHRON_RAW_USAGE = 0x61;
export const KEYCHRON_REPORT_ID = 0;
export const KEYCHRON_PACKET_LENGTH = 32;
/** Keychron M6 wired control interface and report layout, verified on PID 0xd060. */
export const KEYCHRON_M6_PRODUCT_ID = 0xd060;
/** Link-KM receiver paired with the Keychron M6, verified on 2.4 GHz. */
export const KEYCHRON_M6_RECEIVER_PRODUCT_ID = 0xd029;
export const KEYCHRON_M6_USAGE_PAGE = 0xffc1;
export const KEYCHRON_M6_USAGE = 0x01;
export const KEYCHRON_M6_COMMAND_REPORT_ID = 0xb3;
export const KEYCHRON_M6_COMMAND_RESPONSE_REPORT_ID = 0xb4;
export const KEYCHRON_M6_SETTINGS_REPORT_ID = 0xb5;
export const KEYCHRON_M6_SETTINGS_RESPONSE_REPORT_ID = 0xb6;
export const KEYCHRON_M6_STATUS_COMMAND = 0x06;
export const KEYCHRON_M6_STATUS_PACKET_LENGTH = 63;
export const KEYCHRON_PRODUCTS = new Map<number, { name: string; receiver?: boolean }>([
  [0x0440, { name: "Nape Pro" }],
  [0xd026, { name: "Keychron Link-KM", receiver: true }],
  [0xd029, { name: "Keychron Link-KM Type C", receiver: true }],
]);
export const KEYCHRON_COMMAND = { firmwareVersion: 161, miscGroup: 167 } as const;
export const KEYCHRON_NAPE_COMMAND = {
  getOrientation: 32, getDpiStage: 33, setDpiStage: 34, setDpiValue: 35,
  getDpiValue: 36, getBattery: 49, getCustomDpi: 54, setCustomDpi: 55,
} as const;
export const KEYCHRON_MISC_COMMAND = {
  getSleep: 11,
  setSleep: 12,
  getPolling: 13,
  setPolling: 14,
} as const;
export const KEYCHRON_POLLING_TABLE = [8000, 4000, 2000, 1000, 500, 250, 125] as const;
/** Nape Pro only — observed on firmware v1.2.6-ZK (stage 5 stores 4000). Other Keychron mice should define their own ranges. */
export const KEYCHRON_NAPE_DPI_MIN = 50;
export const KEYCHRON_NAPE_DPI_MAX = 4000;
export const KEYCHRON_NAPE_DPI_STEP = 50;
export const KEYCHRON_NAPE_SLEEP_MIN_SECONDS = 60;
export const KEYCHRON_NAPE_SLEEP_MAX_SECONDS = 12 * 3600 + 59 * 60 + 59;
export const KEYCHRON_NAPE_SLEEP_OPTIONS = [
  60, 120, 300, 600, 1800, 3600, 7200, 18_000, 43_200,
] as const;

export function keychronPacket(command: readonly number[]): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(KEYCHRON_PACKET_LENGTH);
  packet.set(command.slice(0, KEYCHRON_PACKET_LENGTH));
  return packet;
}

export function keychronDecodePolling(response: Uint8Array): { rateHz: number; supported: number[] } {
  if (response.slice(2).every((byte) => byte === 0)) return { rateHz: 1000, supported: [125, 500, 1000] };
  const mask = response[5] ?? 0;
  const supported = KEYCHRON_POLLING_TABLE.filter((_, index) => ((mask >> index) & 1) === 1).slice().sort((a, b) => a - b);
  const rateHz = KEYCHRON_POLLING_TABLE[Math.min(response[6] ?? 3, KEYCHRON_POLLING_TABLE.length - 1)] ?? 1000;
  return { rateHz, supported: supported.length ? supported : [rateHz] };
}

export function keychronDecodeFirmware(response: Uint8Array): string | null {
  const end = response.indexOf(0, 1);
  const bytes = response.slice(1, end < 0 ? undefined : end);
  if (!bytes.length) return null;
  const text = String.fromCharCode(...bytes);
  return text.startsWith("v") ? text : `v${text}`;
}

export function keychronDecodeBattery(
  response: Uint8Array,
): { percent: number; state: "Charging" | "Full" | "Discharging" } {
  const percent = response[2] ?? 0xff;
  const status = response[3] ?? 0;
  const state = status === 1
    ? "Charging"
    : status === 2
      ? "Full"
      : "Discharging";
  return { percent, state };
}

export function keychronDecodeSleepTimeout(response: Uint8Array): number {
  return (response[5] ?? 0) | ((response[6] ?? 0) << 8);
}

export function keychronEncodeSleepTimeout(seconds: number): number[] {
  return [
    KEYCHRON_COMMAND.miscGroup,
    KEYCHRON_MISC_COMMAND.setSleep,
    0,
    0,
    seconds & 0xff,
    (seconds >> 8) & 0xff,
    0,
    0,
  ];
}
