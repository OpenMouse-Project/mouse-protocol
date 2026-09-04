import assert from "node:assert/strict";
import test from "node:test";

import {
  ATK_SENSORS,
  atkDecodeLiftOff,
  atkPackDpiStage,
  atkPackDpiStageForSensor,
  atkUnpackDpiStage,
  atkUnpackDpiStageForSensor,
} from "@openmouse/protocol/atk";
import { ATK_PRODUCTS } from "./products.ts";
import { AtkHidClient } from "./hid.ts";

test("DPI stages survive a round trip across every step range", () => {
  for (const [x, y] of [[50, 50], [800, 800], [10000, 1600], [10050, 10050], [26000, 26000], [42000, 42000]]) {
    const stage = atkPackDpiStage(x!, y!);
    const sum = stage.reduce((total, byte) => total + byte, 0);

    assert.equal(sum & 0xff, 0x55, `stage checksum for ${x}/${y}`);
    assert.deepEqual(atkUnpackDpiStage(stage), { x, y });
  }
});

test("DPI stages with a corrupt checksum are rejected", () => {
  const stage = atkPackDpiStage(1600, 1600);
  stage[3] ^= 0xff;

  assert.equal(atkUnpackDpiStage(stage), null);
  assert.equal(atkUnpackDpiStage([1, 2, 3]), null);
});

test("Lift-off codes decode to millimetres", () => {
  assert.equal(atkDecodeLiftOff(1), 0.7);
  assert.equal(atkDecodeLiftOff(4), 1);
  assert.equal(atkDecodeLiftOff(11), 1.7);
  assert.equal(atkDecodeLiftOff(0), null);
});

/**
 * Captured from a VXE R1 (CID/MID 2,12, PAW3395, firmware "Mouse 3.13") behind
 * receiver 0x373b:0x1085. Stage bytes read from EEPROM 0x000c..0x001b, whose
 * four stages the mouse's own DPI button cycles as 800/1200/1600/3200.
 */
const R1_STAGES: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0x0f, 0x0f, 0x00, 0x37], 800],
  [[0x17, 0x17, 0x00, 0x27], 1200],
  [[0x1f, 0x1f, 0x00, 0x17], 1600],
  [[0x3f, 0x3f, 0x00, 0xd7], 3200],
];

test("a PAW3395 stage decodes as 50-DPI steps, not the A9's 10-DPI steps", () => {
  for (const [bytes, dpi] of R1_STAGES) {
    assert.deepEqual(
      atkUnpackDpiStageForSensor("PAW3395", bytes),
      { x: dpi, y: dpi },
      `PAW3395 stage ${bytes.map((b) => b.toString(16)).join(" ")}`,
    );
    // The A9 encoding reads the same bytes a fifth as large; that mismatch is
    // the bug this sensor split fixes.
    assert.deepEqual(atkUnpackDpiStage(bytes), { x: dpi / 5, y: dpi / 5 });
  }
});

test("step-50 sensors round trip DPI across the doubling threshold", () => {
  for (const sensor of ["PAW3395", "PAW3950", "CORE26K"] as const) {
    const { minDpi, maxDpi } = ATK_SENSORS[sensor];
    for (const dpi of [minDpi, 800, 1600, 26000, maxDpi]) {
      if (dpi > maxDpi) continue;
      const stage = atkPackDpiStageForSensor(sensor, dpi, dpi);

      assert.equal(stage.reduce((total, byte) => total + byte, 0) & 0xff, 0x55, `${sensor} ${dpi} checksum`);
      assert.deepEqual(atkUnpackDpiStageForSensor(sensor, stage), { x: dpi, y: dpi }, `${sensor} ${dpi}`);
    }
  }
});

test("separate axes keep their own doubling flag above 30,000 DPI", () => {
  const stage = atkPackDpiStageForSensor("PAW3950", 36000, 1600);

  assert.deepEqual(atkUnpackDpiStageForSensor("PAW3950", stage), { x: 36000, y: 1600 });
});

test("an unidentified mouse keeps the A9 encoding", () => {
  assert.deepEqual(
    atkUnpackDpiStageForSensor(null, [0x1f, 0x1f, 0x00, 0x17]),
    atkUnpackDpiStage([0x1f, 0x1f, 0x00, 0x17]),
  );
  assert.deepEqual(atkPackDpiStageForSensor(null, 1600, 1600), atkPackDpiStage(1600, 1600));
});

test("every catalogued product names a sensor whose encoding is implemented", () => {
  for (const [cidMid, product] of Object.entries(ATK_PRODUCTS)) {
    assert.ok(/^\d+,\d+$/.test(cidMid), `${cidMid} is a "cid,mid" key`);
    assert.ok(ATK_SENSORS[product.sensor], `${product.model} sensor ${product.sensor} has a profile`);
  }
});

function deviceWith(vendorId: number, productId: number): HIDDevice {
  return {
    vendorId,
    productId,
    collections: [{
      usagePage: 0xff02,
      usage: 0x02,
      children: [],
      inputReports: [{ reportId: 0x08, items: [{ reportSize: 8, reportCount: 16 }] }],
      outputReports: [{ reportId: 0x08, items: [{ reportSize: 8, reportCount: 16 }] }],
      featureReports: [],
    }],
  } as unknown as HIDDevice;
}

test("both of the VXE R1's transports are claimed", () => {
  // 2.4 GHz receiver under ATK's own vendor id.
  assert.ok(AtkHidClient.isSupported(deviceWith(0x373b, 0x1085)));
  // Wired, under COMPX's 0x3554.
  assert.ok(AtkHidClient.isSupported(deviceWith(0x3554, 0xf58f)));
});

test("0x3554 is claimed by product id, never vendor-wide", () => {
  // The VGN Dragonfly F2 shares this vendor id and has its own driver.
  for (const productId of [0xfb56, 0xfb57, 0xf520]) {
    assert.equal(AtkHidClient.isSupported(deviceWith(0x3554, productId)), false, productId.toString(16));
  }
});

test("a device without the 0xff02 config collection is not claimed", () => {
  const pointerOnly = {
    vendorId: 0x373b,
    productId: 0x1085,
    collections: [{ usagePage: 0x01, usage: 0x02, children: [], inputReports: [], outputReports: [], featureReports: [] }],
  } as unknown as HIDDevice;

  assert.equal(AtkHidClient.isSupported(pointerOnly), false);
});
