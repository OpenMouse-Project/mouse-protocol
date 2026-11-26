import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupportedClient } from "../registry.ts";
import { Sinowealth520HidClient } from "./hid.ts";

const AULA = [4, 0, 0, 0, 0, 0x2e];
const GM3 = [4, 0, 0, 0, 0, 0x22];

/** A report-9 SinoWealth device that answers the signature read; other replies echo zeros. */
function mockDevice(signature: number[], productId = 0x0138) {
  const commands: number[] = [];
  let request = new Uint8Array();
  const device = {
    vendorId: 0x258a,
    productId,
    opened: true,
    collections: [{
      usagePage: 0xff02, usage: 2, children: [], inputReports: [], outputReports: [],
      featureReports: [{ reportId: 9, items: [{ reportSize: 8, reportCount: 519 }] }],
    }],
    async open() {},
    async close() {},
    async sendFeatureReport(_id: number, data: Uint8Array) {
      request = new Uint8Array(data);
      commands.push(request[1]!);
    },
    async receiveFeatureReport(id: number) {
      const frame = new Uint8Array(520);
      frame.set([id, ...request.slice(0, 7)]);
      if (request[1] === 0x05) frame.set(signature, 8);
      return new DataView(frame.buffer);
    },
  } as unknown as HIDDevice;
  return { device, commands };
}

const has = (client: object, method: string) => method in client;

test("both receivers and the GM3 cable go to the shared client", () => {
  for (const productId of [0x0136, 0x0138]) {
    assert.ok(createSupportedClient(mockDevice(AULA, productId).device) instanceof Sinowealth520HidClient);
  }
});

test("an AULA signature gets the AULA controls only", async () => {
  const { device } = mockDevice(AULA);
  const client = new Sinowealth520HidClient(device);
  assert.equal(has(client, "setPollingRate"), false, "no controls before the mouse is named");
  await client.readStatus().catch(() => undefined);
  assert.equal(has(client, "setDpiStageAxes"), true);
  assert.equal(has(client, "setDebounceTime"), false);
  assert.equal(has(client, "setButtonMapping"), false);
  assert.equal(client.pollIntervalMs, 0);
});

test("a GM3 signature gets the GM3 controls", async () => {
  const { device } = mockDevice(GM3);
  const client = new Sinowealth520HidClient(device);
  await client.readStatus().catch(() => undefined);
  assert.equal(has(client, "setDebounceTime"), true);
  assert.equal(has(client, "setButtonMapping"), true);
  assert.equal(has(client, "setDpiStageAxes"), false);
  assert.equal(client.pollIntervalMs, 2_000);
});

test("an AULA on the cable and an unknown model are refused before anything else is sent", async () => {
  for (const [signature, productId, message] of [
    [AULA, 0x0136, /2\.4 GHz receiver only/],
    [[4, 0, 0, 0, 0, 0x99], 0x0138, /does not know/],
    [[9, 9, 9, 9, 9, 9], 0x0138, /did not identify/],
  ] as const) {
    const { device, commands } = mockDevice([...signature], productId);
    const client = new Sinowealth520HidClient(device);
    await assert.rejects(client.readStatus(), message);
    assert.deepEqual(commands, [0x05], "only the signature was read");
    assert.equal(has(client, "setPollingRate"), false);
  }
});
