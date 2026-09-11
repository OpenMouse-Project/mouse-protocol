import type { MouseStatus } from "../mouse-types.ts";
import {
  KEYCHRON_M6_COMMAND_REPORT_ID as COMMAND_REPORT_ID,
  KEYCHRON_M6_PRODUCT_ID as PRODUCT_ID,
  KEYCHRON_M6_RECEIVER_PRODUCT_ID as RECEIVER_PRODUCT_ID,
  KEYCHRON_M6_SETTINGS_REPORT_ID as SETTINGS_REPORT_ID,
  KEYCHRON_M6_STATUS_COMMAND as STATUS_COMMAND,
  KEYCHRON_M6_STATUS_PACKET_LENGTH as PACKET_LENGTH,
  KEYCHRON_M6_USAGE as USAGE,
  KEYCHRON_M6_USAGE_PAGE as USAGE_PAGE,
  KEYCHRON_VENDOR_ID,
} from "@openmouse/protocol/keychron";

const QUERY_TIMEOUT_MS = 1200;
const SETTINGS_PACKET_LENGTH = 20;
const DPI_STAGE_COUNT = 5;
const DPI_MIN = 100;
const DPI_MAX = 26_000;
const DPI_STEP = 50;
/** Polling table entries index this scale (Keychron Launcher POLLING_RATE_VALUE_SCALE). */
const POLLING_RATES = [125, 500, 1000, 2000, 4000, 8000] as const;
const ACK = 0xe4;
/** Firmware LOD codes on the PAW3950: 1 = 1 mm, 2 = 2 mm, 3 = 0.7 mm. */
const LOD_BY_LEVEL = { Low: 3, Medium: 1, High: 2 } as const;
const SLEEP_MINUTES = [1, 3, 5, 10, 15, 30, 60, 120, 240] as const;
const DEBOUNCE_MAX_MS = 20;
const ANGLE_LIMIT = 30;
const PROFILE_MAX = 5;

/** Commands on the 63-byte 0xb3 report (answers arrive on 0xb4). */
const CMD = { firmware: 0x04, status: 0x06 } as const;
/** Commands on the 20-byte 0xb5 report (answers arrive on 0xb6). */
const SET = {
  version: 0x02,
  sleep: 0x0a,
  profile: 0x0e,
  dpi: 0x40,
  polling: 0x41,
  sensor: 0x42,
  debounce: 0x43,
} as const;

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;

type M6Settings = {
  profile: number;
  profileCount: number;
  activeDpiStage: number;
  /** All five hardware slots; only the first `stageCount` are in use. */
  dpiStages: number[];
  stageCount: number;
  pollingTable: number[];
  pollingIndex: number;
  lod: number;
  lodLevel: number;
  rippleControl: boolean;
  angleSnapping: boolean;
  motionSync: boolean;
  scrollReversed: boolean;
  maxSpeed: boolean;
  angle: number;
  angleSupported: boolean;
  debounceMs: number;
  sleepMinutes: number;
  batteryPercent: number;
  charging: boolean;
};

type M6Identity = { firmware: string | null; workMode: number };

