import type { MouseStatus } from "../mouse-types.ts";
import {
  LEOBOG_GM3_BUTTON_ACTIONS,
  LEOBOG_GM3_BUTTON_NAMES,
  LEOBOG_GM3_DEBOUNCE_OPTIONS,
  LEOBOG_GM3_CONFIG_READ_COMMAND,
  LEOBOG_GM3_DEFAULT_BUTTONS,
  LEOBOG_GM3_DPI_MAX,
  LEOBOG_GM3_DPI_MIN,
  LEOBOG_GM3_DPI_STEP,
  LEOBOG_GM3_MACRO_SLOTS,
  LEOBOG_GM3_MAX_DPI_STAGES,
  LEOBOG_GM3_LINK_COMMAND,
  LEOBOG_GM3_POLLING_RATES,
  LEOBOG_GM3_POWER_COMMAND,
  LEOBOG_GM3_POWER_REPORT_ID,
  LEOBOG_GM3_PRODUCTS,
  LEOBOG_GM3_SLEEP_MAX_MINUTES,
  LEOBOG_GM3_VENDOR_ID,
  leobogGm3BuildConfigReadRequest,
  leobogGm3BuildConfigWriteRequest,
  leobogGm3BuildButtonRequest,
  leobogGm3BuildLinkRequest,
  leobogGm3BuildMacroRequest,
  leobogGm3BuildPowerRequest,
  leobogGm3ButtonLabel,
  leobogGm3DecodeOnboard,
  leobogGm3EncodeButtonTable,
  leobogGm3EncodeMacroRecord,
  leobogGm3FindButtonAction,
  leobogGm3IsMacroBinding,
  leobogGm3IsDpiValue,
  leobogGm3MacroBindingCode,
  leobogGm3ParseConfig,
  leobogGm3ParseLink,
  leobogGm3ParsePower,
  leobogGm3WithActiveStage,
  leobogGm3WithDebounce,
  leobogGm3WithDpiStage,
  leobogGm3WithPollingRate,
  leobogGm3WithSleepMinutes,
  leobogGm3WithStageCount,
  type LeobogGm3OnboardConfig,
  type LeobogGm3ButtonCode,
  type LeobogGm3ButtonName,
  type LeobogGm3Macro,
  type LeobogGm3MacroStep,
  type LeobogGm3Product,
} from "@openmouse/protocol/leobog";

const RESPONSE_DELAY_MS = 50;
const READ_ATTEMPTS = 3;
/**
 * The block read is the expensive one: when the mouse is asleep the receiver
 * accepts the request and then never answers, so the HID call sits there for
 * its own ~5 s timeout. On a 5 s status poll that alone makes the page
 * unusable, so a block read gets a short deadline and a failure backs off
 * before the next attempt.
 */
const CONFIG_CACHE_MS = 500;
/** The receiver can time out quickly when the mouse is asleep. */
const WIRELESS_CONFIG_READ_DEADLINE_MS = 600;
/**
 * The wired device sometimes takes about 2.1 s to publish the feature report,
 * even though the report itself is valid. A shorter deadline rejected those
 * valid answers and left the request occupying the HID handle.
 */
const WIRED_CONFIG_READ_DEADLINE_MS = 2_500;
const CONFIG_RETRY_BACKOFF_MS = 1_000;
/**
 * How long a poll stays off the device after one of its receives had to be
 * abandoned. WebHID has no cancel, so that receive keeps sitting on the handle
 * until the browser gives up on it; issuing the next poll immediately stacks a
 * second wait on top of the first, which is what made the browser itself
 * stutter while the 2.4 GHz link was quiet.
 */
/**
 * How long a poll stays off the device after a rough one. Two things make a
 * poll rough: a receive that had to be abandoned, which WebHID cannot cancel
 * and which therefore sits on the handle until the browser gives up on it,
 * and a reply that legitimately took a long time. Measured on a cable: one
 * reply in 23 polls took 2.1 s while the rest took 50-60 ms, and that one
 * reply was the stutter. Issuing the next poll immediately would stack a
 * second wait on top of whatever the browser is still settling, so the next
 * poll waits this long instead and the page replays its last answer.
 */
const POLL_BACKOFF_MS = 4_000;
/**
 * How long a status poll will wait for the configuration block, on either
 * transport. Measured in the page on a cable: 22 of 23 replies took 50-60 ms
 * and one took 2 096 ms. A poll that waits out that slow reply holds the page
 * — and the browser waiting on the same transfer — for two seconds, so a poll
 * gives up instead and reuses what it has. Writes keep the long budget below,
 * because a write has to see the block it is about to modify.
 */
