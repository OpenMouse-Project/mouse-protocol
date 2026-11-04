import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.ts";
import {
  REDRAGON_M719_PRO_BRIGHTNESS_PERCENTS,
  REDRAGON_M719_PRO_BUTTONS,
  REDRAGON_M719_PRO_BUTTON_ACTIONS,
  REDRAGON_M719_PRO_COMMAND,
  REDRAGON_M719_PRO_COMMAND_REPORT_ID,
  REDRAGON_M719_PRO_COMMAND_USAGE_PAGE,
  REDRAGON_M719_PRO_DPI_MAX,
  REDRAGON_M719_PRO_DPI_MIN,
  REDRAGON_M719_PRO_DPI_OPTIONS,
  REDRAGON_M719_PRO_DPI_STEP,
  REDRAGON_M719_PRO_EEPROM,
  REDRAGON_M719_PRO_MAX_CHUNK_LENGTH,
  REDRAGON_M719_PRO_MAX_DPI_STAGES,
  REDRAGON_M719_PRO_NOTIFY_REPORT_ID,
  REDRAGON_M719_PRO_NOTIFY_USAGE_PAGE,
  REDRAGON_M719_PRO_POLLING_RATES,
  REDRAGON_M719_PRO_PRODUCTS,
  REDRAGON_M719_PRO_RESPONSE_REPORT_ID,
  REDRAGON_M719_PRO_RGB_EFFECT,
  REDRAGON_M719_PRO_SPEED_LEVELS,
  REDRAGON_M719_PRO_VENDOR_ID,
  REDRAGON_M719_PRO_WIRED_PRODUCT_ID,
  REDRAGON_M719_PRO_WIRELESS_PRODUCT_ID,
  redragonM719ProDecodeBattery,
  redragonM719ProDecodeButtonAction,
  redragonM719ProDecodeConnectStatus,
  redragonM719ProDecodeDpiLedEffect,
  redragonM719ProDecodeDpiStage,
  redragonM719ProDecodeDpiStageColor,
  redragonM719ProDecodeDpiStageColors,
  redragonM719ProDecodeDpiStages,
  redragonM719ProDecodeHardwareNotification,
  redragonM719ProDecodePollingRate,
  redragonM719ProDecodeReadEeprom,
  redragonM719ProDecodeRgbLighting,
  redragonM719ProDecodeWriteEeprom,
  redragonM719ProEncodeButtonAction,
  redragonM719ProEncodeDpiLedEffect,
  redragonM719ProEncodeDpiStage,
  redragonM719ProEncodeDpiStageColor,
  redragonM719ProEncodeGetBattery,
  redragonM719ProEncodeGetConnectStatus,
  redragonM719ProEncodeHandshake,
  redragonM719ProEncodePollingRate,
  redragonM719ProEncodeReadEeprom,
  redragonM719ProEncodeRgbLighting,
  redragonM719ProEncodeTellDriverStatus,
  redragonM719ProEncodeWriteEeprom,
  redragonM719ProNearestDpi,
  redragonM719ProNormalizeReply,
  redragonM719ProPackScalar,
  redragonM719ProUnpackScalar,
  redragonM719ProVerifyHandshakeReply,
  type RedragonM719ProDpiLedMode,
  type RedragonM719ProRgb,
  type RedragonM719ProRgbEffectCode,
} from "@openmouse/protocol/redragon";

const DISPLAY_NAME = "Redragon M719RGB-PRO";
const COMMAND_TIMEOUT_MS = 900;
const WRITE_RETRY_LIMIT = 4;
const WRITE_SETTLE_DELAY_MS = 15;
const OFFLINE_NOTE = "The mouse is off or asleep. Wake it or switch it on to read and change its settings.";

const MAIN_LIGHTING_MODES: readonly MouseLightingMode[] = [
  "Static",
  "Breathing single",
  "Neon",
  "Off",
];
const MAIN_COLOR_MODES: readonly MouseLightingMode[] = ["Static", "Breathing single"];
const MAIN_REACTIVE_MODES: readonly MouseLightingMode[] = ["Breathing single", "Neon"];

const DPI_INDICATOR_MODES: readonly MouseLightingMode[] = [
  "Static",
  "Breathing single",
  "Off",
];

function rgbToHex({ r, g, b }: RedragonM719ProRgb): string {
  return `#${[r, g, b].map((channel) => (channel & 0xff).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(color: string): RedragonM719ProRgb {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (!match) throw new Error(`Expected a #rrggbb colour, got "${color}".`);
  return {
    r: parseInt(match[1]!, 16),
    g: parseInt(match[2]!, 16),
    b: parseInt(match[3]!, 16),
  };
}

