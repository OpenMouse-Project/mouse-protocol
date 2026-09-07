/**
 * GearHub-V5 codec — the transport-independent half of support for the
 * MicLink/mlzn ODM platform on VID 0x3151 (qmk.top's "GearHub-V5" web tool).
 *
 * This layer knows packet shapes, command ids, the Bit7 checksum, the report-
 * rate table, and the device catalog. It knows nothing about WebHID or the
 * 2.4 GHz relay — that lives in `src/drivers/gearhub/hid.ts`.
 *
 * VID 0x3151 belongs to the ODM, not to any one brand: several unrelated
 * makers ship on it. A GearHub-V5 mouse is identified by the GET_USB_VERSION
 * *device id* (the same key GearHub's own bundle looks its model table up by),
 * never by product id — the receiver's VID:PID is shared. The product id only
 * settles transport (2.4 GHz receiver vs. direct cable).
 *
 * Everything here was read out of GearHub-V5's own JS bundle and confirmed
 * byte for byte on hardware: a Lingbao M5 Pro (PAW3395, device id 2285) and an
 * Attack Shark R2 (PAW3950, device id 1893), both on the 2.4 GHz receiver
 * (0x3151:0x402D), Windows 11.
 */

export const GEARHUB_VENDOR_ID = 0x3151;
export const GEARHUB_REPORT_ID = 0x00;
export const GEARHUB_REPORT_SIZE = 64;
export const GEARHUB_CMD_SIZE = 9;

/** DPI stages the report layout has room for. */
export const GEARHUB_MAX_DPI_STAGES = 8;

/**
 * Mouse-class command ids. GearHub groups settings into two 64-byte "option
 * param" blocks that are read whole and written back whole:
 *
 *   OPTIONPARAM1 (GET 0xD4 / SET 0x54) — the DPI stage table.
 *   OPTIONPARAM0 (GET 0xD3 / SET 0x53) — report rate (byte 9), debounce
 *     (byte 10), lift-off / "silent height" (byte 52), sleep, sensitivity.
 *
 * There is no standalone GET/SET report-rate command — an earlier version of
 * this driver used one (0x83 / 0x03) and the firmware silently ignored it.
 */
export const CMD = {
  GET_FIRMWARE: 0x80,
  GET_USB_VERSION: 0x8f,
  GET_OPTIONPARAM0: 0xd3,
  SET_OPTIONPARAM0: 0x53,
  GET_DPI: 0xd4, // GET_OPTIONPARAM1
  SET_DPI: 0x54, // SET_OPTIONPARAM1
  GET_KEYMATRIX: 0xd0, // [0xD0, profile] -> 14 slots x 4-byte action, in one reply
  SET_KEYMATRIX: 0x50, // [0x50, profile, slot, 0,0,0,0,0, d0,d1,d2,d3] -> one button
} as const;

/**
 * Receiver-level relay commands. Raw — the Bit7 checksum is NOT applied to
 * these. The relay sequencing itself is the driver's job.
 */
export const DONGLE_CMD = {
  SELECT_TARGET: 0xf6,
  GET_STATUS: 0xf7,
  NOTICE_READ: 0xfc,
} as const;

export const TARGET_MOUSE = 0x05;

/**
 * OPTIONPARAM0 report-rate field (byte 9) encoding, from GearHub's
 * `___utils_reportRateToNum` / `___utils_numToReportRate`. NOT a plain 0..6
 * index — a bitmask-style code. Verified on hardware: an R2 at 1000 Hz read
 * back code 1, and writing code 129 set it to 8000 Hz.
 */
export const REPORT_RATE_ENCODE: Record<number, number> = {
  8000: 129,
  4000: 130,
  2000: 132,
  1000: 1,
  500: 2,
  250: 4,
  125: 8,
};

export const REPORT_RATE_DECODE: Record<number, number> = Object.fromEntries(
  Object.entries(REPORT_RATE_ENCODE).map(([hz, code]) => [code, Number(hz)]),
);

/** Every rate the codec can express, ascending. */
export const GEARHUB_RATES = Object.keys(REPORT_RATE_ENCODE)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * OPTIONPARAM0 byte offsets (GET reply layout == SET payload layout), from
 * GearHub's `___getMouseOption0` / `___cmdSetMouseOption0`.
 */