/**
 * Keychron M6 client for the 0xffc1 vendor collection, the "8k" variant of
 * Keychron Launcher's mouse protocol (63-byte 0xb3/0xb4 reads, 20-byte
 * 0xb5/0xb6 writes). Not the VIA raw-HID protocol the Nape Pro speaks.
 *
 * Status report (0x06) layout, decoded from Keychron Launcher and confirmed
 * on an M6 (firmware 1.0.3, USB) for every field the driver reads:
 *   [1]      active onboard profile, zero-based; [50] profile count
 *   [2..4]   per connection (USB, 2.4 GHz, Bluetooth): DPI stage in the low
 *            nibble, polling index in the high nibble
 *   [5..14]  five DPI slots, little-endian 16-bit
 *   [15]     bits 0-1 lift-off code, bit 2 ripple control, bit 3 angle
 *            snapping, bit 4 motion sync, bit 6 reversed scroll
 *   [16]     DPI stages in use (1-5); unused tail slots keep stale values
 *   [17]     debounce in ms; [18] sleep timeout in minutes
 *   [19]     battery percent, bit 7 = charging
 *   [43..48] polling table as indexes into POLLING_RATES; [49] its length
 *   [52]     bit 0 max-speed mode; [53] bit 2 = angle tuning supported
 *   [55]     sensor angle as a signed byte; [61] lift-off fine level
 * Settings writes are acknowledged with [0xe4, code, command]; code 0 is
 * success and 7 means the command is not supported on this connection.
 * The 0x40 write packet is the DPI part of this layout shifted one byte down
 * (stage at [1..3], slots at [4..13], stage count at [14]).
 */
