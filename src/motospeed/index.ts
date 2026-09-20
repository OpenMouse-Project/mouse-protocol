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

export interface MotospeedReport {
  reportId: number;
  data: Uint8Array;
}
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
  /** Readback uses 1 = High, 2 = Low. Write command uses the opposite values. */
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

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${label} must be an integer between ${min} and ${max}.`,
    );
  }
}

function report(reportId: number, values: readonly number[]): MotospeedReport {
  const data = new Uint8Array(
    reportId === MOTOSPEED_SETTINGS_REPORT_ID ? 63 : 20,
  );
  data.set(values);
  return { reportId, data };
}

export function motospeedBuildSettingsRequest(): MotospeedReport {
  return report(MOTOSPEED_SETTINGS_REPORT_ID, [0x06]);
}

export function motospeedDecodeSettings(
  data: DataView | Uint8Array,
  wireless: boolean,
): MotospeedSettings {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Filter Battery packets
  if (bytes.length < 20 || bytes[0] !== 0x06)
    throw new Error("Invalid Motospeed settings reply.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dpiStages: MotospeedSettings["dpiStages"] = [
    view.getUint16(5, true),
    view.getUint16(7, true),
    view.getUint16(9, true),
    view.getUint16(11, true),
    view.getUint16(13, true),
  ];

  const activeDpiStage = bytes[4];
  const dpiStageCount = bytes[16];
  integer(dpiStageCount, 1, 5, "DPI stage count in reply");
  integer(activeDpiStage, 0, dpiStageCount - 1, "Active DPI stage in reply");

  const pollingRateHz = MOTOSPEED_POLLING_RATES[bytes[2] >> 4];
  if (pollingRateHz === undefined)
    throw new Error("Unknown Motospeed polling rate in reply.");

  for (const dpi of dpiStages.slice(0, dpiStageCount))
    integer(dpi, 100, 26000, "DPI in reply");
  const settingsByte = bytes[15];
  const percent = bytes[19] & 0x7f;
  const validBattery = wireless && percent <= 100;
  return {
    dpiStages,
    activeDpiStage,
    dpiStageCount,
    pollingRateHz,
    settingsByte,
    liftOffDistanceCode: settingsByte & 3,
    liftOffDistance:
      (settingsByte & 3) === 1
        ? "High"
        : (settingsByte & 3) === 2
          ? "Low"
          : null,
    motionSync: (settingsByte & 0x04) !== 0,
    angleSnapping: (settingsByte & 0x08) !== 0,
    rippleControl: (settingsByte & 0x10) !== 0,
    invertScroll: (settingsByte & 0x40) !== 0,
    esportsMode: (settingsByte & 0x80) !== 0,
    debounceMs: bytes[17],
    sleepMinutes: bytes[18],
    batteryPercent: validBattery ? percent : null,
    charging: validBattery ? (bytes[19] & 0x80) !== 0 : null,
  };
}

export function motospeedBuildDpiCommand(options: {
  dpiStages: readonly number[];
  activeDpiStage: number;
  /** Zero leaves the enabled stage count unchanged */
  dpiStageCount?: number;
}): MotospeedReport {
  if (options.dpiStages.length !== 5)
    throw new RangeError("Motospeed requires five DPI slot values.");

  const count = options.dpiStageCount ?? 0;
  integer(count, 0, 5, "DPI stage count");
  integer(options.activeDpiStage, 0, (count || 5) - 1, "Active DPI stage");
  const packet = report(MOTOSPEED_COMMAND_REPORT_ID, [
    0x40,
    0xff,
    options.activeDpiStage,
    0xff,
  ]);
  const view = new DataView(packet.data.buffer);
  options.dpiStages.forEach((dpi, index) => {
    integer(dpi, 100, 26000, "DPI");
    if (dpi % 100 !== 0) throw new RangeError("DPI must use 100 DPI steps.");
    view.setUint16(4 + index * 2, dpi, true);
  });
  packet.data[14] = count;
  return packet;
}

export function motospeedBuildPollingCommand(hz: number): MotospeedReport {
  const index = MOTOSPEED_POLLING_RATES.indexOf(hz);
  if (index < 0)
    throw new RangeError(
      "Motospeed polling rate must be 125, 500, 1000, 2000, 4000, or 8000 Hz.",
    );
  const packet = report(MOTOSPEED_COMMAND_REPORT_ID, [0x41, 0xff, index, 0xff]);
  const view = new DataView(packet.data.buffer);
  MOTOSPEED_POLLING_RATES.forEach((rate, slot) =>
    view.setUint16(4 + slot * 2, rate, true),
  );
  return packet;
}

export function motospeedBuildDebounceCommand(ms: number): MotospeedReport {
  integer(ms, 0, 20, "Debounce time");
  return report(MOTOSPEED_COMMAND_REPORT_ID, [0x43, ms]);
}

export function motospeedBuildSleepCommand(minutes: number): MotospeedReport {
  integer(minutes, 1, 60, "Sleep time in minutes");
  return report(MOTOSPEED_COMMAND_REPORT_ID, [0x0a, 1, minutes]);
}

/** Part 2's write layout differs from the bit order in part 3's readback. */
export function motospeedBuildGeneralCommand(
  settings: MotospeedGeneralSettings,
): MotospeedReport {
  if (
    settings.liftOffDistance !== "Low" &&
    settings.liftOffDistance !== "High"
  ) {
    throw new RangeError("Motospeed lift-off distance must be Low or High.");
  }
  return report(MOTOSPEED_COMMAND_REPORT_ID, [
    0x42,
    settings.liftOffDistance === "Low" ? 1 : 2,
    settings.rippleControl ? 1 : 2,
    settings.angleSnapping ? 1 : 2,
    settings.motionSync ? 1 : 2,
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

export function motospeedBuildLightingCommand(
  lighting: MotospeedLighting,
): MotospeedReport {
  if (lighting.mode === "off")
    return report(MOTOSPEED_COMMAND_REPORT_ID, [0x24]);
  integer(lighting.brightness, 0, 255, "Brightness");
  integer(lighting.speed, 0, 255, "Lighting speed");
  const color = lighting.mode === "rainbow" ? [255, 0, 0] : lighting.color;
  color.forEach((value) => integer(value, 0, 255, "RGB component"));
  const mode =
    lighting.mode === "static" ? 1 : lighting.mode === "breathing" ? 2 : 3;
  return report(MOTOSPEED_COMMAND_REPORT_ID, [
    0x24,
    mode,
    lighting.brightness,
    lighting.speed,
    ...color,
  ]);
}

export type MotospeedButtonMapping =
  | {
      kind: "mouse" | "multimedia" | "dpi" | "lighting" | "shortcut";
      code: number;
    }
  | { kind: "disabled" };

/** Simple mappings only. The partially documented macro upload commands are excluded. */
export function motospeedBuildButtonCommand(
  button: number,
  mapping: MotospeedButtonMapping,
): MotospeedReport {
  integer(button, 0, 4, "Button index");
  const features = {
    mouse: 1,
    multimedia: 3,
    dpi: 5,
    lighting: 6,
    shortcut: 8,
    disabled: 9,
  };
  const code = mapping.kind === "disabled" ? 0 : mapping.code;
  integer(code, 0, 0xffffff, "Button mapping code");
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
