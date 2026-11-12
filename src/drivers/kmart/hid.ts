import type { MouseStatus } from "../mouse-types.ts";
import {
  KMART_COMMAND, KMART_DPI_STAGE_COUNT, KMART_PMW3325_DPI_VALUES, KMART_POLLING_RATES, KMART_PRODUCT_IDS,
  KMART_RECEIVER_PRODUCT_ID, KMART_REPORT_ID, KMART_SENSOR_PMW3325, KMART_USAGE, KMART_USAGE_PAGE,
  KMART_VENDOR_ID, kmartDecodeStatus, kmartDpiStagesData, kmartPayload, kmartPollingInterval, kmartRequest,
  type KmartStatus,
} from "@openmouse/protocol/kmart";

const PRODUCT_IDS = new Set<number>(KMART_PRODUCT_IDS);
/** The configurator waits 10 ms before reading a reply and 60 ms after a write. */
const READ_PAUSE_MS = 10;
const WRITE_PAUSE_MS = 60;
const STATUS_ATTEMPTS = 3;
/** The mouse keeps no readable copy of its DPI ladder, so the driver remembers the last one it wrote. */
const DEFAULT_STAGES = [400, 800, 1600, 2400, 3200, 6400];

function hasControlCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === KMART_USAGE_PAGE && collection.usage === KMART_USAGE
      && collection.featureReports.some((report) => report.reportId === KMART_REPORT_ID))
    || hasControlCollection(collection.children));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Feature-report client for the Kmart 43499755 wireless gaming mouse. */
export class KmartHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private stages: number[] = [...DEFAULT_STAGES];

  constructor(device: HIDDevice) { this.device = device; }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === KMART_VENDOR_ID
      && PRODUCT_IDS.has(device.productId)
      // Native adapters report no collections; WebHID must expose the vendor feature report.
      && (device.collections.length === 0 || hasControlCollection(device.collections));
  }

  get pollIntervalMs(): number { return 30_000; }

  getDpiOptions(): number[] { return [...KMART_PMW3325_DPI_VALUES]; }

  getSupportedPollingRates(): number[] { return [...KMART_POLLING_RATES]; }

  async open(): Promise<void> {
    if (!KmartHidClient.isSupported(this.device)) throw new Error("Kmart configuration collection is unavailable.");
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    await this.run(async () => { if (this.device.opened) await this.device.close(); });
  }
  async startNotifications(_onChange?: () => void): Promise<boolean> { return false; }

  async readStatus(): Promise<MouseStatus> {
    return this.run(async () => {
      const status = await this.queryStatus();
      // MouseStatus has no unknown polling rate, so fail rather than invent 125 Hz.
      if (status.pollingRateHz === null) throw new Error("Kmart reported an unrecognised polling interval.");
      const receiver = this.device.productId === KMART_RECEIVER_PRODUCT_ID;
      const stage = Math.min(status.activeStage, this.stages.length - 1);
      return {
        brand: "Kmart",
        name: "Kmart Wireless Gaming Mouse",
        batteryPercent: status.batteryPercent,
        batteryState: status.chargeState === 1 ? "Charging" : status.chargeState === 2 ? "Full" : "Discharging",
        dpi: this.stages[stage]!,
        pollingRateHz: status.pollingRateHz,
        supportedPollingRates: this.getSupportedPollingRates(),
        activeProfile: null,
        connectionType: receiver ? "Wireless" : "Wired",
        connectionDetail: receiver ? (status.linked ? "2.4 GHz receiver" : "2.4 GHz receiver (mouse asleep)") : "USB",
        liftOffDistance: null,
        firmware: [status.firmwareTag],
        ui: {
          family: "kmart",
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          hideSignalCard: true,
          hideSleepCard: true,
          defaultDisplayName: "Kmart Wireless Gaming Mouse",
        },
      };
    });
  }

  /** Sets the active stage's DPI, keeping the other stages the driver last wrote. */
  async setDpi(dpi: number): Promise<number> {
    if (!KMART_PMW3325_DPI_VALUES.includes(dpi)) throw new RangeError(`DPI ${dpi} is not supported by this mouse.`);
    return this.run(async () => {
      const status = await this.requireLinked();
      if (status.sensor !== KMART_SENSOR_PMW3325) {
        throw new Error(`Kmart sensor 0x${status.sensor.toString(16)} has no verified DPI table.`);
      }
      // Keep the device's own enabled-stage count instead of forcing all six on.
      const enabled = status.enabledStageCount >= 1 && status.enabledStageCount <= KMART_DPI_STAGE_COUNT
        ? status.enabledStageCount : KMART_DPI_STAGE_COUNT;
      const stage = Math.min(status.activeStage, enabled - 1);
      const stages = [...this.stages];
      stages[stage] = dpi;
      await this.write(KMART_COMMAND.dpiStages, kmartDpiStagesData(stages, stage, enabled));
      this.stages = stages;
      return dpi;
    });
  }

  async setPollingRate(rate: number): Promise<number> {
    const interval = kmartPollingInterval(rate);
    return this.run(async () => {
      await this.requireLinked();
      await this.write(KMART_COMMAND.pollingInterval, [interval]);
      const confirmed = (await this.queryStatus()).pollingRateHz;
      if (confirmed !== rate) throw new Error("Kmart polling-rate write did not persist.");
      return rate;
    });
  }

  private async requireLinked(): Promise<KmartStatus> {
    const status = await this.queryStatus();
    // The wired PID's link byte is unverified, so only the receiver is gated on it.
    if (this.device.productId === KMART_RECEIVER_PRODUCT_ID && !status.linked) throw new Error("The mouse is asleep. Move it, then try again.");
    return status;
  }

  private async queryStatus(): Promise<KmartStatus> {
    await this.open();
    for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt += 1) {
      const sequence = this.nextSequence();
      await this.device.sendFeatureReport(KMART_REPORT_ID, kmartRequest(KMART_COMMAND.status, sequence));
      await sleep(READ_PAUSE_MS);
      const payload = kmartPayload(await this.device.receiveFeatureReport(KMART_REPORT_ID));
      // A reply that does not echo our sequence byte belongs to an earlier request.
      if (payload[3] === sequence) return kmartDecodeStatus(payload);
    }
    throw new Error("Kmart status reply did not match the request.");
  }

  private async write(command: number, data: number[]): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(KMART_REPORT_ID, kmartRequest(command, this.nextSequence(), data, true));
    await sleep(WRITE_PAUSE_MS);
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) & 0xff;
    return this.sequence;
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
