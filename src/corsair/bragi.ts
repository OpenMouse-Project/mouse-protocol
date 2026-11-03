/**
 * Corsair's "Bragi" protocol (ckb-next's name; OpenRGB calls it Corsair
 * Peripheral V2), spoken by the IRONCLAW RGB WIRELESS, the SCIMITAR RGB ELITE
 * and Corsair's other post-2019 peripherals, over the cable and through
 * SLIPSTREAM receivers.
 *
 * The request layout and the SET ack are confirmed against iCUE in
 * `captures/corsair-ironclaw-rgb-wireless/`. GET replies, the handshake and
 * the polling, brightness and angle-snapping properties were captured from a
 * wired SCIMITAR RGB ELITE in `captures/corsair-scimitar-rgb-elite/`. Property
 * ids not seen in a capture come from ckb-next (`bragi_proto.h`,
 * `bragi_common.c`), OpenRGB (`CorsairPeripheralV2Controller.cpp`) and
 * OpenLinkHub (`ironclawW.go`), which agree with each other.
 *
 * Transport: output reports without a report id on the vendor interface
 * (usage page 0xFF42, interface 1, interrupt endpoints 0x04/0x84). Every
 * request is answered by an input report of the same size on the same
 * interface. The size is 64 bytes on the IRONCLAW and 128 bytes on the
 * SCIMITAR RGB ELITE (its report descriptor declares 128; see the mouse table).
 *
 *   request  [0x08 | slot] [command] [property] [0x00] [value, u16 LE]
 *   reply    [slot]        [command] [status]   [value, LE]
 *
 * Slot 0 is the device on the cable: the mouse when wired, the receiver when
 * wireless. A receiver relays slot n (1–7) to the device paired in that slot.
 * Nothing here transports bytes; the WebHID client lives in
 * `src/drivers/corsair/bragi-hid.ts`.
 */
export const CORSAIR_BRAGI_USAGE_PAGE = 0xff42;
/** The default report size; a mouse whose descriptor says otherwise sets `packetSize` in its table entry. */
export const CORSAIR_BRAGI_PACKET_SIZE = 64;
/** Byte 0 of every request, OR'd with the slot. */
export const CORSAIR_BRAGI_MAGIC = 0x08;
export const CORSAIR_BRAGI_MAX_SLOT = 7;

export const CORSAIR_BRAGI_COMMAND = {
  set: 0x01,
  get: 0x02,
} as const;

export const CORSAIR_BRAGI_PROPERTY = {
  /** 1–7 = 8 ms … 0.125 ms, see `CORSAIR_BRAGI_POLLING_RATES`. */
  pollingRate: 0x01,
  /** Lighting brightness in tenths of a percent, 0–1000 (SCIMITAR RGB ELITE: iCUE's 0/33/66/100 % steps send 0/330/660/1000). */
  brightness: 0x02,
  /** 1 = hardware (onboard settings), 2 = software (iCUE drives the mouse). */
  mode: 0x03,
  /** Angle snapping, 0 = off, 1 = on (SCIMITAR RGB ELITE). */
  angleSnapping: 0x07,
  /** Tenths of a percent, 0–1000. */
  batteryLevel: 0x0f,
  batteryStatus: 0x10,
  vendorId: 0x11,
  productId: 0x12,
  firmware: 0x13,
  /** Live DPI per axis, plain u16 (no scaling). */
  dpiX: 0x21,
  dpiY: 0x22,
  /**
   * Active onboard DPI stage, 0-based (SCIMITAR RGB ELITE: follows the mouse's own
   * DPI button and survives a replug; iCUE writes it along with the stage's DPI
   * when a stage is selected in Device Memory Mode). Read-only here.
   */
  dpiStage: 0x4f,
  /** Receivers only: bit n is set while the device paired in slot n is connected. */
  slots: 0x36,
} as const;

/** Reply byte 2. Names from OpenRGB's `GetErrorString`; ckb-next agrees on 5. */
export const CORSAIR_BRAGI_STATUS = {
  ok: 0x00,
  invalidValue: 0x01,
  failed: 0x03,
  unsupported: 0x05,
} as const;

export const CORSAIR_BRAGI_MODE = {
  hardware: 0x01,
  software: 0x02,
} as const;

/** Polling property value → Hz. ckb-next stores `value - 1` into its 8 ms … 0.125 ms enum. */
export const CORSAIR_BRAGI_POLLING_RATES: ReadonlyMap<number, number> = new Map([
  [1, 125], [2, 250], [3, 500], [4, 1000], [5, 2000], [6, 4000], [7, 8000],
]);

