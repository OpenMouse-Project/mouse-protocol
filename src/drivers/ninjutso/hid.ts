import type { MouseStatus } from "../mouse-types.ts";
import {
  NINJUTSO_COMMAND,
  NINJUTSO_CONTROL_PAYLOAD_LENGTH,
  NINJUTSO_CONTROL_REPORT_ID,
  NINJUTSO_LEGACY_MOUSE_PRODUCT_IDS,
  NINJUTSO_LEGACY_PAYLOAD_LENGTH,
  NINJUTSO_LEGACY_RECEIVER_PRODUCT_IDS,
  NINJUTSO_LEGACY_REPORT_ID,
  NINJUTSO_LEGACY_VENDOR_ID,
  NINJUTSO_MOUSE_PRODUCT_IDS,
  NINJUTSO_POLLING_RATES,
  NINJUTSO_RECEIVER_PRODUCT_IDS,
  NINJUTSO_REPORT_ID,
  NINJUTSO_VENDOR_ID,
  ninjutsoBuildRequest,
  ninjutsoDecodeDpi,
  ninjutsoDecodePollingRate,
  ninjutsoEncodeDpi,
  ninjutsoEncodePollingRate,
  ninjutsoLegacyDecodeDpi,
  ninjutsoLegacyEncodeDpi,
  ninjutsoLegacyRequest,
  ninjutsoResponseValue,
} from "@openmouse/protocol/ninjutso";

const CURRENT_IDS = new Set<number>([...NINJUTSO_MOUSE_PRODUCT_IDS, ...NINJUTSO_RECEIVER_PRODUCT_IDS]);
const LEGACY_IDS = new Set<number>([...NINJUTSO_LEGACY_MOUSE_PRODUCT_IDS, ...NINJUTSO_LEGACY_RECEIVER_PRODUCT_IDS]);
const CURRENT_RECEIVERS = new Set<number>(NINJUTSO_RECEIVER_PRODUCT_IDS);
const LEGACY_RECEIVERS = new Set<number>(NINJUTSO_LEGACY_RECEIVER_PRODUCT_IDS);
const SORA_V3_IDS = new Set<number>([0xe010, 0xeb02]);
const SORA_V2_3950_IDS = new Set<number>([0xae14, 0xae15, 0xae16]);
const LEGACY_HIGH_RATE_RECEIVERS = new Set<number>([0xae8c, 0xae8a]);
const LOD_VALUES = ["Low", "Medium", "High"] as const;
const SLEEP_OPTIONS = Array.from({ length: 15 }, (_, index) => (index + 1) * 60);

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

/**
 * NinjaForce-derived WebHID implementation for Sora V2/V3 and TEN-family mice.
 * Packet layouts are public and deterministic; hardware verification is still pending.
 */
