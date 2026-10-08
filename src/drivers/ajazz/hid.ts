import type { MouseStatus } from "../mouse-types.ts";
import {
  AJAZZ_DONGLE_VENDOR_ID,
  AJAZZ_OFFERED_POLLING_RATES,
  AJAZZ_PRODUCTS,
  AJAZZ_REPORT_ID,
  AJAZZ_SLEEP_OPTIONS,
  AJAZZ_USAGE,
  AJAZZ_USAGE_PAGE,
  AJAZZ_USB_VENDOR_ID,
  AJAZZ_DPI_MIN,
  AJAZZ_DPI_STEP,
  AJAZZ_DPI_STAGES,
  ajazzDecodeBattery,
  ajazzDecodeConfig,
  ajazzDecodePollingRate,
  ajazzDecodeVersion,
  ajazzEncodePollingRate,
  ajazzEncodeSetConfig,
  ajazzGetBatteryRequest,
  ajazzGetConfigRequest,
  ajazzGetVersionRequest,
  ajazzIsValidDpi,
  ajazzIsValidSleepSeconds,
  type AjazzConfig,
} from "../../ajazz/index.ts";

const REPLY_TIMEOUT_MS = 800;
/** Pause after a SET before reading back, so the mouse can commit to flash. */
const SETTLE_AFTER_WRITE_MS = 250;

/** Rejected when a command gets no matching input report within the timeout. */
export class AjazzTimeoutError extends Error {
  constructor() {
    super("The mouse did not answer. It may be asleep or out of range.");
    this.name = "AjazzTimeoutError";
  }
}

export interface AjazzClientOptions {
  replyTimeoutMs?: number;
  settleAfterWriteMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

/**
 * AJAZZ NJ07 / NJ08 vendor HID control (see `@openmouse/protocol/ajazz`).
 *
 * Transport: output report 0xF0 (63 bytes); the answer is the next input
 * report that echoes the command byte. The mouse also pushes DPI, battery and
 * status reports unprompted, so replies are matched by command rather than by
 * arrival order. A tiny queue serializes calls like the vendor panel does.
 *
 * Evidence: the vendor panel's JavaScript only. Nothing here has been run
 * against hardware, so every write reads the config back and fails loudly
 * when the mouse kept something else.
 */
export class AjazzHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly replyTimeoutMs: number;
  private readonly settleAfterWriteMs: number;
  /** Last config that decoded cleanly, so a failed poll does not blank the UI. */
  private lastGoodConfig: AjazzConfig | null = null;

  constructor(device: HIDDevice, options: AjazzClientOptions = {}) {
    this.device = device;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.settleAfterWriteMs = options.settleAfterWriteMs ?? SETTLE_AFTER_WRITE_MS;
  }

  static isSupported(device: HIDDevice): boolean {
    if (!AJAZZ_PRODUCTS.has(device.productId)) return false;
    if (device.vendorId !== AJAZZ_USB_VENDOR_ID && device.vendorId !== AJAZZ_DONGLE_VENDOR_ID) return false;
    const search = (list: readonly HIDCollectionInfo[]): boolean =>
      list.some((c) => (c.usagePage === AJAZZ_USAGE_PAGE && c.usage === AJAZZ_USAGE) || search(c.children));
    return search(device.collections);
  }

  private get product() {
    return AJAZZ_PRODUCTS.get(this.device.productId);
  }

