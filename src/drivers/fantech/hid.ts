import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";

// Fantech command IDs (from GearHub qmk.top protocol)
export const CMD = {
  // Family B (older Fantech mice) command set
  GET_ALL_PARAMS: 159,    // Get all parameters (profile, report rate, etc.)
  GET_DPI: 144,           // Get DPI settings (SENSORDPI)
  SET_DPI: 16,            // Set DPI settings
  GET_REPORT_RATE: 131,   // Get report/polling rate
  SET_REPORT_RATE: 8,     // Set report/polling rate
  GET_DEBOUNCE: 132,      // Get debounce time
  SET_DEBOUNCE: 4,        // Set debounce time
  SET_PROFILE: 2,         // Set current profile
} as const;

// Report rate encoding for Fantech mice
export const REPORT_RATE_ENCODE: Record<number, number> = {
  8000: 0,
  4000: 1,
  2000: 2,
  1000: 3,
  500: 4,
  125: 5,
};

export const REPORT_RATE_DECODE: Record<number, number> = Object.fromEntries(
  Object.entries(REPORT_RATE_ENCODE).map(([k, v]) => [v, Number(k)]),
);

export const FANTECH_REPORT_ID = 0x00;
export const FANTECH_REPORT_SIZE = 64;

/**
 * Fantech vendor HID control.
 *
 * Transport: vendor usage page 0xFFFF, usage 0x02 under VID 0x3151.
 * The WG14P Yari Pro exposes a 64-byte feature report on this interface
 * for DPI and configuration settings.
 *
 * Protocol: Fantech command-based protocol (Family B).
 * - Send command as first byte of 64-byte feature report
 * - Read response as 64-byte feature report
 * - DPI stored as LE uint16 in bytes [8+h*2..9+h*2] (X) and [24+h*2..25+h*2] (Y)
 * - Report rate encoded as 0=8000, 1=4000, 2=2000, 3=1000, 4=500, 5=125
 */
