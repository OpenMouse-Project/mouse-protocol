import type { MouseStatus } from "../mouse-types.ts";
import { GWOLVES_PRODUCTS, GWOLVES_VENDOR_ID, type GWolvesProduct } from "./products.ts";

// G-Wolves' newer "XVI" generation: the four `protocol: "xvi-new"` entries
// in ./products.ts (HTM Plus, HSK Pro 2.0, HTXU 0x5608, Fenrir Pro).
// Decoded from G-Wolves' own web driver (https://mouse.xyz,
// static/js/index-*.js, class `cm` with `isNewProtocol == "1"`, plus the
// per-model UI chunk): same 64-byte feature-report transport as the older
// XVI generation (report id 0, 0xa1 status, command echo, 20 ms poll with
// 30 polls × 5 sends), but sensor commands move to profile-addressed
// frames — `[2, len, class, cmd, profile, ...]` with the reply values one
// slot later than the old layout. DPI, firmware and battery keep the shared
// XVI shapes; only polling, lift-off, sleep, debounce and the toggles take
// the profile byte.
//
// Confidence notes, read before trusting this on hardware:
// - Every frame below is byte-for-byte what the vendor page sends for these
//   models (including the odd set-polling command 0 and the 16-means-1kHz
//   quirk in getPollingRate). What is NOT confirmed is how real firmware
//   answers: all four entries stay `verified: false`, and every setter
//   re-reads and throws on mismatch, so a wrong guess fails loudly.
// - Button remapping covers plain clicks and Disable, decoded from the
//   vendor's $e action encoder and reply layout (slots 1-based for both
//   reads and writes — a 0-based write lands on the wrong button and reads
//   back unchanged, confirmed against live hardware). DPI/macros/media need
//   table layouts this bundle leaves half-decoded (and its MS-macro writers
//   are stubs), so those read back as Custom. Same for the tracking /
//   polling-info / angle-tune / hyper / competitive / combine / DPI-XY
//   toggles, which exist in the vendor code but are not needed for the core
//   settings surface.

const REPORT_ID = 0;
const PACKET_LENGTH = 64;
const STATUS_OK = 0xa1;
const STATUS_ASLEEP = 2;
// The web driver only ever addresses profile "1".
const PROFILE = 1;
const MAX_STAGES = 7;
// env-models.json "commonDelay" (20 ms for every XVI model), and the web
// driver's own retry budget: 30 polls per send, 5 sends.
const POLL_DELAY_MS = 20;
const POLLS_PER_SEND = 30;
const SENDS = 5;
// Same code table the older XVI generation uses — one shared
// setPollingRate serves both, so the UI-selected code is identical.
const POLLING_CODES: ReadonlyMap<number, number> = new Map([
  [125, 8], [250, 4], [500, 2], [1000, 1], [2000, 32], [4000, 64], [8000, 128],
]);
// All four xvi-new models top out at 30K DPI with 0.7/1/2 mm lift-off, and
// all ship 8K dongles (wired also runs to 8K), so every rate is offered on
// both paths — unlike the older generation's 1K-wired/1K-ACE limits.
// Button remapping covers plain clicks and Disable only, mirroring the
// older XVI driver's action set. The vendor encodes a remap as
// SetButton(profile, slot-0-based, type, data, len) →
// `[2, 5+len, 3, 0, profile, slot, 0, type, len, ...data]`, with clicks as
// type 1 / bitmask code (1, 2, 4, 8, 16) and Disable as type 0 with no
// data; reads use the query shape (type 255, len 10) and decode the type at
// reply[9] with the value at reply[11]. DPI/macros/media need table layouts
// this bundle leaves half-decoded, so they stay out (read back as Custom).
const BUTTONS = ["Left", "Right", "Middle", "Back", "Forward"];
const BUTTON_ACTIONS: ReadonlyMap<string, number> = new Map([
  ["Left Click", 1], ["Right Click", 2], ["Middle Click", 4], ["Backward", 8], ["Forward", 16],
]);
const BUTTON_QUERY_TYPE = 255;
const BUTTON_QUERY_LEN = 10;
const DPI_STEP = 50;
const DPI_MAX = 30_000;
const LOD_LEVELS = ["Low", "Medium", "High"] as const;
const LOD_RAW: ReadonlyMap<string, number> = new Map([["Low", 0.7], ["Medium", 1], ["High", 2]]);
const SLEEP_MIN_S = 30;
const SLEEP_MAX_S = 600;
const SLEEP_OFF: ReadonlySet<number> = new Set([0, 0xff00, 0xffff]);
// env-models.json "ButtonDebounceTimeMax" is 50 for all four models.
const DEBOUNCE_MAX_MS = 50;

