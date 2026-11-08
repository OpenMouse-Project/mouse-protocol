import assert from "node:assert/strict";
import test from "node:test";
import { KmartHidClient } from "./hid.ts";
import { KMART_COMMAND, KMART_REPORT_ID } from "@openmouse/protocol/kmart";

function device(options: { asleep?: boolean; ignoreWrites?: boolean; sensor?: number } = {}) {
  let interval = 8;
  let stageByte = 0x36;
  let pending: Uint8Array | null = null;
  const writes: Uint8Array[] = [];
  const hid = {
    vendorId: 0x248a,
    productId: 0x5b2f,
    productName: "Wireless-Receiver",
    opened: false,
    collections: [{
      usagePage: 0xff00, usage: 1, children: [],
      featureReports: [{ reportId: KMART_REPORT_ID, items: [{ reportSize: 8, reportCount: 32 }] }],
    }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async sendFeatureReport(reportId: number, data: BufferSource) {
      assert.equal(reportId, KMART_REPORT_ID);
      pending = new Uint8Array(data as Uint8Array);
      writes.push(pending);
      if (pending[4] === 1 && !options.ignoreWrites) {
        if (pending[1] === KMART_COMMAND.pollingInterval) interval = pending[6]!;
        if (pending[1] === KMART_COMMAND.dpiStages) stageByte = pending[6]!;
      }
    },
    async receiveFeatureReport(reportId: number) {
      assert.equal(reportId, KMART_REPORT_ID);
      assert.ok(pending);
      // WebHID on some platforms prefixes the report ID; exercise that path.
      const reply = new Uint8Array(33);
      reply.set([0x0c, 0x01, 0x20, options.asleep ? 2 : 0, pending[3]!, 0x01, 0x10, 0x00, 0x4d, 0x33, 0x36, 0x31, 0x32,
        0x01, 0x11, options.sensor ?? 0x25, stageByte, interval, 0x58, 0x00, 0xff, options.asleep ? 0 : 1]);
      return new DataView(reply.buffer);
    },
  } as unknown as HIDDevice;
  return { hid, writes };
}

test("Kmart recognizes only the vendor feature collection", () => {
  const { hid } = device();
  assert.equal(KmartHidClient.isSupported(hid), true);
  assert.equal(KmartHidClient.isSupported({ ...hid, productId: 0x5b30 } as HIDDevice), false);
  assert.equal(KmartHidClient.isSupported({ ...hid, collections: [{ usagePage: 1, usage: 2, children: [], featureReports: [] }] } as unknown as HIDDevice), false);
});

test("Kmart status reports battery, polling and the remembered stage DPI", async () => {
  const client = new KmartHidClient(device().hid);
  const status = await client.readStatus();
  assert.equal(status.brand, "Kmart");
  assert.equal(status.batteryPercent, 88);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.pollingRateHz, 125);
  assert.equal(status.dpi, 1600);
  assert.equal(status.connectionType, "Wireless");
});

test("Kmart polling writes verify against read-back", async () => {
  const { hid, writes } = device();
  const client = new KmartHidClient(hid);
  assert.equal(await client.setPollingRate(1000), 1000);
  assert.ok(writes.some((report) => report[1] === KMART_COMMAND.pollingInterval && report[6] === 1));
  await assert.rejects(() => new KmartHidClient(device({ ignoreWrites: true }).hid).setPollingRate(500), /did not persist/);
  await assert.rejects(() => client.setPollingRate(2000), RangeError);
});

test("Kmart DPI writes the full stage table and keeps untouched stages", async () => {
  const { hid, writes } = device();
  const client = new KmartHidClient(hid);
  assert.equal(await client.setDpi(1200), 1200);
  const dpiWrite = writes.find((report) => report[1] === KMART_COMMAND.dpiStages)!;
  assert.deepEqual([...dpiWrite.slice(4, 20)], [1, 18, 0x36, 0x3f, 3, 0, 7, 0, 11, 0, 0x17, 0, 0x1f, 0, 0x34, 0]);
  assert.equal((await client.readStatus()).dpi, 1200);
  await assert.rejects(() => client.setDpi(1250), RangeError);
});

test("Kmart refuses writes while the mouse sleeps or on an unverified sensor", async () => {
  const asleep = device({ asleep: true });
  await assert.rejects(() => new KmartHidClient(asleep.hid).setPollingRate(1000), /asleep/);
  assert.equal(asleep.writes.some((report) => report[4] === 1), false);
  await assert.rejects(() => new KmartHidClient(device({ sensor: 0x04 }).hid).setDpi(800), /no verified DPI table/);
});
