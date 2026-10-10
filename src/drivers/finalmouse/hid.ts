import type { MouseStatus } from "../mouse-types.js";
import {
  buildFinalmouseReport,
  decodeFinalmouseReport,
  encodeFinalmouseClickMode,
  encodeFinalmouseDongleLedData,
  encodeFinalmouseIndicatorColor,
  encodeFinalmouseProfileData,
  encodeFinalmouseProfileEnable,
  encodeFinalmouseProfileName,
  encodeFinalmouseTmrActuation,
  encodeFinalmouseTmrMsp,
  FINALMOUSE_COMMAND,
  FINALMOUSE_PROFILE,
  FINALMOUSE_REPORT,
  FINALMOUSE_SLX_DONGLE_PRODUCT_IDS,
  FINALMOUSE_VENDOR_ID as PROTOCOL_VENDOR_ID,
  finalmouseActuationMmToSteps,
  finalmousePawLodMmToRaw,
  finalmousePawLodRawToMm,
  finalmouseSignalStrength,
  type FinalmouseProfileData,
  type FinalmouseProfileLed,
  type FinalmouseTelemetry,
} from "@openmouse/protocol/finalmouse";

export const FINALMOUSE_VENDOR_ID = PROTOCOL_VENDOR_ID;
export const FINALMOUSE_ULX_DONGLE_PRODUCT_ID = 0x0100;
export const FINALMOUSE_DISPLAY_NAME = "Finalmouse UltralightX";
export const FINALMOUSE_SLX_DISPLAY_NAME = "Finalmouse Starlight X";

