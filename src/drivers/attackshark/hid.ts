import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import { LAMZU_PRODUCTS } from "@openmouse/protocol/lamzu";
import { DELUX_M600_PRO_MODEL_ID, DELUX_UNBRANDED_PRODUCT_IDS } from "@openmouse/protocol/delux";
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
const X11_RECEIVER_MODELS: ReadonlyMap<number, ReceiverModel> = new Map([
  [0x55, attackShark("X11", "percent")],
  // xb-bx/attack-shark-r1-driver reports charge as p2 * 10.
  [0x10, attackShark("R1", "tenths")],
  [0x85, attackShark("X6", "tenths")],
  [0x4d, attackShark("X3")],
  [0x4e, attackShark("X3 Max")],
  [0x01, attackShark("X3 Pro")],
  [0x07, attackShark("X11 SE")],
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
// path (docs/delux-m600-pro-testing.md).
const X11_REBUILT_CONFIG_MODELS: ReadonlySet<number> = new Set([DELUX_M600_PRO_MODEL_ID]);

// The firmware has no cheap "current DPI" command, so — exactly like the
// reference driver — the last full six-stage table this process wrote (or
// read back, when the read succeeds) is remembered here and re-sent whole on
// every edit. Module-level because the desktop app opens a fresh short-lived
// client per write and the table must survive between them.
interface X11DpiState {
  stages: number[];
  activeStage: number;
  angleSnap: boolean;
  rippleControl: boolean;
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
    };
    x11DpiStates.set(productId, state);
  }
  return state;
}

/** Test/diagnostic hook: forget cached X11 DPI state (defaults come back). */
export function resetAttackSharkX11DpiState(): void {
  x11DpiStates.clear();
}

// Battery and polling rate are both push/last-known rather than readable: the
// receiver streams `03 55 40 01 <pct>` on interface 2 on its own, and the
// firmware has no polling-rate read-back. This process keeps the last value it
// saw per product id so a short-lived client can still report it. The X11's
// reference driver and the web app's own X11 bridge both default the polling
// rate to 1,000 Hz for the same reason.
const X11_DEFAULT_POLLING_HZ = 1000;
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
}

const x11RuntimeStates = new Map<number, X11RuntimeState>();

function x11RuntimeFor(productId: number): X11RuntimeState {
  let state = x11RuntimeStates.get(productId);
  if (!state) {
    state = { pollingRateHz: X11_DEFAULT_POLLING_HZ, batteryPercent: null, batteryAt: 0, modelId: null };
    x11RuntimeStates.set(productId, state);
  }
  return state;
}

// Two config writes through the 2.4 GHz receiver about 0.4-0.5 s apart froze
// the link until the receiver was replugged; pairs 1, 2 and 3 s apart did not
// (Delux M600 Pro, docs/delux-m600-pro-testing.md). The receiver answers each
// write within ~10 ms, so the gap is enforced from the last write rather than
// waiting on that answer. Module-level for the same short-lived-client reason
// as the state above.
const X11_RECEIVER_WRITE_GAP_MS = 1000;
const x11LastReceiverWriteAt = new Map<number, number>();

