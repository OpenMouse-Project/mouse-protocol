import assert from "node:assert/strict";
import test from "node:test";

import {
  AMKETTE_XS_BLUETOOTH_PRODUCT_ID,
  AMKETTE_XS_PRODUCT_IDS,
  AMKETTE_XS_USAGE,
  amketteBluetoothSlot,
  amketteIsReceiverName,
  amketteXsModel,
} from "./xs.ts";

test("the XS IDs add Bluetooth to the two shared product IDs, on usage 0x00", () => {
  assert.equal(AMKETTE_XS_BLUETOOTH_PRODUCT_ID, 0x026d);
  assert.deepEqual([...AMKETTE_XS_PRODUCT_IDS].sort(), [0x026d, 0x026e, 0x026f]);
  assert.equal(AMKETTE_XS_USAGE, 0x00);
});

test("Amkette models are found only by the strings the firmware reports", () => {
  assert.equal(amketteXsModel("XS Speed")?.name, "XS Flow 2 Speed");
  assert.equal(amketteXsModel("XS Speed")?.lightingScheme, 1);
  assert.equal(amketteXsModel("XS speed 2")?.name, "XS Flow 2 Speed", "the Bluetooth LE name");
  assert.equal(amketteXsModel("XS Flow+")?.name, "XS Flow Plus");
  assert.equal(amketteXsModel("XS Natural+")?.lightingScheme, 4);
  // Retail names are not reported by the firmware, so they are not matched.
  assert.equal(amketteXsModel("XS Flow 2 Speed"), null);
  assert.equal(amketteXsModel("XS Natural Plus"), null);
  assert.equal(amketteXsModel(""), null);
  assert.equal(amketteXsModel(null), null);
  assert.equal(amketteXsModel("Kyu Pro MX1"), null);
});

test("receiver strings are generic, model names are not", () => {
  assert.equal(amketteIsReceiverName("2.4G Wireless Receiver"), true);
  assert.equal(amketteIsReceiverName("USB Dongle"), true);
  assert.equal(amketteIsReceiverName("XS Speed"), false);
  assert.equal(amketteIsReceiverName(""), false);
  assert.equal(amketteIsReceiverName(null), false);
});

test("the Bluetooth name carries the slot of the three the mouse holds", () => {
  for (const slot of [1, 2, 3]) {
    assert.equal(amketteXsModel(`XS speed ${slot}`)?.name, "XS Flow 2 Speed");
    assert.equal(amketteBluetoothSlot(`XS speed ${slot}`), slot);
  }
  assert.equal(amketteBluetoothSlot("XS speed 4"), null);
  assert.equal(amketteBluetoothSlot("XS speed"), null, "the USB label has no slot");
  assert.equal(amketteBluetoothSlot("XS speed 22"), null);
  assert.equal(amketteXsModel("XS speed 4"), null);
  assert.equal(amketteBluetoothSlot("Kyu Pro MX1"), null);
  assert.equal(amketteBluetoothSlot(null), null);
});
