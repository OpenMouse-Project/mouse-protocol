import type { MouseStatus } from "../mouse-types.ts";
import {
  LAMZU_ATLANTIS_COMMAND as COMMAND,
  LAMZU_ATLANTIS_FLASH as FLASH,
  LAMZU_ATLANTIS_MAX_DPI as DPI_MAX,
  LAMZU_ATLANTIS_MAX_DPI_STAGES as MAX_STAGES,
  LAMZU_ATLANTIS_MAX_PAYLOAD as MAX_PAYLOAD,
  LAMZU_ATLANTIS_MAX_TIMER_SECONDS as MAX_TIMER_SECONDS,
  LAMZU_ATLANTIS_MIN_DPI as DPI_MIN,
  LAMZU_ATLANTIS_PROFILE_COUNT as PROFILE_COUNT,
  LAMZU_ATLANTIS_REPORT_ID as REPORT_ID,
  LAMZU_ATLANTIS_SLEEP_OPTIONS as SLEEP_OPTIONS,
  LAMZU_ATLANTIS_STAGE_STRIDE as STAGE_STRIDE,
  LAMZU_ATLANTIS_DPI_STEP as DPI_STEP,
  LAMZU_ATLANTIS_TIMER_STEP_SECONDS as TIMER_STEP_SECONDS,
  LAMZU_ATLANTIS_USAGE as CONFIG_USAGE,
  LAMZU_ATLANTIS_USAGE_PAGE as CONFIG_USAGE_PAGE,
  LAMZU_ATLANTIS_WRITE_ACTIVE_PROFILE as WRITE_ACTIVE_PROFILE,
  lamzuAtlantisDecodeBattery,
  lamzuAtlantisDecodeDpiStage,
  lamzuAtlantisDecodeFirmware,
  lamzuAtlantisDecodeLiftOffDistance,
  lamzuAtlantisDecodePollingRate,
  lamzuAtlantisDecodeReply,
  lamzuAtlantisEncodeLiftOffDistance,
  lamzuAtlantisEncodePollingRate,
  lamzuAtlantisEncodeRequest,
  lamzuAtlantisFieldIsIntact,
  lamzuAtlantisProduct,
  lamzuAtlantisSealField,
  type LamzuAtlantisProduct,
} from "@openmouse/protocol/lamzu";
import { pulsarVgnEncodeDpi } from "@openmouse/protocol/pulsar";

const RESPONSE_TIMEOUT_MS = 600;
const RESPONSE_ATTEMPTS = 3;
const DEBOUNCE_MAX_MS = 15;

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

/**
 * Lamzu's Atlantis generation (0x3554), which speaks CompX's report-8
 * interrupt protocol rather than the feature-report page/command protocol the
 * 0x373e and 0x37b0 Lamzu models use. Settings are byte fields in a flash
 * image, so every setter here writes one field and reads it back.
 *
 * The framing and the 50-step DPI encoding are shared with the Pulsar 4K
 * receiver and the VGN and Teevolution units on the same vendor id, and are
 * imported rather than reimplemented. What is Lamzu-specific is the identity,
 * the lift-off encoding, the polling-rate table and the DPI-stage fields —
 * see `../../lamzu/atlantis.ts`.
 */
