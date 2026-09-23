import assert from "node:assert/strict";
import test from "node:test";

const { AtkBitmouseHidClient } = await import("./bitmouse-hid.ts");
const {
  BITMOUSE_COMMAND,
  BITMOUSE_COMMAND_CODE,
  BITMOUSE_ERROR_STATUS,
  BITMOUSE_FRAME_LENGTH,
  BITMOUSE_PAYLOAD_OFFSET,
  BITMOUSE_REPORT_ID,
} = await import("@openmouse/protocol/bitmouse");

interface FakeBitmouseOptions {
  /** Whether the fake's DPI block survives writes; a rejected write does not move the stage. */
  ignoreWrites?: boolean;
}

/**
 * A minimal BITMOUSE device answering only what `setActiveDpiStage` touches:
 * the seven `getAddressData` exchanges that assemble the DPI block and the
 * `setDpi` write. The block's first byte is the current stage — the one field
 * a write with `enable` set moves, which is exactly what the driver confirms.
 */
function fakeBitmouse(currentIndex: number, values: number[], options: FakeBitmouseOptions = {}) {
  const sent: Uint8Array[] = [];
  const listeners: Array<(event: HIDInputReportEvent) => void> = [];
  const block = new Uint8Array(70);
  block[0] = currentIndex;
  block[1] = values.length;
  values.forEach((value, index) => {
    const at = 2 + index * 8;
    block[at] = value & 0xff;
    block[at + 1] = (value >> 8) & 0xff;
    block[at + 2] = value & 0xff;
    block[at + 3] = (value >> 8) & 0xff;
  });

  const emitReply = (commandId: number, target: number, payload: readonly number[]) => {
    const frame = new Uint8Array(BITMOUSE_FRAME_LENGTH);
    frame[0] = BITMOUSE_COMMAND_CODE;
    frame[1] = 0x00;
    frame[2] = 0x3a;
    frame[3] = target;
    frame[4] = commandId;
    frame[5] = payload.length;
    frame.set(payload, 6);
    const event = { reportId: BITMOUSE_REPORT_ID, data: new DataView(frame.buffer) } as HIDInputReportEvent;
    for (const listener of listeners) listener(event);
  };

  const device = {
    vendorId: 0x25a0,
    productId: 0x1154,
    productName: "ATK ZERO",
    opened: true,
    collections: [{ usagePage: 0xff05, usage: 0x0001, children: [], featureReports: [], inputReports: [], outputReports: [] }],
    open: async () => {},
    close: async () => {},
    addEventListener: (_type: string, listener: (event: HIDInputReportEvent) => void) => listeners.push(listener),
    removeEventListener: (_type: string, listener: (event: HIDInputReportEvent) => void) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    sendReport: async (_reportId: number, data: Uint8Array) => {
      const frame = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      sent.push(frame);
      const commandId = frame[5];
      // getAddressData echoes its address and length, then the requested bytes.
      if (commandId === BITMOUSE_COMMAND.getAddressData) {
        const address = frame[BITMOUSE_PAYLOAD_OFFSET] | (frame[BITMOUSE_PAYLOAD_OFFSET + 1] << 8);
        const length = frame[BITMOUSE_PAYLOAD_OFFSET + 2];
        const payload = [
          address & 0xff,
          (address >> 8) & 0xff,
          length,
          ...Array.from(block.subarray(address - 1, address - 1 + length)),
        ];
        emitReply(commandId, frame[4], payload);
        return;
      }
      // setDpi: payload is [index, xLo, xHi, yLo, yHi, blue, green, red, 0, enable].
      if (commandId === BITMOUSE_COMMAND.setDpi && !options.ignoreWrites) {
        const index = frame[BITMOUSE_PAYLOAD_OFFSET]!;
        block[0] = index;
        const at = 2 + index * 8;
        block.set(frame.subarray(BITMOUSE_PAYLOAD_OFFSET + 1, BITMOUSE_PAYLOAD_OFFSET + 4), at); // x
        block.set(frame.subarray(BITMOUSE_PAYLOAD_OFFSET + 3, BITMOUSE_PAYLOAD_OFFSET + 6), at + 2); // y
        block[at + 4] = frame[BITMOUSE_PAYLOAD_OFFSET + 5]!; // blue
        block[at + 5] = frame[BITMOUSE_PAYLOAD_OFFSET + 6]!; // green
        block[at + 6] = frame[BITMOUSE_PAYLOAD_OFFSET + 7]!; // red
        return;
      }
      // Anything else the client might probe is refused loudly, so a test that
      // reaches an unexpected exchange fails instead of hanging.
      const payload = [0, 0, 0, 0];
      const error = new Uint8Array(BITMOUSE_FRAME_LENGTH);
      error[0] = BITMOUSE_COMMAND_CODE;
      error[1] = BITMOUSE_ERROR_STATUS;
      error[2] = 0x3a;
      error[3] = frame[4];
      error[4] = commandId;
      error[5] = payload.length;
      error.set(payload, 6);
      emitReply(commandId, frame[4], payload);
    },
  } as unknown as HIDDevice;

  return { client: new AtkBitmouseHidClient(device), sent };
}

test("setActiveDpiStage re-applies the stored stage with enable set", async () => {
  // Arrange: five stages, the mouse sitting on stage 0 (1-based 1).
  const { client, sent } = fakeBitmouse(0, [400, 800, 1600, 3200, 6400]);

  // Act
  const confirmed = await client.setActiveDpiStage(4);

  // Assert: the request echoes stage 4's stored record and moves onto it.
  assert.equal(confirmed, 4);
  const write = sent.find((frame) => frame[5] === BITMOUSE_COMMAND.setDpi);
  assert.ok(write, "a setDpi write should have been sent");
  assert.equal(write![BITMOUSE_PAYLOAD_OFFSET], 4, "writes the target stage");
  assert.equal(write![BITMOUSE_PAYLOAD_OFFSET + 8], 0, "stored record byte kept zero");
  assert.equal(write![BITMOUSE_PAYLOAD_OFFSET + 9], 1, "enable set moves the mouse onto it");
  assert.deepEqual([write![8], write![9]], [0x00, 0x19], "stage 4's 6400 DPI echoed unchanged");
});

test("setActiveDpiStage reports a mouse that refuses to move", async () => {
  const { client } = fakeBitmouse(0, [400, 800, 1600, 3200, 6400], { ignoreWrites: true });

  await assert.rejects(() => client.setActiveDpiStage(4), /stayed on stage 1 instead of 5/);
});