import {
  bitmouseAddressDataRequest,
  bitmouseDecodeCidMid,
  bitmouseDecodeConfig,
  bitmouseDecodeDpiBlock,
  bitmouseDecodeReply,
  bitmouseDecodeSensorMode,
  bitmouseDecodeLiftOffLevel,
  bitmouseLiftOffMillimetres,
  bitmouseDecodeVersion,
  bitmouseDpiBlockAddresses,
  bitmouseDpiOptions,
  bitmouseEnabledStages,
  bitmouseEncodePollingRate,
  bitmouseEncodeSensorMode,
  bitmouseEncodeRequest,
  bitmouseSetDpiRequest,
  bitmouseSetFarDistanceRequest,
  bitmouseSetFlagRequest,
  bitmouseSetLiftOffRequest,
  bitmouseSetSensorModeRequest,
  bitmouseSetSleepRequest,
  BITMOUSE_ADDRESS,
  BITMOUSE_ADDRESS_DATA_OFFSET,
  BITMOUSE_COMMAND,
  BITMOUSE_DPI_BLOCK_CHUNK,
  BITMOUSE_DPI_RANGES,
  BITMOUSE_LENGTHS,
  BITMOUSE_LIFT_OFF_MAX_CODE,
  BITMOUSE_LIFT_OFF_MIN_CODE,
  BITMOUSE_POLLING_RATES,
  BITMOUSE_PRODUCTS,
  BITMOUSE_REPORT_ID,
  BITMOUSE_TARGET,
  BITMOUSE_USAGE,
  BITMOUSE_USAGE_PAGE,
  type BitmouseConfig,
  type BitmouseDpiBlock,
  type BitmouseProduct,
  type BitmouseReply,
  type BitmouseRequest,
} from "@openmouse/protocol/bitmouse";
import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";

/**
 * Driver for ATK's BITMOUSE configuration channel — the protocol the current
 * ATK HUB speaks to the ZERO family. See bitmouse/index.ts for the framing.
 *
 * The older ATK mice in atk/hid.ts use a different channel entirely (16-byte
 * EEPROM commands on usage page 0xff02), so the two drivers never contend for
 * the same collection.
 *
 * Only the products verified on hardware are claimed here. The vendor software
 * drives many more models over this same protocol; adding one is a product-table
 * entry plus a hardware check.
 */

const REPLY_TIMEOUT_MS = 700;
const WRITE_SETTLE_MS = 120;

/**
 * Debounce is written as a raw byte with no documented ceiling; 15 ms matches
 * the rest of the ATK range. Only 4 and 8 ms have been exercised on hardware.
 */
const DEBOUNCE_MAX_MS = 15;
const SLEEP_SECONDS: readonly number[] = [30, 60, 120, 300, 600, 1800];
const SLEEP_MIN_SECONDS = 30;
const SLEEP_MAX_SECONDS = 0xffff;

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

/**
 * The register runs 1 to 11 (0.7 mm to 1.7 mm in tenths), which the vendor
 * software exposes as a slider. MouseStatus carries three stops, so the shared
 * control writes the ends and the middle and reports anything the vendor app
 * left in between by which stop it is nearest.
 */
const LIFT_OFF_LEVELS: ReadonlyArray<readonly [code: number, name: LiftOffDistance]> = [
  [1, "Low"],
  [4, "Medium"],
  [11, "High"],
];

