import type { MouseStatus } from "../mouse-types.ts";
import { GWOLVES_PRODUCTS, GWOLVES_VENDOR_ID, type GWolvesProduct } from "./products.ts";

// G-Wolves' older "XVI" generation: the HTX Mini 8K and every other
// `protocol: "xvi"` entry in ./products.ts. Decoded from G-Wolves' own web
// driver (https://mouse.xyz, static/js/index-*.js, class `cm`), which uses
// that class for each env-models.json entry with "XVI": "1"; this driver
// follows its "IsNewProtocol": "0" branch. Not yet tested on hardware.
//
// Transport: unnumbered 64-byte feature reports (report id 0). The web driver
// finds the collection by that shape rather than by usage page, and requests
// the device by vendor and product id only, so the picker filter does too.
// Requests use one of two layouts:
//   frame:  [0, 0, device, length, class, command, data...]  (DPI, firmware)
//   legacy: [0, device, command, wireless, data...]           (polling, LOD, battery)
// The reply mirrors the request with a status byte in slot 0 (0xa1 = done,
// 2 = mouse asleep) and the command echoed in place. Chrome returns the reply
// with or without a leading report-id byte depending on platform; the web
// driver detects that per reply, and so does gwolvesXviNormalize().

const REPORT_ID = 0;
const PACKET_LENGTH = 64;
const STATUS_OK = 0xa1;
const STATUS_ASLEEP = 2;
const MOUSE = 2;
const LOD_DEVICE = 1;
// The web driver only ever addresses profile "1".
const PROFILE = 1;
const MAX_STAGES = 7;
// env-models.json "commonDelay" (20 ms for every XVI model), and the web
// driver's own retry budget: 30 polls per send, 5 sends.
const POLL_DELAY_MS = 20;
const POLLS_PER_SEND = 30;
const SENDS = 5;
const POLLING_CODES: ReadonlyMap<number, number> = new Map([
  [125, 8], [250, 4], [500, 2], [1000, 1], [2000, 32], [4000, 64], [8000, 128],
]);
// ponytail: every XVI model gets the PAW3395 limits (50-26,000 DPI, 1/2 mm
// lift-off). The 30,000 DPI models (VUK, Fenrir, Fenir Max, HTS Ultra, HT-S2
// Pro) also offer 0.7 mm; add per-product limits when one of them is tested.
const DPI_STEP = 50;
const DPI_MAX = 26_000;

export function gwolvesXviFrame(length: number, commandClass: number, command: number, data: readonly number[] = []): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(PACKET_LENGTH);
  packet.set([MOUSE, length, commandClass, command, ...data], 2);
  return packet;
}

export function gwolvesXviLegacy(device: number, command: number, wireless: boolean, data: readonly number[] = []): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(PACKET_LENGTH);
  packet.set([device, command, wireless ? 1 : 0, ...data], 1);
  return packet;
}

/** Drops the report-id byte some platforms prepend, so reply[k] lines up with request[k]. */
export function gwolvesXviNormalize(reply: Uint8Array): Uint8Array {
  return reply.length > PACKET_LENGTH || reply[0] === REPORT_ID ? reply.subarray(1) : reply;
}

