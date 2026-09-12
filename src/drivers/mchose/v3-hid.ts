import {
  MCHOSE_V3_BUTTONS,
  MCHOSE_V3_COMMAND,
  MCHOSE_V3_DEBOUNCE_MAX_MS,
  MCHOSE_V3_DPI_MIN,
  MCHOSE_V3_DPI_STAGES,
  MCHOSE_V3_DPI_STEP,
  MCHOSE_V3_SLEEP_OPTIONS,
  MCHOSE_V3_MODES,
  MCHOSE_V3_LINK_PRODUCT_IDS,
  MCHOSE_V3_REPORT_ID,
  MCHOSE_V3_USAGE,
  MCHOSE_V3_USAGE_PAGE,
  mchoseV3DecodeButtons,
  mchoseV3DecodeDeviceInfo,
  mchoseV3DecodeDpi,
  mchoseV3DecodeLiftOff,
  mchoseV3DecodeSensor,
  mchoseV3DecodeSettings,
  mchoseV3ButtonAction,
  mchoseV3ButtonActionLabels,
  mchoseV3ButtonActionName,
  mchoseV3CheckSettings,
  mchoseV3Encode,
  mchoseV3EncodeButtons,
  mchoseV3EncodeDpiTable,
  mchoseV3EncodeLiftOff,
  mchoseV3EncodeSensor,
  mchoseV3EncodeSettings,
  mchoseV3FindProduct,
  mchoseV3IsBusy,
  mchoseV3IsProductId,
  mchoseV3IsRejection,
  mchoseV3LiftOffLabels,
  mchoseV3LiftOffStop,
  mchoseV3Payload,
  mchoseV3PollingRates,
  mchoseV3RoundDpi,
  type MchoseV3DeviceInfo,
  type MchoseV3Dpi,
  type MchoseV3Product,
  type MchoseV3Settings,
} from "@openmouse/protocol/mchose";
import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";

/**
 * MCHOSE A7 V3 and its siblings.
 *
 * This generation abandoned the A7 V2's inverted feature reports for a
 * `0x4d`-magic output report (see `src/mchose/v3.ts`). The command set was read
 * out of MCHOSE's own M HUB bundle, and the **reads** have since been confirmed
 * against a real A7 V3 Ultra+ on its 2.4 GHz receiver: identity, battery and
 * charge state, the DPI table, polling, profile, sleep, debounce, the sensor
 * flags and the button table all came back correctly. See the capture notes in
 * docs/mchose-protocol.md.
 *
 * **The writes have not been exercised on hardware.** They are built to the
 * same shape M HUB uses, and the framing under them is proven by the reads, but
 * no byte here has been watched going into a real V3. Three things follow:
 *
 * - every write is a read-modify-write of a **whole block**, because this
 *   protocol has no partial update. A setter reads, edits the decoded object,
 *   writes and reads back; a failed read aborts rather than writing defaults
 *   over a working configuration, and bytes this codec does not understand are
 *   carried through rather than zeroed;
 * - every setter verifies, and throws when the mouse reports something other
 *   than what it was told;
 * - the button vocabulary is M HUB's own, lifted from the vendor bundle's
 *   action tables rather than guessed at. See `src/mchose/v3-buttons.ts`; the
 *   type numbers are **not** the A7 V2's.
 *
 * {@link WRITE_SETTLE_MS} is the number most likely to be wrong: it is the A7
 * V2's figure, and this generation's has never been measured.
 */

/**
 * How long to wait for a reply.
 *
 * Measured, not guessed. On a cable, `0x0900`, `0x0002`, `0x0003` and `0x0001`
 * all answer in 1–3 ms. Everything else answers in **almost exactly 1.001 s**:
 * `0x0901` does it on the cable, and `0x0900` does it over the receiver when
 * the mouse is not currently reachable. That looks like a fixed deferral inside
 * the firmware rather than a variable delay, so the budget only has to clear
 * it — an earlier 600 ms timeout sat just underneath, which meant those replies
 * were *always* missed and then mistaken for the next attempt's answer.
 */
