import {
  MCHOSE_A5_GEN1_DPI_MAX,
  MCHOSE_A5_GEN1_DPI_MIN,
  MCHOSE_A5_GEN1_DPI_STAGES,
  MCHOSE_A5_GEN1_DPI_STEP,
  MCHOSE_A5_GEN1_PRODUCTS,
  MCHOSE_A5_GEN1_PROFILE_COUNT,
  MCHOSE_A5_GEN1_RECEIVER_RATES,
  MCHOSE_A5_GEN1_USAGE_PAGE,
  MCHOSE_A5_GEN1_VENDOR_ID,
  MCHOSE_A5_GEN1_WIRED_RATES,
  mchoseA5Gen1DecodeDpi,
  mchoseA5Gen1DecodeFirmware,
  mchoseA5Gen1DecodeReply,
  mchoseA5Gen1EncodeDpi,
  mchoseA5Gen1EncodeRequest,
  mchoseA5Gen1NormalizeDpi,
  mchoseA5Gen1ReplyMatches,
} from "@openmouse/protocol/mchose";
import type { MouseStatus } from "../mouse-types.ts";

const POLLING_CODES = new Map([[125, 0x08], [250, 0x04], [500, 0x02], [1000, 0x01]]);
const POLLING_VALUES = new Map([...POLLING_CODES].map(([rate, code]) => [code, rate]));
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function flatten(collections: readonly HIDCollectionInfo[]): HIDCollectionInfo[] {
  return collections.flatMap((collection) => [collection, ...flatten(collection.children)]);
}

function featureReportIds(device: HIDDevice): number[] {
  return flatten(device.collections)
    .filter((collection) => collection.usagePage >= 0xff00)
    .flatMap((collection) => collection.featureReports.map((report) => report.reportId));
}

export class MchoseA5ProMaxHidClient {
  readonly device: HIDDevice;
  readonly reportId: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
    this.reportId = featureReportIds(device)[0] ?? 0;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === MCHOSE_A5_GEN1_VENDOR_ID
      && MCHOSE_A5_GEN1_PRODUCTS.has(device.productId)
      && flatten(device.collections).some((collection) =>
        collection.usagePage === MCHOSE_A5_GEN1_USAGE_PAGE && collection.featureReports.length > 0);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(): Promise<boolean> { return false; }
  displayName(): string { return MCHOSE_A5_GEN1_PRODUCTS.get(this.device.productId)?.name ?? "MCHOSE A5"; }
  isWireless(): boolean { return !this.isWired(); }
  getDpiOptions(): number[] { return []; }
  getSleepOptions(): number[] { return [0, 60, 120, 300, 600, 900, 1800]; }
  getDebounceMaxMs(): number { return 15; }

  private isWired(): boolean {
    return MCHOSE_A5_GEN1_PRODUCTS.get(this.device.productId)?.connection === "Wired";
  }

  private rates(): readonly number[] {
    return this.isWired() ? MCHOSE_A5_GEN1_WIRED_RATES : MCHOSE_A5_GEN1_RECEIVER_RATES;
  }

