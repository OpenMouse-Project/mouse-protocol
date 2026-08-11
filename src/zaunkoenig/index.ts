/**
 * Zaunkoenig's WebHID configuration protocol, reconstructed from the public
 * Zaunkoenfigurator shipped at https://zaunkoenig.co/zaunkoenfigurator.
 *
 * The device stores every setting in one little-endian 16-bit word. Writes
 * carry a second 16-bit control word: zero applies the configuration and
 * 0xffff requests a factory reset.
 */
export const ZAUNKOENIG_VENDOR_ID = 0x0483;
export const ZAUNKOENIG_M3K_PRODUCT_ID = 0xa462;
export const ZAUNKOENIG_M2K_PRODUCT_ID = 0xa3cf;
export const ZAUNKOENIG_PRODUCT_IDS = [
  ZAUNKOENIG_M3K_PRODUCT_ID,
  ZAUNKOENIG_M2K_PRODUCT_ID,
] as const;

export const ZAUNKOENIG_USAGE_PAGE = 0xff00;
export const ZAUNKOENIG_VERSION_REPORT_ID = 2;
export const ZAUNKOENIG_CONFIG_REPORT_ID = 3;
export const ZAUNKOENIG_MINIMUM_FIRMWARE_MARKER = "parawizard new v0.8";

export type ZaunkoenigModel = "M3K" | "M2K";
export type ZaunkoenigUsbSpeed = "Full" | "High";
export type ZaunkoenigPrimaryButton = "Left" | "Right";

export interface ZaunkoenigConfig {
  usbSpeed: ZaunkoenigUsbSpeed;
  pollingRateHz: 1000 | 2000 | 4000 | 8000;
  /** Raw interval code retained even when Full-speed forces the effective rate to 1 kHz. */
  pollingRateCode: 0 | 1 | 2 | 3;
  liftOffDistanceMm: 1 | 2 | 3;
  angleSnapping: boolean;
  primaryButton: ZaunkoenigPrimaryButton;
  dpi: number;
}

export interface ZaunkoenigDeviceDefinition {
  model: ZaunkoenigModel;
  dpiStep: 50 | 100;
  dpiMax: 12_000 | 20_000;
  liftOffDistancesMm: readonly (1 | 2 | 3)[];
  /** This implementation follows public code and still needs physical-hardware verification. */
  verified: false;
}

export const ZAUNKOENIG_DEVICES: ReadonlyMap<number, ZaunkoenigDeviceDefinition> = new Map([
  [ZAUNKOENIG_M3K_PRODUCT_ID, {
    model: "M3K",
    dpiStep: 50,
    dpiMax: 20_000,
    liftOffDistancesMm: [1, 2, 3],
    verified: false,
  }],
  [ZAUNKOENIG_M2K_PRODUCT_ID, {
    model: "M2K",
    dpiStep: 100,
    dpiMax: 12_000,
    liftOffDistancesMm: [2, 3],
    verified: false,
  }],
]);

const POLLING_RATES = [8000, 4000, 2000, 1000] as const;

export function zaunkoenigDevice(productId: number): ZaunkoenigDeviceDefinition {
  const definition = ZAUNKOENIG_DEVICES.get(productId);
  if (!definition) throw new Error(`Unsupported Zaunkoenig product id 0x${productId.toString(16)}.`);
  return definition;
}

export function zaunkoenigFirmwareIsSupported(version: string): boolean {
  return version.includes(ZAUNKOENIG_MINIMUM_FIRMWARE_MARKER);
}

export function zaunkoenigDecodeVersionReport(source: DataView | Uint8Array): string {
  const bytes = asBytes(source);
  const start = bytes[0] === ZAUNKOENIG_VERSION_REPORT_ID ? 1 : 0;
  const terminator = bytes.indexOf(0, start);
  const end = terminator < 0 ? bytes.length : terminator;
  return String.fromCharCode(...bytes.slice(start, end)).trim();
}

