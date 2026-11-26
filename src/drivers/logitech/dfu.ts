/**
 * Logitech DFU (device firmware update) package handling.
 *
 * A firmware release ships as a *depot* archive published at
 * `https://updates.ghub.logitechg.com/depots/<uuid>/<name>.depot`
 * (plain HTTPS, no auth). The archive layout is verified against live
 * downloads:
 *
 *   magic u32 (`0x20170110`, little-endian bytes `10 01 17 20`)
 *   indexLength u32LE
 *   JSON file index: {"files": [{"name", "mode"}]}
 *   per file: dataLength u32LE + raw bytes, in index order
 *
 * Inside, `dfu.json` describes which HID interfaces (`VID_PID`, e.g.
 * `046d_c094`) each content block fits, its dotted-decimal `version`, the
 * firmware blob's SHA256 (`binaryFileKey.hash`), and flashing constraints
 * (`startBlockers` such as `BLOCKER_CONNECT_USB`, `force`,
 * `restartAllEntities`, `retryStuckBootloader`). `manifest.json` maps the
 * logical binary key to the blob filename.
 *
 * What this module deliberately does NOT contain: the Yeti bootloader wire
 * commands (detach/erase/download sequencing). Those byte sequences are not
 * recoverable from static analysis and are not guessed here — flashing them
 * wrong bricks hardware. The {@link DfuBootloaderTransport} interface marks
 * the seam: implement it against USB captures of a real session, then drive
 * it with {@link flashDfuBinary}, which enforces hash verification and an
 * explicit user confirmation before a single byte goes out.
 */

export class DfuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DfuError";
  }
}

/** Thrown when a flash is attempted without explicit user confirmation. */
export class DfuConfirmationError extends DfuError {
  constructor() {
    super("Refusing to flash without explicit user confirmation.");
    this.name = "DfuConfirmationError";
  }
}

/** Thrown when a flashing precondition (blockers, hash) is not satisfied. */
export class DfuPreconditionError extends DfuError {
  constructor(message: string) {
    super(message);
    this.name = "DfuPreconditionError";
  }
}

export const DEPOT_ARCHIVE_MAGIC = 0x20170110;

/**
 * HID++ 2.0 DFU feature id, confirmed via the vendor agent (feature_00d0_dfu
 * drives packet send/status/complete; receivers without it fall back to a
 * plain device restart to leave bootloader mode). Verified vocabulary around
 * it — statuses Packet success %i/%i, Success, Entity/System Restart
 * Required, Wait For Event, No_Status, error; completion restarts the device,
 * and packets are numbered with a package-size ceiling. Exact function ids
 * and packet layout are NOT established here (needs USB captures) and must
 * not be guessed: see DfuBootloaderTransport.
 */
export const DFU_FEATURE_ID = 0x00d0;

