export const FINALMOUSE_REPORT = {
  dongle: 0x02,
  dongleInput: 0x03,
  main: 0x04,
  mainInput: 0x05,
  /**
   * Starlight X report IDs, inferred from xpanel's shared transport
   * (`_r`: SLX types send output report 0x01 and listen on input report
   * 0x02; ULX uses 0x04/0x05). Unverifiable without SLX hardware — if SLX
   * writes fail, this is the first constant to revisit.
   */
  slx: 0x01,
  slxInput: 0x02,
} as const;

export const FINALMOUSE_COMMAND = {
  dpi: 16,
  pollingRate: 17,
  motionSync: 18,
  dongleLed: 20,
  liftOffDistance: 21,
  tournamentScrollMode: 23,
  tournamentScrollTimeout: 24,
  /** Starlight X PAW lift-off: one raw byte, see finalmousePawLodRawToMm. */
  pawLod: 25,
  ledBrightness: 26,
  tmrCalCapture: 27,
  tmrCal: 28,
  tmrLiveRequest: 29,
  tmrLiveReport: 30,
  /** Starlight X click mode: [modeR, modeL] plus optional [relR, relL]. */
  clickMode: 31,
  uptime: 32,
  /** Starlight X TMR actuation: [thrR, thrL] u16le plus optional [hystR, hystL]. */
  tmrActuation: 53,
  indicatorColor: 54,
  /** Starlight X TMR most-sensitive-point reference: [mspR, mspL] u16le µm. */
  tmrMsp: 55,
  tmrRtStatus: 56,
  /** Starlight X profiles: active index + count; data/name/enable below. */
  profile: 57,
  profileData: 58,
  dongleLedData: 61,
  profileName: 62,
  profileEnable: 63,
  wakeAll: 96,
  dongleInfo: 10,
} as const;

/** Starlight X product IDs on 361D (xpanel): dongles 0x300/0x301. */
export const FINALMOUSE_SLX_DONGLE_PRODUCT_IDS = [0x0300, 0x0301] as const;
/** Starlight X direct-mouse product IDs (xpanel supports mouse-direct too). */
export const FINALMOUSE_SLX_MOUSE_PRODUCT_IDS = [0x0310, 0x0311] as const;
export const FINALMOUSE_ULX_DONGLE_PRODUCT_ID = 0x0100;
export const FINALMOUSE_ULX_MOUSE_PRODUCT_ID = 0x0102;
export const FINALMOUSE_VENDOR_ID = 0x361d;

const OUTPUT_REPORT_LENGTH = 63;

export interface FinalmouseTelemetry {
  dpi?: number;
  pollingRateHz?: number;
  batteryVoltageMv?: number;
  batteryPercent?: number;
  /** State of charge 0-100 from the 0x26 battery-status report, when answered. */
  batterySoc?: number;
  rssiDbm?: number;
  /** 0 = no link (xpanel clears RSSI then); otherwise 1. */
  linkState?: number;
  liftOffDistanceMm?: number;
  /** Starlight X PAW lift-off in millimetres (0.7-2.0), when answered. */
  pawLodMm?: number;
  /** True when the PAW value came from the custom slider (raw 7-17). */
  pawLodCustom?: boolean;
  motionSync?: boolean;
  dongleLedMode?: number;
  tournamentScrollMode?: number;
  tournamentScrollTimeoutMs?: number;
  chargingState?: number;
  mouseFirmware?: string;
  dongleRfFirmware?: string;
  dongleUsbFirmware?: string;
  mouseSerial?: string;
  /** 0 = mechanical, 1 = TMR analog. */
  clickModeL?: number;
  clickModeR?: number;
  /** 0 = normal, 1 = early, 2 = late. Null until a 4-byte reply arrives. */
  clickReleaseL?: number | null;
  clickReleaseR?: number | null;
  /** Actuation steps in 0.01 mm units (1-40); 0 = not reported / uncalibrated. */
  tmrThrL?: number;
  tmrThrR?: number;
  /** Rapid-trigger sensitivity in µm (150-250). */
  tmrHystL?: number;
  tmrHystR?: number;
  /** Calibrated most-sensitive-point reference in µm; 0 = uncalibrated. */
  tmrMspL?: number;
  tmrMspR?: number;
  profileActive?: number;
  profileCount?: number;
  profileEnabledMask?: number;
  /** Accumulated profile names by index (replies arrive one per profile). */
  profileNames?: Record<number, string>;
  /** Accumulated per-profile LED data by index. */
  profileLeds?: Record<number, FinalmouseProfileLed>;
  indicatorColor?: { r: number; g: number; b: number };
  ledBrightness?: number;
  uptime?: number;
}

