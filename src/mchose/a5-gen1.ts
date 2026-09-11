/** First-generation MCHOSE A5 protocol, distinct from the current M HUB protocol. */
export const MCHOSE_A5_GEN1_VENDOR_ID = 0x2023;
export const MCHOSE_A5_GEN1_USAGE_PAGE = 0xffff;
export const MCHOSE_A5_GEN1_REPORT_LENGTH = 64;

export interface MchoseA5Gen1Product {
  name: string;
  connection: "Wired" | "Wireless";
  verified: boolean;
}

/** A5 Pro Max identities exercised by the standalone WebHID driver. */
export const MCHOSE_A5_GEN1_PRODUCTS: ReadonlyMap<number, MchoseA5Gen1Product> = new Map([
  [0xf019, { name: "MCHOSE A5 Pro Max", connection: "Wired", verified: true }],
  [0xf013, { name: "MCHOSE A5 Pro Max (1K receiver)", connection: "Wireless", verified: true }],
  [0xf015, { name: "MCHOSE A5 Pro Max (4K receiver)", connection: "Wireless", verified: false }],
]);

export const MCHOSE_A5_GEN1_PROFILE_COUNT = 3;
export const MCHOSE_A5_GEN1_DPI_STAGES = 6;
export const MCHOSE_A5_GEN1_DPI_MIN = 50;
export const MCHOSE_A5_GEN1_DPI_MAX = 26000;
export const MCHOSE_A5_GEN1_DPI_STEP = 50;
export const MCHOSE_A5_GEN1_RECEIVER_RATES = [125, 250, 500, 1000] as const;
export const MCHOSE_A5_GEN1_WIRED_RATES = [125, 500, 1000] as const;

export interface MchoseA5Gen1Command {
  length: number;
  page: number;
  command: number;
  data?: readonly number[];
  route?: number;
}

/** Build the 64-byte XVI feature-report body (the report id is passed separately). */
export function mchoseA5Gen1EncodeRequest(input: MchoseA5Gen1Command): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(MCHOSE_A5_GEN1_REPORT_LENGTH);
  payload[2] = input.route ?? 2;
  payload[3] = input.length & 0xff;
  payload[4] = input.page & 0xff;
  payload[5] = input.command & 0xff;
  payload.set((input.data ?? []).slice(0, 57), 6);
  return payload;
}

/** Normalize WebHID implementations that include or omit the report id in returned data. */
export function mchoseA5Gen1DecodeReply(raw: Uint8Array, reportId: number): Uint8Array {
  if (raw.length === MCHOSE_A5_GEN1_REPORT_LENGTH + 1 && raw[0] === reportId) return raw.slice(1);
  return raw.slice(0, MCHOSE_A5_GEN1_REPORT_LENGTH);
}

export function mchoseA5Gen1ReplyMatches(reply: Uint8Array, page: number, command: number): boolean {
  return reply[0] === 0xa1 && reply[4] === page && reply[5] === command;
}

export function mchoseA5Gen1DecodeFirmware(reply: Uint8Array): string {
  return [reply[6], reply[7], reply[8], reply[9]]
    .map((part) => String(part ?? 0).padStart(2, "0"))
    .join(".");
}

export function mchoseA5Gen1DecodeDpi(reply: Uint8Array): { count: number; stages: number[] } {
  const count = Math.max(1, Math.min(MCHOSE_A5_GEN1_DPI_STAGES, reply[7] || MCHOSE_A5_GEN1_DPI_STAGES));
  const stages = Array.from({ length: count }, (_, index) => {
    const offset = 8 + index * 4;
    return ((reply[offset] ?? 0) << 8) | (reply[offset + 1] ?? 0);
  });
  return { count, stages };
}

export function mchoseA5Gen1NormalizeDpi(value: number): number {
  return Math.max(MCHOSE_A5_GEN1_DPI_MIN, Math.min(
    MCHOSE_A5_GEN1_DPI_MAX,
    Math.round(value / MCHOSE_A5_GEN1_DPI_STEP) * MCHOSE_A5_GEN1_DPI_STEP,
  ));
}

export function mchoseA5Gen1EncodeDpi(profile: number, stages: readonly number[]): number[] {
  const normalized = stages.slice(0, MCHOSE_A5_GEN1_DPI_STAGES).map(mchoseA5Gen1NormalizeDpi);
  const data = [profile, normalized.length];
  for (const dpi of normalized) data.push((dpi >> 8) & 0xff, dpi & 0xff, (dpi >> 8) & 0xff, dpi & 0xff);
  return data;
}
