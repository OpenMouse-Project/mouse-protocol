import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";
import {
  REDRAGON_M690_PRO_BLOCK_REPORT_ID,
  REDRAGON_M690_PRO_BUTTON_OPTIONS,
  REDRAGON_M690_PRO_BUTTONS_LENGTH,
  REDRAGON_M690_PRO_BUTTONS_TRAILER,
  REDRAGON_M690_PRO_CMD_LINK,
  REDRAGON_M690_PRO_CMD_STATUS,
  REDRAGON_M690_PRO_COMMAND_REPORT_ID,
  REDRAGON_M690_PRO_CONFIG_LENGTH,
  REDRAGON_M690_PRO_DPI_LABELS,
  REDRAGON_M690_PRO_EFFECT_BREATHING,
  REDRAGON_M690_PRO_EFFECT_STEADY,
  REDRAGON_M690_PRO_EFFECT_STREAMING,
  REDRAGON_M690_PRO_POLLING_RATES,
  REDRAGON_M690_PRO_PRODUCTS,
  REDRAGON_M690_PRO_STAGE_COUNT,
  REDRAGON_M690_PRO_USAGE,
  REDRAGON_M690_PRO_USAGE_PAGE,
  REDRAGON_M690_PRO_VENDOR_ID,
  redragonM690ProCheckBlock,
  redragonM690ProCheckCommandReply,
  redragonM690ProDecodeButtons,
  redragonM690ProDecodeConfig,
  redragonM690ProDecodeLink,
  redragonM690ProDecodeStatus,
  redragonM690ProEncodeBlockWrite,
  redragonM690ProEncodeCommand,
  redragonM690ProIsModelBlock,
  redragonM690ProNearestDpi,
  redragonM690ProWithActiveStage,
  redragonM690ProWithButtonAction,
  redragonM690ProWithLighting,
  redragonM690ProWithPollingRate,
  redragonM690ProWithStageColor,
  redragonM690ProWithStageDpi,
  type RedragonM690ProConfig,
  type RedragonM690ProLightingChange,
  type RedragonM690ProProduct,
  type RedragonM690ProRgb,
} from "@openmouse/protocol/redragon";

/** The vendor app reads an answer 50-60 ms after sending its command; match it. */
const COMMAND_DELAY_MS = 60;
/** Block reads are re-requested a few times before giving up; writes never are. */
const READ_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 150;
/** The vendor app leaves 150-400 ms between the settings and button block writes. */
const BLOCK_WRITE_SETTLE_MS = 200;

const MODE_STATIC: MouseLightingMode = "Static";
const MODE_WAVE: MouseLightingMode = "Wave";
const MODE_BREATHING: MouseLightingMode = "Breathing random";
const MODE_OFF: MouseLightingMode = "Off";
const LIGHTING_MODES: readonly MouseLightingMode[] = [MODE_STATIC, MODE_WAVE, MODE_BREATHING, MODE_OFF];
/** The vendor sliders' five positions (Cfg.ini `LightUI`/`SpeedUI` 0-4); brightness 0 is Off. */
const BRIGHTNESS_PERCENT = [25, 50, 75, 100] as const;
const SPEEDS = [1, 2, 3, 4, 5] as const;
/**
 * Shown for effects without a speed (Static, Off) so that switching to Wave or
 * Breathing starts from a selected value: the factory speed byte 2, shown as 3.
 */
const DEFAULT_SPEED = 3;
/**
 * Shown when the stored brightness is 0 (Off, or an effect saved dark) so
 * that switching to an effect starts from a selected value, and written when
 * an effect stored at 0 is selected without one.
 */
const DEFAULT_BRIGHTNESS = 50;
const LIGHTING_EFFECT_FOR_MODE: Partial<Record<MouseLightingMode, RedragonM690ProLightingChange["effect"]>> = {
  [MODE_STATIC]: REDRAGON_M690_PRO_EFFECT_STEADY,
  [MODE_OFF]: REDRAGON_M690_PRO_EFFECT_STEADY,
  [MODE_WAVE]: REDRAGON_M690_PRO_EFFECT_STREAMING,
  [MODE_BREATHING]: REDRAGON_M690_PRO_EFFECT_BREATHING,
};

function hasVendorReports(collections: readonly HIDCollectionInfo[], found = new Set<number>()): Set<number> {
  for (const collection of collections) {
    if (collection.usagePage === REDRAGON_M690_PRO_USAGE_PAGE && collection.usage === REDRAGON_M690_PRO_USAGE) {
      for (const report of collection.featureReports ?? []) found.add(report.reportId);
    }
    hasVendorReports(collection.children ?? [], found);
  }
  return found;
}

