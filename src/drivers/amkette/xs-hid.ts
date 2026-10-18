import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.ts";
import {
  decodeKyuProMx1Telemetry,
  RYUNIX_BRIGHTNESS_LEVELS,
  RYUNIX_BUTTON_ACTIONS,
  RYUNIX_BUTTON_FACTORY_CODES,
  RYUNIX_BUTTON_POSITIONS,
  RYUNIX_BUTTON_SLOTS,
  RYUNIX_COMMAND_REPORT_ID,
  RYUNIX_CONFIG_REPORT_ID,
  RYUNIX_DEFAULT_DPI_COLORS,
  RYUNIX_DPI_MAX_STAGES,
  RYUNIX_DPI_MIN,
  RYUNIX_DPI_STEP,
  RYUNIX_LIFT_OFF_MM,
  RYUNIX_LIGHTING_SCHEMES,
  RYUNIX_SLEEP_MAX_MINUTES,
  RYUNIX_SLEEP_MIN_MINUTES,
  RYUNIX_SPEED_LEVELS,
  RYUNIX_USAGE,
  RYUNIX_USAGE_PAGE,
  RYUNIX_VENDOR_ID,
  RYUNIX_WIRELESS_PRODUCT_ID,
  ryunixAckOk,
  ryunixButtonActionName,
  ryunixClampDpi,
  ryunixDefaultDpiStages,
  ryunixNextSequence,
  ryunixParseColor,
  ryunixSensor,
  ryunixSetButtonsFrames,
  ryunixSetDpiColorsFrame,
  ryunixSetDpiFrame,
  ryunixSetLiftOffFrame,
  ryunixSetLightingFrame,
  ryunixSetPollingRateFrame,
  ryunixSetPowerFrame,
  ryunixSetSensorOptionsFrame,
  ryunixSupportedPollingRates,
  type KyuProMx1Telemetry,
  type RyunixButtonCode,
  type RyunixSensor,
} from "@openmouse/protocol/ryunix";
import {
  AMKETTE_XS_BLUETOOTH_PRODUCT_ID,
  AMKETTE_XS_FALLBACK_NAME,
  AMKETTE_XS_PRODUCT_IDS,
  AMKETTE_XS_USAGE,
  amketteBluetoothSlot,
  amketteIsReceiverName,
  amketteXsModel,
} from "@openmouse/protocol/amkette";

const COMMAND_ATTEMPTS = 3;
/**
 * Waits before each acknowledgement read of one attempt (cumulative 60, 150, 300
 * and 600 ms). Over the 2.4 GHz receiver the acknowledgement was seen reading 0
 * at 60 ms and 1 by 150 ms, so one early read would re-send a command that had
 * landed.
 */
const ACK_POLL_DELAYS_MS = [60, 90, 150, 300] as const;
const DPI_AXIS_GAP_MS = 200;
/** How long a status read waits for the report it asked for. */
const STATUS_WAIT_MS = 300;
/** Fresh-status polls after a write; the mouse reports on request, not on change. */
const CONFIRM_POLLS = 4;
const CONFIRM_POLL_MS = 400;

/** Brightness levels 1-4 as the percentages shown in the UI. */
const BRIGHTNESS_PERCENT = [25, 50, 75, 100] as const;
/**
 * The XS Flow 2 Speed's three effects (scheme 1). Other schemes are not offered:
 * the XS Natural Plus has none (scheme 4), and the XS Flow Plus's seven
 * (scheme 3) have not been mapped or checked, so it keeps this subset.
 */
const BASIC_EFFECT_CODES = RYUNIX_LIGHTING_SCHEMES[1]!;
const LIGHTING_MODE_NAMES: Readonly<Record<number, MouseLightingMode>> = {
  0: "Off",
  2: "Breathing single",
  3: "Static",
};

type LiftOffLevel = NonNullable<MouseStatus["liftOffDistance"]>;
const LIFT_OFF_LEVEL_MM: Readonly<Partial<Record<LiftOffLevel, number>>> = { Low: 1, High: 2 };

/** What the vendor app assumes before anything is written; the mouse cannot confirm them. */
const VENDOR_DEFAULTS = {
  liftOffMm: 2,
  sleepMinutes: 1,
  angleSnapping: false,
  motionSync: true,
  rippleControl: false,
} as const;

