import {
  WE_CMD_READ_EEPROM,
  WE_CMD_WRITE_EEPROM,
  WE_REPORT_ID,
  weBuildCmdPayload,
  wePackScalarPair,
  weReportChecksum,
  weUnpackScalarPair,
} from "@openmouse/protocol/endgame-gear-we";
import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";
import {
  ATK_COMPX_COMMAND,
  ATK_R1_BUTTONS,
  ATK_R1_PROFILE_COUNT,
  ATK_VXE_R1_ANGLE_SELECTOR,
  ATK_VXE_R1_DEBOUNCE_SELECTOR,
  ATK_VXE_R1_LOD_SELECTOR,
  ATK_VXE_R1_POLLING_RATES,
  ATK_VXE_R1_SETTINGS_REGISTER,
  ATK_SENSORS,
  atkBuildReceiverPairRequest,
  atkBuildSetCurrentProfile,
  atkDecodeLiftOff,
  atkDecodeButtonAssignment,
  atkDecodeCurrentProfile,
  atkDecodePairingStatus,
  atkDecodeReceiverStatus,
  atkDecodeVxeR1PollingCode,
  atkDpiOptionsForSensor,
  atkPackDpiStage,
  atkPackDpiStageForSensor,
  atkPackVxeR1LiveSetting,
  atkPackVxeR1PollingSetting,
  atkUnpackDpiStage,
  atkUnpackDpiStageForSensor,
} from "@openmouse/protocol/atk";
import { type AtkProduct, ATK_COMPX_PRODUCT_IDS, ATK_PRODUCTS } from "./products.ts";

// ATK mice (A9 family and siblings) use the same OEM framing as the Endgame
// Gear WE series — 16-byte EEPROM commands on report 0x08 — but carry them on
// output/input reports rather than feature reports.
const BATTERY_COMMAND = 0x04;
const VERSION_COMMAND = 0x12;
const CIDMID_COMMAND = 0x10;
const SET_LONG_RANGE_COMMAND = 0x16;
const GET_LONG_RANGE_COMMAND = 0x17;
const FRAME_LENGTH = 16;
const DATA_OFFSET = 5;
const MAX_DATA_LENGTH = 10;
const REPLY_TIMEOUT_MS = 500;
const WRITE_SETTLE_MS = 10;
const R1_LIVE_WRITE_SETTLE_MS = 250;
const R1_PROFILE_SWITCH_SETTLE_MS = 100;
const MAX_IDENTIFY_ATTEMPTS = 3;

// The VXE R1 SE/SE+ ships its "Wireless mouse -1k dongle" under 0x373b:0x1085
// (Beken MCU). It shares the A9 EEPROM map for DPI/advanced/lod, but the poll
// rate lives in the live-settings row; see the codec for the full story.
const VXE_R1_RECEIVER_PID = 0x1085;
const VXE_R1_COMPX_RECEIVER_PID = 0xf58e;
const VXE_R1_COMPX_MOUSE_PID = 0xf58f;
const R1_SETTINGS_LENGTH = 4;

// Byte addresses in the mouse's configuration EEPROM.
const REGISTER = {
  // 0x0000: polling rate, DPI stage count, active DPI stage (value/checksum pairs).
  system: 0x0000,
  liftOffDistance: 0x000a,
  // Four bytes per DPI stage.
  dpiBase: 0x000c,
  dpiColorBase: 0x002c,
  dpiLighting: 0x004c,
  // 0x00a9: debounce, motion sync, sleep timer, linear correction, ripple control.
  advanced: 0x00a9,
  // 0x00bd: angle tuning degrees, then the angle-snapping enable flag.
  angle: 0x00bd,
  sensorPerformance: 0x00b5,
} as const;

const SYSTEM_LENGTH = 6;
const ADVANCED_LENGTH = 10;
const ANGLE_LENGTH = 4;
const DPI_STAGE_LENGTH = 4;
const MAX_DPI_STAGES = 6;
const R1_MAX_DPI_STAGES = 8;

const DPI_MIN = 50;
const DPI_MAX = 42000;
const DEBOUNCE_MAX_MS = 15;
// The R1 accepts 1-20 ms in its live-settings debounce entry (per OpenVXE).
const R1_DEBOUNCE_MAX_MS = 20;
const SLEEP_STEP_SECONDS = 10;
const SLEEP_SECONDS: readonly number[] = [30, 60, 120, 300, 600, 1800];
const R1_SLEEP_SECONDS: readonly number[] = [30, 60, 120, 180, 300, 1200, 1500, 1800];
const R1_DEBOUNCE_MILLISECONDS: readonly number[] = [0, 1, 2, 4, 8, 15, 20];
const R1_SENSOR_PERFORMANCE_LENGTH = 6;
const R1_DPI_LIGHTING_LENGTH = 8;
const R1_DPI_COLOR_GROUP_LENGTH = 8;
const R1_DPI_BRIGHTNESS = [0x10, 0x80, 0xff] as const;
const R1_DPI_SPEED = [1, 3, 5] as const;

const POLLING_RATES: ReadonlyArray<readonly [number, number]> = [
  [0x08, 125],
  [0x04, 250],
  [0x02, 500],
  [0x01, 1000],
  [0x10, 2000],
  [0x20, 4000],
  [0x40, 8000],
];

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

/** Register codes are tenths of a millimetre offset by 6 (1 = 0.7 mm). */
const LIFT_OFF_CODES: ReadonlyArray<readonly [number, LiftOffDistance]> = [
  [1, "Low"],
  [4, "Medium"],
  [11, "High"],
];

/** R1 lift-off levels are 1 mm and 2 mm in the live-settings entry. */
const R1_LIFT_OFF_CODES: ReadonlyArray<readonly [number, LiftOffDistance]> = [
  [1, "Low"],
  [2, "High"],
];

