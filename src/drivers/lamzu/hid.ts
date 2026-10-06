import type { MagneticButtonsStatus, MagneticCalibrationProgress, MouseStatus } from "../mouse-types.ts";
import {
  COMPX_HEADER_LENGTH as HEADER_LENGTH,
  COMPX_PACKET_LENGTH as PACKET_LENGTH,
  COMPX_REPORT_ID as REPORT_ID,
  COMPX_STATUS as STATUS,
  compaxDecodeDpiStages,
  compaxDecodeFirmware,
  compaxDecodeLiftOff,
  compaxDecodePollingRate,
  compaxDecodeSleep,
  compaxEncodeRequest,
  LAMZU_POLLING_RATES as POLLING_RATES,
  LAMZU_VENDOR_IDS,
  lamzuProduct,
  LUNAFURY_READ,
  LUNAFURY_WRITE,
  lunafuryDecodeAngle,
  lunafuryDecodeLightning,
  lunafuryDecodeButtonDebounce,
  lunafuryDecodeWheelGuard,
  type LunaFuryButton,
  type LunaFuryLightningMode,
  type LunaFurySettings,
  type LunaFuryWheelGuard,
  MAGNETIC_CALIBRATION_ERRORS,
  MAGNETIC_CALIBRATION_STATE,
  MAGNETIC_CALIBRATION_STEPS,
  MAGNETIC_RAPID_TRIGGER_MAX_MS,
  MAGNETIC_RELEASE_FOLLOWS,
  MAGNETIC_SWITCH,
  MAGNETIC_TRAVEL_MAX,
  magneticCalibrationPrompt,
  magneticDecodeCalibration,
  magneticDecodeEid,
  magneticDecodeFault,
  magneticDecodeRapidTrigger,
  magneticDecodeSwitchTypes,
  magneticDecodeTravel,
  magneticRead,
  magneticWrite,
  type CompaxDpiStage,
  type LamzuProduct,
} from "@openmouse/protocol/lamzu";

const SLEEP_SECONDS: readonly number[] = [10, 30, 60, 300, 600, 1800];

const RESPONSE_ATTEMPTS = 12;
const RESPONSE_DELAY_MS = 30;
const WAKE_DELAY_MS = 300;
const QUICK_ATTEMPTS = 3;
const SLEEP_DISABLED_MIN = 0xff00;
const SLEEP_MAX_SECONDS = 0xfeff;
const DPI_STEP = 50;
const CALIBRATION_MAX_MS = 240_000;
const DPI_MAX = 30000;
const DEBOUNCE_MAX_MS = 15;
const NOTIFY_REPORT_ID = 4;
const NOTIFY_DEBOUNCE_MS = 200;
const NOTIFY_KINDS = new Set([0x03, 0x06, 0x08]);

const TARGET = {
  dongle: 0x00,
  mouse: 0x02,
} as const;

const PAGE = {
  device: 0x00,
  profile: 0x01,
  dongle: 0x02,
} as const;

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

const LIFT_OFF_DISTANCES: ReadonlyArray<readonly [number, LiftOffDistance]> = [
  [0x87, "Low"],
  [0x01, "Medium"],
  [0x02, "High"],
];

interface LamzuRequest {
  target: number;
  page: number;
  command: number;
  length: number;
  args: readonly number[];
  attempts?: number;
  matchesReply?: (payload: Uint8Array) => boolean;
  /** Return the whole 58 byte payload instead of the length the mouse echoes. */
  full?: boolean;
}

const READ = {
  firmware: { target: TARGET.mouse, page: PAGE.device, command: 0x81, length: 0x10, args: [] },
  dongleFirmware: { target: TARGET.dongle, page: PAGE.device, command: 0x81, length: 0x10, args: [], attempts: 2 },
  battery: { target: TARGET.mouse, page: PAGE.device, command: 0x83, length: 0x02, args: [] },
  activeProfile: { target: TARGET.mouse, page: PAGE.device, command: 0x85, length: 0x01, args: [] },
} as const satisfies Record<string, LamzuRequest>;

