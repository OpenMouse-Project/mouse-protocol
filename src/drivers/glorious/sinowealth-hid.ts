import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";
import {
  GLORIOUS_SINOWEALTH_CMD_DEBOUNCE,
  GLORIOUS_SINOWEALTH_CMD_GET_CONFIG,
  GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID,
  GLORIOUS_SINOWEALTH_CONFIG_LONG_REPORT_ID,
  GLORIOUS_SINOWEALTH_CONFIG_REPORT_ID,
  GLORIOUS_SINOWEALTH_DEBOUNCE_MS,
  GLORIOUS_SINOWEALTH_DPI_MIN,
  GLORIOUS_SINOWEALTH_DPI_STEP,
  GLORIOUS_SINOWEALTH_EFFECT_BREATHING,
  GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE,
  GLORIOUS_SINOWEALTH_EFFECT_GLORIOUS,
  GLORIOUS_SINOWEALTH_EFFECT_OFF,
  GLORIOUS_SINOWEALTH_EFFECT_STATIC,
  GLORIOUS_SINOWEALTH_EFFECT_WAVE,
  GLORIOUS_SINOWEALTH_MAX_SPEED,
  GLORIOUS_SINOWEALTH_POLLING_RATES,
  GLORIOUS_SINOWEALTH_REPORT_LENGTH,
  GLORIOUS_SINOWEALTH_USAGE_PAGE,
  gloriousSinowealthCheckCommandReply,
  gloriousSinowealthCheckConfig,
  gloriousSinowealthConfigSize,
  gloriousSinowealthDecodeConfig,
  gloriousSinowealthDecodeDebounce,
  gloriousSinowealthDpiOptions,
  gloriousSinowealthEncodeCommand,
  gloriousSinowealthEncodeConfigWrite,
  gloriousSinowealthEncodeDebounce,
  gloriousSinowealthProduct,
  gloriousSinowealthSupportsEffect,
  gloriousSinowealthWithActiveStage,
  gloriousSinowealthWithLighting,
  gloriousSinowealthWithPollingRate,
  gloriousSinowealthWithStageDpi,
  type GloriousSinowealthConfig,
  type GloriousSinowealthEffect,
  type GloriousSinowealthLightingChange,
  type GloriousSinowealthProduct,
  type GloriousSinowealthRgb,
} from "../../glorious-sinowealth/index.ts";

/** libratbag and OpenRGB both wait for the mouse to answer a command before reading it. */
const COMMAND_DELAY_MS = 60;
const READ_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 150;
/**
 * OpenRGB: reading the block right after a write returns zeros from offset
 * 0x2C onward, so the read-back waits.
 */
const WRITE_SETTLE_MS = 300;
/** Bytes before this offset are the report header and its echo, not settings. */
const SETTINGS_START = 9;

const MODE_OFF: MouseLightingMode = "Off";
const MODE_STATIC: MouseLightingMode = "Static";
const MODE_CYCLING: MouseLightingMode = "Cycling";
const MODE_BREATHING_RANDOM: MouseLightingMode = "Breathing random";
const MODE_WAVE: MouseLightingMode = "Wave";
const MODE_BREATHING_SINGLE: MouseLightingMode = "Breathing single";
const EFFECT_FOR_MODE: ReadonlyArray<readonly [MouseLightingMode, GloriousSinowealthEffect]> = [
  [MODE_OFF, GLORIOUS_SINOWEALTH_EFFECT_OFF],
  [MODE_STATIC, GLORIOUS_SINOWEALTH_EFFECT_STATIC],
  [MODE_CYCLING, GLORIOUS_SINOWEALTH_EFFECT_GLORIOUS],
  [MODE_BREATHING_RANDOM, GLORIOUS_SINOWEALTH_EFFECT_BREATHING],
  [MODE_WAVE, GLORIOUS_SINOWEALTH_EFFECT_WAVE],
  [MODE_BREATHING_SINGLE, GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE],
];
const BRIGHTNESS_PERCENT = [25, 50, 75, 100] as const;
const SPEEDS = [1, 2, 3] as const;
/** Shown, and written, when a stored brightness or speed is 0 so a chosen effect is never dark or frozen. */
const DEFAULT_BRIGHTNESS = 50;
const DEFAULT_SPEED = 2;

