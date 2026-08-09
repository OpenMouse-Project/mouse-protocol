export const ORBITAL_VENDOR_ID = 0x1915;
export const ORBITAL_REPORT_ID = 0;
export const ORBITAL_PACKET_SIZE = 64;
export const ORBITAL_REPORT_RATES_HZ: readonly number[] = [125, 500, 1000, 2000, 4000, 8000];
export interface OrbitalDeviceDefinition {
  name: string;
  protocol: "dms" | "dms_v2";
  receiver: boolean;
  pairedProductId?: number;
  maxReportRateIndex: number;
}
export const ORBITAL_DEVICES: ReadonlyMap<number, OrbitalDeviceDefinition> = new Map([
  [0x080c, { name: "Ghost / Pathfinder V2", protocol: "dms_v2", receiver: false, maxReportRateIndex: 5 }],
  [0x080b, { name: "Ghost / Pathfinder V2 receiver", protocol: "dms_v2", receiver: true, pairedProductId: 0x080c, maxReportRateIndex: 5 }],
  [0x0747, { name: "Pathfinder V1", protocol: "dms", receiver: false, maxReportRateIndex: 2 }],
  [0x0746, { name: "Pathfinder V1 receiver", protocol: "dms", receiver: true, pairedProductId: 0x0747, maxReportRateIndex: 2 }],
]);

export function orbitalFinishPacket(packet: Uint8Array, routeToMouse = false): Uint8Array {
  const result = packet.slice();
  if (routeToMouse) result[0] = (result[0] ?? 0) | 0x40;
  const sum = result.slice(0, ORBITAL_PACKET_SIZE - 1).reduce((total, byte) => total + byte, 0);
  result[ORBITAL_PACKET_SIZE - 1] = (0xa1 - (sum & 0xff)) & 0xff;
  return result;
}

