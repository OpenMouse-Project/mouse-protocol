import type { MouseStatus } from "../mouse-types.ts";
import {
  AJAZZ_BUTTON_ACTIONS,
  AJAZZ_BUTTON_NAMES,
  AJAZZ_DEFAULT_KEYS,
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
  ajazzBindingLabel,
  ajazzDecodeBattery,
  ajazzDecodeConfig,
  ajazzDecodeKeys,
  ajazzDecodePollingRate,
  ajazzDecodeVersion,
  ajazzEncodePollingRate,
  ajazzEncodeSetConfig,
  ajazzEncodeSetKeys,
  ajazzFindButtonAction,
  ajazzApplyKeyDefaults,
  ajazzGetBatteryRequest,
  ajazzGetConfigRequest,
  ajazzGetKeysRequest,
  ajazzGetVersionRequest,
  ajazzIsValidDpi,
  ajazzIsValidSleepSeconds,
  ajazzKeysLookPlausible,
  type AjazzConfig,
  type AjazzKeyBinding,
} from "../../ajazz/index.ts";

const REPLY_TIMEOUT_MS = 800;
/** Pause after a SET before reading back, so the mouse can commit to flash. */
const SETTLE_AFTER_WRITE_MS = 250;
/** Outer bound for post-write read-back polling; slow commits get this long. */
const CONFIRM_TIMEOUT_MS = 2500;
/** Pause between read-back polls. */
const POLL_INTERVAL_MS = 250;
/** SET attempts before a write is reported as ignored (a lost frame is common). */
const WRITE_ATTEMPTS = 2;

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
  /** Outer bound for post-write read-back polling. */
  confirmTimeoutMs?: number;
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
 * Evidence: the vendor panel's JavaScript, plus ticket-0156 hardware replies
 * for config, battery and version (NJ07 MC, firmware 2.0.1) and a passing
 * flash write round-trip. The key-map path follows the same panel JS and
 * awaits a hardware confirmation, so every write still reads back and fails
 * loudly when the mouse kept something else.
 */
