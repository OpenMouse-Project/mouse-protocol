import type { MouseStatus } from "../mouse-types.js";
import { KEY_USAGES, NUMPAD_USAGES } from "../../redragon/keys.js";
import {
  UTECHSMART_VENUS_ACTIVE_PROFILE_ADDRESS,
  UTECHSMART_VENUS_BUTTON_ACTIONS,
  UTECHSMART_VENUS_BUTTON_BASES,
  UTECHSMART_VENUS_BUTTON_COUNT,
  UTECHSMART_VENUS_CONFIG_USAGE,
  UTECHSMART_VENUS_CONFIG_USAGE_PAGE,
  UTECHSMART_VENUS_DPI_LABELS,
  UTECHSMART_VENUS_MAX_READ,
  UTECHSMART_VENUS_MAX_STAGES,
  UTECHSMART_VENUS_POLLING_RATES,
  UTECHSMART_VENUS_PRODUCT_ID,
  UTECHSMART_VENUS_PROFILE_BASES,
  UTECHSMART_VENUS_PROFILE_COUNT,
  UTECHSMART_VENUS_REPORT_ID,
  UTECHSMART_VENUS_VENDOR_ID,
  utechsmartVenusButtonActionName,
  utechsmartVenusDecodeStatus,
  utechsmartVenusDecodeRead,
  utechsmartVenusEncodeControl,
  utechsmartVenusEncodeDpi,
  utechsmartVenusEncodePolling,
  utechsmartVenusEncodeRead,
  utechsmartVenusPlanWrite,
  utechsmartVenusReadReportId,
  utechsmartVenusStageAddress,
  type UtechsmartVenusButtonAction,
  type UtechsmartVenusChange,
  type UtechsmartVenusControl,
  type UtechsmartVenusMemory,
  type UtechsmartVenusProfile,
} from "@openmouse/protocol/utechsmart";

const READ_DELAY_MS = 5;
const WRITE_DELAY_MS = 8;
// F1 commit semantics/persistence are UNVERIFIED. Hardware testing will decide
// this list in one place; v1 sends no F1 (and never the F1 00 00 reset).
const COMMIT_AFTER_WRITE: readonly UtechsmartVenusControl[] = [];
// UNVERIFIED: the reverse-engineered tool claims F5 applies polling immediately.
// This is NOT Redragon's F5 session bracket.
const APPLY_POLLING_IMMEDIATELY = true;

// The table has 20 slots; slot 18 is unused and deliberately not remappable.
const BUTTON_NAMES = ["Left", "Right", "Middle", "Fire", "DPI+", "DPI-",
  ...Array.from({ length: 12 }, (_, index) => `Side ${index + 1}`), null, "Profile"] as const;

/** Shared remapper accepts string choices, not structured chords. Offer named
 * codec actions/shortcuts and all left Ctrl/Shift/Alt/GUI combinations per key.
 * The codec's spelling for GUI is Win; keypad keys are included too.
 */
const BUTTON_OPTIONS = new Map<string, UtechsmartVenusButtonAction>();
for (const [name] of UTECHSMART_VENUS_BUTTON_ACTIONS) BUTTON_OPTIONS.set(name, { kind: "action", name });
for (const [, usage] of [...KEY_USAGES, ...NUMPAD_USAGES]) {
  const key = { kind: "key", usage } as const;
  BUTTON_OPTIONS.set(utechsmartVenusButtonActionName(key), key);
  for (let modifiers = 1; modifiers <= 15; modifiers++) {
    const combo = { kind: "combo", modifiers, usage } as const;
    BUTTON_OPTIONS.set(utechsmartVenusButtonActionName(combo), combo);
  }
}

function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === UTECHSMART_VENUS_CONFIG_USAGE_PAGE &&
      collection.usage === UTECHSMART_VENUS_CONFIG_USAGE &&
      (collection.featureReports ?? []).some((report) => report.reportId === UTECHSMART_VENUS_REPORT_ID)) ||
    hasConfigCollection(collection.children ?? []));
}

