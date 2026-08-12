import type { MouseLighting, MouseLightingMode } from "../mouse-types.ts";

export interface LogitechRgbEffect {
  index: number;
  id: number;
  period: number;
}

export interface LogitechRgbZone {
  index: number;
  location: number;
  effects: LogitechRgbEffect[];
}

const EFFECT_MODES: Readonly<Record<number, MouseLightingMode>> = {
  0x00: "Off",
  0x01: "Static",
  0x03: "Cycling",
  0x04: "Wave",
  0x0a: "Breathing single",
  0x15: "Cycling",
  0x16: "Wave",
};

export function logitechRgbMode(effectId: number): MouseLightingMode | null {
  return EFFECT_MODES[effectId] ?? null;
}

export function logitechRgbLighting(zone: LogitechRgbZone): MouseLighting | null {
  const modes = [...new Set(zone.effects.map(({ id }) => logitechRgbMode(id)).filter((mode) => mode !== null))];
  if (modes.length === 0) return null;
  return {
    zone: zone.location === 0x05 ? "Combined" : "RGB",
    modes,
    mode: null,
    color: "#00ff00",
    color2: null,
    colorModes: modes.filter((mode) => mode === "Static" || mode === "Breathing single"),
    dualColorModes: [],
    reactiveModes: modes.filter((mode) => mode === "Cycling" || mode === "Wave" || mode === "Breathing single"),
    speeds: [1000, 2000, 3000, 5000, 10000],
    speed: 5000,
    writeOnly: true,
  };
}

export function encodeLogitechRgbEffect(
  zone: LogitechRgbZone,
  lighting: MouseLighting,
): number[] | null {
  if (!lighting.mode) return null;
  const effect = zone.effects.find(({ id }) => logitechRgbMode(id) === lighting.mode);
  if (!effect) return null;
  const parameters = new Uint8Array(10);
  if (lighting.mode === "Static" || lighting.mode === "Breathing single") {
    const color = Number.parseInt((lighting.color ?? "#00ff00").slice(1), 16);
    parameters[0] = (color >> 16) & 0xff;
    parameters[1] = (color >> 8) & 0xff;
    parameters[2] = color & 0xff;
  }
  const period = lighting.speed ?? (effect.period || 5000);
  if (lighting.mode === "Cycling") {
    parameters[5] = (period >> 8) & 0xff;
    parameters[6] = period & 0xff;
    parameters[7] = 100;
  } else if (lighting.mode === "Wave") {
    parameters[6] = (period >> 8) & 0xff;
    parameters[7] = period & 0xff;
  } else if (lighting.mode === "Breathing single") {
    parameters[3] = (period >> 8) & 0xff;
    parameters[4] = period & 0xff;
    parameters[6] = 100;
  } else if (lighting.mode === "Static") {
    parameters[3] = 0x02;
  }
  return [zone.index, effect.index, ...parameters, 0x01];
}
