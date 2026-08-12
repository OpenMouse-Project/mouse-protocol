import assert from "node:assert/strict";
import test from "node:test";

import { encodeLogitechRgbEffect, logitechRgbLighting, type LogitechRgbZone } from "./rgb-effects.ts";

const zone: LogitechRgbZone = {
  index: 0,
  location: 5,
  effects: [
    { index: 0, id: 0, period: 0 },
    { index: 1, id: 1, period: 0 },
    { index: 2, id: 0x15, period: 5000 },
  ],
};

test("maps an advertised G502 X RGB cluster into OpenMouse lighting", () => {
  const lighting = logitechRgbLighting(zone);
  assert.deepEqual(lighting?.modes, ["Off", "Static", "Cycling"]);
  assert.equal(lighting?.zone, "Combined");
  assert.equal(lighting?.writeOnly, true);
});

test("encodes the Solaar 0x8071 SetEffectByIndex payload", () => {
  const lighting = logitechRgbLighting(zone)!;
  assert.deepEqual(encodeLogitechRgbEffect(zone, {
    ...lighting,
    mode: "Static",
    color: "#123456",
  }), [0, 1, 0x12, 0x34, 0x56, 0x02, 0, 0, 0, 0, 0, 0, 1]);
});
