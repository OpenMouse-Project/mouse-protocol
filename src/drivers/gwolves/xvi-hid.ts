import type { MouseStatus } from "../mouse-types.ts";
import { GWOLVES_PRODUCTS, GWOLVES_VENDOR_ID, type GWolvesProduct } from "./products.ts";

// G-Wolves' older "XVI" generation: the HTX Mini 8K and every other
// `protocol: "xvi"` entry in ./products.ts. Decoded from G-Wolves' own web
// driver (https://mouse.xyz, static/js/index-*.js, class `cm`), which uses
// that class for each env-models.json entry with "XVI": "1"; this driver
// follows its "IsNewProtocol": "0" branch. DPI, polling, lift-off, battery
// and firmware are confirmed on an HTX Mini 8K receiver (Discord ticket
// #0105, 2026-09-28); sleep, debounce, Motion Sync, angle snap and buttons
// are decoded from the same page but not yet tested on hardware.
//
// Transport: unnumbered 64-byte feature reports (report id 0). The web driver
// finds the collection by that shape rather than by usage page, and requests
// the device by vendor and product id only, so the picker filter does too.
// Requests use one of two layouts:
//   frame:  [0, 0, device, length, class, command, data...]  (DPI, firmware, sleep)
//   legacy: [0, length, command, wireless, data...]           (everything else)
// The reply mirrors the request with a status byte in slot 0 (0xa1 = done,
// 2 = mouse asleep), the command echoed in place and, for legacy replies, its
// own data length in byte 1. Each read command is its write command | 0x80.
// Chrome returns the reply with or without a leading report-id byte depending
// on platform; the web driver detects that per reply, and so does
// gwolvesXviNormalize().

const REPORT_ID = 0;
const PACKET_LENGTH = 64;
const STATUS_OK = 0xa1;
const STATUS_ASLEEP = 2;
const MOUSE = 2;
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
// ponytail: every XVI model gets the PAW3395 DPI limit (50-26,000). The
// 30,000 DPI models (VUK, Fenrir, Fenir Max, HTS Ultra, HT-S2 Pro) also offer
// a 0.7 mm lift-off (`shortLiftOff`), which the web driver writes as
// mm * 10 when below 1 mm: 0.7 mm is 7, 1 mm is 1, 2 mm is 2.
const DPI_STEP = 50;
const DPI_MAX = 26_000;
// The web driver's sleep slider, in seconds; the mouse reports "never" as
// one of the SLEEP_OFF raw values.
const SLEEP_MIN_S = 30;
const SLEEP_MAX_S = 600;
const SLEEP_OFF: ReadonlySet<number> = new Set([0, 0xff00, 0xffff]);
// Debounce is four timings: before press, before release, after press, after
// release. The web driver's single-value debounce (for models without the
// four-way editor) is the first one, so that is the one exposed here.
// env-models.json "ButtonDebounceTimeMax" is 80 for every XVI model.
const DEBOUNCE_MAX_MS = 80;
// Six 6-byte key records, [action, type (1 = plain), macro data...], Left,
// Right, Middle, Back, Forward, DPI. Action codes are the web driver's key
// menu (bn/Sn in the settings chunk) under the shared remapper's labels.
// ponytail: five buttons for every model; the HTS Plus, HTX and their ACE
// versions also have the DPI slot ("BtnMaxNum": "6"), add it per product
// when one is tested.
const BUTTON_RECORD = 6;
const BUTTON_TABLE = 36;
const BUTTONS = ["Left", "Right", "Middle", "Back", "Forward"];
const BUTTON_ACTIONS: ReadonlyMap<string, number> = new Map([
  ["Left Click", 1], ["Right Click", 2], ["Middle Click", 3], ["Backward", 4], ["Forward", 5],
  ["DPI Loop", 11], ["DPI+", 9], ["DPI-", 10], ["Disable", 8],
]);
const LEFT_CLICK = 1;

export function gwolvesXviFrame(length: number, commandClass: number, command: number, data: readonly number[] = []): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(PACKET_LENGTH);
  packet.set([MOUSE, length, commandClass, command, ...data], 2);
  return packet;
}