export class FantechHidClient {
  device: HIDDevice;
  currentProfile = 0;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== VENDOR_ID.fantech) return false;
    const hasVendorConfig = (collections: readonly HIDCollectionInfo[]): boolean =>
      collections.some(
        (collection) =>
          (collection.usagePage === 0xffff &&
            collection.usage === 0x02) ||
          hasVendorConfig(collection.children),
      );
    return hasVendorConfig(device.collections);
  }

  get supportedPollingRates(): number[] {
    return [125, 250, 500, 1000, 2000, 4000, 8000];
  }

  getDpiOptions(): number[] {
    return [
      400, 800, 1200, 1600, 2000, 2400, 3200, 4000, 4800, 5600, 6400, 8000,
      10000, 12000, 16000, 20000, 26000, 30000,
    ];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  // ---------------------------------------------------------------------------
  // Command I/O
  // ---------------------------------------------------------------------------

  /** Send a command and receive the response. */
  async sendCommand(cmd: number, ...payload: number[]): Promise<Uint8Array> {
    const buf = new Uint8Array(FANTECH_REPORT_SIZE);
    buf[0] = cmd;
    for (let i = 0; i < payload.length && i + 1 < buf.length; i++) {
      buf[i + 1] = payload[i];
    }
    await this.device.sendFeatureReport(FANTECH_REPORT_ID, buf);
    return this.readResponse();
  }

  /** Read a response report. */
  async readResponse(): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(FANTECH_REPORT_ID);
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  // ---------------------------------------------------------------------------
  // DPI Protocol
  // ---------------------------------------------------------------------------

  /** Read current DPI settings. Returns DPI for active slot. */
  async getDpi(): Promise<{
    dpiX: number;
    dpiY: number;
    slot: number;
    numSlots: number;
  }> {
    await this.open();
    const resp = await this.sendCommand(CMD.GET_DPI, this.currentProfile);
    if (resp.length < 10) return { dpiX: 1600, dpiY: 1600, slot: 0, numSlots: 1 };

    // Response structure (Family B):
    // Byte 2: current DPI slot index
    // Byte 3: number of DPI slots
    // Bytes [8..23]: X DPI per slot (LE uint16, up to 8 slots)
    // Bytes [24..39]: Y DPI per slot (LE uint16, up to 8 slots)
    const slot = resp[2] > 8 ? 0 : resp[2];
    const numSlots = resp[3] || 1;

    const dpiX = resp[8 + slot * 2] | (resp[9 + slot * 2] << 8);
    const dpiY = resp[24 + slot * 2] | (resp[25 + slot * 2] << 8);

    return {
      dpiX: dpiX || 1600,
      dpiY: dpiY || dpiX || 1600,
      slot,
      numSlots,
    };
  }

  /** Set DPI for a specific slot. */
  async setDpiForSlot(dpiX: number, dpiY: number, slot = 0): Promise<number> {
    await this.open();

    // First read current state
    const readResp = await this.sendCommand(CMD.GET_DPI, this.currentProfile);
    const numSlots = readResp[3] || 1;

    // Build the Set DPI command
    const buf = new Uint8Array(FANTECH_REPORT_SIZE);
    buf[0] = CMD.SET_DPI;
    buf[1] = this.currentProfile;
    buf[2] = slot > 8 ? 0 : slot;
    buf[3] = numSlots;

    // Write X DPI as LE uint16
    buf[8 + slot * 2] = dpiX & 0xff;
    buf[9 + slot * 2] = (dpiX >> 8) & 0xff;

    // Write Y DPI as LE uint16
    buf[24 + slot * 2] = dpiY & 0xff;
    buf[25 + slot * 2] = (dpiY >> 8) & 0xff;

    await this.device.sendFeatureReport(FANTECH_REPORT_ID, buf);
    return dpiX;
  }

  // ---------------------------------------------------------------------------
  // Report Rate Protocol
  // ---------------------------------------------------------------------------

  /** Get current report/polling rate. */
  async getReportRate(): Promise<number> {
    await this.open();
    const resp = await this.sendCommand(CMD.GET_REPORT_RATE);
    const code = resp.length > 2 ? resp[2] : 3;
    return REPORT_RATE_DECODE[code] ?? 1000;
  }

  /** Set report/polling rate. */
  async setReportRate(hz: number): Promise<number> {
    if (!(hz in REPORT_RATE_ENCODE)) {
      throw new Error(
        `Unsupported rate ${hz} Hz. Supported: ${Object.keys(REPORT_RATE_ENCODE).join(", ")}`,
      );
    }
    await this.open();
    const code = REPORT_RATE_ENCODE[hz];
    const buf = new Uint8Array(FANTECH_REPORT_SIZE);
    buf[0] = CMD.SET_REPORT_RATE;
    buf[1] = code;
    await this.device.sendFeatureReport(FANTECH_REPORT_ID, buf);
    return hz;
  }

  // ---------------------------------------------------------------------------
  // High-Level API
  // ---------------------------------------------------------------------------

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const [dpiResult, pollRate] = await Promise.allSettled([
      this.getDpi(),
      this.getReportRate(),
    ]);

    const dpiData =
      dpiResult.status === "fulfilled" ? dpiResult.value : null;
    const pollRateVal =
      pollRate.status === "fulfilled" ? pollRate.value : 1000;

    return {
      brand: "Fantech",
      name: this.device.productName || "Fantech Mouse",
      ui: {
        family: "fantech",
        settingsReady: dpiData !== null,
        hideLodLow: true,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        defaultDisplayName: this.device.productName || "Fantech Mouse",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: dpiData?.dpiX ?? 1600,
      dpiY: dpiData?.dpiY ?? dpiData?.dpiX ?? 1600,
      pollingRateHz: pollRateVal,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: this.currentProfile,
      connectionType: "Wired",
      connectionDetail: "USB",
      liftOffDistance: null,
      firmware: ["Fantech mouse"],
    };
  }

  async setDpi(dpi: number, dpiY = dpi): Promise<number> {
    await this.open();
    const current = await this.getDpi();
    await this.setDpiForSlot(dpi, dpiY, current.slot);
    return dpi;
  }

  async setPollingRate(rate: number): Promise<number> {
    if (!this.supportedPollingRates.includes(rate)) {
      throw new Error("Fantech supports 125, 250, 500, 1000, 2000, 4000, or 8000 Hz.");
    }
    await this.setReportRate(rate);
    return rate;
  }
}
