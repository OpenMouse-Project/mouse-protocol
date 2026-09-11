import type { MouseStatus } from "../mouse-types.ts";
import {
  DAREU_BUTTON_ACTIONS,
  DAREU_BUTTONS,
  DAREU_COMMAND_USAGE,
  DAREU_COMMAND_USAGE_PAGE,
  DAREU_DIRECT_PRODUCT_ID,
  DAREU_DPI_LED_BRIGHTNESS_RANGE,
  DAREU_DPI_LED_EFFECTS,
  DAREU_DPI_LED_SPEED_RANGE,
  DAREU_DPI_MAX,
  DAREU_DPI_MIN,
  DAREU_DPI_STEP,
  DAREU_MAX_BUFFER_CHUNK,
  DAREU_MEMORY_ADDRESS,
  DAREU_PROFILE_COUNT,
  DAREU_PRODUCT_IDS,
  DAREU_RECEIVER_PRODUCT_ID,
  DAREU_RECEIVER_USAGE,
  DAREU_RECEIVER_USAGE_PAGE,
  DAREU_REPORT_ID,
  DAREU_REPORT_SIZE,
  DAREU_SLEEP_TIMEOUT_SECONDS,
  DAREU_VENDOR_ID,
  DAREU_WIRED_POLLING_RATES,
  DAREU_WIRELESS_POLLING_RATES,
  dareuCheckActiveRequest,
  dareuChecksum,
  dareuDecodeActiveProfile,
  dareuDecodeBattery,
  dareuDecodeButtonAssignment,
  dareuDecodeDpiLedState,
  dareuDecodeFirmwareVersion,
  dareuDecodeReadBufferReply,
  dareuDpiFromId,
  dareuDpiId,
  dareuEncodeButtonAssignment,
  dareuEncodeDpiLedBrightness,
  dareuGetBatteryRequest,
  dareuGetActiveProfileRequest,
  dareuGetMouseFirmwareRequest,
  dareuGetReceiverFirmwareRequest,
  dareuHasValidMemoryChecksum,
  dareuIsValidDpiLedSetting,
  dareuIsValidSleepTimeout,
  dareuMatchesReply,
  dareuPollingRateHz,
  dareuPollingRateId,
  dareuReadBufferRequests,
  dareuSetActiveProfileRequest,
  dareuWithMemoryChecksum,
  dareuWriteBufferRequests,
} from "@openmouse/protocol/dareu";

const RESPONSE_TIMEOUT_MS = 800;
const MAX_DPI_STAGES = 5;

type DpiStage = { x: number; y: number };
type DpiConfig = { stageCount: number; activeStage: number; stages: DpiStage[] };

/**
 * Dareu's Jm channel uses report 8 directly through both the wired mouse and
 * the TM265 2.4 GHz receiver. Writes are exactly the vendor panel's bounded
 * memory records and are followed by a fresh read before being reported done.
 */
export class DareuHidClient {
  readonly device: HIDDevice;
  private waiter: {
    request: Uint8Array;
    resolve: (reply: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private queue: Promise<void> = Promise.resolve();

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== DAREU_REPORT_ID) return;
    const reply = new Uint8Array(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
    const waiter = this.waiter;
    if (!waiter || !dareuMatchesReply(waiter.request, reply)) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.resolve(reply);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== DAREU_VENDOR_ID || !(DAREU_PRODUCT_IDS as readonly number[]).includes(device.productId)) return false;
    const collections = this.flattenCollections(device.collections);
    const hasReceiverService = collections.some((collection) =>
      collection.usagePage === DAREU_RECEIVER_USAGE_PAGE && collection.usage === DAREU_RECEIVER_USAGE);
    const hasCommandChannel = collections.some((collection) =>
      collection.usagePage === DAREU_COMMAND_USAGE_PAGE
      && collection.usage === DAREU_COMMAND_USAGE
      && collection.inputReports.some((report) => report.reportId === DAREU_REPORT_ID && this.reportLength(report) === DAREU_REPORT_SIZE)
      && collection.outputReports.some((report) => report.reportId === DAREU_REPORT_ID && this.reportLength(report) === DAREU_REPORT_SIZE));
    return hasReceiverService && hasCommandChannel;
  }