export class NinjutsoHidClient {
  readonly canDisableSleep = false;
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus: MouseStatus | null = null;
  private profile = 1;
  private effectiveProductId: number | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId === NINJUTSO_VENDOR_ID && CURRENT_IDS.has(device.productId)) {
      return hasFeatureReport(device.collections, NINJUTSO_REPORT_ID);
    }
    if (device.vendorId === NINJUTSO_LEGACY_VENDOR_ID && LEGACY_IDS.has(device.productId)) {
      return hasFeatureReport(device.collections, NINJUTSO_LEGACY_REPORT_ID)
        && hasFeatureReport(device.collections, 4);
    }
    return false;
  }

  get pollIntervalMs(): number {
    return this.isWireless() ? 10_000 : 30_000;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastStatus = null;
    this.effectiveProductId = null;
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(_onChange?: () => void): Promise<boolean> {
    return false;
  }

  isLegacy(): boolean {
    return this.device.vendorId === NINJUTSO_LEGACY_VENDOR_ID;
  }

  isWireless(): boolean {
    return (this.isLegacy() ? LEGACY_RECEIVERS : CURRENT_RECEIVERS).has(this.device.productId);
  }

  displayName(): string {
    if (this.isWireless() && this.effectiveProductId !== null) {
      if (this.isLegacy()) return "Ninjutso Sora V2";
      return SORA_V3_IDS.has(this.effectiveProductId) ? "Ninjutso Sora V3" : "Ninjutso TEN / TEN AIR";
    }
    const reported = this.device.productName?.trim();
    if (reported && !/^usb (input|hid)/i.test(reported)) return reported;
    if (this.isLegacy()) return "Ninjutso Sora V2";
    if (SORA_V3_IDS.has(this.effectiveProductId ?? this.device.productId)) return "Ninjutso Sora V3";
    return "Ninjutso TEN / TEN AIR";
  }

  getDpiOptions(): number[] {
    const direct = !this.isLegacy() && SORA_V3_IDS.has(this.effectiveProductId ?? this.device.productId);
    const max = direct ? 45_000 : this.isLegacy() ? 30_000 : 30_000;
    const step = direct ? 1 : 50;
    return Array.from({ length: Math.floor(max / step) }, (_, index) => (index + 1) * step);
  }

  getSupportedPollingRates(): number[] {
    if (!this.isLegacy()) return [...NINJUTSO_POLLING_RATES];
    return LEGACY_HIGH_RATE_RECEIVERS.has(this.device.productId) ? [1000, 2000, 4000, 8000] : [1000];
  }

  getSleepOptions(): readonly number[] {
    return this.isLegacy() ? [] : SLEEP_OPTIONS;
  }

  getDebounceMaxMs(): number {
    // NinjaForce exposes this byte as three Slam-Click levels, not milliseconds.
    return 0;
  }

  async readStatus(_live = false): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const status = this.isLegacy() ? await this.readLegacyStatus() : await this.readCurrentStatus();
      this.lastStatus = status;
      return status;
    });
  }

  async setDpi(dpi: number): Promise<number> {
    return await this.run(async () => {
      await this.open();
      return this.isLegacy() ? await this.setLegacyDpi(dpi) : await this.setCurrentDpi(dpi);
    });
  }

  async setPollingRate(rate: number): Promise<number> {
    return await this.run(async () => {
      await this.open();
      if (!this.getSupportedPollingRates().includes(rate)) throw new Error(`This Ninjutso connection does not support ${rate} Hz.`);
      if (this.isLegacy()) {
        await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(ninjutsoLegacyRequest(10, this.profile, Math.log2(rate / 1000))));
        const confirmed = this.legacyRate((await this.readLegacySettings()).data[24]!);
        if (confirmed !== rate) throw new Error(`The mouse kept ${confirmed} Hz instead of ${rate} Hz.`);
        this.patch({ pollingRateHz: confirmed });
        return confirmed;
      }
      await this.sendCurrent(NINJUTSO_COMMAND.setPollingRate, [ninjutsoEncodePollingRate(rate)]);
      const confirmed = ninjutsoDecodePollingRate((await this.readCurrent(NINJUTSO_COMMAND.pollingRate))[0]!) ?? 0;
      if (confirmed !== rate) throw new Error(`The mouse kept ${confirmed} Hz instead of ${rate} Hz.`);
      this.patch({ pollingRateHz: confirmed });
      return confirmed;
    });
  }

  async setLiftOffDistance(value: LiftOffDistance): Promise<LiftOffDistance> {
    return await this.run(async () => {
      await this.open();
      const code = LOD_VALUES.indexOf(value);
      if (code < 0) throw new Error(`Unsupported lift-off distance: ${value}.`);
      if (this.isLegacy()) {
        const effective = await this.ensureEffectiveProductId();
        if (!SORA_V2_3950_IDS.has(effective) && code === 0) throw new Error("This Sora V2 supports Medium or High lift-off distance only.");
        await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(ninjutsoLegacyRequest(11, this.profile, code)));
        const confirmed = this.decodeLod((await this.readLegacySettings()).data[22]!);
        if (confirmed !== value) throw new Error(`The mouse kept ${confirmed} lift-off distance instead of ${value}.`);
        this.patch({ liftOffDistance: confirmed });
        return confirmed;
      }
      await this.sendCurrent(NINJUTSO_COMMAND.setLiftOffDistance, [code]);
      const confirmed = this.decodeLod((await this.readCurrent(NINJUTSO_COMMAND.liftOffDistance))[0]!);
      if (confirmed !== value) throw new Error(`The mouse kept ${confirmed} lift-off distance instead of ${value}.`);
      this.patch({ liftOffDistance: confirmed });
      return confirmed;
    });
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return await this.run(async () => {
      await this.open();
      if (this.isLegacy()) {
        await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(ninjutsoLegacyRequest(6, this.profile, enabled ? 1 : 0)));
        const confirmed = (await this.readLegacySettings()).data[23] === 1;
        if (confirmed !== enabled) throw new Error(`The mouse left Motion Sync ${confirmed ? "on" : "off"}.`);
        this.patch({ motionSync: confirmed });
        return confirmed;
      }
      await this.sendCurrent(NINJUTSO_COMMAND.setMotionSync, [enabled ? 1 : 0]);
      const confirmed = (await this.readCurrent(NINJUTSO_COMMAND.motionSync))[0] === 1;
      if (confirmed !== enabled) throw new Error(`The mouse left Motion Sync ${confirmed ? "on" : "off"}.`);
      this.patch({ motionSync: confirmed });
      return confirmed;
    });
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    return await this.run(async () => {
      if (this.isLegacy()) throw new Error("Sora V2 does not expose a sleep timer in NinjaForce.");
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 900 || seconds % 60 !== 0) {
        throw new Error("Ninjutso sleep timeout must be 1–15 minutes.");
      }
      await this.open();
      await this.sendCurrent(NINJUTSO_COMMAND.setSleepMinutes, [seconds / 60]);
      const confirmed = (await this.readCurrent(NINJUTSO_COMMAND.sleepMinutes))[0]! * 60;
      if (confirmed !== seconds) throw new Error(`The mouse kept a ${confirmed} second sleep timeout instead of ${seconds}.`);
      this.patch({ sleepTimeout: confirmed });
      return confirmed;
    });
  }

  private async readCurrentStatus(): Promise<MouseStatus> {
    const effective = await this.ensureEffectiveProductId();
    this.profile = (await this.readCurrent(NINJUTSO_COMMAND.profile))[0] || 1;
    const stage = (await this.readCurrent(NINJUTSO_COMMAND.activeDpiStage))[0] ?? 0;
    const direct = SORA_V3_IDS.has(effective);
    // Feature replies share one report id, so keep request/response pairs ordered.
    const battery = await this.readCurrent(NINJUTSO_COMMAND.batteryPercent);
    const charging = await this.readCurrent(NINJUTSO_COMMAND.batteryCharging);
    const dpi = await this.readCurrent(NINJUTSO_COMMAND.dpi, [stage]);
    const polling = await this.readCurrent(NINJUTSO_COMMAND.pollingRate);
    const lod = await this.readCurrent(NINJUTSO_COMMAND.liftOffDistance);
    const motion = await this.readCurrent(NINJUTSO_COMMAND.motionSync);
    const angle = await this.readCurrent(NINJUTSO_COMMAND.angleTuning);
    const sleep = await this.readCurrent(NINJUTSO_COMMAND.sleepMinutes);
    const firmware = await this.readCurrent(NINJUTSO_COMMAND.firmware, [0]);
    const batteryPercent = Math.min(battery[0] ?? 0, 100);
    const firmwareValues = [`Mouse ${this.decodeFirmware(firmware)}`];
    if (this.isWireless()) {
      const receiverVersion = await this.readCurrent(NINJUTSO_COMMAND.firmware, [1]);
      firmwareValues.push(`Receiver ${this.decodeFirmware(receiverVersion)}`);
    }
    const pollingRateHz = ninjutsoDecodePollingRate(polling[0]!) ?? 1000;
    const supportedLiftOffDistances: LiftOffDistance[] = [...LOD_VALUES];
    return {
      brand: "Ninjutso",
      name: this.displayName(),
      ui: {
        family: "ninjutso",
        hideUnsupportedPollingRates: true,
        hideSignalCard: true,
        hideAngleSnapping: true,
        hideRippleControl: true,
        showAdvancedSection: true,
        forceShowBattery: true,
        defaultDisplayName: this.displayName(),
        pollingNote: "NinjaForce exposes 1,000–8,000 Hz on this protocol.",
      },
      batteryPercent,
      batteryState: charging[0] ? "Charging" : "Discharging",
      dpi: ninjutsoDecodeDpi(dpi[0]!, dpi[1]!, dpi[2]!, direct),
      pollingRateHz,
      supportedPollingRates: [...NINJUTSO_POLLING_RATES],
      activeProfile: this.profile,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      connectionDetail: this.isWireless() ? "2.4 GHz receiver · NinjaForce protocol" : "USB · NinjaForce protocol",
      motionSync: motion[0] === 1,
      debounceMs: null,
      sleepTimeout: (sleep[0] ?? 0) * 60 || null,
      angleTuning: this.signedByte(angle[0] ?? 0),
      angleSnapping: null,
      rippleControl: null,
      liftOffDistance: this.decodeLod(lod[0]!),
      supportedLiftOffDistances,
      firmware: firmwareValues,
    };
  }

  private async readLegacyStatus(): Promise<MouseStatus> {
    const effective = await this.ensureEffectiveProductId();
    const settings = await this.readLegacySettings();
    const data = settings.data;
    this.profile = settings.profile;
    const stageCount = Math.min(Math.max(data[11] ?? 1, 1), 4);
    const stage = Math.min(data[20] ?? 0, stageCount - 1);
    const dpiOffset = 12 + stage * 2;
    const rate = LEGACY_HIGH_RATE_RECEIVERS.has(this.device.productId) ? this.legacyRate(data[24] ?? 0) : 1000;
    const supportsUltraLow = SORA_V2_3950_IDS.has(effective);
    return {
      brand: "Ninjutso",
      name: this.displayName(),
      ui: {
        family: "ninjutso",
        hideUnsupportedPollingRates: true,
        hideSignalCard: true,
        hideSleepCard: true,
        hideAngleSnapping: true,
        hideRippleControl: true,
        showAdvancedSection: true,
        forceShowBattery: true,
        defaultDisplayName: "Ninjutso Sora V2",
        pollingNote: "Polling options follow the connected Sora V2 receiver generation.",
      },
      batteryPercent: Math.min(data[7] ?? 0, 100),
      batteryState: this.isWireless() ? data[8] === 1 ? "Charging" : "Discharging" : "Unknown",
      dpi: ninjutsoLegacyDecodeDpi(data[dpiOffset]!, data[dpiOffset + 1]!),
      pollingRateHz: rate,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: this.profile,
      connectionType: this.isWireless() ? "Wireless" : "Wired",
      connectionDetail: this.isWireless() ? "2.4 GHz receiver · Sora V2 protocol" : "USB · Sora V2 protocol",
      motionSync: data[23] === 1,
      debounceMs: null,
      sleepTimeout: null,
      angleTuning: supportsUltraLow ? this.signedByte(data[26] ?? 0) : null,
      angleSnapping: null,
      rippleControl: null,
      liftOffDistance: this.decodeLod(data[22]!),
      supportedLiftOffDistances: supportsUltraLow ? [...LOD_VALUES] : ["Medium", "High"],
      firmware: await this.readLegacyFirmware(),
    };
  }

  private async setCurrentDpi(dpi: number): Promise<number> {
    const effective = await this.ensureEffectiveProductId();
    this.profile = (await this.readCurrent(NINJUTSO_COMMAND.profile))[0] || 1;
    const stage = (await this.readCurrent(NINJUTSO_COMMAND.activeDpiStage))[0] ?? 0;
    const direct = SORA_V3_IDS.has(effective);
    const encoded = ninjutsoEncodeDpi(dpi, direct);
    await this.setControl(false);
    try {
      await this.sendCurrent(NINJUTSO_COMMAND.setDpi, [stage, ...encoded]);
    } finally {
      await this.setControl(true);
    }
    const value = await this.readCurrent(NINJUTSO_COMMAND.dpi, [stage]);
    const confirmed = ninjutsoDecodeDpi(value[0]!, value[1]!, value[2]!, direct);
    if (confirmed !== dpi) throw new Error(`The mouse kept ${confirmed} DPI instead of ${dpi} DPI.`);
    this.patch({ dpi: confirmed });
    return confirmed;
  }

  private async setLegacyDpi(dpi: number): Promise<number> {
    const settings = await this.readLegacySettings();
    const stageCount = Math.min(Math.max(settings.data[11] ?? 1, 1), 4);
    const stage = Math.min(settings.data[20] ?? 0, stageCount - 1);
    const stages = Array.from({ length: 4 }, (_, index) => {
      const offset = 12 + index * 2;
      return ninjutsoLegacyDecodeDpi(settings.data[offset]!, settings.data[offset + 1]!);
    });
    stages[stage] = dpi;
    const payload = ninjutsoLegacyRequest(5, settings.profile);
    payload[8] = stageCount;
    stages
      .flatMap((value, index) => index < stageCount ? ninjutsoLegacyEncodeDpi(value) : [0, 0])
      .forEach((value, index) => payload[9 + index] = value);
    await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(payload));
    const confirmedSettings = await this.readLegacySettings();
    const offset = 12 + stage * 2;
    const confirmed = ninjutsoLegacyDecodeDpi(confirmedSettings.data[offset]!, confirmedSettings.data[offset + 1]!);
    if (confirmed !== dpi) throw new Error(`The mouse kept ${confirmed} DPI instead of ${dpi} DPI.`);
    this.patch({ dpi: confirmed });
    return confirmed;
  }

  private async ensureEffectiveProductId(): Promise<number> {
    if (this.effectiveProductId !== null) return this.effectiveProductId;
    if (!this.isWireless()) return this.effectiveProductId = this.device.productId;
    if (this.isLegacy()) {
      const payload = new Uint8Array(NINJUTSO_LEGACY_PAYLOAD_LENGTH);
      payload.set([40, 0, 0, 1, 0, 0, 2]);
      await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(payload));
      await delay(5);
      const response = await this.device.receiveFeatureReport(NINJUTSO_LEGACY_REPORT_ID);
      return this.effectiveProductId = response.getUint8(10) << 8 | response.getUint8(9);
    }
    const response = await this.readCurrent(NINJUTSO_COMMAND.pairedProductId);
    return this.effectiveProductId = response[1]! << 8 | response[0]!;
  }

  private async readCurrent(command: number, args: readonly number[] = []): Promise<Uint8Array> {
    const profileCommands = new Set<number>([
      NINJUTSO_COMMAND.activeDpiStage,
      NINJUTSO_COMMAND.dpi,
      NINJUTSO_COMMAND.pollingRate,
      NINJUTSO_COMMAND.liftOffDistance,
      NINJUTSO_COMMAND.angleTuning,
      NINJUTSO_COMMAND.motionSync,
      NINJUTSO_COMMAND.sleepMinutes,
    ]);
    const request = ninjutsoBuildRequest(command, profileCommands.has(command) ? this.profile : 0, args);
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.device.sendFeatureReport(NINJUTSO_REPORT_ID, buffer(request));
      await delay(attempt === 0 ? 30 : 60);
      const response = await this.device.receiveFeatureReport(NINJUTSO_REPORT_ID);
      const value = ninjutsoResponseValue(response, command);
      if (value) return value;
    }
    throw new Error(`The Ninjutso mouse did not answer command 0x${command.toString(16)}.`);
  }

  private async sendCurrent(command: number, args: readonly number[]): Promise<void> {
    await this.device.sendFeatureReport(NINJUTSO_REPORT_ID, buffer(ninjutsoBuildRequest(command, this.profile, args)));
  }

  private async setControl(resume: boolean): Promise<void> {
    const payload = new Uint8Array(NINJUTSO_CONTROL_PAYLOAD_LENGTH);
    payload.set(resume ? [28, 27, 0, 0, 1] : [27, 26, 0, 0, 1]);
    await this.device.sendFeatureReport(NINJUTSO_CONTROL_REPORT_ID, buffer(payload));
    await delay(30);
  }

  private async readLegacySettings(): Promise<{ profile: number; data: Uint8Array }> {
    const profileRequest = ninjutsoLegacyRequest(13);
    await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(profileRequest));
    await delay(15);
    let profileReply = await this.device.receiveFeatureReport(NINJUTSO_LEGACY_REPORT_ID);
    if (profileReply.getUint8(9) === 0) {
      await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(profileRequest));
      await delay(15);
      profileReply = await this.device.receiveFeatureReport(NINJUTSO_LEGACY_REPORT_ID);
    }
    const profile = profileReply.getUint8(9);
    const compact = this.device.productName === "Ninjutso Sora V2 8K";
    const payloadLength = compact ? 73 : 703;
    const request = new Uint8Array(payloadLength);
    request.set([38, 0, 0, 1, 0, profile]);
    await this.device.sendFeatureReport(4, buffer(request));
    await delay(90);
    const response = await this.device.receiveFeatureReport(4);
    const bytes = new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
    const sumEnd = compact ? 71 : 701;
    const checksumOffset = compact ? 72 : 702;
    const sum = bytes.slice(0, sumEnd).reduce((total, value) => total + value, 0);
    const expected = ((bytes[checksumOffset + 1] ?? 0) << 8) | (bytes[checksumOffset] ?? 0);
    if (sum !== expected) throw new Error("The Sora V2 settings checksum did not match.");
    return { profile, data: bytes.slice(9) };
  }

  private async readLegacyFirmware(): Promise<string[]> {
    const read = async (selector: number): Promise<string> => {
      const request = ninjutsoLegacyRequest(9);
      request[6] = selector;
      await this.device.sendFeatureReport(NINJUTSO_LEGACY_REPORT_ID, buffer(request));
      await delay(15);
      const response = await this.device.receiveFeatureReport(NINJUTSO_LEGACY_REPORT_ID);
      return [12, 11, 10, 9].map((offset) => response.getUint8(offset).toString(16).padStart(2, "0")).join("").toUpperCase();
    };
    const versions = [`Mouse ${await read(this.isWireless() ? 0 : 4)}`];
    if (this.isWireless()) versions.push(`Receiver ${await read(4)}`);
    return versions;
  }

  private decodeFirmware(bytes: Uint8Array): string {
    return [...bytes.slice(0, 3)].reverse().map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  private legacyRate(code: number): number {
    return [1000, 2000, 4000, 8000][code] ?? 1000;
  }

  private decodeLod(code: number): LiftOffDistance {
    return LOD_VALUES[code] ?? "Medium";
  }

  private signedByte(value: number): number {
    return value >= 0x80 ? value - 0x100 : value;
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return await started;
  }
}

function hasFeatureReport(collections: readonly HIDCollectionInfo[], reportId: number): boolean {
  return collections.some((collection) =>
    collection.featureReports.some((report) => report.reportId === reportId)
    || hasFeatureReport(collection.children, reportId));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buffer(payload: Uint8Array): ArrayBuffer {
  return new Uint8Array(payload).buffer;
}
