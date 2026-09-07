import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mchoseA5Gen1DecodeDpi,
  mchoseA5Gen1DecodeReply,
  mchoseA5Gen1EncodeRequest,
  mchoseA5Gen1NormalizeDpi,
  mchoseA5Gen1ReplyMatches,
} from "./a5-gen1.ts";

describe("MCHOSE A5 first-generation codec", () => {
  it("builds the captured XVI request header", () => {
    const packet = mchoseA5Gen1EncodeRequest({ length: 2, page: 1, command: 0x88, data: [1, 4] });
    assert.equal(packet.length, 64);
    assert.deepEqual([...packet.slice(0, 8)], [0, 0, 2, 2, 1, 0x88, 1, 4]);
  });

  it("accepts replies with or without the report id", () => {
    const body = Uint8Array.from([0xa1, 0, 2, 1, 1, 0x80, 1, ...Array(57).fill(0)]);
    assert.deepEqual(mchoseA5Gen1DecodeReply(body, 7), body);
    assert.deepEqual(mchoseA5Gen1DecodeReply(Uint8Array.from([7, ...body]), 7), body);
    assert.equal(mchoseA5Gen1ReplyMatches(body, 1, 0x80), true);
  });

  it("decodes big-endian duplicated DPI pairs", () => {
    const reply = new Uint8Array(64);
    reply[7] = 2;
    reply.set([0x03, 0x20, 0x03, 0x20, 0x06, 0x40, 0x06, 0x40], 8);
    assert.deepEqual(mchoseA5Gen1DecodeDpi(reply), { count: 2, stages: [800, 1600] });
  });

  it("quantizes DPI to the model's 50-step range", () => {
    assert.equal(mchoseA5Gen1NormalizeDpi(1674), 1650);
    assert.equal(mchoseA5Gen1NormalizeDpi(99999), 26000);
  });
});
