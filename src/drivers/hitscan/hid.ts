import type { MouseStatus } from "../mouse-types.ts";
import {
  HITSCAN_REPORT_ID, HITSCAN_PAYLOAD_LENGTH, HITSCAN_COMMAND, HITSCAN_CONFIG_LENGTH,
  HITSCAN_VENDOR_ID, HITSCAN_PRODUCTS, HITSCAN_MODELS, HITSCAN_ADDRESS, HITSCAN_SETTING_ADDRESS,
  HITSCAN_3395_DPI_VALUES, HITSCAN_DEBOUNCE_MAX_MS, HITSCAN_LIFT_OFF_MILLIMETRES,
  HITSCAN_BUTTON_NAMES, HITSCAN_BUTTON_OPTIONS,
  HitscanConfig,
  hitscanChecksumIsValid, hitscanMatchesResponse, hitscanParseReadResponse,
  hitscanBuildCommand, hitscanBuildReadChunks, hitscanBuildWriteChunks,
  hitscanEncodeRecord, hitscanEncodeScalar, hitscanEncodePollingRate, hitscanDecodePollingRate,
  hitscanEncode3395Dpi, hitscanDecode3395Dpi, hitscanDecodeLiftOff, hitscanPollingRatesFor,
  hitscanEncodeButton, hitscanDecodeButton, hitscanButtonActionForLabel, hitscanButtonLabel,
  hitscanDecodeBattery, hitscanDecodeVersion, hitscanFormatVersion,
} from "@openmouse/protocol/hitscan";

export interface HitscanClientOptions {
  replyTimeoutMs?: number;
  attempts?: number;
  /** Unsolicited command 0x0a; receives the 16-byte body without report ID. */
  onNotification?: (payload: Uint8Array) => void;
}

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;
type Flag = "motionSync" | "angleSnapping" | "rippleControl";

/** Every shipped model profile (MID 1 and 2) is the same 3395 configuration. */
const MODEL = HITSCAN_MODELS.get(1)!;
const STAGE_STRIDE = 4;
const LIFT_OFF_STOPS: Readonly<Record<1 | 2, LiftOffDistance>> = { 1: "Low", 2: "High" };

/**
 * Native utility transport: WriteFile/ReadFile, report 8, 16-byte bodies.
 * Uses output reports and input events. It does not use feature reports.
 * See docs/hitscan/HID-COMMANDS.md and the linked static-analysis evidence.
 *
 * Settings are checksummed records in a flash image, so every setter writes
 * one record and reads it back. Only settings whose meaning was traced to a
 * named UI handler in Hitscan Utility 1.0.2 are exposed; sleep, sensor mode
 * and the LED fields stay raw. Nothing here has run on hardware yet.
 */
