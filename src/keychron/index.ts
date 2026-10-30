/** Nape Pro VIA codec. Do not reuse these keymap/layer helpers for M-series Keychron mice. */
export const KEYCHRON_VENDOR_ID = 0x3434;
export const KEYCHRON_RAW_USAGE_PAGE = 0xff60;
export const KEYCHRON_RAW_USAGE = 0x61;
export const KEYCHRON_REPORT_ID = 0;
export const KEYCHRON_PACKET_LENGTH = 32;
/** Keychron M6 wired control interface and report layout, verified on PID 0xd060. */
export const KEYCHRON_M6_PRODUCT_ID = 0xd060;
/** Link-KM receiver paired with the Keychron M6, verified on 2.4 GHz. */
export const KEYCHRON_M6_RECEIVER_PRODUCT_ID = 0xd029;
export const KEYCHRON_M6_USAGE_PAGE = 0xffc1;
export const KEYCHRON_M6_USAGE = 0x01;
export const KEYCHRON_M6_COMMAND_REPORT_ID = 0xb3;
export const KEYCHRON_M6_COMMAND_RESPONSE_REPORT_ID = 0xb4;
export const KEYCHRON_M6_SETTINGS_REPORT_ID = 0xb5;
export const KEYCHRON_M6_SETTINGS_RESPONSE_REPORT_ID = 0xb6;
export const KEYCHRON_M6_STATUS_COMMAND = 0x06;
export const KEYCHRON_M6_STATUS_PACKET_LENGTH = 63;
/**
 * The M6's protocol is Launcher's "8k" one, which every Keychron mouse with a
 * 0xffc1 collection speaks. Launcher's "1k" protocol is the same command set
 * on usage page 0x8c: 20-byte feature report 0x51 for settings and 64-byte
 * feature report 0x52 for buttons. Launcher prefers 0xffc1, then 0x8c, then
 * the 4K family's 0xff0a when a device offers more than one.
 */
export const KEYCHRON_1K_USAGE_PAGE = 0x8c;
export const KEYCHRON_1K_USAGE = 0x01;
export const KEYCHRON_1K_REPORT_ID = 0x51;
export const KEYCHRON_1K_BUTTON_REPORT_ID = 0x52;
/** Default function Launcher's config gives a button; it also names the button. */
export type KeychronButtonId =
  | "left" | "right" | "middle" | "backward" | "forward"
  | "leftTilt" | "rightTilt" | "upScroll" | "downScroll" | "leftScroll" | "rightScroll"
  | "dpiLoop" | "pageUp" | "pageDown" | "swichLight";
/**
 * One row per product ID from Launcher's per-model config
 * (launcher.keychron.com/static/device/<vid << 16 | pid>/json/v3.json), named
 * as Launcher's product list names it. Neither says which of the two
 * protocols a model speaks; the collection it exposes decides that.
 */
export interface KeychronLauncherMouse {
  productId: number;
  name: string;
  /** dpi.limit */
  dpi: readonly [min: number, max: number];
  /** The highest rate in dpi.reportRate. */
  maxPollingHz: number;
  /** sys.lod stops written as the 2-bit lift-off code: [code, millimetres]. */
  lod?: ReadonlyArray<readonly [code: number, millimetres: number]>;
  /** sys.lod stops written as the lift-off level byte, on firmware that flags it: [level, millimetres]. */
  lodLevels?: ReadonlyArray<readonly [level: number, millimetres: number]>;
  /** keys: button index and its default function. */
  buttons: ReadonlyArray<readonly [index: number, id: KeychronButtonId]>;
  /** light: the effect codes the model offers. */
  light?: readonly number[];
  /** sys.disSensor: Launcher hides ripple control, angle snapping and motion sync. */
  noSensorOptions?: true;
}
/**
 * The M6 (0xd060) is the only row confirmed on hardware; its config lists 1
 * and 2 mm, but lift-off code 3 (0.7 mm) round-tripped on the mouse too.
 */