export function parseDepotArchive(buffer: Uint8Array): Map<string, Uint8Array> {
  if (buffer.length < 8) {
    throw new DfuError(`Depot too short (${buffer.length} bytes).`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== DEPOT_ARCHIVE_MAGIC) {
    throw new DfuError("Depot magic mismatch — not a Logitech depot archive.");
  }
  const indexLength = view.getUint32(4, true);
  let index: { files?: Array<{ name?: unknown }> };
  try {
    index = JSON.parse(new TextDecoder().decode(buffer.subarray(8, 8 + indexLength)));
  } catch {
    throw new DfuError("Depot file index is not valid JSON.");
  }
  if (!index || !Array.isArray(index.files)) {
    throw new DfuError("Depot file index has no files[].");
  }
  let offset = 8 + indexLength;
  const files = new Map<string, Uint8Array>();
  for (const file of index.files) {
    if (typeof file?.name !== "string") throw new DfuError("Depot index entry without a name.");
    if (offset + 4 > buffer.length) throw new DfuError(`Depot truncated at ${file.name}.`);
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > buffer.length) throw new DfuError(`Depot truncated inside ${file.name}.`);
    files.set(file.name, buffer.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== buffer.length) {
    throw new DfuError(`Depot has ${buffer.length - offset} trailing bytes.`);
  }
  return files;
}

export interface DfuInterfaceInfo {
  interfaceId: string;
  updatable: boolean;
  force: boolean;
  targetEntity: string[];
}

export interface DfuContent {
  interfaceIds: string[];
  /** Dotted-decimal package version, e.g. "25.1.18". */
  version: string;
  binaryKey: string | null;
  binaryHash: string | null;
  updateRequired: boolean;
  startBlockers: string[];
  startWarnings: string[];
}

export interface DfuPackage {
  contents: DfuContent[];
  startBlockers: string[];
  startWarnings: string[];
  updateRequired: boolean;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseDfuJson(text: string): DfuPackage {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DfuError("dfu.json is not valid JSON.");
  }
  if (!json || !Array.isArray(json.contents)) {
    throw new DfuError("dfu.json has no contents[].");
  }
  const contents: DfuContent[] = (json.contents as Array<Record<string, unknown>>).map((content, index) => {
    const infos = Array.isArray(content.interfaceInfos) ? content.interfaceInfos : [];
    const interfaceIds = [...new Set(
      (infos as Array<Record<string, unknown>>)
        .map((info) => (typeof info.interfaceId === "string" ? info.interfaceId.toLowerCase() : ""))
        .filter(Boolean),
    )];
    const binaryFileKey = (content.binaryFileKey ?? {}) as Record<string, unknown>;
    const version = content.version;
    if (typeof version !== "string" || version.length === 0) {
      throw new DfuError(`dfu.json contents[${index}] has no version.`);
    }
    return {
      interfaceIds,
      version,
      binaryKey: typeof binaryFileKey.key === "string" ? binaryFileKey.key : null,
      binaryHash: typeof binaryFileKey.hash === "string" ? binaryFileKey.hash : null,
      updateRequired: content.updateRequired === true,
      startBlockers: asStringArray(content.startBlockers),
      startWarnings: asStringArray(content.startWarnings),
    };
  });
  return {
    contents,
    startBlockers: asStringArray(json.startBlockers),
    startWarnings: asStringArray(json.startWarnings),
    updateRequired: json.updateRequired === true,
  };
}

/** Resolves the firmware blob for a content block via manifest.json resources. */
export function resolveDfuBinary(
  files: Map<string, Uint8Array>,
  manifestText: string | null,
  binaryKey: string | null,
): Uint8Array | null {
  if (manifestText) {
    try {
      const manifest = JSON.parse(manifestText) as {
        resources?: Array<{ key?: unknown; src?: unknown }>;
      };
      const match = manifest.resources?.find((resource) => resource.key === binaryKey);
      if (match && typeof match.src === "string") {
        const blob = files.get(match.src);
        if (blob) return blob;
      }
    } catch {
      // Fall through to extension probing below.
    }
  }
  for (const [name, data] of files) {
    if (name.endsWith(".dfu") || name.endsWith(".bin") || name.endsWith(".img")) return data;
  }
  return null;
}

/** Numeric dot-separated compare. Returns -1 / 0 / 1. */
export function compareDfuVersions(a: string, b: string): number {
  const parts = (version: string): number[] =>
    version.split(".").map((part) => {
      const n = Number.parseInt(part.replace(/[^0-9].*$/, ""), 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Selects the content block fitting an interface ("046d_xxxx", any case).
 * First block with an exact interface match wins; null when none fits.
 */
export function matchDfuContent(pkg: DfuPackage, interfaceId: string): DfuContent | null {
  const want = interfaceId.toLowerCase();
  return pkg.contents.find((content) =>
    content.interfaceIds.some((id) => id.toLowerCase() === want),
  ) ?? null;
}

export interface DfuFlashContext {
  /** True when the device is on a wired connection right now. */
  wired: boolean;
  /** Explicit user confirmation (button press), never implied. */
  confirmed: boolean;
  /** Binary already hash-verified against the manifest. */
  hashVerified: boolean;
}

/** Enforces flashing preconditions. Throws on the first violated gate. */
export function assertSafeToFlash(content: DfuContent, context: DfuFlashContext): void {
  if (!context.confirmed) throw new DfuConfirmationError();
  if (!context.hashVerified) {
    throw new DfuPreconditionError("Refusing to flash a binary whose SHA256 was not verified.");
  }
  if (content.startBlockers.includes("BLOCKER_CONNECT_USB") && !context.wired) {
    throw new DfuPreconditionError("This update requires a wired USB connection (BLOCKER_CONNECT_USB).");
  }
}

/**
 * Bootloader transport seam. Command framing lives here once captured from a
 * real session — this interface carries no invented bytes.
 */
export interface DfuBootloaderTransport {
  enterBootloader(): Promise<void>;
  erase(): Promise<void>;
  writeBlock(offset: number, data: Uint8Array): Promise<void>;
  /** Resolves when the device reports a successful flash. */
  awaitComplete(timeoutMs?: number): Promise<void>;
}

export interface DfuFlashProgress {
  bytesWritten: number;
  bytesTotal: number;
}

/**
 * Streams a hash-verified binary through a bootloader transport in fixed
 * blocks. All safety gates run first; nothing is sent otherwise.
 */
export async function flashDfuBinary(
  transport: DfuBootloaderTransport,
  content: DfuContent,
  binary: Uint8Array,
  context: DfuFlashContext,
  opts?: { blockSize?: number; onProgress?: (progress: DfuFlashProgress) => void },
): Promise<void> {
  assertSafeToFlash(content, context);
  const blockSize = opts?.blockSize ?? 256;
  if (blockSize <= 0) throw new DfuError("blockSize must be positive.");
  await transport.enterBootloader();
  await transport.erase();
  for (let offset = 0; offset < binary.length; offset += blockSize) {
    await transport.writeBlock(offset, binary.subarray(offset, offset + blockSize));
    opts?.onProgress?.({ bytesWritten: Math.min(offset + blockSize, binary.length), bytesTotal: binary.length });
  }
  await transport.awaitComplete();
}