export class AtkHidClient {
  // Sleep is stored in 10-second units with no "never" value.
  readonly canDisableSleep = false;
  // Written out rather than a parameter property so node --test can strip types.
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus: MouseStatus | null = null;
  private product: AtkProduct | null = null;
  private identified = false;
  private identifyAttempts = 0;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === 0xff02 && collection.usage === 0x0002)
      || collection.children.some(search);
    if (!device.collections.some(search)) return false;
    if (device.vendorId === VENDOR_ID.atk) return true;
    return device.vendorId === VENDOR_ID.vgn && ATK_COMPX_PRODUCT_IDS.includes(device.productId);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastStatus = null;
    this.product = null;
    this.identified = false;
    this.identifyAttempts = 0;
    if (this.device.opened) await this.device.close();
  }

  /** ATK broadcasts are undocumented; the panel falls back to polling. */
  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    if (this.product) return `${this.product.brand} ${this.product.model}`;
    const name = this.device.productName?.trim();
    if (!name) return "ATK";
    return /^atk/i.test(name) ? name : `ATK ${name}`;
  }

  deviceBrand(): AtkProduct["brand"] {
    return this.product?.brand ?? (/^vxe\b/i.test(this.device.productName || "") ? "VXE" : "ATK");
  }

  /**
   * A wired A9 still reports a battery level, so the receiver is identified by
   * its own product string instead: "ATK Nearlink Mouse Dongle" against the
   * mouse's own "ATK A9 PLUS 2.0 NK".
   */
  isWireless(): boolean {
    return this.device.productId === VXE_R1_RECEIVER_PID
      || (this.device.vendorId === VENDOR_ID.vgn && this.device.productId === VXE_R1_COMPX_RECEIVER_PID)
      || /receiver|dongle/i.test(this.device.productName || "");
  }

  /** VXE R1 SE/SE+ on its stock 1K receiver (Beken MCU, per OpenVXE). */
  isR1(): boolean {
    return this.product?.family === "r1"
      || this.usesSharedR1Transport();
  }

  maxDpi(): number {
    return this.product ? ATK_SENSORS[this.product.sensor].maxDpi : DPI_MAX;
  }

  getSleepOptions(): readonly number[] {
    return this.isR1() && !this.usesR1LiveSettings() ? R1_SLEEP_SECONDS : SLEEP_SECONDS;
  }

  getDebounceMaxMs(): number {
    return this.isR1() ? R1_DEBOUNCE_MAX_MS : DEBOUNCE_MAX_MS;
  }

  getDebounceOptions(): readonly number[] {
    return this.isR1() && !this.usesR1LiveSettings()
      ? R1_DEBOUNCE_MILLISECONDS
      : Array.from(
        { length: this.getDebounceMaxMs() + (this.usesR1LiveSettings() ? 0 : 1) },
        (_, index) => index + (this.usesR1LiveSettings() ? 1 : 0),
      );
  }

  getSupportedPollingRates(): number[] {
    return this.usesR1LiveSettings()
      ? [...ATK_VXE_R1_POLLING_RATES]
      : this.isR1()
        ? POLLING_RATES.map(([, hertz]) => hertz).filter((hertz) => hertz <= 1000)
      : POLLING_RATES.map(([, hertz]) => hertz);
  }

  /**
   * The encoding steps by 10 DPI, then 50 above 10,000 and 100 above 30,000.
   * Models top out below 42,000; writes are confirmed by reading back.
   */
  getDpiOptions(): number[] {
    if (this.product) return atkDpiOptionsForSensor(this.product.sensor);
    const options: number[] = [];
    for (let dpi = DPI_MIN; dpi <= 10000; dpi += 10) options.push(dpi);
    for (let dpi = 10050; dpi <= 30000; dpi += 50) options.push(dpi);
    for (let dpi = 30100; dpi <= DPI_MAX; dpi += 100) options.push(dpi);
    return options;
  }

  async readStatus(live = false): Promise<MouseStatus> {
    await this.open();
    await this.identify();
    const battery = await this.readBattery();
    const system = await this.read(REGISTER.system, SYSTEM_LENGTH);
    const stageCount = this.stageCount(system);
    const activeDpiStage = this.stageIndex(system);
    const dpiStages: Array<{ x: number; y: number }> = [];
    for (let index = 0; index < stageCount; index += 1) dpiStages.push(await this.readDpiStage(index));
    const stage = dpiStages[activeDpiStage]!;
    if (live && this.lastStatus) {
      return this.lastStatus = {
        ...this.lastStatus,
        batteryPercent: battery?.percent ?? null,
        batteryState: batteryState(battery),
        batteryVoltageMv: battery?.millivolts ?? null,
        pollingRateHz: await this.readPollingRate(system),
        dpi: stage.x,
        dpiY: stage.y,
        dpiStages: dpiStages.map(({ x }) => x),
        activeDpiStage,
      };
    }
    const firmware = await this.readFirmware();
    const liftOffDistance = await this.read(REGISTER.liftOffDistance, 2);
    const advanced = await this.read(REGISTER.advanced, ADVANCED_LENGTH);
    const angle = await this.read(REGISTER.angle, ANGLE_LENGTH).catch(() => null);
    const r1Extras = this.usesVerifiedR1WiredTransport() ? await this.readR1Extras(stageCount) : null;
    const stored = this.usesVerifiedR1WiredTransport()
      ? await this.readR1StoredConfiguration().catch(() => null)
      : null;
    const receiver = this.usesR1LiveSettings()
      ? await this.readR1ReceiverInfo().catch(() => null)
      : null;
    const angleTuning = angle ? weUnpackScalarPair(angle[0], angle[1]) : null;
    const angleSnapping = angle ? weUnpackScalarPair(angle[2], angle[3]) : null;
    return this.lastStatus = {
      brand: this.deviceBrand(),
      name: this.displayName(),
      ui: {
        family: "atk",
        hideUnsupportedPollingRates: true,
        forceShowBattery: battery !== null,
        dpiStageEditor: this.usesVerifiedR1WiredTransport() ? {
          maxStages: R1_MAX_DPI_STAGES,
          countEditable: false,
          minDpi: ATK_SENSORS.PAW3395SE.minDpi,
          maxDpi: ATK_SENSORS.PAW3395SE.maxDpi,
          stepDpi: 50,
        } : undefined,
        dpiLighting: r1Extras ? {
          modes: [0, 1, 2],
          brightness: [0, 1, 2],
          speed: [0, 1, 2],
        } : undefined,
      },
      batteryPercent: battery?.percent ?? null,
      batteryState: batteryState(battery),
      batteryVoltageMv: battery?.millivolts ?? null,
      dpi: stage.x,
      dpiY: stage.y,
      dpiStages: dpiStages.map(({ x }) => x),
      dpiStageColors: r1Extras?.dpiStageColors,
      activeDpiStage,
      supportsSeparateDpiAxes: false,
      pollingRateHz: await this.readPollingRate(system),
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: stored?.activeProfile ?? null,
      atkProfileCount: stored ? ATK_R1_PROFILE_COUNT : undefined,
      atkButtonMappings: stored?.buttons,
      atkReceiver: receiver ?? undefined,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      connectionDetail: this.isWireless() ? "2.4 GHz receiver" : "Wired USB",
      debounceMs: advanced[0],
      motionSync: advanced[2] === 1,
      sleepTimeout: advanced[4] * SLEEP_STEP_SECONDS || null,
      rippleControl: advanced[8] === 1,
      performanceMode: r1Extras?.performanceMode,
      longRangeMode: r1Extras?.longRangeMode,
      dpiLedMode: r1Extras?.dpiLedMode,
      dpiLedBrightness: r1Extras?.dpiLedBrightness,
      dpiLedSpeed: r1Extras?.dpiLedSpeed,
      angleSnapping: this.isR1()
        ? advanced[6] === 1
        : angleSnapping === null ? null : angleSnapping === 1,
      angleTuning: angleTuning === null ? null : this.decodeAngle(angleTuning),
      liftOffDistance: this.decodeLiftOffDistance(liftOffDistance[0]),
      supportedLiftOffDistances: this.isR1() ? ["Low", "High"] : undefined,
      firmware,
    };
  }

  /** Read the active R1 profile and its six button records without changing either. */
  async readR1StoredConfiguration(): Promise<{
    activeProfile: number;
    buttons: NonNullable<MouseStatus["atkButtonMappings"]>;
  }> {
    await this.identify();
    if (!this.usesVerifiedR1WiredTransport()) {
      throw new Error("Stored R1 configuration inspection is available only over the verified wired transport.");
    }
    const activeProfile = await this.readR1CurrentProfile();

    const buttons: NonNullable<MouseStatus["atkButtonMappings"]> = [];
    for (let group = 0; group < ATK_R1_BUTTONS.length; group += 2) {
      const first = ATK_R1_BUTTONS[group]!;
      const data = await this.read(first.address, 8);
      for (let offset = 0; offset < 2; offset += 1) {
        const button = ATK_R1_BUTTONS[group + offset];
        if (!button) continue;
        const assignment = atkDecodeButtonAssignment(data.subarray(offset * 4, offset * 4 + 4));
        if (!assignment) throw new Error(`The ${button.label.toLowerCase()} assignment is truncated.`);
        buttons.push({
          id: button.id,
          name: button.label,
          address: button.address,
          keyClass: assignment.keyClass,
          value1: assignment.value1,
          value2: assignment.value2,
          checksumValid: assignment.checksumValid,
          action: assignment.label,
          raw: assignment.raw,
        });
      }
    }
    return { activeProfile: activeProfile + 1, buttons };
  }

  /** Select one of the four verified wired R1 banks and require readback. */
  async setR1ActiveProfile(profile: number): Promise<number> {
    await this.identify();
    if (!this.usesVerifiedR1WiredTransport()) {
      throw new Error("R1 profile switching is available only over the verified wired transport.");
    }
    if (!Number.isInteger(profile) || profile < 1 || profile > ATK_R1_PROFILE_COUNT) {
      throw new Error(`R1 profile must be between 1 and ${ATK_R1_PROFILE_COUNT}.`);
    }
    await this.send(atkBuildSetCurrentProfile(profile - 1));
    await delay(R1_PROFILE_SWITCH_SETTLE_MS);
    const confirmed = (await this.readR1CurrentProfile()) + 1;
    if (confirmed !== profile) throw new Error(`The mouse kept profile ${confirmed} instead of ${profile}.`);
    this.lastStatus = null;
    return confirmed;
  }

  /** Read receiver online/RF identity and pairing countdown; this never starts pairing. */
  async readR1ReceiverInfo(): Promise<NonNullable<MouseStatus["atkReceiver"]>> {
    await this.identify();
    if (!this.isR1() || !this.usesR1LiveSettings()) {
      throw new Error("R1 receiver telemetry is available only through the receiver transport.");
    }
    const onlineReply = await this.exchange(
      weBuildCmdPayload(ATK_COMPX_COMMAND.getWirelessMouseOnline),
      (frame) => frame[0] === ATK_COMPX_COMMAND.getWirelessMouseOnline
        && frame[1] === 0 && frame[4] >= 1 && this.hasValidChecksum(frame),
    );
    const online = atkDecodeReceiverStatus(onlineReply.subarray(DATA_OFFSET));
    if (!online) throw new Error("The receiver returned a truncated online-status reply.");
    const pairingReply = await this.exchange(
      weBuildCmdPayload(ATK_COMPX_COMMAND.getWirelessDonglePairResult),
      (frame) => frame[0] === ATK_COMPX_COMMAND.getWirelessDonglePairResult
        && frame[1] === 0 && frame[4] >= 2 && this.hasValidChecksum(frame),
    ).catch(() => null);
    const pairing = pairingReply ? atkDecodePairingStatus(pairingReply.subarray(DATA_OFFSET)) : null;
    return {
      ...online,
      pairingStatus: pairing?.status ?? null,
      pairingSecondsRemaining: pairing?.secondsRemaining ?? null,
    };
  }

  /** Start receiver pairing for one exact CID/MID; callers must poll telemetry for completion. */
  async startR1ReceiverPairing(cid: number, mid: number): Promise<void> {
    await this.identify();
    if (this.device.vendorId !== VENDOR_ID.vgn || this.device.productId !== VXE_R1_COMPX_RECEIVER_PID) {
      throw new Error("R1 receiver pairing is available only through the verified VXE Mouse 1K Dongle.");
    }
    await this.exchange(
      atkBuildReceiverPairRequest(cid, mid),
      (frame) => frame[0] === ATK_COMPX_COMMAND.setWirelessDonglePair
        && frame[1] === 0 && this.hasValidChecksum(frame),
    );
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (!this.usesR1LiveSettings()) await this.identify();
    if (this.usesR1LiveSettings()) return await this.setR1PollingRate(pollingRateHz);
    const encoded = POLLING_RATES.find(([, hertz]) => hertz === pollingRateHz);
    if (!encoded) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
    await this.write(REGISTER.system, wePackScalarPair(encoded[0]));
    if (this.isR1()) await delay(R1_LIVE_WRITE_SETTLE_MS);
    const confirmed = this.decodePollingRate((await this.read(REGISTER.system, SYSTEM_LENGTH))[0]);
    if (confirmed !== pollingRateHz) {
      throw new Error(`The mouse kept ${confirmed} Hz instead of ${pollingRateHz} Hz.`);
    }
    this.patch({ pollingRateHz: confirmed });
    return confirmed;
  }

  async setDpi(dpi: number, dpiY: number = dpi): Promise<number> {
    await this.identify();
    const sensor = this.product?.sensor ?? null;
    const options = sensor ? atkDpiOptionsForSensor(sensor) : null;
    for (const value of [dpi, dpiY]) {
      if (!Number.isInteger(value) || (options ? !options.includes(value) : value < DPI_MIN || value > DPI_MAX)) {
        throw new Error(`${value.toLocaleString()} is not a supported DPI value.`);
      }
    }
    const index = this.stageIndex(await this.read(REGISTER.system, SYSTEM_LENGTH));
    const stage = sensor ? atkPackDpiStageForSensor(sensor, dpi, dpiY) : atkPackDpiStage(dpi, dpiY);
    if (!stage) throw new Error(`${dpi.toLocaleString()} DPI is not representable by this sensor.`);
    await this.write(this.dpiAddress(index), stage);
    const confirmed = await this.readDpiStage(index);
    if (confirmed.x !== dpi || confirmed.y !== dpiY) {
      throw new Error(`The mouse kept ${confirmed.x.toLocaleString()} DPI instead of ${dpi.toLocaleString()}.`);
    }
    this.patch({ dpi: confirmed.x, dpiY: confirmed.y });
    return confirmed.x;
  }

  async setActiveDpiStage(index: number): Promise<number> {
    await this.identify();
    if (this.isR1() && !this.usesVerifiedR1WiredTransport()) {
      throw new Error("R1 DPI stage selection is available only over the verified R1 SE+ wired transport.");
    }
    const system = await this.read(REGISTER.system, SYSTEM_LENGTH);
    const count = this.stageCount(system);
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`DPI stage must be between 1 and ${count}.`);
    }
    await this.write(REGISTER.system + 4, wePackScalarPair(index));
    const pair = await this.read(REGISTER.system + 4, 2);
    const confirmed = weUnpackScalarPair(pair[0]!, pair[1]!);
    if (confirmed !== index) throw new Error(`The mouse kept DPI stage ${(confirmed ?? 0) + 1} instead of ${index + 1}.`);
    const stage = await this.readDpiStage(index);
    this.patch({ activeDpiStage: confirmed, dpi: stage.x, dpiY: stage.y });
    return confirmed;
  }

  async setDpiStageValue(index: number, dpi: number): Promise<number> {
    await this.identify();
    if (this.isR1() && !this.usesVerifiedR1WiredTransport()) {
      throw new Error("R1 DPI stage editing is available only over the verified R1 SE+ wired transport.");
    }
    const system = await this.read(REGISTER.system, SYSTEM_LENGTH);
    const count = this.stageCount(system);
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`DPI stage must be between 1 and ${count}.`);
    }
    const sensor = this.product?.sensor ?? null;
    const options = sensor ? atkDpiOptionsForSensor(sensor) : this.getDpiOptions();
    if (!Number.isInteger(dpi) || !options.includes(dpi)) {
      throw new Error(`${dpi.toLocaleString()} is not a supported DPI value.`);
    }
    const packed = sensor ? atkPackDpiStageForSensor(sensor, dpi, dpi) : atkPackDpiStage(dpi, dpi);
    if (!packed) throw new Error(`${dpi.toLocaleString()} DPI is not representable by this sensor.`);
    await this.write(this.dpiAddress(index), packed);
    const confirmed = await this.readDpiStage(index);
    if (confirmed.x !== dpi || confirmed.y !== dpi) {
      throw new Error(`The mouse kept ${confirmed.x.toLocaleString()} DPI instead of ${dpi.toLocaleString()}.`);
    }
    const dpiStages = this.lastStatus?.dpiStages?.slice() ?? [];
    while (dpiStages.length < count) dpiStages.push(dpiStages.at(-1) ?? dpi);
    dpiStages[index] = confirmed.x;
    const active = this.lastStatus?.activeDpiStage ?? this.stageIndex(system);
    this.patch({
      dpiStages,
      ...(active === index ? { dpi: confirmed.x, dpiY: confirmed.y } : {}),
    });
    return confirmed.x;
  }

  async setDpiStageColor(index: number, color: string): Promise<string> {
    await this.identify();
    if (!this.usesVerifiedR1WiredTransport()) {
      throw new Error("DPI stage colors are not available on this connection.");
    }
    const rgb = parseHexColor(color);
    const count = this.stageCount(await this.read(REGISTER.system, SYSTEM_LENGTH));
    if (!rgb || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error("The DPI stage or colour is invalid.");
    }
    const groupAddress = REGISTER.dpiColorBase + Math.floor(index / 2) * R1_DPI_COLOR_GROUP_LENGTH;
    const group = Array.from(await this.read(groupAddress, R1_DPI_COLOR_GROUP_LENGTH));
    group.splice((index % 2) * 4, 4, ...packRgb(rgb));
    await this.write(groupAddress, group);
    const confirmedGroup = await this.read(groupAddress, R1_DPI_COLOR_GROUP_LENGTH);
    const confirmed = unpackRgb(confirmedGroup.subarray((index % 2) * 4, (index % 2 + 1) * 4));
    if (confirmed !== color.toLowerCase()) throw new Error(`The mouse kept ${confirmed ?? "an invalid colour"} instead of ${color}.`);
    const dpiStageColors = this.lastStatus?.dpiStageColors?.slice() ?? [];
    while (dpiStageColors.length < count) dpiStageColors.push("#000000");
    dpiStageColors[index] = confirmed;
    this.patch({ dpiStageColors });
    return confirmed;
  }

  async setPerformanceMode(enabled: boolean): Promise<boolean> {
    const confirmed = await this.writeR1PerformanceBlock((block) => {
      block.splice(4, 2, ...wePackScalarPair(enabled ? 1 : 0));
    });
    const value = weUnpackScalarPair(confirmed[4]!, confirmed[5]!) === 1;
    if (value !== enabled) throw new Error(`The mouse left performance mode ${value ? "on" : "off"}.`);
    this.patch({ performanceMode: value });
    return value;
  }

  async setLongRangeMode(enabled: boolean): Promise<boolean> {
    await this.identify();
    if (!this.usesVerifiedR1WiredTransport()) throw new Error("Long-range mode is not available on this connection.");
    await this.send(weBuildCmdPayload(SET_LONG_RANGE_COMMAND, [0, 0, 0, 10, enabled ? 1 : 0]));
    await delay(WRITE_SETTLE_MS);
    const confirmed = await this.readLongRangeMode();
    if (confirmed !== enabled) throw new Error(`The mouse left long-range mode ${confirmed ? "on" : "off"}.`);
    this.patch({ longRangeMode: confirmed });
    return confirmed;
  }

  async setDpiLighting(mode: number, brightness: number, speed: number): Promise<void> {
    await this.identify();
    if (!this.usesVerifiedR1WiredTransport()) throw new Error("DPI lighting is not available on this connection.");
    if (![0, 1, 2].includes(mode) || ![0, 1, 2].includes(brightness) || ![0, 1, 2].includes(speed)) {
      throw new Error("The DPI lighting setting is invalid.");
    }
    const block = Array.from(await this.read(REGISTER.dpiLighting, R1_DPI_LIGHTING_LENGTH));
    const effect = mode === 2 ? 2 : 1;
    block.splice(0, 2, ...wePackScalarPair(effect));
    block.splice(2, 2, ...wePackScalarPair(R1_DPI_BRIGHTNESS[brightness]!));
    block.splice(4, 2, ...wePackScalarPair(R1_DPI_SPEED[speed]!));
    block.splice(6, 2, ...wePackScalarPair(mode === 0 ? 0 : 1));
    await this.write(REGISTER.dpiLighting, block);
    const confirmed = this.decodeR1DpiLighting(await this.read(REGISTER.dpiLighting, R1_DPI_LIGHTING_LENGTH));
    if (!confirmed || confirmed.dpiLedMode !== mode
      || confirmed.dpiLedBrightness !== brightness || confirmed.dpiLedSpeed !== speed) {
      throw new Error("The mouse did not retain its DPI lighting settings.");
    }
    this.patch(confirmed);
  }

  async setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    if (!this.usesR1LiveSettings()) await this.identify();
    if (this.usesR1LiveSettings()) return await this.setR1LiftOffDistance(value);
    const encoded = (this.isR1() ? R1_LIFT_OFF_CODES : LIFT_OFF_CODES).find(([, name]) => name === value);
    if (!encoded) throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    await this.write(REGISTER.liftOffDistance, wePackScalarPair(encoded[0]));
    const confirmed = this.decodeLiftOffDistance((await this.read(REGISTER.liftOffDistance, 2))[0]);
    if (confirmed !== value) {
      throw new Error(`The mouse kept a ${String(confirmed).toLowerCase()} lift-off distance instead of ${value.toLowerCase()}.`);
    }
    this.patch({ liftOffDistance: confirmed });
    return confirmed;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    await this.identify();
    return await this.setAdvancedFlag(2, enabled, "motionSync", "Motion Sync");
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    await this.identify();
    return await this.setAdvancedFlag(8, enabled, "rippleControl", "ripple control");
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    if (!this.usesR1LiveSettings()) await this.identify();
    if (this.usesR1LiveSettings()) return await this.setR1AngleSnapping(enabled);
    if (this.isR1()) return await this.setAdvancedFlag(6, enabled, "angleSnapping", "straight-line correction");
    const group = await this.read(REGISTER.angle, ANGLE_LENGTH);
    await this.write(REGISTER.angle, [group[0], enabled ? 1 : 0].flatMap((value) => wePackScalarPair(value)));
    const confirmed = (await this.read(REGISTER.angle, ANGLE_LENGTH))[2] === 1;
    if (confirmed !== enabled) throw new Error(`The mouse left angle snapping ${confirmed ? "on" : "off"}.`);
    this.patch({ angleSnapping: confirmed });
    return confirmed;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!this.usesR1LiveSettings()) await this.identify();
    if (this.usesR1LiveSettings()) return await this.setR1DebounceTime(milliseconds);
    const options = this.getDebounceOptions();
    if (!Number.isInteger(milliseconds) || !options.includes(milliseconds)) {
      throw new Error(`This mouse does not support ${milliseconds} ms debounce.`);
    }
    const confirmed = await this.writeAdvanced(0, milliseconds);
    if (confirmed !== milliseconds) {
      throw new Error(`The mouse kept ${confirmed} ms of debounce instead of ${milliseconds} ms.`);
    }
    this.patch({ debounceMs: confirmed });
    return confirmed;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!this.usesR1LiveSettings()) await this.identify();
    const valid = this.isR1()
      ? this.getSleepOptions().includes(seconds)
      : Number.isInteger(seconds) && seconds >= SLEEP_STEP_SECONDS
        && seconds <= 0xff * SLEEP_STEP_SECONDS && seconds % SLEEP_STEP_SECONDS === 0;
    if (!valid) {
      throw new Error(`This mouse does not support a ${seconds} second sleep timeout.`);
    }
    const units = Math.round(seconds / SLEEP_STEP_SECONDS);
    const confirmed = await this.writeAdvanced(4, units) * SLEEP_STEP_SECONDS;
    if (confirmed !== units * SLEEP_STEP_SECONDS) {
      throw new Error(`The mouse kept a ${confirmed} second sleep timeout instead of ${seconds} seconds.`);
    }
    this.patch({ sleepTimeout: confirmed });
    return confirmed;
  }

  private async setAdvancedFlag(
    offset: number,
    enabled: boolean,
    field: "motionSync" | "rippleControl" | "angleSnapping",
    label: string,
  ): Promise<boolean> {
    const confirmed = await this.writeAdvanced(offset, enabled ? 1 : 0) === 1;
    if (confirmed !== enabled) throw new Error(`The mouse left ${label} ${confirmed ? "on" : "off"}.`);
    this.patch({ [field]: confirmed });
    return confirmed;
  }

  /** The advanced block is written whole, so read it back, patch one pair, write. */
  private async writeAdvanced(offset: number, value: number): Promise<number> {
    const group = Array.from(await this.read(REGISTER.advanced, ADVANCED_LENGTH));
    group.splice(offset, 2, ...wePackScalarPair(value));
    await this.write(REGISTER.advanced, group);
    return (await this.read(REGISTER.advanced, ADVANCED_LENGTH))[offset];
  }

  private async readR1Extras(stageCount: number): Promise<{
    dpiStageColors: string[];
    performanceMode: boolean;
    longRangeMode: boolean;
    dpiLedMode: number;
    dpiLedBrightness: number;
    dpiLedSpeed: number;
  } | null> {
    try {
      const performance = await this.read(REGISTER.sensorPerformance, R1_SENSOR_PERFORMANCE_LENGTH);
      const lighting = this.decodeR1DpiLighting(await this.read(REGISTER.dpiLighting, R1_DPI_LIGHTING_LENGTH));
      const dpiStageColors: string[] = [];
      for (let groupIndex = 0; groupIndex < Math.ceil(stageCount / 2); groupIndex += 1) {
        const group = await this.read(
          REGISTER.dpiColorBase + groupIndex * R1_DPI_COLOR_GROUP_LENGTH,
          R1_DPI_COLOR_GROUP_LENGTH,
        );
        for (let slot = 0; slot < 2 && dpiStageColors.length < stageCount; slot += 1) {
          const color = unpackRgb(group.subarray(slot * 4, slot * 4 + 4));
          if (!color) throw new Error("The mouse reported a DPI stage color that failed its checksum.");
          dpiStageColors.push(color);
        }
      }
      const performanceMode = weUnpackScalarPair(performance[4]!, performance[5]!);
      if ((performanceMode !== 0 && performanceMode !== 1) || !lighting) {
        throw new Error("The mouse reported invalid R1 extended settings.");
      }
      return {
        dpiStageColors,
        performanceMode: performanceMode === 1,
        longRangeMode: await this.readLongRangeMode(),
        ...lighting,
      };
    } catch {
      return null;
    }
  }

  private decodeR1DpiLighting(block: Uint8Array): {
    dpiLedMode: number;
    dpiLedBrightness: number;
    dpiLedSpeed: number;
  } | null {
    if (block.length < R1_DPI_LIGHTING_LENGTH) return null;
    const effect = weUnpackScalarPair(block[0]!, block[1]!);
    const brightness = weUnpackScalarPair(block[2]!, block[3]!);
    const speed = weUnpackScalarPair(block[4]!, block[5]!);
    const enabled = weUnpackScalarPair(block[6]!, block[7]!);
    const brightnessIndex = R1_DPI_BRIGHTNESS.indexOf(brightness as typeof R1_DPI_BRIGHTNESS[number]);
    const speedIndex = R1_DPI_SPEED.indexOf(speed as typeof R1_DPI_SPEED[number]);
    if ((effect !== 1 && effect !== 2) || brightnessIndex < 0 || speedIndex < 0
      || (enabled !== 0 && enabled !== 1)) return null;
    return {
      dpiLedMode: enabled === 0 ? 0 : effect === 2 ? 2 : 1,
      dpiLedBrightness: brightnessIndex,
      dpiLedSpeed: speedIndex,
    };
  }

  private async readLongRangeMode(): Promise<boolean> {
    const reply = await this.exchange(
      weBuildCmdPayload(GET_LONG_RANGE_COMMAND),
      (frame) => frame[0] === GET_LONG_RANGE_COMMAND && frame[1] === 0
        && frame[4] >= 1 && frame[DATA_OFFSET] <= 1 && this.hasValidChecksum(frame),
    );
    return reply[DATA_OFFSET] === 1;
  }

  private async writeR1PerformanceBlock(change: (block: number[]) => void): Promise<Uint8Array> {
    await this.identify();
    if (!this.usesVerifiedR1WiredTransport()) {
      throw new Error("Performance mode is not available on this connection.");
    }
    const block = Array.from(await this.read(REGISTER.sensorPerformance, R1_SENSOR_PERFORMANCE_LENGTH));
    change(block);
    await this.write(REGISTER.sensorPerformance, block);
    return await this.read(REGISTER.sensorPerformance, R1_SENSOR_PERFORMANCE_LENGTH);
  }

  private dpiAddress(index: number): number {
    return REGISTER.dpiBase + index * DPI_STAGE_LENGTH;
  }

  private async readDpiStage(index: number): Promise<{ x: number; y: number }> {
    const data = await this.read(this.dpiAddress(index), DPI_STAGE_LENGTH);
    const stage = this.product
      ? atkUnpackDpiStageForSensor(this.product.sensor, data)
      : atkUnpackDpiStage(data);
    if (!stage) throw new Error("The mouse reported a DPI stage that failed its checksum.");
    return stage;
  }

  private stageIndex(system: Uint8Array): number {
    const stages = this.stageCount(system);
    return Math.min(system[4], stages - 1);
  }

  private stageCount(system: Uint8Array): number {
    const max = this.isR1() ? R1_MAX_DPI_STAGES : MAX_DPI_STAGES;
    return Math.min(Math.max(system[2], 1), max);
  }

  private decodePollingRate(value: number): number {
    const match = POLLING_RATES.find(([code]) => code === value);
    if (!match) throw new Error(`The mouse reported an unknown polling-rate value 0x${value.toString(16)}.`);
    return match[1];
  }

  private decodeLiftOffDistance(code: number): LiftOffDistance | null {
    if (this.isR1()) return R1_LIFT_OFF_CODES.find(([value]) => value === code)?.[1] ?? null;
    const millimetres = atkDecodeLiftOff(code);
    if (millimetres === null) return null;
    if (millimetres < 1) return "Low";
    return millimetres < 1.5 ? "Medium" : "High";
  }

  private decodeAngle(byte: number): number {
    return byte > 0x80 ? byte - 0x100 : byte;
  }

  /**
   * R1 polling comes from the live-settings row at 0x0070, not the A9 system
   * block (whose first pair is a link-mode byte on this family). A stock row
   * may be unpopulated, so fall back to the receiver's ceiling when unknown.
   */
  private async readPollingRate(system?: Uint8Array): Promise<number> {
    if (this.usesR1LiveSettings()) {
      const settings = await this.read(ATK_VXE_R1_SETTINGS_REGISTER, R1_SETTINGS_LENGTH).catch(() => null);
      const decoded = settings ? atkDecodeVxeR1PollingCode(settings[1]) : null;
      return decoded ?? 1000;
    }
    return this.decodePollingRate((system ?? await this.read(REGISTER.system, SYSTEM_LENGTH))[0]!);
  }

  /**
   * The R1 applies the write through its live-settings row (OpenVXE sends it
   * fire-and-forget), so confirmation stays optimistic rather than erroring on
   * a register that may not echo what was applied.
   */
  private async setR1PollingRate(pollingRateHz: number): Promise<number> {
    const data = atkPackVxeR1PollingSetting(pollingRateHz);
    if (!data) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
    await this.write(ATK_VXE_R1_SETTINGS_REGISTER, data);
    const confirmed = await this.readPollingRate();
    await delay(R1_LIVE_WRITE_SETTLE_MS);
    this.patch({ pollingRateHz: confirmed });
    return confirmed;
  }

  /** The R1's lift-off levels are 1 mm and 2 mm, applied through the live-settings row. */
  private async setR1LiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    const encoded = R1_LIFT_OFF_CODES.find(([, name]) => name === value);
    if (!encoded) throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    await this.write(ATK_VXE_R1_SETTINGS_REGISTER, atkPackVxeR1LiveSetting(ATK_VXE_R1_LOD_SELECTOR, encoded[0]));
    await delay(R1_LIVE_WRITE_SETTLE_MS);
    this.patch({ liftOffDistance: value });
    return value;
  }

  private async setR1DebounceTime(milliseconds: number): Promise<number> {
    if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > R1_DEBOUNCE_MAX_MS) {
      throw new Error(`Debounce must be a whole number of milliseconds between 1 and ${R1_DEBOUNCE_MAX_MS}.`);
    }
    await this.write(
      ATK_VXE_R1_SETTINGS_REGISTER,
      atkPackVxeR1LiveSetting(ATK_VXE_R1_DEBOUNCE_SELECTOR, milliseconds),
    );
    await delay(R1_LIVE_WRITE_SETTLE_MS);
    this.patch({ debounceMs: milliseconds });
    return milliseconds;
  }

  private async setR1AngleSnapping(enabled: boolean): Promise<boolean> {
    await this.write(
      ATK_VXE_R1_SETTINGS_REGISTER,
      atkPackVxeR1LiveSetting(ATK_VXE_R1_ANGLE_SELECTOR, enabled ? 0x10 : 0x00),
    );
    await delay(R1_LIVE_WRITE_SETTLE_MS);
    this.patch({ angleSnapping: enabled });
    return enabled;
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  private hasValidChecksum(frame: Uint8Array): boolean {
    return frame.length === FRAME_LENGTH
      && frame[15] === weReportChecksum(WE_REPORT_ID, [...frame.subarray(0, 15)]);
  }

  private async readR1CurrentProfile(): Promise<number> {
    const reply = await this.exchange(
      weBuildCmdPayload(ATK_COMPX_COMMAND.getCurrentConfig),
      (frame) => frame[0] === ATK_COMPX_COMMAND.getCurrentConfig
        && frame[1] === 0 && frame[4] >= 1 && this.hasValidChecksum(frame),
    );
    const profile = atkDecodeCurrentProfile(reply.subarray(DATA_OFFSET));
    if (profile === null) throw new Error("The mouse reported an invalid active configuration bank.");
    return profile;
  }

  private async identify(): Promise<void> {
    if (this.identified) return;
    if (this.identifyAttempts >= MAX_IDENTIFY_ATTEMPTS) {
      if (this.usesSharedR1Transport()) {
        throw new Error("The VXE R1 did not answer CID/MID; refusing to use the fallback DPI codec.");
      }
      return;
    }
    this.identifyAttempts += 1;
    const reply = await this.exchange(
      weBuildCmdPayload(CIDMID_COMMAND),
      (frame) => frame[0] === CIDMID_COMMAND && frame[4] >= 2,
    ).catch(() => null);
    if (!reply) {
      if (this.usesSharedR1Transport()) {
        throw new Error("The VXE R1 did not answer CID/MID; refusing to use the fallback DPI codec.");
      }
      return;
    }
    this.identified = true;
    this.product = ATK_PRODUCTS[`${reply[DATA_OFFSET]},${reply[DATA_OFFSET + 1]}`] ?? null;
  }

  private usesSharedR1Transport(): boolean {
    return this.device.productId === VXE_R1_RECEIVER_PID
      || (this.device.vendorId === VENDOR_ID.vgn
        && (this.device.productId === VXE_R1_COMPX_RECEIVER_PID || this.device.productId === VXE_R1_COMPX_MOUSE_PID))
      || /\bvxe\s+r1(?:\s*se\+?)?\b/i.test(this.device.productName || "");
  }

  private usesR1LiveSettings(): boolean {
    return this.isR1() && this.isWireless();
  }

  private usesVerifiedR1WiredTransport(): boolean {
    return this.device.vendorId === VENDOR_ID.vgn && this.device.productId === VXE_R1_COMPX_MOUSE_PID
      && this.product === ATK_PRODUCTS["2,32"] && !this.isWireless();
  }

  /**
   * Command 0x12 (GetMouseVersion) reports the version as BCD, matching the
   * Endgame Gear siblings: an A9 Nearlink dongle answering 0x01 0x23 is 1.23.
   */
  private async readFirmware(): Promise<string[]> {
    const reply = await this.exchange(
      weBuildCmdPayload(VERSION_COMMAND),
      (frame) => frame[0] === VERSION_COMMAND,
    ).catch(() => null);
    if (!reply) return [];
    const data = reply.subarray(DATA_OFFSET, DATA_OFFSET + Math.min(reply[4], MAX_DATA_LENGTH));
    if (data.length < 2) return [];
    const bcd = (byte: number) => byte.toString(16).padStart(2, "0");
    return [`Mouse ${Number(bcd(data[0]))}.${bcd(data[1])}`];
  }

  private async readBattery(): Promise<{
    percent: number | null;
    charging: boolean | null;
    millivolts: number | null;
  } | null> {
    const reply = await this.exchange(
      weBuildCmdPayload(BATTERY_COMMAND),
      (frame) => frame[0] === BATTERY_COMMAND,
    ).catch(() => null);
    if (!reply) return null;
    const length = Math.min(reply[4], MAX_DATA_LENGTH);
    const millivolts = length >= 4 ? (reply[DATA_OFFSET + 2] << 8) | reply[DATA_OFFSET + 3] : 0;
    return {
      percent: length >= 1 ? Math.min(reply[DATA_OFFSET], 100) : null,
      charging: length >= 2 ? reply[DATA_OFFSET + 1] !== 0 : null,
      millivolts: millivolts > 0 ? millivolts : null,
    };
  }

  private async read(address: number, length: number): Promise<Uint8Array> {
    const reply = await this.exchange(
      weBuildCmdPayload(WE_CMD_READ_EEPROM, [0, (address >> 8) & 0xff, address & 0xff, length]),
      // Some firmware answers a read with the write command id.
      (frame) => (frame[0] === WE_CMD_READ_EEPROM || frame[0] === WE_CMD_WRITE_EEPROM)
        && frame[1] === 0 && this.hasValidChecksum(frame)
        && frame[2] === ((address >> 8) & 0xff)
        && frame[3] === (address & 0xff)
        && frame[4] >= length,
    );
    return reply.subarray(DATA_OFFSET, DATA_OFFSET + length);
  }

  private async write(address: number, data: readonly number[]): Promise<void> {
    if (this.isR1() && !this.usesR1LiveSettings() && !this.usesVerifiedR1WiredTransport()) {
      throw new Error("Persistent R1 EEPROM writes are available only over the verified R1 SE+ wired transport.");
    }
    const payload = weBuildCmdPayload(
      WE_CMD_WRITE_EEPROM,
      [0, (address >> 8) & 0xff, address & 0xff, data.length, ...data],
    );
    await this.run(async () => {
      await this.open();
      // Copy for an ArrayBuffer-backed view, as the WebHID typings require.
      await this.device.sendReport(WE_REPORT_ID, new Uint8Array(payload).buffer);
      await delay(WRITE_SETTLE_MS);
    });
  }

  private async send(frame: Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.device.sendReport(WE_REPORT_ID, new Uint8Array(frame).buffer);
    });
  }

  /** Send a frame and resolve with the first input report the matcher accepts. */
  private async exchange(frame: Uint8Array, matches: (frame: Uint8Array) => boolean): Promise<Uint8Array> {
    return await this.run(async () => {
      await this.open();
      return await new Promise<Uint8Array>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error("The mouse did not answer — it may be asleep or out of range."));
        }, REPLY_TIMEOUT_MS);
        const listener = (event: HIDInputReportEvent) => {
          if (event.reportId !== WE_REPORT_ID) return;
          const reply = copyDataView(event.data);
          if (reply.length < FRAME_LENGTH || !matches(reply)) return;
          finish();
          resolve(reply);
        };
        this.device.addEventListener("inputreport", listener);
        this.device.sendReport(WE_REPORT_ID, new Uint8Array(frame).buffer).catch((error: unknown) => {
          finish();
          reject(error);
        });
      });
    });
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return await started;
  }
}

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function batteryState(battery: { charging: boolean | null } | null): MouseStatus["batteryState"] {
  if (!battery || battery.charging === null) return "Unknown";
  return battery.charging ? "Charging" : "Discharging";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseHexColor(color: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function packRgb(rgb: readonly [number, number, number]): number[] {
  const sum = (rgb[0] + rgb[1] + rgb[2]) & 0xff;
  return [...rgb, (0x55 - sum) & 0xff];
}

function unpackRgb(record: Uint8Array): string | null {
  if (record.length < 4 || (record[0]! + record[1]! + record[2]! + record[3]!) % 0x100 !== 0x55) return null;
  return `#${[record[0], record[1], record[2]].map((value) => value!.toString(16).padStart(2, "0")).join("")}`;
}
