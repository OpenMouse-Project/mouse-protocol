import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HyperXHidClient } from "./hid.ts";
import {
  CMD,
  decodeBattery,
  decodeConnection,
  decodeDpi,
  decodeDpiSettings,
  decodeHardwareInfo,
  decodeLod,
  dpiOptions,
  encodeDpi,
  encodeEnableProfiles,
  encodeSave,
  encodeSelectProfile,
  encodeSetDpi,
  encodeSetLod,
  encodeSetPollingRate,
  isValidDpi,
  POLLING_RATE_DECODE,
  POLLING_RATE_ENCODE,
  SUPPORTED_POLLING_RATES,
} from "@openmouse/protocol/hyperx";

/** Response buffer for a given opcode with optional payload. */
function response(opcode: number, ...payload: number[]): Uint8Array {
  const buf = new Uint8Array(64);
  buf[0] = opcode;
  for (let i = 0; i < payload.length && i + 1 < buf.length; i++) buf[i + 1] = payload[i];
  return buf;
}

function fakeDevice(overrides?: Partial<HIDDevice>): HIDDevice {
  return {
    vendorId: 0x0951,
    productId: 0x1727,
    productName: "HyperX Pulsefire Haste",
    opened: false,
    collections: [
      { usagePage: 0xff00, usage: 0x01, type: 0, children: [], input: 0, output: 0, feature: 0 },
    ],
    open: async () => { (overrides ?? {}).opened = true; },
    close: async () => {},
    sendReport: async () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    ...overrides,
  } as unknown as HIDDevice;
}

/**
 * A fake device that echoes a canned response for every query opcode. The
 * `replies` argument maps opcode → response bytes payload (byte 0 is the
 * opcode itself).
 */
function deviceWithReplies(
  replies: ReadonlyMap<number, Uint8Array> | ((opcode: number) => Uint8Array | null),
  overrides?: Partial<HIDDevice>,
): HIDDevice {
  let handler: ((event: HIDInputReportEvent) => void) | null = null;
  const device = fakeDevice({
    sendReport: async (_id: number, data: BufferSource) => {
      const source = data as ArrayBufferView | ArrayBuffer;
      const bytes = source instanceof Uint8Array
        ? source
        : new Uint8Array(source instanceof ArrayBuffer ? source : source.buffer, (source as ArrayBufferView).byteOffset, (source as ArrayBufferView).byteLength);
      const opcode = bytes[0] ?? 0;
      const reply = typeof replies === "function" ? replies(opcode) : replies.get(opcode);
      if (reply && handler) {
        // Fire the inputreport event asynchronously, matching the real device.
        const event = {
          device,
          reportId: 0,
          data: new DataView(reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength)),
        } as unknown as HIDInputReportEvent;
        setTimeout(() => handler!(event), 0);
      }
    },
    addEventListener: (_type: string, listener: (event: HIDInputReportEvent) => void) => {
      handler = listener;
    },
    removeEventListener: () => { handler = null; },
    ...overrides,
  });
  return device;
}

