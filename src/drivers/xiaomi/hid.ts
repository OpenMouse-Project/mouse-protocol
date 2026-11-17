import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";
import type { XiaomiLightingDevice } from "@openmouse/protocol/xiaomi";
import {
  XIAOMI_DEVICES,
  XIAOMI_EFFECTS_BY_DEVICE,
  XIAOMI_LIGHTING_DEVICES,
  XIAOMI_HEADER,
  XIAOMI_PACKET_SIZE,
  XIAOMI_POLLING_RATES,
  XIAOMI_PRODUCT_IDS,
  XIAOMI_REPORT_DATA_SIZE,
  XIAOMI_REPORT_ID,
  XIAOMI_SPEEDS,
  XIAOMI_VENDOR_ID,
  xiaomiDecodeBattery,
  xiaomiDecodeDpi,
  xiaomiDecodeLighting,
  xiaomiDecodePolling,
  xiaomiHexColorToRgb,
  xiaomiReadBatteryRequest,
  xiaomiReadDpiRequest,
  xiaomiReadLightingRequest,
  xiaomiReadPollingRequest,
  xiaomiRgbToHexColor,
  xiaomiWriteDpiRequest,
  xiaomiWriteLightingRequest,
  xiaomiWritePollingRequest,
} from "@openmouse/protocol/xiaomi";

const RESPONSE_TIMEOUT_MS = 1_500;

/** Logical effect → shared lighting-mode label. */
const EFFECT_MODES: Record<number, MouseLightingMode> = {
  0: "Off",
  1: "Static",
  2: "Breathing single",
  3: "Single Flash",
  5: "Cycling",
  6: "Spectrum",
};

/** Shared lighting-mode label → logical effect. */
const MODE_EFFECTS: Record<string, number> = Object.fromEntries(
  Object.entries(EFFECT_MODES).map(([effect, mode]) => [mode, Number(effect)]),
);

/** Factory defaults, used to fill a level the firmware reports empty (0). */
const DEFAULT_DPI_LEVELS = [100, 800, 1600, 2400, 4800];

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

/**
 * No HID descriptor has been captured for this mouse, so the control channel
 * is selected by shape: any collection that can both send and receive reports.
 */
function hasControlCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some(
    (collection) =>
      (collection.inputReports.length > 0 && collection.outputReports.length > 0) ||
      hasControlCollection(collection.children),
  );
}

function sanitizeDpiLevel(level: number, index: number): number {
  if (Number.isInteger(level) && level >= 50 && level <= 7200 && level % 50 === 0) return level;
  return DEFAULT_DPI_LEVELS[index];
}

