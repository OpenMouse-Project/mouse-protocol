import type { MouseStatus } from "../mouse-types.ts";

/**
 * Lingbao M5 Pro vendor HID control.
 *
 * Verified end to end against real hardware: a Lingbao M5 Pro (PixArt
 * PAW3395) on its 2.4G receiver, VID 0x3151 / PID 0x402D, Windows 11.
 *
 * Lingbao ships no protocol of its own — the mouse is configured by GearHub-V5
 * (https://www.qmk.top), the ODM web tool behind a long list of brands, and
 * everything below was read out of GearHub's own bundle and then confirmed
 * byte for byte on the device. VID 0x3151 belongs to MicLink/mlzn, the ODM,
 * NOT to Lingbao and not to Fantech (which the existing `fantech` driver in
 * this repo assumes); several unrelated brands enumerate under it, which is
 * why the product-id tables below are exact rather than vendor-wide.
 *
 * ── Transport ────────────────────────────────────────────────────────────
 * USB interface 2, vendor usage page 0xFFFF, usage 0x02, one unnumbered
 * 64-byte feature report. Commands are 9 bytes zero-padded into that report.
 * Measured on the M5 Pro: `FeatureReportByteLength = 65` (report id + 64).
 *
 * ── Checksum ("Bit7", GearHub's own name for it) ─────────────────────────
 * byte[7] = 255 - (sum(bytes 0..6) & 0xFF). Without it the device ACKs the
 * SET_FEATURE and answers 64 zero bytes — silently, no error.
 *
 * ── 2.4G is a relay, not a pipe ──────────────────────────────────────────
 * The receiver does not forward a command just because one was written to it.
 * A read over 2.4G is a four-step exchange, and the receiver's OWN commands
 * are raw — they carry no checksum:
 *
 *   1. 0xF6 0x05   select the paired mouse as the target (0x0A = keyboard)
 *   2. 0xF7        poll receiver status until it reports ready
 *   3. <command>   the checksummed 9-byte command
 *   4. 0xFC        "notice read", then read the feature report back
 *
 * Omit any of 1/2/4 and every reply is 64 zeros — indistinguishable from a
 * device that does not speak the protocol at all. This is the single reason
 * the `fantech` driver reads nothing from this hardware: it has the right
 * interface and roughly the right DPI layout, but no relay, no checksum, and
 * a different command set.
 *
 * Step 2 is a real gate. An idle M5 Pro drops off its receiver within a few
 * minutes; `mouseOnline` then goes false and every command goes unanswered
 * until the mouse is moved. `readStatus()` surfaces that as its own error so
 * it is never mistaken for a protocol mismatch.
 *
 * Plugged in by cable the mouse enumerates as PID 0x4026 and skips the relay
 * entirely: send the checksummed command, read the reply straight back.
 */

/** Receiver-level commands. Raw — the Bit7 checksum is NOT applied to these. */
const DONGLE_CMD = {
  SELECT_TARGET: 0xf6,
  GET_STATUS: 0xf7,
  NOTICE_READ: 0xfc,
} as const;

const TARGET_MOUSE = 0x05;

/**
 * Mouse-class command ids. GearHub numbers them so every read is its matching
 * write plus 0x80 (SET_REPORT 0x03 / GET_REPORT 0x83, SET_DPI 0x54 / GET_DPI
 * 0xD4). All of these were confirmed echoing on the M5 Pro.
 */
export const CMD = {
  GET_FIRMWARE: 0x80,
  GET_USB_VERSION: 0x8f,
  SET_REPORT_RATE: 0x03,
  GET_REPORT_RATE: 0x83,
  GET_PROFILE: 0x85,
  GET_DEBOUNCE: 0x86,
  SET_DPI: 0x54,
  GET_DPI: 0xd4,
} as const;

/**
 * Report-rate codes for the MOUSE class — seven entries, with 250 Hz at code
 * 5. GearHub's keyboard class uses a six-entry table where code 5 means
 * 125 Hz instead; decoding a mouse with that table reports 250 Hz as 125 Hz
 * and cannot express 125 Hz at all. (The `fantech` driver in this repo
 * carries the six-entry keyboard table.)
 */