export function gwolvesXviLegacy(length: number, command: number, wireless: boolean, data: readonly number[] = []): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(PACKET_LENGTH);
  packet.set([length, command, wireless ? 1 : 0, ...data], 1);
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

  private get liftOffCodes(): ReadonlyMap<NonNullable<MouseStatus["liftOffDistance"]>, number> {
    return this.product.shortLiftOff
      ? new Map([["Low", 7], ["Medium", 1], ["High", 2]])
      : new Map([["Low", 1], ["High", 2]]);
  }

  private get supportedPollingRates(): number[] {
    // Wired and the ACE models' 1K receivers (PIDs ending 0x03) stop at 1 kHz;
    // the 4K dongles (PIDs ending 0x07, the _4KDongle entries in
    // env-models.json) stop at 4 kHz; every other XVI receiver in that config
    // is its 8K dongle.
    const lowByte = this.device.productId & 0xff;
    const max = this.isWirelessPath() ? (lowByte === 0x03 ? 1000 : lowByte === 0x07 ? 4000 : 8000) : 1000;
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
    const battery = await this.transact(gwolvesXviLegacy(2, 0x8f, wireless));
    const pollingRateHz = await this.readPollingRate();
    const { stages, active } = await this.readDpiStages();
    const liftOffDistance = await this.readLiftOffDistance();
    // G-Wolves' page reads these on every XVI model, but a firmware that
    // refuses one should cost that card, not the settings that already work.
    const sleep = await this.optional(() => this.readSleep());
    const debounce = await this.optional(() => this.readDebounce());
    const motionSync = await this.optional(() => this.readFlag(0x91));
    const angleSnapping = await this.optional(() => this.readFlag(0x87));
    const buttons = await this.optional(() => this.readButtons());
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
      motionSync,
      debounceMs: debounce?.[0] ?? null,
      sleepTimeout: sleep,
      angleSnapping,
      rippleControl: null,
      performanceMode: null,
      liftOffDistance,
      supportedLiftOffDistances: [...this.liftOffCodes.keys()],
      firmware: [`Mouse ${firmware.slice(6, 10).join(".")}`],
      ...(buttons ? { buttonMappings: this.decodeButtons(buttons), buttonOptions: [...BUTTON_ACTIONS.keys()] } : {}),
      ui: {
        family: "gwolves-xvi",
        hideUnsupportedPollingRates: true,
        // G-Wolves' page offers no ripple control on XVI models.
        hideRippleControl: true,
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
    await this.transact(gwolvesXviLegacy(2, 0x02, this.isWirelessPath(), [code]));
    const confirmed = await this.readPollingRate();
    if (confirmed !== rate) throw new Error(`The ${this.product.model} kept ${confirmed} Hz instead of ${rate} Hz.`);
    return confirmed;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    const code = this.liftOffCodes.get(value);
    if (code === undefined) throw new Error(`The ${this.product.model} offers only the 1 mm and 2 mm lift-off distances.`);
    await this.transact(gwolvesXviLegacy(1, 0x06, this.isWirelessPath(), [code]));
    const confirmed = await this.readLiftOffDistance();
    if (confirmed !== value) throw new Error(`The ${this.product.model} kept ${confirmed ?? "an unknown"} LOD instead of ${value}.`);
    return confirmed;
  }

  getSleepOptions(): number[] {
    return [30, 60, 120, 180, 300, 600];
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!Number.isInteger(seconds) || seconds < SLEEP_MIN_S || seconds > SLEEP_MAX_S) {
      throw new Error(`The ${this.product.model} sleeps after ${SLEEP_MIN_S}-${SLEEP_MAX_S} seconds.`);
    }
    await this.transact(gwolvesXviFrame(3, 0, 0x07, [seconds >> 8, seconds & 0xff]));
    const confirmed = await this.readSleep();
    if (confirmed !== seconds) throw new Error(`The ${this.product.model} kept ${confirmed ?? "no"} sleep timeout instead of ${seconds} s.`);
    return confirmed;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > DEBOUNCE_MAX_MS) {
      throw new Error(`The ${this.product.model} takes 0-${DEBOUNCE_MAX_MS} ms of debounce.`);
    }
    const timings = await this.readDebounce();
    timings[0] = milliseconds;
    await this.transact(gwolvesXviLegacy(5, 0x05, this.isWirelessPath(), timings));
    const confirmed = (await this.readDebounce())[0];
    if (confirmed !== milliseconds) throw new Error(`The ${this.product.model} kept ${confirmed} ms debounce instead of ${milliseconds} ms.`);
    return confirmed;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return this.writeFlag(0x11, enabled, "Motion Sync");
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return this.writeFlag(0x07, enabled, "angle snapping");
  }

  /** Rewrites the whole key table with one record changed, the way the web driver does. */
  async setButtonMapping(button: string, action: string): Promise<void> {
    const index = BUTTONS.indexOf(button);
    if (index < 0) throw new Error(`The ${this.product.model} has no "${button}" button.`);
    const code = BUTTON_ACTIONS.get(action);
    if (code === undefined) throw new Error(`Unknown button action "${action}".`);
    const table = await this.readButtons();
    if (table[index * BUTTON_RECORD] === code) return;
    table.set([code, 1], index * BUTTON_RECORD);
    if (!BUTTONS.some((_, slot) => table[slot * BUTTON_RECORD] === LEFT_CLICK)) {
      throw new Error("Keep at least one button as Left Click.");
    }
    await this.transact(gwolvesXviLegacy(BUTTON_TABLE, 0x04, this.isWirelessPath(), [...table]));
    const confirmed = this.decodeButtons(await this.readButtons())[button];
    if (confirmed !== action) throw new Error(`The ${this.product.model} kept ${confirmed} on ${button} instead of ${action}.`);
  }

  private decodeButtons(table: Uint8Array): Record<string, string> {
    const labels = new Map([...BUTTON_ACTIONS].map(([label, code]) => [code, label]));
    return Object.fromEntries(BUTTONS.map((name, slot) => [name, labels.get(table[slot * BUTTON_RECORD]!) ?? "Custom"]));
  }

  private async readButtons(): Promise<Uint8Array> {
    const table = (await this.transact(gwolvesXviLegacy(BUTTON_TABLE, 0x84, this.isWirelessPath()))).slice(4, 4 + BUTTON_TABLE);
    // The web driver stores an unset type byte back as 1 (plain action).
    for (let at = 1; at < BUTTON_TABLE; at += BUTTON_RECORD) if (table[at] === 0) table[at] = 1;
    return table;
  }

  private async readSleep(): Promise<number | null> {
    const reply = await this.transact(gwolvesXviFrame(3, 0, 0x87, [0]));
    const seconds = ((reply[6] ?? 0) << 8) | (reply[7] ?? 0);
    return SLEEP_OFF.has(seconds) ? null : seconds;
  }

  private async readDebounce(): Promise<number[]> {
    return [...(await this.transact(gwolvesXviLegacy(5, 0x85, this.isWirelessPath()))).slice(4, 8)];
  }

  private async readFlag(command: number): Promise<boolean> {
    return (await this.transact(gwolvesXviLegacy(1, command, this.isWirelessPath())))[4] === 1;
  }

  private async writeFlag(command: number, enabled: boolean, label: string): Promise<boolean> {
    await this.transact(gwolvesXviLegacy(1, command, this.isWirelessPath(), [enabled ? 1 : 0]));
    const confirmed = await this.readFlag(command | 0x80);
    if (confirmed !== enabled) throw new Error(`The ${this.product.model} kept ${label} ${confirmed ? "on" : "off"}.`);
    return confirmed;
  }

  private async optional<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }

  private async readPollingRate(): Promise<number> {
    let code = (await this.transact(gwolvesXviLegacy(2, 0x82, this.isWirelessPath())))[4];
    // The web driver reads 64 over the cable as 1 kHz.
    if (!this.isWirelessPath() && code === 64) code = 1;
    return [...POLLING_CODES].find(([, value]) => value === code)?.[0] ?? 1000;
  }

  private async readLiftOffDistance(): Promise<MouseStatus["liftOffDistance"]> {
    const raw = (await this.transact(gwolvesXviLegacy(1, 0x86, this.isWirelessPath())))[4];
    return [...this.liftOffCodes].find(([, code]) => code === raw)?.[0] ?? null;
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
    // length in byte 1 and the command in byte 2.
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
