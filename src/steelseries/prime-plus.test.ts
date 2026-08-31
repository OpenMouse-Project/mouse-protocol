import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIME_PLUS_DPI_MAX,
  PRIME_PLUS_DPI_MIN,
  PRIME_PLUS_LED_BRIGHTNESS_MAX,
  PRIME_PLUS_MAX_DPI_PRESETS,
  PRIME_PLUS_SAVE_COMMAND,
  PrimePlusProtocolError,
  steelseriesPrimePlusDpiOptions,
  steelseriesPrimePlusEncodeButtonsMapping,
  steelseriesPrimePlusEncodeColor,
  steelseriesPrimePlusEncodeDpiPresets,
  steelseriesPrimePlusEncodeLedBrightness,
  steelseriesPrimePlusEncodePollingRate,
  steelseriesPrimePlusSaveCommand,
} from "./prime-plus.ts";

test("DPI options span the full 50-18000 linear range in 50 DPI steps", () => {
  const options = steelseriesPrimePlusDpiOptions();
  assert.equal(options[0], PRIME_PLUS_DPI_MIN);
  assert.equal(options.at(-1), PRIME_PLUS_DPI_MAX);
  assert.equal(options.length, (PRIME_PLUS_DPI_MAX - PRIME_PLUS_DPI_MIN) / 50 + 1);
});

test("encodes rivalcfg's default five-preset configuration byte for byte", () => {
  // rivalcfg default `sensitivity: "400, 800, 1200, 2400, 3200"`, first preset
  // selected (first_preset: 0, so selectedIndex is used directly, unlike
  // Aerox 3's 1-based scheme).
  // (dpi - 50) / 50 + 1, little-endian 2 bytes each:
  //   400  -> 8   = 0x0008
  //   800  -> 16  = 0x0010
  //   1200 -> 24  = 0x0018
  //   2400 -> 48  = 0x0030
  //   3200 -> 64  = 0x0040
  assert.deepEqual(
    [...steelseriesPrimePlusEncodeDpiPresets([400, 800, 1200, 2400, 3200], 0)],
    [0x61, 0x05, 0x00, 0x08, 0x00, 0x10, 0x00, 0x18, 0x00, 0x30, 0x00, 0x40, 0x00],
  );
  assert.deepEqual([...steelseriesPrimePlusEncodeDpiPresets([50], 0)], [0x61, 0x01, 0x00, 0x01, 0x00]);
  assert.deepEqual([...steelseriesPrimePlusEncodeDpiPresets([18000], 0)], [0x61, 0x01, 0x00, 0x68, 0x01]);
  assert.deepEqual([...steelseriesPrimePlusEncodeDpiPresets([400, 800], 1)], [0x61, 0x02, 0x01, 0x08, 0x00, 0x10, 0x00]);
});

test("rejects off-grid DPI, out-of-bounds DPI, bad preset counts, and bad selected indices", () => {
  assert.throws(() => steelseriesPrimePlusEncodeDpiPresets([825], 0), PrimePlusProtocolError);
  assert.throws(() => steelseriesPrimePlusEncodeDpiPresets([0], 0), PrimePlusProtocolError);
  assert.throws(() => steelseriesPrimePlusEncodeDpiPresets([18050], 0), PrimePlusProtocolError);
  assert.throws(() => steelseriesPrimePlusEncodeDpiPresets([], 0), new RegExp(`1–${PRIME_PLUS_MAX_DPI_PRESETS} DPI presets`));
  assert.throws(
    () => steelseriesPrimePlusEncodeDpiPresets([400, 400, 400, 400, 400, 400], 0),
    new RegExp(`1–${PRIME_PLUS_MAX_DPI_PRESETS} DPI presets`),
  );
  assert.throws(() => steelseriesPrimePlusEncodeDpiPresets([400, 800], -1), PrimePlusProtocolError);
  assert.throws(() => steelseriesPrimePlusEncodeDpiPresets([400, 800], 2), PrimePlusProtocolError);
});