export const KEYCHRON_LAUNCHER_MICE: readonly KeychronLauncherMouse[] = [
  { productId: 0xd033, name: "Keychron M3", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [7, "swichLight"], [13, "downScroll"], [14, "upScroll"]], light: [1, 2, 3, 4, 5, 6] },
  { productId: 0xd035, name: "Keychron M1", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [5, "forward"], [6, "backward"], [13, "downScroll"], [14, "upScroll"]], light: [1, 2, 3, 4, 5, 6] },
  { productId: 0xd036, name: "Keychron M3 Mini", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd03b, name: "Keychron M2", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd03d, name: "Keychron M2 Mini", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd03f, name: "Keychron M6", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [8, "leftTilt"], [9, "rightTilt"], [10, "rightScroll"], [11, "leftScroll"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd043, name: "Keychron M4", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "right"], [2, "middle"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd044, name: "Keychron M7", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [7, "pageDown"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd048, name: "Keychron M5 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [8, "downScroll"], [9, "upScroll"], [10, "rightScroll"], [11, "leftScroll"]] },
  { productId: 0xd049, name: "Keychron M6 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [8, "rightTilt"], [9, "leftTilt"], [10, "rightScroll"], [11, "leftScroll"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd04a, name: "Keychron M3 KM", dpi: [50, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [5, "swichLight"], [6, "upScroll"], [7, "downScroll"]], light: [1, 2, 3, 4, 5, 6] },
  { productId: 0xd04c, name: "Keychron M3 Combo", dpi: [50, 12000], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [5, "pageDown"], [6, "upScroll"], [7, "downScroll"]], noSensorOptions: true },
  { productId: 0xd04d, name: "Keychron M2 Mini Combo", dpi: [50, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [6, "upScroll"], [7, "downScroll"]] },
  { productId: 0xd04e, name: "Keychron M3 Combo", dpi: [50, 12000], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [5, "pageDown"], [6, "upScroll"], [7, "downScroll"]], noSensorOptions: true },
  { productId: 0xd04f, name: "Keychron M3 Mini", dpi: [50, 12000], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [6, "upScroll"], [7, "downScroll"]], noSensorOptions: true },
  { productId: 0xd050, name: "Keychron M3 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "pageDown"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd051, name: "Keychron M3 Mini 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd052, name: "Keychron M2 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd053, name: "Keychron M4 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd054, name: "Keychron M1 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [5, "pageUp"], [6, "pageDown"], [13, "upScroll"], [14, "downScroll"]] },
  { productId: 0xd055, name: "Keychron M2 Mini 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd056, name: "Keychron M7 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "pageDown"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd058, name: "Keychron BM22", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [5, "dpiLoop"], [6, "upScroll"], [7, "downScroll"]], noSensorOptions: true },
  { productId: 0xd059, name: "Keychron M1", dpi: [100, 26000], maxPollingHz: 1000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [5, "forward"], [6, "backward"], [13, "downScroll"], [14, "upScroll"]], light: [1, 2, 3, 4, 5, 6] },
  { productId: 0xd060, name: "Keychron M6", dpi: [100, 26000], maxPollingHz: 1000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [8, "rightTilt"], [9, "leftTilt"], [10, "rightScroll"], [11, "leftScroll"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd061, name: "Keychron BM24", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [5, "dpiLoop"], [6, "upScroll"], [7, "downScroll"]], noSensorOptions: true },
  { productId: 0xd062, name: "Keychron BM25", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [5, "dpiLoop"], [6, "upScroll"], [7, "downScroll"]], noSensorOptions: true },
  { productId: 0xd063, name: "Keychron BM26", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [6, "upScroll"], [7, "downScroll"]], noSensorOptions: true },
  { productId: 0xd064, name: "Keychron M6", dpi: [50, 12000], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [8, "rightTilt"], [9, "leftTilt"], [10, "rightScroll"], [11, "leftScroll"], [13, "downScroll"], [14, "upScroll"]], noSensorOptions: true },
  { productId: 0xd067, name: "Keychron M6 SE", dpi: [50, 12000], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [8, "rightTilt"], [9, "leftTilt"], [10, "rightScroll"], [11, "leftScroll"], [13, "downScroll"], [14, "upScroll"]], noSensorOptions: true },
  { productId: 0xd068, name: "Keychron M5", dpi: [50, 12000], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [10, "rightScroll"], [11, "leftScroll"], [13, "upScroll"], [14, "downScroll"]], noSensorOptions: true },
  { productId: 0xd069, name: "Keychron M7", dpi: [50, 12000], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [7, "pageDown"], [13, "upScroll"], [14, "downScroll"]], noSensorOptions: true },
  { productId: 0xd06b, name: "Keychron LM7", dpi: [50, 26000], maxPollingHz: 8000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd06c, name: "Keychron LM7 Ultra", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd06d, name: "Keychron G4", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd06e, name: "Keychron G3", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd06f, name: "Keychron G5", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd070, name: "Keychron BM27", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [7, "dpiLoop"], [13, "upScroll"], [14, "downScroll"]], noSensorOptions: true },
  { productId: 0xd073, name: "Keychron M5 SE", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [7, "dpiLoop"], [13, "upScroll"], [14, "downScroll"]], noSensorOptions: true },
  { productId: 0xd074, name: "Keychron G3 HE", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd075, name: "Keychron M8", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd076, name: "Keychron M3 V2", dpi: [50, 26000], maxPollingHz: 8000, lod: [[1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [5, "upScroll"], [6, "downScroll"]], light: [1, 2, 3] },
  { productId: 0xd079, name: "Keychron BM28", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [7, "dpiLoop"], [13, "upScroll"], [14, "downScroll"]], noSensorOptions: true },
  { productId: 0xd080, name: "Keychron G4 HE", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd082, name: "Keychron BM28 8K", dpi: [50, 6000], maxPollingHz: 8000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [5, "dpiLoop"], [10, "rightScroll"], [11, "leftScroll"], [13, "upScroll"], [14, "downScroll"]], noSensorOptions: true },
  { productId: 0xd083, name: "Keychron G3 HE", dpi: [50, 40000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], lodLevels: [[2, 0.9], [3, 1.2], [4, 1.4], [5, 1.6]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd084, name: "Keychron T1 HE", dpi: [100, 2400], maxPollingHz: 1000, buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [7, "dpiLoop"], [13, "upScroll"], [14, "downScroll"]], noSensorOptions: true },
  { productId: 0xd086, name: "Keychron G6 HE 8K", dpi: [50, 40000], maxPollingHz: 8000, lodLevels: [[1, 0.7], [2, 0.8], [3, 0.9], [4, 1], [5, 1.1], [6, 1.2], [7, 1.3], [8, 1.4], [9, 1.5], [10, 1.6], [11, 1.7]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [13, "upScroll"], [14, "downScroll"]] },
  { productId: 0xd087, name: "Keychron G5 HE", dpi: [50, 40000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd08a, name: "Keychron M6 HE 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [8, "rightTilt"], [9, "leftTilt"], [10, "rightScroll"], [11, "leftScroll"], [13, "downScroll"], [14, "upScroll"]] },
  { productId: 0xd08c, name: "Keychron G10 HE", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd091, name: "Keychron M8 HE", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd092, name: "Keychron G9 HE 8K", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd09d, name: "Keychron G6 HE 8K", dpi: [50, 40000], maxPollingHz: 8000, lodLevels: [[1, 0.7], [2, 0.8], [3, 0.9], [4, 1], [5, 1.1], [6, 1.2], [7, 1.3], [8, 1.4], [9, 1.5], [10, 1.6], [11, 1.7]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [13, "upScroll"], [14, "downScroll"]] },
  { productId: 0xd0a2, name: "Keychron G6 HE 8K", dpi: [50, 40000], maxPollingHz: 8000, lodLevels: [[1, 0.7], [2, 0.8], [3, 0.9], [4, 1], [5, 1.1], [6, 1.2], [7, 1.3], [8, 1.4], [9, 1.5], [10, 1.6], [11, 1.7]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "forward"], [4, "backward"], [13, "upScroll"], [14, "downScroll"]] },
  { productId: 0xd0a3, name: "Keychron G3 HE", dpi: [50, 40000], maxPollingHz: 8000, lodLevels: [[1, 0.7], [2, 0.8], [3, 0.9], [4, 1], [5, 1.1], [6, 1.2], [7, 1.3], [8, 1.4], [9, 1.5], [10, 1.6], [11, 1.7]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
  { productId: 0xd085, name: "JamesDonkey RSR7 Ultra+", dpi: [50, 30000], maxPollingHz: 8000, lod: [[3, 0.7], [1, 1], [2, 2]], buttons: [[0, "left"], [1, "middle"], [2, "right"], [3, "backward"], [4, "forward"], [7, "upScroll"], [8, "downScroll"]] },
];
/** Receivers in Launcher's product list (category "Bridge"). */
export const KEYCHRON_RECEIVERS = new Map<number, string>([
  [0xd024, "CANDYSIGN Link"],
  [0xd026, "Keychron Link-KM"],
  [0xd027, "Keychron Receiver"],
  [0xd028, "Keychron Ultra-Link 8K"],
  [0xd029, "Keychron Link-KM Type C"],
  [0xd030, "Keychron Link Type A"],
  [0xd031, "Keychron Link Type C"],
  [0xd05a, "Keychron TurboLink 8K"],
]);
/**
 * Keychron's 4K mice speak Launcher's "4k" protocol on this collection: the
 * Nordic DMS v1 framing the Orbital driver also uses (64-byte report 0, 0xA1
 * checksum, 0x40 on byte 0 to route through the receiver). Decoded from
 * Keychron Launcher, not yet confirmed on hardware.
 */
export const KEYCHRON_4K_USAGE_PAGE = 0xff0a;
export const KEYCHRON_4K_USAGE = 0x01;
/**
 * Wired product ID of each 4K model and the model ID its firmware reports in
 * the version reply, which is how a receiver says what it is paired with
 * (Launcher's receiver table). 0xd041 is the aluminium M3 Mini 4K.
 */
export const KEYCHRON_4K_MICE: ReadonlyArray<{ productId: number; modelId: number; name: string }> = [
  { productId: 0xd040, modelId: 0x0621, name: "Keychron M4 4K" },
  { productId: 0xd046, modelId: 0x0624, name: "Keychron M6 4K" },
  { productId: 0xd03c, modelId: 0x07a0, name: "Keychron M3 4K" },
  { productId: 0xd037, modelId: 0x0620, name: "Keychron M3 Mini 4K" },
  { productId: 0xd041, modelId: 0x0622, name: "Keychron M3 Mini 4K" },
  { productId: 0xd045, modelId: 0x0623, name: "Keychron M2 4K" },
];
/**
 * Mice on Launcher's "8k_nordic" protocol: the same 0xff0a collection and
 * framing as the 4K family, with Orbital's DMS v2 settings layout. The G3 Air
 * config forces that protocol by name; Launcher's product list describes the
 * mouse as "54L" (nRF54L15).
 */
export const KEYCHRON_8K_NORDIC_MICE: ReadonlyArray<{ productId: number; name: string }> = [
  { productId: 0xd077, name: "Keychron G3 Air" },
  { productId: 0x2801, name: "Keychron LM7 Air" },
];
/**
 * Ultra-Link 8K receivers from Keychron's product list. 0xd05b is listed with
 * an nRF54LM20A, the receiver half of the 54L platform; 0xd078 was added next
 * to the G3 Air. Neither pairing is confirmed on hardware.
 */
export const KEYCHRON_8K_NORDIC_RECEIVER_PRODUCT_IDS: readonly number[] = [0xd05b, 0xd078];
export const KEYCHRON_8K_NORDIC_PRODUCT_IDS: readonly number[] = [
  ...KEYCHRON_8K_NORDIC_MICE.map((mouse) => mouse.productId),
  ...KEYCHRON_8K_NORDIC_RECEIVER_PRODUCT_IDS,
];
/** Lemokey, Keychron's gaming brand; an 8K Nordic handshake carries either vendor ID. */
export const LEMOKEY_VENDOR_ID = 0x362d;
export const KEYCHRON_PRODUCTS = new Map<number, { name: string; receiver?: boolean }>([
  [0x0440, { name: "Nape Pro" }],
  [0xd026, { name: "Keychron Link-KM", receiver: true }],
  [0xd029, { name: "Keychron Link-KM Type C", receiver: true }],
]);
export const KEYCHRON_NAPE_PRODUCTS = new Map<number, { name: string; receiver?: boolean }>([
  [0x0440, { name: "Nape Pro" }],
  [0xd026, { name: "Keychron Link-KM", receiver: true }],
  [0xd029, { name: "Keychron Link-KM Type C", receiver: true }],
]);
export const KEYCHRON_COMMAND = { firmwareVersion: 161, getCurrentLayer: 163, miscGroup: 167 } as const;
/** Standard VIA opcodes used by Nape for keymap metadata (not the 0xA7 misc group). */
export const KEYCHRON_VIA_COMMAND = {
  getKeycode: 4,
  setKeycode: 5,
  getLayerCount: 17,
  getBuffer: 18,
  getEncoder: 20,
  setEncoder: 21,
} as const;
export const KEYCHRON_NAPE_COMMAND = {
  getOrientation: 32, getDpiStage: 33, setDpiStage: 34, setDpiValue: 35,
  getDpiValue: 36, setLayer: 45, getBattery: 49, setOrientation: 52,
  getCustomDpi: 54, setCustomDpi: 55, getLayerOrientation: 56, setLayerOrientation: 57,
} as const;
/** Sensor heading is stored per layer in 45° steps (0–7 → 0°–315°). */
export const KEYCHRON_NAPE_ORIENTATION_STEPS = 8;
export const KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES = 45;
/**
 * Nape Pro exposes eight user layers (1–8). VIA may report a spare slot at
 * index 0; GET_CURRENT_LAYER and keymap/encoder commands use the same 1–8
 * index. Keychron Launcher writes GET_BUFFER offset 14 * 3 when the mouse
 * reports current layer 3.
 */
export const KEYCHRON_NAPE_LAYER_COUNT = 8;
export const KEYCHRON_MISC_COMMAND = {
  getSleep: 11,
  setSleep: 12,
  getPolling: 13,
  setPolling: 14,
} as const;
export const KEYCHRON_POLLING_TABLE = [8000, 4000, 2000, 1000, 500, 250, 125] as const;
/** Nape Pro only — observed on firmware v1.2.6-ZK (stage 5 stores 4000). Other Keychron mice should define their own ranges. */
export const KEYCHRON_NAPE_DPI_MIN = 50;
export const KEYCHRON_NAPE_DPI_MAX = 4000;
export const KEYCHRON_NAPE_DPI_STEP = 50;
export const KEYCHRON_NAPE_SLEEP_MIN_SECONDS = 60;
export const KEYCHRON_NAPE_SLEEP_MAX_SECONDS = 12 * 3600 + 59 * 60 + 59;
export const KEYCHRON_NAPE_SLEEP_OPTIONS = [
  60, 120, 300, 600, 1800, 3600, 7200, 18_000, 43_200,
] as const;

export function keychronPacket(command: readonly number[]): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(KEYCHRON_PACKET_LENGTH);
  packet.set(command.slice(0, KEYCHRON_PACKET_LENGTH));
  return packet;
}

export function keychronDecodePolling(response: Uint8Array): { rateHz: number; supported: number[] } {
  if (response.slice(2).every((byte) => byte === 0)) return { rateHz: 1000, supported: [125, 500, 1000] };
  const mask = response[5] ?? 0;
  const supported = KEYCHRON_POLLING_TABLE.filter((_, index) => ((mask >> index) & 1) === 1).slice().sort((a, b) => a - b);
  const rateHz = KEYCHRON_POLLING_TABLE[Math.min(response[6] ?? 3, KEYCHRON_POLLING_TABLE.length - 1)] ?? 1000;
  return { rateHz, supported: supported.length ? supported : [rateHz] };
}

export function keychronDecodeFirmware(response: Uint8Array): string | null {
  const end = response.indexOf(0, 1);
  const bytes = response.slice(1, end < 0 ? undefined : end);
  if (!bytes.length) return null;
  const text = String.fromCharCode(...bytes);
  return text.startsWith("v") ? text : `v${text}`;
}

export function keychronDecodeBattery(
  response: Uint8Array,
): { percent: number; state: "Charging" | "Full" | "Discharging" } {
  const percent = response[2] ?? 0xff;
  const status = response[3] ?? 0;
  const state = status === 1
    ? "Charging"
    : status === 2
      ? "Full"
      : "Discharging";
  return { percent, state };
}

export function keychronDecodeSleepTimeout(response: Uint8Array): number {
  return (response[5] ?? 0) | ((response[6] ?? 0) << 8);
}

export function keychronEncodeSleepTimeout(seconds: number): number[] {
  return [
    KEYCHRON_COMMAND.miscGroup,
    KEYCHRON_MISC_COMMAND.setSleep,
    0,
    0,
    seconds & 0xff,
    (seconds >> 8) & 0xff,
    0,
    0,
  ];
}

export function keychronDecodeLayerCount(response: Uint8Array): number {
  return response[1] ?? 0;
}

export function keychronDecodeCurrentLayer(response: Uint8Array): number {
  const reported = response[1] ?? 1;
  if (reported < 1) return 1;
  return Math.min(reported, KEYCHRON_NAPE_LAYER_COUNT);
}

export function keychronEncodeSetLayer(layer: number): number[] {
  return [KEYCHRON_COMMAND.miscGroup, KEYCHRON_NAPE_COMMAND.setLayer, layer & 0xff];
}

export function keychronOrientationIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= KEYCHRON_NAPE_ORIENTATION_STEPS) {
    throw new Error(`Orientation must be a 45° step from 0° to 315°.`);
  }
  return index;
}