  get supportedPollingRates(): number[] {
    return [...AJAZZ_OFFERED_POLLING_RATES];
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = AJAZZ_DPI_MIN; dpi <= (this.product?.maxDpi ?? 0); dpi += AJAZZ_DPI_STEP) options.push(dpi);
    return options;
  }

  getSleepOptions(): number[] {
    return [...AJAZZ_SLEEP_OPTIONS];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /** Send one command and resolve with the input report that echoes it. */
  private exchange(request: Uint8Array): Promise<Uint8Array> {
    const command = request[0];
    const started = this.queue.then(async () => {
      await this.open();
      return new Promise<Uint8Array>((resolve, reject) => {
        const done = (): void => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
        };
        const timer = setTimeout(() => {
          done();
          reject(new AjazzTimeoutError());
        }, this.replyTimeoutMs);
        const listener = (event: HIDInputReportEvent): void => {
          const data = copyDataView(event.data);
          if (data[0] !== command) return;
          done();
          resolve(data);
        };
        this.device.addEventListener("inputreport", listener);
        this.device.sendReport(AJAZZ_REPORT_ID, request.slice()).catch((error: unknown) => {
          done();
          reject(error);
        });
      });
    });
    this.queue = started.catch(() => undefined);
    return started;
  }

  /** Retry on timeout only; a sleeping dongle often drops the first command. */
  private async exchangeRetrying(request: Uint8Array, attempts: number): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.exchange(request);
      } catch (error) {
        if (!(error instanceof AjazzTimeoutError)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private async readConfig(attempts = 3): Promise<AjazzConfig | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const reply = await this.exchange(ajazzGetConfigRequest()).catch(() => null);
      const config = reply ? ajazzDecodeConfig(reply) : null;
      if (config && configLooksValid(config)) return (this.lastGoodConfig = config);
    }
    return null;
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const product = this.product;
    const model = product?.model ?? "NJ07";
    const wired = this.device.vendorId === AJAZZ_USB_VENDOR_ID;
    const config = (await this.readConfig(2)) ?? this.lastGoodConfig;
    const battery = await this.exchange(ajazzGetBatteryRequest()).then(ajazzDecodeBattery, () => null);
    const version = await this.exchange(ajazzGetVersionRequest()).then(ajazzDecodeVersion, () => null);
    const stages = config?.stages.slice(0, config.dpiCount) ?? [];
    const activeStage = config ? Math.min(config.dpiIndex, stages.length - 1) : 0;
    return {
      brand: "AJAZZ",
      name: `AJAZZ ${model}`,
      ui: {
        family: "ajazz",
        settingsReady: config !== null,
        valuesVerified: config !== null,
        showAdvancedSection: true,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        hideSignalCard: true,
        defaultDisplayName: `AJAZZ ${model}`,
        dpiStageEditor: {
          maxStages: AJAZZ_DPI_STAGES,
          countEditable: false,
          minDpi: AJAZZ_DPI_MIN,
          maxDpi: product?.maxDpi ?? 12800,
          stepDpi: AJAZZ_DPI_STEP,
        },
      },
      batteryPercent: battery ? Math.min(battery.percent, 100) : null,
      batteryState: battery ? (battery.charging ? "Charging" : "Discharging") : "Unknown",
      dpi: config ? stages[activeStage] : 0,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: stages.length ? activeStage : undefined,
      pollingRateHz: config ? (ajazzDecodePollingRate(config.reportRate) ?? 0) : 0,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      liftOffDistance: null,
      connectionType: wired ? "Wired" : "Wireless",
      connectionDetail: wired ? "Wired USB" : "2.4 GHz receiver",
      sleepTimeout: config && config.sleepMinutes > 0 ? config.sleepMinutes * 60 : null,
      scrollDirection: config ? (config.scrollFlag === 1 ? "Reverse" : "Forward") : null,
      firmware: version ? [`${model} ${version}`] : [model],
    };
  }

  /**
   * SET_CONFIG rewrites the whole block, so every setter reads the current
   * block, patches one field, writes it and reads it back. The panel tolerates
   * a silent SET (it only waits 500 ms for an echo), so a missing echo is not
   * an error here either; the read-back is the check.
   */
  private async updateConfig(
    patch: Partial<AjazzConfig>,
    kept: (confirmed: AjazzConfig) => boolean,
    describe: (confirmed: AjazzConfig) => string,
    wanted: string,
  ): Promise<void> {
    const current = await this.readConfig();
    if (!current) throw new Error("Could not read the current config from the mouse.");
    await this.exchangeRetrying(ajazzEncodeSetConfig({ ...current, ...patch }), 2).catch((error: unknown) => {
      if (!(error instanceof AjazzTimeoutError)) throw error;
    });
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readConfig();
    if (!confirmed || !kept(confirmed)) {
      throw new Error(`The mouse kept ${confirmed ? describe(confirmed) : "an unreadable config"} instead of ${wanted}.`);
    }
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const maxDpi = this.product?.maxDpi ?? 12800;
    if (!ajazzIsValidDpi(dpi, maxDpi)) {
      throw new Error(`DPI must be a whole number between ${AJAZZ_DPI_MIN} and ${maxDpi} (got ${dpi}).`);
    }
    const current = await this.readConfig();
    if (!current) throw new Error("Could not read the current config from the mouse.");
    if (!Number.isInteger(stage) || stage < 0 || stage >= current.dpiCount) {
      throw new Error(`DPI stage must be between 1 and ${current.dpiCount}.`);
    }
    const stages = [...current.stages];
    stages[stage] = dpi;
    await this.updateConfig(
      { stages },
      (c) => c.stages[stage] === dpi,
      (c) => `${c.stages[stage]} DPI`,
      `${dpi} DPI`,
    );
    return dpi;
  }

  async setDpi(dpi: number): Promise<number> {
    const current = await this.readConfig();
    if (!current) throw new Error("Could not read the current config from the mouse.");
    return this.setDpiStageValue(current.dpiIndex, dpi);
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const current = await this.readConfig();
    if (!current) throw new Error("Could not read the current config from the mouse.");
    if (!Number.isInteger(stage) || stage < 0 || stage >= current.dpiCount) {
      throw new Error(`DPI stage must be between 1 and ${current.dpiCount}.`);
    }
    await this.updateConfig(
      { dpiIndex: stage },
      (c) => c.dpiIndex === stage,
      (c) => `DPI stage ${c.dpiIndex + 1}`,
      `DPI stage ${stage + 1}`,
    );
    return stage;
  }

  async setPollingRate(rate: number): Promise<number> {
    const index = (AJAZZ_OFFERED_POLLING_RATES as readonly number[]).includes(rate)
      ? ajazzEncodePollingRate(rate)
      : null;
    if (index === null) {
      throw new Error(`This mouse does not support ${rate} Hz.`);
    }
    await this.updateConfig(
      { reportRate: index },
      (c) => c.reportRate === index,
      (c) => `${ajazzDecodePollingRate(c.reportRate) ?? "?"} Hz`,
      `${rate} Hz`,
    );
    return rate;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!ajazzIsValidSleepSeconds(seconds)) {
      throw new Error(`This mouse does not support a ${seconds}-second sleep timeout.`);
    }
    const minutes = seconds / 60;
    await this.updateConfig(
      { sleepMinutes: minutes },
      (c) => c.sleepMinutes === minutes,
      (c) => `a ${c.sleepMinutes}-minute sleep timeout`,
      `${minutes} minutes`,
    );
    return seconds;
  }

  async setScrollDirection(
    direction: NonNullable<MouseStatus["scrollDirection"]>,
  ): Promise<NonNullable<MouseStatus["scrollDirection"]>> {
    if (direction !== "Forward" && direction !== "Reverse") {
      throw new Error(`Scroll direction must be Forward or Reverse (got ${direction}).`);
    }
    const scrollFlag = direction === "Reverse" ? 1 : 0;
    await this.updateConfig(
      { scrollFlag },
      (c) => c.scrollFlag === scrollFlag,
      (c) => `${c.scrollFlag === 1 ? "Reverse" : "Forward"} scroll direction`,
      direction,
    );
    return direction;
  }
}

/** Rejects a decode that cannot be a real block, such as a crossed or half-filled report. */
function configLooksValid(config: AjazzConfig): boolean {
  return (
    ajazzDecodePollingRate(config.reportRate) !== null &&
    config.dpiCount >= 1 &&
    config.dpiCount <= AJAZZ_DPI_STAGES &&
    config.dpiIndex < config.dpiCount
  );
}
