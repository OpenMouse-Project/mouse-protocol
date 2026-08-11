import assert from "node:assert/strict";
import test from "node:test";

import {
  ZAUNKOENIG_M2K_PRODUCT_ID,
  ZAUNKOENIG_M3K_PRODUCT_ID,
  zaunkoenigBuildConfigPayload,
  zaunkoenigBuildFactoryResetPayload,
  zaunkoenigDecodeConfigReport,
  zaunkoenigDecodeVersionReport,
  zaunkoenigEncodeConfigWord,
  zaunkoenigFirmwareIsSupported,
} from "../../zaunkoenig/index.ts";

test("decodes the M3K factory-default packed word", () => {
  const config = zaunkoenigDecodeConfigReport(
    new Uint8Array([3, 0x0f, 0x22, 0, 0]),
    ZAUNKOENIG_M3K_PRODUCT_ID,
  );
  assert.deepEqual(config, {
    usbSpeed: "High",
    pollingRateHz: 8000,
    pollingRateCode: 0,
    liftOffDistanceMm: 2,
    angleSnapping: false,
    primaryButton: "Left",
    dpi: 800,
  });
  assert.equal(zaunkoenigEncodeConfigWord(config, ZAUNKOENIG_M3K_PRODUCT_ID), 0x220f);
});

test("round-trips every M3K field and builds the four-byte write payload", () => {
  const config = {
    usbSpeed: "High" as const,
    pollingRateHz: 2000 as const,
    pollingRateCode: 2 as const,
    liftOffDistanceMm: 3 as const,
    angleSnapping: true,
    primaryButton: "Right" as const,
    dpi: 20_000,
  };
  const word = zaunkoenigEncodeConfigWord(config, ZAUNKOENIG_M3K_PRODUCT_ID);
  assert.deepEqual([...zaunkoenigBuildConfigPayload(config, ZAUNKOENIG_M3K_PRODUCT_ID)], [word & 0xff, word >> 8, 0, 0]);
  assert.deepEqual(zaunkoenigDecodeConfigReport(new Uint8Array([word & 0xff, word >> 8]), ZAUNKOENIG_M3K_PRODUCT_ID), config);
});

test("uses the M2K's 100 DPI steps and 2/3 mm LOD encoding", () => {
  const config = zaunkoenigDecodeConfigReport(new Uint8Array([3, 0x0f, 0x84]), ZAUNKOENIG_M2K_PRODUCT_ID);
  assert.equal(config.dpi, 1600);
  assert.equal(config.liftOffDistanceMm, 2);
  assert.equal(config.primaryButton, "Right");
  assert.throws(() => zaunkoenigEncodeConfigWord({ ...config, dpi: 50 }, ZAUNKOENIG_M2K_PRODUCT_ID), /100–12000/);
  assert.throws(() => zaunkoenigEncodeConfigWord({ ...config, liftOffDistanceMm: 1 }, ZAUNKOENIG_M2K_PRODUCT_ID), /2 or 3 mm/);
});

test("decodes the firmware report and exposes the exact compatibility gate", () => {
  const report = new Uint8Array([2, ...Buffer.from("parawizard new v0.8.2"), 0, 0x20]);
  assert.equal(zaunkoenigDecodeVersionReport(report), "parawizard new v0.8.2");
  assert.equal(zaunkoenigFirmwareIsSupported("parawizard new v0.8.2"), true);
  assert.equal(zaunkoenigFirmwareIsSupported("parawizard v0.7"), false);
  assert.deepEqual([...zaunkoenigBuildFactoryResetPayload()], [0, 0, 0xff, 0xff]);
});

test("rejects polling rates that Full-speed USB cannot carry", () => {
  const base = zaunkoenigDecodeConfigReport(new Uint8Array([3, 0x0f, 0x22]), ZAUNKOENIG_M3K_PRODUCT_ID);
  assert.throws(
    () => zaunkoenigEncodeConfigWord({ ...base, usbSpeed: "Full", pollingRateHz: 8000 }, ZAUNKOENIG_M3K_PRODUCT_ID),
    /Full-speed supports only 1000 Hz/,
  );
});

test("preserves dormant interval bits while USB is in Full-speed mode", () => {
  const highSpeed = zaunkoenigDecodeConfigReport(new Uint8Array([3, 0x0f, 0x22]), ZAUNKOENIG_M3K_PRODUCT_ID);
  const fullSpeed = { ...highSpeed, usbSpeed: "Full" as const, pollingRateHz: 1000 as const };
  const word = zaunkoenigEncodeConfigWord(fullSpeed, ZAUNKOENIG_M3K_PRODUCT_ID);
  assert.equal((word >> 11) & 0b11, 0);
  assert.equal(zaunkoenigDecodeConfigReport(new Uint8Array([word & 0xff, word >> 8]), ZAUNKOENIG_M3K_PRODUCT_ID).pollingRateCode, 0);
});