export function keychronOrientationDegrees(index: number): number {
  return KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES * keychronOrientationIndex(index);
}

export function keychronOrientationLabel(index: number): string {
  return `${keychronOrientationDegrees(index)}\u00b0`;
}

export const KEYCHRON_NAPE_ORIENTATION_OPTIONS = Array.from(
  { length: KEYCHRON_NAPE_ORIENTATION_STEPS },
  (_, index) => ({
    index,
    degrees: KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES * index,
    label: `${KEYCHRON_NAPE_ORIENTATION_STEP_DEGREES * index}\u00b0`,
  }),
);

export function keychronDecodeOrientationIndex(response: Uint8Array): number {
  return response[2] ?? 0xff;
}

export function keychronEncodeSetOrientation(index: number): number[] {
  return [KEYCHRON_COMMAND.miscGroup, KEYCHRON_NAPE_COMMAND.setOrientation, keychronOrientationIndex(index)];
}

export function keychronEncodeGetLayerOrientation(layer: number): number[] {
  return [KEYCHRON_COMMAND.miscGroup, KEYCHRON_NAPE_COMMAND.getLayerOrientation, layer & 0xff];
}

export function keychronEncodeSetLayerOrientation(layer: number, index: number): number[] {
  return [
    KEYCHRON_COMMAND.miscGroup,
    KEYCHRON_NAPE_COMMAND.setLayerOrientation,
    layer & 0xff,
    keychronOrientationIndex(index),
  ];
}