export interface FinalmouseProfileLed {
  id: number;
  mode: number;
  brightness: number;
  r: number;
  g: number;
  b: number;
}

/** Click-mode values shared by both switches (xpanel: 0 = mechanical, 1 = analog). */
export const FINALMOUSE_CLICK_MODE = { mechanical: 0, analog: 1 } as const;
/** Release-point values (xpanel readback log: 0 = normal, 1 = early, 2 = late). */
export const FINALMOUSE_RELEASE_POINT = { normal: 0, early: 1, late: 2 } as const;

/**
 * TMR-DS actuation limits from xpanel (Bebg4M4T: min 0.01, max 0.40,
 * step 0.01 mm; RT sensitivity 150-250 µm in steps of 10, 220 recommended).
 */
export const FINALMOUSE_TMR = {
  actuationMinMm: 0.01,
  actuationMaxMm: 0.4,
  actuationStepMm: 0.01,
  rtMinUm: 150,
  rtMaxUm: 250,
  rtStepUm: 10,
  rtRecommendedUm: 220,
} as const;

/** Profiles on Starlight X (xpanel caps the roster at 5, names at 31 chars). */
export const FINALMOUSE_PROFILE = { maxCount: 5, maxNameLength: 31 } as const;

/**
 * PAW lift-off table from xpanel (YNk7IF1T): presets send raw 2 (= 1 mm) and
 * raw 3 (= 2 mm); the custom slider sends raw 7-17 (= 0.7-1.7 mm).
 */
const PAW_PRESET_RAW: Readonly<Record<number, number>> = { 1: 2, 2: 3 };
const PAW_RAW_PRESET: Readonly<Record<number, number>> = { 1: 0.7, 2: 1, 3: 2 };
const PAW_CUSTOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2];

/** Raw PAW byte to millimetres, or null when the byte is not a known value. */
export function finalmousePawLodRawToMm(raw: number): number | null {
  if (raw in PAW_RAW_PRESET) return PAW_RAW_PRESET[raw]!;
  const mm = raw / 10;
  return PAW_CUSTOM_STEPS.includes(mm) ? mm : null;
}

/** True when the raw PAW byte came from xpanel's custom slider (7-17). */
export function finalmousePawLodRawIsCustom(raw: number): boolean {
  return raw >= 7 && raw <= 17;
}

/**
 * Millimetres to raw PAW byte. The 1 mm / 2 mm presets map to raw 2 / 3;
 * anything else must be an exact custom step (0.7-2.0 in 0.1 steps).
 */
export function finalmousePawLodMmToRaw(mm: number): number | null {
  if (mm === 1) return PAW_PRESET_RAW[1]!;
  if (mm === 2) return PAW_PRESET_RAW[2]!;
  if (!PAW_CUSTOM_STEPS.includes(mm)) return null;
  const raw = Math.round(mm * 10);
  return raw >= 7 && raw <= 17 ? raw : null;
}

/** Clamp millimetres to the 0.01-0.40 actuation range in 0.01 steps. */
export function finalmouseClampActuationMm(mm: number): number {
  const stepped = Math.round(mm / FINALMOUSE_TMR.actuationStepMm) * FINALMOUSE_TMR.actuationStepMm;
  return Math.min(
    FINALMOUSE_TMR.actuationMaxMm,
    Math.max(FINALMOUSE_TMR.actuationMinMm, Number(stepped.toFixed(2))),
  );
}

/** Millimetres to TMR actuation steps (0.01 mm units). */
export function finalmouseActuationMmToSteps(mm: number): number {
  return Math.round(finalmouseClampActuationMm(mm) * 100);
}

/** TMR actuation steps back to millimetres. */
export function finalmouseActuationStepsToMm(steps: number): number {
  return finalmouseClampActuationMm(steps / 100);
}

/**
 * RSSI to the 0-4 signal scale the shared SignalCard renders (`{n}/4`),
 * using xpanel's thresholds (|rssi| < 40 → 4, < 50 → 3, < 65 → 2, else 1).
 * Null when there is no reading, or the link is down (linkState 0).
 */
