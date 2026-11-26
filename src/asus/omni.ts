/**
 * ROG Omni receiver (`0x1ACE`), shared by ASUS mice and keyboards.
 *
 * Interface 2 holds three vendor collections. Report 1 on usage page `0xFF02`
 * controls the receiver itself. Each paired device gets its own report id,
 * which the pair list names (keyboard 2, mouse 3 on the receiver we tested).
 * A mouse speaks the normal ASUS protocol on its report, in 63-byte reports.
 *
 * Receiver commands are `[command, sub, arg low, arg high, data...]`.
 *
 * ## Provenance
 *
 * - Hardware: pair list, firmware read, booster read and every mouse read,
 *   on a receiver with firmware 7.00.04 paired to a Harpe Ace Aim Lab Edition
 *   and a ROG Azoth.
 * - G-Helper (`app/Peripherals/PeripheralsProvider.cs`): pair-list handshake,
 *   the mouse collection, and the booster read.
 * - ASUS GearLink web app: pairing mode, unpair and reboot. Read for facts
 *   only; no code was taken.
 */

export const ASUS_OMNI_PRODUCT_ID = 0x1ace;

export const ASUS_OMNI_USAGE_PAGE = 0xff02;
export const ASUS_OMNI_REPORT_ID = 1;

/** Every Omni report, receiver and paired device alike, carries 63 data bytes. */
export const ASUS_OMNI_REPORT_SIZE = 63;

export type AsusOmniDeviceKind = "mouse" | "keyboard" | "unknown";

export interface AsusOmniSlot {
  /** The paired device's own product id, as it enumerates on its own receiver. */
  productId: number;
  /** Report id that carries this device's commands through the receiver. */
  reportId: number;
  notifyReportId: number;
}

/** Report ids the receiver hands out per device kind. */
const KIND_BY_REPORT_ID: Readonly<Record<number, AsusOmniDeviceKind>> = { 2: "keyboard", 3: "mouse" };

/** Keyboard product ids as they appear in the pair list (from G-Helper). */
export const ASUS_OMNI_KEYBOARDS: ReadonlyMap<number, string> = new Map([
  [0x1a85, "ROG Azoth"],
  [0x1b42, "ROG Azoth Extreme"],
  [0x1cf1, "ROG Azoth Extreme SE"],
  [0x1ab0, "ROG Strix Scope II 96 Wireless"],
  [0x1b7a, "ROG Strix Scope II 96 RX Wireless"],
  [0x1b06, "ROG Falchion RX Low Profile"],
]);

function command(code: number, sub: number, data: readonly number[] = []): Uint8Array {
  const report = new Uint8Array(ASUS_OMNI_REPORT_SIZE);
  report.set([code, sub, 0x00, 0x00, ...data]);
  return report;
}

export function asusOmniPairedDevicesRequest(): Uint8Array {
  return command(0xa0, 0x00);
}

export function asusOmniFirmwareRequest(): Uint8Array {
  return command(0xa1, 0x01);
}

export function asusOmniPairingModeRequest(enabled: boolean): Uint8Array {
  return command(0xa2, 0x00, [enabled ? 0x01 : 0x00]);
}

/** GearLink also sends the device serial after the PID; the receiver accepts it empty. */
export function asusOmniUnpairRequest(productId: number): Uint8Array {
  if (!Number.isInteger(productId) || productId <= 0 || productId > 0xffff) {
    throw new Error(`Invalid ROG Omni device id: ${productId}`);
  }

  return command(0xa2, 0x01, [0x05, 0x0b, productId & 0xff, productId >> 8]);
}

/** The receiver drops off USB and enumerates again. GearLink sends it after a pairing. */
export function asusOmniRebootRequest(): Uint8Array {
  return command(0xb0, 0x00, [...new TextEncoder().encode("reset")]);
}

/** Mouse-side read: data byte 4 is 1 when 2000-8000 Hz polling is available. */
export function asusOmniBoosterRequest(): Uint8Array {
  const report = new Uint8Array(ASUS_OMNI_REPORT_SIZE);
  report.set([0x7d, 0x20, 0x02]);
  return report;
}

export function asusOmniDecodePairedDevices(data: Uint8Array): AsusOmniSlot[] {
  if (data.length < 4 || data[0] !== 0xa0) {
    throw new Error("ROG Omni pair list reply is malformed.");
  }

  const count = data[2] | (data[3] << 8);
  const slots: AsusOmniSlot[] = [];
  for (let i = 0; i < count && 8 + i * 4 <= data.length; i++) {
    const offset = 4 + i * 4;
    slots.push({
      productId: data[offset] | (data[offset + 1] << 8),
      reportId: data[offset + 2],
      notifyReportId: data[offset + 3],
    });
  }
  return slots;
}

export function asusOmniDeviceKind(slot: AsusOmniSlot): AsusOmniDeviceKind {
  return KIND_BY_REPORT_ID[slot.reportId] ?? "unknown";
}

/** `a.bb.cc`, in hex like ASUS prints it. */
export function asusOmniDecodeFirmware(data: Uint8Array): string {
  if (data.length < 8 || data[0] !== 0xa1 || data[1] !== 0x01) {
    throw new Error("ROG Omni firmware reply is malformed.");
  }

  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  return `${data[6].toString(16)}.${hex(data[5])}.${hex(data[4])}`;
}