/** Nape VIA keymap is 7 packed columns; the overlay exposes the first six. */
export const KEYCHRON_NAPE_KEYMAP_COLUMNS = 7;
export const KEYCHRON_NAPE_KEYMAP_BUFFER_SIZE = KEYCHRON_NAPE_KEYMAP_COLUMNS * 2;
export const KEYCHRON_NAPE_KEY_CONTROLS = [
  { col: 0, name: "03" },
  { col: 1, name: "04" },
  { col: 2, name: "01" },
  { col: 3, name: "02" },
  { col: 4, name: "M1" },
  { col: 5, name: "M2" },
] as const;
export const KEYCHRON_NAPE_ENCODER_ID = 0;
export const KEYCHRON_NAPE_ENCODER_CCW = 0;
export const KEYCHRON_NAPE_ENCODER_CW = 1;

/** VIA protocol 12 QMK keycodes confirmed on Nape Pro firmware v1.2.6-ZK. */
export const KEYCHRON_QK_USER = 0x7e00;
export const KEYCHRON_QK_MOMENTARY = 0x5220;
export const KEYCHRON_NAPE_KEYCODE = {
  no: 0,
  mute: 0x00a8,
  volumeUp: 0x00a9,
  volumeDown: 0x00aa,
  leftClick: 0x00d1,
  rightClick: 0x00d2,
  middleClick: 0x00d3,
  backward: 0x00d4,
  forward: 0x00d5,
  scrollUp: 0x00d9,
  scrollDown: 0x00da,
  scrollLeft: 0x00db,
  scrollRight: 0x00dc,
  dpiNext: KEYCHRON_QK_USER + 37,
  dpiPrev: KEYCHRON_QK_USER + 38,
  pollingPrev: KEYCHRON_QK_USER + 39,
  pollingNext: KEYCHRON_QK_USER + 40,
  orientationCycle: KEYCHRON_QK_USER + 43,
  dpiCycle: KEYCHRON_QK_USER + 44,
  pollingCycle: KEYCHRON_QK_USER + 45,
  doubleClick: KEYCHRON_QK_USER + 46,
  customDpi: KEYCHRON_QK_USER + 47,
  gestureMode: KEYCHRON_QK_MOMENTARY + 9,
  scrollMode: KEYCHRON_QK_MOMENTARY + 10,
} as const;