export function zaunkoenigDecodeConfigWord(word: number, productId: number): ZaunkoenigConfig {
  const definition = zaunkoenigDevice(productId);
  const value = word & 0xffff;
  const pollingRateCode = ((value >> 11) & 0b11) as ZaunkoenigConfig["pollingRateCode"];
  const rawLod = (value >> 9) & 0b11;
  const liftOffDistanceMm = definition.model === "M2K" ? rawLod : rawLod + 1;
  if (!definition.liftOffDistancesMm.includes(liftOffDistanceMm as 1 | 2 | 3)) {
    throw new Error(`Zaunkoenig ${definition.model} reported unsupported lift-off code ${rawLod}.`);
  }
  const usbSpeed = value & 0x2000 ? "High" : "Full";
  return {
    usbSpeed,
    pollingRateHz: usbSpeed === "Full" ? 1000 : POLLING_RATES[pollingRateCode],
    pollingRateCode,
    liftOffDistanceMm: liftOffDistanceMm as 1 | 2 | 3,
    angleSnapping: Boolean(value & 0x4000),
    primaryButton: value & 0x8000 ? "Right" : "Left",
    dpi: ((value & 0x01ff) + 1) * definition.dpiStep,
  };
}

export function zaunkoenigDecodeConfigReport(source: DataView | Uint8Array, productId: number): ZaunkoenigConfig {
  const bytes = asBytes(source);
  const start = bytes[0] === ZAUNKOENIG_CONFIG_REPORT_ID ? 1 : 0;
  if (bytes.length - start < 2) throw new Error("Zaunkoenig configuration report is shorter than two bytes.");
  return zaunkoenigDecodeConfigWord(bytes[start]! | (bytes[start + 1]! << 8), productId);
}

export function zaunkoenigEncodeConfigWord(config: ZaunkoenigConfig, productId: number): number {
  const definition = zaunkoenigDevice(productId);
  if (!Number.isInteger(config.dpi) || config.dpi < definition.dpiStep || config.dpi > definition.dpiMax
    || config.dpi % definition.dpiStep !== 0) {
    throw new Error(`Zaunkoenig ${definition.model} DPI must be ${definition.dpiStep}–${definition.dpiMax} in ${definition.dpiStep} DPI steps.`);
  }
  if (!definition.liftOffDistancesMm.includes(config.liftOffDistanceMm)) {
    throw new Error(`Zaunkoenig ${definition.model} lift-off distance must be ${definition.liftOffDistancesMm.join(" or ")} mm.`);
  }
  const selectedPollingRateCode = POLLING_RATES.indexOf(config.pollingRateHz);
  if (selectedPollingRateCode < 0) throw new Error("Zaunkoenig polling rate must be 1000, 2000, 4000, or 8000 Hz.");
  if (!Number.isInteger(config.pollingRateCode) || config.pollingRateCode < 0 || config.pollingRateCode > 3) {
    throw new Error("Zaunkoenig polling-rate code must be an integer from 0 to 3.");
  }
  if (config.usbSpeed === "Full" && config.pollingRateHz !== 1000) {
    throw new Error("USB Full-speed supports only 1000 Hz polling.");
  }

  // Full-speed always reports at 1 kHz, but the firmware retains the interval
  // bits and uses them again if High-speed is restored.
  const pollingRateCode = config.usbSpeed === "Full" ? config.pollingRateCode : selectedPollingRateCode;
  const rawLod = definition.model === "M2K" ? config.liftOffDistanceMm : config.liftOffDistanceMm - 1;
  let word = (config.dpi / definition.dpiStep - 1) & 0x01ff;
  word |= (rawLod & 0b11) << 9;
  word |= (pollingRateCode & 0b11) << 11;
  if (config.usbSpeed === "High") word |= 0x2000;
  if (config.angleSnapping) word |= 0x4000;
  if (config.primaryButton === "Right") word |= 0x8000;
  return word & 0xffff;
}

/** Four-byte payload passed to sendFeatureReport(3, ...). */
export function zaunkoenigBuildConfigPayload(config: ZaunkoenigConfig, productId: number): Uint8Array {
  const word = zaunkoenigEncodeConfigWord(config, productId);
  return new Uint8Array([word & 0xff, word >> 8, 0, 0]);
}

/** 0x0000 followed by the 0xffff factory-reset sentinel. */
export function zaunkoenigBuildFactoryResetPayload(): Uint8Array {
  return new Uint8Array([0, 0, 0xff, 0xff]);
}

function asBytes(source: DataView | Uint8Array): Uint8Array {
  return source instanceof Uint8Array
    ? source
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}