export const REPORT_RATE_DECODE: Record<number, number> = {
  0: 8000,
  1: 4000,
  2: 2000,
  3: 1000,
  4: 500,
  5: 250,
  6: 125,
};

export const REPORT_RATE_ENCODE: Record<number, number> = Object.fromEntries(
  Object.entries(REPORT_RATE_DECODE).map(([code, hz]) => [hz, Number(code)]),
);

export const LINGBAO_VENDOR_ID = 0x3151;
export const LINGBAO_REPORT_ID = 0x00;
export const LINGBAO_REPORT_SIZE = 64;
export const LINGBAO_CMD_SIZE = 9;

/** DPI stages the report layout has room for. */
export const LINGBAO_MAX_DPI_STAGES = 8;

// GET_DPI response layout, from GearHub's getDPI() and confirmed on hardware:
//   [2] active stage index, [3] stage count,
//   [8 + i*2] X as LE uint16, [24 + i*2] Y as LE uint16,
//   [40 + i*3] that stage's indicator colour as r, g, b.
const DPI_X_OFFSET = 8;
const DPI_Y_OFFSET = 24;
const DPI_RGB_OFFSET = 40;

export interface LingbaoProduct {
  model: string;
  /** How this product id is reached: through the 2.4G receiver, or directly. */
  transport: "dongle" | "direct";
  sensor: string;
  maxPollingHz: number;
  minDpi: number;
  maxDpi: number;
  dpiStep: number;
}

/**
 * The M5 Pro presents two product ids: the 2.4G receiver, and the mouse
 * itself when connected by cable. Both were seen on the test machine.
 *
 * The receiver is an 8K part — GearHub's device table flags 0x402D
 * `reportRate: 8e3`, and the mouse answered GET_REPORT with code 0 (8000 Hz)
 * live. Lingbao's own spec sheet for the base M5 Pro says 1000 Hz, so either
 * that sheet undersells the receiver or the retail bundle varies; the value
 * below follows the hardware and GearHub, not the sheet.
 *
 * Bluetooth is the mouse's third mode. It is not listed here: over BLE the
 * device enumerates on a different usage page entirely (0xFF35/0xFF66,
 * usage 0x0202) and GearHub drives it through a separate read path, which
 * this driver does not implement.
 */
export const LINGBAO_PRODUCTS: ReadonlyMap<number, LingbaoProduct> = new Map([
  [0x402d, {
    model: "M5 Pro (2.4G receiver)",
    transport: "dongle",
    sensor: "PixArt PAW3395",
    maxPollingHz: 8000,
    minDpi: 50,
    maxDpi: 26000,
    dpiStep: 50,
  }],
  [0x4026, {
    model: "M5 Pro (wired)",
    transport: "direct",
    sensor: "PixArt PAW3395",
    maxPollingHz: 1000,
    minDpi: 50,
    maxDpi: 26000,
    dpiStep: 50,
  }],
]);

const ALL_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

export interface LingbaoDongleStatus {
  canRead: boolean;
  canSend: boolean;
  keyboardOnline: boolean;
  mouseOnline: boolean;
  keyboardBattery: number;
  mouseBattery: number;
}

export interface LingbaoDpiStage {
  x: number;
  y: number;
  rgb: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Pad to 9 bytes and stamp the Bit7 checksum into byte 7. */
export function encodeCommand(bytes: readonly number[]): Uint8Array {
  const out = new Uint8Array(Math.max(LINGBAO_CMD_SIZE, bytes.length));
  out.set(bytes);
  let sum = 0;
  for (let i = 0; i < 7; i++) sum = (sum + out[i]) & 0xff;
  out[7] = (255 - sum) & 0xff;
  return out;
}

export class LingbaoHidClient {
  device: HIDDevice;
  currentProfile = 0;

  readonly product: LingbaoProduct | undefined;

  private targetSelected = false;

  /**
   * The relay is stateful — select target, poll ready, send, notice-read,
   * read — so two exchanges in flight at once interleave and corrupt each
   * other. Every public operation is chained through here so only one runs at
   * a time, the same way GearHub serialises through its own send queue.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  constructor(device: HIDDevice) {
    this.device = device;
    this.product = LINGBAO_PRODUCTS.get(device.productId);
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== LINGBAO_VENDOR_ID) return false;
    if (!LINGBAO_PRODUCTS.has(device.productId)) return false;
    const hasControl = (collections: readonly HIDCollectionInfo[]): boolean =>
      collections.some(
        (collection) =>
          (collection.usagePage === 0xffff && collection.usage === 0x02) ||
          hasControl(collection.children ?? []),
      );
    return hasControl(device.collections);
  }

  /** Whether reads go through the 2.4G relay or straight to the device. */
  get transport(): "dongle" | "direct" {
    return this.product?.transport ?? "direct";
  }

