/** Shared page-command framing used by WLMouse and Lamzu receivers. */
export const COMPX_REPORT_ID = 0;
export const COMPX_PACKET_LENGTH = 64;
export const COMPX_HEADER_LENGTH = 6;
export const COMPX_STATUS = { request: 0x00, pending: 0xa0, ok: 0xa1, unsupported: 0xa2 } as const;
export type CompaxLiftOffDistance = "Low" | "Medium" | "High";
export interface CompaxDpiStage { x: number; y: number }
export interface CompaxRequest {
  target: number; length: number; page: number; command: number;
  args: readonly number[]; attempts?: number;
}

export function compaxEncodeRequest(spec: CompaxRequest): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(COMPX_PACKET_LENGTH);
  packet[0] = COMPX_STATUS.request;
  packet[2] = spec.target;
  packet[3] = spec.length;
  packet[4] = spec.page;
  packet[5] = spec.command;
  packet.set(spec.args.slice(0, COMPX_PACKET_LENGTH - COMPX_HEADER_LENGTH), COMPX_HEADER_LENGTH);
  return packet;
}

export function compaxDecodeDpiStages(payload: Uint8Array): CompaxDpiStage[] {
  const stages: CompaxDpiStage[] = [];
  for (let index = 0; index < (payload[1] ?? 0); index += 1) {
    const offset = 2 + index * 4;
    if (offset + 3 >= payload.length) break;
    stages.push({
      x: ((payload[offset] ?? 0) << 8) | (payload[offset + 1] ?? 0),
      y: ((payload[offset + 2] ?? 0) << 8) | (payload[offset + 3] ?? 0),
    });
  }
  return stages;
}

export function compaxDecodePollingRate(table: ReadonlyArray<readonly [number, number]>, value: number): number {
  const rate = table.find(([encoded]) => encoded === value)?.[1];
  if (!rate) throw new Error(`The mouse reported an unknown polling-rate value 0x${value.toString(16)}.`);
  return rate;
}

export function compaxDecodeLiftOff(value: number): CompaxLiftOffDistance | null {
  if (!value) return null;
  const millimetres = (value & 0x80) !== 0 ? (value & 0x7f) / 10 : value;
  return millimetres < 1 ? "Low" : millimetres < 2 ? "Medium" : "High";
}

export function compaxDecodeSleep(payload: Uint8Array | null, disabledMinimum = 0xff00): number | null {
  if (!payload || payload.length < 3) return null;
  const seconds = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
  return seconds === 0 || seconds >= disabledMinimum ? null : seconds;
}

export function compaxDecodeFirmware(label: string, payload: Uint8Array | null): string {
  return !payload || payload.length < 4 ? `${label} firmware unavailable` : `${label} ${payload[2]}.${payload[3]}`;
}

