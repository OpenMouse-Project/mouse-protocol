import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";
import {
  AEROX3_WIRELESS_DEFAULT_BUTTONS,
  AEROX3_WIRELESS_DEFAULT_DIM_TIMER_SECONDS,
  AEROX3_WIRELESS_DEFAULT_DPI_PRESETS,
  AEROX3_WIRELESS_DEFAULT_POLLING_RATE,
  AEROX3_WIRELESS_DEFAULT_SLEEP_TIMER_MINUTES,
  AEROX3_WIRELESS_DEFAULT_ZONE_COLORS,
  AEROX3_WIRELESS_DPI_MAX,
  AEROX3_WIRELESS_DPI_MIN,
  AEROX3_WIRELESS_DPI_STEP,
  AEROX3_WIRELESS_MAX_DPI_PRESETS,
  AEROX3_WIRELESS_MULTIMEDIA_KEYS,
  AEROX3_WIRELESS_POLLING_RATES,
  AEROX3_WIRELESS_REPORT_ID,
  AEROX3_WIRELESS_SLEEP_TIMER_MAX_MINUTES,
  AEROX3_WIRELESS_ZONES,
  STEELSERIES_PRODUCTS,
  STEELSERIES_VENDOR_ID,
  steelseriesAerox3WirelessBatteryQuery,
  steelseriesAerox3WirelessDecodeBattery,
  steelseriesAerox3WirelessDpiOptions,
  steelseriesAerox3WirelessEncodeButtonsMapping,
  steelseriesAerox3WirelessEncodeDefaultLighting,
  steelseriesAerox3WirelessEncodeDimTimer,
  steelseriesAerox3WirelessEncodeDpiPresets,
  steelseriesAerox3WirelessEncodePollingRate,
  steelseriesAerox3WirelessEncodeReactiveColor,
  steelseriesAerox3WirelessEncodeSleepTimer,
  steelseriesAerox3WirelessEncodeZoneColor,
  steelseriesAerox3WirelessSaveCommand,
  type Aerox3WirelessBattery,
  type Aerox3WirelessButtonAction,
  type Aerox3WirelessButtonName,
  type Aerox3WirelessDefaultLighting,
  type Aerox3WirelessRgb,
  type Aerox3WirelessZone,
} from "@openmouse/protocol/steelseries";

/** rivalcfg's `command_approve_delay`. */
const COMMAND_DELAY_MS = 50;
const RESPONSE_TIMEOUT_MS = 500;
/** rivalcfg waits this long for the 2.4 ghz readback after every write. */
const WIRELESS_READBACK_TIMEOUT_MS = 200;

const CONFIG_USAGE_PAGE = 0xffc0;
const CONFIG_USAGE = 0x01;

/** the only collection with a 64-byte output report, the others refuse writes. */
function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === CONFIG_USAGE_PAGE && collection.usage === CONFIG_USAGE)
    || hasConfigCollection(collection.children ?? []));
}

/**
 * the dongle answers `40 FF 01` in place of the mouse while the mouse sleeps or
 * is out of range. it also sends it once right after a polling rate change.
 */
function isMouseUnreachableEvent(payload: Uint8Array): boolean {
  return payload[0] === 0x40 && payload[1] === 0xff;
}

/** the 2.4 ghz dongle pids, every other aerox 3 wireless pid is the usb cable. */
const WIRELESS_MODE_PRODUCT_IDS = new Set([0x1838, 0x1878]);

const ZONE_LABELS: Record<Aerox3WirelessZone, string> = { 1: "Top", 2: "Middle", 3: "Bottom" };
const REACTIVE_ZONE = "Click reaction";
const ZONE_MODES: readonly MouseLightingMode[] = ["Static", "Off"];
const REACTIVE_MODES: readonly MouseLightingMode[] = ["Reactive", "Off"];

const BUTTON_LABELS: Record<Aerox3WirelessButtonName, string> = {
  button1: "Left",
  button2: "Right",
  button3: "Middle",
  button4: "Back",
  button5: "Forward",
  button6: "DPI",
  scrollUp: "Scroll Up",
  scrollDown: "Scroll Down",
};