const PROFILE_READ = {
  sleepTimeout: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.device, command: 0x87, length: 0x03, args: [profile] }),
  debounce: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.device, command: 0x88, length: 0x02, args: [profile] }),
  dpiStages: (profile: number, maxStages: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x81, length: 0x0a, args: [profile, maxStages] }),
  activeStage: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x82, length: 0x02, args: [profile] }),
  pollingRate: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x80, length: 0x02, args: [profile] }),
  liftOffDistance: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x88, length: 0x02, args: [profile] }),
  separateAxes: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x8d, length: 0x02, args: [profile] }),
  angleSnapping: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x84, length: 0x02, args: [profile] }),
  motionSync: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x89, length: 0x02, args: [profile] }),
  competitiveMode: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x93, length: 0x02, args: [profile] }),
  hyperMode: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x8b, length: 0x02, args: [profile] }),
  rippleControl: (profile: number): LamzuRequest =>
    ({ target: TARGET.mouse, page: PAGE.profile, command: 0x8a, length: 0x02, args: [profile] }),
  // Addressed to the receiver itself, not the mouse behind it.
  dongleLed: (profile: number): LamzuRequest =>
    ({ target: TARGET.dongle, page: PAGE.dongle, command: 0x84, length: 0x02, args: [profile] }),
} as const;

const WRITE = {
  dpiStages: 0x01,
  pollingRate: 0x00,
  liftOffDistance: 0x08,
  sleepTimeout: 0x07,
  debounce: 0x08,
  angleSnapping: 0x04,
  motionSync: 0x09,
  competitiveMode: 0x13,
  hyperMode: 0x0b,
  rippleControl: 0x0a,
  dongleLed: 0x04,
} as const;

export type LamzuDpiStage = CompaxDpiStage;

export class LamzuHidClient {
  readonly canDisableSleep = false;

