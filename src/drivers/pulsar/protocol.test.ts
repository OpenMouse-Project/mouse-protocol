import assert from "node:assert/strict";
import test from "node:test";

import {
  pulsarDataChecksum,
  pulsarDecodeDpi,
  pulsarDecodePollingRate,
  pulsarEncodeDpi,
  pulsarEncodePollingRate,
  pulsarPacketChecksum,
  pulsarVgnDecodeDpi,
  pulsarVgnEncodeDpi,
} from "@openmouse/protocol/pulsar";

test("captured Pulsar 4K receiver DPI stages decode as 50-step values", () => {
  // The mouse's own flash slots and the physical DPI button cycle write these
  // four-byte stages; they must decode to the real sensitivities. This receiver
  // enumerates under the shared VGN vendor id (0x3554), not the Pulsar vendor
  // id (0x3710) — see pulsar-hid.ts's vendor-id branch.
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x0f, 0x0f, 0x00, 0x37])), 800);
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x1f, 0x1f, 0x00, 0x17])), 1600);
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x3f, 0x3f, 0x00, 0xd7])), 3200);
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x13, 0x13, 0x00, 0x2f])), 1000);
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x07, 0x07, 0x88, 0xbf])), 26000);
});

test("VGN receiver DPI codec rejects corrupt or mismatched stages", () => {
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x0f, 0x0f, 0x00, 0x00])), null);
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x0f, 0x1f, 0x00, 0x37])), null);
  assert.equal(pulsarVgnDecodeDpi(new Uint8Array([0x0f, 0x0f, 0x00])), null);
});

test("VGN receiver DPI and polling rate codecs round-trip supported UI values", () => {
  const dpis = [50, 400, 800, 1600, 26000];
  const rates = [125, 250, 500, 1000, 2000, 4000, 8000];

  for (const dpi of dpis) assert.equal(pulsarVgnDecodeDpi(pulsarVgnEncodeDpi(dpi)), dpi);
  for (const rate of rates) assert.equal(pulsarDecodePollingRate(pulsarEncodePollingRate(rate)), rate);
});

test("encoded VGN receiver DPI stage writes match the captured byte pattern", () => {
  assert.deepEqual([...pulsarVgnEncodeDpi(800)], [0x0f, 0x0f, 0x00, 0x37]);
  assert.deepEqual([...pulsarVgnEncodeDpi(1600)], [0x1f, 0x1f, 0x00, 0x17]);
  assert.deepEqual([...pulsarVgnEncodeDpi(3200)], [0x3f, 0x3f, 0x00, 0xd7]);
});

// Pulsar-vendor (0x3710) mice, including the X2 CrazyLight (CID 0x57), use a
// 10-step low range plus a dpiEx-flagged high range instead — verified against
// hardware 2026-08-19: bbb.pulsar.gg (Pulsar's own configurator) writes these
// exact bytes for a CrazyLight, and the sensor physically tracks the value
// this decode returns, not the VGN receiver's 50-step reading of the same bytes.
test("captured Pulsar-vendor (CrazyLight) DPI stages decode as 10-step values", () => {
  assert.equal(pulsarDecodeDpi(new Uint8Array([79, 79, 0, 183])), 800);
  assert.equal(pulsarDecodeDpi(new Uint8Array([159, 159, 0, 23])), 1600);
  assert.equal(pulsarDecodeDpi(new Uint8Array([39, 39, 0, 7])), 400);
});

test("Pulsar-vendor DPI codec rejects corrupt or mismatched stages", () => {
  assert.equal(pulsarDecodeDpi(new Uint8Array([79, 79, 0, 0])), null);
  assert.equal(pulsarDecodeDpi(new Uint8Array([79, 159, 0, 183])), null);
  assert.equal(pulsarDecodeDpi(new Uint8Array([79, 79, 0])), null);
});

test("Pulsar-vendor DPI codec round-trips the full catalogue", () => {
  const dpis = [10, 400, 800, 1600, 10000, 10050, 30000, 30100, 32000];
  for (const dpi of dpis) assert.equal(pulsarDecodeDpi(pulsarEncodeDpi(dpi)), dpi);
});

test("encoded Pulsar-vendor DPI stage writes match the captured byte pattern", () => {
  assert.deepEqual([...pulsarEncodeDpi(800)], [79, 79, 0, 183]);
  assert.deepEqual([...pulsarEncodeDpi(1600)], [159, 159, 0, 23]);
  assert.deepEqual([...pulsarEncodeDpi(400)], [39, 39, 0, 7]);
});

test("packet and data checksums match the shared VGN scheme", () => {
  assert.equal(pulsarDataChecksum(new Uint8Array([0x0f, 0x0f, 0x00])), 0x37);
  assert.equal(pulsarPacketChecksum(new Uint8Array(16)), (0x55 - 0x08) & 0xff);
});
