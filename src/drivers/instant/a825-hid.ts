import type { MouseStatus } from "../mouse-types.ts";
import {
  decodeInstantConfig,
  decodeInstantStatus,
  instantBlockReadByteFrame,
  instantBlockReadFrames,
  instantFrame,
  INSTANT_BLOCK,
  INSTANT_COMMAND,
  INSTANT_CONFIG_LENGTH,
  INSTANT_DPI_GEARS,
  INSTANT_FRAME_LENGTH,
  INSTANT_POLLING_RATES,
  INSTANT_PRODUCT_IDS,
  INSTANT_REPORT_ID,
  INSTANT_STATUS_LENGTH,
  INSTANT_USAGE,
  INSTANT_USAGE_PAGE,
  INSTANT_VENDOR_ID,
  instantDpiFrames,
  type InstantConfigImage,
} from "@openmouse/protocol/instant";

function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some(
    (collection) =>
      (collection.usagePage === INSTANT_USAGE_PAGE &&
        collection.usage === INSTANT_USAGE &&
        collection.featureReports.some(
          (report) => report.reportId === INSTANT_REPORT_ID,
        )) ||
      hasConfigCollection(collection.children),
  );
}

function statusBytes(view: DataView, reportId: number): Uint8Array {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  // The A825 reports are fixed-size: a numbered reply is 8 bytes for a command
  // and 32 for the status block. A reply of 7 or 31 bytes has no report ID, so
  // do not guess from the first byte (a stored value may itself be 0x07).
  const numbered =
    bytes.length === INSTANT_FRAME_LENGTH || bytes.length === INSTANT_STATUS_LENGTH;
  if (numbered) {
    if (bytes[0] !== reportId) {
      throw new Error(`Unexpected A825 report ID: ${bytes[0]}`);
    }
    return bytes.slice(1);
  }
  return bytes.slice();
}

/**
 * Sades Kaze / Instant A825 control client.
 *
 * Reads the 32-byte status block and the stored configuration image. Settings
 * framing is implemented in `@openmouse/protocol/instant`. The DPI command has
 * no observable read-back on this firmware and the polling-rate field is not yet
 * mapped, so the panel shows this device as read-only.
 */
