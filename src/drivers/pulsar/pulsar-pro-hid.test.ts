import assert from "node:assert/strict";
import test from "node:test";

Object.assign(globalThis, { window: globalThis });

const { PulsarProHidClient } = await import("./pulsar-pro-hid.ts");

class FakePulsarProDevice {
  opened = true;
  readonly vendorId = 0x3710;
  readonly productId = 0x5405;
  readonly productName = "Pulsar PRO Dongle";
  readonly collections = [];
  sends = 0;
  opens = 0;
  private listener: ((event: HIDInputReportEvent) => void) | null = null;

  addEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void): void {
    if (this.listener === listener) this.listener = null;
  }

  async open(): Promise<void> { this.opens += 1; this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendReport(_reportId: number, data: BufferSource): Promise<void> {
    this.sends += 1;
    const view = data as ArrayBufferView;
    const command = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)[0] ?? 0;
    const response = new Uint8Array(64);
    response[0] = 0xa6;
    queueMicrotask(() => this.listener?.({ data: new DataView(response.buffer) } as HIDInputReportEvent));
    assert.equal(command, 0xc4);
  }
}

test("A6 rejects an optional command immediately and caches the unsupported query", async () => {
  const device = new FakePulsarProDevice();
  const client = new PulsarProHidClient(device as unknown as HIDDevice);
  await client.open();
  const optionalQuery = (client as unknown as {
    queryOptional(command: number, timeoutMs: number): Promise<Uint8Array | null>;
  }).queryOptional.bind(client);

  const started = Date.now();
  assert.equal(await optionalQuery(0xc4, 1_500), null);
  assert.ok(Date.now() - started < 250, "A6 should not wait for the request timeout");
  assert.equal(await optionalQuery(0xc4, 1_500), null);
  assert.equal(device.sends, 1, "a rejected optional query should not be probed again");
});

test("a command reopens a receiver that closed without an explicit client close", async () => {
  const device = new FakePulsarProDevice();
  device.opened = false;
  const client = new PulsarProHidClient(device as unknown as HIDDevice);
  const optionalQuery = (client as unknown as {
    queryOptional(command: number, timeoutMs: number): Promise<Uint8Array | null>;
  }).queryOptional.bind(client);

  assert.equal(await optionalQuery(0xc4, 1_500), null);
  assert.equal(device.opens, 1);
  assert.equal(device.sends, 1);
});
