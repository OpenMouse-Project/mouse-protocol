import type { MouseStatus } from "../mouse-types.ts";
import {
  decodeWootingAnalogReport,
  decodeWootingDeviceConfig,
  decodeWootingVersion,
  encodeWootingCommand,
  isWootingReply,
  wootingFeatureReport,
  wootingProductName,
  WOOTING_MAGIC_MULTI,
  WOOTING_MAGIC_WORD_1,
  type WootingAnalogKey,
  WOOTING_ANALOG_USAGE_PAGE,
  WOOTING_COMMAND,
  WOOTING_CONFIG_USAGE,
  WOOTING_CONFIG_USAGE_PAGE,
  WOOTING_PRODUCTS,
  WOOTING_VENDOR_ID,
} from "@openmouse/protocol/wooting";

/**
 * Wooting analog keyboard (60HE+) read-only WebHID control — stage one.
 *
 * OpenMouse is a mouse control panel, so a keyboard has no home in the settings
 * grid. This driver's job is narrow and honest: recognise a supported Wooting
 * board, connect to its vendor config interface, and report what it is. It sets
 * `ui.settingsReady = false` so the mouse settings grid stays hidden, and it
 * exposes no setters, so nothing here can change a key, curve, or profile.
 *
 * Device identity always succeeds — it comes from the `HIDDevice` metadata. The
 * live device-config read is best-effort: the 60HE+ config interface declares
 * only an input report, so whether the browser permits the outgoing feature
 * report is hardware/Chrome-specific. When it is not permitted the driver still
 * connects and identifies the board; it just omits the live layout line.
 */

const CONFIG_RESPONSE_TIMEOUT_MS = 400;
/** How long to gather input reports for a multi-report reply (ack + data). */
const COLLECT_WINDOW_MS = 130;

export class WootingHidClient {
  readonly device: HIDDevice;

  private responseWaiter: { resolve: (data: Uint8Array) => void; reject: (error: Error) => void } | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;

  // Each command's raw reply is read once per connection and cached, so a
  // failure (or a device that just will not answer) never re-spams writes on
  // every background refresh.
  private readonly replies = new Map<number, Uint8Array | null>();

  // Serializes command sends so a profile read and a status refresh never share
  // the single input-report reply channel at the same time.
  private commandLock: Promise<unknown> = Promise.resolve();