export class InstantA825HidClient {
  readonly device: HIDDevice;
  private config: InstantConfigImage | null = null;
  private status: Uint8Array | null = null;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return (
      device.vendorId === INSTANT_VENDOR_ID &&
      INSTANT_PRODUCT_IDS.has(device.productId) &&
      hasConfigCollection(device.collections)
    );
  }

  getDpiOptions(): number[] {
    return [...INSTANT_DPI_GEARS];
  }

  getPollingRateOptions(): number[] {
    return [...INSTANT_POLLING_RATES];
  }

  async open(): Promise<void> {
    if (!InstantA825HidClient.isSupported(this.device)) {
      throw new Error("Unsupported A825 HID interface");
    }
    if (this.closing) await this.closing;
    if (this.opening) return this.opening;
    if (this.device.opened) return;
    const generation = this.generation;
    const task = (async () => {
      await this.device.open();
      if (generation !== this.generation) {
        if (this.device.opened) await this.device.close();
        throw new Error("A825 disconnected while opening");
      }
    })();
    this.opening = task;
    try {
      await task;
    } finally {
      if (this.opening === task) this.opening = null;
    }
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.config = null;
    this.status = null;
    this.queue = Promise.resolve();
    const task = (async () => {
      await this.opening?.catch(() => undefined);
      if (this.device.opened) await this.device.close();
    })();
    this.closing = task;
    try {
      await task;
    } finally {
      if (this.closing === task) this.closing = null;
    }
  }

  /** Raw 32-byte status report, including report ID 7. */
  getRawStatusReport(): Uint8Array | null {
    return this.status?.slice() ?? null;
  }

  /** Cached 0x0000-0x02FF configuration image, or null before it is read. */
  getConfigImage(): InstantConfigImage | null {
    return this.config
      ? {
          ...this.config,
          bytes: this.config.bytes.slice(),
        }
      : null;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const task = this.queue.then(() => {
      if (generation !== this.generation) {
        throw new Error("A825 disconnected before queued transfer");
      }
      return action();
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async send(frame: Uint8Array): Promise<void> {
    await this.device.sendFeatureReport(
      INSTANT_REPORT_ID,
      frame.slice(1).buffer,
    );
  }

  private async readStatusReport(): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(INSTANT_REPORT_ID);
    return statusBytes(view, INSTANT_REPORT_ID);
  }

  /** Read one byte from the configuration image, using the vendor read path. */
  private async readByte(address: number): Promise<number> {
    const setup = instantBlockReadFrames(address, 1);
    for (const frame of setup) await this.send(frame);
    await this.send(instantBlockReadByteFrame(address, 0, 1));
    const closeWindow = instantFrame(INSTANT_COMMAND.block, [
      INSTANT_BLOCK.commit,
      0,
      address & 0xff,
      (address >>> 8) & 0xff,
      0,
      0,
    ]);
    let report: Uint8Array;
    try {
      report = await this.readStatusReport();
    } catch (error) {
      // The read window is open even when the reply is lost. Try to close it,
      // but keep the original failure.
      await this.send(closeWindow).catch(() => undefined);
      throw error;
    }
    // The vendor closes the read window after every byte.
    await this.send(closeWindow);
    const full = new Uint8Array(report.length + 1);
    full[0] = INSTANT_REPORT_ID;
    full.set(report, 1);
    const value = full.length > 1 ? full[1] : null;
    if (value == null) throw new Error("A825 config read returned no data");
    return value;
  }

  /**
   * Read the stored configuration image. A full read is 0x1000 one-byte
   * transfers; read a small range when only a few bytes matter.
   */
  async readConfigImage(length = INSTANT_CONFIG_LENGTH): Promise<InstantConfigImage> {
    if (!Number.isInteger(length) || length < 1 || length > INSTANT_CONFIG_LENGTH) {
      throw new RangeError(`Invalid A825 config length: ${length}`);
    }
    return this.serialize(async () => {
      const generation = this.generation;
      await this.open();
      if (generation !== this.generation) {
        throw new Error("A825 disconnected while opening");
      }
      const bytes = new Uint8Array(length);
      for (let address = 0; address < length; address += 1) {
        bytes[address] = await this.readByte(address);
      }
      if (generation !== this.generation) {
        throw new Error("A825 disconnected during the configuration read");
      }
      const image = decodeInstantConfig(bytes);
      if (length === INSTANT_CONFIG_LENGTH) this.config = image;
      return {
        bytes: image.bytes.slice(),
        lightingDirectionByte: image.lightingDirectionByte,
      };
    });
  }

  async readStatus(): Promise<MouseStatus> {
    return this.serialize(async () => {
      const generation = this.generation;
      await this.open();
      if (generation !== this.generation) {
        throw new Error("A825 disconnected while opening");
      }
      const report = await this.readStatusReport();
      if (generation !== this.generation) {
        throw new Error("A825 disconnected during the status read");
      }
      this.status = new Uint8Array(report.length + 1);
      this.status[0] = INSTANT_REPORT_ID;
      this.status.set(report, 1);
      const decoded = decodeInstantStatus(this.status);

      return {
        brand: "Sades",
        name: this.device.productName || "Sades Kaze",
        ui: {
          family: "sades-a825",
          settingsReady: false,
          valuesVerified: false,
          pollingReadOnly: true,
          hideProcessingCard: true,
          hideSignalCard: true,
          hideSleepCard: true,
          defaultDisplayName: "Sades Kaze",
          statusNote:
            "Instant A825 control protocol captured; DPI and lighting writes are not enabled until they can be verified by read-back.",
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: 0,
        pollingRateHz: 0,
        supportedPollingRates: [...INSTANT_POLLING_RATES],
        activeProfile: null,
        connectionType: "Wired",
        connectionDetail: "USB",
        liftOffDistance: null,
        firmware:
          decoded?.magicOk
            ? [`Build 0x${decoded.firmware.toString(16).padStart(4, "0")}`]
            : [],
      };
    });
  }

  /**
   * Send the vendor's live DPI command. Kept for protocol tooling; the panel
   * does not expose it because this firmware gives no read-back for the value.
   */
  async setLiveDpi(dpi: number, mode = 0): Promise<number> {
    return this.serialize(async () => {
      await this.open();
      for (const frame of instantDpiFrames(dpi, mode)) await this.send(frame);
      return dpi;
    });
  }
}
