/** Keychron Nape Pro VIA driver. M-series mice use a different HID protocol and need their own client. */
import type { MouseStatus } from "../mouse-types.ts";
import {
  KEYCHRON_COMMAND as CMD,
  KEYCHRON_MISC_COMMAND as MISC,
  KEYCHRON_NAPE_COMMAND as NAPE,
  KEYCHRON_NAPE_DPI_MAX as DPI_MAX,
  KEYCHRON_NAPE_DPI_MIN as DPI_MIN,
  KEYCHRON_NAPE_DPI_STEP as DPI_STEP,
  KEYCHRON_NAPE_LAYER_COUNT as LAYER_COUNT,
  KEYCHRON_NAPE_ORIENTATION_STEPS as ORIENTATION_STEPS,
  KEYCHRON_NAPE_SLEEP_MAX_SECONDS as SLEEP_MAX,
  KEYCHRON_NAPE_SLEEP_MIN_SECONDS as SLEEP_MIN,
  KEYCHRON_NAPE_SLEEP_OPTIONS as SLEEP_OPTIONS,
  KEYCHRON_POLLING_TABLE as POLLING_TABLE,
  KEYCHRON_NAPE_PRODUCTS as PRODUCTS,
  KEYCHRON_RAW_USAGE as RAW_USAGE,
  KEYCHRON_RAW_USAGE_PAGE as RAW_USAGE_PAGE,
  KEYCHRON_REPORT_ID as REPORT_ID,
  KEYCHRON_VENDOR_ID,
  KEYCHRON_VIA_COMMAND as VIA,
  keychronDecodeBattery,
  keychronDecodeCurrentLayer,
  keychronDecodeFirmware,
  keychronDecodeKeycodeReply,
  keychronDecodeKeymapBuffer,
  keychronDecodeLayerCount,
  keychronDecodePolling,
  keychronDecodeSleepTimeout,
  keychronDecodeOrientationIndex,
  keychronEncodeGetBuffer,
  keychronEncodeGetEncoder,
  keychronEncodeGetKeycode,
  keychronEncodeGetLayerOrientation,
  keychronEncodeSetEncoder,
  keychronEncodeSetKeycode,
  keychronEncodeSetLayer,
  keychronEncodeSetLayerOrientation,
  keychronEncodeSetOrientation,
  keychronEncodeSleepTimeout,
  keychronLayerKeymapFromCodes,
  keychronLayerLabel,
  keychronOrientationDegrees,
  keychronOrientationIndex,
  keychronPacket,
  keychronUserLayerToVia,
  type KeychronNapeLayerKeymap,
} from "@openmouse/protocol/keychron";
const QUERY_TIMEOUT_MS = 1200;

const DPI_STAGE_COUNT = 5;
const NAPE_DISPLAY_NAME = "Nape Pro";
const PRODUCT_IDS = new Set<number>(PRODUCTS.keys());

export class KeychronNapeHidClient {
  private responseWaiter: {
    match: (bytes: Uint8Array) => boolean;
    resolve: (bytes: Uint8Array) => void;
    reject: (reason: Error) => void;
  } | null = null;

