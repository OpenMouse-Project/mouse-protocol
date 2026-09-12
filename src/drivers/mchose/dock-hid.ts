import {
  MCHOSE_DOCK_COMMAND,
  MCHOSE_DOCK_COLOR_MODES,
  MCHOSE_DOCK_LEVELS,
  MCHOSE_DOCK_MODE_LABELS,
  MCHOSE_DOCK_PRODUCT_ID,
  MCHOSE_DOCK_REPORT_ID,
  MCHOSE_DOCK_USAGE,
  MCHOSE_DOCK_USAGE_PAGE,
  mchoseDockColorFromHex,
  mchoseDockColorToHex,
  mchoseDockDecodeLighting,
  mchoseDockEffectFor,
  mchoseDockEncode,
  mchoseDockEncodeLighting,
  mchoseDockModeLabel,
  mchoseDockPayload,
  type MchoseDockLighting,
} from "@openmouse/protocol/mchose";
import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.ts";
import { VENDOR_ID } from "../vendors.ts";

/**
 * MCHOSE MagDock — the charging base, which is where this family's RGB lives.
 * The A7 V2 mice have no controllable LEDs of their own.
 *
 * It is not a mouse, so it follows the non-mouse pattern: a `MouseStatus` with
 * `ui.settingsReady: false` so the settings grid stays hidden, carrying only
 * the lighting the device actually has.
 */

const REPLY_TIMEOUT_MS = 700;
const WRITE_SETTLE_MS = 400;
const READ_ATTEMPTS = 6;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export class MchoseDockHidClient {
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();
  private lastKnown: MchoseDockLighting | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === MCHOSE_DOCK_USAGE_PAGE
        && collection.usage === MCHOSE_DOCK_USAGE)
      || collection.children.some(search);
    return device.vendorId === VENDOR_ID.mchose
      && device.productId === MCHOSE_DOCK_PRODUCT_ID
      && device.collections.some(search);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.lastKnown = null;
    if (this.device.opened) await this.device.close();
  }

  /** The dock pushes no unsolicited state the panel can use. */
  async startNotifications(): Promise<boolean> {
    return false;
  }

  displayName(): string {
    return this.device.productName?.trim() || "MCHOSE MagDock";
  }

  /** Called for every connected client, dock or not. */
  getDpiOptions(): number[] {
    return [];
  }

  /** Send a request and wait for the matching reply on the input report. */
  private request(command: number, params: readonly number[] = []): Promise<Uint8Array | null> {
    const run = async (): Promise<Uint8Array | null> => {
      const frame = mchoseDockEncode(command, params);
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
        const reply = await new Promise<Uint8Array | null>((resolve) => {
          const timer = setTimeout(() => {
            this.device.removeEventListener("inputreport", listener);
            resolve(null);
          }, REPLY_TIMEOUT_MS);
          const listener = (event: Event): void => {
            const report = event as HIDInputReportEvent;
            const payload = mchoseDockPayload(new Uint8Array(report.data.buffer), command);
            if (!payload) return;
            clearTimeout(timer);
            this.device.removeEventListener("inputreport", listener);
            resolve(payload);
          };
          this.device.addEventListener("inputreport", listener);
          this.device.sendReport(MCHOSE_DOCK_REPORT_ID, frame).catch(() => {
            clearTimeout(timer);
            this.device.removeEventListener("inputreport", listener);
            resolve(null);
          });
        });
        if (reply) return reply;
      }
      return null;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readLighting(): Promise<MchoseDockLighting | null> {
    await this.open();
    const payload = await this.request(MCHOSE_DOCK_COMMAND.readLighting);
    const decoded = payload ? mchoseDockDecodeLighting(payload) : null;
    if (decoded) this.lastKnown = decoded;
    return decoded;
  }

  async readStatus(): Promise<MouseStatus> {
    const lighting = await this.readLighting();

    return {
      brand: "MCHOSE",
      name: this.displayName(),
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      liftOffDistance: null,
      connectionType: "Wired",
      firmware: [],
      lighting: lighting ? this.toMouseLighting(lighting) : undefined,
      ui: {
        family: "mchose-dock",
        // Not a mouse: the settings grid would render nothing but blanks.
        settingsReady: false,
        defaultDisplayName: "MCHOSE MagDock",
        statusNote: lighting
          // Not just the V2's base: an A7 V3 owner's MagDock enumerates
          // identically and reads correctly through this same driver.
          ? "Charging base — lighting only. The A7 mice have no LEDs of their own."
          : "Charging base — the lighting state could not be read.",
      },
    };
  }

  private toMouseLighting(state: MchoseDockLighting): MouseLighting {
    const modes = MCHOSE_DOCK_MODE_LABELS.map(([, label]) => label as MouseLightingMode);
    return {
      zone: "Base",
      modes: ["Off", ...modes],
      mode: state.enabled ? (mchoseDockModeLabel(state.effect) as MouseLightingMode) : "Off",
      color: mchoseDockColorToHex(state.color),
      color2: null,
      colorModes: MCHOSE_DOCK_COLOR_MODES as MouseLightingMode[],
      dualColorModes: [],
      reactiveModes: [],
      speeds: [...MCHOSE_DOCK_LEVELS],
      speed: state.speed,
      brightness: state.brightness,
      brightnessLevels: [...MCHOSE_DOCK_LEVELS],
    };
  }

  /**
   * The dock takes its whole lighting block in one write, so anything the panel
   * does not specify is carried over from the last read rather than zeroed.
   */
  async setLighting(next: MouseLighting): Promise<void> {
    const current = this.lastKnown ?? await this.readLighting();
    if (!current) throw new Error("The dock did not report its lighting state.");

    const off = next.mode === "Off";
    const effect = off ? current.effect : mchoseDockEffectFor(next.mode ?? "") ?? current.effect;
    const color = next.color ? mchoseDockColorFromHex(next.color) : null;

    const state: MchoseDockLighting = {
      enabled: !off,
      effect,
      effectCount: current.effectCount,
      speed: next.speed ?? current.speed,
      brightness: next.brightness ?? current.brightness,
      // The music effect is what the sync flag is for.
      musicSync: effect === mchoseDockEffectFor("Reactive"),
      color: color ?? current.color,
      direction: current.direction,
    };

    await this.open();
    const frame = mchoseDockEncodeLighting(state);
    const send = async (): Promise<void> => {
      await this.device.sendReport(MCHOSE_DOCK_REPORT_ID, frame);
      await delay(WRITE_SETTLE_MS);
    };
    const queued = this.queue.then(send, send);
    this.queue = queued.catch(() => undefined);
    await queued;

    const after = await this.readLighting();
    if (!after) throw new Error("The dock did not confirm the lighting change.");
    if (after.enabled !== state.enabled || (state.enabled && after.effect !== state.effect)) {
      throw new Error("The dock did not accept the lighting change.");
    }
  }
}
