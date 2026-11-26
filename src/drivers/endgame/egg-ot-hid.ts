import type { MouseStatus } from "../mouse-types.ts";
import {
  OT_COMTYPE,
  OT_COMTYPE_OFFSET,
  OT_CPI_COUNT,
  OT_DEVICE_PROFILES,
  OT_PACKET_SIZE,
  OT_PAYLOAD_INDEX,
  OT_POLLING_RATES,
  OT_POLL_RATE_HZ,
  OT_PROFILE_BLOCK,
  OT_PROFILE_FLAG,
  OT_READ_RETRIES,
  OT_REPORT_ID,
  OT_USAGE,
  OT_USAGE_PAGE,
  OT_VENDOR_ID,
  OT_WRITE_RETRIES,
  otCpiStep,
  otDecodeButtonRemap,
  otDecodeEffect,
  otEncodeEffect,
  otEncodeFirmwarePacket,
  otEncodeFirmwareReset,
  otEncodeFirmwareSetup,
  otEncodeProfilePackets,
  otEncodeQueryPacket,
  otEncodeSetPasswdPacket,
  otFirmwarePackets,
  otIsValidCpi,
  otLodLabel,
  otLodRaw,
  otNormalizeFeatureReport,
  otParseWirelessTelemetry,
  otPollRateHz,
  otProfileBlocks,
  otProfileForPid,
  otReassembleEffect,
  type OtButtonAction,
  type OtDeviceProfile,
  type OtEffect,
  type OtWirelessTelemetry,
} from "@openmouse/protocol/endgame-gear-ot";

export interface EggOtStatus extends MouseStatus {
  otProfileIndex: number;
  otProfileCount: number;
  otProfileNames: string[];
  otCpiStages: Array<{ x: number; y: number; active: boolean }>;
  otCpiMin: number;
  otCpiMax: number;
  otActiveCpiIndex: number;
  otPollRates: number[];
  otPollRateIndex: number;
  otLodRaw: number;
  otLodLabel: string | null;
  otAngleSnapping: boolean;
  otRippleControl: boolean;
  otSlamClickFilter: boolean;
  otMotionSyncResponsive: boolean;
  otMotionSyncSmooth: boolean;
  otSensitivityX: number;
  otSensitivityY: number;
  otAcceleration: number;
  otJitterCorrection: number;
  otLedStages: Array<{ r: number; g: number; b: number }>;
  otButtonActions: OtButtonAction[];
  otHasRgbEffect: boolean;
  otRgbMode: number;
  otRgbColor: { r: number; g: number; b: number };
  otRgbBrightness: number;
  otRgbSpeed: number;
  otBattery: { level: number; charging: boolean } | null;
  otFirmwareRaw: number[] | null;
}

export const EGG_OT_BUTTON_NAMES = ["Left", "Right", "Middle", "Forward", "Back", "Wheel Up", "Wheel Down"] as const;
export type EggOtButtonIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const OT_BUTTON_LABELS = ["Left Click", "Right Click", "Middle Click", "Back", "Forward", "Wheel Up", "Wheel Down"] as const;

export interface EggOtFlashProgress {
  fraction: number;
  packet: number;
  packets: number;
}

export class EggOtHidClient {
  private chain: Promise<unknown> = Promise.resolve();
  private firmwareRaw: number[] | null | undefined;
  private packetPayloadLength = OT_PACKET_SIZE - 1;
  private trace: string[] = [];
  private sessionStarted = false;

  readonly device: HIDDevice;
  readonly profile: OtDeviceProfile;

  constructor(device: HIDDevice) {
    this.device = device;
    this.profile = otProfileForPid(device.productId);
  }

