import assert from "node:assert/strict";
import test from "node:test";
import {
  redgearDecodeRawStatus,
  redgearDecodeStatusPayload,
} from "../../redgear/index.js";
import { RedgearX13HidClient } from "./hid.js";
import { X13_NATIVE_STATUS_HEX } from "./status-fixture.js";

const fixture = Uint8Array.from(Buffer.from(X13_NATIVE_STATUS_HEX, "hex"));
function mock() {
  const calls: string[] = [];
  const state = {
    vendorId: 0x1b80,
    productId: 0xb412,
    productName: "MECHREV Gaming Mouse",
    opened: false,
    collections: [
      {
        usagePage: 0xff00,
        usage: 1,
        children: [],
        inputReports: [],
        outputReports: [],
        featureReports: [
          { reportId: 3, items: [{ reportSize: 8, reportCount: 39 }] },
        ],
      },
    ],
    async open() {
      state.opened = true;
      calls.push("open");
    },
    async close() {
      state.opened = false;
      calls.push("close");
    },
    async receiveFeatureReport(id: number) {
      calls.push(`read:${id}`);
      // Exercise nonzero DataView offsets too.
      const bytes = new Uint8Array(44);
      bytes.set(fixture.subarray(1), 2);
      return new DataView(bytes.buffer, 2, 39);
    },
    async sendFeatureReport() {
      assert.fail("Driver must never write a feature report");
    },
    async sendReport() {
      assert.fail("Driver must never write an output report");
    },
  };
  return { state, device: state as unknown as HIDDevice, calls };
}

test("raw framing validates independent native fixture without interpreting settings", () => {
  const bytes = fixture.slice();
  const parsed = redgearDecodeRawStatus(bytes);
  assert.equal(parsed.payload.length, 39);
  assert.deepEqual(parsed.payload, fixture.slice(1));
  parsed.payload[0] = 0;
  assert.equal(bytes[1], 5);
  for (const length of [0, 1, 39, 41])
    assert.throws(() => redgearDecodeRawStatus(new Uint8Array(length)));
  const wrong = fixture.slice();
  wrong[0] = 4;
  assert.throws(() => redgearDecodeRawStatus(wrong), /report ID/);
  assert.deepEqual(
    redgearDecodeStatusPayload(fixture.subarray(1)).payload,
    fixture.subarray(1),
  );
  for (const length of [0, 38, 40])
    assert.throws(() => redgearDecodeStatusPayload(new Uint8Array(length)));
  // Payload byte 0 may itself equal 3; it must never be mistaken for an ID.
  const payload = fixture.slice(1);
  payload[0] = 3;
  assert.equal(redgearDecodeStatusPayload(payload).payload[0], 3);
});

test("identity matcher accepts only the status collection on the exact VID/PID", () => {
  const { device, state } = mock();
  assert.equal(RedgearX13HidClient.isSupported(device), true);
  state.productId = 0xb413;
  assert.equal(RedgearX13HidClient.isSupported(device), false);
  state.productId = 0xb412;
  state.vendorId = 0x1b81;
  assert.equal(RedgearX13HidClient.isSupported(device), false);
  state.vendorId = 0x1b80;
  state.collections[0]!.featureReports[0]!.reportId = 4;
  assert.equal(RedgearX13HidClient.isSupported(device), false);
  state.collections[0]!.featureReports[0]!.reportId = 3;
  state.collections[0]!.featureReports[0]!.items[0]!.reportCount = 2048;
  assert.equal(RedgearX13HidClient.isSupported(device), false);
});

test("status performs only GET_FEATURE(3), coalesces reads, and reports decoded settings", async () => {
  const { device, calls } = mock();
  const client = new RedgearX13HidClient(device);
  const pending = client.readStatus();
  assert.equal(client.readStatus(), pending);
  const status = await pending;
  assert.deepEqual(calls, ["open", "read:3"]);
  assert.equal(status.brand, "Redgear");
  assert.equal(status.ui?.settingsReady, true);
  assert.equal(status.ui?.valuesVerified, true);
  assert.deepEqual(status.firmware, []);
  assert.deepEqual(
    client.getDpiOptions(),
    [400, 800, 1200, 2400, 3200, 4000, 4800],
  );
  assert.equal(status.dpi, 4000);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(client.getRawStatusReport(), fixture);
  const copy = client.getRawStatusReport()!;
  copy[0] = 0;
  assert.equal(client.getRawStatusReport()![0], 3);
  await client.close();
  assert.equal(client.getRawStatusReport(), null);
});

