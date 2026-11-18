/**
 * Instant Microelectronics A825 configuration protocol.
 *
 * Reverse-engineered from the vendor control app shipped for the Sades Kaze
 * (Instant A825), `SadesKaze(A825).[20241009].exe` → `DevDock.exe`
 * (product "New825Tab", VID 0x30FA, PIDs 0x1440/0x1E01), and verified against a
 * Sades Kaze on VID 0x30FA / PID 0x1440.
 *
 * Transport
 * ---------
 * The control collection is usage page 0xFF01, usage 1, on interface 1. Its
 * only feature report is report ID 7. The vendor app and the device both use
 * 8-byte feature reports:
 *
 *   [0x07, command, a, b, c, d, e, f]
 *
 * The same report also carries a 32-byte status block that the device returns
 * from a feature read; only the first eight bytes are used for command replies.
 *
 * Block access (command 0x18)
 * ---------------------------
 * The device exposes a 16-bit, little-endian addressed configuration memory.
 * A block is written as one frame per byte, then finished and committed:
 *
 *   07 18 03 <index> <addrLo> <addrHi> <data> <length-1>
 *   07 18 09 00      <addrLo> <addrHi> 00     <length-1>
 *   07 18 00 00      <addrLo> <addrHi> 00     00
 *
 * A byte is read by issuing the same address/length setup and then one frame
 * per byte:
 *
 *   07 18 03 00 <addrLo> <addrHi> 00 <length-1>
 *   07 18 00 00 <addrLo> <addrHi> 00 00
 *   07 18 05 <index> <addrLo> <addrHi> 00 <length-1>   → reply byte 1
 *   07 18 00 00 <addrLo> <addrHi> 00 00
 *
 * Verified on hardware: writing the byte at 0x3A and reading it back returns
 * the written value (0x0B → 0x0A → 0x0B). That byte is a lighting field, not
 * the polling rate. The 0x0000-0x0FFF image is readable with
 * `instantBlockReadFrames`.
 *
 * Direct commands
 * ---------------
 * The vendor app also writes a DPI value and a button map directly:
 *
 *   07 12 <value/8> 00 00 00 00 00        (mode 0)
 *   07 12 <value/16 high> <value/16 low> ... (other modes)
 *   07 11 00 ...                          commit
 *   07 09 ...                             button map
 *   07 17 <lo> <hi> ...                   16-bit key/function code
 *   07 13 ...                             lighting/mode
 *
 * The vendor app's Apply writes the stored image (0x0000-0x02FF plus the
 * 0x0F80 trailer). The direct commands above are read from the vendor code;
 * sending 0x12 on the tested unit changed neither the stored image nor the
 * status block.
 */

export const INSTANT_VENDOR_ID = 0x30fa;

/** PIDs seen on A825 controls. 0x7F7F comes from public GM320 research. */
export const INSTANT_PRODUCT_IDS: ReadonlySet<number> = new Set([
  0x1440, 0x1e01, 0x7f7f,
]);

export const INSTANT_USAGE_PAGE = 0xff01;
export const INSTANT_USAGE = 0x01;
export const INSTANT_INTERFACE = 1;

export const INSTANT_REPORT_ID = 0x07;
export const INSTANT_FRAME_LENGTH = 8;
/** Status block returned by a feature read on report 7. */
export const INSTANT_STATUS_LENGTH = 32;

export const INSTANT_COMMAND = {
  block: 0x18,
  dpi: 0x12,
  apply: 0x11,
  buttonMap: 0x09,
  keyCode: 0x17,
  notice: 0x13,
} as const;

export const INSTANT_BLOCK = {
  write: 0x03,
  read: 0x05,
  finish: 0x09,
  commit: 0x00,
  mode: 0x10,
} as const;

/**
 * Configuration image addresses written by the vendor app's
 * `A825_WriteLightingConfig` (0x480B00). Every write is a named block; bytes
 * between blocks are untouched.
 */
