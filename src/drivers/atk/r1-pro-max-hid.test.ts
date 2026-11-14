import assert from "node:assert/strict";
import test from "node:test";

import { atkPackDpiStageForSensor } from "@openmouse/protocol/atk";
import { AtkHidClient } from "./hid.ts";

type Sent = { reportId: number; data: Uint8Array };

class FakeR1ProMaxDevice {
  vendorId = 0x3554;
  productId: number;
  productName: string;
  opened = false;
  collections = [{
    usagePage: 0xff02,
    usage: 0x0002,
    children: [],
    featureReports: [],
    inputReports: [],
    outputReports: [],
  }];

  readonly sent: Sent[] = [];
  replies: number[][] = [];
  writeReplies: number[][] = [];
  private listeners = new Set<(event: HIDInputReportEvent) => void>();

  constructor(productId: number, productName: string) {
    this.productId = productId;
    this.productName = productName;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async forget(): Promise<void> {}

  addEventListener(
    type: string,
    listener: (event: HIDInputReportEvent) => void,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "inputreport") this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: HIDInputReportEvent) => void,
    _options?: boolean | EventListenerOptions,
  ): void {
    if (type === "inputreport") this.listeners.delete(listener);
  }

  async sendReport(reportId: number, data: ArrayBuffer): Promise<void> {
    const frame = new Uint8Array(data);
    this.sent.push({ reportId, data: frame });
    const reply = frame[0] === 0x07
      ? this.writeReplies.shift()
      : this.replies.shift();
    if (!reply) return;
    const payload = new Uint8Array(reply);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ reportId, data: new DataView(payload.buffer) } as HIDInputReportEvent);
      }
    });
  }

  async sendFeatureReport(): Promise<void> {
    throw new Error("not used");
  }

  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("not used");
  }
}

function device(productId: number, productName: string): HIDDevice {
  return new FakeR1ProMaxDevice(productId, productName) as unknown as HIDDevice;
}

function reply(command: number, address: number, data: number[]): number[] {
  const frame = [command, 0x00, (address >> 8) & 0xff, address & 0xff, data.length, ...data];
  while (frame.length < 16) frame.push(0x00);
  frame[15] = (0x55 - 0x08 - frame.slice(0, 15).reduce((total, byte) => total + byte, 0)) & 0xff;
  return frame;
}

function writes(fake: HIDDevice): Uint8Array[] {
  return (fake as unknown as FakeR1ProMaxDevice).sent
    .filter(({ reportId, data }) => reportId === 8 && data[0] === 0x07)
    .map(({ data }) => data);
}

const SYSTEM_1000_HZ_ONE_STAGE = [0x01, 0x54, 0x01, 0x54, 0x00, 0x55];

test("R1 Pro Max COMPX transports are recognized without using the SE+ live-rate table", () => {
  const receiver = device(0xf58a, "VXE R1 Pro Max Receiver");
  const wired = device(0xf58c, "VXE R1 Pro Max");

  assert.equal(AtkHidClient.isSupported(receiver), true);
  assert.equal(AtkHidClient.isSupported(wired), true);
  assert.equal(new AtkHidClient(receiver).isWireless(), true);
  assert.equal(new AtkHidClient(wired).isWireless(), false);
  assert.deepEqual(new AtkHidClient(receiver).getSupportedPollingRates(), [125, 250, 500, 1000]);
  assert.deepEqual(new AtkHidClient(wired).getSupportedPollingRates(), [125, 250, 500, 1000]);
});

test("R1 Pro Max wired transport writes polling through the system EEPROM", async () => {
  const fake = device(0xf58c, "VXE R1 Pro Max");
  (fake as unknown as FakeR1ProMaxDevice).replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, [0x08, 0x4d, 0x01, 0x54, 0x00, 0x55]),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setPollingRate(125), 125);

  const write = writes(fake)[0];
  assert.ok(write);
  assert.equal(write![2], 0x00);
  assert.equal(write![3], 0x00);
  assert.equal(write![4], 0x02);
  assert.deepEqual([...write!.subarray(5, 7)], [0x08, 0x4d]);
  assert.equal(writes(fake).some((frame) => frame[3] === 0x70), false);
});