function writableMock() {
  const result = mock();
  let current = fixture.slice(1);
  const writes: Uint8Array[] = [];
  result.state.receiveFeatureReport = async (id: number) => {
    result.calls.push(`read:${id}`);
    return new DataView(current.slice().buffer);
  };
  const device = result.device;
  device.sendFeatureReport = async (id: number, data: BufferSource) => {
    result.calls.push(`write:${id}`);
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    current = view.slice();
    writes.push(current.slice());
  };
  return { ...result, writes };
}

test("writes read fresh, preserve unknown bytes, serialize and verify each exact payload", async () => {
  const { device, calls, writes } = writableMock();
  const client = new RedgearX13HidClient(device);
  await Promise.all([client.setDpi(2400), client.setPollingRate(500)]);
  assert.deepEqual(calls, [
    "open",
    "read:3",
    "write:3",
    "read:3",
    "read:3",
    "write:3",
    "read:3",
  ]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.length, 39);
  assert.equal(writes[0]![0], 3);
  assert.equal(writes[1]![1], 2);
  for (let i = 2; i < 39; i++) assert.equal(writes[1]![i], fixture[i + 1]);
  assert.equal(writes[1]![2], 0x31);
  const status = await client.readStatus();
  assert.equal(status.dpi, 2400);
  assert.equal(status.pollingRateHz, 500);
  await client.setDpi(2400);
  assert.equal(writes.length, 2); // unchanged setting sends no write.
});

test("invalid values never open or touch hardware", async () => {
  const { device, calls } = writableMock();
  const client = new RedgearX13HidClient(device);
  await assert.rejects(client.setDpi(1600));
  await assert.rejects(client.setPollingRate(2000));
  assert.deepEqual(calls, []);
});

test("static lighting corrects the physical green/blue swap and rejects unsupported effects", async () => {
  const { device, writes } = writableMock();
  const client = new RedgearX13HidClient(device);
  const status = await client.readStatus();
  const lighting = status.lighting!;
  assert.equal(lighting.mode, null);
  assert.deepEqual(lighting.modes, ["Static"]);
  await assert.rejects(client.setLighting({ ...lighting, mode: "Wave" }));
  await assert.rejects(
    client.setLighting({ ...lighting, mode: "Static", brightness: 50 }),
  );
  assert.equal(writes.length, 0);
  await client.setLighting({ ...lighting, mode: "Static", color: "#00ff00" });
  assert.equal(writes.length, 1);
  const frame = writes[0]!;
  assert.equal(frame[2], 0);
  assert.deepEqual([...frame.slice(4, 7)], [0, 0, 255]);
  for (let i = 0; i < 39; i++)
    if (![2, 4, 5, 6].includes(i)) assert.equal(frame[i], fixture[i + 1]);
  assert.equal((await client.readStatus()).lighting!.color, "#00ff00");
});

test("button client reads report 4, edits one record, verifies, and leaves macros private", async () => {
  const { device, state, calls } = mock();
  state.collections[0]!.featureReports.push({
    reportId: 4,
    items: [{ reportSize: 8, reportCount: 2048 }],
  });
  const buttons = new Uint8Array(2048);
  const records = [
    "2101000000000000ffff",
    "2202000000000000ffff",
    "2304000000000000ffff",
    "44000000000000000000",
    "2510000000000000ffff",
    "2608000000000000ffff",
    "2702000000000000ffff",
  ];
  records.forEach((hex, i) => {
    buttons[i * 2] = 48 + i * 10;
    buttons.set(Buffer.from(hex, "hex"), 48 + i * 10);
  });
  buttons.fill(0x5a, 160);
  let current = buttons.slice();
  state.receiveFeatureReport = async (id: number) => {
    calls.push(`read:${id}`);
    return new DataView((id === 4 ? current : fixture.slice(1)).slice().buffer);
  };
  device.sendFeatureReport = async (id: number, data: BufferSource) => {
    assert.equal(id, 4);
    calls.push("write:4");
    current = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
      : new Uint8Array(data).slice();
  };
  const client = new RedgearX13HidClient(device);
  const status = await client.readStatus();
  assert.equal(status.buttonMappings!.Forward, "Forward");
  assert.equal(JSON.stringify(status).includes("5a5a5a"), false);
  await client.setButtonMapping("Forward", "Back");
  assert.equal(current[89], 8);
  for (let i = 0; i < 2048; i++)
    if (i !== 89) assert.equal(current[i], buttons[i]);
  assert.equal((await client.readStatus()).buttonMappings!.Forward, "Back");
  const count = calls.length;
  await assert.rejects(client.setButtonMapping("Left", "Back"), /primary/);
  assert.equal(calls.filter((c) => c === "write:4").length, 1);
  assert.ok(calls.length > count);
});

