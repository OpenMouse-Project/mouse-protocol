import type { MouseStatus } from "../mouse-types.ts";
import {
  THERMALTAKE_CONFIG_USAGE,
  THERMALTAKE_CONFIG_USAGE_PAGE,
  THERMALTAKE_DEBOUNCE_MAX_MS,
  THERMALTAKE_DEBOUNCE_MIN_MS,
  THERMALTAKE_DPI_MAX,
  THERMALTAKE_DPI_MAX_STAGES,
  THERMALTAKE_DPI_MIN,
  THERMALTAKE_DPI_STEP,
  THERMALTAKE_POLLING_RATES,
  THERMALTAKE_PRODUCT_IDS,
  THERMALTAKE_PRODUCT_NAMES,
  THERMALTAKE_PROFILE_COUNT,
  THERMALTAKE_REPORT_ID,
  THERMALTAKE_SHORT_REPORT_ID,
  THERMALTAKE_VENDOR_ID,
  thermaltakeApplySettings,
  thermaltakeCommands,
  thermaltakeDecodeActiveProfile,
  thermaltakeDecodeFirmware,
  thermaltakeDecodeProfile,
  thermaltakeDecodeSettings,
  thermaltakeEncodeProfileWrite,
  thermaltakeNearestDpi,
  thermaltakeShortCommand,
  type ThermaltakeSettingsPatch,
} from "../../thermaltake/index.ts";

/** Waits the vendor tool leaves after each step; the flash write is the slow one. */
const DELAY_MS = {
  firmware: 100,
  register: 20,
  profileRead: 150,
  beginWrite: 100,
  flashWrite: 400,
  endWrite: 20,
  profileSwitch: 300,
} as const;

function hasConfigCollection(collection: HIDCollectionInfo): boolean {
  return (collection.usagePage === THERMALTAKE_CONFIG_USAGE_PAGE && collection.usage === THERMALTAKE_CONFIG_USAGE)
    || collection.children.some(hasConfigCollection);
}

/** Interface 0: the Generic Desktop Mouse collection with its unnumbered 8-byte feature report. */
function hasShortChannel(collection: HIDCollectionInfo): boolean {
  return (collection.usagePage === 0x01 && collection.usage === 0x02
    && collection.featureReports.some((report) => report.reportId === THERMALTAKE_SHORT_REPORT_ID))
    || collection.children.some(hasShortChannel);
}

/**
 * Which command path this WebHID device offers: the full config collection,
 * the 8-byte report on the mouse interface, or neither.
 */
export function thermaltakeChannel(device: HIDDevice): "config" | "short" | null {
  if (device.collections.some(hasConfigCollection)) return "config";
  if (device.collections.some(hasShortChannel)) return "short";
  return null;
}

const SHORT_NOTE = "In the browser this mouse can only switch onboard profiles. DPI, polling rate, button "
  + "response and angle snapping live in profile blocks that only its settings collection carries, and "
  + "Chrome on Windows hides that collection. Run OpenMouse Bridge to change them.";
const UNREACHABLE_NOTE = "Status only: this is the mouse's keyboard interface. Reconnect and pick the other "
  + "Iris Optical RGB entry to switch profiles, or run OpenMouse Bridge to change every setting.";
const NEEDS_CONFIG = "Changing this needs the mouse's settings collection, which Chrome on Windows hides. "
  + "Run OpenMouse Bridge to change it.";

/**
 * Tt eSPORTS Iris Optical RGB and its Hatsune Miku Edition (see
 * `@openmouse/protocol/thermaltake`). Settings live in five onboard profiles;
 * every change rewrites the active profile whole, keeping the bytes it does
 * not touch (lighting, buttons, name), and is read back before it counts.
 *
 * Two paths, like the Rapoo driver:
 * - with the LED-page config collection (OpenMouse Bridge, which reaches it
 *   natively) everything works;
 * - in Chrome on Windows that collection holds only constant items, has no
 *   caps and is dropped (docs/thermaltake-iris-testing.md), so the driver
 *   falls back to the 8-byte report on the mouse interface: firmware, the
 *   active profile and switching between the five profiles.
 * The keyboard interface alone offers neither and reports identity only.
 */