test("R1 Pro Max wired transport accepts PAW3395 30K DPI with independent X/Y values", async () => {
  const packed = atkPackDpiStageForSensor("PAW3395", 30000, 100);
  assert.ok(packed);

  const fake = device(0xf58c, "VXE R1 Pro Max");
  (fake as unknown as FakeR1ProMaxDevice).replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, SYSTEM_1000_HZ_ONE_STAGE),
    reply(0x08, 0x000c, packed!),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDpi(30000, 100), 30000);
  assert.equal(client.maxDpi(), 30000);

  const write = writes(fake).find((frame) => frame[2] === 0x00 && frame[3] === 0x0c);
  assert.ok(write);
  assert.deepEqual([...write!.subarray(5, 9)], packed);
});

test("R1 Pro Max receiver writes a non-active DPI stage through the captured two-stage group", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0x4f, 0x4f, 0x00, 0xb7,
    0x3f, 0x3f, 0x00, 0xd7,
  ];
  const after = [
    0x4f, 0x4f, 0x00, 0xb7,
    0x1f, 0x1f, 0x00, 0x17,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, [
      0x01, 0x54,
      0x02, 0x53,
      0x00, 0x55,
    ]),
    reply(0x08, 0x000c, before),
    reply(0x08, 0x0010, [
      0x1f, 0x1f, 0x00, 0x17,
    ]),
  ];

  hardware.writeReplies = [
    reply(0x07, 0x000c, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDpiStageValue(1, 1600), 1600);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0x0c,
  );

  assert.ok(write);
  assert.equal(write![4], 0x08);
  assert.deepEqual([...write!.subarray(5, 13)], after);
});

test("R1 Pro Max receiver selects the active DPI stage through the captured full system row", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const stage1 = [
    0x01, 0x54,
    0x02, 0x53,
    0x00, 0x55,
    0x00, 0x00, 0x00, 0x55,
  ];

  const stage2 = [
    0x01, 0x54,
    0x02, 0x53,
    0x01, 0x54,
    0x00, 0x00, 0x00, 0x55,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, stage1),
    reply(0x08, 0x0000, stage2),
    reply(0x08, 0x0010, [0x3f, 0x3f, 0x00, 0xd7]),
  ];

  hardware.writeReplies = [
    reply(0x07, 0x0000, stage2),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setActiveDpiStage(1), 1);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0x00,
  );

  assert.ok(write);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], stage2);
});

test("R1 Pro Max receiver writes DPI stage count through the captured full system row", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const oneStage = [
    0x01, 0x54,
    0x01, 0x54,
    0x00, 0x55,
    0x00, 0x00, 0x00, 0x55,
  ];
  const twoStages = [
    0x01, 0x54,
    0x02, 0x53,
    0x00, 0x55,
    0x00, 0x00, 0x00, 0x55,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, oneStage),
    reply(0x08, 0x0000, twoStages),
    reply(0x08, 0x000c, [0x4f, 0x4f, 0x00, 0xb7]),
    reply(0x08, 0x0010, [0x3f, 0x3f, 0x00, 0xd7]),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x0000, twoStages),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDpiStageCount(2), 2);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0x00,
  );

  assert.ok(write);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], twoStages);
});

test("R1 Pro Max receiver writes DPI stage colour through the captured two-stage group", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0xff, 0x00, 0x00, 0x56,
    0xff, 0x00, 0xff, 0x57,
  ];
  const after = [
    0x00, 0xff, 0x00, 0x56,
    0xff, 0x00, 0xff, 0x57,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, SYSTEM_1000_HZ_ONE_STAGE),
    reply(0x08, 0x002c, before),
    reply(0x08, 0x002c, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x002c, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDpiStageColor(0, "#00ff00"), "#00ff00");

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0x2c,
  );

  assert.ok(write);
  assert.equal(write![4], 0x08);
  assert.deepEqual([...write!.subarray(5, 13)], after);
});

