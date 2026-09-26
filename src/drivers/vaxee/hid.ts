import type { MouseStatus } from "../mouse-types.ts";
import {
  VAXEE_COMMAND, VAXEE_MOUSE_NAMES, VAXEE_PRODUCT_IDS, VAXEE_RECEIVER_IDS,
  VAXEE_REPORT_ID, VAXEE_USAGE, VAXEE_USAGE_PAGE, VAXEE_VENDOR_ID,
  vaxeeDpi, vaxeePollingCode, vaxeePollingRate, vaxeeReply, vaxeeRequest,
} from "@openmouse/protocol/vaxee";

const PRODUCT_IDS = new Set<number>(VAXEE_PRODUCT_IDS);
const PAUSE_MS = 100; // Vendor panel waits 100 ms between send and receive.

function hasControlCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === VAXEE_USAGE_PAGE && collection.usage === VAXEE_USAGE
      && collection.featureReports.some((report) => report.reportId === VAXEE_REPORT_ID))
    || hasControlCollection(collection.children));
}

/** Feature-report client for the VAXEE Control Center protocol. */
export class VaxeeHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) { this.device = device; }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === VAXEE_VENDOR_ID
      && PRODUCT_IDS.has(device.productId)
      && hasControlCollection(device.collections);
  }

  get pollIntervalMs(): number { return 30_000; }

  getDpiOptions(): number[] {
    // The Control Center uses one-DPI steps on the 3954 generation, but the
    // current model may be behind a receiver. A 50-DPI grid is common to both.
    return Array.from({ length: 519 }, (_, index) => 100 + index * 50);
  }

  getSupportedPollingRates(): number[] {
    return [0x1002, 0x2001, 0x2002].includes(this.device.productId)
      ? [500, 1000, 2000, 4000]
      : [500, 1000];
  }

  async open(): Promise<void> {
    if (!VaxeeHidClient.isSupported(this.device)) throw new Error("VAXEE configuration collection is unavailable.");
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> { if (this.device.opened) await this.device.close(); }
  async startNotifications(_onChange?: () => void): Promise<boolean> { return false; }

  async readStatus(): Promise<MouseStatus> {
    return this.run(async () => {
      const receiver = VAXEE_RECEIVER_IDS.has(this.device.productId);
      const modelReply = await this.exchange(VAXEE_COMMAND.mousePid, 2, [], 2);
      const mousePid = modelReply[5]! | (modelReply[6]! << 8);
      const stage = (await this.exchange(VAXEE_COMMAND.dpiStage, 1, [], 1))[5]!;
      if (stage < 1 || stage > 4) throw new Error(`Invalid VAXEE DPI stage ${stage}.`);
      const dpi = vaxeeDpi(await this.exchange(VAXEE_COMMAND.dpiValue, 3, [stage], 3));
      const pollingRateHz = vaxeePollingRate((await this.exchange(VAXEE_COMMAND.polling, 1, [], 1))[5]!);
      const lodCode = (await this.exchange(VAXEE_COMMAND.lod, 1, [], 1))[5]!;
      if (lodCode !== 1 && lodCode !== 2) throw new Error(`Invalid VAXEE LOD code ${lodCode}.`);
      const batterySteps = (await this.exchange(VAXEE_COMMAND.battery, 1, [], 1))[5]!;
      const charging = (await this.exchange(VAXEE_COMMAND.charging, 1, [], 1))[5]!;
      const firmware = await this.exchange(VAXEE_COMMAND.firmware, 2, [], 2);
      const firmwareString = (firmware[5]! | (firmware[6]! << 8)).toString(16);
      return {
        brand: "VAXEE",
        name: VAXEE_MOUSE_NAMES[mousePid] ? `VAXEE ${VAXEE_MOUSE_NAMES[mousePid]}` : this.device.productName || "VAXEE mouse",
        batteryPercent: batterySteps <= 20 ? batterySteps * 5 : null,
        batteryState: charging ? "Charging" : "Discharging",
        dpi,
        pollingRateHz,
        supportedPollingRates: this.getSupportedPollingRates(),
        activeProfile: null,
        connectionType: receiver ? "Wireless" : "Wired",
        connectionDetail: receiver ? "2.4 GHz receiver" : "USB",
        liftOffDistance: lodCode === 1 ? "Low" : "High",
        supportedLiftOffDistances: ["Low", "High"],
        firmware: [firmwareString],
        ui: {
          family: "vaxee",
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          hideSignalCard: true,
          hideSleepCard: true,
          defaultDisplayName: "VAXEE mouse",
        },
      };
    });
  }

  async setDpi(dpi: number): Promise<number> {
    if (!Number.isInteger(dpi) || dpi < 100 || dpi > 26000 || dpi % 50 !== 0) {
      throw new RangeError("VAXEE DPI must be 100–26,000 in steps of 50.");
    }
    return this.run(async () => {
      const stage = (await this.exchange(VAXEE_COMMAND.dpiStage, 1, [], 1))[5]!;
      if (stage < 1 || stage > 4) throw new Error(`Invalid VAXEE DPI stage ${stage}.`);
      await this.exchange(VAXEE_COMMAND.dpiValue, 3, [stage, dpi & 255, dpi >> 8], 1, true);
      const confirmed = vaxeeDpi(await this.exchange(VAXEE_COMMAND.dpiValue, 3, [stage], 3));
      if (confirmed !== dpi) throw new Error("VAXEE DPI write did not persist.");
      return confirmed;
    });
  }

  async setPollingRate(rate: number): Promise<number> {
    if (!this.getSupportedPollingRates().includes(rate)) throw new RangeError("Unsupported polling rate for this VAXEE connection.");
    return this.run(async () => {
      if (rate > 1000) {
        const newer = this.device.productId === 0x2002;
        const tracking = (await this.exchange(VAXEE_COMMAND.tracking, newer ? 2 : 1, [], 1))[5]!;
        if (newer ? tracking > 1 : tracking < 1 || tracking > 4) {
          throw new Error(`Unknown VAXEE tracking mode ${tracking}.`);
        }
        const standard = newer ? tracking === 0 : tracking === 2 || tracking === 4;
        if (standard) throw new Error("VAXEE standard mode is limited to 1,000 Hz.");
      }
      await this.exchange(VAXEE_COMMAND.polling, 1, [vaxeePollingCode(rate)], 1, true);
      const confirmed = vaxeePollingRate((await this.exchange(VAXEE_COMMAND.polling, 1, [], 1))[5]!);
      if (confirmed !== rate) throw new Error("VAXEE polling-rate write did not persist.");
      return confirmed;
    });
  }

  async setLiftOffDistance(value: "Low" | "Medium" | "High"): Promise<"Low" | "High"> {
    if (value !== "Low" && value !== "High") throw new RangeError("VAXEE supports Low or High LOD.");
    return this.run(async () => {
      const code = value === "Low" ? 1 : 2;
      await this.exchange(VAXEE_COMMAND.lod, 1, [code], 1, true);
      const confirmed = (await this.exchange(VAXEE_COMMAND.lod, 1, [], 1))[5]!;
      if (confirmed !== code) throw new Error("VAXEE LOD write did not persist.");
      return value;
    });
  }

  private async exchange(command: number, length: number, values: number[], responseLength: number, write = false): Promise<Uint8Array> {
    await this.open();
    await this.device.sendFeatureReport(VAXEE_REPORT_ID, new Uint8Array(vaxeeRequest(command, length, values, write)).buffer);
    await new Promise<void>((resolve) => setTimeout(resolve, PAUSE_MS));
    return vaxeeReply(await this.device.receiveFeatureReport(VAXEE_REPORT_ID), command, responseLength);
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