function toHexColor({ r, g, b }: RedragonM690ProRgb): string {
  return `#${[r, g, b].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseColor(color: string): RedragonM690ProRgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Redragon M690 PRO colour "${color}" is not #rrggbb.`);
  return { r: parseInt(match[1]!, 16), g: parseInt(match[2]!, 16), b: parseInt(match[3]!, 16) };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class NotM690ProError extends Error {
  constructor() {
    super("This SinoWealth device's settings block is not the Redragon M690 PRO's; not touching it.");
  }
}

/**
 * Redragon M690 PRO (`258a:002e` cable, `258a:002f` 2.4 GHz receiver) WebHID
 * control.
 *
 * SinoWealth framing (see `m690-pro.ts` in `@openmouse/protocol/redragon`):
 * a command on feature report 5 selects what feature report 8 answers.
 * Settings and buttons are each one block that is read, changed, and written
 * back whole, in the vendor app's order (settings, then buttons with its `a5`
 * trailer), then read back and compared. The cable and the receiver keep
 * separate settings banks; each PID reads and writes its own, as the vendor
 * app does.
 *
 * Through the receiver, the dongle answers reads even while the mouse is off
 * (with the last values it holds), so link state comes from command 0x80 and
 * writes are refused while the mouse is reported unreachable, as the vendor
 * app does.
 *
 * Short answers (identify `0x01`, link `0x80`, battery `0x90`) come back on
 * the 7-byte feature report 5, and the firmware STALLs that read unless it
 * asks for exactly 8 bytes. Chrome asks for the device's largest feature
 * report (520 bytes) on every read (captured over the cable), so in a browser
 * those answers can be unreadable. The mouse is therefore identified from its
 * settings block, and link and battery are read when the transport allows it
 * and otherwise reported as unknown.
 */
