import type { AsusOmniDevice, AsusOmniInfo, MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";

import {
  ASUS_DEBOUNCE_MS,
  ASUS_MICE,
  ASUS_OMNI_KEYBOARDS,
  ASUS_OMNI_PRODUCT_ID,
  ASUS_OMNI_REPORT_ID,
  ASUS_OMNI_REPORT_SIZE,
  ASUS_OMNI_USAGE_PAGE,
  ASUS_POLLING_RATES,
  ASUS_REPORT_ID,
  ASUS_REPORT_SIZE,
  ASUS_USAGE,
  ASUS_USAGE_PAGE,
  ASUS_VENDOR_ID,
  asusOmniBoosterRequest,
  asusOmniDecodeFirmware,
  asusOmniDecodePairedDevices,
  asusOmniDeviceKind,
  asusOmniFirmwareRequest,
  asusOmniPairedDevicesRequest,
  asusOmniPairingModeRequest,
  asusOmniRebootRequest,
  asusOmniUnpairRequest,
  asusDecodeBattery,
  asusDecodeDpiColors,
  asusDecodeDpiXY,
  asusDecodeLighting,
  asusDecodeLiftOffDistance,
  asusDecodeProfile,
  asusDecodeSettings,
  asusReadBatteryRequest,
  asusReadDpiColorsRequest,
  asusReadDpiXYRequest,
  asusReadLiftOffRequest,
  asusReadLightingRequest,
  asusReadProfileRequest,
  asusReadSettingsRequest,
  asusSaveRequest,
  asusSetActiveDpiStageRequest,
  asusSetAngleSnappingRequest,
  asusSetDebounceRequest,
  asusSetDpiRequest,
  asusSetLiftOffRequest,
  asusSetLightingRequest,
  asusSetPollingRateRequest,
  asusSetProfileRequest,
  type AsusBattery,
  type AsusLightingEffect,
  type AsusLiftOffDistance,
  type AsusMouseModel,
  type AsusOmniSlot,
  type AsusProfile,
  type AsusRawLightingZone,
  type AsusRgb,
  type AsusSettings,
} from "../../asus/index.js";

const RESPONSE_TIMEOUT_MS = 1000;

const UNPAIR_TIMEOUT_MS = 10_000;

const UNPAIR_POLL_MS = 500;

const OMNI_NAME = "ROG Omni receiver";

const COLOR_MODES: readonly MouseLightingMode[] = ["Static", "Breathing single", "Reactive", "Wave"];

const BRIGHTNESS_LEVELS = [0, 25, 50, 75, 100] as const;

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function hasConfigCollection(collections: readonly HIDCollectionInfo[], usagePage: number, reportId: number): boolean {
  return collections.some(
    (collection) =>
      (collection.usagePage === usagePage &&
        collection.usage === ASUS_USAGE &&
        collection.inputReports.some((report) => report.reportId === reportId) &&
        collection.outputReports.some((report) => report.reportId === reportId)) ||
      hasConfigCollection(collection.children, usagePage, reportId),
  );
}

function omniDevice(slot: AsusOmniSlot): AsusOmniDevice {
  const name = ASUS_MICE.get(slot.productId)?.name
    ?? ASUS_OMNI_KEYBOARDS.get(slot.productId)
    ?? `ASUS device 0x${slot.productId.toString(16).padStart(4, "0")}`;
  return { productId: slot.productId, kind: asusOmniDeviceKind(slot), name };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function parseHexColor(color: string | null): [number, number, number] {
  const normalized = color ?? "#ff0000";
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(normalized);
  if (!match) {
    throw new Error(`Invalid RGB colour: ${normalized}`);
  }

  return [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)];
}

export class AsusHidClient {
  readonly device: HIDDevice;

  readonly isOmni: boolean;

  /** On an Omni receiver, the paired mouse from the last pair-list read. */
  private pairedModel: AsusMouseModel | null;

  private mouseReportId = ASUS_REPORT_ID;

  private mouseProductId: number | null = null;

  private booster = false;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.isOmni = device.productId === ASUS_OMNI_PRODUCT_ID;
    this.pairedModel = ASUS_MICE.get(device.productId) ?? null;
    if (!this.pairedModel && !this.isOmni) {
      throw new Error(`ASUS product 0x${device.productId.toString(16)} is not supported.`);
    }

    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== ASUS_VENDOR_ID) return false;
    if (device.productId === ASUS_OMNI_PRODUCT_ID) {
      return hasConfigCollection(device.collections, ASUS_OMNI_USAGE_PAGE, ASUS_OMNI_REPORT_ID);
    }
    return ASUS_MICE.has(device.productId) && hasConfigCollection(device.collections, ASUS_USAGE_PAGE, ASUS_REPORT_ID);
  }

  get model(): AsusMouseModel {
    if (!this.pairedModel) {
      throw new Error(`No supported mouse is paired to this ${OMNI_NAME}.`);
    }
    return this.pairedModel;
  }

  private get label(): string {
    return this.pairedModel?.name ?? OMNI_NAME;
  }

  async open(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
  }

  async close(): Promise<void> {
    if (this.device.opened) {
      await this.device.close();
    }
  }

  getDpiOptions(): number[] {
    const { minDpi, maxDpi, dpiStep } = this.model;
    const values: number[] = [];
    for (let dpi = minDpi; dpi <= maxDpi; dpi += dpiStep) {
      values.push(dpi);
    }
    return values;
  }

  getSupportedPollingRates(): number[] {
    return ASUS_POLLING_RATES.filter((rate) => this.booster || rate <= 1000);
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return started;
  }

  /** Report 0 is the mouse's own 64-byte channel; every Omni report is 63 bytes. */
  private payload(request: Uint8Array, reportId: number): ArrayBuffer {
    const size = reportId === ASUS_REPORT_ID ? ASUS_REPORT_SIZE : ASUS_OMNI_REPORT_SIZE;
    const payload = new ArrayBuffer(size);
    new Uint8Array(payload).set(request.subarray(0, size));
    return payload;
  }

  /** Sends `request` and resolves with the first reply echoing its first `matchLength` bytes. */
  private async exchange(request: Uint8Array, matchLength = 3, reportId = this.mouseReportId): Promise<Uint8Array> {
    return this.run(async () => {
      await this.open();

      const payload = this.payload(request, reportId);

      return new Promise<Uint8Array>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
        };

        const listener = (event: HIDInputReportEvent): void => {
          if (event.reportId !== reportId) return;

          const data = copyDataView(event.data);
          if (data.length < payload.byteLength) return;

          // `FF AA` is the firmware's reply while asleep, out of range, or refusing a request.
          if (data[0] === 0xff && data[1] === 0xaa) {
            cleanup();
            reject(new Error(`${this.label} is asleep or refused the request.`));
            return;
          }

          for (let i = 0; i < matchLength; i++) {
            if (data[i] !== request[i]) return;
          }

          cleanup();
          resolve(data.subarray(0, payload.byteLength));
        };

        const timer = setTimeout(() => {
          this.device.removeEventListener("inputreport", listener);
          reject(new Error(`${this.label} did not answer the HID request.`));
        }, RESPONSE_TIMEOUT_MS);

        this.device.addEventListener("inputreport", listener);

        this.device.sendReport(reportId, payload).catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
    });
  }

  /** For receiver commands that GearLink sends without waiting for a reply. */
  private async sendToReceiver(request: Uint8Array): Promise<void> {
    if (!this.isOmni) {
      throw new Error(`The ${this.label} is not a ${OMNI_NAME}.`);
    }

    await this.run(async () => {
      await this.open();
      await this.device.sendReport(ASUS_OMNI_REPORT_ID, this.payload(request, ASUS_OMNI_REPORT_ID));
    });
  }

  /** Reads the pair list and switches to whichever supported mouse it names. */
  async readOmniReceiver(): Promise<AsusOmniInfo> {
    const firmware = asusOmniDecodeFirmware(await this.exchange(asusOmniFirmwareRequest(), 2, ASUS_OMNI_REPORT_ID));
    const slots = asusOmniDecodePairedDevices(
      await this.exchange(asusOmniPairedDevicesRequest(), 2, ASUS_OMNI_REPORT_ID),
    );

    const mouse = slots.find((slot) => asusOmniDeviceKind(slot) === "mouse" && ASUS_MICE.has(slot.productId));
    if (!mouse) {
      this.pairedModel = null;
      this.mouseProductId = null;
      this.booster = false;
    } else if (mouse.productId !== this.mouseProductId || mouse.reportId !== this.mouseReportId) {
      this.booster = (await this.exchange(asusOmniBoosterRequest(), 3, mouse.reportId))[4] === 0x01;
      this.pairedModel = { ...ASUS_MICE.get(mouse.productId)!, wireless: true };
      this.mouseReportId = mouse.reportId;
      this.mouseProductId = mouse.productId;
    }

    return { firmware, devices: slots.map(omniDevice) };
  }

  async setOmniPairingMode(enabled: boolean): Promise<void> {
    await this.sendToReceiver(asusOmniPairingModeRequest(enabled));
  }

  /** Resolves once the pair list no longer holds `productId`. */
  async unpairOmniDevice(productId: number): Promise<void> {
    await this.sendToReceiver(asusOmniUnpairRequest(productId));

    const deadline = Date.now() + UNPAIR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await wait(UNPAIR_POLL_MS);
      const { devices } = await this.readOmniReceiver();
      if (!devices.some((device) => device.productId === productId)) return;
    }

    throw new Error(`The ${OMNI_NAME} still lists device 0x${productId.toString(16)}.`);
  }

  /** The receiver drops off USB and comes back, so this client's device handle ends here. */
  async rebootOmniReceiver(): Promise<void> {
    await this.sendToReceiver(asusOmniRebootRequest());
  }

  private async save(): Promise<void> {
    await this.exchange(asusSaveRequest(), 2);
  }

  private async readSettings(): Promise<AsusSettings> {
    const settings = asusDecodeSettings(this.model, await this.exchange(asusReadSettingsRequest()), this.booster);

    if (this.model.dpiXY) {
      settings.dpiStages = asusDecodeDpiXY(this.model, await this.exchange(asusReadDpiXYRequest()));
    }

    return settings;
  }

  private async readDpiColors(): Promise<AsusRgb[]> {
    return asusDecodeDpiColors(this.model, await this.exchange(asusReadDpiColorsRequest()));
  }

  private async readProfile(): Promise<AsusProfile> {
    return asusDecodeProfile(this.model, await this.exchange(asusReadProfileRequest()));
  }

  private async readLiftOffDistance(): Promise<AsusLiftOffDistance> {
    return asusDecodeLiftOffDistance(await this.exchange(asusReadLiftOffRequest(), 2));
  }

  private async readBattery(): Promise<AsusBattery> {
    return asusDecodeBattery(await this.exchange(asusReadBatteryRequest(), 2));
  }

  private async readLighting(): Promise<MouseLighting[]> {
    const { model } = this;
    const replies: Uint8Array[] = [];

    for (let zone = 0; zone < model.zones.length; zone++) {
      replies.push(
        model.lightingAllZones && zone > 0
          ? replies[0]
          : await this.exchange(asusReadLightingRequest(model, zone), 2),
      );
    }

    return replies.map((reply, zone) => this.lightingStatus(asusDecodeLighting(model, reply, zone), zone));
  }

  private lightingStatus(raw: AsusRawLightingZone, zone: number): MouseLighting {
    const { lightingModes, brightnessMax, zones } = this.model;
    const modes = Object.keys(lightingModes) as AsusLightingEffect[];

    return {
      zone: zones[zone],
      modes,
      mode: modes.find((mode) => lightingModes[mode] === raw.mode) ?? "Static",
      color: `#${hexByte(raw.red)}${hexByte(raw.green)}${hexByte(raw.blue)}`,
      color2: null,
      colorModes: COLOR_MODES.filter((mode) => mode in lightingModes),
      dualColorModes: [],
      reactiveModes: [],
      speeds: [],
      speed: null,
      brightness: Math.max(0, Math.min(100, Math.round((raw.brightness * 100) / brightnessMax))),
      brightnessLevels: BRIGHTNESS_LEVELS,
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const profile = await this.readProfile();
    return this.setDpiStageValue(profile.activeDpiStage, dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const { name } = this.model;

    if (!this.getDpiOptions().includes(dpi)) {
      throw new Error(`${dpi} DPI is not supported by the ${name}.`);
    }

    const color = this.model.dpiColors ? (await this.readDpiColors())[stage] : undefined;

    await this.exchange(asusSetDpiRequest(this.model, stage, dpi, color));
    await this.save();

    const stored = (await this.readSettings()).dpiStages[stage];
    if (stored !== dpi) {
      throw new Error(`${name} kept ${stored} DPI instead of ${dpi} DPI.`);
    }

    return stored;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    await this.exchange(asusSetActiveDpiStageRequest(this.model, stage));
    await this.save();

    if ((await this.readProfile()).activeDpiStage !== stage) {
      throw new Error(`${this.model.name} did not switch to DPI stage ${stage + 1}.`);
    }

    return stage;
  }

  async setPollingRate(rate: number): Promise<number> {
    if (!this.getSupportedPollingRates().includes(rate)) {
      throw new Error(`${rate} Hz is not supported by the ${this.model.name} on this connection.`);
    }

    await this.exchange(asusSetPollingRateRequest(this.model, rate));
    await this.save();

    const confirmed = (await this.readSettings()).pollingRateHz;
    if (confirmed !== rate) {
      throw new Error(`${this.model.name} kept ${confirmed} Hz instead of ${rate} Hz.`);
    }

    return rate;
  }

  async setProfile(profile: number): Promise<number> {
    await this.exchange(asusSetProfileRequest(this.model, profile));
    await this.save();

    if ((await this.readProfile()).onboardProfile !== profile) {
      throw new Error(`${this.model.name} did not switch to profile ${profile}.`);
    }

    return profile;
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    await this.exchange(asusSetAngleSnappingRequest(this.model, enabled));
    await this.save();

    if ((await this.readSettings()).angleSnapping !== enabled) {
      throw new Error(`${this.model.name} did not retain the angle-snapping setting.`);
    }

    return enabled;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!this.model.debounce) {
      throw new Error(`The ${this.model.name} has no debounce setting.`);
    }

    const normalized = ASUS_DEBOUNCE_MS.reduce<number>(
      (best, value) => (Math.abs(value - milliseconds) < Math.abs(best - milliseconds) ? value : best),
      ASUS_DEBOUNCE_MS[0],
    );

    await this.exchange(asusSetDebounceRequest(this.model, normalized));
    await this.save();

    const confirmed = (await this.readSettings()).debounceMs;
    if (confirmed !== normalized) {
      throw new Error(`${this.model.name} kept ${confirmed} ms debounce instead of ${normalized} ms.`);
    }

    return normalized;
  }

  async setLiftOffDistance(value: "Low" | "Medium" | "High"): Promise<AsusLiftOffDistance> {
    const { name } = this.model;

    if (!this.model.liftOff) {
      throw new Error(`The ${name} has no lift-off setting.`);
    }

    if (value !== "Low" && value !== "High") {
      throw new Error(`${name} only supports Low or High lift-off distance.`);
    }

    await this.exchange(asusSetLiftOffRequest(value), 2);
    await this.save();

    const confirmed = await this.readLiftOffDistance();
    if (confirmed !== value) {
      throw new Error(`${name} kept ${confirmed} lift-off instead of ${value}.`);
    }

    return confirmed;
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    const { model } = this;
    const zone = model.zones.indexOf(lighting.zone);

    if (zone < 0) {
      throw new Error(`Unknown ${model.name} lighting zone: ${lighting.zone}`);
    }

    if (!lighting.mode) {
      throw new Error("Choose an RGB effect first.");
    }

    const rawMode = model.lightingModes[lighting.mode as AsusLightingEffect];
    if (rawMode === undefined) {
      throw new Error(`Unsupported ${model.name} lighting mode: ${lighting.mode}`);
    }

    let [red, green, blue] = parseHexColor(lighting.color);

    const brightness = Math.max(
      0,
      Math.min(model.brightnessMax, Math.round(((lighting.brightness ?? 100) * model.brightnessMax) / 100)),
    );

    // Gladius II Spectrum takes fixed red bytes plus its own speed code (0x64 is medium).
    let speed = 0;
    if (lighting.mode === "Spectrum") {
      [red, green, blue] = [0xff, 0x00, 0x00];
      speed = 0x64;
    }

    await this.exchange(asusSetLightingRequest(model, zone, rawMode, brightness, red, green, blue, speed));
    await this.save();

    return (await this.readLighting())[zone];
  }

  /** An Omni receiver with no supported mouse: only the receiver card has anything to show. */
  private receiverOnlyStatus(omni: AsusOmniInfo): MouseStatus {
    return {
      brand: "ASUS",
      name: OMNI_NAME,
      ui: {
        family: "asus",
        settingsReady: false,
        statusNote: `No supported mouse is paired to this ${OMNI_NAME}. Pair one under Advanced.`,
        defaultDisplayName: OMNI_NAME,
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: "Wireless",
      connectionDetail: OMNI_NAME,
      liftOffDistance: null,
      firmware: [`Receiver ${omni.firmware}`],
      asusOmni: omni,
    };
  }

  async readStatus(): Promise<MouseStatus> {
    const omni = this.isOmni ? await this.readOmniReceiver() : undefined;
    if (omni && !this.pairedModel) {
      return this.receiverOnlyStatus(omni);
    }

    const { model } = this;

    const settings = await this.readSettings();
    const profile = await this.readProfile();
    const liftOffDistance = model.liftOff ? await this.readLiftOffDistance() : null;
    const lightingZones = await this.readLighting();
    const battery = model.battery ? await this.readBattery() : null;

    // The battery read answers 0% while the mouse is asleep.
    const batteryPercent = battery && battery.percent > 0 ? battery.percent : null;

    return {
      brand: "ASUS",
      name: model.name,

      ui: {
        family: "asus",
        settingsReady: true,
        valuesVerified: true,
        hideUnsupportedPollingRates: true,
        showAdvancedSection: true,
        hideSignalCard: true,
        hideSleepCard: true,
        hideMotionSync: true,
        hideRippleControl: true,
        dpiStageEditor: {
          maxStages: model.dpiStages,
          countEditable: false,
          minDpi: model.minDpi,
          maxDpi: model.maxDpi,
          stepDpi: model.dpiStep,
        },
        statusNote: model.verified
          ? `${model.name} hardware controls are enabled.`
          : `${model.name} support has not been tested on real hardware yet. Every change is read back from the mouse.`,
        defaultDisplayName: model.name,
      },

      batteryPercent,
      batteryState: battery?.charging ? "Charging" : batteryPercent !== null ? "Discharging" : "Unknown",

      dpi: settings.dpiStages[profile.activeDpiStage],
      dpiStages: settings.dpiStages,
      activeDpiStage: profile.activeDpiStage,

      pollingRateHz: settings.pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),

      activeProfile: profile.onboardProfile,
      profileCount: model.profiles,

      connectionType: model.wireless ? "Wireless" : "Wired",
      connectionDetail: omni ? OMNI_NAME : model.wireless ? "2.4 GHz receiver" : "Wired USB",

      debounceMs: model.debounce ? settings.debounceMs : null,
      angleSnapping: settings.angleSnapping,

      liftOffDistance,
      supportedLiftOffDistances: model.liftOff ? ["Low", "High"] : [],

      lighting: lightingZones[0],
      lightingZones,

      firmware: omni ? [`Receiver ${omni.firmware}`] : [],
      asusOmni: omni,
    };
  }
}