export class XiaomiHidClient {
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== XIAOMI_VENDOR_ID || !XIAOMI_PRODUCT_IDS.has(device.productId)) return false;
    return hasControlCollection(device.collections);
  }

  private get definition() {
    return XIAOMI_DEVICES.get(this.device.productId)!;
  }

  private get label(): string {
    return this.definition.name;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    const values: number[] = [];
    for (let dpi = 50; dpi <= 7200; dpi += 50) values.push(dpi);
    return values;
  }

  getSupportedPollingRates(): number[] {
    return [...XIAOMI_POLLING_RATES].sort((a, b) => a - b);
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return started;
  }

  /**
   * Strips the leading report-ID byte from the 32-byte hidraw request,
   * leaving the 31 data bytes WebHID's `sendReport` expects.
   */
  private payload(request: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(XIAOMI_REPORT_DATA_SIZE);
    new Uint8Array(buffer).set(request.subarray(1, XIAOMI_PACKET_SIZE));
    return buffer;
  }

  /**
   * Sends a write command. The firmware does not answer writes (the reference
   * app never reads after them), so the caller must read back to verify.
   */
  private async write(request: Uint8Array): Promise<void> {
    return this.run(async () => {
      await this.open();
      await this.device.sendReport(XIAOMI_REPORT_ID, this.payload(request));
    });
  }

  /** Sends `request` and resolves with the first reply echoing its header and command byte. */
  private async exchange(request: Uint8Array): Promise<Uint8Array> {
    return this.run(async () => {
      await this.open();
      const payload = this.payload(request);
      return new Promise<Uint8Array>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
        };

        const listener = (event: HIDInputReportEvent): void => {
          if (event.reportId !== XIAOMI_REPORT_ID) return;
          const data = copyDataView(event.data);
          if (data.length < 2) return;
          // WebHID delivers the 31 data bytes without the report-ID byte;
          // the decoders expect the 32-byte hidraw layout, so prepend it.
          const report = new Uint8Array(XIAOMI_PACKET_SIZE);
          report[0] = XIAOMI_HEADER;
          report.set(data.subarray(0, XIAOMI_REPORT_DATA_SIZE), 1);
          if (report[0] !== request[0] || report[1] !== request[1]) return;
          cleanup();
          resolve(report);
        };

        const timer = setTimeout(() => {
          this.device.removeEventListener("inputreport", listener);
          reject(new Error(`${this.label} did not answer the HID request.`));
        }, RESPONSE_TIMEOUT_MS);

        this.device.addEventListener("inputreport", listener);

        this.device.sendReport(XIAOMI_REPORT_ID, payload).catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
    });
  }

  private async readLightingZones(): Promise<MouseLighting[]> {
    const zones: MouseLighting[] = [];
    for (const [zone, zoneId] of Object.entries(XIAOMI_LIGHTING_DEVICES) as [string, number][]) {
      const raw = xiaomiDecodeLighting(await this.exchange(xiaomiReadLightingRequest(zoneId)));
      zones.push(this.lightingStatus(zone, raw));
    }
    return zones;
  }

  private lightingStatus(
    zone: string,
    raw: { effect: number; speed: number; color: [number, number, number] },
  ): MouseLighting {
    const modes = XIAOMI_EFFECTS_BY_DEVICE[zone as XiaomiLightingDevice].map((effect) => EFFECT_MODES[effect]);
    return {
      zone,
      modes,
      mode: EFFECT_MODES[raw.effect] ?? "Static",
      color: xiaomiRgbToHexColor(raw.color),
      color2: null,
      colorModes: modes.filter((mode) => mode !== "Off"),
      dualColorModes: [],
      reactiveModes: [],
      speeds: [...XIAOMI_SPEEDS],
      speed: raw.speed,
    };
  }

  async readLighting(): Promise<MouseLighting[]> {
    return this.readLightingZones();
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    const zoneId = (Object.entries(XIAOMI_LIGHTING_DEVICES) as [string, number][])
      .find(([name]) => name === lighting.zone)?.[1];
    if (zoneId === undefined) throw new Error(`Unknown ${this.label} lighting zone: ${lighting.zone}`);
    if (!lighting.mode) throw new Error("Choose an RGB effect first.");
    const effect = MODE_EFFECTS[lighting.mode];
    if (effect === undefined) throw new Error(`Unsupported ${this.label} lighting mode: ${lighting.mode}`);
    const [red, green, blue] = xiaomiHexColorToRgb(lighting.color ?? "#00ff00");
    const speed = lighting.speed ?? 4;
    await this.write(xiaomiWriteLightingRequest(zoneId, effect, speed, [red, green, blue]));
    return (await this.readLightingZones())[zoneId];
  }

  async readStatus(): Promise<MouseStatus> {
    const definition = this.definition;
    const battery = xiaomiDecodeBattery(await this.exchange(xiaomiReadBatteryRequest()));
    const dpi = xiaomiDecodeDpi(await this.exchange(xiaomiReadDpiRequest()));
    const pollingRateHz = xiaomiDecodePolling(await this.exchange(xiaomiReadPollingRequest()));
    const lightingZones = await this.readLightingZones();
    const wireless = definition.wireless;

    return {
      brand: "Xiaomi",
      name: definition.name,
      ui: {
        family: "xiaomi",
        settingsReady: definition.verified,
        valuesVerified: definition.verified,
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
        defaultDisplayName: definition.name,
        statusNote: definition.verified
          ? `${definition.name} hardware controls are enabled.`
          : `${definition.name} wireless support has not been tested on real hardware yet. Every change is read back from the mouse.`,
      },
      batteryPercent: battery,
      batteryState: wireless ? "Discharging" : "Charging",
      dpi: dpi.levels[dpi.active],
      dpiStages: dpi.levels,
      activeDpiStage: dpi.active,
      pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver" : "Wired USB",
      liftOffDistance: null,
      lighting: lightingZones[0],
      lightingZones,
      firmware: [],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const current = xiaomiDecodeDpi(await this.exchange(xiaomiReadDpiRequest()));
    const levels = current.levels.map((level, index) => sanitizeDpiLevel(level, index));
    levels[current.active] = dpi;
    await this.write(xiaomiWriteDpiRequest(levels, current.active));
    const confirmed = xiaomiDecodeDpi(await this.exchange(xiaomiReadDpiRequest()));
    if (confirmed.levels[confirmed.active] !== dpi) {
      throw new Error(`${this.label} kept ${confirmed.levels[confirmed.active]} DPI instead of ${dpi} DPI.`);
    }
    return confirmed.levels[confirmed.active];
  }

  async setPollingRate(rate: number): Promise<number> {
    if (!this.getSupportedPollingRates().includes(rate)) {
      throw new Error(`${rate} Hz is not supported by the ${this.label}.`);
    }
    await this.write(xiaomiWritePollingRequest(rate));
    const confirmed = xiaomiDecodePolling(await this.exchange(xiaomiReadPollingRequest()));
    if (confirmed !== rate) {
      throw new Error(`${this.label} kept ${confirmed} Hz instead of ${rate} Hz.`);
    }
    return confirmed;
  }
}
