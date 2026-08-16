import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import { LAMZU_PRODUCTS } from "@openmouse/protocol/lamzu";

// Attack Shark mice ship from multiple OEMs with different VIDs and protocols:
//
//   0x1d57 — R1, X11 family: HID feature reports, 250 ms cmd delay
//   0x25a7 — X3, X6, X11 direct — protocol TBD
//   0x373e — R5 Ultra, R3 (Lamzu OEM) — usagePage 0xffff feature reports
//
// PIDs change between firmware revisions, so detection is collection-based,
// not PID-based. For 0x373e we exclude known Lamzu PIDs.
//
// Real X11 hardware (0x1d57, wired 0xfa55 and wireless 0xfa60) exposes NO
// feature reports to the browser on any of its four HID entries. Its config
// channel is USB interface 2 (a system-control/consumer composite; see the
// lsusb dump in dressedinblack5/attack-shark-x11-electron docs/descritors),
// and the reference driver bypasses the HID stack entirely: it claims
// interface 2 with libusb, detaches the kernel HID driver on Linux, and on
// Windows requires Zadig to swap the driver for WinUSB. A browser can do
// none of that — WebHID sees no feature reports, and WebUSB refuses to
// claim HID-class interfaces. The collection gate below therefore correctly
// refuses these units; the X11-family helper further down turns that
// refusal into a real explanation.
//
// Protocol source: xb-bx/attack-shark-r1-driver (Odin)
//                  HarukaYamamoto0/attack-shark-x11-driver (TypeScript)
//                  Research credit: viix0dev

// ── VID constants ─────────────────────────────────────────────────────────

const VID_1D57 = 0x1d57; // R1 / X11 family
const VID_25A7 = VENDOR_ID.attackShark; // X3, X6, X11 direct
const VID_373E = 0x373e; // Lamzu OEM (R5 Ultra, R3)

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

// Battery arrives as input report with this 4-byte signature; byte 4 = %.
// The leading 0x03 is the HID report id of the battery packet.
const BATTERY_SIGNATURE = [0x03, 0x55, 0x40, 0x01];
const BATTERY_REPORT_ID = BATTERY_SIGNATURE[0];

// ── Collection helpers ─────────────────────────────────────────────────────

function hasFeatureReports(collection: HIDCollectionInfo): boolean {
  if (collection.featureReports.length > 0) return true;
  return collection.children.some(hasFeatureReports);
}

function hasVendorControl(collection: HIDCollectionInfo): boolean {
  if (collection.usagePage === 0xffff && collection.featureReports.length > 0) return true;
  return collection.children.some(hasVendorControl);
}

function declaresInputReport(collection: HIDCollectionInfo, reportId: number): boolean {
  if (collection.inputReports.some((report) => report.reportId === reportId)) return true;
  return collection.children.some((child) => declaresInputReport(child, reportId));
}

// ── X11 family (config is native-only; battery is readable) ──────────────

// Documented 0x1d57 PIDs: wired X11, wireless X11 receiver, R1.
const X11_FAMILY_PIDS: ReadonlySet<number> = new Set([0xfa55, 0xfa60, 0xfa61]);

const X11_FAMILY_NAMES: ReadonlyMap<number, string> = new Map([
  [0xfa55, "Attack Shark X11 (wired)"],
  [0xfa60, "Attack Shark X11 (wireless receiver)"],
  [0xfa61, "Attack Shark R1"],
]);

const X11_FAMILY_MODELS: ReadonlyMap<number, string> = new Map([
  [0xfa55, "Attack Shark X11"],
  [0xfa60, "Attack Shark X11"],
  [0xfa61, "Attack Shark R1"],
]);

// The wireless receiver's interface 2 pushes battery packets on its own —
// no command needed — so a read-only claim of that entry costs nothing and
// risks nothing. The wired PIDs never report battery on this endpoint.
const X11_WIRELESS_PID = 0xfa60;

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
  const name = X11_FAMILY_NAMES.get(unit.productId) ?? "Attack Shark X11";
  return `This ${name} entry cannot answer: it is one of the mouse's plain `
    + "keyboard/mouse interfaces. Re-open the picker and ctrl-click every row with "
    + "this name so OpenMouse can attach to the status entry (battery readout on "
    + "wireless). Changing settings is not possible from a browser for this mouse: "
    + "its config channel needs a native desktop driver (e.g. the open-source "
    + "Attack Shark X11 driver).";
}

// ── Protocol family detection ─────────────────────────────────────────────

type ProtocolFamily = "1d57" | "1d57-x11" | "25a7" | "373e" | null;