/**
 * What the mouse cannot report back, as last written by OpenMouse this session.
 * Keyed by product ID, so the cable, the receiver and Bluetooth each start
 * fresh, and two mice on the same path share it.
 */
interface WriteOnlyState {
  dpiStages: number[] | null;
  dpiColors: string[];
  /** Null until written; `readStatus` shows the vendor default meanwhile. */
  liftOffMm: number | null;
  sleepMinutes: number | null;
  angleSnapping: boolean | null;
  motionSync: boolean | null;
  rippleControl: boolean | null;
  /** Positions changed this session; the rest are written as the factory layout. */
  buttons: Array<RyunixButtonCode | null>;
  brightness: number;
  speed: number;
}

const writeOnlyByProduct = new Map<number, WriteOnlyState>();

function stateFor(productId: number): WriteOnlyState {
  let state = writeOnlyByProduct.get(productId);
  if (!state) {
    state = {
      dpiStages: null,
      dpiColors: [...RYUNIX_DEFAULT_DPI_COLORS],
      liftOffMm: null,
      sleepMinutes: null,
      angleSnapping: null,
      motionSync: null,
      rippleControl: null,
      buttons: new Array(RYUNIX_BUTTON_POSITIONS).fill(null),
      brightness: 4,
      speed: 3,
    };
    writeOnlyByProduct.set(productId, state);
  }
  return state;
}

/** Forget what this session wrote, e.g. between tests. */
export function resetAmketteXsWriteState(productId?: number): void {
  if (productId === undefined) writeOnlyByProduct.clear();
  else writeOnlyByProduct.delete(productId);
}

function hasCollection(collections: readonly HIDCollectionInfo[], usage: number, featureReport?: number): boolean {
  return collections.some((collection) =>
    collection.usagePage === RYUNIX_USAGE_PAGE
      && collection.usage === usage
      && (featureReport === undefined || collection.featureReports.some((report) => report.reportId === featureReport))
    || hasCollection(collection.children, usage, featureReport));
}

/** True when the product string names an Amkette XS model; never inferred from IDs. */
export function isAmketteDevice(device: { productName?: string | null }): boolean {
  return amketteXsModel(device.productName) !== null;
}

/** 0 discharging, 1 charging; a wired mouse at 100% sends 2, read as full. */
function batteryState(telemetry: KyuProMx1Telemetry | null): MouseStatus["batteryState"] {
  if (!telemetry) return "Unknown";
  switch (telemetry.batteryStatusCode) {
    case 0: return "Discharging";
    case 1: return "Charging";
    case 2: return telemetry.batteryPercent === 100 ? "Full" : "Unknown";
    default: return "Unknown";
  }
}

/** How a write is judged against the status the mouse reports afterwards. */
interface Confirmation {
  accept: (telemetry: KyuProMx1Telemetry) => boolean;
  mismatch: (telemetry: KyuProMx1Telemetry) => string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesOf(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * The Amkette XS firmware on 0x04F3, which shares its IDs and wire protocol with
 * the Ryunix Kyu Pro MX1 (see `docs/amkette-xs-flow-testing.md`). It is told
 * apart by its configuration collection on usage 0x00, seen on all three paths
 * of an XS Flow 2 Speed; the Kyu Pro MX1 (usage 0xC7) keeps its own read-only
 * driver.
 */
export class AmketteXsHidClient {
  private telemetry: KyuProMx1Telemetry | null = null;
  /** Counts decoded status reports, so a read can wait for one it asked for. */
  private telemetryCount = 0;
  /** `open()` has asked for a report that no status read has waited for yet. */
  private openRequestPending = false;
  private listening = false;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private telemetryWaiters: Array<() => void> = [];
  private onChange: (() => void) | null = null;

  public constructor(public readonly device: HIDDevice) {}

  public static isSupported(device: HIDDevice): boolean {
    return device.vendorId === RYUNIX_VENDOR_ID
      && AMKETTE_XS_PRODUCT_IDS.has(device.productId)
      && hasCollection(device.collections, AMKETTE_XS_USAGE, RYUNIX_CONFIG_REPORT_ID)
      && !hasCollection(device.collections, RYUNIX_USAGE);
  }

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const telemetry = decodeKyuProMx1Telemetry(bytes, event.reportId);
    if (!telemetry) return;
    this.telemetry = telemetry;
    this.telemetryCount += 1;
    const waiters = this.telemetryWaiters;
    this.telemetryWaiters = [];
    for (const wake of waiters) wake();
    this.onChange?.();
  };

  public async open(): Promise<void> {
    if (!AmketteXsHidClient.isSupported(this.device)) {
      throw new Error("The mouse's configuration collection is unavailable.");
    }
    if (!this.device.opened) await this.device.open();
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
      this.openRequestPending = true;
      await this.requestTelemetry();
    }
  }

