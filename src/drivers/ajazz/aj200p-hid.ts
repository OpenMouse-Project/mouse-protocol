import type { MouseLighting, MouseStatus } from "../mouse-types.js";
import {
  AJ200P_ACTIONS,
  AJ200P_BUTTON_NAMES,
  AJ200P_BUTTON_SLOTS,
  AJ200P_COMMAND,
  AJ200P_OUTPUT_REPORT_ID,
  AJ200P_PRODUCTS,
  AJ200P_SLEEP_SECONDS,
  AJ200P_USAGE,
  AJ200P_USAGE_PAGE,
  AJ200P_VENDOR_ID,
  aj200pBindingLabel,
  aj200pColorBytes,
  aj200pDecodeDpi,
  aj200pDecodeInfo,
  aj200pDecodeKeys,
  aj200pDecodeReply,
  aj200pDecodeSettings,
  aj200pDecodeRate,
  aj200pEncode,
  aj200pEncodeRate,
  aj200pFindAction,
  aj200pInteger,
  aj200pPatchDpi,
  aj200pSettingsLength,
  type Aj200pCommand,
  type Aj200pSettings,
} from "../../ajazz/aj200p.js";

export interface AjazzAj200pOptions {
  replyTimeoutMs?: number;
  settleAfterWriteMs?: number;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i]);
const LODS = ["Low", "Medium", "High"] as const;
const MODES = ["Off", "Static", "Breathing single"] as const;

/**
 * Native WebHID, with whole read/modify/write transactions serialized.
 * Writes await their acknowledgement BEFORE issuing a read-back request.
 * Unknown bytes and unrelated profile settings are always retained.
 */