export class HitscanHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private opening: Promise<void> | null = null;
  private disposed = false;
  private listening = false;
  private pending: { request: Uint8Array; resolve: (reply: Uint8Array) => void; reject: (error: Error) => void } | null = null;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly notify?: (payload: Uint8Array) => void;
  private lastStatus: MouseStatus | null = null;
  private firmware: string | null = null;

  constructor(device: HIDDevice, options: HitscanClientOptions = {}) {
    this.device = device;
    this.timeoutMs = options.replyTimeoutMs ?? 100;
    this.attempts = options.attempts ?? 3;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError("Invalid Hitscan timeout.");
    if (!Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 5) throw new RangeError("Invalid Hitscan attempt count.");
    this.notify = options.onNotification;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== HITSCAN_VENDOR_ID || !HITSCAN_PRODUCTS.has(device.productId)) return false;
    const hasReport = (reports: readonly HIDReportInfo[]): boolean => reports.some(report =>
      report.reportId === HITSCAN_REPORT_ID && report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) === 128);
    const find = (collections: readonly HIDCollectionInfo[]): boolean => collections.some(collection =>
      (hasReport(collection.inputReports) && hasReport(collection.outputReports)) || find(collection.children));
    return find(device.collections);
  }

  private readonly onInput = (event: HIDInputReportEvent): void => {
    if (event.reportId !== HITSCAN_REPORT_ID || event.device !== this.device) return;
    const reply = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice();
    if (!hitscanChecksumIsValid(reply)) return;
    if (reply[0] === 0x0a) { this.notify?.(reply); return; }
    const pending = this.pending;
    if (!pending || !hitscanMatchesResponse(pending.request, reply)) return;
    if (pending.request[0] === HITSCAN_COMMAND.read && !hitscanParseReadResponse(
      reply, (pending.request[2]! << 8) | pending.request[3]!, pending.request[4]!,
    )) return;
    pending.resolve(reply);
  };

  /** Memoized so close() can wait for an open that is still in flight. */
  open(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("The Hitscan client is closed."));
    this.opening ??= this.openOnce().catch((error: unknown) => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  private async openOnce(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    // close() may have run while device.open() was pending.
    if (this.disposed) throw new Error("The Hitscan client is closed.");
    if (!this.listening) { this.device.addEventListener("inputreport", this.onInput); this.listening = true; }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async exchangeNow(request: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    await this.open();
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 8));
      if (this.disposed) throw new Error("The Hitscan client is closed.");
      // Arm the waiter before sendReport: a device may reply before it resolves.
      const reply = new Promise<Uint8Array>((resolve, reject) => {
        const finish = (result: Uint8Array | Error): void => {
          clearTimeout(timer);
          this.pending = null;
          if (result instanceof Error) reject(result); else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error("The Hitscan device did not answer.")), this.timeoutMs);
        this.pending = { request, resolve: value => finish(value), reject: error => finish(error) };
      });
      // Attach immediately so a timeout during sendReport cannot reject unhandled.
      const outcome = reply.then(value => ({ value }), error => ({ error }));
      try { await this.device.sendReport(HITSCAN_REPORT_ID, request); }
      catch (error) {
        this.pending?.reject(error instanceof Error ? error : new Error(String(error)));
        await outcome;
        throw error;
      }
      const result = await outcome;
      if ("value" in result) return result.value;
      if (this.disposed || attempt === this.attempts - 1) throw result.error;
    }
    throw new Error("Hitscan exchange failed.");
  }

  /** Serializes commands; input and output exclude the Windows report-ID byte. */
  exchange(payload: Uint8Array): Promise<Uint8Array> {
    if (payload.length !== HITSCAN_PAYLOAD_LENGTH || !hitscanChecksumIsValid(payload)) throw new Error("Invalid Hitscan request.");
    const request = Uint8Array.from(payload);
    return this.run(() => this.exchangeNow(request));
  }

  private async readNow(address: number, length: number): Promise<Uint8Array> {
    const packets = hitscanBuildReadChunks(address, length);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const request of packets) {
      const chunkAddress = (request[2]! << 8) | request[3]!;
      const reply = await this.exchangeNow(request);
      const chunk = hitscanParseReadResponse(reply, chunkAddress, request[4]!);
      if (!chunk) throw new Error(`Invalid Hitscan flash reply at ${chunkAddress}.`);
      result.set(chunk, offset); offset += chunk.length;
    }
    return result;
  }

  readFlash(address: number, length: number): Promise<Uint8Array> {
    hitscanBuildReadChunks(address, length); // Validate before queueing.
    return this.run(() => this.readNow(address, length));
  }

  private async writeNow(address: number, data: Uint8Array<ArrayBuffer>): Promise<void> {
    for (const request of hitscanBuildWriteChunks(address, data)) await this.exchangeNow(request);
    const readback = await this.readNow(address, data.length);
    if (readback.some((value, index) => value !== data[index])) throw new Error("The Hitscan device did not retain the requested bytes.");
  }

  /** Write only the caller-selected range; require echo and readback verification. */
  writeFlash(address: number, data: Uint8Array): Promise<void> {
    const copy = Uint8Array.from(data);
    hitscanBuildWriteChunks(address, copy); // Validate before queueing.
    return this.run(() => this.writeNow(address, copy));
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.lastStatus = null;
    this.pending?.reject(new Error("The Hitscan client is closed."));
    await this.opening?.catch(() => undefined);
    this.opening = null;
    await this.queue;
    if (this.listening) this.device.removeEventListener("inputreport", this.onInput);
    this.listening = false;
    if (this.device.opened) await this.device.close();
  }

  /**
   * Command 0x0a arrives unsolicited, but its bits are not decoded yet, so the
   * app stays on its polling path.
   */
  async startNotifications(): Promise<boolean> {
    return false;
  }

  private transport(): "wired" | "receiver" | "8k-receiver" {
    return HITSCAN_PRODUCTS.get(this.device.productId)?.transport ?? "wired";
  }

  displayName(): string {
    return this.device.productName || "Hitscan mouse";
  }

  deviceBrand(): MouseStatus["brand"] {
    return "Hitscan";
  }

  isWireless(): boolean {
    return this.transport() !== "wired";
  }

  maxDpi(): number {
    return MODEL.maxDpi;
  }

  /** Above 4050 the encoder moves in 100-DPI steps, so the list is not a plain range. */
  getDpiOptions(): number[] {
    return [...HITSCAN_3395_DPI_VALUES];
  }

  getSupportedPollingRates(): number[] {
    return [...hitscanPollingRatesFor(this.transport())];
  }

  getDebounceMaxMs(): number {
    return HITSCAN_DEBOUNCE_MAX_MS;
  }

  readStatus(live = false): Promise<MouseStatus> {
    return this.run(async () => {
      if (live && this.lastStatus) return await this.readLiveStatus(this.lastStatus);
      const config = new HitscanConfig(await this.readNow(0, HITSCAN_CONFIG_LENGTH));
      const battery = await this.readBattery();
      if (this.firmware === null) {
        const version = await this.exchangeNow(hitscanBuildCommand(HITSCAN_COMMAND.firmware))
          .then(reply => hitscanDecodeVersion(reply), () => null);
        this.firmware = version === null ? "Firmware unavailable" : `Mouse ${hitscanFormatVersion(version)}`;
      }

      const pollingRaw = config.scalar(HITSCAN_SETTING_ADDRESS.pollingRate);
      const stageCount = Math.min(Math.max(config.scalar(HITSCAN_SETTING_ADDRESS.dpiStageCount) ?? 1, 1), MODEL.maxDpiStages);
      const stageIndex = Math.min(config.scalar(HITSCAN_SETTING_ADDRESS.activeDpiStage) ?? 0, stageCount - 1);
      const stages: number[] = [];
      const colors: string[] = [];
      for (let stage = 0; stage < stageCount; stage++) {
        const record = config.dpiStage(stage);
        const dpi = record ? hitscanDecode3395Dpi(record) : null;
        // Each stage carries its own checksum; reporting a made-up value for a
        // corrupt or unequal-axis record would hide that from the user.
        if (dpi === null) throw new Error(`The mouse returned an unrecognized DPI stage ${stage + 1}.`);
        stages.push(dpi);
        const color = config.dpiColor(stage);
        colors.push(color ? `#${[...color].map(value => value.toString(16).padStart(2, "0")).join("")}` : "#ffffff");
      }

      const liftOffCode = hitscanDecodeLiftOff(config.scalar(HITSCAN_SETTING_ADDRESS.liftOffDistance) ?? 0);
      const flag = (address: number): boolean | null => {
        const value = config.scalar(address);
        return value === 0 || value === 1 ? value === 1 : null;
      };

      const buttonMappings: Record<string, string> = {};
      const fixedButtons: string[] = ["Left"];
      HITSCAN_BUTTON_NAMES.forEach((name, index) => {
        const record = config.button(index);
        const action = record ? hitscanDecodeButton(record) : null;
        buttonMappings[name] = action ? hitscanButtonLabel(action) : "Unknown";
        if (name !== "Left" && (!action || !hitscanButtonActionForLabel(buttonMappings[name]))) fixedButtons.push(name);
      });

      const wireless = this.isWireless();
      return this.lastStatus = {
        brand: this.deviceBrand(),
        name: this.displayName(),
        ui: {
          family: "hitscan",
          hideUnsupportedPollingRates: true,
          hideSignalCard: true,
          hideSleepCard: true,
          showAdvancedSection: true,
          ...(wireless ? { forceShowBattery: true } : {}),
          statusNote: "Hitscan support was recovered from the vendor utility and has not been tested on hardware yet.",
          dpiStageEditor: {
            maxStages: MODEL.maxDpiStages,
            countEditable: true,
            minDpi: MODEL.minDpi,
            maxDpi: MODEL.maxDpi,
            stepDpi: MODEL.dpiStep,
          },
        },
        batteryPercent: battery?.percent ?? null,
        batteryVoltageMv: battery?.millivolts ?? null,
        batteryState: battery ? (battery.charging ? "Charging" : "Discharging") : "Unknown",
        dpi: stages[stageIndex]!,
        dpiStages: stages,
        dpiStageColors: colors,
        activeDpiStage: stageIndex,
        pollingRateHz: (pollingRaw === null ? null : hitscanDecodePollingRate(pollingRaw)) ?? this.getSupportedPollingRates()[3]!,
        supportedPollingRates: this.getSupportedPollingRates(),
        activeProfile: null,
        connectionType: wireless ? "Wireless" : "Wired",
        connectionDetail: wireless ? (this.transport() === "8k-receiver" ? "8K receiver" : "2.4 GHz receiver") : "Wired USB",
        debounceMs: config.scalar(HITSCAN_SETTING_ADDRESS.debounce),
        liftOffDistance: liftOffCode === null ? null : LIFT_OFF_STOPS[liftOffCode],
        supportedLiftOffDistances: ["Low", "High"],
        liftOffScale: liftOffCode === null ? null : this.liftOffScale(liftOffCode),
        motionSync: flag(HITSCAN_SETTING_ADDRESS.motionSync),
        angleSnapping: flag(HITSCAN_SETTING_ADDRESS.angleSnapping),
        rippleControl: flag(HITSCAN_SETTING_ADDRESS.rippleControl),
        buttonMappings,
        fixedButtons,
        buttonOptions: HITSCAN_BUTTON_OPTIONS.map(([label]) => label),
        firmware: [this.firmware],
      };
    });
  }

  private async readLiveStatus(previous: MouseStatus): Promise<MouseStatus> {
    const battery = await this.readBattery();
    // The DPI and polling buttons change these without telling the client.
    const head = await this.readHead();
    const stages = previous.dpiStages ?? [];
    const stageIndex = head.scalar(HITSCAN_SETTING_ADDRESS.activeDpiStage);
    const pollingRaw = head.scalar(HITSCAN_SETTING_ADDRESS.pollingRate);
    const dpi = stageIndex === null ? undefined : stages[stageIndex];
    return this.lastStatus = {
      ...previous,
      batteryPercent: battery?.percent ?? null,
      batteryVoltageMv: battery?.millivolts ?? null,
      batteryState: battery ? (battery.charging ? "Charging" : "Discharging") : "Unknown",
      pollingRateHz: (pollingRaw === null ? null : hitscanDecodePollingRate(pollingRaw)) ?? previous.pollingRateHz,
      ...(dpi === undefined ? {} : { activeDpiStage: stageIndex!, dpi }),
    };
  }

  /** Polling rate, stage count and active stage: the first three records. */
  private async readHead(): Promise<HitscanConfig> {
    const padded = new Uint8Array(HITSCAN_CONFIG_LENGTH);
    padded.set(await this.readNow(0, HITSCAN_SETTING_ADDRESS.activeDpiStage + 2));
    return new HitscanConfig(padded);
  }

  /** Unqueued: callers hold the queue. A corrupt record fails rather than guessing stage 1. */
  private async readActiveStage(): Promise<number> {
    const stage = (await this.readHead()).scalar(HITSCAN_SETTING_ADDRESS.activeDpiStage);
    if (stage === null) throw new Error("The mouse returned a corrupt active DPI stage.");
    return stage;
  }

  /**
   * Wireless only. The reply layout is inferred from CompX, so an unanswered
   * or unrecognized query reports an unknown battery instead of failing the read.
   */
  private async readBattery(): Promise<ReturnType<typeof hitscanDecodeBattery>> {
    if (!this.isWireless()) return null;
    return await this.exchangeNow(hitscanBuildCommand(HITSCAN_COMMAND.battery))
      .then(reply => hitscanDecodeBattery(reply), () => null);
  }

  private liftOffScale(code: 1 | 2): NonNullable<MouseStatus["liftOffScale"]> {
    return {
      value: code, min: 1, max: 2,
      millimetres: HITSCAN_LIFT_OFF_MILLIMETRES[code - 1]!,
      minMillimetres: HITSCAN_LIFT_OFF_MILLIMETRES[0], maxMillimetres: HITSCAN_LIFT_OFF_MILLIMETRES[1],
      millimetresByCode: [...HITSCAN_LIFT_OFF_MILLIMETRES],
    };
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  /** Writes one checksummed scalar record; writeNow verifies the read-back. */
  private async writeScalar(address: number, value: number): Promise<void> {
    await this.writeNow(address, hitscanEncodeScalar(value));
  }

  setPollingRate(pollingRateHz: number): Promise<number> {
    return this.run(async () => {
      if (!this.getSupportedPollingRates().includes(pollingRateHz)) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
      await this.writeScalar(HITSCAN_SETTING_ADDRESS.pollingRate, hitscanEncodePollingRate(pollingRateHz));
      this.patch({ pollingRateHz });
      return pollingRateHz;
    });
  }

  setDpi(dpi: number): Promise<number> {
    return this.run(async () => {
      // The DPI button moves the active stage without telling the client, so
      // the cached index may already be stale.
      const stage = await this.readActiveStage();
      this.patch({ activeDpiStage: stage });
      return await this.writeStage(stage, dpi);
    });
  }

  setDpiStageValue(stage: number, dpi: number): Promise<number> {
    return this.run(() => this.writeStage(stage, dpi));
  }

  private async writeStage(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= MODEL.maxDpiStages) throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
    if (!HITSCAN_3395_DPI_VALUES.includes(dpi)) {
      throw new Error(`DPI must be ${MODEL.minDpi}–4,050 in 50-DPI steps or 4,100–${MODEL.maxDpi.toLocaleString("en-US")} in 100-DPI steps.`);
    }
    const { record, effectiveDpi } = hitscanEncode3395Dpi(dpi);
    await this.writeNow(HITSCAN_ADDRESS.dpiStages + stage * STAGE_STRIDE, record);
    const stages = this.lastStatus?.dpiStages?.slice();
    if (stages && stage < stages.length) stages[stage] = effectiveDpi;
    this.patch({
      ...(stages ? { dpiStages: stages } : {}),
      ...(this.lastStatus?.activeDpiStage === stage ? { dpi: effectiveDpi } : {}),
    });
    return effectiveDpi;
  }

  setActiveDpiStage(stage: number): Promise<number> {
    return this.run(async () => {
      const count = this.lastStatus?.dpiStages?.length
        ?? (await this.readHead()).scalar(HITSCAN_SETTING_ADDRESS.dpiStageCount) ?? 1;
      if (!Number.isInteger(stage) || stage < 0 || stage >= count) throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
      await this.writeScalar(HITSCAN_SETTING_ADDRESS.activeDpiStage, stage);
      const dpi = this.lastStatus?.dpiStages?.[stage];
      this.patch({ activeDpiStage: stage, ...(dpi === undefined ? {} : { dpi }) });
      return stage;
    });
  }

  setDpiStageCount(count: number): Promise<number> {
    return this.run(async () => {
      if (!Number.isInteger(count) || count < 1 || count > MODEL.maxDpiStages) {
        throw new Error(`This mouse supports between 1 and ${MODEL.maxDpiStages} DPI stages.`);
      }
      const active = await this.readActiveStage();
      // The stage list changes shape; the next read rebuilds it.
      this.lastStatus = null;
      // The utility rejects an active index at or past the count, so move it first.
      if (active >= count) await this.writeScalar(HITSCAN_SETTING_ADDRESS.activeDpiStage, count - 1);
      await this.writeScalar(HITSCAN_SETTING_ADDRESS.dpiStageCount, count);
      return count;
    });
  }

  setDpiStageColor(stage: number, color: string): Promise<string> {
    return this.run(async () => {
      if (!Number.isInteger(stage) || stage < 0 || stage >= MODEL.maxDpiStages) throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
      const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
      if (!match) throw new Error(`${color} is not a #rrggbb colour.`);
      const hex = match[1]!.toLowerCase();
      const rgb = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
      await this.writeNow(HITSCAN_ADDRESS.dpiColors + stage * STAGE_STRIDE, hitscanEncodeRecord(rgb));
      const colors = this.lastStatus?.dpiStageColors?.slice();
      if (colors && stage < colors.length) { colors[stage] = `#${hex}`; this.patch({ dpiStageColors: colors }); }
      return `#${hex}`;
    });
  }

  setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    const code = value === "Low" ? 1 : value === "High" ? 2 : null;
    if (code === null) return Promise.reject(new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`));
    return this.setLiftOffScale(code).then(() => value);
  }

  setLiftOffScale(code: number): Promise<number> {
    return this.run(async () => {
      const known = hitscanDecodeLiftOff(code);
      if (known === null) throw new Error("Lift-off must be code 1 (1 mm) or 2 (2 mm).");
      await this.writeScalar(HITSCAN_SETTING_ADDRESS.liftOffDistance, known);
      this.patch({ liftOffDistance: LIFT_OFF_STOPS[known], liftOffScale: this.liftOffScale(known) });
      return known;
    });
  }

  setDebounceTime(milliseconds: number): Promise<number> {
    return this.run(async () => {
      if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > HITSCAN_DEBOUNCE_MAX_MS) {
        throw new Error(`Debounce must be a whole number of milliseconds between 0 and ${HITSCAN_DEBOUNCE_MAX_MS}.`);
      }
      await this.writeScalar(HITSCAN_SETTING_ADDRESS.debounce, milliseconds);
      this.patch({ debounceMs: milliseconds });
      return milliseconds;
    });
  }

  setMotionSync(enabled: boolean): Promise<boolean> {
    return this.setFlag(HITSCAN_SETTING_ADDRESS.motionSync, "motionSync", enabled);
  }

  setAngleSnapping(enabled: boolean): Promise<boolean> {
    return this.setFlag(HITSCAN_SETTING_ADDRESS.angleSnapping, "angleSnapping", enabled);
  }

  setRippleControl(enabled: boolean): Promise<boolean> {
    return this.setFlag(HITSCAN_SETTING_ADDRESS.rippleControl, "rippleControl", enabled);
  }

  private setFlag(address: number, field: Flag, enabled: boolean): Promise<boolean> {
    return this.run(async () => {
      await this.writeScalar(address, enabled ? 1 : 0);
      this.patch({ [field]: enabled });
      return enabled;
    });
  }

  /**
   * Only the named actions are written. Shortcut and macro records are tied
   * to storage the utility associates with each physical button, so a button
   * carrying one is reported in `fixedButtons` instead of being overwritten.
   */
  setButtonMapping(button: string, action: string): Promise<void> {
    return this.run(async () => {
      const index = HITSCAN_BUTTON_NAMES.indexOf(button as typeof HITSCAN_BUTTON_NAMES[number]);
      if (index < 0) throw new Error(`This mouse has no ${button} button.`);
      if (index === 0) throw new Error("The left button cannot be remapped.");
      const decoded = hitscanButtonActionForLabel(action);
      if (!decoded) throw new Error(`${action} is not an action this mouse accepts.`);
      await this.writeNow(HITSCAN_ADDRESS.buttons + index * STAGE_STRIDE, hitscanEncodeRecord(hitscanEncodeButton(decoded)));
      const mappings = this.lastStatus?.buttonMappings;
      if (mappings) this.patch({ buttonMappings: { ...mappings, [button]: action } });
    });
  }
}
