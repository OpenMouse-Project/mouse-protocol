import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGITECH_FRIENDLY_NAME_BYTES_PER_REPORT,
  buildFriendlyNameWrite,
  decodeFriendlyNameChunk,
  decodeFriendlyNameLengths,
  decodeFriendlyNameText,
  encodeFriendlyName,
  rejectFriendlyName,
} from "./friendly-name.js";

test("decodes the lengths captured from hardware", () => {
  // An MX Master 4 reports 11 of a maximum 14.
  assert.deepEqual(decodeFriendlyNameLengths([0x0b, 0x0e]), { length: 11, maxLength: 14 });
});

test("a reply with no maximum decodes as null rather than a zero-length limit", () => {
  // A maxLength of 0 would refuse every name with "at most 0 characters".
  assert.equal(decodeFriendlyNameLengths([0x0b, 0x00]), null);
  assert.equal(decodeFriendlyNameLengths([0x0b]), null);
  assert.equal(decodeFriendlyNameLengths([]), null);
});

test("a chunk skips the echoed offset", () => {
  // 00 4D 58 20 4D 61 73 74 65 72 20 34 — the leading 00 is the offset asked
  // for. Reading from index 0 puts it in the name and shifts every character.
  const payload = [0x00, ...[..."MX Master 4"].map((c) => c.charCodeAt(0))];
  const characters = decodeFriendlyNameChunk(payload, 11);
  assert.equal(decodeFriendlyNameText(characters), "MX Master 4");
});

test("a chunk never takes more characters than remain", () => {
  const payload = [0x00, ...[..."MX Master 4XXXX"].map((c) => c.charCodeAt(0))];
  assert.equal(decodeFriendlyNameText(decodeFriendlyNameChunk(payload, 11)), "MX Master 4");
  assert.deepEqual(decodeFriendlyNameChunk(payload, 0), []);
  assert.deepEqual(decodeFriendlyNameChunk(payload, -1), []);
});

test("trailing padding is not part of the name", () => {
  assert.equal(decodeFriendlyNameText([0x4d, 0x58, 0x00, 0x00]), "MX");
  assert.equal(decodeFriendlyNameText([0x20, 0x4d, 0x58, 0x20]), "MX");
});

test("a name the device can hold is accepted", () => {
  assert.equal(rejectFriendlyName("Desk mouse", 14), null);
  assert.equal(rejectFriendlyName("MX Master 4", 14), null);
});

test("a name the device cannot hold is refused before anything is written", () => {
  // Validated up front: a device that takes half a name and rejects the rest
  // leaves the user with neither the old one nor the new.
  assert.equal(rejectFriendlyName("A".repeat(15), 14), "too-long");
  assert.equal(rejectFriendlyName("", 14), "empty");
  assert.equal(rejectFriendlyName("   ", 14), "empty");
  assert.equal(rejectFriendlyName("Maus ü", 14), "non-ascii");
  assert.equal(rejectFriendlyName("Maus — 4", 14), "non-ascii");
});

test("a name too long for one report is refused rather than paged", () => {
  // Reachable only on a device allowing more than fifteen characters; an
  // honest refusal beats paging logic that has never run.
  const long = "A".repeat(LOGITECH_FRIENDLY_NAME_BYTES_PER_REPORT + 1);
  assert.equal(rejectFriendlyName(long, 32), "too-long-for-one-report");
});

test("the write is offset zero followed by the characters", () => {
  assert.deepEqual(buildFriendlyNameWrite("MX"), [0x00, 0x4d, 0x58]);
  assert.deepEqual(encodeFriendlyName("  MX  "), [0x4d, 0x58]);
});
