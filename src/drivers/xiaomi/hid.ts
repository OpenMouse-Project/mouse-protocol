import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";
import type { XiaomiBinding, XiaomiLightingDevice, XiaomiMacroEvent } from "@openmouse/protocol/xiaomi";
import {
  XIAOMI_BUTTON_ACTIONS,
  XIAOMI_BUTTON_NAMES,
  XIAOMI_DEVICES,
  XIAOMI_EFFECTS_BY_DEVICE,
  XIAOMI_KEY_COMBOS,
  XIAOMI_LIGHTING_DEVICES,
  XIAOMI_MACRO_EVENT_SIZE,
  XIAOMI_MACRO_MAX_EVENT_BYTES,
  XIAOMI_MACRO_PACKET_SIZE,
  XIAOMI_MACRO_REPORT_DATA_SIZE,
  XIAOMI_MACRO_REPORT_ID,
  XIAOMI_PACKET_SIZE,
  XIAOMI_POLLING_RATES,
  XIAOMI_PRODUCT_IDS,
  XIAOMI_REPORT_DATA_SIZE,
  XIAOMI_REPORT_ID,
  XIAOMI_SPEEDS,
  XIAOMI_VENDOR_ID,
  xiaomiBindingLabel,
  xiaomiDecodeBattery,
  xiaomiDecodeBinding,
  xiaomiDecodeDpi,
  xiaomiDecodeLighting,
  xiaomiDecodeMacroChunk,
  xiaomiDecodePolling,
  xiaomiHexColorToRgb,
  xiaomiMacroPackets,
  xiaomiReadBatteryRequest,
  xiaomiReadBindingRequest,
  xiaomiReadDpiRequest,
  xiaomiReadLightingRequest,
  xiaomiReadMacroRequest,
  xiaomiReadPollingRequest,
  xiaomiRgbToHexColor,
  xiaomiWriteBindingRequest,
  xiaomiWriteDpiRequest,
  xiaomiWriteLightingRequest,
  xiaomiWriteMacroRequest,
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

/** A HID report channel: its report ID and the hidraw packet/data sizes. */
interface XiaomiChannel {
  reportId: number;
  packetSize: number;
  dataSize: number;
}

/** Control channel: 32-byte hidraw reports headed by 0x4d. */
const CONTROL_CHANNEL: XiaomiChannel = {
  reportId: XIAOMI_REPORT_ID,
  packetSize: XIAOMI_PACKET_SIZE,
  dataSize: XIAOMI_REPORT_DATA_SIZE,
};

/** Macro channel: 64-byte hidraw reports headed by 0x57. */
const MACRO_CHANNEL: XiaomiChannel = {
  reportId: XIAOMI_MACRO_REPORT_ID,
  packetSize: XIAOMI_MACRO_PACKET_SIZE,
  dataSize: XIAOMI_MACRO_REPORT_DATA_SIZE,
};

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
   * Strips the leading report-ID byte from the hidraw request, leaving the
   * data bytes WebHID's `sendReport` expects.
   */
  private payload(channel: XiaomiChannel, request: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(channel.dataSize);
    new Uint8Array(buffer).set(request.subarray(1, channel.packetSize));
    return buffer;
  }

  /**
   * Sends a write command. The firmware does not answer writes (the reference
   * app never reads after them), so the caller must read back to verify.
   */
  private async write(channel: XiaomiChannel, request: Uint8Array): Promise<void> {
    return this.run(async () => {
      await this.open();
      await this.device.sendReport(channel.reportId, this.payload(channel, request));
    });
  }

  /** Sends `request` and resolves with the first reply echoing its header and command byte. */
  private async exchange(channel: XiaomiChannel, request: Uint8Array): Promise<Uint8Array> {
    return this.run(async () => {
      await this.open();
      const payload = this.payload(channel, request);
      return new Promise<Uint8Array>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", listener);
        };

        const listener = (event: HIDInputReportEvent): void => {
          if (event.reportId !== channel.reportId) return;
          const data = copyDataView(event.data);
          if (data.length < 2) return;
          // WebHID delivers the data bytes without the report-ID byte; the
          // decoders expect the hidraw layout, so prepend the report ID.
          const report = new Uint8Array(channel.packetSize);
          report[0] = channel.reportId;
          report.set(data.subarray(0, channel.dataSize), 1);
          if (report[0] !== request[0] || report[1] !== request[1]) return;
          cleanup();
          resolve(report);
        };

        const timer = setTimeout(() => {
          this.device.removeEventListener("inputreport", listener);
          reject(new Error(`${this.label} did not answer the HID request.`));
        }, RESPONSE_TIMEOUT_MS);

        this.device.addEventListener("inputreport", listener);

        this.device.sendReport(channel.reportId, payload).catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
    });
  }

  private async readLightingZones(): Promise<MouseLighting[]> {
    const zones: MouseLighting[] = [];
    for (const [zone, zoneId] of Object.entries(XIAOMI_LIGHTING_DEVICES) as [string, number][]) {
      const raw = xiaomiDecodeLighting(await this.exchange(CONTROL_CHANNEL, xiaomiReadLightingRequest(zoneId)));
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
    await this.write(CONTROL_CHANNEL, xiaomiWriteLightingRequest(zoneId, effect, speed, [red, green, blue]));
    return (await this.readLightingZones())[zoneId];
  }

  async readStatus(): Promise<MouseStatus> {
    const definition = this.definition;
    const battery = xiaomiDecodeBattery(await this.exchange(CONTROL_CHANNEL, xiaomiReadBatteryRequest()));
    const dpi = xiaomiDecodeDpi(await this.exchange(CONTROL_CHANNEL, xiaomiReadDpiRequest()));
    const pollingRateHz = xiaomiDecodePolling(await this.exchange(CONTROL_CHANNEL, xiaomiReadPollingRequest()));
    const lightingZones = await this.readLightingZones();
    const wireless = definition.wireless;
    const buttonMappings: Record<string, string> = {};
    for (const [button, name] of XIAOMI_BUTTON_NAMES.entries()) {
      const binding = await this.readBinding(button);
      buttonMappings[name] = xiaomiBindingLabel(binding) ?? "Unknown";
    }

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
      buttonMappings,
      buttonOptions: XIAOMI_BUTTON_ACTIONS.map((action) => action.label),
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const current = xiaomiDecodeDpi(await this.exchange(CONTROL_CHANNEL, xiaomiReadDpiRequest()));
    const levels = current.levels.map((level, index) => sanitizeDpiLevel(level, index));
    levels[current.active] = dpi;
    await this.write(CONTROL_CHANNEL, xiaomiWriteDpiRequest(levels, current.active));
    const confirmed = xiaomiDecodeDpi(await this.exchange(CONTROL_CHANNEL, xiaomiReadDpiRequest()));
    if (confirmed.levels[confirmed.active] !== dpi) {
      throw new Error(`${this.label} kept ${confirmed.levels[confirmed.active]} DPI instead of ${dpi} DPI.`);
    }
    return confirmed.levels[confirmed.active];
  }

  async setPollingRate(rate: number): Promise<number> {
    if (!this.getSupportedPollingRates().includes(rate)) {
      throw new Error(`${rate} Hz is not supported by the ${this.label}.`);
    }
    await this.write(CONTROL_CHANNEL, xiaomiWritePollingRequest(rate));
    const confirmed = xiaomiDecodePolling(await this.exchange(CONTROL_CHANNEL, xiaomiReadPollingRequest()));
    if (confirmed !== rate) {
      throw new Error(`${this.label} kept ${confirmed} Hz instead of ${rate} Hz.`);
    }
    return confirmed;
  }

  /** Reads the current binding (key combo or macro) of a button. */
  async readBinding(button: number): Promise<XiaomiBinding> {
    const report = await this.exchange(CONTROL_CHANNEL, xiaomiReadBindingRequest(button));
    return xiaomiDecodeBinding(report);
  }

  /**
   * Binds a button to a key combo. `combo` is one of `XIAOMI_KEY_COMBOS`
   * (e.g. `CUSTOM_KEY_COMBO`); `modifiers` and `key` are only meaningful for
   * the custom-key combo.
   */
  async setBinding(button: number, combo: number, modifiers = 0, key = 0): Promise<void> {
    await this.write(CONTROL_CHANNEL, xiaomiWriteBindingRequest(button, combo, modifiers, key));
  }

  /**
   * Maps a button (by display name) to one of the preset actions in
   * `buttonOptions`. Custom combos and macros are not selectable here: they
   * appear in `buttonMappings` and are overwritten when a preset is chosen.
   */
  async setButtonMapping(button: string, actionLabel: string): Promise<void> {
    const buttonIndex = XIAOMI_BUTTON_NAMES.indexOf(button as (typeof XIAOMI_BUTTON_NAMES)[number]);
    if (buttonIndex === -1) throw new Error(`Unknown ${this.label} button: ${button}`);
    const action = XIAOMI_BUTTON_ACTIONS.find((candidate) => candidate.label === actionLabel);
    if (!action) throw new Error(`Unknown ${this.label} button action: ${actionLabel}`);
    await this.setBinding(buttonIndex, action.combo);
  }

  /**
   * Reads the macro bound to a button. Throws if the button is not bound to a
   * macro. The macro body lives on the 64-byte macro channel (report ID 0x57),
   * read in chunks of up to 14 events.
   */
  async readMacro(button: number): Promise<XiaomiMacroEvent[]> {
    const binding = await this.readBinding(button);
    if (binding.mode !== XIAOMI_KEY_COMBOS.MACROS_NO_DELAY && binding.mode !== XIAOMI_KEY_COMBOS.MACROS_WITH_DELAY) {
      throw new Error(`Button ${button} is not bound to a macro (mode 0x${binding.mode.toString(16)}).`);
    }
    const events: XiaomiMacroEvent[] = [];
    let offset = 0;
    for (;;) {
      const remaining = (binding.macroSize ?? 0) - events.length * XIAOMI_MACRO_EVENT_SIZE;
      if (remaining <= 0) break;
      const chunkSize = Math.min(remaining, XIAOMI_MACRO_MAX_EVENT_BYTES);
      const report = await this.exchange(MACRO_CHANNEL, xiaomiReadMacroRequest(offset, chunkSize));
      const chunk = xiaomiDecodeMacroChunk(report);
      events.push(...chunk.events);
      if (chunk.packetSize < XIAOMI_MACRO_EVENT_SIZE) break; // end of macro
      offset += chunkSize;
    }
    return events;
  }

  /**
   * Writes a macro to a button. `mode` must be `MACROS_NO_DELAY` or
   * `MACROS_WITH_DELAY`. The binding is written on the control channel first,
   * then the macro body is streamed in 64-byte packets on the macro channel.
   */
  async setMacro(button: number, mode: number, events: readonly XiaomiMacroEvent[]): Promise<void> {
    if (mode !== XIAOMI_KEY_COMBOS.MACROS_NO_DELAY && mode !== XIAOMI_KEY_COMBOS.MACROS_WITH_DELAY) {
      throw new Error(`Unsupported macro mode 0x${mode.toString(16)}.`);
    }
    const size = events.length * XIAOMI_MACRO_EVENT_SIZE;
    // The binding stores the size as a signed 16-bit value, so the device
    // can only address 0x7fff bytes (8191 events). Reject larger macros
    // before touching the device.
    if (size > 0x7fff) {
      throw new RangeError(
        `Xiaomi macro is too large: ${events.length} events exceed the 8191-event device limit`,
      );
    }
    // Encode every packet before writing anything, so an invalid event
    // cannot leave the button with a partially written macro.
    const packets: Uint8Array[] = [];
    let offset = 0;
    for (const chunk of xiaomiMacroPackets(events)) {
      packets.push(xiaomiWriteMacroRequest(offset, chunk));
      offset += chunk.length * XIAOMI_MACRO_EVENT_SIZE;
    }
    await this.write(CONTROL_CHANNEL, xiaomiWriteBindingRequest(button, mode, (size >> 8) & 0xff, size & 0xff));
    for (const packet of packets) {
      await this.write(MACRO_CHANNEL, packet);
    }
  }
}
