import assert from "node:assert/strict";
import test from "node:test";

import {
  ASUS_REPORT_SIZE,
  decodeGladiusIIProfile,
  decodeGladiusIISettings,
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
} from "../../asus/index.ts";

function packet(hex: string): Uint8Array {
  return Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((value) =>
        Number.parseInt(value, 16),
      ),
  );
}

function expectPrefix(
  actual: Uint8Array,
  expected: number[],
): void {
  assert.equal(
    actual.length,
    ASUS_REPORT_SIZE,
  );

  assert.deepEqual(
    [...actual.slice(0, expected.length)],
    expected,
  );

  // Everything after the command should remain zero-filled.
  assert.ok(
    [...actual.slice(expected.length)].every(
      (value) => value === 0,
    ),
  );
}

/* ---------------------------------------------------------
 * VERIFIED HARDWARE READ CAPTURES
 * --------------------------------------------------------- */

test(
  "decodes verified Gladius II settings capture",
  () => {
    const response = packet(`
      12 04 00 00
      0E 00
      0B 00
      03
      00
      07
      00
      00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00
    `);

    const result =
      decodeGladiusIISettings(
        response,
      );

    assert.deepEqual(
      result.dpiStages,
      [1500, 1200],
    );

    assert.equal(
      result.pollingRateHz,
      1000,
    );

    assert.equal(
      result.debounceMs,
      32,
    );

    assert.equal(
      result.angleSnapping,
      false,
    );
  },
);

test(
  "decodes verified Gladius II profile capture",
  () => {
    const response = packet(`
      12 00 00 00
      30 31 39 35
      03 06
      00
      01
      0E 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00 00 00 00 00 00 00
      00 00
    `);

    const result =
      decodeGladiusIIProfile(
        response,
      );

    assert.equal(
      result.onboardProfile,
      1,
    );

    assert.equal(
      result.activeDpiStage,
      0,
    );
  },
);

/* ---------------------------------------------------------
 * READ REQUESTS
 * --------------------------------------------------------- */

test(
  "builds Gladius II settings read request",
  () => {
    expectPrefix(
      gladiusIIReadSettingsRequest(),
      [
        0x12,
        0x04,
        0x00,
      ],
    );
  },
);

test(
  "builds Gladius II profile read request",
  () => {
    expectPrefix(
      gladiusIIReadProfileRequest(),
      [
        0x12,
        0x00,
      ],
    );
  },
);

/* ---------------------------------------------------------
 * DPI
 * --------------------------------------------------------- */

test(
  "builds stage 1 1600 DPI request",
  () => {
    expectPrefix(
      gladiusIISetDpiRequest(
        0,
        1600,
      ),
      [
        0x51,
        0x31,
        0x00,
        0x00,
        0x0f,
        0x00,
      ],
    );
  },
);

test(
  "builds stage 2 12000 DPI request",
  () => {
    /*
     * (12000 - 100) / 100 = 119
     * 119 = 0x0077
     */
    expectPrefix(
      gladiusIISetDpiRequest(
        1,
        12000,
      ),
      [
        0x51,
        0x31,
        0x01,
        0x00,
        0x77,
        0x00,
      ],
    );
  },
);

test(
  "rejects invalid DPI value",
  () => {
    assert.throws(
      () =>
        gladiusIISetDpiRequest(
          0,
          1550,
        ),
      /DPI must be/,
    );
  },
);

test(
  "rejects invalid DPI stage",
  () => {
    assert.throws(
      () =>
        gladiusIISetDpiRequest(
          2,
          1600,
        ),
      /stage must be 0 or 1/,
    );
  },
);

test(
  "builds active DPI stage 2 request",
  () => {
    expectPrefix(
      gladiusIISetActiveDpiStageRequest(
        1,
      ),
      [
        0x51,
        0x31,
        0x09,
        0x00,
        0x02,
      ],
    );
  },
);

/* ---------------------------------------------------------
 * POLLING RATE
 * --------------------------------------------------------- */

test(
  "builds 125 Hz polling request",
  () => {
    expectPrefix(
      gladiusIISetPollingRateRequest(
        125,
      ),
      [
        0x51,
        0x31,
        0x02,
        0x00,
        0x00,
      ],
    );
  },
);

test(
  "builds 500 Hz polling request",
  () => {
    expectPrefix(
      gladiusIISetPollingRateRequest(
        500,
      ),
      [
        0x51,
        0x31,
        0x02,
        0x00,
        0x02,
      ],
    );
  },
);

test(
  "builds 1000 Hz polling request",
  () => {
    expectPrefix(
      gladiusIISetPollingRateRequest(
        1000,
      ),
      [
        0x51,
        0x31,
        0x02,
        0x00,
        0x03,
      ],
    );
  },
);

