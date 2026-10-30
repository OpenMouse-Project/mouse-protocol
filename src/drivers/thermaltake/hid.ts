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
  THERMALTAKE_VENDOR_ID,
  thermaltakeApplySettings,
  thermaltakeCommands,
  thermaltakeDecodeActiveProfile,
  thermaltakeDecodeFirmware,
  thermaltakeDecodeProfile,
  thermaltakeDecodeSettings,
  thermaltakeEncodeProfileWrite,
  thermaltakeNearestDpi,
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

export function thermaltakeExposesConfigChannel(device: HIDDevice): boolean {
  return device.collections.some(hasConfigCollection);
}

const UNREACHABLE_NOTE = "Status only: the settings collection declares only constant items, so Chrome on "
  + "Windows hides it and cannot send it reports. Run OpenMouse Bridge to change settings.";

/**
 * Tt eSPORTS Iris Optical RGB and its Hatsune Miku Edition over the 2052-byte
 * feature reports of the LED-page config collection (see
 * `@openmouse/protocol/thermaltake`). Settings live in five onboard profiles;
 * every change rewrites the active profile whole, keeping the bytes it does
 * not touch (lighting, buttons, name), and is read back before it counts.
 *
 * The config collection holds only constant items, so Windows reports no
 * caps for it and Chrome on Windows drops it, leaving just the consumer
 * collection: the same wall as the Delux M600 Pro
 * (docs/thermaltake-iris-testing.md). That device is still claimed so the
 * user learns why, but it reports identity only. OpenMouse Bridge lists the
 * collection without reports and reaches it natively.
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

  private get settingsReachable(): boolean {
    return thermaltakeExposesConfigChannel(this.device);
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
    if (!this.settingsReachable) {
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
        firmware: this.firmware === null ? [] : [`Firmware V1.${String(this.firmware).padStart(3, "0")}`],
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

  /** One-based, as the profile selector counts. */
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
      const profile = await this.readActiveProfileNow();
      const data = await this.readProfileNow(profile);
      const next = thermaltakeApplySettings(
        data,
        typeof patch === "function" ? patch(thermaltakeDecodeSettings(data)) : patch,
      );
      if (next.every((byte, i) => byte === data[i])) return;
      await this.command(thermaltakeCommands.beginWrite(), DELAY_MS.beginWrite);
      try {
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
      return thermaltakeDecodeFirmware(await this.receive(THERMALTAKE_REPORT_ID.command));
    } catch {
      return null;
    }
  }

  private async readActiveProfileNow(): Promise<number> {
    await this.command(thermaltakeCommands.readActiveProfile(), DELAY_MS.register);
    const profile = thermaltakeDecodeActiveProfile(await this.receive(THERMALTAKE_REPORT_ID.command));
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
    await this.device.sendFeatureReport(THERMALTAKE_REPORT_ID.command, payload);
    await delay(waitMs);
  }

  private async receive(reportId: number): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(reportId);
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (!this.settingsReachable) throw new Error(UNREACHABLE_NOTE);
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
