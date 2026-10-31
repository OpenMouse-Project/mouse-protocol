import { LamzuAtlantisHidClient } from "../lamzu-atlantis/hid.ts";
import { SCYROX_V8S_20K_ADDRESS, scyroxProduct } from "@openmouse/protocol/scyrox";

/**
 * Scyrox's CompX generation: the V8S mouse (wired 0x3554:0xf515) and its
 * "Turbo 8k" dongle (0x3554:0xf517). The Atlantis client does the talking —
 * same report-8 transport, same flash fields, same per-field sealing — with
 * one exception the product catalog carries: the rate bytes follow CompX's own
 * table (rateFamily "pulsar"), not Lamzu's. The dongle answered the Atlantis
 * client's exact read sequence on hardware; the wired endpoint was read
 * through the Pulsar driver's full-image sweep before this catalog existed,
 * and every field that sweep covered holds the same bytes with the seal
 * intact.
 *
 * Reads are verified on both transports (see docs/scyrox-v8s-testing.md);
 * writes inherit the Atlantis client's write-then-read-back behavior and still
 * need hardware verification one by one.
 *
 * The older V8's "SCYROX 8K Dongle" (0x3554:0xf5f7) answers the same
 * sequence; its 3950 sensor keeps the stages in the legacy fields, which the
 * catalog entry selects. Its full read and a polling-rate round trip are
 * verified (see docs/scyrox-v8-testing.md).
 */
export class ScyroxHidClient extends LamzuAtlantisHidClient {
  constructor(device: HIDDevice) {
    super(device, scyroxProduct(device.vendorId, device.productId) ?? null);
  }

  static override isSupported(device: HIDDevice): boolean {
    return scyroxProduct(device.vendorId, device.productId) !== undefined
      && LamzuAtlantisHidClient.hasConfigCollection(device);
  }

  /** The "20K" switch is a Scyrox-only byte, so the catalog cannot carry it. */
  protected override turboModeAddress(): number | null {
    return SCYROX_V8S_20K_ADDRESS;
  }
}