test("encodes every polling rate and rejects rates the mouse does not offer", () => {
  assert.deepEqual([...steelseriesPrimePlusEncodePollingRate(1000)], [0x5d, 0x01]);
  assert.deepEqual([...steelseriesPrimePlusEncodePollingRate(500)], [0x5d, 0x02]);
  assert.deepEqual([...steelseriesPrimePlusEncodePollingRate(250)], [0x5d, 0x03]);
  assert.deepEqual([...steelseriesPrimePlusEncodePollingRate(125)], [0x5d, 0x04]);
  assert.throws(() => steelseriesPrimePlusEncodePollingRate(2000), PrimePlusProtocolError);
});

test("encodes the wheel LED color with rivalcfg's fixed 16-byte suffix", () => {
  assert.deepEqual(
    [...steelseriesPrimePlusEncodeColor(0xff, 0x52, 0x00)],
    [
      0x62, 0x01, 0xff, 0x52, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0xff,
    ],
  );
  assert.throws(() => steelseriesPrimePlusEncodeColor(256, 0, 0), PrimePlusProtocolError);
  assert.throws(() => steelseriesPrimePlusEncodeColor(-1, 0, 0), PrimePlusProtocolError);
});

test("encodes LED brightness as a 2-byte little-endian 0-256 range", () => {
  assert.deepEqual([...steelseriesPrimePlusEncodeLedBrightness(0)], [0x5f, 0x00, 0x00]);
  assert.deepEqual([...steelseriesPrimePlusEncodeLedBrightness(256)], [0x5f, 0x00, 0x01]);
  assert.deepEqual([...steelseriesPrimePlusEncodeLedBrightness(255)], [0x5f, 0xff, 0x00]);
  assert.throws(() => steelseriesPrimePlusEncodeLedBrightness(257), PrimePlusProtocolError);
  assert.throws(() => steelseriesPrimePlusEncodeLedBrightness(-1), PrimePlusProtocolError);
  assert.equal(PRIME_PLUS_LED_BRIGHTNESS_MAX, 256);
});

test("frames the save command as a single byte, distinct from Aerox 3's and Rival 3 Gen 1's", () => {
  assert.deepEqual([...steelseriesPrimePlusSaveCommand()], [0x59]);
  assert.deepEqual([...steelseriesPrimePlusSaveCommand()], [...PRIME_PLUS_SAVE_COMMAND]);
});

test("encodes button mappings into the 30-byte (6 buttons x 5 bytes) zero-filled packet", () => {
  const packet = steelseriesPrimePlusEncodeButtonsMapping({
    button1: { type: "button", target: "button2" },
    button2: { type: "disabled" },
    button3: { type: "dpiSwitch" },
    button4: { type: "scrollUp" },
    button5: { type: "scrollDown" },
    button6: { type: "keyboard", code: 0x04 },
  });
  const expected = new Array(30).fill(0x00);
  expected[0x00] = 0x02; // button1 -> button2
  expected[0x05] = 0x00; // button2 -> disabled
  expected[0x0a] = 0x30; // button3 -> dpiSwitch
  expected[0x0f] = 0x31; // button4 -> scrollUp
  expected[0x14] = 0x32; // button5 -> scrollDown
  expected[0x19] = 0x51; // button6 -> keyboard
  expected[0x1a] = 0x04; // scan code
  assert.deepEqual([...packet], [0x5b, ...expected]);
});

test("encodes a multimedia button mapping", () => {
  const packet = steelseriesPrimePlusEncodeButtonsMapping({
    button1: { type: "multimedia", code: 0xcd },
  });
  const expected = new Array(30).fill(0x00);
  expected[0x00] = 0x61;
  expected[0x01] = 0xcd;
  assert.deepEqual([...packet], [0x5b, ...expected]);
});

test("rejects unknown buttons and out-of-range scan codes", () => {
  assert.throws(
    () => steelseriesPrimePlusEncodeButtonsMapping({ button7: { type: "disabled" } } as never),
    PrimePlusProtocolError,
  );
  assert.throws(
    () => steelseriesPrimePlusEncodeButtonsMapping({ button1: { type: "button", target: "button9" as never } }),
    PrimePlusProtocolError,
  );
  assert.throws(
    () => steelseriesPrimePlusEncodeButtonsMapping({ button1: { type: "keyboard", code: 300 } }),
    PrimePlusProtocolError,
  );
  assert.throws(
    () => steelseriesPrimePlusEncodeButtonsMapping({ button1: { type: "multimedia", code: -1 } }),
    PrimePlusProtocolError,
  );
});