test("button read-back mismatch locks out subsequent settings writes", async () => {
  const { device, state, calls } = mock();
  const buttons = new Uint8Array(2048);
  const records = [
    "2101000000000000ffff",
    "2202000000000000ffff",
    "2304000000000000ffff",
    "44000000000000000000",
    "2510000000000000ffff",
    "2608000000000000ffff",
    "2702000000000000ffff",
  ];
  records.forEach((hex, i) => {
    buttons[i * 2] = 48 + i * 10;
    buttons.set(Buffer.from(hex, "hex"), 48 + i * 10);
  });
  state.receiveFeatureReport = async () => new DataView(buttons.slice().buffer);
  device.sendFeatureReport = async () => {
    calls.push("write:4");
  };
  const client = new RedgearX13HidClient(device);
  await assert.rejects(client.setButtonMapping("Forward", "Back"), /mismatch/);
  const count = calls.length;
  await assert.rejects(client.setDpi(2400), /reconnect/);
  assert.equal(calls.length, count);
});

test("write failure and verification mismatch disable further writes until reconnect", async () => {
  for (const failure of ["transport", "mismatch"]) {
    const { device, calls } = mock();
    const client = new RedgearX13HidClient(device);
    device.sendFeatureReport = async () => {
      calls.push("write");
      if (failure === "transport") throw new Error("denied");
    };
    await assert.rejects(
      client.setDpi(2400),
      failure === "transport" ? /denied/ : /mismatch/,
    );
    const count = calls.length;
    await assert.rejects(client.setPollingRate(500), /reconnect/);
    assert.equal(calls.length, count);
    assert.equal((await client.readStatus()).ui!.settingsReady, false);
    await client.close();
  }
});

test("closing during settings read prevents a later write", async () => {
  const { device, state, calls } = mock();
  let resolve!: (v: DataView) => void;
  let started!: () => void;
  const reading = new Promise<void>((r) => {
    started = r;
  });
  state.receiveFeatureReport = () =>
    new Promise((r) => {
      resolve = r;
      started();
    });
  const client = new RedgearX13HidClient(device);
  const pending = client.setDpi(2400);
  await reading;
  await client.close();
  resolve(new DataView(fixture.slice(1).buffer));
  await assert.rejects(pending, /disconnected/);
  assert.deepEqual(calls, ["open", "close"]);
});

test("failed or malformed reads degrade to identity and do not retry until reconnect", async () => {
  const { device, state, calls } = mock();
  state.receiveFeatureReport = async () => {
    calls.push("read:3");
    throw new Error("unavailable");
  };
  const client = new RedgearX13HidClient(device);
  assert.match((await client.readStatus()).ui!.statusNote!, /Identity only/);
  await client.readStatus();
  assert.deepEqual(calls, ["open", "read:3"]);
  await client.close();
  state.receiveFeatureReport = async () => {
    calls.push("malformed");
    return new DataView(new ArrayBuffer(2));
  };
  assert.match((await client.readStatus()).ui!.statusNote!, /Identity only/);
  assert.equal(client.getRawStatusReport(), null);
});

test("disconnect prevents an outstanding reply from repopulating cached status", async () => {
  const { device, state } = mock();
  let resolve!: (value: DataView) => void;
  let started!: () => void;
  const reading = new Promise<void>((r) => {
    started = r;
  });
  state.receiveFeatureReport = () =>
    new Promise<DataView>((r) => {
      resolve = r;
      started();
    });
  const client = new RedgearX13HidClient(device);
  const pending = client.readStatus();
  await reading;
  await client.close();
  resolve(new DataView(fixture.slice(1).buffer));
  await assert.rejects(pending, /disconnected/);
  assert.equal(client.getRawStatusReport(), null);
});

test("timeout falls back to identity without issuing overlapping retries", async () => {
  const { device, state, calls } = mock();
  state.receiveFeatureReport = () => {
    calls.push("pending-read");
    return new Promise<DataView>(() => {});
  };
  const client = new RedgearX13HidClient(device);
  assert.match((await client.readStatus()).ui!.statusNote!, /Identity only/);
  await client.readStatus();
  assert.deepEqual(calls, ["open", "pending-read"]);
  await client.close();
});