  get supportedPollingRates(): number[] {
    const max = this.product?.maxPollingHz ?? 1000;
    return ALL_RATES.filter((hz) => hz <= max);
  }

  /** PAW3395 steps in 50 DPI increments; these are the round values worth offering. */
  getDpiOptions(): number[] {
    return [
      400, 800, 1200, 1600, 2000, 2400, 3200, 4000, 4800, 5600, 6400, 8000,
      10000, 12000, 16000, 20000, 26000,
    ];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  // ---------------------------------------------------------------------------
  // Raw feature-report I/O
  // ---------------------------------------------------------------------------

  private async rawSend(bytes: readonly number[] | Uint8Array): Promise<void> {
    const buf = new Uint8Array(LINGBAO_REPORT_SIZE);
    buf.set(
      bytes instanceof Uint8Array
        ? bytes.subarray(0, LINGBAO_REPORT_SIZE)
        : bytes.slice(0, LINGBAO_REPORT_SIZE),
    );
    await this.device.sendFeatureReport(LINGBAO_REPORT_ID, buf);
  }

  private async rawRead(): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(LINGBAO_REPORT_ID);
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  // ---------------------------------------------------------------------------
  // 2.4G receiver relay
  // ---------------------------------------------------------------------------

  /**
   * Poll the receiver for link state and battery. A receiver command, so no
   * checksum. Measured layout, live: `01 00 2D 01 00 01` — ready to read,
   * no keyboard, mouse at 0x2D = 45%, keyboard offline, mouse online, ready
   * to send.
   */
  async readDongleStatus(): Promise<LingbaoDongleStatus> {
    return this.enqueue(() => this.pollStatus());
  }

  /** Unqueued: callers already holding the queue slot use this. */
  private async pollStatus(): Promise<LingbaoDongleStatus> {
    await this.rawSend([DONGLE_CMD.GET_STATUS]);
    await delay(10);
    const r = await this.rawRead();
    return {
      canRead: r[0] === 1,
      keyboardBattery: r[1],
      mouseBattery: r[2],
      keyboardOnline: r[3] === 0,
      mouseOnline: r[4] === 0,
      canSend: r[5] === 1,
    };
  }

  private async selectMouse(): Promise<void> {
    if (this.targetSelected) return;
    await this.rawSend([DONGLE_CMD.SELECT_TARGET, TARGET_MOUSE]);
    await delay(50);
    this.targetSelected = true;
  }

  private async waitReady(direction: "send" | "read"): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(100);
      const status = await this.pollStatus();
      if (direction === "send" ? status.canSend : status.canRead) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Command exchange
  // ---------------------------------------------------------------------------

  /**
   * Run one command and return its reply, rejecting a reply that is not an
   * answer. The device validates by echo: it repeats the command id in byte
   * 0. An unrelayed or unchecksummed command comes back as 64 zeros, which is
   * exactly what must never be mistaken for data.
   */
  async command(bytes: readonly number[]): Promise<Uint8Array> {
    return this.enqueue(() => this.exchange(bytes));
  }

  private async exchange(bytes: readonly number[]): Promise<Uint8Array> {
    await this.open();
    const encoded = encodeCommand(bytes);

    if (this.transport === "direct") {
      await this.rawSend(encoded);
      await delay(10);
      return this.verifyEcho(await this.rawRead(), bytes[0]);
    }

    await this.selectMouse();
    if (!(await this.waitReady("send"))) {
      throw new Error("Lingbao receiver never became ready to send.");
    }
    await this.rawSend(encoded);
    if (!(await this.waitReady("read"))) {
      throw new Error("Lingbao receiver never became ready to read.");
    }
    await this.rawSend([DONGLE_CMD.NOTICE_READ]);
    await delay(10);
    return this.verifyEcho(await this.rawRead(), bytes[0]);
  }

  private verifyEcho(resp: Uint8Array, cmd: number): Uint8Array {
    if (resp.length < LINGBAO_REPORT_SIZE) {
      throw new Error(
        `Lingbao command 0x${cmd.toString(16)} returned ${resp.length} bytes, expected ${LINGBAO_REPORT_SIZE}.`,
      );
    }
    if (resp[0] !== cmd) {
      const blank = resp.every((byte) => byte === 0);
      throw new Error(
        blank
          ? `Lingbao command 0x${cmd.toString(16)} was not answered (all-zero response).`
          : `Lingbao command 0x${cmd.toString(16)} answered with id 0x${resp[0].toString(16)}.`,
      );
    }
    return resp;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Device id — the key GearHub looks its model table up by. M5 Pro answers 2285. */
  async getDeviceId(): Promise<number> {
    const resp = await this.command([CMD.GET_USB_VERSION]);
    return (resp[1] | (resp[2] << 8) | (resp[3] << 16) | (resp[4] << 24)) >>> 0;
  }

  /** Firmware revision: byte 2 high, byte 1 low. M5 Pro answers 0x0303. */
  async getFirmwareVersion(): Promise<number> {
    const resp = await this.command([CMD.GET_FIRMWARE]);
    return (resp[2] << 8) | resp[1];
  }

  async getReportRate(): Promise<number> {
    const resp = await this.command([CMD.GET_REPORT_RATE]);
    const hz = REPORT_RATE_DECODE[resp[2]];
    if (hz === undefined) {
      throw new Error(`Lingbao GET_REPORT_RATE returned unknown code ${resp[2]}.`);
    }
    return hz;
  }

  /** Every DPI stage of the active profile, plus which one is selected. */
  async getDpi(): Promise<{ stages: LingbaoDpiStage[]; activeIndex: number }> {
    const resp = await this.command([CMD.GET_DPI, this.currentProfile]);
    const activeIndex = resp[2] >= LINGBAO_MAX_DPI_STAGES ? 0 : resp[2];
    const count = Math.min(resp[3], LINGBAO_MAX_DPI_STAGES);
    if (count === 0) throw new Error("Lingbao GET_DPI reported no DPI stages.");

    const stages: LingbaoDpiStage[] = [];
    for (let i = 0; i < count; i++) {
      stages.push({
        x: resp[DPI_X_OFFSET + i * 2] | (resp[DPI_X_OFFSET + 1 + i * 2] << 8),
        y: resp[DPI_Y_OFFSET + i * 2] | (resp[DPI_Y_OFFSET + 1 + i * 2] << 8),
        rgb:
          (resp[DPI_RGB_OFFSET + i * 3] << 16) |
          (resp[DPI_RGB_OFFSET + 1 + i * 3] << 8) |
          resp[DPI_RGB_OFFSET + 2 + i * 3],
      });
    }
    return { stages, activeIndex };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async setReportRate(hz: number): Promise<number> {
    const code = REPORT_RATE_ENCODE[hz];
    if (code === undefined || !this.supportedPollingRates.includes(hz)) {
      throw new Error(
        `Unsupported rate ${hz} Hz. Supported: ${this.supportedPollingRates.join(", ")}`,
      );
    }
    await this.open();
    // SET_REPORT carries the code in byte 2, not byte 1.
    const cmd = new Uint8Array(LINGBAO_CMD_SIZE);
    cmd[0] = CMD.SET_REPORT_RATE;
    cmd[2] = code;
    await this.sendWrite(cmd);
    return hz;
  }

  /**
   * Replace one DPI stage. SET_DPI carries the whole stage table, so the other
   * stages — and every stage's indicator colour — are read back and echoed
   * unchanged rather than zeroed.
   */
  async setDpiForStage(x: number, y: number, index: number): Promise<number> {
    const { stages, activeIndex } = await this.getDpi();
    const target = index >= 0 && index < stages.length ? index : activeIndex;
    stages[target] = { ...stages[target], x, y };

    const cmd = new Uint8Array(LINGBAO_REPORT_SIZE);
    cmd[0] = CMD.SET_DPI;
    cmd[1] = this.currentProfile;
    cmd[2] = target;
    cmd[3] = stages.length;
    stages.forEach((stage, i) => {
      cmd[DPI_X_OFFSET + i * 2] = stage.x & 0xff;
      cmd[DPI_X_OFFSET + 1 + i * 2] = (stage.x >> 8) & 0xff;
      cmd[DPI_Y_OFFSET + i * 2] = stage.y & 0xff;
      cmd[DPI_Y_OFFSET + 1 + i * 2] = (stage.y >> 8) & 0xff;
      cmd[DPI_RGB_OFFSET + i * 3] = (stage.rgb >> 16) & 0xff;
      cmd[DPI_RGB_OFFSET + 1 + i * 3] = (stage.rgb >> 8) & 0xff;
      cmd[DPI_RGB_OFFSET + 2 + i * 3] = stage.rgb & 0xff;
    });
    await this.sendWrite(cmd);
    return x;
  }

  /** A write takes the same relay path as a read, minus the read-back. */
  private async sendWrite(cmd: Uint8Array): Promise<void> {
    return this.enqueue(() => this.writeThrough(cmd));
  }

  private async writeThrough(cmd: Uint8Array): Promise<void> {
    const encoded = encodeCommand([...cmd]);
    if (this.transport === "direct") {
      await this.rawSend(encoded);
      await delay(10);
      return;
    }
    await this.selectMouse();
    if (!(await this.waitReady("send"))) {
      throw new Error("Lingbao receiver never became ready to send.");
    }
    await this.rawSend(encoded);
    await delay(50);
  }

  // ---------------------------------------------------------------------------
  // High-Level API
  // ---------------------------------------------------------------------------

  async readStatus(): Promise<MouseStatus> {
    await this.open();

    let battery: number | null = null;
    let connectionType: "Wired" | "Wireless" = "Wired";
    let connectionDetail = "USB";

    if (this.transport === "dongle") {
      connectionType = "Wireless";
      connectionDetail = "2.4 GHz";
      const status = await this.readDongleStatus();
      if (!status.mouseOnline) {
        throw new Error(
          "Lingbao receiver is present but no mouse is linked to it — the mouse is asleep, powered off, or switched to Bluetooth/wired mode. Move the mouse and try again.",
        );
      }
      battery = status.mouseBattery > 0 && status.mouseBattery <= 100 ? status.mouseBattery : null;
    }

    // The DPI read has to work: it carries the values the UI exists to show,
    // and it is the cheapest proof the whole relay + checksum path is right.
    const dpi = await this.getDpi();
    const active = dpi.stages[dpi.activeIndex] ?? dpi.stages[0];

    const [rateResult, firmwareResult] = await Promise.allSettled([
      this.getReportRate(),
      this.getFirmwareVersion(),
    ]);
    const pollingRateHz = rateResult.status === "fulfilled" ? rateResult.value : 1000;
    const firmware =
      firmwareResult.status === "fulfilled" && firmwareResult.value !== 0
        ? [`v${(firmwareResult.value >> 8) & 0xff}.${String(firmwareResult.value & 0xff).padStart(2, "0")}`]
        : [];

    const name = this.product ? `Lingbao ${this.product.model}` : this.device.productName || "Lingbao Mouse";

    return {
      brand: "Lingbao",
      name,
      ui: {
        family: "lingbao",
        settingsReady: true,
        hideLodLow: true,
        hideProcessingCard: true,
        defaultDisplayName: this.product ? "Lingbao M5 Pro" : name,
      },
      batteryPercent: battery,
      batteryState: battery === null ? "Unknown" : "Discharging",
      dpi: active.x,
      dpiY: active.y,
      supportsSeparateDpiAxes: true,
      dpiStages: dpi.stages.map((stage) => stage.x),
      activeDpiStage: dpi.activeIndex,
      pollingRateHz,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: this.currentProfile,
      connectionType,
      connectionDetail,
      liftOffDistance: null,
      firmware: this.product ? [...firmware, this.product.sensor] : firmware,
    };
  }

  async setDpi(dpi: number, dpiY = dpi): Promise<number> {
    const { activeIndex } = await this.getDpi();
    await this.setDpiForStage(dpi, dpiY, activeIndex);
    return dpi;
  }

  async setPollingRate(rate: number): Promise<number> {
    return this.setReportRate(rate);
  }
}
