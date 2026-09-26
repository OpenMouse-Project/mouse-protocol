/**
 * Delux M800 Mini / M600 Pro catalogue and protocol exports.
 *
 * Both models use the 0x1d57 X11-style firmware. The Mini reports branded
 * product names, and its product IDs overlap other OEM mice, so IDs alone do
 * not identify it. The M600 Pro reports only generic Beken strings ("USB
 * Gaming Mouse" wired, "2.4G Wireless Device" on its receiver). Its wired
 * product ID is claimed by ID alone. Its receiver shares 0xfa60 with the X11
 * family and is named by the model id in its messages instead
 * (`DELUX_M600_PRO_MODEL_ID`). See docs/delux-m600-pro-testing.md.
 */

export const DELUX_OEM_VENDOR_ID = 0x1d57;

export const DELUX_M800_MINI_WIRELESS_PID = 0xfa60;
export const DELUX_M800_MINI_WIRED_PID = 0xfa55;
export const DELUX_M600_PRO_WIRED_PID = 0xfa71;

export const DELUX_PRODUCT_IDS: ReadonlySet<number> = new Set([
  DELUX_M800_MINI_WIRELESS_PID,
  DELUX_M800_MINI_WIRED_PID,
  DELUX_M600_PRO_WIRED_PID,
]);

/**
 * Model id the paired mouse sends in byte 1 of every receiver message
 * (`03 <model> <event> ...`, e.g. battery `03 20 40 01 <pct>`). The shared
 * 0xfa60 receiver carries no other identity; the X11 sends 0x55.
 */
export const DELUX_M600_PRO_MODEL_ID = 0x20;

/**
 * Delux product IDs whose firmware reports no Delux product string. Claimed by
 * ID alone: no other 0x1d57 device in this catalogue uses them.
 */
export const DELUX_UNBRANDED_PRODUCT_IDS: ReadonlySet<number> = new Set([
  DELUX_M600_PRO_WIRED_PID,
]);

export const DELUX_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [DELUX_M800_MINI_WIRELESS_PID, "Delux M800 Mini (Wireless)"],
  [DELUX_M800_MINI_WIRED_PID, "Delux M800 Mini (Wired)"],
  [DELUX_M600_PRO_WIRED_PID, "Delux M600 Pro (Wired)"],
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
  X11_DPI_VALUES as DELUX_DPI_VALUES,
} from "../compx/x11-dpi.ts";
