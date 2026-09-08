import {
  MCHOSE_COMMAND,
  MCHOSE_CONFIG_USAGE,
  MCHOSE_CONFIG_USAGE_PAGE,
  MCHOSE_DPI_STAGES,
  MCHOSE_LONG_REPORT_ID,
  MCHOSE_LONG_TOKENS,
  MCHOSE_PRODUCTS,
  MCHOSE_PROFILE_COUNT,
  MCHOSE_SLEEP_OPTIONS,
  MCHOSE_DEBOUNCE_MAX_MS,
  MCHOSE_DOCK_PRODUCT_ID,
  MCHOSE_ANGLE_TUNING_MAX,
  MCHOSE_SHORT_REPORT_ID,
  MCHOSE_SHORT_TOKENS,
  mchoseDecodeBattery,
  mchoseDecodeConfig,
  mchoseDecodeIdentity,
  mchoseDecodeReply,
  mchoseDecodeVersion,
  mchoseEncodeCommand,
  mchoseEncodeConfigWrite,
  mchoseEncodeSetProfile,
  mchoseEncodeSleep,
  mchoseEncodePerformance,
  type MchoseProcessing,
  mchoseLiftOffLabels,
  mchoseDecodeButtons,
  mchoseDecodeButtonName,
  MCHOSE_BUTTON_TYPE,
  type MchoseButtonAssignment,
  mchoseDecodeProfileName,
  mchoseModeNumber,
  MCHOSE_MODES,
  MCHOSE_ANGLE_TUNING_MIN,
  mchoseEncodeButton,
  mchoseFindButtonAction,
  MCHOSE_BUTTONS,
  MCHOSE_BUTTON_ACTIONS,
  mchoseFindProduct,
  mchoseV3IsProductId,
  mchosePollingRates,
  type MchoseBattery,
  type MchoseConfig,
} from "@openmouse/protocol/mchose";
import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";

/**
 * MCHOSE A7 V2 family, over the vendor `0xff01` collection.
 *
 * The command set and its bit-inverted wire format were recovered from
 * MCHOSE's M HUB web driver and verified against an A7 V2 Ultra+ on its 2.4 GHz
 * receiver, including a polling-rate write that round-tripped and restored.
 * docs/mchose-protocol.md has the details, including which of the device's
 * other vendor collections are decoys.
 */

/** A reply can arrive before the firmware has filled it in, so reads are polled. */
const POLL_DELAY_MS = 90;
const POLL_ATTEMPTS = 20;
/** Settle time after a config write before the value reads back. */
const WRITE_SETTLE_MS = 400;
/** The mouse needs longer than a config write before it answers for a new profile. */
const PROFILE_SETTLE_MS = 600;
/** Sleep is applied more slowly still; 400 ms was not enough on hardware. */
const SLEEP_SETTLE_MS = 1500;
/**
 * The performance command is the slowest to apply; at 1200 ms a read still
 * returned the previous state, so it is given longer and retried.
 */
const PERFORMANCE_SETTLE_MS = 2000;
const PERFORMANCE_ATTEMPTS = 3;
/** A button write is a standalone command and applies quickly. */
const BUTTON_SETTLE_MS = 900;
/** Bytes of the 0x67 reply that carry fields; past this is stale scratch. */
const CONFIG_MEANINGFUL_BYTES = 20;
const BATTERY_MEANINGFUL_BYTES = 11;