const REPLY_TIMEOUT_MS = 1500;
const READ_ATTEMPTS = 3;

/**
 * How many "ask again" replies to accept before giving up on a command. Each
 * one costs a full second, and a receiver with no mouse behind it will keep
 * sending them, so this stays low: the point is to ride out a mouse waking up,
 * not to wait for one that is switched off.
 */
const BUSY_ATTEMPTS = 2;

/** M HUB pauses this long before re-asking a busy device. */
const BUSY_RETRY_MS = 30;

/** What came back for one attempt. */
type Reply =
  | { kind: "payload"; payload: Uint8Array }
  /** A one-byte 0xff: the device is there but cannot answer yet. */
  | { kind: "busy" }
  /** The firmware refused the command outright. Retrying changes nothing. */
  | { kind: "rejected" }
  | { kind: "timeout" };

/** `0x0901`'s target byte: the mouse rather than the receiver in front of it. */
const VERSION_TARGET_MOUSE = 0;

/** The X axis of the DPI table; Y is a separate table on the models that have one. */
const DPI_AXIS_X = 0;

/**
 * How long to let a write commit before reading it back.
 *
 * Untimed on this generation. The A7 V2 needed 400 ms for its ordinary config
 * write and up to two seconds for its slowest, so this starts at the V2's
 * figure; if a V3 write reads back stale, this is the first number to raise.
 */
const WRITE_SETTLE_MS = 400;
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The receivers serve every model in the generation. */
const LINK_PRODUCT_IDS: readonly number[] = Object.values(MCHOSE_V3_LINK_PRODUCT_IDS);

export class MchoseV3HidClient {
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Set once a command has exhausted its retries, and cleared at the top of
   * every status read. A status is six commands, so without this a mouse that
   * is off or out of range costs six full retry budgets — long enough to look
   * like the app has hung. One silent command is enough to conclude nothing is
   * listening; the next poll gets a clean try.
   */
  private unresponsive = false;

  /** Resolved once per session; every range check needs the model's limits. */
  private cachedProduct: MchoseV3Product | null = null;

