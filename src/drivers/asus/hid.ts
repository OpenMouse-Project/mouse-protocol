import type {
  MouseLighting,
  MouseLightingMode,
  MouseStatus,
} from "../mouse-types.ts";

import {
  ASUS_GLADIUS_II_USAGE,
  ASUS_GLADIUS_II_USAGE_PAGE,
  ASUS_REPORT_ID,
  ASUS_REPORT_SIZE,
  ASUS_VENDOR_ID,
  GLADIUS_II_DEBOUNCE_MS,
  GLADIUS_II_DPI_STEP,
  GLADIUS_II_MAX_DPI,
  GLADIUS_II_MIN_DPI,
  GLADIUS_II_POLLING_RATES,
  GLADIUS_II_PROFILE_COUNT,
  ROG_GLADIUS_II_PRODUCT_ID,
  decodeGladiusIILiftOffDistance,
  decodeGladiusIILighting,
  decodeGladiusIIProfile,
  decodeGladiusIISettings,
  gladiusIIReadLiftOffRequest,
  gladiusIIReadLightingRequest,
  gladiusIIReadProfileRequest,
  gladiusIIReadSettingsRequest,
  gladiusIISaveRequest,
  gladiusIISetActiveDpiStageRequest,
  gladiusIISetAngleSnappingRequest,
  gladiusIISetDebounceRequest,
  gladiusIISetDpiRequest,
  gladiusIISetLiftOffRequest,
  gladiusIISetLightingRequest,
  gladiusIISetPollingRateRequest,
  gladiusIISetProfileRequest,
  type GladiusIIRawLightingZone,
} from "../../asus/index.ts";

const RESPONSE_TIMEOUT_MS = 1000;

const RGB_ZONE_NAMES = [
  "Logo",
  "Scroll wheel",
  "Underglow",
] as const;

const LIGHTING_MODES: readonly MouseLightingMode[] = [
  "Static",
  "Breathing single",
  "Cycling",
  "Spectrum",
  "Reactive",
  "Wave",
];

const COLOR_MODES: readonly MouseLightingMode[] = [
  "Static",
  "Breathing single",
  "Reactive",
  "Wave",
];

const RAW_TO_LIGHTING_MODE: Record<
  number,
  MouseLightingMode
> = {
  0x00: "Static",
  0x01: "Breathing single",
  0x02: "Cycling",
  0x03: "Spectrum",
  0x04: "Reactive",
  0x05: "Wave",
};

const LIGHTING_MODE_TO_RAW: Partial<
  Record<MouseLightingMode, number>
> = {
  Static: 0x00,
  "Breathing single": 0x01,
  Cycling: 0x02,
  Spectrum: 0x03,
  Reactive: 0x04,
  Wave: 0x05,
};

function copyDataView(
  view: DataView,
): Uint8Array {
  return new Uint8Array(
    view.buffer.slice(
      view.byteOffset,
      view.byteOffset +
        view.byteLength,
    ),
  );
}

function hasConfigCollection(
  collections: readonly HIDCollectionInfo[],
): boolean {
  return collections.some(
    (collection) => {
      const correctCollection =
        collection.usagePage ===
          ASUS_GLADIUS_II_USAGE_PAGE &&
        collection.usage ===
          ASUS_GLADIUS_II_USAGE;

      if (correctCollection) {
        const hasInput =
          collection.inputReports.some(
            (report) =>
              report.reportId ===
              ASUS_REPORT_ID,
          );

        const hasOutput =
          collection.outputReports.some(
            (report) =>
              report.reportId ===
              ASUS_REPORT_ID,
          );

        if (
          hasInput &&
          hasOutput
        ) {
          return true;
        }
      }

      return hasConfigCollection(
        collection.children,
      );
    },
  );
}

function hexByte(
  value: number,
): string {
  return value
    .toString(16)
    .padStart(2, "0");
}