/** Test/diagnostic hook: forget cached X11 battery/polling state. */
export function resetAttackSharkX11RuntimeState(): void {
  x11RuntimeStates.clear();
  x11LastReceiverWriteAt.clear();
}

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
  private lastStatus: MouseStatus | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private batteryPercent: number | null = null;
  private listening = false;

  constructor(device: HIDDevice, options: { batteryWaitMs?: number; receiverWriteGapMs?: number } = {}) {
    this.device = device;
    this.family = detectFamily(device);
    this.batteryWaitMs = options.batteryWaitMs ?? X11_BATTERY_WAIT_MS;
    this.receiverWriteGapMs = options.receiverWriteGapMs ?? X11_RECEIVER_WRITE_GAP_MS;
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

  /** True when this unit's DPI report 0x04 can be driven. */
  private get x11DpiSupported(): boolean {
    return this.family === "1d57-x11"
      && this.x11ConfigReachable
      && X11_DPI_PIDS.has(this.device.productId);
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
    if (packet[0] === BATTERY_REPORT_ID && X11_RECEIVER_MODELS.has(packet[1])) {
      x11RuntimeFor(this.device.productId).modelId = packet[1];
    }
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
    if (this.family === "25a7") {
      return [400, 800, 1200, 1600, 2400, 3200, 6400, 12000, 26000];
    }
    // The app only accepts stage edits that appear in this list; without it
    // the X11 stage editor could switch stages but never change a value.
    if (this.x11DpiSupported) return [...X11_DPI_VALUES];
    return [];
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();

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
    if (this.x11RebuiltConfig && this.isWireless()) {
      await this.waitForX11Battery(x11RuntimeFor(this.device.productId));
    }

    const dpiState = this.x11DpiSupported ? x11DpiStateFor(this.device.productId) : null;
    // Only native adapters try the read: over WebHID every GET_FEATURE on
    // this firmware timed out (about 5 s each) on the measured hardware.
    if (dpiState && this.nativeConfig) {
      await this.readX11DpiState();
    }
    if (dpiState) {
      dpi = dpiState.stages[dpiState.activeStage - 1] ?? 0;
    }

    // Native X11: polling rate has no read-back (report the last value this
    // process applied, defaulting to 1,000 Hz), and the wireless receiver
    // pushes battery on its own — give it a bounded moment to arrive.
    const x11Runtime = this.family === "1d57-x11" && this.x11ConfigReachable
      ? x11RuntimeFor(this.device.productId)
      : null;
    if (x11Runtime) {
      if (this.isWireless()) await this.waitForX11Battery(x11Runtime);
      pollingRateHz = x11Runtime.pollingRateHz;
    }
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
        hideProcessingCard: true,
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
              countEditable: false,
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
          dpiStages: [...dpiState.stages],
          activeDpiStage: dpiState.activeStage - 1,
          angleSnapping: dpiState.angleSnap,
          rippleControl: dpiState.rippleControl,
        }
        : {}),
      pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      liftOffDistance: null,
      firmware,
    };
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (this.family === "1d57-x11") {
      if (!this.x11ConfigReachable) {
        throw new Error(
          "This mouse's settings channel is not reachable from a browser; "
          + "changing settings needs the OpenMouse Bridge or the desktop app.",
        );
      }
      // Native transport: the same 0x06 feature report the 0x1d57 (R1) path
      // uses. This firmware exposes no read-back command, so trust the write
      // and cache the value rather than confirming it.
      const entry = POLLING_RATES_1D57.find(([, hz]) => hz === pollingRateHz);
      if (!entry) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
      await this.write1d57PollingRate(entry[0]);
      x11RuntimeFor(this.device.productId).pollingRateHz = pollingRateHz;
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
   * Re-send the full six-stage table. The firmware has no partial update and
   * no reliable read-back, so every edit carries the whole table — the same
   * approach the reference driver takes.
   */
  private async writeX11Dpi(): Promise<void> {
    const state = x11DpiStateFor(this.device.productId);
    const report = buildX11DpiReport({
      stages: state.stages,
      activeStage: state.activeStage,
      angleSnap: state.angleSnap,
      rippleControl: state.rippleControl,
      wired: this.x11UsesShortDpiReport(),
    });
    // The buffer's leading byte is the report id; WebHID/Tauri take it
    // separately. Copy so the payload is a plain ArrayBuffer-backed view.
    const payload = new Uint8Array(report.length - 1);
    payload.set(report.subarray(1));
    await this.sendConfigReport(X11_DPI_REPORT_ID, payload);
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
   * Best-effort read of the live table. The reference driver only documents
   * this for the wireless receiver (a GET on report 0x04); the wired unit
   * returns nothing. A failure leaves the cached table untouched rather than
   * aborting the status read.
   */
  private async readX11DpiState(): Promise<void> {
    if (this.device.productId === 0xfa55) return;
    const state = x11DpiStateFor(this.device.productId);
    try {
      const view = await this.run(() => this.device.receiveFeatureReport(X11_DPI_REPORT_ID));
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const decoded = decodeX11DpiReport(bytes);
      if (!decoded) return;
      state.stages = [...decoded.stages];
      state.activeStage = decoded.activeStage;
      state.angleSnap = decoded.angleSnap;
      state.rippleControl = decoded.rippleControl;
    } catch {
      // No read-back on this firmware/transport; keep the cached table.
    }
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

  /** Sets the active stage's DPI, preserving the other five. */
  async setDpi(dpi: number, _dpiY?: number): Promise<number> {
    this.requireX11Dpi();
    const state = x11DpiStateFor(this.device.productId);
    const value = nearestX11Dpi(dpi);
    state.stages[state.activeStage - 1] = value;
    await this.writeX11Dpi();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, dpi: value };
    return value;
  }

  /** Edits one stage's DPI. `stage` is 0-based, matching the shared UI contract. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    this.requireX11Dpi();
    if (!Number.isInteger(stage) || stage < 0 || stage >= X11_DPI_STAGE_COUNT) {
      throw new RangeError(`This mouse has no DPI stage ${stage + 1}.`);
    }
    const state = x11DpiStateFor(this.device.productId);
    const value = nearestX11Dpi(dpi);
    state.stages[stage] = value;
    await this.writeX11Dpi();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, dpiStages: [...state.stages] };
    return value;
  }

  /** Selects the active stage. `stage` is 0-based, matching the shared UI contract. */
  async setActiveDpiStage(stage: number): Promise<number> {
    this.requireX11Dpi();
    if (!Number.isInteger(stage) || stage < 0 || stage >= X11_DPI_STAGE_COUNT) {
      throw new RangeError(`This mouse has no DPI stage ${stage + 1}.`);
    }
    const state = x11DpiStateFor(this.device.productId);
    state.activeStage = stage + 1;
    await this.writeX11Dpi();
    if (this.lastStatus) {
      this.lastStatus = {
        ...this.lastStatus,
        dpi: state.stages[stage] ?? this.lastStatus.dpi,
        activeDpiStage: stage,
      };
    }
    return stage;
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    this.requireX11Dpi();
    x11DpiStateFor(this.device.productId).angleSnap = enabled;
    await this.writeX11Dpi();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, angleSnapping: enabled };
    return enabled;
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    this.requireX11Dpi();
    x11DpiStateFor(this.device.productId).rippleControl = enabled;
    await this.writeX11Dpi();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, rippleControl: enabled };
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

  private async write1d57PollingRate(rateByte: number): Promise<void> {
    await this.open();
    // 8 data bytes — browser prepends report ID 0x06.
    // Structure: [0x09, 0x01, rate, checksum, 0, 0, 0, 0]
    const data = new Uint8Array([0x09, 0x01, rateByte, (0xff - rateByte) & 0xff, 0, 0, 0, 0]);
    await this.sendConfigReport(POLLING_REPORT_ID, data);
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

  /**
   * Send one config report, holding it back until the receiver gap since the
   * previous write has passed. Runs inside the command queue so overlapping
   * callers are spaced too.
   */
  private sendConfigReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.run(async () => {
      const paced = this.family === "1d57-x11" && this.isWireless();
      if (paced) {
        const wait = (x11LastReceiverWriteAt.get(this.device.productId) ?? 0) + this.receiverWriteGapMs - Date.now();
        if (wait > 0) await this.delay(wait);
      }
      try {
        await this.device.sendFeatureReport(reportId, data);
      } finally {
        if (paced) x11LastReceiverWriteAt.set(this.device.productId, Date.now());
      }
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
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