  private napeVerified: boolean | null = null;
  readonly device: HIDDevice;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const bytes = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    if (!this.responseWaiter?.match(bytes)) return;
    const waiter = this.responseWaiter;
    this.responseWaiter = null;
    waiter.resolve(bytes);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }
  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === KEYCHRON_VENDOR_ID
      && PRODUCT_IDS.has(device.productId)
      && device.collections.some((collection) =>
        collection.usagePage === RAW_USAGE_PAGE && collection.usage === RAW_USAGE);
  }

  private openedListener = false;

  async open(): Promise<void> {
    await this.openDevice();
    await this.ensureNapeCompatible();
  }

  private async openDevice(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.openedListener) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.openedListener = true;
    }
  }

  async close(): Promise<void> {
    if (this.openedListener) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.openedListener = false;
    }
    this.responseWaiter?.reject(new Error("The Keychron device was closed."));
    this.responseWaiter = null;
    this.napeVerified = null;
    if (this.device.opened) await this.device.close();
  }

  private isReceiver(): boolean {
    return PRODUCTS.get(this.device.productId)?.receiver === true;
  }

  private async ensureNapeCompatible(): Promise<void> {
    if (!this.isReceiver()) {
      this.napeVerified = true;
      return;
    }
    if (this.napeVerified === true) return;
    if (this.napeVerified === false) {
      throw new Error(this.incompatibleReceiverMessage());
    }

    try {
      const orientationIndex = await this.getOrientationIndex();
      if (orientationIndex < 0 || orientationIndex >= ORIENTATION_STEPS) {
        throw new Error("orientation out of range");
      }
      const stage = await this.getDpiStage();
      const dpi = await this.getDpiValue(stage);
      if (dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
        throw new Error(`dpi ${dpi} outside Nape Pro range`);
      }
      this.napeVerified = true;
    } catch (error) {
      this.napeVerified = false;
      await this.close().catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.incompatibleReceiverMessage()} (${detail})`);
    }
  }

  private incompatibleReceiverMessage(): string {
    const receiver = PRODUCTS.get(this.device.productId)?.name ?? "Keychron receiver";
    return `This ${receiver} is not paired to a Nape Pro that OpenMouse can control. `
      + "Use the wired cable, or pair a Nape Pro to the receiver.";
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = DPI_MIN; dpi <= DPI_MAX; dpi += DPI_STEP) options.push(dpi);
    return options;
  }

  getSleepOptions(): number[] {
    return [...SLEEP_OPTIONS];
  }

  readonly canDisableSleep = false;

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const firmware = await this.getFirmwareVersion().catch(() => null);
    const stage = await this.getDpiStage();
    const stages = await this.getAllDpiValues();
    const battery = await this.getBattery().catch(() => null);
    const polling = await this.getPolling().catch(() => null);
    const orientation = await this.getOrientation().catch(() => null);
    const sleepTimeout = await this.getSleepTimeout().catch(() => null);
    const layers = await this.readLayers().catch(() => null);
    const active = stages.find((entry) => entry.index === stage) ?? stages[0];
    const dpi = active?.value ?? 800;
    const product = PRODUCTS.get(this.device.productId);
    const viaReceiver = product?.receiver === true;
    const displayName = viaReceiver
      ? NAPE_DISPLAY_NAME
      : (product?.name || this.device.productName || NAPE_DISPLAY_NAME);
    const connectionDetail = [
      viaReceiver ? `2.4 GHz (${product?.name ?? "receiver"})` : "Wired USB",
      orientation !== null ? `${orientation}\u00b0 orientation` : null,
      `DPI stage ${stage + 1}/${DPI_STAGE_COUNT}`,
      layers ? keychronLayerLabel(layers.current) : null,
    ].filter(Boolean).join(" · ");

    return {
      brand: "Keychron",
      name: displayName,
      ui: {
        family: "keychron-nape",
        defaultDisplayName: NAPE_DISPLAY_NAME,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        forceShowBattery: true,
        showAdvancedSection: sleepTimeout !== null,
        pollingNote: "Nape Pro exposes polling through Keychron's misc HID commands when the firmware allows it.",
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          countEditable: false,
          minDpi: DPI_MIN,
          maxDpi: DPI_MAX,
          stepDpi: DPI_STEP,
        },
      },
      batteryPercent: battery && battery.percent <= 100 ? battery.percent : null,
      batteryState: battery ? battery.state : "Unknown",
      dpi,
      dpiStages: stages.map((entry) => entry.value),
      activeDpiStage: stage,
      pollingRateHz: polling?.rateHz ?? 1000,
      supportedPollingRates: polling?.supported ?? [1000],
      activeProfile: null,
      connectionDetail: connectionDetail || "Keychron Launcher protocol",
      liftOffDistance: null,
      supportedLiftOffDistances: [],
      sleepTimeout,
      napeLayer: layers?.current,
      napeLayerCount: layers?.count,
      firmware: [firmware ?? "Firmware unavailable"],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    if (dpi < DPI_MIN || dpi > DPI_MAX) {
      throw new Error(`Nape Pro DPI must be between ${DPI_MIN} and ${DPI_MAX}.`);
    }
    await this.open();
    const stage = await this.getDpiStage();
    return await this.writeDpiStageValue(stage, dpi);
  }

  /** Selects the active DPI stage index (0-based). */
  async setActiveDpiStage(stage: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= DPI_STAGE_COUNT) {
      throw new Error(`DPI stage must be between 1 and ${DPI_STAGE_COUNT}.`);
    }
    await this.open();
    await this.write([CMD.miscGroup, NAPE.setDpiStage, stage & 0xff]);
    const confirmed = await this.getDpiStage();
    if (confirmed !== stage) throw new Error(`The mouse kept DPI stage ${confirmed + 1}.`);
    return confirmed;
  }

  /** Writes one stage's DPI value without requiring it to be active first. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= DPI_STAGE_COUNT) {
      throw new Error(`DPI stage must be between 1 and ${DPI_STAGE_COUNT}.`);
    }
    if (dpi < DPI_MIN || dpi > DPI_MAX) {
      throw new Error(`Nape Pro DPI must be between ${DPI_MIN} and ${DPI_MAX}.`);
    }
    await this.open();
    return await this.writeDpiStageValue(stage, dpi);
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    await this.open();
    const current = await this.getPolling();
    if (!current.supported.includes(pollingRateHz)) {
      throw new Error(`This Nape Pro connection does not support ${pollingRateHz} Hz.`);
    }
    const shift = POLLING_TABLE.indexOf(pollingRateHz as (typeof POLLING_TABLE)[number]);
    if (shift < 0) throw new Error(`Unsupported polling rate ${pollingRateHz} Hz.`);
    await this.write([CMD.miscGroup, MISC.setPolling, shift & 0xff, shift & 0xff]);
    return (await this.getPolling()).rateHz;
  }

  async setLiftOffDistance(_lod: NonNullable<MouseStatus["liftOffDistance"]>): Promise<never> {
    throw new Error("Lift-off distance is not exposed by the Nape Pro Launcher protocol.");
  }

  async setMotionSync(_enabled: boolean): Promise<never> {
    throw new Error("Motion Sync is not exposed by the Nape Pro Launcher protocol.");
  }

  async setAngleSnapping(_enabled: boolean): Promise<never> {
    throw new Error("Angle snapping is not exposed by the Nape Pro Launcher protocol.");
  }

  async setRippleControl(_enabled: boolean): Promise<never> {
    throw new Error("Ripple control is not exposed by the Nape Pro Launcher protocol.");
  }

  async setDebounceTime(_debounceMs: number): Promise<never> {
    throw new Error("Debounce is not exposed by the Nape Pro Launcher protocol.");
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!Number.isInteger(seconds) || seconds < SLEEP_MIN) {
      throw new Error("The sleep time cannot be less than 1 minute.");
    }
    if (seconds > SLEEP_MAX) {
      throw new Error("The sleep time cannot be more than 12:59:59.");
    }
    await this.open();
    const reply = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === MISC.setSleep,
      keychronEncodeSleepTimeout(seconds),
    );
    if ((reply[2] ?? 0) !== 0) {
      throw new Error("The Nape Pro rejected the requested sleep timeout.");
    }
    const confirmed = await this.getSleepTimeout();
    if (confirmed !== seconds) {
      throw new Error(`The mouse kept a ${confirmed} second sleep timeout instead of ${seconds} seconds.`);
    }
    return confirmed;
  }

  async setPerformanceMode(_enabled: boolean): Promise<never> {
    throw new Error("Performance mode is not exposed by the Nape Pro Launcher protocol.");
  }

  /** Selects the active user layer (1–8). */
  async setLayer(layer: number): Promise<number> {
    await this.open();
    const count = await this.usableLayerCount();
    if (!Number.isInteger(layer) || layer < 1 || layer > count) {
      throw new Error(`Layer must be between 1 and ${count}.`);
    }
    await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.setLayer,
      keychronEncodeSetLayer(layer),
    );
    const confirmed = await this.getCurrentLayer();
    if (confirmed !== layer) {
      throw new Error(`The mouse kept layer ${confirmed} instead of layer ${layer}.`);
    }
    return confirmed;
  }

  async readLayerKeymap(layer: number): Promise<KeychronNapeLayerKeymap> {
    await this.open();
    const viaLayer = keychronUserLayerToVia(layer);
    const buffer = await this.query(
      (bytes) => bytes[0] === VIA.getBuffer,
      keychronEncodeGetBuffer(viaLayer),
    );
    const columns = keychronDecodeKeymapBuffer(buffer);
    const ccw = await this.query(
      (bytes) => bytes[0] === VIA.getEncoder && bytes[3] === 0,
      keychronEncodeGetEncoder(viaLayer, false),
    );
    const cw = await this.query(
      (bytes) => bytes[0] === VIA.getEncoder && bytes[3] === 1,
      keychronEncodeGetEncoder(viaLayer, true),
    );
    const orientationIndex = await this.getLayerOrientationIndex(layer).catch(() => 0);
    return keychronLayerKeymapFromCodes(
      layer,
      columns,
      keychronDecodeKeycodeReply(ccw),
      keychronDecodeKeycodeReply(cw),
      orientationIndex >= 0 && orientationIndex < ORIENTATION_STEPS ? orientationIndex : 0,
    );
  }

  async setLayerOrientation(layer: number, index: number): Promise<number> {
    await this.open();
    const count = await this.usableLayerCount();
    if (!Number.isInteger(layer) || layer < 1 || layer > count) {
      throw new Error(`Layer must be between 1 and ${count}.`);
    }
    const next = keychronOrientationIndex(index);
    await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.setLayerOrientation,
      keychronEncodeSetLayerOrientation(layer, next),
    );
    const confirmed = await this.getLayerOrientationIndex(layer);
    if (confirmed !== next) {
      throw new Error(`The mouse kept orientation index ${confirmed} on that layer instead of ${next}.`);
    }
    const current = await this.getCurrentLayer();
    if (current === layer) {
      await this.query(
        (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.setOrientation,
        keychronEncodeSetOrientation(next),
      );
    }
    return confirmed;
  }

  async setKeycode(layer: number, col: number, keycode: number): Promise<number> {
    await this.open();
    const viaLayer = keychronUserLayerToVia(layer);
    await this.query(
      (bytes) => bytes[0] === VIA.setKeycode,
      keychronEncodeSetKeycode(viaLayer, col, keycode),
    );
    const confirmed = await this.query(
      (bytes) => bytes[0] === VIA.getKeycode && bytes[3] === (col & 0xff),
      keychronEncodeGetKeycode(viaLayer, col),
    );
    const actual = keychronDecodeKeycodeReply(confirmed);
    if (actual !== keycode) {
      throw new Error(`The mouse kept 0x${actual.toString(16)} on that button instead of 0x${keycode.toString(16)}.`);
    }
    return actual;
  }

  async setEncoder(layer: number, clockwise: boolean, keycode: number): Promise<number> {
    await this.open();
    const viaLayer = keychronUserLayerToVia(layer);
    await this.query(
      (bytes) => bytes[0] === VIA.setEncoder,
      keychronEncodeSetEncoder(viaLayer, clockwise, keycode),
    );
    const confirmed = await this.query(
      (bytes) => bytes[0] === VIA.getEncoder && bytes[3] === (clockwise ? 1 : 0),
      keychronEncodeGetEncoder(viaLayer, clockwise),
    );
    const actual = keychronDecodeKeycodeReply(confirmed);
    if (actual !== keycode) {
      throw new Error(`The mouse kept 0x${actual.toString(16)} on the scroll wheel instead of 0x${keycode.toString(16)}.`);
    }
    return actual;
  }

  private async getDpiStage(): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.getDpiStage,
      [CMD.miscGroup, NAPE.getDpiStage],
    );
    return Math.min(response[2] ?? 0, DPI_STAGE_COUNT - 1);
  }

  private async getDpiValue(stage: number): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.getDpiValue,
      [CMD.miscGroup, NAPE.getDpiValue, stage & 0xff],
    );
    return (response[2] ?? 0) | ((response[3] ?? 0) << 8);
  }

  private async getAllDpiValues(): Promise<Array<{ index: number; value: number }>> {
    const values: Array<{ index: number; value: number }> = [];
    for (let index = 0; index < DPI_STAGE_COUNT; index += 1) {
      try {
        values.push({ index, value: await this.getDpiValue(index) });
      } catch {
        break;
      }
    }
    return values;
  }

  private async writeDpiStageValue(stage: number, dpi: number): Promise<number> {
    // Launcher writes are fire-and-forget (no matching input report).
    await this.write([CMD.miscGroup, NAPE.setDpiValue, stage & 0xff, dpi & 0xff, (dpi >> 8) & 0xff]);
    const active = await this.getDpiStage();
    if (active === stage) {
      await this.write([CMD.miscGroup, NAPE.setDpiStage, stage & 0xff]);
    }
    const confirmed = await this.getDpiValue(stage);
    if (confirmed !== dpi) {
      if (active === stage) {
        await this.write([CMD.miscGroup, NAPE.setCustomDpi, dpi & 0xff, (dpi >> 8) & 0xff]);
        return await this.getCustomDpi().catch(async () => this.getDpiValue(stage));
      }
      throw new Error(`The mouse kept ${confirmed} DPI instead of ${dpi} DPI.`);
    }
    return confirmed;
  }

  private async getBattery(): Promise<{ percent: number; state: MouseStatus["batteryState"] }> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.getBattery,
      [CMD.miscGroup, NAPE.getBattery],
    );
    return keychronDecodeBattery(response);
  }

  private async getOrientationIndex(): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.getOrientation,
      [CMD.miscGroup, NAPE.getOrientation],
    );
    return keychronDecodeOrientationIndex(response);
  }

  private async getLayerOrientationIndex(layer: number): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.getLayerOrientation,
      keychronEncodeGetLayerOrientation(layer),
    );
    return keychronDecodeOrientationIndex(response);
  }

  private async getOrientation(): Promise<number | null> {
    const index = await this.getOrientationIndex();
    if (index < 0 || index >= ORIENTATION_STEPS) return null;
    return keychronOrientationDegrees(index);
  }

  private async getCustomDpi(): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === NAPE.getCustomDpi,
      [CMD.miscGroup, NAPE.getCustomDpi],
    );
    return (response[2] ?? 0) | ((response[3] ?? 0) << 8);
  }

  private async getPolling(): Promise<{ rateHz: number; supported: number[] }> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === MISC.getPolling,
      [CMD.miscGroup, MISC.getPolling],
    );
    return keychronDecodePolling(response);
  }

  private async getSleepTimeout(): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.miscGroup && bytes[1] === MISC.getSleep,
      [CMD.miscGroup, MISC.getSleep],
    );
    return keychronDecodeSleepTimeout(response);
  }

  private async getFirmwareVersion(): Promise<string | null> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.firmwareVersion,
      [CMD.firmwareVersion],
    );
    return keychronDecodeFirmware(response);
  }

  private async readLayers(): Promise<{ count: number; current: number } | null> {
    const count = await this.usableLayerCount();
    if (count < 1) return null;
    const current = Math.min(Math.max(await this.getCurrentLayer(), 1), count);
    return { count, current };
  }

  private async usableLayerCount(): Promise<number> {
    const reported = await this.getLayerCount();
    if (reported < 1) return 0;
    return Math.min(reported, LAYER_COUNT);
  }

  private async getLayerCount(): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === VIA.getLayerCount,
      [VIA.getLayerCount],
    );
    return keychronDecodeLayerCount(response);
  }

  private async getCurrentLayer(): Promise<number> {
    const response = await this.query(
      (bytes) => bytes[0] === CMD.getCurrentLayer,
      [CMD.getCurrentLayer],
    );
    return keychronDecodeCurrentLayer(response);
  }

  private async write(command: number[]): Promise<void> {
    const packet = keychronPacket(command);
    await this.device.sendReport(REPORT_ID, packet);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  }

  private async query(match: (bytes: Uint8Array) => boolean, command: number[]): Promise<Uint8Array> {
    if (this.responseWaiter) throw new Error("Another Keychron request is already in progress.");
    const packet = keychronPacket(command);
    let timeout = 0;
    let rejectResponse: ((reason: Error) => void) | null = null;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      rejectResponse = reject;
      timeout = window.setTimeout(() => {
        this.responseWaiter = null;
        reject(new Error(`The Keychron device did not answer command 0x${command[0]?.toString(16)}.`));
      }, QUERY_TIMEOUT_MS);
      this.responseWaiter = {
        match,
        resolve: (bytes) => {
          window.clearTimeout(timeout);
          resolve(bytes);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      };
    });
    void response.catch(() => undefined);
    try {
      await this.device.sendReport(REPORT_ID, packet);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      (rejectResponse as ((reason: Error) => void) | null)?.(new Error(`Chrome could not write Keychron HID report. ${detail}`));
      this.responseWaiter = null;
    }
    return await response;
  }
}
