import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AJAZZ_BLANK_CONFIG,
  AJAZZ_DONGLE_VENDOR_ID,
  AJAZZ_PRODUCTS,
  AJAZZ_REPORT_ID,
  AJAZZ_USAGE,
  AJAZZ_USAGE_PAGE,
  AJAZZ_USB_VENDOR_ID,
  ajazzDecodeBattery,
  ajazzDecodeConfig,
  ajazzDecodePollingRate,
  ajazzDecodeVersion,
  ajazzEncodePollingRate,
  ajazzEncodeSetConfig,
  ajazzGetBatteryRequest,
  ajazzGetConfigRequest,
  ajazzGetVersionRequest,
  ajazzIsValidDpi,
  ajazzIsValidSleepSeconds,
  type AjazzConfig,
} from "../../ajazz/index.ts";
import { AjazzHidClient } from "./hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";

const NJ07_MC = 0x2167;

/** The NJ07 MC factory config from the vendor panel's mouse_info_nj07mc.json. */
const FACTORY: AjazzConfig = {
  lightMode: 0,
  reportRate: 3,
  dpiCount: 6,
  dpiIndex: 1,
  stages: [400, 800, 1200, 1600, 2400, 3200],
  scrollFlag: 0,
  lodValue: 1,
  sensorFlag: 0,
  keyRespond: 8,
  sleepMinutes: 5,
  highspeedMode: 0,
  wakeByte: 0x10,
};

/**
 * What the vendor panel's `setMouseConfigData(FACTORY)` puts on the wire,
 * written out by hand from its t[] assignments (t[0] is the report id 0xF0, so
 * t[n] is body[n - 1]).
 */
const FACTORY_SET_BODY = (() => {
  const body = new Uint8Array(63);
  body.set([0x0f, 0x01, 0x0a, 0x2f]);
  body[9] = 4; // report_rate 3 + 1
  body[10] = 6; // dpi_count
  body[11] = 2; // dpi_index 1 + 1
  body.set([0x90, 0x01, 0x20, 0x03, 0xb0, 0x04, 0x40, 0x06, 0x60, 0x09, 0x80, 0x0c], 12);
  body[48] = 1; // lod_value
  body[50] = 8; // key_respond
  body[51] = 5; // sleep_light
  body[53] = 0x10; // wakeup << 4 | move_light
  return body;
})();

function reply(command: number, fill: (data: Uint8Array) => void = () => {}): Uint8Array {
  const data = new Uint8Array(63);
  data[0] = command;
  fill(data);
  return data;
}

describe("ajazz codec", () => {
  it("frames the three read requests as 63-byte bodies", () => {
    assert.deepEqual([...ajazzGetVersionRequest().slice(0, 3)], [0x04, 0x01, 0x00]);
    assert.deepEqual([...ajazzGetBatteryRequest().slice(0, 3)], [0x30, 0x01, 0x00]);
    assert.deepEqual([...ajazzGetConfigRequest().slice(0, 5)], [0x0e, 0x01, 0x0b, 0x2e, 0x00]);
    for (const req of [ajazzGetVersionRequest(), ajazzGetBatteryRequest(), ajazzGetConfigRequest()]) {
      assert.equal(req.length, 63);
    }
  });

  it("encodes the factory config exactly as the vendor panel does", () => {
    assert.deepEqual([...ajazzEncodeSetConfig(FACTORY)], [...FACTORY_SET_BODY]);
  });

  it("decodes a config reply back to the config that produced it", () => {
    const wire = Uint8Array.from(FACTORY_SET_BODY);
    wire[0] = 0x0e;
    assert.deepEqual(ajazzDecodeConfig(wire), FACTORY);
  });

  it("keeps the wake byte whole instead of splitting its nibbles", () => {
    const wire = Uint8Array.from(FACTORY_SET_BODY);
    wire[0] = 0x0e;
    wire[53] = 0x01; // click wake, move light on: the panel would read both as 0
    const config = ajazzDecodeConfig(wire)!;
    assert.equal(config.wakeByte, 0x01);
    assert.equal(ajazzEncodeSetConfig(config)[53], 0x01);
  });

  it("falls back to the vendor defaults on a blank or erased block", () => {
    for (const fill of [0x00, 0xff]) {
      const wire = new Uint8Array(63).fill(fill);
      wire[0] = 0x0e;
      assert.deepEqual(ajazzDecodeConfig(wire), AJAZZ_BLANK_CONFIG);
    }
  });

  it("rejects a reply that is short or answers another command", () => {
    assert.equal(ajazzDecodeConfig(new Uint8Array(40)), null);
    assert.equal(ajazzDecodeConfig(reply(0x30)), null);
    assert.equal(ajazzDecodeBattery(reply(0x0e)), null);
    assert.equal(ajazzDecodeVersion(reply(0x0e)), null);
  });

  it("decodes battery and the trailing version characters", () => {
    assert.deepEqual(
      ajazzDecodeBattery(reply(0x30, (d) => { d[7] = 87; d[8] = 1; })),
      { percent: 87, charging: true },
    );
    const ascii = (text: string) => (d: Uint8Array) => d.set([...text].map((c) => c.charCodeAt(0)), 2);
    assert.equal(ajazzDecodeVersion(reply(0x04, ascii("V1.0.5"))), "1.0.5");
    assert.equal(ajazzDecodeVersion(reply(0x04)), null);
  });

  it("maps polling rate indexes and validates DPI and sleep", () => {
    assert.equal(ajazzEncodePollingRate(1000), 3);
    assert.equal(ajazzEncodePollingRate(750), null);
    assert.equal(ajazzDecodePollingRate(0), 125);
    assert.equal(ajazzDecodePollingRate(4), null);
    assert.equal(ajazzIsValidDpi(50, 24000), true);
    assert.equal(ajazzIsValidDpi(49, 24000), false);
    assert.equal(ajazzIsValidDpi(24050, 24000), false);
    assert.equal(ajazzIsValidDpi(800.5, 24000), false);
    assert.equal(ajazzIsValidSleepSeconds(300), true);
    assert.equal(ajazzIsValidSleepSeconds(90), false);
    assert.equal(ajazzIsValidSleepSeconds(0), false);
    assert.equal(ajazzIsValidSleepSeconds(6060), false);
  });
});

