import type { MouseStatus, MouseLighting } from "../mouse-types.js";
import {
  REDGEAR_X13_VENDOR_ID,
  REDGEAR_X13_PRODUCT_ID,
  REDGEAR_X13_USAGE_PAGE,
  REDGEAR_X13_USAGE,
  REDGEAR_X13_STATUS_REPORT_ID,
  REDGEAR_X13_STATUS_BYTES,
  REDGEAR_X13_SUPPORT,
  REDGEAR_X13_DPI,
  REDGEAR_X13_RATES,
  redgearDecodeStatusPayload,
  redgearDecodeSettings,
  redgearEncodeDpi,
  redgearEncodePollingRate,
  redgearEncodeStaticColor,
  redgearDecodeStaticColor,
  redgearDecodeButtons,
  redgearEncodeButton,
  X13_BUTTON_NAMES,
  X13_BUTTON_ACTIONS,
} from "../../redgear/index.js";

function hasStatusCollection(
  collections: readonly HIDCollectionInfo[],
): boolean {
  return collections.some(
    (collection) =>
      (collection.usagePage === REDGEAR_X13_USAGE_PAGE &&
        collection.usage === REDGEAR_X13_USAGE &&
        collection.featureReports.some(
          (report) =>
            report.reportId === REDGEAR_X13_STATUS_REPORT_ID &&
            report.items.reduce(
              (bits, item) => bits + item.reportSize * item.reportCount,
              0,
            ) ===
              (REDGEAR_X13_STATUS_BYTES - 1) * 8,
        )) ||
      hasStatusCollection(collection.children),
  );
}