describe("HyperXHidClient", () => {
  it("isSupported detects Kingston-era HyperX vendor config interface", () => {
    const device = fakeDevice();
    assert.equal(HyperXHidClient.isSupported(device), true);
  });

  it("isSupported detects HP-era HyperX devices", () => {
    const device = fakeDevice({ vendorId: 0x03f0, productId: 0x0f8f } as Partial<HIDDevice>);
    assert.equal(HyperXHidClient.isSupported(device), true);
  });

  it("isSupported rejects non-HyperX devices", () => {
    const device = fakeDevice({ vendorId: 0x046d } as Partial<HIDDevice>);
    assert.equal(HyperXHidClient.isSupported(device), false);
  });

  it("isSupported rejects devices without the vendor collection", () => {
    const device = fakeDevice({
      collections: [
        { usagePage: 0x01, usage: 0x02, type: 0, children: [], input: 0, output: 0, feature: 0 },
      ],
    } as Partial<HIDDevice>);
    assert.equal(HyperXHidClient.isSupported(device), false);
  });

  it("sendQuery waits for the reply echoing the opcode", async () => {
    const device = deviceWithReplies(new Map([[CMD.GET_HARDWARE_INFO, response(CMD.GET_HARDWARE_INFO)]]));
    const client = new HyperXHidClient(device);
    const resp = await client.sendQuery(CMD.GET_HARDWARE_INFO);
    assert.equal(resp[0], CMD.GET_HARDWARE_INFO);
  });

  it("sendQuery rejects when no reply echoes the opcode", async () => {
    const device = deviceWithReplies(new Map());
    const client = new HyperXHidClient(device);
    await assert.rejects(() => client.sendQuery(CMD.GET_BATTERY), /not answered/);
  });

  it("setPollingRate writes the correct command", async () => {
    const sent: Uint8Array[] = [];
    const device = fakeDevice({
      sendReport: async (_id: number, data: BufferSource) => {
        const buf = new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferLike).byteLength);
        sent.push(buf);
      },
    });
    const client = new HyperXHidClient(device);
    await client.setPollingRate(1000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], CMD.SET_POLLING_RATE);
    assert.equal(sent[0][4], 0x03); // 1000 Hz
  });

  it("setDpi writes DPI, saves, and confirms via read-back", async () => {
    const dpiReply = response(CMD.GET_DPI);
    dpiReply[4] = 0;   // active profile
    dpiReply[5] = 0x01; // profile 0 enabled
    dpiReply[12] = 16; // profile 0 DPI/100 LE = 1600
    const sent: Uint8Array[] = [];
    const device = deviceWithReplies(new Map([[CMD.GET_DPI, dpiReply]]));
    const live = device as HIDDevice & { findPending: boolean };
    const orig = device.sendReport.bind(device);
    Object.defineProperty(device, "sendReport", {
      configurable: true,
      value: async (reportId: number, data: BufferSource) => {
        const buf = new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferLike).byteLength);
        sent.push(buf);
        return orig(reportId, data);
      },
    });
    void live;
    const client = new HyperXHidClient(device);
    const result = await client.setDpi(1600);
    assert.equal(result, 1600);
    const dpiWrites = sent.filter((b) => b[0] === CMD.SET_DPI);
    assert.equal(dpiWrites.length, 2); // profiles 0 and 1 (X and Y share DPI)
    const profileZero = dpiWrites.find((b) => b[2] === 0);
    assert.ok(profileZero);
    assert.equal(profileZero[1], 0x02); // sub-command: set profile DPI value
    assert.equal(profileZero[2], 0);    // profile 0
    assert.equal(profileZero[4], 16);   // 1600 / 100
    assert.ok(sent.some((b) => b[0] === CMD.SAVE && b[1] === 0x03));
  });

  it("setLiftOffDistance writes 1 mm Low LOD and confirms", async () => {
    const dpiReply = response(CMD.GET_DPI);
    dpiReply[4] = 0;
    dpiReply[5] = 0x01;
    dpiReply[12] = 16;
    dpiReply[37] = 2; // LOD = 2 mm High initially
    const sent: Uint8Array[] = [];
    const device = deviceWithReplies(new Map([[CMD.GET_DPI, dpiReply]]));
    const orig = device.sendReport.bind(device);
    Object.defineProperty(device, "sendReport", {
      configurable: true,
      value: async (reportId: number, data: BufferSource) => {
        const view = data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
        const buf = new Uint8Array(view);
        sent.push(buf);
        return orig(reportId, data);
      },
    });
    const client = new HyperXHidClient(device);
    await assert.rejects(() => client.setLiftOffDistance("Low"), /kept/);
    const lodWrite = sent.find((b) => b[0] === CMD.SET_DPI && b[1] === 0x05);
    assert.ok(lodWrite);
    assert.equal(lodWrite![4], 1);
    assert.equal(lodWrite![5], 1);
  });
});