export const INSTANT_CONFIG = {
  header: 0x0000,
  keymap: 0x0007,
  stageEnable: 0x001c,
  stageColorsA: 0x0020,
  stageColorsB: 0x0028,
  sensor: 0x0030,
  lightingDirection: 0x003a,
  lighting: 0x003e,
  trailer: 0x0f80,
} as const;

/** Readable configuration window; the vendor app writes 0x0000-0x02FF. */
export const INSTANT_CONFIG_LENGTH = 0x1000;

/**
 * DPI gears from the vendor's `DeviceFeature.ini` `[Chip]` table. The array
 * index + 1 is the on-wire gear index (the value the vendor app stores in a
 * DPI stage); the second number in the INI is a separate firmware code.
 */
export const INSTANT_DPI_GEARS: readonly number[] = [
  200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2400, 3200, 4000,
  4800, 5600, 6400, 7200, 8000, 8800, 9600, 10400, 11200, 12800,
];

export const INSTANT_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

export function instantDpiGearIndex(dpi: number): number | null {
  const index = INSTANT_DPI_GEARS.indexOf(dpi);
  return index < 0 ? null : index + 1;
}

function byte(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} is not a byte: ${value}`);
  }
  return value;
}

/** Build one 8-byte report. `params` fills bytes 2..7. */
export function instantFrame(
  command: number,
  params: readonly number[] = [],
): Uint8Array {
  if (params.length > 6) {
    throw new RangeError(`Instant frame takes at most 6 parameters, got ${params.length}`);
  }
  const frame = new Uint8Array(INSTANT_FRAME_LENGTH);
  frame[0] = INSTANT_REPORT_ID;
  frame[1] = byte(command, "command");
  params.forEach((value, index) => {
    frame[2 + index] = byte(value, `parameter ${index}`);
  });
  return frame;
}

/** Frames that write `data` to `address`, followed by finish and commit. */
export function instantBlockWriteFrames(
  address: number,
  data: readonly number[],
): Uint8Array[] {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new RangeError(`Invalid Instant block address: ${address}`);
  }
  if (data.length === 0 || data.length > 0x100) {
    throw new RangeError(`Invalid Instant block length: ${data.length}`);
  }
  const low = address & 0xff;
  const high = (address >>> 8) & 0xff;
  const last = data.length - 1;
  const frames = data.map((value, index) =>
    instantFrame(INSTANT_COMMAND.block, [
      INSTANT_BLOCK.write,
      index,
      low,
      high,
      byte(value, `data byte ${index}`),
      last,
    ]),
  );
  frames.push(
    instantFrame(INSTANT_COMMAND.block, [
      INSTANT_BLOCK.finish,
      0,
      low,
      high,
      0,
      last,
    ]),
  );
  frames.push(
    instantFrame(INSTANT_COMMAND.block, [
      INSTANT_BLOCK.commit,
      0,
      low,
      high,
      0,
      0,
    ]),
  );
  return frames;
}

/** Frames that prepare and read `length` bytes from `address`. */
export function instantBlockReadFrames(
  address: number,
  length: number,
): Uint8Array[] {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new RangeError(`Invalid Instant block address: ${address}`);
  }
  if (!Number.isInteger(length) || length < 1 || length > 0x100) {
    throw new RangeError(`Invalid Instant block length: ${length}`);
  }
  const low = address & 0xff;
  const high = (address >>> 8) & 0xff;
  const last = length - 1;
  const frames: Uint8Array[] = [];
  for (let index = 0; index < length; index += 1) {
    frames.push(
      instantFrame(INSTANT_COMMAND.block, [
        INSTANT_BLOCK.write,
        index,
        low,
        high,
        0,
        last,
      ]),
    );
  }
  frames.push(
    instantFrame(INSTANT_COMMAND.block, [
      INSTANT_BLOCK.commit,
      0,
      low,
      high,
      0,
      0,
    ]),
  );
  return frames;
}

/** Frame that requests byte `index` of the prepared read block. */
export function instantBlockReadByteFrame(
  address: number,
  index: number,
  length: number,
): Uint8Array {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
    throw new RangeError(`Invalid Instant block address: ${address}`);
  }
  if (!Number.isInteger(length) || length < 1 || length > 0x100) {
    throw new RangeError(`Invalid Instant block length: ${length}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`Instant block index ${index} is outside a ${length}-byte block`);
  }
  return instantFrame(INSTANT_COMMAND.block, [
    INSTANT_BLOCK.read,
    index,
    address & 0xff,
    (address >>> 8) & 0xff,
    0,
    length - 1,
  ]);
}

