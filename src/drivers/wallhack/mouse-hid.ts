import type { MouseStatus } from "../mouse-types.ts";
import {
  wallhackBuildCurveRead,
  wallhackBuildCustomCurveWrite,
  wallhackBuildGetKeys,
  wallhackBuildGetMacro,
  wallhackBuildRead,
  wallhackBuildSetDpiStage,
  wallhackBuildSetKeys,
  wallhackBuildSetMacro,
  wallhackBuildSimple,
  wallhackBuildWrite,
  wallhackBindingFromLabel,
  wallhackBindingLabel,
  wallhackCurveModeFromIndex,
  wallhackCurveStatusText,
  wallhackDecodeBattery,
  wallhackDecodeCustomCurve,
  wallhackDecodeKeysReply,
  wallhackDecodeMacro,
  wallhackDecodePresetCurve,
  wallhackDecodeTriplet,
  wallhackDecodeVersions,
  wallhackEncodeBinding,
  wallhackEncodeMacro,
  wallhackIsReplyFor,
  wallhackLodFromCode,
  wallhackLodToCode,
  wallhackMacroIndexAddress,
  wallhackMacroReplyBytes,
  wallhackMacroWriteBlocks,
  wallhackMouseName,
  wallhackPollingHzToRank,
  wallhackPollingRankToHz,
  wallhackRawToSensorAngle,
  wallhackScanningModeFromByte,
  wallhackScanningModeToByte,
  wallhackSensorAngleToRaw,
  wallhackTripletsEqual,
  WALLHACK_BUTTON_OPTIONS,
  WALLHACK_BUTTON_ORDER,
  WALLHACK_COMMAND,
  WALLHACK_CURVE_ADDRESS,
  WALLHACK_CURVE_MODE_INDEX,
  WALLHACK_FLASH,
  WALLHACK_KEY_SLOTS,
  WALLHACK_MACRO_SLOTS,
  WALLHACK_MACRO_SLOT_BYTES,
  WALLHACK_MOUSE_PRODUCT_IDS,
  WALLHACK_MOUSE_USAGE_PAGE,
  WALLHACK_POLLING_RATES,
  WALLHACK_REPORT_ID,
  WALLHACK_VENDOR_ID,
  type WallhackCurveMode,
  type WallhackCurvePoint,
  type WallhackMacroStep,
  type WallhackSensorScanningMode,
  type WallhackTriplet,
} from "@openmouse/protocol/wallhack";