export const KEYCHRON_NAPE_BUTTON_ACTIONS = [
  "Disabled",
  "Left click",
  "Right click",
  "Middle click",
  "Back",
  "Forward",
  "Double left click",
  "Scroll up",
  "Scroll down",
  "Scroll left",
  "Scroll right",
  "Volume up",
  "Volume down",
  "Mute",
  "Scroll mode",
  "Gesture mode",
  "DPI cycle",
  "DPI up",
  "DPI down",
  "Polling cycle",
  "Polling up",
  "Polling down",
  "Cycle orientation",
] as const;
export type KeychronNapeButtonAction = (typeof KEYCHRON_NAPE_BUTTON_ACTIONS)[number];

const KEYCHRON_NAPE_BUTTON_KEYCODES: Record<KeychronNapeButtonAction, number> = {
  Disabled: KEYCHRON_NAPE_KEYCODE.no,
  "Left click": KEYCHRON_NAPE_KEYCODE.leftClick,
  "Right click": KEYCHRON_NAPE_KEYCODE.rightClick,
  "Middle click": KEYCHRON_NAPE_KEYCODE.middleClick,
  Back: KEYCHRON_NAPE_KEYCODE.backward,
  Forward: KEYCHRON_NAPE_KEYCODE.forward,
  "Double left click": KEYCHRON_NAPE_KEYCODE.doubleClick,
  "Scroll up": KEYCHRON_NAPE_KEYCODE.scrollUp,
  "Scroll down": KEYCHRON_NAPE_KEYCODE.scrollDown,
  "Scroll left": KEYCHRON_NAPE_KEYCODE.scrollLeft,
  "Scroll right": KEYCHRON_NAPE_KEYCODE.scrollRight,
  "Volume up": KEYCHRON_NAPE_KEYCODE.volumeUp,
  "Volume down": KEYCHRON_NAPE_KEYCODE.volumeDown,
  Mute: KEYCHRON_NAPE_KEYCODE.mute,
  "Scroll mode": KEYCHRON_NAPE_KEYCODE.scrollMode,
  "Gesture mode": KEYCHRON_NAPE_KEYCODE.gestureMode,
  "DPI cycle": KEYCHRON_NAPE_KEYCODE.dpiCycle,
  "DPI up": KEYCHRON_NAPE_KEYCODE.dpiNext,
  "DPI down": KEYCHRON_NAPE_KEYCODE.dpiPrev,
  "Polling cycle": KEYCHRON_NAPE_KEYCODE.pollingCycle,
  "Polling up": KEYCHRON_NAPE_KEYCODE.pollingNext,
  "Polling down": KEYCHRON_NAPE_KEYCODE.pollingPrev,
  "Cycle orientation": KEYCHRON_NAPE_KEYCODE.orientationCycle,
};

