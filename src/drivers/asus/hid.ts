import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";

import {
  ASUS_DEBOUNCE_MS,
  ASUS_MICE,
  ASUS_POLLING_RATES,
  ASUS_REPORT_ID,
  ASUS_REPORT_SIZE,
  ASUS_USAGE,
  ASUS_USAGE_PAGE,
  ASUS_VENDOR_ID,
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
  type AsusProfile,
  type AsusRawLightingZone,
  type AsusRgb,
  type AsusSettings,
} from "../../asus/index.js";

const RESPONSE_TIMEOUT_MS = 1000;

const COLOR_MODES: readonly MouseLightingMode[] = ["Static", "Breathing single", "Reactive", "Wave"];

const BRIGHTNESS_LEVELS = [0, 25, 50, 75, 100] as const;

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some(
    (collection) =>
      (collection.usagePage === ASUS_USAGE_PAGE &&
        collection.usage === ASUS_USAGE &&
        collection.inputReports.some((report) => report.reportId === ASUS_REPORT_ID) &&
        collection.outputReports.some((report) => report.reportId === ASUS_REPORT_ID)) ||
      hasConfigCollection(collection.children),
  );
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

  readonly model: AsusMouseModel;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    const model = ASUS_MICE.get(device.productId);
    if (!model) {
      throw new Error(`ASUS product 0x${device.productId.toString(16)} is not supported.`);
    }

    this.device = device;
    this.model = model;
  }

  static isSupported(device: HIDDevice): boolean {
    return (
      device.vendorId === ASUS_VENDOR_ID && ASUS_MICE.has(device.productId) && hasConfigCollection(device.collections)
    );
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
    return [...ASUS_POLLING_RATES];
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return started;
  }

  /** Sends `request` and resolves with the first reply echoing its first `matchLength` bytes. */
  private async exchange(request: Uint8Array, matchLength = 3): Promise<Uint8Array> {
    return this.run(async () => {
      await this.open();

      return new Promise<Uint8Array>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
        };

        const listener = (event: HIDInputReportEvent): void => {
          if (event.reportId !== ASUS_REPORT_ID) return;

          const data = copyDataView(event.data);
          if (data.length < ASUS_REPORT_SIZE) return;

          // `FF AA` is the firmware's reply while asleep, out of range, or refusing a request.
          if (data[0] === 0xff && data[1] === 0xaa) {
            cleanup();
            reject(new Error(`${this.model.name} is asleep or refused the request.`));
            return;
          }

          for (let i = 0; i < matchLength; i++) {
            if (data[i] !== request[i]) return;
          }

          cleanup();
          resolve(data.subarray(0, ASUS_REPORT_SIZE));
        };

        const timer = setTimeout(() => {
          this.device.removeEventListener("inputreport", listener);
          reject(new Error(`${this.model.name} did not answer the HID request.`));
        }, RESPONSE_TIMEOUT_MS);

        this.device.addEventListener("inputreport", listener);

        const payload = new ArrayBuffer(request.byteLength);
        new Uint8Array(payload).set(request);

        this.device.sendReport(ASUS_REPORT_ID, payload).catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
    });
  }

  private async save(): Promise<void> {
    await this.exchange(asusSaveRequest(), 2);
  }

  private async readSettings(): Promise<AsusSettings> {
    const settings = asusDecodeSettings(this.model, await this.exchange(asusReadSettingsRequest()));

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

  async readStatus(): Promise<MouseStatus> {
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
      connectionDetail: model.wireless ? "2.4 GHz receiver" : "Wired USB",

      debounceMs: model.debounce ? settings.debounceMs : null,
      angleSnapping: settings.angleSnapping,

      liftOffDistance,
      supportedLiftOffDistances: model.liftOff ? ["Low", "High"] : [],

      lighting: lightingZones[0],
      lightingZones,

      firmware: [],
    };
  }
}
