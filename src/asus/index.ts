/*
 * The settings-block layout (field index and offset follow the DPI stage
 * count) and the per-zone lighting reply are ported from libratbag's ASUS
 * driver (src/asus.c, src/driver-asus.c):
 *
 * Copyright (C) 2021 Kyoken, kyoken@kyoken.ninja
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice (including the next
 * paragraph) shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

import type { AsusMouseModel } from "./devices.js";

export * from "./devices.js";

export const ASUS_VENDOR_ID = 0x0b05;

export const ASUS_USAGE_PAGE = 0xff01;
export const ASUS_USAGE = 0x0001;

export const ASUS_REPORT_ID = 0;
export const ASUS_REPORT_SIZE = 64;

export const ASUS_POLLING_RATES = [125, 250, 500, 1000] as const;

export const ASUS_DEBOUNCE_MS = [12, 16, 20, 24, 28, 32] as const;

export type AsusLiftOffDistance = "Low" | "High";

export interface AsusSettings {
  dpiStages: number[];
  pollingRateHz: number;
  debounceMs: number | null;
  angleSnapping: boolean;
}

export interface AsusProfile {
  onboardProfile: number;
  activeDpiStage: number;
}

export interface AsusRawLightingZone {
  mode: number;
  /** Wire scale, 0 to the model's `brightnessMax`. */
  brightness: number;
  red: number;
  green: number;
  blue: number;
}

export interface AsusBattery {
  percent: number;
  charging: boolean;
}

export type AsusRgb = readonly [number, number, number];

/** Rate, debounce and angle snapping follow the DPI stages in the settings block. */
const FIELD_RATE = 0;
const FIELD_DEBOUNCE = 1;
const FIELD_SNAPPING = 2;

function settingField(model: AsusMouseModel, field: number): number {
  return model.dpiStages + field;
}

function settingOffset(model: AsusMouseModel, field: number): number {
  return 4 + model.dpiStages * 2 + field * 2;
}

function requirePrefix(data: Uint8Array, expected: readonly number[], name: string, minLength: number): void {
  if (data.length < minLength) {
    throw new Error(`${name} reply is too short.`);
  }

  expected.forEach((byte, i) => {
    if (data[i] !== byte) {
      throw new Error(`${name} reply has unexpected byte ${i}: 0x${data[i].toString(16).padStart(2, "0")}`);
    }
  });
}

function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function decodeDpi(model: AsusMouseModel, value: number): number {
  return (value + 1) * model.dpiStep;
}

function request(...bytes: number[]): Uint8Array {
  const data = new Uint8Array(ASUS_REPORT_SIZE);
  data.set(bytes);
  return data;
}

function requireStage(model: AsusMouseModel, stage: number): void {
  if (!Number.isInteger(stage) || stage < 0 || stage >= model.dpiStages) {
    throw new Error(`${model.name} DPI stage must be 0-${model.dpiStages - 1}.`);
  }
}

/* ---------------------------------
 * READ DECODERS
 * --------------------------------- */

export function asusDecodeSettings(model: AsusMouseModel, data: Uint8Array): AsusSettings {
  const rateOffset = settingOffset(model, FIELD_RATE);
  requirePrefix(data, [0x12, 0x04, 0x00], "ASUS settings", settingOffset(model, FIELD_SNAPPING) + 1);

  // Newer firmware keeps a polling-booster value in the high nibble.
  const pollingRaw = data[rateOffset] & 0x07;
  const pollingRateHz = ASUS_POLLING_RATES[pollingRaw];
  if (pollingRateHz === undefined) {
    throw new Error(`Unknown ASUS polling value 0x${pollingRaw.toString(16).padStart(2, "0")}.`);
  }

  const debounceRaw = data[settingOffset(model, FIELD_DEBOUNCE)];

  return {
    dpiStages: Array.from({ length: model.dpiStages }, (_, i) => decodeDpi(model, readUint16LE(data, 4 + i * 2))),
    pollingRateHz,
    debounceMs: debounceRaw >= 0x02 && debounceRaw <= 0x07 ? debounceRaw * 4 + 4 : null,
    angleSnapping: data[settingOffset(model, FIELD_SNAPPING)] === 0x01,
  };
}

/** X values from the `12 04 02` block, four bytes (X, Y) per stage. */
export function asusDecodeDpiXY(model: AsusMouseModel, data: Uint8Array): number[] {
  requirePrefix(data, [0x12, 0x04, 0x02], "ASUS X/Y DPI", 4 + model.dpiStages * 4);

  return Array.from({ length: model.dpiStages }, (_, i) => decodeDpi(model, readUint16LE(data, 4 + i * 4)));
}

export function asusDecodeDpiColors(model: AsusMouseModel, data: Uint8Array): AsusRgb[] {
  requirePrefix(data, [0x12, 0x04, 0x03], "ASUS DPI colours", 4 + model.dpiStages * 3);

  return Array.from({ length: model.dpiStages }, (_, i) => {
    const offset = 4 + i * 3;
    return [data[offset], data[offset + 1], data[offset + 2]] as const;
  });
}

export function asusDecodeProfile(model: AsusMouseModel, data: Uint8Array): AsusProfile {
  requirePrefix(data, [0x12, 0x00, 0x00], "ASUS profile", 12);

  const stageRaw = data[11];
  if (stageRaw < 1 || stageRaw > model.dpiStages) {
    throw new Error(`Invalid ${model.name} DPI stage ${stageRaw}.`);
  }

  return {
    onboardProfile: data[10] + 1,
    activeDpiStage: stageRaw - 1,
  };
}

