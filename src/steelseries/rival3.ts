/**
 * SteelSeries Rival 3 Gen 1 configuration protocol — pure encode/decode helpers.
 *
 * Reconstructed from public open-source implementations, not vendor software:
 *
 * - rivalcfg `rivalcfg/devices/rival3.py`, `rivalcfg/handlers/multidpi_range_choice.py`,
 *   `rivalcfg/devices/dpi/truemove_core.py`, `rivalcfg/mouse.py`, `rivalcfg/usbhid.py`
 *   (https://github.com/flozz/rivalcfg) — the primary source for every byte here.
 * - libratbag `src/driver-steelseries.c` — corroborates the polling values, the
 *   save id, the firmware id, and that SteelSeries uses unnumbered reports.
 * - OpenRGB `SteelSeriesRival3Controller.cpp` — corroborates interface 3, the
 *   firmware query, and that short unpadded writes are accepted.
 *
 * Every command is an HID **output report** with report id 0x00 on the vendor
 * configuration interface (hidapi `interface_number == 3`). The functions here
 * build the report *payload* — the bytes after the report id, which the WebHID
 * driver passes to `sendReport(0x00, …)` separately. rivalcfg sends these
 * frames unpadded, and that is what this codec produces.
 *
 * **This device is write-only.** No public implementation has a getter for
 * DPI, polling, lighting, or buttons: rivalcfg mirrors state into a local JSON
 * file because the mouse cannot be asked, and libratbag flags its SteelSeries
 * profiles `RATBAG_PROFILE_CAP_WRITE_ONLY`. The single readable value is the
 * two-byte firmware version behind command `10 00`.
 *
 * Settings apply immediately; the save command (`09 00`) commits them to
 * onboard flash (rivalcfg's `--no-save`: "Do not persist settings in the
 * internal device memory"). Which half of that is volatile has not been
 * confirmed on hardware yet.
 *
 * Known but deliberately not implemented — documented so nobody re-derives
 * them, withheld until there is a reason and hardware evidence to ship them:
 *
 * - `05 00 <zone 1–4> <r> <g> <b> <brightness 0x00–0x64>` — zone color (zone 0 = all)
 * - `06 00 <0x00–0x06>` — lighting effect (steady = 0x04)
 * - `07 00` + 8 × 2-byte fields — button mapping
 *
 * None of this has been verified on physical hardware by this project.
 * The Rival 3 Gen 2 (`1038:1870`) and Rival 3 Wireless (`1038:1830`) use
 * different, incompatible command sets and must not reuse this module.
 */

export const STEELSERIES_REPORT_ID = 0x00;

/** Two-byte command prefixes; the payload is the prefix plus its arguments. */
export const RIVAL3_COMMAND = {
  pollingRate: [0x04, 0x00],
  save: [0x09, 0x00],
  dpiPresets: [0x0b, 0x00],
  firmware: [0x10, 0x00],
} as const;

export const RIVAL3_POLLING_RATES = [125, 250, 500, 1000] as const;

const POLLING_RATE_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [1000, 0x01],
  [500, 0x02],
  [250, 0x03],
  [125, 0x04],
]);

export const RIVAL3_DPI_MIN = 200;
export const RIVAL3_DPI_MAX = 8500;
export const RIVAL3_DPI_STEP = 100;
export const RIVAL3_MAX_DPI_PRESETS = 5;
export const RIVAL3_FIRMWARE_RESPONSE_LENGTH = 2;

/**
 * rivalcfg's TrueMove Core sensor table (`devices/dpi/truemove_core.py`):
 * DPI is sent as one byte from this lookup, not as an integer. The source
 * ships it as a literal table with no closed-form formula; the increments
 * follow a repeating +2/+2/+3 pattern, and the values rivalcfg quotes
 * (200→0x04 … 1200→0x1b, 1600→0x24, 8500→0xc5) are pinned in protocol.test.ts.
 */
export const TRUEMOVE_CORE_DPI_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [200, 0x04], [300, 0x06], [400, 0x08], [500, 0x0b], [600, 0x0d], [700, 0x0f],
  [800, 0x12], [900, 0x14], [1000, 0x16], [1100, 0x19], [1200, 0x1b], [1300, 0x1d],
  [1400, 0x20], [1500, 0x22], [1600, 0x24], [1700, 0x27], [1800, 0x29], [1900, 0x2b],
  [2000, 0x2e], [2100, 0x30], [2200, 0x32], [2300, 0x35], [2400, 0x37], [2500, 0x39],
  [2600, 0x3c], [2700, 0x3e], [2800, 0x40], [2900, 0x43], [3000, 0x45], [3100, 0x47],
  [3200, 0x4a], [3300, 0x4c], [3400, 0x4e], [3500, 0x51], [3600, 0x53], [3700, 0x55],
  [3800, 0x58], [3900, 0x5a], [4000, 0x5c], [4100, 0x5f], [4200, 0x61], [4300, 0x63],
  [4400, 0x66], [4500, 0x68], [4600, 0x6a], [4700, 0x6d], [4800, 0x6f], [4900, 0x71],
  [5000, 0x74], [5100, 0x76], [5200, 0x78], [5300, 0x7b], [5400, 0x7d], [5500, 0x7f],
  [5600, 0x82], [5700, 0x84], [5800, 0x86], [5900, 0x89], [6000, 0x8b], [6100, 0x8d],
  [6200, 0x90], [6300, 0x92], [6400, 0x94], [6500, 0x97], [6600, 0x99], [6700, 0x9b],
  [6800, 0x9e], [6900, 0xa0], [7000, 0xa2], [7100, 0xa5], [7200, 0xa7], [7300, 0xa9],
  [7400, 0xac], [7500, 0xae], [7600, 0xb0], [7700, 0xb3], [7800, 0xb5], [7900, 0xb7],
  [8000, 0xba], [8100, 0xbc], [8200, 0xbe], [8300, 0xc1], [8400, 0xc3], [8500, 0xc5],
]);