  private queue: Promise<unknown> = Promise.resolve();
  private readonly staticReads = new Map<string, Promise<Uint8Array | null>>();
  private lastStatus: MouseStatus | null = null;
  private notifier: HIDDevice | null = null;
  private notifyListener: ((event: HIDInputReportEvent) => void) | null = null;
  private activeProfile = 1;

  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    const search = (collection: HIDCollectionInfo): boolean =>
      collection.featureReports.some((report) => report.reportId === REPORT_ID)
      || collection.children.some(search);
    return LAMZU_VENDOR_IDS.includes(device.vendorId)
      && lamzuProduct(device.vendorId, device.productId) !== undefined
      && device.collections.some(search);
  }

  private profile(): LamzuProduct | undefined {
    return lamzuProduct(this.device.vendorId, this.device.productId);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.staticReads.clear();
    this.lastStatus = null;
    if (this.notifier && this.notifyListener) {
      this.notifier.removeEventListener("inputreport", this.notifyListener);
      if (this.notifier.opened) await this.notifier.close();
    }
    this.notifier = null;
    this.notifyListener = null;
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(onChange: () => void): Promise<boolean> {
    if (this.notifier) return true;
    const devices = await navigator.hid?.getDevices() ?? [];
    const sibling = devices.find((candidate) =>
      candidate !== this.device
      && candidate.vendorId === this.device.vendorId
      && candidate.productId === this.device.productId
      && candidate.collections.some((collection) =>
        collection.inputReports.some((report) => report.reportId === NOTIFY_REPORT_ID)));
    if (!sibling) return false;
    if (!sibling.opened) await sibling.open();

    let timer: number | null = null;
    this.notifyListener = (event: HIDInputReportEvent) => {
      if (event.reportId !== NOTIFY_REPORT_ID || !NOTIFY_KINDS.has(event.data.getUint8(0))) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        onChange();
      }, NOTIFY_DEBOUNCE_MS);
    };
    sibling.addEventListener("inputreport", this.notifyListener);
    this.notifier = sibling;
    return true;
  }

  private once(key: string, read: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
    const pending = this.staticReads.get(key);
    if (pending) return pending;
    const started = read();
    this.staticReads.set(key, started);
    started.catch(() => this.staticReads.delete(key));
    return started;
  }

  displayName(): string {
    const known = this.profile();
    if (!known) return this.device.productName || "Lamzu";
    const color = known.brand === "LunaFury"
      ? this.device.productName?.match(/\b(EL|ES)\b/i)?.[1]?.toUpperCase() : undefined;
    return `${this.deviceBrand()} ${known.model}${color ? ` ${color}` : ""}`;
  }

  deviceBrand(): MouseStatus["brand"] {
    return this.profile()?.brand ?? "Lamzu";
  }

  maxDpi(): number {
    return this.profile()?.maxDpi ?? DPI_MAX;
  }

  maxDpiStages(): number {
    return this.profile()?.maxDpiStages ?? 6;
  }

  getSleepOptions(): readonly number[] {
    return this.profile()?.sleepOptions ?? SLEEP_SECONDS;
  }

  getDebounceMaxMs(): number {
    return DEBOUNCE_MAX_MS;
  }

  getSupportedPollingRates(): number[] {
    const listed = this.profile()?.pollingRates;
    if (listed) return [...listed];
    return [...new Set(POLLING_RATES.map(([, hertz]) => hertz))].sort((left, right) => left - right);
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = DPI_STEP; dpi <= this.maxDpi(); dpi += DPI_STEP) options.push(dpi);
    return options;
  }

  isWireless(): boolean {
    const known = this.profile();
    if (known) return known.wireless;
    return /receiver|dongle/i.test(this.device.productName || "");
  }

  async readStatus(live = false): Promise<MouseStatus> {
    await this.open();
    if (live && this.lastStatus) return await this.readLiveStatus(this.lastStatus);
    const wireless = this.isWireless();
    const firmware = await this.once("firmware", () => this.request(READ.firmware));
    if (!firmware) throw new Error("The mouse did not report a firmware version.");
    const dongleFirmware = await this.once("dongleFirmware", () =>
      wireless ? this.request(READ.dongleFirmware).catch(() => null) : Promise.resolve(null));
    const battery = await this.request(READ.battery);
    // Profile-page commands must address the profile the mouse is actually
    // running, not a fixed slot: writing to profile 1 is silently ignored when
    // a different onboard profile is active.
    const activeProfileReply = await this.request(READ.activeProfile).catch(() => null);
    const profile = activeProfileReply ? Math.max(1, activeProfileReply[0]) : 1;
    this.activeProfile = profile;
    const sleepTimeout = await this.request(PROFILE_READ.sleepTimeout(profile)).catch(() => null);
    const debounce = await this.request(PROFILE_READ.debounce(profile)).catch(() => null);
    const stages = this.decodeDpiStages(await this.request(PROFILE_READ.dpiStages(profile, this.maxDpiStages())));
    const activeStage = this.stageIndex((await this.request(PROFILE_READ.activeStage(profile)))[1], stages.length);
    const pollingRate = await this.request(PROFILE_READ.pollingRate(profile));
    const liftOffDistance = await this.request(PROFILE_READ.liftOffDistance(profile));
    const separateAxes = await this.request(PROFILE_READ.separateAxes(profile)).catch(() => null);
    const angleSnapping = await this.request(PROFILE_READ.angleSnapping(profile)).catch(() => null);
    const motionSync = await this.request(PROFILE_READ.motionSync(profile)).catch(() => null);
    const competitiveMode = await this.request(PROFILE_READ.competitiveMode(profile)).catch(() => null);
    const hyperMode = await this.request(PROFILE_READ.hyperMode(profile)).catch(() => null);
    const rippleControl = await this.request(PROFILE_READ.rippleControl(profile)).catch(() => null);
    const dongleLed = this.profile()?.dongleLed
      ? await this.request(PROFILE_READ.dongleLed(profile)).catch(() => null)
      : null;
    const lunafury = this.deviceBrand() === "LunaFury"
      ? await this.readLunaFurySettings(profile) : undefined;
    const stage = stages[activeStage];
    if (!stage) throw new Error("The mouse did not report any DPI stages.");
    const magneticButtons = this.profile()?.magnetic ? await this.readMagnetic(profile).catch(() => undefined) : undefined;
    return this.lastStatus = {
      ...(magneticButtons ? { magneticButtons } : {}),
      brand: this.deviceBrand(),
      name: this.displayName(),
      ui: {
        family: this.profile()?.uiFamily ?? "lamzu",
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
      },
      batteryPercent: battery[1] <= 100 ? battery[1] : null,
      batteryState: battery[0] === 1 ? "Charging" : "Discharging",
      dpi: stage.x,
      dpiY: stage.y,
      supportsSeparateDpiAxes: separateAxes ? separateAxes[1] === 1 : false,
      pollingRateHz: this.decodePollingRate(pollingRate[1]),
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: activeProfileReply ? activeProfileReply[0] : null,
      angleSnapping: angleSnapping ? angleSnapping[1] === 1 : null,
      motionSync: motionSync ? motionSync[1] === 1 : null,
      performanceMode: competitiveMode ? competitiveMode[1] === 1 : null,
      hyperMode: hyperMode ? hyperMode[1] === 1 : null,
      rippleControl: rippleControl ? rippleControl[1] === 1 : null,
      ...(lunafury ? { lunafury: lunafury.settings, angleTuning: lunafury.angle } : {}),
      dongleLedEnabled: dongleLed ? dongleLed[1] === 1 : null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver" : "Wired USB",
      debounceMs: debounce ? debounce[1] : null,
      sleepTimeout: this.decodeSleepTimeout(sleepTimeout),
      liftOffDistance: this.decodeLiftOffDistance(liftOffDistance[1]),
      firmware: dongleFirmware
        ? [this.decodeFirmware("Mouse", firmware), this.decodeFirmware("Dongle", dongleFirmware)]
        : [this.decodeFirmware("Mouse", firmware)],
    };
  }

  private async readLiveStatus(previous: MouseStatus): Promise<MouseStatus> {
    const battery = await this.request(READ.battery);
    const pollingRate = await this.request(PROFILE_READ.pollingRate(this.activeProfile));
    return this.lastStatus = {
      ...previous,
      batteryPercent: battery[1] <= 100 ? battery[1] : null,
      batteryState: battery[0] === 1 ? "Charging" : "Discharging",
      pollingRateHz: this.decodePollingRate(pollingRate[1]),
    };
  }

  private requireLunaFury(): void {
    if (this.deviceBrand() !== "LunaFury") throw new Error("This control is only available on LunaFury mice.");
  }

  private readLunaFury(spec: LamzuRequest): Promise<Uint8Array> {
    const profile = spec.args[0];
    const button = spec.page === PAGE.device && spec.command === 0x92 ? spec.args[2] : undefined;
    // These reads echo their profile and, for latency, the button selector.
    // A successful same-command reply can still belong to the previous read.
    return this.request({
      ...spec,
      matchesReply: (payload) => payload[0] === profile
        && (button === undefined || payload[2] === button),
    });
  }

  private async readLunaFurySettings(profile: number): Promise<{ settings: LunaFurySettings; angle: number | null }> {
    const optional = (spec: LamzuRequest) => this.readLunaFury({ ...spec, attempts: 2 }).catch(() => null);
    const lightningMode = lunafuryDecodeLightning(await optional(LUNAFURY_READ.lightning(profile)));
    const leftDebounceMs = lunafuryDecodeButtonDebounce(await optional(LUNAFURY_READ.buttonDebounce(profile, "left")), "left");
    const rightDebounceMs = lunafuryDecodeButtonDebounce(await optional(LUNAFURY_READ.buttonDebounce(profile, "right")), "right");
    const middleDebounceMs = lunafuryDecodeButtonDebounce(await optional(LUNAFURY_READ.buttonDebounce(profile, "middle")), "middle");
    const wheelGuard = lunafuryDecodeWheelGuard(await optional(LUNAFURY_READ.wheelGuard(profile)));
    const angle = lunafuryDecodeAngle(await optional(LUNAFURY_READ.angle(profile)));
    return { settings: { lightningMode, leftDebounceMs, rightDebounceMs, middleDebounceMs, wheelGuard }, angle };
  }

  private patchLunaFury(changes: Partial<LunaFurySettings>): void {
    this.patch({ lunafury: { ...this.lastStatus?.lunafury, ...changes } });
  }

  async setAngleTuning(degrees: number): Promise<number> {
    this.requireLunaFury();
    const profile = await this.currentProfile();
    await this.request(LUNAFURY_WRITE.angle(profile, degrees));
    const confirmed = lunafuryDecodeAngle(await this.readLunaFury(LUNAFURY_READ.angle(profile)));
    if (confirmed !== degrees) throw new Error(`The mouse did not confirm the ${degrees}° sensor angle.`);
    this.patch({ angleTuning: confirmed });
    return confirmed;
  }

  async setLunaFuryLightningMode(mode: LunaFuryLightningMode): Promise<LunaFuryLightningMode> {
    this.requireLunaFury();
    const profile = await this.currentProfile();
    await this.request(LUNAFURY_WRITE.lightning(profile, mode));
    const confirmed = lunafuryDecodeLightning(await this.readLunaFury(LUNAFURY_READ.lightning(profile)));
    if (confirmed !== mode) throw new Error("The mouse did not confirm the Lightning Trigger mode.");
    this.patchLunaFury({ lightningMode: confirmed });
    return confirmed;
  }

  async setLunaFuryButtonDebounce(button: LunaFuryButton, milliseconds: number): Promise<number> {
    this.requireLunaFury();
    const profile = await this.currentProfile();
    await this.request(LUNAFURY_WRITE.buttonDebounce(profile, button, milliseconds));
    const confirmed = lunafuryDecodeButtonDebounce(await this.readLunaFury(LUNAFURY_READ.buttonDebounce(profile, button)), button);
    if (confirmed !== milliseconds) throw new Error(`The mouse did not confirm ${milliseconds} ms latency for the ${button} button.`);
    this.patchLunaFury({ [`${button}DebounceMs`]: confirmed });
    return confirmed;
  }

  async setLunaFuryWheelGuard(guard: LunaFuryWheelGuard): Promise<LunaFuryWheelGuard> {
    this.requireLunaFury();
    const profile = await this.currentProfile();
    await this.request(LUNAFURY_WRITE.wheelGuard(profile, guard));
    const confirmed = lunafuryDecodeWheelGuard(await this.readLunaFury(LUNAFURY_READ.wheelGuard(profile)));
    if (!confirmed || confirmed.enabled !== guard.enabled || confirmed.windowMs !== guard.windowMs) {
      throw new Error("The mouse did not confirm the wheel guard settings.");
    }
    this.patchLunaFury({ wheelGuard: confirmed });
    return confirmed;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const encoded = POLLING_RATES.find(([, hertz]) => hertz === pollingRateHz);
    if (!encoded || !this.getSupportedPollingRates().includes(pollingRateHz)) {
      throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
    }
    const profile = await this.currentProfile();
    await this.write(PAGE.profile, WRITE.pollingRate, profile, [encoded[0]]);
    const confirmed = this.decodePollingRate((await this.request(PROFILE_READ.pollingRate(profile)))[1]);
    if (confirmed !== pollingRateHz) {
      throw new Error(`The mouse kept ${confirmed} Hz instead of ${pollingRateHz} Hz.`);
    }
    this.patch({ pollingRateHz: confirmed });
    return confirmed;
  }

  async setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    const encoded = LIFT_OFF_DISTANCES.find(([, name]) => name === value);
    if (!encoded) throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    const profile = await this.currentProfile();
    await this.write(PAGE.profile, WRITE.liftOffDistance, profile, [encoded[0]]);
    const confirmed = this.decodeLiftOffDistance((await this.request(PROFILE_READ.liftOffDistance(profile)))[1]);
    if (confirmed !== value) {
      throw new Error(`The mouse kept a ${String(confirmed).toLowerCase()} lift-off distance instead of ${value.toLowerCase()}.`);
    }
    this.patch({ liftOffDistance: confirmed });
    return confirmed;
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.angleSnapping, PROFILE_READ.angleSnapping, enabled, "angleSnapping", "angle snapping");
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.motionSync, PROFILE_READ.motionSync, enabled, "motionSync", "Motion Sync");
  }

  async setPerformanceMode(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.competitiveMode, PROFILE_READ.competitiveMode, enabled, "performanceMode", "competitive mode");
  }

  async setHyperMode(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.hyperMode, PROFILE_READ.hyperMode, enabled, "hyperMode", "Hyper mode");
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.rippleControl, PROFILE_READ.rippleControl, enabled, "rippleControl", "ripple control");
  }

  async setDongleLed(enabled: boolean): Promise<boolean> {
    if (!this.profile()?.dongleLed) throw new Error("This receiver has no LED control.");
    const profile = await this.currentProfile();
    await this.request({
      target: TARGET.dongle, page: PAGE.dongle, command: WRITE.dongleLed, length: 0x02, args: [profile, enabled ? 1 : 0],
    });
    const confirmed = (await this.request(PROFILE_READ.dongleLed(profile)))[1] === 1;
    if (confirmed !== enabled) throw new Error(`The receiver left its LED ${confirmed ? "on" : "off"}.`);
    this.patch({ dongleLedEnabled: confirmed });
    return confirmed;
  }

  private async setFlag(
    command: number,
    read: (profile: number) => LamzuRequest,
    enabled: boolean,
    field: "angleSnapping" | "motionSync" | "performanceMode" | "hyperMode" | "rippleControl",
    label: string,
  ): Promise<boolean> {
    const profile = await this.currentProfile();
    await this.write(PAGE.profile, command, profile, [enabled ? 1 : 0]);
    const confirmed = (await this.request(read(profile)))[1] === 1;
    if (confirmed !== enabled) {
      throw new Error(`The mouse left ${label} ${confirmed ? "on" : "off"}.`);
    }
    this.patch({ [field]: confirmed });
    return confirmed;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > DEBOUNCE_MAX_MS) {
      throw new Error(`Debounce must be a whole number of milliseconds between 0 and ${DEBOUNCE_MAX_MS}.`);
    }
    const profile = await this.currentProfile();
    await this.write(PAGE.device, WRITE.debounce, profile, [milliseconds]);
    const confirmed = (await this.request(PROFILE_READ.debounce(profile)))[1];
    if (confirmed !== milliseconds) {
      throw new Error(`The mouse kept ${confirmed} ms of debounce instead of ${milliseconds} ms.`);
    }
    this.patch({ debounceMs: confirmed });
    return confirmed;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > SLEEP_MAX_SECONDS) {
      throw new Error(`The sleep timeout must be a whole number of seconds between 1 and ${SLEEP_MAX_SECONDS}.`);
    }
    const profile = await this.currentProfile();
    await this.write(PAGE.device, WRITE.sleepTimeout, profile, [seconds >> 8 & 0xff, seconds & 0xff]);
    const reply = await this.request(PROFILE_READ.sleepTimeout(profile));
    const confirmed = (reply[1] << 8) | reply[2];
    if (confirmed !== seconds) {
      throw new Error(`The mouse kept a ${confirmed} second sleep timeout instead of ${seconds} seconds.`);
    }
    this.patch({ sleepTimeout: this.decodeSleepTimeout(reply) });
    return confirmed;
  }

  async setDpi(dpi: number, dpiY: number = dpi): Promise<number> {
    const ceiling = this.maxDpi();
    for (const value of [dpi, dpiY]) {
      if (!Number.isInteger(value) || value < DPI_STEP || value > ceiling || value % DPI_STEP !== 0) {
        throw new Error(`${value.toLocaleString()} is not a supported DPI value.`);
      }
    }
    const profile = await this.currentProfile();
    const stages = this.decodeDpiStages(await this.request(PROFILE_READ.dpiStages(profile, this.maxDpiStages())));
    const active = this.stageIndex((await this.request(PROFILE_READ.activeStage(profile)))[1], stages.length);
    if (!stages[active]) throw new Error("The mouse did not report any DPI stages.");
    stages[active] = { x: dpi, y: dpiY };
    await this.write(PAGE.profile, WRITE.dpiStages, profile, [
      stages.length,
      ...stages.flatMap((stage) => [stage.x >> 8 & 0xff, stage.x & 0xff, stage.y >> 8 & 0xff, stage.y & 0xff]),
    ]);
    const confirmed = this.decodeDpiStages(
      await this.request(PROFILE_READ.dpiStages(profile, this.maxDpiStages())),
    )[active];
    if (!confirmed || confirmed.x !== dpi || confirmed.y !== dpiY) {
      throw new Error(`The mouse kept ${confirmed ? confirmed.x.toLocaleString() : "an unknown"} DPI instead of ${dpi.toLocaleString()}.`);
    }
    this.patch({ dpi: confirmed.x, dpiY: confirmed.y });
    return confirmed.x;
  }

  async readMagnetic(profile: number = this.activeProfile): Promise<MagneticButtonsStatus> {
    const fault = await this.request(magneticRead.fault).then(magneticDecodeFault).catch(() => null);
    const types = !fault || fault.calibrated
      ? await this.request(magneticRead.switchTypes).then(magneticDecodeSwitchTypes).catch(() => null)
      : null;
    const buttons: MagneticButtonsStatus["buttons"] = [];
    for (const side of [0, 1] as const) {
      const key = side + 1;
      const travel = await this.request(magneticRead.travel(profile, key)).then(magneticDecodeTravel).catch(() => null);
      const rapid = await this.request(magneticRead.rapidTrigger(profile, key)).then(magneticDecodeRapidTrigger).catch(() => null);
      const type = fault && !fault.calibrated ? MAGNETIC_SWITCH.optical : types?.[side];
      buttons.push({
        switchType: type === MAGNETIC_SWITCH.magnetic ? "magnetic" : type === MAGNETIC_SWITCH.optical ? "optical" : null,
        triggerPoint: travel && travel.press >= 1 && travel.press <= MAGNETIC_TRAVEL_MAX ? travel.press : null,
        releasePoint: travel ? (travel.release === MAGNETIC_RELEASE_FOLLOWS ? null : travel.release) : null,
        rapidTrigger: rapid ? rapid : null,
        rapidTriggerEnabled: rapid === null ? null : rapid > 0,
      });
    }
    return {
      buttons,
      triggerPointRange: { min: 1, max: MAGNETIC_TRAVEL_MAX },
      releasePointRange: { min: 1, max: MAGNETIC_TRAVEL_MAX },
      rapidTriggerRange: { min: 1, max: MAGNETIC_RAPID_TRIGGER_MAX_MS },
      rapidTriggerUnit: "ms",
      rapidTriggerSwitch: false,
      canChooseSwitchType: true,
      calibration: !fault ? "unknown" : fault.calibrated && !fault.needsRecalibration ? "calibrated" : "needed",
      liveDepth: false,
    };
  }

  /** Press travel for one button, keeping its release travel. */
  async setMagneticTriggerPoint(button: 0 | 1, point: number): Promise<number> {
    if (!Number.isInteger(point) || point < 1 || point > MAGNETIC_TRAVEL_MAX) {
      throw new RangeError(`Trigger point must be 1 to ${MAGNETIC_TRAVEL_MAX}.`);
    }
    const profile = await this.currentProfile();
    const current = magneticDecodeTravel(await this.request(magneticRead.travel(profile, button + 1)));
    await this.request(magneticWrite.travel(profile, button + 1, point, current.release));
    const confirmed = magneticDecodeTravel(await this.request(magneticRead.travel(profile, button + 1)));
    if (confirmed.press !== point) throw new Error(`The mouse kept trigger point ${confirmed.press} instead of ${point}.`);
    return confirmed.press;
  }

  /** Release travel for one button; null makes the release follow the trigger point. */
  async setMagneticReleasePoint(button: 0 | 1, point: number | null): Promise<number | null> {
    if (point !== null && (!Number.isInteger(point) || point < 1 || point > MAGNETIC_TRAVEL_MAX || point === MAGNETIC_RELEASE_FOLLOWS)) {
      throw new RangeError(`Release point must be 1 to ${MAGNETIC_TRAVEL_MAX}, other than ${MAGNETIC_RELEASE_FOLLOWS}.`);
    }
    const profile = await this.currentProfile();
    const current = magneticDecodeTravel(await this.request(magneticRead.travel(profile, button + 1)));
    const wanted = point ?? MAGNETIC_RELEASE_FOLLOWS;
    await this.request(magneticWrite.travel(profile, button + 1, current.press, wanted));
    const confirmed = magneticDecodeTravel(await this.request(magneticRead.travel(profile, button + 1)));
    if (confirmed.release !== wanted) throw new Error(`The mouse kept release travel ${confirmed.release} instead of ${wanted}.`);
    return point;
  }

  /** Rapid trigger in milliseconds; off is stored as 0. */
  async setMagneticRapidTrigger(button: 0 | 1, enabled: boolean, milliseconds: number): Promise<{ enabled: boolean; level: number }> {
    if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > MAGNETIC_RAPID_TRIGGER_MAX_MS) {
      throw new RangeError(`Rapid trigger must be 1 to ${MAGNETIC_RAPID_TRIGGER_MAX_MS} ms.`);
    }
    const profile = await this.currentProfile();
    const wanted = enabled ? milliseconds : 0;
    await this.request(magneticWrite.rapidTrigger(profile, button + 1, wanted));
    const confirmed = magneticDecodeRapidTrigger(await this.request(magneticRead.rapidTrigger(profile, button + 1)));
    if (confirmed !== wanted) throw new Error(`The mouse kept rapid trigger at ${confirmed} ms instead of ${wanted} ms.`);
    return { enabled, level: milliseconds };
  }

  /** Chooses magnetic or optical for each button. Magnetic needs a calibrated mouse. */
  async setMagneticSwitchTypes(types: readonly ["magnetic" | "optical", "magnetic" | "optical"]): Promise<void> {
    const fault = magneticDecodeFault(await this.request(magneticRead.fault));
    if (!fault.calibrated && types.includes("magnetic")) throw new Error("Calibrate the magnetic switches before choosing Magnetic.");
    const eid = magneticDecodeEid(await this.request(magneticRead.eid));
    const wanted = types.map((type) => MAGNETIC_SWITCH[type]) as [number, number];
    await this.request(magneticWrite.switchTypes(eid, wanted[0], wanted[1]));
    const confirmed = magneticDecodeSwitchTypes(await this.request(magneticRead.switchTypes));
    if (confirmed[0] !== wanted[0] || confirmed[1] !== wanted[1]) throw new Error("The mouse kept its previous switch mode.");
  }

  /** Runs the manual calibration. Resolves on success, rejects with the mouse's own reason on failure. */
  async calibrateMagneticButtons(onProgress: (progress: MagneticCalibrationProgress) => void, signal?: AbortSignal): Promise<void> {
    const poll = (state: number): Promise<Uint8Array> => this.request({ ...magneticWrite.calibration(state), full: true });
    const wait = (milliseconds: number): Promise<void> => this.delay(milliseconds);
    const first = magneticDecodeCalibration(await poll(5));
    const two = first.twoButtons;
    await poll(two ? 4 : 1);
    const started = Date.now();
    let silent = 0;
    for (;;) {
      if (signal?.aborted) throw new Error("Calibration cancelled.");
      if (Date.now() - started > CALIBRATION_MAX_MS) throw new Error("Calibration timed out. Fully press and release as prompted, then recalibrate.");
      await wait(100);
      let reading;
      try {
        reading = magneticDecodeCalibration(await poll(two ? 5 : 3));
      } catch (error) {
        if (++silent > 25) throw new Error("The mouse stopped answering during calibration.", { cause: error });
        continue;
      }
      silent = 0;
      const message = two
        ? magneticCalibrationPrompt(reading.mask) ?? MAGNETIC_CALIBRATION_STEPS[reading.state] ?? "Calibrating..."
        : MAGNETIC_CALIBRATION_STEPS[reading.state] ?? "Calibrating...";
      onProgress({
        left: two ? Math.min(reading.left, 100) : Math.min(reading.progress, 100),
        right: two ? Math.min(reading.right, 100) : Math.min(reading.progress, 100),
        message,
        step: Math.min(Math.max(reading.state, 1), 6),
        steps: 6,
      });
      if (reading.state === MAGNETIC_CALIBRATION_STATE.success) return;
      if (reading.state === MAGNETIC_CALIBRATION_STATE.cancelled) throw new Error(MAGNETIC_CALIBRATION_STEPS[9]);
      if (reading.state === MAGNETIC_CALIBRATION_STATE.failed) {
        throw new Error(MAGNETIC_CALIBRATION_ERRORS[reading.code] ?? MAGNETIC_CALIBRATION_STEPS[8]);
      }
    }
  }

  private async currentProfile(): Promise<number> {
    const reply = await this.request(READ.activeProfile);
    this.activeProfile = Math.max(1, reply[0]);
    return this.activeProfile;
  }

  private async write(page: number, command: number, profile: number, values: readonly number[]): Promise<void> {
    const args = [profile, ...values];
    await this.request({ target: TARGET.mouse, page, command, length: args.length, args });
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  private stageIndex(reported: number, count: number): number {
    return Math.min(Math.max(reported, 1), Math.max(count, 1)) - 1;
  }

  private async request(spec: LamzuRequest): Promise<Uint8Array> {
    const run = this.queue.then(() => this.exchange(spec), () => this.exchange(spec));
    this.queue = run.catch(() => undefined);
    return await run;
  }

  private async exchange(spec: LamzuRequest): Promise<Uint8Array> {
    await this.open();
    const request = spec.target === TARGET.mouse
      ? { ...spec, target: this.profile()?.mouseTarget ?? TARGET.mouse }
      : spec;
    const packet = compaxEncodeRequest(request);
    await this.device.sendFeatureReport(REPORT_ID, packet);

    const attempts = spec.attempts ?? RESPONSE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const reply = this.copyDataView(await this.device.receiveFeatureReport(REPORT_ID));
      if (reply[0] === STATUS.unsupported) throw new Error(this.describe(spec, "is not supported by this mouse"));
      if (reply[0] === STATUS.ok && reply[4] === spec.page && reply[5] === spec.command) {
        const length = spec.full ? PACKET_LENGTH - HEADER_LENGTH : Math.min(reply[3], PACKET_LENGTH - HEADER_LENGTH);
        const payload = reply.slice(HEADER_LENGTH, HEADER_LENGTH + length);
        if (!spec.matchesReply || spec.matchesReply(payload)) return payload;
      }
      if (reply[0] !== STATUS.pending && reply[0] !== STATUS.busy && reply[0] !== STATUS.ok) {
        throw new Error(this.describe(spec, `returned an unexpected status 0x${reply[0].toString(16)}`));
      }
      await this.delay(attempt < QUICK_ATTEMPTS ? RESPONSE_DELAY_MS : WAKE_DELAY_MS);
    }
    throw new Error(this.describe(spec, "got no answer — the mouse may be asleep or out of range"));
  }

  private describe(spec: LamzuRequest, problem: string): string {
    const hex = (value: number) => `0x${value.toString(16).padStart(2, "0")}`;
    return `Page ${hex(spec.page)} command ${hex(spec.command)} ${problem}.`;
  }

  private decodeDpiStages(payload: Uint8Array): LamzuDpiStage[] {
    return compaxDecodeDpiStages(payload);
  }

  private decodePollingRate(value: number): number {
    return compaxDecodePollingRate(POLLING_RATES, value);
  }

  private decodeLiftOffDistance(value: number): LiftOffDistance | null {
    return compaxDecodeLiftOff(value);
  }

  private decodeSleepTimeout(payload: Uint8Array | null): number | null {
    return compaxDecodeSleep(payload, SLEEP_DISABLED_MIN);
  }

  private decodeFirmware(label: string, payload: Uint8Array | null): string {
    return compaxDecodeFirmware(label, payload);
  }

  private copyDataView(view: DataView): Uint8Array {
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
}