describe("HyperX protocol codecs", () => {
  it("decodeHardwareInfo parses PID, VID, firmware and product string", () => {
    const raw = response(CMD.GET_HARDWARE_INFO);
    raw[3] = 0x3c;
    raw[4] = 0x8e; // PID 0x048e
    raw[5] = 0x04;
    raw[6] = 0xf0; // VID 0x03f0
    raw[7] = 0x03;
    // Little-endian BCD release: 0x09 0x00 0x01 0x04 → 4.1.0.9
    raw[8] = 0x09;
    raw[9] = 0x00;
    raw[10] = 0x01;
    raw[11] = 0x04;
    const name = "HyperX Pulsefire Haste";
    for (let i = 0; i < name.length; i++) raw[20 + i] = name.charCodeAt(i);

    const info = decodeHardwareInfo(raw);
    assert.ok(info);
    assert.equal(info.vendorId, 0x03f0);
    assert.equal(info.productId, 0x048e);
    assert.equal(info.firmware, "4.1.0.9");
    assert.equal(info.product, "HyperX Pulsefire Haste");
  });

  it("decodeHardwareInfo returns null for wrong opcode", () => {
    const raw = response(0xff);
    assert.equal(decodeHardwareInfo(raw), null);
  });

  it("decodeBattery parses charging (0x01), full (0x02) and discharging", () => {
    const raw = response(CMD.GET_BATTERY);
    raw[4] = 85;
    raw[5] = 0x01;
    assert.deepEqual(decodeBattery(raw), { percent: 85, state: "Charging" });

    raw[4] = 100;
    raw[5] = 0x02;
    assert.deepEqual(decodeBattery(raw), { percent: 100, state: "Full" });

    raw[4] = 42;
    raw[5] = 0x00;
    assert.deepEqual(decodeBattery(raw), { percent: 42, state: "Discharging" });
  });

  it("decodeBattery returns null battery for wired models", () => {
    const raw = response(CMD.GET_BATTERY);
    raw[4] = 0;
    raw[5] = 0x00;
    const bat = decodeBattery(raw);
    assert.ok(bat);
    assert.equal(bat.percent, null);
    assert.equal(bat.state, "Unknown");
  });

  it("decodeConnection maps wireless/wired codes", () => {
    const raw = response(CMD.GET_CONNECTION);
    raw[3] = 0x01;
    assert.equal(decodeConnection(raw), "Wireless");
    raw[3] = 0x02;
    assert.equal(decodeConnection(raw), "Wired");
    raw[3] = 0x00;
    assert.equal(decodeConnection(raw), null);
  });

  it("decodeLod maps 1 mm to Low, 2 mm to High", () => {
    assert.equal(decodeLod(1), "Low");
    assert.equal(decodeLod(2), "High");
    assert.equal(decodeLod(0), null);
    assert.equal(decodeLod(3), null);
  });

  it("decodeDpiSettings parses profiles, active profile, enable mask and LOD", () => {
    const raw = response(CMD.GET_DPI);
    raw[4] = 2;    // active profile 2
    raw[5] = 0b00111; // profiles 0,1,2 enabled
    raw[8] = 0xa0; // max DPI step = 160 → 16000
    raw[12] = 8;  // profile 0 DPI = 800
    raw[13] = 0;
    raw[14] = 16; // profile 1 DPI = 1600
    raw[15] = 0;
    raw[16] = 32; // profile 2 DPI = 3200
    raw[17] = 0;
    raw[37] = 2;  // LOD = 2 mm (High)

    const settings = decodeDpiSettings(raw);
    assert.ok(settings);
    assert.equal(settings.activeProfile, 2);
    assert.equal(settings.enabled, 0b00111);
    assert.equal(settings.profiles[0], 800);
    assert.equal(settings.profiles[1], 1600);
    assert.equal(settings.profiles[2], 3200);
    assert.equal(settings.maxDpi, 16000);
    assert.equal(settings.liftOffDistance, "High");
  });

  it("encodeSetPollingRate builds the correct buffer", () => {
    const buf = encodeSetPollingRate(1000);
    assert.ok(buf);
    assert.equal(buf[0], CMD.SET_POLLING_RATE);
    assert.equal(buf[3], 0x01);
    assert.equal(buf[4], 0x03);
  });

  it("encodeSetPollingRate returns null for unsupported rate", () => {
    assert.equal(encodeSetPollingRate(9999), null);
  });

  it("encodeSetDpi builds the correct buffer", () => {
    const buf = encodeSetDpi(0, 1600);
    assert.ok(buf);
    assert.equal(buf[0], CMD.SET_DPI);
    assert.equal(buf[1], 0x02);
    assert.equal(buf[2], 0);
    assert.equal(buf[3], 0x02);
    assert.equal(buf[4], 16); // 1600 / 100
    assert.equal(buf[5], 0);
  });

  it("encodeSetDpi rejects invalid DPI", () => {
    assert.equal(encodeSetDpi(0, 150), null);
    assert.equal(encodeSetDpi(0, 16100), null);
    assert.equal(encodeSetDpi(0, 1650), null);
  });

  it("encodeSelectProfile and encodeEnableProfiles build the correct buffers", () => {
    const select = encodeSelectProfile(3);
    assert.equal(select[0], CMD.SET_DPI);
    assert.equal(select[1], 0x00);
    assert.equal(select[4], 3);

    const enable = encodeEnableProfiles(0b00111);
    assert.equal(enable[0], CMD.SET_DPI);
    assert.equal(enable[1], 0x01);
    assert.equal(enable[4], 0b00111);
  });

  it("encodeSetLod builds the correct buffer", () => {
    const buf = encodeSetLod("High");
    assert.equal(buf[0], CMD.SET_DPI);
    assert.equal(buf[1], 0x05);
    assert.equal(buf[4], 2);
    assert.equal(buf[5], 2);
  });

  it("encodeSave builds the correct buffers", () => {
    const all = encodeSave(0xff);
    assert.equal(all[0], CMD.SAVE);
    assert.equal(all[1], 0xff);
    const dpi = encodeSave(0x03);
    assert.equal(dpi[1], 0x03);
  });

  it("isValidDpi validates correctly", () => {
    assert.equal(isValidDpi(200), true);
    assert.equal(isValidDpi(1600), true);
    assert.equal(isValidDpi(16000), true);
    assert.equal(isValidDpi(100), false);
    assert.equal(isValidDpi(16100), false);
    assert.equal(isValidDpi(1650), false);
  });

  it("encodeDpi / decodeDpi round-trip", () => {
    for (const dpi of [200, 400, 800, 1600, 3200, 6400, 12000, 16000]) {
      assert.equal(decodeDpi(encodeDpi(dpi)), dpi);
    }
  });

  it("POLLING_RATE_ENCODE and POLLING_RATE_DECODE are inverses", () => {
    for (const [hz, code] of POLLING_RATE_ENCODE) {
      assert.equal(POLLING_RATE_DECODE.get(code), hz);
    }
  });

  it("SUPPORTED_POLLING_RATES has expected values", () => {
    assert.deepEqual(SUPPORTED_POLLING_RATES, [125, 250, 500, 1000]);
  });

  it("dpiOptions returns the correct range", () => {
    const opts = dpiOptions();
    assert.equal(opts[0], 200);
    assert.equal(opts[opts.length - 1], 16000);
    assert.equal(opts.length, 159);
  });
});