export interface CorsairBragiMouse {
  name: string;
  dpiMin: number;
  dpiMax: number;
  /**
   * Output/input report size in bytes, from the vendor interface's HID report
   * descriptor. Optional so existing entries stay valid: omitted means
   * `CORSAIR_BRAGI_PACKET_SIZE` (64).
   */
  packetSize?: number;
  /**
   * HID usage of the command collection (the input-only 0xFF42 collection on the
   * same device has a different usage). Left out when the descriptor was not
   * captured, which leaves the picker filter on the usage page alone.
   */
  commandUsage?: number;
  /**
   * Properties beyond the base set that this mouse has been seen to answer a GET
   * for on hardware. Mice without the entry are never asked, so a mouse that
   * refuses them costs no timeouts and the IRONCLAW's request sequence is unchanged.
   */
  extraProperties?: readonly ("brightness" | "angleSnapping" | "dpiStage")[];
}

/**
 * Mice by the product id they report over the cable, which is also what a
 * receiver returns for property 0x12 on their slot (ckb-next names receiver
 * children this way). The IRONCLAW's DPI range is from iCUE's slider: the
 * captured values only fit 100–18,000. The SCIMITAR RGB ELITE's range was
 * probed on the mouse: SET 100 and 18,000 are acked ok, 99 and 18,001 get
 * status 1 (invalid value) and leave the old value in place.
 */
export const CORSAIR_BRAGI_MICE: ReadonlyMap<number, CorsairBragiMouse> = new Map([
  [0x1b4c, { name: "IRONCLAW RGB WIRELESS", dpiMin: 100, dpiMax: 18_000 }],
  [0x1be3, {
    name: "SCIMITAR RGB ELITE",
    dpiMin: 100,
    dpiMax: 18_000,
    packetSize: 128,
    commandUsage: 0x01,
    extraProperties: ["brightness", "angleSnapping", "dpiStage"],
  }],
]);

/**
 * Receivers that relay to paired slots. 0x1bdc carried the ticket-0159
 * capture; 0x1b66 is the IRONCLAW's stock receiver in ckb-next (`usb.h`).
 */
export const CORSAIR_BRAGI_RECEIVERS: ReadonlyMap<number, string> = new Map([
  [0x1b66, "IRONCLAW RGB WIRELESS receiver"],
  [0x1bdc, "SLIPSTREAM WIRELESS USB Receiver"],
]);

export const CORSAIR_BRAGI_PRODUCT_IDS: readonly number[] = [...CORSAIR_BRAGI_MICE.keys(), ...CORSAIR_BRAGI_RECEIVERS.keys()];

export interface CorsairBragiReply {
  slot: number;
  command: number;
  status: number;
  /** Bytes 3–6 little-endian; a property uses as many of them as it needs. */
  value: number;
}

/** A zero-padded request of `size` bytes (a mouse's `packetSize`). */
export function corsairBragiPacketOfSize(size: number, slot: number, command: number, property: number, ...value: number[]): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot > CORSAIR_BRAGI_MAX_SLOT) {
    throw new Error(`Corsair Bragi slot must be 0–${CORSAIR_BRAGI_MAX_SLOT}.`);
  }
  if (!Number.isInteger(size) || size < 4 + value.length) throw new Error("Corsair Bragi packet size is too small for the request.");
  const packet = new Uint8Array(size);
  packet.set([CORSAIR_BRAGI_MAGIC | slot, command, property, 0x00, ...value]);
  return packet;
}

/** A zero-padded 64-byte request. */
export function corsairBragiPacket(slot: number, command: number, property: number, ...value: number[]): Uint8Array {
  return corsairBragiPacketOfSize(CORSAIR_BRAGI_PACKET_SIZE, slot, command, property, ...value);
}

/** The Bragi polling property value for a rate in Hz, or null when the table has none. */
function pollingValue(hz: number): number | null {
  for (const [value, rate] of CORSAIR_BRAGI_POLLING_RATES) if (rate === hz) return value;
  return null;
}

/**
 * Request encoders. `size` is the mouse's `packetSize` (default 64); pass 128 for the
 * SCIMITAR RGB ELITE. The driver is read-only for now, so nothing here is sent by it:
 * the SET layouts are tested against captures.
 */
