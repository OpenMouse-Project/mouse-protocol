import { LamzuAtlantisHidClient } from "../lamzu-atlantis/hid.ts";
import type { LamzuAtlantisProduct } from "@openmouse/protocol/lamzu";
import {
  SCYROX_CID,
  SCYROX_HANDSHAKE_KEY,
  SCYROX_POLLING_RATES_8K,
  SCYROX_TYPE_WIRED_8K,
  SCYROX_V8S_20K_ADDRESS,
  scyroxDecodeHandshake,
  scyroxEncodeHandshake,
  scyroxModelForMid,
  scyroxProduct,
  type ScyroxIdentity,
} from "@openmouse/protocol/scyrox";

const HANDSHAKE_COMMAND = 0x01;

/** How long a failed handshake waits before a later full read asks again. */
const IDENTIFY_RETRY_MS = 30_000;

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
  /** What the handshake answered; null until a Scyrox reply was read. */
  private identity: ScyroxIdentity | null = null;
  /** Set once the handshake got a reply, or has nothing to ask. */
  private identitySettled = false;
  /** No new handshake before this time, after one went unanswered. */
  private nextIdentifyAt = 0;
  /** Exposed so a test can retry without waiting. */
  protected identifyRetryMs = IDENTIFY_RETRY_MS;

  constructor(device: HIDDevice) {
    super(device, scyroxProduct(device.vendorId, device.productId) ?? null);
  }

  /**
   * The V8 and the V6 share product ids (the vendor tool tells them apart by
   * MID alone), so the 3950 entries ask until the mouse answers. A mouse
   * asleep behind the dongle does not answer; the next full read after
   * IDENTIFY_RETRY_MS asks again, so a silent mouse costs one timeout per
   * interval rather than one per read, and a mouse that wakes is still named.
   */
  protected override async identify(): Promise<void> {
    if (this.identitySettled || Date.now() < this.nextIdentifyAt) return;
    if (this.catalogEntry()?.model !== "V8") {
      this.identitySettled = true;
      return;
    }
    try {
      const reply = await this.request(HANDSHAKE_COMMAND, 0, scyroxEncodeHandshake(SCYROX_HANDSHAKE_KEY));
      // Any reply settles it: asking again would get the same answer.
      this.identitySettled = true;
      const identity = scyroxDecodeHandshake(reply);
      if (identity?.cid === SCYROX_CID) this.identity = identity;
    } catch {
      this.nextIdentifyAt = Date.now() + this.identifyRetryMs;
    }
  }

  private catalogEntry(): LamzuAtlantisProduct | undefined {
    return scyroxProduct(this.device.vendorId, this.device.productId);
  }

  private identifiedModel(): "V8" | "V6" | null {
    return this.identity ? scyroxModelForMid(this.identity.mid) ?? null : null;
  }

  /**
   * The 3950 entries' extra writes (the lift-off stop table, angle tuning,
   * the 30 ms debounce ceiling and Restore) were tested on a V8 and a V6, so
   * they are offered once the handshake has named the mouse either model. A
   * mouse that has not answered yet gets the shared controls only. A wired
   * mouse that reports the wired 8K type gets the 8K rate list instead of the
   * 1K default.
   */
  protected override product(): LamzuAtlantisProduct | undefined {
    const catalog = super.product();
    if (!catalog || catalog.model !== "V8") return catalog;
    const rates = !catalog.wireless && this.identity?.type === SCYROX_TYPE_WIRED_8K
      ? { pollingRates: SCYROX_POLLING_RATES_8K }
      : {};
    if (this.identifiedModel() !== null) return { ...catalog, ...rates };
    const { liftOffStopCodes: _stops, maxDebounceMs: _debounce, ...shared } = catalog;
    return { ...shared, ...rates, supportsAngleTuning: false, supportsFactoryReset: false };
  }

  override displayName(): string {
    const model = this.identifiedModel();
    return model ? `Scyrox ${model}` : super.displayName();
  }

  static override isSupported(device: HIDDevice): boolean {
    return scyroxProduct(device.vendorId, device.productId) !== undefined
      && LamzuAtlantisHidClient.hasConfigCollection(device);
  }

  /** The "20K" switch is a Scyrox-only byte, so the catalog cannot carry it. */
  protected override turboModeAddress(): number | null {
    return SCYROX_V8S_20K_ADDRESS;
  }

  /**
   * The configurator greys out 20K until Competitive Mode (performance mode
   * here) is on, and 20K only runs under it, so the two move together.
   */
  protected override linksTurboToPerformanceMode(): boolean {
    return true;
  }
}