test("R1 Pro Max receiver writes DPI lighting mode through the captured 0x004c row", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const steady = [
    0x01, 0x54,
    0x80, 0xd5,
    0x01, 0x54,
    0x01, 0x54,
  ];
  const breathing = [
    0x02, 0x53,
    0x80, 0xd5,
    0x01, 0x54,
    0x01, 0x54,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x004c, steady),
    reply(0x08, 0x004c, breathing),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x004c, breathing),
  ];

  const client = new AtkHidClient(fake);
  await client.setDpiLighting(2, 1, 0);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0x4c,
  );

  assert.ok(write);
  assert.equal(write![4], 0x08);
  assert.deepEqual([...write!.subarray(5, 13)], breathing);
});

test("R1 Pro Max receiver writes Long Range through the captured 0x16 command", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const enabled = [
    0x01,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x16, 0, enabled),
    reply(0x17, 0, [0x01]),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setLongRangeMode(true), true);

  const sent = hardware.sent.find(
    ({ reportId, data }) => reportId === 8 && data[0] === 0x16,
  );

  assert.ok(sent);
  assert.deepEqual([...sent!.data], reply(0x16, 0, enabled));
});

test("R1 Pro Max receiver writes Performance Mode through the captured 0x00b5 row", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0x01, 0x54,
    0x12, 0x43,
    0x01, 0x54,
  ];
  const after = [
    0x01, 0x54,
    0x12, 0x43,
    0x00, 0x55,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x00b5, before),
    reply(0x08, 0x00b5, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x00b5, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setPerformanceMode(false), false);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0xb5,
  );

  assert.ok(write);
  assert.equal(write![4], 0x06);
  assert.deepEqual([...write!.subarray(5, 11)], after);
});

test("R1 Pro Max receiver writes sleep timeout through the captured advanced block", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0x04, 0x51,
    0x00, 0x55,
    0x06, 0x4f,
    0x00, 0x55,
    0x01, 0x54,
  ];
  const after = [
    0x04, 0x51,
    0x00, 0x55,
    0x0c, 0x49,
    0x00, 0x55,
    0x01, 0x54,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x00a9, before),
    reply(0x08, 0x00a9, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x00a9, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setSleepTimeout(120), 120);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0xa9,
  );

  assert.ok(write);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], after);
});

test("R1 Pro Max receiver writes angle snapping through the captured advanced block", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0x04, 0x51,
    0x00, 0x55,
    0x06, 0x4f,
    0x01, 0x54,
    0x01, 0x54,
  ];
  const after = [
    0x04, 0x51,
    0x00, 0x55,
    0x06, 0x4f,
    0x00, 0x55,
    0x01, 0x54,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x00a9, before),
    reply(0x08, 0x00a9, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x00a9, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setAngleSnapping(false), false);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0xa9,
  );

  assert.ok(write);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], after);
});

test("R1 Pro Max receiver writes ripple control through the captured advanced block", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0x04, 0x51,
    0x01, 0x54,
    0x06, 0x4f,
    0x01, 0x54,
    0x01, 0x54,
  ];
  const after = [
    0x04, 0x51,
    0x01, 0x54,
    0x06, 0x4f,
    0x01, 0x54,
    0x00, 0x55,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x00a9, before),
    reply(0x08, 0x00a9, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x00a9, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setRippleControl(false), false);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0xa9,
  );

  assert.ok(write);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], after);
});

test("R1 Pro Max receiver writes Motion Sync through the captured advanced block", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0x04, 0x51,
    0x01, 0x54,
    0x06, 0x4f,
    0x01, 0x54,
    0x01, 0x54,
  ];
  const after = [
    0x04, 0x51,
    0x00, 0x55,
    0x06, 0x4f,
    0x01, 0x54,
    0x01, 0x54,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x00a9, before),
    reply(0x08, 0x00a9, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x00a9, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setMotionSync(false), false);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0xa9,
  );

  assert.ok(write);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], after);
});

test("R1 Pro Max receiver writes debounce through the captured advanced block", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  const before = [
    0x04, 0x51,
    0x01, 0x54,
    0x06, 0x4f,
    0x01, 0x54,
    0x01, 0x54,
  ];
  const after = [
    0x08, 0x4d,
    0x01, 0x54,
    0x06, 0x4f,
    0x01, 0x54,
    0x01, 0x54,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x00a9, before),
    reply(0x08, 0x00a9, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x00a9, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDebounceTime(8), 8);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0xa9,
  );

  assert.ok(write);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], after);
});

