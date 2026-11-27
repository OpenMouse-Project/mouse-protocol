import type { MouseLighting, MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import { LAMZU_PRODUCTS } from "@openmouse/protocol/lamzu";
import { DELUX_M600_PRO_MODEL_ID, DELUX_UNBRANDED_PRODUCT_IDS } from "@openmouse/protocol/delux";
import { REDRAGON_M719_PRO_PRODUCTS } from "@openmouse/protocol/redragon";
import {
  buildX11DpiReport,
  decodeX11DpiReport,
  nearestX11Dpi,
  X11_DPI_DEFAULT_ACTIVE,
  X11_DPI_DEFAULT_STAGES,
  X11_DPI_MAX,
  X11_DPI_MIN,
  X11_DPI_REPORT_ID,
  X11_DPI_STAGE_COUNT,
  X11_DPI_STEP,
  X11_DPI_VALUES,
} from "../../compx/x11-dpi.ts";
import {
  buildX11ButtonReport,
  buildX11MacroReports,
  buildX11PowerReport,
  buildX11QueryRequest,
  decodeX11ButtonReport,
  decodeX11FirmwareVersion,
  decodeX11PollingReport,
  decodeX11PowerReport,
  X11_BUTTON_REPORT_ID,
  X11_BUTTON_SLOTS,
  X11_DEBOUNCE_OPTIONS,
  X11_LIGHT_BRIGHTNESS,
  X11_LIGHT_MODES,
  X11_LIGHT_SPEEDS,
  X11_MACRO_REPORT_ID,
  X11_POWER_REPORT_ID,
  X11_QUERY_REPORT_ID,
  X11_SLEEP_OPTIONS,
  X11_VERSION_REPORT_ID,
  type X11ButtonAction,
  type X11MacroEvent,
  type X11PowerSettings,
  x11QueryReady,
} from "../../compx/x11-config.ts";
import {
  buildX3Burst,
  buildX3MacroChunks,
  defaultX3Settings,
  X3_BUTTON_OPTIONS,
  X3_BUTTON_SLOT,
  X3_FACTORY_BUTTONS,
  X3_MACRO_GAP_MS,
  x3ActionLabel,
  x3ParseActionLabel,
  type X3MacroEvent,
  parseX3Battery,
  X3_DPI_MAX,
  X3_DPI_MIN,
  X3_DPI_STEP,
  X3_MAX_STAGES,
  X3_RECEIVER_GAP_MS,
  X3_WIRED_GAP_MS,
  type X3PollingHz,
  type X3Rgb,
  type X3Settings,
} from "../../compx/x3-config.ts";

// Attack Shark mice ship from multiple OEMs with different VIDs and protocols:
//
//   0x1d57 — R1, X11, X3, X6 and more on shared PIDs: HID feature reports,
//            250 ms cmd delay; the model id rides in receiver messages
//   0x25a7 — X3, X6, X8, X11 direct: GearHub-derived protocol (report 0, 64 B)
//   0x373e — R5 Ultra, R6, R8, R3 (Lamzu OEM) — usagePage 0xffff feature reports
//
// PIDs change between firmware revisions, so detection is collection-based,
// not PID-based. For 0x373e we exclude known Lamzu PIDs.
//
// Real X11 hardware (0x1d57, wired 0xfa55 and wireless 0xfa60) exposes NO
// feature reports to the browser on any of its four HID entries. Its config
// channel is USB interface 2 (a system-control/consumer composite; see the
// lsusb dump in dressedinblack5/attack-shark-x11-electron docs/descritors),
// and WebHID only surfaces the Consumer collection, which declares none. The
// config feature reports (0x06 polling, 0x04 DPI) are still reachable through
// the OS HID stack on interface 2's `&col04` sub-collection: node-hid does
// this on Windows with the stock input.inf (no Zadig/WinUSB), and the Tauri
// Desktop app's Rust hidapi adapter opens every sub-collection path too. The
// browser-side collection gate below therefore refuses these units, and the
// X11-family helper turns that refusal into a real explanation; the
// collections-less native branch writes the same packets over such an adapter.
//
// Linux is the exception: hidraw hands the browser interface 2's whole report
// descriptor, so WebHID sees the 0x0b collection with 0x04/0x06 and the same
// packets are written from the browser (verified on a Delux M600 Pro on the
// 0xfa60 receiver; see docs/delux-m600-pro-testing.md).
//
// OpenMouse Bridge on Windows sits in between: its hidapi transport lists the
// 0x0a battery and 0x0b config collections, but Windows rebuilds their
// descriptors from preparsed data, which has no entry for this firmware's
// Constant-only items. The 0x0a collection then reads as unnumbered, so
// receiver messages arrive as report 0 with the 0x03 id still in the data,
// and the 0x0b collection declares no reports at all. Bridge sends a report no
// collection declares to every path, and the 0x0b path is the only one with a
// feature length on Windows (262 bytes), so the write lands there
// (captures/delux-m600-pro/windows-bridge.txt).
//
// Protocol source: xb-bx/attack-shark-r1-driver (Odin)
//                  HarukaYamamoto0/attack-shark-x11-driver (TypeScript)
//                  qmk.top GearHub bundle (MU class — 0x25a7 protocol)
//                  Research credit: viix0dev

// ── VID constants ─────────────────────────────────────────────────────────

const VID_1D57 = 0x1d57; // R1 / X11 family
const VID_25A7 = VENDOR_ID.attackShark; // X3, X6, X8, X11 direct
const VID_373E = 0x373e; // Lamzu OEM (R5 Ultra, R6, R8, R3)

// ── 0x1d57 protocol (R1 / X11) ───────────────────────────────────────────
// Confirmed from open-source driver research.

const CMD_DELAY_MS = 300;

// Polling rate: feature report 0x06, 9 bytes.
// [len=0x09, 0x01, rate_byte, checksum, 0, 0, 0, 0]
// (The browser prepends the report ID 0x06 when calling sendFeatureReport.)
const POLLING_REPORT_ID = 0x06;

const POLLING_RATES_1D57: ReadonlyArray<readonly [number, number]> = [
  [0x08, 125],
  [0x04, 250],
  [0x02, 500],
  [0x01, 1000],
];

const DPI_READ_REPORT_ID = 0xa0;

// Receiver messages arrive as input report 0x03: [0x03, model, event, p1, p2].
// Byte 1 is the paired mouse's model id (HarukaYamamoto0/attack-shark-x11-driver
// docs/messages/README.md). The PIDs are shared across the whole platform, so
// this byte is the only thing that names the mouse. Battery is event 0x40 with
// p1 = 0x01; p2's scale differs per model, so only models whose scale was
// checked carry `battery` (the others are named but report no battery).
const BATTERY_REPORT_ID = 0x03;
/** Receiver messages are always five bytes, report id included. */
const RECEIVER_MESSAGE_BYTES = 5;
/** Interface 2's battery (input 0x03) and config (features) collections. */
const X11_BATTERY_USAGE_PAGE = 0x0a;
const X11_CONFIG_USAGE_PAGE = 0x0b;

interface ReceiverModel {
  brand: "Attack Shark" | "Delux";
  name: string;
  battery?: "percent" | "tenths";
}

const attackShark = (model: string, battery?: ReceiverModel["battery"]): ReceiverModel =>
  ({ brand: "Attack Shark", name: `Attack Shark ${model}`, battery });

/**
 * Models identified by the model id their receiver messages carry. Attack
 * Shark ids: HarukaYamamoto0/attack-shark-x11-driver src/core/devices.ts.
 */
const X11_MODEL_ID = 0x55;
const X11_RECEIVER_MODELS: ReadonlyMap<number, ReceiverModel> = new Map([
  [X11_MODEL_ID, attackShark("X11", "percent")],
  // xb-bx/attack-shark-r1-driver reports charge as p2 * 10.
  [0x10, attackShark("R1", "tenths")],
  [0x85, attackShark("X6", "tenths")],
  [0x4d, attackShark("X3")],
  [0x4e, attackShark("X3 Max")],
  [0x01, attackShark("X3 Pro")],
  [0x07, attackShark("X11 SE", "percent")],
  [0xbe, attackShark("X11 Pro")],
  [0xb1, attackShark("X1")],
  [0x02, attackShark("X8 SE")],
  [0x06, attackShark("X8 Plus")],
  [0x08, attackShark("X8 Pro")],
  [0x04, attackShark("G3")],
  [0x0e, attackShark("G3 Pro")],
  [0x24, attackShark("V6")],
  [0xe5, attackShark("V3 Pro")],
  [0xea, attackShark("V3")],
  // docs/delux-m600-pro-testing.md
  [DELUX_M600_PRO_MODEL_ID, { brand: "Delux", name: "Delux M600 Pro (Wireless)", battery: "percent" }],
]);

// ── 0x25a7 protocol (GearHub / MU class) ─────────────────────────────────
// Reverse-engineered from the qmk.top GearHub web driver JS bundle.
// Uses HID feature reports on report ID 0x00, 64 bytes total.
// Commands are padded to 9 bytes; checksum goes in byte[7].

const REPORT_ID_25A7 = 0x00;
const REPORT_LEN_25A7 = 64;
const CMD_LEN_25A7 = 9;
const CMD_DELAY_25A7_MS = 100;

// Command IDs (MU class)
const FEA_CMD_GET_REV = 0x80; // Get firmware revision
const FEA_CMD_GET_DPI = 0xd4; // Get DPI slots (param: profile)
const FEA_CMD_SET_REPORT_RATE = 0x04; // Set polling rate

/** Polling-rate byte codes used by the 0x25a7 protocol. */
export const POLLING_CODES_25A7: ReadonlyMap<number, number> = new Map([
  [125, 0x08],
  [250, 0x04],
  [500, 0x02],
  [1000, 0x01],
  [2000, 0x84],
  [4000, 0x82],
  [8000, 0x81],
]);

// ── Collection helpers ─────────────────────────────────────────────────────

function hasFeatureReports(collection: HIDCollectionInfo): boolean {
  if (collection.featureReports.length > 0) return true;
  return collection.children.some(hasFeatureReports);
}

function hasVendorControl(collection: HIDCollectionInfo): boolean {
  if (collection.usagePage === 0xffff && collection.featureReports.length > 0) return true;
  return collection.children.some(hasVendorControl);
}

function featureReportBytes(collection: HIDCollectionInfo, reportId: number): number | null {
  const report = collection.featureReports.find((entry) => entry.reportId === reportId);
  if (report) {
    const bits = (report.items ?? []).reduce(
      (sum, item) => sum + (item.reportSize ?? 0) * (item.reportCount ?? 0),
      0,
    );
    return Math.ceil(bits / 8);
  }
  for (const child of collection.children) {
    const bytes = featureReportBytes(child, reportId);
    if (bytes !== null) return bytes;
  }
  return null;
}

/**
 * Declared payload length of the X11 DPI report 0x04 when the browser exposes
 * the config channel (0x04 beside the 0x06 polling report), else null. Linux
 * hidraw hands WebHID interface 2's whole descriptor, so the channel is
 * visible there; Windows keeps it on a sub-collection the browser cannot open.
 * A length of 0 means the descriptor sizes were not available.
 */
function x11ConfigReportBytes(device: HIDDevice): number | null {
  for (const collection of device.collections) {
    const dpiBytes = featureReportBytes(collection, X11_DPI_REPORT_ID);
    if (dpiBytes !== null && featureReportBytes(collection, POLLING_REPORT_ID) !== null) return dpiBytes;
  }
  return null;
}

function declaresAnyReport(collection: HIDCollectionInfo): boolean {
  return collection.inputReports.length > 0
    || collection.outputReports.length > 0
    || collection.featureReports.length > 0
    || collection.children.some(declaresAnyReport);
}

/**
 * True when the config collection is listed but declares no reports: the
 * shape a descriptor rebuilt from Windows preparsed data takes (OpenMouse
 * Bridge on Windows). Chrome on Windows does not list the collection, and
 * Linux hidraw lists it with its feature reports.
 */
function x11RebuiltConfigCollection(device: HIDDevice): boolean {
  return device.collections.some(
    (collection) => collection.usagePage === X11_CONFIG_USAGE_PAGE && !declaresAnyReport(collection),
  );
}

function declaresInputReport(collection: HIDCollectionInfo, reportId: number): boolean {
  if (collection.inputReports.some((report) => report.reportId === reportId)) return true;
  return collection.children.some((child) => declaresInputReport(child, reportId));
}

// ── X11 family (config is native-only; battery is readable) ──────────────

// Documented 0x1d57 PIDs: two wired ones (0xfa55 on the X11, 0xfa61 on the R1)
// and the 2.4 GHz receiver (0xfa60). None of them names a model: the R1's
// receiver is 0xfa60 too, and the X3 and X6 enumerate under the same ids. Until
// a receiver message names the mouse, say only what the PID proves.
const X11_FAMILY_NAMES: ReadonlyMap<number, string> = new Map([
  [0xfa55, "Attack Shark mouse (wired)"],
  [0xfa60, "Attack Shark mouse (2.4 GHz receiver)"],
  [0xfa61, "Attack Shark mouse (wired)"],
]);

const X11_FAMILY_PIDS: ReadonlySet<number> = new Set(X11_FAMILY_NAMES.keys());

// The wireless receiver's interface 2 pushes battery packets on its own —
// no command needed — so a read-only claim of that entry costs nothing and
// risks nothing. The wired PIDs never report battery on this endpoint.
const X11_WIRELESS_PID = 0xfa60;

// The X11 family's DPI report 0x04 is documented for the X11 (wired 0xfa55,
// wireless 0xfa60). The R1 (0xfa61) uses a different DpiBuilder/step map in
// the reference driver, so it stays out of this path until ported.
const X11_DPI_PIDS: ReadonlySet<number> = new Set([0xfa55, 0xfa60]);

// A rebuilt config collection (see x11RebuiltConfigCollection) carries no
// report sizes and no hint of which firmware is behind it, so writes through
// it are only enabled once a receiver message names a model checked on that
// path (docs/delux-m600-pro-testing.md). The M600 Pro was captured through
// Bridge on Windows; the genuine X11 (model id 0x55 — issue #161) rides the
// same receiver and protocol and resolves to the receiver's 56-byte DPI
// frame, so it is enabled too. Models whose frame shape is not established
// (R1 0x10, X3 0x4d/0x4e, X6 0x85, …) stay read-only.
const X11_REBUILT_CONFIG_MODELS: ReadonlySet<number> = new Set([DELUX_M600_PRO_MODEL_ID, X11_MODEL_ID]);

const X11_DEFAULT_BUTTONS: Readonly<Record<string, string>> = {
  Left: "Left Click", Right: "Right Click", Middle: "Middle Click", Forward: "Forward", Back: "Backward",
};
const X11_BUTTON_ACTIONS: Readonly<Record<string, X11ButtonAction>> = {
  Off: [0x01, 0, 0], "Left Click": [0x02, 0, 0], "Right Click": [0x03, 0, 0], "Middle Click": [0x04, 0, 0],
  Backward: [0x05, 0, 0], Forward: [0x06, 0, 0], "Double Click": [0x07, 0, 0],
  "Scroll Up": [0x09, 0, 0], "Scroll Down": [0x0a, 0, 0], "Tilt Left": [0x0b, 0, 0], "Tilt Right": [0x0c, 0, 0],
  "DPI Cycle": [0x0d, 0, 0], "DPI Up": [0x0e, 0, 0], "DPI Down": [0x0f, 0, 0], "Easy Aim": [0x10, 0, 3],
  "Media Player": [0x15, 0, 0], "Previous Track": [0x16, 0, 0], "Next Track": [0x17, 0, 0],
  "Play/Pause": [0x18, 0, 0], Stop: [0x19, 0, 0], Mute: [0x1a, 0, 0],
  "Volume Up": [0x1b, 0, 0], "Volume Down": [0x1c, 0, 0], Calculator: [0x1d, 0, 0], Email: [0x1e, 0, 0],
  "Browser Forward": [0x20, 0, 0], "Browser Back": [0x21, 0, 0], "Browser Stop": [0x22, 0, 0],
  "My Computer": [0x23, 0, 0], "Browser Refresh": [0x24, 0, 0], "Browser Home": [0x25, 0, 0], "Browser Search": [0x26, 0, 0],
};

const X11_FACTORY_BUTTON_ACTIONS = [
  0x02, 0x03, 0x04, 0x01, 0x01, 0x0d, 0x06, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x09, 0x0a,
].map((id): X11ButtonAction => [id, 0, 0]);

function x11ActionLabel(action: X11ButtonAction): string {
  const named = Object.entries(X11_BUTTON_ACTIONS).find(([, bytes]) => bytes.every((byte, i) => byte === action[i]));
  return named?.[0] ?? x3ActionLabel(action) ?? "Custom";
}

// The firmware has no partial DPI update, so the whole six-stage table is
// re-sent on every edit. Over a native adapter the live table is read back
// first (the 0xa0 handshake, compx/x11-config.ts) and kept with its raw
// report, so a write changes only what was edited: stage colours and disabled
// stages survive. Without a read-back the last table this process wrote (or
// the factory one) is used, like the reference driver. Module-level because
// the desktop app opens a fresh short-lived client per write and the table
// must survive between them.
interface X11DpiState {
  stages: number[];
  activeStage: number;
  angleSnap: boolean;
  rippleControl: boolean;
  /** Stage-enabled bits (bit i = stage i + 1). */
  enabledMask: number;
  /** The last report read from or written to the mouse, when there is one. */
  base?: Uint8Array;
}

const x11DpiStates = new Map<number, X11DpiState>();

function x11DpiStateFor(productId: number): X11DpiState {
  let state = x11DpiStates.get(productId);
  if (!state) {
    state = {
      stages: [...X11_DPI_DEFAULT_STAGES],
      activeStage: X11_DPI_DEFAULT_ACTIVE,
      angleSnap: false,
      rippleControl: true,
      enabledMask: 0x3f,
    };
    x11DpiStates.set(productId, state);
  }
  return state;
}

/**
 * Hardware stages (0-based) the DPI button cycles through, in order. The
 * shared UI lists and indexes only these, so a disabled stage is neither
 * shown nor re-enabled by an edit.
 */
function x11EnabledStages(state: X11DpiState): number[] {
  const enabled: number[] = [];
  for (let i = 0; i < X11_DPI_STAGE_COUNT; i++) {
    if ((state.enabledMask >> i) & 0x01) enabled.push(i);
  }
  return enabled.length > 0 ? enabled : [...Array(X11_DPI_STAGE_COUNT).keys()];
}

/** Test/diagnostic hook: forget cached X11 DPI state (defaults come back). */
export function resetAttackSharkX11DpiState(): void {
  x11DpiStates.clear();
}

// Battery is push-only: the receiver streams `03 55 40 01 <pct>` on interface
// 2 on its own. The polling rate is read back over a native adapter; elsewhere
// this process keeps the last value it applied per product id so a
// short-lived client can still report it, defaulting to 1,000 Hz like the
// reference driver and the web app's own X11 bridge.
const X11_DEFAULT_POLLING_HZ = 1000;
/** An unanswered start needs a fresh A0 request, rather than more GETs of the same request. */
const X11_RECEIVER_QUERY_ATTEMPTS = 3;
// Polling A0 too early left the Windows receiver at 00. The vendor waits
// 500 ms before the first GET on the receiver and 100 ms on the cable.
const X11_RECEIVER_QUERY_WAIT_MS = 520;
const X11_WIRED_QUERY_WAIT_MS = 100;
/** How long a battery sample stays fresh enough to skip waiting for another. */
const X11_BATTERY_TTL_MS = 30_000;
/** Longest a status read waits for the receiver's next battery packet. */
const X11_BATTERY_WAIT_MS = 2_500;

interface X11RuntimeState {
  pollingRateHz: number;
  batteryPercent: number | null;
  batteryAt: number;
  /** Model id from the last receiver message, when it names a known model. */
  modelId: number | null;
  /** Firmware version read back from report 0x0b, e.g. 0x0107. */
  firmwareVersion: number | null;
  /** True once the 0xa0 read-back has worked over this transport. */
  readBackWorks: boolean;
  pollingRateKnown: boolean;
  buttonRevision: number;
}

const x11RuntimeStates = new Map<number, X11RuntimeState>();

function x11RuntimeFor(productId: number): X11RuntimeState {
  let state = x11RuntimeStates.get(productId);
  if (!state) {
    state = {
      pollingRateHz: X11_DEFAULT_POLLING_HZ,
      batteryPercent: null,
      batteryAt: 0,
      modelId: null,
      firmwareVersion: null,
      readBackWorks: false,
      pollingRateKnown: false,
      buttonRevision: 0,
    };
    x11RuntimeStates.set(productId, state);
  }
  return state;
}

// Two config writes through the 2.4 GHz receiver about 0.4-0.5 s apart froze
// the link until the receiver was replugged; pairs 1, 2 and 3 s apart did not
// (Delux M600 Pro, docs/delux-m600-pro-testing.md). The receiver answers each
// write within ~10 ms, so the gap is enforced from the last write rather than
// waiting on that answer. Module-level for the same short-lived-client reason
// as the state above. A read-back begins with a SET_FEATURE too. Both kinds
// use the same receiver gap and lock, including requests from separate clients.
const X11_RECEIVER_WRITE_GAP_MS = 1000;
const X11_SETTINGS_SCAN_GAP_MS = 2000;
const x11Receivers = new Map<number, { lastWriteAt: number; sending: Promise<unknown>; exchange: Promise<unknown> }>();

function x11ReceiverQueue(productId: number) {
  let receiver = x11Receivers.get(productId);
  if (!receiver) {
    receiver = { lastWriteAt: 0, sending: Promise.resolve(), exchange: Promise.resolve() };
    x11Receivers.set(productId, receiver);
  }
  return receiver;
}

/** Test/diagnostic hook: forget cached X11 battery/polling state. */
export function resetAttackSharkX11RuntimeState(): void {
  x11RuntimeStates.clear();
  x11Receivers.clear();
  x3States.clear();
}

const X3_MODEL_ID = 0x4d;
const X3_PIDS: ReadonlySet<number> = new Set([0xfa60, 0xfa61]);
const X3_POLLING_RATES: X3PollingHz[] = [125, 250, 500, 1000];
const X3_SLEEP_STEP_S = 30;
const X3_LOD = ["Low", "High"] as const;

interface X3State {
  settings: X3Settings;
  battery: { percent: number; voltageMv: number; charging: boolean } | null;
}

const x3States = new Map<number, X3State>();

function x3StateFor(productId: number): X3State {
  let state = x3States.get(productId);
  if (!state) {
    state = { settings: defaultX3Settings(), battery: null };
    x3States.set(productId, state);
  }
  return state;
}

export function resetAttackSharkX3State(): void {
  x3States.clear();
}

const rgbToHex = (c: X3Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * If the granted devices include an X11-family unit that no driver could
 * claim, explain why instead of letting the generic "not a control
 * interface" error blame the picker choice. This fires only when the
 * status entry (the composite with a Consumer collection) was not among
 * the grants — the rows look identical in the picker, so say how to get
 * the right one — and it stays honest about settings being native-only.
 * Returns null when no X11-family device is present.
 */
export function attackSharkNativeOnlyMessage(devices: HIDDevice[]): string | null {
  const unit = devices.find(
    (device) => device.vendorId === VID_1D57 && X11_FAMILY_PIDS.has(device.productId),
  );
  if (!unit) return null;
  const name = X11_FAMILY_NAMES.get(unit.productId) ?? "Attack Shark mouse";
  return `This ${name} cannot be configured through the browser: its settings channel `
    + "is on an interface the browser is not allowed to reach. To change DPI, polling "
    + "rate and lighting, install the OpenMouse Bridge, then open Interface settings "
    + "→ Bridge → Native devices and click “Enable native control”.";
}

// ── Protocol family detection ─────────────────────────────────────────────

type ProtocolFamily = "1d57" | "1d57-x11" | "25a7" | "373e" | null;

function detectFamily(device: HIDDevice): ProtocolFamily {
  if (device.vendorId === VID_1D57) {
    if (/delux/i.test(device.productName || "")
      || DELUX_UNBRANDED_PRODUCT_IDS.has(device.productId)) return null;
    // Native HID adapters (Tauri's TauriHidDevice, the Node/Bridge adapter)
    // cannot parse the report descriptor and report no collections at all,
    // so every collection-based gate below would refuse these units. On that
    // transport the vendor feature reports are reachable, so identify the
    // family from the vendor/product id instead. WebHID always reports the
    // real collection tree, so this branch never fires in a browser.
    if (device.collections.length === 0) {
      return X11_FAMILY_PIDS.has(device.productId) ? "1d57-x11" : null;
    }

    // Some 0x1d57 mice (X8 SE, X11) use the GearHub protocol despite
    // sharing the R1 VID. Distinguish by checking for a vendor-specific
    // collection (usagePage 0xffff) which the GearHub interface exposes.
    if (device.collections.some(hasVendorControl)) return "25a7";

    // An X11-family unit whose config channel the browser can see (Linux) is
    // still X11 firmware, not R1: the R1 read-back (0xa0 request, then 0x06)
    // returns no polling code on it, and a 0x04 request stalls the channel.
    if (X11_DPI_PIDS.has(device.productId) && x11ConfigReportBytes(device) !== null) {
      return "1d57-x11";
    }

    if (device.collections.some(hasFeatureReports)) return "1d57";

    // Real X11/R1 units declare no feature reports anywhere (see header
    // note), so config writes are impossible here — but their interface-2
    // entry, the composite with a Consumer top-level collection, carries the
    // autonomous battery stream. Claim that one read-only; the plain boot
    // keyboard/mouse entries stay refused.
    if (X11_FAMILY_PIDS.has(device.productId)
      && device.collections.some((collection) => collection.usagePage === 0x0c)) {
      return "1d57-x11";
    }

    return null;
  }
  if (device.vendorId === VID_25A7) {
    // Same native-adapter reasoning as VID_1D57 above: with no report
    // descriptor to inspect, the vendor id alone identifies the GearHub
    // family.
    if (REDRAGON_M719_PRO_PRODUCTS.has(device.productId)) return null;
    if (device.collections.length === 0) return "25a7";
    return device.collections.some(hasVendorControl) ? "25a7" : null;
  }
  if (device.vendorId === VID_373E) {
    if (LAMZU_PRODUCTS.has(device.productId)) return null;
    return device.collections.some(hasVendorControl) ? "373e" : null;
  }
  return null;
}

// ── 0x25a7 helpers ────────────────────────────────────────────────────────

/**
 * Compute the GearHub checksum: one's-complement of the sum of the first 7
 * command bytes, stored in byte 7.  Byte 8 stays zero (unused padding).
 */
export function checksum25a7(cmd: Uint8Array): Uint8Array {
  const out = new Uint8Array(CMD_LEN_25A7);
  out.set(cmd.subarray(0, Math.min(cmd.length, CMD_LEN_25A7)));
  let sum = 0;
  for (let i = 0; i < 7; i++) sum = (sum + out[i]) & 0xff;
  out[7] = (0xff - sum) & 0xff;
  return out;
}

/**
 * Encode a 64-byte HID report that starts with the 9-byte padded+checksummed
 * command and is zero-padded to REPORT_LEN_25A7.
 */
function encodeReport25a7(cmd: Uint8Array): Uint8Array {
  const report = new Uint8Array(REPORT_LEN_25A7);
  report.set(checksum25a7(cmd));
  return report;
}

/** Lookup a polling-rate Hz value and return its byte code. */
function pollingHzToCode25a7(hz: number): number | undefined {
  return POLLING_CODES_25A7.get(hz);
}

// ── Driver ────────────────────────────────────────────────────────────────

export class AttackSharkHidClient {
  readonly device: HIDDevice;

  private readonly family: ProtocolFamily;
  private readonly batteryWaitMs: number;
  private readonly receiverWriteGapMs: number;
  private readonly x11ScanGapMs: number;
  private readonly x11QueryWaitMs?: number;
  private x11Ack: { reportId: number; finish: (result: number) => void } | null = null;
  private x11LastPower: ReturnType<typeof decodeX11PowerReport> = null;
  private x11LastButtons: X11ButtonAction[] | null = null;
  private x11ButtonRevision: number | null = null;
  private lastStatus: MouseStatus | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private exclusiveQueue: Promise<unknown> = Promise.resolve();
  private batteryPercent: number | null = null;
  private listening = false;

  private readonly x3BurstGapMs: number | undefined;

  constructor(
    device: HIDDevice,
    options: { batteryWaitMs?: number; receiverWriteGapMs?: number; x3BurstGapMs?: number; x11QueryWaitMs?: number } = {},
  ) {
    this.x3BurstGapMs = options.x3BurstGapMs;
    this.device = device;
    this.family = detectFamily(device);
    this.batteryWaitMs = options.batteryWaitMs ?? X11_BATTERY_WAIT_MS;
    this.receiverWriteGapMs = options.receiverWriteGapMs ?? X11_RECEIVER_WRITE_GAP_MS;
    this.x11ScanGapMs = options.receiverWriteGapMs ?? X11_SETTINGS_SCAN_GAP_MS;
    this.x11QueryWaitMs = options.x11QueryWaitMs;
  }

  /**
   * True when this client is running over a native HID adapter (Tauri's
   * TauriHidDevice, the Node/Bridge adapter) rather than WebHID. Those
   * adapters report no collections, but unlike the browser they can reach
   * the vendor feature reports, so the X11 config channel is writable
   * through them.
   */
  private get nativeConfig(): boolean {
    return this.device.collections.length === 0;
  }

  /**
   * True when the X11 config channel is writable: always over a native
   * adapter, over WebHID when the browser exposes it (Linux hidraw), and
   * through a rebuilt config collection once a checked model is named.
   */
  private get x11ConfigReachable(): boolean {
    return this.nativeConfig
      || x11ConfigReportBytes(this.device) !== null
      || (this.x11RebuiltConfig && X11_REBUILT_CONFIG_MODELS.has(this.receiverModelId ?? -1));
  }

  /** True for an X11 DPI unit whose config collection was rebuilt without reports. */
  private get x11RebuiltConfig(): boolean {
    return this.family === "1d57-x11"
      && X11_DPI_PIDS.has(this.device.productId)
      && x11RebuiltConfigCollection(this.device);
  }

  /**
   * Try the query handshake on a confirmed X11 when the native adapter or
   * a complete receiver descriptor offers the config channel. A valid
   * reply is needed before editing the power and mapping blocks.
   */
  private get x11ReadBack(): boolean {
    return this.x11DpiSupported && this.receiverModelId === X11_MODEL_ID;
  }

  /** True when this unit's DPI report 0x04 can be driven. */
  private get x11DpiSupported(): boolean {
    return this.family === "1d57-x11"
      && this.x11ConfigReachable
      && X11_DPI_PIDS.has(this.device.productId);
  }

  private get x3Active(): boolean {
    return this.family === "1d57-x11"
      && X3_PIDS.has(this.device.productId)
      && this.receiverModelId === X3_MODEL_ID
      && (this.nativeConfig
        || x11ConfigReportBytes(this.device) !== null
        || x11RebuiltConfigCollection(this.device));
  }

  static isSupported(device: HIDDevice): boolean {
    return detectFamily(device) !== null;
  }

  // Battery packets arrive as inputreport events; the raw packet's leading
  // 0x03 is the HID report id, which WebHID strips into event.reportId, so
  // rebuild the native shape before matching the signature. A rebuilt
  // descriptor (Bridge on Windows) reads the battery collection as unnumbered,
  // so the whole packet arrives as report 0, id byte included; the length
  // keeps the boot mouse's and keyboards' unnumbered reports out.
  private x11ActivityAt: number | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    let packet: Uint8Array;
    if (event.reportId === 0 && data.length === RECEIVER_MESSAGE_BYTES && data[0] === BATTERY_REPORT_ID) {
      packet = data.slice();
    } else {
      packet = new Uint8Array(data.length + 1);
      packet[0] = event.reportId;
      packet.set(data, 1);
    }
    if (packet[0] === BATTERY_REPORT_ID && packet[1] === 0x10 && this.x3Active) {
      const battery = parseX3Battery(packet);
      if (battery) {
        const entry = { percent: battery.percent, voltageMv: Math.round(battery.voltage * 1000), charging: battery.charging };
        x3StateFor(this.device.productId).battery = entry;
        if (this.lastStatus) {
          this.lastStatus = {
            ...this.lastStatus,
            batteryPercent: entry.percent,
            batteryVoltageMv: entry.voltageMv,
            batteryState: entry.charging ? "Charging" : "Discharging",
          };
        }
      }
      return;
    }
    if (packet[0] === BATTERY_REPORT_ID && X11_RECEIVER_MODELS.has(packet[1])) {
      const runtime = x11RuntimeFor(this.device.productId);
      // A different mouse behind the same PID: its table is not the cached one.
      if (runtime.modelId !== null && runtime.modelId !== packet[1]) {
        x11DpiStates.delete(this.device.productId);
        runtime.readBackWorks = false;
        runtime.firmwareVersion = null;
        runtime.pollingRateKnown = false;
        runtime.buttonRevision++;
        this.x11LastPower = null;
        this.x11LastButtons = null;
        this.x11ButtonRevision = null;
      }
      runtime.modelId = packet[1];
      if (packet[1] === X11_MODEL_ID && (packet[2] === 0x10 || packet[2] === 0x40)) {
        this.x11ActivityAt = Date.now();
      }
      if (packet[1] === X11_MODEL_ID && packet[2] === 0x10) {
        const dpi = x11DpiStates.get(this.device.productId);
        const stage = packet[3];
        if (dpi?.base && stage >= 1 && stage <= X11_DPI_STAGE_COUNT && (dpi.enabledMask & (1 << (stage - 1)))) {
          dpi.activeStage = stage;
        }
      }
    }
    const ack = this.x11Ack;
    if (ack && packet[0] === BATTERY_REPORT_ID && packet[1] === X11_MODEL_ID
      && packet[2] === 0x50 && packet[4] === ack.reportId) ack.finish(packet[3]);
    const percent = AttackSharkHidClient.parseBatteryReport(packet);
    if (percent !== null) {
      this.batteryPercent = percent;
      const runtime = x11RuntimeFor(this.device.productId);
      runtime.batteryPercent = percent;
      runtime.batteryAt = Date.now();
      if (this.lastStatus) {
        this.lastStatus = { ...this.lastStatus, batteryPercent: percent, batteryState: "Discharging" };
      }
    }
  };

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (this.family === "1d57-x11" && !this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
  }

  async close(): Promise<void> {
    this.lastStatus = null;
    this.x11ActivityAt = null;
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(): Promise<boolean> {
    return false;
  }

  /** The known model id the last receiver message carried, if any. */
  private get receiverModelId(): number | null {
    if (this.family !== "1d57-x11") return null;
    return x11RuntimeFor(this.device.productId).modelId;
  }

  /** The model a receiver message identified, if any. */
  private get receiverModel(): ReceiverModel | undefined {
    const modelId = this.receiverModelId;
    return modelId === null ? undefined : X11_RECEIVER_MODELS.get(modelId);
  }

  displayName(): string {
    // The shared 0xfa60 receiver names its paired mouse only through the
    // model id in its messages; prefer that once one has arrived.
    const identified = this.receiverModel;
    if (identified) return identified.name;
    // X11-family product strings are generic OEM labels ("2.4G Wireless
    // Device", "USB Gaming Mouse") and the PIDs are shared, so fall back to
    // what the PID proves rather than guessing a model.
    const generic = this.device.vendorId === VID_1D57
      ? X11_FAMILY_NAMES.get(this.device.productId)
      : undefined;
    if (generic) return generic;
    const name = this.device.productName?.trim();
    if (!name) return "Attack Shark";
    return /^attack\s*shark/i.test(name) ? name : `Attack Shark ${name}`;
  }

  deviceBrand(): "Attack Shark" | "Delux" {
    return this.receiverModel?.brand ?? "Attack Shark";
  }

  isWireless(): boolean {
    if (this.device.vendorId === VID_1D57 && X11_FAMILY_PIDS.has(this.device.productId)) {
      return this.device.productId === X11_WIRELESS_PID;
    }
    return /receiver|dongle|wireless|2\.4g/i.test(this.device.productName || "");
  }

  getSupportedPollingRates(): number[] {
    if (this.x3Active) return [...X3_POLLING_RATES];
    if (this.family === "1d57") return POLLING_RATES_1D57.map(([, hz]) => hz);
    if (this.family === "25a7") return [...POLLING_CODES_25A7.keys()];
    // Native transport: the X11 exposes the same 0x06 polling command the
    // browser cannot reach, so advertise the rates it accepts.
    if (this.family === "1d57-x11" && this.x11ConfigReachable) return POLLING_RATES_1D57.map(([, hz]) => hz);
    return [];
  }

  getDpiOptions(): number[] {
    // 25a7 devices expose up to 8 DPI slots per profile.
    // The actual values are read dynamically in readStatus(); we return a
    // standard set of supported DPI steps so the UI can offer them.
    if (this.x3Active) {
      return Array.from({ length: (X3_DPI_MAX - X3_DPI_MIN) / X3_DPI_STEP + 1 }, (_, i) => X3_DPI_MIN + i * X3_DPI_STEP);
    }
    if (this.family === "25a7") {
      return [400, 800, 1200, 1600, 2400, 3200, 6400, 12000, 26000];
    }
    // The app only accepts stage edits that appear in this list; without it
    // the X11 stage editor could switch stages but never change a value.
    if (this.x11DpiSupported) return [...X11_DPI_VALUES];
    return [];
  }

  async readX11Configuration(): Promise<MouseStatus> {
    await this.open();
    if (!this.x11ReadBack && this.family === "1d57-x11" && this.isWireless()) {
      await this.waitForX11Battery(x11RuntimeFor(this.device.productId));
    }
    if (!this.x11ReadBack) throw new Error("Wake the X11 to load its settings.");
    return this.readStatus(true);
  }

  serializeX11Settings(): string | null {
    if (!this.x11ReadBack || !this.x11LastPower || !this.x11LastButtons) return null;
    const dpi = x11DpiStateFor(this.device.productId).base;
    if (!dpi) return null;
    const runtime = x11RuntimeFor(this.device.productId);
    return JSON.stringify({
      dpi: Array.from(dpi), power: Array.from(this.x11LastPower.base),
      buttons: Array.from(buildX11ButtonReport(this.x11LastButtons)),
      polling: runtime.pollingRateKnown ? runtime.pollingRateHz : 0, firmware: runtime.firmwareVersion,
    });
  }

  restoreX11Settings(snapshot: string): boolean {
    if (!this.x11ReadBack || this.x11LastPower || this.x11LastButtons) return false;
    try {
      const { dpi, power, buttons, polling, firmware } = JSON.parse(snapshot);
      const rawDpi = decodeX11DpiReport(Uint8Array.from(dpi));
      const rawPower = decodeX11PowerReport(Uint8Array.from(power));
      const rawButtons = decodeX11ButtonReport(Uint8Array.from(buttons));
      if (!rawDpi || !rawPower || !rawButtons) return false;
      const state = x11DpiStateFor(this.device.productId);
      if (!state.base) Object.assign(state, rawDpi);
      this.x11LastPower = rawPower;
      this.x11LastButtons = rawButtons;
      const runtime = x11RuntimeFor(this.device.productId);
      // Display cached DPI, but require a live read before rewriting the table.
      runtime.readBackWorks = true;
      if ([125, 250, 500, 1000].includes(polling) && !runtime.pollingRateKnown) {
        runtime.pollingRateHz = polling;
        runtime.pollingRateKnown = true;
      }
      if (Number.isInteger(firmware) && firmware > 0 && firmware <= 0xffff) runtime.firmwareVersion ??= firmware;
      return true;
    } catch {
      return false;
    }
  }

  async readStatus(readX11Configuration = false): Promise<MouseStatus> {
    await this.open();
    if (this.x3Active) return this.readX3Status();

    let pollingRateHz = 0;
    let dpi = 0;
    let firmware: string[] = [];

    if (this.family === "1d57") {
      pollingRateHz = await this.read1d57PollingRate().catch(() => 0);
    }
    if (this.family === "25a7") {
      const result = await this.read25a7Status().catch(() => null);
      if (result) {
        pollingRateHz = result.pollingRateHz;
        dpi = result.dpi;
        firmware = result.firmware;
      }
    }

    // A rebuilt config collection is writable only for a named model, and only
    // a receiver message names it: wait for one before deciding.
    if (this.family === "1d57-x11" && this.isWireless() && this.lastStatus === null) {
      await this.waitForX11Battery(x11RuntimeFor(this.device.productId));
    }

    // The wireless receiver pushes battery on its own; give it a bounded
    // moment to arrive. Its message also names the model, which decides
    // whether the config read-back below is tried.
    const x11Runtime = this.family === "1d57-x11" && this.x11ConfigReachable
      ? x11RuntimeFor(this.device.productId)
      : null;
    const confirmedX11 = this.x11ReadBack;
    if (confirmedX11 && readX11Configuration && x11Runtime) {
      await this.exclusive(async () => {
        const dpi = this.device.productId === 0xfa55 || await this.readX11DpiState(true);
        if (!dpi || !await this.readX11Runtime(x11Runtime) || !await this.readX11Power(true) || !await this.readX11Buttons(true)) {
          throw new Error("The X11 stopped replying. Wake it and use Load X11 settings to try again.");
        }
      });
    }
    const cachedDpi = this.x11DpiSupported ? x11DpiStateFor(this.device.productId) : null;
    const dpiState = confirmedX11 && !cachedDpi?.base ? null : cachedDpi;
    if (dpiState) {
      dpi = dpiState.stages[dpiState.activeStage - 1] ?? 0;
    }

    // X11 polling rate: read back when possible, otherwise the last value
    // this process applied (defaulting to 1,000 Hz).
    if (x11Runtime) {
      pollingRateHz = !confirmedX11 || x11Runtime.pollingRateKnown ? x11Runtime.pollingRateHz : 0;
      if (x11Runtime.firmwareVersion !== null) {
        const version = x11Runtime.firmwareVersion;
        firmware = [`Firmware ${version >> 8}.${(version & 0xff).toString(16).padStart(2, "0")}`];
      }
    }
    const power = confirmedX11 ? this.x11LastPower : null;
    const buttons = confirmedX11 ? this.x11LastButtons : null;
    const x11Processing = this.receiverModelId === X11_MODEL_ID && dpiState?.base !== undefined;
    const enabledStages = dpiState ? x11EnabledStages(dpiState) : [];
    const batteryPercent = x11Runtime ? x11Runtime.batteryPercent : this.batteryPercent;

    return this.lastStatus = {
      brand: this.deviceBrand(),
      name: this.displayName(),
      ui: {
        family: "attackshark",
        settingsReady: this.family === "1d57"
          || this.family === "25a7"
          || (this.family === "1d57-x11" && this.x11ConfigReachable),
        hideUnsupportedPollingRates: true,
        hideProcessingCard: !x11Processing,
        showAdvancedSection: x11Processing || power !== null,
        hideSleepCard: power === null,
        hideAdvancedLighting: power !== null,
        x11MacroBindings: this.x11ReadBack,
        x11ConfigurationAvailable: confirmedX11,
        x11AutoReadReady: confirmedX11 && (!this.isWireless()
          || (this.x11ActivityAt !== null && Date.now() - this.x11ActivityAt < X11_BATTERY_TTL_MS)),
        // Wireless X11-family units push battery on their own. WebHID only
        // shows the column when the browser can see the battery input report
        // (usually hidden under the protected system-control collection); a
        // native adapter delivers the stream directly, so it is always worth
        // showing there. A rebuilt descriptor lists the battery collection
        // without its report id, and the stream still arrives.
        forceShowBattery: this.family === "1d57-x11"
          && this.isWireless()
          && (this.nativeConfig
            || this.device.collections.some((collection) => declaresInputReport(collection, BATTERY_REPORT_ID))
            || (this.x11RebuiltConfig
              && this.device.collections.some((collection) => collection.usagePage === X11_BATTERY_USAGE_PAGE))),
        statusNote: this.family === "1d57-x11" && !this.x11ConfigReachable
          ? "Status only: this mouse's settings channel is not reachable from a browser and needs a native driver."
          : undefined,
        ...(dpiState
          ? {
            dpiStageEditor: {
              maxStages: X11_DPI_STAGE_COUNT,
              countEditable: confirmedX11 && this.isWireless(),
              minDpi: X11_DPI_MIN,
              maxDpi: X11_DPI_MAX,
              stepDpi: X11_DPI_STEP,
            },
          }
          : {}),
      },
      batteryPercent,
      batteryState: batteryPercent !== null ? "Discharging" : "Unknown",
      dpi,
      ...(dpiState
        ? {
          dpiStages: enabledStages.map((index) => dpiState.stages[index]),
          ...(dpiState.base && this.x11ReadBack ? {
            dpiStageColors: enabledStages.map((index) => {
              const offset = 25 + index * 3;
              return rgbToHex([dpiState.base![offset], dpiState.base![offset + 1], dpiState.base![offset + 2]]);
            }),
          } : {}),
          activeDpiStage: Math.max(0, enabledStages.indexOf(dpiState.activeStage - 1)),
          angleSnapping: dpiState.angleSnap,
          rippleControl: dpiState.rippleControl,
        }
        : {}),
      pollingRateHz,
      ...(power ? { sleepTimeout: power.sleepSeconds, debounceMs: power.debounceMs,
        deepSleepMinutes: power.deepSleepMinutes, lighting: this.x11Lighting(power) } : {}),
      ...(this.x11ReadBack ? {
        buttonMappings: Object.fromEntries(Object.entries(X11_BUTTON_SLOTS).map(([name, slot]) => [
          name, buttons ? x11ActionLabel(buttons[slot]) : "Unknown",
        ])),
        buttonOptions: Object.keys(X11_BUTTON_ACTIONS),
        defaultButtonMappings: { ...X11_DEFAULT_BUTTONS },
      } : {}),
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      liftOffDistance: null,
      firmware,
    };
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (this.x3Active) {
      if (!X3_POLLING_RATES.includes(pollingRateHz as X3PollingHz)) {
        throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
      }
      await this.applyX3((s) => { s.pollingHz = pollingRateHz as X3PollingHz; });
      return pollingRateHz;
    }
    if (this.family === "1d57-x11") {
      if (!this.x11ConfigReachable) {
        throw new Error(
          "This mouse's settings channel is not reachable from a browser; "
          + "changing settings needs the OpenMouse Bridge or the desktop app.",
        );
      }
      const entry = POLLING_RATES_1D57.find(([, hz]) => hz === pollingRateHz);
      if (!entry) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
      await this.exclusive(() => this.write1d57PollingRate(entry[0], this.x11ReadBack));
      const runtime = x11RuntimeFor(this.device.productId);
      runtime.pollingRateHz = pollingRateHz;
      runtime.pollingRateKnown = true;
      if (this.lastStatus) this.lastStatus = { ...this.lastStatus, pollingRateHz };
      return pollingRateHz;
    }
    if (this.family === "1d57") {
      const entry = POLLING_RATES_1D57.find(([, hz]) => hz === pollingRateHz);
      if (!entry) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
      await this.write1d57PollingRate(entry[0]);
      const confirmed = await this.read1d57PollingRate();
      if (confirmed !== pollingRateHz) {
        throw new Error(`The mouse kept ${confirmed} Hz instead of ${pollingRateHz} Hz.`);
      }
      if (this.lastStatus) this.lastStatus = { ...this.lastStatus, pollingRateHz: confirmed };
      return confirmed;
    }
    if (this.family === "25a7") {
      const code = pollingHzToCode25a7(pollingRateHz);
      if (code === undefined) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
      await this.write25a7PollingRate(code);
      if (this.lastStatus) this.lastStatus = { ...this.lastStatus, pollingRateHz };
      return pollingRateHz;
    }
    throw new Error("Polling rate control is not yet implemented for this Attack Shark model.");
  }

  // ── X11 DPI (report 0x04) ─────────────────────────────────────────────

  /** Throw the same explanation the browser path gives when DPI cannot be driven. */
  private requireX11Dpi(): void {
    if (!this.x11DpiSupported) {
      throw new Error(
        this.family === "1d57-x11"
          ? "This mouse's settings channel is not reachable from a browser; "
            + "changing DPI needs the OpenMouse Bridge or the desktop app."
          : "DPI control is not yet implemented for this Attack Shark model.",
      );
    }
  }

  /**
   * Re-send the full six-stage table. The firmware has no partial update, so
   * every edit carries the whole table, built on the last read-back report
   * when there is one so bytes the edit does not touch are kept.
   */
  private async writeX11Dpi(): Promise<void> {
    const state = x11DpiStateFor(this.device.productId);
    const report = buildX11DpiReport({
      stages: state.stages,
      activeStage: state.activeStage,
      angleSnap: state.angleSnap,
      rippleControl: state.rippleControl,
      wired: this.x11UsesShortDpiReport(),
      enabledMask: state.enabledMask,
      base: state.base,
    });
    if (this.x11ReadBack) await this.sendX11Confirmed(report);
    else await this.sendConfigReport(X11_DPI_REPORT_ID, report.subarray(1));
    state.base = report.slice();
    await this.delay(CMD_DELAY_MS);
  }

  /**
   * The DPI report is 52 bytes on the wired X11 and 56 over its receiver. A
   * descriptor the browser exposes decides (the M600 Pro receiver declares
   * the 52-byte form). A rebuilt config collection has no sizes, so there
   * the named model decides (the M600 Pro declares 51 bytes on both paths);
   * otherwise fall back to the product id.
   */
  private x11UsesShortDpiReport(): boolean {
    const declared = x11ConfigReportBytes(this.device);
    if (declared === 51) return true;
    if (declared === 55) return false;
    if (this.x11RebuiltConfig && this.receiverModelId === DELUX_M600_PRO_MODEL_ID) return true;
    return this.device.productId === 0xfa55;
  }

  /**
   * Best-effort read of the live table through the 0xa0 handshake (verified
   * on the wireless receiver; the wired unit is untested and skipped). A
   * failure leaves the cached table untouched rather than aborting the
   * status read. True when the live table was read.
   */
  private async readX11DpiState(scan = false): Promise<boolean> {
    if (this.device.productId === 0xfa55) return false;
    const state = x11DpiStateFor(this.device.productId);
    try {
      const bytes = await this.queryX11Report(X11_DPI_REPORT_ID, undefined, scan);
      const decoded = bytes && decodeX11DpiReport(bytes);
      if (!decoded) return false;
      state.stages = [...decoded.stages];
      state.activeStage = decoded.activeStage;
      state.angleSnap = decoded.angleSnap;
      state.rippleControl = decoded.rippleControl;
      state.enabledMask = decoded.enabledMask;
      state.base = decoded.base;
      x11RuntimeFor(this.device.productId).readBackWorks = true;
      return true;
    } catch {
      // No read-back on this firmware/transport; keep the cached table.
      return false;
    }
  }

  /** Best-effort read of the polling rate (0x06) and firmware version (0x0b). */
  private async readX11Runtime(runtime: X11RuntimeState): Promise<boolean> {
    if (this.device.productId === 0xfa55) return true;
    try {
      const polling = await this.queryX11Report(POLLING_REPORT_ID, undefined, true);
      const hz = polling && decodeX11PollingReport(polling);
      if (!hz) return false;
      runtime.pollingRateHz = hz;
      runtime.pollingRateKnown = true;
      // The vendor app stages the version report with flag 0.
      const version = await this.queryX11Report(X11_VERSION_REPORT_ID, 0x00, true);
      const decoded = version && decodeX11FirmwareVersion(version);
      if (!decoded) return false;
      runtime.firmwareVersion = decoded;
      return true;
    } catch {
      return false;
    }
  }

  private async readX11Power(scan = false): Promise<ReturnType<typeof decodeX11PowerReport>> {
    try {
      const report = await this.queryX11Report(X11_POWER_REPORT_ID, undefined, scan);
      const decoded = report && decodeX11PowerReport(report);
      if (decoded) this.x11LastPower = decoded;
      return decoded;
    } catch {
      return null;
    }
  }

  private x11Lighting(power: X11PowerSettings): MouseLighting {
    const mode = X11_LIGHT_MODES[power.lightMode] ?? null;
    return {
      zone: "Mouse", modes: X11_LIGHT_MODES, mode, color: power.color, color2: null,
      colorModes: ["Static", "Breathing single"], dualColorModes: [],
      reactiveModes: ["Breathing single", "Neon", "Breathing random", "Breathing DPI"],
      speeds: X11_LIGHT_SPEEDS, speed: X11_LIGHT_SPEEDS.find((speed) => speed === power.lightSpeed) ?? null,
      brightness: X11_LIGHT_BRIGHTNESS[power.brightness - 1] ?? null,
      brightnessLevels: X11_LIGHT_BRIGHTNESS, brightnessModes: ["Static", "Static DPI"],
    };
  }

  async setLighting(lighting: Pick<MouseLighting, "mode" | "color" | "brightness" | "speed">): Promise<void> {
    if (!this.x11ReadBack) throw new Error("This mouse does not support X11 lighting.");
    const lightMode = X11_LIGHT_MODES.findIndex((mode) => mode === lighting.mode);
    const brightness = X11_LIGHT_BRIGHTNESS.findIndex((level) => level === lighting.brightness) + 1;
    await this.editX11Power({ lightMode, color: lighting.color ?? undefined, lightSpeed: lighting.speed ?? undefined,
      brightness: lightMode === 1 || lightMode === 5 ? brightness || undefined : undefined });
  }

  private async editX11Power(changes: Partial<X11PowerSettings>): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.readX11Power();
      if (!current) throw new Error("The mouse did not return its power settings. Wake it and try again.");
      const report = buildX11PowerReport(current.base, changes, !this.isWireless());
      await this.sendX11Confirmed(report);
      this.x11LastPower = decodeX11PowerReport(report);
    });
  }

  private async readX11Buttons(scan = false): Promise<X11ButtonAction[] | null> {
    const runtime = x11RuntimeFor(this.device.productId);
    const revision = runtime.buttonRevision;
    try {
      const report = await this.queryX11Report(X11_BUTTON_REPORT_ID, undefined, scan);
      const decoded = report && decodeX11ButtonReport(report);
      if (!decoded || runtime.buttonRevision !== revision) return null;
      this.x11LastButtons = decoded;
      this.x11ButtonRevision = revision;
      return decoded;
    } catch {
      return null;
    }
  }

  private async editX11Buttons(change: (actions: X11ButtonAction[]) => void, upload?: () => Promise<void>): Promise<void> {
    await this.exclusive(async () => {
      const runtime = x11RuntimeFor(this.device.productId);
      const current = await this.readX11Buttons()
        ?? (this.x11ButtonRevision === runtime.buttonRevision ? this.x11LastButtons : null);
      if (!current) throw new Error("Wake the mouse to read its button map, or use Reset to default.");
      const actions = [...current];
      change(actions);
      if (!Object.values(X11_BUTTON_SLOTS).some((slot) => actions[slot][0] === 0x02)) {
        throw new Error("Keep Left Click assigned to at least one mouse button.");
      }
      if (upload) await upload();
      await this.writeX11Buttons(actions);
    });
  }

  private async writeX11Buttons(actions: X11ButtonAction[]): Promise<void> {
    const runtime = x11RuntimeFor(this.device.productId);
    // Invalidate previous live maps even if the receiver applies a write
    // without acknowledging it. A snapshot never has a live revision.
    const revision = ++runtime.buttonRevision;
    await this.sendX11Confirmed(buildX11ButtonReport(actions));
    this.x11LastButtons = actions;
    this.x11ButtonRevision = revision;
  }

  async assignX11Macro(button: string, events: readonly X11MacroEvent[], playback = 0, repeats = 1, name = ""): Promise<void> {
    const slot = X11_BUTTON_SLOTS[button];
    if (!this.x11ReadBack || slot === undefined) throw new Error("This mouse button does not support an X11 macro.");
    const pages = buildX11MacroReports(slot + 1, events, playback, repeats, name);
    await this.editX11Buttons((actions) => {
      actions[slot] = [0x12, 0, slot + 1];
    }, async () => {
      for (const page of pages.slice(0, -1)) await this.sendConfigReport(X11_MACRO_REPORT_ID, page.subarray(1));
      await this.sendX11Confirmed(pages[pages.length - 1], 1);
    });
  }

  private async sendX11Confirmed(report: Uint8Array<ArrayBuffer>, attempts = 3): Promise<void> {
    const [reportId] = report;
    if (!this.isWireless()) {
      await this.sendConfigReport(reportId, report.subarray(1));
      return;
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      let result: Promise<number> | undefined;
      try {
        await this.sendConfigReport(reportId, report.subarray(1), () => {
          result = new Promise((finish) => { this.x11Ack = { reportId, finish }; });
        });
        const status = await Promise.race([result!, this.delay(600).then(() => null)]);
        if (status === 0) return;
      } finally {
        this.x11Ack = null;
      }
    }
    throw new Error("The X11 did not confirm the change. Wake the mouse and try again.");
  }

  /**
   * Read one config report: stage it with a 0xa0 request, then wait for the
   * receiver before checking readiness. A bare GET without the request
   * returns stale buffer contents. Null when the mouse never gets ready
   * (asleep or out of range).
   */
  private async queryX11Report(reportId: number, flag?: number, scan = false): Promise<Uint8Array | null> {
    const request = buildX11QueryRequest(reportId, flag);
    const wireless = this.isWireless();
    const attempts = !scan && wireless && this.x11QueryWaitMs === undefined ? X11_RECEIVER_QUERY_ATTEMPTS : 1;
    const wait = this.x11QueryWaitMs ?? (wireless ? X11_RECEIVER_QUERY_WAIT_MS : X11_WIRED_QUERY_WAIT_MS);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (scan && !this.x11ReadBack) return null;
      await this.sendConfigReport(X11_QUERY_REPORT_ID, request, undefined, scan ? this.x11ScanGapMs : undefined);
      await this.delay(wait);
      const ready = this.copyView(await this.run(() => this.device.receiveFeatureReport(X11_QUERY_REPORT_ID)));
      if (x11QueryReady(ready)) {
        return this.copyView(await this.run(() => this.device.receiveFeatureReport(reportId)));
      }
    }
    return null;
  }

  /**
   * The wireless receiver streams battery on its own, so the only way to get
   * a fresh percentage is to stay open for its next packet. Skip the wait when
   * the last sample is still fresh — the desktop app re-reads every few
   * seconds and should not pay this each time.
   */
  private async waitForX11Battery(runtime: X11RuntimeState): Promise<void> {
    if (runtime.batteryPercent !== null && Date.now() - runtime.batteryAt < X11_BATTERY_TTL_MS) return;
    // A named model whose battery scale is unchecked never yields a reading.
    if (this.receiverModel && !this.receiverModel.battery) return;
    const start = Date.now();
    const deadline = start + this.batteryWaitMs;
    while (Date.now() < deadline) {
      await this.delay(100);
      if (runtime.batteryPercent !== null && runtime.batteryAt >= start) return;
    }
  }

  /**
   * The table an edit starts from. When it can be read back, the live one is
   * read before every edit: the DPI button changes the active stage behind
   * this process's back, and a cached or factory table would undo that or
   * reset what the mouse holds (stage colours, disabled stages). Once the
   * read-back has worked over this transport, a failed read means the mouse
   * is asleep or out of range and the edit is refused rather than written
   * from a guess. Before that (a transport where the handshake was never
   * seen working), the cached table is used as before.
   */
  private async x11DpiForEdit(): Promise<X11DpiState> {
    this.requireX11Dpi();
    if (this.x11ReadBack && !(await this.readX11DpiState())
      && x11RuntimeFor(this.device.productId).readBackWorks) {
      throw new Error("The mouse did not answer; move it to wake it up and try again.");
    }
    return x11DpiStateFor(this.device.productId);
  }

  /** Hardware stage behind a 0-based index into the enabled stages the UI shows. */
  private x11HardwareStage(state: X11DpiState, stage: number): number {
    const enabled = x11EnabledStages(state);
    if (!Number.isInteger(stage) || stage < 0 || stage >= enabled.length) {
      throw new RangeError(`This mouse has no DPI stage ${stage + 1}.`);
    }
    return enabled[stage];
  }

  /**
   * Run one edit start to finish: read the live table, change it, write it
   * back. Held exclusively so no other read or edit slips its own request in
   * between and so no read lands between this edit's read and its write.
   */
  private editX11<T>(apply: (state: X11DpiState) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const state = await this.x11DpiForEdit();
      const previous = { ...state, stages: [...state.stages] };
      try {
        return await apply(state);
      } catch (error) {
        Object.assign(state, previous);
        throw error;
      }
    });
  }

  /** Sets the active stage's DPI, preserving the other five. */
  async setDpi(dpi: number, _dpiY?: number): Promise<number> {
    if (this.x3Active) return this.setDpiStageValue(x3StateFor(this.device.productId).settings.activeStage, dpi);
    return this.editX11(async (state) => {
      const value = nearestX11Dpi(dpi);
      state.stages[state.activeStage - 1] = value;
      await this.writeX11Dpi();
      if (this.lastStatus) this.lastStatus = { ...this.lastStatus, dpi: value };
      return value;
    });
  }

  /** Edits one stage's DPI. `stage` is 0-based, matching the shared UI contract. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (this.x3Active) {
      await this.applyX3((s) => {
        this.requireX3Stage(s, stage);
        s.dpiStages[stage] = dpi;
      });
      return dpi;
    }
    return this.editX11(async (state) => {
      const hardware = this.x11HardwareStage(state, stage);
      const value = nearestX11Dpi(dpi);
      state.stages[hardware] = value;
      await this.writeX11Dpi();
      if (this.lastStatus) {
        this.lastStatus = {
          ...this.lastStatus,
          dpiStages: x11EnabledStages(state).map((index) => state.stages[index]),
        };
      }
      return value;
    });
  }

  /** Selects the active stage. `stage` is 0-based, matching the shared UI contract. */
  async setActiveDpiStage(stage: number): Promise<number> {
    if (this.x3Active) {
      await this.applyX3((s) => {
        this.requireX3Stage(s, stage);
        s.activeStage = stage;
      });
      return stage;
    }
    return this.editX11(async (state) => {
      const hardware = this.x11HardwareStage(state, stage);
      state.activeStage = hardware + 1;
      await this.writeX11Dpi();
      if (this.lastStatus) {
        this.lastStatus = {
          ...this.lastStatus,
          dpi: state.stages[hardware] ?? this.lastStatus.dpi,
          activeDpiStage: stage,
        };
      }
      return stage;
    });
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    if (this.x3Active) {
      await this.applyX3((s) => { s.angleSnap = enabled; });
      return enabled;
    }
    return this.editX11(async (state) => {
      if (this.receiverModelId === X11_MODEL_ID && !state.base) throw new Error("The mouse did not return its DPI table.");
      state.angleSnap = enabled;
      await this.writeX11Dpi();
      if (this.lastStatus) this.lastStatus = { ...this.lastStatus, angleSnapping: enabled };
      return enabled;
    });
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    if (this.x3Active) {
      await this.applyX3((s) => { s.ripple = enabled; });
      return enabled;
    }
    return this.editX11(async (state) => {
      if (this.receiverModelId === X11_MODEL_ID && !state.base) throw new Error("The mouse did not return its DPI table.");
      state.rippleControl = enabled;
      await this.writeX11Dpi();
      if (this.lastStatus) this.lastStatus = { ...this.lastStatus, rippleControl: enabled };
      return enabled;
    });
  }

  private requireX3(): void {
    if (!this.x3Active) throw new Error("This setting is only available on the Attack Shark X3.");
  }

  private requireX3Stage(s: X3Settings, stage: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= s.dpiStages.length) {
      throw new RangeError(`This mouse has no DPI stage ${stage + 1}.`);
    }
  }

  private async applyX3(change: (settings: X3Settings) => void): Promise<void> {
    const state = x3StateFor(this.device.productId);
    const next = structuredClone(state.settings);
    change(next);
    const burst = buildX3Burst(next);
    const gap = this.x3BurstGapMs ?? (this.isWireless() ? X3_RECEIVER_GAP_MS : X3_WIRED_GAP_MS);
    await this.run(async () => {
      for (const report of burst) {
        const payload = new Uint8Array(report.length - 1);
        payload.set(report.subarray(1));
        await this.device.sendFeatureReport(report[0], payload);
        await this.delay(gap);
      }
    });
    state.settings = next;
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...this.x3Fields(next) };
  }

  private x3Fields(s: X3Settings): Partial<MouseStatus> {
    const count = Math.min(s.dpiStages.length, X3_MAX_STAGES);
    return {
      dpi: s.dpiStages[s.activeStage] ?? 0,
      dpiStages: [...s.dpiStages],
      dpiStageColors: s.stageColors.slice(0, count).map(rgbToHex),
      activeDpiStage: s.activeStage,
      pollingRateHz: s.pollingHz,
      liftOffDistance: X3_LOD[s.lod],
      rippleControl: s.ripple,
      angleSnapping: s.angleSnap,
      motionSync: s.motionSync,
      sleepTimeout: s.sleepMinutes * 60,
      debounceMs: s.debounceMs,
      ...this.x3Buttons(s),
    };
  }

  private x3Buttons(s: X3Settings): Partial<MouseStatus> {
    const buttonMappings: Record<string, string> = {};
    const fixedButtons: string[] = [];
    for (const [name, slot] of Object.entries(X3_BUTTON_SLOT)) {
      const label = x3ActionLabel(s.buttons[slot]);
      buttonMappings[name] = label ?? "Custom (read-only)";
      if (!label) fixedButtons.push(name);
    }
    return { buttonMappings, buttonOptions: [...X3_BUTTON_OPTIONS], fixedButtons };
  }

  private readX3Status(): MouseStatus {
    const state = x3StateFor(this.device.productId);
    const battery = state.battery;
    return this.lastStatus = {
      brand: this.deviceBrand(),
      name: this.displayName(),
      ui: {
        family: "attackshark",
        settingsReady: true,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: false,
        showAdvancedSection: true,
        forceShowBattery: this.isWireless(),
        dpiStageEditor: {
          maxStages: X3_MAX_STAGES,
          countEditable: true,
          minDpi: X3_DPI_MIN,
          maxDpi: X3_DPI_MAX,
          stepDpi: X3_DPI_STEP,
        },
      },
      batteryPercent: battery?.percent ?? null,
      batteryVoltageMv: battery?.voltageMv ?? null,
      batteryState: battery ? (battery.charging ? "Charging" : "Discharging") : "Unknown",
      ...this.x3Fields(state.settings),
      supportedPollingRates: [...X3_POLLING_RATES],
      supportedLiftOffDistances: [...X3_LOD],
      activeProfile: null,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      firmware: [],
    } as MouseStatus;
  }

  getButtonOptions(): string[] {
    if (this.x11ReadBack) return Object.keys(X11_BUTTON_ACTIONS);
    return [...X3_BUTTON_OPTIONS];
  }

  async setButtonMapping(button: string, action: string): Promise<void> {
    if (this.x11ReadBack) {
      const slot = X11_BUTTON_SLOTS[button];
      const mapping = Object.hasOwn(X11_BUTTON_ACTIONS, action) ? X11_BUTTON_ACTIONS[action] : null;
      if (slot === undefined || !mapping) throw new RangeError("Unsupported X11 button or action.");
      await this.editX11Buttons((actions) => { actions[slot] = mapping; });
      return;
    }
    this.requireX3();
    const index = X3_BUTTON_SLOT[button];
    if (index === undefined) throw new RangeError(`Unknown X3 button: ${button}`);
    const slot = x3ParseActionLabel(action);
    if (!slot) throw new RangeError(`${action} is not an X3 button action.`);
    await this.applyX3((s) => { s.buttons[index] = slot; });
  }

  async setX11KeyboardShortcut(button: string, modifiers: number, usage: number): Promise<void> {
    const slot = X11_BUTTON_SLOTS[button];
    if (!this.x11ReadBack || slot === undefined || !Number.isInteger(usage) || usage < 4 || usage > 0xe7
      || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) {
      throw new RangeError("Invalid X11 button or keyboard shortcut.");
    }
    await this.editX11Buttons((actions) => { actions[slot] = [0x11, modifiers, usage]; });
  }

  async resetButtonMappings(): Promise<void> {
    if (this.x11ReadBack) {
      await this.exclusive(() => this.writeX11Buttons([...X11_FACTORY_BUTTON_ACTIONS]));
      return;
    }
    this.requireX3();
    await this.applyX3((s) => { s.buttons = X3_FACTORY_BUTTONS.map((b) => [...b] as unknown as X3Settings["buttons"][number]); });
  }

  async uploadMacro(macro: { slot?: number; events: readonly X3MacroEvent[] }): Promise<void> {
    this.requireX3();
    const chunks = buildX3MacroChunks(macro.events, macro.slot ?? 2);
    await this.run(async () => {
      for (const chunk of chunks) {
        await this.device.sendFeatureReport(chunk[0], chunk.slice(1));
        await this.delay(this.x3BurstGapMs ?? X3_MACRO_GAP_MS);
      }
    });
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (this.x11ReadBack && this.isWireless()) {
      if (!Number.isInteger(count) || count < 1 || count > X11_DPI_STAGE_COUNT) {
        throw new RangeError(`This mouse has 1 to ${X11_DPI_STAGE_COUNT} DPI stages.`);
      }
      return this.editX11(async (state) => {
        if (!state.base) throw new Error("The mouse did not return its DPI table.");
        const enabled = x11EnabledStages(state);
        const disabled = state.stages.map((_, index) => index).filter((index) => !enabled.includes(index));
        const next = [...enabled, ...disabled].slice(0, count);
        for (const index of next) {
          if (state.stages[index] === 0) state.stages[index] = X11_DPI_DEFAULT_STAGES[index];
        }
        const stageMask = (1 << X11_DPI_STAGE_COUNT) - 1;
        state.enabledMask = next.reduce((mask, index) => mask | (1 << index), state.enabledMask & ~stageMask);
        if (!next.includes(state.activeStage - 1)) state.activeStage = next.at(-1)! + 1;
        await this.writeX11Dpi();
        return count;
      });
    }
    this.requireX3();
    await this.applyX3((s) => {
      if (!Number.isInteger(count) || count < 1 || count > X3_MAX_STAGES) {
        throw new RangeError(`This mouse has 1 to ${X3_MAX_STAGES} DPI stages.`);
      }
      const last = s.dpiStages[s.dpiStages.length - 1] ?? 800;
      s.dpiStages = Array.from({ length: count }, (_, i) => s.dpiStages[i] ?? last);
      s.activeStage = Math.min(s.activeStage, count - 1);
    });
    return count;
  }

  async setDpiStageColor(stage: number, color: string): Promise<string> {
    const match = /^#([0-9a-f]{6})$/i.exec(color);
    if (!match) throw new TypeError("DPI stage colour must be #rrggbb.");
    const rgb = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16)) as unknown as X3Rgb;
    if (this.x11ReadBack) {
      return this.editX11(async (state) => {
        if (!state.base) throw new Error("The mouse did not return its DPI table.");
        const index = this.x11HardwareStage(state, stage);
        state.base = state.base.slice();
        state.base.set(rgb, 25 + index * 3);
        await this.writeX11Dpi();
        return color.toLowerCase();
      });
    }
    this.requireX3();
    await this.applyX3((s) => {
      this.requireX3Stage(s, stage);
      s.stageColors[stage] = rgb;
    });
    return color.toLowerCase();
  }

  getSleepOptions(): number[] {
    if (this.x11ReadBack) return this.lastStatus?.sleepTimeout != null ? [...X11_SLEEP_OPTIONS] : [];
    return Array.from({ length: 60 }, (_, i) => (i + 1) * X3_SLEEP_STEP_S);
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (this.x11ReadBack) {
      await this.editX11Power({ sleepSeconds: seconds });
      return seconds;
    }
    this.requireX3();
    if (!Number.isInteger(seconds) || seconds % X3_SLEEP_STEP_S !== 0) {
      throw new RangeError("Sleep time must be a multiple of 30 seconds.");
    }
    await this.applyX3((s) => { s.sleepMinutes = seconds / 60; });
    return seconds;
  }

  async setDeepSleepTimeout(minutes: number): Promise<number> {
    if (this.x11ReadBack) {
      await this.editX11Power({ deepSleepMinutes: minutes });
      return minutes;
    }
    this.requireX3();
    await this.applyX3((s) => { s.deepSleepMinutes = minutes; });
    return minutes;
  }

  getDeepSleepTimeout(): number {
    if (this.x11ReadBack) {
      if (!this.x11LastPower) throw new Error("Load X11 settings to read its deep sleep timeout.");
      return this.x11LastPower.deepSleepMinutes;
    }
    return x3StateFor(this.device.productId).settings.deepSleepMinutes;
  }

  getDebounceMaxMs(): number {
    return 50;
  }

  getDebounceOptions(): number[] {
    if (this.x11ReadBack) return [...X11_DEBOUNCE_OPTIONS];
    return Array.from({ length: 25 }, (_, i) => (i + 1) * 2);
  }

  async setDebounceTime(ms: number): Promise<number> {
    if (this.x11ReadBack) {
      await this.editX11Power({ debounceMs: ms });
      return ms;
    }
    this.requireX3();
    if (!Number.isInteger(ms) || ms < 2 || ms > 50 || ms % 2 !== 0) {
      throw new RangeError("Debounce time must be an even 2 to 50 ms.");
    }
    await this.applyX3((s) => { s.debounceMs = ms; });
    return ms;
  }

  async setLiftOffDistance(lod: NonNullable<MouseStatus["liftOffDistance"]>): Promise<string> {
    this.requireX3();
    const index = (X3_LOD as readonly string[]).indexOf(lod);
    if (index < 0) throw new RangeError("Lift-off distance must be Low (1 mm) or High (2 mm).");
    await this.applyX3((s) => { s.lod = index as 0 | 1; });
    return lod;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    this.requireX3();
    await this.applyX3((s) => { s.motionSync = enabled; });
    return enabled;
  }

  // ── 0x25a7 low-level ──────────────────────────────────────────────────

  /**
   * Send a 9-byte command via a 64-byte HID feature report (report ID 0x00),
   * then wait a short delay for the device to process it.
   */
  private async sendCmd25a7(cmd: Uint8Array): Promise<void> {
    const report = encodeReport25a7(cmd);
    await this.run(() => this.device.sendFeatureReport(REPORT_ID_25A7, report as BufferSource));
    await this.delay(CMD_DELAY_25A7_MS);
  }

  /**
   * Send a command and read back the 64-byte feature report reply.
   */
  private async askCmd25a7(cmd: Uint8Array): Promise<Uint8Array> {
    await this.sendCmd25a7(cmd);
    const reply = await this.run(() => this.device.receiveFeatureReport(REPORT_ID_25A7));
    return this.copyView(reply);
  }

  /**
   * Get firmware revision string(s) from the device.
   * Command 0x80 → response byte[1..2] = version (little-endian uint16).
   */
  private async getFirmware25a7(): Promise<string[]> {
    const resp = await this.askCmd25a7(new Uint8Array([FEA_CMD_GET_REV]));
    if (resp[0] !== FEA_CMD_GET_REV) return [];
    const version = resp[1] | (resp[2] << 8);
    return version !== 0 ? [`v${version}`] : [];
  }

  /**
   * Get DPI configuration for a profile.
   * Command 0xD4 [profile] → response contains active DPI index, slot count,
   * and per-slot X/Y values encoded as LE uint16.
   */
  private async getDpi25a7(profile: number): Promise<{ activeIndex: number; slots: number; dpis: number[] }> {
    const resp = await this.askCmd25a7(new Uint8Array([FEA_CMD_GET_DPI, profile]));
    if (resp[0] !== FEA_CMD_GET_DPI) return { activeIndex: 0, slots: 0, dpis: [] };
    const activeIndex = resp[2] > 8 ? 0 : resp[2];
    const slotCount = resp[3];
    const dpis: number[] = [];
    for (let i = 0; i < slotCount; i++) {
      const x = resp[8 + i * 2] | (resp[9 + i * 2] << 8);
      dpis.push(x);
    }
    return { activeIndex, slots: slotCount, dpis };
  }

  /**
   * Set polling rate via command 0x04.
   */
  private async write25a7PollingRate(code: number): Promise<void> {
    await this.sendCmd25a7(new Uint8Array([FEA_CMD_SET_REPORT_RATE, 0, code]));
  }

  /**
   * Read all status from a 0x25a7 device (firmware + DPI + polling rate).
   */
  private async read25a7Status(): Promise<{ pollingRateHz: number; dpi: number; firmware: string[] }> {
    const firmware = await this.getFirmware25a7();

    // Read DPI from profile 0
    const dpiResult = await this.getDpi25a7(0);
    const dpi = dpiResult.dpis[dpiResult.activeIndex] ?? 0;

    // Polling rate is not directly readable via a single command in the MU
    // class protocol; we default to 1000 Hz and let the user set it.
    const pollingRateHz = 1000;

    return { pollingRateHz, dpi, firmware };
  }

  // ── 0x1d57 low-level ──────────────────────────────────────────────────

  private async write1d57PollingRate(rateByte: number, confirm = false): Promise<void> {
    await this.open();
    const report = new Uint8Array([POLLING_REPORT_ID, 0x09, 0x01, rateByte, 0xff - rateByte, 0, 0, 0, 0]);
    if (confirm) await this.sendX11Confirmed(report);
    else await this.sendConfigReport(POLLING_REPORT_ID, report.subarray(1));
    await this.delay(CMD_DELAY_MS);
  }

  private async read1d57PollingRate(): Promise<number> {
    await this.open();
    // Send read-request on report 0xa0 then read back from 0x06.
    const req = new Uint8Array([POLLING_REPORT_ID, 0x00, 0x01, 0, 0, 0, 0, 0]);
    await this.run(() => this.device.sendFeatureReport(DPI_READ_REPORT_ID, req));
    await this.delay(CMD_DELAY_MS);
    const reply = await this.run(() => this.device.receiveFeatureReport(POLLING_REPORT_ID));
    const data = this.copyView(reply);
    const rateByte = data[2]; // byte 2 of feature report (after report ID byte 0)
    const match = POLLING_RATES_1D57.find(([code]) => code === rateByte);
    return match ? match[1] : 0;
  }

  // ── shared helpers ────────────────────────────────────────────────────

  /** Space all configuration writes and read requests across receiver clients. */
  private sendConfigReport(
    reportId: number,
    data: Uint8Array<ArrayBuffer>,
    beforeSend?: () => void,
    gapMs = this.receiverWriteGapMs,
  ): Promise<void> {
    const receiver = this.family === "1d57-x11" && this.isWireless() ? x11ReceiverQueue(this.device.productId) : null;
    const send = () => this.run(async () => {
      if (receiver) {
        const wait = receiver.lastWriteAt + gapMs - Date.now();
        if (wait > 0) await this.delay(wait);
      }
      try {
        beforeSend?.();
        await this.device.sendFeatureReport(reportId, data);
      } finally {
        if (receiver) receiver.lastWriteAt = Date.now();
      }
    });
    if (!receiver) return send();
    const next = receiver.sending.then(send, send);
    receiver.sending = next.catch(() => undefined);
    return next;
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Run a multi-step exchange with the receiver without letting another one
   * start in the middle. `run` only orders single transfers; a read handshake
   * (stage, wait, fetch) and an edit (read, write) span several, and a second
   * request staged in between replaces the first. Never call this from inside
   * a task already running here.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.family === "1d57-x11" && this.isWireless()) {
      const receiver = x11ReceiverQueue(this.device.productId);
      const next = receiver.exchange.then(task, task);
      receiver.exchange = next.catch(() => undefined);
      return next;
    }
    const next = this.exclusiveQueue.then(task, task);
    this.exclusiveQueue = next.catch(() => undefined);
    return next;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private copyView(view: DataView): Uint8Array {
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  /** Check if an input report matches the battery signature. */
  static isBatteryReport(data: Uint8Array): boolean {
    return data[0] === BATTERY_REPORT_ID
      && X11_RECEIVER_MODELS.get(data[1])?.battery !== undefined
      && data[2] === 0x40
      && data[3] === 0x01;
  }

  /** Extract battery percentage from a battery input report. */
  static parseBatteryReport(data: Uint8Array): number | null {
    if (!AttackSharkHidClient.isBatteryReport(data)) return null;
    const value = data[4];
    if (X11_RECEIVER_MODELS.get(data[1])?.battery === "tenths") return value <= 10 ? value * 10 : null;
    return value <= 100 ? value : null;
  }
}