  // When set, input reports are accumulated here instead of resolving a single
  // waiter — used to gather a multi-report reply (ack + data) for one command.
  private collecting: Uint8Array[] | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    const bytes = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    if (this.collecting) {
      this.collecting.push(bytes);
      return;
    }
    const waiter = this.responseWaiter;
    if (!waiter) return;
    this.clearPendingRead();
    waiter.resolve(bytes);
  };

  private listening = false;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  /**
   * Wooting VID plus the command-capable config collection: usage page `0xFF55`,
   * usage `0x01`. Only this collection is matched — a board also presents a
   * legacy `0xFF00` collection and the `0xFF53` analog stream, and matching those
   * would list the same physical keyboard several times.
   */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== WOOTING_VENDOR_ID) return false;
    if (!WOOTING_PRODUCTS.has(device.productId)) return false;
    return WootingHidClient.configCollection(device.collections) !== null;
  }

  /** The command-capable config collection, if this device exposes one. */
  private static configCollection(
    collections: readonly HIDCollectionInfo[],
  ): HIDCollectionInfo | null {
    for (const collection of collections) {
      if (collection.usage === WOOTING_CONFIG_USAGE
        && collection.usagePage === WOOTING_CONFIG_USAGE_PAGE) {
        return collection;
      }
      const nested = WootingHidClient.configCollection(collection.children);
      if (nested) return nested;
    }
    return null;
  }

  /**
   * Part of the shared client contract the control panel calls on every device.
   * A keyboard exposes no mouse DPI, so there are no options to offer.
   */
  getDpiOptions(): number[] {
    return [];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
  }

  async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    if (this.device.opened) await this.device.close();
  }

  /**
   * Subscribe to the live analog key stream. The 60HE+ pushes a full snapshot of
   * the currently-pressed keys as input reports on its analog interface (0xFF53,
   * a sibling of the config interface). Opens that interface, forwards each
   * decoded frame to `onFrame`, and resolves to a stop function that detaches the
   * listener. Rejects if the analog interface is not available to the page.
   */
  async startAnalog(onFrame: (keys: WootingAnalogKey[]) => void): Promise<() => void> {
    const analog = await this.analogDevice();
    if (!analog) {
      throw new Error("This Wooting's analog interface is not available to OpenMouse.");
    }
    if (!analog.opened) await analog.open();
    const listener = (event: HIDInputReportEvent): void => {
      const data = new Uint8Array(
        event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
      );
      onFrame(decodeWootingAnalogReport(data));
    };
    analog.addEventListener("inputreport", listener);
    return () => analog.removeEventListener("inputreport", listener);
  }

  /** The sibling analog-stream interface (same board, usage page 0xFF53). */
  private async analogDevice(): Promise<HIDDevice | null> {
    const hid = (globalThis.navigator as Navigator | undefined)?.hid;
    if (!hid) return null;
    const devices = await hid.getDevices();
    return devices.find((device) =>
      device.vendorId === WOOTING_VENDOR_ID
      && device.productId === this.device.productId
      && device.collections.some((collection) =>
        collection.usagePage === WOOTING_ANALOG_USAGE_PAGE && collection.usage === WOOTING_CONFIG_USAGE),
    ) ?? null;
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    // Sequential: each reply is awaited before the next command is sent, so the
    // input-report answers never interleave.
    const version = await this.command(WOOTING_COMMAND.getVersion);
    const config = await this.command(WOOTING_COMMAND.getDeviceConfig);

    return {
      brand: "Wooting",
      name: wootingProductName(this.device.productId),
      ui: {
        family: "wooting",
        // Keyboard analog controls have no place in the mouse settings grid yet.
        settingsReady: false,
        defaultDisplayName: wootingProductName(this.device.productId),
      },
      batteryPercent: null,
      batteryState: "Unknown",
      // Placeholder mouse fields the shared status shape still requires; the grid
      // is hidden, so these are never shown.
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: "USB",
      liftOffDistance: null,
      firmware: this.firmwareLines(version, config),
    };
  }

  // ---------------------------------------------------------------------------
  // Report I/O
  // ---------------------------------------------------------------------------

  /**
   * Best-effort live read of a command's raw reply, attempted once per connection
   * and then cached. Never throws: on any failure it returns null, the caller
   * falls back to whatever it has, and the failure is remembered so a background
   * refresh does not try (and fail) the write again.
   */
  private async command(commandId: number): Promise<Uint8Array | null> {
    if (this.replies.has(commandId)) return this.replies.get(commandId) ?? null;
    const raw = await this.sendCommand(commandId).catch(() => null);
    this.replies.set(commandId, raw);
    return raw;
  }

  /**
   * Live (uncached) read of the connected profile's actuation / rapid-trigger
   * settings: the current profile index plus the raw analog-profile "main part"
   * reply, for the analog UI to decode.
   */
  async readAnalogProfile(): Promise<{ index: number | null; reports: Uint8Array[]; note: string }> {
    const indexReply = await this.sendCommand(WOOTING_COMMAND.getCurrentKeyboardProfileIndex).catch(() => null);
    const index = indexReply && indexReply.length > 4 ? indexReply[4]! : null;
    // Send the profile-read command over Wootility's OUTPUT-report channel and
    // collect whatever comes back. Surface exactly what happened for diagnosis.
    // The parameter is an "optionalProfile" selector: qQ = (namespace << 8) | index
    // in the low 16 bits (namespace enum: onboard=0, linked=1). We've confirmed the
    // command/selector but not the exact CHANNEL + MAGIC. Wootility uses output
    // reports with magic 0xD0 0xDA; our feature commands use 0xD1 0xDA. Sweep the
    // combinations and keep whichever returns a real body. All read-only.
    // get_keyboard_profile (0x27) carries the actuation (nested field 1 = mm × 20480)
    // and rapid-trigger fields. Read it over the working channel (feature, magic
    // 0xD1, current-profile selector 0xFFFF).
    const command = new Uint8Array([
      WOOTING_MAGIC_MULTI, WOOTING_MAGIC_WORD_1, WOOTING_COMMAND.getKeyboardProfile, 0xff, 0xff, 0x00, 0x00,
    ]);
    const reports = await this.collectCommand(command, false).catch(() => []);
    const note = reports.some((report) => report.subarray(4).some((byte) => byte !== 0))
      ? "get_keyboard_profile"
      : "no body";
    return { index, reports, note };
  }

  /**
   * Send a command and gather every input report it triggers within a short
   * window. `viaOutput` chooses Wootility's output-report channel (id 2) versus
   * the feature-report channel.
   */
  private async collectCommand(command: Uint8Array, viaOutput: boolean): Promise<Uint8Array[]> {
    const run = this.commandLock.then(async () => {
      this.collecting = [];
      try {
        if (viaOutput) {
          const report = new Uint8Array(62);
          report.set(command.subarray(0, 62));
          await this.device.sendReport(2, report);
        } else {
          await this.device.sendFeatureReport(this.featureReportId(), command.slice());
        }
      } catch (error) {
        this.collecting = null;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, COLLECT_WINDOW_MS));
      const reports = this.collecting ?? [];
      this.collecting = null;
      return reports;
    });
    this.commandLock = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Serialize command sends so overlapping callers never share the reply channel. */
  private async sendCommand(commandId: number, param0 = 0): Promise<Uint8Array | null> {
    const run = this.commandLock.then(() => this.probeCommand(commandId, param0));
    this.commandLock = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Send a command on the config interface's declared feature report and read the
   * reply. The 60HE+ answers with the multi-report magic (0xD1), so commands go
   * out in that form. The answer arrives as an input report (matching Wooting's
   * own tooling); a feature GET is tried only as a fallback. Returns the raw
   * reply for the matching command, or null if nothing usable came back.
   */
  private async probeCommand(commandId: number, param0 = 0): Promise<Uint8Array | null> {
    const reportId = this.featureReportId();
    // Magic + command payload, without hidapi's leading report-index byte —
    // WebHID carries the report id separately.
    const payload = wootingFeatureReport(
      encodeWootingCommand(commandId, param0, 0, 0, 0, { multiReport: true }),
    ).data;

    const inputReply = this.nextInputReport();
    inputReply.catch(() => {}); // guard: this promise may go unused

    try {
      await this.device.sendFeatureReport(reportId, payload);
    } catch {
      this.clearPendingRead();
      return null;
    }

    const viaInput = await inputReply.catch(() => null);
    if (viaInput && isWootingReply(viaInput)) return viaInput;

    this.clearPendingRead();
    const viaFeature = await this.device.receiveFeatureReport(reportId)
      .then((view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
      .catch(() => null);
    return viaFeature && isWootingReply(viaFeature) ? viaFeature : null;
  }

  /** Report id of the config collection's declared feature report (0 if none). */
  private featureReportId(): number {
    const collection = WootingHidClient.configCollection(this.device.collections);
    return collection?.featureReports?.[0]?.reportId ?? 0;
  }

  /** Resolve with the next input report, or reject on timeout. */
  private nextInputReport(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.responseWaiter = { resolve, reject };
      this.responseTimer = setTimeout(() => {
        const waiter = this.responseWaiter;
        if (!waiter) return;
        this.clearPendingRead();
        waiter.reject(new Error("Wooting keyboard did not answer the config request."));
      }, CONFIG_RESPONSE_TIMEOUT_MS);
    });
  }

  private clearPendingRead(): void {
    if (this.responseTimer !== null) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
    this.responseWaiter = null;
  }

  /**
   * Turn the command replies into readable lines. Decoded fields (firmware
   * version, layout) are shown on their own; a raw hex preview appears only as a
   * fallback when a reply could not be decoded, so a fully-decoded board reads as
   * a clean two-line card rather than a debug dump.
   */
  private firmwareLines(version: Uint8Array | null, config: Uint8Array | null): string[] {
    const lines: string[] = [];

    if (version) {
      const decoded = decodeWootingVersion(version);
      lines.push(decoded ? `Firmware: ${decoded}` : `Version reply: ${wootingHexPreview(version, 20)}`);
    }

    if (config) {
      // Only decode when the reply carries a payload past its 4-byte header — a
      // header-only answer has no config, so never invent a layout.
      const decoded = config.subarray(4).some((byte) => byte !== 0)
        ? decodeWootingDeviceConfig(config)
        : null;
      lines.push(decoded ? `Layout: ${decoded.layout}` : `Config reply: ${wootingHexPreview(config, 20)}`);
    }

    return lines;
  }
}

/** First `count` bytes of a buffer as spaced hex, with an ellipsis if truncated. */
function wootingHexPreview(bytes: Uint8Array, count: number): string {
  const shown = [...bytes.subarray(0, count)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > count ? `${shown} …` : shown;
}
