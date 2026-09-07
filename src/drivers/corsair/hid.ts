import type { MouseStatus } from "../mouse-types.ts";
import {
  CORSAIR_CONFIG_USAGE,
  CORSAIR_LIFT_LEVELS,
  CORSAIR_PRODUCTS,
  CORSAIR_REPORT_ID,
  CORSAIR_SNIPER_STAGE,
  CORSAIR_USAGE_PAGE,
  CORSAIR_VENDOR_ID,
  type CorsairDpiStage,
  type CorsairIdent,
  type CorsairLiftName,
  type CorsairRgb,
  corsairDecode,
  corsairDevice,
  corsairEnabledStages,
  corsairEncode,
  corsairFormatVersion,
  corsairIsEcho,
  corsairLiftName,
  corsairParseRgbHex,
  corsairRgbHex,
} from "@openmouse/protocol/corsair";

/**
 * Corsair NIGHTSWORD RGB — WebHID client (phase 2: live reads and writes).
 *
 * Talks to the config interface (usage page 0xffc2, usage 4) through 64-byte
 * feature reports on report id 0. Every GET is send → short wait → receive,
 * and the reply must echo the request's first four bytes; a stale buffer from
 * the previous GET fails that check and the request is retried. A SET gets no
 * reply at all, so every setter confirms with the matching GET. All traffic
 * goes through one queue because the device has a single reply buffer.
 *
 * Slot d0 is iCUE's held-button Sniper stage and is left alone; the stage
 * editor works on slots d1–d5, numbered the way iCUE numbers them. Every
 * write addresses the live profile (byte 3 = 0), which the mouse forgets on
 * a power cycle — the onboard profile needs Corsair's file-based format and is
 * out of scope.
 *
 * Reads past identity are best-effort: if the DPI fields cannot be read the
 * status still identifies the mouse with `ui.settingsReady = false`.
 *
 * iCUE's service keeps this interface open too. Reads and writes have been
 * observed to coexist with it (shared mode, iCUE actively re-applying its
 * profile). If Chrome ever refuses a transfer with a bare `NotAllowedError`,
 * that is mapped to guidance; the more common cause of that error is being
 * granted MI_00's usage-3 collection, which `isSupported()` now rejects.
 */

const PRODUCT_IDS = new Set<number>(CORSAIR_PRODUCTS.keys());
/** Gap between sendFeatureReport and receiveFeatureReport; ~20 ms was reliable on fw 3.41. */
const REPLY_DELAY_MS = 20;
const REQUEST_ATTEMPTS = 3;
const SUPPORTED_POLLING_RATES = [1000, 500, 250, 125] as const;
const LIFT_NAMES: readonly CorsairLiftName[] = ["Low", "Medium", "High"];

/**
 * The sensor accepts any integer DPI, but the shared picker and stage editor
 * work from an explicit option list, and 18,000 entries is too many for a
 * dropdown. 50-DPI steps cover every preset iCUE ships with.
 */
const DPI_MIN = 100;
const DPI_OPTION_STEP = 50;

interface CorsairDpiState {
  mask: number;
  current: { stage: number; x: number; y: number };
  stages: Map<number, CorsairDpiStage>;
}

