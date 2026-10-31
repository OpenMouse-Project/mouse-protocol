/**
 * LEOBOG GM3 (SinoWealth) wire format.
 *
 * The 2.4 GHz receiver identifies as `258a:0138`; the wired path is
 * `258a:0136` per the vendor driver's `Dev/ms/3311-2/MS.ini`. The vendor
 * configuration app talks to the `0xff02:0x0002` collection with 520-byte
 * feature reports.
 *
 * Two queries are implemented so far, both on report 9:
 *
 * - battery: command pair `09 09`, byte 8 of the response is the percentage
 * - link: command pair `07 00`, byte 8 is 1 while the mouse answers the
 *   receiver and 0 once the mouse has gone to sleep. The 2.4 GHz receiver
 *   keeps answering the battery query from its last reading in that state, so
 *   the link flag is what tells a live percentage from a stale one.
 *
 * Requests are 520-byte feature reports framed as
 * `09 <checksum> <command> <sub-command> 01 00 <length> 00 <payload…>`. The
 * length at bytes 6-7 is the number of payload bytes the device should return
 * and the checksum is the low byte of the sum of every byte from index 2 on.
 */

import { LEOBOG_GM3_ONBOARD_LENGTH } from "./onboard.js";
import {
  LEOBOG_GM3_BUTTON_COMMAND,
  LEOBOG_GM3_BUTTON_SUBCOMMAND,
  LEOBOG_GM3_BUTTON_TABLE_LENGTH,
} from "./buttons.js";
import {
  LEOBOG_GM3_MACRO_COMMAND,
  LEOBOG_GM3_MACRO_SUBCOMMAND,
} from "./macros.js";

export * from "./onboard.js";
export * from "./buttons.js";
export * from "./macros.js";

export interface LeobogGm3Product {
  name: string;
  connection: "Wired" | "Wireless";
  /** True only after the exact PID and path were exercised on hardware. */
  verified: boolean;
}

export const LEOBOG_GM3_VENDOR_ID = 0x258a; // SinoWealth
export const LEOBOG_GM3_WIRED_PRODUCT_ID = 0x0136;
export const LEOBOG_GM3_RECEIVER_PRODUCT_ID = 0x0138;

export const LEOBOG_GM3_PRODUCTS: ReadonlyMap<number, LeobogGm3Product> = new Map([
  [LEOBOG_GM3_WIRED_PRODUCT_ID, {
    name: "GM3",
    connection: "Wired",
    // Exercised on hardware: the `258a:0136` cable path answers the block
    // read and applies block writes (with the write gap the vendor uses).
    verified: true,
  }],
  [LEOBOG_GM3_RECEIVER_PRODUCT_ID, {
    name: "GM3",
    connection: "Wireless",
    verified: true,
  }],
]);

export const LEOBOG_GM3_PRODUCT_IDS: readonly number[] = [...LEOBOG_GM3_PRODUCTS.keys()];

/** Vendor collection used by the 520-byte battery query. */
export const LEOBOG_GM3_USAGE_PAGE = 0xff02;
export const LEOBOG_GM3_USAGE = 0x0002;

export const LEOBOG_GM3_POWER_REPORT_ID = 0x09;
export const LEOBOG_GM3_POWER_COMMAND = 0x09;
export const LEOBOG_GM3_POWER_PACKET_LENGTH = 520;
export const LEOBOG_GM3_POWER_LEVEL_OFFSET = 8;

/** Command pair used by the vendor app's `GetOnline` query (`07 00`). */
export const LEOBOG_GM3_LINK_REPORT_ID = 0x09;
export const LEOBOG_GM3_LINK_COMMAND = 0x07;
export const LEOBOG_GM3_LINK_SUBCOMMAND = 0x00;
export const LEOBOG_GM3_LINK_STATE_OFFSET = 8;

/**
 * The onboard configuration block: `44 00` reads it and `04 00` writes it
 * back, both with 400 payload bytes. The vendor application reads the block,
 * edits the one field the user changed and writes the whole thing back, which
 * is why the driver does the same instead of sending single-purpose writes.
 */
export const LEOBOG_GM3_CONFIG_READ_COMMAND = 0x44;
export const LEOBOG_GM3_CONFIG_WRITE_COMMAND = 0x04;
export const LEOBOG_GM3_CONFIG_SUBCOMMAND = 0x00;

/**
 * Builds one 520-byte vendor frame. `payload` follows the eight header bytes
 * and doubles as the reply length the device is asked for.
 */
export function leobogGm3BuildRequest(
  command: number,
  subCommand: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const frame = new Uint8Array(LEOBOG_GM3_POWER_PACKET_LENGTH);
  frame[0] = LEOBOG_GM3_POWER_REPORT_ID;
  frame[2] = command;
  frame[3] = subCommand;
  frame[4] = 0x01;
  frame[6] = payload.length & 0xff;
  frame[7] = (payload.length >> 8) & 0xff;
  frame.set(payload, 8);
  frame[1] = frame.subarray(2).reduce((sum, byte) => sum + byte, 0) & 0xff;
  return frame;
}

/**
 * The captured battery frame, report id included. WebHID callers send
 * `frame.subarray(1)` because `sendFeatureReport` carries the report id
 * separately.
 */
export function leobogGm3BuildPowerRequest(): Uint8Array {
  return leobogGm3BuildRequest(LEOBOG_GM3_POWER_COMMAND, 0x01, new Uint8Array(1));
}

/** The vendor app's `GetOnline` frame: one payload byte, no arguments. */
export function leobogGm3BuildLinkRequest(): Uint8Array {
  return leobogGm3BuildRequest(LEOBOG_GM3_LINK_COMMAND, LEOBOG_GM3_LINK_SUBCOMMAND, new Uint8Array(1));
}

