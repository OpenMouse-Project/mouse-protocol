import type { MouseStatus } from "../mouse-types.ts";
import {
  BYTECH_REPORT_ID,
  BYTECH_USAGE,
  BYTECH_USAGE_PAGE,
  BYTECH_VENDOR_ID,
  bytechBuildBasicInfoQuery,
  bytechBuildDpiStagesQuery,
  bytechBuildSensorQuery,
  bytechBuildSetDpi,
  bytechBuildSetPollingRate,
  bytechBuildSetSensor,
  bytechBuildSetSleep,
  bytechDecodeDpiValue,
  bytechPollingCodeToHz,
  bytechPollingHzToCode,
} from "../../bytech/index.ts";

export class BytechHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus: MouseStatus | null = null;
  private dpiStagesLoaded = false;

  // Cached sensor state for incremental updates
  private cachedLod = 1;
  private cachedDebounce = 2;
  private cachedAngleSnap = false;
  private cachedGlassMode = false;
  private cachedRippleControl = false;
  private cachedMotionSync = true;
  private cachedWorkSpeedMode = 2;
  private cachedDpiStages: number[] = [800, 1600, 2400, 3200, 6400, 26000];
  private cachedActiveStage = 0;
  private cachedStageCount = 6;
  private cachedSleepSeconds = 60;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== BYTECH_VENDOR_ID) return false;
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === BYTECH_USAGE_PAGE
        && collection.usage === BYTECH_USAGE
        && collection.featureReports.some((r) => r.reportId === BYTECH_REPORT_ID))
      || collection.children.some(search);
    return device.collections.some(search);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastStatus = null;
    this.dpiStagesLoaded = false;
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    if (this.device.productId === 0x1015) return "IPI Float 88 (Wired)";
    if (this.device.productId === 0x1014) return "IPI Float 88 (Wireless)";
    return "IPI Float 88";
  }

  deviceBrand(): MouseStatus["brand"] {
    return "IPI";
  }

  isWireless(): boolean {
    return this.device.productId === 0x1014;
  }

  getSupportedPollingRates(): number[] {
    return [125, 250, 500, 1000, 2000, 4000, 8000];
  }

  getDpiOptions(): number[] {
    return [400, 800, 1200, 1600, 2400, 3200, 6400, 12000, 26000, 42000];
  }

  getDebounceMaxMs(): number {
    return 60;
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: 61 }, (_, i) => i);
  }

  getSleepOptions(): number[] {
    return [60, 120, 180, 300, 600, 900, 1800];
  }

  private async exchange(requestPayload: Uint8Array): Promise<Uint8Array> {
    await this.open();
    await this.run(() => this.device.sendFeatureReport(BYTECH_REPORT_ID, requestPayload as BufferSource));
    const expectedEcho = requestPayload[3];
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.delay(attempt === 0 ? 30 : 40);
      const view = await this.run(() => this.device.receiveFeatureReport(BYTECH_REPORT_ID));
      const full = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const payload = full.length > 0 && full[0] === BYTECH_REPORT_ID ? full.subarray(1) : full;
      if (expectedEcho === undefined || (payload.length > 3 && payload[3] === expectedEcho)) {
        return payload;
      }
    }
    const view = await this.run(() => this.device.receiveFeatureReport(BYTECH_REPORT_ID));
    const full = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return full.length > 0 && full[0] === BYTECH_REPORT_ID ? full.subarray(1) : full;
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();

    // 1. Fetch sensor configuration
    const sensorResp = await this.exchange(bytechBuildSensorQuery());
    let pollingRateHz = 1000;
    let lod: "Low" | "Medium" | "High" = "Low";

    if (sensorResp.length > 14) {
      const isWireless = this.isWireless();
      const rateCode = isWireless ? (sensorResp[6]! & 7) : ((sensorResp[6]! & 0x70) >> 4);
      pollingRateHz = bytechPollingCodeToHz(rateCode);

      const activeProfileVal = sensorResp[7] ?? 0;
      // High nibble is the active stage: ((val >> 4) & 0x0f) - 1
      const highNibble = (activeProfileVal >> 4) & 0x0f;
      this.cachedActiveStage = Math.max(0, Math.min(5, highNibble > 0 ? highNibble - 1 : 0));

      // Low nibble is the number of enabled stages (1..6)
      const lowNibble = activeProfileVal & 0x0f;
      if (lowNibble >= 1 && lowNibble <= 6) {
        this.cachedStageCount = lowNibble;
      }

      this.cachedLod = sensorResp[8] ?? 1;
      lod = this.cachedLod === 2 ? "High" : "Low";

      this.cachedDebounce = sensorResp[9] ?? 2;
      const flags = sensorResp[10] ?? 0;
      this.cachedAngleSnap = (flags & 1) === 1;
      this.cachedGlassMode = ((flags & 2) >> 1) === 1;
      this.cachedRippleControl = ((flags & 16) >> 4) === 1;
      this.cachedMotionSync = ((flags & 32) >> 5) === 1;
      this.cachedWorkSpeedMode = (flags & 192) >> 6;
      this.cachedSleepSeconds = (sensorResp.length > 13 && sensorResp[13]! > 0) ? sensorResp[13]! * 30 : 60;
    }

    // 2. Fetch battery & basic info
    let batteryPercent: number | null = null;
    try {
      const basicResp = await this.exchange(bytechBuildBasicInfoQuery());
      if (basicResp.length > 5) {
        const rawBat = basicResp[5]!;
        if (rawBat <= 100) {
          batteryPercent = rawBat;
        } else if (rawBat === 0xe4) {
          batteryPercent = 100;
        }
      }
    } catch {
      // Best-effort
    }

    // 3. Fetch DPI stages on initial connection, then cache to avoid bus collisions
    if (!this.dpiStagesLoaded) {
      try {
        const allChunks: number[] = [];
        for (let step = 0; step < 6; step++) {
          const chunkResp = await this.exchange(bytechBuildDpiStagesQuery(step));
          const startOffset = step === 0 ? 6 : 5;
          for (let i = startOffset; i < Math.min(chunkResp.length, 15); i++) {
            allChunks.push(chunkResp[i]!);
          }
        }
        const decodedStages: number[] = [];
        for (let o = 0; o < 12; o += 2) {
          if (o + 1 < allChunks.length) {
            const val = bytechDecodeDpiValue(allChunks[o]!, allChunks[o + 1]!);
            if (val >= 50 && val <= 42000) {
              decodedStages.push(val);
            }
          }
        }
        if (decodedStages.length >= 6) {
          this.cachedDpiStages = decodedStages.slice(0, 6);
          this.dpiStagesLoaded = true;
        }
      } catch {
        // Keep cached defaults on transient read failure
      }
    }

    const activeDpi = this.cachedDpiStages[this.cachedActiveStage] ?? 800;
    const powerMode = this.cachedWorkSpeedMode === 2 ? "Game" : this.cachedWorkSpeedMode === 1 ? "High Speed" : "Normal";

    return this.lastStatus = {
      brand: "IPI",
      name: this.displayName(),
      ui: {
        family: "bytech",
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
        dpiStageEditor: {
          maxStages: 6,
          countEditable: true,
          minDpi: 50,
          maxDpi: 42000,
          stepDpi: 50,
        },
      },
      batteryPercent,
      batteryState: batteryPercent !== null ? (this.isWireless() ? "Discharging" : "Charging") : "Unknown",
      dpi: activeDpi,
      dpiStages: this.cachedDpiStages.slice(0, this.cachedStageCount),
      activeDpiStage: this.cachedActiveStage,
      pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      liftOffDistance: lod,
      supportedLiftOffDistances: ["Low", "High"],
      angleSnapping: this.cachedAngleSnap,
      motionSync: this.cachedMotionSync,
      rippleControl: this.cachedRippleControl,
      activeProfile: 1,
      powerMode,
      powerModes: ["Game", "High Speed", "Normal"],
      debounceMs: this.cachedDebounce,
      sleepTimeout: this.cachedSleepSeconds,
      firmware: ["v0117"],
    };
  }

  async setPollingRate(hz: number): Promise<number> {
    const code = bytechPollingHzToCode(hz);
    const packet = bytechBuildSetPollingRate(code, this.isWireless());
    await this.exchange(packet);
    await this.delay(100);
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, pollingRateHz: hz };
    return hz;
  }

  async setDpi(dpi: number): Promise<number> {
    await this.setDpiStageValue(this.cachedActiveStage, dpi);
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    if (stage < 0 || stage >= this.cachedStageCount) throw new RangeError(`DPI stage ${stage} out of range`);
    this.cachedActiveStage = stage;
    const dpi = this.cachedDpiStages[stage] ?? 800;
    const packet = bytechBuildSetDpi(stage, dpi, this.cachedStageCount);
    await this.exchange(packet);
    if (this.lastStatus) {
      this.lastStatus = {
        ...this.lastStatus,
        activeDpiStage: stage,
        dpi,
      };
    }
    return stage;
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (stage < 0 || stage >= 6) throw new RangeError(`DPI stage ${stage} out of range`);
    this.cachedDpiStages[stage] = dpi;
    const packet = bytechBuildSetDpi(this.cachedActiveStage, this.cachedDpiStages[this.cachedActiveStage] ?? dpi, this.cachedStageCount);
    await this.exchange(packet);
    if (this.lastStatus) {
      this.lastStatus = {
        ...this.lastStatus,
        dpiStages: this.cachedDpiStages.slice(0, this.cachedStageCount),
        dpi: this.cachedDpiStages[this.cachedActiveStage] ?? dpi,
      };
    }
    return dpi;
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > 6) {
      throw new RangeError("This mouse holds between 1 and 6 DPI stages.");
    }
    this.cachedStageCount = count;
    if (this.cachedActiveStage >= count) {
      this.cachedActiveStage = count - 1;
    }
    const dpi = this.cachedDpiStages[this.cachedActiveStage] ?? 800;
    const packet = bytechBuildSetDpi(this.cachedActiveStage, dpi, count);
    await this.exchange(packet);
    if (this.lastStatus) {
      this.lastStatus = {
        ...this.lastStatus,
        activeDpiStage: this.cachedActiveStage,
        dpi,
        dpiStages: this.cachedDpiStages.slice(0, count),
      };
    }
    return count;
  }

  async setLiftOffDistance(lod: "Low" | "Medium" | "High"): Promise<"Low" | "Medium" | "High"> {
    if (lod === "Medium") {
      throw new RangeError("This mouse only supports Low (1 mm) and High (2 mm) lift-off distances.");
    }
    this.cachedLod = lod === "High" ? 2 : 1;
    await this.syncSensorOptions();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, liftOffDistance: lod };
    return lod;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    this.cachedMotionSync = enabled;
    await this.syncSensorOptions();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, motionSync: enabled };
    return enabled;
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    this.cachedAngleSnap = enabled;
    await this.syncSensorOptions();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, angleSnapping: enabled };
    return enabled;
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    this.cachedRippleControl = enabled;
    await this.syncSensorOptions();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, rippleControl: enabled };
    return enabled;
  }

  async setDebounceTime(ms: number): Promise<number> {
    this.cachedDebounce = Math.max(0, Math.min(60, ms));
    await this.syncSensorOptions();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, debounceMs: this.cachedDebounce };
    return this.cachedDebounce;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    const units = Math.max(1, Math.round(seconds / 30));
    this.cachedSleepSeconds = units * 30;
    const packet = bytechBuildSetSleep(units);
    await this.exchange(packet);
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, sleepTimeout: this.cachedSleepSeconds };
    return this.cachedSleepSeconds;
  }

  async setPowerMode(mode: string): Promise<string> {
    const code = mode === "Game" ? 2 : mode === "High Speed" ? 1 : 0;
    this.cachedWorkSpeedMode = code;
    await this.syncSensorOptions();
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, powerMode: mode };
    return mode;
  }

  private async syncSensorOptions(): Promise<void> {
    const packet = bytechBuildSetSensor({
      lod: this.cachedLod,
      debounce: this.cachedDebounce,
      angleSnap: this.cachedAngleSnap,
      glassMode: this.cachedGlassMode,
      rippleControl: this.cachedRippleControl,
      motionSync: this.cachedMotionSync,
      workSpeedMode: this.cachedWorkSpeedMode,
    });
    await this.exchange(packet);
  }
}