export function finalmouseSignalStrength(rssiDbm: number | undefined, linkState?: number): number | null {
  if (rssiDbm === undefined || linkState === 0) return null;
  const magnitude = Math.abs(rssiDbm);
  if (magnitude < 40) return 4;
  if (magnitude < 50) return 3;
  if (magnitude < 65) return 2;
  return 1;
}

/** Per-profile content block carried by command 58 (xpanel `Yr` field order). */
export interface FinalmouseProfileData {
  dpi: number;
  lod: number;
  motionSync: number;
  jscrollMode: number;
  jscrollTimeout100ms: number;
  thrUmR: number;
  thrUmL: number;
  modeR: number;
  modeL: number;
  enabled: number;
}

/** Encode command 31. Wire order is [modeR, modeL] with optional [relR, relL]. */
export function encodeFinalmouseClickMode(
  modeR: number,
  modeL: number,
  relR?: number,
  relL?: number,
): Uint8Array {
  for (const mode of [modeR, modeL]) {
    if (mode !== 0 && mode !== 1) throw new Error("Finalmouse click mode must be 0 (mechanical) or 1 (analog).");
  }
  const bytes = [modeR & 1, modeL & 1];
  if (relR !== undefined || relL !== undefined) {
    if (relR === undefined || relL === undefined) throw new Error("Finalmouse release points must be set for both switches together.");
    for (const rel of [relR, relL]) {
      if (rel !== 0 && rel !== 1 && rel !== 2) throw new Error("Finalmouse release point must be 0 (normal), 1 (early) or 2 (late).");
    }
    bytes.push(relR, relL);
  }
  return new Uint8Array(bytes);
}

/** Encode command 53. Wire order is [thrR, thrL] u16le plus [hystR, hystL]. */
export function encodeFinalmouseTmrActuation(
  thrR: number,
  thrL: number,
  hystR?: number,
  hystL?: number,
): Uint8Array {
  for (const thr of [thrR, thrL]) {
    if (!Number.isInteger(thr) || thr < 1 || thr > 40) {
      throw new Error("Finalmouse actuation steps must be 1-40 (0.01-0.40 mm).");
    }
  }
  const bytes = [...u16Bytes(thrR), ...u16Bytes(thrL)];
  if (hystR !== undefined || hystL !== undefined) {
    if (hystR === undefined || hystL === undefined) {
      throw new Error("Finalmouse rapid-trigger sensitivity must be set for both switches together.");
    }
    for (const hyst of [hystR, hystL]) {
      if (!Number.isInteger(hyst) || hyst < FINALMOUSE_TMR.rtMinUm || hyst > FINALMOUSE_TMR.rtMaxUm) {
        throw new Error(`Finalmouse rapid-trigger sensitivity must be ${FINALMOUSE_TMR.rtMinUm}-${FINALMOUSE_TMR.rtMaxUm} µm.`);
      }
    }
    bytes.push(...u16Bytes(hystR), ...u16Bytes(hystL));
  }
  return new Uint8Array(bytes);
}

/** Encode command 55. Wire order is [mspR, mspL] u16le µm. */
export function encodeFinalmouseTmrMsp(mspR: number, mspL: number): Uint8Array {
  for (const msp of [mspR, mspL]) {
    if (!Number.isInteger(msp) || msp < 0 || msp > 0xffff) throw new Error("Finalmouse MSP must be 0-65535 µm.");
  }
  return new Uint8Array([...u16Bytes(mspR), ...u16Bytes(mspL)]);
}

/** Encode one command-58 profile content block (xpanel `Yr` order). */
export function encodeFinalmouseProfileData(data: FinalmouseProfileData): Uint8Array {
  return new Uint8Array([
    ...u16Bytes(data.dpi),
    data.lod & 0xff,
    data.motionSync & 0xff,
    data.jscrollMode & 0xff,
    data.jscrollTimeout100ms & 0xff,
    ...u16Bytes(data.thrUmR),
    ...u16Bytes(data.thrUmL),
    data.modeR & 0xff,
    data.modeL & 0xff,
    data.enabled & 0xff,
  ]);
}

/** Encode command 62: profile id plus a 31-char UTF-8 name. */
export function encodeFinalmouseProfileName(id: number, name: string): Uint8Array {
  assertProfileId(id);
  const bytes = Array.from(new TextEncoder().encode(name)).slice(0, FINALMOUSE_PROFILE.maxNameLength - 1);
  return new Uint8Array([id & 0xff, ...bytes]);
}