/** Report-3 settings client. Only accepted DPI/rate/static-colour fields are writable. */
export class RedgearX13HidClient {
  readonly device: HIDDevice;
  private pending: Promise<MouseStatus> | null = null;
  private generation = 0;
  private readFailed = false;
  private rawStatus: Uint8Array | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private buttons: ReturnType<typeof redgearDecodeButtons> | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return (
      device.vendorId === REDGEAR_X13_VENDOR_ID &&
      device.productId === REDGEAR_X13_PRODUCT_ID &&
      hasStatusCollection(device.collections)
    );
  }

  getDpiOptions(): number[] {
    return [...REDGEAR_X13_DPI];
  }

  setActiveDpiStage(stage: number): Promise<number> {
    if (
      !Number.isInteger(stage) ||
      stage < 0 ||
      stage >= REDGEAR_X13_DPI.length
    )
      return Promise.reject(new RangeError("Invalid X13 Pro DPI stage"));
    return this.setDpi(REDGEAR_X13_DPI[stage]!);
  }

  async open(): Promise<void> {
    if (!RedgearX13HidClient.isSupported(this.device))
      throw new Error("Unsupported X13 Pro HID interface");
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    this.generation++;
    this.rawStatus = null;
    this.readFailed = false;
    this.lastError = null;
    this.buttons = null;
    if (this.device.opened) await this.device.close();
  }

  /** Independent copy for diagnostics; includes the native report ID. */
  getRawStatusReport(): Uint8Array | null {
    return this.rawStatus?.slice() ?? null;
  }

  readStatus(): Promise<MouseStatus> {
    if (this.pending) return this.pending;
    const task = this.serialize(() => this.readStatusNow());
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = null;
      })
      .catch(() => undefined);
    return task;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const task = this.queue.then(() => {
      if (generation !== this.generation)
        throw new Error("X13 Pro disconnected before queued transfer");
      return action();
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async transfer<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (this.readFailed)
      throw new Error(
        "X13 Pro transport unavailable; reconnect before changing settings",
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "X13 Pro transfer timed out; reconnect before retrying",
                ),
              ),
            2000,
          );
        }),
      ]);
      if (generation !== this.generation)
        throw new Error("X13 Pro disconnected during transfer");
      return value;
    } catch (error) {
      if (generation === this.generation) {
        this.readFailed = true;
        this.rawStatus = null;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async freshPayload(): Promise<Uint8Array> {
    const view = await this.transfer(() =>
      this.device.receiveFeatureReport(REDGEAR_X13_STATUS_REPORT_ID),
    );
    const { payload } = redgearDecodeStatusPayload(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
    redgearDecodeSettings(payload);
    return payload;
  }

  setDpi(dpi: number): Promise<number> {
    if (!(REDGEAR_X13_DPI as readonly number[]).includes(dpi))
      return Promise.reject(new RangeError("Unsupported X13 Pro DPI"));
    return this.writeSetting((payload) => redgearEncodeDpi(payload, dpi), dpi);
  }

  setPollingRate(rate: number): Promise<number> {
    if (!(REDGEAR_X13_RATES as readonly number[]).includes(rate))
      return Promise.reject(new RangeError("Unsupported X13 Pro polling rate"));
    return this.writeSetting(
      (payload) => redgearEncodePollingRate(payload, rate),
      rate,
    );
  }

  setLighting(lighting: MouseLighting): Promise<void> {
    if (
      lighting.mode !== "Static" ||
      !lighting.color ||
      !/^#[0-9a-f]{6}$/i.test(lighting.color) ||
      lighting.brightness != null ||
      lighting.speed != null
    )
      return Promise.reject(
        new RangeError(
          "X13 Pro supports only static #rrggbb lighting; brightness/speed are unavailable",
        ),
      );
    const color = lighting.color;
    return this.writeSetting(
      (payload) => redgearEncodeStaticColor(payload, color),
      undefined,
    );
  }

  private async freshButtons(): Promise<Uint8Array> {
    const view = await this.transfer(() => this.device.receiveFeatureReport(4));
    const payload = new Uint8Array(
      view.buffer,
      view.byteOffset,
      view.byteLength,
    ).slice();
    redgearDecodeButtons(payload);
    return payload;
  }

  setButtonMapping(button: string, action: string): Promise<void> {
    if (
      !(X13_BUTTON_NAMES as readonly string[]).includes(button) ||
      !(X13_BUTTON_ACTIONS as readonly string[]).includes(action)
    )
      return Promise.reject(
        new RangeError("Unsupported X13 Pro button/action"),
      );
    return this.serialize(async () => {
      const generation = this.generation;
      await this.open();
      if (generation !== this.generation)
        throw new Error("X13 Pro disconnected before button read");
      const original = await this.freshButtons();
      if (generation !== this.generation)
        throw new Error("X13 Pro disconnected before button write");
      const target = redgearEncodeButton(original, button, action);
      if (target.some((byte, i) => byte !== original[i])) {
        await this.transfer(() =>
          this.device.sendFeatureReport(4, new Uint8Array(target).buffer),
        );
        const actual = await this.freshButtons();
        if (actual.some((byte, i) => byte !== target[i])) {
          this.readFailed = true;
          this.rawStatus = null;
          this.buttons = null;
          this.lastError = "Button read-back mismatch";
          throw new Error(
            "X13 Pro button read-back mismatch; reconnect and inspect the mouse",
          );
        }
      }
      this.buttons = redgearDecodeButtons(target);
    });
  }

  private writeSetting<T>(
    encode: (payload: Uint8Array) => Uint8Array,
    result: T,
  ): Promise<T> {
    return this.serialize(async () => {
      const generation = this.generation;
      await this.open();
      if (generation !== this.generation)
        throw new Error("X13 Pro disconnected while opening");
      const original = await this.freshPayload();
      if (generation !== this.generation)
        throw new Error("X13 Pro disconnected before settings write");
      const target = encode(original);
      if (target.some((byte, index) => byte !== original[index])) {
        await this.transfer(() =>
          this.device.sendFeatureReport(
            REDGEAR_X13_STATUS_REPORT_ID,
            new Uint8Array(target).buffer,
          ),
        );
        const actual = await this.freshPayload();
        if (actual.some((byte, index) => byte !== target[index])) {
          this.readFailed = true;
          this.rawStatus = null;
          this.lastError = "Settings read-back mismatch";
          throw new Error(
            "X13 Pro settings read-back mismatch; reconnect and inspect the mouse before retrying",
          );
        }
      }
      this.rawStatus = new Uint8Array(REDGEAR_X13_STATUS_BYTES);
      this.rawStatus[0] = REDGEAR_X13_STATUS_REPORT_ID;
      this.rawStatus.set(target, 1);
      return result;
    });
  }

  private async readStatusNow(): Promise<MouseStatus> {
    const generation = this.generation;
    await this.open();
    if (generation !== this.generation)
      throw new Error("X13 Pro disconnected while opening");
    let note =
      "DPI, polling, static RGB and standard buttons supported through OpenMouse Bridge. Green/blue channels corrected. Close the vendor app before use. Macros and hardware profiles are unavailable.";
    if (!this.readFailed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const view = await Promise.race([
          this.device.receiveFeatureReport(REDGEAR_X13_STATUS_REPORT_ID),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Status read timed out")),
              2000,
            );
          }),
        ]);
        if (generation !== this.generation)
          throw new Error("X13 Pro disconnected during status read");
        const bytes = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        const { payload } = redgearDecodeStatusPayload(bytes);
        redgearDecodeSettings(payload);
        this.rawStatus = new Uint8Array(REDGEAR_X13_STATUS_BYTES);
        this.rawStatus[0] = REDGEAR_X13_STATUS_REPORT_ID;
        this.rawStatus.set(payload, 1);
        // The button collection is optional; never invent a map if it is absent.
        const offersButtons = (
          collections: readonly HIDCollectionInfo[],
        ): boolean =>
          collections.some(
            (c) =>
              c.featureReports.some(
                (r) =>
                  r.reportId === 4 &&
                  r.items.reduce(
                    (n, item) => n + item.reportSize * item.reportCount,
                    0,
                  ) ===
                    2048 * 8,
              ) || offersButtons(c.children),
          );
        if (offersButtons(this.device.collections)) {
          try {
            this.buttons = redgearDecodeButtons(await this.freshButtons());
          } catch (error) {
            this.buttons = null;
            if (generation !== this.generation) throw error;
          }
        }
      } catch (error) {
        if (generation !== this.generation) throw error;
        // A timed-out transfer cannot be cancelled by WebHID. Do not issue
        // another transfer on this connection; closing/reopening resets it.
        this.readFailed = true;
        this.rawStatus = null;
        this.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (generation !== this.generation)
      throw new Error("X13 Pro disconnected during status read");
    if (this.readFailed)
      note = `Identity only; status read unavailable${this.lastError ? ` (${this.lastError})` : ""}. Reconnect to retry. Settings are disabled.`;
    const settings = this.rawStatus
      ? redgearDecodeSettings(this.rawStatus.subarray(1))
      : null;
    return {
      brand: "Redgear",
      name: REDGEAR_X13_SUPPORT.name,
      ui: {
        family: "redgear-x13",
        settingsReady: settings !== null,
        valuesVerified: settings !== null,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        hideSignalCard: true,
        hideSleepCard: true,
        dpiStageEditor: {
          maxStages: 7,
          countEditable: false,
          minDpi: 400,
          maxDpi: 4800,
          stepDpi: 400,
        },
        defaultDisplayName: REDGEAR_X13_SUPPORT.name,
        statusNote: note,
      },
      batteryPercent: null,
      batteryState: "Unknown",
      // Fallback sentinels remain hidden when the status read is unavailable.
      dpi: settings?.dpi ?? 0,
      pollingRateHz: settings?.pollingRateHz ?? 0,
      ...(settings
        ? {
            dpiStages: [...REDGEAR_X13_DPI],
            activeDpiStage: this.rawStatus![1],
          }
        : {}),
      ...(settings
        ? {
            lighting: {
              zone: "Shell",
              modes: ["Static"],
              ...redgearDecodeStaticColor(this.rawStatus!.subarray(1)),
              color2: null,
              colorModes: ["Static"],
              dualColorModes: [],
              reactiveModes: [],
              speeds: [],
              speed: null,
            } satisfies MouseLighting,
          }
        : {}),
      ...(settings && this.buttons
        ? { ...this.buttons, buttonOptions: [...X13_BUTTON_ACTIONS] }
        : {}),
      supportedPollingRates: [...REDGEAR_X13_RATES],
      activeProfile: null,
      liftOffDistance: null,
      connectionType: "Wired",
      connectionDetail: "USB",
      firmware: [],
    };
  }
}