/** The value returned by a read byte frame lives at report byte 1. */
export function decodeInstantReadByte(report: Uint8Array): number | null {
  return report.length > 1 && report[0] === INSTANT_REPORT_ID ? report[1] : null;
}

/** Frames that set a live DPI value and commit it. */
export function instantDpiFrames(dpi: number, mode = 0): Uint8Array[] {
  const gear = instantDpiGearIndex(dpi);
  if (gear == null) {
    throw new RangeError(`Unsupported A825 DPI: ${dpi}`);
  }
  if (mode === 0) {
    const units = Math.round(dpi / 8);
    if (units > 0xff) {
      throw new RangeError(
        `A825 mode 0 stores DPI/8 in one byte; ${dpi} needs the 16-bit mode`,
      );
    }
    return [
      instantFrame(INSTANT_COMMAND.dpi, [units, 0, 0, 0, 0, 0]),
      instantFrame(INSTANT_COMMAND.apply),
    ];
  }
  const units = Math.round(dpi / 16);
  return [
    instantFrame(INSTANT_COMMAND.dpi, [
      (units >>> 8) & 0xff,
      units & 0xff,
      0,
      0,
      0,
      0,
    ]),
    instantFrame(INSTANT_COMMAND.apply),
  ];
}

/** Enter or leave the block-write mode used at the end of an Apply. */
export function instantModeFrames(enter: boolean): Uint8Array[] {
  return [
    instantFrame(INSTANT_COMMAND.block, [enter ? INSTANT_BLOCK.mode : 0, 0, 0, 0, 0, 0]),
  ];
}

export interface InstantConfigImage {
  /** Bytes read from the configuration image; the array length is the requested range. */
  bytes: Uint8Array;
  /**
   * Byte at 0x3A. Ghidra shows it packs the lighting direction, symmetry and
   * a stage count (`FUN_00480b00` reads light_direction/light_symmetry here);
   * it is NOT the polling rate. Kept raw until the layout is fully named.
   */
  lightingDirectionByte: number | null;
}

export function decodeInstantConfig(bytes: Uint8Array): InstantConfigImage {
  return {
    bytes,
    lightingDirectionByte:
      bytes.length > INSTANT_CONFIG.lightingDirection
        ? bytes[INSTANT_CONFIG.lightingDirection]!
        : null,
  };
}

export interface InstantStatus {
  /** Firmware/build word at bytes 2-3, little-endian (0x0954 on the Kaze). */
  firmware: number;
  /** State byte 1; changes with device activity. */
  state: number;
  /** Sensor value at bytes 11-12, little-endian; near the active DPI. */
  sensorCpi: number;
  /** Bytes 17-19 are the fixed 0x24 0x5A 0xA5 marker. */
  magicOk: boolean;
}

export function decodeInstantStatus(report: Uint8Array): InstantStatus | null {
  if (report.length < 20) return null;
  const hasReportId = report.length === INSTANT_STATUS_LENGTH;
  const offset = hasReportId ? 1 : 0;
  if (hasReportId && report[0] !== INSTANT_REPORT_ID) return null;
  if (report.length < offset + 19) return null;
  return {
    firmware: report[offset + 1]! | (report[offset + 2]! << 8),
    state: report[offset]!,
    sensorCpi: report[offset + 10]! | (report[offset + 11]! << 8),
    magicOk:
      report[offset + 15] === 0x24 &&
      report[offset + 16] === 0x5a &&
      report[offset + 17] === 0xa5,
  };
}
