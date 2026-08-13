import assert from "node:assert/strict";
import test from "node:test";

import { TeevolutionHidClient } from "./hid.ts";
import {
  TEEVOLUTION_COMMAND,
  TEEVOLUTION_FLASH,
  TEEVOLUTION_PACKET_LENGTH,
  TEEVOLUTION_REPORT_ID,
  teevolutionEncodeDpi,
  teevolutionEncodePollingRate,
  teevolutionPacketChecksum,
} from "@openmouse/protocol/teevolution";

Object.assign(globalThis, { window: globalThis });

function device(productId: number, reportId = TEEVOLUTION_REPORT_ID): HIDDevice {
  return {
    vendorId: 0x3554,
    productId,
    productName: "RapidSync",
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      children: [],
      featureReports: [],
      inputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
      outputReports: [{ reportId, items: [{ reportCount: 16, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

test("support is limited to Terra Pro Compx transports with report 8", () => {
  // Arrange
  const receiver = device(0xf523);
  const wired = device(0xf520);
  const alt = device(0xf5bb);
  const wrongPid = device(0xfb56);
  const wrongReport = device(0xf523, 0x09);

  // Act / Assert
  assert.equal(TeevolutionHidClient.isSupported(receiver), true);
  assert.equal(TeevolutionHidClient.isSupported(wired), true);
  assert.equal(TeevolutionHidClient.isSupported(alt), true);
  assert.equal(TeevolutionHidClient.isSupported(device(0xf522)), true);
  assert.equal(TeevolutionHidClient.isSupported(wrongPid), false);
  assert.equal(TeevolutionHidClient.isSupported(wrongReport), false);
});

class FakeRapidSync {
  readonly vendorId = 0x3554;
  readonly productId = 0xf523;
  readonly productName = "RapidSync";
  readonly collections = device(0xf523).collections;
  opened = false;
  readonly sent: Uint8Array[] = [];
  mouseOnline = true;

  private listeners = new Map<string, (event: unknown) => void>();
  private flash = new Uint8Array(256);

  constructor() {
    this.flash[TEEVOLUTION_FLASH.reportRate] = teevolutionEncodePollingRate(1000);
    this.flash[TEEVOLUTION_FLASH.reportRate + 1] = (0x55 - this.flash[0]!) & 0xff;
    this.flash[TEEVOLUTION_FLASH.maxDpiStage] = 2;
    this.flash[TEEVOLUTION_FLASH.currentDpi] = 1;
    this.flash[TEEVOLUTION_FLASH.liftOffDistance] = 1;
    this.flash.set(teevolutionEncodeDpi(1600), TEEVOLUTION_FLASH.dpiValues + 4);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendReport(_reportId: number, data: BufferSource): Promise<void> {
    const request = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(request.slice());
    const reply = new Uint8Array(TEEVOLUTION_PACKET_LENGTH);
    reply[0] = request[0] ?? 0;
    const command = request[0] ?? 0;
    if (command === TEEVOLUTION_COMMAND.encryptionData) {
      reply[9] = 14;
      reply[10] = 3;
      reply[11] = 5;
    } else if (command === TEEVOLUTION_COMMAND.deviceOnline) {
      reply[5] = this.mouseOnline ? 1 : 0;
    } else if (command === TEEVOLUTION_COMMAND.readFlashData) {
      const address = ((request[2] ?? 0) << 8) | (request[3] ?? 0);
      const length = request[4] ?? 0;
      reply[2] = request[2] ?? 0;
      reply[3] = request[3] ?? 0;
      reply[4] = length;
      reply.set(this.flash.slice(address, address + length), 5);
    } else if (command === TEEVOLUTION_COMMAND.writeFlashData) {
      const address = ((request[2] ?? 0) << 8) | (request[3] ?? 0);
      const length = request[4] ?? 0;
      this.flash.set(request.slice(5, 5 + length), address);
    } else if (command === TEEVOLUTION_COMMAND.batteryLevel) {
      reply[5] = 85;
    } else if (command === TEEVOLUTION_COMMAND.readVersionId || command === TEEVOLUTION_COMMAND.getDongleVersion) {
      reply[5] = 2;
      reply[6] = 0x21;
    }
    reply[15] = teevolutionPacketChecksum(reply);
    queueMicrotask(() => {
      this.listeners.get("inputreport")?.({
        reportId: TEEVOLUTION_REPORT_ID,
        data: new DataView(reply.buffer, reply.byteOffset, reply.byteLength),
      });
    });
  }
}

function onlineFlags(sent: readonly Uint8Array[]): number[] {
  return sent.filter((packet) => packet[0] === TEEVOLUTION_COMMAND.deviceOnline).map((packet) => packet[5] ?? 0);
}

test("status reads query online without taking host-control", async () => {
  // Arrange
  const hid = new FakeRapidSync();
  const client = new TeevolutionHidClient(hid as unknown as HIDDevice);

  // Act
  const status = await client.readStatus();

  // Assert
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(onlineFlags(hid.sent), [0]);
});

test("polling writes still enter and leave host-control", async () => {
  // Arrange
  const hid = new FakeRapidSync();
  const client = new TeevolutionHidClient(hid as unknown as HIDDevice);
  await client.readDeviceInfo();
  hid.sent.length = 0;

  // Act
  const confirmed = await client.setPollingRate(2000);

  // Assert
  assert.equal(confirmed, 2000);
  assert.deepEqual(onlineFlags(hid.sent), [1, 0]);
});