const enum XviNewCommand {
  setPolling = 0,
  setButton = 0,
  setDpiStages = 1,
  setActiveDpi = 2,
  setSleep = 7,
  setLiftOff = 8,
  setMotionSync = 9,
  setRipple = 10,
  setHyper = 11,
  setDpiXy = 13,
  setTracking = 19,
  setAngleTune = 20,
  setAngleSnap = 4,
  getPolling = 128,
  getDpiStages = 129,
  getActiveDpi = 130,
  getBattery = 131,
  getAngleSnap = 132,
  getDpiXy = 141,
  getSleep = 135,
  getLiftOff = 136,
  getMotionSync = 137,
  getRipple = 138,
  getHyper = 139,
  getFirmware = 129,
  getButton = 128,
  getDebounce = 136,
  setDebounce = 8,
}

/** New-protocol frame: `[0, 0, 2, length, class, command, profile, ...]`. */
/** Battery, firmware and DPI-max take no profile byte — pass null there. */
function xviNewFrame(length: number, commandClass: number, command: number, data: readonly number[] = [], profile: number | null = PROFILE): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(PACKET_LENGTH);
  packet.set([2, length, commandClass, command, ...(profile === null ? [] : [profile]), ...data], 2);
  return packet;
}

/** Drops the report-id byte some platforms prepend, so reply[k] lines up. */
function xviNewNormalize(reply: Uint8Array): Uint8Array {
  return reply.length > PACKET_LENGTH || reply[0] === REPORT_ID ? reply.subarray(1) : reply;
}