function detectFamily(device: HIDDevice): ProtocolFamily {
  if (device.vendorId === VID_1D57) {
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
    return device.collections.some(hasVendorControl) ? "25a7" : null;
  }
  if (device.vendorId === VID_373E) {
    if (LAMZU_PRODUCTS.has(device.productId)) return null;
    return device.collections.some(hasVendorControl) ? "373e" : null;
  }
  return null;
}

// ── Driver ────────────────────────────────────────────────────────────────

export class AttackSharkHidClient {
  readonly device: HIDDevice;

  private readonly family: ProtocolFamily;
  private lastStatus: MouseStatus | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private batteryPercent: number | null = null;
  private listening = false;

  constructor(device: HIDDevice) {
    this.device = device;
    this.family = detectFamily(device);
  }

  static isSupported(device: HIDDevice): boolean {
    return detectFamily(device) !== null;
  }

  // Battery packets arrive as inputreport events; the raw packet's leading
  // 0x03 is the HID report id, which WebHID strips into event.reportId, so
  // rebuild the native shape before matching the signature.
  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const packet = new Uint8Array(data.length + 1);
    packet[0] = event.reportId;
    packet.set(data, 1);
    const percent = AttackSharkHidClient.parseBatteryReport(packet);
    if (percent !== null) {
      this.batteryPercent = percent;
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

  displayName(): string {
    // X11-family product strings are generic OEM labels ("2.4G Wireless
    // Device", "USB Gaming Mouse"), so name those models by PID instead.
    const model = this.device.vendorId === VID_1D57
      ? X11_FAMILY_MODELS.get(this.device.productId)
      : undefined;
    if (model) return model;
    const name = this.device.productName?.trim();
    if (!name) return "Attack Shark";
    return /^attack\s*shark/i.test(name) ? name : `Attack Shark ${name}`;
  }

  deviceBrand(): string {
    return "Attack Shark";
  }

  isWireless(): boolean {
    if (this.device.vendorId === VID_1D57 && X11_FAMILY_PIDS.has(this.device.productId)) {
      return this.device.productId === X11_WIRELESS_PID;
    }
    return /receiver|dongle|wireless|2\.4g/i.test(this.device.productName || "");
  }

  getSupportedPollingRates(): number[] {
    if (this.family === "1d57") return POLLING_RATES_1D57.map(([, hz]) => hz);
    return [];
  }

  getDpiOptions(): number[] {
    return [];
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();

    let pollingRateHz = 0;
    if (this.family === "1d57") {
      pollingRateHz = await this.read1d57PollingRate().catch(() => 0);
    }

    return this.lastStatus = {
      brand: "Attack Shark",
      name: this.displayName(),
      ui: {
        family: "attackshark",
        settingsReady: this.family === "1d57",
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        // Wireless X11-family units push battery on their own — but only
        // show the column when the battery report is actually visible to
        // the browser. On known units it is declared under the protected
        // system-control collection, so Chrome hides it and the packet can
        // never arrive; an always-empty battery column would just confuse.
        forceShowBattery: this.family === "1d57-x11"
          && this.isWireless()
          && this.device.collections.some((collection) => declaresInputReport(collection, BATTERY_REPORT_ID)),
        statusNote: this.family === "1d57-x11"
          ? "Status only: this mouse's settings channel is not reachable from a browser and needs a native driver."
          : undefined,
      },
      batteryPercent: this.batteryPercent,
      batteryState: this.batteryPercent !== null ? "Discharging" : "Unknown",
      dpi: 0,
      pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      liftOffDistance: null,
      firmware: [],
    };
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (this.family === "1d57-x11") {
      throw new Error(
        "This mouse's settings channel is not reachable from a browser; "
        + "changing settings needs the native Attack Shark X11 driver.",
      );
    }
    if (this.family !== "1d57") {
      throw new Error("Polling rate control is not yet implemented for this Attack Shark model.");
    }
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

  // ── 0x1d57 low-level ──────────────────────────────────────────────────

  private async write1d57PollingRate(rateByte: number): Promise<void> {
    await this.open();
    // 8 data bytes — browser prepends report ID 0x06.
    // Structure: [0x09, 0x01, rate, checksum, 0, 0, 0, 0]
    const data = new Uint8Array([0x09, 0x01, rateByte, (0xff - rateByte) & 0xff, 0, 0, 0, 0]);
    await this.run(() => this.device.sendFeatureReport(POLLING_REPORT_ID, data));
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
    return BATTERY_SIGNATURE.every((byte, i) => data[i] === byte);
  }

  /** Extract battery percentage from a battery input report. */
  static parseBatteryReport(data: Uint8Array): number | null {
    if (!AttackSharkHidClient.isBatteryReport(data)) return null;
    const pct = data[4];
    return pct >= 0 && pct <= 100 ? pct : null;
  }
}
