import assert from "node:assert/strict";

class InputReport extends Event implements HIDInputReportEvent {
  constructor(
    readonly device: HIDDevice,
    readonly reportId: number,
    readonly data: DataView,
  ) {
    super("inputreport");
  }
}

export class X6Device implements HIDDevice {
  vendorId = 0x0bda;
  productId = 0xffe0;
  productName = "Dongle 8K";
  opened = false;
  collections: HIDCollectionInfo[] = [
    {
      usagePage: 0xffc1,
      usage: 1,
      children: [],
      featureReports: [],
      inputReports: [
        { reportId: 0xb4, items: [{ reportSize: 8, reportCount: 63 }] },
      ],
      outputReports: [0xb3, 0xb5].map((reportId) => ({ reportId, items: [] })),
    },
  ];
  listeners = new Set<(event: HIDInputReportEvent) => void>();
  sent: Array<{ reportId: number; data: number[] }> = [];
  settings = Uint8Array.from(
    Buffer.from("060022220290012003b004800cc0120d0505012e", "hex"),
  );
  silent = false;
  retainWrites = true;
  failSend = false;
  beforeReply: (() => void) | null = null;

  async open() {
    this.opened = true;
  }

  async close() {
    this.opened = false;
  }

  addEventListener(
    _type: "inputreport",
    listener: (event: HIDInputReportEvent) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "inputreport",
    listener: (event: HIDInputReportEvent) => void,
  ) {
    this.listeners.delete(listener);
  }

  async sendFeatureReport(): Promise<void> {
    throw new Error("X6 uses output reports");
  }

  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("X6 uses input reports");
  }

  emit(reportId: number, bytes: Uint8Array) {
    const event = new InputReport(
      this,
      reportId,
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    for (const listener of this.listeners) listener(event);
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    assert.ok(this.opened);
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.sent.push({ reportId, data: [...bytes] });
    if (this.failSend) throw new Error("USB send failed");

    if (reportId === 0xb3 && bytes[0] === 6) {
      this.beforeReply?.();
      if (!this.silent) this.emit(0xb4, this.settings);
      return;
    }
    if (reportId !== 0xb5 || !this.retainWrites) return;

    switch (bytes[0]) {
      case 0x40:
        this.settings[4] = bytes[2];
        this.settings.set(bytes.subarray(4, 14), 5);
        if (bytes[14]) this.settings[16] = bytes[14];
        break;
      case 0x41:
        this.settings[2] = this.settings[3] = bytes[2] * 17;
        break;
      case 0x43:
        this.settings[17] = bytes[1];
        break;
      case 0x0a:
        this.settings[18] = bytes[2];
        break;
      case 0x42:
        this.settings[15] =
          (bytes[1] === 1 ? 1 : 2) |
          (bytes[2] === 1 ? 0x04 : 0) |
          (bytes[3] === 1 ? 0x08 : 0) |
          (bytes[4] === 1 ? 0x10 : 0) |
          (bytes[6] === 2 ? 0x40 : 0) |
          (bytes[7] === 2 ? 0x80 : 0);
        break;
    }
  }
}