export function asusDecodeLiftOffDistance(data: Uint8Array): AsusLiftOffDistance {
  requirePrefix(data, [0x12, 0x06], "ASUS lift-off", 8);

  const raw = data[7];
  if (raw === 0) return "Low";
  if (raw === 1) return "High";
  throw new Error(`Unknown ASUS lift-off value ${raw}.`);
}

export function asusDecodeLighting(model: AsusMouseModel, data: Uint8Array, zone: number): AsusRawLightingZone {
  const offset = model.lightingAllZones ? 4 + zone * 5 : 4;
  requirePrefix(data, [0x12, 0x03], "ASUS lighting", offset + 5);

  return {
    mode: data[offset],
    brightness: data[offset + 1],
    red: data[offset + 2],
    green: data[offset + 3],
    blue: data[offset + 4],
  };
}

export function asusDecodeBattery(data: Uint8Array): AsusBattery {
  requirePrefix(data, [0x12, 0x07], "ASUS battery", 10);

  return {
    percent: data[4],
    charging: data[9] > 0,
  };
}

/* ---------------------------------
 * READ REQUESTS
 * --------------------------------- */

export function asusReadSettingsRequest(): Uint8Array {
  return request(0x12, 0x04, 0x00);
}

export function asusReadDpiXYRequest(): Uint8Array {
  return request(0x12, 0x04, 0x02);
}

export function asusReadDpiColorsRequest(): Uint8Array {
  return request(0x12, 0x04, 0x03);
}

export function asusReadProfileRequest(): Uint8Array {
  return request(0x12, 0x00);
}

export function asusReadLiftOffRequest(): Uint8Array {
  return request(0x12, 0x06);
}

export function asusReadLightingRequest(model: AsusMouseModel, zone: number): Uint8Array {
  return request(0x12, 0x03, model.lightingAllZones ? 0x00 : zone);
}

export function asusReadBatteryRequest(): Uint8Array {
  return request(0x12, 0x07);
}

/* ---------------------------------
 * WRITES
 * --------------------------------- */

export function asusSetDpiRequest(model: AsusMouseModel, stage: number, dpi: number, color?: AsusRgb): Uint8Array {
  requireStage(model, stage);

  if (!Number.isInteger(dpi) || dpi < model.minDpi || dpi > model.maxDpi || dpi % model.dpiStep !== 0) {
    throw new Error(`${model.name} DPI must be ${model.minDpi}-${model.maxDpi} in ${model.dpiStep}-DPI steps.`);
  }

  const encoded = dpi / model.dpiStep - 1;

  return request(0x51, 0x31, stage, 0x00, encoded & 0xff, (encoded >> 8) & 0xff, ...(color ?? []));
}

export function asusSetActiveDpiStageRequest(model: AsusMouseModel, stage: number): Uint8Array {
  requireStage(model, stage);

  return request(0x51, 0x31, 0x09, 0x00, stage + 1);
}

export function asusSetPollingRateRequest(model: AsusMouseModel, pollingRateHz: number): Uint8Array {
  const rateIndex = ASUS_POLLING_RATES.findIndex((rate) => rate === pollingRateHz);
  if (rateIndex === -1) {
    throw new Error(`Unsupported ${model.name} polling rate: ${pollingRateHz} Hz.`);
  }

  return request(0x51, 0x31, settingField(model, FIELD_RATE), 0x00, rateIndex);
}

export function asusSetProfileRequest(model: AsusMouseModel, profile: number): Uint8Array {
  if (!Number.isInteger(profile) || profile < 1 || profile > model.profiles) {
    throw new Error(`${model.name} profile must be 1-${model.profiles}.`);
  }

  return request(0x50, 0x02, profile - 1);
}

export function asusSetAngleSnappingRequest(model: AsusMouseModel, enabled: boolean): Uint8Array {
  return request(0x51, 0x31, settingField(model, FIELD_SNAPPING), 0x00, enabled ? 0x01 : 0x00);
}

export function asusSetDebounceRequest(model: AsusMouseModel, milliseconds: number): Uint8Array {
  if (!ASUS_DEBOUNCE_MS.some((value) => value === milliseconds)) {
    throw new Error(`${model.name} debounce must be one of: ${ASUS_DEBOUNCE_MS.join(", ")} ms.`);
  }

  return request(0x51, 0x31, settingField(model, FIELD_DEBOUNCE), 0x00, milliseconds / 4 - 1);
}

/** Also resets the surface calibration; ASUS has no separate lift-off command. */
export function asusSetLiftOffRequest(value: AsusLiftOffDistance): Uint8Array {
  return request(0x51, 0x35, 0xff, 0x00, 0xff, value === "High" ? 1 : 0);
}

export function asusSetLightingRequest(
  model: AsusMouseModel,
  zone: number,
  mode: number,
  brightness: number,
  red: number,
  green: number,
  blue: number,
  speed = 0,
): Uint8Array {
  if (!Number.isInteger(zone) || zone < 0 || zone >= model.zones.length) {
    throw new Error(`${model.name} RGB zone must be 0-${model.zones.length - 1}.`);
  }

  if (brightness < 0 || brightness > model.brightnessMax) {
    throw new Error(`${model.name} RGB brightness must be 0-${model.brightnessMax}.`);
  }

  // Bytes 9 and 10 are the animation direction and random-colour flag, unused here.
  return request(0x51, 0x28, zone, 0x00, mode, brightness, red, green, blue, 0x00, 0x00, speed);
}

export function asusSaveRequest(): Uint8Array {
  return request(0x50, 0x03);
}