export class ThermaltakeHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private firmware: number | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === THERMALTAKE_VENDOR_ID && THERMALTAKE_PRODUCT_IDS.includes(device.productId);
  }

  private get channel(): "config" | "short" | null {
    return thermaltakeChannel(this.device);
  }

  displayName(): string {
    return THERMALTAKE_PRODUCT_NAMES.get(this.device.productId)
      ?? (this.device.productName?.trim() || "Tt eSPORTS mouse");
  }

  getDpiOptions(): number[] {
    const options: number[] = [];
    for (let dpi = THERMALTAKE_DPI_MIN; dpi <= THERMALTAKE_DPI_MAX; dpi += THERMALTAKE_DPI_STEP) options.push(dpi);
    return options;
  }

  getSupportedPollingRates(): number[] {
    return [...THERMALTAKE_POLLING_RATES];
  }

  getDebounceOptions(): number[] {
    const options: number[] = [];
    for (let ms = THERMALTAKE_DEBOUNCE_MIN_MS; ms <= THERMALTAKE_DEBOUNCE_MAX_MS; ms += 1) options.push(ms);
    return options;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.device.opened) await this.device.close();
  }

  readStatus(): Promise<MouseStatus> {
    if (this.channel === "short") return this.readShortStatus();
    if (this.channel === null) {
      return Promise.resolve({
        brand: "Thermaltake",
        name: this.displayName(),
        ui: { family: "thermaltake", settingsReady: false, statusNote: UNREACHABLE_NOTE },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: 0,
        pollingRateHz: 0,
        activeProfile: null,
        liftOffDistance: null,
        connectionType: "Wired",
        firmware: [],
      });
    }
    return this.run(async () => {
      if (this.firmware === null) this.firmware = await this.readFirmwareNow();
      const profile = await this.readActiveProfileNow();
      const settings = thermaltakeDecodeSettings(await this.readProfileNow(profile));
      return {
        brand: "Thermaltake",
        name: this.displayName(),
        ui: {
          family: "thermaltake",
          hideUnsupportedPollingRates: true,
          hideSignalCard: true,
          hideSleepCard: true,
          hideMotionSync: true,
          hideRippleControl: true,
          showAdvancedSection: true,
          dpiStageEditor: {
            maxStages: THERMALTAKE_DPI_MAX_STAGES,
            countEditable: true,
            minDpi: THERMALTAKE_DPI_MIN,
            maxDpi: THERMALTAKE_DPI_MAX,
            stepDpi: THERMALTAKE_DPI_STEP,
          },
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: settings.dpiStages[settings.activeDpiStage]!,
        dpiStages: settings.dpiStages,
        activeDpiStage: settings.activeDpiStage,
        pollingRateHz: settings.pollingRateHz ?? 0,
        supportedPollingRates: this.getSupportedPollingRates(),
        activeProfile: profile + 1,
        profileCount: THERMALTAKE_PROFILE_COUNT,
        angleSnapping: settings.angleSnapping,
        debounceMs: settings.debounceMs,
        liftOffDistance: null,
        connectionType: "Wired",
        deviceMode: "Onboard",
        firmware: this.firmwareLabel(),
      };
    });
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    await this.patchActiveProfile({ pollingRateHz });
    return pollingRateHz;
  }

  /** Changes the active stage's value. */
  async setDpi(dpi: number): Promise<number> {
    const value = thermaltakeNearestDpi(dpi);
    await this.patchActiveProfile((current) => {
      const stages = [...current.dpiStages];
      stages[current.activeDpiStage] = value;
      return { dpiStages: stages };
    });
    return value;
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const value = thermaltakeNearestDpi(dpi);
    await this.patchActiveProfile((current) => {
      if (!Number.isInteger(stage) || stage < 0 || stage >= current.dpiStages.length) {
        throw new RangeError(`Invalid DPI stage ${stage + 1}.`);
      }
      const stages = [...current.dpiStages];
      stages[stage] = value;
      return { dpiStages: stages };
    });
    return value;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    await this.patchActiveProfile({ activeDpiStage: stage });
    return stage;
  }

  /** New stages take the value already stored in that slot of the four-stage table. */
  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > THERMALTAKE_DPI_MAX_STAGES) {
      throw new RangeError(`This mouse supports between 1 and ${THERMALTAKE_DPI_MAX_STAGES} DPI stages.`);
    }
    await this.patchActiveProfile((current) => ({
      dpiStages: current.dpiTable.slice(0, count).map((dpi) => (dpi > 0 ? dpi : THERMALTAKE_DPI_MIN)),
      activeDpiStage: Math.min(current.activeDpiStage, count - 1),
    }));
    return count;
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    await this.patchActiveProfile({ angleSnapping: enabled });
    return enabled;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    await this.patchActiveProfile({ debounceMs: milliseconds });
    return milliseconds;
  }

  private readShortStatus(): Promise<MouseStatus> {
    return this.run(async () => {
      if (this.firmware === null) this.firmware = await this.readFirmwareNow();
      const profile = await this.readActiveProfileNow();
      return {
        brand: "Thermaltake",
        name: this.displayName(),
        ui: {
          family: "thermaltake",
          settingsReady: false,
          hideSignalCard: true,
          hideSleepCard: true,
          hideProcessingCard: true,
          showAdvancedSection: true,
          statusNote: SHORT_NOTE,
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: 0,
        pollingRateHz: 0,
        activeProfile: profile + 1,
        profileCount: THERMALTAKE_PROFILE_COUNT,
        liftOffDistance: null,
        connectionType: "Wired",
        deviceMode: "Onboard",
        firmware: this.firmwareLabel(),
      };
    });
  }

  private firmwareLabel(): string[] {
    return this.firmware === null ? [] : [`Firmware V1.${String(this.firmware).padStart(3, "0")}`];
  }

  /** One-based, as the profile selector counts. Works on either channel. */
  setProfile(profile: number): Promise<number> {
    return this.run(async () => {
      const index = profile - 1;
      await this.command(thermaltakeCommands.writeActiveProfile(index), DELAY_MS.profileSwitch);
      await this.command(thermaltakeCommands.endWrite(), DELAY_MS.endWrite);
      const now = await this.readActiveProfileNow();
      if (now !== index) throw new Error(`The mouse stayed on profile ${now + 1}.`);
      return profile;
    });
  }

  /**
   * Reads the active profile fresh, applies the patch, writes the whole block
   * back the way the vendor tool does, then reads it again and fails unless
   * every byte matches.
   */
  private patchActiveProfile(
    patch: ThermaltakeSettingsPatch | ((current: ReturnType<typeof thermaltakeDecodeSettings>) => ThermaltakeSettingsPatch),
  ): Promise<void> {
    return this.run(async () => {
      if (this.channel !== "config") throw new Error(NEEDS_CONFIG);
      const profile = await this.readActiveProfileNow();
      const data = await this.readProfileNow(profile);
      const next = thermaltakeApplySettings(
        data,
        typeof patch === "function" ? patch(thermaltakeDecodeSettings(data)) : patch,
      );
      if (next.every((byte, i) => byte === data[i])) return;
      try {
        // Inside the try: a transport can apply the opening command and still
        // reject it, and the write window must be closed either way.
        await this.command(thermaltakeCommands.beginWrite(), DELAY_MS.beginWrite);
        await this.device.sendFeatureReport(THERMALTAKE_REPORT_ID.profile, thermaltakeEncodeProfileWrite(profile, next));
        await delay(DELAY_MS.flashWrite);
      } finally {
        await this.command(thermaltakeCommands.endWrite(), DELAY_MS.endWrite);
      }
      const stored = await this.readProfileNow(profile);
      if (!stored.every((byte, i) => byte === next[i])) {
        throw new Error("The mouse did not keep the new settings.");
      }
    });
  }

  private async readFirmwareNow(): Promise<number | null> {
    try {
      await this.command(thermaltakeCommands.readFirmware(), DELAY_MS.firmware);
      return thermaltakeDecodeFirmware(await this.receiveCommandReply(), this.channel ?? "config");
    } catch {
      return null;
    }
  }

  private async readActiveProfileNow(): Promise<number> {
    await this.command(thermaltakeCommands.readActiveProfile(), DELAY_MS.register);
    const profile = thermaltakeDecodeActiveProfile(await this.receiveCommandReply(), this.channel ?? "config");
    if (profile === null) throw new Error("The mouse did not report its active profile.");
    return profile;
  }

  private async readProfileNow(profile: number): Promise<Uint8Array> {
    await this.command(thermaltakeCommands.readProfile(profile), DELAY_MS.profileRead);
    const data = thermaltakeDecodeProfile(await this.receive(THERMALTAKE_REPORT_ID.profile), profile);
    if (!data) throw new Error(`The mouse returned a damaged copy of profile ${profile + 1}.`);
    return data;
  }

  private async command(payload: Uint8Array<ArrayBuffer>, waitMs: number): Promise<void> {
    if (this.channel === "config") await this.device.sendFeatureReport(THERMALTAKE_REPORT_ID.command, payload);
    else await this.device.sendFeatureReport(THERMALTAKE_SHORT_REPORT_ID, thermaltakeShortCommand(payload));
    await delay(waitMs);
  }

  private receiveCommandReply(): Promise<Uint8Array> {
    return this.receive(this.channel === "config" ? THERMALTAKE_REPORT_ID.command : THERMALTAKE_SHORT_REPORT_ID);
  }

  private async receive(reportId: number): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(reportId);
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.channel === null) throw new Error(UNREACHABLE_NOTE);
      await this.open();
      return action();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
