import type { MouseStatus } from "../mouse-types.ts";
import {
  KSNAKE_PRODUCT_ID,
  KSNAKE_POLLING_RATES,
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
  ksnakeIsValidDpi,
  type KsnakeConfig,
} from "../../ksnake/index.js";
import { VENDOR_ID } from "../vendors.ts";

const REPLY_TIMEOUT_MS = 800;
/** Pause after a SET before reading back, so the mouse can commit to flash. */
const SETTLE_AFTER_WRITE_MS = 250;

/** Rejected when a command gets no inputreport within the timeout. Retried by writes. */
export class KsnakeTimeoutError extends Error {
  constructor() {
    super("The mouse did not answer — it may be asleep or out of range.");
    this.name = "KsnakeTimeoutError";
  }
}

export interface KsnakeClientOptions {
  replyTimeoutMs?: number;
  settleAfterWriteMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * K-snake X11 vendor HID control.
 *
 * Transport: output report 0 (64 bytes starting with 0x55); the reply
 * arrives as the next `inputreport`. A tiny queue serializes concurrent
 * calls like the vendor panel's commandQueueWrapper.
 *
 * Evidence: vendor panel at https://x1a11.yjx2012.com/, the X11 user manual
 * (6 factory DPI steps, 1000 Hz in 2.4G/wired, 125 Hz in BT, PAW3311), plus
 * retail-hardware verification — 2.4 GHz dongle (VID 0xA8A5, Vendor 0xFF01
 * interface, PARTIAL as expected since this protocol never uses feature
 * reports), FW 2.1.7, read/set/confirm round-trips for DPI and polling.
 */
export class KsnakeHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly replyTimeoutMs: number;
  private readonly settleAfterWriteMs: number;

  constructor(device: HIDDevice, options: KsnakeClientOptions = {}) {
    this.device = device;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.settleAfterWriteMs = options.settleAfterWriteMs ?? SETTLE_AFTER_WRITE_MS;
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
    return [...KSNAKE_POLLING_RATES];
  }

  getDpiOptions(): number[] {
    // PAW3311, vendor slider 200–12000. Defaults: 800/1200/1600/3200/5000/12000.
    const options: number[] = [];
    for (let dpi = 200; dpi <= 12000; dpi += 100) options.push(dpi);
    return options;
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
    const timeoutMs = this.replyTimeoutMs;
    return this.run(async () => {
      await this.open();
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.device.removeEventListener("inputreport", listener);
          reject(new KsnakeTimeoutError());
        }, timeoutMs);
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

  /** Same as exchange, but resends on timeout (a sleeping dongle often drops the first). Non-timeout errors throw immediately. SETs are idempotent full-config writes, so resending is safe. */
  private async exchangeRetrying(body: Uint8Array, attempts: number): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.exchange(body);
      } catch (error) {
        if (!(error instanceof KsnakeTimeoutError)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Best-effort config read for post-write confirmation; null when the mouse stays silent. */
  private async readBackConfig(attempts: number): Promise<KsnakeConfig | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const reply = await this.exchange(ksnakeGetConfigRequest()).catch(() => null);
      const config = reply ? ksnakeDecodeConfig(reply) : null;
      if (config) return config;
    }
    return null;
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
        dpiStageEditor: {
          maxStages: 6,
          countEditable: false,
          minDpi: 200,
          maxDpi: 12000,
          stepDpi: 100,
        },
      },
      batteryPercent: battery ? Math.min(battery.percent, 100) : null,
      batteryState: battery ? (battery.charging !== 0 ? "Charging" : "Discharging") : "Unknown",
      dpi,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: stages.length ? activeStage : undefined,
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
    if (!ksnakeIsValidDpi(dpi)) {
      throw new Error(`DPI must be a whole number between 200 and 12000 for the K-snake X11 (got ${dpi}).`);
    }
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    const stages = [...config.stages];
    const index = Math.min(Math.max(config.dpiIndex, 0), stages.length - 1);
    stages[index] = dpi;
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, stages }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    const got = confirmed?.stages[Math.min(Math.max(confirmed.dpiIndex, 0), confirmed.stages.length - 1)];
    if (got !== dpi) throw new Error(`The mouse kept ${got ?? "?"} DPI instead of ${dpi}.`);
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    if (!Number.isInteger(stage) || stage < 0 || stage >= config.stages.length) {
      throw new Error(`DPI stage must be between 1 and ${config.stages.length}.`);
    }
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, dpiIndex: stage }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    if (confirmed?.dpiIndex !== stage) {
      throw new Error(`The mouse kept DPI stage ${(confirmed?.dpiIndex ?? 0) + 1} instead of ${stage + 1}.`);
    }
    return stage;
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!ksnakeIsValidDpi(dpi)) {
      throw new Error(`DPI must be a whole number between 200 and 12000 for the K-snake X11 (got ${dpi}).`);
    }
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    if (!Number.isInteger(stage) || stage < 0 || stage >= config.stages.length) {
      throw new Error(`DPI stage must be between 1 and ${config.stages.length}.`);
    }
    const stages = [...config.stages];
    stages[stage] = dpi;
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, stages }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    if (confirmed?.stages[stage] !== dpi) {
      throw new Error(`The mouse kept ${confirmed?.stages[stage] ?? "?"} DPI instead of ${dpi}.`);
    }
    return dpi;
  }

  async setPollingRate(rate: number): Promise<number> {
    const index = ksnakeEncodePollingRate(rate);
    if (index === null) throw new Error(`This mouse does not support ${rate} Hz.`);
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, reportRate: index }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    const back = confirmed ? ksnakeDecodePollingRate(confirmed.reportRate) : null;
    if (back !== rate) throw new Error(`The mouse kept ${back ?? "?"} Hz instead of ${rate} Hz.`);
    return rate;
  }
}

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}