  public async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    this.telemetry = null;
    this.openRequestPending = false;
    this.onChange = null;
    if (this.device.opened) await this.device.close();
  }

  /**
   * The mouse sends status only when asked (feature report 0x05), not when it
   * changes, so there is nothing to subscribe to: callers keep polling
   * `readStatus`, which asks for a fresh report each time. The callback still
   * fires on any report that does arrive.
   */
  public async startNotifications(onChange?: () => void): Promise<boolean> {
    await this.open();
    this.onChange = onChange ?? null;
    return false;
  }

  /**
   * Always Amkette: the driver is chosen by the usage-0x00 collection, which has
   * only been seen on an Amkette mouse, so the brand follows the same evidence.
   * The product name only refines the model.
   */
  public deviceBrand(): "Amkette" {
    return "Amkette";
  }

  public displayName(): string {
    const model = amketteXsModel(this.device.productName);
    if (model) return model.name;
    // A receiver's generic string names the dongle, not the mouse, so it is not shown.
    const name = this.device.productName?.trim();
    return name && !amketteIsReceiverName(name) ? name : AMKETTE_XS_FALLBACK_NAME;
  }

  public isBluetooth(): boolean {
    return this.device.productId === AMKETTE_XS_BLUETOOTH_PRODUCT_ID;
  }

  public isWireless(): boolean {
    return this.device.productId === RYUNIX_WIRELESS_PRODUCT_ID || this.isBluetooth();
  }

  /** Bluetooth shows its slot when the advertised name carries one. */
  private connectionDetail(): string {
    if (this.isBluetooth()) {
      const slot = amketteBluetoothSlot(this.device.productName);
      return slot === null ? "Bluetooth" : `Bluetooth, slot ${slot}`;
    }
    return this.isWireless() ? "2.4 GHz receiver" : "USB";
  }

  public getDpiOptions(): number[] {
    return [];
  }

  /** Auto-sleep choices in seconds: whole minutes from 1 to 15. */
  public getSleepOptions(): number[] {
    const options: number[] = [];
    for (let minutes = RYUNIX_SLEEP_MIN_MINUTES; minutes <= RYUNIX_SLEEP_MAX_MINUTES; minutes++) options.push(minutes * 60);
    return options;
  }

  public getSupportedPollingRates(): number[] {
    return ryunixSupportedPollingRates(this.telemetry?.maxPollingCode ?? null);
  }

  /** Effects the detected model offers; an unidentified mouse gets the basic set. */
  private lightingEffects(): readonly number[] {
    return amketteXsModel(this.device.productName)?.lightingScheme === 4 ? [] : BASIC_EFFECT_CODES;
  }

  /** Reading feature report 0x05 makes the mouse emit an input report 0x04. */
  private async requestTelemetry(): Promise<void> {
    try {
      await this.device.receiveFeatureReport(RYUNIX_CONFIG_REPORT_ID);
    } catch {
      // A failed read leaves the last report in place; the next read asks again.
    }
  }

  private waitForTelemetry(
    accept: (telemetry: KyuProMx1Telemetry) => boolean,
    timeoutMs: number,
  ): Promise<KyuProMx1Telemetry | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: KyuProMx1Telemetry | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const check = (): void => {
        if (settled) return;
        if (this.telemetry && accept(this.telemetry)) finish(this.telemetry);
        else this.telemetryWaiters.push(check);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      check();
    });
  }

  /**
   * Ask for a status report and wait briefly for it, keeping the last one if
   * none comes. Right after `open()` the report it asked for is awaited instead
   * of asking again.
   */
  private async refreshTelemetry(): Promise<void> {
    if (this.openRequestPending) {
      this.openRequestPending = false;
      await this.waitForTelemetry(() => this.telemetryCount > 0, STATUS_WAIT_MS);
      return;
    }
    const before = this.telemetryCount;
    await this.requestTelemetry();
    await this.waitForTelemetry(() => this.telemetryCount > before, STATUS_WAIT_MS);
  }

  /**
   * The mouse only sends status when asked, so a write is judged against a
   * report requested after it. Returns the matching report, or null if none of
   * the polls matched.
   */
  private async confirmByTelemetry(
    accept: (telemetry: KyuProMx1Telemetry) => boolean,
  ): Promise<KyuProMx1Telemetry | null> {
    for (let poll = 0; poll < CONFIRM_POLLS; poll++) {
      const before = this.telemetryCount;
      await this.requestTelemetry();
      const match = await this.waitForTelemetry(
        (telemetry) => this.telemetryCount > before && accept(telemetry),
        CONFIRM_POLL_MS,
      );
      if (match) return match;
    }
    return null;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private nextSequence(): number {
    this.sequence = ryunixNextSequence(this.sequence);
    return this.sequence;
  }

  /** Send one frame on report 0x06 and require the mouse to acknowledge it. */
  private async sendFrame(frame: Uint8Array): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < COMMAND_ATTEMPTS; attempt++) {
      await delay(100 + attempt * 50);
      try {
        await this.device.sendFeatureReport(RYUNIX_COMMAND_REPORT_ID, new Uint8Array(frame));
        for (const wait of ACK_POLL_DELAYS_MS) {
          await delay(wait);
          const ack = await this.device.receiveFeatureReport(RYUNIX_COMMAND_REPORT_ID);
          if (ryunixAckOk(bytesOf(ack))) return;
        }
        lastError = new Error("The mouse did not acknowledge the command.");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("The mouse did not acknowledge the command.");
  }

  /**
   * Send frames and, when `accept` is given, judge the write against fresh
   * status, all inside the command queue so another setter's frames cannot land
   * between the write and its confirmation. Throws when the mouse reports a
   * value other than the one written; a mouse that sends no status at all is
   * judged by its acknowledgement alone.
   */
  private send(
    build: (sequence: () => number) => Uint8Array | Uint8Array[],
    confirm?: Confirmation,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.open();
      const frames = build(() => this.nextSequence());
      for (const [index, frame] of (Array.isArray(frames) ? frames : [frames]).entries()) {
        if (index > 0) await delay(DPI_AXIS_GAP_MS);
        await this.sendFrame(frame);
      }
      if (!confirm) return;
      const confirmed = await this.confirmByTelemetry(confirm.accept);
      if (!confirmed && this.telemetry && !confirm.accept(this.telemetry)) {
        throw new Error(confirm.mismatch(this.telemetry));
      }
    });
  }

  /**
   * DPI values are encoded per sensor (50 or 100 counts per step), so a write
   * waits for the mouse to report which sensor it has rather than assume one.
   */
  private requireSensor(): RyunixSensor {
    const sensorType = this.telemetry?.sensorType ?? null;
    if (sensorType === null) {
      throw new Error("The mouse has not reported its sensor yet, so DPI cannot be written safely.");
    }
    return ryunixSensor(sensorType);
  }

  /** The vendor app seeds a table the first time, since the mouse never reports one. */
  private tableFor(state: WriteOnlyState): number[] {
    return state.dpiStages ? [...state.dpiStages] : ryunixDefaultDpiStages(ryunixSensor(this.telemetry?.sensorType ?? null));
  }

  private async writeDpiTable(
    stages: number[],
    activeStage: number,
    confirm?: Confirmation,
  ): Promise<void> {
    const sensor = this.requireSensor();
    const state = stateFor(this.device.productId);
    const table = { stages, activeStage };
    await this.send((sequence) => [
      ryunixSetDpiFrame(sequence(), table, sensor, "x"),
      ryunixSetDpiFrame(sequence(), table, sensor, "y"),
      ryunixSetDpiColorsFrame(sequence(), state.dpiColors),
    ], confirm);
    state.dpiStages = [...stages];
  }

  private activeStage(count: number): number {
    const reported = this.telemetry?.dpiStage ?? 0;
    return reported < count ? reported : 0;
  }

  public readStatus(): Promise<MouseStatus> {
    return this.enqueue(async () => {
      await this.open();
      await this.refreshTelemetry();
      return this.buildStatus();
    });
  }

  private buildStatus(): MouseStatus {
    const telemetry = this.telemetry;
    const state = stateFor(this.device.productId);
    const sensor = ryunixSensor(telemetry?.sensorType ?? null);
    const wireless = this.isWireless();
    // Until a table is written the mouse's own stages are unknown; the vendor's
    // defaults are shown so the editor has rows, and the note below says so.
    const stages = this.tableFor(state);
    const activeStage = this.activeStage(stages.length);

    const effects = this.lightingEffects();
    const mode = telemetry ? LIGHTING_MODE_NAMES[telemetry.ledModeCode] ?? null : null;
    const lighting: MouseLighting | undefined = telemetry && effects.length > 0 ? {
      zone: "Mouse",
      modes: effects.map((code) => LIGHTING_MODE_NAMES[code]!),
      mode,
      // No effect has its own colour: Breathe takes the active DPI stage's colour.
      color: null,
      color2: null,
      colorModes: [],
      dualColorModes: [],
      reactiveModes: ["Breathing single"],
      speeds: [...RYUNIX_SPEED_LEVELS],
      speed: state.speed,
      brightness: BRIGHTNESS_PERCENT[state.brightness - 1] ?? 100,
      brightnessLevels: [...BRIGHTNESS_PERCENT],
    } : undefined;

    const buttonMappings: Record<string, string> = {};
    for (const [index, slot] of RYUNIX_BUTTON_SLOTS.entries()) {
      const code = state.buttons[index];
      buttonMappings[slot.name] = (code ? ryunixButtonActionName(code) : null) ?? slot.factory;
    }

    const liftOffMm = state.liftOffMm ?? VENDOR_DEFAULTS.liftOffMm;
    const liftOff = (Object.entries(LIFT_OFF_LEVEL_MM).find(([, mm]) => mm === liftOffMm)?.[0] as LiftOffLevel | undefined) ?? null;

    return {
      brand: this.deviceBrand(),
      name: this.displayName(),
      ui: {
        family: "amkette-xs",
        settingsReady: true,
        valuesVerified: telemetry !== null,
        hideUnsupportedPollingRates: true,
        hideSignalCard: true,
        forceShowBattery: true,
        showAdvancedSection: true,
        defaultDisplayName: AMKETTE_XS_FALLBACK_NAME,
        statusNote: "This mouse reports battery, active DPI stage, polling rate and lighting mode. DPI values, lift-off, sleep, processing options and buttons cannot be read back: they show what OpenMouse last wrote, and the vendor app's defaults until then. Choosing a stage or changing a DPI value writes the whole stage table as shown here, replacing stages stored on the mouse by another tool.",
        dpiStageEditor: {
          maxStages: RYUNIX_DPI_MAX_STAGES,
          countEditable: true,
          minDpi: RYUNIX_DPI_MIN,
          maxDpi: sensor.maxDpi,
          stepDpi: RYUNIX_DPI_STEP,
        },
      },
      batteryPercent: telemetry?.batteryPercent ?? null,
      batteryState: batteryState(telemetry),
      dpi: stages[activeStage] ?? 0,
      dpiStages: [...stages],
      activeDpiStage: activeStage,
      dpiStageColors: state.dpiColors.slice(0, stages.length),
      pollingRateHz: telemetry?.pollingRateHz ?? 0,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: this.connectionDetail(),
      liftOffDistance: liftOff,
      supportedLiftOffDistances: ["Low", "High"],
      sleepTimeout: (state.sleepMinutes ?? VENDOR_DEFAULTS.sleepMinutes) * 60,
      angleSnapping: state.angleSnapping ?? VENDOR_DEFAULTS.angleSnapping,
      motionSync: state.motionSync ?? VENDOR_DEFAULTS.motionSync,
      rippleControl: state.rippleControl ?? VENDOR_DEFAULTS.rippleControl,
      buttonMappings,
      buttonOptions: [...RYUNIX_BUTTON_ACTIONS.keys()],
      ...(lighting ? { lighting } : {}),
      firmware: [],
    };
  }

  public async setPollingRate(pollingRateHz: number): Promise<number> {
    if (!this.getSupportedPollingRates().includes(pollingRateHz)) {
      throw new Error(`This mouse does not offer ${pollingRateHz} Hz.`);
    }
    await this.send((sequence) => ryunixSetPollingRateFrame(sequence(), pollingRateHz), {
      accept: (value) => value.pollingRateHz === pollingRateHz,
      mismatch: (value) => `The mouse still reports ${value.pollingRateHz} Hz after the change.`,
    });
    return pollingRateHz;
  }

  public async setDpi(dpi: number): Promise<number> {
    const stages = this.tableFor(stateFor(this.device.productId));
    return this.writeStageValue(stages, this.activeStage(stages.length), dpi);
  }

  public async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    return this.writeStageValue(this.tableFor(stateFor(this.device.productId)), stage, dpi);
  }

  private async writeStageValue(stages: number[], stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= stages.length) {
      throw new RangeError(`Invalid DPI stage ${stage + 1}.`);
    }
    const value = ryunixClampDpi(dpi, this.requireSensor());
    stages[stage] = value;
    await this.writeDpiTable(stages, this.activeStage(stages.length));
    return value;
  }

  /**
   * The mouse selects a stage only through a full table write, so this writes
   * the table OpenMouse shows (the vendor's defaults until something else has
   * been written this session) with the chosen stage active, as Amkette's own
   * configurator does on every stage click. Stages stored on the mouse by
   * another tool are replaced by the shown values.
   */
  public async setActiveDpiStage(stage: number): Promise<number> {
    const stages = this.tableFor(stateFor(this.device.productId));
    if (!Number.isInteger(stage) || stage < 0 || stage >= stages.length) {
      throw new RangeError(`Invalid DPI stage ${stage + 1}.`);
    }
    await this.writeDpiTable(stages, stage, {
      accept: (value) => value.dpiStage === stage,
      mismatch: (value) => `The mouse still reports DPI stage ${value.dpiStage + 1} after the change.`,
    });
    return stage;
  }

  public async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > RYUNIX_DPI_MAX_STAGES) {
      throw new RangeError(`A DPI table needs 1 to ${RYUNIX_DPI_MAX_STAGES} stages.`);
    }
    const sensor = this.requireSensor();
    const current = this.tableFor(stateFor(this.device.productId));
    const stages = ryunixDefaultDpiStages(sensor, RYUNIX_DPI_MAX_STAGES)
      .map((fallback, index) => current[index] ?? fallback)
      .slice(0, count);
    await this.writeDpiTable(stages, this.activeStage(stages.length));
    return count;
  }

  public async setDpiStageColor(index: number, color: string): Promise<string> {
    ryunixParseColor(color);
    const state = stateFor(this.device.productId);
    if (!Number.isInteger(index) || index < 0 || index >= RYUNIX_DPI_MAX_STAGES) {
      throw new RangeError(`Invalid DPI stage ${index + 1}.`);
    }
    const colors = [...state.dpiColors];
    colors[index] = color.toLowerCase();
    await this.send((sequence) => ryunixSetDpiColorsFrame(sequence(), colors));
    state.dpiColors = colors;
    return colors[index]!;
  }

  public async setLiftOffDistance(level: LiftOffLevel): Promise<LiftOffLevel> {
    const millimetres = LIFT_OFF_LEVEL_MM[level];
    if (millimetres === undefined || !(RYUNIX_LIFT_OFF_MM as readonly number[]).includes(millimetres)) {
      throw new Error(`This mouse offers Low and High lift-off, not ${level}.`);
    }
    await this.send((sequence) => ryunixSetLiftOffFrame(sequence(), millimetres));
    stateFor(this.device.productId).liftOffMm = millimetres;
    return level;
  }

  /** Auto sleep in seconds; the mouse stores whole minutes from 1 to 15. */
  public async setSleepTimeout(seconds: number): Promise<number> {
    const minutes = Math.min(
      RYUNIX_SLEEP_MAX_MINUTES,
      Math.max(RYUNIX_SLEEP_MIN_MINUTES, Math.round(seconds / 60)),
    );
    // The vendor app also sends its wake-on-move and light-on-move defaults.
    await this.send((sequence) => ryunixSetPowerFrame(sequence(), {
      sleepMinutes: minutes,
      wakeOnMove: true,
      lightOnMove: false,
    }));
    stateFor(this.device.productId).sleepMinutes = minutes;
    return minutes * 60;
  }

  private async writeSensorOptions(patch: Partial<Record<"angleSnapping" | "motionSync" | "rippleControl", boolean>>): Promise<void> {
    const state = stateFor(this.device.productId);
    // The mouse cannot report these, so unwritten ones take the vendor app's defaults.
    const next = {
      angleSnapping: patch.angleSnapping ?? state.angleSnapping ?? VENDOR_DEFAULTS.angleSnapping,
      motionSync: patch.motionSync ?? state.motionSync ?? VENDOR_DEFAULTS.motionSync,
      rippleControl: patch.rippleControl ?? state.rippleControl ?? VENDOR_DEFAULTS.rippleControl,
    };
    await this.send((sequence) => ryunixSetSensorOptionsFrame(sequence(), next));
    Object.assign(state, next);
  }

  public async setAngleSnapping(enabled: boolean): Promise<boolean> {
    await this.writeSensorOptions({ angleSnapping: enabled });
    return enabled;
  }

  public async setMotionSync(enabled: boolean): Promise<boolean> {
    await this.writeSensorOptions({ motionSync: enabled });
    return enabled;
  }

  public async setRippleControl(enabled: boolean): Promise<boolean> {
    await this.writeSensorOptions({ rippleControl: enabled });
    return enabled;
  }

  public async setLighting(lighting: Pick<MouseLighting, "mode"> & Partial<Pick<MouseLighting, "speed" | "brightness">>): Promise<MouseLightingMode> {
    const effect = this.lightingEffects().find((code) => LIGHTING_MODE_NAMES[code] === lighting.mode);
    if (effect === undefined || !lighting.mode) {
      throw new Error(`This mouse does not offer the ${lighting.mode ?? "selected"} lighting effect.`);
    }
    const state = stateFor(this.device.productId);
    const level = lighting.brightness == null
      ? state.brightness
      : RYUNIX_BRIGHTNESS_LEVELS[BRIGHTNESS_PERCENT.indexOf(lighting.brightness as 25 | 50 | 75 | 100)];
    if (level === undefined) throw new Error(`Brightness ${lighting.brightness}% is not available.`);
    const speed = lighting.speed ?? state.speed;
    if (!(RYUNIX_SPEED_LEVELS as readonly number[]).includes(speed)) {
      throw new Error(`Lighting speed ${speed} is not available.`);
    }
    await this.send((sequence) => ryunixSetLightingFrame(sequence(), { effect, brightness: level, speed }), {
      accept: (value) => value.ledModeCode === effect,
      mismatch: () => "The mouse still reports its previous lighting effect after the change.",
    });
    state.brightness = level;
    state.speed = speed;
    return lighting.mode;
  }

  /**
   * `button` is the slot name from `buttonMappings`; `action` one of
   * `buttonOptions`. Every write carries all ten positions; positions not
   * changed in this session are written as the vendor app's default layout, as
   * the vendor app does, rather than 0xFF, whose meaning here is unknown.
   */
  public async setButtonMapping(button: string, action: string): Promise<string> {
    const index = RYUNIX_BUTTON_SLOTS.findIndex((slot) => slot.name === button);
    if (index < 0) throw new Error(`Unknown button "${button}".`);
    const code = RYUNIX_BUTTON_ACTIONS.get(action);
    if (!code) throw new Error(`Unknown button action "${action}".`);
    const state = stateFor(this.device.productId);
    const changed = [...state.buttons];
    changed[index] = code;
    const positions = RYUNIX_BUTTON_FACTORY_CODES.map((factory, position) => changed[position] ?? factory);
    await this.send((sequence) => ryunixSetButtonsFrames([sequence(), sequence()], positions));
    state.buttons = changed;
    return action;
  }
}