export class RedragonM690ProHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private identified = false;
  /** Whether report-5 answers can be read here: null until the first try. */
  private shortAnswers: boolean | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== REDRAGON_M690_PRO_VENDOR_ID) return false;
    if (!REDRAGON_M690_PRO_PRODUCTS.has(device.productId)) return false;
    const reports = hasVendorReports(device.collections);
    return reports.has(REDRAGON_M690_PRO_BLOCK_REPORT_ID) && reports.has(REDRAGON_M690_PRO_COMMAND_REPORT_ID);
  }

  get supportedPollingRates(): number[] {
    return [...REDRAGON_M690_PRO_POLLING_RATES];
  }

  getDpiOptions(): number[] {
    return [...REDRAGON_M690_PRO_DPI_LABELS];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /**
   * Reads everything the mouse can report. A device that cannot be opened
   * still fails, but a settings read that fails (or a settings block that is
   * not the M690 PRO's) gives an identity-only status with controls off, so
   * the connection stays up and the next refresh can try again.
   */
  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      try {
        return await this.readFullStatus();
      } catch (error) {
        return this.unavailableStatus(error);
      }
    });
  }

  private async readFullStatus(): Promise<MouseStatus> {
    const block = await this.identify() ?? await this.readConfig();
    const product = this.product();
    const wireless = product.connection === "Wireless";
    const linked = wireless ? await this.readLink() : true;
    const config = redragonM690ProDecodeConfig(block);
    const buttons = redragonM690ProDecodeButtons(await this.readButtons());
    const statusReply = await this.shortCommand(REDRAGON_M690_PRO_CMD_STATUS);
    const status = statusReply ? redragonM690ProDecodeStatus(statusReply) : null;
    const stages = config.stages.map((dpi) => dpi ?? 0);
    const name = `Redragon ${product.name}`;
    return {
      brand: "Redragon",
      name,
      ui: {
        family: "redragon-m690-pro",
        settingsReady: true,
        valuesVerified: true,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        dpiStageEditor: {
          maxStages: REDRAGON_M690_PRO_STAGE_COUNT,
          countEditable: false,
          minDpi: REDRAGON_M690_PRO_DPI_LABELS[0]!,
          maxDpi: REDRAGON_M690_PRO_DPI_LABELS[REDRAGON_M690_PRO_DPI_LABELS.length - 1]!,
          stepDpi: 50,
        },
        defaultDisplayName: name,
        ...(linked === false ? {
          statusNote: "The mouse is off or asleep: the receiver shows its last values, and changes need the mouse awake.",
        } : wireless && linked === null ? {
          // A browser cannot read the battery or link answers (see the class
          // comment); OpenMouse Bridge can. Without the link check, a change
          // made while the mouse is off is undone when it reconnects
          // (captured), because the receiver only holds a copy.
          statusNote: "Battery level and the awake check need OpenMouse Bridge. Without it, changes made while the mouse is off or asleep are undone when it reconnects.",
        } : !wireless && status === null ? {
          statusNote: "Charging status needs OpenMouse Bridge.",
        } : {}),
      },
      batteryPercent: linked === false ? null : status?.batteryPercent ?? null,
      batteryState: linked !== false && status?.charge ? status.charge : "Unknown",
      dpi: stages[config.activeStage] ?? stages[0]!,
      dpiStages: stages,
      dpiStageColors: config.stageColors.map(toHexColor),
      activeDpiStage: config.activeStage,
      pollingRateHz: config.pollingHz ?? 0,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      buttonMappings: buttons,
      buttonOptions: [...REDRAGON_M690_PRO_BUTTON_OPTIONS],
      fixedButtons: Object.entries(buttons)
        .filter(([, action]) => !REDRAGON_M690_PRO_BUTTON_OPTIONS.includes(action))
        .map(([button]) => button),
      lighting: this.lighting(config),
      connectionType: product.connection,
      connectionDetail: wireless ? (linked === false ? "2.4 GHz receiver, mouse off or asleep" : "2.4 GHz receiver") : "USB cable",
      liftOffDistance: null,
      firmware: [],
    };
  }

  /** Snaps to the nearest vendor DPI value, writes it, and returns that value. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const label = redragonM690ProNearestDpi(dpi);
    await this.writeConfig((block) => redragonM690ProWithStageDpi(block, stage, label));
    return label;
  }

  /** Selects the active DPI stage (0-based), as the mouse's DPI buttons do. */
  async setActiveDpiStage(stage: number): Promise<number> {
    await this.writeConfig((block) => redragonM690ProWithActiveStage(block, stage));
    return stage;
  }

  async setPollingRate(hz: number): Promise<number> {
    await this.writeConfig((block) => redragonM690ProWithPollingRate(block, hz));
    return hz;
  }

  /**
   * Sets one stage's indicator colour (`#rrggbb`, 0-based stage), the
   * contract of OpenMouse's `applyDpiStageColor`. OpenMouse currently calls it
   * only when applying a saved game profile: the stage editor's per-stage
   * colour picker was dropped in openmouse 0fc6ae1 ("unified stage-based DPI
   * editor"), and works again unchanged if that picker returns.
   */
  async setDpiStageColor(stage: number, color: string): Promise<void> {
    const rgb = parseColor(color);
    await this.writeConfig((block) => redragonM690ProWithStageColor(block, stage, rgb));
  }

  /**
   * Selects an effect and writes the brightness, speed and colour requested
   * for it, as the panel shows them before Apply. A value left unset keeps
   * what that effect has stored, except a stored brightness of 0, which would
   * leave the chosen effect dark. Off is Steady at brightness 0, which keeps
   * the colour.
   */
  async setLighting(lighting: MouseLighting): Promise<void> {
    const effect = lighting.mode ? LIGHTING_EFFECT_FOR_MODE[lighting.mode] : undefined;
    if (effect === undefined) throw new Error(`The Redragon M690 PRO has no "${lighting.mode}" lighting effect.`);
    if (lighting.speed != null && !SPEEDS.includes(lighting.speed as 1)) {
      throw new Error(`Redragon M690 PRO lighting speed ${lighting.speed} is outside 1-${SPEEDS.length}.`);
    }
    if (lighting.brightness != null && !BRIGHTNESS_PERCENT.includes(lighting.brightness as 25)) {
      throw new Error(`Redragon M690 PRO brightness ${lighting.brightness}% is not one of ${BRIGHTNESS_PERCENT.join(", ")}.`);
    }
    const color = lighting.color == null ? null : parseColor(lighting.color);
    await this.writeConfig((block) => {
      const config = redragonM690ProDecodeConfig(block);
      const change: RedragonM690ProLightingChange = { effect };
      if (lighting.mode === MODE_OFF) {
        change.brightness = 0;
      } else {
        const stored = effect === REDRAGON_M690_PRO_EFFECT_STEADY ? config.lighting.steady.brightness
          : effect === REDRAGON_M690_PRO_EFFECT_STREAMING ? config.lighting.streaming.brightness
            : config.lighting.breathing.brightness;
        if (lighting.brightness != null) {
          change.brightness = BRIGHTNESS_PERCENT.indexOf(lighting.brightness as 25) + 1;
        } else if (stored === 0) {
          change.brightness = BRIGHTNESS_PERCENT.indexOf(DEFAULT_BRIGHTNESS) + 1;
        }
        if (effect !== REDRAGON_M690_PRO_EFFECT_STEADY && lighting.speed != null) change.speed = lighting.speed - 1;
        if (effect === REDRAGON_M690_PRO_EFFECT_STEADY && color) change.color = color;
      }
      return redragonM690ProWithLighting(block, change);
    });
  }

  /**
   * Assigns an action from `buttonOptions` to one of the eight buttons.
   * Refuses to take away the last left click, which would leave the mouse
   * unable to click.
   */
  async setButtonMapping(button: string, action: string): Promise<void> {
    await this.writeButtons((block) => {
      const next = redragonM690ProWithButtonAction(block, button, action);
      if (!Object.values(redragonM690ProDecodeButtons(next)).includes("Left click")) {
        throw new Error("Keep Left click on at least one button, or the mouse cannot click.");
      }
      return next;
    });
  }

  private lighting(config: RedragonM690ProConfig): MouseLighting {
    const { effect, steady, streaming, breathing, steadyColors } = config.lighting;
    let mode: MouseLightingMode | null = null;
    let brightness = 0;
    let speed: number | null = null;
    if (effect === REDRAGON_M690_PRO_EFFECT_STEADY && steady.brightness === 0) {
      mode = MODE_OFF;
    } else if (effect === REDRAGON_M690_PRO_EFFECT_STEADY) {
      mode = MODE_STATIC;
      brightness = steady.brightness;
    } else if (effect === REDRAGON_M690_PRO_EFFECT_STREAMING) {
      mode = MODE_WAVE;
      brightness = streaming.brightness;
      speed = streaming.speed;
    } else if (effect === REDRAGON_M690_PRO_EFFECT_BREATHING) {
      mode = MODE_BREATHING;
      brightness = breathing.brightness;
      speed = breathing.speed;
    }
    const color = steadyColors[steady.slot] ?? null;
    return {
      zone: "Mouse",
      modes: LIGHTING_MODES,
      mode,
      color: color ? toHexColor(color) : null,
      color2: null,
      colorModes: [MODE_STATIC],
      dualColorModes: [],
      reactiveModes: [MODE_WAVE, MODE_BREATHING],
      speeds: SPEEDS,
      speed: speed !== null && speed < SPEEDS.length ? speed + 1 : DEFAULT_SPEED,
      brightness: BRIGHTNESS_PERCENT[brightness - 1] ?? DEFAULT_BRIGHTNESS,
      // Always offered: OpenMouse shows brightness from the effect the mouse
      // reports, not the one just picked, so varying it would hide it on Static
      // after Off and show it on Off after Breathing. Off ignores it.
      brightnessLevels: [...BRIGHTNESS_PERCENT],
    };
  }

  private product(): RedragonM690ProProduct {
    return REDRAGON_M690_PRO_PRODUCTS.get(this.device.productId)!;
  }

  /**
   * Opens the device and, once per connection, checks that its settings block
   * is the M690 PRO's before anything is written (`258a:002f` is a generic
   * SinoWealth receiver id). Returns the settings block it read for that,
   * or null once the device is known.
   */
  private async prepare(): Promise<Uint8Array | null> {
    await this.open();
    return await this.identify();
  }

  private async identify(): Promise<Uint8Array | null> {
    if (this.identified) return null;
    const block = await this.readConfig();
    if (!redragonM690ProIsModelBlock(block)) throw new NotM690ProError();
    this.identified = true;
    return block;
  }

  private unavailableStatus(error: unknown): MouseStatus {
    const product = this.product();
    const name = `Redragon ${product.name}`;
    const statusNote = error instanceof NotM690ProError
      ? "This device's settings block is not the Redragon M690 PRO's, so its settings are left alone."
      : `The Redragon M690 PRO's settings could not be read (${error instanceof Error ? error.message : String(error)}); OpenMouse keeps trying.`;
    return {
      brand: "Redragon",
      name: error instanceof NotM690ProError ? this.device.productName?.trim() || name : name,
      ui: {
        family: "redragon-m690-pro",
        settingsReady: false,
        valuesVerified: false,
        hideProcessingCard: true,
        defaultDisplayName: name,
        statusNote,
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: product.connection,
      liftOffDistance: null,
      firmware: [],
    };
  }

  /** Receiver link state, or null when report-5 answers cannot be read here. */
  private async readLink(): Promise<boolean | null> {
    const reply = await this.shortCommand(REDRAGON_M690_PRO_CMD_LINK);
    return reply ? redragonM690ProDecodeLink(reply) : null;
  }

  private async ensureLinked(): Promise<void> {
    if (this.product().connection !== "Wireless") return;
    if (await this.readLink() === false) {
      throw new Error("The Redragon M690 PRO is off or asleep. Move it or switch it on, then try again.");
    }
  }

  private async readConfig(): Promise<Uint8Array> {
    return await this.readBlock(this.product().configCommand, REDRAGON_M690_PRO_CONFIG_LENGTH);
  }

  private async readButtons(): Promise<Uint8Array> {
    return await this.readBlock(this.product().buttonsCommand, REDRAGON_M690_PRO_BUTTONS_LENGTH);
  }

  private async writeConfig(change: (block: Uint8Array) => Uint8Array): Promise<void> {
    await this.writeBlocks(change, (block) => block);
  }

  private async writeButtons(change: (block: Uint8Array) => Uint8Array): Promise<void> {
    await this.writeBlocks((block) => block, change);
  }

  /**
   * The vendor app's write: settings block, then button block with its
   * trailer, both rewritten whole even when only one changed. Both are read
   * back and must match before the change is reported as done.
   */
  private async writeBlocks(
    changeConfig: (block: Uint8Array) => Uint8Array,
    changeButtons: (block: Uint8Array) => Uint8Array,
  ): Promise<void> {
    await this.run(async () => {
      await this.prepare();
      await this.ensureLinked();
      const config = changeConfig(await this.readConfig());
      const buttons = changeButtons(await this.readButtons());
      await this.sendBlock(redragonM690ProEncodeBlockWrite(config, REDRAGON_M690_PRO_CONFIG_LENGTH));
      await this.sendBlock(redragonM690ProEncodeBlockWrite(buttons, REDRAGON_M690_PRO_BUTTONS_LENGTH, REDRAGON_M690_PRO_BUTTONS_TRAILER));
      const [configBack, buttonsBack] = [await this.readConfig(), await this.readButtons()];
      if (!sameBytes(configBack, config) || !sameBytes(buttonsBack, buttons)) {
        throw new Error("The Redragon M690 PRO did not keep the new settings (read-back differs).");
      }
    });
  }

  private async sendBlock(frame: Uint8Array): Promise<void> {
    await this.device.sendFeatureReport(REDRAGON_M690_PRO_BLOCK_REPORT_ID, frame.slice(1).buffer as ArrayBuffer);
    await sleep(BLOCK_WRITE_SETTLE_MS);
  }

  /**
   * A short command answered on report 5, tried once: null when the answer
   * cannot be read. After a first failure on a transport that never answered,
   * later calls skip the doomed request (each one costs the mouse a STALL).
   */
  private async shortCommand(command: number): Promise<Uint8Array | null> {
    if (this.shortAnswers === false) return null;
    try {
      await this.device.sendFeatureReport(REDRAGON_M690_PRO_COMMAND_REPORT_ID, redragonM690ProEncodeCommand(command).slice(1).buffer as ArrayBuffer);
      await sleep(COMMAND_DELAY_MS);
      const reply = await this.receive(REDRAGON_M690_PRO_COMMAND_REPORT_ID);
      redragonM690ProCheckCommandReply(reply, command);
      this.shortAnswers = true;
      return reply;
    } catch {
      if (this.shortAnswers === null) this.shortAnswers = false;
      return null;
    }
  }

  private async readBlock(command: number, length: number): Promise<Uint8Array> {
    return await this.request(command, REDRAGON_M690_PRO_BLOCK_REPORT_ID, (block) => {
      redragonM690ProCheckBlock(block, command, length);
      return block.slice(0, length);
    });
  }

  /**
   * Sends a block read command on report 5 and collects the block from
   * `reportId`, re-sending the command if the block cannot be read yet or is
   * not the one asked for. Only read commands go through here.
   */
  private async request<T>(command: number, reportId: number, accept: (answer: Uint8Array) => T): Promise<T> {
    let failure: unknown = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(READ_RETRY_DELAY_MS);
      try {
        await this.device.sendFeatureReport(REDRAGON_M690_PRO_COMMAND_REPORT_ID, redragonM690ProEncodeCommand(command).slice(1).buffer as ArrayBuffer);
        await sleep(COMMAND_DELAY_MS);
        return accept(await this.receive(reportId));
      } catch (error) {
        failure = error;
      }
    }
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`The Redragon M690 PRO did not answer command 0x${command.toString(16).padStart(2, "0")} on report ${reportId} (${reason}).`);
  }

  /** WebHID keeps or strips the report id depending on platform; normalise to "id first". */
  private async receive(reportId: number): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(reportId);
    const bytes = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    if (bytes[0] === reportId) return bytes;
    const out = new Uint8Array(bytes.length + 1);
    out[0] = reportId;
    out.set(bytes, 1);
    return out;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
