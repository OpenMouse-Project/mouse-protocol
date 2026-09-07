import type { MouseStatus } from "../mouse-types.ts";
import {
  CMD,
  decodeButtonAction,
  DONGLE_CMD,
  DPI_RGB_OFFSET,
  DPI_X_OFFSET,
  DPI_Y_OFFSET,
  encodeButtonAction,
  encodeCommand,
  GEARHUB_BUTTON_ACTIONS,
  GEARHUB_BUTTONS,
  GEARHUB_DEBOUNCE_MAX_MS,
  GEARHUB_FALLBACK_PROFILE,
  GEARHUB_LIFT_OFF_LEVELS,
  GEARHUB_MAX_DPI_STAGES,
  GEARHUB_PRODUCTS,
  GEARHUB_RATES,
  GEARHUB_REPORT_ID,
  GEARHUB_REPORT_SIZE,
  GEARHUB_SLEEP_OPTIONS,
  GEARHUB_VENDOR_ID,
  gearHubProfileFor,
  OPT0_DEBOUNCE,
  OPT0_FLAG_RIPPLE,
  OPT0_FLAGS,
  OPT0_REPORT_RATE,
  OPT0_SILENT_HEIGHT,
  OPT0_SLEEP_24G,
  OPT0_SLEEP_BT,
  OPT0_STRAIGHT_CORRECTION,
  REPORT_RATE_DECODE,
  REPORT_RATE_ENCODE,
  TARGET_MOUSE,
  type GearHubProfile,
  type GearHubTransport,
  type LiftOffLevel,
} from "@openmouse/protocol/gearhub";

/**
 * GearHub-V5 WebHID driver (VID 0x3151). Owns the 2.4 GHz relay handshake and
 * the feature-report I/O; packet shapes and the device catalog live in the
 * `@openmouse/protocol/gearhub` codec.
 *
 * One driver claims the shared receiver VID:PID and then identifies the model
 * from the GET_USB_VERSION device id: 2285 = Lingbao M5 Pro, 1893 = Attack
 * Shark R2, anything else = the M5 Pro fallback. The product id only settles
 * transport.
 *
 * ── Transport ────────────────────────────────────────────────────────────
 * USB interface 2, vendor usage page 0xFFFF, usage 0x02, one unnumbered
 * 64-byte feature report. Commands are 9 bytes zero-padded into that report.
 *
 * ── Checksum ("Bit7", GearHub's own name) ────────────────────────────────
 * byte[7] = 255 - (sum(bytes 0..6) & 0xFF). Without it the device ACKs the
 * SET_FEATURE and answers 64 zero bytes — silently, no error.
 *
 * ── 2.4 GHz is a relay, not a pipe ───────────────────────────────────────
 * The receiver does not forward a command just because one was written to it.
 * A read over 2.4 GHz is a four-step exchange, and the receiver's OWN commands
 * are raw — they carry no checksum:
 *
 *   1. 0xF6 0x05   select the paired mouse as the target
 *   2. 0xF7        poll receiver status until it reports ready
 *   3. <command>   the checksummed 9-byte command
 *   4. 0xFC        "notice read", then read the feature report back
 *
 * Omit any of 1/2/4 and every reply is 64 zeros — indistinguishable from a
 * device that does not speak the protocol at all.
 *
 * Step 2 is a real gate. An idle mouse drops off its receiver within a few
 * minutes; `mouseOnline` then goes false and every command goes unanswered
 * until the mouse is moved. `readStatus()` surfaces that as its own error so
 * it is never mistaken for a protocol mismatch.
 *
 * Plugged in by cable the mouse enumerates as PID 0x4026 and skips the relay
 * entirely: send the checksummed command, read the reply straight back.
 */

export interface GearHubDongleStatus {
  canRead: boolean;
  canSend: boolean;
  keyboardOnline: boolean;
  mouseOnline: boolean;
  keyboardBattery: number;
  mouseBattery: number;
}