export const OPT0_REPORT_RATE = 9;
export const OPT0_DEBOUNCE = 10;
/** 16-bit LE flags word. Bit 2 is ripple correction ("wave repair"). */
export const OPT0_FLAGS = 12;
export const OPT0_FLAG_RIPPLE = 1 << 2;
/** LE16 idle-before-standby, in seconds. GearHub exposes a per-link timer. */
export const OPT0_SLEEP_BT = 40;
export const OPT0_SLEEP_24G = 44;
/** Straight-line / angle-snapping correction ("line repair"): 0 or 1. */
export const OPT0_STRAIGHT_CORRECTION = 53;
/** Lift-off / "silent height": an index into the sensor's lift-off list. */
export const OPT0_SILENT_HEIGHT = 52;

/** GearHub's Debounce slider runs 1-10 (ms). */
export const GEARHUB_DEBOUNCE_MAX_MS = 10;

/**
 * Standby-time stops offered to the UI, in seconds; 0 = never sleep. GearHub
 * itself takes a free-form seconds value — this is the discrete set the
 * OpenMouse sleep card renders, chosen to cover the useful range.
 */
export const GEARHUB_SLEEP_OPTIONS = [0, 15, 30, 60, 120, 300];

/** DPI table (OPTIONPARAM1) byte offsets, confirmed on hardware:
 *   [2] active stage index, [3] stage count,
 *   [8 + i*2] X as LE uint16, [24 + i*2] Y as LE uint16,
 *   [40 + i*3] that stage's indicator colour as r, g, b. */
export const DPI_X_OFFSET = 8;
export const DPI_Y_OFFSET = 24;
export const DPI_RGB_OFFSET = 40;

export type LiftOffLevel = "Low" | "Medium" | "High";

/**
 * Lift-off stops per sensor, ordered by the OPTIONPARAM0 byte-52 index
 * (ascending height). Derived from GearHub's `getLiftOffDistance()`:
 * PAW3950/3955 offer 0.7 / 1 / 2 mm; PAW3395 offers 1 / 2 mm.
 */
export const GEARHUB_LIFT_OFF_LEVELS: Record<string, readonly LiftOffLevel[]> = {
  "PixArt PAW3950": ["Low", "Medium", "High"],
  "PixArt PAW3955": ["Low", "Medium", "High"],
  "PixArt PAW3395": ["Low", "High"],
};

// ── Button remapping (keymatrix) ───────────────────────────────────────────

/**
 * The GET_KEYMATRIX reply is 14 slots of 4 bytes. These are the slots that map
 * to a physical R2 button, in the order OpenMouse shows them. Verified on
 * hardware: slots 0-4 hold Left/Right/Middle/Back/Forward by default, slot 5
 * holds DPI Loop (the bottom DPI button).
 */
export interface GearHubButton {
  /** Name shown in the remapper. */
  name: string;
  /** Slot index into the keymatrix (also the SET_KEYMATRIX button arg). */
  slot: number;
}

export const GEARHUB_BUTTONS: readonly GearHubButton[] = [
  { name: "Left", slot: 0 },
  { name: "Right", slot: 1 },
  { name: "Middle", slot: 2 },
  { name: "Back", slot: 3 },
  { name: "Forward", slot: 4 },
  { name: "DPI", slot: 5 },
];

/**
 * Assignable actions, label → 4-byte matrix value, from GearHub's `ia` table.
 * Mouse functions only (no keyboard keys, combos or macros — OpenMouse's
 * generic remapper is a single-choice dropdown). Left…Forward and DPI Loop
 * were confirmed on hardware; DPI ± come straight from the bundle.
 */
export const GEARHUB_BUTTON_ACTIONS: ReadonlyArray<
  readonly [string, readonly [number, number, number, number]]
> = [
  ["Left Click", [1, 0, 0xf0, 0]],
  ["Right Click", [1, 0, 0xf1, 0]],
  ["Middle Click", [1, 0, 0xf2, 0]],
  ["Back", [1, 0, 0xf3, 0]],
  ["Forward", [1, 0, 0xf4, 0]],
  ["DPI Loop", [20, 0, 0, 0]],
  ["DPI +", [20, 0, 1, 0]],
  ["DPI -", [0, 2, 0, 20]],
  ["Disabled", [0, 0, 0, 0]],
];

/** Decode a 4-byte slot to an action label; "Custom" for anything else
 *  (a keyboard key / macro set in GearHub — left untouched). */
export function decodeButtonAction(bytes: readonly number[]): string {
  for (const [label, value] of GEARHUB_BUTTON_ACTIONS) {
    if (value.every((b, i) => b === bytes[i])) return label;
  }
  return "Custom";
}

/** Encode an action label to its 4-byte slot value, or null if unknown. */
export function encodeButtonAction(
  label: string,
): readonly [number, number, number, number] | null {
  return GEARHUB_BUTTON_ACTIONS.find(([l]) => l === label)?.[1] ?? null;
}

