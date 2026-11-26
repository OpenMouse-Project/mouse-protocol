import assert from "node:assert/strict";
import test from "node:test";

import {
  ATK_MOUSE_DEVICES,
  atkDeviceForHid,
  atkDevicesForCidMid,
  atkDevicesForHid,
} from "./device-catalog.generated.ts";

// The catalog is generated from the ATK HUB web bundle; these tests pin the
// shape and a few anchors so a regeneration that regresses is caught.

test("catalog has the full mouse line, not the old 8-entry table", () => {
  assert.ok(ATK_MOUSE_DEVICES.length >= 199, `only ${ATK_MOUSE_DEVICES.length} devices`);
});

test("every entry has an identity and a sensor", () => {
  for (const device of ATK_MOUSE_DEVICES) {
    assert.ok(device.model.length > 0, "model missing");
    assert.ok(device.vendorId > 0 && device.productId > 0, `bad vid/pid for ${device.model}`);
    assert.ok(device.sensor, `sensor missing for ${device.model}`);
  }
});

test("verified anchors match the driver's hand-built table", () => {
  // products.ts: "1,8" -> ATK F1 Ultimate 2.0, PAW3950Ultra.
  const f1Ultimate2 = atkDeviceForHid(0x373b, 0x11e4);
  assert.equal(f1Ultimate2?.model, "ATK F1 Ultimate 2.0");
  assert.equal(f1Ultimate2?.cidMid, "1,8");
  assert.equal(f1Ultimate2?.sensor, "PAW3950Ultra");
  assert.equal(f1Ultimate2?.firmwareMark, "f1");
});

test("shared USB ids resolve only with the runtime CID/MID", () => {
  const shared = atkDevicesForHid(0x3554, 0xf58c);
  assert.ok(shared.length > 1, "expected an ambiguous 0x3554:0xf58c");
  assert.equal(atkDeviceForHid(0x3554, 0xf58c), undefined);
  assert.equal(atkDeviceForHid(0x3554, 0xf58c, "2,27")?.model, "VXE R1 PRO MAX");
});

test("CID/MID is not unique and must not be used alone", () => {
  // "1,8" is F1 Ultimate 2.0 but also another model; the key alone is unsafe.
  assert.ok(atkDevicesForCidMid("1,8").length > 1);
});

test("per-device feature flags are present where the vendor sets them", () => {
  const f1Ultimate2 = atkDeviceForHid(0x373b, 0x11e4);
  assert.equal(f1Ultimate2?.features.noDpiRGB, true);
  assert.equal(f1Ultimate2?.features.noBottomButton, true);
  // A model without the flags keeps them absent (vendor default = feature on).
  const plain = atkDeviceForHid(0x373b, 0x1017);
  assert.ok(plain);
  assert.equal(plain?.features.noDpiRGB, undefined);
});