const KEYCHRON_NAPE_BUTTON_ACTION_BY_KEYCODE = new Map<number, KeychronNapeButtonAction>(
  Object.entries(KEYCHRON_NAPE_BUTTON_KEYCODES).map(([action, keycode]) => [keycode, action as KeychronNapeButtonAction]),
);

export interface KeychronNapeMappedControl {
  keycode: number;
  action: KeychronNapeButtonAction | "Custom";
}

export interface KeychronNapeLayerKeymap {
  layer: number;
  keys: Array<KeychronNapeMappedControl & { col: number; name: string }>;
  wheel: { ccw: KeychronNapeMappedControl; cw: KeychronNapeMappedControl };
  /** Saved sensor heading for this layer, 0–7 (0°–315°). */
  orientationIndex: number;
}

export function keychronUserLayerToVia(layer: number): number {
  return Math.min(Math.max(layer, 1), KEYCHRON_NAPE_LAYER_COUNT);
}

/** Firmware layers are 1–8; the UI and Launcher label them 0–7. */
export function keychronLayerDisplayIndex(layer: number): number {
  return keychronUserLayerToVia(layer) - 1;
}

export function keychronLayerLabel(layer: number): string {
  return `Layer ${keychronLayerDisplayIndex(layer)}`;
}

export function keychronActionForKeycode(keycode: number): KeychronNapeButtonAction | "Custom" {
  return KEYCHRON_NAPE_BUTTON_ACTION_BY_KEYCODE.get(keycode) ?? "Custom";
}