function effectToMode(effect: RedragonM719ProRgbEffectCode): MouseLightingMode {
  switch (effect) {
    case REDRAGON_M719_PRO_RGB_EFFECT.steady:
      return "Static";
    case REDRAGON_M719_PRO_RGB_EFFECT.breathing:
      return "Breathing single";
    case REDRAGON_M719_PRO_RGB_EFFECT.neon:
      return "Neon";
    default:
      return "Off";
  }
}

function modeToEffect(mode: MouseLightingMode | null): RedragonM719ProRgbEffectCode {
  switch (mode) {
    case "Static":
      return REDRAGON_M719_PRO_RGB_EFFECT.steady;
    case "Breathing single":
      return REDRAGON_M719_PRO_RGB_EFFECT.breathing;
    case "Neon":
      return REDRAGON_M719_PRO_RGB_EFFECT.neon;
    case "Off":
      return REDRAGON_M719_PRO_RGB_EFFECT.off;
    default:
      throw new Error(`Unsupported Redragon M719RGB-PRO lighting mode: ${String(mode)}.`);
  }
}

function dpiLedCodeToMode(code: RedragonM719ProDpiLedMode): MouseLightingMode {
  if (code === 1) return "Static";
  if (code === 2) return "Breathing single";
  return "Off";
}

function modeToDpiLedCode(mode: MouseLightingMode | null): RedragonM719ProDpiLedMode {
  switch (mode) {
    case "Static":
      return 1;
    case "Breathing single":
      return 2;
    case "Off":
      return 0;
    default:
      throw new Error(`Unsupported Redragon M719RGB-PRO DPI indicator mode: ${String(mode)}.`);
  }
}

function hasFeatureReport(
  collections: readonly HIDCollectionInfo[] | undefined,
  reportId: number,
): boolean {
  for (const collection of collections ?? []) {
    if ((collection.featureReports ?? []).some((report) => report.reportId === reportId)) {
      return true;
    }
    if (hasFeatureReport(collection.children, reportId)) return true;
  }
  return false;
}

function hasInputReport(
  collections: readonly HIDCollectionInfo[] | undefined,
  reportId: number,
): boolean {
  for (const collection of collections ?? []) {
    if ((collection.inputReports ?? []).some((report) => report.reportId === reportId)) {
      return true;
    }
    if (hasInputReport(collection.children, reportId)) return true;
  }
  return false;
}

function hasUsagePage(
  collections: readonly HIDCollectionInfo[] | undefined,
  usagePage: number,
): boolean {
  for (const collection of collections ?? []) {
    if (collection.usagePage === usagePage) return true;
    if (hasUsagePage(collection.children, usagePage)) return true;
  }
  return false;
}

function hasCommandChannel(device: HIDDevice): boolean {
  return hasFeatureReport(device.collections, REDRAGON_M719_PRO_COMMAND_REPORT_ID)
    || hasUsagePage(device.collections, REDRAGON_M719_PRO_COMMAND_USAGE_PAGE);
}

