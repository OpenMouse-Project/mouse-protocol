import type { KeychronDynamicDpi, MagneticButtonsStatus, MouseLighting, MouseStatus } from "../mouse-types.ts";
import { isKeychronConfigurableReceiver, KeychronReceiverControls } from "./receiver-hid.ts";
import {
  KEYCHRON_8K_NORDIC_PRODUCT_IDS,
  KEYCHRON_M6_COMMAND_REPORT_ID as COMMAND_REPORT_ID,
  KEYCHRON_M6_SETTINGS_REPORT_ID as SETTINGS_REPORT_ID,
  KEYCHRON_M6_STATUS_COMMAND as STATUS_COMMAND,
  KEYCHRON_M6_STATUS_PACKET_LENGTH as PACKET_LENGTH,
  KEYCHRON_M6_USAGE as USAGE,
  KEYCHRON_M6_USAGE_PAGE as USAGE_PAGE,
  KEYCHRON_RECEIVERS,
  KEYCHRON_VENDOR_ID,
  type KeychronLauncherMouse,
} from "@openmouse/protocol/keychron";
import {
  KEYCHRON_DEBOUNCE_MAX_MS as DEBOUNCE_MAX_MS,
  KEYCHRON_DEFAULT_DPI as DEFAULT_DPI,
  KEYCHRON_DPI_STAGE_COUNT as DPI_STAGE_COUNT,
  KEYCHRON_DPI_STEP as DEFAULT_DPI_STEP,
  KEYCHRON_POLLING_RATES as POLLING_RATES,
  KEYCHRON_SET,
  KEYCHRON_SLEEP_MINUTES as SLEEP_MINUTES,
  KEYCHRON_STANDARD_LOD as STANDARD_LOD,
  keychronActiveGear,
  keychronActiveStage,
  keychronButtonOptions,
  keychronButtons,
  keychronDecodeButton,
  keychronDecodeConnectedMouse,
  keychronDecodeSettings,
  keychronEncodeAngle,
  keychronEncodeButton,
  keychronEncodeDebounce,
  keychronEncodeDpi,
  keychronEncodeLighting,
  keychronEncodeSensor,
  keychronLauncherFirmware,
  keychronLauncherMouse,
  keychronLighting,
  keychronLiftOff,
  keychronLiftOffStops,
  readU16,
  writeU16,
  type KeychronButton,
  type KeychronLight,
  type KeychronSettings,
} from "./launcher-mouse.ts";

const QUERY_TIMEOUT_MS = 1200;
const SETTINGS_PACKET_LENGTH = 20;
const ACK = 0xe4;
/** Launcher's angle slider; the byte is signed and Launcher reads anything past +90 as negative. */
const ANGLE_LIMIT = 90;
const PROFILE_MAX = 5;
const POLLING_GEARS = 6;
/** From this protocol version the feature flags sit in the 0x02 answer instead of the status report. */
const FLAGS_IN_VERSION_REPLY = 6;

/** Commands on the 63-byte 0xb3 report (answers arrive on 0xb4). */
const CMD = {
  firmware: KEYCHRON_SET.firmware,
  status: STATUS_COMMAND,
  writeXy: 0x48,
  readXy: 0x49,
  writeButton: KEYCHRON_SET.writeButton,
  readButton: KEYCHRON_SET.readButton,
} as const;
/** Commands on the 20-byte 0xb5 report (answers arrive on 0xb6). */
const SET = {
  version: 0x02,
  receiverState: KEYCHRON_SET.receiverState,
  sleep: 0x0a,
  profile: 0x0e,
  lightingAnswer: 0x21,
  readLighting: 0x23,
  writeLighting: 0x24,
  polling: KEYCHRON_SET.polling,
  writePollingSets: 0x4a,
  readPollingSets: 0x4b,
} as const;

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;
type SensorFlag = "motionSync" | "angleSnapping" | "rippleControl" | "maxSpeed";

/** Launcher's support flags (feature1-4), from the status report or, from protocol 6, the 0x02 answer. */
type Features = {
  /** Status bytes 40-42 carry the DPI ceiling and step. */
  dpiLimits: boolean;
  /** Gear values can be rewritten, not only picked. */
  pollingGears: boolean;
  /** The 20K FPS switch. */
  fps20k: boolean;
  angle: boolean;
  triggerSense: boolean;
  switchChoice: boolean;
  pairing: boolean;
  dynamicDpi: boolean;
  /** Separate X/Y DPI through 0x48/0x49. */
  separateDpi: boolean;
  /** USB and 2.4 GHz polling tables through 0x4a/0x4b. */
  separatePolling: boolean;
  /** Lift-off through the level byte instead of the 2-bit code. */
  lodLevel: boolean;
};

type Status = KeychronSettings & {
  profileCount: number;
  /** Gear table as indexes into POLLING_RATES; only the first `pollingCount` are live. */
  pollingTable: number[];
  pollingCount: number;
  dpiMax: number;
  dpiStep: number;
  maxSpeed: boolean;
  angle: number;
  lodLevel: number;
  lodCount: number;
  sleepMinutes: number;
  batteryPercent: number;
  charging: boolean;
  features: Features;
};

type Identity = {
  firmware: string | null;
  /** 0 USB, 1 2.4 GHz, 2 Bluetooth. */
  workMode: number;
  version: number;
  productId: number | null;
  /** Feature bytes from the 0x02 answer, used from protocol 6. */
  flags: [number, number, number, number];
};

/** DPI as the panel sees it; `xy` holds the 0x49 block when the mouse keeps X and Y apart. */
type Dpi = {
  activeStage: number;
  stages: number[];
  stageCount: number;
  xy: { y: number[]; enable: number[] } | null;
};

type PollingSet = { level: number; count: number; table: number[] };
/** The gear set in use, plus both sets when the mouse keeps USB and 2.4 GHz apart. */
type Polling = PollingSet & { sets: [PollingSet, PollingSet] | null; set: 0 | 1 };

type LiftOffChoices = { kind: "code" | "level"; choices: ReadonlyArray<readonly [number, number]> };