/** Pad to 9 bytes and stamp the Bit7 checksum into byte 7. */
export function encodeCommand(bytes: readonly number[]): Uint8Array {
  const out = new Uint8Array(Math.max(GEARHUB_CMD_SIZE, bytes.length));
  out.set(bytes);
  let sum = 0;
  for (let i = 0; i < 7; i++) sum = (sum + out[i]) & 0xff;
  out[7] = (255 - sum) & 0xff;
  return out;
}

// ── Transport catalog ──────────────────────────────────────────────────────

/** What a product id settles on its own: how the mouse is reached. */
export interface GearHubTransport {
  transport: "dongle" | "direct";
  /** Polling ceiling this link imposes regardless of the sensor. */
  wiredPollingCeilingHz?: number;
}

/**
 * Product ids on VID 0x3151 for this family, and the only thing the id itself
 * settles: transport. The M5 Pro presents the 2.4 GHz receiver (0x402D) and,
 * by cable, the mouse directly (0x4026).
 *
 * Bluetooth is a third mode not listed here: over BLE the device enumerates on
 * a different usage page entirely (0xFF35/0xFF66) and GearHub drives it through
 * a separate read path this driver does not implement.
 */
export const GEARHUB_PRODUCTS: ReadonlyMap<number, GearHubTransport> = new Map([
  [0x402d, { transport: "dongle" }],
  [0x4026, { transport: "direct", wiredPollingCeilingHz: 1000 }],
]);

// ── Device catalog (by GET_USB_VERSION device id) ──────────────────────────

/**
 * Per-model identity, keyed by the GET_USB_VERSION device id. The receiver's
 * VID:PID is shared across GearHub-V5 mice, so it cannot carry any of this —
 * only the device id can. `brand` names the maker that ships this id.
 */
export interface GearHubProfile {
  deviceId: number;
  brand: "Lingbao" | "Attack Shark";
  model: string;
  sensor: string;
  maxPollingHz: number;
  minDpi: number;
  maxDpi: number;
  dpiStep: number;
}

/**
 * The M5 Pro receiver is an 8K part — GearHub flags 0x402D `reportRate: 8e3`
 * and the mouse answered code 0 (8000 Hz) live. Lingbao's own base-M5-Pro
 * sheet says 1000 Hz, so either it undersells the receiver or the bundle
 * varies; this follows the hardware. Wired mode is capped to 1000 Hz by the
 * `GEARHUB_PRODUCTS` entry, not here.
 */
export const LINGBAO_M5_PRO_PROFILE: GearHubProfile = {
  deviceId: 2285,
  brand: "Lingbao",
  model: "M5 Pro",
  sensor: "PixArt PAW3395",
  maxPollingHz: 8000,
  minDpi: 50,
  maxDpi: 26000,
  dpiStep: 50,
};

/**
 * Attack Shark R2. Same GearHub-V5 platform and VID:PID as the M5 Pro,
 * distinguished only by device id 1893 (Attack Shark's own web driver shows it
 * as `ID1893_v201`). Verified on retail hardware over the 2.4 GHz receiver:
 * identity, firmware v2.01, the six-stage DPI table (top stage ~42000),
 * 8000 Hz polling, DPI read + write. Wired mode (PID 0x4026) was not tested.
 */
export const ATTACK_SHARK_R2_PROFILE: GearHubProfile = {
  deviceId: 1893,
  brand: "Attack Shark",
  model: "R2",
  sensor: "PixArt PAW3950",
  maxPollingHz: 8000,
  minDpi: 50,
  maxDpi: 42000,
  dpiStep: 50,
};

export const GEARHUB_DEVICE_PROFILES: ReadonlyMap<number, GearHubProfile> = new Map(
  [LINGBAO_M5_PRO_PROFILE, ATTACK_SHARK_R2_PROFILE].map((profile) => [profile.deviceId, profile]),
);

/**
 * Identity for an unrecognised GearHub-V5 sibling: the M5 Pro, which is what
 * this driver always reported before it learned to ask for the device id.
 */
export const GEARHUB_FALLBACK_PROFILE = LINGBAO_M5_PRO_PROFILE;

/** Resolve a device id to its profile, or the fallback. */
export function gearHubProfileFor(deviceId: number | null | undefined): GearHubProfile {
  return (deviceId != null && GEARHUB_DEVICE_PROFILES.get(deviceId)) || GEARHUB_FALLBACK_PROFILE;
}
