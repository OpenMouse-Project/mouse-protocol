import assert from "node:assert/strict";
import test from "node:test";

import {
  pulsarDataChecksum,
  pulsarDecodeDpi,
  pulsarDecodePollingRate,
  pulsarEncodeDpi,
  pulsarEncodePollingRate,
  pulsarPacketChecksum,
} from "@openmouse/protocol/pulsar";

test("captured Pulsar 4K receiver DPI stages decode as 50-step values", () => {
  // The mouse's own flash slots and the physical DPI button cycle write these
  // four-byte stages; they must decode to the real sensitivities.
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x0f, 0x0f, 0x00, 0x37])), 800);
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x1f, 0x1f, 0x00, 0x17])), 1600);
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x3f, 0x3f, 0x00, 0xd7])), 3200);
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x13, 0x13, 0x00, 0x2f])), 1000);
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x07, 0x07, 0x88, 0xbf])), 26000);
});

test("DPI codec rejects corrupt or mismatched stages", () => {
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x0f, 0x0f, 0x00, 0x00])), null);
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x0f, 0x1f, 0x00, 0x37])), null);
  assert.equal(pulsarDecodeDpi(new Uint8Array([0x0f, 0x0f, 0x00])), null);
});

test("DPI and polling rate codecs round-trip supported UI values", () => {
  const dpis = [50, 400, 800, 1600, 26000];
  const rates = [125, 250, 500, 1000, 2000, 4000, 8000];

  for (const dpi of dpis) assert.equal(pulsarDecodeDpi(pulsarEncodeDpi(dpi)), dpi);
  for (const rate of rates) assert.equal(pulsarDecodePollingRate(pulsarEncodePollingRate(rate)), rate);
});

test("encoded DPI stage writes match the captured byte pattern", () => {
  assert.deepEqual([...pulsarEncodeDpi(800)], [0x0f, 0x0f, 0x00, 0x37]);
  assert.deepEqual([...pulsarEncodeDpi(1600)], [0x1f, 0x1f, 0x00, 0x17]);
  assert.deepEqual([...pulsarEncodeDpi(3200)], [0x3f, 0x3f, 0x00, 0xd7]);
});

test("packet and data checksums match the shared VGN scheme", () => {
  assert.equal(pulsarDataChecksum(new Uint8Array([0x0f, 0x0f, 0x00])), 0x37);
  assert.equal(pulsarPacketChecksum(new Uint8Array(16)), (0x55 - 0x08) & 0xff);
});
