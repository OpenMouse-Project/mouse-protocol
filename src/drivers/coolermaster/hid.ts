import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.ts";
import {
  COOLERMASTER_BREATHING_SPEED_MAP,
  COOLERMASTER_CMD_HANDSHAKE_1,
  COOLERMASTER_CMD_HANDSHAKE_2,
  COOLERMASTER_COLOR_CYCLE_SPEED_MAP,
  COOLERMASTER_DPI_MAX,
  COOLERMASTER_DPI_MIN,
  COOLERMASTER_DPI_OPTIONS,
  COOLERMASTER_DPI_STAGE_COUNT,
  COOLERMASTER_DPI_STEP,
  COOLERMASTER_LIGHTING_MODE_BREATH,
  COOLERMASTER_LIGHTING_MODE_COLOR_CYCLE,
  COOLERMASTER_LIGHTING_MODE_CUSTOM,
  COOLERMASTER_LIGHTING_MODE_OFF,
  COOLERMASTER_LIGHTING_MODE_STATIC,
  COOLERMASTER_POLLING_RATES,
  COOLERMASTER_PRODUCT_IDS,
  COOLERMASTER_PRODUCT_NAMES,
  COOLERMASTER_REPORT_ID,
  COOLERMASTER_USAGE,
  COOLERMASTER_USAGE_PAGE,
  COOLERMASTER_VENDOR_ID,
  coolermasterDecodeBreathingSpeed,
  coolermasterDecodeColorCycleSpeed,
  coolermasterDecodeCustomEffect,
  coolermasterDecodeDebounce,
  coolermasterDecodeEffectMode,
  coolermasterDecodeGeneralEffect,
  coolermasterDecodePerformance,
  coolermasterDecodePollingRate,
  coolermasterEncodeGetCustomEffect,
  coolermasterEncodeGetDebounce,
  coolermasterEncodeGetEffectMode,
  coolermasterEncodeGetGeneralEffect,
  coolermasterEncodeGetPerformance,
  coolermasterEncodeGetPollingRate,
  coolermasterEncodeHandshake,
  coolermasterEncodeSetCustomEffect,
  coolermasterEncodeSetDebounce,
  coolermasterEncodeSetEffectMode,
  coolermasterEncodeSetGeneralEffect,
  coolermasterEncodeSetPerformance,
  coolermasterEncodeSetPollingRate,
  coolermasterParseHexColor,
  coolermasterToHexColor,
  type CoolerMasterCustomEffect,
  type CoolerMasterGeneralEffect,
  type CoolerMasterPerformance,
} from "@openmouse/protocol/coolermaster";

const MM711_LIGHTING_MODES: readonly MouseLightingMode[] = [
  "Static",
  "Breathing single",
  "Breathing random",
  "Cycling",
  "Off",
];

const MM711_COLOR_MODES: readonly MouseLightingMode[] = ["Static", "Breathing single"];
const MM711_SPEED_MODES: readonly MouseLightingMode[] = ["Breathing single", "Breathing random", "Cycling"];
const MM711_SPEEDS: readonly number[] = [1, 2, 3, 4, 5];
const MM711_BRIGHTNESS_LEVELS: readonly number[] = [0, 25, 50, 75, 100];

const RESPONSE_TIMEOUT_MS = 1000;

function hasControlCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === COOLERMASTER_USAGE_PAGE && collection.usage === COOLERMASTER_USAGE)
    || (collection.children && hasControlCollection(collection.children)));
}

function matchesReply(request: Uint8Array, reply: Uint8Array): boolean {
  if (reply.length < 2 || request.length < 2) return false;
  if (request[0] === COOLERMASTER_CMD_HANDSHAKE_1 && request[1] === COOLERMASTER_CMD_HANDSHAKE_2) {
    return reply[0] === COOLERMASTER_CMD_HANDSHAKE_1 && reply[1] === COOLERMASTER_CMD_HANDSHAKE_2;
  }
  return reply[1] === request[1];
}

/**
 * WebHID driver for Cooler Master mice (MM711 and compatible models).
 */