/**
 * Keychron Launcher's "8k" mouse protocol on the 0xffc1 collection (63-byte
 * 0xb3/0xb4 reads, 20-byte 0xb5/0xb6 writes), which the M6 and most other
 * Keychron mice speak. Not the VIA raw-HID protocol the Nape Pro speaks.
 * Decoded from Launcher (main.be11320b2a72b61b.js, webpack module 20706);
 * the M6 (firmware 1.0.3, USB and Link-KM) confirmed every field it reads and
 * every write except angle tuning, buttons, lighting and the flagged paths.
 *
 * Status report (0x06) layout:
 *   [1]      active onboard profile, zero-based; [50] profile count
 *   [2..4]   per connection (USB, 2.4 GHz, Bluetooth): DPI stage in the low
 *            nibble, polling gear in the high nibble
 *   [5..14]  five DPI slots, little-endian 16-bit
 *   [15]     bits 0-1 lift-off code, bit 2 ripple control, bit 3 angle
 *            snapping, bit 4 motion sync, bit 6 reversed scroll
 *   [16]     DPI stages in use (1-5); unused tail slots keep stale values
 *   [17]     debounce in ms; [18] sleep timeout in minutes
 *   [19]     battery percent, bit 7 = charging
 *   [26] [53] [60]  feature flags before protocol 6 (from 6, 0x02 bytes 11-13 and 15)
 *   [40..41] DPI ceiling; [42] DPI step (when flagged)
 *   [43..48] polling gears as indexes into POLLING_RATES; [49] gears in use
 *   [52]     bit 0 20K FPS; [55] sensor angle, signed
 *   [61]     lift-off level in the low nibble, level count in the high nibble
 * Settings writes are acknowledged with [0xe4, code, command]; code 0 is
 * success and 7 means the command is not supported on this connection.
 * The 0x40 write packet is the DPI part of this layout shifted one byte down
 * (stage at [1..3], slots at [4..13], stage count at [14]).
 */
