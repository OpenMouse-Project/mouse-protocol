import type { MagneticButtonsStatus, MagneticCalibrationProgress, MouseStatus } from "../mouse-types.ts";
import {
  GWOLVES_ADDRESS,
  GWOLVES_COMMAND,
  GWOLVES_HTS_PLUS_PRO_MODEL_ID,
  GWOLVES_NOTIFICATION,
  GWOLVES_RAPID_TRIGGER_MAX,
  GWOLVES_REPORT_ID,
  GWOLVES_TRIGGER_POINT_MAX,
  gwolvesAdvanceCalibration,
  gwolvesBuildCalibrationPayload,
  gwolvesBuildModelPayload,
  gwolvesBuildReadPayload,
  gwolvesBuildSimplePayload,
  gwolvesBuildWritePayload,
  gwolvesBuildWriteScalarPayload,
  gwolvesDecodeProfile,
  gwolvesDecodeRapidTrigger,
  gwolvesDecodeTriggerPoint,
  gwolvesEncodeRapidTrigger,
  gwolvesEncodeTriggerPoint,
  gwolvesParseButtonDepth,
  gwolvesParseModelId,
  type GWolvesCalibrationStage,
  gwolvesEncodeDpi,
  gwolvesEncodePollingRate,
  gwolvesParseBattery,
  gwolvesParseReadResponse,
  gwolvesReportChecksumIsValid,
} from "@openmouse/protocol/gwolves";
import {
  TEEVOLUTION_SHARED_BUTTON_OPTIONS,
  teevolutionDecodeButtonMappings,
  teevolutionReadKeyTable,
  teevolutionRemapButton,
} from "@openmouse/protocol/teevolution";
import { GWOLVES_PRODUCTS, GWOLVES_RECEIVER_MODELS, GWOLVES_VENDOR_ID, type GWolvesProduct } from "./products.ts";

// G-Wolves mice enumerate under their own vendor id (0x33e4) but speak the
// exact same shared VGN-family wire protocol already implemented
// independently in this repo for the VGN Dragonfly F2 Master+ and the
// Pulsar 4K Wireless Receiver — identical opcodes, checksums, EEPROM
// address map, DPI encoding, and polling-rate encoding. This driver uses
// its own protocol module (../../gwolves/index.ts) rather than importing
// vgn's, matching the pattern already established for the Pulsar/VGN case:
// independent per-brand implementation of a shared algorithm, so a future
// G-Wolves-specific quirk can diverge without touching another brand's
// tested code. Confirmed against real hardware 2026-08-21 via a live HID
// capture (browser sendReport/inputreport patch) while changing DPI, LOD,
// and polling rate on the official G-Wolves web driver at mouse.fit, then
// independently reproduced with hidapitester with no browser involved at
// all. See PROTOCOL-NOTES.md in the PR for the raw captured packets this
// was verified against.
//
// This class is intentionally model-agnostic: per-product identity (name,
// wireless/wired, verified-on-hardware status) lives in ./products.ts, not
// here. Adding support for another G-Wolves model that turns out to share
// this same protocol should just mean a new entry in that catalog.
const RESPONSE_TIMEOUT_MS = 700;
// G-Wolves' web driver (mouse.fit) gives every model in this catalog five
// remappable buttons (BtnMaxNum and KeyBindingSeq in its env-models.json), so
// the key table's sixth, DPI, slot stays hidden.
const BUTTON_LIMITS = { buttons: 5, actions: TEEVOLUTION_SHARED_BUTTON_OPTIONS };
const SUPPORTED_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
const CALIBRATION_TIMING = { settleMs: 2_000, noReadingsMs: 8_000, idleMs: 30_000, maxMs: 90_000 };
const MAGNETIC_ADDRESS = {
  trigger: [GWOLVES_ADDRESS.leftTrigger, GWOLVES_ADDRESS.rightTrigger],
  rapidTrigger: [GWOLVES_ADDRESS.leftRapidTrigger, GWOLVES_ADDRESS.rightRapidTrigger],
} as const;

