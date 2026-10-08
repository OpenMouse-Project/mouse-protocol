import type { MouseStatus, MouseUiHints } from "../mouse-types.ts";
import {
  GLORIOUS_CORE2_DEBOUNCE_DEFAULT_MS,
  GLORIOUS_CORE2_DEBOUNCE_MAX_MS,
  GLORIOUS_CORE2_DEBOUNCE_MIN_MS,
  GLORIOUS_CORE2_DEBOUNCE_STEP_MS,
  GLORIOUS_CORE2_DPI_MAX,
  GLORIOUS_CORE2_DPI_MIN,
  GLORIOUS_CORE2_DPI_STEP,
  GLORIOUS_CORE2_FRAME_LENGTH,
  GLORIOUS_CORE2_MAX_DPI_STAGES,
  GLORIOUS_CORE2_POLLING_CODES,
  GLORIOUS_CORE2_PRODUCTS,
  GLORIOUS_CORE2_PROFILE_COUNT,
  GLORIOUS_CORE2_PROFILE_DEFAULT,
  GLORIOUS_CORE2_REPORT_ID,
  GLORIOUS_CORE2_USAGE_PAGE,
  GLORIOUS_CORE2_VENDOR_ID,
  GLORIOUS_CORE2_WIRELESS_MAX_POLLING_HZ,
  decodeGloriousCore2Battery,
  decodeGloriousCore2Firmware,
  encodeGloriousCore2ActiveDpiStage,
  encodeGloriousCore2BatteryRequest,
  encodeGloriousCore2Debounce,
  encodeGloriousCore2DpiColors,
  encodeGloriousCore2DpiStages,
  encodeGloriousCore2FirmwareRequest,
  encodeGloriousCore2MotionSync,
  encodeGloriousCore2PollingRate,
  encodeGloriousCore2Profile,
  type GloriousCore2Battery,
  type GloriousCore2Firmware,
} from "../../glorious-core2/index.ts";

/**
 * Driver for the Glorious Model O 2 PRO 4K/8K, wired (0x258a:0x201b) and
 * through its 2.4 GHz receiver (0x2035). Frames follow Glorious CORE's own
 * traffic and code, see ../../glorious-core2/index.ts and
 * captures/glorious-o2-pro-4k8k-wired/.
 *
 * Only the firmware and battery are readable: CORE never reads a setting back,
 * and no read command for DPI stages, colors, polling rate, debounce, motion
 * sync or the active profile is known. Like the sibling classic driver, this
 * client keeps its own last-written values (localStorage, one set per profile)
 * for the UI to show and reports `valuesVerified: false`.
 *
 * Every setting belongs to one of three onboard profiles and is written with
 * that profile's number. The mouse cannot say which profile is active, so the
 * client assumes profile 1 until the user picks one; picking sends CORE's own
 * profile-select frame, after which writes land in the profile in use.
 *
 * Not offered, for want of evidence: lift-off distance (CORE writes the same
 * value for both of its options), auto sleep, lighting, buttons and macros,
 * and the advanced debounce times.
 */

/** The mouse answers a request after about 60 ms in the capture. */
const REPLY_DELAY_MS = 60;
/** CORE waits this long after each frame, and longer after the active DPI stage. */
const FRAME_GAP_MS = 30;
const ACTIVE_STAGE_GAP_MS = 120;
const PROFILE_SWITCH_GAP_MS = 50;

const FACTORY_STAGE_DPIS = [400, 800, 1600, 3200];
/** CORE's stage colors in the order it hands them out: orange, light blue, red, green, then purple and cyan. */
const STAGE_COLORS = ["#ffa40d", "#26b4ff", "#ff2626", "#18b30a", "#5500ff", "#00ffff"];
const FACTORY_STAGE_COLORS = STAGE_COLORS.slice(0, FACTORY_STAGE_DPIS.length);
/** The factory default level is 1600 DPI, the third stage. */
const FACTORY_ACTIVE_STAGE = 2;
const FACTORY_POLLING_HZ = 1000;

interface GloriousCore2State {
  stageDpis: number[];
  stageColors: string[];
  activeStage: number;
  pollingRateHz: number;
  debounceMs: number;
  motionSync: boolean;
}