function collectReports(collections: readonly HIDCollectionInfo[], found = new Map<number, number | null>()): Map<number, number | null> {
  for (const collection of collections) {
    if (collection.usagePage === GLORIOUS_SINOWEALTH_USAGE_PAGE) {
      for (const report of collection.featureReports ?? []) {
        const bits = (report.items ?? []).reduce((sum, item) => sum + (item.reportSize ?? 0) * (item.reportCount ?? 0), 0);
        found.set(report.reportId, bits > 0 ? Math.ceil(bits / 8) + 1 : null);
      }
    }
    collectReports(collection.children ?? [], found);
  }
  return found;
}

function toHexColor({ r, g, b }: GloriousSinowealthRgb): string {
  return `#${[r, g, b].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseColor(color: string): GloriousSinowealthRgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Glorious colour "${color}" is not #rrggbb.`);
  return { r: parseInt(match[1]!, 16), g: parseInt(match[2]!, 16), b: parseInt(match[3]!, 16) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Original wired Glorious Model O / O- (`258a:0036`), Model D / D- (`258a:0033`)
 * and Model O Eternal (`3794:a000`), over the SinoWealth protocol described in
 * `@openmouse/protocol/glorious-sinowealth`.
 *
 * Settings are read from the mouse, changed in a copy, written back whole and
 * read back to confirm. Not exercised on hardware yet: the status says so.
 *
 * The debounce answer arrives on the short command report, which the firmware
 * may STALL when a browser asks for the interface's largest report; it is read
 * once and, when it cannot be read, debounce is left off rather than guessed.
 */
export class GloriousSinowealthHidClient {
  readonly pollIntervalMs = 0;
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  /** Whether report-5 answers can be read here: null until the first try. */
  private shortAnswers: boolean | null = null;
  private dpiOptions: number[] = [];
  private readonly configReportId: number;
  /** Declared byte length (report id included) of the settings report, when the descriptor says. */
  private readonly declaredLength: number | null;

  constructor(device: HIDDevice) {
    this.device = device;
    const reports = collectReports(device.collections);
    this.configReportId = reports.has(GLORIOUS_SINOWEALTH_CONFIG_REPORT_ID)
      ? GLORIOUS_SINOWEALTH_CONFIG_REPORT_ID
      : GLORIOUS_SINOWEALTH_CONFIG_LONG_REPORT_ID;
    this.declaredLength = reports.get(this.configReportId) ?? null;
  }

  static isSupported(device: HIDDevice): boolean {
    if (!gloriousSinowealthProduct(device.vendorId, device.productId)) return false;
    const reports = collectReports(device.collections);
    return reports.has(GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID)
      && (reports.has(GLORIOUS_SINOWEALTH_CONFIG_REPORT_ID) || reports.has(GLORIOUS_SINOWEALTH_CONFIG_LONG_REPORT_ID));
  }

  get supportedPollingRates(): number[] {
    return [...GLORIOUS_SINOWEALTH_POLLING_RATES];
  }

  getSupportedPollingRates(): number[] {
    return this.supportedPollingRates;
  }

  /** The sensor's DPI choices, known once a status has been read; empty before that. */
  getDpiOptions(): number[] {
    return [...this.dpiOptions];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /**
   * Reads everything the mouse reports. A device that cannot be opened still
   * fails, but a settings read that fails gives an identity-only status with
   * controls off, so the connection stays up and the next refresh can retry.
   */
  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      try {
        return await this.readFullStatus();
      } catch (error) {
        return this.unavailableStatus(error);
      }
    });
  }

  private async readFullStatus(): Promise<MouseStatus> {
    const block = await this.readConfig();
    const config = gloriousSinowealthDecodeConfig(block);
    const debounceMs = await this.readDebounce();
    const product = this.product();
    const name = `Glorious ${product.name}`;
    const stages = config.stages.map((stage) => stage.dpi ?? 0);
    const options = gloriousSinowealthDpiOptions(block);
    this.dpiOptions = options;
    return {
      brand: "Glorious",
      name,
      ui: {
        family: "glorious-sinowealth",
        settingsReady: config.sensorName !== null,
        valuesVerified: true,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        hideSleepCard: true,
        hideSignalCard: true,
        ...(debounceMs !== null ? { showAdvancedSection: true } : {}),
        dpiStageEditor: {
          maxStages: stages.length,
          countEditable: false,
          minDpi: options[0] ?? GLORIOUS_SINOWEALTH_DPI_MIN,
          maxDpi: options[options.length - 1] ?? GLORIOUS_SINOWEALTH_DPI_MIN,
          stepDpi: GLORIOUS_SINOWEALTH_DPI_STEP,
        },
        defaultDisplayName: name,
        statusNote: config.sensorName === null
          ? `This mouse reports an unknown sensor (0x${config.sensor.toString(16)}), so DPI is left alone.`
          : "Experimental: this mouse's protocol is documented by libratbag and OpenRGB but has not been confirmed on hardware here yet. Please report whether changes stick.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: stages[config.activeStage] ?? stages[0] ?? 0,
      dpiStages: stages,
      activeDpiStage: Math.max(0, Math.min(config.activeStage, stages.length - 1)),
      pollingRateHz: config.pollingHz ?? 0,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      lighting: this.lighting(block, config),
      ...(debounceMs !== null ? { debounceMs } : {}),
      connectionType: "Wired",
      connectionDetail: "USB cable",
      liftOffDistance: null,
      firmware: [],
    };
  }

  /** Sets the `stage`-th enabled DPI stage (0-based) and returns the DPI written. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const rounded = Math.round(dpi / GLORIOUS_SINOWEALTH_DPI_STEP) * GLORIOUS_SINOWEALTH_DPI_STEP;
    await this.writeConfig((block) => gloriousSinowealthWithStageDpi(block, stage, rounded));
    return rounded;
  }

  /** Selects the active DPI stage (0-based among the enabled ones). */
  async setActiveDpiStage(stage: number): Promise<number> {
    await this.writeConfig((block) => gloriousSinowealthWithActiveStage(block, stage));
    return stage;
  }

  async setPollingRate(hz: number): Promise<number> {
    await this.writeConfig((block) => gloriousSinowealthWithPollingRate(block, hz));
    return hz;
  }

  /**
   * Selects an effect with the brightness, speed and colour requested for it,
   * as the panel shows them before Apply. A value left unset keeps what that
   * effect has stored, except a stored brightness or speed of 0, which would
   * leave the chosen effect dark or frozen.
   */
  async setLighting(lighting: MouseLighting): Promise<void> {
    const effect = EFFECT_FOR_MODE.find(([mode]) => mode === lighting.mode)?.[1];
    if (effect === undefined) throw new Error(`The Glorious ${this.product().name} has no "${lighting.mode}" lighting effect.`);
    if (lighting.speed != null && !SPEEDS.includes(lighting.speed as 1)) {
      throw new Error(`Glorious lighting speed ${lighting.speed} is outside 1-${GLORIOUS_SINOWEALTH_MAX_SPEED}.`);
    }
    if (lighting.brightness != null && !BRIGHTNESS_PERCENT.includes(lighting.brightness as 25)) {
      throw new Error(`Glorious brightness ${lighting.brightness}% is not one of ${BRIGHTNESS_PERCENT.join(", ")}.`);
    }
    const color = lighting.color == null ? null : parseColor(lighting.color);
    await this.writeConfig((block) => {
      const config = gloriousSinowealthDecodeConfig(block);
      const change: GloriousSinowealthLightingChange = { effect };
      if (effect !== GLORIOUS_SINOWEALTH_EFFECT_OFF) {
        const stored = this.storedParams(config, effect);
        if (lighting.brightness != null) {
          change.brightness = BRIGHTNESS_PERCENT.indexOf(lighting.brightness as 25) + 1;
        } else if ((stored?.brightness ?? 0) === 0) {
          change.brightness = BRIGHTNESS_PERCENT.indexOf(DEFAULT_BRIGHTNESS) + 1;
        }
        if (effect !== GLORIOUS_SINOWEALTH_EFFECT_STATIC) {
          if (lighting.speed != null) change.speed = lighting.speed;
          else if ((stored?.speed ?? 0) === 0) change.speed = DEFAULT_SPEED;
        }
        if (color && (effect === GLORIOUS_SINOWEALTH_EFFECT_STATIC || effect === GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE)) {
          change.color = color;
        }
      }
      return gloriousSinowealthWithLighting(block, change);
    });
  }

  /** Sets the debounce time in milliseconds; refused when the mouse's current value cannot be read. */
  async setDebounceTime(milliseconds: number): Promise<number> {
    const frame = gloriousSinowealthEncodeDebounce(milliseconds);
    await this.run(async () => {
      await this.open();
      if (await this.readDebounce() === null) {
        throw new Error("This mouse's debounce cannot be read from here, so it is left alone.");
      }
      await this.device.sendFeatureReport(GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID, frame.slice(1).buffer as ArrayBuffer);
      await sleep(COMMAND_DELAY_MS);
      const back = await this.readDebounce();
      if (back !== milliseconds) throw new Error("The Glorious mouse did not keep the new debounce time (read-back differs).");
    });
    return milliseconds;
  }

  getDebounceOptions(): number[] {
    return [...GLORIOUS_SINOWEALTH_DEBOUNCE_MS];
  }

  private storedParams(config: GloriousSinowealthConfig, effect: GloriousSinowealthEffect) {
    return effect === GLORIOUS_SINOWEALTH_EFFECT_GLORIOUS ? config.glorious
      : effect === GLORIOUS_SINOWEALTH_EFFECT_STATIC ? config.static
        : effect === GLORIOUS_SINOWEALTH_EFFECT_BREATHING ? config.breathing
          : effect === GLORIOUS_SINOWEALTH_EFFECT_WAVE ? config.wave
            : config.breathingSingle;
  }

  private lighting(block: Uint8Array, config: GloriousSinowealthConfig): MouseLighting | undefined {
    // A block padded to the interface's largest report is checked at its true size.
    const size = gloriousSinowealthConfigSize(block.length, this.declaredLength);
    const settings = size === null ? block : block.subarray(0, size);
    const available = EFFECT_FOR_MODE.filter(([, effect]) => gloriousSinowealthSupportsEffect(settings, effect));
    // Mice without LEDs report effect 0xff, and no effect is available.
    if (available.length <= 1) return undefined;
    const current = EFFECT_FOR_MODE.find(([, effect]) => effect === config.effect);
    const stored = current && current[1] !== GLORIOUS_SINOWEALTH_EFFECT_OFF ? this.storedParams(config, current[1]) : null;
    const color = config.effect === GLORIOUS_SINOWEALTH_EFFECT_BREATHING_SINGLE ? config.breathingSingleColor : config.staticColor;
    return {
      zone: "Mouse",
      modes: available.map(([mode]) => mode),
      mode: current?.[0] ?? null,
      color: color ? toHexColor(color) : null,
      color2: null,
      colorModes: [MODE_STATIC, MODE_BREATHING_SINGLE],
      dualColorModes: [],
      reactiveModes: [MODE_CYCLING, MODE_BREATHING_RANDOM, MODE_WAVE, MODE_BREATHING_SINGLE],
      speeds: SPEEDS,
      speed: stored && stored.speed >= 1 && stored.speed <= GLORIOUS_SINOWEALTH_MAX_SPEED ? stored.speed : DEFAULT_SPEED,
      brightness: BRIGHTNESS_PERCENT[(stored?.brightness ?? 0) - 1] ?? DEFAULT_BRIGHTNESS,
      brightnessLevels: [...BRIGHTNESS_PERCENT],
    };
  }

  private product(): GloriousSinowealthProduct {
    return gloriousSinowealthProduct(this.device.vendorId, this.device.productId)!;
  }

  private unavailableStatus(error: unknown): MouseStatus {
    const name = `Glorious ${this.product().name}`;
    return {
      brand: "Glorious",
      name,
      ui: {
        family: "glorious-sinowealth",
        settingsReady: false,
        valuesVerified: false,
        hideProcessingCard: true,
        defaultDisplayName: name,
        statusNote: `The ${name}'s settings could not be read (${error instanceof Error ? error.message : String(error)}); OpenMouse keeps trying.`,
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: "Wired",
      liftOffDistance: null,
      firmware: [],
    };
  }

  /**
   * Reads, changes and writes the settings block, then reads it back and
   * compares everything after the header. Refused when the block's true size
   * cannot be established, since byte [3] of the write carries it.
   */
  private async writeConfig(change: (block: Uint8Array) => Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      const block = await this.readConfig();
      const size = gloriousSinowealthConfigSize(block.length, this.declaredLength);
      if (size === null) {
        throw new Error(`The Glorious mouse's settings block size is unclear (${block.length} bytes read); not writing.`);
      }
      const next = change(block.subarray(0, size));
      const frameLength = Math.max(size, this.declaredLength ?? GLORIOUS_SINOWEALTH_REPORT_LENGTH);
      const frame = gloriousSinowealthEncodeConfigWrite(next, size, frameLength);
      await this.device.sendFeatureReport(this.configReportId, frame.slice(1).buffer as ArrayBuffer);
      await sleep(WRITE_SETTLE_MS);
      const back = (await this.readConfig()).subarray(SETTINGS_START, size);
      const sent = next.subarray(SETTINGS_START, size);
      if (back.length !== sent.length || back.some((byte, index) => byte !== sent[index])) {
        throw new Error("The Glorious mouse did not keep the new settings (read-back differs).");
      }
    });
  }

  private async readConfig(): Promise<Uint8Array> {
    let failure: unknown = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(READ_RETRY_DELAY_MS);
      try {
        await this.device.sendFeatureReport(
          GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID,
          gloriousSinowealthEncodeCommand(GLORIOUS_SINOWEALTH_CMD_GET_CONFIG).slice(1).buffer as ArrayBuffer,
        );
        await sleep(COMMAND_DELAY_MS);
        const block = await this.receive(this.configReportId);
        gloriousSinowealthCheckConfig(block);
        return block;
      } catch (error) {
        failure = error;
      }
    }
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`The Glorious mouse did not answer its settings request (${reason}).`);
  }

  /** The debounce time, tried once: null when the answer cannot be read here. */
  private async readDebounce(): Promise<number | null> {
    if (this.shortAnswers === false) return null;
    try {
      await this.device.sendFeatureReport(
        GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID,
        gloriousSinowealthEncodeCommand(GLORIOUS_SINOWEALTH_CMD_DEBOUNCE).slice(1).buffer as ArrayBuffer,
      );
      await sleep(COMMAND_DELAY_MS);
      const reply = await this.receive(GLORIOUS_SINOWEALTH_COMMAND_REPORT_ID);
      gloriousSinowealthCheckCommandReply(reply, GLORIOUS_SINOWEALTH_CMD_DEBOUNCE);
      const milliseconds = gloriousSinowealthDecodeDebounce(reply);
      this.shortAnswers = true;
      return milliseconds;
    } catch {
      if (this.shortAnswers === null) this.shortAnswers = false;
      return null;
    }
  }

  /** WebHID keeps or strips the report id depending on platform; normalise to "id first". */
  private async receive(reportId: number): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(reportId);
    const bytes = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    if (bytes[0] === reportId) return bytes;
    const out = new Uint8Array(bytes.length + 1);
    out[0] = reportId;
    out.set(bytes, 1);
    return out;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