export class CorsairHidClient {
  readonly canDisableSleep = false;
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  /**
   * Corsair VID, a catalogued product id, and the usage-4 config collection
   * with a feature report on id 0. MI_00 exposes an 0xffc2 collection too
   * (usage 3, input report 14 only) that must not be claimed.
   */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== CORSAIR_VENDOR_ID || !PRODUCT_IDS.has(device.productId)) return false;
    return hasConfigCollection(device.collections);
  }

  get pollIntervalMs(): number { return 30_000; }

  getDpiOptions(): number[] {
    const { dpiMax } = corsairDevice(this.device.productId);
    const options: number[] = [];
    for (let dpi = DPI_MIN; dpi <= dpiMax; dpi += DPI_OPTION_STEP) options.push(dpi);
    return options;
  }

  getSupportedPollingRates(): number[] { return [...SUPPORTED_POLLING_RATES]; }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async startNotifications(_onChange?: () => void): Promise<boolean> { return false; }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      return await this.readStatusDirect();
    });
  }

  // ---------------------------------------------------------------------------
  // Setters. Each one reads what it needs, writes the live profile, and
  // confirms with the matching GET because a SET never answers.
  // ---------------------------------------------------------------------------

  /** Rewrites the value of whichever slot is currently selected (Sniper included). */
  async setDpi(dpi: number, dpiY: number = dpi): Promise<number> {
    this.assertDpi(dpi);
    this.assertDpi(dpiY);
    return await this.run(async () => {
      await this.open();
      const current = corsairDecode.dpiStage(await this.request(corsairEncode.dpiStage()));
      const confirmed = await this.writeSlot(current.stage, dpi, dpiY);
      return confirmed.x;
    });
  }

  /** `stage` indexes the numbered stages (slots d1+), 0-based, like `dpiStages`. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    this.assertDpi(dpi);
    return await this.run(async () => {
      await this.open();
      const { slot, entry } = await this.numberedSlot(stage);
      // A Y that already differs is a separate-axis setting the shared editor
      // cannot show; changing X must not silently flatten it.
      const y = entry.y === entry.x ? dpi : entry.y;
      return (await this.writeSlot(slot, dpi, y, entry.rgb)).x;
    });
  }

  async setDpiStageColor(stage: number, color: string): Promise<string> {
    const rgb = corsairParseRgbHex(color);
    return await this.run(async () => {
      await this.open();
      const { slot, entry } = await this.numberedSlot(stage);
      const confirmed = await this.writeSlot(slot, entry.x, entry.y, rgb);
      return corsairRgbHex(confirmed.rgb);
    });
  }

  /**
   * Enables slots d1..d`count` and disables the rest. The mask is written
   * first: the mouse ignores a stage write to a slot that is not enabled
   * (verified on fw 3.41 — the read-back stays zero). Newly enabled slots that
   * hold 0 DPI are then seeded from the last previously enabled stage, since an
   * enabled 0-DPI stage would freeze the cursor. The Sniper bit is preserved.
   */
  async setDpiStageCount(count: number): Promise<number> {
    const { stages } = corsairDevice(this.device.productId);
    const maxNumbered = stages - 1;
    if (!Number.isInteger(count) || count < 1 || count > maxNumbered) {
      throw new Error(`This mouse holds between 1 and ${maxNumbered} DPI stages.`);
    }
    return await this.run(async () => {
      await this.open();
      const state = await this.readDpi();
      const numbered = numberedSlots(state.mask, stages);
      const template = numbered.length > 0 ? state.stages.get(numbered[numbered.length - 1]!) : undefined;

      const sniperBit = state.mask & (1 << CORSAIR_SNIPER_STAGE);
      const wanted = sniperBit | (((1 << count) - 1) << 1);
      await this.send(corsairEncode.setDpiMask(wanted));
      const confirmed = corsairDecode.dpiMask(await this.request(corsairEncode.dpiMask()));
      const enabled = numberedSlots(confirmed, stages).length;
      if (enabled !== count) throw new Error(`The mouse kept ${enabled} DPI stages instead of ${count}.`);

      for (let slot = 1; slot <= count; slot += 1) {
        if (numbered.includes(slot)) continue;
        const existing = corsairDecode.stage(await this.request(corsairEncode.stage(slot)));
        if (existing.x > 0 && existing.y > 0) continue;
        const seed = template ?? { x: 800, y: 800, rgb: [0x00, 0xbf, 0xff] as CorsairRgb };
        await this.writeSlot(slot, seed.x, seed.y, seed.rgb);
      }
      // Keep the selection inside the enabled range.
      if (state.current.stage > count) await this.selectSlot(count);
      return enabled;
    });
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    return await this.run(async () => {
      await this.open();
      const state = await this.readDpi();
      const numbered = numberedSlots(state.mask, corsairDevice(this.device.productId).stages);
      const slot = numbered[stage];
      if (slot === undefined) throw new Error(`This mouse does not have a DPI stage ${stage + 1}.`);
      const confirmed = await this.selectSlot(slot);
      return numbered.indexOf(confirmed);
    });
  }

  async setLiftOffDistance(value: CorsairLiftName): Promise<CorsairLiftName> {
    const raw = CORSAIR_LIFT_LEVELS[value];
    if (raw === undefined) throw new Error("Lift-off distance must be Low, Medium, or High.");
    return await this.run(async () => {
      await this.open();
      await this.send(corsairEncode.setLift(raw));
      const confirmed = corsairDecode.lift(await this.request(corsairEncode.lift()));
      const name = corsairLiftName(confirmed);
      if (confirmed !== raw || name === null) {
        throw new Error(`The mouse kept lift-off height ${confirmed} instead of ${raw}.`);
      }
      return name;
    });
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return await this.run(async () => {
      await this.open();
      await this.send(corsairEncode.setSnap(enabled));
      const confirmed = corsairDecode.snap(await this.request(corsairEncode.snap()));
      if (confirmed !== enabled) throw new Error(`The mouse kept angle snapping ${confirmed ? "on" : "off"}.`);
      return confirmed;
    });
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async readStatusDirect(): Promise<MouseStatus> {
    const definition = corsairDevice(this.device.productId);
    const ident = corsairDecode.ident(await this.request(corsairEncode.ident()));
    const dpi = await this.readDpi().catch(() => null);
    const lift = dpi ? await this.request(corsairEncode.lift()).then(corsairDecode.lift, () => null) : null;
    const snap = dpi ? await this.request(corsairEncode.snap()).then(corsairDecode.snap, () => null) : null;

    const enabled = dpi ? corsairEnabledStages(dpi.mask, definition.stages) : [];
    // Slot 0 is the held-button Sniper stage; the numbered stages iCUE shows are slots 1+.
    const numbered = enabled.filter((slot) => slot !== CORSAIR_SNIPER_STAGE);
    const stageList = numbered.map((slot) => dpi!.stages.get(slot)).filter((stage): stage is CorsairDpiStage => !!stage);
    const activeIndex = dpi ? numbered.indexOf(dpi.current.stage) : -1;
    const displayName = `Corsair ${definition.name}`;

    return {
      brand: "Corsair",
      name: definition.name,
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: dpi?.current.x ?? 0,
      dpiY: dpi?.current.y ?? 0,
      supportsSeparateDpiAxes: true,
      pollingRateHz: ident.pollingRateHz,
      supportedPollingRates: [...SUPPORTED_POLLING_RATES],
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: "USB",
      dpiStages: stageList.map((stage) => stage.x),
      dpiStageColors: stageList.map((stage) => corsairRgbHex(stage.rgb)),
      activeDpiStage: activeIndex >= 0 ? activeIndex : undefined,
      liftOffDistance: lift === null ? null : corsairLiftName(lift),
      supportedLiftOffDistances: [...LIFT_NAMES],
      angleSnapping: snap,
      motionSync: null,
      rippleControl: null,
      firmware: firmwareLines(ident, dpi, enabled, lift),
      ui: {
        family: "corsair",
        settingsReady: dpi !== null,
        valuesVerified: dpi !== null,
        pollingReadOnly: true,
        hideUnsupportedPollingRates: true,
        hideMotionSync: true,
        hideRippleControl: true,
        hideSleepCard: true,
        hideSignalCard: true,
        showAdvancedSection: true,
        pollingNote: "Changing the polling rate makes the mouse re-enumerate; use iCUE for that until reconnect handling lands.",
        statusNote: dpi
          ? "Changes apply to the live profile and are lost when the mouse loses power; the Sniper stage is left untouched."
          : "Identified the mouse but its DPI settings could not be read. Unplug and reconnect the mouse, then add it again.",
        defaultDisplayName: displayName,
        dpiStageEditor: dpi
          ? {
            maxStages: definition.stages - 1,
            countEditable: true,
            minDpi: DPI_MIN,
            maxDpi: definition.dpiMax,
            stepDpi: DPI_OPTION_STEP,
          }
          : undefined,
      },
    };
  }

  /** Mask → current stage → each enabled stage. Any failure aborts the whole DPI read. */
  private async readDpi(): Promise<CorsairDpiState> {
    const definition = corsairDevice(this.device.productId);
    const mask = corsairDecode.dpiMask(await this.request(corsairEncode.dpiMask()));
    const current = corsairDecode.dpiStage(await this.request(corsairEncode.dpiStage()));
    const stages = new Map<number, CorsairDpiStage>();
    for (const stage of corsairEnabledStages(mask, definition.stages)) {
      stages.set(stage, corsairDecode.stage(await this.request(corsairEncode.stage(stage))));
    }
    return { mask, current, stages };
  }

  /** Resolves a 0-based numbered-stage index to its slot and current contents. */
  private async numberedSlot(stage: number): Promise<{ slot: number; entry: CorsairDpiStage }> {
    const mask = corsairDecode.dpiMask(await this.request(corsairEncode.dpiMask()));
    const numbered = numberedSlots(mask, corsairDevice(this.device.productId).stages);
    const slot = numbered[stage];
    if (slot === undefined) throw new Error(`This mouse does not have a DPI stage ${stage + 1}.`);
    const entry = corsairDecode.stage(await this.request(corsairEncode.stage(slot)));
    return { slot, entry };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Writes one slot and reads it back. RGB must always be sent — a stage write
   * without it clears the stage colour — so the current colour is read first
   * when the caller has not supplied one.
   */
  private async writeSlot(slot: number, x: number, y: number, rgb?: CorsairRgb): Promise<CorsairDpiStage> {
    const color = rgb ?? corsairDecode.stage(await this.request(corsairEncode.stage(slot))).rgb;
    await this.send(corsairEncode.setStageDpi(slot, x, y, color));
    const confirmed = corsairDecode.stage(await this.request(corsairEncode.stage(slot)));
    if (confirmed.x !== x || confirmed.y !== y) {
      throw new Error(`The mouse kept ${confirmed.x.toLocaleString()} DPI on stage ${slot} instead of ${x.toLocaleString()}.`);
    }
    if (confirmed.rgb.some((channel, index) => channel !== color[index])) {
      throw new Error(`The mouse kept colour ${corsairRgbHex(confirmed.rgb)} on stage ${slot} instead of ${corsairRgbHex(color)}.`);
    }
    return confirmed;
  }

  private async selectSlot(slot: number): Promise<number> {
    await this.send(corsairEncode.setStage(slot));
    const confirmed = corsairDecode.dpiStage(await this.request(corsairEncode.dpiStage()));
    if (confirmed.stage !== slot) throw new Error(`The mouse stayed on DPI slot ${confirmed.stage} instead of ${slot}.`);
    return confirmed.stage;
  }

  private assertDpi(dpi: number): void {
    const { dpiMax } = corsairDevice(this.device.productId);
    if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > dpiMax) {
      throw new Error(`Corsair DPI must be ${DPI_MIN}–${dpiMax.toLocaleString()}.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /**
   * One GET exchange: send, wait, receive, and require the echo. Chrome hands
   * back the feature buffer without a report-id prefix for id 0; a 65-byte
   * reply with a leading zero is tolerated by stripping it.
   */
  private async request(packet: Uint8Array): Promise<Uint8Array> {
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      await this.send(packet);
      const view = await this.transfer(() => this.device.receiveFeatureReport(CORSAIR_REPORT_ID));
      const reply = stripReportId(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)), packet);
      if (corsairIsEcho(packet, reply)) return reply;
    }
    throw new Error(
      `The Corsair mouse did not answer command 0x${packet[1]!.toString(16).padStart(2, "0")}/0x${packet[2]!.toString(16).padStart(2, "0")}.`,
    );
  }

  /** A SET (or the first half of a GET): send, then leave the device its settle time. */
  private async send(packet: Uint8Array): Promise<void> {
    await this.transfer(() => this.device.sendFeatureReport(CORSAIR_REPORT_ID, buffer(packet)));
    await delay(REPLY_DELAY_MS);
  }

  /** Wraps a transfer so a refused report reads as a fix, not a bare Chrome error. */
  private async transfer<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw corsairTransferError(error);
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

/**
 * Chrome reports a refused feature-report transfer as a `NotAllowedError`
 * whose message is only "Failed to write the feature report." Verified on
 * hardware: that is what MI_00's usage-3 collection answers (it has no feature
 * report), while the usage-4 interface keeps working with iCUE running. So the
 * likely fix is picking the other interface; closing iCUE is the fallback.
 */
export function corsairTransferError(error: unknown): Error {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  if (name !== "NotAllowedError") return error instanceof Error ? error : new Error(detail);
  return new Error(
    "Chrome refused the Corsair mouse's feature report. Remove the device and add it again, choosing the "
      + "entry that lists usage 4 (the config interface). If that entry was already selected, close iCUE "
      + "and stop the \"Corsair Service\" Windows service, then reconnect. "
      + `(${detail})`,
  );
}

/** Enabled slots other than the Sniper slot, in slot order. */
function numberedSlots(mask: number, stages: number): number[] {
  return corsairEnabledStages(mask, stages).filter((slot) => slot !== CORSAIR_SNIPER_STAGE);
}

function firmwareLines(
  ident: CorsairIdent,
  dpi: CorsairDpiState | null,
  enabled: number[],
  lift: number | null,
): string[] {
  const lines = [
    `Firmware ${corsairFormatVersion(ident.firmware)}`,
    `Bootloader ${corsairFormatVersion(ident.bootloader)}`,
  ];
  if (dpi) {
    const describe = (slot: number): string => {
      const stage = dpi.stages.get(slot);
      if (!stage) return "?";
      const value = stage.x === stage.y ? `${stage.x}` : `${stage.x}×${stage.y}`;
      return `${value} ${corsairRgbHex(stage.rgb)}`;
    };
    const sniper = enabled.includes(CORSAIR_SNIPER_STAGE) ? [`Sniper ${describe(CORSAIR_SNIPER_STAGE)}`] : [];
    const stages = enabled
      .filter((slot) => slot !== CORSAIR_SNIPER_STAGE)
      .map((slot) => `${slot}: ${describe(slot)}`);
    lines.push(...sniper);
    if (stages.length > 0) lines.push(`DPI stages ${stages.join(", ")}`);
  }
  if (lift !== null) lines.push(`Lift-off height ${lift}`);
  return lines;
}

function hasConfigCollection(items: readonly HIDCollectionInfo[]): boolean {
  return items.some((collection) =>
    (collection.usagePage === CORSAIR_USAGE_PAGE
      && collection.usage === CORSAIR_CONFIG_USAGE
      && collection.featureReports.some((report) => report.reportId === CORSAIR_REPORT_ID))
    || hasConfigCollection(collection.children));
}

function stripReportId(reply: Uint8Array, request: Uint8Array): Uint8Array {
  if (reply.length === 65 && reply[0] === CORSAIR_REPORT_ID && reply[1] === request[0]) return reply.subarray(1);
  return reply;
}

function buffer(payload: Uint8Array): ArrayBuffer {
  return new Uint8Array(payload).buffer;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