const DPI_MIN = 50;
const DPI_STEP = 50;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export class MchoseHidClient {
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();
  private cachedProduct: ReturnType<typeof mchoseFindProduct> = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === MCHOSE_CONFIG_USAGE_PAGE
        && collection.usage === MCHOSE_CONFIG_USAGE)
      || collection.children.some(search);
    return device.vendorId === VENDOR_ID.mchose
      // The MagDock is the same vendor but a different protocol entirely, and
      // has its own driver; it must never be claimed as a mouse.
      && device.productId !== MCHOSE_DOCK_PRODUCT_ID
      // The A7 V3 generation puts a *different* protocol on this same usage
      // page, so the collection alone no longer identifies a V2. Subtracting
      // the known V3 ids rather than listing the V2's keeps this open to
      // unlisted V2-era models, which is how it found the test hardware.
      && !mchoseV3IsProductId(device.productId)
      && device.collections.some(search);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /** MCHOSE pushes unsolicited reports, but their layout is not decoded yet. */
  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    const name = this.device.productName?.trim();
    if (!name) return "MCHOSE";
    return /^mchose/i.test(name) ? name : `MCHOSE ${name}`;
  }

  isWireless(): boolean {
    return !this.isWired();
  }

  /**
   * Over a cable the host talks to the mouse itself, so the product id is a
   * model id; every other link enumerates as a shared receiver id. Which link
   * is live decides which half of the config byte pair applies.
   */
  private isWired(): boolean {
    return MCHOSE_PRODUCTS.some((entry) => entry.productId === this.device.productId);
  }

  /**
   * Send a command and poll for its answer.
   *
   * Two guards matter here, because every command shares one reply buffer: the
   * command echo must un-invert to what was sent, and the caller's `accept`
   * check must pass. Without both, a stale answer left by a previous command
   * reads as a valid one — which is exactly how a config read can hand back a
   * battery reply.
   */
  private request(
    reportId: number,
    command: number,
    tokenCount: number,
    accept: (payload: Uint8Array) => boolean,
    extraTokens: readonly number[] = [],
  ): Promise<Uint8Array | null> {
    const run = async (): Promise<Uint8Array | null> => {
      const body = mchoseEncodeCommand([command, ...extraTokens], tokenCount);
      let previous: Uint8Array | null = null;
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        await this.device.sendFeatureReport(reportId, body);
        await delay(POLL_DELAY_MS);
        let raw: DataView;
        try {
          raw = await this.device.receiveFeatureReport(reportId);
        } catch {
          continue;
        }
        const reply = mchoseDecodeReply(new Uint8Array(raw.buffer));
        if (!reply || reply.command !== command) continue;
        if (!accept(reply.payload)) continue;
        if (previous && reply.payload.every((byte, index) => byte === previous![index])) {
          return reply.payload;
        }
        previous = Uint8Array.from(reply.payload);
      }
      return null;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private nonZero(length: number) {
    return (payload: Uint8Array): boolean =>
      payload.subarray(0, length).some((byte) => byte !== 0);
  }

  /** A config payload always carries a plausible first DPI stage. */
  private static looksLikeConfig(payload: Uint8Array): boolean {
    if (payload.length < CONFIG_MEANINGFUL_BYTES) return false;
    const firstStage = (payload[4] ?? 0) | ((payload[5] ?? 0) << 8);
    return firstStage >= DPI_MIN && firstStage <= 42000;
  }

  private readConfigPayload(): Promise<Uint8Array | null> {
    return this.request(
      MCHOSE_LONG_REPORT_ID,
      MCHOSE_COMMAND.config,
      MCHOSE_LONG_TOKENS,
      MchoseHidClient.looksLikeConfig,
    );
  }

  /**
   * Read the config, apply `changes`, write it back and confirm it took. The
   * whole payload is echoed apart from the changed fields, so button mappings
   * and macros are preserved rather than zeroed by a partial write.
   */
  private async updateConfig(
    changes: Parameters<typeof mchoseEncodeConfigWrite>[1],
  ): Promise<MchoseConfig> {
    await this.open();
    const before = await this.readConfigPayload();
    if (!before) throw new Error("The mouse did not return its configuration.");

    const tokens = mchoseEncodeConfigWrite(before, changes);
    const body = mchoseEncodeCommand(tokens, MCHOSE_LONG_TOKENS);
    const send = async (): Promise<void> => {
      await this.device.sendFeatureReport(MCHOSE_LONG_REPORT_ID, body);
      await delay(WRITE_SETTLE_MS);
    };
    const queued = this.queue.then(send, send);
    this.queue = queued.catch(() => undefined);
    await queued;

    const after = await this.readConfigPayload();
    const decoded = after ? mchoseDecodeConfig(after) : null;
    if (!decoded) throw new Error("The mouse did not confirm the new configuration.");
    return decoded;
  }

  private linkRates(product: ReturnType<typeof mchoseFindProduct>): readonly number[] {
    return product ? mchosePollingRates(product, this.device.productId) : [];
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();

    // Identity and version answer from the receiver itself and are reliable;
    // battery and config travel over the RF link, so a partial read degrades
    // rather than breaking the connect flow.
    const identity = mchoseDecodeIdentity(
      (await this.request(MCHOSE_SHORT_REPORT_ID, MCHOSE_COMMAND.identity, MCHOSE_SHORT_TOKENS, this.nonZero(7))) ?? new Uint8Array(),
    );
    const version = mchoseDecodeVersion(
      (await this.request(MCHOSE_SHORT_REPORT_ID, MCHOSE_COMMAND.version, MCHOSE_SHORT_TOKENS, this.nonZero(2))) ?? new Uint8Array(),
    );

    let battery: MchoseBattery | null = null;
    const batteryPayload = await this.request(
      MCHOSE_SHORT_REPORT_ID, MCHOSE_COMMAND.battery, MCHOSE_SHORT_TOKENS,
      this.nonZero(BATTERY_MEANINGFUL_BYTES),
    );
    if (batteryPayload) battery = mchoseDecodeBattery(batteryPayload);

    const configPayload = await this.readConfigPayload();
    const config = configPayload ? mchoseDecodeConfig(configPayload) : null;

    const product = mchoseFindProduct(battery?.productId ?? null, this.device.productName);
    this.cachedProduct = product;
    const wired = this.isWired();
    const stageIndex = config ? (wired ? config.wiredDpiIndex : config.wirelessDpiIndex) : 0;
    const rateIndex = config ? (wired ? config.wiredRateIndex : config.wirelessRateIndex) : -1;
    const stages = config?.dpiStages ?? [];
    const rates = this.linkRates(product);
    const liftOffSteps = product?.liftOffDistances.length ?? 3;
    const buttons = configPayload ? mchoseDecodeButtons(configPayload) : null;
    if (buttons) await this.labelMacros(buttons);
    const profileNames = config ? await this.readProfileNames() : null;

    const firmware: string[] = [];
    if (version) firmware.push(`Receiver ${version}`);

    return {
      brand: "MCHOSE",
      name: product ? `MCHOSE ${product.name}` : this.displayName(),
      batteryPercent: battery?.batteryPercent ?? null,
      batteryState: battery?.charging ? "Charging" : battery ? "Discharging" : "Unknown",
      dpi: stages[stageIndex] ?? 0,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: stages.length ? stageIndex : undefined,
      pollingRateHz: rates[rateIndex] ?? 0,
      supportedPollingRates: rates.length ? [...rates] : undefined,
      // The wire index is 0-based; the shell shows profiles counting from one.
      activeProfile: config ? config.profileIndex + 1 : null,
      profileCount: config ? MCHOSE_PROFILE_COUNT : undefined,
      profileNames: profileNames ?? undefined,
      debounceMs: config?.keyDebounce ?? null,
      sleepTimeout: config ? config.sleep * 60 : null,
      connectionType: wired ? "Wired" : "Wireless",
      connectionDetail: identity && !identity.connected
        ? "Receiver connected, mouse not linked"
        : undefined,
      liftOffDistance: config ? (mchoseLiftOffLabels(liftOffSteps)[config.liftOffIndex] ?? null) : null,
      motionSync: config ? config.processing.motionSync : null,
      angleSnapping: config ? config.processing.angleSnapping : null,
      rippleControl: config ? config.processing.rippleControl : null,
      powerMode: config ? config.mode : undefined,
      powerModes: config ? [...MCHOSE_MODES] : undefined,
      angleTuning: config ? config.angleTuning : null,
      supportedLiftOffDistances: config ? mchoseLiftOffLabels(liftOffSteps) : undefined,
      buttonMappings: buttons
        ? Object.fromEntries(MCHOSE_BUTTONS.map((name, index) => [name, buttons[index]!.label]))
        : undefined,
      buttonOptions: buttons ? this.getButtonOptions() : undefined,
      firmware,
      ui: {
        family: "mchose",
        settingsReady: Boolean(config),
        valuesVerified: Boolean(config),
        defaultDisplayName: "MCHOSE",
        forceShowBattery: true,
        hideSignalCard: true,
        hideUnsupportedPollingRates: true,
        // Each link stores its own polling rate and DPI stage; only the one in
        // use is shown, so say which that is.
        pollingNote: wired
          ? "Applies to the wired connection."
          : "Applies to the 2.4 GHz connection; Bluetooth is capped at 1000 Hz.",
        dpiStageEditor: {
          maxStages: MCHOSE_DPI_STAGES,
          countEditable: true,
          minDpi: DPI_MIN,
          maxDpi: product?.dpiMax ?? 26000,
          stepDpi: DPI_STEP,
        },
      },
    };
  }

  /** Called for every connected client; the stage editor drives DPI here. */
  getDpiOptions(): number[] {
    return [];
  }

  // ── setters ──────────────────────────────────────────────────────────────

  async setPollingRate(hertz: number): Promise<void> {
    const rates = this.linkRates(this.cachedProduct);
    const index = rates.indexOf(hertz);
    if (index < 0) throw new Error(`This mouse does not support ${hertz} Hz on this connection.`);
    const key = this.isWired() ? "wiredRateIndex" : "wirelessRateIndex";
    const after = await this.updateConfig({ [key]: index });
    const applied = this.isWired() ? after.wiredRateIndex : after.wirelessRateIndex;
    if (applied !== index) throw new Error("The mouse did not accept the new polling rate.");
  }

  async setActiveDpiStage(stage: number): Promise<void> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= MCHOSE_DPI_STAGES) {
      throw new Error(`DPI stage must be 0-${MCHOSE_DPI_STAGES - 1}.`);
    }
    const key = this.isWired() ? "wiredDpiIndex" : "wirelessDpiIndex";
    const after = await this.updateConfig({ [key]: stage });
    const applied = this.isWired() ? after.wiredDpiIndex : after.wirelessDpiIndex;
    if (applied !== stage) throw new Error("The mouse did not accept the new DPI stage.");
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<void> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= MCHOSE_DPI_STAGES) {
      throw new Error(`DPI stage must be 0-${MCHOSE_DPI_STAGES - 1}.`);
    }
    const max = this.cachedProduct?.dpiMax ?? 26000;
    if (dpi < DPI_MIN || dpi > max) throw new Error(`DPI must be between ${DPI_MIN} and ${max}.`);
    const rounded = Math.round(dpi / DPI_STEP) * DPI_STEP;

    const before = await this.readConfigPayload();
    const current = before ? mchoseDecodeConfig(before) : null;
    if (!current) throw new Error("The mouse did not return its configuration.");
    const stages = [...current.dpiStages];
    stages[stage] = rounded;

    const after = await this.updateConfig({ dpiStages: stages });
    if (after.dpiStages[stage] !== rounded) {
      throw new Error("The mouse did not accept the new DPI value.");
    }
  }

  /**
   * Switch the active onboard profile. `profile` is 1-based to match what the
   * shell displays; the firmware is 0-based.
   *
   * Each profile carries its own DPI stages and per-link rate, so everything
   * the panel shows changes with it — the caller is expected to re-read status
   * afterwards. The device also needs a moment before it will answer for the
   * newly selected profile, hence the settle below.
   */
  async setProfile(profile: number): Promise<void> {
    if (!Number.isInteger(profile) || profile < 1 || profile > MCHOSE_PROFILE_COUNT) {
      throw new Error(`Profile must be 1-${MCHOSE_PROFILE_COUNT}.`);
    }
    await this.open();
    const body = mchoseEncodeCommand(mchoseEncodeSetProfile(profile - 1), MCHOSE_SHORT_TOKENS);
    const send = async (): Promise<void> => {
      await this.device.sendFeatureReport(MCHOSE_SHORT_REPORT_ID, body);
      await delay(PROFILE_SETTLE_MS);
    };
    const queued = this.queue.then(send, send);
    this.queue = queued.catch(() => undefined);
    await queued;

    const after = await this.readConfigPayload();
    const decoded = after ? mchoseDecodeConfig(after) : null;
    if (!decoded) throw new Error("The mouse did not confirm the profile change.");
    if (decoded.profileIndex !== profile - 1) {
      throw new Error("The mouse did not switch to that profile.");
    }
  }