export function keychronKeycodeForAction(action: KeychronNapeButtonAction): number {
  return KEYCHRON_NAPE_BUTTON_KEYCODES[action];
}

export function keychronMappedControl(keycode: number): KeychronNapeMappedControl {
  return { keycode, action: keychronActionForKeycode(keycode) };
}

export function keychronLayerKeymapFromCodes(
  layer: number,
  columnCodes: readonly number[],
  ccw: number,
  cw: number,
  orientationIndex = 0,
): KeychronNapeLayerKeymap {
  return {
    layer,
    keys: KEYCHRON_NAPE_KEY_CONTROLS.map((control) => ({
      ...control,
      ...keychronMappedControl(columnCodes[control.col] ?? 0),
    })),
    wheel: {
      ccw: keychronMappedControl(ccw),
      cw: keychronMappedControl(cw),
    },
    orientationIndex,
  };
}

export function keychronEncodeGetBuffer(viaLayer: number): number[] {
  const offset = KEYCHRON_NAPE_KEYMAP_BUFFER_SIZE * viaLayer;
  return [
    KEYCHRON_VIA_COMMAND.getBuffer,
    (offset >> 8) & 0xff,
    offset & 0xff,
    KEYCHRON_NAPE_KEYMAP_BUFFER_SIZE,
  ];
}

