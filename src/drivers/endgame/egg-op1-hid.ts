import type { MouseStatus } from "../mouse-types.ts";
import { isStaleHandleError } from "./stale-handle.ts";
import {
  EGG_4K_DONGLE_PID,
  EGG_4K_OFFSET,
  EGG_4K_POLLING_RATES,
  EGG_4K_V1_POLLING_RATES,
  EGG_BUTTON_ACTION_OPTIONS,
  EGG_COMMAND_SIZE,
  EGG_CONFIG_SIZE,
  EGG_DEVICE_PROFILES,
  EGG_OFFSET,
  EGG_OPERATION,
  EGG_POLLING_RATES,
  EGG_REPORT,
  EGG_VENDOR_ID,
  eggBlockWrites,
  eggButtonActionLabel,
  eggButtonControlOffset,
  eggButtonMappingOffset,
  eggClampCpi,
  eggDecodeButtonAction,
  eggDpiOptions,
  eggEncodeButtonAction,
  eggFormatFirmwareVersion,
  eggIsPlainLeftAction,
  eggIsValidCpi,
  eggLodOptions,
  eggNormalizeFeatureReport,
  eggProfileForPid,
  eggReadUint16LE,
  eggWriteEnabledCpiStages,
  eggWriteUint16LE,
  type EggButtonAction,
  type EggDeviceProfile,
} from "@openmouse/protocol/endgame-gear-op1";

export interface EggOp1Status extends MouseStatus {
  eggCpiLevels: number;
  eggCpiStages: Array<{ x: number; y: number }>;
  eggCpiMin: number;
  eggCpiMax: number;
  eggCpiStepLow: number;
  eggCpiStepHigh: number;
  eggPollingDivider?: number;
  eggLodIndex: number;
  eggLodOptions: string[];
  eggMulticlickFilters: number[];
  eggButtonMappings: string[];
  eggGlassMode: boolean;
  eggSupportsGlassMode: boolean;
  eggMotionSyncAt8k: boolean;
  eggAngleTuning?: number;
  eggForceMaxFps?: boolean;
  eggLedLiftOffDisabled?: boolean;
  eggSupportsV2SensorControls: boolean;
  eggButtonActions: EggButtonAction[];
  eggLeftHanded: boolean;
}

const STATUS_OK = 0x01;
const STATUS_BUSY = 0x03;
const FILTER = {
  slamclick: 0x01,
  motionJitter: 0x10,
} as const;
const BUTTON_CONFIG_SIZE = 7;
const SPDT = {
  "Off": 0x08,
  "GX Safe": 0xf0,
  "GX Speed": 0xf1,
} as const;

export type EggSpdtMode = keyof typeof SPDT;
export const EGG_BUTTON_NAMES = ["Left", "Right", "Middle", "Forward", "Back", "Wheel Up", "Wheel Down"] as const;
export type EggButtonIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const EGG_BUTTON_MAPPINGS = [
  "Left Click", "Right Click", "Middle Click", "Back", "Forward",
  "Scroll Up", "Scroll Down", "CPI Cycle", "Disabled",
] as const;
export type EggButtonMapping = (typeof EGG_BUTTON_MAPPINGS)[number];
export { EGG_BUTTON_ACTION_OPTIONS };

interface ReceivedFeature {
  bytes: Uint8Array;
  rawLength: number;
}

export class EggOp1HidClient {
  private chain: Promise<unknown> = Promise.resolve();
  private configPayloadLength = EGG_CONFIG_SIZE - 1;
  private commandPayloadLength = EGG_COMMAND_SIZE - 1;
  private firmwareVersion: string | null | undefined;
  /** False on the shared 4K dongle until the mouse-info reply says which mouse is paired. */
  private modelKnown: boolean;