  /**
   * Set when the device answered "ask again" rather than with data. It means
   * the receiver is plugged in but the mouse behind it is not reachable, which
   * is a different thing to tell the user than "nothing answered".
   */
  private linkBusy = false;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === MCHOSE_V3_USAGE_PAGE && collection.usage === MCHOSE_V3_USAGE)
      || collection.children.some(search);
    return device.vendorId === VENDOR_ID.mchose
      // An allowlist, not a usage-page match: this collection is shared with
      // the V2 protocol, so only ids known to be V3 may be claimed here.
      && mchoseV3IsProductId(device.productId)
      && device.collections.some(search);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /** Nothing here subscribes to unsolicited state. */
  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    return this.device.productName?.trim() || "MCHOSE";
  }

  /** Wired when the host is talking to the mouse rather than to a receiver. */
  private isWired(): boolean {
    return !LINK_PRODUCT_IDS.includes(this.device.productId);
  }

  /**
   * Send one command and wait for the reply carrying the same id.
   *
   * Replies arrive as input reports rather than as the answer to a read, so
   * the listener goes on before the write and the id match is what pairs them
   * up — the mouse also pushes movement and battery reports down this pipe.
   */
  private request(command: number, data: readonly number[] = []): Promise<Uint8Array | null> {
    const run = async (): Promise<Uint8Array | null> => {
      if (this.unresponsive) return null;
      const body = mchoseV3Encode(command, data);
      let busy = 0;
      let heardAnything = false;

      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
        const reply = await this.attempt(command, body);
        if (reply.kind === "payload") return reply.payload;
        if (reply.kind !== "timeout") heardAnything = true;

        // A refusal is final: the firmware answered, and it said no.
        if (reply.kind === "rejected") return null;
        if (reply.kind === "busy") {
          busy += 1;
          this.linkBusy = true;
          if (busy >= BUSY_ATTEMPTS) return null;
          await delay(BUSY_RETRY_MS);
          // A busy reply does not count against the timeout budget; the device
          // is plainly listening, it just has nothing to say yet.
          attempt -= 1;
        }
      }

      // Only conclude nothing is listening when nothing ever arrived. A device
      // that answered "busy" or "no" is awake, and shutting the rest of the
      // status read down would throw away commands it would have answered.
      if (!heardAnything) this.unresponsive = true;
      return null;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** One send-and-wait, classifying whatever comes back. */
  private attempt(command: number, body: Uint8Array<ArrayBuffer>): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      const finish = (reply: Reply): void => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", listener);
        resolve(reply);
      };
      const listener = (event: Event): void => {
        const frame = new Uint8Array((event as HIDInputReportEvent).data.buffer);
        const payload = mchoseV3Payload(frame, command);
        if (payload) {
          finish(mchoseV3IsBusy(payload) ? { kind: "busy" } : { kind: "payload", payload });
          return;
        }
        // A refusal carries command 0x0000, so it never matches the id above.
        if (mchoseV3IsRejection(frame)) finish({ kind: "rejected" });
      };
      const timer = setTimeout(() => { finish({ kind: "timeout" }); }, REPLY_TIMEOUT_MS);
      this.device.addEventListener("inputreport", listener);
      this.device.sendReport(MCHOSE_V3_REPORT_ID, body)
        .catch(() => { finish({ kind: "timeout" }); });
    });
  }

  private async readDeviceInfo(): Promise<MchoseV3DeviceInfo | null> {
    const payload = await this.request(MCHOSE_V3_COMMAND.readDeviceInfo);
    return payload ? mchoseV3DecodeDeviceInfo(payload) : null;
  }

  private async readSettings(): Promise<MchoseV3Settings | null> {
    const payload = await this.request(MCHOSE_V3_COMMAND.readSettings);
    return payload ? mchoseV3DecodeSettings(payload) : null;
  }

  /**
   * `0x0901` takes a target byte: 0 for the mouse, 1 for the receiver. Sent
   * without one it answers with an **empty** data block rather than an error,
   * which is how the first hardware capture came back with no firmware at all.
   */
  private async readVersion(): Promise<string | null> {
    const payload = await this.request(MCHOSE_V3_COMMAND.readVersion, [VERSION_TARGET_MOUSE]);
    if (!payload || payload.length < 2) return null;
    const raw = `${(payload[0] ?? 0).toString(16).padStart(2, "0")}`
      + `${(payload[1] ?? 0).toString(16).padStart(2, "0")}`;
    const trimmed = raw.replace(/^0+/, "");
    return trimmed ? trimmed : null;
  }

  /**
   * Lift-off sits in two places depending on the model: the five-step ladders
   * do not fit the sensor byte's two bits, so those models answer `0x0009`
   * instead.
   */
  private async readLiftOffIndex(
    product: MchoseV3Product | null,
    settings: MchoseV3Settings,
  ): Promise<number | null> {
    if (!product?.liftOffCommand) return mchoseV3DecodeSensor(settings.sensor).liftOffIndex;
    const payload = await this.request(
      MCHOSE_V3_COMMAND.readLiftOff, [settings.profileIndex],
    );
    return payload ? mchoseV3DecodeLiftOff(payload) : null;
  }

  getDpiOptions(): number[] {
    return [];
  }

  /** Sleep timeouts this driver offers, in seconds. 0 disables the timer. */
  getSleepOptions(): number[] {
    return [...MCHOSE_V3_SLEEP_OPTIONS];
  }

  getDebounceMaxMs(): number {
    return MCHOSE_V3_DEBOUNCE_MAX_MS;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────
  //
  // This protocol has no partial update: every command below replaces a whole
  // block. So each setter reads the block, edits the decoded object, sends it
  // back and reads again to confirm — never building a block from defaults,
  // because the bytes this codec does not understand would be invented rather
  // than preserved. A read that fails aborts the write rather than writing a
  // guess over a working configuration.

  /** Send a write and give the firmware time to commit before reading back. */
  private async write(command: number, data: readonly number[]): Promise<void> {
    const body = mchoseV3Encode(command, data);
    const send = async (): Promise<void> => {
      await this.device.sendReport(MCHOSE_V3_REPORT_ID, body);
      await delay(WRITE_SETTLE_MS);
    };
    const queued = this.queue.then(send, send);
    this.queue = queued.catch(() => undefined);
    await queued;
  }

  /** The model, needed for every range check. Resolved the same way as status. */
  private async resolveProduct(): Promise<MchoseV3Product> {
    if (this.cachedProduct) return this.cachedProduct;
    const info = await this.readDeviceInfo();
    const product = mchoseV3FindProduct(info?.productId ?? null, this.device.productName);
    if (!product) throw new Error("This MCHOSE model is not recognised, so its limits are unknown.");
    this.cachedProduct = product;
    return product;
  }

  /**
   * Read the settings block, apply `edit` to it, write it back and return what
   * the mouse reports afterwards.
   */
  private async updateSettings(
    edit: (settings: MchoseV3Settings) => void,
  ): Promise<MchoseV3Settings> {
    await this.open();
    this.unresponsive = false;
    const before = await this.readSettings();
    if (!before) throw new Error("The mouse did not return its settings.");

    const next: MchoseV3Settings = { ...before, extra: [...before.extra] };
    edit(next);
    mchoseV3CheckSettings(next);

    await this.write(MCHOSE_V3_COMMAND.writeSettings, mchoseV3EncodeSettings(next));

    const after = await this.readSettings();
    if (!after) throw new Error("The mouse did not confirm the new settings.");
    return after;
  }

  async setPollingRate(hertz: number): Promise<void> {
    const product = await this.resolveProduct();
    const rates = mchoseV3PollingRates(product);
    const index = rates.indexOf(hertz);
    if (index < 0) throw new Error(`This mouse does not support ${hertz} Hz.`);
    const wired = this.isWired();
    // Each link stores its own rate; only the one in use is touched.
    const after = await this.updateSettings((settings) => {
      if (wired) settings.wiredRateIndex = index;
      else settings.wirelessRateIndex = index;
    });
    const applied = wired ? after.wiredRateIndex : after.wirelessRateIndex;
    if (applied !== index) throw new Error("The mouse did not accept the new polling rate.");
  }

  async setSleepTimeout(seconds: number): Promise<void> {
    const minutes = Math.round(seconds / 60);
    const after = await this.updateSettings((settings) => {
      settings.sleep = minutes;
      // Zero minutes is "never", and the firmware wants the mode byte to agree.
      settings.sleepMode = minutes === 0 ? 1 : 0;
    });
    if (after.sleep !== minutes) throw new Error("The mouse did not accept the new sleep timer.");
  }

  /**
   * Both primary buttons move together. The firmware keeps them separately and
   * the shell offers one control, so writing only the left would leave the
   * right on a value the user cannot see or change.
   */
  async setDebounceTime(ms: number): Promise<void> {
    const after = await this.updateSettings((settings) => {
      settings.leftDebounceMs = ms;
      settings.rightDebounceMs = ms;
    });
    if (after.leftDebounceMs !== ms) throw new Error("The mouse did not accept the new debounce time.");
  }

  async setAngleTuning(degrees: number): Promise<void> {
    const after = await this.updateSettings((settings) => { settings.angleTuning = degrees; });
    if (after.angleTuning !== degrees) throw new Error("The mouse did not accept the new angle.");
  }

  async setProfile(oneBased: number): Promise<void> {
    const index = oneBased - 1;
    const after = await this.updateSettings((settings) => { settings.profileIndex = index; });
    if (after.profileIndex !== index) throw new Error("The mouse did not switch profile.");
  }

  async setPowerMode(name: string): Promise<void> {
    const modeIndex = MCHOSE_V3_MODES.indexOf(name as (typeof MCHOSE_V3_MODES)[number]);
    if (modeIndex < 0) throw new Error(`Unknown power mode "${name}".`);
    const after = await this.setSensor({ modeIndex });
    if (mchoseV3DecodeSensor(after.sensor).modeIndex !== modeIndex) {
      throw new Error("The mouse did not accept the new power mode.");
    }
  }

  private setSensor(
    changes: Parameters<typeof mchoseV3EncodeSensor>[1],
  ): Promise<MchoseV3Settings> {
    return this.updateSettings((settings) => {
      settings.sensor = mchoseV3EncodeSensor(settings.sensor, changes);
    });
  }

  private async setProcessing(
    key: "motionSync" | "angleSnapping" | "rippleControl" | "glassMode",
    enabled: boolean,
  ): Promise<void> {
    const after = await this.setSensor({ [key]: enabled });
    if (mchoseV3DecodeSensor(after.sensor)[key] !== enabled) {
      throw new Error("The mouse did not accept the new sensor setting.");
    }
  }

  setMotionSync(enabled: boolean): Promise<void> { return this.setProcessing("motionSync", enabled); }
  setAngleSnapping(enabled: boolean): Promise<void> { return this.setProcessing("angleSnapping", enabled); }
  setRippleControl(enabled: boolean): Promise<void> { return this.setProcessing("rippleControl", enabled); }
  setGlassMode(enabled: boolean): Promise<void> { return this.setProcessing("glassMode", enabled); }

  /**
   * Lift-off lives in two places depending on the model, and the write has to
   * follow the read: the five-step ladders do not fit the sensor byte's two
   * bits and answer `0x0109` instead.
   */
  async setLiftOffDistance(label: string): Promise<void> {
    const product = await this.resolveProduct();
    const index = mchoseV3LiftOffLabels(product).indexOf(label);
    if (index < 0) throw new Error(`This mouse has no ${label} lift-off step.`);

    if (!product.liftOffCommand) {
      const after = await this.setSensor({ liftOffIndex: index });
      if (mchoseV3DecodeSensor(after.sensor).liftOffIndex !== index) {
        throw new Error("The mouse did not accept the new lift-off distance.");
      }
      return;
    }

    await this.open();
    this.unresponsive = false;
    const settings = await this.readSettings();
    if (!settings) throw new Error("The mouse did not return its settings.");
    await this.write(
      MCHOSE_V3_COMMAND.writeLiftOff,
      mchoseV3EncodeLiftOff(settings.profileIndex, index, product),
    );
    const applied = await this.readLiftOffIndex(product, settings);
    if (applied !== index) throw new Error("The mouse did not accept the new lift-off distance.");
  }

  /** Read the DPI table for the profile in use, so a write can edit it. */
  private async readDpiTable(): Promise<{ dpi: MchoseV3Dpi; profileIndex: number }> {
    await this.open();
    this.unresponsive = false;
    const settings = await this.readSettings();
    if (!settings) throw new Error("The mouse did not return its settings.");
    const payload = await this.request(
      MCHOSE_V3_COMMAND.readDpi, [settings.profileIndex, DPI_AXIS_X],
    );
    const dpi = payload ? mchoseV3DecodeDpi(payload) : null;
    if (!dpi) throw new Error("The mouse did not return its DPI table.");
    return { dpi, profileIndex: settings.profileIndex };
  }

  private async updateDpiTable(edit: (dpi: MchoseV3Dpi) => void): Promise<MchoseV3Dpi> {
    const product = await this.resolveProduct();
    const { dpi } = await this.readDpiTable();
    const next: MchoseV3Dpi = { ...dpi, stages: [...dpi.stages] };
    edit(next);
    await this.write(MCHOSE_V3_COMMAND.writeDpi, mchoseV3EncodeDpiTable(next, product));
    const after = (await this.readDpiTable()).dpi;
    return after;
  }

  /** Change the stage currently in use, which is what the DPI box edits. */
  async setDpi(dpi: number): Promise<void> {
    const product = await this.resolveProduct();
    const value = mchoseV3RoundDpi(dpi, product);
    const after = await this.updateDpiTable((table) => { table.stages[table.activeStage] = value; });
    if (after.stages[after.activeStage] !== value) {
      throw new Error("The mouse did not accept the new DPI.");
    }
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<void> {
    const product = await this.resolveProduct();
    const value = mchoseV3RoundDpi(dpi, product);
    const after = await this.updateDpiTable((table) => { table.stages[stage] = value; });
    if (after.stages[stage] !== value) throw new Error("The mouse did not accept the new DPI stage.");
  }

  async setActiveDpiStage(stage: number): Promise<void> {
    const after = await this.updateDpiTable((table) => { table.activeStage = stage; });
    if (after.activeStage !== stage) throw new Error("The mouse did not switch DPI stage.");
  }

  async setDpiStageCount(count: number): Promise<void> {
    const after = await this.updateDpiTable((table) => {
      table.stageCount = count;
      // The active stage cannot point past the end of the shortened list.
      if (table.activeStage >= count) table.activeStage = count - 1;
    });
    if (after.stageCount !== count) throw new Error("The mouse did not accept the new stage count.");
  }

  /**
   * Reassign one button, leaving the other five exactly as they were read.
   *
   * The vocabulary comes from M HUB's own action tables — see
   * `src/mchose/v3-buttons.ts` — so nothing here is a guess at what a value
   * means. What has not been verified is the firmware accepting the write,
   * which is why the read-back below decides whether it worked.
   */
  async setButtonMapping(button: string, action: string): Promise<void> {
    await this.open();
    this.unresponsive = false;
    const settings = await this.readSettings();
    if (!settings) throw new Error("The mouse did not return its settings.");
    const payload = await this.request(
      MCHOSE_V3_COMMAND.readButtons, [settings.profileIndex, 0, MCHOSE_V3_BUTTONS.length],
    );
    const buttons = payload ? mchoseV3DecodeButtons(payload) : null;
    if (!buttons) throw new Error("The mouse did not return its button table.");
    if (!buttons[button]) throw new Error(`This mouse has no "${button}" button.`);

    const assignment = mchoseV3ButtonAction(button, action);
    if (!assignment) throw new Error(`Unknown button action "${action}".`);

    const next = { ...buttons, [button]: assignment };
    await this.write(
      MCHOSE_V3_COMMAND.writeButtons,
      mchoseV3EncodeButtons(settings.profileIndex, next),
    );

    const confirmPayload = await this.request(
      MCHOSE_V3_COMMAND.readButtons, [settings.profileIndex, 0, MCHOSE_V3_BUTTONS.length],
    );
    const confirmed = confirmPayload ? mchoseV3DecodeButtons(confirmPayload) : null;
    if (!confirmed || confirmed[button]?.type !== assignment.type) {
      throw new Error("The mouse did not accept the new button assignment.");
    }
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    this.unresponsive = false;
    this.linkBusy = false;

    // Identity first: the host-facing product id is shared across the whole
    // generation, so this is the only thing that says which model is on the
    // other end, and the DPI ceiling and lift-off ladder both hang off it.
    const info = await this.readDeviceInfo();
    const product = mchoseV3FindProduct(info?.productId ?? null, this.device.productName);

    const settings = await this.readSettings();
    const dpiPayload = settings
      ? await this.request(MCHOSE_V3_COMMAND.readDpi, [settings.profileIndex, 0])
      : null;
    const dpi = dpiPayload ? mchoseV3DecodeDpi(dpiPayload) : null;
    const buttonPayload = settings
      ? await this.request(MCHOSE_V3_COMMAND.readButtons, [settings.profileIndex, 0, 6])
      : null;
    const buttons = buttonPayload ? mchoseV3DecodeButtons(buttonPayload) : null;
    const liftOffIndex = settings ? await this.readLiftOffIndex(product, settings) : null;
    const version = await this.readVersion();

    const sensor = settings ? mchoseV3DecodeSensor(settings.sensor) : null;
    const rates = product ? mchoseV3PollingRates(product) : [];
    const rateIndex = settings
      ? (this.isWired() ? settings.wiredRateIndex : settings.wirelessRateIndex)
      : -1;
    const stages = dpi?.stages.slice(0, dpi.stageCount || dpi.stages.length) ?? [];
    const liftOffHeight = product && liftOffIndex !== null
      ? (mchoseV3LiftOffLabels(product)[liftOffIndex] ?? null)
      : null;

    const firmware: string[] = [];
    if (version) firmware.push(`Firmware ${version}`);

    return {
      brand: "MCHOSE",
      name: product ? `MCHOSE ${product.name}` : this.displayName(),
      batteryPercent: info?.batteryPercent ?? null,
      batteryState: info ? (info.chargeStatus ? "Charging" : "Discharging") : "Unknown",
      dpi: dpi ? (dpi.stages[dpi.activeStage] ?? 0) : 0,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: stages.length ? dpi!.activeStage : undefined,
      supportsSeparateDpiAxes: dpi?.hasSeparateY || undefined,
      pollingRateHz: rates[rateIndex] ?? 0,
      supportedPollingRates: rates.length ? [...rates] : undefined,
      // The wire index is 0-based; the shell counts profiles from one.
      activeProfile: settings ? settings.profileIndex + 1 : null,
      profileCount: info?.profileCount || undefined,
      // Both switches read fine; neither can be written yet, so they are shown
      // as state rather than offered as controls.
      debounceMs: settings?.leftDebounceMs ?? null,
      sleepTimeout: settings ? settings.sleep * 60 : null,
      connectionType: this.isWired() ? "Wired" : "Wireless",
      connectionDetail: info && info.connectStatus === 0
        ? "Receiver connected, mouse not linked"
        : undefined,
      // The shell's field is a three-stop scale and this family's ladders run
      // to five, so the bucket goes here and the exact height goes in the note.
      liftOffDistance: product && liftOffIndex !== null
        ? mchoseV3LiftOffStop(product, liftOffIndex)
        : null,
      motionSync: sensor?.motionSync ?? null,
      angleSnapping: sensor?.angleSnapping ?? null,
      rippleControl: sensor?.rippleControl ?? null,
      angleTuning: settings?.angleTuning ?? null,
      powerMode: sensor ? MCHOSE_V3_MODES[sensor.modeIndex] : undefined,
      powerModes: sensor ? [...MCHOSE_V3_MODES] : undefined,
      buttonMappings: buttons
        ? Object.fromEntries(
          Object.entries(buttons).map(([name, action]) => [name, mchoseV3ButtonActionName(name, action)]),
        )
        : undefined,
      buttonOptions: buttons ? mchoseV3ButtonActionLabels() : undefined,
      firmware,
      ui: {
        family: "mchose-v3",
        settingsReady: Boolean(settings),
        valuesVerified: Boolean(settings),
        defaultDisplayName: "MCHOSE",
        forceShowBattery: true,
        hideSignalCard: true,
        hideUnsupportedPollingRates: true,
        showAdvancedSection: true,
        // Each link stores its own polling rate, so say which one is being set.
        pollingNote: this.isWired()
          ? "Applies to the wired connection."
          : "Applies to the 2.4 GHz connection.",
        statusNote: settings
          ? [
            liftOffHeight ? `Lift-off ${liftOffHeight}.` : "",
            "Settings for this model are written to the same commands MCHOSE's own software uses, but have not been confirmed on hardware yet.",
          ].filter(Boolean).join(" ")
          : this.linkBusy
            ? "Receiver connected, but the mouse is not reachable. Wake it or check it is switched on."
            : "This mouse did not answer. Please report the model and how it is connected.",
        dpiStageEditor: product
          ? {
            maxStages: MCHOSE_V3_DPI_STAGES,
            countEditable: true,
            minDpi: MCHOSE_V3_DPI_MIN,
            maxDpi: product.dpiMax,
            stepDpi: MCHOSE_V3_DPI_STEP,
          }
          : undefined,
      },
    };
  }
}

