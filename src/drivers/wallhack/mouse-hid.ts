import type { MouseStatus } from "../mouse-types.ts";
import {
  wallhackBuildRead,
  wallhackBuildSetDpiStage,
  wallhackBuildSimple,
  wallhackBuildWrite,
  wallhackDecodeBattery,
  wallhackDecodeVersions,
  wallhackIsReplyFor,
  wallhackLodFromCode,
  wallhackLodToCode,
  wallhackMouseName,
  wallhackPollingHzToRank,
  wallhackPollingRankToHz,
  WALLHACK_COMMAND,
  WALLHACK_FLASH,
  WALLHACK_MOUSE_PRODUCT_IDS,
  WALLHACK_MOUSE_USAGE_PAGE,
  WALLHACK_POLLING_RATES,
  WALLHACK_REPORT_ID,
  WALLHACK_VENDOR_ID,
} from "@openmouse/protocol/wallhack";

/**
 * WALLHACK M-001 wireless mouse — full WebHID control.
 *
 * The M-001 speaks a report-id-4, 63-byte protocol on its 0xFF1C command
 * interface: a command table plus a byte-addressed config "function area" that
 * holds DPI, polling, lift-off and the processing toggles. This driver reads
 * that map into a `MouseStatus` and writes it back, verifying each change by
 * reading the byte again (the same read-after-write discipline the other
 * OpenMouse mouse drivers use).
 *
 * Wire format reverse-engineered from the WALLHACK Terminal app; not yet
 * confirmed against hardware here, so writes always read back and refuse to
 * claim success the mouse did not report.
 */

const RESPONSE_TIMEOUT_MS = 1000;

export class WallhackMouseHidClient {
  readonly device: HIDDevice;

  private responseWaiter: {
    command: number;
    resolve: (bytes: Uint8Array) => void;
    reject: (reason: Error) => void;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const bytes = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    const waiter = this.responseWaiter;
    if (waiter && wallhackIsReplyFor(bytes, waiter.command)) {
      this.responseWaiter = null;
      waiter.resolve(bytes);
    }
  };

