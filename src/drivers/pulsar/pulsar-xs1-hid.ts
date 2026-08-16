import type { MouseStatus } from "../mouse-types.ts";
import {
  PULSAR_CONFIG_REPORT_ID as CONFIG_REPORT_ID,
  PULSAR_VENDOR_ID,
  PULSAR_XS1_DEBOUNCE_MAX_MS as DEBOUNCE_MAX_MS,
  PULSAR_XS1_FEATURE_REPORT_ID as REPORT_ID,
  PULSAR_XS1_PACKET_LENGTH as PACKET_LENGTH,
  PULSAR_XS1_POLLING_RATES as POLLING_RATES,
  PULSAR_XS1_PRODUCT_IDS,
  PULSAR_XS1_WIRELESS_PRODUCT_IDS,
  pulsarXs1DecodePollingRate,
  pulsarXs1DpiOptions,
  pulsarXs1EncodeRequest,
  readUint16LE,
} from "@openmouse/protocol/pulsar";

export interface PulsarXs1DeviceInfo {
  connection: "Wired" | "Wireless";
  maximumPollingRateHz: number;
}

type LiftOffDistance = NonNullable<MouseStatus["liftOffDistance"]>;

const RESPONSE_ATTEMPTS = 5;
const RESPONSE_DELAY_MS = 25;
const DPI_VALUE_OFFSET = 7;

// The X3 family dongles report a generic "1K Dongle" product name from WebHID,
// which is useless in the UI. Known product ids map to the paired model name.
const XS1_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [0x5402, "Pulsar X3 M"],
]);

const LIFT_OFF_DISTANCES: ReadonlyArray<readonly [number, LiftOffDistance]> = [
  [0x07, "Low"],
  [0x0a, "Medium"],
  [0x14, "High"],
];

const QUERY = {
  version: [0x01, 0x87, 0x04],
  dpi: [0x05, 0x82, 0x05],
  stage: [0x05, 0x81, 0x02],
  motionSync: [0x07, 0x85, 0x02],
  rippleControl: [0x07, 0x83, 0x02],
  angleSnapping: [0x07, 0x84, 0x02],
  liftOffDistance: [0x07, 0x82, 0x03],
  debounce: [0x04, 0x83, 0x03],
  battery: [0x08, 0x81, 0x01],
  pollingRate: [0x08, 0x85, 0x03],
};

const WRITE = {
  dpi: (dpi: number): readonly number[] => [
    0x05, 0x02, 0x05, 0x00, 0x00, 0x01,
    dpi & 0xff, dpi >> 8, dpi & 0xff, dpi >> 8,
  ],
  stage: (stage: number): readonly number[] => [0x05, 0x01, 0x02, 0x00, 0x00, 0x01, stage],
  motionSync: (enabled: boolean): readonly number[] => [0x07, 0x05, 0x02, 0x00, 0x00, 0x01, enabled ? 1 : 0],
  rippleControl: (enabled: boolean): readonly number[] => [0x07, 0x03, 0x02, 0x00, 0x00, 0x01, enabled ? 1 : 0],
  angleSnapping: (enabled: boolean): readonly number[] => [0x07, 0x04, 0x02, 0x00, 0x00, 0x01, enabled ? 1 : 0],
  liftOffDistance: (value: number): readonly number[] => [0x07, 0x02, 0x03, 0x00, 0x00, 0x01, 0x02, value],
  debounce: (milliseconds: number): readonly number[] => [0x04, 0x03, 0x03, 0x00, 0x00, 0x01, milliseconds],
};

