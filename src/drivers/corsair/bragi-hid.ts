import type { MouseStatus } from "../mouse-types.ts";
import {
  CORSAIR_BRAGI_MICE,
  CORSAIR_BRAGI_MODE,
  CORSAIR_BRAGI_PROPERTY,
  CORSAIR_BRAGI_RECEIVERS,
  CORSAIR_BRAGI_USAGE_PAGE,
  CORSAIR_VENDOR_ID,
  corsairBragiDecode,
  corsairBragiEncode,
  corsairBragiIsReplyTo,
  corsairBragiStatusText,
} from "@openmouse/protocol/corsair";

/** ckb-next waits 2 s and OpenLinkHub 1 s; iCUE's acks came back within 10 ms through the receiver. */
const REPLY_TIMEOUT_MS = 1000;
const REPLY_POLL_MS = 5;
const SUPPORTED_POLLING_RATES = [125, 250, 500, 1000];

/**
 * Corsair Bragi mice (IRONCLAW RGB WIRELESS) over the cable or a SLIPSTREAM
 * receiver. Read-only on purpose: iCUE's DPI writes are decoded and encoded
 * in the codec, but they were captured with iCUE driving the mouse (software
 * mode), and nothing shows yet whether the live-DPI property reads back or
 * sticks in hardware mode with iCUE closed. ckb-next flips to software mode
 * before reading; this driver never changes the mode, because a mouse left in
 * software mode stops applying its onboard settings until something flips it
 * back.
 *
 * A request is one 64-byte output report; its answer is the next input report
 * on the same interface with the same slot and command. Replies do not echo
 * the property, so all traffic goes through one queue. Windows hands every
 * open handle a copy of each input report, so a GET iCUE sends at the same
 * moment can answer ours: close iCUE for trustworthy values.
 */