/** Encode command 63: profile id plus enabled flag. */
export function encodeFinalmouseProfileEnable(id: number, enabled: boolean): Uint8Array {
  assertProfileId(id);
  return new Uint8Array([id & 0xff, enabled ? 1 : 0]);
}

/** Encode command 61: per-profile dongle LED entry. */
export function encodeFinalmouseDongleLedData(led: FinalmouseProfileLed): Uint8Array {
  assertProfileId(led.id);
  for (const byte of [led.mode, led.brightness, led.r, led.g, led.b]) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new Error("Finalmouse profile LED bytes must be 0-255.");
  }
  return new Uint8Array([led.id & 0xff, led.mode, led.brightness, led.r, led.g, led.b]);
}

/** Encode command 54: indicator colour triple. */
export function encodeFinalmouseIndicatorColor(r: number, g: number, b: number): Uint8Array {
  for (const byte of [r, g, b]) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new Error("Finalmouse indicator colour bytes must be 0-255.");
  }
  return new Uint8Array([r, g, b]);
}

function assertProfileId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= FINALMOUSE_PROFILE.maxCount) {
    throw new Error(`Finalmouse profile id must be 0-${FINALMOUSE_PROFILE.maxCount - 1}.`);
  }
}

function u16Bytes(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/** Build xpanel's 63-byte WebHID payload. The browser supplies reportId separately. */
export function buildFinalmouseReport(command: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!Number.isInteger(command) || command < 0 || command > 0x7f) throw new Error("Invalid Finalmouse command.");
  if (payload.length > OUTPUT_REPORT_LENGTH - 3) throw new Error("Finalmouse command payload is too large.");
  const report = new Uint8Array(OUTPUT_REPORT_LENGTH);
  report[0] = 2 + payload.length;
  report[1] = 0x80 | command;
  report[2] = payload.length;
  report.set(payload, 3);
  return report;
}