export class GWolvesXviHidClient {
  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== GWOLVES_VENDOR_ID) return false;
    if (GWOLVES_PRODUCTS.get(device.productId)?.protocol !== "xvi") return false;
    return device.collections.some((collection) => collection.featureReports.some((report) =>
      report.reportId === REPORT_ID
      && report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) === PACKET_LENGTH * 8));
  }

  private get product(): GWolvesProduct {
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
    for (let dpi = DPI_STEP; dpi <= DPI_MAX; dpi += DPI_STEP) values.push(dpi);
    return values;
  }

  private get supportedPollingRates(): number[] {
    // Wired and the ACE models' 1K receivers (PIDs ending 0x03) stop at 1 kHz;
    // every other XVI receiver in env-models.json is its 8K dongle.
    const max = this.isWirelessPath() && (this.device.productId & 0xff) !== 0x03 ? 8000 : 1000;
    return [...POLLING_CODES.keys()].filter((rate) => rate <= max);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    const { model, wireless } = this.product;
    const firmware = await this.transact(gwolvesXviFrame(16, 0, 0x81));
    const battery = await this.transact(gwolvesXviLegacy(MOUSE, 0x8f, wireless));
    const pollingRateHz = await this.readPollingRate();
    const { stages, active } = await this.readDpiStages();
    const liftOffDistance = await this.readLiftOffDistance();
    const charging = battery[4] === 1;
    const percent = battery[5] ?? 0;

    return {
      brand: "G-Wolves",
      name: `G-Wolves ${model}`,
      batteryPercent: percent <= 100 ? percent : null,
      batteryState: charging ? (percent >= 100 ? "Full" : "Charging") : "Discharging",
      dpi: stages[active - 1]?.[0] ?? 800,
      pollingRateHz,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver · XVI protocol" : "USB · XVI protocol",
      motionSync: null,
      debounceMs: null,
      sleepTimeout: null,
      angleSnapping: null,
      rippleControl: null,
      performanceMode: null,
      liftOffDistance,
      supportedLiftOffDistances: ["Low", "High"],
      firmware: [`Mouse ${firmware.slice(6, 10).join(".")}`],
      ui: {
        family: "gwolves-xvi",
        hideUnsupportedPollingRates: true,
        forceShowBattery: false,
        defaultDisplayName: `G-Wolves ${model}`,
      },
    };
  }

  async setDpi(dpi: number): Promise<number> {
    if (!this.getDpiOptions().includes(dpi)) throw new Error(`The ${this.product.model} takes 50-26,000 DPI in steps of 50.`);
    const { stages, active } = await this.readDpiStages();
    if (stages.length === 0) throw new Error(`The ${this.product.model} reported no DPI stages.`);
    stages[active - 1] = [dpi, dpi];
    const bytes = stages.flatMap(([x, y]) => [x >> 8, x & 0xff, y >> 8, y & 0xff]);
    await this.transact(gwolvesXviFrame(30, 1, 0x01, [PROFILE, stages.length, ...bytes]));
    const confirmed = (await this.readDpiStages()).stages[active - 1]?.[0];
    if (confirmed !== dpi) throw new Error(`The ${this.product.model} kept ${confirmed ?? "an unknown"} DPI instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setPollingRate(rate: number): Promise<number> {
    const code = POLLING_CODES.get(rate);
    if (code === undefined || !this.supportedPollingRates.includes(rate)) {
      throw new Error(`The ${this.product.model} does not support ${rate} Hz on this connection.`);
    }
    await this.transact(gwolvesXviLegacy(MOUSE, 0x02, this.isWirelessPath(), [code]));
    const confirmed = await this.readPollingRate();
    if (confirmed !== rate) throw new Error(`The ${this.product.model} kept ${confirmed} Hz instead of ${rate} Hz.`);
    return confirmed;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    if (value === "Medium") throw new Error(`The ${this.product.model} offers only the 1 mm and 2 mm lift-off distances.`);
    await this.transact(gwolvesXviLegacy(LOD_DEVICE, 0x06, this.isWirelessPath(), [value === "Low" ? 1 : 2]));
    const confirmed = await this.readLiftOffDistance();
    if (confirmed !== value) throw new Error(`The ${this.product.model} kept ${confirmed ?? "an unknown"} LOD instead of ${value}.`);
    return confirmed;
  }

  private async readPollingRate(): Promise<number> {
    let code = (await this.transact(gwolvesXviLegacy(MOUSE, 0x82, this.isWirelessPath())))[4];
    // The web driver reads 64 over the cable as 1 kHz.
    if (!this.isWirelessPath() && code === 64) code = 1;
    return [...POLLING_CODES].find(([, value]) => value === code)?.[0] ?? 1000;
  }

  private async readLiftOffDistance(): Promise<MouseStatus["liftOffDistance"]> {
    const raw = (await this.transact(gwolvesXviLegacy(LOD_DEVICE, 0x86, this.isWirelessPath())))[4];
    return raw === 1 ? "Low" : raw === 2 ? "High" : null;
  }

  private async readDpiStages(): Promise<{ stages: Array<[number, number]>; active: number }> {
    const table = await this.transact(gwolvesXviFrame(10, 1, 0x81, [PROFILE, MAX_STAGES]));
    const count = Math.min(table[7] ?? 0, MAX_STAGES);
    const word = (index: number) => ((table[index] ?? 0) << 8) | (table[index + 1] ?? 0);
    const stages = Array.from({ length: count }, (_, stage): [number, number] => [word(8 + stage * 4), word(10 + stage * 4)]);
    const active = (await this.transact(gwolvesXviFrame(2, 1, 0x82, [PROFILE])))[7] ?? 1;
    return { stages, active: Math.min(Math.max(active, 1), Math.max(count, 1)) };
  }

  private async transact(request: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    await this.open();
    // A frame keeps byte 1 zero and its command in byte 5; legacy puts the
    // device in byte 1 and the command in byte 2.
    const echoAt = request[1] === 0 ? 5 : 2;
    for (let send = 0; send < SENDS; send += 1) {
      await this.device.sendFeatureReport(REPORT_ID, request);
      for (let poll = 0; poll < POLLS_PER_SEND; poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, POLL_DELAY_MS));
        const view = await this.device.receiveFeatureReport(REPORT_ID);
        const reply = gwolvesXviNormalize(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        if (reply[echoAt] !== request[echoAt]) continue;
        if (reply[0] === STATUS_OK) return reply;
        if (reply[0] === STATUS_ASLEEP) throw new Error(`The ${this.product.model} is asleep or out of range. Move it, then retry.`);
        if ((reply[0] ?? 0) > STATUS_OK) break;
      }
    }
    throw new Error(`The ${this.product.model} did not answer command 0x${request[echoAt]!.toString(16)}.`);
  }
}
