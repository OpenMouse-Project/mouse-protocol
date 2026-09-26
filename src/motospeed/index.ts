export const MOTOSPEED_VENDOR_ID = 0x0bda;
export const MOTOSPEED_USAGE_PAGE = 0xffc1;
export const MOTOSPEED_SETTINGS_REPORT_ID = 0xb3;
export const MOTOSPEED_INPUT_REPORT_ID = 0xb4;
export const MOTOSPEED_COMMAND_REPORT_ID = 0xb5;
export const MOTOSPEED_PRODUCTS = [
  {
    productId: 0xffe0,
    name: "Motospeed X6 8K receiver",
    wireless: true,
    verified: false,
  },
  {
    productId: 0xfff1,
    name: "Motospeed X6",
    wireless: false,
    verified: false,
  },
] as const;

export const MOTOSPEED_POLLING_RATES: readonly number[] = [
  125, 500, 1000, 2000, 4000, 8000,
];

export interface MotospeedGeneralSettings {
  liftOffDistance: "Low" | "High";
  rippleControl: boolean;
  angleSnapping: boolean;
  motionSync: boolean;
  invertScroll: boolean;
  esportsMode: boolean;
}

export interface MotospeedSettings {
  dpiStages: [number, number, number, number, number];
  activeDpiStage: number;
  dpiStageCount: number;
  pollingRateHz: number;
  settingsByte: number;
  /** The low two bits use 1 = Low and 2 = High. */
  liftOffDistanceCode: number;
  liftOffDistance: "Low" | "High" | null;
  motionSync: boolean;
  angleSnapping: boolean;
  rippleControl: boolean;
  invertScroll: boolean;
  esportsMode: boolean;
  debounceMs: number;
  sleepMinutes: number;
  batteryPercent: number | null;
  charging: boolean | null;
}

