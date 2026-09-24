import assert from "node:assert/strict";
import test from "node:test";

import { wlmouse4kEncodeRequest } from "@openmouse/protocol/wlmouse";
import { WLMouseBeastX4kHidClient } from "./beast-x-4k-hid.ts";
import { WLMouseHidClient } from "./hid.ts";
import { VENDOR_ID } from "../vendors.ts";

const globals = globalThis as { window?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } };
globals.window ??= { setTimeout, clearTimeout };

const hex = (text: string) => Uint8Array.from(text.trim().split(/\s+/), (byte) => parseInt(byte, 16));

/** Profile 0's settings block as the vendor software wrote it in the capture, clock bytes zeroed. */
const CAPTURED_BLOCK = hex(`
  00 00 04 01 00 00 ee 00 f1 01 00 03 00 00 01 00
  e8 03 40 06 fe 01 fb 01 00 20 03 80 0c 00 00 ff
  01 00 40 06 88 13 ff 00 00 01 00 80 0c 64 19 9d
  00 7e 01 00 00 19 90 01 14 ff ff 01 00 e0 2e 90
  01 ff 61 00 01 00 80 3e 90 01 ff a1 50 01 00 90
  65 90 01 96 c8 fe 1e 00 58 02 0a 00 00 80 07 38
  04 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00
  00 00 00 00 00`);

function fakeMouse(options: { failCommand?: number } = {}) {
  const memory = new Uint8Array(0x100);
  memory.set(CAPTURED_BLOCK);
  const sent: Array<{ command: number; address: number; length: number }> = [];
  let listener: ((event: HIDInputReportEvent) => void) | null = null;
  const device = {
    vendorId: VENDOR_ID.wlmouse,
    productId: 0xa887,
    productName: "WLmouse",
    opened: true,
    collections: [],
    open: async () => {},
    close: async () => {},
    addEventListener: (_type: string, next: (event: HIDInputReportEvent) => void) => { listener = next; },
    removeEventListener: () => { listener = null; },
    sendReport: async (_reportId: number, body: Uint8Array) => {
      const command = body[2]!;
      const length = body[3]!;
      const address = body[4]! | (body[5]! << 8);
      sent.push({ command, address, length });
      if (command === 0x06) memory.set(body.subarray(7, 7 + length), address);
      const data = command === 0x05 ? memory.subarray(address, address + length) : body.subarray(7, 7 + length);
      const reply = wlmouse4kEncodeRequest(command, address, data, length);
      if (command === options.failCommand) reply[6] = 0xff;
      listener?.({ reportId: 4, data: new DataView(reply.buffer) } as HIDInputReportEvent);
    },
  };
  return { device: device as unknown as HIDDevice, memory, sent };
}

test("requests are framed and checksummed exactly as in the vendor capture", () => {
  assert.deepEqual(wlmouse4kEncodeRequest(0xaa).subarray(0, 3), hex("6b 6b aa"));
  assert.deepEqual(wlmouse4kEncodeRequest(0x01).subarray(0, 3), hex("2b bf 01"));
  assert.deepEqual(wlmouse4kEncodeRequest(0x02).subarray(0, 3), hex("6b bd 02"));
  assert.deepEqual(
    wlmouse4kEncodeRequest(0x06, 0x18, CAPTURED_BLOCK.subarray(0x18, 0x30)).subarray(0, 31),
    hex("d9 e3 06 18 18 00 00 00 20 03 80 0c 00 00 ff 01 00 40 06 88 13 ff 00 00 01 00 80 0c 64 19 9d"),
  );
});

test("the captured settings block decodes to the mouse's settings", async () => {
  const status = await new WLMouseBeastX4kHidClient(fakeMouse().device).readStatus();
  assert.deepEqual(status.dpiStages, [1000]);
  assert.equal(status.dpi, 1000);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.hyperMode, false);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.sleepTimeout, 30);
  assert.equal(status.debounceMs, 10);
});

test("a polling change writes only its chunk inside a session and drops High Mode at 2K", async () => {
  const mouse = fakeMouse();
  mouse.memory[0x0a] = 1;
  assert.equal(await new WLMouseBeastX4kHidClient(mouse.device).setPollingRate(2000), 2000);
  const writes = mouse.sent.filter(({ command }) => command !== 0x05);
  assert.deepEqual(writes, [
    { command: 0x01, address: 0, length: 0 },
    { command: 0x06, address: 0, length: 24 },
    { command: 0x02, address: 0, length: 0 },
  ]);
  assert.equal(mouse.memory[0x0b], 4);
  assert.equal(mouse.memory[0x0a], 0);
  assert.deepEqual(mouse.memory.subarray(0x18, 0x75), CAPTURED_BLOCK.subarray(0x18));
});

test("an error status from the mouse is reported", async () => {
  const client = new WLMouseBeastX4kHidClient(fakeMouse({ failCommand: 0x06 }).device);
  await assert.rejects(client.setMotionSync(true), /rejected command 0x06/);
});

test("only the Beast X 4K's report-4 interface is claimed, and not by the compx driver", () => {
  const withReport4 = {
    vendorId: VENDOR_ID.wlmouse,
    productId: 0xa887,
    collections: [{ inputReports: [{ reportId: 4 }], outputReports: [{ reportId: 4 }], featureReports: [{ reportId: 0 }], children: [] }],
  } as unknown as HIDDevice;
  assert.equal(WLMouseBeastX4kHidClient.isSupported(withReport4), true);
  assert.equal(WLMouseHidClient.isSupported(withReport4), false);
  assert.equal(WLMouseBeastX4kHidClient.isSupported({ ...withReport4, productId: 0xa883 } as HIDDevice), false);
  assert.equal(WLMouseBeastX4kHidClient.isSupported({ ...withReport4, collections: [] } as unknown as HIDDevice), false);
});
