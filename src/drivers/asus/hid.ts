import type { MouseStatus } from "../mouse-types.ts";

import {
  ASUS_GLADIUS_II_USAGE,
  ASUS_GLADIUS_II_USAGE_PAGE,
  ASUS_REPORT_ID,
  ASUS_REPORT_SIZE,
  ASUS_VENDOR_ID,
  GLADIUS_II_DPI_STEP,
  GLADIUS_II_MAX_DPI,
  GLADIUS_II_MIN_DPI,
  GLADIUS_II_POLLING_RATES,
  ROG_GLADIUS_II_PRODUCT_ID,
  decodeGladiusIIProfile,
  decodeGladiusIISettings,
  gladiusIIReadProfileRequest,
  gladiusIIReadSettingsRequest,
  gladiusIISetDpiRequest,
  gladiusIISetPollingRateRequest,
  gladiusIISaveRequest,
} from "../../asus/index.ts";

const RESPONSE_TIMEOUT_MS = 1000;

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(
    view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ),
  );
}

function hasConfigCollection(
  collections: readonly HIDCollectionInfo[],
): boolean {
  return collections.some((collection) => {
    const correctCollection =
      collection.usagePage === ASUS_GLADIUS_II_USAGE_PAGE &&
      collection.usage === ASUS_GLADIUS_II_USAGE;

    if (correctCollection) {
      const hasInput = collection.inputReports.some(
        (report) => report.reportId === ASUS_REPORT_ID,
      );

      const hasOutput = collection.outputReports.some(
        (report) => report.reportId === ASUS_REPORT_ID,
      );

      if (hasInput && hasOutput) {
        return true;
      }
    }

    return hasConfigCollection(collection.children);
  });
}

