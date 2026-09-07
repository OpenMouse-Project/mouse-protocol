/** Transport report ID; it is not part of the 32-byte codec payload. */
export const valkyrieOutputReportId = 0;

export type ValkyrieIdentity = {
  readonly modelCode: string;
  readonly firmwareVersionRaw: number;
  readonly sensorCode: number;
  readonly sensorVariantRaw: number;
  readonly batteryStatusRaw: number;
  readonly batteryPercent: number;
  readonly connectionStatusRaw: number;
};

/** Encodes only the observed read-only identity request (command 0x10). */
export function valkyrieEncodeIdentityRequest(): Uint8Array {
  const payload = new Uint8Array(32);
  payload[0] = 0x10;
  // Bytes 4 through 30 are zero, so their additive checksum is also zero.
  return payload;
}

/** Parses a 32-byte input payload without a report ID; malformed replies return undefined. */
export function valkyrieDecodeIdentityReply(payload: Uint8Array): ValkyrieIdentity | undefined {
  if (payload.length !== 32) return undefined;
  if (payload[0] !== 0x10 || payload[1] !== 0 || payload[2] !== 1 || payload[3] !== 0x0b) {
    return undefined;
  }
  const checksum = payload.subarray(4, 31).reduce((sum, byte) => sum + byte, 0) & 0xff;
  if (payload[31] !== checksum || payload[13] > 100) return undefined;
  const modelBytes = payload.subarray(4, 8);
  if (modelBytes.some((byte) => byte < 0x20 || byte > 0x7e)) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    modelCode: String.fromCharCode(...modelBytes),
    firmwareVersionRaw: view.getUint16(8, true),
    sensorCode: view.getUint8(10),
    sensorVariantRaw: view.getUint8(11),
    batteryStatusRaw: view.getUint8(12),
    batteryPercent: view.getUint8(13),
    connectionStatusRaw: view.getUint8(14),
  };
}

/** Vendor model labels only; a matching code is not a claim of driver support. */
export function valkyrieModelName(modelCode: string): "VK M3 Lite" | "VK M3" | undefined {
  switch (modelCode) {
    case "M220": return "VK M3 Lite";
    case "E023": return "VK M3";
    default: return undefined;
  }
}
export * from "./settings.js";