  /** Only the vendor's 0xFFA1:0x00A5 interface; the other interfaces of the same PID refuse feature-report writes. */
  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === OT_VENDOR_ID
      && OT_DEVICE_PROFILES.has(device.productId)
      && (device.collections ?? []).some((collection) =>
        collection.usagePage === OT_USAGE_PAGE
        && collection.usage === OT_USAGE
        && this.collectionHasFeatureReport([collection], OT_REPORT_ID));
  }

  private static collectionHasFeatureReport(collections: readonly HIDCollectionInfo[] | undefined | null, reportId: number): boolean {
    return (collections ?? []).some((collection) =>
      (collection.featureReports ?? []).some((report) => report.reportId === reportId)
      || this.collectionHasFeatureReport(collection.children ?? [], reportId));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.packetPayloadLength = this.featurePayloadLength(OT_REPORT_ID, OT_PACKET_SIZE - 1);
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      await this.startSession();
    }
  }

  async close(): Promise<void> {
    this.sessionStarted = false;
    if (this.device.opened) await this.device.close();
  }

  /**
   * Vendor session start: kComSetPasswd, then the firmware version. The vendor
   * carries on when the mouse stays silent here, so failures are traced, not thrown.
   */
  private async startSession(): Promise<void> {
    this.trace = [];
    try {
      await this.exchange(otEncodeSetPasswdPacket(), false);
      const query = new Uint8Array(OT_PACKET_SIZE);
      query[OT_COMTYPE_OFFSET] = OT_COMTYPE.queryFirmwareVersion;
      const reply = await this.exchange(query, true);
      if (reply) this.firmwareRaw = Array.from(reply.subarray(OT_PAYLOAD_INDEX));
    } catch {
      // Already recorded in the trace by exchange().
    }
  }

  describeCollections(): string {
    return (this.device.collections ?? []).map((collection) => {
      const reports = (collection.featureReports ?? []).map((report) => `0x${report.reportId.toString(16)}`);
      return `usage 0x${collection.usagePage.toString(16)}:0x${collection.usage.toString(16)} · feature ${reports.join(", ") || "none"}`;
    }).join(" | ") || "No HID collections reported";
  }

  getDpiOptions(): number[] {
    const values: number[] = [];
    for (let cpi = 50; cpi <= this.profile.maxCpi;) {
      values.push(cpi);
      const step = otCpiStep(cpi + 1);
      cpi += step;
    }
    return values;
  }

  async readStatus(): Promise<EggOtStatus> {
    const { effect, telemetry } = await this.run(() => this.loadProfile(0));
    // queryFirmwareRaw serializes itself; wrapping it in run() would deadlock the chain.
    if (this.firmwareRaw === undefined) {
      this.firmwareRaw = await this.queryFirmwareRaw().catch(() => null);
    }
    const activeCpi = effect.cpi[effect.cpiIndex] ?? 800;
    const activeY = effect.cpiY[effect.cpiIndex] ?? activeCpi;
    const pollHz = otPollRateHz(effect.pollrateIndex) ?? otPollRateHz(effect.pollRates[effect.pollrateIndex] ?? -1);
    if (pollHz === null) throw new Error(`The mouse reported an unknown poll-rate index ${effect.pollrateIndex}.`);
    const lodLabel = otLodLabel(effect.dcuThreshold);
    const flags = effect.profileFlags;
    const buttonActions = effect.buttonRemap.map((value, slot) => otDecodeButtonRemap(slot, value));
    return {
      brand: "Endgame Gear",
      name: this.profile.name,
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: activeCpi,
      dpiY: activeY,
      supportsSeparateDpiAxes: true,
      pollingRateHz: pollHz,
      supportedPollingRates: [...OT_POLLING_RATES],
      activeProfile: effect.activeProfile,
      profileCount: Math.max(effect.maxProfile, 1),
      profileNames: effect.profileName ? [effect.profileName] : [],
      connectionType: "Wired",
      connectionDetail: `Wired USB - PID 0x${this.device.productId.toString(16).toUpperCase()} - ${this.profile.sensorFamily.toUpperCase()}`,
      motionSync: (flags & (OT_PROFILE_FLAG.motionSyncResponsive | OT_PROFILE_FLAG.motionSyncSmooth)) !== 0,
      angleSnapping: (flags & OT_PROFILE_FLAG.angleSnapping) !== 0,
      rippleControl: (flags & OT_PROFILE_FLAG.rippleControl) !== 0,
      slamclickFilter: (flags & OT_PROFILE_FLAG.slamClickFilter) !== 0,
      liftOffDistance: lodLabel === "1 mm" ? "Medium" : lodLabel === "2 mm" ? "High" : null,
      firmware: [],
      ui: {
        family: "egg-ot",
        defaultDisplayName: this.profile.name,
        hideSleepCard: true,
      },
      otProfileIndex: effect.profileIndex,
      otProfileCount: Math.max(effect.maxProfile, 1),
      otProfileNames: effect.profileName ? [effect.profileName] : [],
      otCpiStages: effect.cpi.map((x, i) => ({
        x,
        y: effect.cpiY[i] ?? x,
        // Selected stage. The vendor tool instead marks stages whose value
        // is not 50-aligned; that readback quirk is not mirrored here.
        active: i === effect.cpiIndex,
      })),
      otCpiMin: 50,
      otCpiMax: this.profile.maxCpi,
      otActiveCpiIndex: effect.cpiIndex,
      otPollRates: [...effect.pollRates],
      otPollRateIndex: effect.pollrateIndex,
      otLodRaw: effect.dcuThreshold,
      otLodLabel: lodLabel,
      otAngleSnapping: (flags & OT_PROFILE_FLAG.angleSnapping) !== 0,
      otRippleControl: (flags & OT_PROFILE_FLAG.rippleControl) !== 0,
      otSlamClickFilter: (flags & OT_PROFILE_FLAG.slamClickFilter) !== 0,
      otMotionSyncResponsive: (flags & OT_PROFILE_FLAG.motionSyncResponsive) !== 0,
      otMotionSyncSmooth: (flags & OT_PROFILE_FLAG.motionSyncSmooth) !== 0,
      otSensitivityX: effect.sensitivityX,
      otSensitivityY: effect.sensitivityY,
      otAcceleration: effect.acceleration,
      otJitterCorrection: effect.jitterCorrection,
      otLedStages: effect.red.map((r, i) => ({
        r,
        g: effect.green[i] ?? 0,
        b: effect.blue[i] ?? 0,
      })),
      otButtonActions: buttonActions,
      otHasRgbEffect: this.profile.hasRgbEffect,
      otRgbMode: effect.rgbMode,
      otRgbColor: { r: effect.rgbRed, g: effect.rgbGreen, b: effect.rgbBlue },
      otRgbBrightness: effect.rgbBrightness,
      otRgbSpeed: effect.rgbSpeed,
      otBattery: telemetry ? { level: telemetry.batteryLevel, charging: telemetry.charging } : null,
      otFirmwareRaw: this.firmwareRaw,
    };
  }

  async setDpi(dpi: number): Promise<number> {
    this.assertCpi(dpi);
    const confirmed = await this.updateProfile(0, (effect) => {
      for (let i = 0; i < OT_CPI_COUNT; i += 1) {
        effect.cpi[i] = dpi;
        effect.cpiY[i] = dpi;
      }
    });
    const back = confirmed.cpi[confirmed.cpiIndex] ?? -1;
    if (back !== dpi) throw new Error(`The mouse kept CPI stage at ${back} instead of ${dpi}.`);
    return dpi;
  }

  async setCpiStage(level: number, x: number, y: number): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level >= OT_CPI_COUNT) throw new Error("Invalid CPI stage.");
    this.assertCpi(x);
    this.assertCpi(y);
    const confirmed = await this.updateProfile(0, (effect) => {
      effect.cpi[level] = x;
      effect.cpiY[level] = y;
    });
    if (confirmed.cpi[level] !== x || confirmed.cpiY[level] !== y) {
      throw new Error(`The mouse did not confirm CPI stage ${level + 1}.`);
    }
  }

  async setPollingRate(rate: number): Promise<number> {
    const target = [...OT_POLL_RATE_HZ.entries()].find(([, hz]) => hz === rate)?.[0];
    if (target === undefined) throw new Error("Unsupported OT polling rate.");
    const confirmed = await this.updateProfile(0, (effect) => {
      effect.pollrateIndex = target;
    });
    const back = otPollRateHz(confirmed.pollrateIndex);
    if (back !== rate) throw new Error(`The mouse kept ${back ?? "?"} Hz instead of ${rate} Hz.`);
    return rate;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<void> {
    const raw = value === "Medium" ? otLodRaw("1 mm") : value === "High" ? otLodRaw("2 mm") : null;
    if (raw === null) throw new Error(`${this.profile.name} exposes only 1 mm and 2 mm lift-off distances.`);
    const confirmed = await this.updateProfile(0, (effect) => {
      effect.dcuThreshold = raw;
    });
    if (confirmed.dcuThreshold !== raw) throw new Error("The mouse did not confirm the lift-off distance.");
  }

  async setProcessingFlag(flag: number, enabled: boolean, label: string): Promise<void> {
    const confirmed = await this.updateProfile(0, (effect) => {
      effect.profileFlags = enabled ? effect.profileFlags | flag : effect.profileFlags & ~flag;
    });
    if (((confirmed.profileFlags & flag) !== 0) !== enabled) {
      throw new Error(`The mouse did not confirm ${label}.`);
    }
  }

  async setAngleSnapping(enabled: boolean): Promise<void> {
    await this.setProcessingFlag(OT_PROFILE_FLAG.angleSnapping, enabled, "angle snapping");
  }

  async setRippleControl(enabled: boolean): Promise<void> {
    await this.setProcessingFlag(OT_PROFILE_FLAG.rippleControl, enabled, "ripple control");
  }

  async setSlamClickFilter(enabled: boolean): Promise<void> {
    await this.setProcessingFlag(OT_PROFILE_FLAG.slamClickFilter, enabled, "slam-click filter");
  }

  async setMotionSyncResponsive(enabled: boolean): Promise<void> {
    await this.setProcessingFlag(OT_PROFILE_FLAG.motionSyncResponsive, enabled, "responsive Motion Sync");
  }

  async setMotionSyncSmooth(enabled: boolean): Promise<void> {
    await this.setProcessingFlag(OT_PROFILE_FLAG.motionSyncSmooth, enabled, "smooth Motion Sync");
  }

  buttonLabels(): string[] {
    return [...EGG_OT_BUTTON_NAMES];
  }

  decodeButtonAction(slot: number, value: number): OtButtonAction {
    return otDecodeButtonRemap(slot, value);
  }

  buttonActionLabel(action: OtButtonAction): string {
    switch (action.key) {
      case "mouse": {
        const label = OT_BUTTON_LABELS[(action.eventId ?? 1) - 1];
        return label ?? `Mouse button ${action.eventId}`;
      }
      case "cpi-loop": return "CPI Loop";
      case "cpi-plus": return "CPI +";
      case "cpi-minus": return "CPI −";
      case "cpi-custom": return `CPI stage ${action.eventId}`;
      case "keyboard": return action.usage ? `Keyboard HID 0x${action.usage.toString(16)}` : "Keyboard (unassigned)";
      case "disabled": return "Disabled";
      case "raw": return `Raw event ${action.eventId}`;
    }
  }

  /**
   * Vendor firmware flash, byte-for-byte from Custom_HID_Update_Firmware:
   * DlSetup, 2 s settle, indexed data packets with progress. The caller must
   * invoke resetFirmware() afterwards as a separate, deliberate step, exactly
   * like the vendor tool. Never exercised on hardware.
   */
  async flashFirmware(
    image: Uint8Array,
    version: { major: number; minor: number; build: number },
    onProgress?: (progress: EggOtFlashProgress) => void,
  ): Promise<void> {
    await this.run(async () => {
      await this.open();
      const { setup, chunks } = otFirmwarePackets(image);
      setup.major = version.major;
      setup.minor = version.minor;
      setup.build = version.build;
      await this.sendPacket(otEncodeFirmwareSetup(setup));
      await this.delay(2000);
      for (let index = 0; index < chunks.length; index += 1) {
        await this.sendPacket(otEncodeFirmwarePacket(index, chunks[index]!));
        onProgress?.({ fraction: (10 + (index / chunks.length) * 90) / 100, packet: index, packets: chunks.length });
        await this.delay(5);
      }
    });
  }

  /** Vendor reset magic (kComResetFirmware + 0x0BADF00D). Reboots the mouse. */
  async resetFirmware(): Promise<void> {
    await this.run(async () => {
      await this.open();
      await this.sendPacket(otEncodeFirmwareReset());
    });
  }

  async queryFirmwareRaw(): Promise<number[] | null> {
    return this.run(async () => {
      await this.open();
      const packet = new Uint8Array(OT_PACKET_SIZE);
      packet[1] = OT_COMTYPE.queryFirmwareVersion;
      const reply = await this.exchange(packet, true);
      if (!reply) return null;
      return Array.from(reply.subarray(OT_PAYLOAD_INDEX));
    });
  }

  private async loadProfile(profileIndex: number): Promise<{ effect: OtEffect; telemetry: OtWirelessTelemetry | null }> {
    await this.open();
    const replies = new Map<number, Uint8Array>();
    // Main block first like the vendor loader (it carries the profile count).
    const blocks = otProfileBlocks().sort((a, b) =>
      (a.block === OT_PROFILE_BLOCK.main ? -1 : a.block) - (b.block === OT_PROFILE_BLOCK.main ? -1 : b.block));
    for (const { block } of blocks) {
      const reply = await this.queryBlock(block, profileIndex);
      replies.set(block, reply);
    }
    const effect = otDecodeEffect(otReassembleEffect(replies));
    const wirelessReply = replies.get(OT_PROFILE_BLOCK.wireless);
    const telemetry = wirelessReply && wirelessReply.length > 8 ? otParseWirelessTelemetry(wirelessReply) : null;
    return { effect, telemetry };
  }

  private async queryBlock(block: number, profileIndex: number): Promise<Uint8Array> {
    let reply: Uint8Array | null;
    try {
      reply = await this.exchange(otEncodeQueryPacket(block, profileIndex), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OT profile block ${block} failed: ${message} ${this.describeFailureContext()}`);
    }
    if (!reply) throw new Error(`The mouse did not answer OT profile block ${block}. ${this.describeFailureContext()}`);
    return reply.subarray(OT_PAYLOAD_INDEX);
  }

  /** Recent packets since the session started (tx/rx hex, newest last) so a failed handshake reports what actually came back. */
  private describeTrace(): string {
    return this.trace.length > 0 ? this.trace.join(" | ") : "no packets";
  }

  /** Trace plus the granted HID collections, so a refused write shows which interface the browser handed us. */
  private describeFailureContext(): string {
    return `Trace: ${this.describeTrace()}. Collections: ${this.describeCollections()}`;
  }

  private record(direction: "tx" | "rx" | "err", detail: Uint8Array | string): void {
    const text = typeof detail === "string"
      ? detail
      : Array.from(detail.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const entry = `${direction} ${text}`;
    const last = this.trace[this.trace.length - 1];
    const repeat = last?.match(/^(.*) x(\d+)$/);
    if (last === entry) {
      this.trace[this.trace.length - 1] = `${entry} x2`;
    } else if (repeat?.[1] === entry) {
      this.trace[this.trace.length - 1] = `${entry} x${Number(repeat[2]) + 1}`;
    } else {
      if (this.trace.length >= 24) this.trace.shift();
      this.trace.push(entry);
    }
    console.log(`[egg-ot] ${direction} ${text}`);
  }

  private async updateProfile(profileIndex: number, change: (effect: OtEffect) => void): Promise<OtEffect> {
    return this.run(async () => {
      const { effect } = await this.loadProfile(profileIndex);
      const patched: OtEffect = {
        ...effect,
        cpi: [...effect.cpi],
        cpiY: [...effect.cpiY],
        pollRates: [...effect.pollRates],
        red: [...effect.red],
        green: [...effect.green],
        blue: [...effect.blue],
        buttonRemap: [...effect.buttonRemap],
        hidUsage: [...effect.hidUsage],
        modifier: [...effect.modifier],
      };
      change(patched);
      const bytes = otEncodeEffect(patched);
      for (const packet of otEncodeProfilePackets(bytes)) {
        await this.sendPacket(packet);
      }
      const { effect: confirmed } = await this.loadProfile(profileIndex);
      return confirmed;
    });
  }

  private async sendPacket(packet: Uint8Array): Promise<void> {
    await this.open();
    let writeCounter = 0;
    let readCounter = 0;
    const payload = Uint8Array.from(packet.subarray(1, 1 + this.packetPayloadLength));
    const expectResponse = packet[1] !== OT_COMTYPE.setProfileData
      && packet[1] !== OT_COMTYPE.firmwareDlSetup
      && packet[1] !== OT_COMTYPE.firmwareDataPacket
      && packet[1] !== OT_COMTYPE.resetFirmware;
    while (writeCounter++ < OT_WRITE_RETRIES) {
      const sent = (await this.device.sendFeatureReport(OT_REPORT_ID, payload)) as unknown as
        | number
        | undefined;
      // WebHID resolves void on success; node-hid style fakes resolve a byte count.
      if (typeof sent === "number" && sent <= 0) continue;
      {
        while (readCounter++ < OT_READ_RETRIES) {
          const reply = await this.receivePacket();
          if (reply[1] !== 0x00) {
            if (expectResponse) {
              if (reply[1] === OT_COMTYPE.ack) continue;
              return;
            } else if (reply[1] === OT_COMTYPE.ack || reply[1] === OT_COMTYPE.response) {
              return;
            }
          }
        }
      }
    }
    throw new Error("The Endgame Gear OT mouse did not acknowledge the packet.");
  }

  private async exchange(packet: Uint8Array, expectResponse: boolean): Promise<Uint8Array | null> {
    await this.open();
    const payload = Uint8Array.from(packet.subarray(1, 1 + this.packetPayloadLength));
    let writeCounter = 0;
    while (writeCounter++ < OT_WRITE_RETRIES) {
      this.record("tx", payload);
      const sent = (await this.device.sendFeatureReport(OT_REPORT_ID, payload)) as unknown as
        | number
        | undefined;
      if (typeof sent === "number" && sent <= 0) {
        this.record("err", `write returned ${sent}`);
        continue;
      }
      let readCounter = 0;
      while (readCounter++ < OT_READ_RETRIES) {
        let reply: Uint8Array;
        try {
          reply = await this.receivePacket();
        } catch (error) {
          this.record("err", error instanceof Error ? error.message : String(error));
          throw error;
        }
        this.record("rx", reply);
        if (reply[1] === 0x00) continue;
        if (expectResponse) {
          // The vendor treats the ACK as already seen after the write, so a lone response also completes.
          if (reply[1] === OT_COMTYPE.ack) continue;
          return reply;
        } else if (reply[1] === OT_COMTYPE.ack || reply[1] === OT_COMTYPE.response) {
          return reply;
        }
      }
    }
    return null;
  }

  private async receivePacket(): Promise<Uint8Array> {
    const view = await Promise.race([
      this.device.receiveFeatureReport(OT_REPORT_ID),
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error("OT feature read timed out")),
        3000,
      )),
    ]);
    const raw = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    return otNormalizeFeatureReport(raw);
  }

  private featurePayloadLength(reportId: number, fallback: number): number {
    const reports: HIDReportInfo[] = [];
    const collect = (collections: readonly HIDCollectionInfo[] | undefined | null): void => {
      for (const collection of collections ?? []) {
        reports.push(...(collection.featureReports ?? []).filter((report) => report.reportId === reportId));
        collect(collection.children ?? []);
      }
    };
    collect(this.device.collections ?? []);
    for (const report of reports) {
      const bits = (report.items ?? []).reduce((sum, item) => sum + item.reportSize * item.reportCount, 0);
      if (bits > 0) return Math.ceil(bits / 8);
    }
    return fallback;
  }

  private assertCpi(value: number): void {
    if (!otIsValidCpi(this.profile, value)) {
      throw new Error(
        `${this.profile.name} CPI must be 50 to ${this.profile.maxCpi.toLocaleString()} in 50 CPI steps (100 above 10,000).`,
      );
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(operation, operation);
    this.chain = pending.catch(() => undefined);
    return pending;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
}