export class GWolvesHidClient {
  readonly device: HIDDevice;
  private waiter: {
    command: number;
    resolve: (response: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: number;
  } | null = null;

  /** Exposed so tests do not have to wait out the real delays. */
  calibrationTiming = { ...CALIBRATION_TIMING };
  private receiverModelId: number | null | undefined;
  private readonly depthListeners = new Set<(left: number, right: number) => void>();

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== GWOLVES_REPORT_ID) return;
    const response = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    if (response[0] === GWOLVES_NOTIFICATION) {
      const depth = gwolvesParseButtonDepth(response);
      if (depth) for (const listener of this.depthListeners) listener(depth.left, depth.right);
      return;
    }
    const waiter = this.waiter;
    if (!waiter || response[0] !== waiter.command) return;
    window.clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.resolve(response);
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  // Only product ids present in GWOLVES_PRODUCTS (see ./products.ts) are
  // accepted — this is the single place that catalog is consulted for
  // device recognition, so adding a model is purely a data change there.
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== GWOLVES_VENDOR_ID) return false;
    if (GWOLVES_PRODUCTS.get(device.productId)?.protocol !== "vgn") return false;
    return device.collections.some((collection) =>
      collection.usagePage === 0xff02
      && collection.inputReports.some((report) => report.reportId === GWOLVES_REPORT_ID && this.reportLength(report) === 16)
      && collection.outputReports.some((report) => report.reportId === GWOLVES_REPORT_ID && this.reportLength(report) === 16));
  }

  private get product(): GWolvesProduct {
    // isSupported() is always checked before a client is constructed (see
    // registry.ts), so an unknown product id here means a caller bypassed
    // that check rather than a real runtime case to handle gracefully.
    const product = GWOLVES_PRODUCTS.get(this.device.productId);
    if (!product) throw new Error(`Unrecognized G-Wolves product id 0x${this.device.productId.toString(16)}.`);
    return product;
  }

  private get model(): string {
    if (!this.product.wireless) return this.product.model;
    return GWOLVES_RECEIVER_MODELS.get(this.receiverModelId ?? -1) ?? "8K receiver";
  }

  isWirelessPath(): boolean {
    return this.product.wireless;
  }

  get pollIntervalMs(): number {
    return this.isWirelessPath() ? 10_000 : 30_000;
  }

  getDpiOptions(): number[] {
    const values: number[] = [];
    for (let dpi = 50; dpi <= 26_000; dpi += 50) values.push(dpi);
    return values;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.device.removeEventListener("inputreport", this.onInputReport);
    this.device.addEventListener("inputreport", this.onInputReport);
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const { wireless } = this.product;
    const magnetic = await this.isMagnetic();
    const model = this.model;
    const batteryResponse = await this.transact(gwolvesBuildSimplePayload(GWOLVES_COMMAND.battery));
    const firmwareResponse = await this.transact(gwolvesBuildSimplePayload(GWOLVES_COMMAND.firmware));
    const profile = await this.readProfile();
    // Optional: a mouse that will not read its key table keeps the rest of its status.
    const keys = await teevolutionReadKeyTable((address, length) => this.read(address, length)).catch(() => null);
    const battery = gwolvesParseBattery(batteryResponse);
    const settings = gwolvesDecodeProfile(profile);
    const firmware = this.version(firmwareResponse);

    return {
      brand: "G-Wolves",
      name: `G-Wolves ${model}`,
      batteryPercent: battery?.percent ?? null,
      batteryVoltageMv: battery?.voltageMv ?? null,
      batteryState: battery
        ? battery.charging ? (battery.percent >= 99 ? "Full" : "Charging") : "Discharging"
        : "Unknown",
      dpi: settings.dpi,
      pollingRateHz: settings.pollingRateHz,
      supportedPollingRates: SUPPORTED_POLLING_RATES,
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver · 8K protocol" : "USB · 8K protocol",
      motionSync: settings.motionSync,
      debounceMs: settings.debounceMs,
      sleepTimeout: settings.sleepTimeout === null ? null : settings.sleepTimeout / 10,
      angleSnapping: settings.angleSnapping,
      rippleControl: settings.rippleControl,
      performanceMode: settings.performanceMode,
      liftOffDistance: settings.liftOffDistance,
      ...(magnetic ? { magneticButtons: await this.readMagnetic().catch(() => undefined) } : {}),
      ...(keys ? { buttonMappings: teevolutionDecodeButtonMappings(keys, 0, BUTTON_LIMITS.buttons), buttonOptions: BUTTON_LIMITS.actions } : {}),
      firmware: firmware ? [`Mouse ${firmware}`] : [],
      ui: {
        family: "vgn-f2",
        hideUnsupportedPollingRates: true,
        forceShowBattery: false,
        pollingNote: `${model} supports 125 Hz through 8,000 Hz over its shared VGN-family protocol.`,
        defaultDisplayName: `G-Wolves ${model}`,
      },
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const profile = gwolvesDecodeProfile(await this.readProfile());
    const address = GWOLVES_ADDRESS.dpiStages + profile.activeDpiStage * 4;
    await this.write(address, [...gwolvesEncodeDpi(dpi)]);
    const confirmed = gwolvesDecodeProfile(await this.readProfile()).dpi;
    if (confirmed !== dpi) throw new Error(`The ${this.model} kept ${confirmed} DPI instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setPollingRate(rate: number): Promise<number> {
    await this.writeScalar(GWOLVES_ADDRESS.pollingRate, gwolvesEncodePollingRate(rate));
    const confirmed = gwolvesDecodeProfile(await this.readProfile()).pollingRateHz;
    if (confirmed !== rate) {
      const hint = this.isWirelessPath()
        ? " (on the wireless path, the mouse must be actively awake — try moving it first)"
        : "";
      throw new Error(`The ${this.model} kept ${confirmed} Hz instead of ${rate} Hz.${hint}`);
    }
    return confirmed;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    const raw = value === "Low" ? 3 : value === "Medium" ? 1 : 2;
    await this.writeScalar(GWOLVES_ADDRESS.lod, raw);
    const confirmed = gwolvesDecodeProfile(await this.readProfile()).liftOffDistance;
    if (confirmed !== value) throw new Error(`The ${this.model} kept ${confirmed ?? "unknown"} LOD instead of ${value}.`);
    return confirmed;
  }

  /**
   * Matches G-Wolves' web driver: its Set_MS_KeyFunction writes
   * [type, param hi, param lo, 0x55 checksum] at 96 + 4 * button, with the
   * same type and param values as Teevolution's table.
   */
  async setButtonMapping(button: string, action: string): Promise<void> {
    await teevolutionRemapButton(
      (address, length) => this.read(address, length),
      (address, data) => this.write(address, [...data]),
      button,
      action,
      BUTTON_LIMITS,
    );
  }

  /** True for the magnetic model. On the shared receiver the mouse behind it is asked once. */
  async isMagnetic(): Promise<boolean> {
    if (!this.product.wireless) return this.product.magnetic === true;
    if (this.receiverModelId === undefined) {
      this.receiverModelId = await this.transact(gwolvesBuildModelPayload(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256))))
        .then((response) => gwolvesParseModelId(response)?.modelId ?? null)
        .catch(() => null);
    }
    return this.receiverModelId === GWOLVES_HTS_PLUS_PRO_MODEL_ID;
  }

  async readMagnetic(): Promise<MagneticButtonsStatus> {
    const wired = !this.product.wireless;
    const buttons: MagneticButtonsStatus["buttons"] = [];
    for (const side of [0, 1] as const) {
      const triggerPoint = gwolvesDecodeTriggerPoint(await this.read(MAGNETIC_ADDRESS.trigger[side], 2));
      const rapid = gwolvesDecodeRapidTrigger(await this.read(MAGNETIC_ADDRESS.rapidTrigger[side], 2));
      buttons.push({
        switchType: "magnetic",
        triggerPoint,
        rapidTrigger: rapid && rapid.level >= 1 && rapid.level <= GWOLVES_RAPID_TRIGGER_MAX ? rapid.level : null,
        rapidTriggerEnabled: rapid ? rapid.enabled : null,
      });
    }
    return {
      buttons,
      triggerPointRange: { min: 1, max: GWOLVES_TRIGGER_POINT_MAX },
      // The web driver offers rapid trigger and calibration on a cable only.
      rapidTriggerRange: wired ? { min: 1, max: GWOLVES_RAPID_TRIGGER_MAX } : null,
      rapidTriggerUnit: "level",
      rapidTriggerSwitch: true,
      canChooseSwitchType: false,
      calibration: wired ? "unknown" : null,
      liveDepth: true,
    };
  }

  async setMagneticTriggerPoint(button: 0 | 1, point: number): Promise<number> {
    await this.writeScalar(MAGNETIC_ADDRESS.trigger[button], gwolvesEncodeTriggerPoint(point));
    const confirmed = gwolvesDecodeTriggerPoint(await this.read(MAGNETIC_ADDRESS.trigger[button], 2));
    if (confirmed !== point) throw new Error(`The ${this.model} kept trigger point ${confirmed ?? "unknown"} instead of ${point}.`);
    return confirmed;
  }

  async setMagneticRapidTrigger(button: 0 | 1, enabled: boolean, level: number): Promise<{ enabled: boolean; level: number }> {
    if (this.product.wireless) throw new Error("Rapid trigger can only be changed with the mouse on its cable.");
    await this.writeScalar(MAGNETIC_ADDRESS.rapidTrigger[button], gwolvesEncodeRapidTrigger(enabled, level));
    const confirmed = gwolvesDecodeRapidTrigger(await this.read(MAGNETIC_ADDRESS.rapidTrigger[button], 2));
    if (!confirmed || confirmed.enabled !== enabled || confirmed.level !== level) {
      throw new Error(`The ${this.model} did not keep the rapid trigger setting.`);
    }
    return confirmed;
  }

  /** Live press depth of the left and right button, 0 to 100, while the mouse streams it. */
  onButtonDepth(listener: (left: number, right: number) => void): () => void {
    this.depthListeners.add(listener);
    return () => { this.depthListeners.delete(listener); };
  }

  /**
   * Starts the calibration and follows it by press depth. The mouse does not
   * report a result, so success means both buttons were seen fully pressed and
   * then fully released. Wired only, like G-Wolves' web driver.
   */
  async calibrateMagneticButtons(onProgress: (progress: MagneticCalibrationProgress) => void, signal?: AbortSignal): Promise<void> {
    if (this.product.wireless) throw new Error("Calibrate the magnetic switches with the mouse on its cable.");
    let stage = "pressBoth" as GWolvesCalibrationStage;
    let settled = false;
    let seen = false;
    let last = Date.now();
    let depth = { left: 0, right: 0 };
    const report = (): void => onProgress({
      ...depth,
      step: stage === "pressBoth" ? 2 : 3,
      steps: 3,
      message: stage === "pressBoth"
        ? "Press and hold both the left and right buttons fully for 2 seconds."
        : stage === "releaseBoth" ? "Release both the left and right buttons." : "Calibration Successful",
    });
    const stop = this.onButtonDepth((left, right) => {
      seen = true;
      last = Date.now();
      depth = { left, right };
      if (!settled) return;
      stage = gwolvesAdvanceCalibration(stage, depth);
      report();
    });
    try {
      onProgress({ ...depth, step: 1, steps: 3, message: "Do not press any buttons until the white LED stops blinking and turns solid green." });
      const response = await this.transact(gwolvesBuildCalibrationPayload());
      if (!gwolvesReportChecksumIsValid(response)) throw new Error("The mouse did not answer the calibration request.");
      await new Promise<void>((resolve) => window.setTimeout(resolve, this.calibrationTiming.settleMs));
      settled = true;
      seen = false;
      const started = Date.now();
      last = started;
      report();
      while (stage !== "done") {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
        if (signal?.aborted) throw new Error("Calibration cancelled.");
        const now = Date.now();
        if (!seen && now - started > this.calibrationTiming.noReadingsMs) {
          throw new Error("No live button readings arrived from the mouse, so the calibration could not be followed.");
        }
        if (now - started > this.calibrationTiming.maxMs || (seen && now - last > this.calibrationTiming.idleMs)) {
          throw new Error("Calibration did not finish. Fully press and release both buttons as prompted, then try again.");
        }
      }
      report();
    } finally {
      stop();
    }
  }

  async close(): Promise<void> {
    this.depthListeners.clear();
    this.failWaiter(new Error("The G-Wolves device was closed."));
    this.device.removeEventListener("inputreport", this.onInputReport);
    if (this.device.opened) await this.device.close();
  }

  private async readProfile(): Promise<Uint8Array> {
    const profile = new Uint8Array(0xb7);
    for (const [start, end] of [[0, 0x2c], [0xa8, 0xb7]] as const) {
      for (let address = start; address < end; address += 10) {
        const length = Math.min(10, end - address);
        profile.set(await this.read(address, length), address);
      }
    }
    return profile;
  }

  private async read(address: number, length: number): Promise<Uint8Array> {
    const response = await this.transact(gwolvesBuildReadPayload(address, length));
    const data = gwolvesParseReadResponse(response, address, length);
    if (!data) throw new Error(`${this.model} flash read failed at 0x${address.toString(16)}.`);
    return data;
  }

  private async writeScalar(address: number, value: number): Promise<void> {
    const response = await this.transact(gwolvesBuildWriteScalarPayload(address, value));
    if (!gwolvesReportChecksumIsValid(response) || response[0] !== GWOLVES_COMMAND.write || response[1] !== 0) {
      throw new Error(`${this.model} flash write failed at 0x${address.toString(16)}.`);
    }
    const confirmed = await this.read(address, 2);
    if (confirmed[0] !== value || ((confirmed[0]! + confirmed[1]!) & 0xff) !== 0x55) {
      throw new Error(`The ${this.model} did not retain the value written at 0x${address.toString(16)}.`);
    }
  }

  private async write(address: number, data: readonly number[]): Promise<void> {
    const response = await this.transact(gwolvesBuildWritePayload(address, data));
    if (!gwolvesReportChecksumIsValid(response) || response[0] !== GWOLVES_COMMAND.write || response[1] !== 0) {
      throw new Error(`${this.model} flash write failed at 0x${address.toString(16)}.`);
    }
  }

  private async transact(payload: Uint8Array): Promise<Uint8Array> {
    await this.open();
    this.failWaiter(new Error("Superseded by another G-Wolves request."));
    const command = payload[0]!;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.waiter?.resolve === resolve) this.waiter = null;
        reject(new Error(`Timed out waiting for G-Wolves command 0x${command.toString(16)}.`));
      }, RESPONSE_TIMEOUT_MS);
      this.waiter = { command, resolve, reject, timer };
    });
    try {
      await this.device.sendReport(GWOLVES_REPORT_ID, new Uint8Array(payload).buffer);
    } catch (error) {
      this.failWaiter(error instanceof Error ? error : new Error(String(error)));
    }
    return response;
  }

  private version(response: Uint8Array): string | null {
    if (!gwolvesReportChecksumIsValid(response) || response[0] !== GWOLVES_COMMAND.firmware || response[1] !== 0) return null;
    return `v${response[5] ?? 0}.${(response[6] ?? 0).toString(16).padStart(2, "0")}`;
  }

  private failWaiter(error: Error): void {
    const waiter = this.waiter;
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    this.waiter = null;
    waiter.reject(error);
  }

  private static reportLength(report: HIDReportInfo): number {
    return report.items.reduce((sum, item) => sum + item.reportSize * item.reportCount, 0) / 8;
  }
}