export class SteelSeriesProtocolError extends Error {}

/** The 84 DPI values the sensor table can express, ascending. */
export function steelseriesRival3DpiOptions(): number[] {
  return [...TRUEMOVE_CORE_DPI_TO_BYTE.keys()].sort((a, b) => a - b);
}

/**
 * `0B 00 <count> <selected> <v1>…<vN>` — replaces the mouse's whole preset
 * table. `selectedIndex` is 0-based here and encoded 1-based on the wire.
 *
 * DPI values must be exact table keys. rivalcfg rounds a request to the
 * nearest table entry; this codec rejects off-grid values instead, matching
 * how the rest of this package validates DPI, so a caller is never silently
 * given a different sensitivity than it asked for.
 */
export function steelseriesRival3EncodeDpiPresets(
  presets: readonly number[],
  selectedIndex: number,
): Uint8Array {
  if (presets.length < 1 || presets.length > RIVAL3_MAX_DPI_PRESETS) {
    throw new SteelSeriesProtocolError(
      `SteelSeries Rival 3 supports 1–${RIVAL3_MAX_DPI_PRESETS} DPI presets.`,
    );
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= presets.length) {
    throw new SteelSeriesProtocolError(
      `Selected DPI preset must be an index into the ${presets.length} presets being written.`,
    );
  }
  const encoded = presets.map((dpi) => {
    const byte = TRUEMOVE_CORE_DPI_TO_BYTE.get(dpi);
    if (byte === undefined) {
      throw new SteelSeriesProtocolError(
        `SteelSeries Rival 3 DPI must be ${RIVAL3_DPI_MIN}–${RIVAL3_DPI_MAX.toLocaleString()} in ${RIVAL3_DPI_STEP} DPI steps.`,
      );
    }
    return byte;
  });
  return new Uint8Array([...RIVAL3_COMMAND.dpiPresets, presets.length, selectedIndex + 1, ...encoded]);
}

/** `04 00 <v>` with 1000→0x01, 500→0x02, 250→0x03, 125→0x04. */
export function steelseriesRival3EncodePollingRate(pollingRateHz: number): Uint8Array {
  const byte = POLLING_RATE_TO_BYTE.get(pollingRateHz);
  if (byte === undefined) {
    throw new SteelSeriesProtocolError("SteelSeries Rival 3 supports 125, 250, 500, or 1000 Hz polling.");
  }
  return new Uint8Array([...RIVAL3_COMMAND.pollingRate, byte]);
}

/** `09 00` — commit the current settings to onboard flash. */
export function steelseriesRival3SaveCommand(): Uint8Array {
  return new Uint8Array(RIVAL3_COMMAND.save);
}

/** `10 00` — the device answers with a two-byte input report. */
export function steelseriesRival3FirmwareQuery(): Uint8Array {
  return new Uint8Array(RIVAL3_COMMAND.firmware);
}

export interface SteelSeriesRival3Firmware {
  /** The two raw response bytes, in the order the device sent them. */
  bytes: [number, number];
  /** The bytes joined in read order, e.g. "37.0". */
  display: string;
}

/**
 * Decode the two-byte firmware response. The byte order is contested between
 * public implementations — libratbag reads [minor, major], current rivalcfg
 * joins the bytes in read order, and OpenRGB treats them as a little-endian
 * word — so both raw bytes are returned and `display` follows rivalcfg's
 * read-order behavior until hardware (a `1038:184C` unit, known to be firmware
 * v0.37.0.0) settles which byte is which.
 */
export function steelseriesRival3DecodeFirmware(payload: Uint8Array): SteelSeriesRival3Firmware {
  if (payload.length < RIVAL3_FIRMWARE_RESPONSE_LENGTH) {
    throw new SteelSeriesProtocolError("SteelSeries Rival 3 firmware response is shorter than two bytes.");
  }
  const bytes: [number, number] = [payload[0]!, payload[1]!];
  return { bytes, display: `${bytes[0]}.${bytes[1]}` };
}
