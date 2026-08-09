export const KEYCHRON_VENDOR_ID = 0x3434;
export const KEYCHRON_RAW_USAGE_PAGE = 0xff60;
export const KEYCHRON_RAW_USAGE = 0x61;
export const KEYCHRON_REPORT_ID = 0;
export const KEYCHRON_PACKET_LENGTH = 32;
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
export const KEYCHRON_MISC_COMMAND = { getPolling: 13, setPolling: 14 } as const;
export const KEYCHRON_POLLING_TABLE = [8000, 4000, 2000, 1000, 500, 250, 125] as const;

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

