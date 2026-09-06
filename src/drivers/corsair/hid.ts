import type { MouseStatus } from "../mouse-types.ts";
import {
  CORSAIR_CONFIG_USAGE,
  CORSAIR_PRODUCTS,
  CORSAIR_REPORT_ID,
  CORSAIR_SNIPER_STAGE,
  CORSAIR_USAGE_PAGE,
  CORSAIR_VENDOR_ID,
  type CorsairDpiStage,
  type CorsairIdent,
  corsairDecode,
  corsairDevice,
  corsairEnabledStages,
  corsairEncode,
  corsairFormatVersion,
  corsairIsEcho,
  corsairRgbHex,
} from "@openmouse/protocol/corsair";

/**
 * Corsair NIGHTSWORD RGB — read-only WebHID client (phase 1).
 *
 * Talks to the config interface (usage page 0xffc2, usage 4) through 64-byte
 * feature reports on report id 0. Every GET is send → short wait → receive,
 * and the reply must echo the request's first four bytes; a stale buffer from
 * the previous GET fails that check and the request is retried. All traffic
 * goes through one queue because the device has a single reply buffer.
 *
 * Reads are best-effort past identity: if the DPI fields cannot be read the
 * status still identifies the mouse (`ui.settingsReady = false` either way —
 * nothing here writes). Live values are the software profile iCUE would show;
 * they reset to the onboard profile on power cycle.
 *
 * iCUE's service keeps this interface open too. Reads have been observed to
 * coexist with it (shared mode, iCUE actively re-applying its profile). If
 * Chrome ever refuses a transfer with a bare `NotAllowedError`, that is mapped
 * to a "close iCUE" message; the more common cause of that error is being
 * granted MI_00's usage-3 collection, which `isSupported()` now rejects.
 */

const PRODUCT_IDS = new Set<number>(CORSAIR_PRODUCTS.keys());
/** Gap between sendFeatureReport and receiveFeatureReport; ~20 ms was reliable on fw 3.41. */
const REPLY_DELAY_MS = 20;
const REQUEST_ATTEMPTS = 3;
const SUPPORTED_POLLING_RATES = [1000, 500, 250, 125] as const;

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

  /** Read-only: nothing to offer the DPI picker. */
  getDpiOptions(): number[] { return []; }

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
      activeDpiStage: activeIndex >= 0 ? activeIndex : undefined,
      liftOffDistance: null,
      angleSnapping: snap,
      motionSync: null,
      rippleControl: null,
      firmware: firmwareLines(ident, dpi, enabled, lift),
      ui: {
        family: "corsair",
        settingsReady: false,
        valuesVerified: dpi !== null,
        pollingReadOnly: true,
        hideUnsupportedPollingRates: true,
        hideMotionSync: true,
        hideRippleControl: true,
        hideSleepCard: true,
        hideSignalCard: true,
        statusNote: dpi
          ? "Read-only for now: live DPI stages, polling rate, lift-off height, and angle snapping are shown but cannot be changed."
          : "Identified the mouse but its DPI settings could not be read. Unplug and reconnect the mouse, then add it again.",
        defaultDisplayName: displayName,
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

  /**
   * One GET exchange: send, wait, receive, and require the echo. Chrome hands
   * back the feature buffer without a report-id prefix for id 0; a 65-byte
   * reply with a leading zero is tolerated by stripping it.
   */
  private async request(packet: Uint8Array): Promise<Uint8Array> {
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      await this.transfer(() => this.device.sendFeatureReport(CORSAIR_REPORT_ID, buffer(packet)));
      await delay(REPLY_DELAY_MS);
      const view = await this.transfer(() => this.device.receiveFeatureReport(CORSAIR_REPORT_ID));
      const reply = stripReportId(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)), packet);
      if (corsairIsEcho(packet, reply)) return reply;
    }
    throw new Error(
      `The Corsair mouse did not answer command 0x${packet[1]!.toString(16).padStart(2, "0")}/0x${packet[2]!.toString(16).padStart(2, "0")}.`,
    );
  }

  /** Wraps a transfer so iCUE holding the interface reads as a fix, not a bare Chrome error. */
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