export class CorsairBragiHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private inbox: Uint8Array[] = [];
  private onReport: ((event: HIDInputReportEvent) => void) | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  /**
   * Corsair VID, a known Bragi mouse or receiver, and the 0xFF42 collection
   * that takes output reports. The receiver's interface 2 is also 0xFF42 but
   * input-only (button and connection notifications), so it is not claimed.
   */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== CORSAIR_VENDOR_ID) return false;
    if (!CORSAIR_BRAGI_MICE.has(device.productId) && !CORSAIR_BRAGI_RECEIVERS.has(device.productId)) return false;
    return hasCommandCollection(device.collections);
  }

  get pollIntervalMs(): number { return 30_000; }

  getDpiOptions(): number[] { return []; }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.onReport) {
      this.onReport = (event) => {
        this.inbox.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
      };
      this.device.addEventListener("inputreport", this.onReport);
    }
  }

  async close(): Promise<void> {
    if (this.onReport) {
      this.device.removeEventListener("inputreport", this.onReport);
      this.onReport = null;
    }
    this.inbox = [];
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      return await this.readStatusDirect();
    });
  }

  private async readStatusDirect(): Promise<MouseStatus> {
    const receiver = CORSAIR_BRAGI_RECEIVERS.get(this.device.productId);
    let slot = 0;
    if (receiver) {
      const connected = await this.value(0, CORSAIR_BRAGI_PROPERTY.slots).then((bits) => bits === null ? null : corsairBragiDecode.slots(bits));
      const picked = pickSlot(connected);
      if (picked === null) {
        return identityOnly(receiver, "The receiver answered, but no mouse is connected to it. Wake the mouse (move it or click), then add it again.");
      }
      slot = picked;
    }

    const productId = await this.value(slot, CORSAIR_BRAGI_PROPERTY.productId);
    const mouse = CORSAIR_BRAGI_MICE.get(productId ?? this.device.productId);
    const name = mouse?.name ?? (productId === null ? receiver ?? "Corsair mouse" : `mouse 0x${hex(productId, 4)}`);
    const firmware = await this.get(slot, CORSAIR_BRAGI_PROPERTY.firmware).then(corsairBragiDecode.firmware, () => null);
    const mode = await this.value(slot, CORSAIR_BRAGI_PROPERTY.mode);
    const polling = await this.value(slot, CORSAIR_BRAGI_PROPERTY.pollingRate);
    const level = await this.value(slot, CORSAIR_BRAGI_PROPERTY.batteryLevel);
    const charge = await this.value(slot, CORSAIR_BRAGI_PROPERTY.batteryStatus);
    const dpiX = await this.value(slot, CORSAIR_BRAGI_PROPERTY.dpiX);
    // A mouse that ignores X will not answer Y either; skip the second timeout.
    const dpiY = dpiX === null ? null : await this.value(slot, CORSAIR_BRAGI_PROPERTY.dpiY);

    const software = mode === CORSAIR_BRAGI_MODE.software;
    const lines = [
      firmware ? `Firmware ${firmware}` : null,
      mode === null ? null : `Mode: ${software ? "software (iCUE is driving the mouse)" : mode === CORSAIR_BRAGI_MODE.hardware ? "hardware (onboard settings)" : `unknown (${mode})`}`,
      productId === null ? null : `Product id 0x${hex(productId, 4)}${receiver ? ` in receiver slot ${slot}` : ""}`,
    ].filter((line): line is string => line !== null);

    return {
      brand: "Corsair",
      name,
      batteryPercent: level === null ? null : corsairBragiDecode.batteryPercent(level),
      batteryState: charge === null ? "Unknown" : corsairBragiDecode.batteryState(charge),
      dpi: dpiX ?? 0,
      dpiY: dpiY ?? dpiX ?? 0,
      supportsSeparateDpiAxes: true,
      pollingRateHz: polling === null ? 0 : corsairBragiDecode.pollingRateHz(polling) ?? 0,
      supportedPollingRates: [...SUPPORTED_POLLING_RATES],
      activeProfile: null,
      deviceMode: mode === CORSAIR_BRAGI_MODE.hardware ? "Onboard" : software ? "Host" : "Unknown",
      connectionType: receiver ? "Wireless" : "Wired",
      connectionDetail: receiver ?? "USB",
      liftOffDistance: null,
      firmware: lines,
      ui: {
        family: "corsair-bragi",
        settingsReady: false,
        valuesVerified: dpiX !== null,
        defaultDisplayName: `Corsair ${name}`,
        statusNote: dpiX === null
          ? "Identified the mouse, but it did not answer the DPI read. Close iCUE, reconnect the mouse, and add it again."
          : software
            ? "Read-only for now. iCUE has the mouse in software mode, so these are iCUE's values."
            : "Read-only for now: DPI, polling rate and battery are read from the mouse but cannot be changed here yet.",
      },
    };
  }

  /** A property's value, or null when the mouse refuses it or stays silent. */
  private async value(slot: number, property: number): Promise<number | null> {
    return await this.get(slot, property).then((reply) => corsairBragiDecode.reply(reply).value, () => null);
  }

  /** One GET: send, then wait for the matching reply. Throws on a non-zero status or a timeout. */
  private async get(slot: number, property: number): Promise<Uint8Array> {
    const request = corsairBragiEncode.get(slot, property);
    this.inbox = [];
    await this.device.sendReport(0, request.buffer as ArrayBuffer);
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const reply = this.inbox.find((candidate) => corsairBragiIsReplyTo(request, candidate));
      if (reply) {
        const { status } = corsairBragiDecode.reply(reply);
        if (status !== 0) throw new Error(`Corsair property 0x${hex(property, 2)}: ${corsairBragiStatusText(status)}.`);
        return reply;
      }
      await delay(REPLY_POLL_MS);
    }
    throw new Error(`The Corsair mouse did not answer property 0x${hex(property, 2)}.`);
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

/**
 * Which receiver slot to talk to. `connected` lists the slots the receiver
 * reports as connected, ascending, or is null when that read failed; a failed
 * read falls back to slot 1, the one iCUE used, in case this receiver does not
 * answer 0x36 at all. Null means no mouse to talk to.
 */
function pickSlot(connected: number[] | null): number | null {
  // ponytail: lowest connected slot; read 0x12 per slot if a keyboard ever shares the receiver.
  if (connected === null) return 1;
  return connected[0] ?? null;
}

function identityOnly(name: string, note: string): MouseStatus {
  return {
    brand: "Corsair",
    name,
    batteryPercent: null,
    batteryState: "Unknown",
    dpi: 0,
    pollingRateHz: 0,
    activeProfile: null,
    connectionType: "Wireless",
    connectionDetail: name,
    liftOffDistance: null,
    firmware: [],
    ui: { family: "corsair-bragi", settingsReady: false, valuesVerified: false, defaultDisplayName: `Corsair ${name}`, statusNote: note },
  };
}

function hasCommandCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === CORSAIR_BRAGI_USAGE_PAGE && collection.outputReports.length > 0)
    || hasCommandCollection(collection.children));
}

function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, "0");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