export interface GearHubDpiStage {
  x: number;
  y: number;
  rgb: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GearHubHidClient {
  device: HIDDevice;
  currentProfile = 0;

  /** What the product id tells us before we connect: the transport. */
  private readonly transportEntry: GearHubTransport | undefined;
  /** Model identity, resolved from the device id on the first readStatus(). */
  private resolvedProfile: GearHubProfile | null = null;

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
    this.transportEntry = GEARHUB_PRODUCTS.get(device.productId);
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== GEARHUB_VENDOR_ID) return false;
    if (!GEARHUB_PRODUCTS.has(device.productId)) return false;
    const hasControl = (collections: readonly HIDCollectionInfo[]): boolean =>
      collections.some(
        (collection) =>
          (collection.usagePage === 0xffff && collection.usage === 0x02) ||
          hasControl(collection.children ?? []),
      );
    return hasControl(device.collections);
  }

  /** Whether reads go through the 2.4 GHz relay or straight to the device. */
  get transport(): "dongle" | "direct" {
    return this.transportEntry?.transport ?? "direct";
  }

  get supportedPollingRates(): number[] {
    const profile = this.resolvedProfile ?? GEARHUB_FALLBACK_PROFILE;
    const linkCeiling = this.transportEntry?.wiredPollingCeilingHz ?? Infinity;
    const ceiling = Math.min(profile.maxPollingHz, linkCeiling);
    return GEARHUB_RATES.filter((hz) => hz <= ceiling);
  }

  /**
   * DPI stops worth offering, capped at the resolved model's sensor ceiling.
   * These sensors step in 50 DPI increments; the UI offers the round values.
   * Before the first readStatus() this uses the fallback (M5 Pro) ceiling.
   */
  getDpiOptions(): number[] {
    const { maxDpi } = this.resolvedProfile ?? GEARHUB_FALLBACK_PROFILE;
    return [
      400, 800, 1200, 1600, 2000, 2400, 3200, 4000, 4800, 5600, 6400, 8000,
      10000, 12000, 16000, 20000, 26000,
      28000, 30000, 32000, 36000, 40000, 42000,
    ].filter((dpi) => dpi <= maxDpi);
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
    const buf = new Uint8Array(GEARHUB_REPORT_SIZE);
    buf.set(
      bytes instanceof Uint8Array
        ? bytes.subarray(0, GEARHUB_REPORT_SIZE)
        : bytes.slice(0, GEARHUB_REPORT_SIZE),
    );
    await this.device.sendFeatureReport(GEARHUB_REPORT_ID, buf);
  }

  private async rawRead(): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(GEARHUB_REPORT_ID);
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  // ---------------------------------------------------------------------------
  // 2.4 GHz receiver relay
  // ---------------------------------------------------------------------------

  /**
   * Poll the receiver for link state and battery. A receiver command, so no
   * checksum. Measured layout, live: `01 00 2D 01 00 01` — ready to read,
   * no keyboard, mouse at 0x2D = 45%, keyboard offline, mouse online, ready
   * to send.
   */
  async readDongleStatus(): Promise<GearHubDongleStatus> {
    return this.enqueue(() => this.pollStatus());
  }

  /** Unqueued: callers already holding the queue slot use this. */
  private async pollStatus(): Promise<GearHubDongleStatus> {
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
    for (let attempt = 0; attempt < 8; attempt++) {
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
   * answer. Most reads echo the command id in byte 0; an unrelayed or
   * unchecksummed command comes back as 64 zeros, which must never be mistaken
   * for data. `GET_KEYMATRIX` is the exception — its reply is pure matrix data
   * with no echo byte — so `echoes: false` keeps only the all-zero guard.
   */
  async command(bytes: readonly number[], opts: { echoes?: boolean } = {}): Promise<Uint8Array> {
    return this.enqueue(() => this.exchange(bytes, opts.echoes ?? true));
  }

  private async exchange(bytes: readonly number[], echoes: boolean): Promise<Uint8Array> {
    await this.open();
    const encoded = encodeCommand(bytes);

    if (this.transport === "direct") {
      await this.rawSend(encoded);
      await delay(10);
      return this.verifyReply(await this.rawRead(), bytes[0], echoes);
    }

    await this.selectMouse();
    if (!(await this.waitReady("send"))) {
      throw new Error("The 2.4 GHz receiver never became ready to send.");
    }
    await this.rawSend(encoded);
    if (!(await this.waitReady("read"))) {
      throw new Error("The 2.4 GHz receiver never became ready to read.");
    }
    await this.rawSend([DONGLE_CMD.NOTICE_READ]);
    await delay(10);
    return this.verifyReply(await this.rawRead(), bytes[0], echoes);
  }

  private verifyReply(resp: Uint8Array, cmd: number, echoes: boolean): Uint8Array {
    if (resp.length < GEARHUB_REPORT_SIZE) {
      throw new Error(
        `GearHub command 0x${cmd.toString(16)} returned ${resp.length} bytes, expected ${GEARHUB_REPORT_SIZE}.`,
      );
    }
    if (resp.every((byte) => byte === 0)) {
      throw new Error(`GearHub command 0x${cmd.toString(16)} was not answered (all-zero response).`);
    }
    if (echoes && resp[0] !== cmd) {
      throw new Error(
        `GearHub command 0x${cmd.toString(16)} answered with id 0x${resp[0].toString(16)}.`,
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

  /**
   * Read the 64-byte OPTIONPARAM0 block — report rate (byte 9), debounce
   * (10), lift-off (52), sleep, sensitivity. GearHub reads and writes this
   * whole; the driver picks out the fields it exposes.
   */
  async getOptionParam0(): Promise<Uint8Array> {
    return this.command([CMD.GET_OPTIONPARAM0]);
  }

  async getReportRate(): Promise<number> {
    const opt0 = await this.getOptionParam0();
    const hz = REPORT_RATE_DECODE[opt0[OPT0_REPORT_RATE]];
    if (hz === undefined) {
      throw new Error(
        `GearHub OPTIONPARAM0 held an unknown report-rate code ${opt0[OPT0_REPORT_RATE]}.`,
      );
    }
    return hz;
  }

  /** The lift-off stops this model offers, ascending; empty when unknown. */
  private liftOffLevels(): readonly LiftOffLevel[] {
    const profile = this.resolvedProfile ?? GEARHUB_FALLBACK_PROFILE;
    return GEARHUB_LIFT_OFF_LEVELS[profile.sensor] ?? [];
  }

  /** Every DPI stage of the active profile, plus which one is selected. */
  async getDpi(): Promise<{ stages: GearHubDpiStage[]; activeIndex: number }> {
    const resp = await this.command([CMD.GET_DPI, this.currentProfile]);
    const activeIndex = resp[2] >= GEARHUB_MAX_DPI_STAGES ? 0 : resp[2];
    const count = Math.min(resp[3], GEARHUB_MAX_DPI_STAGES);
    if (count === 0) throw new Error("GearHub GET_DPI reported no DPI stages.");

    const stages: GearHubDpiStage[] = [];
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

  /**
   * Change fields in OPTIONPARAM0 by read-modify-write. GearHub's settings
   * only take effect when the whole 64-byte block is written back, so every
   * byte not in `overrides` is carried over from the current read. Bytes
   * 17/18 are stamped the way GearHub's own writer stamps them.
   */
  private async patchOptionParam0(
    overrides: Record<number, number | ((current: number) => number)>,
  ): Promise<void> {
    const current = await this.getOptionParam0();
    const block = new Uint8Array(GEARHUB_REPORT_SIZE);
    block.set(current.subarray(8, GEARHUB_REPORT_SIZE), 8);
    block[0] = CMD.SET_OPTIONPARAM0;
    block[17] = 255;
    block[18] = 8;
    for (const [offset, value] of Object.entries(overrides)) {
      const i = Number(offset);
      block[i] = (typeof value === "function" ? value(current[i]) : value) & 0xff;
    }
    await this.sendWrite(block);
  }

  async setReportRate(hz: number): Promise<number> {
    const code = REPORT_RATE_ENCODE[hz];
    if (code === undefined || !this.supportedPollingRates.includes(hz)) {
      throw new Error(
        `Unsupported rate ${hz} Hz. Supported: ${this.supportedPollingRates.join(", ")}`,
      );
    }
    await this.patchOptionParam0({ [OPT0_REPORT_RATE]: code });
    return hz;
  }

  /** Set the lift-off distance. Levels come from `liftOffLevels()`. */
  async setLiftOffDistance(level: LiftOffLevel): Promise<LiftOffLevel> {
    const index = this.liftOffLevels().indexOf(level);
    if (index < 0) {
      throw new Error(`Lift-off level "${level}" is not available on this model.`);
    }
    await this.patchOptionParam0({ [OPT0_SILENT_HEIGHT]: index });
    return level;
  }

  /** Debounce (button click filter), 0..10 ms — GearHub's "Debounce" slider. */
  getDebounceMaxMs(): number {
    return GEARHUB_DEBOUNCE_MAX_MS;
  }

  /** The exact debounce values to offer (0..10 ms), so the UI never presents
   *  a value the firmware would clamp. */
  getDebounceOptions(): number[] {
    return Array.from({ length: GEARHUB_DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  async setDebounceTime(ms: number): Promise<number> {
    const clamped = Math.max(0, Math.min(GEARHUB_DEBOUNCE_MAX_MS, Math.round(ms)));
    await this.patchOptionParam0({ [OPT0_DEBOUNCE]: clamped });
    return clamped;
  }

  /** Standby-time stops, seconds; 0 = never. GearHub's "Sleep Settings". */
  getSleepOptions(): number[] {
    return [...GEARHUB_SLEEP_OPTIONS];
  }

  /**
   * Idle seconds before standby. GearHub keeps a 2.4 GHz timer and a Bluetooth
   * timer; OpenMouse has one control, so both are set to the same value.
   */
  async setSleepTimeout(seconds: number): Promise<number> {
    const s = Math.max(0, Math.min(0xffff, Math.round(seconds)));
    await this.patchOptionParam0({
      [OPT0_SLEEP_24G]: s & 0xff,
      [OPT0_SLEEP_24G + 1]: (s >> 8) & 0xff,
      [OPT0_SLEEP_BT]: s & 0xff,
      [OPT0_SLEEP_BT + 1]: (s >> 8) & 0xff,
    });
    return s;
  }

  /** "Straight Correction" — GearHub's angle-snapping / line-repair toggle. */
  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    await this.patchOptionParam0({ [OPT0_STRAIGHT_CORRECTION]: enabled ? 1 : 0 });
    return enabled;
  }

  /** "Ripple Correction" — bit 2 of the OPTIONPARAM0 flags word. */
  async setRippleControl(enabled: boolean): Promise<boolean> {
    await this.patchOptionParam0({
      [OPT0_FLAGS]: (current) =>
        enabled ? current | OPT0_FLAG_RIPPLE : current & ~OPT0_FLAG_RIPPLE,
    });
    return enabled;
  }

  // ── Button remapping ──────────────────────────────────────────────────────

  /**
   * Raw keymatrix reply for a profile: 14 slots x 4 bytes, no echo byte. Read
   * late in `readStatus` after several other relay exchanges, so it retries
   * once — the relay is more likely to miss its ready window under load.
   */
  async getKeyMatrix(profile = 0): Promise<Uint8Array> {
    try {
      return await this.command([CMD.GET_KEYMATRIX, profile], { echoes: false });
    } catch {
      return this.command([CMD.GET_KEYMATRIX, profile], { echoes: false });
    }
  }

  private buttonMappingsFrom(reply: Uint8Array): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { name, slot } of GEARHUB_BUTTONS) {
      const o = slot * 4;
      out[name] = decodeButtonAction([reply[o], reply[o + 1], reply[o + 2], reply[o + 3]]);
    }
    return out;
  }

  /** Every action `setButtonMapping` accepts, in display order. */
  getButtonOptions(): string[] {
    return GEARHUB_BUTTON_ACTIONS.map(([label]) => label);
  }

  /** Reassign one physical button. `button` is a `GEARHUB_BUTTONS` name. */
  async setButtonMapping(button: string, action: string): Promise<void> {
    const target = GEARHUB_BUTTONS.find((b) => b.name === button);
    if (!target) throw new Error(`Unknown button "${button}".`);
    const value = encodeButtonAction(action);
    if (!value) throw new Error(`Unsupported button action "${action}".`);
    const cmd = new Uint8Array(GEARHUB_REPORT_SIZE);
    cmd[0] = CMD.SET_KEYMATRIX;
    cmd[1] = 0; // profile
    cmd[2] = target.slot;
    cmd[8] = value[0];
    cmd[9] = value[1];
    cmd[10] = value[2];
    cmd[11] = value[3];
    await this.sendWrite(cmd);
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

    const cmd = new Uint8Array(GEARHUB_REPORT_SIZE);
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
      throw new Error("The 2.4 GHz receiver never became ready to send.");
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
          "The 2.4 GHz receiver is present but no mouse is linked to it — the mouse is asleep, powered off, or switched to Bluetooth/wired mode. Move the mouse and try again.",
        );
      }
      battery = status.mouseBattery > 0 && status.mouseBattery <= 100 ? status.mouseBattery : null;
    }

    // Identify the model before the first data read. GearHub keys its model
    // table off this id; the receiver's shared VID:PID cannot. A failure here
    // (older firmware, a sibling that does not answer 0x8F) is non-fatal — we
    // fall back to the M5 Pro profile, which is what this driver always was.
    let deviceId: number | null = null;
    try {
      deviceId = await this.getDeviceId();
    } catch {
      deviceId = null;
    }
    this.resolvedProfile = deviceId !== null ? gearHubProfileFor(deviceId) : null;
    const profile = this.resolvedProfile ?? GEARHUB_FALLBACK_PROFILE;
    const displayName = `${profile.brand} ${profile.model}`;

    // The DPI read has to work: it carries the values the UI exists to show,
    // and it is the cheapest proof the whole relay + checksum path is right.
    const dpi = await this.getDpi();
    const active = dpi.stages[dpi.activeIndex] ?? dpi.stages[0];

    // Report rate and lift-off both live in the OPTIONPARAM0 block — one read
    // covers both. A failure leaves the rate at a safe default and lift-off
    // unreported rather than sinking the whole status.
    const [opt0Result, keyMatrixResult, firmwareResult] = await Promise.allSettled([
      this.getOptionParam0(),
      this.getKeyMatrix(0),
      this.getFirmwareVersion(),
    ]);
    let pollingRateHz = 1000;
    let liftOffDistance: LiftOffLevel | null = null;
    let supportedLiftOffDistances: LiftOffLevel[] | undefined;
    let debounceMs: number | null = null;
    let angleSnapping: boolean | null = null;
    let rippleControl: boolean | null = null;
    let sleepTimeout: number | null = null;
    if (opt0Result.status === "fulfilled") {
      const opt0 = opt0Result.value;
      pollingRateHz = REPORT_RATE_DECODE[opt0[OPT0_REPORT_RATE]] ?? pollingRateHz;
      debounceMs = opt0[OPT0_DEBOUNCE];
      angleSnapping = opt0[OPT0_STRAIGHT_CORRECTION] !== 0;
      rippleControl = (opt0[OPT0_FLAGS] & OPT0_FLAG_RIPPLE) !== 0;
      sleepTimeout = opt0[OPT0_SLEEP_24G] | (opt0[OPT0_SLEEP_24G + 1] << 8);
      const levels = this.liftOffLevels();
      if (levels.length > 0) {
        liftOffDistance = levels[opt0[OPT0_SILENT_HEIGHT]] ?? levels[0];
        if (levels.length < 3) supportedLiftOffDistances = [...levels];
      }
    }
    const firmware =
      firmwareResult.status === "fulfilled" && firmwareResult.value !== 0
        ? [`v${(firmwareResult.value >> 8) & 0xff}.${String(firmwareResult.value & 0xff).padStart(2, "0")}`]
        : [];

    const buttonMappings =
      keyMatrixResult.status === "fulfilled"
        ? this.buttonMappingsFrom(keyMatrixResult.value)
        : undefined;

    return {
      brand: profile.brand,
      name: displayName,
      ui: {
        family: "gearhub",
        settingsReady: true,
        defaultDisplayName: displayName,
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
      liftOffDistance,
      ...(supportedLiftOffDistances ? { supportedLiftOffDistances } : {}),
      debounceMs,
      angleSnapping,
      rippleControl,
      sleepTimeout,
      ...(buttonMappings ? { buttonMappings, buttonOptions: this.getButtonOptions() } : {}),
      firmware: [...firmware, profile.sensor],
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
