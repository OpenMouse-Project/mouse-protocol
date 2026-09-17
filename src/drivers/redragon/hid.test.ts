import assert from "node:assert/strict";
import test from "node:test";

import {
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_REPORT_ID,
  redragonDecodeDpiValue,
  redragonEncodeDpiSlot,
  redragonEncodeDpiValue,
  redragonEncodePollingRate,
} from "@openmouse/protocol/redragon";
import { RedragonHidClient } from "./hid.ts";

type Sent = { reportId: number; data: Uint8Array };

function configCollection(echo: Uint8Array = new Uint8Array([0x08, 0x40, 0, 0, 0, 0xfa, 0xfa])) {
  return {
    usagePage: REDRAGON_CONFIG_USAGE_PAGE,
    usage: REDRAGON_CONFIG_USAGE,
    children: [],
    featureReports: [{ reportId: REDRAGON_REPORT_ID, items: [{ reportSize: 8, reportCount: 16 }] }],
    inputReports: [],
    outputReports: [],
    echo,
  };
}

class FakeRedragonDevice {
  vendorId = 0x04d9;
  productId = 0xfc7a;
  productName = "USB Gaming Mouse";
  opened = false;
  collections: ReturnType<typeof configCollection>[] = [configCollection()];
  readonly sent: Sent[] = [];

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    this.sent.push({ reportId, data: new Uint8Array(data as ArrayBufferLike) });
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    assert.equal(reportId, REDRAGON_REPORT_ID);
    const echo = this.collections[0]!.echo;
    return new DataView(echo.buffer.slice(echo.byteOffset, echo.byteOffset + echo.byteLength));
  }
}

const asDevice = (fake: FakeRedragonDevice): HIDDevice => fake as unknown as HIDDevice;

test("DPI codes match the usbmon capture (800->0x12, 1200->0x1b, ...)", () => {
  assert.deepEqual(redragonEncodeDpiValue(800), { value: 0x12, range: 0 });
  assert.deepEqual(redragonEncodeDpiValue(1200), { value: 0x1b, range: 0 });
  assert.deepEqual(redragonEncodeDpiValue(2400), { value: 0x36, range: 0 });
  assert.deepEqual(redragonEncodeDpiValue(3500), { value: 0x4f, range: 0 });
  assert.deepEqual(redragonEncodeDpiValue(5500), { value: 0x7c, range: 0 });
  // 12400 overflows one byte: range flag set, value halved.
  assert.deepEqual(redragonEncodeDpiValue(12400), { value: 140, range: 1 });
});

test("DPI decode inverts the encode within quantization", () => {
  for (const dpi of [800, 1200, 2400, 3500, 5500, 12400]) {
    const { value, range } = redragonEncodeDpiValue(dpi);
    assert.ok(Math.abs(redragonDecodeDpiValue(value, range) - dpi) / dpi < 0.01, `dpi ${dpi}`);
  }
});

test("slot frame is byte-for-byte the captured RDCfg write", () => {
  // Captured: 02 f3 4a 00 05 00 00 00 01 36 00 36 00 00 00 00 (profile 1, level 2, 2400 DPI).
  assert.deepEqual(
    [...redragonEncodeDpiSlot(0, 1, 2400)],
    [0x02, 0xf3, 0x4a, 0x00, 0x05, 0, 0, 0, 0x01, 0x36, 0x00, 0x36, 0x00, 0, 0, 0],
  );
  // The user's live 800 DPI edit: 02 f3 44 00 05 ... 01 12 00 12 ...
  assert.deepEqual(
    [...redragonEncodeDpiSlot(0, 0, 800)],
    [0x02, 0xf3, 0x44, 0x00, 0x05, 0, 0, 0, 0x01, 0x12, 0x00, 0x12, 0x00, 0, 0, 0],
  );
});

test("encoder rejects what the device never showed", () => {
  assert.throws(() => redragonEncodeDpiSlot(0, 5, 800), /level/);
  assert.throws(() => redragonEncodeDpiSlot(1, 0, 800), /profile/);
  assert.throws(() => redragonEncodeDpiValue(40), /range/);
  assert.throws(() => redragonEncodeDpiValue(13000), /range/);
  assert.throws(() => redragonEncodeDpiValue(800.5), /range/);
});