export function keychronDecodeKeymapBuffer(response: Uint8Array): number[] {
  const size = response[3] ?? 0;
  const data = response.subarray(4, 4 + size);
  const codes: number[] = [];
  for (let index = 0; index + 1 < data.length; index += 2) {
    codes.push(((data[index] ?? 0) << 8) | (data[index + 1] ?? 0));
  }
  return codes;
}

export function keychronEncodeGetKeycode(viaLayer: number, col: number): number[] {
  return [KEYCHRON_VIA_COMMAND.getKeycode, viaLayer & 0xff, 0, col & 0xff];
}

export function keychronEncodeSetKeycode(viaLayer: number, col: number, keycode: number): number[] {
  return [
    KEYCHRON_VIA_COMMAND.setKeycode,
    viaLayer & 0xff,
    0,
    col & 0xff,
    (keycode >> 8) & 0xff,
    keycode & 0xff,
  ];
}

export function keychronEncodeGetEncoder(viaLayer: number, clockwise: boolean): number[] {
  return [
    KEYCHRON_VIA_COMMAND.getEncoder,
    viaLayer & 0xff,
    KEYCHRON_NAPE_ENCODER_ID,
    clockwise ? KEYCHRON_NAPE_ENCODER_CW : KEYCHRON_NAPE_ENCODER_CCW,
  ];
}

export function keychronEncodeSetEncoder(viaLayer: number, clockwise: boolean, keycode: number): number[] {
  return [
    KEYCHRON_VIA_COMMAND.setEncoder,
    viaLayer & 0xff,
    KEYCHRON_NAPE_ENCODER_ID,
    clockwise ? KEYCHRON_NAPE_ENCODER_CW : KEYCHRON_NAPE_ENCODER_CCW,
    (keycode >> 8) & 0xff,
    keycode & 0xff,
  ];
}

export function keychronDecodeKeycodeReply(response: Uint8Array): number {
  return ((response[4] ?? 0) << 8) | (response[5] ?? 0);
}

