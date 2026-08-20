import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import { LAMZU_PRODUCTS } from "@openmouse/protocol/lamzu";

// Attack Shark mice ship from multiple OEMs with different VIDs and protocols:
//
//   0x1d57 — R1, X11 family: HID feature reports, 250 ms cmd delay
//   0x25a7 — X3, X6, X8, X11 direct: GearHub-derived protocol (report 0, 64 B)
//   0x373e — R5 Ultra, R3 (Lamzu OEM) — usagePage 0xffff feature reports
//
// PIDs change between firmware revisions, so detection is collection-based,
// not PID-based. For 0x373e we exclude known Lamzu PIDs.
//
// Protocol source: xb-bx/attack-shark-r1-driver (Odin)
//                  HarukaYamamoto0/attack-shark-x11-driver (TypeScript)
//                  qmk.top GearHub bundle (MU class — 0x25a7 protocol)
//                  Research credit: viix0dev

// ── VID constants ─────────────────────────────────────────────────────────

const VID_1D57 = 0x1d57; // R1 / X11 family
const VID_25A7 = VENDOR_ID.attackShark; // X3, X6, X8, X11 direct
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
const BATTERY_SIGNATURE = [0x03, 0x55, 0x40, 0x01];

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

// ── Protocol family detection ─────────────────────────────────────────────

type ProtocolFamily = "1d57" | "25a7" | "373e" | null;

function detectFamily(device: HIDDevice): ProtocolFamily {
  if (device.vendorId === VID_1D57) {
    // Some 0x1d57 mice (X8 SE, X11) use the GearHub protocol despite
    // sharing the R1 VID.  Distinguish by checking for a vendor-specific
    // collection (usagePage 0xffff) which the GearHub interface exposes.
    if (device.collections.some(hasVendorControl)) return "25a7";
    return device.collections.some(hasFeatureReports) ? "1d57" : null;
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
  private lastStatus: MouseStatus | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
    this.family = detectFamily(device);
  }

  static isSupported(device: HIDDevice): boolean {
    return detectFamily(device) !== null;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastStatus = null;
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    const name = this.device.productName?.trim();
    if (!name) return "Attack Shark";
    return /^attack\s*shark/i.test(name) ? name : `Attack Shark ${name}`;
  }

  deviceBrand(): string {
    return "Attack Shark";
  }

  isWireless(): boolean {
    return /receiver|dongle|wireless|2\.4g/i.test(this.device.productName || "");
  }

  getSupportedPollingRates(): number[] {
    if (this.family === "1d57") return POLLING_RATES_1D57.map(([, hz]) => hz);
    if (this.family === "25a7") return [...POLLING_CODES_25A7.keys()];
    return [];
  }

  getDpiOptions(): number[] {
    // 25a7 devices expose up to 8 DPI slots per profile.
    // The actual values are read dynamically in readStatus(); we return a
    // standard set of supported DPI steps so the UI can offer them.
    if (this.family === "25a7") {
      return [400, 800, 1200, 1600, 2400, 3200, 6400, 12000, 26000];
    }
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

    return this.lastStatus = {
      brand: "Attack Shark",
      name: this.displayName(),
      ui: {
        family: "attackshark",
        settingsReady: this.family === "1d57" || this.family === "25a7",
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi,
      pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      liftOffDistance: null,
      firmware,
    };
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
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

  // ── shared helpers ────────────────────────────────────────────────────

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
