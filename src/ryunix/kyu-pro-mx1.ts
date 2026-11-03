import { ryunixPollingHz } from "./protocol.ts";

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
  /**
   * Offset 4 raw: 0 discharging, 1 charging. 2 was captured from a wired XS
   * Flow 2 Speed at 100% and is read as full; other values are kept as sent.
   */
  batteryStatusCode: number;
  ledMode: RyunixLedMode | null;
  ledModeCode: number;
  /** Offset 7: the mouse's top polling-rate class (see `ryunixSupportedPollingRates`). */
  maxPollingCode: number | null;
  /** Offset 8: the sensor type (see `RYUNIX_SENSORS`). */
  sensorType: number | null;
}

/** Decode the telemetry body delivered by input report 0x04 (six bytes minimum, nine with sensor type). */
export function decodeKyuProMx1Telemetry(
  data: Uint8Array,
  reportId: number,
): KyuProMx1Telemetry | null {
  if (reportId !== RYUNIX_TELEMETRY_REPORT_ID || data.length < 6) return null;

  const activeByte = data[0];
  const pollingRateHz = ryunixPollingHz(data[2]);
  const batteryPercent = data[3];
  const batteryStatusCode = data[4];
  if (
    (activeByte !== 0 && activeByte !== 1)
    || pollingRateHz === null
    || batteryPercent > 100
    || batteryStatusCode > 2
  ) return null;

  return {
    active: activeByte === 1,
    dpiStage: data[1],
    pollingRateHz,
    batteryPercent,
    charging: batteryStatusCode === 1,
    batteryStatusCode,
    ledMode: LED_MODES[data[5]] ?? null,
    ledModeCode: data[5],
    maxPollingCode: data.length > 7 ? data[7] : null,
    sensorType: data.length > 8 && data[8] !== 0 ? data[8] : null,
  };
}
