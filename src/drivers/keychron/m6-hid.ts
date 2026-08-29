import type { MouseStatus } from "../mouse-types.ts";
import {
  KEYCHRON_M6_COMMAND_REPORT_ID as COMMAND_REPORT_ID,
  KEYCHRON_M6_COMMAND_RESPONSE_REPORT_ID as COMMAND_RESPONSE_REPORT_ID,
  KEYCHRON_M6_PRODUCT_ID as PRODUCT_ID,
  KEYCHRON_M6_RECEIVER_PRODUCT_ID as RECEIVER_PRODUCT_ID,
  KEYCHRON_M6_SETTINGS_REPORT_ID as SETTINGS_REPORT_ID,
  KEYCHRON_M6_SETTINGS_RESPONSE_REPORT_ID as SETTINGS_RESPONSE_REPORT_ID,
  KEYCHRON_M6_STATUS_COMMAND as STATUS_COMMAND,
  KEYCHRON_M6_STATUS_PACKET_LENGTH as PACKET_LENGTH,
  KEYCHRON_M6_USAGE as USAGE,
  KEYCHRON_M6_USAGE_PAGE as USAGE_PAGE,
  KEYCHRON_VENDOR_ID,
} from "@openmouse/protocol/keychron";

const QUERY_TIMEOUT_MS = 1200;
const DPI_STAGE_COUNT = 5;
const DPI_MIN = 100;
const DPI_MAX = 26_000;
const DPI_STEP = 50;
const POLLING_RATES = [125, 500, 1000] as const;

type M6Settings = {
  activeDpiStage: number;
  dpiStages: number[];
  pollingTable: number[];
  pollingIndex: number;
  batteryPercent: number;
  charging: boolean;
};

/**
 * Keychron M6 wired client. The 0xffc1 collection uses 63-byte reports,
 * unlike the VIA raw-HID protocol used by the Nape Pro.
 */