  isWirelessPath(): boolean {
    return this.device.productId === DAREU_RECEIVER_PRODUCT_ID;
  }

  getSleepOptions(): number[] {
    return [...DAREU_SLEEP_TIMEOUT_SECONDS];
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = DAREU_DPI_MIN; dpi <= DAREU_DPI_MAX; dpi += DAREU_DPI_STEP) options.push(dpi);
    return options;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.device.removeEventListener("inputreport", this.onInputReport);
    this.device.addEventListener("inputreport", this.onInputReport);
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.onInputReport);
    this.failWaiter(new Error("The Dareu device was closed."));
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.serialized(async () => {
      await this.ensureActive();
      const battery = await this.readBattery().catch(() => null);
      const activeProfile = await this.readActiveProfile().catch(() => null);
      const dpi = await this.readDpiConfig().catch(() => null);
      const polling = await this.readPollingRate().catch(() => null);
      const lighting = await this.readDpiLighting().catch(() => null);
      const dpiLedSleep = await this.readDpiLedSleepTimeout().catch(() => null);
      const sleep = await this.readSleepTimeout().catch(() => null);
      const buttons = await this.readButtons().catch(() => null);
      const mouseFirmware = await this.readMouseFirmware().catch(() => null);
      const receiverFirmware = this.isWirelessPath() ? await this.readReceiverFirmware().catch(() => null) : null;
      const wireless = this.isWirelessPath();
      const verified = dpi !== null || polling !== null;

      return {
        brand: "Dareu",
        name: "Dareu A950 PRO Mg",
        ui: {
          family: "dareu",
          settingsReady: verified,
          valuesVerified: verified,
          hideUnsupportedPollingRates: true,
          hideSleepCard: sleep === null,
          showAdvancedSection: lighting !== null || sleep !== null,
          powerOverview: lighting !== null || sleep !== null,
          defaultDisplayName: "Dareu A950 PRO Mg",
          dpiStageEditor: dpi ? {
            maxStages: MAX_DPI_STAGES,
            countEditable: true,
            minDpi: DAREU_DPI_MIN,
            maxDpi: DAREU_DPI_MAX,
            stepDpi: DAREU_DPI_STEP,
          } : undefined,
          dpiLighting: lighting ? {
            modes: DAREU_DPI_LED_EFFECTS,
            brightness: this.range(DAREU_DPI_LED_BRIGHTNESS_RANGE),
            speed: this.range(DAREU_DPI_LED_SPEED_RANGE),
            sleepTimeouts: dpiLedSleep === null ? undefined : DAREU_SLEEP_TIMEOUT_SECONDS,
          } : undefined,
        },
        batteryPercent: battery?.percent ?? null,
        batteryState: battery ? this.batteryState(battery.percent, battery.status) : "Unknown",
        dpi: dpi?.stages[dpi.activeStage]?.x ?? 0,
        // TM271F declares DpiXOnly. Its legacy records share one high byte,
        // so exposing separate axes would create combinations the vendor UI
        // itself cannot encode.
        supportsSeparateDpiAxes: false,
        dpiStages: dpi?.stages.map((stage) => stage.x),
        activeDpiStage: dpi?.activeStage,
        pollingRateHz: polling ?? 0,
        supportedPollingRates: wireless ? [...DAREU_WIRELESS_POLLING_RATES] : [...DAREU_WIRED_POLLING_RATES],
        activeProfile,
        profileCount: activeProfile === null ? undefined : DAREU_PROFILE_COUNT,
        buttonMappings: buttons?.mappings,
        buttonOptions: buttons ? [...DAREU_BUTTON_ACTIONS] : undefined,
        fixedButtons: buttons?.fixed,
        connectionType: wireless ? "Wireless" : "Wired",
        connectionDetail: wireless ? "2.4 GHz receiver" : "USB",
        dpiLedMode: lighting?.mode ?? null,
        dpiLedBrightness: lighting?.brightness ?? null,
        dpiLedSpeed: lighting?.speed ?? null,
        dpiLedSleepTimeout: dpiLedSleep,
        sleepTimeout: sleep,
        liftOffDistance: null,
        firmware: [
          mouseFirmware === null ? null : `Mouse ${this.formatFirmware(mouseFirmware)}`,
          receiverFirmware === null ? null : `Receiver ${this.formatFirmware(receiverFirmware)}`,
        ].filter((value): value is string => value !== null),
      };
    });
  }

  async setPollingRate(rate: number): Promise<number> {
    return await this.serialized(async () => {
      await this.ensureActive();
      const id = dareuPollingRateId(rate, this.transport());
      if (id === null) throw new Error(`${rate.toLocaleString()} Hz is unavailable on this Dareu connection.`);
      await this.readPollingRate();
      await this.writeBuffer(DAREU_MEMORY_ADDRESS.pollingRate, dareuWithMemoryChecksum(new Uint8Array([id])));
      const confirmed = await this.readPollingRate();
      if (confirmed !== rate) throw new Error(`The mouse kept ${confirmed.toLocaleString()} Hz instead of ${rate.toLocaleString()} Hz.`);
      return confirmed;
    });
  }

  async setDpi(dpi: number, dpiY = dpi): Promise<number> {
    return await this.setDpiAxes(dpi, dpiY).then(({ x }) => x);
  }

  async setDpiAxes(x: number, y: number): Promise<{ x: number; y: number }> {
    return await this.serialized(async () => {
      await this.ensureActive();
      if (x !== y) throw new Error("This Dareu model exposes one shared X/Y DPI value.");
      const config = await this.readDpiConfig();
      await this.writeDpiStage(config, config.activeStage, x);
      const confirmed = (await this.readDpiConfig()).stages[config.activeStage]!;
      if (confirmed.x !== x || confirmed.y !== y) throw new Error("The mouse did not confirm the requested X/Y DPI values.");
      return { x: confirmed.x, y: confirmed.y };
    });
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    return await this.serialized(async () => {
      await this.ensureActive();
      const config = await this.readDpiConfig();
      this.assertStage(config, stage);
      await this.writeDpiStage(config, stage, dpi);
      const confirmed = (await this.readDpiConfig()).stages[stage]!;
      if (confirmed.x !== dpi) throw new Error(`The mouse kept ${confirmed.x.toLocaleString()} DPI instead of ${dpi.toLocaleString()} DPI.`);
      return confirmed.x;
    });
  }

  async setDpiStageCount(count: number): Promise<number> {
    return await this.serialized(async () => {
      await this.ensureActive();
      if (!Number.isInteger(count) || count < 1 || count > MAX_DPI_STAGES) throw new Error(`Dareu supports 1–${MAX_DPI_STAGES} DPI stages.`);
      const config = await this.readDpiConfig();
      const active = Math.min(config.activeStage, count - 1);
      await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiHeader, new Uint8Array([
        count, dareuChecksum(new Uint8Array([count, 0])), active, dareuChecksum(new Uint8Array([active, 0])),
      ]));
      const confirmed = await this.readDpiConfig();
      if (confirmed.stageCount !== count || confirmed.activeStage !== active) throw new Error("The mouse did not confirm its DPI stage count.");
      return confirmed.stageCount;
    });
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    return await this.serialized(async () => {
      await this.ensureActive();
      const config = await this.readDpiConfig();
      this.assertStage(config, stage);
      await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiHeader + 2, dareuWithMemoryChecksum(new Uint8Array([stage])));
      const confirmed = await this.readDpiConfig();
      if (confirmed.activeStage !== stage) throw new Error(`The mouse kept DPI stage ${confirmed.activeStage + 1}.`);
      return confirmed.activeStage;
    });
  }

  async setProfile(profile: number): Promise<void> {
    return await this.serialized(async () => {
      await this.ensureActive();
      await this.exchange(dareuSetActiveProfileRequest(profile));
      const confirmed = await this.readActiveProfile();
      if (confirmed !== profile) throw new Error(`The mouse kept profile ${confirmed} instead of ${profile}.`);
    });
  }

  async setDpiLighting(mode: number, brightness: number, speed: number): Promise<void> {
    return await this.serialized(async () => {
      await this.ensureActive();
      if (!dareuIsValidDpiLedSetting(mode, brightness, speed)) throw new Error("Unsupported Dareu DPI indicator setting.");
      await this.readDpiLighting();
      if (mode === 0) {
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiLedEnabled, dareuWithMemoryChecksum(new Uint8Array([0])));
      } else {
        const brightnessData = dareuEncodeDpiLedBrightness(brightness);
        if (!brightnessData) throw new Error("Unsupported Dareu DPI indicator brightness.");
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiLedEnabled, dareuWithMemoryChecksum(new Uint8Array([1])));
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiLed, dareuWithMemoryChecksum(new Uint8Array([mode])));
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiLed + 2, brightnessData);
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiLed + 4, dareuWithMemoryChecksum(new Uint8Array([speed])));
      }
      const confirmed = await this.readDpiLighting();
      if (confirmed.mode !== mode || (mode !== 0 && (confirmed.brightness !== brightness || confirmed.speed !== speed))) {
        throw new Error("The mouse did not confirm the requested DPI indicator settings.");
      }
    });
  }

  async setDpiLedSleepTimeout(seconds: number): Promise<number> {
    return await this.serialized(async () => {
      await this.ensureActive();
      if (!dareuIsValidSleepTimeout(seconds)) throw new Error("Unsupported Dareu DPI indicator sleep timeout.");
      await this.readDpiLedSleepTimeout();
      await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiLedSleep, dareuWithMemoryChecksum(new Uint8Array([seconds / 10])));
      const confirmed = await this.readDpiLedSleepTimeout();
      if (confirmed !== seconds) throw new Error("The mouse did not confirm the DPI indicator sleep timeout.");
      return confirmed;
    });
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    return await this.serialized(async () => {
      await this.ensureActive();
      if (!dareuIsValidSleepTimeout(seconds)) throw new Error("Unsupported Dareu mouse sleep timeout.");
      await this.readSleepTimeout();
      if (seconds === 0) {
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.sleepEnabled, dareuWithMemoryChecksum(new Uint8Array([0])));
      } else {
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.sleepEnabled, dareuWithMemoryChecksum(new Uint8Array([1])));
        await this.writeBuffer(DAREU_MEMORY_ADDRESS.sleepTimeout, dareuWithMemoryChecksum(new Uint8Array([seconds / 10])));
      }
      const confirmed = await this.readSleepTimeout();
      if (confirmed !== seconds) throw new Error("The mouse did not confirm its sleep timeout.");
      return confirmed;
    });
  }

  async setButtonMapping(button: string, action: string): Promise<void> {
    return await this.serialized(async () => {
      await this.ensureActive();
      const index = DAREU_BUTTONS.findIndex((candidate) => candidate.name === button);
      const encoded = dareuEncodeButtonAssignment(action);
      if (index < 0 || !encoded) throw new Error("This Dareu button mapping is read-only.");
      const current = await this.readBuffer(DAREU_MEMORY_ADDRESS.buttonAssignments + index * 4, 4);
      if (!dareuDecodeButtonAssignment(current)) throw new Error("This Dareu button has an unknown or macro assignment and is read-only.");
      await this.writeBuffer(DAREU_MEMORY_ADDRESS.buttonAssignments + index * 4, encoded);
      const confirmed = dareuDecodeButtonAssignment(await this.readBuffer(DAREU_MEMORY_ADDRESS.buttonAssignments + index * 4, 4));
      if (confirmed !== action) throw new Error("The mouse did not confirm the requested button mapping.");
    });
  }

  private async readBattery(): Promise<{ percent: number; status: number }> {
    const battery = dareuDecodeBattery(await this.exchange(dareuGetBatteryRequest()));
    if (!battery) throw new Error("The Dareu battery reply was invalid.");
    return battery;
  }

  private async readActiveProfile(): Promise<number> {
    const profile = dareuDecodeActiveProfile(await this.exchange(dareuGetActiveProfileRequest()));
    if (profile === null) throw new Error("The Dareu active-profile reply was invalid.");
    return profile;
  }

  private async readMouseFirmware(): Promise<number> {
    const version = dareuDecodeFirmwareVersion(await this.exchange(dareuGetMouseFirmwareRequest()), 18);
    if (version === null) throw new Error("The Dareu mouse firmware reply was invalid.");
    return version;
  }

  private async readReceiverFirmware(): Promise<number> {
    const version = dareuDecodeFirmwareVersion(await this.exchange(dareuGetReceiverFirmwareRequest()), 29);
    if (version === null) throw new Error("The Dareu receiver firmware reply was invalid.");
    return version;
  }

  private async readDpiConfig(): Promise<DpiConfig> {
    const header = await this.readBuffer(DAREU_MEMORY_ADDRESS.dpiHeader, 4);
    if (!dareuHasValidMemoryChecksum(header.slice(0, 2)) || !dareuHasValidMemoryChecksum(header.slice(2, 4))) {
      throw new Error("The Dareu DPI header checksum is invalid.");
    }
    const stageCount = header[0]!;
    const activeStage = header[2]!;
    if (stageCount < 1 || stageCount > MAX_DPI_STAGES || activeStage >= stageCount) throw new Error("The Dareu DPI stage header is invalid.");
    const data = await this.readBuffer(DAREU_MEMORY_ADDRESS.dpiLegacyStages, stageCount * 4);
    const stages: DpiStage[] = [];
    for (let stage = 0; stage < stageCount; stage += 1) {
      const raw = data.slice(stage * 4, stage * 4 + 4);
      if (!dareuHasValidMemoryChecksum(raw)) throw new Error(`Dareu DPI stage ${stage + 1} has an invalid checksum.`);
      const x = dareuDpiFromId(raw[0]! | raw[2]! << 8);
      const y = dareuDpiFromId(raw[1]! | raw[2]! << 8);
      if (x === null || y === null) throw new Error(`Dareu DPI stage ${stage + 1} is invalid.`);
      stages.push({ x, y });
    }
    return { stageCount, activeStage, stages };
  }

  private async readPollingRate(): Promise<number> {
    const data = await this.readBuffer(DAREU_MEMORY_ADDRESS.pollingRate, 2);
    if (!dareuHasValidMemoryChecksum(data)) throw new Error("The Dareu polling-rate checksum is invalid.");
    const rate = dareuPollingRateHz(data[0]!, this.transport());
    if (rate === null) throw new Error("The Dareu polling-rate value is unsupported on this connection.");
    return rate;
  }

  private async readDpiLighting(): Promise<{ mode: 0 | 1 | 2; brightness: number; speed: number }> {
    const lighting = dareuDecodeDpiLedState(await this.readBuffer(DAREU_MEMORY_ADDRESS.dpiLed, 8));
    if (!lighting) throw new Error("The Dareu DPI indicator data is invalid.");
    return lighting;
  }

  private async readDpiLedSleepTimeout(): Promise<number> {
    const data = await this.readBuffer(DAREU_MEMORY_ADDRESS.dpiLedSleep, 2);
    if (!dareuHasValidMemoryChecksum(data)) throw new Error("The Dareu DPI indicator sleep checksum is invalid.");
    const seconds = data[0]! * 10;
    if (!dareuIsValidSleepTimeout(seconds)) throw new Error("The Dareu DPI indicator sleep value is unsupported.");
    return seconds;
  }

  private async readSleepTimeout(): Promise<number> {
    const enabled = await this.readBuffer(DAREU_MEMORY_ADDRESS.sleepEnabled, 2);
    if (!dareuHasValidMemoryChecksum(enabled) || (enabled[0] !== 0 && enabled[0] !== 1)) {
      throw new Error("The Dareu sleep enable value is invalid.");
    }
    if (enabled[0] === 0) return 0;
    const value = await this.readBuffer(DAREU_MEMORY_ADDRESS.sleepTimeout, 2);
    if (!dareuHasValidMemoryChecksum(value)) throw new Error("The Dareu sleep timeout checksum is invalid.");
    const seconds = value[0]! * 10;
    if (!dareuIsValidSleepTimeout(seconds) || seconds === 0) throw new Error("The Dareu sleep timeout is invalid.");
    return seconds;
  }

  private async readButtons(): Promise<{ mappings: Record<string, string>; fixed: string[] }> {
    const data = await this.readBuffer(DAREU_MEMORY_ADDRESS.buttonAssignments, DAREU_BUTTONS.length * 4);
    const mappings: Record<string, string> = {};
    const fixed: string[] = [];
    DAREU_BUTTONS.forEach((button, index) => {
      const action = dareuDecodeButtonAssignment(data.slice(index * 4, index * 4 + 4));
      mappings[button.name] = action ?? "Custom (read-only)";
      if (!action) fixed.push(button.name);
    });
    return { mappings, fixed };
  }

  private async writeDpiStage(config: DpiConfig, stage: number, dpi: number): Promise<void> {
    this.assertStage(config, stage);
    const id = dareuDpiId(dpi);
    if (id === null) throw new Error(`Dareu DPI must be ${DAREU_DPI_MIN}–${DAREU_DPI_MAX.toLocaleString()} in ${DAREU_DPI_STEP}-DPI steps.`);
    const data = new Uint8Array([id & 0xff, id & 0xff, id >> 8, 0]);
    data[3] = dareuChecksum(data);
    await this.writeBuffer(DAREU_MEMORY_ADDRESS.dpiLegacyStages + stage * 4, data);
  }

  private async ensureActive(): Promise<void> {
    const response = await this.exchange(dareuCheckActiveRequest());
    if (response[5] !== 1) throw new Error("The Dareu mouse is offline. Wake it or pair it to this receiver, then retry.");
  }

  private async readBuffer(address: number, length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    const requests = dareuReadBufferRequests(address, length);
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index]!;
      const chunk = dareuDecodeReadBufferReply(request, await this.exchange(request));
      if (!chunk) throw new Error(`Dareu memory read failed at 0x${(address + index * DAREU_MAX_BUFFER_CHUNK).toString(16)}.`);
      bytes.set(chunk, index * DAREU_MAX_BUFFER_CHUNK);
    }
    return bytes;
  }

  private async writeBuffer(address: number, data: Uint8Array): Promise<void> {
    for (const request of dareuWriteBufferRequests(address, data)) {
      // Jm's SetBuffer waits for each command-7 reply. This matters for the
      // DPI LED transition: enable (82) must land before effect (76).
      await this.exchange(request);
    }
  }

  private async exchange(request: Uint8Array): Promise<Uint8Array> {
    await this.open();
    if (this.waiter) throw new Error("Another Dareu request is already in progress.");
    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === resolve) this.waiter = null;
        reject(new Error(`The Dareu mouse did not answer command 0x${request[0]!.toString(16)}.`));
      }, RESPONSE_TIMEOUT_MS);
      this.waiter = { request, resolve, reject, timer };
    });
    try {
      await this.device.sendReport(DAREU_REPORT_ID, new Uint8Array(request));
    } catch (error) {
      this.failWaiter(error instanceof Error ? error : new Error(String(error)));
    }
    return await response;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private failWaiter(error: Error): void {
    const waiter = this.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.reject(error);
  }

  private assertStage(config: DpiConfig, stage: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= config.stageCount) throw new Error(`DPI stage must be between 1 and ${config.stageCount}.`);
  }

  private transport(): "wired" | "receiver" {
    return this.device.productId === DAREU_DIRECT_PRODUCT_ID ? "wired" : "receiver";
  }

  private range([minimum, maximum]: readonly [number, number]): number[] {
    return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
  }

  private formatFirmware(version: number): string {
    return `${(version >>> 8).toString(16).toUpperCase()}.${(version & 0xff).toString(16).padStart(2, "0").toUpperCase()}`;
  }

  private batteryState(percent: number, status: number): MouseStatus["batteryState"] {
    // Dareu's Energy page defines 0x01 and 0x02 as charging. Other status
    // values have no vendor label, so retain Unknown rather than invent one.
    if (status === 1 || status === 2) return "Charging";
    if (status === 0) return percent === 100 ? "Full" : "Discharging";
    return "Unknown";
  }

  private static flattenCollections(collections: readonly HIDCollectionInfo[]): HIDCollectionInfo[] {
    return collections.flatMap((collection) => [collection, ...this.flattenCollections(collection.children)]);
  }

  private static reportLength(report: HIDReportInfo): number {
    return report.items.reduce((sum, item) => sum + item.reportSize * item.reportCount, 0) / 8;
  }
}