interface MouseOptions {
  vendorId?: number;
  productId?: number;
  /** Never answer anything. */
  silent?: boolean;
  /** Acknowledge SET_CONFIG but keep the old block. */
  ignoreWrites?: boolean;
  /** Push a status report before every answer, like the mouse does on DPI changes. */
  noisy?: boolean;
}

/** A mock mouse that answers the vendor frames from a stored config block. */
function fakeMouse(options: MouseOptions = {}) {
  const block = Uint8Array.from(FACTORY_SET_BODY);
  const sent: Uint8Array[] = [];
  const listeners = new Set<(event: HIDInputReportEvent) => void>();
  const emit = (data: Uint8Array): void => {
    const event = { reportId: AJAZZ_REPORT_ID, data: new DataView(data.buffer.slice(0)) };
    for (const listener of [...listeners]) listener(event as unknown as HIDInputReportEvent);
  };
  const device = {
    vendorId: options.vendorId ?? AJAZZ_DONGLE_VENDOR_ID,
    productId: options.productId ?? NJ07_MC,
    productName: "2.4G Wireless Mouse",
    opened: false,
    collections: [{ usagePage: AJAZZ_USAGE_PAGE, usage: AJAZZ_USAGE, children: [] }],
    open: async () => { device.opened = true; },
    close: async () => { device.opened = false; },
    addEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: (event: HIDInputReportEvent) => void) => { listeners.delete(fn); },
    sendReport: async (reportId: number, body: BufferSource) => {
      assert.equal(reportId, AJAZZ_REPORT_ID);
      const request = Uint8Array.from(body as Uint8Array);
      assert.equal(request.length, 63);
      sent.push(request);
      if (options.silent) return;
      if (options.noisy) emit(reply(0xfa, (d) => { d[8] = 3; d[9] = 4; }));
      switch (request[0]) {
        case 0x0e: {
          const wire = Uint8Array.from(block);
          wire[0] = 0x0e;
          emit(wire);
          break;
        }
        case 0x0f:
          if (!options.ignoreWrites) block.set(request.slice(8, 54), 8);
          emit(reply(0x0f));
          break;
        case 0x30:
          emit(reply(0x30, (d) => { d[7] = 64; d[8] = 0; }));
          break;
        case 0x04:
          emit(reply(0x04, (d) => d.set([...("V1.0.5")].map((c) => c.charCodeAt(0)), 2)));
          break;
      }
    },
  };
  const client = new AjazzHidClient(device as unknown as HIDDevice, { replyTimeoutMs: 20, settleAfterWriteMs: 0 });
  return { device: device as unknown as HIDDevice, client, block, sent };
}