test("R1 Pro Max receiver writes lift-off distance through the captured EEPROM pair", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x000a, [0x02, 0x53]),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x000a, [0x02, 0x53]),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setLiftOffDistance("High"), "High");

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0x0a,
  );

  assert.ok(write);
  assert.equal(write![4], 0x02);
  assert.deepEqual([...write!.subarray(5, 7)], [0x02, 0x53]);
});

test("R1 Pro Max receiver writes active DPI as the vendor-captured two-stage group", async () => {
  const target = atkPackDpiStageForSensor("PAW3395", 3200, 3200)!;
  const previous = atkPackDpiStageForSensor("PAW3395", 4000, 4000)!;
  const neighbour = atkPackDpiStageForSensor("PAW3395", 3200, 3200)!;

  assert.deepEqual(target, [0x3f, 0x3f, 0x00, 0xd7]);
  assert.deepEqual(previous, [0x4f, 0x4f, 0x00, 0xb7]);

  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;
  const beforeGroup = [...previous, ...neighbour];
  const afterGroup = [...target, ...neighbour];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, SYSTEM_1000_HZ_ONE_STAGE),
    reply(0x08, 0x000c, beforeGroup),
    reply(0x08, 0x000c, target),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x000c, afterGroup),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDpi(3200), 3200);

  const write = writes(fake).find(
    (frame) => frame[2] === 0x00 && frame[3] === 0x0c,
  );

  assert.ok(write);
  assert.equal(write![4], 0x08);
  assert.deepEqual([...write!.subarray(5, 13)], afterGroup);
});

test("R1 Pro Max receiver writes polling with the vendor-captured full system row", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;
  const before = [
    0x01, 0x54,
    0x01, 0x54,
    0x00, 0x55,
    0x00, 0x00, 0x00, 0x55,
  ];
  const after = [
    0x02, 0x53,
    0x01, 0x54,
    0x00, 0x55,
    0x00, 0x00, 0x00, 0x55,
  ];

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, before),
    reply(0x08, 0x0000, after),
  ];
  hardware.writeReplies = [
    reply(0x07, 0x0000, after),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setPollingRate(500), 500);

  const write = writes(fake)[0];
  assert.ok(write);
  assert.equal(write![2], 0x00);
  assert.equal(write![3], 0x00);
  assert.equal(write![4], 0x0a);
  assert.deepEqual([...write!.subarray(5, 15)], after);
  assert.equal(writes(fake).some((frame) => frame[3] === 0x70), false);
});

test("R1 Pro Max receiver switches profiles through the captured 0x0f command", async () => {
  const fake = device(0xf58a, "VXE R1 Pro Max Receiver");
  const hardware = fake as unknown as FakeR1ProMaxDevice;

  hardware.replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x0f, 0, [0x01]),
    reply(0x0e, 0, [0x01]),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setR1ActiveProfile(2), 2);

  const sent = hardware.sent.find(
    ({ reportId, data }) => reportId === 8 && data[0] === 0x0f,
  );

  assert.ok(sent);
  assert.deepEqual([...sent!.data], reply(0x0f, 0, [0x01]));
});

test("R1 Pro Max wired transport edits DPI stage count and clamps the active stage", async () => {
  const fake = device(0xf58c, "VXE R1 Pro Max");
  const stage = atkPackDpiStageForSensor("PAW3395", 1600, 1600)!;
  (fake as unknown as FakeR1ProMaxDevice).replies = [
    reply(0x10, 0, [0x02, 0x1b]),
    reply(0x08, 0x0000, [0x02, 0x53, 0x03, 0x52, 0x02, 0x53, 0x00, 0x55, 0x00, 0x55]),
    reply(0x08, 0x0000, [0x02, 0x53, 0x02, 0x53, 0x01, 0x54, 0x00, 0x55, 0x00, 0x55]),
    reply(0x08, 0x000c, stage),
    reply(0x08, 0x0010, stage),
  ];

  const client = new AtkHidClient(fake);
  assert.equal(await client.setDpiStageCount(2), 2);

  const write = writes(fake).find((frame) => frame[2] === 0x00 && frame[3] === 0x00 && frame[4] === 0x0a);
  assert.ok(write);
  assert.deepEqual([...write!.subarray(5, 11)], [0x02, 0x53, 0x02, 0x53, 0x01, 0x54]);
});

