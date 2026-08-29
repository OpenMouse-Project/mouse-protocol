import type { MouseStatus } from "../mouse-types.ts";
import {
  GWOLVES_ADDRESS,
  GWOLVES_COMMAND,
  GWOLVES_REPORT_ID,
  gwolvesBuildReadPayload,
  gwolvesBuildSimplePayload,
  gwolvesBuildWritePayload,
  gwolvesBuildWriteScalarPayload,
  gwolvesDecodeProfile,
  gwolvesEncodeDpi,
  gwolvesEncodePollingRate,
  gwolvesParseBattery,
  gwolvesParseReadResponse,
  gwolvesReportChecksumIsValid,
} from "@openmouse/protocol/gwolves";
import { GWOLVES_PRODUCTS, GWOLVES_VENDOR_ID, type GWolvesProduct } from "./products.ts";

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
const SUPPORTED_POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

export class GWolvesHidClient {
  readonly device: HIDDevice;
  private waiter: {
    command: number;
    resolve: (response: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: number;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== GWOLVES_REPORT_ID) return;
    const response = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
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
    if (!GWOLVES_PRODUCTS.has(device.productId)) return false;
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
    const { model, wireless } = this.product;
    const batteryResponse = await this.transact(gwolvesBuildSimplePayload(GWOLVES_COMMAND.battery));
    const firmwareResponse = await this.transact(gwolvesBuildSimplePayload(GWOLVES_COMMAND.firmware));
    const profile = await this.readProfile();
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
    if (confirmed !== dpi) throw new Error(`The ${this.product.model} kept ${confirmed} DPI instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setPollingRate(rate: number): Promise<number> {
    await this.writeScalar(GWOLVES_ADDRESS.pollingRate, gwolvesEncodePollingRate(rate));
    const confirmed = gwolvesDecodeProfile(await this.readProfile()).pollingRateHz;
    if (confirmed !== rate) {
      const hint = this.isWirelessPath()
        ? " (on the wireless path, the mouse must be actively awake — try moving it first)"
        : "";
      throw new Error(`The ${this.product.model} kept ${confirmed} Hz instead of ${rate} Hz.${hint}`);
    }
    return confirmed;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    const raw = value === "Low" ? 3 : value === "Medium" ? 1 : 2;
    await this.writeScalar(GWOLVES_ADDRESS.lod, raw);
    const confirmed = gwolvesDecodeProfile(await this.readProfile()).liftOffDistance;
    if (confirmed !== value) throw new Error(`The ${this.product.model} kept ${confirmed ?? "unknown"} LOD instead of ${value}.`);
    return confirmed;
  }

  async close(): Promise<void> {
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
    if (!data) throw new Error(`${this.product.model} flash read failed at 0x${address.toString(16)}.`);
    return data;
  }

  private async writeScalar(address: number, value: number): Promise<void> {
    const response = await this.transact(gwolvesBuildWriteScalarPayload(address, value));
    if (!gwolvesReportChecksumIsValid(response) || response[0] !== GWOLVES_COMMAND.write || response[1] !== 0) {
      throw new Error(`${this.product.model} flash write failed at 0x${address.toString(16)}.`);
    }
    const confirmed = await this.read(address, 2);
    if (confirmed[0] !== value || ((confirmed[0]! + confirmed[1]!) & 0xff) !== 0x55) {
      throw new Error(`The ${this.product.model} did not retain the value written at 0x${address.toString(16)}.`);
    }
  }

  private async write(address: number, data: readonly number[]): Promise<void> {
    const response = await this.transact(gwolvesBuildWritePayload(address, data));
    if (!gwolvesReportChecksumIsValid(response) || response[0] !== GWOLVES_COMMAND.write || response[1] !== 0) {
      throw new Error(`${this.product.model} flash write failed at 0x${address.toString(16)}.`);
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