const POLL_CONFIG_READ_DEADLINE_MS = 600;
/** A status poll that waited longer than this counts as a rough one. */
const SLOW_POLL_MS = 500;
/**
 * How long a write's read-modify-write waits for the block: as long as the
 * slowest reply the device has produced, because a write has to see the block
 * it is about to modify and to read the same block back.
 */
const CONFIG_WRITE_DEADLINE_MS = 2_500;
/**
 * The vendor application leaves ~60 ms between the block read's reply and its
 * write frame. Over the 2.4 GHz receiver a zero-gap write still lands, but
 * over the cable the device accepts it and then ignores it — verified on
 * hardware on both connections.
 */
const WRITE_GAP_MS = 80;

function hasPowerReport(collections: readonly HIDCollectionInfo[]): boolean {
  for (const collection of collections) {
    if (collection.featureReports?.some((report) => report.reportId === LEOBOG_GM3_POWER_REPORT_ID)) {
      return true;
    }
    if (hasPowerReport(collection.children ?? [])) return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Feature-report reads can return the previous command's buffer. Accept the
 * requested command at either alignment because Chrome normally includes
 * the report id while the Windows capture tool does not.
 */
function responseMatchesCommand(response: Uint8Array, command: number): boolean {
  const withReportId = new Uint8Array(response.length + 1);
  withReportId[0] = LEOBOG_GM3_POWER_REPORT_ID;
  withReportId.set(response, 1);
  const frames = response[0] === LEOBOG_GM3_POWER_REPORT_ID
    ? [response, withReportId]
    : [withReportId];
  return frames.some((frame) => frame.length >= 3 && frame[2] === command);
}

/** Factory bindings, used to seed the client's own copy of the button table. */
function defaultButtonTable(): LeobogGm3ButtonCode[] {
  return LEOBOG_GM3_BUTTON_NAMES.map(
    (name) => leobogGm3FindButtonAction(LEOBOG_GM3_DEFAULT_BUTTONS[name])
      ?? ([0x00, 0x00, 0x00, 0x00] as LeobogGm3ButtonCode),
  );
}

/** Label for a macro binding, or null when the entry is something else. */
function macroBindingLabel(code: LeobogGm3ButtonCode): string | null {
  if (!leobogGm3IsMacroBinding(code)) return null;
  const slot = code[3]!;
  return slot < LEOBOG_GM3_MACRO_SLOTS ? `Macro ${slot + 1}` : null;
}

/**
 * The catalog label for a macro action, in the plain `Macro N` form the button
 * card offers. The vendor's loop modes and repeat counts are not exposed yet,
 * so selecting one of these writes the default repeat-once binding.
 */
function macroBindingFor(label: string): LeobogGm3ButtonCode | null {
  const match = /^Macro (\d+)$/.exec(label);
  if (!match) return null;
  const slot = Number(match[1]) - 1;
  return Number.isInteger(slot) && slot >= 0 && slot < LEOBOG_GM3_MACRO_SLOTS
    ? leobogGm3MacroBindingCode(slot)
    : null;
}

/**
 * LEOBOG GM3 telemetry and settings.
 *
 * Every report-9 exchange is either a short read or a read-modify-write of
 * the 400-byte onboard block: the vendor application itself reads `44 00`,
 * edits one field and writes the whole block back with `04 00`, so this class
 * does the same and reads the block back to confirm what the mouse kept.
 *
 * Reads work while the mouse sleeps (the receiver answers the battery query
 * from its last reading), but the block commands time out in that state — the
 * vendor app shows its "press a button on the mouse" page for the same
 * reason. `readStatus` therefore falls back to battery plus a note, and every
 * setter fails loudly rather than pretending to have written anything.
 */
export class LeobogGm3HidClient {
  readonly device: HIDDevice;
  /**
   * Poll often enough to reflect a DPI stage changed by the mouse's own button
   * while asking the device half as often. A slow reply reaches the whole
   * browser rather than just this page, so the number of asks matters more
   * than the gap between them.
   */
  readonly pollIntervalMs = 2_000;
  private queue: Promise<unknown> = Promise.resolve();
  /** Last decoded block, so status polls do not re-read 400 bytes every time. */
  private configCache: { config: LeobogGm3OnboardConfig; at: number } | null = null;
  /** Wall clock before which another block read attempt is pointless. */
  private configRetryAfter = 0;
  /** Wall clock before which the next poll may not touch the device at all. */
  private pollRetryAfter = 0;
  /** Set when a deadline race won and left WebHID's receive outstanding. */
  private abandonedReceive = false;
  /** The last poll's answer, replayed while the device is left alone. */
  private lastStatus: MouseStatus | null = null;
  /**
   * Operations waiting behind the one in flight. A poll consults it before
   * each optional query, so a user's write does not spend the whole poll
   * waiting for a value the block could answer.
   */
  private queuedOperations = 0;
  /**
   * The device answers no read for the button table, so the client keeps its
   * own copy, seeded from the factory bindings. Every write sends the whole
   * table, which is why the untouched slots come from here.
   *
   * That seed is also the risk: the copy starts at the factory bindings, so the
   * first write replaces any binding the user made in the vendor application
   * and there is no read to check against. Anything richer than a whole-table
   * write would have to come from the vendor application's own profile file.
   */
  private buttonTable: LeobogGm3ButtonCode[] = defaultButtonTable();
  /**
   * Macros are write-only too: the device answers no read for `03 00`, so this
   * mirrors whatever this client uploaded.
   */
  private macros: Array<LeobogGm3Macro | null> =
    Array.from({ length: LEOBOG_GM3_MACRO_SLOTS }, () => null);

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== LEOBOG_GM3_VENDOR_ID) return false;
    if (!LEOBOG_GM3_PRODUCTS.has(device.productId)) return false;
    return hasPowerReport(device.collections);
  }

  /** Every value the block can encode: 100-24000 in 100 DPI steps. */
  getDpiOptions(): number[] {
    const count = (LEOBOG_GM3_DPI_MAX - LEOBOG_GM3_DPI_MIN) / LEOBOG_GM3_DPI_STEP + 1;
    return Array.from({ length: count }, (_, index) => LEOBOG_GM3_DPI_MIN + index * LEOBOG_GM3_DPI_STEP);
  }

  getDebounceOptions(): readonly number[] {
    return LEOBOG_GM3_DEBOUNCE_OPTIONS;
  }

  getSupportedPollingRates(): number[] {
    return [...LEOBOG_GM3_POLLING_RATES];
  }

  /**
   * Auto-sleep steps OpenMouse offers, in seconds. 0 is "never", which is what
   * the vendor's off switch writes to the block; the rest are the idle times
   * its slider covers (1, 2, 3, 5, 10, 15 and 20 minutes).
   */
  getSleepOptions(): number[] {
    return [0, 60, 120, 180, 300, 600, 900, 1200];
  }

  /** Actions the shared button card offers, in catalog order. */
  getButtonOptions(): string[] {
    return [
      ...LEOBOG_GM3_BUTTON_ACTIONS.map((action) => action.label),
      ...Array.from({ length: LEOBOG_GM3_MACRO_SLOTS }, (_, slot) => `Macro ${slot + 1}`),
    ];
  }

  /**
   * The client's copy of the assignments. The GM3 has no read command for the
   * table, so this starts at the factory bindings and then tracks whatever
   * this client wrote — the same trade-off the M2-NEX macro editor makes.
   */
  getButtonMappings(): Record<string, string> {
    return this.labelsForTable(this.buttonTable);
  }

  /** The factory bindings, so the remapper can offer a restore-defaults. */
  getDefaultButtonMappings(): Record<string, string> {
    return this.labelsForTable(defaultButtonTable());
  }

  private labelsForTable(table: readonly LeobogGm3ButtonCode[]): Record<string, string> {
    return Object.fromEntries(LEOBOG_GM3_BUTTON_NAMES.map((name, slot) => {
      const code = table[slot] ?? ([0x00, 0x00, 0x00, 0x00] as LeobogGm3ButtonCode);
      return [
        name,
        leobogGm3ButtonLabel(code) ?? macroBindingLabel(code) ?? `Custom (${code.join(", ")})`,
      ];
    }));
  }

  /**
   * Remaps one slot by rewriting the whole 80-byte table. There is nothing to
   * read back, so the write either lands or it does not; the local copy is
   * updated only after the frame was handed to the device.
   */
  async setButtonMapping(button: string, actionLabel: string): Promise<void> {
    return await this.run(async () => {
      const slot = LEOBOG_GM3_BUTTON_NAMES.indexOf(button as LeobogGm3ButtonName);
      if (slot < 0) {
        throw new Error(`This mouse has no "${button}" button.`);
      }
      const code = leobogGm3FindButtonAction(actionLabel) ?? macroBindingFor(actionLabel);
      if (code === null) {
        throw new Error(`"${actionLabel}" is not one of the GM3 button actions.`);
      }
      const table = this.buttonTable.map((entry, index) => (index === slot ? code : entry));
      await this.open();
      await this.writeButtonTable(leobogGm3EncodeButtonTable(table));
      this.buttonTable = table;
    });
  }

  /** Fire-and-forget: `01 00` is answered with the previous reply buffer. */
  private async writeButtonTable(payload: Uint8Array): Promise<void> {
    const request = leobogGm3BuildButtonRequest(payload);
    await this.device.sendFeatureReport(
      LEOBOG_GM3_POWER_REPORT_ID,
      request.slice(1).buffer as ArrayBuffer,
    );
  }

  /**
   * Rewrites the whole table with the factory bindings, the one reset the
   * vendor application exposes that we have measured. `01 00` is answered with
   * the previous reply buffer, so there is no read-back to confirm against and
   * the local copy simply follows the write, as it does elsewhere here.
   */
  async resetButtonMappings(): Promise<void> {
    return await this.run(async () => {
      const table = defaultButtonTable();
      await this.open();
      await this.writeButtonTable(leobogGm3EncodeButtonTable(table));
      this.buttonTable = table;
    });
  }

  /** Macro slots in wire order; null marks an empty slot. */
  getMacros(): Array<LeobogGm3Macro | null> {
    return this.macros.map((macro) => (macro === null ? null : {
      name: macro.name,
      steps: macro.steps.map((step) => ({ ...step, event: { ...step.event } })),
    }));
  }

  /**
   * Uploads one macro with vendor command `03 00`. The device answers no read
   * for it, so there is nothing to confirm against — the local copy is only
   * updated after the frame was handed over, exactly like the button table.
   *
   * `slot` names this client's copy, not a field in the frame: the record
   * carries the name, the steps and nothing else, so the mouse numbers the
   * macros it receives in upload order. Labels and button bindings are built
   * from the same local slot, so they line up while every upload goes through
   * one client. A macro uploaded by the vendor application can shift the
   * indices, and with no readback that cannot be detected from here — see
   * `docs/leobog-gm3-buttons.md`.
   */
  async setMacro(slot: number, name: string, steps: readonly LeobogGm3MacroStep[]): Promise<void> {
    return await this.run(async () => {
      if (!Number.isInteger(slot) || slot < 0 || slot >= LEOBOG_GM3_MACRO_SLOTS) {
        throw new Error(`The GM3 has ${LEOBOG_GM3_MACRO_SLOTS} macro slots.`);
      }
      const payload = leobogGm3EncodeMacroRecord(name, steps);
      await this.open();
      const request = leobogGm3BuildMacroRequest(payload);
      await this.device.sendFeatureReport(
        LEOBOG_GM3_POWER_REPORT_ID,
        request.slice(1).buffer as ArrayBuffer,
      );
      this.macros[slot] = {
        name,
        steps: steps.map((step) => ({ ...step, event: { ...step.event } })),
      };
    });
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    const startedAt = Date.now();
    return await this.run(async () => {
      await this.open();
      // A previous poll had to abandon a receive, so let that one land before
      // spending another. Replaying the last answer keeps the page current
      // without touching a handle that is still busy.
      if (this.lastStatus !== null && Date.now() < this.pollRetryAfter) {
        const replayed = { ...this.lastStatus };
        // Device-reported fields stay as they were; the client's own tables
        // are rebuilt so an upload made while the device was left alone still
        // shows up.
        replayed.buttonMappings = this.getButtonMappings();
        replayed.buttonOptions = this.getButtonOptions();
        replayed.defaultButtonMappings = this.getDefaultButtonMappings();
        replayed.leobogMacros = this.getMacros();
        // A settings write also runs during the backoff. Its read-back block is
        // newer than the one this replay carries, so the configuration-derived
        // fields come from the cache — otherwise a change the mouse accepted
        // looks like it reverted until the next full poll.
        if (this.configCache !== null) {
          const cached = this.configCache.config;
          replayed.dpi = cached.dpiStages[cached.activeStage]!;
          replayed.dpiStages = cached.dpiStages.slice(0, cached.stageCount);
          replayed.activeDpiStage = cached.activeStage;
          replayed.pollingRateHz = cached.pollingRateHz;
          replayed.debounceMs = cached.debounceMs;
          replayed.sleepTimeout = cached.sleepMinutes * 60;
        }
        return replayed;
      }
      const product = this.product();
      // Link state and battery are receiver features. Over the cable those
      // requests are unanswered, so asking for them only delays the useful
      // configuration read.
      const linked = product.connection === "Wireless" ? await this.readLink() : null;
      const name = `LEOBOG ${product.name}`;
      // A sleeping mouse times out on every block command, and the link flag
      // already says so, so skip the attempt instead of stalling the poll.
      const settings = linked === false
        ? { config: null, refreshFailed: false }
        : await this.settingsForStatus(
          POLL_CONFIG_READ_DEADLINE_MS,
        );
      const config = settings.config;
      // Read the configuration before power. The vendor application uses that
      // order too, and a receiver queried on its own can answer with its
      // default 100% until the mouse has refreshed the profile. A fresh
      // power answer is preferred because it follows the live battery level;
      // the block value is the fallback when that answer is unavailable.
      // The live query is also the one step a poll can drop: when a user's
      // write is waiting behind it, spending the round trip on a battery
      // number the block can answer is the difference between a click that
      // lands immediately and one that waits for the whole poll.
      const queried = product.connection === "Wireless" && !this.operationQueuedBehind()
        ? await this.tryBattery()
        : null;
      // The block's battery byte is a receiver cache, not a cable reading.
      // Never present it as live while the mouse is connected over USB.
      const percent = product.connection === "Wireless"
        ? queried ?? config?.reportedBatteryPercent ?? null
        : null;

      const status: MouseStatus = {
        brand: "LEOBOG",
        name,
        ui: this.ui(product, linked, config, settings.refreshFailed, percent),
        batteryPercent: percent,
        batteryState: product.connection === "Wireless" ? "Discharging" : "Charging",
        dpi: config ? config.dpiStages[config.activeStage]! : 0,
        dpiStages: config ? config.dpiStages.slice(0, config.stageCount) : undefined,
        activeDpiStage: config?.activeStage,
        pollingRateHz: config?.pollingRateHz ?? 0,
        supportedPollingRates: [...LEOBOG_GM3_POLLING_RATES],
        debounceMs: config?.debounceMs ?? null,
        sleepTimeout: config ? config.sleepMinutes * 60 : null,
        buttonMappings: this.getButtonMappings(),
        buttonOptions: this.getButtonOptions(),
        defaultButtonMappings: this.getDefaultButtonMappings(),
        leobogMacros: this.getMacros(),
        activeProfile: null,
        connectionType: product.connection,
        connectionDetail: product.connection === "Wireless" ? "2.4 GHz receiver" : "USB cable",
        liftOffDistance: null,
        firmware: [],
      };
      if (this.abandonedReceive) {
        this.abandonedReceive = false;
        this.pollRetryAfter = Date.now() + POLL_BACKOFF_MS;
      }
      this.lastStatus = status;
      // A poll that waited this long occupied the handle for most of it, and
      // the browser may still be settling the transfer behind it. Measured on
      // a cable: one reply in 23 polls took 2.1 s while the rest took 50-60 ms,
      // and that one reply was the stutter. Giving it four seconds of quiet
      // after keeps the next poll from queueing straight behind it.
      if (Date.now() - startedAt > SLOW_POLL_MS) {
        this.pollRetryAfter = Date.now() + POLL_BACKOFF_MS;
      }
      return status;
    });
  }

  /** Writes one DPI stage's value and confirms the mouse kept it. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    return await this.run(async () => {
      await this.writeStageValue(stage, dpi);
      return dpi;
    });
  }

  /**
   * The plain DPI control: the vendor application's DPI slider edits the
   * *selected* stage's value and leaves the selection alone, so this writes
   * the active stage rather than moving to a different one.
   */
  async setDpi(dpi: number): Promise<number> {
    return await this.run(async () => {
      await this.open();
      const config = leobogGm3DecodeOnboard(
        await this.readOnboard(1, CONFIG_WRITE_DEADLINE_MS),
      );
      if (config === null) {
        throw new Error("Could not read the GM3 configuration block to find the active DPI stage.");
      }
      await this.writeStageValue(config.activeStage, dpi);
      return dpi;
    });
  }

  private async writeStageValue(stage: number, dpi: number): Promise<void> {
    if (!leobogGm3IsDpiValue(dpi)) {
      throw new RangeError(`This mouse supports ${LEOBOG_GM3_DPI_MIN}-${LEOBOG_GM3_DPI_MAX} DPI in steps of ${LEOBOG_GM3_DPI_STEP}.`);
    }
    await this.apply(
      (block) => leobogGm3WithDpiStage(block, stage, dpi),
      (config) => config.dpiStages[stage] === dpi,
      `The mouse did not keep ${dpi} DPI on stage ${stage + 1}.`,
    );
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    return await this.run(async () => {
      await this.apply(
        (block) => leobogGm3WithActiveStage(block, stage),
        (config) => config.activeStage === stage,
        `The mouse did not switch to DPI stage ${stage + 1}.`,
      );
      return stage;
    });
  }

  async setDpiStageCount(count: number): Promise<number> {
    return await this.run(async () => {
      await this.apply(
        (block) => leobogGm3WithStageCount(block, count),
        (config) => config.stageCount === count,
        `The mouse did not keep ${count} DPI stages.`,
      );
      return count;
    });
  }

  async setPollingRate(hz: number): Promise<number> {
    return await this.run(async () => {
      await this.apply(
        (block) => leobogGm3WithPollingRate(block, hz),
        (config) => config.pollingRateHz === hz,
        `The mouse did not keep ${hz} Hz.`,
      );
      return hz;
    });
  }

  async setDebounceTime(ms: number): Promise<number> {
    return await this.run(async () => {
      await this.apply(
        (block) => leobogGm3WithDebounce(block, ms),
        (config) => config.debounceMs === ms,
        `The mouse did not keep ${ms} ms debounce.`,
      );
      return ms;
    });
  }

  /** Auto-sleep idle time in seconds; 0 turns it off. */
  async setSleepTimeout(seconds: number): Promise<number> {
    const minutes = seconds / 60;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > LEOBOG_GM3_SLEEP_MAX_MINUTES) {
      throw new RangeError(
        `Auto-sleep must be off (0) or ${1}-${LEOBOG_GM3_SLEEP_MAX_MINUTES} whole minutes, got ${seconds} s.`,
      );
    }
    return await this.run(async () => {
      await this.apply(
        (block) => leobogGm3WithSleepMinutes(block, minutes),
        (config) => config.sleepMinutes === minutes,
        `The mouse did not keep a ${minutes || "no"} minute auto-sleep timer.`,
      );
      return seconds;
    });
  }

  private ui(
    product: LeobogGm3Product,
    linked: boolean | null,
    config: LeobogGm3OnboardConfig | null,
    refreshFailed: boolean,
    batteryPercent: number | null,
  ): MouseStatus["ui"] {
    const scope = product.verified
      ? "DPI stages, polling rate and button debounce are editable."
      : "These settings were captured on the 2.4 GHz receiver; this connection path is not hardware-verified yet.";
    // Wired, the receiver-style battery query goes unanswered and the block
    // reports no level either, so say so instead of showing a dash with no
    // explanation.
    const batteryNote = batteryPercent === null
      ? " Battery level is not reported on this connection."
      : "";
    const buttonNote = " Button assignments are write-only: the mouse cannot report them back, so"
      + " the list starts from the factory bindings and follows writes made here.";
    const notes = (refreshFailed
      ? "The mouse did not answer a settings refresh — it may be asleep. Press a button on the mouse; the values below are the last ones it reported."
      // The link flag is checked before the missing block: a sleeping mouse
      // reports both, and the sleep state is the reason the block is empty.
      : linked === false
        ? "The mouse is asleep, so the battery reading is the receiver's last value; press a button to wake it."
        : config === null
          ? "The mouse is not answering its configuration commands, so settings are read-only until it is awake; press a button on the mouse."
        : scope + buttonNote) + batteryNote;

    return {
      family: "leobog-gm3",
      settingsReady: config !== null,
      valuesVerified: config !== null,
      forceShowBattery: product.connection === "Wireless",
      showAdvancedSection: true,
      hideSignalCard: true,
      hideProcessingCard: true,
      hideLodLow: true,
      hideUnsupportedPollingRates: true,
      // DPI lives in the stage table only; there is no separate live-DPI value
      // to edit, so the Sensitivity card offers the stages on their own.
      hideSingleDpi: true,
      dpiStageEditor: {
        maxStages: LEOBOG_GM3_MAX_DPI_STAGES,
        countEditable: true,
        minDpi: LEOBOG_GM3_DPI_MIN,
        maxDpi: LEOBOG_GM3_DPI_MAX,
        stepDpi: LEOBOG_GM3_DPI_STEP,
      },
      defaultDisplayName: `LEOBOG ${product.name}`,
      statusNote: notes,
    };
  }

  private product(): LeobogGm3Product {
    return LEOBOG_GM3_PRODUCTS.get(this.device.productId)!;
  }

  /**
   * The link query answers from the receiver even while the mouse sleeps, so
   * it never throws: an unanswered frame is reported as an unknown link.
   */
  private async readLink(): Promise<boolean | null> {
    try {
      const response = await this.exchange(
        leobogGm3BuildLinkRequest(),
        3,
        WIRELESS_CONFIG_READ_DEADLINE_MS,
        LEOBOG_GM3_LINK_COMMAND,
      );
      return leobogGm3ParseLink(response);
    } catch {
      return null;
    }
  }

  /**
   * Settings for a status poll: a cached block while it is fresh, a bounded
   * read when it is not, and no attempt at all while backing off from a
   * device that just failed to answer.
   *
   * A user's write is already queued by the time this runs, so the poll leaves
   * the block alone and reuses what it has: the next poll refreshes it.
   */
  private async settingsForStatus(readDeadlineMs: number): Promise<{
    config: LeobogGm3OnboardConfig | null;
    refreshFailed: boolean;
  }> {
    const cached = this.configCache;
    if (cached !== null && Date.now() - cached.at < CONFIG_CACHE_MS) {
      return { config: cached.config, refreshFailed: false };
    }
    if (Date.now() < this.configRetryAfter) {
      return { config: cached?.config ?? null, refreshFailed: cached !== null };
    }
    if (this.operationQueuedBehind()) {
      return { config: cached?.config ?? null, refreshFailed: cached !== null };
    }
    try {
      const config = leobogGm3DecodeOnboard(
        await this.readOnboard(3, readDeadlineMs, true),
      );
      if (config === null) throw new Error("The GM3 configuration block could not be decoded.");
      this.configCache = { config, at: Date.now() };
      this.configRetryAfter = 0;
      return { config, refreshFailed: false };
    } catch {
      // A timed-out WebHID receive can keep the device handle busy even
      // after this promise has given up. Reopen it so the next poll starts
      // from a clean handle instead of waiting for the old request to expire.
      await this.resetDevice();
      this.configRetryAfter = Date.now() + CONFIG_RETRY_BACKOFF_MS;
      return { config: cached?.config ?? null, refreshFailed: true };
    }
  }

  /** Cancels a stuck feature-report receive by reopening the HID handle. */
  private async resetDevice(): Promise<void> {
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      // The old receive may already have closed the handle.
    }
    try {
      await this.device.open();
    } catch {
      // The next status poll will try to open it again.
    }
  }

  /** Reads the 400-byte block; throws when the mouse does not answer. */
  private async readOnboard(
    attempts = 1,
    deadlineMs?: number,
    yieldToQueue = false,
  ): Promise<Uint8Array> {
    const response = await this.exchange(
      leobogGm3BuildConfigReadRequest(),
      attempts,
      deadlineMs,
      LEOBOG_GM3_CONFIG_READ_COMMAND,
      yieldToQueue,
    );
    const payload = leobogGm3ParseConfig(response);
    if (payload === null) {
      throw new Error("The GM3 configuration reply did not match the captured format.");
    }
    return payload;
  }

  private async writeOnboard(payload: Uint8Array): Promise<void> {
    const request = leobogGm3BuildConfigWriteRequest(payload);
    await this.device.sendFeatureReport(
      LEOBOG_GM3_POWER_REPORT_ID,
      request.slice(1).buffer as ArrayBuffer,
    );
  }

  /**
   * Read-modify-write with a read-back check. `verify` decides whether the
   * mouse kept the change; anything else raises the supplied message so the
   * UI can surface it instead of showing a value the mouse never accepted.
   */
  private async apply(
    transform: (block: Uint8Array) => Uint8Array,
    verify: (config: LeobogGm3OnboardConfig) => boolean,
    message: string,
  ): Promise<void> {
    // A receive that timed out leaves the handle busy even though this call has
    // given up on it, so a failed read reopens the device before the error goes
    // back to the UI. Otherwise the next status poll queues behind the stale
    // request and the page looks frozen.
    const readBlock = async (deadlineMs: number): Promise<Uint8Array> => {
      try {
        return await this.readOnboard(3, deadlineMs);
      } catch (error) {
        await this.resetDevice();
        throw error;
      }
    };
    await this.open();
    const before = await readBlock(CONFIG_WRITE_DEADLINE_MS);
    await sleep(WRITE_GAP_MS);
    await this.writeOnboard(transform(before));
    await sleep(RESPONSE_DELAY_MS);
    const config = leobogGm3DecodeOnboard(await readBlock(WIRED_CONFIG_READ_DEADLINE_MS));
    if (config === null || !verify(config)) throw new Error(message);
    // The UI can show the change straight away instead of waiting for the next
    // status poll to re-read the block.
    this.configCache = { config, at: Date.now() };
    this.configRetryAfter = 0;
  }

  /**
   * The battery query, or null when the mouse does not answer it. Over the
   * cable it never does, and a failed query must not lose the settings that
   * came back from the block, so this never throws.
   */
  private async tryBattery(): Promise<number | null> {
    // One budget for all three attempts. A fresh 600 ms deadline per attempt
    // let a receiver that had gone quiet hold this step, and with it the whole
    // poll, for 1.8 s; that is the stutter the page and the browser around it
    // showed whenever the 2.4 GHz link fell silent.
    const budgetUntil = Date.now() + WIRELESS_CONFIG_READ_DEADLINE_MS;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      // Retrying here costs the same as any other step, and the poll has
      // already decided this query is the one it can skip.
      if (attempt > 0 && this.operationQueuedBehind()) break;
      if (attempt > 0) await sleep(RESPONSE_DELAY_MS);
      const remainingMs = budgetUntil - Date.now();
      if (remainingMs <= 0) break;
      try {
        const response = await this.exchange(
          leobogGm3BuildPowerRequest(),
          1,
          remainingMs,
          LEOBOG_GM3_POWER_COMMAND,
        );
        const percent = leobogGm3ParsePower(response);
        if (percent !== null) return percent;
      } catch {
        // Try again, then give up and let the caller fall back to the block.
      }
    }
    return null;
  }

  /** Sends one request and returns the feature report that came back. */
  private async exchange(
    request: Uint8Array,
    attempts: number,
    deadlineMs?: number,
    expectedCommand?: number,
    /** Polls give up their retries when a user's write is queued behind them. */
    yieldToQueue = false,
  ): Promise<Uint8Array> {
    let lastError: unknown = null;
    const deadlineAt = deadlineMs === undefined ? null : Date.now() + deadlineMs;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (yieldToQueue && this.operationQueuedBehind()) break;
      if (attempt > 0) await sleep(RESPONSE_DELAY_MS);
      try {
        await this.device.sendFeatureReport(
          LEOBOG_GM3_POWER_REPORT_ID,
          request.slice(1).buffer as ArrayBuffer,
        );
        await sleep(RESPONSE_DELAY_MS);
        const pending = this.device.receiveFeatureReport(LEOBOG_GM3_POWER_REPORT_ID).then(
          (view) => new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)),
        );
        if (deadlineAt === null) {
          const response = await pending;
          if (expectedCommand === undefined || responseMatchesCommand(response, expectedCommand)) {
            return response;
          }
          lastError = new Error(`The GM3 replied with command 0x${response[2]?.toString(16) ?? "??"} instead of 0x${expectedCommand.toString(16)}.`);
          continue;
        }

        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs <= 0) {
            throw new Error(`The GM3 did not answer within ${deadlineMs} ms.`);
          }
          const response = await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              deadlineTimer = setTimeout(() => {
                // The receive is still outstanding: WebHID offers no cancel, so
                // it stays on the handle until the browser's own timeout.
                this.abandonedReceive = true;
                reject(new Error(`The GM3 did not answer within ${deadlineMs} ms.`));
              }, remainingMs);
            }),
          ]);
          if (expectedCommand === undefined || responseMatchesCommand(response, expectedCommand)) {
            return response;
          }
          lastError = new Error(`The GM3 replied with command 0x${response[2]?.toString(16) ?? "??"} instead of 0x${expectedCommand.toString(16)}.`);
        } finally {
          // A reply that beats the deadline has to clear its timer: left
          // running it would flag the next healthy poll as abandoned and make
          // the status poll back off for seconds.
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          // The real HID call keeps waiting for its own timeout; swallow that
          // so a late rejection is not an unhandled promise.
          void pending.catch(() => undefined);
        }
      } catch (error) {
        lastError = error;
        if (deadlineAt !== null && Date.now() >= deadlineAt) break;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("The GM3 did not answer with a feature report.");
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    // Counted here rather than in a finally further down, so an operation that
    // has just started can see the ones queued behind it.
    this.queuedOperations += 1;
    try {
      return await result;
    } finally {
      this.queuedOperations -= 1;
    }
  }

  /** True when another operation is already queued behind the current one. */
  private operationQueuedBehind(): boolean {
    return this.queuedOperations > 1;
  }
}