export class GWolvesXviNewHidClient {
  readonly device: HIDDevice;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== GWOLVES_VENDOR_ID) return false;
    if (GWOLVES_PRODUCTS.get(device.productId)?.protocol !== "xvi-new") return false;
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
    return [...POLLING_CODES.keys()];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    const { model, wireless } = this.product;
    const firmware = await this.readFirmware();
    // `[2, 2, 0, 131]` answers `[charging, percent]` at [6..7] once the
    // reply prefix (when present) is normalized away.
    const battery = await this.transact(xviNewFrame(2, 0, XviNewCommand.getBattery, [], null));
    const pollingRateHz = await this.readPollingRate();
    const { stages, active } = await this.readDpiStages();
    const liftOffDistance = await this.readLiftOffDistance();
    const sleep = await this.optional(() => this.readSleep());
    const debounce = await this.optional(() => this.readDebounceTimings());
    const motionSync = await this.optional(() => this.readFlag(XviNewCommand.getMotionSync));
    const angleSnapping = await this.optional(() => this.readFlag(XviNewCommand.getAngleSnap));
    const buttons = await this.optional(() => this.readButtons());
    const charging = battery[6] === 1;
    const percent = battery[7] ?? 0;

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
      connectionDetail: wireless ? "2.4 GHz receiver · XVI-new protocol" : "USB · XVI-new protocol",
      motionSync,
      debounceMs: debounce?.[0] ?? null,
      sleepTimeout: sleep,
      angleSnapping,
      rippleControl: null,
      performanceMode: null,
      liftOffDistance,
      supportedLiftOffDistances: [...LOD_LEVELS],
      firmware: firmware ? [`Mouse ${firmware}`] : [],
      ...(buttons ? { buttonMappings: this.decodeButtons(buttons), buttonOptions: [...BUTTON_ACTIONS.keys(), "Disable"] } : {}),
      dpiStages: stages.map(([x]) => x),
      activeDpiStage: active - 1,
      ui: {
        family: "gwolves-xvi",
        hideUnsupportedPollingRates: true,
        hideRippleControl: true,
        forceShowBattery: false,
        defaultDisplayName: `G-Wolves ${model}`,
        dpiStageEditor: { maxStages: MAX_STAGES, countEditable: false, minDpi: DPI_STEP, maxDpi: DPI_MAX, stepDpi: DPI_STEP },
      },
    };
  }

  async setDpi(dpi: number): Promise<number> {
    if (!this.getDpiOptions().includes(dpi)) throw new Error(`The ${this.product.model} takes 50-30,000 DPI in steps of 50.`);
    const { stages, active } = await this.readDpiStages();
    if (stages.length === 0) throw new Error(`The ${this.product.model} reported no DPI stages.`);
    stages[active - 1] = [dpi, dpi];
    const bytes = stages.flatMap(([x, y]) => [x >> 8, x & 0xff, y >> 8, y & 0xff]);
    await this.transact(xviNewFrame(30, 1, XviNewCommand.setDpiStages, [stages.length, ...bytes]));
    const confirmed = (await this.readDpiStages()).stages[active - 1]?.[0];
    if (confirmed !== dpi) throw new Error(`The ${this.product.model} kept ${confirmed ?? "an unknown"} DPI instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setPollingRate(rate: number): Promise<number> {
    const code = POLLING_CODES.get(rate);
    if (code === undefined || !this.supportedPollingRates.includes(rate)) {
      throw new Error(`The ${this.product.model} does not support ${rate} Hz on this connection.`);
    }
    await this.transact(xviNewFrame(2, 1, XviNewCommand.setPolling, [code]));
    const confirmed = await this.readPollingRate();
    if (confirmed !== rate) throw new Error(`The ${this.product.model} kept ${confirmed} Hz instead of ${rate} Hz.`);
    return confirmed;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    const mm = LOD_RAW.get(value);
    if (mm === undefined) throw new Error(`The ${this.product.model} offers only the 0.7 mm, 1 mm and 2 mm lift-off distances.`);
    // Fractional steps ride above bit 7; whole millimetres go raw.
    const encoded = mm >= 1 ? mm : Math.round(mm * 10) | 128;
    await this.transact(xviNewFrame(2, 1, XviNewCommand.setLiftOff, [encoded]));
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
    await this.transact(xviNewFrame(3, 0, XviNewCommand.setSleep, [seconds >> 8, seconds & 0xff]));
    const confirmed = await this.readSleep();
    if (confirmed !== seconds) throw new Error(`The ${this.product.model} kept ${confirmed ?? "no"} sleep timeout instead of ${seconds} s.`);
    return confirmed;
  }

  async setDebounceTime(milliseconds: number): Promise<number> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > DEBOUNCE_MAX_MS) {
      throw new Error(`The ${this.product.model} takes 0-${DEBOUNCE_MAX_MS} ms of debounce.`);
    }
    const { select, timings } = await this.readDebounce();
    timings[0] = milliseconds;
    await this.transact(xviNewFrame(5, 0, XviNewCommand.setDebounce, [select, ...timings]));
    const confirmed = (await this.readDebounceTimings())[0];
    if (confirmed !== milliseconds) throw new Error(`The ${this.product.model} kept ${confirmed} ms debounce instead of ${milliseconds} ms.`);
    return confirmed;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return this.writeFlag(XviNewCommand.setMotionSync, XviNewCommand.getMotionSync, enabled, "Motion Sync");
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return this.writeFlag(XviNewCommand.setAngleSnap, XviNewCommand.getAngleSnap, enabled, "angle snapping");
  }

  /** Rewrites one button slot; clicks and Disable only (see above). */
  async setButtonMapping(button: string, action: string): Promise<void> {
    const index = BUTTONS.indexOf(button);
    if (index < 0) throw new Error(`The ${this.product.model} has no "${button}" button.`);
    const table = await this.readButtons();
    const current = this.decodeButtons(table);
    if (action !== "Disable" && !BUTTON_ACTIONS.has(action)) {
      throw new Error(`Unknown button action "${action}".`);
    }
    current[button] = action;
    if (!Object.values(current).includes("Left Click")) {
      throw new Error("Keep at least one button as Left Click.");
    }
    // Slots are 1-based on the wire for both reads and writes (confirmed
    // against live hardware: a 0-based write lands on the wrong button and
    // reads back unchanged).
    const slot = index + 1;
    if (action === "Disable") {
      await this.transact(xviNewFrame(5, 3, XviNewCommand.setButton, [slot, 0, 0, 0]));
    } else {
      const code = BUTTON_ACTIONS.get(action)!;
      await this.transact(xviNewFrame(6, 3, XviNewCommand.setButton, [slot, 0, 1, 1, code]));
    }
    const confirmed = this.decodeButtons(await this.readButtons())[button];
    if (confirmed !== action) throw new Error(`The ${this.product.model} kept ${confirmed} on ${button} instead of ${action}.`);
  }

  /** Writes one DPI stage value (0-based), preserving a split X/Y stage. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(dpi) || dpi < DPI_STEP || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
      throw new Error(`The ${this.product.model} takes 50-30,000 DPI in steps of 50.`);
    }
    const { stages } = await this.readDpiStages();
    if (stage < 0 || stage >= stages.length) throw new Error(`This mouse does not have a DPI stage ${stage + 1}.`);
    const bytes = stages.flatMap(([x, yy], at) => {
      const next = at === stage ? dpi : x;
      const keepY = at === stage ? (yy === x ? dpi : yy!) : yy!;
      return [next >> 8, next & 0xff, keepY >> 8, keepY & 0xff];
    });
    await this.transact(xviNewFrame(30, 1, XviNewCommand.setDpiStages, [stages.length, ...bytes]));
    const confirmed = (await this.readDpiStages()).stages[stage]?.[0];
    if (confirmed !== dpi) throw new Error(`The ${this.product.model} kept ${confirmed ?? "an unknown"} DPI on stage ${stage + 1} instead of ${dpi} DPI.`);
    return confirmed;
  }

  /** Selects the active DPI stage (0-based). */
  async setActiveDpiStage(stage: number): Promise<number> {
    const { stages } = await this.readDpiStages();
    if (!Number.isInteger(stage) || stage < 0 || stage >= stages.length) {
      throw new Error(`This mouse does not have a DPI stage ${stage + 1}.`);
    }
    await this.transact(xviNewFrame(2, 1, XviNewCommand.setActiveDpi, [stage + 1]));
    const confirmed = ((await this.transact(xviNewFrame(2, 1, XviNewCommand.getActiveDpi)))[7] ?? 1) - 1;
    if (confirmed !== stage) throw new Error(`The ${this.product.model} kept DPI stage ${confirmed + 1} active instead of stage ${stage + 1}.`);
    return confirmed;
  }

  private decodeButtons(table: Uint8Array): Record<string, string> {
    const labels = new Map([...BUTTON_ACTIONS].map(([label, code]) => [code, label]));
    return Object.fromEntries(BUTTONS.map((name, slot) => {
      const type = table[slot * 2]!;
      const code = table[slot * 2 + 1]!;
      if (type === 0) return [name, "Disable"];
      if (type === 1) return [name, labels.get(code) ?? "Custom"];
      return [name, "Custom"];
    }));
  }

  /** One [type, code] pair per slot; slots are 1-based on the wire. */
  private async readButtons(): Promise<Uint8Array> {
    const table = new Uint8Array(BUTTONS.length * 2);
    for (let slot = 0; slot < BUTTONS.length; slot += 1) {
      // Reads address the slot 1-based while writes are 0-based.
      const reply = await this.transact(
        xviNewFrame(15, 3, XviNewCommand.getButton, [slot + 1, 0, BUTTON_QUERY_TYPE, BUTTON_QUERY_LEN]),
      );
      table[slot * 2] = reply[9] ?? 255;
      table[slot * 2 + 1] = reply[11] ?? 0;
    }
    return table;
  }

  private async optional<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch {
      return null;
    }
  }

  private async readFirmware(): Promise<string | null> {
    // `[2, 16, 0, 129]`; the version follows the command echo at [6..9]
    // however the platform frames the reply (normalize strips the prefix).
    const reply = await this.transact(xviNewFrame(16, 0, XviNewCommand.getFirmware, [], null));
    if (reply[5] !== XviNewCommand.getFirmware) return null;
    return `${reply[6]}.${reply[7]}.${reply[8]}.${reply[9]}`;
  }

  private async readPollingRate(): Promise<number> {
    let code = (await this.transact(xviNewFrame(2, 1, XviNewCommand.getPolling)))[7];
    // The web driver reads 16 as 1 kHz.
    if (code === 16) code = 1;
    return [...POLLING_CODES].find(([, value]) => value === code)?.[0] ?? 1000;
  }

  private async readLiftOffDistance(): Promise<MouseStatus["liftOffDistance"]> {
    const raw = (await this.transact(xviNewFrame(2, 1, XviNewCommand.getLiftOff)))[7];
    const mm = raw >= 128 ? (raw & 0x7f) / 10 : raw;
    return mm === 0.7 ? "Low" : mm === 1 ? "Medium" : mm === 2 ? "High" : null;
  }

  private async readSleep(): Promise<number | null> {
    const reply = await this.transact(xviNewFrame(3, 0, XviNewCommand.getSleep));
    const seconds = ((reply[7] ?? 0) << 8) | (reply[8] ?? 0);
    return SLEEP_OFF.has(seconds) ? null : seconds;
  }

  private async readDebounce(): Promise<{ select: number; timings: number[] }> {
    // Select level at [7], the three timings at [8..10].
    const reply = await this.transact(xviNewFrame(5, 0, XviNewCommand.getDebounce));
    return { select: reply[7] ?? 0, timings: [...reply.slice(8, 11)] };
  }

  private async readDebounceTimings(): Promise<number[]> {
    return (await this.readDebounce()).timings;
  }

  private async readDpiStages(): Promise<{ stages: Array<[number, number]>; active: number }> {
    const table = await this.transact(xviNewFrame(10, 1, XviNewCommand.getDpiStages, [MAX_STAGES]));
    const count = Math.min(table[7] ?? 0, MAX_STAGES);
    const word = (index: number) => ((table[index] ?? 0) << 8) | (table[index + 1] ?? 0);
    const stages = Array.from({ length: count }, (_, stage): [number, number] => [word(8 + stage * 4), word(10 + stage * 4)]);
    const active = (await this.transact(xviNewFrame(2, 1, XviNewCommand.getActiveDpi)))[7] ?? 1;
    return { stages, active: Math.min(Math.max(active, 1), Math.max(count, 1)) };
  }

  private async readFlag(command: XviNewCommand): Promise<boolean> {
    return (await this.transact(xviNewFrame(2, 1, command)))[7] === 1;
  }

  private async writeFlag(setCommand: XviNewCommand, getCommand: XviNewCommand, enabled: boolean, label: string): Promise<boolean> {
    await this.transact(xviNewFrame(2, 1, setCommand, [enabled ? 1 : 0]));
    const confirmed = await this.readFlag(getCommand);
    if (confirmed !== enabled) throw new Error(`The ${this.product.model} kept ${label} ${confirmed ? "on" : "off"}.`);
    return confirmed;
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
        const reply = xviNewNormalize(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        if (reply[echoAt] !== request[echoAt]) continue;
        if (reply[0] === STATUS_OK) return reply;
        if (reply[0] === STATUS_ASLEEP) throw new Error(`The ${this.product.model} is asleep or out of range. Move it, then retry.`);
        if ((reply[0] ?? 0) > STATUS_OK) break;
      }
    }
    throw new Error(`The ${this.product.model} did not answer command 0x${request[echoAt]!.toString(16)}.`);
  }
}
