import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import { LINGBAO_PRODUCTS } from "../lingbao/hid.ts";

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

/**
 * Report rate encoding for Fantech mice.
 *
 * This table is also the single source of truth for `supportedPollingRates`:
 * a rate the driver cannot encode must never reach the UI, which renders one
 * button per advertised rate and would throw on click. 250 Hz is deliberately
 * absent — Fantech's own spec sheet lists it for the WG14P, but its wire
 * encoding has never been captured, and inventing a code byte would silently
 * set some other rate. Add it here, and nowhere else, once a capture confirms
 * the value.
 */
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

/** DPI slots the Family B report layout has room for (bytes [8..23] X, [24..39] Y). */
export const FANTECH_MAX_DPI_SLOTS = 8;

/** First byte of the per-slot X DPI array, in both a GET_DPI response and a SET_DPI command. */
const DPI_X_OFFSET = 8;
/** First byte of the per-slot Y DPI array, immediately after the X array. */
const DPI_Y_OFFSET = DPI_X_OFFSET + FANTECH_MAX_DPI_SLOTS * 2;
/** One past the end of the Y array; the whole DPI table is [DPI_X_OFFSET, DPI_END). */
const DPI_END = DPI_Y_OFFSET + FANTECH_MAX_DPI_SLOTS * 2;

function rejectionMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

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
 *
 * NOT every VID 0x3151 mouse speaks Family B, and the ones that do not are
 * indistinguishable from the ones that do until you ask them something. The
 * 2.4G receiver sold as PID 0x402D presents byte-for-byte the interface
 * described above — vendor page 0xFFFF, usage 0x02, one unnumbered 64-byte
 * feature report — and ACKs every SET_FEATURE write without error, yet
 * answers GET_DPI, GET_REPORT_RATE, GET_ALL_PARAMS and GET_DEBOUNCE alike
 * with 64 zero bytes (measured on Windows across 0-500ms read delays and
 * three different command layouts).
 *
 * Reading those zeros as data is worse than failing outright: byte 2 of a
 * blank response decodes to report-rate code 0 = 8000 Hz, and a zero DPI used
 * to fall back to 1600, so `readStatus()` returned a perfectly plausible
 * "ready" mouse whose every number was invented. Each read below therefore
 * rejects a blank response, and `readStatus()` throws when nothing answers at
 * all — the caller treats that as "try the next candidate driver" (see
 * `connectToInterface()` in the desktop app under `src/native-hid/scan.ts`).
 */