export class KeychronM6HidClient {
  readonly device: HIDDevice;
  private openedListener = false;
  private responseWaiter: {
    reportId: number;
    match: (bytes: Uint8Array) => boolean;
    resolve: (bytes: Uint8Array) => void;
    reject: (reason: Error) => void;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== this.responseWaiter?.reportId) return;
    const bytes = new Uint8Array(event.data.buffer.slice(
      event.data.byteOffset,
      event.data.byteOffset + event.data.byteLength,
    ));
    if (!this.responseWaiter.match(bytes)) return;
    const waiter = this.responseWaiter;
    this.responseWaiter = null;
    waiter.resolve(bytes);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === KEYCHRON_VENDOR_ID
      && (device.productId === PRODUCT_ID || device.productId === RECEIVER_PRODUCT_ID)
      && device.collections.some((collection) =>
        collection.usagePage === USAGE_PAGE
        && collection.usage === USAGE
        && collection.outputReports.some((report) => report.reportId === COMMAND_REPORT_ID)
        && collection.inputReports.some((report) => report.reportId === COMMAND_RESPONSE_REPORT_ID));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.openedListener) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.openedListener = true;
    }
  }

  async close(): Promise<void> {
    if (this.openedListener) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.openedListener = false;
    }
    this.responseWaiter?.reject(new Error("The Keychron M6 device was closed."));
    this.responseWaiter = null;
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    return Array.from({ length: (DPI_MAX - DPI_MIN) / DPI_STEP + 1 }, (_, index) => DPI_MIN + index * DPI_STEP);
  }

  readonly canDisableSleep = false;

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const settings = this.parseStatus(await this.queryStatus());
    const activeDpiStage = Math.min(settings.activeDpiStage, settings.dpiStages.length - 1);
    const dpi = settings.dpiStages[activeDpiStage] ?? settings.dpiStages[0] ?? 800;
    const pollingRateHz = POLLING_RATES[settings.pollingTable[settings.pollingIndex] ?? 2] ?? 1000;
    const supportedPollingRates = settings.pollingTable
      .map((value) => POLLING_RATES[value])
      .filter((value) => value !== undefined) as number[];

    return {
      brand: "Keychron",
      name: "Keychron M6",
      ui: {
        family: "keychron-m6",
        defaultDisplayName: "Keychron M6",
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        hideSleepCard: true,
        forceShowBattery: true,
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          countEditable: false,
          minDpi: DPI_MIN,
          maxDpi: DPI_MAX,
          stepDpi: DPI_STEP,
        },
      },
      batteryPercent: settings.batteryPercent <= 100 ? settings.batteryPercent : null,
      batteryState: settings.charging ? "Charging" : "Discharging",
      dpi,
      dpiStages: settings.dpiStages,
      activeDpiStage,
      pollingRateHz,
      supportedPollingRates: supportedPollingRates.length ? supportedPollingRates : [pollingRateHz],
      activeProfile: null,
      connectionType: this.device.productId === RECEIVER_PRODUCT_ID ? "Wireless" : "Wired",
      connectionDetail: this.device.productId === RECEIVER_PRODUCT_ID
        ? "2.4 GHz (Keychron Link-KM)"
        : "Wired USB",
      liftOffDistance: null,
      supportedLiftOffDistances: [],
      firmware: ["Firmware version not yet decoded"],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
      throw new Error(`Keychron M6 DPI must be a multiple of ${DPI_STEP} between ${DPI_MIN} and ${DPI_MAX}.`);
    }
    await this.open();
    const settings = this.parseStatus(await this.queryStatus());
    const active = Math.min(settings.activeDpiStage, DPI_STAGE_COUNT - 1);
    settings.dpiStages[active] = dpi;
    await this.writeSettings(this.dpiSettingsPacket(settings));
    const confirmed = this.parseStatus(await this.queryStatus()).dpiStages[active];
    if (confirmed !== dpi) throw new Error(`The Keychron M6 kept ${confirmed} DPI instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= DPI_STAGE_COUNT) {
      throw new Error(`DPI stage must be between 1 and ${DPI_STAGE_COUNT}.`);
    }
    await this.open();
    const settings = this.parseStatus(await this.queryStatus());
    settings.activeDpiStage = stage;
    await this.writeSettings(this.dpiSettingsPacket(settings));
    const confirmed = this.parseStatus(await this.queryStatus()).activeDpiStage;
    if (confirmed !== stage) throw new Error(`The Keychron M6 kept DPI stage ${confirmed + 1}.`);
    return confirmed;
  }

  async setPollingRate(rateHz: number): Promise<number> {
    await this.open();
    const settings = this.parseStatus(await this.queryStatus());
    const supported = settings.pollingTable
      .map((value) => POLLING_RATES[value])
      .filter((value) => value !== undefined) as number[];
    if (!supported.includes(rateHz)) throw new Error(`The Keychron M6 does not support ${rateHz} Hz on this connection.`);
    const pollingIndex = settings.pollingTable.findIndex((value) => POLLING_RATES[value] === rateHz);
    if (pollingIndex < 0) throw new Error(`The Keychron M6 has no polling-rate entry for ${rateHz} Hz.`);
    settings.pollingIndex = pollingIndex;
    await this.writeSettings(this.pollingSettingsPacket(settings));
    const confirmed = this.parseStatus(await this.queryStatus());
    const actual = POLLING_RATES[confirmed.pollingTable[confirmed.pollingIndex] ?? 2] ?? 1000;
    if (actual !== rateHz) throw new Error(`The Keychron M6 kept ${actual} Hz instead of ${rateHz} Hz.`);
    return actual;
  }

  async setLiftOffDistance(_lod: NonNullable<MouseStatus["liftOffDistance"]>): Promise<never> {
    throw new Error("Lift-off distance writes are not yet validated for the Keychron M6.");
  }

  async setMotionSync(_enabled: boolean): Promise<never> {
    throw new Error("Motion Sync writes are not yet validated for the Keychron M6.");
  }

  async setAngleSnapping(_enabled: boolean): Promise<never> {
    throw new Error("Angle-snapping writes are not yet validated for the Keychron M6.");
  }

  async setRippleControl(_enabled: boolean): Promise<never> {
    throw new Error("Ripple-control writes are not yet validated for the Keychron M6.");
  }

  async setDebounceTime(_debounceMs: number): Promise<never> {
    throw new Error("Debounce writes are not yet validated for the Keychron M6.");
  }

  private parseStatus(bytes: Uint8Array): M6Settings {
    if (bytes.length < 51 || bytes[0] !== STATUS_COMMAND) {
      throw new Error("The Keychron M6 returned an invalid status report.");
    }
    const dpiStages = Array.from({ length: DPI_STAGE_COUNT }, (_, index) => {
      const offset = 5 + index * 2;
      return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    });
    const pollingCount = Math.min(bytes[49] || 6, 6);
    return {
      activeDpiStage: bytes[1] ?? 0,
      dpiStages,
      pollingTable: Array.from(bytes.slice(43, 43 + pollingCount)),
      pollingIndex: ((bytes[2] ?? 0) >> 4) & 0x0f,
      batteryPercent: (bytes[19] ?? 0) & 0x7f,
      charging: ((bytes[19] ?? 0) & 0x80) !== 0,
    };
  }

  private dpiSettingsPacket(settings: M6Settings): Uint8Array {
    const packet = new Uint8Array(20);
    packet[0] = 0x40;
    packet[1] = settings.activeDpiStage;
    packet[2] = settings.activeDpiStage;
    packet[3] = settings.activeDpiStage;
    settings.dpiStages.forEach((dpi, index) => {
      packet[4 + index * 2] = dpi & 0xff;
      packet[5 + index * 2] = (dpi >> 8) & 0xff;
    });
    packet[14] = DPI_STAGE_COUNT;
    return packet;
  }

  private pollingSettingsPacket(settings: M6Settings): Uint8Array {
    const packet = new Uint8Array(20);
    packet[0] = 0x41;
    packet[1] = settings.pollingIndex;
    packet[2] = settings.pollingIndex;
    packet[9] = settings.pollingTable.length;
    packet.set(settings.pollingTable.slice(0, 6), 3);
    return packet;
  }

  private async queryStatus(): Promise<Uint8Array> {
    const packet = new Uint8Array(PACKET_LENGTH);
    packet[0] = STATUS_COMMAND;
    return await this.query(COMMAND_REPORT_ID, COMMAND_RESPONSE_REPORT_ID, (bytes) => bytes[0] === STATUS_COMMAND, packet);
  }

  private async writeSettings(packet: Uint8Array): Promise<void> {
    await this.query(
      SETTINGS_REPORT_ID,
      SETTINGS_RESPONSE_REPORT_ID,
      (bytes) => bytes[0] === packet[0] || bytes[0] === 0xe4,
      packet,
    );
  }

  private async query(
    reportId: number,
    responseReportId: number,
    match: (bytes: Uint8Array) => boolean,
    packet: Uint8Array,
  ): Promise<Uint8Array> {
    if (this.responseWaiter) throw new Error("Another Keychron M6 request is already in progress.");
    let timeout = 0;
    let rejectResponse: ((reason: Error) => void) | null = null;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      rejectResponse = reject;
      timeout = window.setTimeout(() => {
        this.responseWaiter = null;
        reject(new Error(`The Keychron M6 did not answer command 0x${packet[0]?.toString(16)}.`));
      }, QUERY_TIMEOUT_MS);
      this.responseWaiter = {
        reportId: responseReportId,
        match,
        resolve: (bytes) => {
          window.clearTimeout(timeout);
          resolve(bytes);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      };
    });
    void response.catch(() => undefined);
    try {
      await this.device.sendReport(reportId, new Uint8Array(packet).buffer);
    } catch (error) {
      this.responseWaiter = null;
      const detail = error instanceof Error ? error.message : String(error);
      (rejectResponse as ((reason: Error) => void) | null)?.(
        new Error(`Chrome could not write Keychron M6 HID report. ${detail}`),
      );
    }
    return await response;
  }
}