export class CoolerMasterHidClient {
  readonly device: HIDDevice;
  private waiter: {
    request: Uint8Array;
    resolve: (reply: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastPerformance: CoolerMasterPerformance | null = null;
  private lastCustomLighting: CoolerMasterCustomEffect = {
    wheel: { r: 255, g: 0, b: 0 },
    logo: { r: 255, g: 0, b: 0 },
  };

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== COOLERMASTER_REPORT_ID) return;
    let reply = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    if (reply.length === 65 && reply[0] === COOLERMASTER_REPORT_ID) {
      reply = reply.subarray(1);
    }
    const waiter = this.waiter;
    if (!waiter || !matchesReply(waiter.request, reply)) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.resolve(reply);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === COOLERMASTER_VENDOR_ID
      && (COOLERMASTER_PRODUCT_IDS as readonly number[]).includes(device.productId)
      && hasControlCollection(device.collections);
  }

  get pollIntervalMs(): number {
    return 30_000;
  }

  getDpiOptions(): number[] {
    return [...COOLERMASTER_DPI_OPTIONS];
  }

  getSupportedPollingRates(): number[] {
    return [...COOLERMASTER_POLLING_RATES];
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: 29 }, (_, i) => i + 4);
  }

  getDebounceMaxMs(): number {
    return 32;
  }

  async open(): Promise<void> {
    if (!CoolerMasterHidClient.isSupported(this.device)) {
      throw new Error("Cooler Master configuration collection is unavailable.");
    }
    if (!this.device.opened) await this.device.open();
    this.device.removeEventListener("inputreport", this.onInputReport);
    this.device.addEventListener("inputreport", this.onInputReport);
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.onInputReport);
    this.failWaiter(new Error("The Cooler Master device was closed."));
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(_onChange?: () => void): Promise<boolean> {
    return false;
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.serialized(async () => {
      await this.open();
      // Step 1: Handshake
      await this.exchange(coolermasterEncodeHandshake()).catch(() => undefined);

      // Step 2: Read performance block (DPI stages, active stage, LOD, angle snap, angle tune)
      const perfReply = await this.exchange(coolermasterEncodeGetPerformance());
      const perf = coolermasterDecodePerformance(perfReply);
      this.lastPerformance = perf;

      // Step 3: Read polling rate
      const pollingReply = await this.exchange(coolermasterEncodeGetPollingRate());
      const pollingRate = coolermasterDecodePollingRate(pollingReply);

      // Step 4: Read debounce time
      let debounceMs: number | null = null;
      try {
        const debounceReply = await this.exchange(coolermasterEncodeGetDebounce());
        debounceMs = coolermasterDecodeDebounce(debounceReply);
      } catch {
        debounceMs = null;
      }

      // Step 5: Read lighting
      let lighting: MouseLighting | undefined;
      try {
        lighting = await this.readLighting();
      } catch {
        lighting = undefined;
      }

      const name = COOLERMASTER_PRODUCT_NAMES.get(this.device.productId) ?? "Cooler Master MM711";

      return {
        brand: "Cooler Master",
        name,
        ui: {
          family: "cooler master",
          defaultDisplayName: name,
          valuesVerified: true,
          settingsReady: true,
          showAdvancedSection: true,
          singleAxisStages: true,
          hideProcessingCard: false,
          hideRippleControl: true,
          hideMotionSync: true,
          dpiStageEditor: {
            maxStages: COOLERMASTER_DPI_STAGE_COUNT,
            countEditable: true,
            minDpi: COOLERMASTER_DPI_MIN,
            maxDpi: COOLERMASTER_DPI_MAX,
            stepDpi: COOLERMASTER_DPI_STEP,
          },
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: perf.currentDpi,
        dpiY: perf.currentDpiY,
        supportsSeparateDpiAxes: true,
        dpiStages: perf.dpiStages.slice(0, perf.stageCount),
        activeDpiStage: perf.activeDpiStage,
        pollingRateHz: pollingRate,
        supportedPollingRates: [...COOLERMASTER_POLLING_RATES],
        debounceMs,
        liftOffDistance: perf.liftOffDistance,
        supportedLiftOffDistances: ["Low", "High"],
        angleSnapping: perf.angleSnapping,
        angleTuning: perf.angleTuning,
        activeProfile: 1,
        connectionType: "Wired",
        firmware: [],
        lighting,
      };
    });
  }

  async setDpi(dpi: number): Promise<number> {
    if (!Number.isFinite(dpi) || dpi < COOLERMASTER_DPI_MIN || dpi > COOLERMASTER_DPI_MAX) {
      throw new RangeError(
        `Cooler Master DPI must be between ${COOLERMASTER_DPI_MIN} and ${COOLERMASTER_DPI_MAX}.`,
      );
    }
    return await this.serialized(async () => {
      const perf = await this.ensurePerformance();
      const updatedStages = [...perf.dpiStages];
      updatedStages[perf.activeDpiStage] = dpi;
      const writePacket = coolermasterEncodeSetPerformance(
        {
          activeDpiStage: perf.activeDpiStage,
          dpiStages: updatedStages,
          dpiStagesY: updatedStages,
        },
        perf.rawPayload,
      );
      const echo = await this.exchange(writePacket);
      const recheck = coolermasterDecodePerformance(echo);
      this.lastPerformance = recheck;
      return recheck.currentDpi;
    });
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= COOLERMASTER_DPI_STAGE_COUNT) {
      throw new RangeError(
        `Cooler Master active DPI stage must be 0-${COOLERMASTER_DPI_STAGE_COUNT - 1}.`,
      );
    }
    return await this.serialized(async () => {
      const perf = await this.ensurePerformance();
      const writePacket = coolermasterEncodeSetPerformance(
        { activeDpiStage: stage },
        perf.rawPayload,
      );
      const echo = await this.exchange(writePacket);
      const recheck = coolermasterDecodePerformance(echo);
      this.lastPerformance = recheck;
      return recheck.activeDpiStage;
    });
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= COOLERMASTER_DPI_STAGE_COUNT) {
      throw new RangeError(
        `Cooler Master DPI stage must be 0-${COOLERMASTER_DPI_STAGE_COUNT - 1}.`,
      );
    }
    if (!Number.isFinite(dpi) || dpi < COOLERMASTER_DPI_MIN || dpi > COOLERMASTER_DPI_MAX) {
      throw new RangeError(
        `Cooler Master DPI must be between ${COOLERMASTER_DPI_MIN} and ${COOLERMASTER_DPI_MAX}.`,
      );
    }
    return await this.serialized(async () => {
      const perf = await this.ensurePerformance();
      const updatedStages = [...perf.dpiStages];
      updatedStages[stage] = dpi;
      const writePacket = coolermasterEncodeSetPerformance(
        {
          dpiStages: updatedStages,
          dpiStagesY: updatedStages,
        },
        perf.rawPayload,
      );
      const echo = await this.exchange(writePacket);
      const recheck = coolermasterDecodePerformance(echo);
      this.lastPerformance = recheck;
      return recheck.dpiStages[stage]!;
    });
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > COOLERMASTER_DPI_STAGE_COUNT) {
      throw new RangeError(
        `Cooler Master DPI stage count must be between 1 and ${COOLERMASTER_DPI_STAGE_COUNT}.`,
      );
    }
    return await this.serialized(async () => {
      const perf = await this.ensurePerformance();
      const clampedActive = Math.min(perf.activeDpiStage, count - 1);
      const writePacket = coolermasterEncodeSetPerformance(
        { stageCount: count, activeDpiStage: clampedActive },
        perf.rawPayload,
      );
      const echo = await this.exchange(writePacket);
      const recheck = coolermasterDecodePerformance(echo);
      this.lastPerformance = recheck;
      return recheck.stageCount;
    });
  }

  async setPollingRate(hz: number): Promise<number> {
    if (!(COOLERMASTER_POLLING_RATES as readonly number[]).includes(hz)) {
      throw new RangeError(
        `Cooler Master polling rate must be one of: ${COOLERMASTER_POLLING_RATES.join(", ")} Hz.`,
      );
    }
    return await this.serialized(async () => {
      await this.open();
      const writePacket = coolermasterEncodeSetPollingRate(hz);
      const echo = await this.exchange(writePacket);
      return coolermasterDecodePollingRate(echo);
    });
  }

  async setDebounceTime(ms: number): Promise<number> {
    if (!Number.isInteger(ms) || ms < 1 || ms > 32) {
      throw new RangeError("Cooler Master debounce time must be an integer between 1 and 32 ms.");
    }
    return await this.serialized(async () => {
      await this.open();
      const writePacket = coolermasterEncodeSetDebounce(ms);
      const echo = await this.exchange(writePacket);
      return coolermasterDecodeDebounce(echo);
    });
  }

  async setLiftOffDistance(lod: "Low" | "Medium" | "High"): Promise<"Low" | "High"> {
    if (lod !== "Low" && lod !== "High") {
      throw new RangeError("Cooler Master lift-off distance must be 'Low' or 'High'.");
    }
    return await this.serialized(async () => {
      const perf = await this.ensurePerformance();
      const writePacket = coolermasterEncodeSetPerformance(
        { liftOffDistance: lod },
        perf.rawPayload,
      );
      const echo = await this.exchange(writePacket);
      const recheck = coolermasterDecodePerformance(echo);
      this.lastPerformance = recheck;
      return recheck.liftOffDistance;
    });
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return await this.serialized(async () => {
      const perf = await this.ensurePerformance();
      const writePacket = coolermasterEncodeSetPerformance(
        { angleSnapping: enabled },
        perf.rawPayload,
      );
      const echo = await this.exchange(writePacket);
      const recheck = coolermasterDecodePerformance(echo);
      this.lastPerformance = recheck;
      return recheck.angleSnapping;
    });
  }

  async setAngleTuning(degrees: number): Promise<number> {
    if (!Number.isInteger(degrees) || degrees < -30 || degrees > 30) {
      throw new RangeError("Cooler Master angle tuning must be an integer between -30 and +30 degrees.");
    }
    return await this.serialized(async () => {
      const perf = await this.ensurePerformance();
      const writePacket = coolermasterEncodeSetPerformance(
        { angleTuning: degrees },
        perf.rawPayload,
      );
      const echo = await this.exchange(writePacket);
      const recheck = coolermasterDecodePerformance(echo);
      this.lastPerformance = recheck;
      return recheck.angleTuning;
    });
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    if (lighting.zone && lighting.zone !== "Mouse") {
      throw new Error(`Unknown Cooler Master lighting zone: ${lighting.zone}`);
    }
    if (!lighting.mode) {
      throw new Error("Choose an RGB effect first.");
    }
    if (!MM711_LIGHTING_MODES.includes(lighting.mode)) {
      throw new Error(`Unsupported Cooler Master lighting mode: ${lighting.mode}`);
    }

    return await this.serialized(async () => {
      await this.open();

      if (lighting.mode === "Off") {
        await this.exchange(coolermasterEncodeSetEffectMode(COOLERMASTER_LIGHTING_MODE_OFF));
      } else if (lighting.mode === "Cycling") {
        const speedLevel = Math.max(1, Math.min(5, lighting.speed ?? 3));
        const speedCode = COOLERMASTER_COLOR_CYCLE_SPEED_MAP[speedLevel] ?? 40;
        const brightness = Math.max(
          0,
          Math.min(127, Math.round(((lighting.brightness ?? 100) * 127) / 100)),
        );
        await this.exchange(
          coolermasterEncodeSetGeneralEffect({
            modeId: COOLERMASTER_LIGHTING_MODE_COLOR_CYCLE,
            speedCode,
            brightness,
            color: { r: 255, g: 255, b: 255 },
          }),
        );
        await this.exchange(
          coolermasterEncodeSetEffectMode(COOLERMASTER_LIGHTING_MODE_COLOR_CYCLE),
        );
      } else if (
        lighting.mode === "Breathing single" ||
        lighting.mode === "Breathing random"
      ) {
        const isRandom = lighting.mode === "Breathing random";
        const speedLevel = Math.max(1, Math.min(5, lighting.speed ?? 3));
        const speedCode = COOLERMASTER_BREATHING_SPEED_MAP[speedLevel] ?? 49;
        const brightness = Math.max(
          0,
          Math.min(255, Math.round(((lighting.brightness ?? 100) * 255) / 100)),
        );
        const color = isRandom
          ? { r: 255, g: 0, b: 0 }
          : coolermasterParseHexColor(lighting.color);
        await this.exchange(
          coolermasterEncodeSetGeneralEffect({
            modeId: COOLERMASTER_LIGHTING_MODE_BREATH,
            speedCode,
            random: isRandom,
            brightness,
            color,
          }),
        );
        await this.exchange(
          coolermasterEncodeSetEffectMode(COOLERMASTER_LIGHTING_MODE_BREATH),
        );
      } else if (lighting.mode === "Static") {
        const newColor = coolermasterParseHexColor(lighting.color);
        const brightness = Math.max(
          0,
          Math.min(255, Math.round(((lighting.brightness ?? 100) * 255) / 100)),
        );
        this.lastCustomLighting = { wheel: newColor, logo: newColor };
        await this.exchange(
          coolermasterEncodeSetGeneralEffect({
            modeId: COOLERMASTER_LIGHTING_MODE_STATIC,
            brightness,
            color: newColor,
          }),
        );
        await this.exchange(
          coolermasterEncodeSetCustomEffect(newColor, newColor),
        );
        await this.exchange(
          coolermasterEncodeSetEffectMode(COOLERMASTER_LIGHTING_MODE_STATIC),
        );
      }

      return await this.readLighting();
    });
  }

  private async readLighting(): Promise<MouseLighting> {
    let modeId = COOLERMASTER_LIGHTING_MODE_COLOR_CYCLE;
    try {
      const modeReply = await this.exchange(coolermasterEncodeGetEffectMode());
      modeId = coolermasterDecodeEffectMode(modeReply);
    } catch {
      // Keep default
    }

    try {
      const customReply = await this.exchange(coolermasterEncodeGetCustomEffect());
      this.lastCustomLighting = coolermasterDecodeCustomEffect(customReply);
    } catch {
      // Keep cached
    }

    let general: CoolerMasterGeneralEffect = {
      modeId,
      speedCode: 40,
      random: false,
      brightness: 255,
      color: { r: 255, g: 0, b: 0 },
    };

    if (
      modeId === COOLERMASTER_LIGHTING_MODE_STATIC ||
      modeId === COOLERMASTER_LIGHTING_MODE_BREATH ||
      modeId === COOLERMASTER_LIGHTING_MODE_COLOR_CYCLE
    ) {
      try {
        const generalReply = await this.exchange(coolermasterEncodeGetGeneralEffect(modeId));
        general = coolermasterDecodeGeneralEffect(generalReply);
      } catch {
        // Keep fallback
      }
    }

    let activeMode: MouseLightingMode = "Cycling";
    let speed: number | null = null;
    let brightness = 100;

    if (modeId === COOLERMASTER_LIGHTING_MODE_OFF) {
      activeMode = "Off";
      brightness = 0;
    } else if (modeId === COOLERMASTER_LIGHTING_MODE_COLOR_CYCLE) {
      activeMode = "Cycling";
      speed = coolermasterDecodeColorCycleSpeed(general.speedCode);
      brightness = Math.round((general.brightness * 100) / 127);
    } else if (modeId === COOLERMASTER_LIGHTING_MODE_BREATH) {
      activeMode = general.random ? "Breathing random" : "Breathing single";
      speed = coolermasterDecodeBreathingSpeed(general.speedCode);
      brightness = Math.round((general.brightness * 100) / 255);
    } else if (modeId === COOLERMASTER_LIGHTING_MODE_CUSTOM) {
      activeMode = "Static";
      brightness = 100;
    } else if (modeId === COOLERMASTER_LIGHTING_MODE_STATIC) {
      activeMode = "Static";
      brightness = Math.round((general.brightness * 100) / 255);
    }

    let color: string | null = null;
    if (activeMode === "Static") {
      color = modeId === COOLERMASTER_LIGHTING_MODE_CUSTOM
        ? coolermasterToHexColor(this.lastCustomLighting.logo)
        : coolermasterToHexColor(general.color);
    } else if (activeMode === "Breathing single") {
      color = coolermasterToHexColor(general.color);
    }

    return {
      zone: "Mouse",
      modes: MM711_LIGHTING_MODES,
      mode: activeMode,
      color,
      color2: null,
      colorModes: MM711_COLOR_MODES,
      dualColorModes: [],
      reactiveModes: MM711_SPEED_MODES,
      speeds: MM711_SPEEDS,
      speed,
      brightness: Math.max(0, Math.min(100, brightness)),
      brightnessLevels: MM711_BRIGHTNESS_LEVELS,
    };
  }

  private async ensurePerformance(): Promise<CoolerMasterPerformance> {
    await this.open();
    if (this.lastPerformance) return this.lastPerformance;
    const reply = await this.exchange(coolermasterEncodeGetPerformance());
    this.lastPerformance = coolermasterDecodePerformance(reply);
    return this.lastPerformance;
  }

  private async exchange(request: Uint8Array): Promise<Uint8Array> {
    await this.open();
    if (this.waiter) {
      throw new Error("Another Cooler Master request is already in progress.");
    }
    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === resolve) this.waiter = null;
        reject(
          new Error(
            `The Cooler Master mouse did not answer command [0x${request[0]?.toString(16)}, 0x${request[1]?.toString(16)}].`,
          ),
        );
      }, RESPONSE_TIMEOUT_MS);
      this.waiter = { request, resolve, reject, timer };
    });

    try {
      await this.device.sendReport(COOLERMASTER_REPORT_ID, new Uint8Array(request));
    } catch (error) {
      this.failWaiter(error instanceof Error ? error : new Error(String(error)));
    }

    return await response;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private failWaiter(error: Error): void {
    const waiter = this.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.reject(error);
  }
}