export const corsairBragiEncode = {
  get: (slot: number, property: number, size = CORSAIR_BRAGI_PACKET_SIZE): Uint8Array =>
    corsairBragiPacketOfSize(size, slot, CORSAIR_BRAGI_COMMAND.get, property),
  /**
   * One DPI axis. iCUE sends X then Y on every change and gets a bare ack
   * (`01 01 00`) for each. Encoded here so the layout is tested against the
   * capture; the read-only driver never sends it. The mouse itself rejects values
   * outside its range with status 1 (SCIMITAR RGB ELITE: below 100 or above 18,000).
   * The write is live and volatile: the SCIMITAR RGB ELITE forgot it on a replug.
   */
  setDpi: (slot: number, axis: "x" | "y", dpi: number, size = CORSAIR_BRAGI_PACKET_SIZE): Uint8Array => {
    if (!Number.isInteger(dpi) || dpi < 1 || dpi > 0xffff) throw new Error("Corsair Bragi DPI must be an integer from 1 to 65535.");
    const property = axis === "x" ? CORSAIR_BRAGI_PROPERTY.dpiX : CORSAIR_BRAGI_PROPERTY.dpiY;
    return corsairBragiPacketOfSize(size, slot, CORSAIR_BRAGI_COMMAND.set, property, dpi & 0xff, dpi >> 8);
  },
  /**
   * Polling rate in Hz. The SCIMITAR RGB ELITE stores it and re-enumerates on USB
   * right after the ack, so the read-back must wait for the device to return.
   */
  setPollingRate: (slot: number, hz: number, size = CORSAIR_BRAGI_PACKET_SIZE): Uint8Array => {
    const value = pollingValue(hz);
    if (value === null) throw new Error(`Corsair Bragi has no polling value for ${hz} Hz.`);
    return corsairBragiPacketOfSize(size, slot, CORSAIR_BRAGI_COMMAND.set, CORSAIR_BRAGI_PROPERTY.pollingRate, value, 0x00);
  },
  /** Lighting brightness as a percentage, sent in tenths of a percent. Stored by the SCIMITAR RGB ELITE. */
  setBrightness: (slot: number, percent: number, size = CORSAIR_BRAGI_PACKET_SIZE): Uint8Array => {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("Corsair Bragi brightness must be 0–100 %.");
    const value = Math.round(percent * 10);
    return corsairBragiPacketOfSize(size, slot, CORSAIR_BRAGI_COMMAND.set, CORSAIR_BRAGI_PROPERTY.brightness, value & 0xff, value >> 8);
  },
  /** Angle snapping on or off. Stored by the SCIMITAR RGB ELITE. */
  setAngleSnapping: (slot: number, enabled: boolean, size = CORSAIR_BRAGI_PACKET_SIZE): Uint8Array =>
    corsairBragiPacketOfSize(size, slot, CORSAIR_BRAGI_COMMAND.set, CORSAIR_BRAGI_PROPERTY.angleSnapping, enabled ? 1 : 0, 0x00),
} as const;

/** True when `reply` answers `request`: same slot (low three bits) and the command echoed. */
export function corsairBragiIsReplyTo(request: Uint8Array, reply: Uint8Array): boolean {
  return reply.length >= 3 && (reply[0]! & 0x07) === (request[0]! & 0x07) && reply[1] === request[1];
}

export function corsairBragiStatusText(status: number): string {
  switch (status) {
    case CORSAIR_BRAGI_STATUS.invalidValue: return "invalid value";
    case CORSAIR_BRAGI_STATUS.failed: return "failed";
    case CORSAIR_BRAGI_STATUS.unsupported: return "not supported";
    default: return `error 0x${status.toString(16).padStart(2, "0")}`;
  }
}

export const corsairBragiDecode = {
  reply: (reply: Uint8Array): CorsairBragiReply => {
    if (reply.length < 7) throw new Error("Corsair Bragi reply is shorter than 7 bytes.");
    return {
      slot: reply[0]! & 0x07,
      command: reply[1]!,
      status: reply[2]!,
      value: (reply[3]! | (reply[4]! << 8) | (reply[5]! << 16) | (reply[6]! << 24)) >>> 0,
    };
  },
  /** Bytes 3–4 major and minor, 5–6 build (u16 LE), as OpenLinkHub prints it. */
  firmware: (reply: Uint8Array): string => {
    if (reply.length < 7) throw new Error("Corsair Bragi firmware reply is shorter than 7 bytes.");
    return `${reply[3]}.${reply[4]}.${reply[5]! | (reply[6]! << 8)}`;
  },
  pollingRateHz: (value: number): number | null => CORSAIR_BRAGI_POLLING_RATES.get(value) ?? null,
  /** Tenths of a percent → percent. */
  batteryPercent: (value: number): number | null => (value <= 1000 ? Math.round(value / 10) : null),
  /** Tenths of a percent → percent (SCIMITAR RGB ELITE brightness: 330 → 33). */
  brightnessPercent: (value: number): number | null => (value <= 1000 ? Math.round(value / 10) : null),
  /** 0 off, 1 on; anything else is not a value this mouse has been seen to send. */
  angleSnapping: (value: number): boolean | null => (value === 1 ? true : value === 0 ? false : null),
  /** ckb-next's battery enum: 1 charging, 2 discharging, 3 charged. */
  batteryState: (value: number): "Charging" | "Discharging" | "Full" | "Unknown" =>
    value === 1 ? "Charging" : value === 2 ? "Discharging" : value === 3 ? "Full" : "Unknown",
  /** Connected receiver slots, ascending. Bit 0 is never a paired device. */
  slots: (value: number): number[] => {
    const slots: number[] = [];
    for (let slot = 1; slot <= CORSAIR_BRAGI_MAX_SLOT; slot += 1) {
      if (value & (1 << slot)) slots.push(slot);
    }
    return slots;
  },
} as const;