test("R1 Pro Max DPI lighting writes the vendor-captured rows", async () => {
  for (const sample of [
    { mode: 0, brightness: 1, speed: 1, expected: [0x00, 0x00, 0x00, 0x00, 0x03, 0x52, 0x00, 0x55] },
    { mode: 1, brightness: 1, speed: 1, expected: [0x01, 0x54, 0x80, 0xd5, 0x03, 0x52, 0x01, 0x54] },
    { mode: 2, brightness: 1, speed: 1, expected: [0x02, 0x53, 0x80, 0xd5, 0x03, 0x52, 0x01, 0x54] },
  ]) {
    const fake = device(0xf58c, "VXE R1 Pro Max");
    (fake as unknown as FakeR1ProMaxDevice).replies = [
      reply(0x10, 0, [0x02, 0x1b]),
      reply(0x08, 0x004c, [0x01, 0x54, 0x80, 0xd5, 0x03, 0x52, 0x01, 0x54]),
      reply(0x08, 0x004c, sample.expected),
    ];

    await new AtkHidClient(fake).setDpiLighting(sample.mode, sample.brightness, sample.speed);
    const write = writes(fake).find((frame) => frame[2] === 0x00 && frame[3] === 0x4c);
    assert.ok(write);
    assert.deepEqual([...write!.subarray(5, 13)], sample.expected);
  }
});