/**
   * Lift-off and the processing toggles share one command and one status byte,
   * so both go through here rather than `updateConfig`. They still read back
   * out of the config blob, which is what confirms the change.
   */
  private async writePerformance(
    liftOffIndex: number,
    changes: Partial<MchoseProcessing> & { mode?: number; angleTuning?: number },
    applied: (config: MchoseConfig) => boolean,
  ): Promise<MchoseConfig> {
    await this.open();
    const body = mchoseEncodeCommand(
      mchoseEncodePerformance(liftOffIndex, changes),
      MCHOSE_SHORT_TOKENS,
    );

    // This command is the slowest of the lot, and a read taken too soon comes
    // back with the *previous* state rather than failing — which reads as the
    // change being rejected. Re-send and re-read until the value actually
    // reflects what was asked for.
    let last: MchoseConfig | null = null;
    for (let attempt = 0; attempt < PERFORMANCE_ATTEMPTS; attempt += 1) {
      const send = async (): Promise<void> => {
        await this.device.sendFeatureReport(MCHOSE_SHORT_REPORT_ID, body);
        await delay(PERFORMANCE_SETTLE_MS);
      };
      const queued = this.queue.then(send, send);
      this.queue = queued.catch(() => undefined);
      await queued;

      const after = await this.readConfigPayload();
      const decoded = after ? mchoseDecodeConfig(after) : null;
      if (decoded) {
        last = decoded;
        if (applied(decoded)) return decoded;
      }
    }
    if (!last) throw new Error("The mouse did not confirm the change.");
    return last;
  }

  /** The current lift-off step, needed because the command always carries it. */
  private async currentLiftOffIndex(): Promise<number> {
    const payload = await this.readConfigPayload();
    const config = payload ? mchoseDecodeConfig(payload) : null;
    if (!config) throw new Error("The mouse did not return its configuration.");
    return config.liftOffIndex;
  }

  async setLiftOffDistance(label: NonNullable<MouseStatus["liftOffDistance"]>): Promise<void> {
    const steps = this.cachedProduct?.liftOffDistances.length ?? 3;
    const index = mchoseLiftOffLabels(steps).indexOf(label);
    if (index < 0) throw new Error(`This mouse does not offer a ${label} lift-off distance.`);
    const after = await this.writePerformance(index, {}, (c) => c.liftOffIndex === index);
    if (after.liftOffIndex !== index) {
      throw new Error("The mouse did not accept that lift-off distance.");
    }
  }

  async setMotionSync(enabled: boolean): Promise<void> {
    const after = await this.writePerformance(await this.currentLiftOffIndex(), { motionSync: enabled }, (c) => c.processing.motionSync === enabled);
    if (after.processing.motionSync !== enabled) {
      throw new Error("The mouse did not accept the motion sync change.");
    }
  }

  async setAngleSnapping(enabled: boolean): Promise<void> {
    const after = await this.writePerformance(await this.currentLiftOffIndex(), { angleSnapping: enabled }, (c) => c.processing.angleSnapping === enabled);
    if (after.processing.angleSnapping !== enabled) {
      throw new Error("The mouse did not accept the angle snapping change.");
    }
  }

  async setRippleControl(enabled: boolean): Promise<void> {
    const after = await this.writePerformance(await this.currentLiftOffIndex(), { rippleControl: enabled }, (c) => c.processing.rippleControl === enabled);
    if (after.processing.rippleControl !== enabled) {
      throw new Error("The mouse did not accept the ripple control change.");
    }
  }

  /** The named power/performance modes this mouse offers. */
  getPowerModes(): string[] {
    return [...MCHOSE_MODES];
  }

  /**
   * MCHOSE's mode selector — Performance, eSports or Ultra. It is a three-way
   * choice, not a switch: the two bits live at the top of the same `sensor`
   * byte as lift-off and the processing toggles.
   */
  async setPowerMode(name: string): Promise<void> {
    const mode = mchoseModeNumber(name);
    if (mode === null) throw new Error(`This mouse has no "${name}" mode.`);
    const after = await this.writePerformance(
      await this.currentLiftOffIndex(),
      { mode },
      (config) => config.mode === name,
    );
    if (after.mode !== name) throw new Error("The mouse did not accept the mode change.");
  }

  /** Angle tuning in degrees; 0 turns the correction off. */
  async setAngleTuning(degrees: number): Promise<void> {
    const value = Math.round(degrees);
    if (!Number.isInteger(value) || value < MCHOSE_ANGLE_TUNING_MIN || value > MCHOSE_ANGLE_TUNING_MAX) {
      throw new Error(`Angle tuning must be ${MCHOSE_ANGLE_TUNING_MIN} to ${MCHOSE_ANGLE_TUNING_MAX} degrees.`);
    }
    const after = await this.writePerformance(await this.currentLiftOffIndex(), { angleTuning: value }, (c) => c.angleTuning === value);
    if (after.angleTuning !== value) {
      throw new Error("The mouse did not accept the angle tuning change.");
    }
  }

  /**
   * How many of the six DPI stages the mouse cycles through. Stored in the
   * config blob, so it goes through the ordinary read-modify-write.
   */
  async setDpiStageCount(count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > MCHOSE_DPI_STAGES) {
      throw new Error(`DPI stage count must be 1-${MCHOSE_DPI_STAGES}.`);
    }
    const after = await this.updateConfig({ stageCount: count });
    if (after.stageCount !== count) {
      throw new Error("The mouse did not accept the new DPI stage count.");
    }
  }

  /**
   * The three profile names the mouse stores. Read one at a time; a profile
   * whose name will not come back is left out rather than guessed at, and the
   * caller falls back to numbering.
   */
  private async readProfileNames(): Promise<string[] | null> {
    const names: string[] = [];
    for (let index = 0; index < MCHOSE_PROFILE_COUNT; index += 1) {
      const payload = await this.request(
        MCHOSE_LONG_REPORT_ID,
        MCHOSE_COMMAND.readProfileName,
        MCHOSE_LONG_TOKENS,
        (reply) => reply[0] === index && (reply[1] ?? 0) !== 0,
        [index],
      );
      const name = payload ? mchoseDecodeProfileName(payload) : null;
      if (!name) return null;
      names.push(name);
    }
    return names;
  }

  /**
   * Name whichever buttons carry a macro. A macro's name is the only thing
   * about it this driver can surface — recording one is not implemented — so
   * labelling it beats showing a bare "Macro". Buttons without one answer with
   * a zero-length name and are left alone.
   */
  private async labelMacros(buttons: MchoseButtonAssignment[]): Promise<void> {
    for (const button of buttons) {
      if (button.type !== MCHOSE_BUTTON_TYPE.macro) continue;
      const payload = await this.request(
        MCHOSE_LONG_REPORT_ID,
        MCHOSE_COMMAND.readButtonName,
        MCHOSE_LONG_TOKENS,
        (reply) => reply[0] === button.buttonIndex,
        [button.buttonIndex],
      );
      const name = payload ? mchoseDecodeButtonName(payload, button.buttonIndex) : null;
      if (name) button.label = `Macro: ${name}`;
    }
  }

  /** Every action a button can be assigned, for the picker. */
  getButtonOptions(): string[] {
    return MCHOSE_BUTTON_ACTIONS.map((entry) => entry.label);
  }

  /**
   * Reassign one button. This is a standalone command rather than part of the
   * config blob, so it cannot disturb DPI, polling or the other buttons —
   * confirmed on hardware, where only the target button's four bytes moved.
   *
   * "Default" restores the factory function, which is the firmware's own escape
   * hatch (type 0 with a zero value).
   */
  async setButtonMapping(button: string, actionLabel: string): Promise<void> {
    const buttonIndex = MCHOSE_BUTTONS.indexOf(button);
    if (buttonIndex < 0) throw new Error(`This mouse has no "${button}" button.`);
    const action = mchoseFindButtonAction(actionLabel);
    if (!action) throw new Error(`Unknown button action "${actionLabel}".`);

    await this.open();
    const tokens = mchoseEncodeButton(buttonIndex, action.type, action.value);
    const body = mchoseEncodeCommand(tokens, MCHOSE_LONG_TOKENS);
    const send = async (): Promise<void> => {
      await this.device.sendFeatureReport(MCHOSE_LONG_REPORT_ID, body);
      await delay(BUTTON_SETTLE_MS);
    };
    const queued = this.queue.then(send, send);
    this.queue = queued.catch(() => undefined);
    await queued;

    const after = await this.readConfigPayload();
    const assignments = after ? mchoseDecodeButtons(after) : null;
    const applied = assignments?.[buttonIndex];
    if (!applied) throw new Error("The mouse did not confirm the button change.");
    if (applied.type !== action.type || applied.value !== action.value) {
      throw new Error("The mouse did not accept that button assignment.");
    }
  }

  /** Sleep timeouts this driver offers, in seconds. 0 disables the timer. */
  getSleepOptions(): number[] {
    return [...MCHOSE_SLEEP_OPTIONS];
  }

  getDebounceMaxMs(): number {
    return MCHOSE_DEBOUNCE_MAX_MS;
  }

  /** The firmware stores whole minutes; the panel works in seconds. */
  async setSleepTimeout(seconds: number): Promise<void> {
    const minutes = Math.round(Math.max(0, seconds) / 60);
    await this.open();
    const body = mchoseEncodeCommand(mchoseEncodeSleep(minutes), MCHOSE_SHORT_TOKENS);
    const send = async (): Promise<void> => {
      await this.device.sendFeatureReport(MCHOSE_SHORT_REPORT_ID, body);
      await delay(SLEEP_SETTLE_MS);
    };
    const queued = this.queue.then(send, send);
    this.queue = queued.catch(() => undefined);
    await queued;

    const after = await this.readConfigPayload();
    const decoded = after ? mchoseDecodeConfig(after) : null;
    if (!decoded) throw new Error("The mouse did not confirm the sleep timeout.");
    if (decoded.sleep !== minutes) throw new Error("The mouse did not accept that sleep timeout.");
  }

  /** Debounce rides along in the config blob rather than its own command. */
  async setDebounceTime(milliseconds: number): Promise<void> {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > MCHOSE_DEBOUNCE_MAX_MS) {
      throw new Error(`Debounce must be 0-${MCHOSE_DEBOUNCE_MAX_MS} ms.`);
    }
    const after = await this.updateConfig({ keyDebounce: milliseconds });
    if (after.keyDebounce !== milliseconds) {
      throw new Error("The mouse did not accept the new debounce time.");
    }
  }

  /** Sets the DPI of whichever stage the live connection is using. */
  async setDpi(dpi: number): Promise<void> {
    const payload = await this.readConfigPayload();
    const current = payload ? mchoseDecodeConfig(payload) : null;
    if (!current) throw new Error("The mouse did not return its configuration.");
    await this.setDpiStageValue(
      this.isWired() ? current.wiredDpiIndex : current.wirelessDpiIndex,
      dpi,
    );
  }
}
