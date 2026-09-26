/** VAXEE Control Center v3.6 feature-report protocol (report ID 0x0e). */
export const VAXEE_VENDOR_ID = 0x3057;
export const VAXEE_USAGE_PAGE = 0xff05;
export const VAXEE_USAGE = 0x01;
export const VAXEE_REPORT_ID = 0x0e;
export const VAXEE_REPORT_SIZE = 63;

/** USB product IDs advertised by the official VAXEE Control Center. */
export const VAXEE_PRODUCT_IDS = [
  0x1001, 0x1002, 0x1003, 0x1004, 0x1005, 0x1006, 0x1007, 0x1008,
  0x1009, 0x1010, 0x1011, 0x1012, 0x1013, 0x0005, 0x2001, 0x1014,
  0x2002, 0x1015,
] as const;

export const VAXEE_MOUSE_NAMES: Readonly<Record<number, string>> = {
  0x1003: "XE Wireless", 0x1004: "NP-01S Wireless", 0x1005: "AX Wireless",
  0x1006: "NP-01 Wireless", 0x1007: "XE-S Wireless", 0x1008: "XE-S-L Wireless",
  0x1009: "VAXEE x Ninjutso Sora", 0x1010: "E1 Wireless",
  0x1011: "NP-01S V2 Wireless", 0x1012: "XE V2 Wireless",
  0x1013: "NP-01S Ergo Wireless", 0x1014: "NP-01S V3 Wireless",
  0x1015: "NP-01 Ergo Wireless",
};

export const VAXEE_RECEIVER_IDS = new Set<number>([0x0005, 0x1001, 0x1002, 0x2001, 0x2002]);

export const VAXEE_COMMAND = {
  firmware: 0x01, dpiStage: 0x02, dpiEnabled: 0x03, dpiValue: 0x04,
  debounce: 0x05, polling: 0x07, tracking: 0x08, lod: 0x09,
  mousePid: 0x0a, battery: 0x0b, charging: 0x10,
  trajectory: 0x13, profile: 0x14,
} as const;

export function vaxeeRequest(command: number, length: number, values: readonly number[] = [], write = false): Uint8Array {
  if (!Number.isInteger(command) || command < 1 || command > 255) throw new RangeError("Invalid VAXEE command.");
  if (!Number.isInteger(length) || length < 0 || length > VAXEE_REPORT_SIZE - 4 || values.length > length) {
    throw new RangeError("Invalid VAXEE payload length.");
  }
  const bytes = new Uint8Array(VAXEE_REPORT_SIZE);
  bytes.set([0xa5, command, write ? 2 : 1, length]);
  values.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("Invalid VAXEE payload byte.");
    bytes[4 + index] = value;
  });
  return bytes;
}

export function vaxeeReply(source: DataView | Uint8Array, command: number, minimumDataLength: number): Uint8Array {
  const bytes = source instanceof Uint8Array
    ? source
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  // The response has a five-byte envelope; data starts at offset 5.
  if (bytes.length < 5 + minimumDataLength || bytes[0] !== 0xa5 || bytes[1] !== command || bytes[2] !== 3 || bytes[3] !== 1) {
    throw new Error(`Invalid VAXEE reply for command 0x${command.toString(16)}.`);
  }
  if (bytes[4]! < minimumDataLength) throw new Error("Truncated VAXEE reply payload.");
  return bytes;
}

export function vaxeeDpi(reply: Uint8Array): number {
  vaxeeReply(reply, VAXEE_COMMAND.dpiValue, 3);
  return reply[6]! | (reply[7]! << 8);
}

export function vaxeePollingRate(code: number): number {
  const rates = [0, 500, 1000, 2000, 4000, 8000];
  const rate = rates[code];
  if (!rate) throw new RangeError(`Unsupported VAXEE polling code ${code}.`);
  return rate;
}

export function vaxeePollingCode(rate: number): number {
  const codes: Readonly<Record<number, number>> = { 500: 1, 1000: 2, 2000: 3, 4000: 4, 8000: 5 };
  const code = codes[rate];
  if (!code) throw new RangeError(`Unsupported VAXEE polling rate ${rate}.`);
  return code;
}