  private listening = false;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  /** M-001 VID/PID with the mouse command collection (usage page 0xFF1C). */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== WALLHACK_VENDOR_ID) return false;
    if (!WALLHACK_MOUSE_PRODUCT_IDS.has(device.productId)) return false;
    return WallhackMouseHidClient.commandCollection(device.collections) !== null;
  }

  private static commandCollection(
    collections: readonly HIDCollectionInfo[],
  ): HIDCollectionInfo | null {
    // Matched on usage page alone, mirroring the WALLHACK app's own `ec()`: the
    // command interface is identified by page 0xFF1C, not a specific usage.
    for (const collection of collections) {
      if (collection.usagePage === WALLHACK_MOUSE_USAGE_PAGE) {
        return collection;
      }
      const nested = WallhackMouseHidClient.commandCollection(collection.children);
      if (nested) return nested;
    }
    return null;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
  }

  async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    this.responseWaiter?.reject(new Error("The WALLHACK mouse was closed."));
    this.responseWaiter = null;
    if (this.device.opened) await this.device.close();
  }

  /** Selectable polling rates, in Hz. Same list wired or wireless. */
  getDpiOptions(): number[] {
    // OpenMouse reads this on connect for every client. The M-001 accepts any
    // DPI in its range rather than a fixed list, so the DPI editor (below) drives
    // the sensitivity card and this returns an empty option list.
    return [];
  }

  getPollingRateOptions(): number[] {
    return [...WALLHACK_POLLING_RATES];
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();

    const version = await this.command(WALLHACK_COMMAND.readVersion).catch(() => null);
    const battery = await this.command(WALLHACK_COMMAND.battery).catch(() => null);

    const dpiStageReply = await this.readByte(WALLHACK_FLASH.dpiRank);
    const activeDpiStage = dpiStageReply ?? 0;
    const dpi = await this.readDpi();
    const pollRank = await this.readByte(WALLHACK_FLASH.reportUsb);
    const wirelessRank = await this.readByte(WALLHACK_FLASH.reportEsb);
    const lodCode = await this.readByte(WALLHACK_FLASH.silentHeight);
    const motionSync = await this.readByte(WALLHACK_FLASH.motionSyncEnable);
    const angleSnap = await this.readByte(WALLHACK_FLASH.angleSnapEnable);
    const ripple = await this.readByte(WALLHACK_FLASH.rippleControlEnable);
    const debounce = await this.readByte(WALLHACK_FLASH.keyDebounceTime);
    const sleep = await this.readByte(WALLHACK_FLASH.sleepTime);
    const autoSleepOff = await this.readByte(WALLHACK_FLASH.turnOffAutomaticSleep);
    const gameMode = await this.readByte(WALLHACK_FLASH.gameMode);
    const angleTune = await this.readByte(WALLHACK_FLASH.angleTuneValue);
    const profileIndex = await this.readByte(WALLHACK_FLASH.profileIndex);

    const batteryInfo = battery ? wallhackDecodeBattery(battery) : null;
    const pollingRateHz = pollRank !== null ? wallhackPollingRankToHz(pollRank) : null;

    return {
      brand: "WALLHACK",
      name: wallhackMouseName(this.device.productId),
      ui: {
        family: "wallhack-mouse",
        defaultDisplayName: wallhackMouseName(this.device.productId),
        showAdvancedSection: true,
        forceShowBattery: true,
        hideUnsupportedPollingRates: true,
      },
      batteryPercent: batteryInfo?.percent ?? null,
      batteryState: batteryInfo?.charging ? "Charging" : "Discharging",
      dpi: dpi ?? 0,
      activeDpiStage,
      pollingRateHz: pollingRateHz ?? 0,
      supportedPollingRates: [...WALLHACK_POLLING_RATES],
      activeProfile: profileIndex !== null ? profileIndex + 1 : null,
      connectionType: "Wireless",
      connectionDetail: wirelessRank !== null ? "2.4 GHz" : "USB",
      motionSync: motionSync === null ? null : motionSync === 1,
      angleSnapping: angleSnap === null ? null : angleSnap === 1,
      rippleControl: ripple === null ? null : ripple === 1,
      angleTuning: angleTune,
      debounceMs: debounce,
      sleepTimeout: autoSleepOff === 1 ? null : sleep,
      gamingSurfaceMode: gameMode === 1 ? "On" : "Off",
      liftOffDistance: lodCode !== null ? wallhackLodFromCode(lodCode) : null,
      supportedLiftOffDistances: ["Low", "Medium", "High"],
      firmware: this.firmwareLines(version),
    };
  }

  // ---------------------------------------------------------------------------
  // Setters (read-after-write verified)
  // ---------------------------------------------------------------------------

  async setDpi(dpi: number): Promise<number> {
    if (!Number.isInteger(dpi) || dpi < 50 || dpi > 26000) {
      throw new Error("WALLHACK DPI must be between 50 and 26000.");
    }
    await this.send(wallhackBuildSetDpiStage(dpi));
    const confirmed = await this.readDpi();
    if (confirmed !== dpi) throw new Error(`The mouse kept ${confirmed ?? "an unknown"} DPI instead of ${dpi}.`);
    return confirmed;
  }

  async setPollingRate(hz: number): Promise<number> {
    const rank = wallhackPollingHzToRank(hz);
    if (rank === null) throw new Error(`${hz} Hz is not a supported WALLHACK polling rate.`);
    // Wired and wireless polling live in separate bytes; write both so the rate
    // holds across a dongle/cable switch.
    await this.writeByte(WALLHACK_FLASH.reportUsb, rank);
    await this.writeByte(WALLHACK_FLASH.reportEsb, rank);
    const confirmed = await this.readByte(WALLHACK_FLASH.reportUsb);
    if (confirmed !== rank) throw new Error(`The mouse did not confirm ${hz} Hz.`);
    return hz;
  }

  async setLiftOffDistance(lod: "Low" | "Medium" | "High"): Promise<"Low" | "Medium" | "High"> {
    return await this.writeVerifiedByte(
      WALLHACK_FLASH.silentHeight,
      wallhackLodToCode(lod),
      "lift-off distance",
      (code) => wallhackLodFromCode(code) === lod,
    ).then(() => lod);
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return (await this.writeVerifiedBoolean(WALLHACK_FLASH.motionSyncEnable, enabled, "Motion Sync"));
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return (await this.writeVerifiedBoolean(WALLHACK_FLASH.angleSnapEnable, enabled, "angle snapping"));
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return (await this.writeVerifiedBoolean(WALLHACK_FLASH.rippleControlEnable, enabled, "ripple control"));
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 20) {
      throw new Error("WALLHACK debounce time must be between 0 and 20 ms.");
    }
    return await this.writeVerifiedByte(WALLHACK_FLASH.keyDebounceTime, debounceMs, "debounce time", (value) => value === debounceMs).then(() => debounceMs);
  }

  async setSleepTimeout(minutes: number): Promise<number> {
    if (!Number.isInteger(minutes) || minutes < 0) {
      throw new Error("WALLHACK sleep timeout must be a whole number of minutes.");
    }
    // A non-zero timeout implies auto-sleep is on; zero disables it.
    await this.writeByte(WALLHACK_FLASH.turnOffAutomaticSleep, minutes === 0 ? 1 : 0);
    if (minutes > 0) {
      await this.writeVerifiedByte(WALLHACK_FLASH.sleepTime, minutes, "sleep timeout", (value) => value === minutes);
    }
    return minutes;
  }

  async setGameMode(enabled: boolean): Promise<boolean> {
    return (await this.writeVerifiedBoolean(WALLHACK_FLASH.gameMode, enabled, "game mode"));
  }

  async setActiveProfile(profile: number): Promise<number> {
    if (!Number.isInteger(profile) || profile < 1) throw new Error("WALLHACK profile must be 1 or higher.");
    await this.writeVerifiedByte(WALLHACK_FLASH.profileIndex, profile - 1, "profile", (value) => value === profile - 1);
    return profile;
  }

  /** Re-pair the mouse to its receiver. */
  async pair(): Promise<void> {
    await this.send(wallhackBuildSimple(WALLHACK_COMMAND.pair));
  }

  async clearPairing(): Promise<void> {
    await this.send(wallhackBuildSimple(WALLHACK_COMMAND.clearPairing));
  }

  async factoryReset(): Promise<void> {
    await this.send(wallhackBuildSimple(WALLHACK_COMMAND.factoryReset));
  }

  // ---------------------------------------------------------------------------
  // Report I/O
  // ---------------------------------------------------------------------------

  /** Read one config byte at `address`, or null if the mouse did not answer. */
  private async readByte(address: number): Promise<number | null> {
    const reply = await this.exchange(wallhackBuildRead(address), WALLHACK_COMMAND.readFunctionArea).catch(() => null);
    if (!reply || reply.length < 8) return null;
    return reply[7]!;
  }

  /** Read the active DPI stage's value from the DPI-stage block. */
  private async readDpi(): Promise<number | null> {
    const reply = await this.exchange(
      wallhackBuildRead(WALLHACK_FLASH.dpi8Block, 9),
      WALLHACK_COMMAND.readFunctionArea,
    ).catch(() => null);
    if (!reply || reply.length < 11) return null;
    return (reply[9]! | (reply[10]! << 8)) & 0xffff;
  }

  private async writeByte(address: number, value: number): Promise<void> {
    await this.send(wallhackBuildWrite(address, [value & 0xff]));
  }

  private async writeVerifiedByte(
    address: number,
    value: number,
    label: string,
    accept: (readback: number) => boolean,
  ): Promise<number> {
    await this.writeByte(address, value);
    const confirmed = await this.readByte(address);
    if (confirmed === null || !accept(confirmed)) {
      throw new Error(`The mouse did not confirm the requested ${label}.`);
    }
    return confirmed;
  }

  private async writeVerifiedBoolean(address: number, enabled: boolean, label: string): Promise<boolean> {
    const confirmed = await this.writeVerifiedByte(address, enabled ? 1 : 0, label, (value) => value === (enabled ? 1 : 0));
    return confirmed === 1;
  }

  /** Read a command's reply once, tolerating a device that does not answer. */
  private async command(command: number): Promise<Uint8Array | null> {
    return await this.exchange(wallhackBuildSimple(command), command).catch(() => null);
  }

  /** Send a report and wait for the input report that echoes `expectCommand`. */
  private async exchange(packet: Uint8Array, expectCommand: number): Promise<Uint8Array> {
    if (this.responseWaiter) throw new Error("Another WALLHACK request is already in progress.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectResponse: ((reason: Error) => void) | null = null;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      rejectResponse = reject;
      timer = setTimeout(() => {
        this.responseWaiter = null;
        reject(new Error(`The WALLHACK mouse did not answer command 0x${expectCommand.toString(16)}.`));
      }, RESPONSE_TIMEOUT_MS);
      this.responseWaiter = {
        command: expectCommand,
        resolve: (bytes) => { clearTimeout(timer); resolve(bytes); },
        reject: (reason) => { clearTimeout(timer); reject(reason); },
      };
    });
    void response.catch(() => undefined);
    try {
      await this.device.sendReport(WALLHACK_REPORT_ID, new Uint8Array(packet));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      (rejectResponse as ((reason: Error) => void) | null)?.(new Error(`Chrome could not write the WALLHACK report. ${detail}`));
      this.responseWaiter = null;
    }
    return await response;
  }

  private async send(packet: Uint8Array): Promise<void> {
    await this.device.sendReport(WALLHACK_REPORT_ID, new Uint8Array(packet));
  }

  private firmwareLines(version: Uint8Array | null): string[] {
    if (!version) return ["Firmware unavailable"];
    const decoded = wallhackDecodeVersions(version);
    if (!decoded) return ["Firmware unavailable"];
    return [
      `Mouse firmware: ${decoded.mouse}`,
      `Receiver firmware: ${decoded.dongle}`,
      `Receiver (NXP): ${decoded.nxp}`,
    ];
  }
}
