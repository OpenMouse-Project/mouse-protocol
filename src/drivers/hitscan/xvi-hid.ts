import type { MouseStatus } from "../mouse-types.ts";
import {
  HITSCAN_XVI_BUTTON_IDS,
  HITSCAN_XVI_BUTTON_NAMES,
  HITSCAN_XVI_DPI_MAX,
  HITSCAN_XVI_DPI_MIN,
  HITSCAN_XVI_DPI_STEP,
  HITSCAN_XVI_LIFT_OFF_MILLIMETRES,
  HITSCAN_XVI_MAX_DPI_STAGES,
  HITSCAN_XVI_MAX_MACROS,
  HITSCAN_XVI_NOTIFICATION_REPORT_ID,
  HITSCAN_XVI_PACKET_LENGTH,
  HITSCAN_XVI_POLLING_RATES,
  HITSCAN_XVI_PRODUCTS,
  HITSCAN_XVI_REPORT_ID,
  HITSCAN_XVI_SLEEP_OPTIONS,
  HITSCAN_XVI_STATUS_ASLEEP,
  HITSCAN_XVI_TIMING_MAX_MS,
  HITSCAN_XVI_VENDOR_ID,
  hitscanXviActiveStageGetRequest,
  hitscanXviActiveStageSetRequest,
  hitscanXviAngleGetRequest,
  hitscanXviAngleSetRequest,
  hitscanXviBatteryRequest,
  hitscanXviButtonGetRequest,
  hitscanXviButtonSetRequest,
  hitscanXviDecodeActiveStage,
  hitscanXviDecodeAngle,
  hitscanXviDecodeBattery,
  hitscanXviDecodeButton,
  hitscanXviDecodeDevicePid,
  hitscanXviDecodeDpiColors,
  hitscanXviDecodeDpiStages,
  hitscanXviDecodeFirmware,
  hitscanXviDecodeLiftOff,
  hitscanXviDecodeMacroData,
  hitscanXviDecodeMacroIds,
  hitscanXviDecodeMacroName,
  hitscanXviDecodeMacroSize,
  hitscanXviDecodeNotification,
  hitscanXviDecodePollingRate,
  hitscanXviDecodeProfileCount,
  hitscanXviDecodeProfileId,
  hitscanXviDecodeProfileName,
  hitscanXviDecodeScrollHighPerformance,
  hitscanXviDecodeSignal,
  hitscanXviDecodeSleep,
  hitscanXviDecodeSpdt,
  hitscanXviDecodeSplitDpi,
  hitscanXviDecodeTimings,
  hitscanXviDevicePidRequest,
  hitscanXviDpiColorsGetRequest,
  hitscanXviDpiColorsSetRequest,
  hitscanXviDpiStagesGetRequest,
  hitscanXviDpiStagesSetRequest,
  hitscanXviFirmwareRequest,
  hitscanXviFlagGetRequest,
  hitscanXviFlagSetRequest,
  hitscanXviLiftOffGetRequest,
  hitscanXviLiftOffSetRequest,
  hitscanXviMacroAllocateRequest,
  hitscanXviMacroDataRequest,
  hitscanXviMacroDataSetRequest,
  hitscanXviMacroDeleteRequest,
  hitscanXviMacroListRequest,
  hitscanXviMacroNameRequest,
  hitscanXviMacroNameSetRequest,
  hitscanXviMacroSizeRequest,
  hitscanXviPollingRateGetRequest,
  hitscanXviPollingRateSetRequest,
  hitscanXviProfileGetRequest,
  hitscanXviProfileListRequest,
  hitscanXviProfileNameGetRequest,
  hitscanXviProfileNameSetRequest,
  hitscanXviProfileSetRequest,
  hitscanXviReply,
  hitscanXviResetProfileRequest,
  hitscanXviScrollHighPerformanceGetRequest,
  hitscanXviScrollHighPerformanceSetRequest,
  hitscanXviSleepGetRequest,
  hitscanXviSignalRequest,
  hitscanXviSleepSetRequest,
  hitscanXviSpdtGetRequest,
  hitscanXviSpdtSetRequest,
  hitscanXviSplitDpiGetRequest,
  hitscanXviSplitDpiSetRequest,
  hitscanXviTimingsGetRequest,
  hitscanXviTimingsSetRequest,
  HITSCAN_XVI_COMMAND,
  type HitscanXviClickTimings,
  type HitscanXviDpiStage,
  type HitscanXviNotification,
} from "../../hitscan/xvi.ts";
import {
  hitscanXviButtonActionForLabel,
  hitscanXviButtonLabel,
  hitscanXviDecodeButtonAction,
  hitscanXviDecodeGbkName,
  hitscanXviDecodeMacroEvents,
  hitscanXviEncodeButtonAction,
  hitscanXviEncodeGbkName,
  hitscanXviEncodeMacroEvents,
  hitscanXviIsLeftClick,
  HITSCAN_XVI_BUTTON_LABELS,
  type HitscanXviButtonAction,
  type HitscanXviMacroEvent,
} from "../../hitscan/xvi-inputs.ts";

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

export interface HitscanXviClientOptions {
  /** Unsolicited input-report listener; `startNotifications` also works. */
  onNotification?: (notification: HitscanXviNotification) => void;
}

export interface HitscanXviMacro {
  id: number;
  name: string | null;
  events: HitscanXviMacroEvent[] | null;
  /** Raw device event bytes, even when the event stream cannot be decoded. */
  bytes: Uint8Array<ArrayBuffer>;
  /** True when the stored stream is too large or uses unknown event types. */
  readOnly: boolean;
}