export class KeychronM6HidClient {
  readonly device: HIDDevice;
  private openedListener = false;
  private identity: M6Identity | null = null;
  private responseWaiter: {
    match: (bytes: Uint8Array) => boolean;
    resolve: (bytes: Uint8Array) => void;
    reject: (reason: Error) => void;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (!this.responseWaiter) return;
    const bytes = new Uint8Array(event.data.buffer.slice(
      event.data.byteOffset,
      event.data.byteOffset + event.data.byteLength,
    ));
    if (!this.responseWaiter.match(bytes)) return;
    const waiter = this.responseWaiter;
    this.responseWaiter = null;
    waiter.resolve(bytes);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === KEYCHRON_VENDOR_ID
      && (device.productId === PRODUCT_ID || device.productId === RECEIVER_PRODUCT_ID)
      && device.collections.some((collection) =>
        collection.usagePage === USAGE_PAGE
        && collection.usage === USAGE
        && collection.outputReports.some((report) => report.reportId === COMMAND_REPORT_ID)
        && collection.inputReports.some((report) => report.reportId === COMMAND_REPORT_ID + 1));
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.openedListener) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.openedListener = true;
    }
  }

  async close(): Promise<void> {
    if (this.openedListener) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.openedListener = false;
    }
    this.responseWaiter?.reject(new Error("The Keychron M6 device was closed."));
    this.responseWaiter = null;
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    return Array.from({ length: (DPI_MAX - DPI_MIN) / DPI_STEP + 1 }, (_, index) => DPI_MIN + index * DPI_STEP);
  }

  getSleepOptions(): number[] {
    return SLEEP_MINUTES.map((minutes) => minutes * 60);
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  readonly canDisableSleep = false;

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const identity = await this.readIdentity();
    const settings = this.parseStatus(await this.queryStatus(), identity.workMode);
    const dpi = settings.dpiStages[settings.activeDpiStage] ?? settings.dpiStages[0] ?? 800;
    const pollingRateHz = POLLING_RATES[settings.pollingTable[settings.pollingIndex] ?? 2] ?? 1000;
    const supportedPollingRates = settings.pollingTable
      .map((value) => POLLING_RATES[value])
      .filter((value): value is (typeof POLLING_RATES)[number] => value !== undefined)
      .sort((a, b) => a - b);
    const liftOffDistance = (Object.keys(LOD_BY_LEVEL) as LiftOff[])
      .find((level) => LOD_BY_LEVEL[level] === settings.lod) ?? null;

    return {
      brand: "Keychron",
      name: "Keychron M6",
      ui: {
        family: "keychron-m6",
        defaultDisplayName: "Keychron M6",
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
        statusNote: "Lift-off: Low is 0.7 mm, Medium is 1 mm, High is 2 mm.",
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          countEditable: false,
          minDpi: DPI_MIN,
          maxDpi: DPI_MAX,
          stepDpi: DPI_STEP,
        },
      },
      batteryPercent: settings.batteryPercent <= 100 ? settings.batteryPercent : null,
      batteryState: settings.charging ? "Charging" : "Discharging",
      dpi,
      dpiStages: settings.dpiStages.slice(0, settings.stageCount),
      activeDpiStage: settings.activeDpiStage,
      pollingRateHz,
      supportedPollingRates: supportedPollingRates.length ? supportedPollingRates : [pollingRateHz],
      activeProfile: settings.profileCount > 1 ? settings.profile + 1 : null,
      profileCount: settings.profileCount > 1 ? settings.profileCount : undefined,
      connectionType: this.device.productId === RECEIVER_PRODUCT_ID ? "Wireless" : "Wired",
      connectionDetail: this.device.productId === RECEIVER_PRODUCT_ID
        ? "2.4 GHz (Keychron Link-KM)"
        : "Wired USB",
      liftOffDistance,
      supportedLiftOffDistances: Object.keys(LOD_BY_LEVEL) as LiftOff[],
      motionSync: settings.motionSync,
      angleSnapping: settings.angleSnapping,
      rippleControl: settings.rippleControl,
      angleTuning: settings.angleSupported ? settings.angle : undefined,
      debounceMs: settings.debounceMs,
      sleepTimeout: settings.sleepMinutes > 0 && settings.sleepMinutes < 0xff ? settings.sleepMinutes * 60 : null,
      firmware: [identity.firmware ?? "Firmware unavailable"],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    this.requireDpi(dpi);
    const settings = await this.readSettings();
    settings.dpiStages[settings.activeDpiStage] = dpi;
    await this.writeSettings(this.dpiSettingsPacket(settings));
    const confirmed = (await this.readSettings()).dpiStages[settings.activeDpiStage];
    if (confirmed !== dpi) throw new Error(`The Keychron M6 kept ${confirmed} DPI instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    this.requireDpi(dpi);
    const settings = await this.readSettings();
    this.requireStage(stage, settings.stageCount);
    settings.dpiStages[stage] = dpi;
    await this.writeSettings(this.dpiSettingsPacket(settings));
    const confirmed = (await this.readSettings()).dpiStages[stage];
    if (confirmed !== dpi) {
      throw new Error(`The Keychron M6 kept ${confirmed} DPI on stage ${stage + 1} instead of ${dpi} DPI.`);
    }
    return confirmed;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const settings = await this.readSettings();
    this.requireStage(stage, settings.stageCount);
    settings.activeDpiStage = stage;
    await this.writeSettings(this.dpiSettingsPacket(settings));
    const confirmed = (await this.readSettings()).activeDpiStage;
    if (confirmed !== stage) throw new Error(`The Keychron M6 kept DPI stage ${confirmed + 1}.`);
    return confirmed;
  }

  async setPollingRate(rateHz: number): Promise<number> {
    const settings = await this.readSettings();
    const pollingIndex = settings.pollingTable.findIndex((value) => POLLING_RATES[value] === rateHz);
    if (pollingIndex < 0) throw new Error(`The Keychron M6 does not support ${rateHz} Hz on this connection.`);
    settings.pollingIndex = pollingIndex;
    await this.writeSettings(this.pollingSettingsPacket(settings));
    const confirmed = await this.readSettings();
    const actual = POLLING_RATES[confirmed.pollingTable[confirmed.pollingIndex] ?? 2] ?? 1000;
    if (actual !== rateHz) throw new Error(`The Keychron M6 kept ${actual} Hz instead of ${rateHz} Hz.`);
    return actual;
  }

  async setLiftOffDistance(lod: LiftOff): Promise<LiftOff> {
    const code = LOD_BY_LEVEL[lod];
    if (code === undefined) throw new Error(`The Keychron M6 has no ${lod} lift-off distance.`);
    const confirmed = await this.writeSensor({ lod: code });
    if (confirmed.lod !== code) throw new Error(`The Keychron M6 kept lift-off code ${confirmed.lod}.`);
    return lod;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("motionSync", enabled);
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("angleSnapping", enabled);
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("rippleControl", enabled);
  }

  async setAngleTuning(degrees: number): Promise<number> {
    if (!Number.isInteger(degrees) || Math.abs(degrees) > ANGLE_LIMIT) {
      throw new Error(`Keychron M6 angle tuning must be a whole number between -${ANGLE_LIMIT} and ${ANGLE_LIMIT} degrees.`);
    }
    if (!(await this.readSettings()).angleSupported) {
      throw new Error("This Keychron M6 firmware does not support angle tuning.");
    }
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.sensor;
    packet[9] = 2;
    packet[10] = degrees & 0xff;
    await this.writeSettings(packet);
    const confirmed = (await this.readSettings()).angle;
    if (confirmed !== degrees) throw new Error(`The Keychron M6 kept a ${confirmed}° sensor angle instead of ${degrees}°.`);
    return confirmed;
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > DEBOUNCE_MAX_MS) {
      throw new Error(`Keychron M6 debounce must be between 0 and ${DEBOUNCE_MAX_MS} ms.`);
    }
    await this.open();
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.debounce;
    packet[1] = debounceMs;
    await this.writeSettings(packet);
    const confirmed = (await this.readSettings()).debounceMs;
    if (confirmed !== debounceMs) throw new Error(`The Keychron M6 kept ${confirmed} ms debounce instead of ${debounceMs} ms.`);
    return confirmed;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    const minutes = Math.round(seconds / 60);
    if (!SLEEP_MINUTES.includes(minutes as (typeof SLEEP_MINUTES)[number])) {
      throw new Error(`Keychron M6 sleep timeout must be one of ${SLEEP_MINUTES.join(", ")} minutes.`);
    }
    await this.open();
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.sleep;
    packet[1] = 1;
    packet[2] = minutes;
    await this.writeSettings(packet);
    const confirmed = (await this.readSettings()).sleepMinutes;
    if (confirmed !== minutes) throw new Error(`The Keychron M6 kept a ${confirmed} minute sleep timeout instead of ${minutes}.`);
    return confirmed * 60;
  }

  /** Switch the onboard profile (1-based, as the panel numbers them). */
  async setProfile(profile: number): Promise<number> {
    const settings = await this.readSettings();
    if (!Number.isInteger(profile) || profile < 1 || profile > Math.min(settings.profileCount, PROFILE_MAX)) {
      throw new Error(`Keychron M6 profile must be between 1 and ${settings.profileCount}.`);
    }
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.profile;
    packet[1] = profile - 1;
    await this.writeSettings(packet);
    const confirmed = (await this.readSettings()).profile + 1;
    if (confirmed !== profile) throw new Error(`The Keychron M6 kept profile ${confirmed}.`);
    return confirmed;
  }

  private async writeSensorFlag(
    flag: "motionSync" | "angleSnapping" | "rippleControl",
    enabled: boolean,
  ): Promise<boolean> {
    const confirmed = await this.writeSensor({ [flag]: enabled });
    if (confirmed[flag] !== enabled) throw new Error(`The Keychron M6 kept ${flag} ${confirmed[flag] ? "on" : "off"}.`);
    return confirmed[flag];
  }

  /**
   * The 0x42 packet carries every sensor option at once; each toggle byte is
   * 1 = on, 2 = off, 0 = leave alone, so resend the current state with the
   * requested change applied.
   */
  private async writeSensor(change: Partial<M6Settings>): Promise<M6Settings> {
    const settings = { ...(await this.readSettings()), ...change };
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.sensor;
    packet[1] = settings.lod;
    packet[2] = settings.rippleControl ? 1 : 2;
    packet[3] = settings.angleSnapping ? 1 : 2;
    packet[4] = settings.motionSync ? 1 : 2;
    packet[6] = settings.scrollReversed ? 2 : 1;
    packet[8] = settings.maxSpeed ? 2 : 1;
    packet[11] = settings.lodLevel;
    await this.writeSettings(packet);
    return await this.readSettings();
  }

  private requireDpi(dpi: number): void {
    if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
      throw new Error(`Keychron M6 DPI must be a multiple of ${DPI_STEP} between ${DPI_MIN} and ${DPI_MAX}.`);
    }
  }

  private requireStage(stage: number, stageCount: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= stageCount) {
      throw new Error(`DPI stage must be between 1 and ${stageCount}.`);
    }
  }

  private async readSettings(): Promise<M6Settings> {
    await this.open();
    const identity = await this.readIdentity();
    return this.parseStatus(await this.queryStatus(), identity.workMode);
  }

  /**
   * Firmware string (0x04 on 0xb3) and connection mode (0x02 on 0xb5) never
   * change while connected, so they are read once. Either failing leaves the
   * mouse usable: the mode falls back to what the product ID implies.
   */
  private async readIdentity(): Promise<M6Identity> {
    if (this.identity) return this.identity;
    const fallbackMode = this.device.productId === RECEIVER_PRODUCT_ID ? 1 : 0;
    const version = await this.querySettings(SET.version, [fallbackMode]).catch(() => null);
    const workMode = version ? (version[9] ?? fallbackMode) & 0x07 : fallbackMode;
    const firmware = await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, [CMD.firmware, workMode], (bytes) => bytes[0] === CMD.firmware)
      .then((bytes) => decodeFirmwareString(bytes) ?? (version ? decodeFirmwareNibbles(version) : null))
      .catch(() => (version ? decodeFirmwareNibbles(version) : null));
    this.identity = { firmware, workMode };
    return this.identity;
  }

  private parseStatus(bytes: Uint8Array, workMode: number): M6Settings {
    if (bytes.length < 51 || bytes[0] !== STATUS_COMMAND) {
      throw new Error("The Keychron M6 returned an invalid status report.");
    }
    const dpiStages = Array.from({ length: DPI_STAGE_COUNT }, (_, index) => {
      const offset = 5 + index * 2;
      return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    });
    const pollingCount = Math.min(bytes[49] || 6, 6);
    const stageCount = Math.min(bytes[16] || DPI_STAGE_COUNT, DPI_STAGE_COUNT);
    const levels = bytes[2 + Math.min(workMode, 2)] ?? 0;
    const flags = bytes[15] ?? 0;
    const angle = bytes[55] ?? 0;
    return {
      profile: bytes[1] ?? 0,
      profileCount: Math.min(bytes[50] ?? 0, PROFILE_MAX),
      activeDpiStage: Math.min(levels & 0x0f, stageCount - 1),
      dpiStages,
      stageCount,
      pollingTable: Array.from(bytes.slice(43, 43 + pollingCount)),
      pollingIndex: (levels >> 4) & 0x0f,
      lod: flags & 0x03,
      lodLevel: bytes[61] ?? 0,
      rippleControl: (flags & 0x04) !== 0,
      angleSnapping: (flags & 0x08) !== 0,
      motionSync: (flags & 0x10) !== 0,
      scrollReversed: (flags & 0x40) !== 0,
      maxSpeed: ((bytes[52] ?? 0) & 0x01) !== 0,
      angle: angle > 127 ? angle - 256 : angle,
      angleSupported: ((bytes[53] ?? 0) & 0x04) !== 0,
      debounceMs: bytes[17] ?? 0,
      sleepMinutes: bytes[18] ?? 0,
      batteryPercent: (bytes[19] ?? 0) & 0x7f,
      charging: ((bytes[19] ?? 0) & 0x80) !== 0,
    };
  }

  private dpiSettingsPacket(settings: M6Settings): Uint8Array {
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.dpi;
    packet[1] = settings.activeDpiStage;
    packet[2] = settings.activeDpiStage;
    packet[3] = settings.activeDpiStage;
    settings.dpiStages.forEach((dpi, index) => {
      packet[4 + index * 2] = dpi & 0xff;
      packet[5 + index * 2] = (dpi >> 8) & 0xff;
    });
    packet[14] = settings.stageCount;
    return packet;
  }

  private pollingSettingsPacket(settings: M6Settings): Uint8Array {
    const packet = new Uint8Array(SETTINGS_PACKET_LENGTH);
    packet[0] = SET.polling;
    packet[1] = settings.pollingIndex;
    packet[2] = settings.pollingIndex;
    packet[9] = settings.pollingTable.length;
    packet.set(settings.pollingTable.slice(0, 6), 3);
    return packet;
  }

  private async queryStatus(): Promise<Uint8Array> {
    return await this.query(COMMAND_REPORT_ID, PACKET_LENGTH, [STATUS_COMMAND], (bytes) => bytes[0] === STATUS_COMMAND);
  }

  private async querySettings(command: number, args: number[]): Promise<Uint8Array> {
    return await this.query(SETTINGS_REPORT_ID, SETTINGS_PACKET_LENGTH, [command, ...args], (bytes) => bytes[0] === command);
  }

  private async writeSettings(packet: Uint8Array): Promise<void> {
    const command = packet[0] ?? 0;
    const reply = await this.query(
      SETTINGS_REPORT_ID,
      SETTINGS_PACKET_LENGTH,
      Array.from(packet),
      (bytes) => bytes[0] === command || (bytes[0] === ACK && bytes[2] === command),
    );
    if (reply[0] === ACK && reply[1] !== 0) {
      throw new Error(`The Keychron M6 rejected command 0x${command.toString(16)} (code ${reply[1]}).`);
    }
  }

  private async query(
    reportId: number,
    length: number,
    payload: number[],
    match: (bytes: Uint8Array) => boolean,
  ): Promise<Uint8Array> {
    if (this.responseWaiter) throw new Error("Another Keychron M6 request is already in progress.");
    const packet = new Uint8Array(length);
    packet.set(payload.slice(0, length));
    let timeout = 0;
    let rejectResponse: ((reason: Error) => void) | null = null;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      rejectResponse = reject;
      timeout = window.setTimeout(() => {
        this.responseWaiter = null;
        reject(new Error(`The Keychron M6 did not answer command 0x${packet[0]?.toString(16)}.`));
      }, QUERY_TIMEOUT_MS);
      this.responseWaiter = {
        match,
        resolve: (bytes) => {
          window.clearTimeout(timeout);
          resolve(bytes);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      };
    });
    void response.catch(() => undefined);
    try {
      await this.device.sendReport(reportId, packet.buffer);
    } catch (error) {
      this.responseWaiter = null;
      const detail = error instanceof Error ? error.message : String(error);
      (rejectResponse as ((reason: Error) => void) | null)?.(
        new Error(`Chrome could not write Keychron M6 HID report. ${detail}`),
      );
    }
    return await response;
  }
}

/** 0x04 answer: [1] is the length of the ASCII version that starts at [2]. */
function decodeFirmwareString(bytes: Uint8Array): string | null {
  const length = Math.min(bytes[1] ?? 0, bytes.length - 2);
  const text = Array.from(bytes.slice(2, 2 + length))
    .filter((byte) => byte >= 0x20 && byte < 0x7f)
    .map((byte) => String.fromCharCode(byte))
    .join("")
    .trim();
  if (!text) return null;
  return text.startsWith("v") ? text : `v${text}`;
}

/** 0x02 answer: major at [8], minor and patch in the nibbles of [7]. */
function decodeFirmwareNibbles(bytes: Uint8Array): string | null {
  if (bytes.length < 9) return null;
  return `v${bytes[8]}.${(bytes[7] ?? 0) >> 4}.${(bytes[7] ?? 0) & 0x0f}`;
}
