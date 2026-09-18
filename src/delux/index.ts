/**
 * Delux mouse protocol constants and device catalogues.
 *
 * Supported hardware includes:
 * - Delux M800 Mini (PAW3395/3370 sensor, 0x1D57:0xFA60 wireless / 0xFA55 wired)
 * - Delux M800 / R1 OEM variants (0x1D57:0xFA61)
 * - Delux M800 Pro (0x248A:0x5B2F wireless / 0x5B2E wired)
 */

export const DELUX_VENDOR_ID = 0x248a;
export const DELUX_OEM_VENDOR_ID = 0x1d57;
export const DELUX_COMPX_VENDOR_ID = 0x373e;

export const DELUX_M800_MINI_WIRELESS_PID = 0xfa60;
export const DELUX_M800_MINI_WIRED_PID = 0xfa55;
export const DELUX_M800_WIRELESS_PID = 0xfa61;

export const DELUX_M800_PRO_WIRELESS_PID = 0x5b2f;
export const DELUX_M800_PRO_WIRED_PID = 0x5b2e;

export const DELUX_PRODUCT_IDS: ReadonlySet<number> = new Set([
  DELUX_M800_MINI_WIRELESS_PID,
  DELUX_M800_MINI_WIRED_PID,
  DELUX_M800_WIRELESS_PID,
  DELUX_M800_PRO_WIRELESS_PID,
  DELUX_M800_PRO_WIRED_PID,
]);

export const DELUX_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [DELUX_M800_MINI_WIRELESS_PID, "Delux M800 Mini (Wireless)"],
  [DELUX_M800_MINI_WIRED_PID, "Delux M800 Mini (Wired)"],
  [DELUX_M800_WIRELESS_PID, "Delux M800 (Wireless)"],
  [DELUX_M800_PRO_WIRELESS_PID, "Delux M800 Pro (Wireless)"],
  [DELUX_M800_PRO_WIRED_PID, "Delux M800 Pro (Wired)"],
]);

export const DELUX_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

export const DELUX_DPI_MIN = 50;
export const DELUX_DPI_MAX = 26000;
export const DELUX_DPI_STEP = 50;