const ACTION_LABELS: ReadonlyArray<readonly [string, Aerox3WirelessButtonAction]> = [
  ["Left Click", { type: "button", target: "button1" }],
  ["Right Click", { type: "button", target: "button2" }],
  ["Middle Click", { type: "button", target: "button3" }],
  ["Back", { type: "button", target: "button4" }],
  ["Forward", { type: "button", target: "button5" }],
  ["Scroll Up", { type: "button", target: "scrollUp" }],
  ["Scroll Down", { type: "button", target: "scrollDown" }],
  ["DPI Cycle", { type: "dpiSwitch" }],
  ["Disabled", { type: "disabled" }],
  ["Mute", { type: "multimedia", code: AEROX3_WIRELESS_MULTIMEDIA_KEYS.mute }],
  ["Play/Pause", { type: "multimedia", code: AEROX3_WIRELESS_MULTIMEDIA_KEYS.playPause }],
  ["Next Track", { type: "multimedia", code: AEROX3_WIRELESS_MULTIMEDIA_KEYS.next }],
  ["Previous Track", { type: "multimedia", code: AEROX3_WIRELESS_MULTIMEDIA_KEYS.previous }],
  ["Volume Up", { type: "multimedia", code: AEROX3_WIRELESS_MULTIMEDIA_KEYS.volumeUp }],
  ["Volume Down", { type: "multimedia", code: AEROX3_WIRELESS_MULTIMEDIA_KEYS.volumeDown }],
  // keyboard codes are hid usage ids, as in rivalcfg `layout_qwerty.py`.
  ...Array.from({ length: 26 }, (_, i) => [`Key ${String.fromCharCode(65 + i)}`, { type: "keyboard", code: 0x04 + i }] as const),
  ...Array.from({ length: 10 }, (_, i) => [`Key ${(i + 1) % 10}`, { type: "keyboard", code: 0x1e + i }] as const),
  ["Key Enter", { type: "keyboard", code: 0x28 }],
  ["Key Escape", { type: "keyboard", code: 0x29 }],
  ["Key Tab", { type: "keyboard", code: 0x2b }],
  ["Key Space", { type: "keyboard", code: 0x2c }],
  ...Array.from({ length: 12 }, (_, i) => [`Key F${i + 1}`, { type: "keyboard", code: 0x3a + i }] as const),
  ...Array.from({ length: 12 }, (_, i) => [`Key F${i + 13}`, { type: "keyboard", code: 0x68 + i }] as const),
];

function actionKey(action: Aerox3WirelessButtonAction): string {
  if (action.type === "button") return `button:${action.target}`;
  if (action.type === "keyboard" || action.type === "multimedia") return `${action.type}:${action.code}`;
  return action.type;
}

function actionLabel(action: Aerox3WirelessButtonAction): string {
  const key = actionKey(action);
  return ACTION_LABELS.find(([, candidate]) => actionKey(candidate) === key)?.[0] ?? "Unknown";
}