export class AjazzHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly replyTimeoutMs: number;
  private readonly settleAfterWriteMs: number;
  private readonly confirmTimeoutMs: number;
  /** Last config that decoded cleanly, so a failed poll does not blank the UI. */
  private lastGoodConfig: AjazzConfig | null = null;

  constructor(device: HIDDevice, options: AjazzClientOptions = {}) {
    this.device = device;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.settleAfterWriteMs = options.settleAfterWriteMs ?? SETTLE_AFTER_WRITE_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
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

  /**
   * Fire-and-forget write, mirroring the vendor panel: `setMouseConfigData()`
   * and `setMouseKeys()` never wait for an echo, they just queue the report.
   * The read-back below is the check, so a mouse that answers SET slowly (or
   * never) no longer stalls every setter for two full reply timeouts.
   */
  private sendOnly(request: Uint8Array): Promise<void> {
    const started = this.queue.then(async () => {
      await this.open();
      await this.device.sendReport(AJAZZ_REPORT_ID, request.slice());
    });
    this.queue = started.catch(() => undefined);
    return started;
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
    // Sequential on purpose: keys are the least critical read, and a failed
    // one must not blank the config the UI already shows.
    const keys = await this.getKeys().catch(() => null);
    const stages = config?.stages.slice(0, config.dpiCount) ?? [];
    const activeStage = config ? Math.min(config.dpiIndex, stages.length - 1) : 0;
    return {
      brand: "AJAZZ",
      name: `AJAZZ ${model}`,
      ui: {
        family: "ajazz",
        settingsReady: config !== null,
        valuesVerified: config !== null,
        // The readable key map belongs in the shared Buttons tab. Keep the
        // tab hidden when the dongle returns no plausible map.
        showAdvancedSection: keys !== null,
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
      sleepTimeout: config ? config.sleepMinutes * 60 : null,
      scrollDirection: config ? (config.scrollFlag === 1 ? "Reverse" : "Forward") : null,
      firmware: version ? [`${model} ${version}`] : [model],
      // Generic remap interface: the shared ButtonMappingCard renders these
      // with no brand-specific code. Opaque bindings (keyboard combos with
      // modifiers, macros) surface as "Custom (…)" and are preserved during a
      // different slot's write.
      buttonMappings: keys
        ? Object.fromEntries(
            AJAZZ_BUTTON_NAMES.map((name, index) => {
              const binding = keys[index];
              return [
                name,
                binding
                  ? ajazzBindingLabel(binding)
                    ?? `Custom (${binding.type},${binding.code1},${binding.code2},${binding.code3})`
                  : "Unknown",
              ] as const;
            }),
          )
        : undefined,
      buttonOptions: AJAZZ_BUTTON_ACTIONS.map((action) => action.label),
    };
  }

  /**
   * SET_CONFIG rewrites the whole block, so every setter reads the current
   * block, patches one field, writes it and reads it back. The write itself
   * is fire-and-forget like the vendor panel; the read-back is the check.
   *
   * A 2.4G link drops frames (the vendor panel's own comment notes the dongle
   * often ignores the first command), so a mismatch is retried once with a
   * fresh read of the block. That covers a lost SET, which otherwise looks
   * exactly like "the mouse ignored this setting" while another field changed
   * in an earlier frame that did land. A genuinely rejected value fails after
   * the second window instead of reporting success.
   */
  private async updateConfig(
    patch: Partial<AjazzConfig>,
    kept: (confirmed: AjazzConfig) => boolean,
    describe: (confirmed: AjazzConfig) => string,
    wanted: string,
  ): Promise<void> {
    let latest: AjazzConfig | null = null;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const current = await this.readConfig();
      if (!current) throw new Error("Could not read the current config from the mouse.");
      latest = current;
      await this.sendOnly(ajazzEncodeSetConfig({ ...current, ...patch }));
      const confirmed = await this.readBackConfigMatching(kept);
      if (confirmed) return;
    }
    const last = await this.readConfig(1);
    const seen = last ?? latest;
    throw new Error(`The mouse kept ${seen ? describe(seen) : "an unreadable config"} instead of ${wanted}.`);
  }

  /** Poll the config until `kept` passes, the deadline elapses, or reads go
   * silent three times running (a dead mouse answers nothing, so further
   * attempts only burn reply timeouts). Slow flash commits still get the
   * full window; silent mice fail fast. */
  private async readBackConfigMatching(kept: (confirmed: AjazzConfig) => boolean): Promise<AjazzConfig | null> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    let silent = 0;
    await sleep(this.settleAfterWriteMs);
    for (;;) {
      const reply = await this.exchange(ajazzGetConfigRequest()).catch(() => null);
      const config = reply ? ajazzDecodeConfig(reply) : null;
      if (config && configLooksValid(config)) {
        this.lastGoodConfig = config;
        if (kept(config)) return config;
        silent = 0;
      } else if (++silent >= 3) {
        return null;
      }
      if (Date.now() >= deadline) return null;
      await sleep(POLL_INTERVAL_MS);
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

  /**
   * Read the six-button map; null when the mouse answers nothing plausible.
   * Default-binding markers (type 0/0xff) come back as the factory defaults,
   * mirroring the vendor panel's merge.
   */
  async getKeys(): Promise<AjazzKeyBinding[] | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await this.exchange(ajazzGetKeysRequest()).catch(() => null);
      const keys = reply ? ajazzDecodeKeys(reply) : null;
      if (keys && ajazzKeysLookPlausible(keys)) return ajazzApplyKeyDefaults(keys);
    }
    return null;
  }

  /**
   * Read the map once without retries, for deadline-bounded write
   * confirmation (retries there would multiply timeouts past the deadline).
   */
  private async getKeysOnce(): Promise<AjazzKeyBinding[] | null> {
    const reply = await this.exchange(ajazzGetKeysRequest()).catch(() => null);
    const keys = reply ? ajazzDecodeKeys(reply) : null;
    return keys && ajazzKeysLookPlausible(keys) ? ajazzApplyKeyDefaults(keys) : null;
  }

  /**
   * Write all six key slots (SET_KEYS). The two fixed wheel entries are
   * always appended by the codec; opaque macro/combo slots are preserved
   * rather than guessed or rebuilt. Confirms by reading the map back, with
   * the same slow-flash tolerance as config writes.
   */
  async setKeys(keys: readonly AjazzKeyBinding[]): Promise<AjazzKeyBinding[]> {
    const slots = [...keys].slice(0, AJAZZ_DEFAULT_KEYS.length);
    if (slots.length !== AJAZZ_DEFAULT_KEYS.length) {
      throw new Error(`Exactly ${AJAZZ_DEFAULT_KEYS.length} key bindings are required (got ${keys.length}).`);
    }
    for (const [index, key] of slots.entries()) {
      const bytes = [key.type, key.code1, key.code2, key.code3];
      if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
        throw new Error(`Button ${index + 1}: binding bytes must be 0-255.`);
      }
    }
    // Read-back arrives default-substituted like getKeys(), so compare
    // against the same normalization (a marker written as-is reads back
    // as its factory binding).
    const wanted = ajazzApplyKeyDefaults(slots);
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      await this.sendOnly(ajazzEncodeSetKeys(slots));
      if (await this.keysMatch(wanted)) return slots;
    }
    const last = await this.getKeys();
    throw new Error(`The mouse did not keep the new button map (read back ${last ? JSON.stringify(last) : "no readable reply"}).`);
  }

  /** Poll the key map until it matches `wanted`, the deadline elapses, or
   * reads go silent three times running. */
  private async keysMatch(wanted: readonly AjazzKeyBinding[]): Promise<boolean> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    let silent = 0;
    await sleep(this.settleAfterWriteMs);
    for (;;) {
      const confirmed = await this.getKeysOnce();
      if (confirmed) {
        if (wanted.every((key, index) => equalBinding(confirmed[index], key))) return true;
        silent = 0;
      } else if (++silent >= 3) {
        return false;
      }
      if (Date.now() >= deadline) return false;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Remap one button by display label (generic `setButtonMapping` interface).
   * SET_KEYS always carries all six key slots, so the current map is
   * re-read and the single slot replaced — confirmed by setKeys' read-back.
   * Slot "Left" is locked: unbinding the primary button with no other
   * recovery path would brick basic use.
   */
  async setButtonMapping(button: string, actionLabel: string): Promise<void> {
    const index = (AJAZZ_BUTTON_NAMES as readonly string[]).indexOf(button);
    if (index < 0) throw new Error(`This mouse has no "${button}" button.`);
    if (index === 0) throw new Error("Left Click is fixed and cannot be reassigned.");
    const binding = ajazzFindButtonAction(actionLabel);
    if (!binding) throw new Error(`Unknown button action "${actionLabel}".`);
    const current = await this.getKeys();
    if (!current) throw new Error("Could not read the current button map from the mouse.");
    const slots = current.map((slot) => ({ ...slot }));
    slots[index] = binding;
    await this.setKeys(slots);
  }

  /** Restore the six factory bindings from every model's default profile. */
  async resetButtonMap(): Promise<void> {
    await this.setKeys(AJAZZ_DEFAULT_KEYS.map((key) => ({ ...key })));
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

function equalBinding(a: AjazzKeyBinding, b: AjazzKeyBinding): boolean {
  return a.type === b.type && a.code1 === b.code1 && a.code2 === b.code2 && a.code3 === b.code3;
}