export class PulsarXs1HidClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus: MouseStatus | null = null;
  private deviceInfo: PulsarXs1DeviceInfo | null = null;

  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== PULSAR_VENDOR_ID || !PULSAR_XS1_PRODUCT_IDS.has(device.productId)) return false;
    const hasXs1Feature = device.collections.some((collection) =>
      collection.featureReports.some((report) => report.reportId === REPORT_ID));
    const hasLegacyControl = device.collections.some((collection) =>
      collection.inputReports.some((report) => report.reportId === CONFIG_REPORT_ID)
      && collection.outputReports.some((report) => report.reportId === CONFIG_REPORT_ID));
    return hasXs1Feature && !hasLegacyControl;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  describeCollections(): string {
    return this.device.collections.map((collection) => {
      const inputIds = collection.inputReports.map((report) => report.reportId);
      const outputIds = collection.outputReports.map((report) => report.reportId);
      const featureIds = collection.featureReports.map((report) => report.reportId);
      return [
        `usage 0x${collection.usagePage.toString(16)}:${collection.usage.toString(16)}`,
        `in [${inputIds.join(", ") || "none"}]`,
        `out [${outputIds.join(", ") || "none"}]`,
        `feature [${featureIds.join(", ") || "none"}]`,
      ].join(" · ");
    }).join(" | ") || "No HID collections reported";
  }

  async readDeviceInfo(): Promise<PulsarXs1DeviceInfo> {
    await this.open();
    this.deviceInfo = {
      connection: PULSAR_XS1_WIRELESS_PRODUCT_IDS.has(this.device.productId) ? "Wireless" : "Wired",
      maximumPollingRateHz: 1000,
    };
    return this.deviceInfo;
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const info = this.deviceInfo ?? await this.readDeviceInfo();
    const battery = await this.query(QUERY.battery);
    const dpiReply = await this.query(QUERY.dpi);
    const batteryPercent = battery[6] <= 100 ? battery[6] : null;
    const version = await this.query(QUERY.version).catch(() => null);
    const motionSync = await this.query(QUERY.motionSync).catch(() => null);
    const rippleControl = await this.query(QUERY.rippleControl).catch(() => null);
    const angleSnapping = await this.query(QUERY.angleSnapping).catch(() => null);
    const liftOffDistance = await this.query(QUERY.liftOffDistance).catch(() => null);
    const debounce = await this.query(QUERY.debounce).catch(() => null);
    const pollingRate = await this.query(QUERY.pollingRate).catch(() => null);
    return this.lastStatus = {
      brand: "Pulsar",
      name: XS1_PRODUCT_NAMES.get(this.device.productId) ?? (this.device.productName || "Pulsar X3"),
      ui: {
        family: "pulsar",
        hideUnsupportedPollingRates: true,
        pollingReadOnly: true,
        hideSleepCard: true,
        hideSignalCard: true,
        forceShowBattery: true,
        pollingNote: "The X3 exposes its polling rate through the feature interface, but the reported value is not reliable.",
      },
      batteryPercent,
      batteryState: batteryPercent === null ? "Unknown" : batteryPercent === 100 ? "Full" : "Discharging",
      dpi: readUint16LE(dpiReply, DPI_VALUE_OFFSET),
      pollingRateHz: pollingRate ? pulsarXs1DecodePollingRate(pollingRate[7]) ?? POLLING_RATES[3] : POLLING_RATES[3],
      supportedPollingRates: [...POLLING_RATES],
      activeProfile: null,
      connectionType: info.connection,
      connectionDetail: "XS-1 feature-report interface",
      motionSync: motionSync ? motionSync[7] === 1 : null,
      rippleControl: rippleControl ? rippleControl[7] === 1 : null,
      angleSnapping: angleSnapping ? angleSnapping[7] === 1 : null,
      debounceMs: debounce ? debounce[7] : null,
      liftOffDistance: this.decodeLiftOffDistance(liftOffDistance ? liftOffDistance[8] : 0),
      firmware: [this.decodeFirmware(version)],
    };
  }

  getDpiOptions(): number[] {
    return pulsarXs1DpiOptions();
  }

  async setDpi(dpi: number): Promise<number> {
    if (!this.getDpiOptions().includes(dpi)) {
      throw new Error(`${dpi.toLocaleString()} DPI is not supported by this Pulsar sensor.`);
    }
    await this.send(WRITE.dpi(dpi));
    const confirmed = await this.query(QUERY.dpi);
    const confirmedX = readUint16LE(confirmed, DPI_VALUE_OFFSET);
    const confirmedY = readUint16LE(confirmed, DPI_VALUE_OFFSET + 2);
    if (confirmedX !== dpi || confirmedY !== dpi) {
      throw new Error(`The mouse kept ${confirmedX.toLocaleString()} DPI instead of ${dpi.toLocaleString()}.`);
    }
    this.patch({ dpi: confirmedX });
    return confirmedX;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.motionSync, QUERY.motionSync, enabled, "motionSync", "Motion Sync");
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.rippleControl, QUERY.rippleControl, enabled, "rippleControl", "ripple control");
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return await this.setFlag(WRITE.angleSnapping, QUERY.angleSnapping, enabled, "angleSnapping", "angle snapping");
  }

  async setLiftOffDistance(liftOffDistance: LiftOffDistance): Promise<LiftOffDistance> {
    const encoded = LIFT_OFF_DISTANCES.find(([, name]) => name === liftOffDistance);
    if (!encoded) {
      throw new Error(`This mouse does not support a ${liftOffDistance.toLowerCase()} lift-off distance.`);
    }
    await this.send(WRITE.liftOffDistance(encoded[0]));
    const confirmed = this.decodeLiftOffDistance((await this.query(QUERY.liftOffDistance))[8]);
    if (confirmed !== liftOffDistance) {
      throw new Error(`The mouse kept ${confirmed ?? "an unknown"} lift-off distance instead of ${liftOffDistance.toLowerCase()}.`);
    }
    this.patch({ liftOffDistance: confirmed });
    return confirmed;
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > DEBOUNCE_MAX_MS) {
      throw new Error(`This Pulsar model supports a debounce time from 0 to ${DEBOUNCE_MAX_MS} ms.`);
    }
    await this.send(WRITE.debounce(debounceMs));
    const confirmed = (await this.query(QUERY.debounce))[7];
    if (confirmed !== debounceMs) {
      throw new Error(`The mouse kept ${confirmed} ms of debounce instead of ${debounceMs} ms.`);
    }
    this.patch({ debounceMs: confirmed });
    return confirmed;
  }

  private async setFlag(
    write: (enabled: boolean) => readonly number[],
    read: readonly number[],
    enabled: boolean,
    field: "motionSync" | "rippleControl" | "angleSnapping",
    label: string,
  ): Promise<boolean> {
    await this.send(write(enabled));
    const confirmed = (await this.query(read))[7] === 1;
    if (confirmed !== enabled) throw new Error(`The mouse left ${label} ${confirmed ? "on" : "off"}.`);
    this.patch({ [field]: confirmed });
    return confirmed;
  }

  private async query(command: readonly number[]): Promise<Uint8Array> {
    const run = this.queue.then(() => this.exchange(command), () => this.exchange(command));
    this.queue = run.catch(() => undefined);
    return await run;
  }

  private async send(command: readonly number[]): Promise<void> {
    const run = this.queue.then(() => this.write(command), () => this.write(command));
    this.queue = run.catch(() => undefined);
    await run;
  }

  private async exchange(command: readonly number[]): Promise<Uint8Array> {
    await this.open();
    const packet = pulsarXs1EncodeRequest(command);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < RESPONSE_ATTEMPTS; attempt += 1) {
      try {
        await this.device.sendFeatureReport(REPORT_ID, packet);
        await this.delay(RESPONSE_DELAY_MS);
        const reply = this.copyDataView(await this.device.receiveFeatureReport(REPORT_ID));
        if (reply.length !== PACKET_LENGTH) {
          throw new Error(`The Pulsar X3 answered with ${reply.length} bytes instead of ${PACKET_LENGTH}.`);
        }
        return reply;
      } catch (error) {
        lastError = error;
        await this.delay(RESPONSE_DELAY_MS);
      }
    }
    throw new Error(
      `The Pulsar X3 did not answer ${this.describe(command)} after ${RESPONSE_ATTEMPTS} attempts. ${this.describeError(lastError)}`,
    );
  }

  private async write(command: readonly number[]): Promise<void> {
    await this.open();
    try {
      await this.device.sendFeatureReport(REPORT_ID, pulsarXs1EncodeRequest(command));
    } catch (error) {
      throw new Error(`Chrome could not write the Pulsar X3 feature report. ${this.describeError(error)}`);
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  private copyDataView(view: DataView): Uint8Array {
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  private patch(changes: Partial<MouseStatus>): void {
    if (this.lastStatus) this.lastStatus = { ...this.lastStatus, ...changes };
  }

  private decodeLiftOffDistance(value: number): LiftOffDistance | null {
    return LIFT_OFF_DISTANCES.find(([encoded]) => encoded === value)?.[1] ?? null;
  }

  private decodeFirmware(reply: Uint8Array | null): string {
    if (!reply) return "Mouse firmware unavailable";
    const major = reply[7] ?? 0;
    const minor = reply[6] ?? 0;
    return `Mouse v${major.toString(16).padStart(2, "0")}.${minor.toString(16).padStart(2, "0")}`;
  }

  private describe(command: readonly number[]): string {
    return `command 0x${command.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