/** Wired Venus MMO 04d9:fc55, on interface 2's vendor config collection only.
 * Transport/read memory and bare F3 writes are owner-verified; this client has
 * not been tested on hardware. Readback confirms memory, not durable storage
 * or effective sensor/polling behavior. No LEDs, macros or profile switching.
 */
export class UtechsmartVenusHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    if (!UtechsmartVenusHidClient.isSupported(device)) throw new Error("Not a supported UtechSmart Venus config device.");
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === UTECHSMART_VENUS_VENDOR_ID && device.productId === UTECHSMART_VENUS_PRODUCT_ID &&
      hasConfigCollection(device.collections);
  }

  get supportedPollingRates(): number[] { return [...UTECHSMART_VENUS_POLLING_RATES]; }
  getDpiOptions(): number[] { return [...UTECHSMART_VENUS_DPI_LABELS]; }

  async open(): Promise<void> { if (!this.device.opened) await this.device.open(); }
  async close(): Promise<void> { if (this.device.opened) await this.device.close(); }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      const memory = await this.readMemory();
      const profile = this.activeProfile(memory);
      const mappings: Record<string, string> = {};
      const fixedButtons: string[] = [];
      BUTTON_NAMES.forEach((name, slot) => {
        if (name === null) return;
        const action = profile.buttons[slot]!;
        mappings[name] = utechsmartVenusButtonActionName(action);
        if (!BUTTON_OPTIONS.has(mappings[name]!)) fixedButtons.push(name);
      });
      return {
        brand: "UtechSmart",
        name: "UtechSmart Venus MMO",
        ui: {
          family: "utechsmart-venus",
          settingsReady: true,
          valuesVerified: true,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          defaultDisplayName: "UtechSmart Venus MMO",
          dpiStageEditor: {
            // Only the enabled stages are editable; ten-slot capacity is inferred.
            maxStages: profile.stages.length,
            countEditable: false,
            minDpi: UTECHSMART_VENUS_DPI_LABELS[0]!,
            maxDpi: UTECHSMART_VENUS_DPI_LABELS.at(-1)!,
            stepDpi: 100,
          },
          statusNote: "Writes are read back; persistence and immediate polling application are not yet hardware-verified.",
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: profile.stages[profile.currentStage]!.dpi,
        dpiStages: profile.stages.map((stage) => stage.dpi),
        activeDpiStage: profile.currentStage,
        pollingRateHz: profile.pollingHz!,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: profile.index + 1,
        profileCount: UTECHSMART_VENUS_PROFILE_COUNT,
        buttonMappings: mappings,
        buttonOptions: [...BUTTON_OPTIONS.keys()],
        fixedButtons,
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  /** Sibling convention: return the snapped DPI, not a cached status. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    const encoded = utechsmartVenusEncodeDpi(dpi);
    utechsmartVenusStageAddress(0, stage);
    return await this.run(async () => {
      await this.open();
      const memory = await this.readMemory();
      const profile = this.activeProfile(memory).index;
      await this.writeAndConfirm(memory, { kind: "dpi", profile, stage, dpi });
      return encoded.dpi;
    });
  }

  async setPollingRate(hz: number): Promise<number> {
    const polling = utechsmartVenusEncodePolling(hz); // Validate before I/O.
    return await this.run(async () => {
      await this.open();
      const memory = await this.readMemory();
      const profile = this.activeProfile(memory).index;
      await this.writeAndConfirm(memory, { kind: "polling", profile, hz },
        APPLY_POLLING_IMMEDIATELY ? polling : undefined);
      return hz;
    });
  }

  async setButtonMapping(button: string, action: string): Promise<void> {
    const slot = BUTTON_NAMES.findIndex((name) => name === button);
    if (slot < 0) throw new Error(`UtechSmart Venus has no button named "${button}".`);
    const value = BUTTON_OPTIONS.get(action);
    if (!value) throw new Error(`UtechSmart Venus action "${action}" is not offered.`);
    await this.run(async () => {
      await this.open();
      const memory = await this.readMemory();
      const profile = this.activeProfile(memory);
      if (action !== "Left click" && !profile.buttons.some((assigned, index) =>
        index !== slot && BUTTON_NAMES[index] !== null && assigned.kind === "action" && assigned.name === "Left click")) {
        throw new Error("Keep Left click on at least one button, or the mouse cannot click.");
      }
      await this.writeAndConfirm(memory, { kind: "button", profile: profile.index, slot, action: value });
    });
  }

  /** The public status decoder needs all five profiles. Read only known settings
   * ranges (no arbitrary gaps, LED/calibration memory, or trailing button slots).
   */
  private async readMemory(): Promise<UtechsmartVenusMemory> {
    const data = new Uint8Array(UTECHSMART_VENUS_BUTTON_BASES.at(-1)! + 2 + 4 * UTECHSMART_VENUS_BUTTON_COUNT);
    data.set(await this.readRange(UTECHSMART_VENUS_ACTIVE_PROFILE_ADDRESS, 16), UTECHSMART_VENUS_ACTIVE_PROFILE_ADDRESS);
    for (let profile = 0; profile < UTECHSMART_VENUS_PROFILE_COUNT; profile++) {
      const base = UTECHSMART_VENUS_PROFILE_BASES[profile]!;
      data.set(await this.readRange(base, 4 + 6 * UTECHSMART_VENUS_MAX_STAGES), base);
      const buttons = UTECHSMART_VENUS_BUTTON_BASES[profile]!;
      data.set(await this.readRange(buttons, 2 + 4 * UTECHSMART_VENUS_BUTTON_COUNT), buttons);
    }
    return { address: 0, data };
  }

  private activeProfile(memory: UtechsmartVenusMemory): UtechsmartVenusProfile {
    const status = utechsmartVenusDecodeStatus(memory);
    const profile = status.profiles[status.activeProfile]!;
    if (profile.pollingHz === null) throw new Error(`UtechSmart Venus reported invalid polling code ${profile.pollingCode}.`);
    return profile;
  }

  private async readRange(address: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += UTECHSMART_VENUS_MAX_READ) {
      out.set(await this.readBytes(address + offset, Math.min(UTECHSMART_VENUS_MAX_READ, length - offset)), offset);
    }
    return out;
  }

  private async readBytes(address: number, length: number): Promise<Uint8Array> {
    await this.sendFrame(utechsmartVenusEncodeRead(address, length));
    const view = await this.device.receiveFeatureReport(utechsmartVenusReadReportId(length));
    // Windows/Chrome includes the report id; codec accepts both forms. Respect
    // the DataView bounds, as with the sibling Holtek transport.
    const answer = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    return utechsmartVenusDecodeRead(answer, address, length);
  }

  private async writeAndConfirm(memory: UtechsmartVenusMemory, change: UtechsmartVenusChange, polling?: Uint8Array): Promise<void> {
    const frames = utechsmartVenusPlanWrite(memory, change);
    for (const frame of frames) await this.sendFrame(frame);
    if (frames.length > 0) {
      for (const control of COMMIT_AFTER_WRITE) await this.sendFrame(utechsmartVenusEncodeControl(control));
    }
    if (polling) await this.sendFrame(polling);
    for (const frame of frames) {
      const address = frame[2]! | (frame[3]! << 8);
      const expected = frame.slice(8, 8 + frame[4]!);
      const actual = await this.readBytes(address, expected.length);
      if (actual.some((byte, index) => byte !== expected[index])) {
        throw new Error(`UtechSmart Venus readback mismatch at 0x${address.toString(16)}: expected ${[...expected]}, got ${[...actual]}.`);
      }
    }
  }

  private async sendFrame(frame: Uint8Array): Promise<void> {
    await this.device.sendFeatureReport(UTECHSMART_VENUS_REPORT_ID, frame.slice(1).buffer as ArrayBuffer);
    await new Promise((resolve) => setTimeout(resolve, frame[1] === 0xf2 ? READ_DELAY_MS : WRITE_DELAY_MS));
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