function factoryState(): GloriousCore2State {
  return {
    stageDpis: [...FACTORY_STAGE_DPIS],
    stageColors: [...FACTORY_STAGE_COLORS],
    activeStage: FACTORY_ACTIVE_STAGE,
    pollingRateHz: FACTORY_POLLING_HZ,
    debounceMs: GLORIOUS_CORE2_DEBOUNCE_DEFAULT_MS,
    motionSync: true,
  };
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * The DPI a stage added by raising the stage count starts at, given the stages
 * already there (never empty): double the last one, capped at the maximum.
 * That continues 400, 800, 1600, 3200 with 6400 and 12800, which are CORE's own
 * defaults for stages 5 and 6 on the newer Glorious mice. Doubling a multiple of
 * the 50 DPI step stays on the step, and the cap does too.
 */
function newStageDpi(existing: readonly number[]): number {
  return Math.min(existing.at(-1)! * 2, GLORIOUS_CORE2_DPI_MAX);
}

export class GloriousCore2HidClient {
  get pollIntervalMs(): number { return 30_000; }
  readonly device: HIDDevice;
  /** Calls run one at a time: a read is a SET followed by a GET and must not interleave with another. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === GLORIOUS_CORE2_VENDOR_ID
      && GLORIOUS_CORE2_PRODUCTS.has(device.productId)
      && GloriousCore2HidClient.hasConfigReport(device.collections);
  }

  /** The config channel is an unnumbered feature report on usage page 0xffff; the 0xffff decoy on interface 1 has none. */
  private static hasConfigReport(collections: readonly HIDCollectionInfo[]): boolean {
    return collections.some((collection) =>
      (collection.usagePage === GLORIOUS_CORE2_USAGE_PAGE
        && collection.featureReports.some((report) => report.reportId === GLORIOUS_CORE2_REPORT_ID))
      || GloriousCore2HidClient.hasConfigReport(collection.children));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  isWireless(): boolean {
    return GLORIOUS_CORE2_PRODUCTS.get(this.device.productId)?.wireless ?? false;
  }

  displayName(): string {
    return this.device.productName || GLORIOUS_CORE2_PRODUCTS.get(this.device.productId)?.name || "Glorious Model O2 Pro 4K/8K";
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = GLORIOUS_CORE2_DPI_MIN; dpi <= GLORIOUS_CORE2_DPI_MAX; dpi += GLORIOUS_CORE2_DPI_STEP) options.push(dpi);
    return options;
  }

  getDebounceOptions(): number[] {
    const options: number[] = [];
    for (let ms = GLORIOUS_CORE2_DEBOUNCE_MIN_MS; ms <= GLORIOUS_CORE2_DEBOUNCE_MAX_MS; ms += GLORIOUS_CORE2_DEBOUNCE_STEP_MS) options.push(ms);
    return options;
  }

  /** 8000 Hz needs the cable; the receiver stops at 4000 Hz. */
  getSupportedPollingRates(): number[] {
    return GLORIOUS_CORE2_POLLING_CODES
      .map(([hertz]) => hertz)
      .filter((hertz) => !this.isWireless() || hertz <= GLORIOUS_CORE2_WIRELESS_MAX_POLLING_HZ);
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const { firmware, battery } = await this.run(async () => ({
      firmware: await this.readFirmware().catch(() => null),
      battery: await this.readBattery().catch(() => null),
    }));
    const profile = this.loadProfile();
    const state = this.loadState(profile);
    const wireless = this.isWireless();
    return {
      brand: "Glorious",
      name: this.displayName(),
      ui: this.getUiHints(),
      batteryPercent: battery?.percent ?? null,
      batteryState: !battery ? "Unknown" : battery.charging ? "Charging" : battery.percent === 100 ? "Full" : "Discharging",
      dpi: state.stageDpis[state.activeStage] ?? state.stageDpis[0]!,
      dpiStages: state.stageDpis,
      dpiStageColors: state.stageColors,
      activeDpiStage: state.activeStage,
      // A rate remembered from the cable can be 8000 Hz, which the receiver does not offer.
      pollingRateHz: wireless ? Math.min(state.pollingRateHz, GLORIOUS_CORE2_WIRELESS_MAX_POLLING_HZ) : state.pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),
      debounceMs: state.debounceMs,
      motionSync: state.motionSync,
      profileCount: GLORIOUS_CORE2_PROFILE_COUNT,
      activeProfile: profile,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver, up to 4000 Hz" : "USB cable, up to 8000 Hz",
      liftOffDistance: null,
      firmware: firmware ? [wireless ? `Receiver ${firmware.version}` : firmware.version] : [],
    };
  }

  /** Changes the DPI of the active stage. */
  async setDpi(dpi: number): Promise<number> {
    return this.setDpiStageValue(this.loadState(this.loadProfile()).activeStage, dpi);
  }

  /** Writes the whole stage table, so every stage comes from the values shown, then re-selects the active stage. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const profile = this.loadProfile();
    const state = this.loadState(profile);
    this.assertStage(stage, state.stageDpis.length);
    const stageDpis = state.stageDpis.map((value, index) => (index === stage ? dpi : value));
    await this.writeStages(profile, stageDpis, state.activeStage);
    this.saveState(profile, { ...state, stageDpis });
    return dpi;
  }

  /** New stages start at newStageDpi() with the next color of CORE's palette; the active stage moves down when its slot disappears. */
  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > GLORIOUS_CORE2_MAX_DPI_STAGES) {
      throw new Error(`This mouse has 1 to ${GLORIOUS_CORE2_MAX_DPI_STAGES} DPI stages.`);
    }
    const profile = this.loadProfile();
    const state = this.loadState(profile);
    const stageDpis = state.stageDpis.slice(0, count);
    while (stageDpis.length < count) stageDpis.push(newStageDpi(stageDpis));
    const stageColors = Array.from({ length: count }, (_, index) => state.stageColors[index] ?? STAGE_COLORS[index]!);
    const activeStage = Math.min(state.activeStage, count - 1);
    await this.writeStages(profile, stageDpis, activeStage, stageColors);
    this.saveState(profile, { ...state, stageDpis, stageColors, activeStage });
    return count;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const profile = this.loadProfile();
    const state = this.loadState(profile);
    this.assertStage(stage, state.stageDpis.length);
    await this.write([[encodeGloriousCore2ActiveDpiStage(stage, profile), ACTIVE_STAGE_GAP_MS]]);
    this.saveState(profile, { ...state, activeStage: stage });
    return stage;
  }

  async setDpiStageColor(stage: number, color: string): Promise<string> {
    const profile = this.loadProfile();
    const state = this.loadState(profile);
    this.assertStage(stage, state.stageDpis.length);
    const stageColors = state.stageColors.map((value, index) => (index === stage ? color.toLowerCase() : value));
    await this.write([[encodeGloriousCore2DpiColors(stageColors, profile), FRAME_GAP_MS]]);
    this.saveState(profile, { ...state, stageColors });
    return color;
  }

  /**
   * One rate for both links, as CORE sends it. The cable's 8000 Hz pairs with
   * 4000 Hz for the receiver, the most CORE allows there.
   */
  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (!this.getSupportedPollingRates().includes(pollingRateHz)) throw new Error(`This connection does not support ${pollingRateHz} Hz.`);
    const profile = this.loadProfile();
    const wirelessHz = Math.min(pollingRateHz, GLORIOUS_CORE2_WIRELESS_MAX_POLLING_HZ);
    await this.write([[encodeGloriousCore2PollingRate(pollingRateHz, wirelessHz, profile), FRAME_GAP_MS]]);
    this.saveState(profile, { ...this.loadState(profile), pollingRateHz });
    return pollingRateHz;
  }

  /** Simple debounce: also clears the advanced press and release times, as CORE does when its advanced switch is off. */
  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!this.getDebounceOptions().includes(milliseconds)) {
      throw new Error(`Debounce must be ${GLORIOUS_CORE2_DEBOUNCE_MIN_MS} to ${GLORIOUS_CORE2_DEBOUNCE_MAX_MS} ms in steps of ${GLORIOUS_CORE2_DEBOUNCE_STEP_MS}.`);
    }
    const profile = this.loadProfile();
    await this.write([[encodeGloriousCore2Debounce(milliseconds, profile), FRAME_GAP_MS]]);
    this.saveState(profile, { ...this.loadState(profile), debounceMs: milliseconds });
    return milliseconds;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    const profile = this.loadProfile();
    await this.write([[encodeGloriousCore2MotionSync(enabled, profile), FRAME_GAP_MS]]);
    this.saveState(profile, { ...this.loadState(profile), motionSync: enabled });
    return enabled;
  }

  /** Selects the profile on the mouse; from then on writes go to it. 1-based, as in the shell. */
  async setProfile(profile: number): Promise<number> {
    const frame = encodeGloriousCore2Profile(profile);
    await this.write([[frame, PROFILE_SWITCH_GAP_MS]]);
    this.saveProfile(profile);
    return profile;
  }

  private assertStage(stage: number, count: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= count) throw new Error(`DPI stage must be between 1 and ${count}.`);
  }

  private async writeStages(profile: number, stageDpis: number[], activeStage: number, stageColors?: string[]): Promise<void> {
    // Encode everything first so a bad value fails before anything is sent.
    const frames: Array<readonly [Uint8Array<ArrayBuffer>, number]> = [[encodeGloriousCore2DpiStages(stageDpis, profile), FRAME_GAP_MS]];
    if (stageColors) frames.push([encodeGloriousCore2DpiColors(stageColors, profile), FRAME_GAP_MS]);
    frames.push([encodeGloriousCore2ActiveDpiStage(activeStage, profile), ACTIVE_STAGE_GAP_MS]);
    await this.write(frames);
  }

  /** Sends frames in order, each followed by its own pause. */
  private write(frames: ReadonlyArray<readonly [Uint8Array<ArrayBuffer>, number]>): Promise<void> {
    return this.run(async () => {
      await this.open();
      for (const [body, gapMs] of frames) {
        await this.send(body);
        await delay(gapMs);
      }
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async send(body: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.device.sendFeatureReport(GLORIOUS_CORE2_REPORT_ID, body);
  }

  /** The reply to the request just sent. WebHID hands back the 64-byte body without the report id. */
  private async receive(): Promise<Uint8Array> {
    await delay(REPLY_DELAY_MS);
    const view = await this.device.receiveFeatureReport(GLORIOUS_CORE2_REPORT_ID);
    return new Uint8Array(view.buffer, view.byteOffset, Math.min(view.byteLength, GLORIOUS_CORE2_FRAME_LENGTH));
  }

  private async readFirmware(): Promise<GloriousCore2Firmware | null> {
    await this.send(encodeGloriousCore2FirmwareRequest(this.isWireless() ? "receiver" : "mouse"));
    return decodeGloriousCore2Firmware(await this.receive());
  }

  private async readBattery(): Promise<GloriousCore2Battery | null> {
    await this.send(encodeGloriousCore2BatteryRequest());
    return decodeGloriousCore2Battery(await this.receive());
  }

  private getUiHints(): MouseUiHints {
    return {
      family: "glorious-core2",
      valuesVerified: false,
      showAdvancedSection: true,
      hideUnsupportedPollingRates: true,
      hideAngleSnapping: true,
      hideRippleControl: true,
      hideSleepCard: true,
      hideSignalCard: true,
      forceShowBattery: this.isWireless(),
      pollingNote: "8000 Hz needs the cable; the receiver stops at 4000 Hz. Glorious advises turning Motion Sync off at 8000 Hz.",
      statusNote: "This mouse cannot report its settings or its active profile, so the values shown are the last ones written here. Pick the profile you use: that also selects it on the mouse. Changing one DPI stage rewrites the whole table from the values shown.",
      dpiStageEditor: {
        maxStages: GLORIOUS_CORE2_MAX_DPI_STAGES,
        countEditable: true,
        minDpi: GLORIOUS_CORE2_DPI_MIN,
        maxDpi: GLORIOUS_CORE2_DPI_MAX,
        stepDpi: GLORIOUS_CORE2_DPI_STEP,
      },
    };
  }

  /** One key per model, not per product id: the cable and the receiver reach the same mouse and the same profiles. */
  private storageKey(suffix: string): string {
    return `openmouse-glorious-core2-v1:o2-pro-4k8k:${suffix}`;
  }

  private loadProfile(): number {
    try {
      const stored = Number(localStorage.getItem(this.storageKey("profile")));
      if (Number.isInteger(stored) && stored >= 1 && stored <= GLORIOUS_CORE2_PROFILE_COUNT) return stored;
    } catch {
      // Fall through to the default when browser storage is unavailable.
    }
    return GLORIOUS_CORE2_PROFILE_DEFAULT;
  }

  private saveProfile(profile: number): void {
    try {
      localStorage.setItem(this.storageKey("profile"), String(profile));
    } catch {
      // The profile is still selected on the mouse.
    }
  }

  private loadState(profile: number): GloriousCore2State {
    const factory = factoryState();
    try {
      const stored = JSON.parse(localStorage.getItem(this.storageKey(`state-p${profile}`)) ?? "null") as Partial<GloriousCore2State> | null;
      if (!stored || !Array.isArray(stored.stageDpis) || stored.stageDpis.length < 1 || stored.stageDpis.length > GLORIOUS_CORE2_MAX_DPI_STAGES) return factory;
      const stageDpis = stored.stageDpis;
      const stageColors = Array.isArray(stored.stageColors) && stored.stageColors.length === stageDpis.length
        ? stored.stageColors
        : stageDpis.map((_, index) => STAGE_COLORS[index]!);
      return {
        stageDpis,
        stageColors,
        activeStage: Math.min(Math.max(stored.activeStage ?? factory.activeStage, 0), stageDpis.length - 1),
        pollingRateHz: stored.pollingRateHz ?? factory.pollingRateHz,
        debounceMs: stored.debounceMs ?? factory.debounceMs,
        motionSync: stored.motionSync ?? factory.motionSync,
      };
    } catch {
      return factory;
    }
  }

  private saveState(profile: number, state: GloriousCore2State): void {
    try {
      localStorage.setItem(this.storageKey(`state-p${profile}`), JSON.stringify(state));
    } catch {
      // Settings still reach the mouse when browser storage is unavailable.
    }
  }
}