/**
 * The read request carries a zeroed 400-byte payload: the vendor application
 * fills the length field with the number of bytes it wants back, and the
 * device rejects the command with a HID timeout when the length is wrong.
 */
export function leobogGm3BuildConfigReadRequest(): Uint8Array {
  return leobogGm3BuildRequest(
    LEOBOG_GM3_CONFIG_READ_COMMAND,
    LEOBOG_GM3_CONFIG_SUBCOMMAND,
    new Uint8Array(LEOBOG_GM3_ONBOARD_LENGTH),
  );
}

export function leobogGm3BuildConfigWriteRequest(payload: Uint8Array): Uint8Array {
  if (payload.length !== LEOBOG_GM3_ONBOARD_LENGTH) {
    throw new RangeError(
      `The onboard block must be ${LEOBOG_GM3_ONBOARD_LENGTH} bytes, got ${payload.length}.`,
    );
  }
  return leobogGm3BuildRequest(
    LEOBOG_GM3_CONFIG_WRITE_COMMAND,
    LEOBOG_GM3_CONFIG_SUBCOMMAND,
    payload,
  );
}

/**
 * The button-table write. The vendor application sends this 80-byte payload
 * as command pair `01 00` before every save. Unlike the block commands it is
 * fire-and-forget: the device does not answer a matching reply, so callers
 * must not wait for one.
 */
export function leobogGm3BuildButtonRequest(payload: Uint8Array): Uint8Array {
  if (payload.length !== LEOBOG_GM3_BUTTON_TABLE_LENGTH) {
    throw new RangeError(
      `The button table must be ${LEOBOG_GM3_BUTTON_TABLE_LENGTH} bytes, got ${payload.length}.`,
    );
  }
  return leobogGm3BuildRequest(
    LEOBOG_GM3_BUTTON_COMMAND,
    LEOBOG_GM3_BUTTON_SUBCOMMAND,
    payload,
  );
}

/**
 * One macro upload. The payload is the `03 00` record built by
 * `leobogGm3EncodeMacroRecord`; like the button table this command is
 * fire-and-forget.
 */
export function leobogGm3BuildMacroRequest(payload: Uint8Array): Uint8Array {
  if (payload.length === 0 || payload.length > 512) {
    throw new RangeError(`A macro record must be 1-512 bytes, got ${payload.length}.`);
  }
  return leobogGm3BuildRequest(
    LEOBOG_GM3_MACRO_COMMAND,
    LEOBOG_GM3_MACRO_SUBCOMMAND,
    payload,
  );
}

/** Pulls the 400-byte block out of a `44 00` answer, or null on a mismatch. */
export function leobogGm3ParseConfig(response: Uint8Array): Uint8Array | null {
  const frame = leobogGm3NormaliseResponse(response);
  if (
    frame.length < 8 + LEOBOG_GM3_ONBOARD_LENGTH
    || frame[0] !== LEOBOG_GM3_POWER_REPORT_ID
    || frame[2] !== LEOBOG_GM3_CONFIG_READ_COMMAND
  ) {
    return null;
  }
  return frame.slice(8, 8 + LEOBOG_GM3_ONBOARD_LENGTH);
}

/** Adds the leading report id to a reply that arrived without one. */
function prependReportId(response: Uint8Array): Uint8Array {
  const frame = new Uint8Array(response.length + 1);
  frame[0] = LEOBOG_GM3_POWER_REPORT_ID;
  frame.set(response, 1);
  return frame;
}

/** Accepts answers with or without the leading report id, as WebHID varies by platform. */
export function leobogGm3NormaliseResponse(response: Uint8Array): Uint8Array {
  if (response[0] === LEOBOG_GM3_POWER_REPORT_ID) return response;
  return prependReportId(response);
}

/** Returns battery percent, or null for a mismatch/truncated/out-of-range answer. */
export function leobogGm3ParsePower(response: Uint8Array): number | null {
  const frame = leobogGm3NormaliseResponse(response);
  if (
    frame.length <= LEOBOG_GM3_POWER_LEVEL_OFFSET
    || frame[0] !== LEOBOG_GM3_POWER_REPORT_ID
    || frame[2] !== LEOBOG_GM3_POWER_COMMAND
  ) {
    return null;
  }
  const percent = frame[LEOBOG_GM3_POWER_LEVEL_OFFSET]!;
  return percent <= 100 ? percent : null;
}

/**
 * Returns true while the mouse answers the receiver, false once it is asleep,
 * and null for a mismatched or unexpected reply. The vendor application shows
 * its "please connect your device" page for the false case.
 *
 * The captured link answer is `09 09 07 00 01 00 01 00 01`, whose checksum
 * byte is itself 0x09. A platform that strips the report id therefore looks
 * exactly like one that keeps it, so both alignments are tried.
 */
export function leobogGm3ParseLink(response: Uint8Array): boolean | null {
  const alignments = response[0] === LEOBOG_GM3_LINK_REPORT_ID
    ? [response, prependReportId(response)]
    : [prependReportId(response)];

  for (const frame of alignments) {
    if (
      frame.length <= LEOBOG_GM3_LINK_STATE_OFFSET
      || frame[0] !== LEOBOG_GM3_LINK_REPORT_ID
      || frame[2] !== LEOBOG_GM3_LINK_COMMAND
    ) {
      continue;
    }
    const state = frame[LEOBOG_GM3_LINK_STATE_OFFSET]!;
    if (state === 0) return false;
    if (state === 1) return true;
  }
  return null;
}
