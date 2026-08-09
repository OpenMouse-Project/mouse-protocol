export * from "../compx/codec.js";
export const WLMOUSE_VENDOR_ID = 0x36a7;
export const WLMOUSE_POLLING_RATES = [
  [0x08, 125], [0x04, 250], [0x02, 500], [0x01, 1000],
  [0x10, 1000], [0x20, 2000], [0x40, 4000], [0x80, 8000],
] as const;