export class FantechHidClient {
  device: HIDDevice;
  currentProfile = 0;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== VENDOR_ID.fantech) return false;
    // 0x3151 is the MicLink/mlzn ODM vendor id, not Fantech's own, and the
    // Lingbao M5 Pro answers on the identical 0xFFFF/0x02 interface while
    // speaking a different dialect entirely (2.4G relay + checksum). It has
    // its own driver; leave its product ids to it, or driverFor() would hand
    // this one a device it cannot read.
    if (LINGBAO_PRODUCTS.has(device.productId)) return false;
    const hasVendorConfig = (collections: readonly HIDCollectionInfo[]): boolean =>
      collections.some(
        (collection) =>
          (collection.usagePage === 0xffff &&
            collection.usage === 0x02) ||
          hasVendorConfig(collection.children),
      );
    return hasVendorConfig(device.collections);
  }

  /**
   * Only the rates this driver can actually put on the wire. Derived from
   * REPORT_RATE_ENCODE so the list the UI renders and the list
   * `setReportRate()` accepts cannot drift apart.
   */
  get supportedPollingRates(): number[] {
    return Object.keys(REPORT_RATE_ENCODE)
      .map(Number)
      .sort((a, b) => a - b);
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

  /** Send a command and return the raw response, answered or not. */
  async sendCommand(cmd: number, ...payload: number[]): Promise<Uint8Array> {
    const buf = new Uint8Array(FANTECH_REPORT_SIZE);
    buf[0] = cmd;
    for (let i = 0; i < payload.length && i + 1 < buf.length; i++) {
      buf[i + 1] = payload[i];
    }
    await this.device.sendFeatureReport(FANTECH_REPORT_ID, buf);
    return this.readResponse();
  }

  /**
   * Send a command that must be answered, rejecting a response that carries no
   * answer at all. A device on a different protocol family still ACKs the
   * feature write and hands back a zero-filled buffer, which is exactly what
   * used to be decoded into invented DPI and polling-rate readings — see the
   * class docs.
   */
  async sendQuery(cmd: number, ...payload: number[]): Promise<Uint8Array> {
    const resp = await this.sendCommand(cmd, ...payload);
    if (resp.length < FANTECH_REPORT_SIZE) {
      throw new Error(
        `Fantech command ${cmd} returned ${resp.length} bytes, expected ${FANTECH_REPORT_SIZE}.`,
      );
    }
    if (resp.every((byte) => byte === 0)) {
      throw new Error(
        `Fantech command ${cmd} was not answered (all-zero response); this device does not speak the Family B protocol.`,
      );
    }
    return resp;
  }

  /** Read a response report. */
  async readResponse(): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(FANTECH_REPORT_ID);
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  // ---------------------------------------------------------------------------
  // DPI Protocol
  // ---------------------------------------------------------------------------

  /**
   * Read current DPI settings for the active slot. Throws when the device does
   * not answer, or answers without a usable DPI — a caller must never be handed
   * a fabricated default it cannot tell apart from a real reading.
   */
  async getDpi(): Promise<{
    dpiX: number;
    dpiY: number;
    slot: number;
    numSlots: number;
  }> {
    await this.open();
    const resp = await this.sendQuery(CMD.GET_DPI, this.currentProfile);

    // Response structure (Family B):
    // Byte 2: current DPI slot index
    // Byte 3: number of DPI slots
    // Bytes [8..23]: X DPI per slot (LE uint16, up to 8 slots)
    // Bytes [24..39]: Y DPI per slot (LE uint16, up to 8 slots)
    const slot = resp[2] >= FANTECH_MAX_DPI_SLOTS ? 0 : resp[2];
    const numSlots = resp[3] || 1;

    const dpiX = resp[DPI_X_OFFSET + slot * 2] | (resp[DPI_X_OFFSET + 1 + slot * 2] << 8);
    const dpiY = resp[DPI_Y_OFFSET + slot * 2] | (resp[DPI_Y_OFFSET + 1 + slot * 2] << 8);
    if (!dpiX) {
      throw new Error(`Fantech GET_DPI answered, but slot ${slot} carries no DPI value.`);
    }

    return { dpiX, dpiY: dpiY || dpiX, slot, numSlots };
  }

  /** Set DPI for a specific slot, leaving every other slot exactly as it was. */
  async setDpiForSlot(dpiX: number, dpiY: number, slot = 0): Promise<number> {
    await this.open();

    // Read current state first. SET_DPI carries the WHOLE per-slot DPI table,
    // so every slot that is not being written has to be echoed back unchanged;
    // sending a freshly zeroed buffer wiped the other DPI stages.
    const readResp = await this.sendQuery(CMD.GET_DPI, this.currentProfile);
    const numSlots = readResp[3] || 1;
    const target = slot >= FANTECH_MAX_DPI_SLOTS ? 0 : slot;

    // Build the Set DPI command
    const buf = new Uint8Array(FANTECH_REPORT_SIZE);
    buf[0] = CMD.SET_DPI;
    buf[1] = this.currentProfile;
    buf[2] = target;
    buf[3] = numSlots;

    // Carry every slot's existing X and Y over before overwriting the target's.
    buf.set(readResp.subarray(DPI_X_OFFSET, DPI_END), DPI_X_OFFSET);

    // Write X DPI as LE uint16
    buf[DPI_X_OFFSET + target * 2] = dpiX & 0xff;
    buf[DPI_X_OFFSET + 1 + target * 2] = (dpiX >> 8) & 0xff;

    // Write Y DPI as LE uint16
    buf[DPI_Y_OFFSET + target * 2] = dpiY & 0xff;
    buf[DPI_Y_OFFSET + 1 + target * 2] = (dpiY >> 8) & 0xff;

    await this.device.sendFeatureReport(FANTECH_REPORT_ID, buf);
    return dpiX;
  }

  // ---------------------------------------------------------------------------
  // Report Rate Protocol
  // ---------------------------------------------------------------------------

  /** Get current report/polling rate. Throws when the device does not answer. */
  async getReportRate(): Promise<number> {
    await this.open();
    const resp = await this.sendQuery(CMD.GET_REPORT_RATE);
    const code = resp[2];
    const hz = REPORT_RATE_DECODE[code];
    if (hz === undefined) {
      throw new Error(`Fantech GET_REPORT_RATE returned unknown rate code ${code}.`);
    }
    return hz;
  }

  /** Set report/polling rate. */
  async setReportRate(hz: number): Promise<number> {
    if (!(hz in REPORT_RATE_ENCODE)) {
      throw new Error(
        `Unsupported rate ${hz} Hz. Supported: ${this.supportedPollingRates.join(", ")}`,
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

    // Nothing answered at all: this interface is not a Family B control
    // channel, so fail instead of returning a status assembled from defaults.
    if (dpiResult.status === "rejected" && pollRate.status === "rejected") {
      throw new Error(
        `Fantech control interface did not answer. ${rejectionMessage(dpiResult)} ${rejectionMessage(pollRate)}`,
      );
    }

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
      // connectionType/connectionDetail are deliberately unset. Family B
      // carries no link information, and VID 0x3151 covers both wired mice and
      // 2.4G receivers, so the "Wired (USB)" that used to be hardcoded here
      // mislabelled every wireless one. OverviewPage hides the row when absent.
      liftOffDistance: null,
      // No firmware command is implemented; an empty list hides the row instead
      // of showing the placeholder string that used to sit here.
      firmware: [],
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
      throw new Error(
        `Fantech supports ${this.supportedPollingRates.join(", ")} Hz.`,
      );
    }
    await this.setReportRate(rate);
    return rate;
  }
}