function validateInRange(
  value: number,
  min: number,
  max: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be in the range(${min}, ${max})`);
  }
}

export interface MotospeedReport {
  reportId: number;
  data: Uint8Array;
}

function report(reportId: number, values: readonly number[]): MotospeedReport {
  const data = new Uint8Array(
    reportId === MOTOSPEED_SETTINGS_REPORT_ID ? 63 : 20,
  );
  data.set(values);
  return { reportId, data };
}

/**
 * Settings Request Packet
 *
 * b3 06 00 00 00 00 ... 00
 * │  │  └─── padding ────┘
 * │  └ Settings request
 * └ 0xb3 Report ID
 */
export function motospeedBuildSettingsRequest(): MotospeedReport {
  return report(MOTOSPEED_SETTINGS_REPORT_ID, [0x06]);
}

/**
 * Settings Return Packet
 *
 * b4 06 00 xx xx xx xx xx xx xx xx xx xx xx xx xx xx xx xx xx xx 00 ... 00
 * │        └┬─┘  │  └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ │  │  │  │  │  └ Padding
 * │        └┬─┘  │  └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ │  │  │  │  └ Battery
 * │         │    │    └── DPI slots 1 through 5 ──┘  │  │  └ Sleep time
 * │         │    └ Current DPI slot         Settings ┘  └ Debounce time
 * │         └ Polling-rate index repeated in both nibbles
 * └ 0xb4 Report ID
 */
export function motospeedDecodeSettings(
  data: DataView | Uint8Array,
  wireless: boolean,
): MotospeedSettings {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Filter Battery packets
  if (bytes.length < 20 || bytes[0] !== 0x06) {
    throw new Error("Invalid Motospeed settings reply.");
  }

  const packetView = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  const dpiStages: MotospeedSettings["dpiStages"] = [
    packetView.getUint16(5, true),
    packetView.getUint16(7, true),
    packetView.getUint16(9, true),
    packetView.getUint16(11, true),
    packetView.getUint16(13, true),
  ];

  const activeDpiStage = bytes[4];
  const dpiStageCount = bytes[16];
  validateInRange(dpiStageCount, 1, 5, "DPI Stage Count");
  validateInRange(activeDpiStage, 0, dpiStageCount - 1, "Active DPI stage");

  const pollingRateHz = MOTOSPEED_POLLING_RATES[bytes[2] >> 4];
  if (pollingRateHz === undefined) {
    throw new Error("Unknown Motospeed polling rate in reply.");
  }

  for (const dpi of dpiStages.slice(0, dpiStageCount)) {
    validateInRange(dpi, 100, 26000, "DPI");
  }

  const settingsByte = bytes[15];

  const batteryPercentage = bytes[19] & 0x7f;
  const validBattery = wireless && batteryPercentage <= 100; // Mouse returns a seemingly random battery level when wired

  return {
    dpiStages,
    activeDpiStage,
    dpiStageCount,
    pollingRateHz,
    settingsByte,
    liftOffDistanceCode: settingsByte & 3,
    liftOffDistance:
      (settingsByte & 3) === 1
        ? "Low"
        : (settingsByte & 3) === 2
          ? "High"
          : null,
    motionSync: (settingsByte & 0x04) !== 0,
    angleSnapping: (settingsByte & 0x08) !== 0,
    rippleControl: (settingsByte & 0x10) !== 0,
    invertScroll: (settingsByte & 0x40) !== 0,
    esportsMode: (settingsByte & 0x80) !== 0,
    debounceMs: bytes[17],
    sleepMinutes: bytes[18],
    batteryPercent: validBattery ? batteryPercentage : null,
    charging: validBattery ? (bytes[19] & 0x80) !== 0 : null,
  };
}

/*
 * DPI Change packet
 *
 * b5 40 ff xx ff xx xx xx xx xx xx xx xx xx xx 05 00 ... 00
 * │  │     │     └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ │  └ padding
 * │  │     │       └────    DPI slots   ───┘   └ DPI count
 * │  │     └ Active DPI slot
 * │  └ 0x40 DPI command
 * └ 0xb5 report ID
 */
export function motospeedBuildDpiCommand(options: {
  dpiStages: readonly number[];
  activeDpiStage: number;
  /** Zero leaves the enabled stage count unchanged */
  dpiStageCount?: number;
}): MotospeedReport {
  if (options.dpiStages.length !== 5) {
    throw new RangeError("Motospeed requires five DPI slot values.");
  }

  const dpiCount = options.dpiStageCount ?? 0;
  validateInRange(dpiCount, 0, 5, "DPI stage count");
  validateInRange(
    options.activeDpiStage,
    0,
    (dpiCount || 5) - 1,
    "Active DPI stage",
  );

  const packet = report(MOTOSPEED_COMMAND_REPORT_ID, [
    0x40,
    0xff,
    options.activeDpiStage,
    0xff,
  ]);

  const packetView = new DataView(packet.data.buffer);
  options.dpiStages.forEach((dpi, index) => {
    validateInRange(dpi, 100, 26000, "DPI");
    if (dpi % 100 !== 0) throw new RangeError("DPI be divisible by 100");
    packetView.setUint16(4 + index * 2, dpi, true);
  });

  packet.data[14] = dpiCount;
  return packet;
}

/*
 * Polling Rate Change Packet
 *
 * b5 41 ff xx ff 7d 00 f4 01 e8 03 d0 07 a0 0f 40 1f 00 ... 00
 * │  │     │     └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └ padding
 * │  │     │       └ 125, 500, 1000, 2000, 4000 and 8000 Hz
 * │  │     └ Selected rate index
 * │  └ 0x41 polling-rate command
 * └ 0xb5 report ID
 */
export function motospeedBuildPollingCommand(hz: number): MotospeedReport {
  const index = MOTOSPEED_POLLING_RATES.indexOf(hz);
  if (index < 0) {
    throw new RangeError("Motospeed polling rate out of range.");
  }

  const packet = report(MOTOSPEED_COMMAND_REPORT_ID, [0x41, 0xff, index, 0xff]);

  const packetView = new DataView(packet.data.buffer);
  MOTOSPEED_POLLING_RATES.forEach((rate, slot) =>
    packetView.setUint16(4 + slot * 2, rate, true),
  );
  return packet;
}

/*
 * Debounce Change Packet
 *
 * b5 43 xx 00 ... 00
 * │  │  │  └ padding
 * │  │  └ Debounce time in milliseconds
 * │  └ 0x43 debounce command
 * └ 0xb5 report ID
 */
export function motospeedBuildDebounceCommand(ms: number): MotospeedReport {
  validateInRange(ms, 0, 20, "Debounce time");
  return report(MOTOSPEED_COMMAND_REPORT_ID, [0x43, ms]);
}

/*
 * Sleep Time Change Packet
 *
 * b5 0a 01 xx 00 ... 00
 * │  │     │  └ padding
 * │  │     └ Sleep time in minutes
 * │  └ 0x0a sleep command
 * └ 0xb5 report ID
 */
export function motospeedBuildSleepCommand(minutes: number): MotospeedReport {
  validateInRange(minutes, 1, 60, "Sleep time in minutes");
  return report(MOTOSPEED_COMMAND_REPORT_ID, [0x0a, 1, minutes]);
}

/**
 * General Mouse Settings Change Packet
 * Handles lift-off distance, Motion Sync, Angle Snapping, Ripple control, Esports mode, and scroll direction
 *
 * b5 42 xx 0x 0x 0x 00 0x 0x 00 ... 00
 * │  │  │   │  │  │     │  │ └ padding
 * │  │  │   │  │  │     │  └ Esports mode, 01 off and 02 on
 * │  │  │   │  │  │     └ Scroll direction, 01 forward and 02 backward
 * │  │  │   │  │  └ Ripple control, 01 on and 02 off
 * │  │  │   │  └ Angle snapping, 01 on and 02 off
 * │  │  │   └ Motion sync, 01 on and 02 off
 * │  │  └ Lift-off distance, 01 low and 02 high
 * │  └ 0x42 general-settings command
 * └ 0xb5 report ID
 */
export function motospeedBuildGeneralCommand(
  settings: MotospeedGeneralSettings,
): MotospeedReport {
  if (["Low", "High"].includes(settings.liftOffDistance) === false) {
    throw new RangeError("Motospeed lift-off distance must be Low or High.");
  }
  return report(MOTOSPEED_COMMAND_REPORT_ID, [
    0x42,
    settings.liftOffDistance === "Low" ? 1 : 2,
    settings.motionSync ? 1 : 2,
    settings.angleSnapping ? 1 : 2,
    settings.rippleControl ? 1 : 2,
    0,
    settings.invertScroll ? 2 : 1,
    settings.esportsMode ? 2 : 1,
  ]);
}

export type MotospeedLighting =
  | { mode: "off" }
  | {
      mode: "static" | "breathing";
      brightness: number;
      speed: number;
      color: readonly [number, number, number];
    }
  | { mode: "rainbow"; brightness: number; speed: number };

/*
 * Lighting Change Packet
 *
 * b5 24 0x xx xx xx xx xx 00 ... 00
 * │  │   │ │  │  └R └G └B └ padding
 * │  │   │ │  └ Speed, unused by static mode
 * │  │   │ └ Brightness
 * │  │   └ Mode, 00 off, 01 static, 02 breathing, 03 rainbow
 * │  └ 0x24 lighting command
 * └ 0xb5 report ID
 */
export function motospeedBuildLightingCommand(
  lighting: MotospeedLighting,
): MotospeedReport {
  if (lighting.mode === "off") {
    return report(MOTOSPEED_COMMAND_REPORT_ID, [0x24]);
  }
  validateInRange(lighting.brightness, 0, 255, "Brightness");
  validateInRange(lighting.speed, 0, 255, "Lighting speed");

  let color;
  let mode;

  switch (lighting.mode) {
    case "rainbow":
      color = [255, 0, 0];
      mode = 3;
      break;
    case "static":
      color = lighting.color;
      mode = 1;
      break;
    case "breathing":
      color = lighting.color;
      mode = 2;
      break;

    default: // Should never run, but default to rainbow as it does not require lighting.color
      color = [255, 0, 0];
      mode = 3;
  }

  color.forEach((value) => validateInRange(value, 0, 255, "RGB component"));

  return report(MOTOSPEED_COMMAND_REPORT_ID, [
    0x24,
    mode,
    lighting.brightness,
    lighting.speed,
    ...color,
  ]);
}

/**
 * b3 52 0x 00 0x xx xx xx 00 ... 00
 * │  │   │     │ └──┬───┘ └ padding
 * │  │   │     │    └ Three-byte feature code, most significant byte first
 * │  │   │     └ Feature type
 * │  │   └ Button index
 * │  └ 0x52 remapping command
 * └ 0xb3 report ID
 *
 * Simple one to one button mappings only.
 * Macros have not been fully reverse engineered.
 */
export type MotospeedButtonMapping =
  | {
      kind: "mouse" | "multimedia" | "dpi" | "lighting" | "shortcut";
      code: number;
    }
  | { kind: "disabled" };

export function motospeedBuildButtonCommand(
  button: number,
  mapping: MotospeedButtonMapping,
): MotospeedReport {
  validateInRange(button, 0, 4, "Button index");
  const features = {
    mouse: 1,
    multimedia: 3,
    dpi: 5,
    lighting: 6,
    shortcut: 8,
    disabled: 9,
  };
  const code = mapping.kind === "disabled" ? 0 : mapping.code;
  validateInRange(code, 0, 0xffffff, "Button mapping code");
  return report(MOTOSPEED_SETTINGS_REPORT_ID, [
    0x52,
    button,
    0,
    features[mapping.kind],
    code >>> 16,
    (code >>> 8) & 255,
    code & 255,
  ]);
}