function toHex({ r, g, b }: Aerox3WirelessRgb): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function fromHex(color: string | null): Aerox3WirelessRgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(color ?? "");
  if (!match) throw new Error("Choose a #rrggbb color first.");
  const value = Number.parseInt(match[1]!, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

interface ZoneState {
  mode: "Static" | "Off";
  color: Aerox3WirelessRgb;
}

/**
 * steelseries aerox 3 wireless webhid control, over the usb cable or the 2.4 ghz dongle.
 *
 * both transports share one command set, the dongle pids get `0x40` ored into
 * every command byte. nothing but the battery can be read back, so dpi stages,
 * polling, lighting, timers and buttons come from a cache seeded with
 * rivalcfg's defaults and updated after each successful write. every write is
 * followed by the save command. dpi, polling, timers and buttons survive a
 * power cycle, zone colors do not: the mouse boots into its startup lighting.
 *
 * the config channel is the usage page `0xFFC0` collection, interface 3 over the
 * cable. chrome grants every collection of the mouse at once, so only that one
 * is claimed. the battery reply echoes the query byte, `92` over the cable and `D2`
 * over the dongle, which tells it apart from readbacks and the dongle's
 * unsolicited `40 FF 01` events.
 *
 * rivalcfg's runtime rainbow `22 FF` is acked by a `1038:183A` unit but leaves
 * the strip dark, so it is not offered. rainbow works as startup lighting.
 */
export class SteelSeriesAerox3WirelessHidClient {
  readonly device: HIDDevice;
  private readonly wireless: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private listenerAttached = false;
  private readonly inputWaiters = new Set<(payload: Uint8Array) => void>();
  private dpiStages: number[] = [...AEROX3_WIRELESS_DEFAULT_DPI_PRESETS];
  private activeDpiStage = 0;
  private pollingRateHz: number = AEROX3_WIRELESS_DEFAULT_POLLING_RATE;
  private sleepTimerMinutes: number = AEROX3_WIRELESS_DEFAULT_SLEEP_TIMER_MINUTES;
  private dimTimerSeconds: number = AEROX3_WIRELESS_DEFAULT_DIM_TIMER_SECONDS;
  private readonly zones = new Map<Aerox3WirelessZone, ZoneState>(
    AEROX3_WIRELESS_ZONES.map((zone) => [zone, { mode: "Static", color: { ...AEROX3_WIRELESS_DEFAULT_ZONE_COLORS[zone] } }]),
  );
  private reactiveColor: Aerox3WirelessRgb | null = null;
  private buttons: Record<Aerox3WirelessButtonName, Aerox3WirelessButtonAction> = { ...AEROX3_WIRELESS_DEFAULT_BUTTONS };

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const payload = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    for (const finish of [...this.inputWaiters]) finish(payload);
  };

  constructor(device: HIDDevice) {
    this.device = device;
    this.wireless = WIRELESS_MODE_PRODUCT_IDS.has(device.productId);
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== STEELSERIES_VENDOR_ID) return false;
    return STEELSERIES_PRODUCTS.get(device.productId)?.family === "aerox3-wireless"
      && hasConfigCollection(device.collections);
  }

  get pollIntervalMs(): number { return 30_000; }

  get supportedPollingRates(): number[] { return [...AEROX3_WIRELESS_POLLING_RATES]; }

  getDpiOptions(): number[] { return steelseriesAerox3WirelessDpiOptions(); }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.listenerAttached) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listenerAttached = true;
    }
  }

  async close(): Promise<void> {
    if (this.listenerAttached) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listenerAttached = false;
    }
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const battery = await this.probeBattery();
      const product = STEELSERIES_PRODUCTS.get(this.device.productId);
      const lightingZones = this.lightingZones();
      return {
        brand: "SteelSeries",
        name: this.device.productName?.trim() || `SteelSeries ${product?.model ?? "Aerox 3 Wireless"}`,
        ui: {
          family: "steelseries-aerox3-wireless",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          hideSignalCard: true,
          showAdvancedSection: true,
          pollingNote: "The Aerox 3 Wireless cannot report its settings; values shown are the last written by this app, or SteelSeries defaults.",
          defaultDisplayName: "SteelSeries Aerox 3 Wireless",
          dpiStageEditor: {
            maxStages: AEROX3_WIRELESS_MAX_DPI_PRESETS,
            countEditable: true,
            minDpi: AEROX3_WIRELESS_DPI_MIN,
            maxDpi: AEROX3_WIRELESS_DPI_MAX,
            stepDpi: AEROX3_WIRELESS_DPI_STEP,
          },
        },
        batteryPercent: battery.level,
        batteryState: battery.isCharging ? "Charging" : "Discharging",
        dpi: this.dpiStages[this.activeDpiStage]!,
        dpiStages: [...this.dpiStages],
        activeDpiStage: this.activeDpiStage,
        pollingRateHz: this.pollingRateHz,
        supportedPollingRates: this.supportedPollingRates,
        sleepTimeout: this.sleepTimerMinutes * 60,
        activeProfile: null,
        buttonMappings: Object.fromEntries(
          (Object.keys(BUTTON_LABELS) as Aerox3WirelessButtonName[]).map((name) => [BUTTON_LABELS[name], actionLabel(this.buttons[name])]),
        ),
        buttonOptions: ACTION_LABELS.map(([label]) => label),
        lighting: lightingZones[0],
        lightingZones,
        connectionType: this.wireless ? "Wireless" : "Wired",
        connectionDetail: this.wireless ? "2.4 GHz dongle" : "USB cable",
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  /** writes `dpi` into the active stage. */
  async setDpi(dpi: number): Promise<number> {
    return await this.setDpiStageValue(this.activeDpiStage, dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    this.requireStage(stage);
    const stages = this.dpiStages.map((value, index) => (index === stage ? dpi : value));
    await this.writePresets(stages, this.activeDpiStage);
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    this.requireStage(stage);
    await this.writePresets(this.dpiStages, stage);
    return stage;
  }

  /** new stages repeat the last one, the user then edits them. */
  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > AEROX3_WIRELESS_MAX_DPI_PRESETS) {
      throw new Error(`The Aerox 3 Wireless holds between 1 and ${AEROX3_WIRELESS_MAX_DPI_PRESETS} DPI stages.`);
    }
    const stages = Array.from({ length: count }, (_, index) => this.dpiStages[index] ?? this.dpiStages.at(-1)!);
    await this.writePresets(stages, Math.min(this.activeDpiStage, count - 1));
    return count;
  }

  async setDpiStages(stages: readonly number[], activeStage = 0): Promise<void> {
    await this.writePresets(stages, activeStage);
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    await this.commit(steelseriesAerox3WirelessEncodePollingRate(pollingRateHz, this.wireless));
    this.pollingRateHz = pollingRateHz;
    return pollingRateHz;
  }

  /** the firmware counts whole minutes, 0 disables sleep. */
  async setSleepTimeout(seconds: number): Promise<number> {
    if (!Number.isInteger(seconds) || seconds % 60 !== 0 || seconds < 0 || seconds > AEROX3_WIRELESS_SLEEP_TIMER_MAX_MINUTES * 60) {
      throw new Error(`The Aerox 3 Wireless sleep timeout must be whole minutes up to ${AEROX3_WIRELESS_SLEEP_TIMER_MAX_MINUTES} minutes, or 0 to disable it.`);
    }
    await this.setSleepTimer(seconds / 60);
    return seconds;
  }

  async setSleepTimer(minutes: number): Promise<void> {
    await this.commit(steelseriesAerox3WirelessEncodeSleepTimer(minutes, this.wireless));
    this.sleepTimerMinutes = minutes;
  }

  async setDimTimer(seconds: number): Promise<void> {
    await this.commit(steelseriesAerox3WirelessEncodeDimTimer(seconds, this.wireless));
    this.dimTimerSeconds = seconds;
  }

  get dimTimer(): number { return this.dimTimerSeconds; }

  async setZoneColor(zone: Aerox3WirelessZone, color: Aerox3WirelessRgb): Promise<void> {
    await this.commit(steelseriesAerox3WirelessEncodeZoneColor(zone, color, this.wireless));
    this.zones.set(zone, { mode: "Static", color: { ...color } });
  }

  async setReactiveColor(color: Aerox3WirelessRgb | null): Promise<void> {
    await this.commit(steelseriesAerox3WirelessEncodeReactiveColor(color, this.wireless));
    this.reactiveColor = color && { ...color };
  }

  /** the lighting the mouse boots into, the only lighting that persists. */
  async setDefaultLighting(mode: Aerox3WirelessDefaultLighting): Promise<void> {
    await this.commit(steelseriesAerox3WirelessEncodeDefaultLighting(mode, this.wireless));
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    if (lighting.zone === REACTIVE_ZONE) {
      if (lighting.mode !== "Reactive" && lighting.mode !== "Off") throw new Error("Choose Reactive or Off.");
      await this.setReactiveColor(lighting.mode === "Off" ? null : fromHex(lighting.color));
      return this.lightingZones().find(({ zone }) => zone === REACTIVE_ZONE)!;
    }
    const zone = AEROX3_WIRELESS_ZONES.find((candidate) => ZONE_LABELS[candidate] === lighting.zone);
    if (zone === undefined) throw new Error(`The Aerox 3 Wireless has no "${lighting.zone}" lighting zone.`);
    switch (lighting.mode) {
      case "Static":
        await this.setZoneColor(zone, fromHex(lighting.color));
        break;
      case "Off":
        await this.setZoneColor(zone, { r: 0, g: 0, b: 0 });
        this.zones.set(zone, { mode: "Off", color: this.zones.get(zone)!.color });
        break;
      default:
        throw new Error(`The Aerox 3 Wireless does not support ${lighting.mode ?? "that"} lighting.`);
    }
    return this.lightingZones().find(({ zone: label }) => label === lighting.zone)!;
  }

  async setButtonMapping(button: string, action: string): Promise<void> {
    const name = (Object.keys(BUTTON_LABELS) as Aerox3WirelessButtonName[]).find((candidate) => BUTTON_LABELS[candidate] === button);
    if (!name) throw new Error(`The Aerox 3 Wireless has no "${button}" button.`);
    const resolved = action === "Default"
      ? AEROX3_WIRELESS_DEFAULT_BUTTONS[name]
      : ACTION_LABELS.find(([label]) => label === action)?.[1];
    if (!resolved) throw new Error(`Unknown button action "${action}".`);
    const next = { ...this.buttons, [name]: resolved };
    if (!Object.values(next).some((candidate) => candidate.type === "button" && candidate.target === "button1")) {
      throw new Error("Keep at least one button as Left Click.");
    }
    await this.setButtonsMapping(next);
  }

  async setButtonsMapping(mapping: Partial<Record<Aerox3WirelessButtonName, Aerox3WirelessButtonAction>>): Promise<void> {
    const next = { ...AEROX3_WIRELESS_DEFAULT_BUTTONS, ...mapping };
    await this.commit(steelseriesAerox3WirelessEncodeButtonsMapping(next, this.wireless));
    this.buttons = next;
  }

  private lightingZones(): MouseLighting[] {
    const base = {
      color2: null,
      dualColorModes: [],
      reactiveModes: [],
      speeds: [],
      speed: null,
      writeOnly: true,
    } as const;
    return [
      ...AEROX3_WIRELESS_ZONES.map((zone): MouseLighting => {
        const state = this.zones.get(zone)!;
        return {
          ...base,
          zone: ZONE_LABELS[zone],
          group: "Strip",
          modes: ZONE_MODES,
          mode: state.mode,
          color: toHex(state.color),
          colorModes: ["Static"],
        };
      }),
      {
        ...base,
        zone: REACTIVE_ZONE,
        modes: REACTIVE_MODES,
        mode: this.reactiveColor ? "Reactive" : "Off",
        color: this.reactiveColor ? toHex(this.reactiveColor) : "#ffffff",
        colorModes: ["Reactive"],
      },
    ];
  }

  private requireStage(stage: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= this.dpiStages.length) {
      throw new Error(`The Aerox 3 Wireless has DPI stages 1 to ${this.dpiStages.length}.`);
    }
  }

  private async writePresets(stages: readonly number[], activeStage: number): Promise<void> {
    await this.commit(steelseriesAerox3WirelessEncodeDpiPresets(stages, activeStage, this.wireless));
    this.dpiStages = [...stages];
    this.activeDpiStage = activeStage;
  }

  /** sends one setting, then the save command, as a single queued transaction. */
  private async commit(report: Uint8Array): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.send(report);
      await this.delay(COMMAND_DELAY_MS);
      await this.send(steelseriesAerox3WirelessSaveCommand(this.wireless));
    });
  }

  /** over the dongle rivalcfg drains a readback after each write, a missing one is not an error. */
  private async send(report: Uint8Array): Promise<void> {
    if (!this.wireless) {
      await this.write(report);
      return;
    }
    await this.awaitResponse(report, () => true, WIRELESS_READBACK_TIMEOUT_MS);
  }

  /** `92` doubles as the connectivity probe. */
  private async probeBattery(): Promise<Aerox3WirelessBattery> {
    const query = steelseriesAerox3WirelessBatteryQuery(this.wireless);
    let unreachable = false;
    const payload = await this.awaitResponse(query, (reply) => {
      if (isMouseUnreachableEvent(reply)) unreachable = true;
      return reply[0] === query[0];
    }, RESPONSE_TIMEOUT_MS);
    if (!payload && unreachable) {
      throw new Error("The Aerox 3 Wireless is asleep or out of range of its dongle. Move or click it to wake it, then try again.");
    }
    if (!payload) {
      throw new Error(
        "The Aerox 3 Wireless did not answer on this interface. Close SteelSeries GG (and the SteelSeriesEngine service); if it still does not answer, add the device again and choose another entry.",
      );
    }
    return steelseriesAerox3WirelessDecodeBattery(payload);
  }

  private async awaitResponse(
    query: Uint8Array,
    accepts: (payload: Uint8Array) => boolean,
    timeoutMs: number,
  ): Promise<Uint8Array | null> {
    const response = new Promise<Uint8Array | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (payload: Uint8Array | null): void => {
        if (payload && !accepts(payload)) return;
        clearTimeout(timer);
        this.inputWaiters.delete(finish as (payload: Uint8Array) => void);
        resolve(payload);
      };
      timer = setTimeout(() => finish(null), timeoutMs);
      this.inputWaiters.add(finish as (payload: Uint8Array) => void);
    });
    try {
      await this.write(query);
    } catch (error) {
      this.inputWaiters.clear();
      throw error;
    }
    return await response;
  }

  private async write(payload: Uint8Array): Promise<void> {
    await this.device.sendReport(AEROX3_WIRELESS_REPORT_ID, payload.buffer as ArrayBuffer);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