export class Keychron8kHidClient {
  readonly device: HIDDevice;
  private openedListener = false;
  private identity: Identity | null = null;
  private model: KeychronLauncherMouse | null | undefined;
  /** Floor, ceiling and step from the last status report, for getDpiOptions(). */
  private dpiLimits: { min: number; max: number; step: number } | null = null;
  private responseWaiter: {
    match: (bytes: Uint8Array) => boolean;
    resolve: (bytes: Uint8Array) => void;
    reject: (reason: Error) => void;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (!this.responseWaiter) return;
    const bytes = new Uint8Array(event.data.buffer.slice(
      event.data.byteOffset,
      event.data.byteOffset + event.data.byteLength,
    ));
    if (!this.responseWaiter.match(bytes)) return;
    const waiter = this.responseWaiter;
    this.responseWaiter = null;
    waiter.resolve(bytes);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  private receiverControls(): KeychronReceiverControls {
    if (!isKeychronConfigurableReceiver(this.device)) throw new Error("No configurable Keychron receiver is connected.");
    return new KeychronReceiverControls(this.query.bind(this), this.sendWithoutReply.bind(this));
  }

  async setKeychronReceiverButton(value: { button: string; action: string }): Promise<void> {
    await this.receiverControls().setButtonMapping(value.button, value.action);
  }

  async setKeychronReceiverLighting(value: MouseLighting): Promise<MouseLighting> {
    return await this.receiverControls().setLighting(value);
  }

  /** Launcher treats any Keychron device with this collection as an "8k" mouse, so this does too. */
  static isSupported(device: HIDDevice): boolean {
    // The G3 Air and its Ultra-Link receivers speak the 8K Nordic protocol
    // instead, and their own driver claims them by product ID. A G3 Air can
    // still expose a 0xffc1 collection, so exclude those IDs here or the
    // collection match would shadow the Nordic driver.
    if (KEYCHRON_8K_NORDIC_PRODUCT_IDS.includes(device.productId)) return false;
    return device.vendorId === KEYCHRON_VENDOR_ID
      && device.collections.some((collection) =>
        collection.usagePage === USAGE_PAGE
        && collection.usage === USAGE
        && collection.outputReports.some((report) => report.reportId === COMMAND_REPORT_ID)
        && collection.inputReports.some((report) => report.reportId === COMMAND_REPORT_ID + 1));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.openedListener) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.openedListener = true;
    }
  }

  async close(): Promise<void> {
    if (this.depthTimer) clearInterval(this.depthTimer);
    this.depthTimer = null;
    this.depthListeners.clear();
    if (this.openedListener) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.openedListener = false;
    }
    this.responseWaiter?.reject(new Error(`The ${this.label} was closed.`));
    this.responseWaiter = null;
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    const { min, max, step } = this.dpiLimits ?? this.modelDpiLimits(null);
    return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, index) => min + index * step);
  }

  getSleepOptions(): number[] {
    return SLEEP_MINUTES.map((minutes) => minutes * 60);
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  readonly canDisableSleep = false;

  /** Falls back to the name alone when the mouse does not answer, e.g. asleep behind its receiver. */
  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const identity = await this.readIdentity();
    const model = await this.readModel(identity);
    let status: Status;
    let dpi: Dpi;
    let polling: Polling;
    try {
      status = await this.readSettings();
      dpi = await this.readDpi(status, identity);
      polling = await this.readPolling(status, identity);
    } catch {
      return this.unreachableStatus(identity);
    }
    const buttons = await this.readButtons().catch(() => null);
    const receiver = isKeychronConfigurableReceiver(this.device)
      ? await this.receiverControls().readStatus().catch(() => null) : null;
    const pairing = status.features.pairing ? await this.readPairingShortcut().catch(() => null) : null;
    const dynamicDpi = status.features.dynamicDpi ? await this.readDynamicDpi(status.profile).catch(() => null) : null;
    const magnetic = status.features.triggerSense ? await this.readMagneticStatus(status.features.switchChoice).catch(() => null) : null;
    const light = model?.light ? await this.readLight().catch(() => null) : null;
    const pollingRateHz = POLLING_RATES[polling.table[polling.level] ?? 2] ?? 1000;
    const liftOff = this.liftOffChoices(status);
    const lod = keychronLiftOff(liftOff.choices, liftOff.kind === "level" ? status.lodLevel : status.lod);
    const { min, max, step } = this.modelDpiLimits(status);
    const sensorOptions = !model?.noSensorOptions;
    const name = this.label;

    return {
      brand: "Keychron",
      name,
      ...(receiver ? { keychronReceiver: receiver } : {}),
      keychronMouse: { pairing, dynamicDpi, factoryReset: true },
      scrollDirection: status.scrollReversed ? "Reverse" : "Forward",
      ...(magnetic ? { magneticButtons: magnetic } : {}),
      ui: {
        family: "keychron-8k",
        receiverControls: isKeychronConfigurableReceiver(this.device),
        defaultDisplayName: name,
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
        ...(lod.note ? { statusNote: lod.note } : {}),
        ...(sensorOptions ? {} : { hideProcessingCard: true }),
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          countEditable: true,
          minDpi: min,
          maxDpi: max,
          stepDpi: step,
        },
      },
      batteryPercent: status.batteryPercent <= 100 ? status.batteryPercent : null,
      batteryState: status.charging ? "Charging" : "Discharging",
      dpi: dpi.stages[dpi.activeStage] ?? dpi.stages[0] ?? 800,
      dpiStages: dpi.stages.slice(0, dpi.stageCount),
      activeDpiStage: dpi.activeStage,
      pollingRateHz,
      supportedPollingRates: this.supportedRates(status, polling),
      activeProfile: status.profileCount > 1 ? status.profile + 1 : null,
      profileCount: status.profileCount > 1 ? status.profileCount : undefined,
      connectionType: identity.workMode === 0 ? "Wired" : "Wireless",
      connectionDetail: this.connectionDetail(identity),
      liftOffDistance: lod.liftOffDistance,
      ...(lod.supportedLiftOffDistances ? { supportedLiftOffDistances: lod.supportedLiftOffDistances } : {}),
      ...(lod.liftOffScale ? { liftOffScale: lod.liftOffScale } : {}),
      ...(sensorOptions ? {
        motionSync: status.motionSync,
        angleSnapping: status.angleSnapping,
        rippleControl: status.rippleControl,
      } : {}),
      ...(status.features.fps20k ? { performanceMode: status.maxSpeed } : {}),
      angleTuning: status.features.angle ? status.angle : undefined,
      debounceMs: status.debounceMs,
      sleepTimeout: status.sleepMinutes > 0 && status.sleepMinutes < 0xff ? status.sleepMinutes * 60 : null,
      ...(buttons ? {
        buttonMappings: Object.fromEntries(buttons.map(({ button, action }) => [button.name, action])),
        buttonOptions: keychronButtonOptions("8k", status.features.pollingGears),
      } : {}),
      ...(light && model?.light ? { lighting: keychronLighting(light, model.light) } : {}),
      firmware: [identity.firmware ?? "Firmware unavailable"],
    };
  }

  private depthTimer: ReturnType<typeof setInterval> | null = null;
  private depthListeners = new Set<(left: number, right: number) => void>();
  private magneticWrite = false;
  private heEditTail: Promise<unknown> = Promise.resolve();

  /** Launcher polls 0x65 every 50 ms only while its travel view is visible. */
  onButtonDepth(listener: (left: number, right: number) => void): () => void {
    this.depthListeners.add(listener);
    if (!this.depthTimer) this.depthTimer = setInterval(() => {
      if (this.queryPending || this.magneticWrite || (typeof document !== "undefined" && document.hidden)) return;
      void this.readHeRecords().then((records) => {
        for (const notify of this.depthListeners) notify(readU16(records[0]!, 10) / 65 * 100, readU16(records[1]!, 10) / 65 * 100);
      }).catch(() => { for (const notify of this.depthListeners) notify(NaN, NaN); });
    }, 50);
    return () => {
      this.depthListeners.delete(listener);
      if (!this.depthListeners.size && this.depthTimer) { clearInterval(this.depthTimer); this.depthTimer = null; }
    };
  }

  private async readHeRecords(): Promise<Uint8Array[]> {
    const reply = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, [0x65], bytes => bytes[0] === 0x65);
    if (reply[1] !== 2 || reply.length < 46) throw new Error("Invalid magnetic button report.");
    const records = [reply.slice(2, 24), reply.slice(24, 46)];
    const ordered = [records.find(r => r[0] === 0), records.find(r => r[0] === 2)];
    if (!ordered[0] || !ordered[1]) throw new Error("Missing magnetic button record.");
    return ordered as Uint8Array[];
  }

  private async readMagneticStatus(choice: boolean): Promise<MagneticButtonsStatus> {
    const records = await this.readHeRecords();
    return {
      buttons: records.map(r => ({
        switchType: (r[12]! & 15) === 1 ? "optical" : (r[12]! & 15) === 2 ? "magnetic" : null,
        triggerPoint: heTravelLevel(readU16(r, 5)),
        rapidTriggerEnabled: (r[12]! >> 4) <= 1 ? (r[12]! >> 4) === 1 : null,
        rapidTrigger: readU16(r, 13) >= 5 && readU16(r, 13) <= 55 && readU16(r, 13) % 5 === 0 ? readU16(r, 13) / 5 : null,
      })),
      triggerPointRange: { min: 1, max: 12 }, rapidTriggerRange: { min: 1, max: 11 },
      rapidTriggerUnit: "level", rapidTriggerSwitch: true, canChooseSwitchType: choice,
      calibration: null, liveDepth: true,
    };
  }

  private editHe(edit: (records: Uint8Array[]) => void): Promise<Uint8Array[]> {
    const result = this.heEditTail.then(() => this.performHeEdit(edit));
    this.heEditTail = result.catch(() => {});
    return result;
  }

  private async performHeEdit(edit: (records: Uint8Array[]) => void): Promise<Uint8Array[]> {
    this.magneticWrite = true;
    try {
      const records = await this.readHeRecords();
      edit(records);
      const packet = new Uint8Array(PACKET_LENGTH);
      packet.set([0x55, 2]);
      records.forEach((r, i) => {
        // Launcher writes configuration only; ADC and optical input bytes are read-only.
        packet.set(r.slice(0, 17), 2 + 22 * i);
      });
      const reply = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, Array.from(packet), bytes => bytes[0] === ACK && bytes[2] === 0x55);
      if (reply[1] !== 0) throw new Error("The mouse rejected magnetic button settings.");
      const confirmed = await this.readHeRecords();
      if (confirmed.some((r, i) => r.slice(0, 9).some((v, j) => v !== records[i]![j]) || r.slice(12, 17).some((v, j) => v !== records[i]![12 + j]))) {
        throw new Error("The mouse did not keep the magnetic button settings.");
      }
      return confirmed;
    } finally { this.magneticWrite = false; }
  }

  async setMagneticTriggerPoint(button: 0 | 1, point: number): Promise<number> {
    if (!Number.isInteger(point) || point < 1 || point > 12) throw new Error("Actuation must be level 1 to 12.");
    await this.editHe(records => {
      const r = records[button]!; const travel = 10 + (point - 1) * 5;
      writeU16(r, 5, travel); writeU16(r, 7, Math.max(5, travel - 10));
      const rapid = Math.min(readU16(r, 13), 65 - travel);
      r[12] = (r[12]! & 15) | (rapid > 0 && (r[12]! >> 4) === 1 ? 16 : 0);
      writeU16(r, 13, rapid || 1); writeU16(r, 15, rapid || 1);
    });
    return point;
  }

  async setMagneticRapidTrigger(button: 0 | 1, enabled: boolean, level: number): Promise<{ enabled: boolean; level: number }> {
    if (!Number.isInteger(level) || level < 1 || level > 11) throw new Error("Rapid trigger must be level 1 to 11.");
    await this.editHe(records => {
      const r = records[button]!;
      if (enabled && level * 5 > 65 - readU16(r, 5)) throw new Error("Rapid trigger exceeds the remaining button travel.");
      r[12] = (r[12]! & 15) | (enabled ? 16 : 0);
      writeU16(r, 13, level * 5); writeU16(r, 15, level * 5);
    });
    return { enabled, level };
  }

  async setMagneticSwitchTypes(types: readonly ["magnetic" | "optical", "magnetic" | "optical"]): Promise<void> {
    await this.editHe(records => records.forEach((r, i) => { r[12] = (r[12]! & 240) | (types[i] === "optical" ? 1 : 2); }));
  }

  async setScrollDirection(direction: NonNullable<MouseStatus["scrollDirection"]>): Promise<string> {
    if (direction !== "Forward" && direction !== "Reverse") throw new Error("Invalid scroll direction.");
    const confirmed = await this.writeSensor({ ...(await this.readSettings()), scrollReversed: direction === "Reverse" });
    if (confirmed.scrollReversed !== (direction === "Reverse")) throw new Error("The mouse did not keep the scroll direction.");
    return direction;
  }

  private async readPairingShortcut(): Promise<{ mask: number; holdTime: number }> {
    const r = await this.querySettings(0x0b, [2]);
    if (r.length < 4 || (r[2]! & 0xe0)) throw new Error("Invalid pairing shortcut.");
    return { mask: r[2] || 9, holdTime: r[3]! };
  }

  async setKeychronPairingShortcut(value: { mask: number; holdTime: number }): Promise<void> {
    const count = value.mask.toString(2).replaceAll("0", "").length;
    if (!Number.isInteger(value.mask) || value.mask < 1 || value.mask > 31 || count > 3
      || !Number.isInteger(value.holdTime) || value.holdTime < 0 || value.holdTime > 255) throw new Error("Choose one to three pairing buttons.");
    const current = await this.readPairingShortcut();
    const p = new Uint8Array(20); p.set([0x0b, 1, value.mask, current.holdTime]);
    await this.writeSettings(p);
    if ((await this.readPairingShortcut()).mask !== value.mask) throw new Error("The mouse did not keep the pairing shortcut.");
  }

  private async readDynamicDpi(profile: number): Promise<KeychronDynamicDpi> {
    const r = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, [0x4f, profile], b => b[0] === 0x4f && b[1] === profile);
    const count = r[5]!;
    if (!count || count > 14 || r.length < 6 + count * 4 || r[3]! > 3) throw new Error("Invalid dynamic DPI report.");
    return { profile, enabled: !!(r[2]! & 1), mode: r[3]!, points: Array.from({ length: count }, (_, i) => ({ speed: readU16(r, 6 + 4 * i), gain: r[8 + 4 * i]! })) };
  }

  async setKeychronDynamicDpi(value: KeychronDynamicDpi): Promise<void> {
    const status = await this.readSettings();
    if (!status.features.dynamicDpi || value.profile !== status.profile) throw new Error("The active dynamic DPI profile changed. Refresh first.");
    if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 3 || !value.points.length || value.points.length > 14
      || value.points.some((p, i) => !Number.isInteger(p.speed) || p.speed < 0 || p.speed > 200
        || !Number.isInteger(p.gain) || p.gain < 0 || p.gain > 56 || (i > 0 && p.speed <= value.points[i - 1]!.speed))) throw new Error("Invalid dynamic DPI curve.");
    const packet = new Uint8Array(PACKET_LENGTH); packet.set([0x4e, value.profile, +value.enabled, value.mode, 0, value.points.length]);
    value.points.forEach((p, i) => { writeU16(packet, 6 + 4 * i, p.speed); packet[8 + 4 * i] = p.gain; });
    // Launcher does not wait for an ACK for 0x4e. Serialize the send, then verify with 0x4f.
    await this.sendWithoutReply(COMMAND_REPORT_ID, packet);
    const confirmed = await this.readDynamicDpi(value.profile);
    if (confirmed.profile !== value.profile || confirmed.enabled !== value.enabled || confirmed.mode !== value.mode
      || confirmed.points.length !== value.points.length || confirmed.points.some((point, i) =>
        point.speed !== value.points[i]!.speed || point.gain !== value.points[i]!.gain)) {
      throw new Error("The mouse did not keep the dynamic DPI settings.");
    }
  }

  async resetKeychronMouse(): Promise<void> {
    await this.setDebounceTime(8);
    const packet = new Uint8Array(20); packet.set([0x0f, 0xff]);
    await this.writeSettings(packet);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  async setDpi(dpi: number): Promise<number> {
    const current = await this.readDpi(await this.readSettings(), await this.readIdentity());
    return await this.setDpiStageValue(current.activeStage, dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const status = await this.readSettings();
    this.requireDpi(dpi, status);
    const identity = await this.readIdentity();
    const current = await this.readDpi(status, identity);
    this.requireStage(stage, current.stageCount);
    const stages = current.stages.map((value, index) => (index === stage ? dpi : value));
    const confirmed = (await this.writeDpi(current, { ...current, stages }, identity)).stages[stage];
    if (confirmed !== dpi) {
      throw new Error(`The ${this.label} kept ${confirmed} DPI on stage ${stage + 1} instead of ${dpi} DPI.`);
    }
    return confirmed;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const identity = await this.readIdentity();
    const current = await this.readDpi(await this.readSettings(), identity);
    this.requireStage(stage, current.stageCount);
    const confirmed = (await this.writeDpi(current, { ...current, activeStage: stage }, identity)).activeStage;
    if (confirmed !== stage) throw new Error(`The ${this.label} kept DPI stage ${confirmed + 1}.`);
    return confirmed;
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > DPI_STAGE_COUNT) {
      throw new Error(`The ${this.label} holds between 1 and ${DPI_STAGE_COUNT} DPI stages.`);
    }
    const identity = await this.readIdentity();
    const current = await this.readDpi(await this.readSettings(), identity);
    // All five hardware slots keep their DPI; the count only decides how many
    // the DPI button cycles through. The active stage rides along on the same
    // packet, so shrinking past it would write a stage the mouse cannot hold.
    const activeStage = Math.min(current.activeStage, count - 1);
    const confirmed = (await this.writeDpi(current, { ...current, stageCount: count, activeStage }, identity)).stageCount;
    if (confirmed !== count) {
      throw new Error(`The ${this.label} kept ${confirmed} DPI stages instead of ${count}.`);
    }
    return confirmed;
  }

  /**
   * Picks the gear that already holds the rate. Firmware that flags editable
   * gears gets the rate written into the active gear instead, when the model
   * offers it.
   */
  async setPollingRate(rateHz: number): Promise<number> {
    const identity = await this.readIdentity();
    const status = await this.readSettings();
    const polling = await this.readPolling(status, identity);
    const rate = POLLING_RATES.indexOf(rateHz as (typeof POLLING_RATES)[number]);
    const gear = polling.table.slice(0, polling.count).indexOf(rate);
    let next: PollingSet;
    if (rate >= 0 && gear >= 0) next = { ...polling, level: gear };
    else if (rate >= 0 && status.features.pollingGears && this.supportedRates(status, polling).includes(rateHz)) {
      next = { ...polling, table: polling.table.map((value, index) => (index === polling.level ? rate : value)) };
    } else {
      throw new Error(`The ${this.label} does not support ${rateHz} Hz on this connection.`);
    }
    await this.writeSettings(this.pollingPacket(polling, next));
    const confirmed = await this.readPolling(await this.readSettings(), identity);
    const actual = POLLING_RATES[confirmed.table[confirmed.level] ?? 2] ?? 1000;
    if (actual !== rateHz) throw new Error(`The ${this.label} kept ${actual} Hz instead of ${rateHz} Hz.`);
    return actual;
  }

  async setLiftOffDistance(lod: LiftOff): Promise<LiftOff> {
    const status = await this.readSettings();
    const liftOff = this.liftOffChoices(status);
    const code = liftOff.choices.length <= 3
      ? keychronLiftOffStops(liftOff.choices).find(([name]) => name === lod)?.[1]
      : undefined;
    if (code === undefined) throw new Error(`The ${this.label} has no ${lod} lift-off distance.`);
    await this.writeLiftOff(status, liftOff.kind, code);
    return lod;
  }

  /** Lift-off on models with more than three heights; the code is the level Launcher's config lists. */
  async setLiftOffScale(code: number): Promise<number> {
    const status = await this.readSettings();
    const liftOff = this.liftOffChoices(status);
    if (!liftOff.choices.some(([value]) => value === code)) throw new Error(`The ${this.label} has no lift-off level ${code}.`);
    await this.writeLiftOff(status, liftOff.kind, code);
    return code;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("motionSync", enabled);
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("angleSnapping", enabled);
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("rippleControl", enabled);
  }

  /** Launcher's "20K FPS" switch, on firmware that flags it. */
  async setPerformanceMode(enabled: boolean): Promise<boolean> {
    if (!(await this.readSettings()).features.fps20k) throw new Error(`The ${this.label} has no 20K FPS mode.`);
    return this.writeSensorFlag("maxSpeed", enabled);
  }

  async setAngleTuning(degrees: number): Promise<number> {
    if (!Number.isInteger(degrees) || Math.abs(degrees) > ANGLE_LIMIT) {
      throw new Error(`The ${this.label} angle must be a whole number between -${ANGLE_LIMIT} and ${ANGLE_LIMIT} degrees.`);
    }
    if (!(await this.readSettings()).features.angle) {
      throw new Error(`This ${this.label} firmware does not support angle tuning.`);
    }
    await this.writeSettings(keychronEncodeAngle(degrees));
    const confirmed = (await this.readSettings()).angle;
    if (confirmed !== degrees) throw new Error(`The ${this.label} kept a ${confirmed}° sensor angle instead of ${degrees}°.`);
    return confirmed;
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > DEBOUNCE_MAX_MS) {
      throw new Error(`The ${this.label} debounce must be between 0 and ${DEBOUNCE_MAX_MS} ms.`);
    }
    await this.open();
    await this.writeSettings(keychronEncodeDebounce(debounceMs));
    const confirmed = (await this.readSettings()).debounceMs;
    if (confirmed !== debounceMs) throw new Error(`The ${this.label} kept ${confirmed} ms debounce instead of ${debounceMs} ms.`);
    return confirmed;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    const minutes = Math.round(seconds / 60);
    if (!SLEEP_MINUTES.includes(minutes as (typeof SLEEP_MINUTES)[number])) {
      throw new Error(`The ${this.label} sleep timeout must be one of ${SLEEP_MINUTES.join(", ")} minutes.`);
    }
    await this.open();
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.sleep;
    packet[1] = 1;
    packet[2] = minutes;
    await this.writeSettings(packet);
    const confirmed = (await this.readSettings()).sleepMinutes;
    if (confirmed !== minutes) throw new Error(`The ${this.label} kept a ${confirmed} minute sleep timeout instead of ${minutes}.`);
    return confirmed * 60;
  }

  /** Switch the onboard profile (1-based, as the panel numbers them). */
  async setProfile(profile: number): Promise<number> {
    const status = await this.readSettings();
    if (!Number.isInteger(profile) || profile < 1 || profile > Math.min(status.profileCount, PROFILE_MAX)) {
      throw new Error(`The ${this.label} profile must be between 1 and ${status.profileCount}.`);
    }
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.profile;
    packet[1] = profile - 1;
    await this.writeSettings(packet);
    const confirmed = (await this.readSettings()).profile + 1;
    if (confirmed !== profile) throw new Error(`The ${this.label} kept profile ${confirmed}.`);
    return confirmed;
  }

  /** 0x52 on the 63-byte report: [1] button index, [3] type, then the type's data. */
  async setButtonMapping(button: string, action: string): Promise<void> {
    await this.readModel(await this.readIdentity());
    const buttons = keychronButtons(this.model ?? undefined);
    const slot = buttons.find((entry) => entry.name === button);
    if (!slot) throw new Error(`The ${this.label} has no "${button}" button.`);
    const code = keychronEncodeButton(action, "8k");
    if (!code) throw new Error(`Unknown button action "${action}".`);
    const expected = action === "Default" ? slot.defaultAction : action;
    const after = (await this.readButtons()).map((entry) => (entry.button.index === slot.index ? expected : entry.action));
    if (!after.includes("Left Click")) throw new Error("Keep at least one button as Left Click.");
    const packet = new Uint8Array(PACKET_LENGTH);
    packet[0] = CMD.writeButton;
    packet[1] = slot.index;
    packet.set(code, 3);
    const reply = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, Array.from(packet), (bytes) => bytes[0] === ACK && bytes[2] === CMD.writeButton);
    if (reply[1] !== 0) throw new Error(`The ${this.label} rejected the ${button} button (code ${reply[1]}).`);
    const confirmed = await this.readButton(slot);
    if (confirmed !== expected) throw new Error(`The ${this.label} kept ${confirmed} on ${button} instead of ${action}.`);
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    await this.readModel(await this.readIdentity());
    const offered = this.model?.light;
    if (!offered) throw new Error(`The ${this.label} has no lighting.`);
    const light = keychronEncodeLighting(lighting, offered);
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.writeLighting;
    packet.set([light.mode, light.brightness, light.speed, ...light.rgb], 1);
    await this.writeSettings(packet);
    const confirmed = keychronLighting(await this.readLight(), offered);
    if (confirmed.mode !== lighting.mode) throw new Error(`The ${this.label} kept its ${confirmed.mode ?? "previous"} lighting.`);
    return confirmed;
  }

  private get label(): string {
    return this.model?.name ?? "Keychron mouse";
  }

  private async writeSensorFlag(flag: SensorFlag, enabled: boolean): Promise<boolean> {
    const confirmed = await this.writeSensor({ ...(await this.readSettings()), [flag]: enabled });
    if (confirmed[flag] !== enabled) throw new Error(`The ${this.label} kept ${flag} ${confirmed[flag] ? "on" : "off"}.`);
    return confirmed[flag];
  }

  /**
   * The 0x42 packet carries every sensor option at once, so resend the
   * current state with the requested change applied. Lift-off goes in the
   * code or the level byte, whichever the firmware uses, with the other one
   * 0 the way Launcher sends it.
   */
  private async writeSensor(next: Status): Promise<Status> {
    const levelMode = this.liftOffChoices(next).kind === "level";
    await this.writeSettings(keychronEncodeSensor({
      ...next,
      lod: levelMode ? 0 : next.lod,
      lodLevel: levelMode ? next.lodLevel : 0,
    }));
    return await this.readSettings();
  }

  private async writeLiftOff(status: Status, kind: LiftOffChoices["kind"], code: number): Promise<void> {
    const confirmed = await this.writeSensor(kind === "level" ? { ...status, lodLevel: code } : { ...status, lod: code });
    const actual = kind === "level" ? confirmed.lodLevel : confirmed.lod;
    if (actual !== code) throw new Error(`The ${this.label} kept lift-off ${kind} ${actual}.`);
  }

  /**
   * The 2-bit codes, or on firmware that flags lift-off levels the level byte,
   * which Launcher fills from the same config list sorted by index and cut to
   * the count the mouse reports.
   */
  private liftOffChoices(status: Status): LiftOffChoices {
    const model = this.model;
    const codes = model ? model.lod ?? [] : STANDARD_LOD;
    if (!status.features.lodLevel) return { kind: "code", choices: codes };
    const levels = [...(model?.lodLevels?.length ? model.lodLevels : codes)].sort((a, b) => a[0] - b[0]);
    return { kind: "level", choices: status.lodCount > 0 ? levels.slice(0, status.lodCount) : levels };
  }

  /** The model's rates when the gears can be rewritten, otherwise the rates the gears hold. */
  private supportedRates(status: Status, polling: PollingSet): number[] {
    const model = this.model;
    const rates = status.features.pollingGears && model
      ? POLLING_RATES.filter((rate) => rate <= model.maxPollingHz)
      : polling.table.slice(0, polling.count).map((value) => POLLING_RATES[value]).filter((rate) => rate !== undefined);
    const unique = [...new Set<number>(rates)].sort((a, b) => a - b);
    return unique.length ? unique : [POLLING_RATES[polling.table[polling.level] ?? 2] ?? 1000];
  }

  private connectionDetail(identity: Identity): string {
    if (identity.workMode === 2) return "Bluetooth";
    if (identity.workMode === 0) return "Wired USB";
    const receiver = KEYCHRON_RECEIVERS.get(this.device.productId);
    return receiver ? `2.4 GHz (${receiver})` : "2.4 GHz receiver";
  }

  private unreachableStatus(identity: Identity): MouseStatus {
    const name = this.label;
    return {
      brand: "Keychron",
      name,
      ui: {
        family: "keychron-8k",
        defaultDisplayName: name,
        settingsReady: false,
        statusNote: identity.workMode === 1
          ? "The mouse did not answer through the receiver. Wake it and reconnect."
          : "The mouse did not answer its settings reads. Reconnect it and try again.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: identity.workMode === 0 ? "Wired" : "Wireless",
      liftOffDistance: null,
      firmware: identity.firmware ? [identity.firmware] : [],
    };
  }

  private requireDpi(dpi: number, status: Status): void {
    const { min, max, step } = this.modelDpiLimits(status);
    if (!Number.isInteger(dpi) || dpi < min || dpi > max || dpi % step !== 0) {
      throw new Error(`The ${this.label} DPI must be a multiple of ${step} between ${min} and ${max}.`);
    }
  }

  private requireStage(stage: number, stageCount: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= stageCount) {
      throw new Error(`DPI stage must be between 1 and ${stageCount}.`);
    }
  }

  /** The model's floor, and the mouse's own ceiling and step when it flags them. */
  private modelDpiLimits(status: Status | null): { min: number; max: number; step: number } {
    const [min, max] = this.model?.dpi ?? DEFAULT_DPI;
    return {
      min,
      max: status?.features.dpiLimits && status.dpiMax > min ? status.dpiMax : max,
      step: status?.features.dpiLimits && status.dpiStep > 0 ? status.dpiStep : DEFAULT_DPI_STEP,
    };
  }

  private async readSettings(): Promise<Status> {
    await this.open();
    const identity = await this.readIdentity();
    await this.readModel(identity);
    const status = this.parseStatus(await this.queryStatus(), identity);
    this.dpiLimits = this.modelDpiLimits(status);
    return status;
  }

  /**
   * Firmware string (0x04 on 0xb3) and connection mode (0x02 on 0xb5) never
   * change while connected, so they are read once. Either failing leaves the
   * mouse usable: the mode falls back to what the product ID implies.
   */
  private async readIdentity(): Promise<Identity> {
    if (this.identity) return this.identity;
    await this.open();
    const fallbackMode = KEYCHRON_RECEIVERS.has(this.device.productId) ? 1 : 0;
    const version = await this.querySettings(SET.version, [fallbackMode]).catch(() => null);
    const workMode = version ? (version[9] ?? fallbackMode) & 0x07 : fallbackMode;
    const firmware = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, [CMD.firmware, workMode], (bytes) => bytes[0] === CMD.firmware)
      .then((bytes) => keychronLauncherFirmware(bytes) ?? (version ? decodeFirmwareNibbles(version) : null))
      .catch(() => (version ? decodeFirmwareNibbles(version) : null));
    this.identity = {
      firmware,
      workMode,
      version: version ? readU16(version, 1) : 0,
      productId: version ? readU16(version, 5) : null,
      flags: version ? [version[11] ?? 0, version[12] ?? 0, version[13] ?? 0, version[15] ?? 0] : [0, 0, 0, 0],
    };
    return this.identity;
  }

  /**
   * The model table row: by USB product ID, then by the ID in the 0x02
   * answer, then, behind a receiver, by the connected mouse in its 0x03 list.
   */
  private async readModel(identity: Identity): Promise<KeychronLauncherMouse | null> {
    if (this.model !== undefined) return this.model;
    let model = keychronLauncherMouse(this.device.productId) ?? keychronLauncherMouse(identity.productId);
    if (!model && identity.workMode === 1) {
      const list = await this.querySettings(SET.receiverState, []).catch(() => null);
      model = keychronLauncherMouse(list ? keychronDecodeConnectedMouse(list) : null);
    }
    this.model = model ?? null;
    return this.model;
  }

  private parseStatus(bytes: Uint8Array, identity: Identity): Status {
    if (bytes.length < 51 || bytes[0] !== STATUS_COMMAND) {
      throw new Error(`The ${this.label} returned an invalid status report.`);
    }
    const flags = identity.version >= FLAGS_IN_VERSION_REPLY
      ? identity.flags
      : [bytes[26] ?? 0, bytes[53] ?? 0, bytes[60] ?? 0, 0];
    const angle = bytes[55] ?? 0;
    return {
      ...keychronDecodeSettings(bytes),
      profileCount: Math.min(bytes[50] ?? 0, PROFILE_MAX),
      pollingTable: Array.from(bytes.slice(43, 43 + POLLING_GEARS)),
      pollingCount: Math.min(bytes[49] || POLLING_GEARS, POLLING_GEARS),
      dpiMax: readU16(bytes, 40),
      dpiStep: bytes[42] ?? 0,
      maxSpeed: ((bytes[52] ?? 0) & 0x01) !== 0,
      angle: angle > ANGLE_LIMIT ? angle - 256 : angle,
      lodLevel: (bytes[61] ?? 0) & 0x0f,
      lodCount: (bytes[61] ?? 0) >> 4,
      sleepMinutes: bytes[18] ?? 0,
      batteryPercent: (bytes[19] ?? 0) & 0x7f,
      charging: ((bytes[19] ?? 0) & 0x80) !== 0,
      features: decodeFeatures(flags[0] ?? 0, flags[1] ?? 0, flags[2] ?? 0, flags[3] ?? 0),
    };
  }

  /** Stages from the status report, or from 0x49 on firmware that keeps X and Y apart. */
  private async readDpi(status: Status, identity: Identity): Promise<Dpi> {
    if (!status.features.separateDpi) {
      return {
        activeStage: keychronActiveStage(status, identity.workMode),
        stages: status.dpiStages,
        stageCount: status.stageCount,
        xy: null,
      };
    }
    const bytes = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, [CMD.readXy], (reply) => reply[0] === CMD.readXy);
    const stageCount = Math.min(bytes[4] || DPI_STAGE_COUNT, DPI_STAGE_COUNT);
    const levels = bytes[1 + Math.min(identity.workMode, 2)] ?? 0;
    return {
      activeStage: Math.min(levels & 0x0f, stageCount - 1),
      stages: Array.from({ length: DPI_STAGE_COUNT }, (_, stage) => readU16(bytes, 5 + stage * 2)),
      stageCount,
      xy: {
        y: Array.from({ length: DPI_STAGE_COUNT }, (_, stage) => readU16(bytes, 21 + stage * 2)),
        // Protocol 6 packs the per-stage flags into one byte; older firmware gives each a byte.
        enable: identity.version >= FLAGS_IN_VERSION_REPLY
          ? Array.from({ length: 8 }, (_, bit) => ((bytes[37] ?? 0) >> bit) & 1)
          : Array.from(bytes.slice(37, 45)),
      },
    };
  }

  /**
   * 0x40, or 0x48 when X and Y are kept apart. The panel edits one axis, so
   * a changed stage gets X = Y; the other stages keep their pairs.
   */
  private async writeDpi(current: Dpi, next: Dpi, identity: Identity): Promise<Dpi> {
    if (!current.xy) {
      await this.writeSettings(keychronEncodeDpi(next.activeStage, next.stages, next.stageCount));
      return await this.readDpi(await this.readSettings(), identity);
    }
    const { y, enable } = current.xy;
    const v6 = identity.version >= FLAGS_IN_VERSION_REPLY;
    const packet = new Uint8Array(PACKET_LENGTH);
    packet[0] = CMD.writeXy;
    // Before protocol 6 each connection byte also carries the Y stage in its high nibble.
    packet.fill(v6 ? next.activeStage : (next.activeStage << 4) | next.activeStage, 1, 4);
    packet[4] = next.stageCount;
    next.stages.forEach((x, stage) => {
      writeU16(packet, 5 + stage * 2, x);
      writeU16(packet, 21 + stage * 2, x === current.stages[stage] ? y[stage] ?? x : x);
    });
    if (v6) packet[37] = enable.reduce((mask, bit, index) => mask | ((bit & 1) << index), 0);
    else packet.set(enable.slice(0, 8), 37);
    const reply = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, Array.from(packet), (bytes) => bytes[0] === ACK && bytes[2] === CMD.writeXy);
    if (reply[1] !== 0) throw new Error(`The ${this.label} rejected command 0x48 (code ${reply[1]}).`);
    return await this.readDpi(await this.readSettings(), identity);
  }

  /** The gear set of this connection: the status table, or 0x4b's USB and 2.4 GHz sets. */
  private async readPolling(status: Status, identity: Identity): Promise<Polling> {
    if (!status.features.separatePolling) {
      return {
        level: keychronActiveGear(status, identity.workMode),
        count: status.pollingCount,
        table: status.pollingTable,
        sets: null,
        set: 0,
      };
    }
    const bytes = await this.querySettings(SET.readPollingSets, []);
    const sets = [0, 1].map((set): PollingSet => ({
      level: bytes[1 + set] ?? 0,
      count: Math.min(bytes[3 + set] || POLLING_GEARS, POLLING_GEARS),
      table: Array.from(bytes.slice(5 + set * POLLING_GEARS, 5 + (set + 1) * POLLING_GEARS)),
    })) as [PollingSet, PollingSet];
    const set = identity.workMode === 1 ? 1 : 0;
    return { ...sets[set], sets, set };
  }

  /** 0x41 carries this connection's gears; 0x4a carries both sets. */
  private pollingPacket(polling: Polling, next: PollingSet): Uint8Array {
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    if (!polling.sets) {
      packet[0] = SET.polling;
      packet[1] = next.level;
      packet[2] = next.level;
      packet.set(next.table.slice(0, next.count), 3);
      packet[9] = next.count;
      return packet;
    }
    packet[0] = SET.writePollingSets;
    polling.sets.map((set, index) => (index === polling.set ? next : set)).forEach((set, index) => {
      packet[1 + index] = set.level;
      packet[3 + index] = set.count;
      packet.set(set.table.slice(0, POLLING_GEARS), 5 + index * POLLING_GEARS);
    });
    return packet;
  }

  private async readButtons(): Promise<Array<{ button: KeychronButton; action: string }>> {
    const buttons = keychronButtons(this.model ?? undefined);
    if (!buttons.length) throw new Error(`OpenMouse does not know the ${this.label} buttons.`);
    const result: Array<{ button: KeychronButton; action: string }> = [];
    for (const button of buttons) result.push({ button, action: await this.readButton(button) });
    return result;
  }

  /** 0x62 answers [0x62, index, 0, type, data...]. */
  private async readButton(button: KeychronButton): Promise<string> {
    const bytes = await this.query(
      COMMAND_REPORT_ID,
      PACKET_LENGTH,
      [CMD.readButton, button.index],
      (reply) => reply[0] === CMD.readButton && reply[1] === button.index,
    );
    return keychronDecodeButton(bytes, "8k") ?? button.defaultAction;
  }

  /** 0x23 answers on 0x21: mode, brightness, speed, then RGB. */
  private async readLight(): Promise<KeychronLight> {
    const bytes = await this.query(SETTINGS_REPORT_ID, SETTINGS_PACKET_LENGTH, [SET.readLighting], (reply) => reply[0] === SET.lightingAnswer);
    return { mode: bytes[1] ?? 0, brightness: bytes[2] ?? 0, speed: bytes[3] ?? 0, rgb: [bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0] };
  }

  private async queryStatus(): Promise<Uint8Array> {
    return await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, [STATUS_COMMAND], (bytes) => bytes[0] === STATUS_COMMAND);
  }

  private async querySettings(command: number, args: number[]): Promise<Uint8Array> {
    return await this.query(SETTINGS_REPORT_ID, SETTINGS_PACKET_LENGTH, [command, ...args], (bytes) => bytes[0] === command);
  }

  private async writeSettings(packet: Uint8Array): Promise<void> {
    const command = packet[0] ?? 0;
    const reply = await this.query(
      SETTINGS_REPORT_ID,
      SETTINGS_PACKET_LENGTH,
      Array.from(packet),
      (bytes) => bytes[0] === command || (bytes[0] === ACK && bytes[2] === command),
    );
    if (reply[0] === ACK && reply[1] !== 0) {
      throw new Error(`The ${this.label} rejected command 0x${command.toString(16)} (code ${reply[1]}).`);
    }
  }

  private queryTail: Promise<void> = Promise.resolve();
  private queryPending = 0;

  protected async sendWithoutReply(reportId: number, packet: Uint8Array): Promise<void> {
    const previous = this.queryTail;
    let release!: () => void;
    this.queryPending++;
    this.queryTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (!this.device.opened) throw new Error("The mouse was disconnected.");
      await this.device.sendReport(reportId, packet.buffer as ArrayBuffer);
    } finally { this.queryPending--; release(); }
  }

  protected async query(reportId: number, length: number, payload: number[], match: (bytes: Uint8Array) => boolean): Promise<Uint8Array> {
    this.queryPending++;
    const previous = this.queryTail;
    let release!: () => void;
    this.queryTail = new Promise<void>(resolve => { release = resolve; });
    try { await previous; return await this.executeQuery(reportId, length, payload, match); }
    finally { this.queryPending--; release(); }
  }

  private async executeQuery(
    reportId: number,
    length: number,
    payload: number[],
    match: (bytes: Uint8Array) => boolean,
  ): Promise<Uint8Array> {
    if (!this.device.opened) throw new Error("The mouse was disconnected.");
    if (this.responseWaiter) throw new Error(`Another ${this.label} request is already in progress.`);
    const packet = new Uint8Array(length);
    packet.set(payload.slice(0, length));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectResponse: ((reason: Error) => void) | null = null;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      rejectResponse = reject;
      timeout = setTimeout(() => {
        this.responseWaiter = null;
        reject(new Error(`The ${this.label} did not answer command 0x${packet[0]?.toString(16)}.`));
      }, QUERY_TIMEOUT_MS);
      this.responseWaiter = {
        match,
        resolve: (bytes) => {
          clearTimeout(timeout);
          resolve(bytes);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      };
    });
    void response.catch(() => undefined);
    try {
      await this.device.sendReport(reportId, packet.buffer);
    } catch (error) {
      this.responseWaiter = null;
      clearTimeout(timeout);
      const detail = error instanceof Error ? error.message : String(error);
      (rejectResponse as ((reason: Error) => void) | null)?.(
        new Error(`Chrome could not write the ${this.label} HID report. ${detail}`),
      );
    }
    return await response;
  }
}

