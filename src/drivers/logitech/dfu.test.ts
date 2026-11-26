import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  assertSafeToFlash,
  DFU_FEATURE_ID,
  compareDfuVersions,
  DfuConfirmationError,
  DfuError,
  DfuPreconditionError,
  flashDfuBinary,
  matchDfuContent,
  parseDepotArchive,
  parseDfuJson,
  resolveDfuBinary,
  type DfuBootloaderTransport,
  type DfuContent,
} from "./dfu.ts";

function syntheticDepot(): Uint8Array {
  const encoder = new TextEncoder();
  const manifest = encoder.encode(JSON.stringify({ resources: [{ key: "dfu_binary", src: "mouse_v1.dfu" }] }));
  const dfu = encoder.encode(JSON.stringify({
    contents: [{
      interfaceInfos: [{ interfaceId: "046d_c094", updatable: true }],
      version: "25.1.18",
      binaryFileKey: { key: "dfu_binary", hash: "00" },
    }],
    startBlockers: ["BLOCKER_CONNECT_USB"],
    updateRequired: true,
  }));
  const blob = new Uint8Array([1, 2, 3, 4]);
  const index = encoder.encode(JSON.stringify({
    files: [{ name: "manifest.json" }, { name: "dfu.json" }, { name: "mouse_v1.dfu" }],
  }));
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, 0x20170110, true);
  new DataView(header.buffer).setUint32(4, index.length, true);
  parts.push(header, index);
  for (const file of [manifest, dfu, blob]) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, file.length, true);
    parts.push(length, file);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test("DFU feature id and archive magic are pinned", () => {
  assert.equal(DFU_FEATURE_ID, 0x00d0);
});

test("parseDepotArchive recovers every file and rejects truncation", () => {
  const files = parseDepotArchive(syntheticDepot());
  assert.equal(files.size, 3);
  assert.ok(files.get("dfu.json"));
  assert.throws(() => parseDepotArchive(new Uint8Array([1, 2, 3])), DfuError);
  assert.throws(() => parseDepotArchive(new Uint8Array(8)), DfuError);
});

test("parseDfuJson validates the verified live shape", () => {
  const files = parseDepotArchive(syntheticDepot());
  const pkg = parseDfuJson(new TextDecoder().decode(files.get("dfu.json")));
  assert.equal(pkg.contents.length, 1);
  assert.deepEqual(pkg.contents[0]?.interfaceIds, ["046d_c094"]);
  assert.equal(pkg.contents[0]?.version, "25.1.18");
  assert.deepEqual(pkg.startBlockers, ["BLOCKER_CONNECT_USB"]);
  assert.equal(pkg.updateRequired, true);
  assert.throws(() => parseDfuJson("{}"), DfuError);
  assert.throws(() => parseDfuJson(JSON.stringify({ contents: [{ version: "" }] })), DfuError);
});

test("resolveDfuBinary prefers the manifest resource key", () => {
  const files = parseDepotArchive(syntheticDepot());
  const manifest = new TextDecoder().decode(files.get("manifest.json"));
  const blob = resolveDfuBinary(files, manifest, "dfu_binary");
  assert.deepEqual(blob, new Uint8Array([1, 2, 3, 4]));
  assert.equal(resolveDfuBinary(new Map(), null, "dfu_binary"), null);
});

test("matchDfuContent matches interface identity case-insensitively", () => {
  const pkg = parseDfuJson(JSON.stringify({
    contents: [{ interfaceInfos: [{ interfaceId: "046d_C094" }], version: "1.0.0" }],
  }));
  assert.equal(matchDfuContent(pkg, "046d_c094")?.version, "1.0.0");
  assert.equal(matchDfuContent(pkg, "046d_ffff"), null);
});

test("compareDfuVersions compares numerically", () => {
  assert.equal(compareDfuVersions("14.3.19", "14.4.20"), -1);
  assert.equal(compareDfuVersions("25.1.18", "25.1.18"), 0);
  assert.equal(compareDfuVersions("38.0.5", "38.00"), 1);
});

function content(overrides: Partial<DfuContent> = {}): DfuContent {
  return {
    interfaceIds: ["046d_c094"],
    version: "25.1.18",
    binaryKey: "dfu_binary",
    binaryHash: createHash("sha256").update(new Uint8Array([9])).digest("hex").toUpperCase(),
    updateRequired: true,
    startBlockers: ["BLOCKER_CONNECT_USB"],
    startWarnings: [],
    ...overrides,
  };
}

test("assertSafeToFlash enforces confirmation, hash, and wired gates", () => {
  const base = { wired: true, confirmed: true, hashVerified: true };
  assert.doesNotThrow(() => assertSafeToFlash(content(), base));
  assert.throws(() => assertSafeToFlash(content(), { ...base, confirmed: false }), DfuConfirmationError);
  assert.throws(() => assertSafeToFlash(content(), { ...base, hashVerified: false }), DfuPreconditionError);
  assert.throws(
    () => assertSafeToFlash(content(), { ...base, wired: false }),
    (error: unknown) => error instanceof DfuPreconditionError && /wired USB/i.test(error.message),
  );
  assert.doesNotThrow(() => assertSafeToFlash(content({ startBlockers: [] }), { ...base, wired: false }));
});

test("flashDfuBinary streams blocks in order after the safety gates", async () => {
  const calls: string[] = [];
  const transport: DfuBootloaderTransport = {
    enterBootloader: async () => { calls.push("enter"); },
    erase: async () => { calls.push("erase"); },
    writeBlock: async (offset) => { calls.push(`write:${offset}`); },
    awaitComplete: async () => { calls.push("complete"); },
  };
  const binary = new Uint8Array(600);
  const progress: Array<{ bytesWritten: number; bytesTotal: number }> = [];
  await flashDfuBinary(transport, content({ startBlockers: [] }), binary,
    { wired: false, confirmed: true, hashVerified: true },
    { blockSize: 256, onProgress: (update) => progress.push(update) });
  assert.deepEqual(calls, ["enter", "erase", "write:0", "write:256", "write:512", "complete"]);
  assert.deepEqual(progress.at(-1), { bytesWritten: 600, bytesTotal: 600 });
  await assert.rejects(
    flashDfuBinary(transport, content(), binary, { wired: true, confirmed: false, hashVerified: true }),
    DfuConfirmationError,
  );
});
