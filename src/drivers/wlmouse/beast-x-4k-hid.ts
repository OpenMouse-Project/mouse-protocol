import type { MouseStatus } from "../mouse-types.ts";
import {
  WLMOUSE_4K_CHUNK_LENGTH as CHUNK_LENGTH,
  WLMOUSE_4K_COMMAND as COMMAND,
  WLMOUSE_4K_POLLING_RATES as POLLING_RATES,
  WLMOUSE_4K_PRODUCT_ID as PRODUCT_ID,
  WLMOUSE_4K_REPORT_ID as REPORT_ID,
  WLMOUSE_4K_SETTINGS as AT,
  WLMOUSE_4K_SETTINGS_LENGTH as SETTINGS_LENGTH,
  WLMOUSE_4K_STAGE_LENGTH as STAGE_LENGTH,
  WLMOUSE_4K_STAGE_SLOTS as STAGE_SLOTS,
  WLMOUSE_4K_STATUS_ERRORS as STATUS_ERRORS,
  WLMOUSE_VENDOR_ID,
  wlmouse4kDecodeReply,
  wlmouse4kDecodeSettings,
  wlmouse4kEncodeRequest,
  type Wlmouse4kReply,
  type Wlmouse4kSettings,
} from "@openmouse/protocol/wlmouse";

const QUERY_TIMEOUT_MS = 1000;
const DPI_MIN = 50;
const DPI_MAX = 26_000;
const DPI_STEP = 50;
/** The vendor software's three sleep choices. */
const SLEEP_SECONDS = [30, 60, 300] as const;
const DEBOUNCE_MAX_MS = 12;
/** The firmware cannot run High Mode at 2K/4K; the vendor software drops it there. */
const HIGH_MODE_MAX_HZ = 1000;
const PROFILE_MAX = 7;

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;
const LIFT_OFF_BY_MM: Readonly<Record<number, LiftOff>> = { 1: "Medium", 2: "High" };

/**
 * WLmouse Beast X 4K over its report-4 settings channel (see
 * `@openmouse/protocol/wlmouse` beast-x-4k.ts for the framing and layout).
 * Every change is a read-modify-write of the active profile's settings block:
 * only the 24-byte chunks that changed are written, inside the open/close
 * session the vendor software uses, then the block is read back to confirm.
 */