function hasResponseChannel(device: HIDDevice): boolean {
  return hasInputReport(device.collections, REDRAGON_M719_PRO_RESPONSE_REPORT_ID)
    || hasUsagePage(device.collections, REDRAGON_M719_PRO_NOTIFY_USAGE_PAGE);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RedragonM719ProHidClient {
  readonly device: HIDDevice;
  private cmdDevice: HIDDevice | null = null;
  private notifyDevice: HIDDevice | null = null;
  private channelsResolved = false;
  private handshakeCompleted = false;
  private queue: Promise<unknown> = Promise.resolve();
  private notificationListener: (() => void) | null = null;
  private lastRgbSpeed = 5;
  private lastRgbBrightness = 10;
  private lastRgbColor: RedragonM719ProRgb = { r: 0xff, g: 0x00, b: 0x00 };

  private waiter: {
    command: number;
    resolve: (reply: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const raw = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    const payload = redragonM719ProNormalizeReply(raw);

    // Asynchronous hardware push notifications (physical DPI button or Profile Switch button).
    if (
      event.reportId === REDRAGON_M719_PRO_NOTIFY_REPORT_ID
      || (event.reportId === REDRAGON_M719_PRO_RESPONSE_REPORT_ID
        && payload[0] === REDRAGON_M719_PRO_COMMAND.hardwareNotify)
    ) {
      const notification = redragonM719ProDecodeHardwareNotification(raw, event.reportId);
      if (notification) {
        this.notificationListener?.();
      }
      return;
    }

    if (
      event.reportId !== REDRAGON_M719_PRO_RESPONSE_REPORT_ID
      && event.reportId !== REDRAGON_M719_PRO_COMMAND_REPORT_ID
    ) {
      return;
    }

    const waiter = this.waiter;
    if (!waiter || payload[0] !== waiter.command) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.resolve(payload);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== REDRAGON_M719_PRO_VENDOR_ID) return false;
    if (!REDRAGON_M719_PRO_PRODUCTS.has(device.productId)) return false;
    return hasCommandChannel(device) || hasResponseChannel(device);
  }

  static supportScore(device: HIDDevice): number {
    if (!this.isSupported(device)) return 0;
    let score = 2;
    if (hasCommandChannel(device)) score += 12;
    if (hasResponseChannel(device)) score += 8;
    if (device.productId === REDRAGON_M719_PRO_WIRED_PRODUCT_ID) score += 2;
    return score;
  }

  displayName(): string {
    return DISPLAY_NAME;
  }

  deviceBrand(): "Redragon" {
    return "Redragon";
  }

  isWireless(): boolean {
    return this.device.productId === REDRAGON_M719_PRO_WIRELESS_PRODUCT_ID;
  }

  getDpiOptions(): number[] {
    return [...REDRAGON_M719_PRO_DPI_OPTIONS];
  }

  getSupportedPollingRates(): number[] {
    return [...REDRAGON_M719_PRO_POLLING_RATES];
  }

  /**
   * Bind command (`0xff02`, Feature Report 8) and response (`0xff01`, Input Report 9)
   * collections whether the platform exposes them on one `HIDDevice` or across
   * sibling `HIDDevice` entries in `navigator.hid.getDevices()`.
   */
  bindPeers(devices: readonly HIDDevice[]): void {
    const peers = devices.filter(
      (candidate) =>
        candidate.vendorId === this.device.vendorId
        && candidate.productId === this.device.productId,
    );
    const pool = peers.length > 0 ? peers : [this.device];
    const cmd = hasCommandChannel(this.device)
      ? this.device
      : (pool.find((candidate) => hasCommandChannel(candidate)) ?? this.device);
    const notify = hasResponseChannel(this.device)
      ? this.device
      : (pool.find((candidate) => hasResponseChannel(candidate)) ?? cmd);
    this.cmdDevice = cmd;
    this.notifyDevice = notify;
    this.channelsResolved = true;
  }

  async open(): Promise<void> {
    if (!RedragonM719ProHidClient.isSupported(this.device)) {
      throw new Error("The Redragon M719RGB-PRO vendor configuration collection is not present on this HID interface.");
    }
    if (!this.channelsResolved) {
      if (hasCommandChannel(this.device) && hasResponseChannel(this.device)) {
        this.cmdDevice = this.device;
        this.notifyDevice = this.device;
        this.channelsResolved = true;
      } else {
        const authorized = typeof navigator !== "undefined" && navigator.hid?.getDevices
          ? await navigator.hid.getDevices().catch(() => [])
          : [];
        this.bindPeers(authorized);
      }
    }

    const cmd = this.cmdDevice ?? this.device;
    const notify = this.notifyDevice ?? cmd;
    if (!cmd.opened) await cmd.open();
    if (notify !== cmd && !notify.opened) await notify.open();

    notify.removeEventListener("inputreport", this.onInputReport);
    notify.addEventListener("inputreport", this.onInputReport);
    if (this.device !== notify) {
      if (!this.device.opened) await this.device.open();
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.device.addEventListener("inputreport", this.onInputReport);
    }
  }

  async close(): Promise<void> {
    this.failWaiter(new Error("The Redragon M719RGB-PRO device was closed."));
    this.notificationListener = null;
    this.handshakeCompleted = false;
    const devices = new Set<HIDDevice>([
      this.device,
      ...(this.cmdDevice ? [this.cmdDevice] : []),
      ...(this.notifyDevice ? [this.notifyDevice] : []),
    ]);
    for (const dev of devices) {
      dev.removeEventListener("inputreport", this.onInputReport);
      if (dev.opened) await dev.close().catch(() => undefined);
    }
    this.cmdDevice = null;
    this.notifyDevice = null;
    this.channelsResolved = false;
  }

  async startNotifications(onChange?: () => void): Promise<boolean> {
    await this.open();
    this.notificationListener = onChange ?? null;
    return true;
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.serialized(async () => {
      await this.open();
      const wireless = this.isWireless();

      if (wireless) {
        const online = await this.checkOnline();
        if (!online) {
          return this.unreadyStatus(OFFLINE_NOTE);
        }
      }

      await this.ensureHandshake();

      let snapshot: Awaited<ReturnType<typeof this.readHardwareSnapshot>>;
      try {
        snapshot = await this.readHardwareSnapshot();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.unreadyStatus(message);
      }

      const battery = await this.readBattery().catch(() => null);
      let batteryPercent: number | null = null;
      let batteryState: MouseStatus["batteryState"] = wireless ? "Unknown" : "Charging";
      if (battery) {
        batteryPercent = battery.percent;
        if (wireless) {
          batteryState = battery.charging
            ? (battery.percent >= 100 ? "Full" : "Charging")
            : "Discharging";
        } else {
          batteryState = battery.percent >= 100 ? "Full" : "Charging";
        }
      }

      const stageCount = snapshot.stageCount;
      const activeStage = Math.min(snapshot.activeStage, stageCount - 1);
      const visibleStages = snapshot.stages.slice(0, stageCount);
      const visibleColors = snapshot.stageColors.slice(0, stageCount).map(rgbToHex);
      const activeColorHex = visibleColors[activeStage] ?? rgbToHex(snapshot.stageColors[0]!);

      const mainLighting = this.buildMainLighting(snapshot.rgb);
      const dpiIndicatorLighting = this.buildDpiIndicatorLighting(snapshot.dpiLedMode, activeColorHex);

      return {
        brand: "Redragon",
        name: DISPLAY_NAME,
        ui: {
          family: "redragon",
          defaultDisplayName: DISPLAY_NAME,
          settingsReady: true,
          valuesVerified: true,
          hideUnsupportedPollingRates: true,
          dpiStageEditor: {
            maxStages: REDRAGON_M719_PRO_MAX_DPI_STAGES,
            countEditable: true,
            minDpi: REDRAGON_M719_PRO_DPI_MIN,
            maxDpi: REDRAGON_M719_PRO_DPI_MAX,
            stepDpi: REDRAGON_M719_PRO_DPI_STEP,
          },
        },
        batteryPercent,
        batteryState,
        dpi: visibleStages[activeStage] ?? snapshot.stages[0] ?? 800,
        dpiStages: visibleStages,
        dpiStageColors: visibleColors,
        activeDpiStage: activeStage,
        pollingRateHz: snapshot.pollingHz,
        supportedPollingRates: [...REDRAGON_M719_PRO_POLLING_RATES],
        activeProfile: null,
        buttonMappings: snapshot.buttonMappings,
        buttonOptions: [...REDRAGON_M719_PRO_BUTTON_ACTIONS],
        fixedButtons: snapshot.fixedButtons,
        connectionType: wireless ? "Wireless" : "Wired",
        connectionDetail: wireless ? "2.4 GHz receiver" : "USB",
        liftOffDistance: null,
        lighting: mainLighting,
        lightingZones: [mainLighting, dpiIndicatorLighting],
        firmware: [],
      };
    });
  }

  async setPollingRate(hz: number): Promise<number> {
    const encoded = redragonM719ProEncodePollingRate(hz);
    return await this.serialized(async () => {
      await this.requireReady();
      await this.writeEeprom(REDRAGON_M719_PRO_EEPROM.pollingRate, encoded);
      const readBack = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.pollingRate, 2);
      const confirmed = redragonM719ProDecodePollingRate(readBack);
      if (confirmed !== hz) {
        throw new Error(`The mouse kept ${confirmed} Hz instead of ${hz} Hz.`);
      }
      return confirmed;
    });
  }

  async setDpi(dpi: number): Promise<number> {
    if (!Number.isFinite(dpi) || dpi < REDRAGON_M719_PRO_DPI_MIN || dpi > REDRAGON_M719_PRO_DPI_MAX) {
      throw new RangeError(
        `Redragon M719RGB-PRO DPI must be between ${REDRAGON_M719_PRO_DPI_MIN} and ${REDRAGON_M719_PRO_DPI_MAX}.`,
      );
    }
    const target = redragonM719ProNearestDpi(dpi);
    return await this.serialized(async () => {
      await this.requireReady();
      const activeStage = await this.readActiveStageIndex();
      return await this.writeStageDpi(activeStage, target);
    });
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_M719_PRO_MAX_DPI_STAGES) {
      throw new RangeError(`Redragon M719RGB-PRO DPI stage must be 0–${REDRAGON_M719_PRO_MAX_DPI_STAGES - 1}.`);
    }
    if (!Number.isFinite(dpi) || dpi < REDRAGON_M719_PRO_DPI_MIN || dpi > REDRAGON_M719_PRO_DPI_MAX) {
      throw new RangeError(
        `Redragon M719RGB-PRO DPI must be between ${REDRAGON_M719_PRO_DPI_MIN} and ${REDRAGON_M719_PRO_DPI_MAX}.`,
      );
    }
    const target = redragonM719ProNearestDpi(dpi);
    return await this.serialized(async () => {
      await this.requireReady();
      return await this.writeStageDpi(stage, target);
    });
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_M719_PRO_MAX_DPI_STAGES) {
      throw new RangeError(`Redragon M719RGB-PRO active DPI stage must be 0–${REDRAGON_M719_PRO_MAX_DPI_STAGES - 1}.`);
    }
    return await this.serialized(async () => {
      await this.requireReady();
      const stageCount = await this.readStageCount();
      if (stage >= stageCount) {
        throw new RangeError(`Stage ${stage + 1} is disabled (only ${stageCount} stages active).`);
      }
      await this.writeEeprom(REDRAGON_M719_PRO_EEPROM.activeDpiStage, redragonM719ProPackScalar(stage));
      const confirmed = await this.readActiveStageIndex();
      if (confirmed !== stage) {
        throw new Error(`The mouse kept DPI stage ${confirmed + 1} instead of ${stage + 1}.`);
      }
      return confirmed;
    });
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > REDRAGON_M719_PRO_MAX_DPI_STAGES) {
      throw new RangeError(`Redragon M719RGB-PRO supports 1–${REDRAGON_M719_PRO_MAX_DPI_STAGES} DPI stages.`);
    }
    return await this.serialized(async () => {
      await this.requireReady();
      const currentActive = await this.readActiveStageIndex();
      await this.writeEeprom(REDRAGON_M719_PRO_EEPROM.dpiStageCount, redragonM719ProPackScalar(count));
      if (currentActive >= count) {
        await this.writeEeprom(REDRAGON_M719_PRO_EEPROM.activeDpiStage, redragonM719ProPackScalar(count - 1));
      }
      const confirmed = await this.readStageCount();
      if (confirmed !== count) {
        throw new Error(`The mouse kept ${confirmed} DPI stages instead of ${count}.`);
      }
      return confirmed;
    });
  }

  async setDpiStageColor(stage: number, color: string): Promise<string> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_M719_PRO_MAX_DPI_STAGES) {
      throw new RangeError(`Redragon M719RGB-PRO DPI stage must be 0–${REDRAGON_M719_PRO_MAX_DPI_STAGES - 1}.`);
    }
    const rgb = hexToRgb(color);
    const expectedHex = rgbToHex(rgb);
    return await this.serialized(async () => {
      await this.requireReady();
      const address = REDRAGON_M719_PRO_EEPROM.dpiColors + stage * 4;
      await this.writeEeprom(address, redragonM719ProEncodeDpiStageColor(rgb));
      const readBack = await this.readEeprom(address, 4);
      const confirmedHex = rgbToHex(redragonM719ProDecodeDpiStageColor(readBack));
      if (confirmedHex !== expectedHex) {
        throw new Error(`The mouse kept stage ${stage + 1} colour ${confirmedHex} instead of ${expectedHex}.`);
      }
      return confirmedHex;
    });
  }

  async setDpiIndicatorMode(mode: RedragonM719ProDpiLedMode): Promise<RedragonM719ProDpiLedMode> {
    if (mode !== 0 && mode !== 1 && mode !== 2) {
      throw new RangeError(`Redragon M719RGB-PRO DPI indicator mode must be 0, 1, or 2.`);
    }
    return await this.serialized(async () => {
      await this.requireReady();
      const activeStage = await this.readActiveStageIndex();
      await this.writeEeprom(
        REDRAGON_M719_PRO_EEPROM.dpiLedEffect,
        redragonM719ProEncodeDpiLedEffect(mode, activeStage),
      );
      const readBack = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.dpiLedEffect, 2);
      const confirmed = redragonM719ProDecodeDpiLedEffect(readBack);
      if (confirmed !== mode) {
        throw new Error(`The mouse kept DPI indicator mode ${confirmed} instead of ${mode}.`);
      }
      return confirmed;
    });
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    if (lighting.zone === "DPI indicator") {
      const code = modeToDpiLedCode(lighting.mode);
      return await this.serialized(async () => {
        await this.requireReady();
        const activeStage = await this.readActiveStageIndex();
        await this.writeEeprom(
          REDRAGON_M719_PRO_EEPROM.dpiLedEffect,
          redragonM719ProEncodeDpiLedEffect(code, activeStage),
        );
        const readBack = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.dpiLedEffect, 2);
        const confirmed = redragonM719ProDecodeDpiLedEffect(readBack);
        if (confirmed !== code) {
          throw new Error("The mouse did not confirm the requested DPI indicator effect.");
        }
        return this.buildDpiIndicatorLighting(confirmed, lighting.color ?? "#ff0000");
      });
    }

    if (lighting.zone && lighting.zone !== "Mouse") {
      throw new Error(`Unknown Redragon M719RGB-PRO lighting zone: ${lighting.zone}.`);
    }

    const effect = modeToEffect(lighting.mode);
    const color = lighting.color ? hexToRgb(lighting.color) : this.lastRgbColor;
    const speed = lighting.speed != null
      ? Math.max(1, Math.min(10, Math.round(lighting.speed)))
      : this.lastRgbSpeed;
    const brightnessPercent = lighting.brightness != null
      ? Math.max(10, Math.min(100, Math.round(lighting.brightness / 10) * 10))
      : this.lastRgbBrightness * 10;
    const brightnessLevel = Math.max(1, Math.min(10, Math.round(brightnessPercent / 10)));

    return await this.serialized(async () => {
      await this.requireReady();
      this.lastRgbColor = color;
      this.lastRgbSpeed = speed;
      this.lastRgbBrightness = brightnessLevel;

      const encoded = redragonM719ProEncodeRgbLighting({
        effect,
        color,
        speed,
        brightness: brightnessLevel,
      });
      await this.writeEeprom(REDRAGON_M719_PRO_EEPROM.rgbLighting, encoded);
      const readBack = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.rgbLighting, 7);
      const confirmed = redragonM719ProDecodeRgbLighting(readBack);
      if (confirmed.effect !== effect) {
        throw new Error(`The mouse kept lighting mode ${effectToMode(confirmed.effect)} instead of ${lighting.mode}.`);
      }
      return this.buildMainLighting(confirmed);
    });
  }

  async setButtonMapping(button: string, action: string): Promise<void> {
    const entry = REDRAGON_M719_PRO_BUTTONS.find((candidate) => candidate.label === button);
    if (!entry) {
      throw new Error(`Unknown Redragon M719RGB-PRO button: ${button}.`);
    }
    const encoded = redragonM719ProEncodeButtonAction(action);

    await this.serialized(async () => {
      await this.requireReady();
      const currentButtons = await this.readButtons();
      const nextMappings = { ...currentButtons.buttonMappings, [button]: action };
      if (!Object.values(nextMappings).includes("Left click")) {
        throw new Error("Keep Left click on at least one button before reassigning this one.");
      }

      if (encoded.comboPayload) {
        const comboAddress = REDRAGON_M719_PRO_EEPROM.comboBase + entry.slot * REDRAGON_M719_PRO_EEPROM.comboSlotStride;
        await this.writeEeprom(comboAddress, encoded.comboPayload);
      }

      // The OEM driver writes the button matrix in 8-byte (2-slot) aligned chunks.
      const pairBaseSlot = entry.slot & ~1;
      const pairAddress = REDRAGON_M719_PRO_EEPROM.buttonMatrix + pairBaseSlot * 4;
      const pairChunk = await this.readEeprom(pairAddress, 8);
      const inPairOffset = (entry.slot & 1) * 4;
      pairChunk.set(encoded.slotBytes, inPairOffset);
      await this.writeEeprom(pairAddress, pairChunk);

      const confirmedChunk = await this.readEeprom(entry.offset, 4);
      for (let i = 0; i < 4; i += 1) {
        if (confirmedChunk[i] !== encoded.slotBytes[i]) {
          throw new Error(`The mouse did not confirm the ${button} assignment.`);
        }
      }
    });
  }

  // ── Internal Transport & EEPROM Helpers ──────────────────────────────────

  private unreadyStatus(statusNote: string): MouseStatus {
    const wireless = this.isWireless();
    return {
      brand: "Redragon",
      name: DISPLAY_NAME,
      ui: {
        family: "redragon",
        defaultDisplayName: DISPLAY_NAME,
        settingsReady: false,
        hideUnsupportedPollingRates: true,
        statusNote,
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 800,
      pollingRateHz: 1000,
      supportedPollingRates: [...REDRAGON_M719_PRO_POLLING_RATES],
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver" : "USB",
      liftOffDistance: null,
      firmware: [],
    };
  }

  private buildMainLighting(rgb: ReturnType<typeof redragonM719ProDecodeRgbLighting>): MouseLighting {
    const mode = effectToMode(rgb.effect);
    if (rgb.effect !== REDRAGON_M719_PRO_RGB_EFFECT.off) {
      this.lastRgbSpeed = rgb.speed;
      this.lastRgbBrightness = rgb.brightness;
      this.lastRgbColor = rgb.color;
    }
    const shownSpeed = rgb.effect === REDRAGON_M719_PRO_RGB_EFFECT.off ? this.lastRgbSpeed : rgb.speed;
    const shownBrightness = (rgb.effect === REDRAGON_M719_PRO_RGB_EFFECT.off ? this.lastRgbBrightness : rgb.brightness) * 10;
    return {
      zone: "Mouse",
      modes: MAIN_LIGHTING_MODES,
      mode,
      color: rgbToHex(rgb.color),
      color2: null,
      colorModes: MAIN_COLOR_MODES,
      dualColorModes: [],
      reactiveModes: MAIN_REACTIVE_MODES,
      speeds: [...REDRAGON_M719_PRO_SPEED_LEVELS],
      speed: shownSpeed,
      brightness: shownBrightness,
      brightnessLevels: [...REDRAGON_M719_PRO_BRIGHTNESS_PERCENTS],
    };
  }

  private buildDpiIndicatorLighting(modeCode: RedragonM719ProDpiLedMode, activeStageColorHex: string): MouseLighting {
    return {
      zone: "DPI indicator",
      modes: DPI_INDICATOR_MODES,
      mode: dpiLedCodeToMode(modeCode),
      color: activeStageColorHex,
      color2: null,
      colorModes: [],
      dualColorModes: [],
      reactiveModes: [],
      speeds: [],
      speed: null,
    };
  }

  private async requireReady(): Promise<void> {
    await this.open();
    if (this.isWireless()) {
      const online = await this.checkOnline();
      if (!online) {
        throw new Error(OFFLINE_NOTE);
      }
    }
    await this.ensureHandshake();
  }

  private async checkOnline(): Promise<boolean> {
    try {
      const reply = await this.exchange(redragonM719ProEncodeGetConnectStatus());
      return redragonM719ProDecodeConnectStatus(reply);
    } catch {
      return false;
    }
  }

  private async ensureHandshake(): Promise<void> {
    if (this.handshakeCompleted) return;
    const challenge: [number, number, number, number] = [0x17, 0x2a, 0x3d, 0x50];
    try {
      const reply = await this.exchange(redragonM719ProEncodeHandshake(challenge));
      if (redragonM719ProVerifyHandshakeReply(challenge, reply)) {
        await this.sendOnly(redragonM719ProEncodeTellDriverStatus(true)).catch(() => undefined);
      }
    } catch {
      // Some minimal receivers/mocks skip Cmd 0x01; EEPROM commands still validate directly.
    }
    this.handshakeCompleted = true;
  }

  private async readBattery() {
    const reply = await this.exchange(redragonM719ProEncodeGetBattery());
    return redragonM719ProDecodeBattery(reply);
  }

  private async readStageCount(): Promise<number> {
    const raw = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.dpiStageCount, 2);
    const count = redragonM719ProUnpackScalar(raw) ?? raw[0] ?? REDRAGON_M719_PRO_MAX_DPI_STAGES;
    return Math.max(1, Math.min(REDRAGON_M719_PRO_MAX_DPI_STAGES, count));
  }

  private async readActiveStageIndex(): Promise<number> {
    const raw = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.activeDpiStage, 2);
    const index = (redragonM719ProUnpackScalar(raw) ?? raw[0] ?? 0) & 0x0f;
    return Math.max(0, Math.min(REDRAGON_M719_PRO_MAX_DPI_STAGES - 1, index));
  }

  private async writeStageDpi(stage: number, targetDpi: number): Promise<number> {
    const address = REDRAGON_M719_PRO_EEPROM.dpiStages + stage * 4;
    await this.writeEeprom(address, redragonM719ProEncodeDpiStage(targetDpi));
    const readBack = await this.readEeprom(address, 4);
    const confirmed = redragonM719ProDecodeDpiStage(readBack);
    if (confirmed !== targetDpi) {
      throw new Error(`The mouse kept ${confirmed} DPI instead of ${targetDpi} DPI.`);
    }
    return confirmed;
  }

  private async readButtons(): Promise<{
    buttonMappings: Record<string, string>;
    fixedButtons: string[];
  }> {
    const chunk60 = await this.readEeprom(0x0060, 8);
    const chunk68 = await this.readEeprom(0x0068, 8);
    const chunk70 = await this.readEeprom(0x0070, 8);
    const chunk80 = await this.readEeprom(0x0080, 8);
    const chunk88 = await this.readEeprom(0x0088, 8);

    const slotMap = new Map<number, Uint8Array>([
      [0, chunk60.subarray(0, 4)],
      [1, chunk60.subarray(4, 8)],
      [2, chunk68.subarray(0, 4)],
      [3, chunk68.subarray(4, 8)],
      [4, chunk70.subarray(0, 4)],
      [8, chunk80.subarray(0, 4)],
      [10, chunk88.subarray(0, 4)],
      [11, chunk88.subarray(4, 8)],
    ]);

    const buttonMappings: Record<string, string> = {};
    const fixedButtons: string[] = [];

    for (const button of REDRAGON_M719_PRO_BUTTONS) {
      const slotBytes = slotMap.get(button.slot)!;
      let comboBytes: Uint8Array | null = null;
      if (slotBytes[0] === 0x05) {
        const comboAddress = REDRAGON_M719_PRO_EEPROM.comboBase + button.slot * REDRAGON_M719_PRO_EEPROM.comboSlotStride;
        comboBytes = await this.readEeprom(comboAddress, 10).catch(() => null);
      }
      const action = redragonM719ProDecodeButtonAction(slotBytes, comboBytes);
      buttonMappings[button.label] = action;
      if (!REDRAGON_M719_PRO_BUTTON_ACTIONS.includes(action)) {
        fixedButtons.push(button.label);
      }
    }

    return { buttonMappings, fixedButtons };
  }

  private async readHardwareSnapshot() {
    const pollingRaw = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.pollingRate, 2);
    const pollingHz = redragonM719ProDecodePollingRate(pollingRaw);
    const stageCount = await this.readStageCount();
    const activeStage = await this.readActiveStageIndex();

    const stagesRaw = new Uint8Array(20);
    stagesRaw.set(await this.readEeprom(0x000c, 8), 0);
    stagesRaw.set(await this.readEeprom(0x0014, 8), 8);
    stagesRaw.set(await this.readEeprom(0x001c, 4), 16);
    const stages = redragonM719ProDecodeDpiStages(stagesRaw);

    const colorsRaw = new Uint8Array(20);
    colorsRaw.set(await this.readEeprom(0x002c, 8), 0);
    colorsRaw.set(await this.readEeprom(0x0034, 8), 8);
    colorsRaw.set(await this.readEeprom(0x003c, 4), 16);
    const stageColors = redragonM719ProDecodeDpiStageColors(colorsRaw);

    const dpiLedRaw = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.dpiLedEffect, 6).catch(
      () => new Uint8Array([0x01, 0x54]),
    );
    const dpiLedMode = redragonM719ProDecodeDpiLedEffect(dpiLedRaw);

    const { buttonMappings, fixedButtons } = await this.readButtons();

    const rgbRaw = await this.readEeprom(REDRAGON_M719_PRO_EEPROM.rgbLighting, 7);
    const rgb = redragonM719ProDecodeRgbLighting(rgbRaw);

    return {
      pollingHz,
      stageCount,
      activeStage,
      stages,
      stageColors,
      dpiLedMode,
      buttonMappings,
      fixedButtons,
      rgb,
    };
  }

  private async readEeprom(address: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += REDRAGON_M719_PRO_MAX_CHUNK_LENGTH) {
      const chunkLen = Math.min(REDRAGON_M719_PRO_MAX_CHUNK_LENGTH, length - offset);
      const currentAddr = address + offset;
      const packet = redragonM719ProEncodeReadEeprom(currentAddr, chunkLen);
      const reply = await this.exchange(packet);
      const decoded = redragonM719ProDecodeReadEeprom(reply, currentAddr, chunkLen);
      if (!decoded) {
        throw new Error(
          `Redragon M719RGB-PRO rejected EEPROM read at 0x${currentAddr.toString(16).padStart(4, "0")}.`,
        );
      }
      out.set(decoded, offset);
    }
    return out;
  }

  private async writeEeprom(address: number, data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.length; offset += REDRAGON_M719_PRO_MAX_CHUNK_LENGTH) {
      const chunk = data.subarray(offset, Math.min(data.length, offset + REDRAGON_M719_PRO_MAX_CHUNK_LENGTH));
      const currentAddr = address + offset;
      const packet = redragonM719ProEncodeWriteEeprom(currentAddr, chunk);

      let acked = false;
      for (let attempt = 0; attempt < WRITE_RETRY_LIMIT; attempt += 1) {
        const reply = await this.exchange(packet);
        const status = redragonM719ProDecodeWriteEeprom(reply);
        if (status === "ack") {
          acked = true;
          break;
        }
        if (status === "busy") {
          await delay(WRITE_SETTLE_DELAY_MS * (attempt + 1));
          continue;
        }
        break;
      }
      if (!acked) {
        throw new Error(
          `Redragon M719RGB-PRO did not acknowledge EEPROM write at 0x${currentAddr.toString(16).padStart(4, "0")}.`,
        );
      }
      if (this.isWireless() || offset + REDRAGON_M719_PRO_MAX_CHUNK_LENGTH < data.length) {
        await delay(WRITE_SETTLE_DELAY_MS);
      }
    }
  }

  private async sendOnly(payload: Uint8Array): Promise<void> {
    const cmd = this.cmdDevice ?? this.device;
    const copy = new Uint8Array(payload);
    await cmd.sendFeatureReport(REDRAGON_M719_PRO_COMMAND_REPORT_ID, copy);
  }

  private async exchange(payload: Uint8Array): Promise<Uint8Array> {
    this.failWaiter(new Error("Superseded by another Redragon M719RGB-PRO request."));
    const command = payload[0]!;
    const cmd = this.cmdDevice ?? this.device;

    const promise = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === resolve) this.waiter = null;
        reject(
          new Error(
            `The Redragon M719RGB-PRO did not answer command 0x${command.toString(16).padStart(2, "0")}.`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.waiter = { command, resolve, reject, timer };
    });

    const copy = new Uint8Array(payload);
    try {
      await cmd.sendFeatureReport(REDRAGON_M719_PRO_COMMAND_REPORT_ID, copy);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.failWaiter(new Error(`Could not write Redragon M719RGB-PRO feature report 8 (${detail}).`));
    }
    return await promise;
  }

  private failWaiter(error: Error): void {
    const waiter = this.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.reject(error);
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
