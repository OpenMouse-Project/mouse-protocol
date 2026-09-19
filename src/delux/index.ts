/**
 * Delux M800 Mini catalogue and protocol exports.
 *
 * The Mini uses the 0x1d57 X11-style firmware under branded product names.
 * Its product IDs overlap other OEM mice, so IDs alone do not identify Delux
 * hardware.
 */

export const DELUX_OEM_VENDOR_ID = 0x1d57;

export const DELUX_M800_MINI_WIRELESS_PID = 0xfa60;
export const DELUX_M800_MINI_WIRED_PID = 0xfa55;

export const DELUX_PRODUCT_IDS: ReadonlySet<number> = new Set([
  DELUX_M800_MINI_WIRELESS_PID,
  DELUX_M800_MINI_WIRED_PID,
]);

export const DELUX_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [DELUX_M800_MINI_WIRELESS_PID, "Delux M800 Mini (Wireless)"],
  [DELUX_M800_MINI_WIRED_PID, "Delux M800 Mini (Wired)"],
]);

export const DELUX_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

export {
  buildX11DpiReport as buildDeluxM800MiniDpiReport,
  decodeX11DpiReport as decodeDeluxM800MiniDpiReport,
  nearestX11Dpi as nearestDeluxM800MiniDpi,
  X11_DPI_DEFAULT_ACTIVE as DELUX_DPI_DEFAULT_ACTIVE,
  X11_DPI_DEFAULT_STAGES as DELUX_DPI_DEFAULT_STAGES,
  X11_DPI_MAX as DELUX_DPI_MAX,
  X11_DPI_MIN as DELUX_DPI_MIN,
  X11_DPI_REPORT_ID as DELUX_DPI_REPORT_ID,
  X11_DPI_STAGE_COUNT as DELUX_DPI_STAGE_COUNT,
  X11_DPI_STEP as DELUX_DPI_STEP,
} from "../compx/x11-dpi.ts";
