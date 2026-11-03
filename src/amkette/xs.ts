/**
 * Amkette XS series on the 0x04F3 OEM firmware it shares with the Ryunix Kyu Pro
 * MX1. The wire protocol, telemetry and command encoders are shared and live in
 * `@openmouse/protocol/ryunix`; this module holds only what identifies the
 * Amkette models: their IDs, collection usage, product strings and Bluetooth
 * names. See `docs/amkette-xs-flow-testing.md` for the evidence.
 */

import { RYUNIX_WIRED_PRODUCT_ID, RYUNIX_WIRELESS_PRODUCT_ID } from "../ryunix/kyu-pro-mx1.ts";

/**
 * Bluetooth LE product ID of the Amkette XS Flow 2 Speed. Amkette's
 * configurator treats any ID other than 0x026E and 0x026F as Bluetooth.
 */
export const AMKETTE_XS_BLUETOOTH_PRODUCT_ID = 0x026d;
/**
 * The Amkette XS firmware publishes the same configuration channel on usage
 * 0x00 of page 0x0A, on all three paths, where the Kyu Pro MX1 contribution
 * saw usage 0xC7. The usage keeps the two drivers apart.
 */
export const AMKETTE_XS_USAGE = 0x00;
export const AMKETTE_XS_PRODUCT_IDS: ReadonlySet<number> = new Set([
  AMKETTE_XS_BLUETOOTH_PRODUCT_ID,
  RYUNIX_WIRED_PRODUCT_ID,
  RYUNIX_WIRELESS_PRODUCT_ID,
]);

export interface AmketteXsModel {
  /** Retail name shown to the user. */
  name: string;
  /** The USB product string the model reports, as Amkette's configurator labels it. */
  productStrings: readonly string[];
  /**
   * Base of the Bluetooth LE name; the mouse keeps three Bluetooth slots and
   * appends the active slot, e.g. "XS speed 2". Null where not known.
   */
  bluetoothLabel: string | null;
  /** Lighting scheme in the vendor app (`RYUNIX_LIGHTING_SCHEMES` in `@openmouse/protocol/ryunix`). */
  lightingScheme: number;
  /** True once an owned unit has been seen reporting `productStrings`. */
  verified: boolean;
}

/**
 * Amkette XS models on this firmware. Each configurator names its device with a
 * short label; an owned XS Flow 2 Speed reports that label ("XS Speed") as its
 * USB product string on the cable. Over Bluetooth LE it advertises "XS speed" plus
 * the active slot (the mouse holds three; "XS speed 2" was seen on slot 2, the
 * other slots are as the owner described them). The other two models' labels are
 * taken from their configurators and have not been seen on hardware.
 */
export const AMKETTE_XS_MODELS: readonly AmketteXsModel[] = [
  { name: "XS Flow 2 Speed", productStrings: ["XS Speed"], bluetoothLabel: "XS speed", lightingScheme: 1, verified: true },
  { name: "XS Flow Plus", productStrings: ["XS Flow+"], bluetoothLabel: null, lightingScheme: 3, verified: false },
  { name: "XS Natural Plus", productStrings: ["XS Natural+"], bluetoothLabel: null, lightingScheme: 4, verified: false },
];

function compactName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * The Amkette model a product string names: a USB label or a Bluetooth slot
 * name. Retail names are not matched, since the firmware has not been seen to
 * report them.
 */
export function amketteXsModel(productName: string | null | undefined): AmketteXsModel | null {
  const compact = compactName(productName ?? "");
  if (compact === "") return null;
  return AMKETTE_XS_MODELS.find((model) =>
    model.productStrings.some((label) => compact === compactName(label))
    || amketteBluetoothSlot(productName, model) !== null) ?? null;
}

/**
 * Name shown when the firmware reports no model name. The driver is chosen by
 * the usage-0x00 collection, which has only been seen on an Amkette mouse, so an
 * unnamed device is shown as Amkette's XS series rather than a specific model.
 */
export const AMKETTE_XS_FALLBACK_NAME = "XS series";

/**
 * True for the generic strings the 2.4 GHz receiver reports ("2.4G Wireless
 * Receiver"), which name the dongle rather than the mouse.
 */
export function amketteIsReceiverName(name: string | null | undefined): boolean {
  return /receiver|dongle/i.test(name ?? "");
}

/** The Bluetooth slot (1-3) a name like "XS speed 2" advertises for a model, or null. */
export function amketteBluetoothSlot(
  productName: string | null | undefined,
  model?: AmketteXsModel,
): number | null {
  const compact = compactName(productName ?? "");
  for (const candidate of model ? [model] : AMKETTE_XS_MODELS) {
    if (candidate.bluetoothLabel === null) continue;
    const base = compactName(candidate.bluetoothLabel);
    const slot = /^[123]$/.exec(compact.slice(base.length));
    if (compact.startsWith(base) && slot) return Number(slot[0]);
  }
  return null;
}
