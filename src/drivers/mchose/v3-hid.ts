import {
  MCHOSE_V3_COMMAND,
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
  mchoseV3Encode,
  mchoseV3FindProduct,
  mchoseV3IsProductId,
  mchoseV3LiftOffLabels,
  mchoseV3LiftOffStop,
  mchoseV3Payload,
  mchoseV3PollingRates,
  type MchoseV3DeviceInfo,
  type MchoseV3Product,
  type MchoseV3Settings,
} from "@openmouse/protocol/mchose";
import type { MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";

/**
 * MCHOSE A7 V3 and its siblings — **read-only**.
 *
 * This generation abandoned the A7 V2's inverted feature reports for a
 * `0x4d`-magic output report (see `src/mchose/v3.ts`). The command set was read
 * out of MCHOSE's own M HUB bundle, and the **reads** have since been confirmed
 * against a real A7 V3 Ultra+ on its 2.4 GHz receiver: identity, battery and
 * charge state, the DPI table, polling, profile, sleep, debounce, the sensor
 * flags and the button table all came back correctly. See the capture notes in
 * docs/mchose-protocol.md.
 *
 * **The writes have not.** No setter is exposed, and that is the whole point of
 * the split: a wrong read costs a blank field, where a speculative write could
 * leave a stranger's mouse in a state they cannot get out of. Nothing here has
 * ever put a byte into a V3's configuration, and the settle timings that the V2
 * work could only find empirically are still unknown for this generation.
 *
 * `settingsReady` is false so the shell offers no inert controls;
 * `valuesVerified` stays true so what it does read is still shown.
 *
 * Adding writes is a small change on top of this — the encoders are already in
 * the codec — but it should wait for someone who can watch the hardware.
 */

const REPLY_TIMEOUT_MS = 600;
const READ_ATTEMPTS = 3;

/** `0x0901`'s target byte: the mouse rather than the receiver in front of it. */
const VERSION_TARGET_MOUSE = 0;

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
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
        const reply = await new Promise<Uint8Array | null>((resolve) => {
          const finish = (value: Uint8Array | null): void => {
            clearTimeout(timer);
            this.device.removeEventListener("inputreport", listener);
            resolve(value);
          };
          const listener = (event: Event): void => {
            const report = event as HIDInputReportEvent;
            const payload = mchoseV3Payload(new Uint8Array(report.data.buffer), command);
            if (payload) finish(payload);
          };
          const timer = setTimeout(() => { finish(null); }, REPLY_TIMEOUT_MS);
          this.device.addEventListener("inputreport", listener);
          this.device.sendReport(MCHOSE_V3_REPORT_ID, body).catch(() => { finish(null); });
        });
        if (reply) return reply;
      }
      this.unresponsive = true;
      return null;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
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

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    this.unresponsive = false;

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
          Object.entries(buttons).map(([name, action]) => [name, describeButton(action.type)]),
        )
        : undefined,
      firmware,
      ui: {
        family: "mchose-v3",
        // No setters exist yet, so the settings grid would be inert.
        settingsReady: false,
        // …but what is shown was genuinely read off the mouse.
        valuesVerified: true,
        defaultDisplayName: "MCHOSE",
        forceShowBattery: true,
        hideSignalCard: true,
        statusNote: settings
          ? [
            liftOffHeight ? `Lift-off ${liftOffHeight}.` : "",
            "Read-only: this driver can report settings but cannot change them yet.",
          ].filter(Boolean).join(" ")
          : "Read-only, and this mouse did not answer. Please report the model and how it is connected.",
      },
    };
  }
}

/**
 * A human label for a button's action type. Only the type is named, not the
 * value: the V2's value tables were confirmed key by key on hardware, and
 * nothing here has been, so naming a specific key would be a guess presented
 * as a fact.
 */
function describeButton(type: number): string {
  switch (type) {
    case 0x00: return "Default";
    case 0x01: return "Mouse button";
    case 0x02: return "Keyboard";
    case 0x03: return "Media";
    case 0x04: return "Macro";
    case 0x05: return "DPI";
    case 0x08: return "System";
    case 0x0a: return "Profile";
    case 0xff: return "Unassigned";
    default: return `Type ${type}`;
  }
}