test(
  "rejects unsupported polling rate",
  () => {
    assert.throws(
      () =>
        gladiusIISetPollingRateRequest(
          2000,
        ),
      /Unsupported Gladius II polling rate/,
    );
  },
);

/* ---------------------------------------------------------
 * ONBOARD PROFILES
 * --------------------------------------------------------- */

test(
  "builds profile 1 request",
  () => {
    expectPrefix(
      gladiusIISetProfileRequest(
        1,
      ),
      [
        0x50,
        0x02,
        0x00,
      ],
    );
  },
);

test(
  "builds profile 3 request",
  () => {
    expectPrefix(
      gladiusIISetProfileRequest(
        3,
      ),
      [
        0x50,
        0x02,
        0x02,
      ],
    );
  },
);

test(
  "rejects invalid profile",
  () => {
    assert.throws(
      () =>
        gladiusIISetProfileRequest(
          4,
        ),
      /profile must be 1-3/,
    );
  },
);

/* ---------------------------------------------------------
 * ANGLE SNAPPING
 * --------------------------------------------------------- */

test(
  "builds angle snapping on request",
  () => {
    expectPrefix(
      gladiusIISetAngleSnappingRequest(
        true,
      ),
      [
        0x51,
        0x31,
        0x04,
        0x00,
        0x01,
      ],
    );
  },
);

test(
  "builds angle snapping off request",
  () => {
    expectPrefix(
      gladiusIISetAngleSnappingRequest(
        false,
      ),
      [
        0x51,
        0x31,
        0x04,
        0x00,
        0x00,
      ],
    );
  },
);

/* ---------------------------------------------------------
 * DEBOUNCE
 * --------------------------------------------------------- */

test(
  "builds 12 ms debounce request",
  () => {
    expectPrefix(
      gladiusIISetDebounceRequest(
        12,
      ),
      [
        0x51,
        0x31,
        0x03,
        0x00,
        0x02,
      ],
    );
  },
);

test(
  "builds 32 ms debounce request",
  () => {
    expectPrefix(
      gladiusIISetDebounceRequest(
        32,
      ),
      [
        0x51,
        0x31,
        0x03,
        0x00,
        0x07,
      ],
    );
  },
);

test(
  "rejects unsupported debounce value",
  () => {
    assert.throws(
      () =>
        gladiusIISetDebounceRequest(
          10,
        ),
      /debounce must be one of/,
    );
  },
);

/* ---------------------------------------------------------
 * LIFT-OFF DISTANCE
 * --------------------------------------------------------- */

test(
  "builds low lift-off distance request",
  () => {
    expectPrefix(
      gladiusIISetLiftOffRequest(
        "Low",
      ),
      [
        0x51,
        0x35,
        0xff,
        0x00,
        0xff,
        0x00,
      ],
    );
  },
);

test(
  "builds high lift-off distance request",
  () => {
    expectPrefix(
      gladiusIISetLiftOffRequest(
        "High",
      ),
      [
        0x51,
        0x35,
        0xff,
        0x00,
        0xff,
        0x01,
      ],
    );
  },
);

/* ---------------------------------------------------------
 * RGB
 * --------------------------------------------------------- */

test(
  "builds static red logo RGB request",
  () => {
    expectPrefix(
      gladiusIISetLightingRequest(
        0,
        0x00,
        4,
        0xff,
        0x00,
        0x00,
      ),
      [
        0x51,
        0x28,
        0x00,
        0x00,
        0x00,
        0x04,
        0xff,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ],
    );
  },
);

test(
  "builds RGB request for underglow zone",
  () => {
    expectPrefix(
      gladiusIISetLightingRequest(
        2,
        0x01,
        3,
        0x12,
        0x34,
        0x56,
        1,
        0,
        0x64,
      ),
      [
        0x51,
        0x28,
        0x02,
        0x00,
        0x01,
        0x03,
        0x12,
        0x34,
        0x56,
        0x01,
        0x00,
        0x64,
      ],
    );
  },
);

test(
  "rejects invalid RGB zone",
  () => {
    assert.throws(
      () =>
        gladiusIISetLightingRequest(
          3,
          0,
          4,
          255,
          0,
          0,
        ),
      /RGB zone must be 0, 1, or 2/,
    );
  },
);

test(
  "rejects invalid RGB brightness",
  () => {
    assert.throws(
      () =>
        gladiusIISetLightingRequest(
          0,
          0,
          5,
          255,
          0,
          0,
        ),
      /brightness must be 0-4/,
    );
  },
);

/* ---------------------------------------------------------
 * SAVE
 * --------------------------------------------------------- */

test(
  "builds ASUS save request",
  () => {
    expectPrefix(
      gladiusIISaveRequest(),
      [
        0x50,
        0x03,
      ],
    );
  },
);