test("R1 Pro Max accepts firmware-normalized Breathing state after reconnect", () => {
  const fake = device(0xf58c, "VXE R1 Pro Max");
  const client = new AtkHidClient(fake);

  const decoded = (client as unknown as {
    decodeR1DpiLighting(block: Uint8Array): {
      dpiLedMode: number;
      dpiLedBrightness: number;
      dpiLedSpeed: number;
    } | null;
  }).decodeR1DpiLighting(Uint8Array.from([
    0x02, 0x53,
    0x80, 0xd5,
    0x01, 0x54,
    0x00, 0x55,
  ]));

  assert.deepEqual(decoded, {
    dpiLedMode: 2,
    dpiLedBrightness: 1,
    dpiLedSpeed: 0,
  });
});
test("R1 Pro over the Compx 1K dongle decodes PAW3395 stages instead of borrowing the ATK-vendor R1 NK codec", async () => {
  // Replies captured from a VXE R1 Pro (firmware 1.20) behind 0x3554:0xf58a
  // "VXE NordicMouse 1K Dongle". It reports CID/MID 2,8, which under ATK's
  // 0x373b vendor id is the PAW3395SE-based VXE R1 NK; that codec has no code
  // 0x07, so the 400-DPI stage used to abort the whole status read.
  const fake = device(0xf58a, "VXE NordicMouse 1K Dongle");
  (fake as unknown as FakeR1ProMaxDevice).replies = [
    reply(0x10, 0, [0x02, 0x08, 0x4b]),
    reply(0x04, 0, [0x14, 0x00]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x04, 0x51, 0x03, 0x52]),
    reply(0x08, 0x000c, [0x07, 0x07, 0x00, 0x47]),
    reply(0x08, 0x0010, [0x0f, 0x0f, 0x00, 0x37]),
    reply(0x08, 0x0014, [0x3f, 0x3f, 0x00, 0xd7]),
    reply(0x08, 0x0018, [0x17, 0x17, 0x00, 0x27]),
    reply(0x12, 0, [0x01, 0x20]),
    reply(0x08, 0x000a, [0x01, 0x54]),
    reply(0x08, 0x00a9, [0x04, 0x51, 0x00, 0x55, 0x06, 0x4f, 0x00, 0x55, 0x00, 0x55]),
    reply(0x08, 0x00bd, [0xff, 0xff, 0xff, 0xff]),
    reply(0x08, 0x00b5, [0x00, 0x55, 0x06, 0x4f, 0x01, 0x54]),
    reply(0x08, 0x004c, [0x02, 0x53, 0x80, 0xd5, 0x05, 0x50, 0x00, 0x55]),
    reply(0x08, 0x002c, [0xff, 0x00, 0x00, 0x56, 0x00, 0xff, 0x00, 0x56]),
    reply(0x08, 0x0034, [0xff, 0x00, 0xff, 0x57, 0xff, 0xc3, 0x5c, 0x37]),
    reply(0x17, 0, [0x00]),
    reply(0x0e, 0, [0x00]),
    reply(0x08, 0x0060, [0x01, 0x01, 0x00, 0x53, 0x01, 0x02, 0x00, 0x52]),
    reply(0x08, 0x0068, [0x01, 0x04, 0x00, 0x50, 0x01, 0x08, 0x00, 0x4c]),
    reply(0x08, 0x0070, [0x01, 0x10, 0x00, 0x44, 0x02, 0x01, 0x00, 0x52]),
  ];

  const client = new AtkHidClient(fake);
  const status = await client.readStatus();

  assert.deepEqual(status.dpiStageColors, ["#ff0000", "#00ff00", "#ff00ff", "#ffc35c"]);
  assert.equal(status.dpiLedMode, 0, "enabled flag 0 is Off even with a Breathing effect pair stored");
  assert.deepEqual(status.ui?.dpiLighting?.brightnessModes, [1], "no brightness control while breathing");
  assert.equal(status.longRangeMode, false);
  assert.equal(status.performanceMode, undefined);
  assert.equal(status.activeProfile, 1);
  assert.equal(status.atkProfileCount, 4);
  assert.deepEqual(
    status.atkButtonMappings?.map((mapping) => mapping.action),
    ["Left click", "Right click", "Middle click", "Back", "Forward", "DPI cycle"],
  );
  assert.equal(status.name, "VXE R1 Pro");
  assert.deepEqual(status.dpiStages, [400, 800, 3200, 1200]);
  assert.equal(status.activeDpiStage, 3);
  assert.equal(status.dpi, 1200);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.connectionDetail, "2.4 GHz receiver");
  assert.equal(status.atkCatalogFeatures, undefined, "no ATK-vendor catalog flags leak onto a Compx device");
  assert.equal(client.maxDpi(), 30000);
});

test("a DPI row with a valid checksum but an impossible sensor code is not reported as a checksum failure", async () => {
  // CID/MID 2,29 on 0xf58f is the catalog's PAW3395SE-based R1 SE; 0x07 is
  // one of the codes that sensor never uses.
  const fake = device(0xf58f, "VXE R1 SE");
  (fake as unknown as FakeR1ProMaxDevice).replies = [
    reply(0x10, 0, [0x02, 0x1d]),
    reply(0x04, 0, [0x14, 0x00]),
    reply(0x08, 0x0000, [0x01, 0x54, 0x01, 0x54, 0x00, 0x55]),
    reply(0x08, 0x000c, [0x07, 0x07, 0x00, 0x47]),
  ];

  await assert.rejects(
    new AtkHidClient(fake).readStatus(),
    /cannot produce; the model may be misidentified/,
  );
});

// Frames below were captured from ATK HUB (v3-hub.atk.store) driving a VXE R1
// Pro, firmware 1.20, through the 0x3554:0xf58a 1K dongle.
const R1_PRO_IDENTITY = reply(0x10, 0, [0x02, 0x08, 0x4b]);
const R1_PRO_SYSTEM = [0x01, 0x54, 0x04, 0x51, 0x03, 0x52, 0x00, 0x55, 0x00, 0x55];

function r1ProReceiver(): FakeR1ProMaxDevice {
  return device(0xf58a, "VXE NordicMouse 1K Dongle") as unknown as FakeR1ProMaxDevice;
}