function rgbToHex(
  red: number,
  green: number,
  blue: number,
): string {
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`;
}

function parseHexColor(
  color: string | null,
): [number, number, number] {
  const normalized =
    color ?? "#ff0000";

  const match =
    /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
      normalized,
    );

  if (!match) {
    throw new Error(
      `Invalid RGB colour: ${normalized}`,
    );
  }

  return [
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16),
  ];
}

function rawLightingToStatus(
  raw: GladiusIIRawLightingZone,
): MouseLighting {
  const mode =
    RAW_TO_LIGHTING_MODE[
      raw.mode
    ] ?? "Static";

  return {
    zone:
      RGB_ZONE_NAMES[raw.zone] ??
      `Zone ${raw.zone + 1}`,

    modes: LIGHTING_MODES,

    mode,

    color: rgbToHex(
      raw.red,
      raw.green,
      raw.blue,
    ),

    color2: null,

    colorModes: COLOR_MODES,

    dualColorModes: [],

    reactiveModes: [],

    speeds: [],

    speed: null,

    brightness:
      Math.max(
        0,
        Math.min(
          100,
          raw.brightness * 25,
        ),
      ),

    brightnessLevels: [
      0,
      25,
      50,
      75,
      100,
    ],
  };
}

export class AsusGladiusIIHidClient {
  readonly device: HIDDevice;

  private queue: Promise<unknown> =
    Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(
    device: HIDDevice,
  ): boolean {
    return (
      device.vendorId ===
        ASUS_VENDOR_ID &&
      device.productId ===
        ROG_GLADIUS_II_PRODUCT_ID &&
      hasConfigCollection(
        device.collections,
      )
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
      let dpi =
        GLADIUS_II_MIN_DPI;
      dpi <=
      GLADIUS_II_MAX_DPI;
      dpi +=
        GLADIUS_II_DPI_STEP
    ) {
      values.push(dpi);
    }

    return values;
  }

  getSupportedPollingRates(): number[] {
    return [
      ...GLADIUS_II_POLLING_RATES,
    ];
  }

  private async run<T>(
    task: () => Promise<T>,
  ): Promise<T> {
    const started =
      this.queue.then(
        task,
        task,
      );

    this.queue =
      started.catch(
        () => undefined,
      );

    return started;
  }

  private async exchange(
    request: Uint8Array,
    matches: (
      reply: Uint8Array,
    ) => boolean,
  ): Promise<Uint8Array> {
    return this.run(async () => {
      await this.open();

      return new Promise<Uint8Array>(
        (resolve, reject) => {
          const cleanup =
            (): void => {
              clearTimeout(
                timer,
              );

              this.device.removeEventListener(
                "inputreport",
                listener,
              );
            };

          const listener = (
            event: HIDInputReportEvent,
          ): void => {
            if (
              event.reportId !==
              ASUS_REPORT_ID
            ) {
              return;
            }

            const data =
              copyDataView(
                event.data,
              );

            if (
              data.length <
              ASUS_REPORT_SIZE
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

          const timer =
            setTimeout(() => {
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

          const payload =
            new ArrayBuffer(
              request.byteLength,
            );

          new Uint8Array(
            payload,
          ).set(request);

          this.device
            .sendReport(
              ASUS_REPORT_ID,
              payload,
            )
            .catch(
              (
                error: unknown,
              ) => {
                cleanup();
                reject(error);
              },
            );
        },
      );
    });
  }

  private async save(): Promise<void> {
    await this.exchange(
      gladiusIISaveRequest(),
      (data) =>
        data[0] === 0x50 &&
        data[1] === 0x03,
    );
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

  private async readLiftOffDistance(): Promise<
    "Low" | "High"
  > {
    const response =
      await this.exchange(
        gladiusIIReadLiftOffRequest(),
        (data) =>
          data[0] === 0x12 &&
          data[1] === 0x06,
      );

    return decodeGladiusIILiftOffDistance(
      response,
    );
  }

  private async readLighting(): Promise<
    MouseLighting[]
  > {
    const response =
      await this.exchange(
        gladiusIIReadLightingRequest(),
        (data) =>
          data[0] === 0x12 &&
          data[1] === 0x03 &&
          data[2] === 0x00,
      );

    return decodeGladiusIILighting(
      response,
    ).map(
      rawLightingToStatus,
    );
  }

  async setDpi(
    dpi: number,
  ): Promise<number> {
    const profile =
      await this.readProfile();

    return this.setDpiStageValue(
      profile.activeDpiStage,
      dpi,
    );
  }

  async setDpiStageValue(
    stage: number,
    dpi: number,
  ): Promise<number> {
    if (
      !this
        .getDpiOptions()
        .includes(dpi)
    ) {
      throw new Error(
        `${dpi} DPI is not supported by the ROG Gladius II.`,
      );
    }

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

    await this.save();

    const confirmed =
      await this.readSettings();

    const stored =
      confirmed.dpiStages[
        stage
      ];

    if (stored !== dpi) {
      throw new Error(
        `ROG Gladius II kept ${stored} DPI instead of ${dpi} DPI.`,
      );
    }

    return stored;
  }

  async setActiveDpiStage(
    stage: number,
  ): Promise<number> {
    if (
      !Number.isInteger(stage) ||
      stage < 0 ||
      stage > 1
    ) {
      throw new Error(
        "DPI stage must be 0 or 1.",
      );
    }

    await this.exchange(
      gladiusIISetActiveDpiStageRequest(
        stage,
      ),
      (data) =>
        data[0] === 0x51 &&
        data[1] === 0x31 &&
        data[2] === 0x09,
    );

    await this.save();

    const confirmed =
      await this.readProfile();

    if (
      confirmed.activeDpiStage !==
      stage
    ) {
      throw new Error(
        `ROG Gladius II did not switch to DPI stage ${stage + 1}.`,
      );
    }

    return stage;
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

    await this.save();

    const confirmed =
      await this.readSettings();

    if (
      confirmed.pollingRateHz !==
      rate
    ) {
      throw new Error(
        `ROG Gladius II kept ${confirmed.pollingRateHz} Hz instead of ${rate} Hz.`,
      );
    }

    return rate;
  }

  async setProfile(
    profile: number,
  ): Promise<number> {
    await this.exchange(
      gladiusIISetProfileRequest(
        profile,
      ),
      (data) =>
        data[0] === 0x50 &&
        data[1] === 0x02 &&
        data[2] ===
          profile - 1,
    );

    await this.save();

    const confirmed =
      await this.readProfile();

    if (
      confirmed.onboardProfile !==
      profile
    ) {
      throw new Error(
        `ROG Gladius II did not switch to profile ${profile}.`,
      );
    }

    return profile;
  }

  async setAngleSnapping(
    enabled: boolean,
  ): Promise<boolean> {
    await this.exchange(
      gladiusIISetAngleSnappingRequest(
        enabled,
      ),
      (data) =>
        data[0] === 0x51 &&
        data[1] === 0x31 &&
        data[2] === 0x04,
    );

    await this.save();

    const confirmed =
      await this.readSettings();

    if (
      confirmed.angleSnapping !==
      enabled
    ) {
      throw new Error(
        "ROG Gladius II did not retain the angle-snapping setting.",
      );
    }

    return enabled;
  }

  async setDebounceTime(
    milliseconds: number,
  ): Promise<number> {
    const normalized =
      [...GLADIUS_II_DEBOUNCE_MS].reduce(
        (best, value) =>
          Math.abs(
            value -
              milliseconds,
          ) <
          Math.abs(
            best -
              milliseconds,
          )
            ? value
            : best,
      );

    await this.exchange(
      gladiusIISetDebounceRequest(
        normalized,
      ),
      (data) =>
        data[0] === 0x51 &&
        data[1] === 0x31 &&
        data[2] === 0x03,
    );

    await this.save();

    const confirmed =
      await this.readSettings();

    if (
      confirmed.debounceMs !==
      normalized
    ) {
      throw new Error(
        `ROG Gladius II kept ${confirmed.debounceMs} ms debounce instead of ${normalized} ms.`,
      );
    }

    return normalized;
  }

  async setLiftOffDistance(
    value:
      | "Low"
      | "Medium"
      | "High",
  ): Promise<"Low" | "High"> {
    if (
      value !== "Low" &&
      value !== "High"
    ) {
      throw new Error(
        "ROG Gladius II only supports Low or High lift-off distance.",
      );
    }

    await this.exchange(
      gladiusIISetLiftOffRequest(
        value,
      ),
      (data) =>
        data[0] === 0x51 &&
        data[1] === 0x35,
    );

    await this.save();

    const confirmed =
      await this.readLiftOffDistance();

    if (confirmed !== value) {
      throw new Error(
        `ROG Gladius II kept ${confirmed} lift-off instead of ${value}.`,
      );
    }

    return confirmed;
  }

  async setLighting(
    lighting: MouseLighting,
  ): Promise<MouseLighting> {
    const zone =
      RGB_ZONE_NAMES.findIndex(
        (name) =>
          name === lighting.zone,
      );

    if (zone < 0) {
      throw new Error(
        `Unknown Gladius II lighting zone: ${lighting.zone}`,
      );
    }

    if (!lighting.mode) {
      throw new Error(
        "Choose an RGB effect first.",
      );
    }

    const rawMode =
      LIGHTING_MODE_TO_RAW[
        lighting.mode
      ];

    if (
      rawMode === undefined
    ) {
      throw new Error(
        `Unsupported Gladius II lighting mode: ${lighting.mode}`,
      );
    }

    let [red, green, blue] =
      parseHexColor(
        lighting.color,
      );

    const brightnessPercent =
      lighting.brightness ?? 100;

    const brightness =
      Math.max(
        0,
        Math.min(
          4,
          Math.round(
            brightnessPercent /
              25,
          ),
        ),
      );

    /*
     * ASUS Rainbow/Spectrum uses
     * fixed red bytes plus a special
     * Gladius-II speed code.
     */
    let speed = 0;

    if (
      lighting.mode ===
      "Spectrum"
    ) {
      red = 0xff;
      green = 0x00;
      blue = 0x00;

      // Medium rainbow speed.
      speed = 0x64;
    }

    await this.exchange(
      gladiusIISetLightingRequest(
        zone,
        rawMode,
        brightness,
        red,
        green,
        blue,
        0,
        0,
        speed,
      ),
      (data) =>
        data[0] === 0x51 &&
        data[1] === 0x28 &&
        data[2] === zone,
    );

    await this.save();

    const confirmed =
      await this.readLighting();

    return confirmed[zone];
  }

  async readStatus(): Promise<MouseStatus> {
    const settings =
      await this.readSettings();

    const profile =
      await this.readProfile();

    const liftOffDistance =
      await this.readLiftOffDistance();

    const lightingZones =
      await this.readLighting();

    const dpi =
      settings.dpiStages[
        profile.activeDpiStage
      ];

    return {
      brand: "ASUS",
      name: "ROG Gladius II",

      ui: {
        family:
          "asus-gladius-ii",

        settingsReady: true,

        valuesVerified: true,

        hideUnsupportedPollingRates:
          true,

        showAdvancedSection:
          true,

        hideSignalCard: true,

        hideSleepCard: true,

        hideMotionSync: true,

        hideRippleControl: true,

        dpiStageEditor: {
          maxStages: 2,
          countEditable: false,
          minDpi:
            GLADIUS_II_MIN_DPI,
          maxDpi:
            GLADIUS_II_MAX_DPI,
          stepDpi:
            GLADIUS_II_DPI_STEP,
        },

        statusNote:
          "ROG Gladius II hardware controls are enabled.",

        defaultDisplayName:
          "ROG Gladius II",
      },

      batteryPercent: null,

      batteryState:
        "Unknown",

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

      profileCount:
        GLADIUS_II_PROFILE_COUNT,

      connectionType:
        "Wired",

      connectionDetail:
        "Wired USB",

      debounceMs:
        settings.debounceMs,

      angleSnapping:
        settings.angleSnapping,

      liftOffDistance,

      supportedLiftOffDistances: [
        "Low",
        "High",
      ],

      lighting:
        lightingZones[0],

      lightingZones,

      firmware: [],
    };
  }
}