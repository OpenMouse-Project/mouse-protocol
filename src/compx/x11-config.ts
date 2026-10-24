// Transport-independent read-back framing for the 0x1d57 X11-style receiver.
//
// The config reports (0x04 DPI table, 0x06 polling rate, 0x0b firmware
// version, ...) cannot be fetched with a bare GET_FEATURE: until the firmware
// is asked for one, a GET returns whatever its control buffer last held
// (descriptor bytes, string descriptors, code). Reading takes a handshake on
// report 0xa0, the same one the vendor app (AttackShark.exe, MS_4 page) uses:
//
//   1. SET_FEATURE 0xa0 [report, length, 0, flag, 0, 0, 0]
//   2. GET_FEATURE 0xa0 until byte 1 (after the report id) is 0x01
//   3. GET_FEATURE report
//
// Verified on a genuine X11 receiver (1d57:fa60, firmware 0x0107) over Linux
// hidraw: every report below was ready on the first poll. Protocol notes:
// github.com/higajooj/x11 PROTOCOL.md.

export const X11_QUERY_REPORT_ID = 0xa0;
export const X11_POLLING_REPORT_ID = 0x06;
export const X11_VERSION_REPORT_ID = 0x0b;

/** Length byte each report carries at offset 1 (its full size on the receiver). */
export const X11_REPORT_LENGTHS: Readonly<Record<number, number>> = {
  0x04: 0x38,
  [X11_POLLING_REPORT_ID]: 0x09,
  [X11_VERSION_REPORT_ID]: 0x08,
};

const POLLING_CODES: ReadonlyMap<number, number> = new Map([
  [0x08, 125],
  [0x04, 250],
  [0x02, 500],
  [0x01, 1000],
]);

/**
 * Payload (report id excluded) asking the firmware to stage `reportId` for
 * reading. The vendor app sends flag 0 for the version report and 1 otherwise.
 */
export function buildX11QueryRequest(reportId: number, flag = 0x01): Uint8Array<ArrayBuffer> {
  const length = X11_REPORT_LENGTHS[reportId];
  if (length === undefined) throw new Error(`No read-back for report 0x${reportId.toString(16)}`);
  return new Uint8Array([reportId, length, 0x00, flag, 0x00, 0x00, 0x00]);
}

/**
 * True once a 0xa0 read says the requested report is staged. Accepts the
 * report with its leading id (hidapi, Chrome) or stripped (some adapters);
 * the ready byte is 0 or 1, so a leading 0xa0 can only be the id.
 */
export function x11QueryReady(reply: Uint8Array): boolean {
  return (reply[0] === X11_QUERY_REPORT_ID ? reply[1] : reply[0]) === 0x01;
}

/**
 * Normalise a read-back to its full layout with the leading report id, or
 * null when it does not carry the report's signature (id, then length byte).
 */
export function normalizeX11Report(reportId: number, data: Uint8Array): Uint8Array | null {
  const length = X11_REPORT_LENGTHS[reportId];
  if (length === undefined) return null;
  if (data[0] === reportId && data[1] === length) return data;
  if (data[0] === length) {
    const full = new Uint8Array(data.length + 1);
    full[0] = reportId;
    full.set(data, 1);
    return full;
  }
  return null;
}

/** Polling rate in Hz from report 0x06 (`06 09 01 <code> <~code>`), or null. */
export function decodeX11PollingReport(data: Uint8Array): number | null {
  const report = normalizeX11Report(X11_POLLING_REPORT_ID, data);
  if (!report || report.length < 5) return null;
  const code = report[3];
  if (((code ^ report[4]) & 0xff) !== 0xff) return null;
  return POLLING_CODES.get(code) ?? null;
}

/** Firmware version from report 0x0b (`0b 08 <hi> <lo>`), e.g. 0x0107, or null. */
export function decodeX11FirmwareVersion(data: Uint8Array): number | null {
  const report = normalizeX11Report(X11_VERSION_REPORT_ID, data);
  if (!report || report.length < 4) return null;
  return (report[2] << 8) | report[3];
}