test("R1 Pro receiver writes a DPI stage as the vendor's two-stage group and waits for the echo", async () => {
  const fake = r1ProReceiver();
  const group = [0x3f, 0x3f, 0x00, 0xd7, 0x1d, 0x1d, 0x00, 0x1b];
  fake.replies = [
    R1_PRO_IDENTITY,
    reply(0x08, 0x0000, R1_PRO_SYSTEM.slice(0, 6)),
    reply(0x08, 0x0014, [0x3f, 0x3f, 0x00, 0xd7, 0x17, 0x17, 0x00, 0x27]),
    reply(0x08, 0x0018, [0x1d, 0x1d, 0x00, 0x1b]),
  ];
  fake.writeReplies = [reply(0x07, 0x0014, group)];

  const client = new AtkHidClient(fake as unknown as HIDDevice);
  assert.equal(await client.setDpiStageValue(3, 1500), 1500);

  const sent = writes(fake as unknown as HIDDevice);
  assert.equal(sent.length, 1);
  assert.deepEqual([...sent[0]!.subarray(0, 13)], [0x07, 0x00, 0x00, 0x14, 0x08, ...group]);
  assert.equal(sent[0]![15], 0x80, "frame checksum matches the captured vendor write");
});

test("R1 Pro receiver changes polling through the complete system row", async () => {
  const fake = r1ProReceiver();
  const row = [0x02, 0x53, ...R1_PRO_SYSTEM.slice(2)];
  fake.replies = [
    R1_PRO_IDENTITY,
    reply(0x08, 0x0000, R1_PRO_SYSTEM),
    reply(0x08, 0x0000, row.slice(0, 6)),
  ];
  fake.writeReplies = [reply(0x07, 0x0000, row)];

  const client = new AtkHidClient(fake as unknown as HIDDevice);
  assert.equal(await client.setPollingRate(500), 500);
  assert.deepEqual([...writes(fake as unknown as HIDDevice)[0]!.subarray(0, 15)], [0x07, 0x00, 0x00, 0x00, 0x0a, ...row]);
});

test("R1 Pro receiver turns DPI lighting off through the enabled flag and keeps the stored brightness", async () => {
  const fake = r1ProReceiver();
  const sentRow = [0x00, 0x00, 0x10, 0x45, 0x01, 0x54, 0x00, 0x55];
  fake.replies = [
    R1_PRO_IDENTITY,
    reply(0x08, 0x004c, [0x01, 0x54, 0x10, 0x45, 0x01, 0x54, 0x01, 0x54]),
    // The mouse keeps a Breathing effect pair rather than the 00 00 it was sent.
    reply(0x08, 0x004c, [0x02, 0x53, 0x10, 0x45, 0x01, 0x54, 0x00, 0x55]),
  ];
  fake.writeReplies = [reply(0x07, 0x004c, sentRow)];

  const client = new AtkHidClient(fake as unknown as HIDDevice);
  await client.setDpiLighting(0, 0, 0);

  const sent = writes(fake as unknown as HIDDevice);
  assert.deepEqual([...sent[0]!.subarray(0, 13)], [0x07, 0x00, 0x00, 0x4c, 0x08, ...sentRow]);
  assert.equal(sent[0]![15], 0xf3, "frame checksum matches the captured vendor write");
});

test("R1 Pro receiver switches configuration banks with the captured select/echo/readback exchange", async () => {
  const fake = r1ProReceiver();
  const select = reply(0x0f, 0, [0x01]);
  fake.replies = [R1_PRO_IDENTITY, select, reply(0x0e, 0, [0x01])];

  const client = new AtkHidClient(fake as unknown as HIDDevice);
  assert.equal(await client.setR1ActiveProfile(2), 2);

  const sent = fake.sent.map(({ data }) => [...data]).find((frame) => frame[0] === 0x0f);
  assert.deepEqual(sent, select);
  assert.equal(select[15], 0x3c, "frame checksum matches the captured vendor write");
});

test("R1 Pro receiver refuses Performance Mode, which ATK HUB does not offer for it", async () => {
  const fake = r1ProReceiver();
  fake.replies = [R1_PRO_IDENTITY];

  const client = new AtkHidClient(fake as unknown as HIDDevice);
  await assert.rejects(client.setPerformanceMode(true), /Performance mode is not available/);
  assert.equal(writes(fake as unknown as HIDDevice).length, 0);
});