/** Decode one WebHID input payload after the browser has removed the report ID. */
export function decodeFinalmouseReport(reportId: number, data: Uint8Array): Partial<FinalmouseTelemetry> | null {
  const mouseInput = reportId === FINALMOUSE_REPORT.mainInput || reportId === FINALMOUSE_REPORT.slxInput;
  if ((!mouseInput && reportId !== FINALMOUSE_REPORT.dongleInput) || data.length < 3) return null;
  const innerLength = Math.min(data[0] ?? 0, data.length - 1);
  const body = data.subarray(1, innerLength + 1);
  if (body.length < 2) return null;
  const command = body[0] ?? -1;
  const payloadLength = Math.min(body[1] ?? 0, Math.max(0, body.length - 2));
  const payload = body.subarray(2, 2 + payloadLength);

  if (reportId === FINALMOUSE_REPORT.dongleInput) {
    return command === FINALMOUSE_COMMAND.dongleInfo
      ? { dongleUsbFirmware: decodeAscii(payload, payloadLength - 1) }
      : null;
  }

  switch (command) {
    case 3: {
      const dpi = u16le(payload);
      return dpi === null ? null : { dpi };
    }
    case 4: {
      const pollingRateHz = u16le(payload);
      return pollingRateHz === null ? null : { pollingRateHz };
    }
    case 5: {
      const millivolts = u16le(payload);
      return millivolts === null ? null : {
        batteryVoltageMv: millivolts,
        batteryPercent: finalmouseBatteryPercent(millivolts),
      };
    }
    case 11: return { dongleRfFirmware: decodeAscii(payload, payloadLength - 1) };
    case 12: return { mouseFirmware: decodeAscii(payload, payloadLength - 1) };
    case 13: return payload.length < 1 ? null : { rssiDbm: payload[0]! > 127 ? payload[0]! - 256 : payload[0]! };
    case 14: return { mouseSerial: decodeAscii(payload, payloadLength - 1) };
    case 18: return payload.length < 1 ? null : { motionSync: payload[0] === 1 };
    case 20: return payload.length < 1 ? null : { dongleLedMode: payload[0] };
    case 21: return payload.length < 1 ? null : { liftOffDistanceMm: payload[0] };
    case 23: return payload.length < 1 ? null : { tournamentScrollMode: payload[0] };
    case 24: return payload.length < 1 ? null : { tournamentScrollTimeoutMs: payload[0]! * 100 };
    case 25: {
      if (payload.length < 1) return null;
      const raw = payload[0]!;
      const pawLodMm = finalmousePawLodRawToMm(raw);
      return pawLodMm === null ? null : { pawLodMm, pawLodCustom: finalmousePawLodRawIsCustom(raw) };
    }
    case 26: return payload.length < 1 ? null : { ledBrightness: payload[0] };
    case 31: {
      if (payload.length < 2) return null;
      const update: Partial<FinalmouseTelemetry> = { clickModeR: payload[0], clickModeL: payload[1] };
      if (payload.length >= 4) {
        update.clickReleaseR = payload[2]!;
        update.clickReleaseL = payload[3]!;
      }
      return update;
    }
    case 32: {
      const uptime = u32le(payload);
      return uptime === null ? null : { uptime };
    }
    case 36: return payload.length < 1 ? null : { linkState: payload[0] };
    case 37: return payload.length < 1 ? null : { chargingState: payload[0] };
    case 38: {
      if (payload.length < 3) return null;
      const millivolts = u16le(payload.subarray(1));
      const update: Partial<FinalmouseTelemetry> = { batterySoc: payload[0] };
      if (millivolts !== null) update.batteryVoltageMv = millivolts;
      return update;
    }
    case 53: {
      if (payload.length < 8) return null;
      const thrR = u16le(payload.subarray(0));
      const thrL = u16le(payload.subarray(2));
      const hystR = u16le(payload.subarray(4));
      const hystL = u16le(payload.subarray(6));
      return thrR === null || thrL === null || hystR === null || hystL === null
        ? null
        : { tmrThrR: thrR, tmrThrL: thrL, tmrHystR: hystR, tmrHystL: hystL };
    }
    case 54: {
      if (payload.length < 3) return null;
      return { indicatorColor: { r: payload[0]!, g: payload[1]!, b: payload[2]! } };
    }
    case 55: {
      if (payload.length < 4) return null;
      const mspR = u16le(payload.subarray(0));
      const mspL = u16le(payload.subarray(2));
      return mspR === null || mspL === null ? null : { tmrMspR: mspR, tmrMspL: mspL };
    }
    case 57: {
      if (payload.length < 2) return null;
      return { profileActive: payload[0], profileCount: payload[1] };
    }
    case 61: {
      if (payload.length < 6) return null;
      const led: FinalmouseProfileLed = {
        id: payload[0]!,
        mode: payload[1]!,
        brightness: payload[2]!,
        r: payload[3]!,
        g: payload[4]!,
        b: payload[5]!,
      };
      return { profileLeds: { [led.id]: led } };
    }
    case 62: {
      if (payload.length < 2) return null;
      const bytes = payload.subarray(1, 1 + FINALMOUSE_PROFILE.maxNameLength);
      const end = bytes.indexOf(0);
      const name = new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
      return { profileNames: { [payload[0]!]: name } };
    }
    case 63: {
      if (payload.length < 3) return null;
      return { profileActive: payload[0], profileCount: payload[1], profileEnabledMask: payload[2] };
    }
    default: return null;
  }
}

/** Finalmouse's ULX battery-voltage calibration curve from xpanel. */
export function finalmouseBatteryPercent(millivolts: number): number {
  if (millivolts <= 0) return 0;
  const voltage = millivolts / 1000;
  const voltages = [3, 3.62, 3.66, 3.74, 3.88, 4.17, 4.38];
  const percentages = [0.2, 5, 10, 25, 50, 75, 100];
  if (voltage >= voltages.at(-1)!) return 100;
  if (voltage <= voltages[0]!) return 0;
  for (let index = 0; index < voltages.length - 1; index += 1) {
    const low = voltages[index]!;
    const high = voltages[index + 1]!;
    if (voltage < low || voltage > high) continue;
    const fraction = (voltage - low) / (high - low);
    return Math.round(percentages[index]! + (percentages[index + 1]! - percentages[index]!) * fraction);
  }
  return 0;
}

function u16le(payload: Uint8Array): number | null {
  return payload.length < 2 ? null : payload[0]! | (payload[1]! << 8);
}

function u32le(payload: Uint8Array): number | null {
  if (payload.length < 4) return null;
  return (payload[0]! | (payload[1]! << 8) | (payload[2]! << 16) | (payload[3]! << 24)) >>> 0;
}

function decodeAscii(payload: Uint8Array, length: number): string {
  if (length <= 0) return "";
  return new TextDecoder("ascii").decode(payload.subarray(0, Math.min(length, payload.length))).replace(/[\0 ]+$/, "");
}