export class AsusGladiusIIHidClient {
  readonly device: HIDDevice;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return (
      device.vendorId === ASUS_VENDOR_ID &&
      device.productId === ROG_GLADIUS_II_PRODUCT_ID &&
      hasConfigCollection(device.collections)
    );
  }

  async open(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
  }

  async close(): Promise<void> {
    if (this.device.opened) {
      await this.device.close();
    }
  }

  getDpiOptions(): number[] {
    const values: number[] = [];

    for (
      let dpi = GLADIUS_II_MIN_DPI;
      dpi <= GLADIUS_II_MAX_DPI;
      dpi += GLADIUS_II_DPI_STEP
    ) {
      values.push(dpi);
    }

    return values;
  }

  getSupportedPollingRates(): number[] {
    return [...GLADIUS_II_POLLING_RATES];
  }

  private async run<T>(
    task: () => Promise<T>,
  ): Promise<T> {
    const started = this.queue.then(
      task,
      task,
    );

    this.queue = started.catch(
      () => undefined,
    );

    return started;
  }

  private async exchange(
    request: Uint8Array,
    matches: (reply: Uint8Array) => boolean,
  ): Promise<Uint8Array> {
    return this.run(async () => {
      await this.open();

      return new Promise<Uint8Array>(
        (resolve, reject) => {
          const cleanup = (): void => {
            clearTimeout(timer);

            this.device.removeEventListener(
              "inputreport",
              listener,
            );
          };

          const listener = (
            event: HIDInputReportEvent,
          ): void => {
            if (
              event.reportId !== ASUS_REPORT_ID
            ) {
              return;
            }

            const data = copyDataView(
              event.data,
            );

            if (
              data.length < ASUS_REPORT_SIZE
            ) {
              return;
            }

            if (!matches(data)) {
              return;
            }

            cleanup();

            resolve(
              data.subarray(
                0,
                ASUS_REPORT_SIZE,
              ),
            );
          };

          const timer = setTimeout(() => {
            this.device.removeEventListener(
              "inputreport",
              listener,
            );

            reject(
              new Error(
                "ROG Gladius II did not answer the HID request.",
              ),
            );
          }, RESPONSE_TIMEOUT_MS);

          this.device.addEventListener(
            "inputreport",
            listener,
          );

          /*
           * WebHID's BufferSource typing requires
           * a real ArrayBuffer rather than the
           * potentially SharedArrayBuffer-backed
           * Uint8Array TypeScript allows here.
           */
          const payload = new ArrayBuffer(
            request.byteLength,
          );

          new Uint8Array(payload).set(
            request,
          );

          this.device
            .sendReport(
              ASUS_REPORT_ID,
              payload,
            )
            .catch(
              (error: unknown) => {
                cleanup();
                reject(error);
              },
            );
        },
      );
    });
  }

  private async readSettings(): Promise<
    ReturnType<
      typeof decodeGladiusIISettings
    >
  > {
    const response =
      await this.exchange(
        gladiusIIReadSettingsRequest(),
        (data) =>
          data[0] === 0x12 &&
          data[1] === 0x04 &&
          data[2] === 0x00,
      );

    return decodeGladiusIISettings(
      response,
    );
  }

  private async readProfile(): Promise<
    ReturnType<
      typeof decodeGladiusIIProfile
    >
  > {
    const response =
      await this.exchange(
        gladiusIIReadProfileRequest(),
        (data) =>
          data[0] === 0x12 &&
          data[1] === 0x00 &&
          data[2] === 0x00,
      );

    return decodeGladiusIIProfile(
      response,
    );
  }

  async setDpi(
    dpi: number,
  ): Promise<number> {
    if (
      !this.getDpiOptions().includes(
        dpi,
      )
    ) {
      throw new Error(
        `${dpi} DPI is not supported by the ROG Gladius II.`,
      );
    }

    /*
     * The mouse has two DPI stages.
     * Change whichever one is active now.
     */
    const profile =
      await this.readProfile();

    const stage =
      profile.activeDpiStage;

    await this.exchange(
      gladiusIISetDpiRequest(
        stage,
        dpi,
      ),
      (data) =>
        data[0] === 0x51 &&
        data[1] === 0x31 &&
        data[2] === stage,
    );

    /*
     * Commit the change to the mouse.
     */
    await this.exchange(
      gladiusIISaveRequest(),
      (data) =>
        data[0] === 0x50 &&
        data[1] === 0x03,
    );

    /*
     * Read the mouse again so we know
     * the requested DPI really stuck.
     */
    const confirmedSettings =
      await this.readSettings();

    const confirmed =
      confirmedSettings.dpiStages[
        stage
      ];

    if (confirmed !== dpi) {
      throw new Error(
        `ROG Gladius II kept ${confirmed} DPI instead of ${dpi} DPI.`,
      );
    }

    return confirmed;
  }

  async setPollingRate(
    rate: number,
  ): Promise<number> {
    if (
      !this
        .getSupportedPollingRates()
        .includes(rate)
    ) {
      throw new Error(
        `${rate} Hz is not supported by the ROG Gladius II.`,
      );
    }

    await this.exchange(
      gladiusIISetPollingRateRequest(
        rate,
      ),
      (data) =>
        data[0] === 0x51 &&
        data[1] === 0x31 &&
        data[2] === 0x02,
    );

    /*
     * Commit the new polling rate.
     */
    await this.exchange(
      gladiusIISaveRequest(),
      (data) =>
        data[0] === 0x50 &&
        data[1] === 0x03,
    );

    /*
     * Verify by reading the hardware.
     */
    const confirmedSettings =
      await this.readSettings();

    if (
      confirmedSettings.pollingRateHz !==
      rate
    ) {
      throw new Error(
        `ROG Gladius II kept ${confirmedSettings.pollingRateHz} Hz instead of ${rate} Hz.`,
      );
    }

    return confirmedSettings.pollingRateHz;
  }

  async readStatus(): Promise<MouseStatus> {
    /*
     * These are sequential because both
     * commands share the same HID input
     * response channel.
     */
    const settings =
      await this.readSettings();

    const profile =
      await this.readProfile();

    const dpi =
      settings.dpiStages[
        profile.activeDpiStage
      ];

    return {
      brand: "ASUS",
      name: "ROG Gladius II",

      ui: {
        family: "asus-gladius-ii",

        settingsReady: true,
        valuesVerified: true,

        hideUnsupportedPollingRates:
          true,

        statusNote:
          "DPI and polling rate changes are supported.",

        defaultDisplayName:
          "ROG Gladius II",
      },

      batteryPercent: null,
      batteryState: "Unknown",

      dpi,

      dpiStages: [
        ...settings.dpiStages,
      ],

      activeDpiStage:
        profile.activeDpiStage,

      pollingRateHz:
        settings.pollingRateHz,

      supportedPollingRates:
        this.getSupportedPollingRates(),

      activeProfile:
        profile.onboardProfile,

      connectionType: "Wired",
      connectionDetail: "Wired USB",

      debounceMs:
        settings.debounceMs,

      angleSnapping:
        settings.angleSnapping,

      liftOffDistance: null,

      firmware: [],
    };
  }
}