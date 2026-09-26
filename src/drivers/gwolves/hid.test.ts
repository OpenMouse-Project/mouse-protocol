import assert from "node:assert/strict";
import test from "node:test";

import { GWolvesHidClient } from "./hid.ts";
import { GWOLVES_COMMAND, gwolvesReportChecksum } from "@openmouse/protocol/gwolves";
import { TEEVOLUTION_KEY_CLASS as KEY, teevolutionEncodeKeyFunction } from "@openmouse/protocol/teevolution";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

function device(productId: number, reportId = 0x08, reportCount = 16): HIDDevice {
  return {
    vendorId: 0x33e4,
    productId,
    productName: "G-Wolves HTX Ultra 8K Wireless Mouse-RS",
    collections: [{
      usagePage: 0xff02,
      usage: 2,
      children: [],
      featureReports: [],
      inputReports: [{ reportId, items: [{ reportCount, reportSize: 8 }] }],
      outputReports: [{ reportId, items: [{ reportCount, reportSize: 8 }] }],
    }],
  } as unknown as HIDDevice;
}

test("support is driven by the product catalog, not hardcoded product ids", () => {
  // Arrange
  const wired = device(0x5618);
  const receiver = device(0x3854);
  const wrongVendor = { ...device(0x5618), vendorId: 0x3554 } as HIDDevice;
  const unknownModel = device(0x1234);
  const wrongReport = device(0x5618, 0x09, 48);

  // Act / Assert
  assert.equal(GWolvesHidClient.isSupported(wired), true);
  assert.equal(GWolvesHidClient.isSupported(receiver), true);
  assert.equal(GWolvesHidClient.isSupported(wrongVendor), false);
  assert.equal(GWolvesHidClient.isSupported(unknownModel), false);
  assert.equal(GWolvesHidClient.isSupported(wrongReport), false);
});

test("models the web driver drives over its 64-byte feature-report path are not claimed", () => {
  // Arrange: "XVI": "1" models in mouse.fit's env-models.json, including
  // "IsNewProtocol": "1" ones (HTM Plus, HSK Pro 2.0, HTXU 0x5608, Fenrir Pro).
  const featureReportModels = [0x3808, 0x3817, 0x6808, 0x6817, 0x5608, 0x5617, 0x3608, 0x3617, 0x3908, 0x2708, 0x5708, 0x5804];

  // Act / Assert: rejected even when the descriptor looks like report 8.
  for (const productId of featureReportModels) {
    assert.equal(GWolvesHidClient.isSupported(device(productId)), false, `0x${productId.toString(16)}`);
  }
});

test("transport metadata distinguishes receiver from cable via the catalog", () => {
  // Arrange / Act
  const wired = new GWolvesHidClient(device(0x5618));
  const receiver = new GWolvesHidClient(device(0x3854));

  // Assert
  assert.equal(wired.isWirelessPath(), false);
  assert.equal(receiver.isWirelessPath(), true);
});

test("poll interval is shorter over the wireless receiver", () => {
  // Arrange / Act
  const wired = new GWolvesHidClient(device(0x5618));
  const receiver = new GWolvesHidClient(device(0x3854));

  // Assert
  assert.equal(wired.pollIntervalMs, 30_000);
  assert.equal(receiver.pollIntervalMs, 10_000);
});

test("DPI options follow the shared VGN-family 50-step range", () => {
  // Arrange / Act
  const client = new GWolvesHidClient(device(0x5618));
  const options = client.getDpiOptions();

  // Assert
  assert.equal(options[0], 50);
  assert.equal(options[options.length - 1], 26_000);
  assert.equal(options.every((dpi) => dpi % 50 === 0), true);
});

/** Answers report 8 from a flash image; `unreadable` rejects reads there. */
function flashDevice(unreadable?: number): HIDDevice & { flash: Uint8Array } {
  const flash = new Uint8Array(256);
  [[KEY.mouse, 0x0100], [KEY.mouse, 0x0200], [KEY.mouse, 0x0400], [KEY.mouse, 0x0800], [KEY.mouse, 0x1000], [KEY.dpi, 0x0100]]
    .forEach(([cls, param], index) => flash.set(teevolutionEncodeKeyFunction(cls!, param!), 96 + index * 4));
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const fake = {
    ...device(0x5618),
    flash,
    opened: true,
    addEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => { listener = fn; },
    removeEventListener: () => { listener = null; },
    async sendReport(_: number, data: BufferSource) {
      const packet = new Uint8Array(data as ArrayBuffer);
      const reply = new Uint8Array(16);
      reply.set(packet.subarray(0, 5));
      const address = (packet[2]! << 8) | packet[3]!;
      if (packet[0] === GWOLVES_COMMAND.read) {
        if (address === unreadable) reply[1] = 1;
        else reply.set(flash.subarray(address, address + packet[4]!), 5);
      }
      if (packet[0] === GWOLVES_COMMAND.write) flash.set(packet.subarray(5, 5 + packet[4]!), address);
      reply[15] = gwolvesReportChecksum(reply.subarray(0, 15));
      queueMicrotask(() => listener?.({ reportId: 8, data: new DataView(reply.buffer) } as HIDInputReportEvent));
    },
  };
  return fake as unknown as HIDDevice & { flash: Uint8Array };
}

test("five buttons remap through the shared key table", async () => {
  const fake = flashDevice();
  const client = new GWolvesHidClient(fake);
  const status = await client.readStatus();
  assert.deepEqual(status.buttonMappings, {
    Left: "Left Click", Right: "Right Click", Middle: "Middle Click", Back: "Backward", Forward: "Forward",
  });
  assert.equal(status.buttonOptions?.includes("Scroll Left"), false, "tilt is Teevolution's alone");

  await client.setButtonMapping("Back", "DPI Loop");
  assert.deepEqual([...fake.flash.subarray(108, 112)], [...teevolutionEncodeKeyFunction(KEY.dpi, 0x0100)]);
  await assert.rejects(() => client.setButtonMapping("DPI", "Left Click"), /no "DPI" button/);
  await assert.rejects(() => client.setButtonMapping("Forward", "Scroll Left"), /Unknown button action/);
});

test("a key table that will not read leaves the rest of the status", async () => {
  const status = await new GWolvesHidClient(flashDevice(96)).readStatus();
  assert.equal(status.buttonMappings, undefined);
  assert.equal(status.brand, "G-Wolves");
});