const POLLING_RATES = [500, 1000, 2000, 4000, 8000] as const;
const DPI_MIN = 50;
const DPI_MAX = 26000;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FinalmouseHidClient {
  readonly device: HIDDevice;
  private telemetry: FinalmouseTelemetry = {};
  private reportRevision = 0;
  private listenerAttached = false;
  private readonly reportWaiters = new Set<() => void>();

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const bytes = new Uint8Array(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
    const update = decodeFinalmouseReport(event.reportId, bytes);
    if (!update) return;
    // Profile names and per-profile LEDs arrive one index per reply, so they
    // accumulate instead of replacing each other.
    const { profileNames, profileLeds, ...rest } = update;
    Object.assign(this.telemetry, rest);
    if (profileNames) this.telemetry.profileNames = { ...this.telemetry.profileNames, ...profileNames };
    if (profileLeds) this.telemetry.profileLeds = { ...this.telemetry.profileLeds, ...profileLeds };
    this.reportRevision += 1;
    for (const finish of [...this.reportWaiters]) finish();
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== FINALMOUSE_VENDOR_ID) return false;
    if (
      device.productId === FINALMOUSE_ULX_DONGLE_PRODUCT_ID
      && device.collections.some((collection) => collection.usagePage === 0xff00 && collection.usage === 0x0001)
    ) return true;
    // Starlight X dongles share the 0xff00 vendor page; the exact usage is
    // not pinned down, so only the page is required.
    return (FINALMOUSE_SLX_DONGLE_PRODUCT_IDS as readonly number[]).includes(device.productId)
      && device.collections.some((collection) => collection.usagePage === 0xff00);
  }

  /** True once constructed on a Starlight X dongle PID. */
  get isSlx(): boolean {
    return (FINALMOUSE_SLX_DONGLE_PRODUCT_IDS as readonly number[]).includes(this.device.productId);
  }

  /** Output report: 0x04 on ULX, 0x01 on SLX (xpanel `_r`; see finalmouse/index.ts). */
  private get txReport(): number {
    return this.isSlx ? FINALMOUSE_REPORT.slx : FINALMOUSE_REPORT.main;
  }

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

  displayName(): string {
    return this.isSlx ? FINALMOUSE_SLX_DISPLAY_NAME : FINALMOUSE_DISPLAY_NAME;
  }

  get pollIntervalMs(): number {
    return 10_000;
  }

  getDpiOptions(): number[] {
    return Array.from({ length: DPI_MAX - DPI_MIN + 1 }, (_, index) => DPI_MIN + index);
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const revision = this.reportRevision;
    const slx = this.isSlx;
    const tx = this.txReport;
    await this.write(tx, slx ? FINALMOUSE_COMMAND.profile : FINALMOUSE_COMMAND.liftOffDistance);
    if (slx) {
      // xpanel polls these only for Starlight X; ULX never answers them, so
      // they stay gated here to keep the ULX burst byte-identical.
      await this.write(tx, FINALMOUSE_COMMAND.clickMode);
      await this.write(tx, FINALMOUSE_COMMAND.tmrActuation);
      await this.write(tx, FINALMOUSE_COMMAND.tmrMsp);
      await this.write(tx, FINALMOUSE_COMMAND.profileEnable);
      await this.write(tx, FINALMOUSE_COMMAND.pawLod);
    }
    // On SLX every command shares output report 0x01 (xpanel `_r`); on ULX
    // the wake/all + dongle-info reports keep their historical IDs.
    await this.write(tx, FINALMOUSE_COMMAND.wakeAll);
    await this.write(slx ? tx : FINALMOUSE_REPORT.dongle, FINALMOUSE_COMMAND.dongleInfo);
    await this.waitForReport(revision, 1000);
    // Status arrives as a short burst of separate feature reports.
    await pause(75);

    const state = this.telemetry;
    if (state.dpi === undefined || state.pollingRateHz === undefined) {
      throw new Error("The Finalmouse UltralightX did not return its current settings. Make sure the mouse is on and close xpanel or other Finalmouse software.");
    }
    const firmware = [
      state.mouseFirmware ? `Mouse ${state.mouseFirmware}` : null,
      state.dongleRfFirmware ? `Dongle RF ${state.dongleRfFirmware}` : null,
      state.dongleUsbFirmware ? `Dongle USB ${state.dongleUsbFirmware}` : null,
    ].filter((value): value is string => value !== null);
    const connectionDetail = [
      "2.4 GHz receiver",
      state.rssiDbm === undefined ? null : `${state.rssiDbm} dBm`,
    ].filter((value): value is string => value !== null).join(" · ");

    return {
      brand: "Finalmouse",
      name: this.displayName(),
      ui: {
        family: slx ? "finalmouse-slx" : "finalmouse-ulx",
        defaultDisplayName: slx ? FINALMOUSE_SLX_DISPLAY_NAME : FINALMOUSE_DISPLAY_NAME,
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
      },
      batteryPercent: state.batterySoc ?? state.batteryPercent ?? null,
      batteryVoltageMv: state.batteryVoltageMv ?? null,
      batteryState: state.chargingState === 1 ? "Charging" : state.chargingState === undefined ? "Unknown" : "Discharging",
      dpi: state.dpi,
      pollingRateHz: state.pollingRateHz,
      supportedPollingRates: [...POLLING_RATES],
      activeProfile: null,
      unitId: state.mouseSerial ?? null,
      connectionType: "Wireless",
      connectionDetail,
      motionSync: state.motionSync ?? null,
      signalStrength: finalmouseSignalStrength(state.rssiDbm, state.linkState),
      ...this.liftOffStatus(state, slx),
      finalmouseIsSlx: slx,
      finalmouseDongleLedMode: state.dongleLedMode ?? null,
      finalmouseTournamentScrollMode: state.tournamentScrollMode ?? null,
      finalmouseTournamentScrollTimeoutMs: state.tournamentScrollTimeoutMs ?? null,
      finalmouseClickModeL: state.clickModeL ?? null,
      finalmouseClickModeR: state.clickModeR ?? null,
      finalmouseClickReleaseL: state.clickReleaseL ?? null,
      finalmouseClickReleaseR: state.clickReleaseR ?? null,
      finalmouseTmrThrL: state.tmrThrL ?? null,
      finalmouseTmrThrR: state.tmrThrR ?? null,
      finalmouseTmrHystL: state.tmrHystL ?? null,
      finalmouseTmrHystR: state.tmrHystR ?? null,
      finalmouseTmrMspL: state.tmrMspL ?? null,
      finalmouseTmrMspR: state.tmrMspR ?? null,
      finalmousePawLodMm: state.pawLodMm ?? null,
      finalmousePawLodCustom: state.pawLodCustom ?? null,
      finalmouseProfileCount: state.profileCount ?? null,
      finalmouseProfileActive: state.profileActive ?? null,
      finalmouseProfileEnabledMask: state.profileEnabledMask ?? null,
      finalmouseProfileNames: state.profileNames ? { ...state.profileNames } : null,
      firmware,
    };
  }

  /**
   * Lift-off mapping. ULX reports legacy stops (1/2 mm); SLX reports PAW
   * values where presets stay on the segmented control and custom values
   * use the continuous `liftOffScale` slider (raw codes 7-17 = 0.7-1.7 mm).
   */
  private liftOffStatus(
    state: FinalmouseTelemetry,
    slx: boolean,
  ): Pick<MouseStatus, "liftOffDistance" | "supportedLiftOffDistances" | "liftOffScale"> {
    if (slx && state.pawLodMm !== undefined) {
      const mm = state.pawLodMm;
      if (state.pawLodCustom === true) {
        const raw = finalmousePawLodMmToRaw(mm) ?? Math.round(mm * 10);
        return {
          liftOffDistance: mm < 1 ? "Low" : mm < 1.5 ? "Medium" : "High",
          supportedLiftOffDistances: ["Low", "Medium", "High"],
          liftOffScale: {
            value: raw,
            min: 7,
            max: 17,
            millimetres: mm,
            minMillimetres: 0.7,
            maxMillimetres: 1.7,
          },
        };
      }
      return {
        liftOffDistance: mm <= 1 ? "Medium" : "High",
        supportedLiftOffDistances: ["Medium", "High"],
        liftOffScale: null,
      };
    }
    return {
      liftOffDistance: state.liftOffDistanceMm === 1 ? "Medium" : state.liftOffDistanceMm === 2 ? "High" : null,
      supportedLiftOffDistances: ["Medium", "High"],
      liftOffScale: null,
    };
  }

  async setDpi(dpi: number): Promise<number> {
    if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX) throw new Error("Finalmouse UltralightX DPI must be between 50 and 26,000.");
    await this.writeU16(FINALMOUSE_COMMAND.dpi, dpi);
    this.telemetry.dpi = dpi;
    return dpi;
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    if (!(POLLING_RATES as readonly number[]).includes(pollingRateHz)) throw new Error("Unsupported Finalmouse UltralightX polling rate.");
    await this.writeU16(FINALMOUSE_COMMAND.pollingRate, pollingRateHz);
    this.telemetry.pollingRateHz = pollingRateHz;
    return pollingRateHz;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    await this.write(this.txReport, FINALMOUSE_COMMAND.motionSync, new Uint8Array([enabled ? 1 : 0]));
    this.telemetry.motionSync = enabled;
    return enabled;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    const millimeters = value === "Medium" ? 1 : value === "High" ? 2 : null;
    if (millimeters === null) throw new Error("Finalmouse UltralightX lift-off distance must be 1 mm or 2 mm.");
    await this.write(this.txReport, FINALMOUSE_COMMAND.liftOffDistance, new Uint8Array([millimeters]));
    this.telemetry.liftOffDistanceMm = millimeters;
    return value;
  }

  async setDongleLedMode(mode: number): Promise<number> {
    if (![0, 1, 2].includes(mode)) throw new Error("Unsupported Finalmouse dongle LED mode.");
    await this.write(this.txReport, FINALMOUSE_COMMAND.dongleLed, new Uint8Array([mode]));
    this.telemetry.dongleLedMode = mode;
    return mode;
  }

  async setTournamentScrollMode(mode: number): Promise<number> {
    if (![0, 1, 2, 3].includes(mode)) throw new Error("Unsupported Finalmouse tournament scroll mode.");
    await this.write(this.txReport, FINALMOUSE_COMMAND.tournamentScrollMode, new Uint8Array([mode]));
    this.telemetry.tournamentScrollMode = mode;
    return mode;
  }

  async setTournamentScrollTimeout(milliseconds: number): Promise<number> {
    if (![100, 500, 1000, 1500].includes(milliseconds)) throw new Error("Unsupported Finalmouse tournament scroll timeout.");
    await this.write(this.txReport, FINALMOUSE_COMMAND.tournamentScrollTimeout, new Uint8Array([milliseconds / 100]));
    this.telemetry.tournamentScrollTimeoutMs = milliseconds;
    return milliseconds;
  }

  /**
   * Continuous lift-off for Starlight X (PAW raw codes 7-17 = 0.7-1.7 mm).
   * This is the shared `setLiftOffScale` hook the app's LOD slider and game
   * profiles call. ULX keeps the segmented `setLiftOffDistance` instead.
   */
  async setLiftOffScale(code: number): Promise<number> {
    this.requireSlx("Custom lift-off");
    if (!Number.isInteger(code) || code < 7 || code > 17) {
      throw new Error("Finalmouse custom lift-off code must be 7-17 (0.7-1.7 mm).");
    }
    await this.write(this.txReport, FINALMOUSE_COMMAND.pawLod, new Uint8Array([code]));
    this.telemetry.pawLodMm = code / 10;
    this.telemetry.pawLodCustom = true;
    return code;
  }

  /** Starlight X PAW lift-off presets (1 mm / 2 mm) and custom steps. */
  async setPawLodMm(mm: number): Promise<number> {
    this.requireSlx("Custom lift-off");
    const raw = finalmousePawLodMmToRaw(mm);
    if (raw === null) throw new Error("Finalmouse PAW lift-off must be 1, 2, or a 0.7-1.7 mm step.");
    await this.write(this.txReport, FINALMOUSE_COMMAND.pawLod, new Uint8Array([raw]));
    this.telemetry.pawLodMm = finalmousePawLodRawToMm(raw) ?? mm;
    this.telemetry.pawLodCustom = raw >= 7;
    return this.telemetry.pawLodMm;
  }

  /**
   * Starlight X click mode per switch (0 mechanical, 1 TMR analog) with an
   * optional release point for both (0 normal, 1 early, 2 late). Analog
   * needs that side calibrated; the device keeps the previous mode otherwise.
   */
  async setClickMode(modeL: number, modeR: number, relL?: number, relR?: number): Promise<void> {
    this.requireSlx("Click mode");
    await this.write(this.txReport, FINALMOUSE_COMMAND.clickMode, encodeFinalmouseClickMode(modeR, modeL, relR, relL));
    this.telemetry.clickModeL = modeL;
    this.telemetry.clickModeR = modeR;
    if (relL !== undefined && relR !== undefined) {
      this.telemetry.clickReleaseL = relL;
      this.telemetry.clickReleaseR = relR;
    }
  }

  /**
   * Starlight X TMR actuation in millimetres (0.01-0.40) plus optional
   * rapid-trigger sensitivity in µm (150-250) for both switches together.
   */
  async setTmrActuation(actuationMmL: number, actuationMmR: number, rtUmL?: number, rtUmR?: number): Promise<void> {
    this.requireSlx("TMR actuation");
    const thrL = finalmouseActuationMmToSteps(actuationMmL);
    const thrR = finalmouseActuationMmToSteps(actuationMmR);
    await this.write(
      this.txReport,
      FINALMOUSE_COMMAND.tmrActuation,
      encodeFinalmouseTmrActuation(thrR, thrL, rtUmR, rtUmL),
    );
    this.telemetry.tmrThrL = thrL;
    this.telemetry.tmrThrR = thrR;
    if (rtUmL !== undefined && rtUmR !== undefined) {
      this.telemetry.tmrHystL = rtUmL;
      this.telemetry.tmrHystR = rtUmR;
    }
  }

  /** Starlight X calibrated most-sensitive-point reference in µm. */
  async setTmrMsp(mspUmL: number, mspUmR: number): Promise<void> {
    this.requireSlx("TMR calibration reference");
    await this.write(this.txReport, FINALMOUSE_COMMAND.tmrMsp, encodeFinalmouseTmrMsp(mspUmR, mspUmL));
    this.telemetry.tmrMspL = mspUmL;
    this.telemetry.tmrMspR = mspUmR;
  }

  /** Starlight X active profile (0-based index into the profile roster). */
  async setActiveProfile(index: number): Promise<number> {
    this.requireSlx("Profiles");
    const count = this.telemetry.profileCount ?? FINALMOUSE_PROFILE.maxCount;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`Finalmouse profile index must be 0-${count - 1}.`);
    }
    await this.write(this.txReport, FINALMOUSE_COMMAND.profile, new Uint8Array([index]));
    this.telemetry.profileActive = index;
    return index;
  }

  /** Starlight X per-profile content block (xpanel `Yr` order). */
  async setProfileData(index: number, data: FinalmouseProfileData): Promise<void> {
    this.requireSlx("Profiles");
    this.assertProfileIndex(index);
    await this.write(
      this.txReport,
      FINALMOUSE_COMMAND.profileData,
      new Uint8Array([index & 0xff, ...encodeFinalmouseProfileData(data)]),
    );
  }

  /** Starlight X profile rename (31 chars max). */
  async setProfileName(index: number, name: string): Promise<string> {
    this.requireSlx("Profiles");
    await this.write(this.txReport, FINALMOUSE_COMMAND.profileName, encodeFinalmouseProfileName(index, name));
    this.telemetry.profileNames = { ...this.telemetry.profileNames, [index]: name };
    return name;
  }

  /** Starlight X profile enable flag. */
  async setProfileEnabled(index: number, enabled: boolean): Promise<boolean> {
    this.requireSlx("Profiles");
    await this.write(this.txReport, FINALMOUSE_COMMAND.profileEnable, encodeFinalmouseProfileEnable(index, enabled));
    return enabled;
  }

  /** Starlight X per-profile dongle LED entry. */
  async setDongleLedData(led: FinalmouseProfileLed): Promise<void> {
    this.requireSlx("Profiles");
    await this.write(this.txReport, FINALMOUSE_COMMAND.dongleLedData, encodeFinalmouseDongleLedData(led));
    this.telemetry.profileLeds = { ...this.telemetry.profileLeds, [led.id]: led };
  }

  /** Starlight X indicator colour triple. */
  async setIndicatorColor(r: number, g: number, b: number): Promise<void> {
    this.requireSlx("Indicator colour");
    await this.write(this.txReport, FINALMOUSE_COMMAND.indicatorColor, encodeFinalmouseIndicatorColor(r, g, b));
  }

  /** Starlight X LED brightness byte. */
  async setLedBrightness(brightness: number): Promise<number> {
    this.requireSlx("LED brightness");
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 0xff) {
      throw new Error("Finalmouse LED brightness must be 0-255.");
    }
    await this.write(this.txReport, FINALMOUSE_COMMAND.ledBrightness, new Uint8Array([brightness]));
    this.telemetry.ledBrightness = brightness;
    return brightness;
  }

  private requireSlx(setting: string): void {
    if (!this.isSlx) throw new Error(`${setting} needs a Starlight X dongle.`);
  }

  private assertProfileIndex(index: number): void {
    const count = this.telemetry.profileCount ?? FINALMOUSE_PROFILE.maxCount;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`Finalmouse profile index must be 0-${count - 1}.`);
    }
  }

  private async writeU16(command: number, value: number): Promise<void> {
    await this.write(this.txReport, command, new Uint8Array([value & 0xff, value >> 8]));
  }

  private async write(reportId: number, command: number, payload: Uint8Array = new Uint8Array(0)): Promise<void> {
    await this.open();
    const report = buildFinalmouseReport(command, payload);
    await this.device.sendReport(reportId, report.buffer as ArrayBuffer);
  }

  private async waitForReport(afterRevision: number, timeoutMs: number): Promise<void> {
    if (this.reportRevision > afterRevision) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.reportWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.reportWaiters.add(finish);
    });
  }
}