function decodeFeatures(feature1: number, feature2: number, feature3: number, feature4: number): Features {
  return {
    dpiLimits: (feature1 & 0x08) !== 0,
    pollingGears: (feature1 & 0x10) !== 0,
    fps20k: (feature1 & 0x80) !== 0,
    angle: (feature2 & 0x04) !== 0,
    triggerSense: (feature2 & 0x68) !== 0,
    switchChoice: (feature2 & 0x08) !== 0,
    pairing: (feature2 & 0x02) !== 0,
    dynamicDpi: (feature4 & 0x20) !== 0,
    separateDpi: (feature3 & 0x01) !== 0,
    separatePolling: (feature3 & 0x02) !== 0,
    lodLevel: (feature4 & 0x10) !== 0,
  };
}

/** 0x02 answer: major at [8], minor and patch in the nibbles of [7]. */
function decodeFirmwareNibbles(bytes: Uint8Array): string | null {
  if (bytes.length < 9) return null;
  return `v${bytes[8]}.${(bytes[7] ?? 0) >> 4}.${(bytes[7] ?? 0) & 0x0f}`;
}

function heTravelLevel(raw: number): number | null {
  return raw >= 10 && raw <= 65 && (raw - 10) % 5 === 0 ? 1 + (raw - 10) / 5 : null;
}