export class AtkBitmouseHidClient {
  readonly canDisableSleep = false;
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus: MouseStatus | null = null;
  private dpiBlock: BitmouseDpiBlock | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== VENDOR_ID.atk) return false;
    if (!BITMOUSE_PRODUCTS.has(device.productId)) return false;
    return device.collections.some((collection) => hasConfigChannel(collection));
  }

  private get product(): BitmouseProduct | null {
    return BITMOUSE_PRODUCTS.get(this.device.productId) ?? null;
  }

  /** A receiver relays configuration to the mouse on target 1. */
  private get target(): number {
    return this.product?.receiver ? BITMOUSE_TARGET.mouseBehindReceiver : BITMOUSE_TARGET.device;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastStatus = null;
    this.dpiBlock = null;
    if (this.device.opened) await this.device.close();
  }

  /** The protocol has a change-notification report, but it is not decoded yet. */
  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    return this.product?.name ?? this.device.productName?.trim() ?? "ATK";
  }

  isWireless(): boolean {
    return this.product?.receiver ?? false;
  }

  maxDpi(): number {
    return BITMOUSE_DPI_RANGES[this.product?.sensor ?? "PAW3950Ultra"].max;
  }

  getSleepOptions(): readonly number[] {
    return SLEEP_SECONDS;
  }

  getDebounceMaxMs(): number {
    return DEBOUNCE_MAX_MS;
  }

  getSupportedPollingRates(): number[] {
    return BITMOUSE_POLLING_RATES.map(([, hertz]) => hertz).sort((left, right) => left - right);
  }

  getDpiOptions(): number[] {
    return bitmouseDpiOptions(BITMOUSE_DPI_RANGES[this.product?.sensor ?? "PAW3950Ultra"]);
  }

  async readStatus(live = false): Promise<MouseStatus> {
    await this.open();
    const config = await this.readConfig();
    const battery = await this.readByte(BITMOUSE_COMMAND.getBatteryLevel, BITMOUSE_LENGTHS.getBatteryLevel);
    const charging = await this.readByte(
      BITMOUSE_COMMAND.getBatteryChargingStatus,
      BITMOUSE_LENGTHS.getBatteryChargingStatus,
    );

    // The DPI table costs seven exchanges, so a live refresh reuses the last one.
    if (!live || !this.dpiBlock) this.dpiBlock = await this.readDpiBlock();
    const dpi = this.activeStage();

    if (live && this.lastStatus) {
      return this.lastStatus = {
        ...this.lastStatus,
        batteryPercent: battery,
        batteryState: charging === 1 ? "Charging" : "Discharging",
        pollingRateHz: config?.pollingRateHz ?? this.lastStatus.pollingRateHz,
        dpi: dpi ?? this.lastStatus.dpi,
      };
    }

    const sensorMode = bitmouseDecodeSensorMode(
      await this.readAddressByte(BITMOUSE_ADDRESS.sensorModel) ?? -1,
    );
    const longRangeByte = await this.readAddressByte(BITMOUSE_ADDRESS.farDistance);
    const longRange = longRangeByte === null ? null : longRangeByte === 1;

    const usable = this.dpiBlock ? bitmouseEnabledStages(this.dpiBlock) : [];
    const stages = usable.map((stage) => stage.x);
    const activeStage = this.dpiBlock && this.dpiBlock.currentIndex < usable.length
      ? this.dpiBlock.currentIndex
      : undefined;
    return this.lastStatus = {
      brand: "ATK",
      name: this.displayName(),
      ui: {
        family: "atk-bitmouse",
        hideUnsupportedPollingRates: true,
        showAdvancedSection: true,
        forceShowBattery: battery !== null,
        dpiStageEditor: stages.length
          ? {
            maxStages: usable.length,
            countEditable: false,
            minDpi: BITMOUSE_DPI_RANGES[this.product?.sensor ?? "PAW3950Ultra"].min,
            maxDpi: this.maxDpi(),
            stepDpi: 10,
          }
          : undefined,
      },
      batteryPercent: battery,
      batteryState: charging === 1 ? "Charging" : "Discharging",
      dpi: dpi ?? 0,
      supportsSeparateDpiAxes: false,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: activeStage,
      pollingRateHz: config?.pollingRateHz ?? 0,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: config ? config.profile : null,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      connectionDetail: this.isWireless() ? "2.4 GHz receiver" : "Wired USB",
      motionSync: config?.motionSync ?? null,
      rippleControl: config?.rippleControl ?? null,
      debounceMs: config?.debounceMs ?? null,
      sleepTimeout: config?.sleepSeconds || null,
      // The vendor names this "straight line correction"; it is angle snapping.
      angleSnapping: config?.linearCorrection ?? null,
      sensorMode,
      sensorModeEditable: sensorMode !== null,
      longRangeMode: longRange,
      liftOffDistance: this.decodeLiftOff(config),
      supportedLiftOffDistances: ["Low", "Medium", "High"],
      liftOffScale: this.liftOffScale(config),
      firmware: await this.readFirmware(),
    };
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const code = bitmouseEncodePollingRate(pollingRateHz);
    if (code === null) throw new Error(`This mouse does not support ${pollingRateHz} Hz.`);
    await this.write(bitmouseSetFlagRequest(
      BITMOUSE_COMMAND.setReportRate,
      BITMOUSE_LENGTHS.setReportRate,
      code,
    ));
    const confirmed = (await this.readConfig())?.pollingRateHz;
    if (confirmed !== pollingRateHz) {
      throw new Error(`The mouse kept ${confirmed ?? "an unknown rate"} instead of ${pollingRateHz} Hz.`);
    }
    this.patch({ pollingRateHz });
    return pollingRateHz;
  }

  /** Writes the stage the mouse is currently on. */
  async setDpi(dpi: number): Promise<number> {
    if (!this.dpiBlock) this.dpiBlock = await this.readDpiBlock();
    return await this.writeStage(this.dpiBlock?.currentIndex ?? 0, dpi);
  }

  /** Writes any stage, which is what the shared DPI stage editor drives. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    return await this.writeStage(stage, dpi);
  }

  private async writeStage(index: number, dpi: number): Promise<number> {
    const range = BITMOUSE_DPI_RANGES[this.product?.sensor ?? "PAW3950Ultra"];
    if (!Number.isInteger(dpi) || dpi < range.min || dpi > range.max) {
      throw new Error(`${dpi.toLocaleString()} is not a supported DPI value.`);
    }
    if (!this.dpiBlock) this.dpiBlock = await this.readDpiBlock();
    const stage = this.dpiBlock?.stages[index];
    if (!stage) throw new Error("The mouse did not report its DPI stages.");

    // Colour rides along with every DPI write, so it is carried over from the
    // stage as read. `enable` is not part of the stored record: it tells the
    // mouse to move onto this stage, which is only right for the active one.
    const active = this.dpiBlock?.currentIndex ?? 0;
    await this.write(bitmouseSetDpiRequest({
      index,
      x: dpi,
      y: dpi,
      red: stage.red,
      green: stage.green,
      blue: stage.blue,
      enable: index === active,
    }));
    this.dpiBlock = await this.readDpiBlock();
    const confirmed = this.dpiBlock?.stages[index]?.x;
    if (confirmed !== dpi) {
      throw new Error(`The mouse kept ${confirmed?.toLocaleString() ?? "an unknown value"} instead of ${dpi.toLocaleString()} DPI.`);
    }
    const stages = this.dpiBlock ? bitmouseEnabledStages(this.dpiBlock).map((entry) => entry.x) : undefined;
    this.patch({
      dpiStages: stages?.length ? stages : undefined,
      ...(index === active ? { dpi } : {}),
    });
    return dpi;
  }

  /**
   * Lift-off. The level lives in the config block's offsetCalibration byte,
   * not in the byte the vendor's field map calls silentHeight, and a write
   * sends it as { height: 0, offsetCalibration: level - 1 }.
   */
  async setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    const level = LIFT_OFF_LEVELS.find(([, name]) => name === value)?.[0];
    if (level === undefined) {
      throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    }
    await this.write(bitmouseSetLiftOffRequest(level));
    const confirmed = this.decodeLiftOff(await this.readConfig());
    if (confirmed !== value) {
      throw new Error(`The mouse kept a ${String(confirmed ?? "unknown").toLowerCase()} lift-off distance instead of ${value.toLowerCase()}.`);
    }
    this.patch({ liftOffDistance: confirmed });
    return confirmed;
  }

  /**
   * The full 0.7-1.7 mm range, which is what the vendor software offers as a
   * slider. The three-stop setLiftOffDistance above stays for the shared
   * Low/Medium/High control.
   */
  async setLiftOffScale(code: number): Promise<number> {
    await this.write(bitmouseSetLiftOffRequest(code));
    const config = await this.readConfig();
    const confirmed = config ? bitmouseDecodeLiftOffLevel(config.offsetCalibration) : null;
    if (confirmed !== code) {
      throw new Error(`The mouse kept lift-off code ${confirmed ?? "unknown"} instead of ${code}.`);
    }
    this.patch({
      liftOffDistance: this.decodeLiftOff(config),
      liftOffScale: this.liftOffScale(config),
    });
    return code;
  }

  private liftOffScale(config: BitmouseConfig | null): MouseStatus["liftOffScale"] {
    if (!config) return null;
    const code = bitmouseDecodeLiftOffLevel(config.offsetCalibration);
    const millimetres = bitmouseLiftOffMillimetres(code);
    if (millimetres === null) return null;
    return {
      value: code,
      min: BITMOUSE_LIFT_OFF_MIN_CODE,
      max: BITMOUSE_LIFT_OFF_MAX_CODE,
      millimetres,
      minMillimetres: bitmouseLiftOffMillimetres(BITMOUSE_LIFT_OFF_MIN_CODE)!,
      maxMillimetres: bitmouseLiftOffMillimetres(BITMOUSE_LIFT_OFF_MAX_CODE)!,
    };
  }

  /** The vendor calls this "straight line correction". */
  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    await this.write(bitmouseSetFlagRequest(
      BITMOUSE_COMMAND.setLinearCorrection,
      BITMOUSE_LENGTHS.setLinearCorrection,
      enabled ? 1 : 0,
    ));
    const confirmed = (await this.readConfig())?.linearCorrection;
    if (confirmed !== enabled) throw new Error(`The mouse left angle snapping ${confirmed ? "on" : "off"}.`);
    this.patch({ angleSnapping: confirmed });
    return confirmed;
  }

  /** ATK's "Ultra Long Range": more radio range for less battery life. */
  async setLongRangeMode(enabled: boolean): Promise<boolean> {
    await this.write(bitmouseSetFarDistanceRequest(enabled));
    const byte = await this.readAddressByte(BITMOUSE_ADDRESS.farDistance);
    const confirmed = byte === null ? null : byte === 1;
    if (confirmed !== enabled) {
      throw new Error(`The mouse left long-range mode ${confirmed ? "on" : "off"}.`);
    }
    this.patch({ longRangeMode: confirmed });
    return confirmed;
  }

  async setSensorMode(mode: "Eco" | "High" | "Ultra"): Promise<"Eco" | "High" | "Ultra"> {
    const code = bitmouseEncodeSensorMode(mode);
    if (code === null) throw new Error(`This mouse does not support a ${mode} sensor mode.`);
    await this.write(bitmouseSetSensorModeRequest(code));
    const confirmed = bitmouseDecodeSensorMode(
      await this.readAddressByte(BITMOUSE_ADDRESS.sensorModel) ?? -1,
    );
    if (confirmed !== mode) {
      throw new Error(`The mouse kept the ${confirmed ?? "unknown"} sensor mode instead of ${mode}.`);
    }
    this.patch({ sensorMode: confirmed });
    return confirmed;
  }

  private decodeLiftOff(config: BitmouseConfig | null): LiftOffDistance | null {
    if (!config) return null;
    const millimetres = bitmouseLiftOffMillimetres(bitmouseDecodeLiftOffLevel(config.offsetCalibration));
    if (millimetres === null) return null;
    if (millimetres < 1) return "Low";
    return millimetres < 1.5 ? "Medium" : "High";
  }

  /** One-byte reads for the settings the config block does not carry. */
  private async readAddressByte(address: number): Promise<number | null> {
    const reply = await this.exchange(bitmouseAddressDataRequest(address, 1)).catch(() => null);
    return reply?.payload[BITMOUSE_ADDRESS_DATA_OFFSET] ?? null;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return await this.setFlag(
      BITMOUSE_COMMAND.setMotionSync, BITMOUSE_LENGTHS.setMotionSync,
      enabled, "motionSync", "Motion Sync",
    );
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return await this.setFlag(
      BITMOUSE_COMMAND.setRippleControl, BITMOUSE_LENGTHS.setRippleControl,
      enabled, "rippleControl", "ripple control",
    );
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > DEBOUNCE_MAX_MS) {
      throw new Error(`Debounce must be a whole number of milliseconds between 0 and ${DEBOUNCE_MAX_MS}.`);
    }
    await this.write(bitmouseSetFlagRequest(
      BITMOUSE_COMMAND.setStabilizationTime,
      BITMOUSE_LENGTHS.setStabilizationTime,
      milliseconds,
    ));
    const confirmed = (await this.readConfig())?.debounceMs;
    if (confirmed !== milliseconds) {
      throw new Error(`The mouse kept ${confirmed ?? "an unknown value"} ms of debounce instead of ${milliseconds} ms.`);
    }
    this.patch({ debounceMs: milliseconds });
    return milliseconds;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!Number.isInteger(seconds) || seconds < SLEEP_MIN_SECONDS || seconds > SLEEP_MAX_SECONDS) {
      throw new Error(`The sleep timeout must be between ${SLEEP_MIN_SECONDS} and ${SLEEP_MAX_SECONDS} seconds.`);
    }
    await this.write(bitmouseSetSleepRequest(seconds));
    const confirmed = (await this.readConfig())?.sleepSeconds;
    if (confirmed !== seconds) {
      throw new Error(`The mouse kept a ${confirmed ?? "unknown"} second sleep timeout instead of ${seconds} seconds.`);
    }
    this.patch({ sleepTimeout: seconds });
    return seconds;
  }

  private async setFlag(
    commandId: number,
    lengths: readonly [number, number],
    enabled: boolean,
    field: "motionSync" | "rippleControl",
    label: string,
  ): Promise<boolean> {
    await this.write(bitmouseSetFlagRequest(commandId, lengths, enabled ? 1 : 0));
    const config = await this.readConfig();
    const confirmed = config ? config[field] : null;
    if (confirmed !== enabled) throw new Error(`The mouse left ${label} ${confirmed ? "on" : "off"}.`);
    this.patch({ [field]: confirmed });
    return confirmed;
  }

  private activeStage(): number | null {
    const block = this.dpiBlock;
    if (!block) return null;
    return block.stages[block.currentIndex]?.x ?? null;
  }

  private async readConfig(): Promise<BitmouseConfig | null> {
    const [paramLen, cmdLen] = BITMOUSE_LENGTHS.getCurrentMouseConfig;
    const reply = await this.exchange({
      commandId: BITMOUSE_COMMAND.getCurrentMouseConfig,
      paramLen,
      cmdLen,
    }).catch(() => null);
    return reply ? bitmouseDecodeConfig(reply.payload) : null;
  }

  private async readByte(commandId: number, lengths: readonly [number, number]): Promise<number | null> {
    const reply = await this.exchange({ commandId, paramLen: lengths[0], cmdLen: lengths[1] })
      .catch(() => null);
    return reply && reply.payload.length ? reply.payload[0]! : null;
  }

  /** Seven ten-byte reads assemble the stage table; a gap makes it unusable. */
  private async readDpiBlock(): Promise<BitmouseDpiBlock | null> {
    const bytes: number[] = [];
    for (const address of bitmouseDpiBlockAddresses()) {
      const reply = await this.exchange(bitmouseAddressDataRequest(address, BITMOUSE_DPI_BLOCK_CHUNK))
        .catch(() => null);
      if (!reply) return null;
      const chunk = reply.payload.subarray(
        BITMOUSE_ADDRESS_DATA_OFFSET,
        BITMOUSE_ADDRESS_DATA_OFFSET + BITMOUSE_DPI_BLOCK_CHUNK,
      );
      if (chunk.length < BITMOUSE_DPI_BLOCK_CHUNK) return null;
      bytes.push(...chunk);
    }
    return bitmouseDecodeDpiBlock(bytes);
  }

  private async readFirmware(): Promise<string[]> {
    const lines: string[] = [];
    const mouse = await this.readVersion(BITMOUSE_COMMAND.getDeviceVersion, this.target);
    if (mouse) lines.push(`Mouse ${mouse}`);
    if (this.product?.receiver) {
      // Dongle commands answer on target 0 even when the mouse is behind it.
      const dongle = await this.readVersion(BITMOUSE_COMMAND.getDongleVersion, BITMOUSE_TARGET.device);
      if (dongle) lines.push(`Dongle ${dongle}`);
    }
    return lines;
  }

  private async readVersion(commandId: number, target: number): Promise<string | null> {
    const [paramLen, cmdLen] = BITMOUSE_LENGTHS.getDeviceVersion;
    const reply = await this.exchange({ commandId, paramLen, cmdLen, target }).catch(() => null);
    return reply ? bitmouseDecodeVersion(reply.payload) : null;
  }

  /**
   * The cid,mid pair the mouse answers with — an ATK ZERO reports 1,1. It is
   * how the vendor software tells models apart behind a shared receiver PID,
   * so it is the check to extend when adding a product.
   */
  async readCidMid(): Promise<string | null> {
    const [paramLen, cmdLen] = BITMOUSE_LENGTHS.mouseCidMid;
    const reply = await this.exchange({
      commandId: BITMOUSE_COMMAND.mouseCidMid,
      paramLen,
      cmdLen,
      payload: [0],
    }).catch(() => null);
    const identity = reply ? bitmouseDecodeCidMid(reply.payload) : null;
    return identity ? `${identity.cid},${identity.mid}` : null;
  }

  /** True when the mouse identifies as the product its USB id claims. */
  async confirmsProduct(): Promise<boolean | null> {
    const expected = this.product?.cidMid;
    if (!expected) return null;
    const actual = await this.readCidMid();
    return actual === null ? null : actual === expected;
  }

  private async write(request: BitmouseRequest): Promise<void> {
    await this.run(async () => {
      await this.open();
      const frame = bitmouseEncodeRequest({ ...request, target: request.target ?? this.target });
      await this.device.sendReport(BITMOUSE_REPORT_ID, frame);
      await delay(WRITE_SETTLE_MS);
    });
  }

  /** Send a request and resolve with the reply carrying the same command id. */
  private async exchange(request: BitmouseRequest): Promise<BitmouseReply> {
    const frame = bitmouseEncodeRequest({ ...request, target: request.target ?? this.target });
    return await this.run(async () => {
      await this.open();
      return await new Promise<BitmouseReply>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error("The mouse did not answer — it may be asleep or out of range."));
        }, REPLY_TIMEOUT_MS);
        const listener = (event: HIDInputReportEvent) => {
          if (event.reportId !== BITMOUSE_REPORT_ID) return;
          const decoded = bitmouseDecodeReply(copyDataView(event.data));
          if (!decoded || decoded.commandId !== request.commandId) return;
          finish();
          if (decoded.isError) {
            reject(new Error(`The mouse rejected command ${request.commandId}.`));
            return;
          }
          resolve(decoded);
        };
        this.device.addEventListener("inputreport", listener);
        this.device.sendReport(BITMOUSE_REPORT_ID, frame).catch((error: unknown) => {
          finish();
          reject(error);
        });
      });
    });
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return await started;
  }
}

function hasConfigChannel(collection: HIDCollectionInfo): boolean {
  const here = collection.usagePage === BITMOUSE_USAGE_PAGE
    && collection.usage === BITMOUSE_USAGE
    && collection.outputReports.some((report) => report.reportId === BITMOUSE_REPORT_ID);
  return here || collection.children.some(hasConfigChannel);
}

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