export class WLMouseBeastX4kHidClient {
  readonly device: HIDDevice;
  readonly canDisableSleep = false;
  private listening = false;
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: {
    command: number;
    address: number;
    resolve: (reply: Wlmouse4kReply) => void;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== REPORT_ID || !this.waiter) return;
    const reply = wlmouse4kDecodeReply(new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    ));
    if (!reply || reply.command !== this.waiter.command || reply.address !== this.waiter.address) return;
    this.waiter.resolve(reply);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === WLMOUSE_VENDOR_ID
      && device.productId === PRODUCT_ID
      && device.collections.some((collection) =>
        collection.outputReports.some((report) => report.reportId === REPORT_ID)
        && collection.inputReports.some((report) => report.reportId === REPORT_ID));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
  }

  async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    return Array.from({ length: (DPI_MAX - DPI_MIN) / DPI_STEP + 1 }, (_, index) => DPI_MIN + index * DPI_STEP);
  }

  getSleepOptions(): number[] {
    return [...SLEEP_SECONDS];
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  async readStatus(): Promise<MouseStatus> {
    const settings = wlmouse4kDecodeSettings((await this.readBlock()).block);
    const dpiStages = settings.stageDpis.slice(0, settings.stageCount);
    return {
      brand: "WLMouse",
      name: "WLmouse Beast X 4K",
      ui: {
        family: "wlmouse-4k",
        hideUnsupportedPollingRates: true,
        hideAngleSnapping: true,
        hideRippleControl: true,
        statusNote: "Lift-off: Medium is 1 mm, High is 2 mm.",
        dpiStageEditor: {
          maxStages: STAGE_SLOTS,
          countEditable: true,
          minDpi: DPI_MIN,
          maxDpi: DPI_MAX,
          stepDpi: DPI_STEP,
        },
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: dpiStages[settings.activeStage] ?? dpiStages[0]!,
      dpiStages,
      activeDpiStage: settings.activeStage,
      pollingRateHz: settings.pollingRateHz ?? 1000,
      supportedPollingRates: [...POLLING_RATES],
      activeProfile: null,
      liftOffDistance: LIFT_OFF_BY_MM[settings.liftOffMm] ?? null,
      supportedLiftOffDistances: ["Medium", "High"],
      motionSync: settings.motionSync,
      hyperMode: settings.highMode,
      debounceMs: settings.debounceMs,
      sleepTimeout: settings.sleepSeconds || null,
      firmware: [],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const { activeStage } = wlmouse4kDecodeSettings((await this.readBlock()).block);
    return await this.setDpiStageValue(activeStage, dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
      throw new Error(`Beast X 4K DPI must be a multiple of ${DPI_STEP} between ${DPI_MIN} and ${DPI_MAX}.`);
    }
    this.requireSlot(stage);
    // Only X, as the vendor software does: Y is used when the slot's separate-axes flag is set.
    const x = AT.stages + stage * STAGE_LENGTH + 2;
    const confirmed = (await this.update((block) => {
      block[x] = dpi & 0xff;
      block[x + 1] = dpi >> 8;
    })).stageDpis[stage];
    if (confirmed !== dpi) throw new Error(`The Beast X 4K kept ${confirmed} DPI on stage ${stage + 1} instead of ${dpi}.`);
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    this.requireSlot(stage);
    return await this.set("activeStage", stage, "its active DPI stage", (block) => {
      if (stage >= block[AT.stageCount]!) throw new Error(`The Beast X 4K only cycles ${block[AT.stageCount]} DPI stages.`);
      block[AT.activeStage] = stage;
    });
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > STAGE_SLOTS) {
      throw new Error(`The Beast X 4K holds between 1 and ${STAGE_SLOTS} DPI stages.`);
    }
    return await this.set("stageCount", count, "its DPI stage count", (block) => {
      block[AT.stageCount] = count;
      if (block[AT.activeStage]! >= count) block[AT.activeStage] = count - 1;
    });
  }

  async setPollingRate(rateHz: number): Promise<number> {
    const index = POLLING_RATES.indexOf(rateHz as (typeof POLLING_RATES)[number]);
    if (index < 0) throw new Error(`The Beast X 4K does not support ${rateHz} Hz.`);
    await this.set("pollingRateHz", rateHz, "its polling rate", (block) => {
      block[AT.pollingIndex] = index;
      if (rateHz > HIGH_MODE_MAX_HZ) block[AT.highMode] = 0;
    });
    return rateHz;
  }

  async setLiftOffDistance(lod: LiftOff): Promise<LiftOff> {
    const mm = lod === "Medium" ? 1 : lod === "High" ? 2 : null;
    if (mm === null) throw new Error(`The Beast X 4K has no ${lod.toLowerCase()} lift-off distance.`);
    await this.set("liftOffMm", mm, "its lift-off distance", (block) => { block[AT.liftOff] = mm - 1; });
    return lod;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return await this.set("motionSync", enabled, "Motion Sync", (block) => { block[AT.motionSync] = enabled ? 1 : 0; });
  }

  /** The vendor software's High Mode, OpenMouse's high-speed toggle. */
  async setHyperMode(enabled: boolean): Promise<boolean> {
    if (enabled) {
      const { pollingRateHz } = wlmouse4kDecodeSettings((await this.readBlock()).block);
      if ((pollingRateHz ?? 0) > HIGH_MODE_MAX_HZ) {
        throw new Error("High-speed mode cannot run at 2000 Hz or 4000 Hz. Lower the polling rate first.");
      }
    }
    return await this.set("highMode", enabled, "high-speed mode", (block) => { block[AT.highMode] = enabled ? 1 : 0; });
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > DEBOUNCE_MAX_MS) {
      throw new Error(`Beast X 4K debounce must be between 0 and ${DEBOUNCE_MAX_MS} ms.`);
    }
    return await this.set("debounceMs", debounceMs, "its debounce", (block) => { block[AT.debounceMs] = debounceMs; });
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!SLEEP_SECONDS.includes(seconds as (typeof SLEEP_SECONDS)[number])) {
      throw new Error(`Beast X 4K sleep must be one of ${SLEEP_SECONDS.join(", ")} seconds.`);
    }
    return await this.set("sleepSeconds", seconds, "its sleep timeout", (block) => {
      block[AT.sleepSeconds] = seconds & 0xff;
      block[AT.sleepSeconds + 1] = seconds >> 8;
    });
  }

  private requireSlot(stage: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= STAGE_SLOTS) {
      throw new Error(`DPI stage must be between 1 and ${STAGE_SLOTS}.`);
    }
  }

  private async set<K extends keyof Wlmouse4kSettings>(
    field: K,
    value: Wlmouse4kSettings[K],
    label: string,
    edit: (block: Uint8Array) => void,
  ): Promise<Wlmouse4kSettings[K]> {
    const confirmed = (await this.update(edit))[field];
    if (confirmed !== value) throw new Error(`The Beast X 4K kept ${label} at ${confirmed} instead of ${value}.`);
    return confirmed;
  }

  private async update(edit: (block: Uint8Array) => void): Promise<Wlmouse4kSettings> {
    const { base, block } = await this.readBlock();
    const next = block.slice();
    edit(next);
    await this.request(COMMAND.openSession);
    try {
      for (let offset = 0; offset < SETTINGS_LENGTH; offset += CHUNK_LENGTH) {
        const chunk = next.subarray(offset, offset + CHUNK_LENGTH);
        if (chunk.every((byte, index) => byte === block[offset + index])) continue;
        await this.request(COMMAND.writeSettings, base + offset, chunk);
      }
    } finally {
      // A close that fails still leaves the read-back below to catch an unsaved write.
      await this.request(COMMAND.closeSession).catch(() => undefined);
    }
    return wlmouse4kDecodeSettings((await this.readBlock()).block);
  }

  /** The active profile number sits at address 0; its block starts at `profile << 7`. */
  private async readBlock(): Promise<{ base: number; block: Uint8Array }> {
    const profile = (await this.request(COMMAND.readSettings, 0, [], 1)).data[0] ?? 0;
    if (profile > PROFILE_MAX) throw new Error(`The Beast X 4K reported an unknown profile ${profile}.`);
    const base = profile << 7;
    const block = new Uint8Array(SETTINGS_LENGTH);
    for (let offset = 0; offset < SETTINGS_LENGTH; offset += CHUNK_LENGTH) {
      const length = Math.min(CHUNK_LENGTH, SETTINGS_LENGTH - offset);
      const reply = await this.request(COMMAND.readSettings, base + offset, [], length);
      if (reply.data.length < length) throw new Error("The Beast X 4K returned a short settings read.");
      block.set(reply.data, offset);
    }
    return { base, block };
  }

  private request(command: number, address = 0, data: ArrayLike<number> = [], length = data.length): Promise<Wlmouse4kReply> {
    const run = this.queue.then(() => this.exchange(command, address, data, length));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exchange(command: number, address: number, data: ArrayLike<number>, length: number): Promise<Wlmouse4kReply> {
    await this.open();
    const hex = `0x${command.toString(16).padStart(2, "0")}`;
    let timer = 0;
    const reply = new Promise<Wlmouse4kReply>((resolve, reject) => {
      timer = window.setTimeout(() => reject(new Error(`The Beast X 4K did not answer command ${hex}.`)), QUERY_TIMEOUT_MS);
      this.waiter = { command, address, resolve };
    });
    void reply.catch(() => undefined);
    try {
      await this.device.sendReport(REPORT_ID, wlmouse4kEncodeRequest(command, address, data, length));
      const answer = await reply;
      if (STATUS_ERRORS.has(answer.status)) {
        throw new Error(`The Beast X 4K rejected command ${hex} (status 0x${answer.status.toString(16)}).`);
      }
      return answer;
    } finally {
      window.clearTimeout(timer);
      this.waiter = null;
    }
  }
}