describe("HyperXHidClient readStatus", () => {
  it("throws when hardware info does not answer", async () => {
    const device = deviceWithReplies(new Map());
    const client = new HyperXHidClient(device);
    await assert.rejects(() => client.readStatus(), /did not answer/);
  });

  it("returns a wired status with DPI, LOD and firmware", async () => {
    const dpiReply = response(CMD.GET_DPI);
    dpiReply[4] = 0;
    dpiReply[5] = 0x01;
    dpiReply[12] = 16; // 1600 DPI
    dpiReply[37] = 1;  // Low LOD

    const hwReply = response(CMD.GET_HARDWARE_INFO);
    hwReply[3] = 0x3c;
    hwReply[4] = 0x27; // PID 0x1727
    hwReply[5] = 0x17;
    hwReply[6] = 0x51; // VID 0x0951
    hwReply[7] = 0x09;
    hwReply[8] = 0x01;
    hwReply[9] = 0x00;
    hwReply[10] = 0x00;
    hwReply[11] = 0x01; // 1.0.0.1
    const name = "Pulsefire Haste";
    for (let i = 0; i < name.length; i++) hwReply[20 + i] = name.charCodeAt(i);

    const batteryReply = response(CMD.GET_BATTERY);
    batteryReply[4] = 0; // wired: no battery
    batteryReply[5] = 0x00;

    const connectionReply = response(CMD.GET_CONNECTION);
    connectionReply[3] = 0x02; // wired

    const device = deviceWithReplies(new Map([
      [CMD.GET_DPI, dpiReply],
      [CMD.GET_HARDWARE_INFO, hwReply],
      [CMD.GET_BATTERY, batteryReply],
      [CMD.GET_CONNECTION, connectionReply],
    ]));
    const status = await new HyperXHidClient(device).readStatus();
    assert.equal(status.brand, "HyperX");
    assert.equal(status.name, "Pulsefire Haste");
    assert.equal(status.ui?.family, "hyperx");
    assert.equal(status.ui?.settingsReady, true);
    assert.equal(status.dpi, 1600);
    assert.equal(status.liftOffDistance, "Low");
    assert.equal(status.connectionType, "Wired");
    assert.equal(status.batteryPercent, null);
    assert.equal(status.firmware.length, 1);
    assert.ok(status.firmware[0].includes("1.0.0.1"));
  });
});