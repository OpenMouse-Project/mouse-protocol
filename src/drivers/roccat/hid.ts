import type { MouseStatus } from "../mouse-types.ts";
import {
  ROCCAT_CONFIG_USAGE,
  ROCCAT_CONFIG_USAGE_PAGE,
  ROCCAT_HZ_TO_POLLING_CODE,
  ROCCAT_KONE_PRO_AIR_WIRELESS_PID,
  ROCCAT_PACKET_LENGTH,
  ROCCAT_PRODUCT_IDS,
  ROCCAT_PRODUCT_NAMES,
  ROCCAT_REPORT_ID,
  ROCCAT_VENDOR_ID,
  roccatDecodeSettingsReply,
  roccatEncodeSettingsQuery,
  type RoccatSettingsReply,
} from "../../roccat/index.ts";

/**
 * ROCCAT Kone Pro Air and Kone Pro over their vendor 0xFF00:0x0001 output
 * channel (see `@openmouse/protocol/roccat`). Frames are 64-byte unnumbered
 * output reports; the mouse answers on the same interface's input stream,
 * echoing the frame's class byte 1.
 *
 * **Read-only.** The driver reads the stored DPI stage table and reports what
 * it could verify; it ships no setter. The reason is on the wire, not in the
 * code: on 2026-10-16 the vendor's own settings frame was sent by hand, the
 * mouse echoed it, and its reply pages still read the previously stored stage
 * table, while a passive listener saw the vendor software polling and no
 * settings write on any of the four interfaces. A user-mode write to this unit
 * is acknowledged without being applied, and a whole-block write that is not
 * applied still costs the user their settings, so the write path stays out
 * until a capture shows one landing. `docs/roccat-kone-pro-air-testing.md`
 * records the session.
 *
 * What is verified on hardware (see `captures/roccat-kone-pro-air/`): the
 * settings query answers with a full stage table once the mouse is awake, the
 * status stream answers `90 0a 04 …`, and an asleep mouse echoes an empty body
 * that the decoder treats as no data rather than as five stages of 0 DPI.
 */
export class RoccatHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();

  /** Wraps a device the registry has already matched. */
  constructor(device: HIDDevice) {
    this.device = device;
  }

  /** Matches a Kone Pro (Air) that exposes the 0xFF00:0x0001 vendor collection. */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== ROCCAT_VENDOR_ID) return false;
    if (!ROCCAT_PRODUCT_IDS.includes(device.productId)) return false;
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === ROCCAT_CONFIG_USAGE_PAGE && collection.usage === ROCCAT_CONFIG_USAGE)
      || collection.children.some(search);
    return device.collections.some(search);
  }

  /** No discrete list: the five-stage table drives the DPI card instead. */
  getDpiOptions(): number[] {
    return [];
  }

  /** Opens the device if the vendor link is still closed. */
  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  /** Closes the vendor link. */
  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /** Product label for the UI. */
  displayName(): string {
    return ROCCAT_PRODUCT_NAMES.get(this.device.productId) ?? "ROCCAT mouse";
  }

  /** Brand tag reported in MouseStatus. */
  deviceBrand(): MouseStatus["brand"] {
    return "ROCCAT";
  }

  /** Wireless on the dongle pid, wired otherwise. */
  connectionType(): "Wired" | "Wireless" {
    return this.device.productId === ROCCAT_KONE_PRO_AIR_WIRELESS_PID ? "Wireless" : "Wired";
  }

  /** The four rates the polling byte can encode, for the read-only report. */
  getSupportedPollingRates(): number[] {
    return [...ROCCAT_HZ_TO_POLLING_CODE.keys()];
  }

  /** Serializes device work so transactions cannot interleave. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Sleeps for the echo window. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  /**
   * Sends one unnumbered 64-byte output report on the vendor interface. All
   * writes here are queries; callers serialize.
   */
  private async write(payload: Uint8Array): Promise<void> {
    await this.open();
    const frame = new Uint8Array(ROCCAT_PACKET_LENGTH);
    frame.set(payload.subarray(0, ROCCAT_PACKET_LENGTH));
    await this.device.sendReport(ROCCAT_REPORT_ID, frame as BufferSource);
  }

  /**
   * Sends a frame and collects the echo the mouse answers with on the input
   * stream. The echo matches on frame byte 1 (the report's class byte), the
   * one byte every captured variant echoes verbatim.
   */
  private async transact(payload: Uint8Array, waitMs = 250): Promise<Uint8Array | null> {
    await this.open();
    let echo: Uint8Array | null = null;
    const listener = (event: HIDInputReportEvent): void => {
      const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      if (data.length >= 3 && data[1] === payload[1] && !echo) echo = data.subarray(0, 24);
    };
    this.device.addEventListener("inputreport", listener);
    try {
      await this.write(payload);
      await this.delay(waitMs);
    } finally {
      this.device.removeEventListener("inputreport", listener);
    }
    return echo;
  }

  /**
   * The DPI table read. Null when the mouse never answers the query, or when it
   * answers with the empty body an asleep mouse sends.
   */
  async readDpiTable(): Promise<RoccatSettingsReply | null> {
    return this.run(() => this.readTable());
  }

  /** Sends the settings query and decodes the echo, without queueing. */
  private async readTable(): Promise<RoccatSettingsReply | null> {
    const echo = await this.transact(roccatEncodeSettingsQuery());
    return echo ? roccatDecodeSettingsReply(echo) : null;
  }

  /**
   * Status snapshot. The DPI table is the only field read from the mouse.
   * Polling rate, LOD, angle snapping, debounce and battery are not reported:
   * the echo carries no established position for the first four, and the
   * status byte's meaning is unresolved for the last.
   */
  async readStatus(): Promise<MouseStatus> {
    const dpiTable = await this.readDpiTable();
    const name = this.displayName();
    const connection = this.connectionType();
    return {
      brand: "ROCCAT",
      name,
      ui: {
        family: "roccat",
        settingsReady: false,
        valuesVerified: dpiTable !== null,
        pollingReadOnly: true,
        hideProcessingCard: true,
        hideSleepCard: true,
        hideSignalCard: true,
        pollingNote: "This driver reports the polling rate but cannot change it: no capture has shown a settings write landing on this mouse.",
        statusNote: dpiTable === null
          ? "The mouse did not answer its settings query, so DPI could not be read."
          : "Read-only for now: the DPI table reads back, but no settings write has been observed taking effect on this model.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: dpiTable?.dpi.stages[0] ?? 0,
      dpiY: dpiTable?.dpi.stagesY[0],
      supportsSeparateDpiAxes: true,
      pollingRateHz: 0,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      debounceMs: null,
      sleepTimeout: null,
      angleSnapping: null,
      liftOffDistance: null,
      connectionType: connection,
      connectionDetail: connection === "Wireless" ? "2.4 GHz (Stellar Wireless)" : "Wired USB",
      motionSync: null,
      rippleControl: null,
      dpiStages: dpiTable?.dpi.stages ? [...dpiTable.dpi.stages] : undefined,
      dpiStagesY: dpiTable?.dpi.stagesY ? [...dpiTable.dpi.stagesY] : undefined,
      activeDpiStage: 0,
      firmware: [],
    };
  }
}