export class AjazzAj200pHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly replyTimeoutMs: number;
  private readonly settleAfterWriteMs: number;
  private cancelPending: (() => void) | null = null;
  private epoch = 0;
  private knownProfile: number | null = null;
  private wireless: boolean;

  constructor(device: HIDDevice, options: AjazzAj200pOptions = {}) {
    this.device = device;
    if (!AJ200P_PRODUCTS.has(device.productId))
      throw new RangeError("Unknown AJ200 AI product id.");
    this.wireless = !this.product.wired;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 2000;
    this.settleAfterWriteMs = options.settleAfterWriteMs ?? 250;
  }
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== AJ200P_VENDOR_ID || !AJ200P_PRODUCTS.has(device.productId))
      return false;
    const find = (collections: readonly HIDCollectionInfo[]): boolean =>
      collections.some(
        (collection) =>
          (collection.usagePage === AJ200P_USAGE_PAGE && collection.usage === AJ200P_USAGE) ||
          find(collection.children ?? []),
      );
    return find(device.collections);
  }
  private get product() {
    return AJ200P_PRODUCTS.get(this.device.productId)!;
  }
  private get buttonNames() {
    return AJ200P_BUTTON_NAMES.slice(0, this.product.flywheel ? 10 : 6);
  }
  get supportedPollingRates(): number[] {
    return [...(this.wireless ? this.product.wirelessRates : this.product.wiredRates)];
  }
  getDpiOptions(): number[] {
    const { minDpi, maxDpi, stepDpi } = this.product;
    return Array.from({ length: (maxDpi - minDpi) / stepDpi + 1 }, (_, i) => minDpi + i * stepDpi);
  }
  private validateDpi(dpi: number): void {
    aj200pInteger(dpi, this.product.minDpi, this.product.maxDpi, "DPI");
    if (dpi % this.product.stepDpi !== 0)
      throw new RangeError(`This sensor uses ${this.product.stepDpi}-DPI steps.`);
  }
  getSleepOptions(): number[] {
    return [...AJ200P_SLEEP_SECONDS];
  }
  getDebounceOptions(): number[] {
    return Array.from({ length: 21 }, (_, i) => i);
  }
  getDebounceMaxMs(): number {
    return 20;
  }
  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }
  async close(): Promise<void> {
    this.epoch++;
    this.cancelPending?.();
    await this.queue.catch(() => {});
    this.knownProfile = null;
    if (this.device.opened) await this.device.close();
  }
  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const task = this.queue.then(async () => {
      if (this.epoch !== epoch) throw new Error("The AJ200P connection was closed.");
      await this.open();
      return operation();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  private exchange(command: Aj200pCommand, payload: ArrayLike<number> = []): Promise<Uint8Array> {
    const body = aj200pEncode(command, payload);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", listener);
        this.cancelPending = null;
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const listener = (event: HIDInputReportEvent) => {
        if (settled) return;
        try {
          const view = event.data;
          const response = aj200pDecodeReply(
            event.reportId,
            new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
            command,
          );
          if (response === null) return;
          settled = true;
          cleanup();
          resolve(response);
        } catch (error) {
          fail(error);
        }
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `AJ200P command 0x${command.toString(16)} timed out. Wake the mouse and close other configurators.`,
            ),
          ),
        this.replyTimeoutMs,
      );
      this.cancelPending = () => fail(new Error("The AJ200P connection was closed."));
      this.device.addEventListener("inputreport", listener);
      try {
        this.device.sendReport(AJ200P_OUTPUT_REPORT_ID, Uint8Array.from(body).buffer).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  }
  private async info() {
    const info = aj200pDecodeInfo(await this.exchange(AJ200P_COMMAND.info));
    this.wireless = info.wireless;
    return info;
  }
  private async settings() {
    const data = await this.exchange(AJ200P_COMMAND.settings);
    if (data.length !== aj200pSettingsLength(this.product))
      throw new Error("The settings layout does not match this AJ200 AI model.");
    return aj200pDecodeSettings(data);
  }
  private async dpiTable() {
    const data = await this.exchange(AJ200P_COMMAND.dpi);
    if (data.length !== (this.product.sensor === "PAW3955" ? 64 : 48))
      throw new Error("The DPI layout does not match this AJ200 AI sensor.");
    return data;
  }
  private async keyTable() {
    const data = await this.exchange(AJ200P_COMMAND.keys);
    aj200pDecodeKeys(data);
    if (this.product.flywheel && data.length !== 33)
      throw new Error("The AJ200 AI flywheel key map is incomplete.");
    return data;
  }
  private actions() {
    return AJ200P_ACTIONS.filter((action) => {
      const type = action.binding[0];
      return (
        type !== 7 ||
        action.binding[1] === 0 ||
        this.supportedPollingRates.includes(aj200pDecodeRate(action.binding[1]) ?? -1)
      );
    });
  }
  private async beginEdit(): Promise<number> {
    const info = await this.info();
    if (this.knownProfile !== null && info.profile !== this.knownProfile) {
      throw new Error("The onboard profile changed. Refresh the mouse before applying edits.");
    }
    return info.profile;
  }
  private async checkProfile(profile: number): Promise<void> {
    if ((await this.info()).profile !== profile)
      throw new Error("The onboard profile changed during the operation. Refresh the mouse.");
  }
  private async writeBlock(
    command: Aj200pCommand,
    read: Aj200pCommand,
    data: Uint8Array,
    profile: number,
  ): Promise<void> {
    await this.checkProfile(profile);
    await this.exchange(command, data);
    await pause(this.settleAfterWriteMs);
    await this.checkProfile(profile);
    const actual = await this.exchange(read);
    if (!equal(actual, data))
      throw new Error("The AJ200P did not keep the new setting; read-back differed.");
    await this.checkProfile(profile);
  }
  private updateSettings(
    patch: (raw: Uint8Array, current: Aj200pSettings, wireless: boolean) => void,
  ): Promise<void> {
    return this.transaction(async () => {
      const profile = await this.beginEdit();
      const current = await this.settings();
      const next = current.raw.slice();
      patch(next, current, (await this.info()).wireless);
      aj200pDecodeSettings(next);
      if (!equal(next, current.raw))
        await this.writeBlock(AJ200P_COMMAND.setSettings, AJ200P_COMMAND.settings, next, profile);
      else await this.checkProfile(profile);
    });
  }

  async readStatus(): Promise<MouseStatus> {
    return this.transaction(async () => {
      // A bottom-button profile change can arrive between reads. Do not combine
      // a key map from one bank with the DPI/settings of another.
      for (let attempt = 0; attempt < 2; attempt++) {
        const info = await this.info();
        const config = await this.settings();
        const dpi = aj200pDecodeDpi(await this.dpiTable()).slice(0, config.count);
        const keys = aj200pDecodeKeys(await this.keyTable());
        if ((await this.info()).profile !== info.profile) continue;
        for (const stage of dpi) {
          this.validateDpi(stage.x);
          this.validateDpi(stage.y);
        }
        this.knownProfile = info.profile;
        const lighting = this.lighting(config);
        return {
          brand: "AJAZZ",
          name: this.product.name,
          ui: {
            family: "ajazz-aj200p",
            settingsReady: true,
            valuesVerified: true,
            showAdvancedSection: true,
            hideSignalCard: true,
            hideUnsupportedPollingRates: true,
            hideRippleControl: true,
            hideAdvancedLighting: true,
            sleepNote: "Saving this timeout also sets deep sleep to one minute later.",
            statusNote:
              this.product.hiddenActionsAnalyzed && info.mouseVersion === "3.3.13"
                ? undefined
                : "Profile and polling-rate button actions are experimental on this model and firmware; hardware behavior is unverified.",
            dpiStageEditor: {
              maxStages: 8,
              countEditable: true,
              minDpi: this.product.minDpi,
              maxDpi: this.product.maxDpi,
              stepDpi: this.product.stepDpi,
            },
          },
          batteryPercent: info.battery,
          batteryState:
            info.battery === null
              ? "Unknown"
              : info.battery === 100
                ? "Full"
                : info.charging
                  ? "Charging"
                  : "Discharging",
          connectionType: info.wireless ? "Wireless" : "Wired",
          connectionDetail: info.wireless ? "2.4 GHz receiver" : "Wired USB",
          firmware: [
            `Mouse ${info.mouseVersion}`,
            ...(AJ200P_PRODUCTS.get(this.device.productId)?.wired
              ? []
              : [`Receiver ${info.receiverVersion}`]),
          ],
          deviceMode: "Onboard",
          activeProfile: info.profile,
          profileCount: 5,
          dpi: dpi[config.active].x,
          dpiY: dpi[config.active].y,
          supportsSeparateDpiAxes: true,
          dpiStages: dpi.map((stage) => stage.x),
          dpiStagesY: dpi.map((stage) => stage.y),
          dpiStageColors: dpi.map((stage) => stage.color),
          activeDpiStage: config.active,
          pollingRateHz: (info.wireless ? config.wirelessRate : config.wiredRate) ?? 0,
          supportedPollingRates: this.supportedPollingRates,
          liftOffDistance: this.product.lodCodes.includes(config.lod) ? LODS[config.lod] : null,
          supportedLiftOffDistances: this.product.lodCodes.map((code) => LODS[code]),
          debounceMs: config.debounce,
          motionSync: config.motionSync,
          angleSnapping: config.angleSnapping,
          performanceMode: config.performanceMode,
          sleepTimeout: config.sleepSeconds,
          buttonMappings: Object.fromEntries(
            this.buttonNames.map((name, i) => [
              name,
              aj200pBindingLabel(keys[AJ200P_BUTTON_SLOTS[i]]),
            ]),
          ),
          buttonOptions: this.actions().map((action) => action.label),
          lighting,
        };
      }
      throw new Error("The onboard profile kept changing while reading. Refresh the mouse.");
    });
  }
  private lighting(config: Aj200pSettings): MouseLighting {
    return {
      zone: "DPI indicator",
      modes: [...MODES],
      mode: MODES[config.effect] ?? null,
      color: config.color,
      color2: null,
      colorModes: ["Static", "Breathing single"],
      dualColorModes: [],
      reactiveModes: ["Breathing single"],
      speeds: [1, 2, 3, 4, 5],
      speed: config.speed,
      brightness: Math.round((config.brightness * 100) / 255),
      brightnessLevels: [0, 20, 40, 60, 80, 100],
    };
  }
  async setProfile(profile: number): Promise<number> {
    aj200pInteger(profile, 1, 5, "Onboard profile");
    return this.transaction(async () => {
      await this.exchange(AJ200P_COMMAND.profile, [profile - 1]);
      await pause(this.settleAfterWriteMs);
      await this.checkProfile(profile);
      this.knownProfile = profile;
      return profile;
    });
  }
  async setButtonMapping(button: string, action: string): Promise<void> {
    const index = (this.buttonNames as readonly string[]).indexOf(button);
    const binding = aj200pFindAction(action);
    if (index < 0 || !binding) throw new RangeError("Unknown AJ200P button or action.");
    return this.transaction(async () => {
      const profile = await this.beginEdit();
      await this.info();
      if (!this.actions().some((candidate) => candidate.label === action))
        throw new Error(
          "This polling-rate action exceeds the current connection's supported rates.",
        );
      const keys = await this.keyTable();
      const next = keys.slice();
      next.set(binding, AJ200P_BUTTON_SLOTS[index] * 3);
      // Keep at least one primary click available, allowing deliberate swaps.
      const decoded = aj200pDecodeKeys(next);
      if (
        !this.buttonNames.some(
          (_name, i) =>
            decoded[AJ200P_BUTTON_SLOTS[i]][0] === 1 &&
            (decoded[AJ200P_BUTTON_SLOTS[i]][1] & 1) !== 0,
        )
      )
        throw new Error("Keep a left-click action on at least one button.");
      if (!equal(next, keys))
        await this.writeBlock(AJ200P_COMMAND.setKeys, AJ200P_COMMAND.keys, next, profile);
    });
  }
  async setPollingRate(hz: number): Promise<number> {
    const code = aj200pEncodeRate(hz);
    await this.updateSettings((raw, _config, wireless) => {
      if (!(wireless ? this.product.wirelessRates : this.product.wiredRates).includes(hz))
        throw new RangeError("This model does not support that polling rate on this connection.");
      raw[wireless ? 0 : 1] = code;
    });
    return hz;
  }
  async setActiveDpiStage(stage: number): Promise<number> {
    await this.updateSettings((raw, config) => {
      raw[3] = aj200pInteger(stage, 0, config.count - 1, "DPI stage");
    });
    return stage;
  }
  async setDpiStageCount(count: number): Promise<number> {
    aj200pInteger(count, 1, 8, "DPI stage count");
    return this.transaction(async () => {
      const profile = await this.beginEdit();
      const config = await this.settings();
      // Inactive slots are retained, but a blank slot cannot be enabled.
      const data = await this.dpiTable();
      const table = aj200pDecodeDpi(data);
      let initialized = data;
      for (let stage = 0; stage < count; stage++) {
        try {
          this.validateDpi(table[stage].x);
          this.validateDpi(table[stage].y);
        } catch (error) {
          if (stage < config.count) throw error;
          initialized = aj200pPatchDpi(initialized, stage, table[config.count - 1]);
        }
      }
      if (!equal(initialized, data))
        await this.writeBlock(AJ200P_COMMAND.setDpi, AJ200P_COMMAND.dpi, initialized, profile);
      const next = config.raw.slice();
      next[2] = count;
      next[3] = Math.min(config.active, count - 1);
      if (!equal(next, config.raw))
        await this.writeBlock(AJ200P_COMMAND.setSettings, AJ200P_COMMAND.settings, next, profile);
      return count;
    });
  }
  private editDpi(
    stage: number | null,
    patch: { x?: number; y?: number; color?: string },
    axesTogether = false,
  ): Promise<void> {
    if (patch.x !== undefined) this.validateDpi(patch.x);
    if (patch.y !== undefined) this.validateDpi(patch.y);
    if (patch.color !== undefined) aj200pColorBytes(patch.color);
    return this.transaction(async () => {
      const profile = await this.beginEdit();
      const config = await this.settings();
      const index = stage ?? config.active;
      aj200pInteger(index, 0, config.count - 1, "DPI stage");
      const data = await this.dpiTable();
      const next = aj200pPatchDpi(data, index, axesTogether ? { x: patch.x, y: patch.x } : patch);
      if (!equal(next, data))
        await this.writeBlock(AJ200P_COMMAND.setDpi, AJ200P_COMMAND.dpi, next, profile);
    });
  }
  async setDpi(dpi: number): Promise<number> {
    await this.editDpi(null, { x: dpi }, true);
    return dpi;
  }
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    await this.editDpi(stage, { x: dpi }, true);
    return dpi;
  }
  async setDpiStageAxes(stage: number, x: number, y: number): Promise<void> {
    await this.editDpi(stage, { x, y });
  }
  async setDpiStageColor(stage: number, color: string): Promise<void> {
    await this.editDpi(stage, { color });
  }
  async setLiftOffDistance(lod: NonNullable<MouseStatus["liftOffDistance"]>): Promise<void> {
    const code = LODS.indexOf(lod);
    if (code < 0 || !this.product.lodCodes.includes(code))
      throw new RangeError("Unsupported AJ200P lift-off distance.");
    await this.updateSettings((raw) => {
      raw[6] = code;
    });
  }
  async setDebounceTime(ms: number): Promise<number> {
    aj200pInteger(ms, 0, 20, "Debounce time");
    await this.updateSettings((raw) => {
      raw[7] = ms;
    });
    return ms;
  }
  async setMotionSync(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== "boolean") throw new TypeError("Motion Sync must be a boolean.");
    await this.updateSettings((raw) => {
      raw[8] = Number(enabled);
    });
    return enabled;
  }
  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== "boolean") throw new TypeError("Angle snapping must be a boolean.");
    await this.updateSettings((raw) => {
      raw[10] = Number(enabled);
    });
    return enabled;
  }
  async setPerformanceMode(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== "boolean") throw new TypeError("Performance mode must be a boolean.");
    await this.updateSettings((raw, config) => {
      if (config.performanceMode === null) throw new Error("Unknown AJ200P sensor power mode.");
      raw[15] = Number(!enabled);
    });
    return enabled;
  }
  async setSleepTimeout(seconds: number): Promise<number> {
    if (!(AJ200P_SLEEP_SECONDS as readonly number[]).includes(seconds))
      throw new RangeError("Unsupported AJ200P sleep timeout.");
    await this.updateSettings((raw) => {
      raw[25] = seconds / 10;
      raw[26] = (seconds + 60) / 10;
    });
    return seconds;
  }
  async setLighting(lighting: MouseLighting): Promise<void> {
    if (lighting.zone !== "DPI indicator" || lighting.mode === null)
      throw new RangeError("Unsupported AJ200P lighting zone or mode.");
    const mode = (MODES as readonly string[]).indexOf(lighting.mode);
    if (mode < 0) throw new RangeError("Unsupported AJ200P lighting effect.");
    if (lighting.color !== null) aj200pColorBytes(lighting.color);
    if (lighting.brightness != null) aj200pInteger(lighting.brightness, 0, 100, "Brightness");
    if (lighting.speed !== null) aj200pInteger(lighting.speed, 1, 5, "Lighting speed");
    await this.updateSettings((raw, current) => {
      raw[27] = mode;
      if (lighting.color !== null) raw.set(aj200pColorBytes(lighting.color), 21);
      // A rounded UI percentage must not silently change the raw brightness
      // when only the colour/effect was edited.
      if (
        lighting.brightness != null &&
        lighting.brightness !== Math.round((current.brightness * 100) / 255)
      )
        raw[28] = Math.round((lighting.brightness * 255) / 100);
      if (lighting.speed !== null) raw[29] = lighting.speed;
    });
  }
}