export class LamzuAtlantisHidClient {
  readonly canDisableSleep = false;

  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private pending: ((body: Uint8Array) => void) | null = null;
  private abortPending: (() => void) | null = null;
  private listener: ((event: HIDInputReportEvent) => void) | null = null;
  private opening: Promise<void> | null = null;
  /** Set by close(), so work already queued gives up instead of reopening. */
  private closed = false;
  private lastStatus: MouseStatus | null = null;
  private firmware: string | null = null;
  /**
   * Y values per stage. MouseStatus carries dpiY only for the active stage, so
   * without this a stage switch would report the new stage's X beside the old
   * stage's Y.
   */
  private stagesY: number[] = [];

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === CONFIG_USAGE_PAGE
        && collection.usage === CONFIG_USAGE
        && collection.outputReports.some((report) => report.reportId === REPORT_ID))
      || collection.children.some(search);
    return lamzuAtlantisProduct(device.vendorId, device.productId) !== undefined
      && device.collections.some(search);
  }

  private product(): LamzuAtlantisProduct | undefined {
    return lamzuAtlantisProduct(this.device.vendorId, this.device.productId);
  }

  /**
   * Memoized: two concurrent reads would otherwise both see a closed device,
   * and the second `device.open()` rejects while both callers go on to attach
   * their own listener, of which `close()` removes one.
   */
  async open(): Promise<void> {
    await this.lifecycle(async () => {
      this.closed = false;
      await this.ensureOpen();
    });
  }

  /**
   * Opens and closes take turns. Overlapping them lets a reopen inspect the
   * device while a close is still mid-flight: it finds the device open and the
   * listener installed, memoizes a resolved promise, and then the close
   * removes that listener — leaving every later open awaiting a promise that
   * will never reinstall anything.
   */
  private async lifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = run.catch(() => undefined);
    return await run;
  }

  /**
   * Opens without clearing `closed`, so an exchange that was already queued
   * when close() ran cannot quietly reopen the device behind the caller.
   */
  private async ensureOpen(): Promise<void> {
    this.opening ??= this.openOnce().catch((error: unknown) => {
      this.opening = null;
      throw error;
    });
    await this.opening;
  }

  private async openOnce(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (this.listener) return;
    this.listener = (event: HIDInputReportEvent) => {
      if (event.reportId !== REPORT_ID || !this.pending) return;
      const view = event.data;
      this.pending(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
    };
    this.device.addEventListener("inputreport", this.listener);
  }

  /**
   * Closing has to cancel, not just tidy up. An exchange waiting on a reply is
   * settled here rather than left to time out and retry, and the generation
   * bump makes anything still queued fail instead of reopening the device
   * behind the caller's back.
   */
  async close(): Promise<void> {
    await this.lifecycle(() => this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.lastStatus = null;
    this.pending = null;
    const abort = this.abortPending;
    this.abortPending = null;
    abort?.();
    const opening = this.opening;
    this.opening = null;
    // A close that lands mid-open must wait for that open to finish, or its
    // listener is installed after this has already removed one.
    await opening?.catch(() => undefined);
    if (this.listener) this.device.removeEventListener("inputreport", this.listener);
    this.listener = null;
    if (this.device.opened) await this.device.close();
  }

  /**
   * No push channel is known on this generation: the only report the config
   * collection carries is 8, which is the request/reply channel, and nothing
   * unsolicited was seen arriving on it while settings were changed in Lamzu's
   * own configurator. Returning false leaves the app on its polling path,
   * which is the honest answer until a notification report turns up.
   */
  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    const known = this.product();
    return known ? `Lamzu ${known.model}` : this.device.productName || "Lamzu";
  }

  deviceBrand(): MouseStatus["brand"] {
    return "Lamzu";
  }

  maxDpi(): number {
    return DPI_MAX;
  }

  getDebounceMaxMs(): number {
    return DEBOUNCE_MAX_MS;
  }

  getSleepOptions(): readonly number[] {
    return SLEEP_OPTIONS;
  }

  getSupportedPollingRates(): number[] {
    return [...(this.product()?.pollingRates ?? [125, 250, 500, 1000])];
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = DPI_MIN; dpi <= DPI_MAX; dpi += DPI_STEP) options.push(dpi);
    return options;
  }

  isWireless(): boolean {
    const known = this.product();
    if (known) return known.wireless;
    return /receiver|dongle/i.test(this.device.productName || "");
  }

  async readStatus(live = false): Promise<MouseStatus> {
    await this.open();
    return await this.transaction(async () => {
      if (live && this.lastStatus) return await this.readLiveStatus(this.lastStatus);

      const battery = lamzuAtlantisDecodeBattery(await this.request(COMMAND.batteryLevel));
      const activeProfile = (await this.request(COMMAND.getCurrentConfig))[0] ?? 0;
      if (this.firmware === null) {
        this.firmware = lamzuAtlantisDecodeFirmware("Mouse", await this.request(COMMAND.readVersionId))
          ?? "Mouse firmware unavailable";
      }

      const pollingRaw = (await this.readField(FLASH.reportRate, 1))[0] ?? 0;
      const stageCount = Math.min((await this.readField(FLASH.dpiStageCount, 1))[0] ?? 1, MAX_STAGES);
      const stageIndex = Math.min((await this.readField(FLASH.currentDpi, 1))[0] ?? 0, Math.max(stageCount - 1, 0));

      const stages: number[] = [];
      const stagesY: number[] = [];
      const colors: string[] = [];
      for (let stage = 0; stage < stageCount; stage += 1) {
        const address = FLASH.dpiValues + stage * STAGE_STRIDE;
        const decoded = lamzuAtlantisDecodeDpiStage(await this.readRaw(address, STAGE_STRIDE));
        // A stage carries its own checksum, so a failed decode means a corrupt
        // read. Reporting a plausible-looking 50 DPI instead would be a lie.
        if (!decoded) throw new Error(`The mouse returned a corrupt DPI stage from address ${address}.`);
        stages.push(decoded.x);
        stagesY.push(decoded.y);
        const color = await this.readField(FLASH.dpiStageColors + stage * STAGE_STRIDE, 3);
        colors.push(`#${[...color].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
      }

      const liftOffRaw = (await this.readField(FLASH.liftOffDistance, 1))[0] ?? 0;
      const debounceMs = (await this.readField(FLASH.debounceTime, 1))[0] ?? 0;
      const sleepRaw = (await this.readField(FLASH.sleepTime, 1))[0] ?? 0;
      const motionSync = (await this.readField(FLASH.motionSync, 1))[0] === 1;
      const angleSnapping = (await this.readField(FLASH.angleSnapping, 1))[0] === 1;
      const rippleControl = (await this.readField(FLASH.rippleControl, 1))[0] === 1;
      const performanceMode = (await this.readField(FLASH.performanceState, 1))[0] === 1;
      const hyperMode = (await this.readField(FLASH.highPerformance, 1))[0] === 1;

      const wireless = this.isWireless();
      this.stagesY = stagesY;
      return this.lastStatus = {
        brand: "Lamzu",
        name: this.displayName(),
        ui: {
          family: "lamzu-atlantis",
          forceShowBattery: true,
          hideUnsupportedPollingRates: true,
          hideSignalCard: true,
          showAdvancedSection: true,
          dpiStageEditor: {
            maxStages: MAX_STAGES,
            countEditable: true,
            minDpi: DPI_MIN,
            maxDpi: DPI_MAX,
            stepDpi: DPI_STEP,
          },
        },
        batteryPercent: battery.percent,
        batteryVoltageMv: battery.millivolts,
        batteryState: battery.charging ? "Charging" : "Discharging",
        dpi: stages[stageIndex] ?? stages[0] ?? DPI_MIN,
        dpiY: stagesY[stageIndex] ?? stagesY[0] ?? DPI_MIN,
        dpiStages: stages,
        dpiStageColors: colors,
        activeDpiStage: stageIndex,
        pollingRateHz: lamzuAtlantisDecodePollingRate(pollingRaw) ?? this.getSupportedPollingRates()[0] ?? 1000,
        supportedPollingRates: this.getSupportedPollingRates(),
        // The profile byte is 0-based on the wire and 1-based in Lamzu's UI.
        activeProfile: activeProfile + 1,
        profileCount: PROFILE_COUNT,
        connectionType: wireless ? "Wireless" : "Wired",
        connectionDetail: wireless ? "2.4 GHz receiver" : "Wired USB",
        debounceMs,
        sleepTimeout: sleepRaw > 0 ? sleepRaw * TIMER_STEP_SECONDS : null,
        liftOffDistance: lamzuAtlantisDecodeLiftOffDistance(liftOffRaw),
        motionSync,
        angleSnapping,
        rippleControl,
        performanceMode,
        hyperMode,
        firmware: [this.firmware],
      };
    });
  }

  private async readLiveStatus(previous: MouseStatus): Promise<MouseStatus> {
    const battery = lamzuAtlantisDecodeBattery(await this.request(COMMAND.batteryLevel));
    const pollingRaw = (await this.readField(FLASH.reportRate, 1))[0] ?? 0;
    return this.lastStatus = {
      ...previous,
      batteryPercent: battery.percent,
      batteryVoltageMv: battery.millivolts,
      batteryState: battery.charging ? "Charging" : "Discharging",
      pollingRateHz: lamzuAtlantisDecodePollingRate(pollingRaw) ?? previous.pollingRateHz,
    };
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    return await this.transaction(async () => {
      const supported = this.getSupportedPollingRates();
      const encoded = lamzuAtlantisEncodePollingRate(pollingRateHz, this.product()?.rateFamily ?? "wired");
      if (encoded === null || !supported.includes(pollingRateHz)) {
        throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
      }
      const confirmed = lamzuAtlantisDecodePollingRate(await this.writeByte(FLASH.reportRate, encoded));
      if (confirmed !== pollingRateHz) {
        throw new Error(`The mouse kept ${confirmed ?? "an unknown rate"} instead of ${pollingRateHz} Hz.`);
      }
      this.patch({ pollingRateHz: confirmed });
      return confirmed;
    });
  }

  async setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    return await this.transaction(async () => {
      const encoded = lamzuAtlantisEncodeLiftOffDistance(value);
      if (encoded === null) {
        throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
      }
      const confirmed = lamzuAtlantisDecodeLiftOffDistance(await this.writeByte(FLASH.liftOffDistance, encoded));
      if (confirmed !== value) {
        throw new Error(`The mouse kept a ${String(confirmed).toLowerCase()} lift-off distance instead of ${value.toLowerCase()}.`);
      }
      this.patch({ liftOffDistance: confirmed });
      return confirmed;
    });
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    return await this.transaction(async () => {
      if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > DEBOUNCE_MAX_MS) {
        throw new Error(`Debounce must be a whole number of milliseconds between 0 and ${DEBOUNCE_MAX_MS}.`);
      }
      const confirmed = await this.writeByte(FLASH.debounceTime, milliseconds);
      if (confirmed !== milliseconds) {
        throw new Error(`The mouse kept ${confirmed} ms of debounce instead of ${milliseconds} ms.`);
      }
      this.patch({ debounceMs: confirmed });
      return confirmed;
    });
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    return await this.transaction(async () => {
      if (!Number.isInteger(seconds)
        || seconds < TIMER_STEP_SECONDS
        || seconds > MAX_TIMER_SECONDS
        || seconds % TIMER_STEP_SECONDS !== 0) {
        throw new Error(`The sleep timeout must be a whole number of ${TIMER_STEP_SECONDS}-second steps up to ${MAX_TIMER_SECONDS} seconds.`);
      }
      const confirmed = (await this.writeByte(FLASH.sleepTime, seconds / TIMER_STEP_SECONDS)) * TIMER_STEP_SECONDS;
      if (confirmed !== seconds) {
        throw new Error(`The mouse kept a ${confirmed} second sleep timeout instead of ${seconds} seconds.`);
      }
      this.patch({ sleepTimeout: confirmed });
      return confirmed;
    });
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return await this.setFlag(FLASH.motionSync, enabled, "motionSync", "Motion Sync");
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return await this.setFlag(FLASH.angleSnapping, enabled, "angleSnapping", "angle snapping");
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return await this.setFlag(FLASH.rippleControl, enabled, "rippleControl", "ripple control");
  }

  async setPerformanceMode(enabled: boolean): Promise<boolean> {
    return await this.setFlag(FLASH.performanceState, enabled, "performanceMode", "competition mode");
  }

  async setHyperMode(enabled: boolean): Promise<boolean> {
    return await this.setFlag(FLASH.highPerformance, enabled, "hyperMode", "high performance");
  }

  async setDpi(dpi: number): Promise<number> {
    return await this.transaction(async () => {
      const stage = this.lastStatus?.activeDpiStage
        ?? (await this.readField(FLASH.currentDpi, 1))[0]
        ?? 0;
      return await this.writeStage(stage, dpi);
    });
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    return await this.transaction(() => this.writeStage(stage, dpi));
  }

  private async writeStage(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= MAX_STAGES) {
      throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
    }
    const address = FLASH.dpiValues + stage * STAGE_STRIDE;
    // pulsarVgnEncodeDpi returns the stage's four bytes with its checksum
    // already in place, so this writes them as-is rather than re-sealing.
    // It writes one value to both axes, so a stage Lamzu's own app had set to
    // separate x and y is flattened here; asymmetric writes are not attempted
    // without hardware to confirm the flags layout for them.
    await this.write(address, [...pulsarVgnEncodeDpi(dpi)]);
    const stored = lamzuAtlantisDecodeDpiStage(await this.readRaw(address, STAGE_STRIDE));
    const confirmed = stored?.x ?? null;
    if (confirmed !== dpi) {
      throw new Error(`The mouse kept ${confirmed?.toLocaleString() ?? "an unknown DPI"} instead of ${dpi.toLocaleString()}.`);
    }
    const stages = this.lastStatus?.dpiStages?.slice();
    if (stages && stage < stages.length) stages[stage] = confirmed;
    // The encoder wrote one value to both axes, so Y moved with X.
    if (stage < this.stagesY.length) this.stagesY[stage] = confirmed;
    this.patch({
      ...(stages ? { dpiStages: stages } : {}),
      ...(this.lastStatus?.activeDpiStage === stage ? { dpi: confirmed, dpiY: confirmed } : {}),
    });
    return confirmed;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    return await this.transaction(async () => {
      const count = (await this.readField(FLASH.dpiStageCount, 1))[0] ?? 1;
      if (!Number.isInteger(stage) || stage < 0 || stage >= count) {
        throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
      }
      const confirmed = await this.writeByte(FLASH.currentDpi, stage);
      if (confirmed !== stage) {
        throw new Error(`The mouse stayed on DPI stage ${confirmed + 1} instead of ${stage + 1}.`);
      }
      // Both axes belong to the newly selected stage; carrying the old Y over
      // would report this stage's X beside the previous stage's Y.
      this.patch({
        activeDpiStage: confirmed,
        ...(this.lastStatus?.dpiStages?.[confirmed] !== undefined
          ? { dpi: this.lastStatus.dpiStages[confirmed] }
          : {}),
        ...(this.stagesY[confirmed] !== undefined ? { dpiY: this.stagesY[confirmed] } : {}),
      });
      return confirmed;
    });
  }

  async setDpiStageCount(count: number): Promise<number> {
    return await this.transaction(async () => {
      if (!Number.isInteger(count) || count < 1 || count > MAX_STAGES) {
        throw new Error(`This mouse supports between 1 and ${MAX_STAGES} DPI stages.`);
      }
      // Dropped before the write, not after: if the verification read fails
      // the mouse has still changed, and a cache kept through that failure
      // would describe a stage list that no longer exists.
      this.lastStatus = null;
      this.stagesY = [];
      const confirmed = await this.writeByte(FLASH.dpiStageCount, count);
      if (confirmed !== count) {
        throw new Error(`The mouse kept ${confirmed} DPI stages instead of ${count}.`);
      }
      // Dropping stages can strand the active index past the end of the list.
      const active = (await this.readField(FLASH.currentDpi, 1))[0] ?? 0;
      if (active >= confirmed) await this.writeByte(FLASH.currentDpi, confirmed - 1);
      return confirmed;
    });
  }

  async setDpiStageColor(stage: number, color: string): Promise<string> {
    return await this.transaction(async () => {
      // Without this bound the stage index scales straight into a flash address:
      // stage -8 lands on the DPI stages at 12, stage 13 on the button actions
      // at 96, and the colour reads back cleanly from wherever it landed.
      if (!Number.isInteger(stage) || stage < 0 || stage >= MAX_STAGES) {
        throw new Error(`This mouse has no DPI stage ${stage + 1}.`);
      }
      const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
      if (!match) throw new Error(`${color} is not a #rrggbb colour.`);
      const wanted = match[1]!.toLowerCase();
      const address = FLASH.dpiStageColors + stage * STAGE_STRIDE;
      await this.writeField(address, [0, 2, 4].map((offset) => Number.parseInt(wanted.slice(offset, offset + 2), 16)));
      const stored = await this.readField(address, 3);
      const confirmed = `#${[...stored].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
      if (confirmed !== `#${wanted}`) throw new Error(`The mouse kept ${confirmed} instead of #${wanted}.`);
      const colors = this.lastStatus?.dpiStageColors?.slice();
      if (colors && stage < colors.length) colors[stage] = confirmed;
      if (colors) this.patch({ dpiStageColors: colors });
      return confirmed;
    });
  }

  async setProfile(profile: number): Promise<number> {
    return await this.transaction(async () => {
      if (!Number.isInteger(profile) || profile < 1 || profile > PROFILE_COUNT) {
        throw new Error(`This mouse has profiles 1 to ${PROFILE_COUNT}.`);
      }
      // Every cached field — DPI stages, colours, active stage, the toggles —
      // describes the profile we are leaving, and setDpi trusts the cached
      // active stage. Dropped before the write, so a failed verification read
      // cannot leave the old profile's settings looking current.
      this.lastStatus = null;
      this.stagesY = [];
      await this.request(WRITE_ACTIVE_PROFILE, 0, [profile - 1]);
      const confirmed = ((await this.request(COMMAND.getCurrentConfig))[0] ?? 0) + 1;
      if (confirmed !== profile) {
        throw new Error(`The mouse stayed on profile ${confirmed} instead of ${profile}.`);
      }
      return confirmed;
    });
  }

  private async setFlag(
    address: number,
    enabled: boolean,
    field: "motionSync" | "angleSnapping" | "rippleControl" | "performanceMode" | "hyperMode",
    label: string,
  ): Promise<boolean> {
    return await this.transaction(async () => {
      const confirmed = (await this.writeByte(address, enabled ? 1 : 0)) === 1;
      if (confirmed !== enabled) throw new Error(`The mouse left ${label} ${confirmed ? "on" : "off"}.`);
      this.patch({ [field]: confirmed });
      return confirmed;
    });
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  /**
   * Writes one field byte and returns what the mouse reports afterwards. The
   * write and its read-back are one transaction: interleaved with another
   * setter for the same field, this would otherwise read the other value back
   * and report a failure the mouse never made.
   */
  private async writeByte(address: number, value: number): Promise<number> {
    await this.writeField(address, [value]);
    return (await this.readField(address, 1))[0] ?? 0;
  }

  private async writeField(address: number, values: readonly number[]): Promise<void> {
    await this.write(address, lamzuAtlantisSealField([...values]));
  }

  private async write(address: number, bytes: readonly number[]): Promise<void> {
    await this.exchange(COMMAND.writeFlashData, address, bytes);
  }

  /**
   * Reads a flash field together with the checksum byte stored after it, and
   * refuses the value unless the pair checksums out.
   */
  private async readField(address: number, length: number): Promise<Uint8Array> {
    const field = await this.readRaw(address, length + 1);
    if (!lamzuAtlantisFieldIsIntact(field)) {
      throw new Error(`The mouse returned a corrupt value from address ${address}.`);
    }
    return field.subarray(0, length);
  }

  private async readRaw(address: number, length: number): Promise<Uint8Array> {
    if (length > MAX_PAYLOAD) throw new Error("A CompX flash read spans at most 10 bytes.");
    const payload = await this.exchange(COMMAND.readFlashData, address, new Array(length).fill(0));
    return payload.subarray(0, length);
  }

  /**
   * Serializes a whole public operation, not a single packet.
   *
   * Queueing per exchange is not enough: a setter is a write followed by a
   * read-back, and two concurrent setters for the same field would interleave
   * as write(a), write(b), read(b), read(b) — the first setter then throws
   * about a value the mouse did accept.
   *
   * Every public method holds this exactly once and works through the
   * unqueued helpers below it, so there is no reentrancy to detect. An
   * "am I nested?" flag cannot work here: it says only that *someone* owns
   * the lock, so an unrelated caller arriving mid-operation would read it as
   * nesting, run inline, and overwrite the in-flight exchange's reply
   * callback.
   */
  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return await run;
  }

  /** Unqueued: the caller already holds the transaction lock. */
  private async request(command: number, address = 0, payload: readonly number[] = []): Promise<Uint8Array> {
    return await this.exchange(command, address, payload);
  }

  private async exchange(command: number, address: number, payload: readonly number[]): Promise<Uint8Array> {
    if (this.closed) throw new Error("The connection to the mouse was closed.");
    await this.ensureOpen();
    const request = lamzuAtlantisEncodeRequest({ command, address, payload });
    for (let attempt = 0; attempt < RESPONSE_ATTEMPTS; attempt += 1) {
      if (this.closed) throw new Error("The connection to the mouse was closed.");
      const reply = await this.sendAndWait(request, command, address);
      if (this.closed) throw new Error("The connection to the mouse was closed.");
      if (!reply) continue;
      if (reply.error !== 0) {
        throw new Error(`Command 0x${command.toString(16).padStart(2, "0")} failed with status ${reply.error}.`);
      }
      return reply.payload;
    }
    throw new Error(
      `Command 0x${command.toString(16).padStart(2, "0")} got no answer — the mouse may be asleep or out of range.`,
    );
  }

  /**
   * A reply that does not match is skipped rather than treated as a failure.
   *
   * Matching on the command alone is not enough: every flash access shares
   * command 0x08 (or 0x07), so after a timed-out attempt a late reply would
   * satisfy the *next* request for a different address — a read of the
   * debounce byte could return the motion-sync byte, and a setter's read-back
   * would then verify against the wrong field. Every reply echoes the address
   * it was asked for, so flash replies are matched on it too.
   */
  private async sendAndWait(request: Uint8Array<ArrayBuffer>, command: number, address: number) {
    const addressed = command === COMMAND.readFlashData || command === COMMAND.writeFlashData;
    return await new Promise<ReturnType<typeof lamzuAtlantisDecodeReply>>((resolve) => {
      let settled = false;
      const finish = (value: ReturnType<typeof lamzuAtlantisDecodeReply>) => {
        if (settled) return;
        settled = true;
        this.pending = null;
        this.abortPending = null;
        globalThis.clearTimeout(timer);
        resolve(value);
      };
      const timer = globalThis.setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);
      this.abortPending = () => finish(null);
      this.pending = (body) => {
        const reply = lamzuAtlantisDecodeReply(body);
        if (!reply || reply.command !== command) return;
        if (addressed && reply.address !== address) return;
        finish(reply);
      };
      this.device.sendReport(REPORT_ID, request).catch(() => finish(null));
    });
  }
}