const POLL_INTERVAL_MS = 20;
const POLLS_PER_SEND = 30;
const SENDS = 5;
const CHUNK_BYTES = 50;
const LIFT_OFF_STOPS: Readonly<Record<number, LiftOffDistance>> = { 0.7: "Low", 1: "Medium", 2: "High" };
/** Vendor signal levels (1 strong, 2 medium, 3 weak) as the shared 0-4 bars. */
const SIGNAL_BARS: Readonly<Record<number, number>> = { 1: 4, 2: 2, 3: 1 };
const DEFAULT_STAGES = [400, 800, 1600, 3200];

/**
 * Hitscan's current generation, as driven by control.hitscan.com release
 * `1.0.15-fe600431`. Vendor `0x3770`, 64-byte feature report 0, mouse device
 * id 2. This is separate from the native Hitscan Utility protocol in
 * `./hid.ts`: that one uses report 8 and checksummed flash records.
 *
 * Not tested on hardware. Every setter verifies by reading the value back and
 * throws on mismatch, so a wrong assumption fails loudly.
 */
export class HitscanXviHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private opening: Promise<void> | null = null;
  private disposed = false;
  private listening = false;
  private lastStatus: MouseStatus | null = null;
  private readonly notify?: HitscanXviClientOptions["onNotification"];
  private readonly onInput = (event: HIDInputReportEvent): void => {
    if (event.reportId !== HITSCAN_XVI_NOTIFICATION_REPORT_ID) return;
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const notification = hitscanXviDecodeNotification(bytes);
    if (notification) (this.notifications ?? this.notify)?.(notification);
  };

  constructor(device: HIDDevice, options: HitscanXviClientOptions = {}) {
    this.device = device;
    this.notify = options.onNotification;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== HITSCAN_XVI_VENDOR_ID || !HITSCAN_XVI_PRODUCTS.has(device.productId)) return false;
    const control = (collections: readonly HIDCollectionInfo[]): boolean => collections.some((collection) =>
      collection.featureReports.some((report) =>
        report.reportId === HITSCAN_XVI_REPORT_ID
        && report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) === HITSCAN_XVI_PACKET_LENGTH * 8)
      || control(collection.children ?? []));
    return control(device.collections);
  }

  get pollIntervalMs(): number {
    return this.isWireless() ? 10_000 : 30_000;
  }

  displayName(): string {
    const product = HITSCAN_XVI_PRODUCTS.get(this.device.productId);
    if (product?.model) return `Hitscan ${product.model}`;
    return this.device.productName?.trim() || "Hitscan mouse";
  }

  deviceBrand(): MouseStatus["brand"] {
    return "Hitscan";
  }

  isWireless(): boolean {
    return HITSCAN_XVI_PRODUCTS.get(this.device.productId)?.transport === "receiver";
  }

  maxDpi(): number {
    return HITSCAN_XVI_DPI_MAX;
  }

  getDpiOptions(): number[] {
    const values: number[] = [];
    for (let dpi = HITSCAN_XVI_DPI_MIN; dpi <= HITSCAN_XVI_DPI_MAX; dpi += HITSCAN_XVI_DPI_STEP) values.push(dpi);
    return values;
  }

  getSupportedPollingRates(): number[] {
    return [...HITSCAN_XVI_POLLING_RATES];
  }

  getSleepOptions(): number[] {
    return [...HITSCAN_XVI_SLEEP_OPTIONS];
  }

  getDebounceMaxMs(): number {
    return HITSCAN_XVI_TIMING_MAX_MS;
  }

  /** True when the interface carries input report 4 for unsolicited updates. */
  startNotifications(listener?: HitscanXviClientOptions["onNotification"]): boolean {
    if (listener !== undefined) this.notifications = listener;
    const carries = (collections: readonly HIDCollectionInfo[]): boolean => collections.some((collection) =>
      collection.inputReports.some((report) => report.reportId === HITSCAN_XVI_NOTIFICATION_REPORT_ID)
      || carries(collection.children ?? []));
    if (!carries(this.device.collections)) return false;
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInput);
      this.listening = true;
    }
    return true;
  }

  private notifications?: HitscanXviClientOptions["onNotification"];

  open(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("The Hitscan client is closed."));
    this.opening ??= (async () => {
      if (!this.device.opened) await this.device.open();
      if (this.disposed) throw new Error("The Hitscan client is closed.");
    })().catch((error: unknown) => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.lastStatus = null;
    await this.opening?.catch(() => undefined);
    this.opening = null;
    await this.queue;
    if (this.listening) this.device.removeEventListener("inputreport", this.onInput);
    this.listening = false;
    if (this.device.opened) await this.device.close();
  }

  /** Serializes complete command round trips. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async transact(request: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    await this.open();
    const label = `0x${(request[5] ?? 0).toString(16)}`;
    let lastError: unknown = null;
    for (let send = 0; send < SENDS; send++) {
      if (this.disposed) throw new Error("The Hitscan client is closed.");
      try {
        await this.device.sendFeatureReport(HITSCAN_XVI_REPORT_ID, request);
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      for (let poll = 0; poll < POLLS_PER_SEND; poll++) {
        await hitscanXviDelay(POLL_INTERVAL_MS);
        let view: DataView;
        try {
          view = await this.device.receiveFeatureReport(HITSCAN_XVI_REPORT_ID);
        } catch (error) {
          // A native read timeout is retryable; a closed device is not.
          lastError = error;
          if (this.disposed || !this.device.opened) throw error instanceof Error ? error : new Error(String(error));
          continue;
        }
        const reply = hitscanXviReply(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), request);
        if (!reply) continue;
        if (reply[0] === HITSCAN_XVI_STATUS_ASLEEP) {
          throw new Error(`${this.displayName()} is asleep or out of range. Move it, then retry.`);
        }
        return reply;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`${this.displayName()} did not answer command ${label}.`);
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  private async optional<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }

  async readStatus(live = false): Promise<MouseStatus> {
    return this.run(async () => {
      if (live && this.lastStatus) return await this.readLiveStatus(this.lastStatus);
      const firmware = hitscanXviDecodeFirmware(await this.transact(hitscanXviFirmwareRequest()));
      if (!firmware) throw new Error("The Hitscan mouse did not report valid firmware.");
      const wireless = this.isWireless();
      const receiverFirmware = wireless
        ? hitscanXviDecodeFirmware(await this.transact(hitscanXviFirmwareRequest(0)))
        : null;
      const pairedPid = wireless
        ? await this.optional(() => this.transact(hitscanXviDevicePidRequest()).then(hitscanXviDecodeDevicePid))
        : this.device.productId;
      const model = HITSCAN_XVI_PRODUCTS.get(pairedPid ?? -1)?.model;
      const name = model ? `Hitscan ${model}` : this.displayName();
      const profileCount = hitscanXviDecodeProfileCount(await this.transact(hitscanXviProfileListRequest()));
      const profileId = hitscanXviDecodeProfileId(await this.transact(hitscanXviProfileGetRequest()));
      if (!profileCount || !profileId || profileId > profileCount) throw new Error("The Hitscan profile table is invalid.");
      const names: string[] = [];
      for (let id = 1; id <= profileCount; id++) {
        const decoded = await this.optional(() =>
          this.transact(hitscanXviProfileNameGetRequest(id)).then(hitscanXviDecodeProfileName));
        names.push(decoded?.name || `Profile ${id}`);
      }
      const settings = await this.readSettings(profileId);
      const battery = await this.optional(() => this.transact(hitscanXviBatteryRequest()).then(hitscanXviDecodeBattery));
      const signal = wireless
        ? await this.optional(() => this.transact(hitscanXviSignalRequest()).then(hitscanXviDecodeSignal))
        : null;
      const stages = settings.stages;
      const active = settings.activeStage;
      const dpi = stages[active]?.x ?? HITSCAN_XVI_DPI_MIN;
      const firmwareList = [`Mouse ${firmware}`];
      if (receiverFirmware) firmwareList.push(`Dongle ${receiverFirmware}`);
      this.lastStatus = {
        brand: "Hitscan",
        name,
        batteryPercent: battery?.percent ?? null,
        batteryState: battery ? (battery.charging ? (battery.percent >= 100 ? "Full" : "Charging") : "Discharging") : "Unknown",
        dpi,
        ...(settings.splitDpi ? { dpiY: stages[active]?.y ?? dpi } : {}),
        supportsSeparateDpiAxes: settings.splitDpi,
        dpiStages: stages.slice(0, settings.stageCount).map((stage) => stage.x),
        dpiStageColors: settings.colors,
        activeDpiStage: active,
        pollingRateHz: settings.pollingRateHz,
        supportedPollingRates: this.getSupportedPollingRates(),
        activeProfile: profileId,
        profileCount,
        profileNames: names,
        connectionType: wireless ? "Wireless" : "Wired",
        connectionDetail: wireless ? "2.4 GHz receiver · Hitscan web protocol" : "USB · Hitscan web protocol",
        motionSync: settings.motionSync,
        hyperMode: settings.hyperMode,
        hitscanCompetitiveMode: settings.competitiveMode,
        angleTuning: settings.angle,
        sleepTimeout: settings.sleep,
        liftOffDistance: LIFT_OFF_STOPS[settings.liftOff] ?? null,
        liftOffScale: this.liftOffScale(settings.liftOff),
        debounceMs: settings.timings?.beforePress ?? null,
        hitscanClickTimings: settings.timings,
        hitscanSpdt: settings.spdt,
        hitscanTournamentScroll: settings.scrollHighPerformance,
        signalStrength: signal ? (SIGNAL_BARS[signal.level] ?? null) : null,
        buttonMappings: settings.buttonMappings,
        buttonOptions: HITSCAN_XVI_BUTTON_LABELS.map(([label]) => label),
        fixedButtons: settings.fixedButtons,
        firmware: firmwareList,
        ui: {
          family: "hitscan-xvi",
          hideUnsupportedPollingRates: true,
          hideRippleControl: true,
          hideAngleSnapping: true,
          showAdvancedSection: true,
          ...(wireless ? { forceShowBattery: true } : {}),
          defaultDisplayName: name,
          statusNote: "Hitscan's control.hitscan.com protocol; not tested on hardware yet.",
          dpiStageEditor: {
            maxStages: HITSCAN_XVI_MAX_DPI_STAGES,
            countEditable: true,
            minDpi: HITSCAN_XVI_DPI_MIN,
            maxDpi: HITSCAN_XVI_DPI_MAX,
            stepDpi: HITSCAN_XVI_DPI_STEP,
          },
        },
      };
      return this.lastStatus;
    });
  }

  private async readLiveStatus(previous: MouseStatus): Promise<MouseStatus> {
    const battery = await this.optional(() => this.transact(hitscanXviBatteryRequest()).then(hitscanXviDecodeBattery));
    const profileId = hitscanXviDecodeProfileId(await this.transact(hitscanXviProfileGetRequest()));
    const signal = this.isWireless()
      ? await this.optional(() => this.transact(hitscanXviSignalRequest()).then(hitscanXviDecodeSignal))
      : null;
    let next: MouseStatus = {
      ...previous,
      batteryPercent: battery?.percent ?? null,
      batteryState: battery ? (battery.charging ? (battery.percent >= 100 ? "Full" : "Charging") : "Discharging") : "Unknown",
      signalStrength: signal ? (SIGNAL_BARS[signal.level] ?? null) : previous.signalStrength,
    };
    if (profileId && profileId !== previous.activeProfile) {
      next = { ...next, activeProfile: profileId };
    }
    this.lastStatus = next;
    return next;
  }

  private liftOffScale(millimetres: number): NonNullable<MouseStatus["liftOffScale"]> {
    return {
      value: millimetres,
      min: HITSCAN_XVI_LIFT_OFF_MILLIMETRES[0] ?? 0.7,
      max: HITSCAN_XVI_LIFT_OFF_MILLIMETRES[HITSCAN_XVI_LIFT_OFF_MILLIMETRES.length - 1] ?? 2,
      millimetres,
      minMillimetres: HITSCAN_XVI_LIFT_OFF_MILLIMETRES[0] ?? 0.7,
      maxMillimetres: HITSCAN_XVI_LIFT_OFF_MILLIMETRES[HITSCAN_XVI_LIFT_OFF_MILLIMETRES.length - 1] ?? 2,
      millimetresByCode: [...HITSCAN_XVI_LIFT_OFF_MILLIMETRES],
    };
  }

  private async readSettings(profileId: number): Promise<{
    stageCount: number;
    activeStage: number;
    stages: HitscanXviDpiStage[];
    splitDpi: boolean;
    colors: string[];
    pollingRateHz: number;
    liftOff: number;
    sleep: number | null;
    angle: number;
    motionSync: boolean;
    hyperMode: boolean;
    competitiveMode: boolean | null;
    spdt: { left: boolean; right: boolean } | null;
    scrollHighPerformance: boolean | null;
    timings: HitscanXviClickTimings | null;
    buttonMappings: Record<string, string>;
    fixedButtons: string[];
  }> {
    // The vendor requests six slots even though every shipped model has four;
    // a reply above four is a firmware generation this driver does not model.
    const stages = hitscanXviDecodeDpiStages(await this.transact(hitscanXviDpiStagesGetRequest(profileId)));
    if (!stages || stages.stages.length > HITSCAN_XVI_MAX_DPI_STAGES) {
      throw new Error("The Hitscan mouse returned an unsupported DPI stage table.");
    }
    const active = hitscanXviDecodeActiveStage(await this.transact(hitscanXviActiveStageGetRequest(profileId)));
    if (!active || active > stages.stages.length) throw new Error("The Hitscan mouse returned an invalid active DPI stage.");
    const pollingRateHz = hitscanXviDecodePollingRate(await this.transact(hitscanXviPollingRateGetRequest(profileId)));
    const liftOff = hitscanXviDecodeLiftOff(await this.transact(hitscanXviLiftOffGetRequest(profileId)));
    if (pollingRateHz === null || liftOff === null) throw new Error("The Hitscan mouse returned invalid core settings.");
    const colors = await this.optional(() =>
      this.transact(hitscanXviDpiColorsGetRequest(profileId)).then(hitscanXviDecodeDpiColors));
    const splitDpi = hitscanXviDecodeSplitDpi(await this.transact(hitscanXviSplitDpiGetRequest(profileId)));
    const sleep = await this.optional(() => this.transact(hitscanXviSleepGetRequest(profileId)).then(hitscanXviDecodeSleep));
    const angle = hitscanXviDecodeAngle(await this.transact(hitscanXviAngleGetRequest(profileId)));
    const motionSync = hitscanXviDecodeFlagPayload(profileId, await this.transact(hitscanXviFlagGetRequest(profileId, HITSCAN_XVI_COMMAND.motionSyncGet)));
    const hyperMode = hitscanXviDecodeFlagPayload(profileId, await this.transact(hitscanXviFlagGetRequest(profileId, HITSCAN_XVI_COMMAND.hyperModeGet)));
    const competitiveMode = await this.optional(async () => {
      const reply = await this.transact(hitscanXviFlagGetRequest(profileId, HITSCAN_XVI_COMMAND.trackingModeGet));
      return hitscanXviDecodeFlagPayload(profileId, reply);
    });
    const spdt = await this.optional(() => this.transact(hitscanXviSpdtGetRequest(profileId)).then(hitscanXviDecodeSpdt));
    const scrollHighPerformance = await this.optional(() =>
      this.transact(hitscanXviScrollHighPerformanceGetRequest(profileId)).then(hitscanXviDecodeScrollHighPerformance));
    const timings = await this.optional(() => this.transact(hitscanXviTimingsGetRequest(profileId)).then(hitscanXviDecodeTimings));
    const buttons = await this.optional(() => this.readButtonSet(profileId));
    if (splitDpi === null || angle === null || motionSync === null || hyperMode === null) {
      throw new Error("The Hitscan mouse returned invalid sensor settings.");
    }
    return {
      stageCount: stages.stages.length,
      activeStage: active - 1,
      stages: stages.stages,
      splitDpi,
      colors: colors ?? [],
      pollingRateHz,
      liftOff,
      sleep,
      angle,
      motionSync,
      hyperMode,
      competitiveMode,
      spdt,
      scrollHighPerformance,
      timings,
      buttonMappings: buttons?.buttonMappings ?? {},
      fixedButtons: buttons?.fixedButtons ?? [],
    };
  }

  private async readButtonSet(profileId: number): Promise<{
    buttonMappings: Record<string, string>;
    fixedButtons: string[];
  }> {
    const mappings: Record<string, string> = {};
    const fixed: string[] = [];
    for (const [index, name] of HITSCAN_XVI_BUTTON_NAMES.entries()) {
      const binding = await this.readButton(profileId, HITSCAN_XVI_BUTTON_IDS[index]!);
      const action = hitscanXviDecodeButtonAction({ functionId: binding.functionId, data: binding.data });
      mappings[name!] = hitscanXviButtonLabel(action);
      if (name !== "Left" && hitscanXviButtonActionForLabel(mappings[name!]!) === null) fixed.push(name!);
    }
    return { buttonMappings: mappings, fixedButtons: fixed };
  }

  private async readButton(profileId: number, buttonId: number): Promise<{ functionId: number; data: number[] }> {
    let decoded = hitscanXviDecodeButton(await this.transact(hitscanXviButtonGetRequest(profileId, buttonId, 10)));
    if (!decoded || decoded.profileId !== profileId || decoded.buttonId !== buttonId) {
      throw new Error("The Hitscan mouse returned an invalid button reply.");
    }
    if (decoded.data.length > 10) {
      decoded = hitscanXviDecodeButton(await this.transact(hitscanXviButtonGetRequest(profileId, buttonId, decoded.data.length)));
      if (!decoded || decoded.profileId !== profileId || decoded.buttonId !== buttonId) {
        throw new Error("The Hitscan mouse returned an invalid button reply.");
      }
    }
    return { functionId: decoded.functionId, data: decoded.data };
  }

  private async writeFlag(profileId: number, command: number, enabled: boolean, label: string): Promise<boolean> {
    const getCommand = command | 0x80;
    await this.transact(hitscanXviFlagSetRequest(profileId, command, enabled));
    const reply = await this.transact(hitscanXviFlagGetRequest(profileId, getCommand));
    const confirmed = hitscanXviDecodeFlagPayload(profileId, reply);
    if (confirmed !== enabled) throw new Error(`The Hitscan mouse kept ${label} ${confirmed ? "on" : "off"}.`);
    return confirmed;
  }

  private async writeStages(profileId: number, stages: readonly HitscanXviDpiStage[]): Promise<HitscanXviDpiStage[]> {
    await this.transact(hitscanXviDpiStagesSetRequest(profileId, stages));
    const confirmed = hitscanXviDecodeDpiStages(await this.transact(hitscanXviDpiStagesGetRequest(profileId)));
    if (!confirmed) throw new Error("The Hitscan mouse did not return its DPI table.");
    if (confirmed.stages.length !== stages.length) throw new Error("The Hitscan mouse kept a different DPI stage count.");
    const expected = stages.slice(0, confirmed.stages.length);
    const equal = expected.every((stage, index) => stage.x === confirmed.stages[index]?.x && stage.y === confirmed.stages[index]?.y);
    if (!equal) throw new Error("The Hitscan mouse did not retain the requested DPI stages.");
    this.patch({
      dpiStages: confirmed.stages.map((stage) => stage.x),
      ...(this.lastStatus?.activeDpiStage === undefined
        ? {}
        : { dpi: confirmed.stages[this.lastStatus.activeDpiStage]?.x ?? this.lastStatus.dpi }),
    });
    return confirmed.stages;
  }

  setDpi(dpi: number): Promise<number> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      const settings = await this.readSettings(profileId);
      if (!settings.stages[settings.activeStage]) throw new Error("The Hitscan mouse reported no active DPI stage.");
      const stages = settings.stages.map((entry, index) => index === settings.activeStage
        ? { x: dpi, y: settings.splitDpi ? entry.y : dpi }
        : entry);
      await this.writeStages(profileId, stages);
      this.patch({ dpi, ...(settings.splitDpi ? { dpiY: dpi } : {}) });
      return dpi;
    });
  }

  setDpiStageValue(stage: number, dpi: number): Promise<number> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      const settings = await this.readSettings(profileId);
      if (!Number.isInteger(stage) || stage < 0 || stage >= settings.stages.length) {
        throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
      }
      const entry = settings.stages[stage]!;
      const updated = { x: dpi, y: settings.splitDpi ? entry.y : dpi };
      const stages = settings.stages.map((value, index) => index === stage ? updated : value);
      await this.writeStages(profileId, stages);
      return dpi;
    });
  }

  setDpiStageCount(count: number): Promise<number> {
    return this.run(async () => {
      if (!Number.isInteger(count) || count < 1 || count > HITSCAN_XVI_MAX_DPI_STAGES) {
        throw new Error(`This mouse supports between 1 and ${HITSCAN_XVI_MAX_DPI_STAGES} DPI stages.`);
      }
      const profileId = await this.currentProfile();
      const settings = await this.readSettings(profileId);
      if (settings.activeStage >= count) {
        await this.transact(hitscanXviActiveStageSetRequest(profileId, count));
      }
      const stages = Array.from({ length: count }, (_, index) =>
        settings.stages[index] ?? { x: DEFAULT_STAGES[index] ?? DEFAULT_STAGES[DEFAULT_STAGES.length - 1]!, y: DEFAULT_STAGES[index] ?? DEFAULT_STAGES[DEFAULT_STAGES.length - 1]! });
      await this.writeStages(profileId, stages);
      return count;
    });
  }

  setActiveDpiStage(stage: number): Promise<number> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      const settings = await this.readSettings(profileId);
      if (!Number.isInteger(stage) || stage < 0 || stage >= settings.stages.length) {
        throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
      }
      await this.transact(hitscanXviActiveStageSetRequest(profileId, stage + 1));
      const confirmed = hitscanXviDecodeActiveStage(await this.transact(hitscanXviActiveStageGetRequest(profileId)));
      if (confirmed !== stage + 1) throw new Error("The Hitscan mouse kept a different DPI stage.");
      this.patch({ activeDpiStage: stage, dpi: settings.stages[stage]?.x ?? this.lastStatus?.dpi ?? HITSCAN_XVI_DPI_MIN });
      return stage;
    });
  }

  setDpiStageColor(stage: number, color: string): Promise<string> {
    return this.run(async () => {
      const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
      if (!match) throw new Error(`${color} is not a #rrggbb colour.`);
      if (!Number.isInteger(stage) || stage < 0 || stage >= HITSCAN_XVI_MAX_DPI_STAGES) {
        throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
      }
      const profileId = await this.currentProfile();
      const current = hitscanXviDecodeDpiColors(await this.transact(hitscanXviDpiColorsGetRequest(profileId)));
      if (!current) throw new Error("The Hitscan mouse did not return its stage colours.");
      const hex = match[1]!.toLowerCase();
      current[stage] = `#${hex}`;
      const rgb = current.flatMap((value) => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)));
      await this.transact(hitscanXviDpiColorsSetRequest(profileId, rgb));
      const confirmed = hitscanXviDecodeDpiColors(await this.transact(hitscanXviDpiColorsGetRequest(profileId)));
      if (confirmed?.[stage] !== `#${hex}`) throw new Error("The Hitscan mouse did not retain the stage colour.");
      this.patch({ dpiStageColors: confirmed });
      return `#${hex}`;
    });
  }

  setSeparateDpiAxes(enabled: boolean): Promise<boolean> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviSplitDpiSetRequest(profileId, enabled));
      const confirmed = hitscanXviDecodeSplitDpi(await this.transact(hitscanXviSplitDpiGetRequest(profileId)));
      if (confirmed !== enabled) throw new Error(`The Hitscan mouse kept separate X/Y ${confirmed ? "on" : "off"}.`);
      this.patch({ supportsSeparateDpiAxes: confirmed });
      return confirmed;
    });
  }

  setPollingRate(hz: number): Promise<number> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviPollingRateSetRequest(profileId, hz));
      const confirmed = hitscanXviDecodePollingRate(await this.transact(hitscanXviPollingRateGetRequest(profileId)));
      if (confirmed !== hz) throw new Error(`The Hitscan mouse kept ${confirmed ?? "an unknown"} Hz instead of ${hz} Hz.`);
      this.patch({ pollingRateHz: confirmed });
      return confirmed;
    });
  }

  setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    const millimetres = Object.entries(LIFT_OFF_STOPS).find(([, stop]) => stop === value)?.[0];
    if (millimetres === undefined) return Promise.reject(new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`));
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviLiftOffSetRequest(profileId, Number(millimetres)));
      const confirmed = hitscanXviDecodeLiftOff(await this.transact(hitscanXviLiftOffGetRequest(profileId)));
      if (confirmed !== Number(millimetres)) throw new Error("The Hitscan mouse kept a different lift-off distance.");
      this.patch({ liftOffDistance: value, liftOffScale: this.liftOffScale(confirmed) });
      return value;
    });
  }

  setSleepTimeout(seconds: number | null): Promise<number | null> {
    if (seconds !== null && !HITSCAN_XVI_SLEEP_OPTIONS.includes(seconds)) {
      return Promise.reject(new Error(`Hitscan auto-sleep offers ${HITSCAN_XVI_SLEEP_OPTIONS.join(", ")} seconds.`));
    }
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviSleepSetRequest(profileId, seconds));
      const confirmed = hitscanXviDecodeSleep(await this.transact(hitscanXviSleepGetRequest(profileId)));
      if (confirmed !== seconds) throw new Error(`The Hitscan mouse kept ${confirmed ?? "no"} auto-sleep instead of ${seconds ?? "no"} s.`);
      this.patch({ sleepTimeout: confirmed });
      return confirmed;
    });
  }

  setAngleTuning(degrees: number): Promise<number> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviAngleSetRequest(profileId, degrees));
      const confirmed = hitscanXviDecodeAngle(await this.transact(hitscanXviAngleGetRequest(profileId)));
      if (confirmed !== degrees) throw new Error("The Hitscan mouse kept a different sensor angle.");
      this.patch({ angleTuning: confirmed });
      return confirmed;
    });
  }

  setMotionSync(enabled: boolean): Promise<boolean> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      const confirmed = await this.writeFlag(profileId, HITSCAN_XVI_COMMAND.motionSyncSet, enabled, "Motion Sync");
      this.patch({ motionSync: confirmed });
      return confirmed;
    });
  }

  setHyperMode(enabled: boolean): Promise<boolean> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      const confirmed = await this.writeFlag(profileId, HITSCAN_XVI_COMMAND.hyperModeSet, enabled, "Performance mode");
      this.patch({ hyperMode: confirmed });
      return confirmed;
    });
  }

  setTrackingMode(enabled: boolean): Promise<boolean> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      const confirmed = await this.writeFlag(profileId, HITSCAN_XVI_COMMAND.trackingModeSet, enabled, "Competitive mode");
      this.patch({ hitscanCompetitiveMode: confirmed });
      return confirmed;
    });
  }

  setScrollHighPerformance(enabled: boolean, timeoutMs = 300): Promise<boolean> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviScrollHighPerformanceSetRequest(profileId, enabled, timeoutMs));
      const confirmed = hitscanXviDecodeScrollHighPerformance(
        await this.transact(hitscanXviScrollHighPerformanceGetRequest(profileId)),
      );
      if (confirmed !== enabled) throw new Error(`The Hitscan mouse kept tournament scroll ${confirmed ? "on" : "off"}.`);
      this.patch({ hitscanTournamentScroll: confirmed });
      return confirmed;
    });
  }

  setSpdt(left: boolean, right: boolean): Promise<{ left: boolean; right: boolean }> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviSpdtSetRequest(profileId, left, right));
      const confirmed = hitscanXviDecodeSpdt(await this.transact(hitscanXviSpdtGetRequest(profileId)));
      if (!confirmed || confirmed.left !== left || confirmed.right !== right) {
        throw new Error("The Hitscan mouse kept different SPDT flags.");
      }
      this.patch({ hitscanSpdt: confirmed });
      return confirmed;
    });
  }

  setClickTimings(timings: HitscanXviClickTimings): Promise<HitscanXviClickTimings> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      await this.transact(hitscanXviTimingsSetRequest(profileId, timings));
      const confirmed = hitscanXviDecodeTimings(await this.transact(hitscanXviTimingsGetRequest(profileId)));
      if (!confirmed || Object.keys(timings).some((key) =>
        timings[key as keyof HitscanXviClickTimings] !== confirmed[key as keyof HitscanXviClickTimings])) {
        throw new Error("The Hitscan mouse kept different click timings.");
      }
      this.patch({ debounceMs: confirmed.beforePress, hitscanClickTimings: confirmed });
      return confirmed;
    });
  }

  readButtonBindings(): Promise<{ mappings: Record<string, string>; options: string[]; fixed: string[] }> {
    return this.run(async () => {
      const profileId = await this.currentProfile();
      const { buttonMappings, fixedButtons } = await this.readButtonSet(profileId);
      return { mappings: buttonMappings, options: HITSCAN_XVI_BUTTON_LABELS.map(([label]) => label), fixed: fixedButtons };
    });
  }

  setButtonMapping(button: string, label: string): Promise<void> {
    return this.run(async () => {
      const index = HITSCAN_XVI_BUTTON_NAMES.indexOf(button);
      if (index < 0) throw new Error(`This mouse has no ${button} button.`);
      if (index === 0) throw new Error("The left button cannot be remapped.");
      const action = hitscanXviButtonActionForLabel(label);
      if (!action) throw new Error(`${label} is not an action this mouse accepts.`);
      const profileId = await this.currentProfile();
      const current = await this.readButton(profileId, HITSCAN_XVI_BUTTON_IDS[index]!);
      const currentAction: HitscanXviButtonAction = hitscanXviDecodeButtonAction(current);
      if (hitscanXviIsLeftClick(currentAction)) {
        throw new Error("Keep at least one button as Left Click.");
      }
      const binding = hitscanXviEncodeButtonAction(action);
      await this.transact(hitscanXviButtonSetRequest(profileId, HITSCAN_XVI_BUTTON_IDS[index]!, binding.functionId, binding.data));
      const confirmed = await this.readButton(profileId, HITSCAN_XVI_BUTTON_IDS[index]!);
      const encoded = hitscanXviEncodeButtonAction(action);
      if (confirmed.functionId !== encoded.functionId
          || confirmed.data.length !== encoded.data.length
          || confirmed.data.some((byte, at) => byte !== encoded.data[at])) {
        throw new Error(`The Hitscan mouse kept a different ${button} action.`);
      }
      const mappings = this.lastStatus?.buttonMappings;
      if (mappings) this.patch({ buttonMappings: { ...mappings, [button]: label } });
    });
  }

  setActiveProfile(profileId: number): Promise<number> {
    return this.run(async () => {
      const count = this.lastStatus?.profileCount ?? hitscanXviDecodeProfileCount(await this.transact(hitscanXviProfileListRequest()));
      if (!count || !Number.isInteger(profileId) || profileId < 1 || profileId > count) {
        throw new Error(`This mouse has no profile ${profileId}.`);
      }
      await this.transact(hitscanXviProfileSetRequest(profileId));
      const confirmed = hitscanXviDecodeProfileId(await this.transact(hitscanXviProfileGetRequest()));
      if (confirmed !== profileId) throw new Error("The Hitscan mouse kept a different profile selected.");
      this.patch({ activeProfile: profileId });
      return confirmed;
    });
  }

  renameProfile(profileId: number, name: string): Promise<string> {
    return this.run(async () => {
      const bytes = hitscanXviEncodeGbkName(name);
      await this.transact(hitscanXviProfileNameSetRequest(profileId, bytes));
      const decoded = hitscanXviDecodeProfileName(await this.transact(hitscanXviProfileNameGetRequest(profileId)));
      if (decoded?.name !== name) throw new Error("The Hitscan mouse kept a different profile name.");
      const names = this.lastStatus?.profileNames;
      if (names && profileId <= names.length) {
        const updated = [...names];
        updated[profileId - 1] = name;
        this.patch({ profileNames: updated });
      }
      return decoded.name;
    });
  }

  /** Restores the profile's stored defaults; the caller should reread the status. */
  resetProfile(profileId?: number): Promise<void> {
    return this.run(async () => {
      const id = profileId ?? await this.currentProfile();
      await this.transact(hitscanXviResetProfileRequest(id));
      this.lastStatus = null;
    });
  }

  async readBattery(): Promise<{ percent: number; charging: boolean } | null> {
    return this.optional(() => this.transact(hitscanXviBatteryRequest()).then(hitscanXviDecodeBattery));
  }

  /* ---------------------------------------------------------------- macros */

  async readMacros(): Promise<HitscanXviMacro[]> {
    return this.run(async () => {
      const ids = hitscanXviDecodeMacroIds(await this.transact(hitscanXviMacroListRequest()));
      if (!ids) throw new Error("The Hitscan mouse returned a malformed macro list.");
      const macros: HitscanXviMacro[] = [];
      for (const id of ids) {
        const macro = await this.readMacroNow(id);
        if (!macro) throw new Error(`Hitscan macro ${id} is listed but unreadable.`);
        macros.push(macro);
      }
      return macros;
    });
  }

  private async readMacroNow(id: number): Promise<HitscanXviMacro | null> {
    const size = hitscanXviDecodeMacroSize(await this.transact(hitscanXviMacroSizeRequest(id)));
    if (size === null) throw new Error(`Invalid Hitscan macro size for macro ${id}.`);
    if (size === 0) return null;
    const nameReply = hitscanXviDecodeMacroName(await this.transact(hitscanXviMacroNameRequest(id)));
    if (!nameReply || nameReply.id !== id) throw new Error(`Invalid Hitscan macro name for macro ${id}.`);
    const bytes: number[] = [];
    const readOnlyLimit = 4096;
    for (let offset = 0; offset < size && offset < readOnlyLimit; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const chunk = hitscanXviDecodeMacroData(await this.transact(hitscanXviMacroDataRequest(id, offset, length)), id, offset, length);
      if (!chunk) throw new Error(`Invalid Hitscan macro data for macro ${id} at ${offset}.`);
      bytes.push(...chunk);
    }
    const stored = Uint8Array.from(bytes);
    const events = size > readOnlyLimit ? null : hitscanXviDecodeMacroEvents(stored);
    return {
      id,
      name: hitscanXviDecodeGbkName(nameReply.bytes),
      events,
      bytes: stored,
      readOnly: size > readOnlyLimit || events === null,
    };
  }

  /** Writes or creates a macro, then verifies bytes and name by reading them back. */
  writeMacro(input: { id?: number; name: string; events: readonly HitscanXviMacroEvent[] }): Promise<HitscanXviMacro> {
    return this.run(async () => {
      const bytes = hitscanXviEncodeMacroEvents(input.events);
      const nameBytes = hitscanXviEncodeGbkName(input.name);
      const ids = hitscanXviDecodeMacroIds(await this.transact(hitscanXviMacroListRequest()));
      if (!ids) throw new Error("The Hitscan mouse returned a malformed macro list.");
      let id: number;
      if (input.id !== undefined) {
        if (!ids.includes(input.id)) throw new Error(`Hitscan macro ${input.id} does not exist.`);
        id = input.id;
      } else {
        const free = Array.from({ length: HITSCAN_XVI_MAX_MACROS }, (_, index) => index + 1)
          .find((slot) => !ids.includes(slot));
        if (free === undefined) throw new Error("The Hitscan macro library is full.");
        id = free;
      }
      await this.transact(hitscanXviMacroAllocateRequest(id, bytes.length));
      const size = hitscanXviDecodeMacroSize(await this.transact(hitscanXviMacroSizeRequest(id)));
      if (size !== bytes.length) throw new Error("The Hitscan mouse did not allocate the macro size.");
      for (let offset = 0; offset < bytes.length; offset += 51) {
        const chunk = bytes.subarray(offset, offset + 51);
        await this.transact(hitscanXviMacroDataSetRequest(id, offset, chunk));
      }
      await this.transact(hitscanXviMacroNameSetRequest(id, nameBytes));
      const actual = await this.readMacroNow(id);
      if (!actual || actual.bytes.length !== bytes.length || actual.bytes.some((byte, at) => byte !== bytes[at])) {
        throw new Error("The Hitscan mouse did not retain the macro stream.");
      }
      const expectedName = hitscanXviDecodeGbkName(nameBytes);
      if (actual.name !== expectedName) throw new Error("The Hitscan mouse did not retain the macro name.");
      return actual;
    });
  }

  deleteMacro(id: number): Promise<void> {
    return this.run(async () => {
      const profileCount = this.lastStatus?.profileCount ?? hitscanXviDecodeProfileCount(await this.transact(hitscanXviProfileListRequest()));
      if (!profileCount) throw new Error("The Hitscan mouse returned no profile list.");
      for (let profileId = 1; profileId <= profileCount; profileId++) {
        const mappings = await this.readButtonSet(profileId);
        if (Object.values(mappings.buttonMappings).some((label) => label === `Macro ${id}`)) {
          throw new Error(`Hitscan macro ${id} is still assigned in profile ${profileId}.`);
        }
      }
      await this.transact(hitscanXviMacroDeleteRequest(id));
      const ids = hitscanXviDecodeMacroIds(await this.transact(hitscanXviMacroListRequest()));
      if (!ids || ids.includes(id)) throw new Error("The Hitscan mouse did not delete the macro.");
    });
  }

  /* --------------------------------------------------------------- helpers */

  private async currentProfile(): Promise<number> {
    const profileId = hitscanXviDecodeProfileId(await this.transact(hitscanXviProfileGetRequest()));
    if (!profileId) throw new Error("The Hitscan mouse returned an invalid active profile.");
    return profileId;
  }
}

/** Shared by every boolean feature: payload[0] echoes the profile, payload[1] is the flag. */
function hitscanXviDecodeFlagPayload(profileId: number, reply: Uint8Array): boolean | null {
  const payload = reply.subarray(6);
  if (payload[0] !== profileId) return null;
  const value = payload[1];
  return value === 0 || value === 1 ? value === 1 : null;
}

/** The package targets ES2022, whose lib has no `Promise.withResolvers`. */
function hitscanXviDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
