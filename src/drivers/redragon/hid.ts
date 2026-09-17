import type { MouseStatus } from "../mouse-types.js";
import {
  REDRAGON_COMMIT_CODES,
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_POLLING_RATES,
  REDRAGON_PRODUCTS,
  REDRAGON_PRODUCT_IDS,
  REDRAGON_PROFILE0,
  REDRAGON_PROFILE0_DPI_SUBCMDS,
  REDRAGON_REPORT_ID,
  REDRAGON_VENDOR_ID,
  redragonEncodeCommit,
  redragonEncodeDpiSlot,
  redragonEncodePollingRate,
  redragonHello,
  redragonSession,
} from "@openmouse/protocol/redragon";

/** RDCfg gaps consecutive writes ~8-18 ms; stay well above that. */
const WRITE_DELAY_MS = 30;
/** Factory DPI table a default RDCfg pushes (level 1 is 1200 out of the box). */
const FACTORY_STAGES = [1200, 2400, 3500, 5500, 12400];
const DEFAULT_POLLING_HZ = 1000;

function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === REDRAGON_CONFIG_USAGE_PAGE &&
      collection.usage === REDRAGON_CONFIG_USAGE &&
      (collection.featureReports ?? []).some((report) => report.reportId === REDRAGON_REPORT_ID)) ||
    hasConfigCollection(collection.children ?? []));
}

/**
 * Redragon K1NG 1K (M724, `04d9:fc7a`) WebHID control.
 *
 * Transport: Holtek vendor collection `0xFFA0:0x01` on USB interface 2,
 * 16-byte numbered feature report 2, `SET_FEATURE` writes of the form
 * `[F3 sub profile section ...]` (see `@openmouse/protocol/redragon`).
 * The device STALLs malformed writes and never answers reads: RDCfg pushes
 * its whole profile table at startup and issues no `GET_REPORT` at all, so
 * this driver is write-only like the SteelSeries Rival 3. `readStatus`
 * therefore reports this session's last-written stages (or the factory
 * table before any write) with `valuesVerified: false`, and the only
 * hardware probe is the `FA FA` marker every `GET_FEATURE` echo carries.
 */
export class RedragonHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStages: number[] | null = null;
  private lastPollingHz: number | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== REDRAGON_VENDOR_ID) return false;
    if (!REDRAGON_PRODUCT_IDS.includes(device.productId)) return false;
    return hasConfigCollection(device.collections);
  }

  get supportedPollingRates(): number[] {
    return [...REDRAGON_POLLING_RATES];
  }

  getDpiOptions(): number[] {
    return [200, 400, 800, 1200, 1600, 2000, 2400, 3200, 3500, 4000, 5500, 6400, 8000, 10000, 12400];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      await this.probeConfigChannel();
      const product = REDRAGON_PRODUCTS.get(this.device.productId);
      // The firmware reports a generic "USB Gaming Mouse" product string,
      // so prefer the catalog name whenever the PID is known.
      const name = product ? `Redragon ${product.name}` : (this.device.productName?.trim() || "Redragon Mouse");
      const stages = this.lastStages ?? [...FACTORY_STAGES];
      return {
        brand: "Redragon",
        name,
        ui: {
          family: "redragon",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The M724 never reports its polling rate; the value shown is this session's last write, or 1000 Hz before any write.",
          statusNote: "The K1NG 1K never reports settings back; values shown are this session's last writes, or the factory table before any write.",
          dpiStageEditor: {
            maxStages: REDRAGON_PROFILE0_DPI_SUBCMDS.length,
            countEditable: false,
            minDpi: 50,
            maxDpi: product?.maxDpi ?? 12400,
            stepDpi: 50,
          },
          defaultDisplayName: `Redragon ${product?.name ?? "Mouse"}`,
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: stages[0] ?? FACTORY_STAGES[0]!,
        dpiStages: stages,
        pollingRateHz: this.lastPollingHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  /**
   * Writes the whole profile-1 DPI table in one vendor session bracket,
   * closed by the commit block. Bisected live: RDCfg re-pushes the table on
   * every Apply and the change is felt immediately; a lone slot write is
   * stored but only takes effect at boot, and the trailing `F1` block is
   * what activates it. Sibling stages come from this session's cache
   * (factory table before any write): editing in RDCfg meanwhile makes the
   * cache stale, exactly like any write-only driver.
   */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_PROFILE0_DPI_SUBCMDS.length) {
      throw new Error(`Redragon DPI stage ${stage} is out of range 0-4.`);
    }
    // Validates the DPI before anything is sent.
    redragonEncodeDpiSlot(REDRAGON_PROFILE0, stage, dpi);
    await this.run(async () => {
      await this.open();
      const next = this.lastStages ?? [...FACTORY_STAGES];
      next[stage] = dpi;
      await this.sendSessionFrame(true);
      for (let level = 0; level < REDRAGON_PROFILE0_DPI_SUBCMDS.length; level++) {
        await this.sendFrame(redragonEncodeDpiSlot(REDRAGON_PROFILE0, level, next[level]!));
      }
      for (const code of REDRAGON_COMMIT_CODES) {
        await this.sendFrame(redragonEncodeCommit(code));
      }
      await this.sendSessionFrame(false);
      this.lastStages = next;
    });
    return dpi;
  }

  /**
   * Writes the polling rate inside the same session bracket + commit block
   * as DPI writes (the vendor sends it mid-push; the trailing `F1` block is
   * what activates writes, verified live for DPI).
   */
  async setPollingRate(hz: number): Promise<number> {
    const frame = redragonEncodePollingRate(hz);
    await this.run(async () => {
      await this.open();
      await this.sendSessionFrame(true);
      await this.sendFrame(frame);
      for (const code of REDRAGON_COMMIT_CODES) {
        await this.sendFrame(redragonEncodeCommit(code));
      }
      await this.sendSessionFrame(false);
      this.lastPollingHz = hz;
    });
    return hz;
  }

  /**
   * The `FA FA` echo every `GET_FEATURE` carries doubles as the proof that
   * the granted interface is the config channel: the mouse and keyboard
   * interfaces expose no feature report 2 at all. The marker is matched as
   * the last two payload bytes so both WebHID framings (report id stripped
   * or kept) validate.
   */
  private async probeConfigChannel(): Promise<void> {
    const view = await this.device.receiveFeatureReport(REDRAGON_REPORT_ID);
    const echo = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    console.debug("[redragon] feature2 echo", [...echo].map((b) => b.toString(16).padStart(2, "0")).join(" "));
    const marker = echo.length >= 2 && echo[echo.length - 2] === 0xfa && echo[echo.length - 1] === 0xfa;
    if (!marker) {
      throw new Error(
        `The Redragon config channel answered ${echo.length} bytes without its FA FA marker (see console "[redragon] feature2 echo"). Add the device again and choose the entry backed by the vendor interface.`,
      );
    }
  }

  private async sendFrame(frame: Uint8Array): Promise<void> {
    await this.device.sendFeatureReport(REDRAGON_REPORT_ID, frame.slice(1).buffer as ArrayBuffer);
    await this.delay(WRITE_DELAY_MS);
  }

  private async sendSessionFrame(begin: boolean): Promise<void> {
    await this.sendFrame(begin ? redragonHello() : redragonSession(false));
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