test("polling codes match the capture (rate = 1000 / code)", () => {
  assert.deepEqual(
    [...redragonEncodePollingRate(125)],
    [0x02, 0xf3, 0x32, 0x00, 0x06, 0, 0, 0, 0x08, 0x00, 0x01, 0x00, 0x01, 0, 0, 0],
  );
  assert.equal(redragonEncodePollingRate(1000)[8], 0x01);
  assert.equal(redragonEncodePollingRate(500)[8], 0x02);
  assert.equal(redragonEncodePollingRate(250)[8], 0x04);
  assert.throws(() => redragonEncodePollingRate(2000), /never observed/);
  assert.throws(() => redragonEncodePollingRate(333), /never observed/);
});

test("setPollingRate sends open + rate + commit + close", async () => {
  const fake = new FakeRedragonDevice();
  const client = new RedragonHidClient(asDevice(fake));
  await client.setPollingRate(500);
  // open + 1 rate write + 5 commit writes + close.
  assert.equal(fake.sent.length, 8);
  assert.deepEqual(
    [...fake.sent[1]!.data],
    [0xf3, 0x32, 0x00, 0x06, 0, 0, 0, 0x02, 0x00, 0x01, 0x00, 0x01, 0, 0, 0],
  );
  const status = await client.readStatus();
  assert.equal(status.pollingRateHz, 500);
  assert.deepEqual(client.supportedPollingRates, [125, 250, 500, 1000]);
});

test("isSupported needs the Holtek VID, the M724 PID, and the config collection", () => {
  const good = new FakeRedragonDevice();
  assert.equal(RedragonHidClient.isSupported(asDevice(good)), true);
  const wrongVid = new FakeRedragonDevice();
  wrongVid.vendorId = 0x1234;
  assert.equal(RedragonHidClient.isSupported(asDevice(wrongVid)), false);
  const wrongPid = new FakeRedragonDevice();
  wrongPid.productId = 0x1111;
  assert.equal(RedragonHidClient.isSupported(asDevice(wrongPid)), false);
  const noCollection = new FakeRedragonDevice();
  noCollection.collections = [];
  assert.equal(RedragonHidClient.isSupported(asDevice(noCollection)), false);
});

test("readStatus reports the factory table as unverified", async () => {
  const client = new RedragonHidClient(asDevice(new FakeRedragonDevice()));
  const status = await client.readStatus();
  assert.equal(status.brand, "Redragon");
  assert.deepEqual(status.dpiStages, [1200, 2400, 3500, 5500, 12400]);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.ui?.dpiStageEditor?.maxStages, 5);
  assert.equal(status.ui?.dpiStageEditor?.countEditable, false);
  assert.equal(status.ui?.pollingReadOnly, undefined);
  assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
});

test("readStatus fails when the FA FA marker is absent", async () => {
  const fake = new FakeRedragonDevice();
  fake.collections = [configCollection(new Uint8Array([0x08, 0, 0, 0, 0, 0, 0]))];
  await assert.rejects(() => new RedragonHidClient(asDevice(fake)).readStatus(), /FA FA/);
});

test("setDpiStageValue pushes table + commit block in one bracket", async () => {
  const fake = new FakeRedragonDevice();
  const client = new RedragonHidClient(asDevice(fake));
  await client.setDpiStageValue(0, 800);
  // open + 5 slot writes + 5 commit writes + close.
  assert.equal(fake.sent.length, 12);
  assert.deepEqual([...fake.sent[0]!.data], [0xf5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    [...fake.sent[1]!.data],
    [0xf3, 0x44, 0x00, 0x05, 0, 0, 0, 0x01, 0x12, 0x00, 0x12, 0x00, 0, 0, 0],
  );
  // Untouched siblings echo the factory table.
  assert.deepEqual(
    [...fake.sent[2]!.data],
    [0xf3, 0x4a, 0x00, 0x05, 0, 0, 0, 0x01, 0x36, 0x00, 0x36, 0x00, 0, 0, 0],
  );
  assert.deepEqual(
    [...fake.sent[5]!.data],
    [0xf3, 0x5c, 0x00, 0x05, 0, 0, 0, 0x01, 0x8c, 0x01, 0x8c, 0x01, 0, 0, 0],
  );
  // Commit block, vendor order.
  for (const [index, code] of [0x04, 0x01, 0x02, 0x08, 0x10].entries()) {
    assert.deepEqual(
      [...fake.sent[6 + index]!.data],
      [0xf1, 0x02, code, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
  }
  assert.deepEqual([...fake.sent[11]!.data], [0xf5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const status = await client.readStatus();
  assert.deepEqual(status.dpiStages, [800, 2400, 3500, 5500, 12400]);
});
