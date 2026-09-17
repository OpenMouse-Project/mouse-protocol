export const RYUNIX_VENDOR_ID = 0x04f3;
export const RYUNIX_WIRED_PRODUCT_ID = 0x026e;
export const RYUNIX_WIRELESS_PRODUCT_ID = 0x026f;
export const RYUNIX_PRODUCT_IDS: ReadonlySet<number> = new Set([
  RYUNIX_WIRED_PRODUCT_ID,
  RYUNIX_WIRELESS_PRODUCT_ID,
]);

export const RYUNIX_USAGE_PAGE = 0x0a;
export const RYUNIX_USAGE = 0xc7;
export const RYUNIX_TELEMETRY_REPORT_ID = 0x04;
export const RYUNIX_CONFIG_REPORT_ID = 0x05;

export type RyunixLedMode =
  | "Off"
  | "Spectrum"
  | "Breathing single"
  | "Static"
  | "Wave"
  | "Reactive"
  | "Cycling";

const POLLING_RATES: Readonly<Record<number, number>> = {
  0x08: 125,
  0x04: 250,
  0x02: 500,
  0x01: 1000,
};

const LED_MODES: Readonly<Record<number, RyunixLedMode>> = {
  0x00: "Off",
  0x01: "Spectrum",
  0x02: "Breathing single",
  0x03: "Static",
  0x04: "Wave",
  0x05: "Reactive",
  0x06: "Cycling",
  0x07: "Wave",
};

export interface KyuProMx1Telemetry {
  active: boolean;
  dpiStage: number;
  pollingRateHz: number;
  batteryPercent: number;
  charging: boolean;
  ledMode: RyunixLedMode | null;
  ledModeCode: number;
}

/** Decode the six-byte telemetry body delivered by input report 0x04. */
export function decodeKyuProMx1Telemetry(
  data: Uint8Array,
  reportId: number,
): KyuProMx1Telemetry | null {
  if (reportId !== RYUNIX_TELEMETRY_REPORT_ID || data.length < 6) return null;

  const activeByte = data[0];
  const pollingRateHz = POLLING_RATES[data[2]];
  const batteryPercent = data[3];
  const chargingByte = data[4];
  if (
    (activeByte !== 0 && activeByte !== 1)
    || pollingRateHz === undefined
    || batteryPercent > 100
    || (chargingByte !== 0 && chargingByte !== 1)
  ) return null;

  return {
    active: activeByte === 1,
    dpiStage: data[1],
    pollingRateHz,
    batteryPercent,
    charging: chargingByte === 1,
    ledMode: LED_MODES[data[5]] ?? null,
    ledModeCode: data[5],
  };
}