  private request(length: number, page: number, command: number, data: readonly number[] = [], route = 2): Promise<Uint8Array> {
    const run = async (): Promise<Uint8Array> => {
      await this.open();
      const payload = mchoseA5Gen1EncodeRequest({ length, page, command, data, route });
      await this.device.sendFeatureReport(this.reportId, payload);
      await delay(34);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const view = await this.device.receiveFeatureReport(this.reportId);
        const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const reply = mchoseA5Gen1DecodeReply(raw, this.reportId);
        if (mchoseA5Gen1ReplyMatches(reply, page, command)) return reply;
        if (attempt === 3) await this.device.sendFeatureReport(this.reportId, payload);
        await delay(30);
      }
      throw new Error(`The MCHOSE A5 did not acknowledge page 0x${page.toString(16)} command 0x${command.toString(16)}.`);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async optional<T>(read: () => Promise<T>): Promise<T | null> {
    try { return await read(); } catch { return null; }
  }

  private async readDpi(profile: number): Promise<{ active: number; stages: number[] }> {
    const table = mchoseA5Gen1DecodeDpi(await this.request(10, 1, 0x81, [profile, MCHOSE_A5_GEN1_DPI_STAGES]));
    const activeReply = await this.request(2, 1, 0x82, [profile]);
    return { active: Math.max(1, Math.min(table.count, activeReply[7] || 1)), stages: table.stages };
  }

  async readStatus(): Promise<MouseStatus> {
    const firmware = await this.optional(async () => mchoseA5Gen1DecodeFirmware(await this.request(16, 0, 0x81)));
    const batteryReply = await this.optional(() => this.request(2, 0, 0x83));
    const profileReply = await this.optional(() => this.request(1, 0, 0x85));
    const profile = profileReply?.[6] || 1;
    const pollingReply = await this.optional(() => this.request(1, 1, 0x80));
    const dpi = await this.optional(() => this.readDpi(profile));
    const sleepReply = await this.optional(() => this.request(2, 0, 0x87));
    const debounceReply = await this.optional(() => this.request(2, 0, 0x88, [profile]));
    const lodReply = await this.optional(() => this.request(1, 1, 0x88));
    const motionReply = await this.optional(() => this.request(1, 1, 0x89));
    const angleReply = await this.optional(() => this.request(1, 1, 0x84));
    const rippleReply = await this.optional(() => this.request(1, 1, 0x8a));
    const activeIndex = Math.max(0, (dpi?.active ?? 1) - 1);
    const rates = this.rates();
    const product = MCHOSE_A5_GEN1_PRODUCTS.get(this.device.productId);

    return {
      brand: "MCHOSE",
      name: product?.name ?? this.displayName(),
      batteryPercent: batteryReply ? Math.min(100, batteryReply[7] ?? 0) : null,
      batteryState: batteryReply?.[6] ? "Charging" : batteryReply ? "Discharging" : "Unknown",
      dpi: dpi?.stages[activeIndex] ?? 0,
      dpiStages: dpi?.stages,
      activeDpiStage: dpi ? activeIndex : undefined,
      pollingRateHz: pollingReply ? (POLLING_VALUES.get(pollingReply[6] ?? 0) ?? 0) : 0,
      supportedPollingRates: [...rates],
      activeProfile: profileReply ? profile : null,
      profileCount: profileReply ? MCHOSE_A5_GEN1_PROFILE_COUNT : undefined,
      debounceMs: debounceReply?.[7] ?? null,
      sleepTimeout: sleepReply ? ((sleepReply[6] ?? 0) << 8) | (sleepReply[7] ?? 0) : null,
      liftOffDistance: lodReply ? ((lodReply[6] ?? 1) === 2 ? "High" : "Low") : null,
      supportedLiftOffDistances: ["Low", "High"],
      motionSync: motionReply ? (motionReply[6] ?? 0) > 0 : null,
      angleSnapping: angleReply ? (angleReply[6] ?? 0) > 0 : null,
      rippleControl: rippleReply ? (rippleReply[6] ?? 0) > 0 : null,
      connectionType: product?.connection,
      connectionDetail: this.isWired() ? "Wired USB" : "2.4 GHz receiver",
      firmware: firmware ? [`Mouse ${firmware}`] : [],
      ui: {
        family: "mchose-a5-gen1",
        settingsReady: Boolean(dpi && pollingReply),
        valuesVerified: Boolean(dpi && pollingReply),
        defaultDisplayName: "MCHOSE A5 Pro Max",
        forceShowBattery: true,
        hideSignalCard: true,
        hideUnsupportedPollingRates: true,
        showAdvancedSection: true,
        pollingNote: this.isWired()
          ? "The first-generation wired firmware supports 125, 500 and 1000 Hz."
          : "Applies to the connected 2.4 GHz receiver.",
        dpiStageEditor: {
          maxStages: MCHOSE_A5_GEN1_DPI_STAGES,
          countEditable: true,
          minDpi: MCHOSE_A5_GEN1_DPI_MIN,
          maxDpi: MCHOSE_A5_GEN1_DPI_MAX,
          stepDpi: MCHOSE_A5_GEN1_DPI_STEP,
        },
      },
    };
  }

  async setPollingRate(hertz: number): Promise<void> {
    if (!this.rates().includes(hertz as never)) throw new Error(`This connection does not support ${hertz} Hz.`);
    const code = POLLING_CODES.get(hertz);
    if (!code) throw new Error(`Unsupported polling rate ${hertz}.`);
    await this.request(1, 1, 0x00, [code]);
    const confirmed = POLLING_VALUES.get((await this.request(1, 1, 0x80))[6] ?? 0);
    if (confirmed !== hertz) throw new Error("The mouse did not confirm the polling-rate change.");
  }

  async setProfile(profile: number): Promise<void> {
    if (!Number.isInteger(profile) || profile < 1 || profile > MCHOSE_A5_GEN1_PROFILE_COUNT) throw new Error("Profile must be 1-3.");
    await this.request(1, 0, 0x05, [profile]);
    if (((await this.request(1, 0, 0x85))[6] || 1) !== profile) throw new Error("The mouse did not confirm the profile change.");
  }

  async setDpiStageValue(stage: number, value: number): Promise<void> {
    const profile = (await this.request(1, 0, 0x85))[6] || 1;
    const current = await this.readDpi(profile);
    if (!Number.isInteger(stage) || stage < 0 || stage >= current.stages.length) throw new Error(`DPI stage must be 0-${current.stages.length - 1}.`);
    const stages = [...current.stages];
    stages[stage] = value;
    await this.writeDpi(profile, stages, current.active);
  }

  async setActiveDpiStage(stage: number): Promise<void> {
    const profile = (await this.request(1, 0, 0x85))[6] || 1;
    const current = await this.readDpi(profile);
    if (!Number.isInteger(stage) || stage < 0 || stage >= current.stages.length) throw new Error(`DPI stage must be 0-${current.stages.length - 1}.`);
    await this.request(2, 1, 0x02, [profile, stage + 1]);
    if ((await this.readDpi(profile)).active !== stage + 1) throw new Error("The mouse did not confirm the active DPI stage.");
  }

  async setDpiStageCount(count: number): Promise<void> {
    const profile = (await this.request(1, 0, 0x85))[6] || 1;
    const current = await this.readDpi(profile);
    if (!Number.isInteger(count) || count < 1 || count > MCHOSE_A5_GEN1_DPI_STAGES) throw new Error("DPI stage count must be 1-6.");
    const stages = [...current.stages];
    while (stages.length < count) stages.push(stages.at(-1) ?? 800);
    await this.writeDpi(profile, stages.slice(0, count), Math.min(current.active, count));
  }

  private async writeDpi(profile: number, stages: readonly number[], active: number): Promise<void> {
    const data = mchoseA5Gen1EncodeDpi(profile, stages);
    await this.request(data.length, 1, 0x01, data);
    await this.request(2, 1, 0x02, [profile, active]);
    const confirmed = await this.readDpi(profile);
    const expected = stages.slice(0, MCHOSE_A5_GEN1_DPI_STAGES).map(mchoseA5Gen1NormalizeDpi);
    if (confirmed.stages.length !== expected.length || confirmed.stages.some((value, index) => value !== expected[index])) {
      throw new Error("The mouse did not confirm the DPI change.");
    }
  }

  async setDpi(value: number): Promise<void> {
    const profile = (await this.request(1, 0, 0x85))[6] || 1;
    const current = await this.readDpi(profile);
    await this.setDpiStageValue(current.active - 1, value);
  }

  async setSleepTimeout(seconds: number): Promise<void> {
    const value = Math.max(0, Math.min(0xffff, Math.round(seconds)));
    await this.request(2, 0, 0x07, [(value >> 8) & 0xff, value & 0xff]);
  }

  async setDebounceTime(milliseconds: number): Promise<void> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 15) throw new Error("Debounce must be 0-15 ms.");
    const profile = (await this.request(1, 0, 0x85))[6] || 1;
    await this.request(2, 0, 0x08, [profile, milliseconds]);
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<void> {
    await this.request(1, 1, 0x08, [value === "High" ? 2 : 1]);
  }

  async setMotionSync(enabled: boolean): Promise<void> { await this.request(1, 1, 0x09, [enabled ? 1 : 0]); }
  async setAngleSnapping(enabled: boolean): Promise<void> { await this.request(1, 1, 0x04, [enabled ? 1 : 0]); }
  async setRippleControl(enabled: boolean): Promise<void> { await this.request(1, 1, 0x0a, [enabled ? 1 : 0]); }
}
