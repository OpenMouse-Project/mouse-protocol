import "../webhid.js";
import {
  HITSCAN_REPORT_ID, HITSCAN_PAYLOAD_LENGTH, HITSCAN_COMMAND,
  HITSCAN_VENDOR_ID, HITSCAN_PRODUCTS,
  hitscanChecksumIsValid, hitscanMatchesResponse, hitscanParseReadResponse,
  hitscanBuildReadChunks, hitscanBuildWriteChunks,
} from "../../hitscan/index.js";

export interface HitscanClientOptions {
  replyTimeoutMs?: number;
  attempts?: number;
  /** Unsolicited command 0x0a; receives the 16-byte body without report ID. */
  onNotification?: (payload: Uint8Array) => void;
}

/**
 * Native utility transport: WriteFile/ReadFile, report 8, 16-byte bodies.
 * Uses output reports and input events. It does not use feature reports.
 * See docs/hitscan/HID-COMMANDS.md and the linked static-analysis evidence.
 * Model capabilities and hardware behavior remain unverified.
 */
export class HitscanHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private listening = false;
  private pending: { request: Uint8Array; resolve: (reply: Uint8Array) => void; reject: (error: Error) => void } | null = null;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly notify?: (payload: Uint8Array) => void;

  constructor(device: HIDDevice, options: HitscanClientOptions = {}) {
    this.device = device;
    this.timeoutMs = options.replyTimeoutMs ?? 100;
    this.attempts = options.attempts ?? 3;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError("Invalid Hitscan timeout.");
    if (!Number.isInteger(this.attempts) || this.attempts < 1 || this.attempts > 5) throw new RangeError("Invalid Hitscan attempt count.");
    this.notify = options.onNotification;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== HITSCAN_VENDOR_ID || !HITSCAN_PRODUCTS.has(device.productId)) return false;
    const hasReport = (reports: readonly HIDReportInfo[]): boolean => reports.some(report =>
      report.reportId === HITSCAN_REPORT_ID && report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) === 128);
    const find = (collections: readonly HIDCollectionInfo[]): boolean => collections.some(collection =>
      (hasReport(collection.inputReports) && hasReport(collection.outputReports)) || find(collection.children));
    return find(device.collections);
  }

  private readonly onInput = (event: HIDInputReportEvent): void => {
    if (event.reportId !== HITSCAN_REPORT_ID || event.device !== this.device) return;
    const reply = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice();
    if (!hitscanChecksumIsValid(reply)) return;
    if (reply[0] === 0x0a) { this.notify?.(reply); return; }
    const pending = this.pending;
    if (!pending || !hitscanMatchesResponse(pending.request, reply)) return;
    if (pending.request[0] === HITSCAN_COMMAND.read && !hitscanParseReadResponse(
      reply, (pending.request[2]! << 8) | pending.request[3]!, pending.request[4]!,
    )) return;
    pending.resolve(reply);
  };

  async open(): Promise<void> {
    if (this.disposed) throw new Error("The Hitscan client is closed.");
    if (!this.device.opened) await this.device.open();
    if (!this.listening) { this.device.addEventListener("inputreport", this.onInput); this.listening = true; }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async exchangeNow(request: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    await this.open();
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 8));
      if (this.disposed) throw new Error("The Hitscan client is closed.");
      // Arm the waiter before sendReport: a device may reply before it resolves.
      const reply = new Promise<Uint8Array>((resolve, reject) => {
        const finish = (result: Uint8Array | Error): void => {
          clearTimeout(timer);
          this.pending = null;
          if (result instanceof Error) reject(result); else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error("The Hitscan device did not answer.")), this.timeoutMs);
        this.pending = { request, resolve: value => finish(value), reject: error => finish(error) };
      });
      // Attach immediately so a timeout during sendReport cannot reject unhandled.
      const outcome = reply.then(value => ({ value }), error => ({ error }));
      try { await this.device.sendReport(HITSCAN_REPORT_ID, request); }
      catch (error) {
        this.pending?.reject(error instanceof Error ? error : new Error(String(error)));
        await outcome;
        throw error;
      }
      const result = await outcome;
      if ("value" in result) return result.value;
      if (this.disposed || attempt === this.attempts - 1) throw result.error;
    }
    throw new Error("Hitscan exchange failed.");
  }

  /** Serializes commands; input and output exclude the Windows report-ID byte. */
  exchange(payload: Uint8Array): Promise<Uint8Array> {
    if (payload.length !== HITSCAN_PAYLOAD_LENGTH || !hitscanChecksumIsValid(payload)) throw new Error("Invalid Hitscan request.");
    const request = Uint8Array.from(payload);
    return this.run(() => this.exchangeNow(request));
  }

  private async readNow(address: number, length: number): Promise<Uint8Array> {
    const packets = hitscanBuildReadChunks(address, length);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const request of packets) {
      const chunkAddress = (request[2]! << 8) | request[3]!;
      const reply = await this.exchangeNow(request);
      const chunk = hitscanParseReadResponse(reply, chunkAddress, request[4]!);
      if (!chunk) throw new Error(`Invalid Hitscan flash reply at ${chunkAddress}.`);
      result.set(chunk, offset); offset += chunk.length;
    }
    return result;
  }

  readFlash(address: number, length: number): Promise<Uint8Array> {
    hitscanBuildReadChunks(address, length); // Validate before queueing.
    return this.run(() => this.readNow(address, length));
  }

  /** Write only the caller-selected range; require echo and readback verification. */
  writeFlash(address: number, data: Uint8Array): Promise<void> {
    const copy = Uint8Array.from(data);
    const packets = hitscanBuildWriteChunks(address, copy);
    return this.run(async () => {
      for (const request of packets) await this.exchangeNow(request);
      const readback = await this.readNow(address, copy.length);
      if (readback.some((value, index) => value !== copy[index])) throw new Error("The Hitscan device did not retain the requested bytes.");
    });
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.pending?.reject(new Error("The Hitscan client is closed."));
    await this.queue;
    if (this.listening) this.device.removeEventListener("inputreport", this.onInput);
    this.listening = false;
    if (this.device.opened) await this.device.close();
  }
}