/**
 * WALLHACK M-001 wireless mouse — full WebHID control.
 *
 * The M-001 speaks a report-id-4, 63-byte protocol on its 0xFF1C command
 * interface: a command table plus a byte-addressed config "function area" that
 * holds DPI, polling, lift-off and the processing toggles, an 8-slot button
 * table (GET_KEYS/SET_KEYS), 4 onboard macro slots (GET_MACRO/SET_MACRO) and
 * 4 DPI-acceleration curve tables. This driver reads that state into a
 * `MouseStatus` and writes it back, verifying each change by reading the
 * value again (the same read-after-write discipline the other OpenMouse
 * mouse drivers use).
 *
 * Wire format reverse-engineered from the WALLHACK Terminal app
 * (terminal.wallhack.com, bundle `index-DVQlQedp.js` plus the
 * `WallHack_K-001_V*.js` firmware chunks); not yet confirmed against
 * hardware here, so writes always read back and refuse to claim success the
 * mouse did not report. Feature gates observed in the app (mouse-Nordic
 * firmware): sensor scanning 52+, button mapping and sensor rotation 53+,
 * macros and dynamic sensitivity 57+.
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
    const sleepSeconds = await this.readSleepSeconds();
    const autoSleepOff = await this.readByte(WALLHACK_FLASH.turnOffAutomaticSleep);
    const gameMode = await this.readByte(WALLHACK_FLASH.gameMode);
    const angleTune = await this.readByte(WALLHACK_FLASH.angleTuneValue);
    const profileIndex = await this.readByte(WALLHACK_FLASH.profileIndex);
    const dynEnabled = await this.readByte(WALLHACK_FLASH.dynamicDpiEnable);
    const dynMode = await this.readByte(WALLHACK_FLASH.dynamicDpiMode);
    const dynReporting = await this.readByte(WALLHACK_FLASH.dynamicDpiCoordinateReportEnable);
    const buttons = await this.readButtonBindings().catch(() => null);

    const batteryInfo = battery ? wallhackDecodeBattery(battery) : null;
    const pollingRateHz = pollRank !== null ? wallhackPollingRankToHz(pollRank) : null;
    const sensorAngle = angleTune !== null ? wallhackRawToSensorAngle(angleTune) : null;

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
      angleTuning: sensorAngle,
      sensorScanningMode: gameMode !== null ? wallhackScanningModeFromByte(gameMode) : null,
      dynamicSensitivityEnabled: dynEnabled === null ? null : dynEnabled !== 0,
      dynamicSensitivityMode: dynMode !== null ? wallhackCurveModeFromIndex(dynMode) : null,
      dynamicSensitivitySpeedReporting: dynReporting === null ? null : dynReporting !== 0,
      debounceMs: debounce,
      sleepTimeout: autoSleepOff === 1 ? null : sleepSeconds !== null ? Math.round(sleepSeconds / 60) : null,
      liftOffDistance: lodCode !== null ? wallhackLodFromCode(lodCode) : null,
      supportedLiftOffDistances: ["Low", "Medium", "High"],
      ...(buttons !== null ? { buttonMappings: buttons.mappings, buttonOptions: buttons.options } : {}),
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
      // The timer is a u16LE second count at `sleepTime` (1-30 minutes).
      if (minutes < 1 || minutes > 30) throw new Error("WALLHACK sleep timeout must be between 1 and 30 minutes.");
      const seconds = minutes * 60;
      await this.send(wallhackBuildWrite(WALLHACK_FLASH.sleepTime, [seconds & 0xff, (seconds >> 8) & 0xff]));
      const confirmed = await this.readSleepSeconds();
      if (confirmed === null || Math.round(confirmed / 60) !== minutes) {
        throw new Error("The mouse did not confirm the requested sleep timeout.");
      }
    }
    return minutes;
  }

  /**
   * Sensor rotation in degrees (-30..+30). The `angleTuneValue` byte stores
   * degrees + 30. Picked up by OpenMouse as `angleTuningWritable`.
   */
  async setAngleTuning(degrees: number): Promise<number> {
    const raw = wallhackSensorAngleToRaw(degrees);
    await this.writeVerifiedByte(WALLHACK_FLASH.angleTuneValue, raw, "sensor angle", (value) => value === raw);
    return degrees;
  }

  /**
   * Sensor scanning mode: HIGH is the default frame rate, ACCEL pins the
   * sensor to high performance at higher battery cost. Needs mouse
   * firmware 52+.
   */
  async setSensorScanningMode(mode: WallhackSensorScanningMode): Promise<WallhackSensorScanningMode> {
    await this.writeVerifiedByte(
      WALLHACK_FLASH.gameMode,
      wallhackScanningModeToByte(mode),
      "sensor scanning mode",
      (value) => wallhackScanningModeFromByte(value) === mode,
    );
    return mode;
  }

  async setGameMode(enabled: boolean): Promise<boolean> {
    return (await this.writeVerifiedBoolean(WALLHACK_FLASH.gameMode, enabled, "game mode"));
  }

  // ---------------------------------------------------------------------------
  // Dynamic sensitivity (DPI acceleration) curves. Needs mouse firmware 57+.
  // ---------------------------------------------------------------------------

  async setDynamicSensitivityEnabled(enabled: boolean): Promise<boolean> {
    return (await this.writeVerifiedBoolean(WALLHACK_FLASH.dynamicDpiEnable, enabled, "dynamic sensitivity"));
  }

  async setDynamicSensitivityMode(mode: WallhackCurveMode): Promise<WallhackCurveMode> {
    const index = WALLHACK_CURVE_MODE_INDEX[mode];
    if (index === undefined) throw new Error(`Unknown WALLHACK curve mode "${mode}".`);
    await this.writeVerifiedByte(WALLHACK_FLASH.dynamicDpiMode, index, "dynamic sensitivity mode", (value) => value === index);
    return mode;
  }

  async setDynamicSensitivitySpeedReporting(enabled: boolean): Promise<boolean> {
    return (await this.writeVerifiedBoolean(
      WALLHACK_FLASH.dynamicDpiCoordinateReportEnable,
      enabled,
      "dynamic sensitivity speed reporting",
    ));
  }

  /** Read all four curve tables (classic/natural/jump/custom). */
  async getDynamicSensitivityCurves(): Promise<Record<WallhackCurveMode, WallhackCurvePoint[]>> {
    await this.open();
    const curves = {} as Record<WallhackCurveMode, WallhackCurvePoint[]>;
    for (const mode of ["classic", "natural", "jump", "custom"] as const) {
      curves[mode] = await this.readCurve(mode);
    }
    return curves;
  }

  /**
   * Replace the custom curve table (exactly 5 points, speed 0-280 strictly
   * increasing, gain a multiple of 0.01 in 0.10-6.00). Verified by re-read.
   */
  async setCustomCurve(points: readonly WallhackCurvePoint[]): Promise<WallhackCurvePoint[]> {
    await this.open();
    await this.send(wallhackBuildCustomCurveWrite(points));
    const confirmed = await this.readCurve("custom");
    const wanted = [...points].map((point) => ({ speed: point.speed, gain: Math.round(point.gain * 100) / 100 }));
    const same = confirmed.length === wanted.length &&
      confirmed.every((point, index) => point.speed === wanted[index]!.speed && point.gain === wanted[index]!.gain);
    if (!same) throw new Error("The mouse did not confirm the custom curve.");
    return confirmed;
  }

  private async readCurve(mode: WallhackCurveMode): Promise<WallhackCurvePoint[]> {
    const reply = await this.exchange(wallhackBuildCurveRead(mode), WALLHACK_COMMAND.readFunctionArea);
    const status = wallhackCurveStatusText(reply);
    if (status !== "ok") throw new Error(`The mouse refused the ${mode} curve read: ${status}.`);
    const address = (reply[4]! | (reply[5]! << 8)) & 0xffff;
    if (address !== WALLHACK_CURVE_ADDRESS[mode]) {
      throw new Error(`The mouse answered the ${mode} curve read with address ${address}.`);
    }
    const length = reply[3]!;
    const payload = reply.subarray(7, 7 + Math.min(length, reply.length - 7));
    const points = mode === "custom" ? wallhackDecodeCustomCurve(payload) : wallhackDecodePresetCurve(payload);
    if (!points) throw new Error(`The mouse returned a malformed ${mode} curve.`);
    return points;
  }

  // ---------------------------------------------------------------------------
  // Button bindings. Needs mouse firmware 53+.
  // ---------------------------------------------------------------------------

  /**
   * Read the 8 key slots and render the five physical buttons as
   * OpenMouse `buttonMappings`, with the fixed `buttonOptions` list. The
   * shared button remapper appears when these are set together with
   * `setButtonMapping`.
   */
  async readButtonBindings(): Promise<{ mappings: Record<string, string>; options: string[] }> {
    const triplets = await this.readKeySlots();
    const mappings: Record<string, string> = {};
    WALLHACK_BUTTON_ORDER.forEach((button, slot) => {
      mappings[WallhackMouseHidClient.buttonLabel(button)] = wallhackBindingLabel(
        wallhackDecodeTriplet(triplets[slot] ?? { keyType: 0, codeL: 0, codeH: 0 }),
      );
    });
    return { mappings, options: [...WALLHACK_BUTTON_OPTIONS] };
  }

  /**
   * Reassign a physical button ("Left", "Right", "Middle", "Back", "Forward")
   * to an action label from `buttonOptions` (plus the parametric `Rapid
   * Fire …`, `Macro …` and `Key …` forms). Verified by re-read.
   */
  async setButtonMapping(button: string, action: string): Promise<void> {
    const slot = WALLHACK_BUTTON_ORDER.indexOf(button.toLowerCase() as (typeof WALLHACK_BUTTON_ORDER)[number]);
    if (slot < 0) throw new Error(`This mouse has no "${button}" button.`);
    const binding = wallhackBindingFromLabel(action);
    const triplet = wallhackEncodeBinding(binding);
    await this.send(wallhackBuildSetKeys([triplet], slot * 3));
    const triplets = await this.readKeySlots();
    const confirmed = triplets[slot];
    if (!confirmed || !wallhackTripletsEqual(confirmed, triplet)) {
      throw new Error(`The mouse kept another binding on ${button} instead of ${action}.`);
    }
  }

  /** Restore the five physical buttons to left/right/middle/back/forward. */
  async resetButtonMappings(): Promise<void> {
    const triplets = await this.readKeySlots();
    WALLHACK_BUTTON_ORDER.forEach((button, slot) => {
      triplets[slot] = wallhackEncodeBinding({ kind: "mouseButton", button });
    });
    await this.send(wallhackBuildSetKeys(triplets, 0));
    const confirmed = await this.readKeySlots();
    const same = triplets.every((triplet, index) => {
      const other = confirmed[index];
      return other !== undefined && wallhackTripletsEqual(triplet, other);
    });
    if (!same) throw new Error("The mouse did not confirm the button reset.");
  }

  private async readKeySlots(): Promise<WallhackTriplet[]> {
    const reply = await this.exchange(wallhackBuildGetKeys(), WALLHACK_COMMAND.getKeys);
    const triplets = wallhackDecodeKeysReply(reply);
    if (!triplets || triplets.length < WALLHACK_KEY_SLOTS) {
      throw new Error("The mouse returned a malformed button table.");
    }
    return triplets;
  }

  private static buttonLabel(button: string): string {
    return button.charAt(0).toUpperCase() + button.slice(1);
  }

  // ---------------------------------------------------------------------------
  // Onboard macros (4 slots, up to 30 steps each). Needs mouse firmware 57+.
  // ---------------------------------------------------------------------------

  /** Read the four macro slots; empty slots come back as null. */
  async getMacros(): Promise<(WallhackMacroStep[] | null)[]> {
    await this.open();
    const indexBytes = await this.exchange(
      wallhackBuildGetMacro(wallhackMacroIndexAddress(0), WALLHACK_MACRO_SLOTS * 2),
      WALLHACK_COMMAND.getMacro,
    );
    const indexPayload = wallhackMacroReplyBytes(indexBytes);
    if (!indexPayload || indexPayload.length < WALLHACK_MACRO_SLOTS * 2) {
      throw new Error("The mouse returned a malformed macro index.");
    }
    const slots: (WallhackMacroStep[] | null)[] = [];
    for (let slot = 0; slot < WALLHACK_MACRO_SLOTS; slot++) {
      const address = (indexPayload[slot * 2]! | (indexPayload[slot * 2 + 1]! << 8)) & 0xffff;
      if (address === 0 || address === 0xffff) {
        slots.push(null);
        continue;
      }
      const content = await this.exchange(
        wallhackBuildGetMacro(address, WALLHACK_MACRO_SLOT_BYTES),
        WALLHACK_COMMAND.getMacro,
      );
      const bytes = wallhackMacroReplyBytes(content);
      const steps = bytes ? wallhackDecodeMacro(bytes) : null;
      slots.push(steps);
    }
    return slots;
  }

  /**
   * Store `steps` in macro slot 0-3, allocating device storage the same way
   * the vendor app does, and verify by re-read. Use `clearMacroSlot` for an
   * empty macro.
   */
  async setMacroSlot(slot: number, steps: readonly WallhackMacroStep[]): Promise<WallhackMacroStep[]> {
    await this.open();
    const record = wallhackEncodeMacro(steps);
    const index = await this.readMacroIndex();
    for (const block of wallhackMacroWriteBlocks(slot, record, index)) {
      await this.send(wallhackBuildSetMacro(block.offset, block.bytes));
    }
    const slots = await this.getMacros();
    const confirmed = slots[slot];
    if (!confirmed || confirmed.length !== steps.length) {
      throw new Error(`The mouse did not confirm macro slot ${slot + 1}.`);
    }
    return confirmed;
  }

  /** Clear macro slot 0-3 (frees its storage on the device). */
  async clearMacroSlot(slot: number): Promise<void> {
    await this.open();
    const index = await this.readMacroIndex();
    for (const block of wallhackMacroWriteBlocks(slot, new Uint8Array(0), index)) {
      await this.send(wallhackBuildSetMacro(block.offset, block.bytes));
    }
    const slots = await this.getMacros();
    if (slots[slot] !== null && slots[slot]!.length !== 0) {
      throw new Error(`The mouse did not clear macro slot ${slot + 1}.`);
    }
  }

  private async readMacroIndex(): Promise<Map<number, number>> {
    const reply = await this.exchange(
      wallhackBuildGetMacro(wallhackMacroIndexAddress(0), WALLHACK_MACRO_SLOTS * 2),
      WALLHACK_COMMAND.getMacro,
    );
    const payload = wallhackMacroReplyBytes(reply);
    if (!payload || payload.length < WALLHACK_MACRO_SLOTS * 2) {
      throw new Error("The mouse returned a malformed macro index.");
    }
    const index = new Map<number, number>();
    for (let slot = 0; slot < WALLHACK_MACRO_SLOTS; slot++) {
      index.set(slot, (payload[slot * 2]! | (payload[slot * 2 + 1]! << 8)) & 0xffff);
    }
    return index;
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

  /** Sleep timer as raw seconds (u16LE at `sleepTime`), or null. */
  private async readSleepSeconds(): Promise<number | null> {
    const reply = await this.exchange(wallhackBuildRead(WALLHACK_FLASH.sleepTime, 2), WALLHACK_COMMAND.readFunctionArea)
      .catch(() => null);
    if (!reply || reply.length < 9) return null;
    const seconds = (reply[7]! | (reply[8]! << 8)) & 0xffff;
    const minutes = Math.round(seconds / 60);
    return minutes >= 1 && minutes <= 30 ? seconds : null;
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
