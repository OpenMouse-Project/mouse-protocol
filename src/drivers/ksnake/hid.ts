import type { MouseStatus } from "../mouse-types.ts";
import {
  KSNAKE_PRODUCT_ID,
  KSNAKE_REPORT_ID,
  KSNAKE_USAGE,
  KSNAKE_USAGE_PAGE,
  KSNAKE_USB_VENDOR_ID,
  ksnakeDecodeBattery,
  ksnakeDecodeConfig,
  ksnakeDecodePollingRate,
  ksnakeDecodeVersion,
  ksnakeEncodePollingRate,
  ksnakeEncodeSetConfig,
  ksnakeGetBatteryRequest,
  ksnakeGetConfigRequest,
  ksnakeGetVersionRequest,
} from "../../ksnake/index.js";
import { VENDOR_ID } from "../vendors.ts";

const REPLY_TIMEOUT_MS = 800;

/**
 * K-snake X11 vendor HID control (DRAFT — needs hardware verification).
 *
 * Transport: output report 0 (64 bytes starting with 0x55); the reply
 * arrives as the next `inputreport`. A tiny queue serializes concurrent
 * calls like the vendor panel's commandQueueWrapper.
 *
 * Evidence: vendor panel at https://x1a11.yjx2012.com/ plus a user HID
 * Diagnostic Report (VID 0xA8A5, Vendor 0xFF01 interface, PARTIAL — expected
 * since this protocol never uses feature reports).
 */
export class KsnakeHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.productId !== KSNAKE_PRODUCT_ID) return false;
    if (device.vendorId !== VENDOR_ID.ksnakeUsb && device.vendorId !== VENDOR_ID.ksnakeDongle) return false;
    const search = (list: readonly HIDCollectionInfo[]): boolean =>
      list.some(
        (c) => (c.usagePage === KSNAKE_USAGE_PAGE && c.usage === KSNAKE_USAGE) || search(c.children),
      );
    return search(device.collections);
  }

  get supportedPollingRates(): number[] {
    return [125, 250, 500, 1000, 2000, 4000, 8000];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return started;
  }

  private async exchange(body: Uint8Array): Promise<Uint8Array> {
    return this.run(async () => {
      await this.open();
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.device.removeEventListener("inputreport", listener);
          reject(new Error("The mouse did not answer — it may be asleep or out of range."));
        }, REPLY_TIMEOUT_MS);
        const listener = (event: HIDInputReportEvent): void => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
          resolve(copyDataView(event.data));
        };
        this.device.addEventListener("inputreport", listener);
        this.device.sendReport(KSNAKE_REPORT_ID, new Uint8Array(body.slice(0, 64)).buffer).catch((error: unknown) => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
          reject(error);
        });
      });
    });
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const [config, battery, version] = await Promise.all([
      this.exchange(ksnakeGetConfigRequest()).then((r) => ksnakeDecodeConfig(r)).catch(() => null),
      this.exchange(ksnakeGetBatteryRequest()).then((r) => ksnakeDecodeBattery(r)).catch(() => null),
      this.exchange(ksnakeGetVersionRequest()).then((r) => ksnakeDecodeVersion(r)).catch(() => null),
    ]);
    const stages = config?.stages ?? [];
    const activeStage = config ? Math.min(Math.max(config.dpiIndex, 0), Math.max(stages.length - 1, 0)) : 0;
    const dpi = stages[activeStage] ?? 1600;
    const pollingRateHz = config ? (ksnakeDecodePollingRate(config.reportRate) ?? 1000) : 1000;
    return {
      brand: "K-snake",
      name: this.device.productName || "K-snake X11",
      ui: {
        family: "ksnake",
        settingsReady: config !== null,
        hideLodLow: true,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        defaultDisplayName: this.device.productName || "K-snake X11",
      },
      batteryPercent: battery ? Math.min(battery.percent, 100) : null,
      batteryState: battery ? (battery.charging !== 0 ? "Charging" : "Discharging") : "Unknown",
      dpi,
      pollingRateHz,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      connectionType: this.device.vendorId === KSNAKE_USB_VENDOR_ID ? "Wired" : "Wireless",
      connectionDetail: this.device.vendorId === KSNAKE_USB_VENDOR_ID ? "Wired USB" : "2.4 GHz receiver",
      liftOffDistance: null,
      firmware: version ? [`X11 ${version}`] : ["K-snake X11"],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const raw = await this.exchange(ksnakeGetConfigRequest());
    const config = ksnakeDecodeConfig(raw);
    if (!config) throw new Error("Could not read the current config from the mouse.");
    const stages = [...config.stages];
    const index = Math.min(Math.max(config.dpiIndex, 0), stages.length - 1);
    stages[index] = dpi;
    await this.exchange(ksnakeEncodeSetConfig({ ...config, stages }));
    const confirmed = await this.exchange(ksnakeGetConfigRequest())
      .then((r) => ksnakeDecodeConfig(r))
      .catch(() => null);
    const got = confirmed?.stages[Math.min(Math.max(confirmed.dpiIndex, 0), confirmed.stages.length - 1)];
    if (got !== dpi) throw new Error(`The mouse kept ${got ?? "?"} DPI instead of ${dpi}.`);
    return dpi;
  }

  async setPollingRate(rate: number): Promise<number> {
    const index = ksnakeEncodePollingRate(rate);
    if (index === null) throw new Error(`This mouse does not support ${rate} Hz.`);
    const raw = await this.exchange(ksnakeGetConfigRequest());
    const config = ksnakeDecodeConfig(raw);
    if (!config) throw new Error("Could not read the current config from the mouse.");
    await this.exchange(ksnakeEncodeSetConfig({ ...config, reportRate: index }));
    const confirmed = await this.exchange(ksnakeGetConfigRequest())
      .then((r) => ksnakeDecodeConfig(r))
      .catch(() => null);
    const back = confirmed ? ksnakeDecodePollingRate(confirmed.reportRate) : null;
    if (back !== rate) throw new Error(`The mouse kept ${back ?? "?"} Hz instead of ${rate} Hz.`);
    return rate;
  }
}

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}