  /** On the shared 4K dongle, switches to the paired mouse's profile once it is identified. */
  profile: EggDeviceProfile;
  onDeviceChange?: () => void;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== EGG_REPORT.event || event.data.byteLength < 2) return;
    const type = event.data.getUint8(0);
    if (type === 0x02 || type === 0x06) this.onDeviceChange?.();
  };

  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
    this.profile = eggProfileForPid(device.productId);
    this.modelKnown = device.productId !== EGG_4K_DONGLE_PID;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === EGG_VENDOR_ID
      && EGG_DEVICE_PROFILES.has(device.productId)
      && this.collectionHasFeatureReport(device.collections, EGG_REPORT.command);
  }

  private static collectionHasFeatureReport(collections: readonly HIDCollectionInfo[] | undefined | null, reportId: number): boolean {
    return (collections ?? []).some((collection) =>
      (collection.featureReports ?? []).some((report) => report.reportId === reportId)
      || this.collectionHasFeatureReport(collection.children ?? [], reportId));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.configPayloadLength = this.featurePayloadLength(EGG_REPORT.config, EGG_CONFIG_SIZE - 1);
    this.commandPayloadLength = this.featurePayloadLength(EGG_REPORT.command, EGG_COMMAND_SIZE - 1);
    this.device.removeEventListener("inputreport", this.onInputReport);
    this.device.addEventListener("inputreport", this.onInputReport);
  }

  describeCollections(): string {
    return (this.device.collections ?? []).map((collection) => {
      const reports = (collection.featureReports ?? []).map((report) => `0x${report.reportId.toString(16)}`);
      return `usage 0x${collection.usagePage.toString(16)}:0x${collection.usage.toString(16)} · feature ${reports.join(", ") || "none"}`;
    }).join(" | ") || "No HID collections reported";
  }

  getDpiOptions(): number[] {
    return eggDpiOptions(this.profile);
  }

  clampDpi(dpi: number): number {
    return eggClampCpi(this.profile, dpi);
  }

  async readStatus(): Promise<EggOp1Status> {
    const config = await this.readConfig();
    // Retried on each read until the mouse answers: over the dongle it sleeps quickly.
    if (!this.modelKnown) await this.run(() => this.identifyPairedMouse()).catch(() => undefined);
    const cpiLevels = Math.min(Math.max(config[EGG_OFFSET.cpiLevels], 1), 4);
    // Firmware does not persist the currently selected runtime stage. Stage 1
    // is the stable representative for the generic DPI readout; the complete
    // stage list below remains authoritative for per-stage configuration.
    const dpi = eggReadUint16LE(config, EGG_OFFSET.firstCpiSplit + 1);
    const dpiY = eggReadUint16LE(config, EGG_OFFSET.firstCpiSplit + 3);
    if (!eggIsValidCpi(this.profile, dpi) || !eggIsValidCpi(this.profile, dpiY)) {
      throw new Error(`The mouse reported an unsupported X ${dpi} / Y ${dpiY} CPI value.`);
    }
    if (this.firmwareVersion === undefined) {
      this.firmwareVersion = await this.readFirmware().catch(() => null);
    }
    const glassMode = this.profile.lodGlass !== null && config[EGG_OFFSET.glassMode] !== 0;
    const lodOptions = eggLodOptions(this.profile, glassMode);
    const lodIndex = config[EGG_OFFSET.lod] - this.lodBase(glassMode);
    const handedBytes = Array.from(config.slice(EGG_OFFSET.handedButton, EGG_OFFSET.handedButton + 6));
    const leftHanded = !eggIsPlainLeftAction(handedBytes) && handedBytes.some(Boolean);
    const buttonActions = EGG_BUTTON_NAMES.map((_, index) =>
      this.decodePhysicalButtonAction(config, index as EggButtonIndex, leftHanded));
    return {
      brand: "Endgame Gear",
      name: this.profile.name,
      batteryPercent: null,
      batteryState: "Unknown",
      dpi,
      dpiY,
      supportsSeparateDpiAxes: true,
      pollingRateHz: this.decodePollingRate(config[EGG_OFFSET.pollingDivider]),
      supportedPollingRates: this.supportedPollingRates(),
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: `Wired USB - PID 0x${this.device.productId.toString(16).toUpperCase()} - ${this.profile.sensorFamily.toUpperCase()}`,
      motionSync: config[EGG_OFFSET.motionSync] !== 0,
      angleSnapping: config[EGG_OFFSET.angleSnapping] !== 0,
      rippleControl: config[EGG_OFFSET.rippleControl] !== 0,
      slamclickFilter: (config[EGG_OFFSET.filterFlags] & FILTER.slamclick) !== 0,
      // Bit 4 is the 4K v1's jitter filter; the 4K v2 tool never writes it.
      motionJitterFilter: this.is4kV2() ? null : (config[EGG_OFFSET.filterFlags] & FILTER.motionJitter) !== 0,
      leftSpdtMode: this.decodeSpdtMode(config[EGG_OFFSET.firstButton]),
      rightSpdtMode: this.decodeSpdtMode(config[EGG_OFFSET.firstButton + BUTTON_CONFIG_SIZE]),
      eggCpiLevels: cpiLevels,
      eggCpiMin: this.profile.cpiMin,
      eggCpiMax: this.profile.cpiMax,
      eggCpiStepLow: this.profile.cpiStepLow,
      eggCpiStepHigh: this.profile.cpiStepHigh,
      eggCpiStages: Array.from({ length: 4 }, (_, level) => {
        const offset = EGG_OFFSET.firstCpiSplit + level * 5;
        return { x: eggReadUint16LE(config, offset + 1), y: eggReadUint16LE(config, offset + 3) };
      }),
      // The 4K v2 polling byte is a vendor enum, so a free divider does not apply there.
      eggPollingDivider: this.profile.wireless4k ? undefined : config[EGG_OFFSET.pollingDivider],
      eggLodIndex: lodIndex,
      eggLodOptions: [...lodOptions],
      eggGlassMode: glassMode,
      eggSupportsGlassMode: this.profile.lodGlass !== null,
      eggMotionSyncAt8k: this.profile.motionSyncAt8k,
      eggAngleTuning: this.profile.configFamily === "v2"
        ? this.decodeInt8(config[this.angleTuningOffset()])
        : undefined,
      eggForceMaxFps: this.profile.configFamily === "v2"
        ? this.profile.wireless4k
          ? (config[EGG_OFFSET.filterFlags] & EGG_4K_OFFSET.forceMaxFpsFlag) !== 0
          : config[EGG_OFFSET.forceMaxFps] !== 0
        : undefined,
      eggLedLiftOffDisabled: this.profile.configFamily === "v2"
        ? config[EGG_OFFSET.ledLiftOff] === 0
        : undefined,
      eggSupportsV2SensorControls: this.profile.configFamily === "v2",
      eggMulticlickFilters: Array.from({ length: 5 }, (_, index) => {
        const offset = eggButtonControlOffset(index);
        if (offset === null) throw new Error(`Missing multiclick offset for button ${index}.`);
        const value = config[offset];
        return value >= 0xf0 ? 8 : value;
      }),
      eggButtonMappings: buttonActions.map(eggButtonActionLabel),
      eggButtonActions: buttonActions,
      eggLeftHanded: leftHanded,
      liftOffDistance: this.genericLod(lodOptions[lodIndex]),
      firmware: this.firmwareVersion ? [`Firmware ${this.firmwareVersion}`] : ["Firmware unavailable"],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    this.assertCpi(dpi);
    const confirmed = await this.updateConfig((config) => {
      eggWriteEnabledCpiStages(config, dpi, dpi);
    });
    const levels = Math.min(Math.max(confirmed[EGG_OFFSET.cpiLevels], 1), 4);
    for (let level = 0; level < levels; level += 1) {
      const offset = EGG_OFFSET.firstCpiSplit + level * 5;
      const confirmedX = eggReadUint16LE(confirmed, offset + 1);
      const confirmedY = eggReadUint16LE(confirmed, offset + 3);
      if (confirmedX !== dpi || confirmedY !== dpi) {
        throw new Error(`The mouse kept CPI stage ${level + 1} at ${confirmedX}/${confirmedY} instead of ${dpi} CPI.`);
      }
    }
    return dpi;
  }

  /** The 4K v2 takes only its vendor enum values; wired 8K models use any 8000 / rate divider. */
  supportedPollingRates(): number[] {
    if (this.profile.wireless4k) return [...(this.is4kV2() ? EGG_4K_POLLING_RATES : EGG_4K_V1_POLLING_RATES)];
    return EGG_POLLING_RATES.filter((rate) => rate <= this.profile.maxPollingHz);
  }

  async setPollingRate(rate: number): Promise<number> {
    if (!this.supportedPollingRates().includes(rate)) {
      throw new Error("Unsupported Endgame Gear 8K polling rate.");
    }
    const divider = 8000 / rate;
    const confirmed = await this.updateConfig((config) => {
      if (this.profile.lodGlass !== null && config[EGG_OFFSET.glassMode] !== 0) {
        throw new Error("Polling rate is controlled by firmware while Glass Mode is active.");
      }
      config[EGG_OFFSET.pollingDivider] = divider;
      if (rate === 8000 && !this.profile.motionSyncAt8k) config[EGG_OFFSET.motionSync] = 0;
    });
    const confirmedRate = this.decodePollingRate(confirmed[EGG_OFFSET.pollingDivider]);
    if (confirmedRate !== rate) throw new Error(`The mouse kept ${confirmedRate} Hz instead of ${rate} Hz.`);
    return confirmedRate;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<void> {
    const target = value === "Low" ? "0.7 mm" : value === "Medium" ? "1.0 mm" : "2.0 mm";
    const fallback = value === "Medium" ? "1 mm" : value === "High" ? "2 mm" : target;
    const config = await this.readConfig();
    const glassMode = this.profile.lodGlass !== null && config[EGG_OFFSET.glassMode] !== 0;
    const options = eggLodOptions(this.profile, glassMode);
    const index = options.findIndex((option) => option === target || option === fallback);
    if (index < 0) throw new Error(`${this.profile.name} does not expose ${target} in its current sensor mode.`);
    await this.setEggLodIndex(index);
  }

  async setEggLodIndex(index: number): Promise<void> {
    const confirmed = await this.updateConfig((config) => {
      const glassMode = this.profile.lodGlass !== null && config[EGG_OFFSET.glassMode] !== 0;
      const options = eggLodOptions(this.profile, glassMode);
      if (!Number.isInteger(index) || index < 0 || index >= options.length) {
        throw new Error("Invalid lift-off distance for this mouse and sensor mode.");
      }
      config[EGG_OFFSET.lod] = index + this.lodBase(glassMode);
    });
    const confirmedGlass = this.profile.lodGlass !== null && confirmed[EGG_OFFSET.glassMode] !== 0;
    if (confirmed[EGG_OFFSET.lod] - this.lodBase(confirmedGlass) !== index) {
      throw new Error("The mouse did not confirm the requested lift-off distance.");
    }
  }

  async setGlassMode(enabled: boolean): Promise<void> {
    if (this.profile.lodGlass === null) throw new Error(`${this.profile.name} does not support Glass Mode.`);
    const confirmed = await this.updateConfig((config) => {
      const wasEnabled = config[EGG_OFFSET.glassMode] !== 0;
      const lod = config[EGG_OFFSET.lod];
      config[EGG_OFFSET.glassMode] = enabled ? 1 : 0;
      if (!this.profile.wireless4k) config[EGG_OFFSET.lod] = 0;
      // The 4K v2 vendor tool's own rescale between the 0.1 mm and whole-mm LOD scales.
      else if (enabled && !wasEnabled) config[EGG_OFFSET.lod] = lod < 8 ? 1 : lod <= 10 ? 2 : lod;
      else if (!enabled && wasEnabled) config[EGG_OFFSET.lod] = lod === 1 ? 3 : lod === 2 ? 10 : lod;
    });
    if ((confirmed[EGG_OFFSET.glassMode] !== 0) !== enabled) {
      throw new Error("The mouse did not confirm Glass Mode.");
    }
  }

  async setSensorAngleTuning(value: number): Promise<void> {
    this.assertV2SensorControl("Sensor Angle Tuning");
    if (!Number.isInteger(value) || value < -127 || value > 127) {
      throw new Error("Sensor Angle Tuning must be an integer from -127 to 127.");
    }
    const offset = this.angleTuningOffset();
    const confirmed = await this.updateConfig((config) => { config[offset] = value & 0xff; });
    if (this.decodeInt8(confirmed[offset]) !== value) {
      throw new Error("The mouse did not confirm Sensor Angle Tuning.");
    }
  }

  async setForceMaxSensorFps(enabled: boolean): Promise<void> {
    this.assertV2SensorControl("Force max Sensor FPS");
    if (this.profile.wireless4k) await this.setFilterFlag(EGG_4K_OFFSET.forceMaxFpsFlag, enabled, "Force max Sensor FPS");
    else await this.setBoolean(EGG_OFFSET.forceMaxFps, enabled, "Force max Sensor FPS");
  }

  async setLedLiftOffDisabled(enabled: boolean): Promise<void> {
    this.assertV2SensorControl("Disable LED on Lift-Off");
    const confirmed = await this.updateConfig((config) => { config[EGG_OFFSET.ledLiftOff] = enabled ? 0 : 1; });
    if ((confirmed[EGG_OFFSET.ledLiftOff] === 0) !== enabled) {
      throw new Error("The mouse did not confirm the lift-off LED setting.");
    }
  }

  async setMotionSync(enabled: boolean): Promise<void> {
    if (enabled && !this.profile.motionSyncAt8k) {
      const config = await this.readConfig();
      if (this.decodePollingRate(config[EGG_OFFSET.pollingDivider]) === 8000) {
        throw new Error(`${this.profile.name} cannot use Motion Sync at 8,000 Hz.`);
      }
    }
    await this.setBoolean(EGG_OFFSET.motionSync, enabled, "Motion Sync");
  }

  async setAngleSnapping(enabled: boolean): Promise<void> {
    await this.setBoolean(EGG_OFFSET.angleSnapping, enabled, "angle snapping");
  }

  async setRippleControl(enabled: boolean): Promise<void> {
    await this.setBoolean(EGG_OFFSET.rippleControl, enabled, "ripple control");
  }

  async setSlamclickFilter(enabled: boolean): Promise<void> {
    await this.setFilterFlag(FILTER.slamclick, enabled, "slamclick filter");
  }

  async setMotionJitterFilter(enabled: boolean): Promise<void> {
    if (this.is4kV2()) throw new Error(`${this.profile.name} has no motion-jitter filter.`);
    await this.setFilterFlag(FILTER.motionJitter, enabled, "motion-jitter filter");
  }

  async setSpdtMode(button: "left" | "right", mode: EggSpdtMode): Promise<void> {
    const offset = EGG_OFFSET.firstButton + (button === "right" ? BUTTON_CONFIG_SIZE : 0);
    const confirmed = await this.updateConfig((config) => { config[offset] = SPDT[mode]; });
    const actual = this.decodeSpdtMode(confirmed[offset]);
    if (actual !== mode) throw new Error(`The mouse kept the ${button} button in ${actual} mode instead of ${mode}.`);
  }

  async setCpiLevels(levels: number): Promise<void> {
    if (!Number.isInteger(levels) || levels < 1 || levels > 4) throw new Error("The OP1/XM2 supports one to four CPI stages.");
    const confirmed = await this.updateConfig((config) => {
      config[EGG_OFFSET.cpiLevels] = levels;
    });
    if (confirmed[EGG_OFFSET.cpiLevels] !== levels) throw new Error("The mouse did not confirm the CPI stage count.");
  }

  async setCpiStage(level: number, x: number, y: number): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level > 3) throw new Error("Invalid CPI stage.");
    this.assertCpi(x);
    this.assertCpi(y);
    const offset = EGG_OFFSET.firstCpiSplit + level * 5;
    const confirmed = await this.updateConfig((config) => {
      config[offset] = x === y ? 0 : 1;
      eggWriteUint16LE(config, offset + 1, x);
      eggWriteUint16LE(config, offset + 3, y);
    });
    if (eggReadUint16LE(confirmed, offset + 1) !== x || eggReadUint16LE(confirmed, offset + 3) !== y) {
      throw new Error(`The mouse did not confirm CPI stage ${level + 1}.`);
    }
  }

  async setCustomPollingDivider(divider: number): Promise<void> {
    if (this.profile.wireless4k) throw new Error(`${this.profile.name} only accepts its listed polling rates.`);
    if (!Number.isInteger(divider) || divider < 1 || divider > 255) throw new Error("Polling divider must be an integer from 1 to 255.");
    const confirmed = await this.updateConfig((config) => {
      if (this.profile.lodGlass !== null && config[EGG_OFFSET.glassMode] !== 0) {
        throw new Error("Polling rate is controlled by firmware while Glass Mode is active.");
      }
      config[EGG_OFFSET.pollingDivider] = divider;
    });
    if (confirmed[EGG_OFFSET.pollingDivider] !== divider) throw new Error("The mouse did not confirm the custom polling divider.");
  }

  async setMulticlickFilter(button: EggButtonIndex, value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0 || value > 25) throw new Error("Multiclick filtering must be from 0 to 25.");
    const offset = eggButtonControlOffset(button);
    if (offset === null) throw new Error(`${EGG_BUTTON_NAMES[button]} has no multiclick filter.`);
    const confirmed = await this.updateConfig((config) => {
      if (button < 2 && config[offset] >= 0xf0) {
        throw new Error(`Turn GX mode off for the ${EGG_BUTTON_NAMES[button]} button first.`);
      }
      config[offset] = value;
    });
    if (confirmed[offset] !== value) throw new Error(`The mouse did not confirm the ${EGG_BUTTON_NAMES[button]} multiclick value.`);
  }

  async setButtonMapping(button: EggButtonIndex, action: EggButtonAction | EggButtonMapping): Promise<void> {
    if (typeof action === "string") {
      const legacy = {
        "Left Click": { key: "mouse-left" }, "Right Click": { key: "mouse-right" },
        "Middle Click": { key: "mouse-middle" }, "Back": { key: "mouse-back" },
        "Forward": { key: "mouse-forward" }, "Scroll Up": { key: "scroll-up" },
        "Scroll Down": { key: "scroll-down" }, "CPI Cycle": { key: "cpi-loop" },
        "Disabled": { key: "disabled" },
      } as const;
      action = legacy[action];
    }
    const encoded = eggEncodeButtonAction(action);
    if (!encoded) throw new Error("Unknown mappings are preserved until a supported action is selected.");
    if (action.key === "fixed-cpi") {
      this.assertCpi(action.x ?? 0);
      this.assertCpi(action.y ?? action.x ?? 0);
    }
    const confirmed = await this.updateConfig((config) => {
      const leftHanded = this.configIsLeftHanded(config);
      if ((button === 0 && !leftHanded) || (button === 1 && leftHanded)) {
        throw new Error(`${EGG_BUTTON_NAMES[button]} is the fixed primary button in the current handedness mode.`);
      }
      this.writePhysicalButtonAction(config, button, encoded, leftHanded);
    });
    const actual = this.decodePhysicalButtonAction(confirmed, button, this.configIsLeftHanded(confirmed));
    if (JSON.stringify(eggEncodeButtonAction(actual)) !== JSON.stringify(encoded)) {
      throw new Error(`The mouse kept the ${EGG_BUTTON_NAMES[button]} mapping as ${eggButtonActionLabel(actual)}.`);
    }
  }

  async setLeftHanded(enabled: boolean): Promise<void> {
    const confirmed = await this.updateConfig((config) => {
      if (enabled) {
        this.writeActionAt(config, EGG_OFFSET.handedButton, { type: 0x00, params: [0x02, 0, 0, 0, 0] });
        this.writeActionAt(config, EGG_OFFSET.firstButton + 1, { type: 0x00, params: [0x01, 0, 0, 0, 0] });
      } else {
        this.writeActionAt(config, EGG_OFFSET.handedButton, { type: 0x00, params: [0x01, 0, 0, 0, 0] });
        this.writeActionAt(config, EGG_OFFSET.firstButton + 1, { type: 0x00, params: [0x02, 0, 0, 0, 0] });
      }
    });
    if (this.configIsLeftHanded(confirmed) !== enabled) throw new Error("The mouse did not confirm left-handed mode.");
  }

  async factoryReset(): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.sendCommand(EGG_OPERATION.factoryReset);
      await this.delay(1100);
      if (!await this.pollCommandOk(8)) throw new Error("The EGG mouse did not acknowledge the factory reset.");
    });
  }

  async close(): Promise<void> {
    this.onDeviceChange = undefined;
    this.device.removeEventListener("inputreport", this.onInputReport);
    if (this.device.opened) await this.device.close();
  }

  private assertCpi(value: number): void {
    if (!eggIsValidCpi(this.profile, value)) {
      throw new Error(
        `${this.profile.name} CPI must be ${this.profile.cpiMin.toLocaleString()} to ${this.profile.cpiMax.toLocaleString()} using the device's supported steps.`,
      );
    }
  }

  private assertV2SensorControl(label: string): void {
    if (this.profile.configFamily !== "v2") throw new Error(`${label} is available only on v2 mice.`);
  }

  private angleTuningOffset(): number {
    return this.profile.wireless4k ? EGG_4K_OFFSET.angleTuning : EGG_OFFSET.angleTuning;
  }

  /** 4K v1 LOD, and 4K v2 glass-mode LOD, is stored as whole millimetres, so option 0 (1 mm) is wire value 1. */
  private lodBase(glassMode: boolean): number {
    return this.profile.wireless4k && (glassMode || !this.is4kV2()) ? 1 : 0;
  }

  private is4kV2(): boolean {
    return this.profile.wireless4k === true && this.profile.configFamily === "v2";
  }

  private decodeInt8(value: number): number {
    return value > 127 ? value - 256 : value;
  }

  private async setBoolean(offset: number, enabled: boolean, label: string): Promise<void> {
    const confirmed = await this.updateConfig((config) => { config[offset] = enabled ? 1 : 0; });
    if ((confirmed[offset] !== 0) !== enabled) throw new Error(`The mouse did not confirm ${label}.`);
  }

  private async setFilterFlag(flag: number, enabled: boolean, label: string): Promise<void> {
    const confirmed = await this.updateConfig((config) => {
      config[EGG_OFFSET.filterFlags] = enabled
        ? config[EGG_OFFSET.filterFlags] | flag
        : config[EGG_OFFSET.filterFlags] & ~flag;
    });
    if (((confirmed[EGG_OFFSET.filterFlags] & flag) !== 0) !== enabled) {
      throw new Error(`The mouse did not confirm the ${label}.`);
    }
  }

  private decodeSpdtMode(value: number): EggSpdtMode {
    if (value === SPDT["GX Safe"]) return "GX Safe";
    if (value === SPDT["GX Speed"]) return "GX Speed";
    return "Off";
  }

  private configIsLeftHanded(config: Uint8Array): boolean {
    const handed = Array.from(config.slice(EGG_OFFSET.handedButton, EGG_OFFSET.handedButton + 6));
    return !eggIsPlainLeftAction(handed) && handed.some(Boolean);
  }

  private decodePhysicalButtonAction(
    config: Uint8Array,
    button: EggButtonIndex,
    leftHanded: boolean,
  ): EggButtonAction {
    if (button === 0) return this.decodeActionAt(config, EGG_OFFSET.handedButton);
    const offset = eggButtonMappingOffset(button, leftHanded);
    if (offset === null) return { key: "mouse-left" };
    return this.decodeActionAt(config, offset);
  }

  private decodeActionAt(config: Uint8Array, offset: number): EggButtonAction {
    return eggDecodeButtonAction(config[offset], Array.from(config.slice(offset + 1, offset + 6)));
  }

  private writePhysicalButtonAction(
    config: Uint8Array,
    button: EggButtonIndex,
    action: NonNullable<ReturnType<typeof eggEncodeButtonAction>>,
    leftHanded: boolean,
  ): void {
    if (button === 0) {
      this.writeActionAt(config, EGG_OFFSET.handedButton, action);
      if (leftHanded) {
        this.writeActionAt(config, EGG_OFFSET.firstButton + 1, { type: 0x00, params: [0x01, 0, 0, 0, 0] });
      }
      return;
    }
    const offset = eggButtonMappingOffset(button, leftHanded);
    if (offset === null) throw new Error(`${EGG_BUTTON_NAMES[button]} has no writable mapping slot.`);
    this.writeActionAt(config, offset, action);
  }

  private writeActionAt(
    config: Uint8Array,
    offset: number,
    action: NonNullable<ReturnType<typeof eggEncodeButtonAction>>,
  ): void {
    config[offset] = action.type;
    for (let index = 0; index < 5; index += 1) config[offset + index + 1] = action.params[index];
  }

  private genericLod(label: string | undefined): MouseStatus["liftOffDistance"] {
    if (label === "0.7 mm") return "Low";
    if (label === "1 mm" || label === "1.0 mm") return "Medium";
    if (label === "2 mm" || label === "2.0 mm") return "High";
    return null;
  }

  private updateConfig(change: (config: Uint8Array) => void): Promise<Uint8Array> {
    return this.run(async () => {
      // v1 and v2 share the dongle but encode lift-off and polling differently: never write blind.
      if (!this.modelKnown) await this.identifyPairedMouse();
      if (!this.modelKnown) throw new Error("The mouse behind the dongle has not identified itself yet. Move it to wake it, then try again.");
      const config = await this.readConfigRaw();
      const before = config.slice();
      change(config);
      if (this.profile.wireless4k) await this.writeConfigBlocks(before, config);
      else await this.writeConfigRaw(config);
      return this.readConfigRaw();
    });
  }

  private readConfig(): Promise<Uint8Array> {
    return this.run(() => this.readConfigRaw());
  }

  private async readConfigRaw(): Promise<Uint8Array> {
    await this.open();
    const trace: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      await this.sendCommand(EGG_OPERATION.load);
      await this.delay(80);
      let backoff = 60;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        for (const reportId of [EGG_REPORT.command, EGG_REPORT.config]) {
          try {
            const received = await this.receiveFeature(reportId, EGG_CONFIG_SIZE, this.configPayloadLength);
            if (this.isValidConfig(received.bytes, received.rawLength)) {
              received.bytes[0] = EGG_REPORT.config;
              return received.bytes;
            }
            trace.push(`GET 0x${reportId.toString(16)} len=${received.rawLength}`);
          } catch (error) {
            trace.push(error instanceof Error ? error.message : `GET 0x${reportId.toString(16)} failed`);
          }
        }
        await this.delay(backoff);
        backoff = Math.min(backoff * 2, 400);
      }
    }
    throw new Error(`The EGG mouse did not return a valid configuration (${trace.slice(-3).join("; ")}).`);
  }

  private async writeConfigRaw(config: Uint8Array): Promise<void> {
    const payload = new Uint8Array(this.configPayloadLength);
    payload.set(config.subarray(1, 1 + Math.min(config.length - 1, payload.length)));
    payload[0] = EGG_OPERATION.store;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // Only the first attempt may close/reopen; later attempts are plain retries so
        // recovery does not stack with this loop.
        await this.sendFeatureRecovering(EGG_REPORT.config, payload, attempt === 0);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await this.delay(50);
      }
    }
    if (lastError) throw lastError;
    await this.delay(300);
    const acknowledged = await this.pollCommandOk(8);
    if (!acknowledged) throw new Error("The EGG mouse did not acknowledge the configuration write.");
  }

  /** 4K v1 and v2: send only the blocks that changed, like the vendor tools. Both button chunks go together. */
  private async writeConfigBlocks(before: Uint8Array, after: Uint8Array): Promise<void> {
    const glass = this.profile.lodGlass !== null;
    const old = eggBlockWrites(before, glass);
    const writes = eggBlockWrites(after, glass);
    const changed = new Set(writes
      .filter((write, index) => write.payload.some((byte, i) => byte !== old[index].payload[i]))
      .map((write) => write.command));
    for (const write of writes.filter((write) => changed.has(write.command))) {
      // Header after the command byte: target 0x0F (mouse), declared length, two zero bytes, chunk index.
      await this.sendCommand(write.command, [0x0f, write.declaredLength, 0, 0, write.chunk], write.payload);
      await this.delay(150);
      if (!await this.pollCommandOk(8)) throw new Error("The EGG mouse did not acknowledge the configuration write.");
    }
  }

  private readFirmware(): Promise<string | null> {
    return this.run(async () => {
      await this.open();
      await this.sendCommand(EGG_OPERATION.firmware);
      await this.delay(50);
      let bestEffortVersion: string | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await this.receiveFeature(EGG_REPORT.command, EGG_COMMAND_SIZE, this.commandPayloadLength);
        const version = eggFormatFirmwareVersion(response.bytes);
        if (version !== null) bestEffortVersion = version;
        if (response.bytes[1] === STATUS_OK && version !== null) return version;
        await this.delay(50 * (attempt + 1));
      }
      return bestEffortVersion;
    });
  }

  /**
   * The dongle's USB IDs are the same whichever 4K mouse is paired; the
   * mouse-info reply carries the mouse's own VID/PID at payload +0/+2, and the
   * profile follows it because v1 and v2 encode lift-off and polling
   * differently (re/PROTOCOL.md section 12). An unlisted PID keeps the neutral
   * profile. Leaves modelKnown false while the mouse does not answer.
   */
  private async identifyPairedMouse(): Promise<void> {
    await this.open();
    await this.sendCommand(EGG_OPERATION.mouseInfo);
    // The vendor tool's settle and busy back-off (PROTOCOL.md section 2).
    await this.delay(150);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = (await this.receiveFeature(EGG_REPORT.command, EGG_COMMAND_SIZE, this.commandPayloadLength)).bytes;
      if (reply[1] === STATUS_OK && eggReadUint16LE(reply, 16) === EGG_VENDOR_ID) {
        const paired = EGG_DEVICE_PROFILES.get(eggReadUint16LE(reply, 18));
        if (paired?.wireless4k) this.profile = paired;
        this.modelKnown = true;
        return;
      }
      // An OK without our VID is the previous command's held reply: the dongle has not relayed the mouse yet.
      if (reply[1] !== STATUS_BUSY && reply[1] !== STATUS_OK) return;
      await this.delay(200 * (attempt + 1));
    }
  }

  private async sendCommand(operation: number, header: number[] = [], payload?: Uint8Array): Promise<void> {
    const command = new Uint8Array(this.commandPayloadLength);
    command.set([operation, ...header]);
    // Payload sits at wire offset 16, i.e. 15 once the report ID is stripped.
    if (payload) command.set(payload, 15);
    await this.sendFeatureRecovering(EGG_REPORT.command, command);
  }

  /**
   * A handle left stale (sleep/resume, USB hiccup, an earlier page) rejects
   * every write with "Failed to write the feature report" until the device is
   * re-enumerated. Close and reopen it once and retry before giving up.
   */
  private async sendFeatureRecovering(reportId: number, data: BufferSource, recover = true): Promise<void> {
    try {
      await this.device.sendFeatureReport(reportId, data);
    } catch (error) {
      if (!recover || !isStaleHandleError(error)) throw error;
      await this.device.close().catch(() => undefined);
      await this.open();
      await this.device.sendFeatureReport(reportId, data);
    }
  }

  private async pollCommandOk(attempts: number): Promise<boolean> {
    let backoff = 60;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await this.receiveFeature(EGG_REPORT.command, EGG_COMMAND_SIZE, this.commandPayloadLength);
      if (response.bytes[1] === STATUS_OK) return true;
      if (response.bytes[1] !== STATUS_BUSY && attempt > 1) return false;
      await this.delay(backoff);
      backoff = Math.min(backoff * 2, 400);
    }
    return false;
  }

  private async receiveFeature(reportId: number, expectedTotal: number, payloadLength: number): Promise<ReceivedFeature> {
    const view = await Promise.race([
      this.device.receiveFeatureReport(reportId),
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error(`GET 0x${reportId.toString(16)} timed out`)),
        3000,
      )),
    ]);
    const raw = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    return {
      bytes: this.normalizeFeature(raw, reportId, expectedTotal, payloadLength),
      rawLength: raw.length,
    };
  }

  private normalizeFeature(raw: Uint8Array, reportId: number, expectedTotal: number, payloadLength: number): Uint8Array {
    return eggNormalizeFeatureReport(raw, reportId, expectedTotal, payloadLength);
  }

  private isValidConfig(config: Uint8Array, rawLength: number): boolean {
    const stages = config[EGG_OFFSET.cpiLevels];
    const divider = config[EGG_OFFSET.pollingDivider];
    const cpi = eggReadUint16LE(config, EGG_OFFSET.firstCpiSplit + 1);
    return rawLength >= 131
      && config[1] === STATUS_OK
      && stages >= 1 && stages <= 4
      && divider >= 1 && divider <= 255
      && eggIsValidCpi(this.profile, cpi);
  }

  private featurePayloadLength(reportId: number, fallback: number): number {
    const reports: HIDReportInfo[] = [];
    const collect = (collections: readonly HIDCollectionInfo[] | undefined | null): void => {
      for (const collection of collections ?? []) {
        reports.push(...(collection.featureReports ?? []).filter((report) => report.reportId === reportId));
        collect(collection.children ?? []);
      }
    };
    collect(this.device.collections ?? []);
    for (const report of reports) {
      const bits = (report.items ?? []).reduce((sum, item) => sum + item.reportSize * item.reportCount, 0);
      if (bits > 0) return Math.ceil(bits / 8);
    }
    return fallback;
  }

  private decodePollingRate(divider: number): number {
    if (!divider) throw new Error("The mouse reported an invalid polling-rate divider.");
    if (this.profile.wireless4k && divider === EGG_4K_OFFSET.powerSavePolling) return 1000;
    return 8000 / divider;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(operation, operation);
    this.chain = pending.catch(() => undefined);
    return pending;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
}