describe("AjazzHidClient", () => {
  it("claims only the catalogue ids on the two vendor ids and the 0xFF01:0x10 collection", () => {
    const { device } = fakeMouse();
    assert.equal(AjazzHidClient.isSupported(device), true);
    for (const patch of [{ vendorId: 0x1234 }, { productId: 0x2255 }, { collections: [] }]) {
      assert.equal(AjazzHidClient.isSupported({ ...device, ...patch } as unknown as HIDDevice), false);
    }
    assert.equal(AjazzHidClient.isSupported({ ...device, vendorId: AJAZZ_USB_VENDOR_ID } as unknown as HIDDevice), true);
    assert.deepEqual([...AJAZZ_PRODUCTS.keys()].sort(), [0x2157, 0x2158, 0x2167, 0x2168, 0x2177, 0x2178]);
  });

  it("is picked by the registry and named AJAZZ, leaving K-snake's id alone", () => {
    const { device } = fakeMouse();
    const client = createSupportedClient(device);
    assert.ok(client instanceof AjazzHidClient);
    assert.equal(deviceBrand(client), "AJAZZ");
    const ksnake = { ...device, productId: 0x2255 } as unknown as HIDDevice;
    assert.notEqual(createSupportedClient(ksnake)?.constructor.name, "AjazzHidClient");
  });

  it("reads identity, battery, DPI stages, polling, sleep and scroll direction", async () => {
    const { client } = fakeMouse();
    const status = await client.readStatus();
    assert.equal(status.brand, "AJAZZ");
    assert.equal(status.name, "AJAZZ NJ07 MC");
    assert.equal(status.ui?.settingsReady, true);
    assert.deepEqual(status.dpiStages, [400, 800, 1200, 1600, 2400, 3200]);
    assert.equal(status.activeDpiStage, 1);
    assert.equal(status.dpi, 800);
    assert.equal(status.pollingRateHz, 1000);
    assert.deepEqual(status.supportedPollingRates, [125, 500, 1000]);
    assert.equal(status.sleepTimeout, 300);
    assert.equal(status.scrollDirection, "Forward");
    assert.equal(status.batteryPercent, 64);
    assert.equal(status.batteryState, "Discharging");
    assert.equal(status.connectionType, "Wireless");
    assert.deepEqual(status.firmware, ["NJ07 MC 1.0.5"]);
    assert.equal(status.ui?.dpiStageEditor?.maxDpi, 24000);
  });

  it("reports a wired mouse as wired", async () => {
    const { client } = fakeMouse({ vendorId: AJAZZ_USB_VENDOR_ID });
    assert.equal((await client.readStatus()).connectionType, "Wired");
  });

  it("falls back to identity only when the mouse stays silent", async () => {
    const { client } = fakeMouse({ silent: true });
    const status = await client.readStatus();
    assert.equal(status.name, "AJAZZ NJ07 MC");
    assert.equal(status.ui?.settingsReady, false);
    assert.equal(status.dpi, 0);
    assert.equal(status.batteryPercent, null);
    assert.deepEqual(status.firmware, ["NJ07 MC"]);
  });

  it("matches replies by command, so unsolicited reports are ignored", async () => {
    const { client } = fakeMouse({ noisy: true });
    const status = await client.readStatus();
    assert.equal(status.pollingRateHz, 1000);
    assert.equal(status.batteryPercent, 64);
  });

  it("changes one DPI stage and leaves the rest of the block alone", async () => {
    const { client, block } = fakeMouse();
    assert.equal(await client.setDpiStageValue(2, 1500), 1500);
    assert.deepEqual(ajazzDecodeConfig(Uint8Array.from([0x0e, ...block.slice(1)])), {
      ...FACTORY,
      stages: [400, 800, 1500, 1600, 2400, 3200],
    });
  });

  it("changes the active stage's DPI with setDpi", async () => {
    const { client, block } = fakeMouse();
    await client.setDpi(900);
    assert.equal(ajazzDecodeConfig(Uint8Array.from([0x0e, ...block.slice(1)]))!.stages[1], 900);
  });

  it("switches stage, polling rate, sleep and scroll direction", async () => {
    const { client, block } = fakeMouse();
    await client.setActiveDpiStage(4);
    await client.setPollingRate(500);
    await client.setSleepTimeout(600);
    await client.setScrollDirection("Reverse");
    assert.deepEqual(ajazzDecodeConfig(Uint8Array.from([0x0e, ...block.slice(1)])), {
      ...FACTORY,
      dpiIndex: 4,
      reportRate: 2,
      sleepMinutes: 10,
      scrollFlag: 1,
    });
  });

  it("refuses values the mouse or UI cannot take", async () => {
    const { client, sent } = fakeMouse();
    await assert.rejects(client.setPollingRate(250), /does not support 250 Hz/);
    await assert.rejects(client.setDpiStageValue(0, 24050), /between 50 and 24000/);
    await assert.rejects(client.setDpiStageValue(6, 800), /stage must be between 1 and 6/);
    await assert.rejects(client.setActiveDpiStage(6), /stage must be between 1 and 6/);
    await assert.rejects(client.setSleepTimeout(90), /does not support a 90-second/);
    assert.equal(sent.some((r) => r[0] === 0x0f), false);
  });

  it("fails loudly when the mouse acknowledges a write but keeps the old value", async () => {
    const { client } = fakeMouse({ ignoreWrites: true });
    await assert.rejects(client.setPollingRate(125), /kept 1000 Hz instead of 125 Hz/);
  });

  it("does not write when the current config cannot be read", async () => {
    const { client, sent } = fakeMouse({ silent: true });
    await assert.rejects(client.setPollingRate(500), /Could not read the current config/);
    assert.equal(sent.some((r) => r[0] === 0x0f), false);
  });
});
