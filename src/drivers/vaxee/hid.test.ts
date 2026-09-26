import assert from "node:assert/strict";
import test from "node:test";
import { VaxeeHidClient } from "./hid.ts";
import { VAXEE_COMMAND, VAXEE_REPORT_ID } from "@openmouse/protocol/vaxee";

function device(productId = 0x2002, options: { ignoreWrites?: boolean; standardMode?: boolean } = {}) {
  let dpi = 800;
  let rateCode = 2;
  let lod = 1;
  let pending: Uint8Array | null = null;
  const writes: Uint8Array[] = [];
  const hid = {
    vendorId: 0x3057,
    productId,
    productName: "VAXEE receiver",
    opened: false,
    collections: [{
      usagePage: 0xff05, usage: 1, children: [],
      featureReports: [{ reportId: VAXEE_REPORT_ID, items: [{ reportSize: 8, reportCount: 63 }] }],
    }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async sendFeatureReport(reportId: number, buffer: BufferSource) {
      assert.equal(reportId, VAXEE_REPORT_ID);
      pending = new Uint8Array(buffer as ArrayBuffer);
      writes.push(pending);
      if (pending[2] === 2 && !options.ignoreWrites) {
        if (pending[1] === VAXEE_COMMAND.dpiValue) dpi = pending[5]! | (pending[6]! << 8);
        if (pending[1] === VAXEE_COMMAND.polling) rateCode = pending[4]!;
        if (pending[1] === VAXEE_COMMAND.lod) lod = pending[4]!;
      }
    },
    async receiveFeatureReport(reportId: number) {
      assert.equal(reportId, VAXEE_REPORT_ID);
      assert.ok(pending);
      const command = pending[1]!;
      const reply = new Uint8Array(63);
      const data = command === VAXEE_COMMAND.mousePid ? [0x11, 0x10]
        : command === VAXEE_COMMAND.dpiStage ? [1]
        : command === VAXEE_COMMAND.dpiValue ? [1, dpi & 255, dpi >> 8]
        : command === VAXEE_COMMAND.polling ? [rateCode]
        : command === VAXEE_COMMAND.tracking ? [options.standardMode ? 0 : 1]
        : command === VAXEE_COMMAND.lod ? [lod]
        : command === VAXEE_COMMAND.battery ? [13]
        : command === VAXEE_COMMAND.charging ? [0]
        : command === VAXEE_COMMAND.firmware ? [1, 2] : [1];
      reply.set([0xa5, command, 3, 1, data.length, ...data]);
      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;
  return { hid, writes };
}

test("VAXEE recognizes only the vendor feature collection", () => {
  const { hid } = device();
  assert.equal(VaxeeHidClient.isSupported(hid), true);
  assert.equal(VaxeeHidClient.isSupported({ ...hid, vendorId: 0x3058 } as HIDDevice), false);
  assert.equal(VaxeeHidClient.isSupported({ ...hid, collections: [] } as unknown as HIDDevice), false);
});

test("VAXEE refuses high polling in standard mode and reports ignored writes", async () => {
  const standard = device(0x2002, { standardMode: true });
  await assert.rejects(() => new VaxeeHidClient(standard.hid).setPollingRate(4000), /standard mode/);
  assert.equal(standard.writes.some((report) => report[1] === VAXEE_COMMAND.polling && report[2] === 2), false);

  const ignored = device(0x2002, { ignoreWrites: true });
  await assert.rejects(() => new VaxeeHidClient(ignored.hid).setDpi(1600), /did not persist/);
});

test("VAXEE status decodes battery steps and writes verify against read-back", async () => {
  const { hid, writes } = device();
  const client = new VaxeeHidClient(hid);
  const status = await client.readStatus();
  assert.equal(status.name, "VAXEE NP-01S V2 Wireless");
  assert.equal(status.batteryPercent, 65);
  assert.equal(status.dpi, 800);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(4000), 4000);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.ok(writes.some((report) => report[1] === VAXEE_COMMAND.dpiValue && report[2] === 2));
  await assert.rejects(() => client.setDpi(1651), RangeError);
  await assert.rejects(() => client.setPollingRate(125), RangeError);
});
